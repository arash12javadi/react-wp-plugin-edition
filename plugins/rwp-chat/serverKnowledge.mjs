/**
 * The site's own words, chosen for one question.
 *
 * `loadSiteFacts` can hand the assistant a list of page titles, which says where things are but
 * never what they say. Asked "what does delivery cost", a model holding only URLs and a strict
 * no-inventing rule can do nothing but apologise. This module closes that gap by treating the CMS
 * as a corpus: the visitor's question is matched against the published pages and posts, and the
 * few that fit are given to the model as passages it may answer from and quote.
 *
 * Two things keep that safe and cheap.
 *
 *  1. Every read uses the anon key, so row level security decides what a member of the public may
 *     see. A draft, a trashed page or a staff-only row can never be pulled into a prompt — the
 *     same rule the site itself follows.
 *  2. Passages are converted to plain text, truncated and budgeted in characters, because the
 *     corpus is orders of magnitude larger than the context window of the model reading it: page
 *     bodies are HTML, and one page can be longer than the whole transcript.
 *
 * Retrieval is keyword matching rather than embeddings on purpose. It needs no extra service, no
 * extra table and no extra key, and on a site of a few dozen pages "which rows mention the words
 * the visitor used" is both accurate and instant.
 */

/** How much of one page is quoted to the model. */
const PASSAGE_CHARS = 700;
/** The most passages one answer is given. */
const MAX_PASSAGES = 4;
/** The overall budget for the knowledge section, so one huge page cannot crowd out the rules. */
const TOTAL_CHARS = 2_400;
/** How many words of the question are looked up. */
const MAX_TERMS = 3;
/** Shorter words say nothing about subject matter and match half the site. */
const MIN_TERM_LENGTH = 4;
/** The columns a passage is built from. Kept beside the reader so the two cannot drift. */
const PAGE_FIELDS = 'id,title,slug,is_post,excerpt,content';

/**
 * Words that appear in every question, in every page and in the prompt itself. Filtering them is
 * what makes "what does the site say about delivery" search for "delivery" and not for "site".
 */
const STOP_WORDS = new Set(`
  about above after again against also and any are because been before being below between both
  but can could did does doing done down during each else even ever every few for from further
  get got had has have having her here hers him his how into its itself just know like made make
  many may me might more most much must need needs never not now off often once only other our
  ours out over own please same say says she should since some still such than thank thanks that
  the their them then there these they thing things think this those through too under until
  very want was way we well were what when where which while who whom why will with within would
  yes yet you your yours
  hello hey hi help question ask asking answer
  site website page pages post posts blog content
  attached attachment attachments file files image images photo
`.trim().split(/\s+/));

/** The handful of entities a CMS body actually contains; anything else is left as written. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#8217': '’', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–',
};

/**
 * A page body as prose: tags, scripts and runs of whitespace removed.
 *
 * Deliberately not a parser. The model needs the words, not the headings, and a regex that cannot
 * be tricked into catastrophic backtracking is worth more here than one that handles every edge of
 * HTML. `<script>` bodies are dropped rather than flattened because a block editor can leave
 * tracking snippets in a page row, and those are not something the assistant should repeat.
 */
export const plainText = (value) => String(value ?? '')
  .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The words of a question worth looking up, longest first.
 *
 * Longest first because the discriminating word in "how do refunds work" is `refunds`, and only
 * three lookups are made: an early generic term would spend a query on nothing.
 */
export function searchTerms(question, max = MAX_TERMS) {
  const seen = new Set();
  const words = String(question || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(word));
  for (const word of words) seen.add(word);
  return [...seen].sort((a, b) => b.length - a.length).slice(0, max);
}

/** One PostgREST query for a word, over the three columns a visitor might be quoting. */
const matchPath = (term) => {
  const pattern = encodeURIComponent(`*${term}*`);
  const filter = `title.ilike.${pattern},excerpt.ilike.${pattern},content.ilike.${pattern}`;
  return `pages?status=eq.published&is_site_template=not.is.true&or=(${filter})`
    + `&select=${PAGE_FIELDS}&order=updated_at.desc&limit=3`;
};

/** The newest published content, for a question that named nothing the site has written about. */
const recentPath = `pages?status=eq.published&is_site_template=not.is.true`
  + `&select=${PAGE_FIELDS}&order=updated_at.desc&limit=3`;

/** What the visitor is looking at, when the widget resolved it to a public page. */
const contextPath = (id) =>
  `pages?id=eq.${Number(id)}&status=eq.published&is_site_template=not.is.true&select=${PAGE_FIELDS}&limit=1`;

/**
 * The passages that best answer this question.
 *
 * `fetchRows` is the caller's PostgREST reader — it takes a path and returns parsed rows — so this
 * module never holds a key, a client or a URL. Failures are swallowed: a site whose pages table
 * cannot be read still has a working assistant, just a less informed one.
 *
 * Order is settled before truncation: the page the visitor is on, then whatever matched the most
 * of their words, then the newest rows. That is why a page can be found twice — once as context,
 * once as a search hit — and still be quoted once.
 */
export async function loadKnowledge(fetchRows, { question = '', contextType = '', contextId = '' } = {}) {
  const terms = searchTerms(question);
  /** slug → { page, score, priority }: keyed by slug because that is what a URL is built from. */
  const found = new Map();
  const remember = (page, score, priority = false) => {
    if (!page?.slug) return;
    const known = found.get(page.slug);
    if (!known) {
      found.set(page.slug, { page, score, priority });
      return;
    }
    known.score += score;
    known.priority = known.priority || priority;
  };

  const requests = [];
  if (contextType === 'page' && /^\d+$/.test(String(contextId))) {
    requests.push(
      fetchRows(contextPath(contextId))
        .then((rows) => remember(rows?.[0], terms.length + 1, true))
        .catch(() => undefined),
    );
  }
  for (const term of terms) {
    requests.push(
      fetchRows(matchPath(term))
        .then((rows) => (rows || []).forEach((page) => remember(page, 1)))
        .catch(() => undefined),
    );
  }
  await Promise.all(requests);

  // Nothing to go on — a first message of "hi", or a site whose pages are all drafts. The newest
  // rows still give the assistant something true to say about what this site is.
  if (!found.size) {
    const rows = await fetchRows(recentPath).catch(() => []);
    (rows || []).forEach((page) => remember(page, 0));
  }

  const entries = [...found.values()]
    .sort((a, b) => Number(b.priority) - Number(a.priority) || b.score - a.score)
    .slice(0, MAX_PASSAGES);

  const passages = [];
  let budget = TOTAL_CHARS;
  for (const { page } of entries) {
    const text = plainText(page.content || page.excerpt).slice(0, PASSAGE_CHARS);
    if (!text) {
      // A page with no body is still a real destination: keep it as a link, spend no budget on it.
      if (!passages.length) passages.push({ title: String(page.title || 'Untitled'), url: `/${page.slug}`, text: '' });
      continue;
    }
    if (text.length > budget) continue;
    budget -= text.length;
    passages.push({ title: String(page.title || 'Untitled'), url: `/${page.slug}`, text });
  }
  return passages;
}

/**
 * The passages as the prompt shows them: one quoted line per page, with its URL beside it.
 *
 * Quoted and attributed because the model is told to prefer this text over its own knowledge, and
 * an answer that repeats "£4.95" is only safe if a human can find the page it came from. A passage
 * from the knowledge base may have no page at all — a return policy typed in by hand, a price list
 * uploaded as a document — and is marked so the model cannot invent a URL for it.
 */
export const describeKnowledge = (passages) => (passages || [])
  .map((passage) => {
    const where = passage.url
      ? ` (${passage.url})`
      : ' (from the knowledge base, not a page — use this text, but cite no URL for it)';
    return `- ${passage.title}${where}: ${passage.text || '(no body text — link to it, but do not describe it)'}`;
  })
  .join('\n');

// The knowledge base --------------------------------------------------------------------------

/**
 * The second corpus: the curated knowledge base (Chat → Knowledge), searched through
 * rwp_chat_knowledge_search.
 *
 * The two corpora overlap — after a sync every published page is in both — and they are not
 * redundant. Pages are matched by keyword over whole rows, so a long page about delivery is quoted
 * from its opening; the knowledge base is split into overlapping passages, so the paragraph that
 * mentions "Saturday delivery" is the one that comes back. It is also the only place the site can
 * say something no page says: a policy an administrator typed in, a supplier's price list uploaded
 * as a document.
 */

/** How much of one stored passage is quoted. */
const LIBRARY_ENTRY_CHARS = 700;
/** The most entries one answer is given from the knowledge base. */
const LIBRARY_MAX_ENTRIES = 3;
/** How many words of the question are looked up in the knowledge base. */
const LIBRARY_TERMS = 3;

/**
 * The passages the knowledge base offers for this question, best first.
 *
 * `fetchPassages` is the caller's reader for the RPC and takes one search term. Failures are
 * swallowed for the same reason as above: a knowledge base that cannot be read costs the answer its
 * detail, never the whole answer.
 */
export async function loadLibrary(fetchPassages, { question = '' } = {}) {
  const terms = searchTerms(question, LIBRARY_TERMS);
  if (!terms.length) return [];
  const results = await Promise.all(terms.map((term) => fetchPassages(term).catch(() => [])));

  /** entry_id → the best passage of that entry, so one article cannot fill the whole prompt. */
  const found = new Map();
  results.forEach((rows, index) => {
    for (const row of rows || []) {
      if (!row || row.entry_id === undefined || row.entry_id === null) continue;
      const text = String(row.content || '').trim().slice(0, LIBRARY_ENTRY_CHARS);
      if (!text) continue;
      // Terms arrive longest first, so a hit on an earlier one is a hit on the more specific word.
      const weight = (Number(row.rank) || 0) + (LIBRARY_TERMS - index) / 10;
      const key = String(row.entry_id);
      const known = found.get(key);
      if (!known) {
        found.set(key, { row, text, best: weight, score: weight, matched: 1 });
        continue;
      }
      known.score += weight;
      known.matched += 1;
      if (weight > known.best) {
        known.best = weight;
        known.text = text;
        known.row = row;
      }
    }
  });

  const ordered = [...found.values()].sort((a, b) => b.matched - a.matched || b.score - a.score);
  const passages = [];
  let budget = TOTAL_CHARS;
  for (const entry of ordered) {
    if (passages.length >= LIBRARY_MAX_ENTRIES) break;
    if (entry.text.length > budget) continue;
    budget -= entry.text.length;
    passages.push({
      title: String(entry.row.title || 'Untitled'),
      url: entry.row.url ? String(entry.row.url) : '',
      text: entry.text,
    });
  }
  return passages;
}

/**
 * Two sets of passages as one, the first set first.
 *
 * The corpora answer the same question from the same site, so the same page turns up in both.
 * Quoting it twice spends the budget on a repeat and teaches the model nothing, so a passage is
 * kept only if nothing already chosen has its URL — or, for a passage with no page, its title.
 * The knowledge base is passed first: it is curated, and a sync keeps it as fresh as the page
 * matcher's view, so where the two disagree about which paragraph matters, it is right.
 */
export function combinePassages(primary, secondary, budget = TOTAL_CHARS) {
  const seen = new Set();
  const chosen = [];
  let left = budget;
  for (const passage of [...(primary || []), ...(secondary || [])]) {
    if (!passage) continue;
    const key = passage.url ? `url:${passage.url}` : `title:${String(passage.title).toLowerCase()}`;
    if (seen.has(key)) continue;
    const text = String(passage.text || '');
    if (text.length > left) continue;
    seen.add(key);
    left -= text.length;
    chosen.push({ ...passage, text });
  }
  return chosen;
}

// Admin routes --------------------------------------------------------------------------------
// Three things the browser cannot do on its own: read every published page under the rules the
// public site follows (sync), call the model with the site's own key (refine), and show what the
// assistant would actually be told (search). Everything else — listing, editing, deleting an entry
// — is an ordinary PostgREST query that row level security already limits to manage_options, so the
// admin screen makes those directly (lib/knowledge.ts) and there is no second copy of the rules
// here to drift from the policies in schema.sql.

/** A ceiling, so switching this on for a site with thousands of rows cannot become a timeout. */
const SYNC_LIMIT = 300;
/** Entries written per request: enough to be quick, small enough that one body stays small. */
const SYNC_BATCH = 10;
/** A "page" with less text than this is a placeholder. Indexing it would teach the model nothing. */
const MIN_PAGE_CHARS = 40;
/** How many stale entries are archived per request. */
const ARCHIVE_BATCH = 50;

/**
 * A cheap fingerprint of a page's text, so a sync only writes what changed.
 *
 * Without it every sync rewrites every row, which bumps updated_at on all of them (the trigger does
 * that), re-splits every page into passages, and turns "updated" in the admin screen into "last
 * synced". Length is included because a hash over a whole page is a filter, not a proof: it has to
 * be right about the common case, and erring towards one unnecessary write is harmless.
 */
export const fingerprint = (value) => {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`;
};

/**
 * Copies the published pages and posts into the knowledge base.
 *
 * One-way and idempotent: the CMS owns scraped entries, so a second run changes nothing, an edited
 * page is rewritten, and a page that was unpublished or deleted is archived rather than left
 * quotable. The assistant only ever sees status = 'published', which is what keeps a draft secret
 * while it is still in the table.
 *
 * Reads with the anon key — the same key, and so the same row level security, as the public site —
 * and writes as the caller, so the policies that require manage_options decide. That is also what
 * lets it work on a Vercel deployment, which holds no secret key.
 */
export async function syncRoute(ctx, { rest, requireAdmin }) {
  await requireAdmin(ctx);

  // An automatic pass, which is how `chat_knowledge_auto_sync` earns its keep: the admin screen asks
  // for one every time it opens, and on most openings the honest answer is "nothing to do". Reading
  // three options is a fraction of what re-reading up to 300 pages costs, so the interval is checked
  // here, before a single page is fetched.
  if (ctx.json()?.if_stale) {
    const names = ['chat_knowledge_auto_sync', 'chat_knowledge_sync_hours', 'chat_knowledge_last_sync'];
    const list = names.map((name) => `"${name}"`).join(',');
    const rows = await rest(ctx, `options?option_name=in.(${encodeURIComponent(list)})&select=option_name,option_value`, { auth: 'anon' })
      .catch(() => []);
    const options = Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.option_name, row.option_value]));
    const hours = Math.max(1, Number(options.chat_knowledge_sync_hours) || 24);
    const lastSync = options.chat_knowledge_last_sync || '';
    const last = Date.parse(lastSync);
    const deferred = options.chat_knowledge_auto_sync !== 'true'
      ? 'off'
      : Number.isFinite(last) && Date.now() - last < hours * 3_600_000 ? 'fresh' : '';
    if (deferred) {
      return {
        status: 200,
        body: {
          pages: 0, indexed: 0, skipped: 0, created: 0, updated: 0, unchanged: 0, archived: 0,
          last_sync: lastSync || null,
          deferred,
        },
      };
    }
  }

  const startedAt = new Date().toISOString();

  const pages = await rest(
    ctx,
    `pages?status=eq.published&is_site_template=not.is.true&select=${PAGE_FIELDS}&order=updated_at.desc&limit=${SYNC_LIMIT}`,
    { auth: 'anon' },
  );

  const scraped = (Array.isArray(pages) ? pages : [])
    .map((page) => ({ page, text: plainText(page.content || page.excerpt) }))
    .filter(({ page, text }) => page?.id && page?.slug && text.length >= MIN_PAGE_CHARS);

  // What is already stored, so the reply can say "3 new, 12 updated" and the entries whose page is
  // gone can be found by id instead of compared one at a time.
  const stored = await rest(ctx, 'chat_knowledge_base?source_type=eq.scraped&select=id,source_key,status,metadata', { auth: 'user' });
  const known = new Map((Array.isArray(stored) ? stored : []).map((row) => [row.source_key, row]));

  const changed = [];
  let unchanged = 0;
  for (const { page, text } of scraped) {
    const sourceKey = `page:${page.id}`;
    const existing = known.get(sourceKey);
    const checksum = fingerprint(`${page.title}\n${text}`);
    // A row somebody archived or pulled back to draft is a decision, not a stale copy, so the sync
    // steps over it. Without this, an entry archived because its page was out of date would be
    // republished on the next pass, and the switch on the Knowledge screen would mean nothing.
    if (existing && existing.status !== 'published') {
      unchanged += 1;
      continue;
    }
    // The checksum is of the page as it was when the row was last written. An entry edited here
    // keeps the old one, so an edit survives every sync that finds the page unchanged — and is
    // replaced only when the page really did change.
    if (existing && existing.metadata?.checksum === checksum) {
      unchanged += 1;
      continue;
    }
    changed.push({
      source_type: 'scraped',
      source_key: sourceKey,
      title: String(page.title || 'Untitled'),
      url: `/${page.slug}`,
      content: text,
      // Left blank when the page has no excerpt: the trigger fills it from the content.
      excerpt: plainText(page.excerpt).slice(0, 600),
      status: 'published',
      metadata: { page_id: page.id, slug: page.slug, is_post: Boolean(page.is_post), checksum, synced_at: startedAt },
    });
  }

  // The unique index on (source_type, source_key) is what makes this an update rather than a second
  // copy of the page; the trigger then re-splits only the content that changed.
  for (let index = 0; index < changed.length; index += SYNC_BATCH) {
    await rest(ctx, 'chat_knowledge_base?on_conflict=source_type,source_key', {
      method: 'POST',
      auth: 'user',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: changed.slice(index, index + SYNC_BATCH),
    });
  }

  const live = new Set(scraped.map(({ page }) => `page:${page.id}`));
  const stale = [...known.values()]
    .filter((row) => row.status === 'published' && !live.has(row.source_key))
    .map((row) => row.id);
  for (let index = 0; index < stale.length; index += ARCHIVE_BATCH) {
    const ids = stale.slice(index, index + ARCHIVE_BATCH).join(',');
    await rest(ctx, `chat_knowledge_base?id=in.(${ids})`, {
      method: 'PATCH',
      auth: 'user',
      prefer: 'return=minimal',
      body: { status: 'archived' },
    });
  }

  // Recorded after the writes, so a failed sync never looks like a fresh one. Failing to write the
  // timestamp is not a failed sync: the entries are already in, and the next run rewrites whatever
  // the fingerprint says has changed.
  await rest(ctx, 'options?on_conflict=option_name', {
    method: 'POST',
    auth: 'user',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [{ option_name: 'chat_knowledge_last_sync', option_value: startedAt }],
  }).catch((error) => console.warn(`[rwp-chat] The knowledge base was synced, but chat_knowledge_last_sync was not saved: ${error?.message}`));

  return {
    status: 200,
    body: {
      pages: Array.isArray(pages) ? pages.length : 0,
      indexed: scraped.length,
      skipped: (Array.isArray(pages) ? pages.length : 0) - scraped.length,
      created: changed.filter((row) => !known.has(row.source_key)).length,
      updated: changed.filter((row) => known.has(row.source_key)).length,
      unchanged,
      archived: stale.length,
      last_sync: startedAt,
    },
  };
}

/** How much text one refinement is given. A longer entry is trimmed rather than refused. */
const REFINE_INPUT_CHARS = 8_000;
/** Room for a rewrite of everything above. */
const REFINE_OUTPUT_TOKENS = 3_000;
/** The admin screen shows a spinner for this long. Unlike a chat reply, a person is waiting. */
const REFINE_TIMEOUT_MS = 45_000;

/**
 * What a refinement may and may not do.
 *
 * The point of the rewrite is retrieval: the passage a question matches should contain a sentence
 * that answers it, in the site's own words. So the model may reorganise and clarify, and may not add
 * a fact, a number or a promise — what it produces is quoted to visitors as if the site wrote it.
 */
const REFINE_PROMPT = `You are editing one entry of a company's knowledge base. An AI assistant quotes this text to
customers when they ask a question, so the text has to read as the company's own words.

Rewrite it so that a question about this subject matches it and can be answered from it.

Rules
1. Keep every fact exactly as written. Prices, dates, times, quantities, names, model numbers,
   email addresses and URLs are copied character for character. Never round, convert or update one.
2. Add nothing. No new policy, no extra detail, no advice, no example that is not in the text, no
   promise the original did not make. If the text is silent about something, it stays silent.
3. Remove what is not knowledge: navigation labels, cookie notices, "click here", image captions,
   duplicated headings and boilerplate that appears on every page.
4. Write plain prose in the company's own voice, in the same language as the text. Paragraphs of
   two or three sentences, each about one subject, are ideal. No Markdown, no bullet characters, no
   headings, no code fences.
5. Keep the original length within about a quarter. Shortening is fine when what is cut is not
   knowledge; padding the text out with words that say nothing is not.
6. If the text contains nothing that could answer a customer's question, return an empty content
   string instead of inventing something.

Also return a title of five words or fewer: what a person would search for to find this.`;

const REFINE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    content: { type: 'STRING' },
  },
  required: ['content'],
};

/**
 * Rewrites one entry so the assistant can answer from it.
 *
 * Only the text is sent — never the stored row, the metadata, or anything a visitor typed — and the
 * answer goes back to the screen instead of being saved, so an administrator reads it before it
 * becomes something the site says. That is why this is a button and not a step inside the sync.
 */
export async function refineRoute(ctx, { callAiJson, isAiConfigured, AiError }) {
  const body = ctx.json() || {};
  const content = String(body.content || '').trim();
  if (content.length < 20) {
    return { status: 400, body: { error: 'There is nothing to refine yet: write or paste the text first.' } };
  }

  const config = await ctx.aiConfig();
  if (!isAiConfigured(config)) {
    return {
      status: 501,
      body: { error: 'Refining needs an AI key. Save one on Settings → Integrations → AI, then try again.' },
    };
  }

  const title = String(body.title || '').trim().slice(0, 300);
  const instruction = String(body.instruction || '').trim().slice(0, 600);
  const truncated = content.length > REFINE_INPUT_CHARS;

  try {
    const { parsed, model } = await callAiJson(config, {
      system: REFINE_PROMPT,
      messages: [{
        role: 'user',
        text: `${title ? `Title: ${title}\n\n` : ''}Text to edit:\n\n${content.slice(0, REFINE_INPUT_CHARS)}`
          + (instruction ? `\n\nAlso, as far as these rules allow: ${instruction}` : ''),
      }],
      schema: REFINE_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: REFINE_OUTPUT_TOKENS,
      timeoutMs: REFINE_TIMEOUT_MS,
      blocked: 'The provider refused to edit this text. Check that it holds nothing the provider considers sensitive, or edit it by hand.',
      truncated: 'The rewrite hit the model\'s output limit. Refine a shorter part of the text.',
      logTag: 'rwp-chat knowledge',
    });

    const refined = String(parsed?.content || '').trim();
    if (!refined) {
      return {
        status: 422,
        body: { error: 'The model found nothing here that could answer a customer\'s question, which usually means the text is navigation or boilerplate rather than knowledge.' },
      };
    }
    return {
      status: 200,
      body: {
        title: String(parsed?.title || '').trim().slice(0, 120),
        content: refined,
        model,
        // Said out loud, because a rewrite of a cut-down entry reads complete but is not.
        truncated,
      },
    };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

/** How many passages the preview shows: more than the model gets, so the ranking is visible. */
const PREVIEW_LIMIT = 8;

/**
 * What the assistant would be told for this question.
 *
 * The one way to check the thing that actually matters: not "is the page on the site" but "when a
 * visitor asks this, does anything come back". It runs the same retrieval a chat reply runs, so a
 * passage shown here is a passage the model would have been given.
 */
/**
 * What the assistant would be handed for one question, so an administrator can see the corpus
 * answer — or fail to answer — before a customer finds out.
 *
 * It runs the same query shape the assistant runs: rwp_chat_knowledge_search takes one word, so the
 * question is split by `searchTerms` and each term is asked separately, exactly as `loadLibrary`
 * does. Passing the whole question to a single-word full-text query would match almost nothing and
 * report terms that were never actually looked up. The text is cut at `LIBRARY_ENTRY_CHARS` for the
 * same reason: what the screen shows is what the model would be given, not more.
 */
export async function searchRoute(ctx, { rest, requireAdmin }) {
  await requireAdmin(ctx);
  const query = String(ctx.json()?.query || '').trim().slice(0, 300);
  if (!query) {
    return { status: 400, body: { error: 'Type a question a visitor might ask, so there is something to look for.' } };
  }

  const terms = searchTerms(query, LIBRARY_TERMS);
  // A question made entirely of stop words ("how long does it take") still has to search something.
  const asked = terms.length ? terms : [query];
  const results = await Promise.all(asked.map((term) => rest(ctx, 'rpc/rwp_chat_knowledge_search', {
    method: 'POST',
    auth: 'anon',
    body: { p_query: term, p_limit: PREVIEW_LIMIT },
  }).catch(() => [])));

  /** entry:part → the best rank any term gave it, so a passage matched twice appears once. */
  const best = new Map();
  results.forEach((rows, index) => {
    for (const row of rows || []) {
      if (!row || row.entry_id === undefined || row.entry_id === null) continue;
      const text = String(row.content || '').trim().slice(0, LIBRARY_ENTRY_CHARS);
      if (!text) continue;
      // Longest term first, as `loadLibrary` weights them: a hit on the more specific word wins.
      const rank = (Number(row.rank) || 0) + (asked.length - index) / 100;
      const key = `${row.entry_id}:${row.part}`;
      const known = best.get(key);
      if (!known || rank > known.rank) best.set(key, { row, text, rank });
    }
  });

  const passages = [...best.values()]
    .sort((a, b) => b.rank - a.rank || String(a.row.title || '').localeCompare(String(b.row.title || '')))
    .slice(0, PREVIEW_LIMIT)
    .map(({ row, text, rank }) => ({
      title: String(row.title || 'Untitled'),
      url: row.url ? String(row.url) : '',
      source_type: String(row.source_type || ''),
      part: Number(row.part) || 0,
      rank,
      text,
    }));

  return { status: 200, body: { query, terms, passages } };
}

/** Exported for tests. */
export const _internal = {
  matchPath, recentPath, contextPath, fingerprint,
  PASSAGE_CHARS, TOTAL_CHARS, LIBRARY_ENTRY_CHARS, LIBRARY_MAX_ENTRIES, MIN_PAGE_CHARS,
};

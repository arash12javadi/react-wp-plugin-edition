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
 * an answer that repeats "£4.95" is only safe if a human can find the page it came from.
 */
export const describeKnowledge = (passages) => (passages || [])
  .map((passage) => `- ${passage.title} (${passage.url}): ${passage.text || '(no body text — link to it, but do not describe it)'}`)
  .join('\n');

/** Exported for tests. */
export const _internal = { matchPath, recentPath, contextPath, PASSAGE_CHARS, TOTAL_CHARS };

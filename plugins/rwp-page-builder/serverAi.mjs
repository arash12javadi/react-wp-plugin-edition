/**
 * Copy optimisation for POST /api/plugins/rwp-page-builder/ai/section.
 *
 * One route serves the three AI Refine scopes the editor offers: a whole section, one widget and one
 * text field. They differ only in which items the browser sends, so the prompt, the validation and
 * the rate limit are shared.
 *
 * The key is the one saved on Settings → Integrations → AI: the plugin context resolves it and
 * `server/integrationAi.mjs` spends it, which is also what lets a site change provider without this
 * plugin changing. A VITE_ variable would be compiled into the JavaScript every visitor downloads,
 * where anyone could read it and spend the quota.
 *
 * The browser sends only copy (headings, paragraphs, button labels) with a little context about where
 * it lives. The model returns replacement strings for the same ids; it never sees or edits the
 * layout JSON, so ids, structure, links, styles and private form settings cannot change.
 *
 * There is no cap on how much text a refinement may send. A long section is split into several
 * provider calls instead (see `batchesOf`), which removes the reason the old 24,000-character limit
 * existed at all.
 */

import { AI_SETTINGS_HINT, AiError, callAiJson, describeAiStatus, isAiConfigured } from '../../server/integrationAi.mjs';

/**
 * The AI half of `GET status`, the same shape the other plugins' status routes answer with.
 */
export const aiStatus = async (ctx) => describeAiStatus(await ctx.aiConfig());

/** How long one provider call may take before the editor is told, rather than left waiting. */
const TIMEOUT_MS = 45_000;

/**
 * How much text one provider call may rewrite.
 *
 * An answer is roughly as long as the text it replaces, and every provider caps an answer (8,192
 * output tokens is the common floor of the current models). Long copy is therefore split across
 * calls rather than refused: the old 4,000-characters-per-field and 24,000-characters-per-section
 * limits were only ever there to stay under that ceiling.
 */
const BATCH_CHARS = 6_000;
/**
 * The most provider calls one refinement may start.
 *
 * Not a length limit but a spending one: the rate limiter counts clicks, and without this a single
 * click on a very large section could buy dozens of generations. 12 × 6,000 characters is far beyond
 * any real section; the message below tells the editor to refine a widget if they hit it.
 */
const MAX_BATCHES = 12;
/** The answer ceiling asked of the provider, per batch. Billing follows the tokens used, not this. */
const OUTPUT_TOKENS = { base: 2_048, perItem: 512, max: 8_192 };
/** A custom instruction steers a rewrite in a sentence or two; this only stops a whole page being pasted in. */
const MAX_PROMPT_CHARS = 4_000;

// Per-user rate limit ------------------------------------------------------------------------------
// In-memory (per process). Every provider meters its own account; this keeps one editor clicking
// "Generate" repeatedly from using all of it.
const calls = new Map();
const USER_LIMIT = 8;
const WINDOW_MS = 60_000;

function rateLimited(userId) {
  const now = Date.now();
  const recent = (calls.get(userId) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= USER_LIMIT) return true;
  recent.push(now);
  calls.set(userId, recent);
  return false;
}

// Prompt -------------------------------------------------------------------------------------------

export const PRESETS = {
  seo: 'Improve the copy for readability and search relevance. Use the focus keyword naturally where it fits (headings and the first sentence are good places), never stuff it, and prefer short sentences and plain words.',
  cta: 'Strengthen the calls to action so visitors convert. Button labels become short, specific action phrases that start with a verb ("Get started", "Book a demo", "Download the guide"). Supporting copy states the benefit and removes hesitation.',
  shorten: 'Shorten and simplify. Make every string punchy and modern: cut filler, use active voice, and keep only what the visitor needs. Aim for roughly 30–50% fewer words without losing meaning.',
  tone: 'Rewrite the copy in the requested tone while keeping the meaning and facts.',
};

export const TONES = {
  professional: 'professional: confident, precise and credible',
  casual: 'casual: friendly, conversational and warm',
  urgent: 'urgent: time-sensitive and direct, without false claims',
  persuasive: 'persuasive: benefit-led, addresses objections, builds desire',
};

const SYSTEM_PROMPT = `You are a senior conversion copywriter and SEO editor improving one block of copy from a web page built with a visual page builder.

You receive JSON with:
- "context": what is being rewritten — a whole section, a single widget or one text field — with its layout (for context only)
- "items": the text fields to rewrite, each { "id", "widget", "field", "format", "text" }
- "instructions": what to improve

Rules:
1. Return JSON exactly matching the response schema: { "items": [{ "id", "text" }], "summary" }.
2. Only use the ids of the items you were sent; the ids are short numbers. Include an item only if you changed it; if nothing needs changing, return an empty "items" array and explain why in "summary". Never invent new ids.
3. Keep every dynamic tag ({{...}}) and shortcode ([...]) exactly as written, character for character.
4. "format": "text" means plain text: no HTML, no Markdown. "format": "html" means keep the same kind of simple HTML (p, strong, em, a, ul, ol, li, br, h2–h4); keep existing links and their href values unchanged; never add scripts, styles, iframes or attributes other than href.
5. Match each field's role: headings stay heading-length, button labels stay 1–4 words, paragraphs stay paragraphs.
6. Do not invent facts, prices, statistics, testimonials, names or guarantees that are not in the input. Keep testimonial quotes attributed to the same person and do not change what they said beyond light polishing.
7. Write in the same language as the input text.
8. "summary": one or two sentences on what you changed and why.
9. The items you are sent are the whole task: do not write copy for anything that was not sent, and return a replacement for every item you can improve however long the input is.`;

function validateRequest(body) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length) throw new AiError(400, 'There is no text to optimize.');
  // The model is sent numbered ids ("1", "2", ...) and the editor's own id stays here as `sourceId`.
  // A model rewriting a few thousand characters has to copy an id back for every item, and a long
  // opaque id (`n_1729...|text`) is easy to mistype; the mistyped answer then matched no item and was
  // dropped without a word, which is exactly what "the AI suggested no changes" turned out to be.
  // A number cannot be mistyped into a different item.
  const clean = items.map((item, index) => {
    if (typeof item?.id !== 'string' || typeof item?.text !== 'string') throw new AiError(400, 'Each item needs a string id and text.');
    return {
      id: String(index + 1),
      sourceId: item.id.slice(0, 200),
      widget: String(item.widget || '').slice(0, 60),
      field: String(item.field || '').slice(0, 60),
      format: item.format === 'html' ? 'html' : 'text',
      text: item.text,
    };
  });
  const characters = clean.reduce((total, item) => total + item.text.length, 0);
  if (characters > BATCH_CHARS * MAX_BATCHES) {
    throw new AiError(400, `This is ${characters.toLocaleString('en-US')} characters of text, which is more than one refinement can cover (${(BATCH_CHARS * MAX_BATCHES).toLocaleString('en-US')}). Select a widget or a section and refine that instead.`);
  }

  const preset = Object.hasOwn(PRESETS, body.preset) ? body.preset : null;
  const tone = Object.hasOwn(TONES, body.tone) ? body.tone : null;
  const customPrompt = typeof body.customPrompt === 'string' ? body.customPrompt.trim() : '';
  if (customPrompt.length > MAX_PROMPT_CHARS) {
    throw new AiError(400, `Keep the instruction under ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters (it is ${customPrompt.length.toLocaleString('en-US')}).`);
  }
  if (!preset && !customPrompt) throw new AiError(400, 'Choose a preset or write an instruction.');
  if (preset === 'tone' && !tone) throw new AiError(400, 'Choose a tone.');

  const context = body.context && typeof body.context === 'object' ? {
    kind: String(body.context.kind || 'Section').slice(0, 60),
    columns: Number(body.context.columns) || 1,
    widgets: Array.isArray(body.context.widgets) ? body.context.widgets.slice(0, 40).map((widget) => String(widget).slice(0, 40)) : [],
    position: String(body.context.position || '').slice(0, 40),
  } : { kind: 'Section' };

  return {
    items: clean,
    context,
    preset,
    tone,
    customPrompt,
    focusKeyword: typeof body.focusKeyword === 'string' ? body.focusKeyword.trim().slice(0, 100) : '',
    pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle.trim().slice(0, 200) : '',
  };
}

function buildInstructions(request) {
  const lines = [];
  if (request.preset) lines.push(PRESETS[request.preset]);
  if (request.preset === 'tone' || request.tone) lines.push(`Tone: ${TONES[request.tone || 'professional']}.`);
  if (request.focusKeyword) lines.push(`Focus keyword for the page: "${request.focusKeyword}".`);
  if (request.pageTitle) lines.push(`The page is titled "${request.pageTitle}".`);
  // The custom prompt is the user's own instruction, but it is placed inside the data, after the
  // rules, so it cannot override them (for example to return other ids).
  if (request.customPrompt) lines.push(`Additional instruction from the editor: ${request.customPrompt}`);
  return lines.join('\n');
}

/** The items as the model sees them: numbered ids only, none of the server's bookkeeping. */
const modelItems = (items) => items.map(({ id, widget, field, format, text }) => ({ id, widget, field, format, text }));

// Dynamic tags ({{page.title}}) and shortcodes ([rwp_login], [rwp_add_to_cart id="…"]). Shortcode
// names are lowercase with key=value attributes, so bracketed copy such as "[Step-by-Step Guide]"
// is not mistaken for one.
const tokensOf = (text) => [...String(text).matchAll(/\{\{[^}]*\}\}|\[\/?[a-z][a-z0-9_-]*(?:\s+[a-z_-]+=[^\]]*)?\]/g)].map((match) => match[0]).sort();

/**
 * Keeps only replacements for known ids that preserve every dynamic tag and shortcode.
 *
 * Three things a model can do are counted rather than swallowed, because they look identical to the
 * editor ("no changes") while needing three different answers: an entry naming no item we sent
 * (`ignored`), a rewrite the rules refuse (`rejected` with its reason), and a rewrite identical to
 * the original, which is a legitimate "nothing to change".
 */
function validateResponse(request, parsed) {
  const entries = Array.isArray(parsed?.items) ? parsed.items : [];
  const byId = new Map(request.items.map((item) => [item.id, item]));
  // One answer for one item is unambiguous even when its id came back mangled or missing.
  const lone = request.items.length === 1 && entries.length === 1 ? request.items[0] : null;
  const accepted = [];
  const rejected = [];
  let ignored = 0;
  for (const entry of entries) {
    // JSON mode still returns "id": 1 as a number for some providers, and a model may pad it.
    const original = byId.get(String(entry?.id ?? '').trim()) || lone;
    if (!original || typeof entry.text !== 'string') {
      ignored += 1;
      continue;
    }
    const text = entry.text.trim();
    if (!text || text === original.text.trim()) continue;
    const before = tokensOf(original.text).join('\n');
    // Added tags or shortcodes are rejected too: they run on the live page ([rwp_login] renders a form).
    if (tokensOf(text).join('\n') !== before) {
      rejected.push({ id: original.sourceId, reason: 'changed a dynamic tag or shortcode' });
      continue;
    }
    if (text.length > Math.max(original.text.length * 3, original.text.length + 600)) {
      rejected.push({ id: original.sourceId, reason: 'the rewrite was far longer than the original' });
      continue;
    }
    accepted.push({ id: original.sourceId, text });
  }
  return {
    items: accepted,
    rejected,
    ignored,
    summary: typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 600) : '',
  };
}

// The call ------------------------------------------------------------------------------------------

/**
 * The schema the answer has to match: a replacement for any id it changed, plus a short summary.
 *
 * Written Google's way (`type: 'OBJECT'`); `integrationAi.mjs` re-cases the types for OpenAI, so this
 * is the single description of the answer however the site is configured, and it cannot drift from
 * what `validateResponse` expects.
 */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['id', 'text'] } },
    summary: { type: 'STRING' },
  },
  required: ['items'],
};

/**
 * Splits the items into provider calls small enough that the answer cannot hit the output ceiling.
 *
 * Greedy and order-preserving. An item is never split, because its rewrite is one string, so a single
 * item larger than `BATCH_CHARS` becomes a batch of its own.
 */
function batchesOf(items) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const item of items) {
    if (batch.length && size + item.text.length > BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(item);
    size += item.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** The answer ceiling for one batch: room for its rewrites plus the JSON written around them. */
const answerTokens = (items) => Math.min(
  OUTPUT_TOKENS.max,
  OUTPUT_TOKENS.base
    + items.length * OUTPUT_TOKENS.perItem
    + Math.ceil(items.reduce((total, item) => total + item.text.length, 0) / 4),
);

/**
 * One rewrite, from whichever provider the AI card is set to.
 *
 * A single user turn carries the block and the instruction; the rules are the system prompt, so the
 * model is told what it may change before it is told what to change. The retries a provider needs (a
 * retired model name, an older OpenAI model with no structured outputs) live in `callAiJson`, so
 * nothing below this line is provider-specific.
 */
const ask = (config, request) => callAiJson(config, {
  system: SYSTEM_PROMPT,
  messages: [{
    role: 'user',
    text: JSON.stringify({ context: request.context, instructions: buildInstructions(request), items: modelItems(request.items) }),
  }],
  schema: RESPONSE_SCHEMA,
  temperature: 0.6,
  timeoutMs: TIMEOUT_MS,
  maxOutputTokens: answerTokens(request.items),
  blocked: 'The AI refused to rewrite this text. Reword the custom instruction, or edit the text by hand.',
  truncated: 'The answer was cut off. Try again, or refine one widget or one text field instead of the whole section.',
  logTag: 'rwp-page-builder',
});

/** Route handler. `rest` is the plugin's Supabase REST helper. */
export async function optimizeCopyRoute(ctx, rest) {
  const config = await ctx.aiConfig();
  if (!isAiConfigured(config)) {
    return { status: 501, body: { error: `AI optimization has no key yet. Save one on ${AI_SETTINGS_HINT} and this button starts working.` } };
  }
  if (!ctx.bearerToken) return { status: 401, body: { error: 'Sign in to use AI optimization.' } };

  const userResponse = await fetch(`${ctx.supabase.url.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: ctx.supabase.publishableKey, Authorization: `Bearer ${ctx.bearerToken}` },
  });
  if (!userResponse.ok) return { status: 401, body: { error: 'Your session has expired. Sign in again.' } };
  const user = await userResponse.json();
  const allowed = await rest(ctx, 'rpc/user_has_cap', { method: 'POST', body: { capability: 'edit_posts' }, auth: 'user' }).catch(() => false);
  if (allowed !== true) return { status: 403, body: { error: 'AI optimization needs the edit_posts capability (Contributor or above).' } };
  if (rateLimited(user.id)) return { status: 429, body: { error: `You can run AI optimization ${USER_LIMIT} times a minute. Wait a moment and try again.` } };

  try {
    const request = validateRequest(ctx.json());
    // One click, one rate-limit slot, one or more provider calls: a long block is split so that no
    // answer is cut off by the model's output ceiling. A failure in any batch fails the refinement,
    // so the editor never applies half a rewrite without being told.
    const items = [];
    const rejected = [];
    const summaries = [];
    let ignored = 0;
    let model = '';
    const batches = batchesOf(request.items);
    for (const [index, batch] of batches.entries()) {
      const { parsed, model: used } = await ask(config, { ...request, items: batch });
      const answer = validateResponse({ ...request, items: batch }, parsed);
      items.push(...answer.items);
      rejected.push(...answer.rejected);
      ignored += answer.ignored;
      if (answer.summary) summaries.push(answer.summary);
      // A batch that changed nothing is worth a line in the log: it is the one failure the editor
      // cannot see from the result alone (an empty answer, a fine answer, and a mistyped id all look
      // the same there).
      if (!answer.items.length) {
        console.warn(`[rwp-page-builder] batch ${index + 1}/${batches.length} changed nothing: ${batch.length} item(s) sent, ${answer.rejected.length} rejected, ${answer.ignored} unreadable, ids [${batch.map((item) => item.id).join(', ')}].`);
      }
      model = used;
    }
    return { status: 200, body: { items, rejected, ignored, summary: summaries.join(' ').slice(0, 600), model } };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

// Exported for tests.
export const _internal = { validateRequest, validateResponse, buildInstructions, batchesOf, answerTokens, tokensOf, modelItems };

/**
 * Section copy optimisation for POST /api/plugins/rwp-page-builder/ai/section.
 *
 * The key is the one saved on Settings → Integrations → AI: the plugin context resolves it and
 * `server/integrationAi.mjs` spends it, which is also what lets a site change provider without this
 * plugin changing. A VITE_ variable would be compiled into the JavaScript every visitor downloads,
 * where anyone could read it and spend the quota.
 *
 * The browser sends only the section's copy (headings, paragraphs, button labels) with a little
 * layout context. The model returns replacement strings for the same ids; it never sees or edits the
 * layout JSON, so ids, structure, links, styles and private form settings cannot change.
 */

import { AI_SETTINGS_HINT, AiError, callAiJson, describeAiStatus, isAiConfigured } from '../../server/integrationAi.mjs';

/**
 * The AI half of `GET status`, the same shape the other plugins' status routes answer with.
 */
export const aiStatus = async (ctx) => describeAiStatus(await ctx.aiConfig());

/** How long the model may take before the editor is told, rather than left waiting. */
const TIMEOUT_MS = 45_000;
const MAX_ITEMS = 80;
const MAX_ITEM_CHARS = 4_000;
const MAX_TOTAL_CHARS = 24_000;
const MAX_PROMPT_CHARS = 500;

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

const SYSTEM_PROMPT = `You are a senior conversion copywriter and SEO editor improving ONE section of a web page built with a visual page builder.

You receive JSON with:
- "section": what kind of section it is and its layout (for context only)
- "items": the section's text fields, each { "id", "widget", "field", "format", "text" }
- "instructions": what to improve

Rules:
1. Return JSON exactly matching the response schema: { "items": [{ "id", "text" }], "summary" }.
2. Only use ids from the input. Include an item only if you changed it. Never invent new ids.
3. Keep every dynamic tag ({{...}}) and shortcode ([...]) exactly as written, character for character.
4. "format": "text" means plain text: no HTML, no Markdown. "format": "html" means keep the same kind of simple HTML (p, strong, em, a, ul, ol, li, br, h2–h4); keep existing links and their href values unchanged; never add scripts, styles, iframes or attributes other than href.
5. Match each field's role: headings stay heading-length, button labels stay 1–4 words, paragraphs stay paragraphs.
6. Do not invent facts, prices, statistics, testimonials, names or guarantees that are not in the input. Keep testimonial quotes attributed to the same person and do not change what they said beyond light polishing.
7. Write in the same language as the input text.
8. "summary": one or two sentences on what you changed and why.`;

function validateRequest(body) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length) throw new AiError(400, 'This section has no text fields to optimize.');
  if (items.length > MAX_ITEMS) throw new AiError(400, `This section has ${items.length} text fields; the limit is ${MAX_ITEMS}. Optimize a smaller section.`);
  let total = 0;
  const clean = items.map((item) => {
    if (typeof item?.id !== 'string' || typeof item?.text !== 'string') throw new AiError(400, 'Each item needs a string id and text.');
    if (item.text.length > MAX_ITEM_CHARS) throw new AiError(400, `The field "${String(item.field || item.id).slice(0, 60)}" is over ${MAX_ITEM_CHARS} characters; shorten it or optimize it separately.`);
    total += item.text.length;
    return {
      id: item.id.slice(0, 200),
      widget: String(item.widget || '').slice(0, 60),
      field: String(item.field || '').slice(0, 60),
      format: item.format === 'html' ? 'html' : 'text',
      text: item.text,
    };
  });
  if (total > MAX_TOTAL_CHARS) throw new AiError(400, `This section has ${total} characters of text; the limit is ${MAX_TOTAL_CHARS}. Optimize a smaller section.`);

  const preset = Object.hasOwn(PRESETS, body.preset) ? body.preset : null;
  const tone = Object.hasOwn(TONES, body.tone) ? body.tone : null;
  const customPrompt = typeof body.customPrompt === 'string' ? body.customPrompt.trim().slice(0, MAX_PROMPT_CHARS) : '';
  if (!preset && !customPrompt) throw new AiError(400, 'Choose a preset or write an instruction.');
  if (preset === 'tone' && !tone) throw new AiError(400, 'Choose a tone.');

  const section = body.section && typeof body.section === 'object' ? {
    kind: String(body.section.kind || 'Section').slice(0, 60),
    columns: Number(body.section.columns) || 1,
    widgets: Array.isArray(body.section.widgets) ? body.section.widgets.slice(0, 40).map((widget) => String(widget).slice(0, 40)) : [],
    position: String(body.section.position || '').slice(0, 40),
  } : { kind: 'Section' };

  return {
    items: clean,
    section,
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

// Dynamic tags ({{page.title}}) and shortcodes ([rwp_login], [rwp_add_to_cart id="…"]). Shortcode
// names are lowercase with key=value attributes, so bracketed copy such as "[Step-by-Step Guide]"
// is not mistaken for one.
const tokensOf = (text) => [...String(text).matchAll(/\{\{[^}]*\}\}|\[\/?[a-z][a-z0-9_-]*(?:\s+[a-z_-]+=[^\]]*)?\]/g)].map((match) => match[0]).sort();

/** Keeps only replacements for known ids that preserve every dynamic tag and shortcode. */
function validateResponse(request, parsed) {
  const byId = new Map(request.items.map((item) => [item.id, item]));
  const accepted = [];
  const rejected = [];
  for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
    const original = byId.get(entry?.id);
    if (!original || typeof entry.text !== 'string') continue;
    const text = entry.text.trim();
    if (!text || text === original.text.trim()) continue;
    const before = tokensOf(original.text).join('\n');
    // Added tags or shortcodes are rejected too: they run on the live page ([rwp_login] renders a form).
    if (tokensOf(text).join('\n') !== before) {
      rejected.push({ id: original.id, reason: 'changed a dynamic tag or shortcode' });
      continue;
    }
    if (text.length > Math.max(original.text.length * 3, original.text.length + 600)) {
      rejected.push({ id: original.id, reason: 'the rewrite was far longer than the original' });
      continue;
    }
    accepted.push({ id: original.id, text });
  }
  return { items: accepted, rejected, summary: typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 600) : '' };
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
 * One rewrite, from whichever provider the AI card is set to.
 *
 * A single user turn carries the section and the instruction; the rules are the system prompt, so the
 * model is told what it may change before it is told what to change. The retries a provider needs (a
 * retired model name, an older OpenAI model with no structured outputs) live in `callAiJson`, so
 * nothing below this line is provider-specific.
 */
const ask = (config, request) => callAiJson(config, {
  system: SYSTEM_PROMPT,
  messages: [{
    role: 'user',
    text: JSON.stringify({ section: request.section, instructions: buildInstructions(request), items: request.items }),
  }],
  schema: RESPONSE_SCHEMA,
  temperature: 0.6,
  timeoutMs: TIMEOUT_MS,
  blocked: 'The AI refused to rewrite this section. Reword the custom instruction, or edit the text by hand.',
  truncated: 'The answer was cut off because the section is too long. Optimize a smaller section.',
  logTag: 'rwp-page-builder',
});

/** Route handler. `rest` is the plugin's Supabase REST helper. */
export async function optimizeSectionRoute(ctx, rest) {
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
    const { parsed, model } = await ask(config, request);
    return { status: 200, body: { ...validateResponse(request, parsed), model } };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

// Exported for tests.
export const _internal = { validateRequest, validateResponse, buildInstructions, tokensOf };

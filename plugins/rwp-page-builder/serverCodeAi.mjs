/**
 * AI code assistant for the Custom HTML widget: POST /api/plugins/rwp-page-builder/ai/code.
 *
 * Custom HTML is the one widget whose code runs in every visitor's browser, so this route is
 * stricter than AI Section Refine: it needs manage_options (the same capability the database
 * trigger demands when Custom HTML code is added or changed) and it returns whole field values
 * instead of a patch. The model only ever sees this widget's code and the editor's instruction.
 *
 * The answer is validated and bounded here before it reaches the browser. The editor validates it
 * again and applies it as one undoable store commit, so a slow answer cannot overwrite an edit made
 * while the request was in flight.
 *
 * The key is the one saved on Settings → Integrations → AI, resolved by the plugin context and
 * spent by `server/integrationAi.mjs`; a VITE_ variable would be public.
 */

import { AI_SETTINGS_HINT, AiError, callAiJson, isAiConfigured } from '../../server/integrationAi.mjs';

/** How long the model may take before the editor is told, rather than left waiting. */
const TIMEOUT_MS = 90_000;

/** Per field and per request ceilings, so one answer cannot balloon into a multi-megabyte save. */
const FIELD_LIMITS = { html: 24_000, css: 16_000, js: 16_000, jsx: 24_000 };
const MAX_INPUT_CHARS = 48_000;
const MAX_OUTPUT_CHARS = 56_000;
const MAX_INSTRUCTION_CHARS = 1_200;

/** Which fields the widget uses in each mode. Mirrors render/widgets/pro.tsx. */
const FIELDS_BY_MODE = {
  html: ['html', 'css', 'js'],
  react: ['jsx', 'css'],
};

// Per-user rate limit ------------------------------------------------------------------------------
// In-memory (per process). Generating a whole section is more expensive than refining copy, so the
// window is tighter than AI Section Refine's.
const calls = new Map();
const USER_LIMIT = 6;
const WINDOW_MS = 60_000;

function rateLimited(userId) {
  const now = Date.now();
  const recent = (calls.get(userId) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= USER_LIMIT) return true;
  recent.push(now);
  calls.set(userId, recent);
  if (calls.size > 5_000) {
    for (const [key, times] of calls) if (!times.some((time) => now - time < WINDOW_MS)) calls.delete(key);
  }
  return false;
}

// Prompt -------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior front-end engineer editing ONE Custom HTML widget in a visual page builder.

The widget has these code fields:
- "html": raw HTML, rendered with innerHTML. <script> tags in it do NOT run.
- "css": the widget's stylesheet. The word "selector" is replaced with this widget's own class; every other selector is global to the page.
- "js": JavaScript that runs once on the live page after render, with "root" bound to this widget's element. Used in HTML mode only.
- "jsx": React JSX used instead of html/js in React mode. It is compiled at runtime to React.createElement. React, createElement, settings and node are in scope. No imports, no TypeScript, use className rather than class, and return one element or fragment.

You receive JSON with:
- "mode": "html" or "react"
- "pageTitle": the page title, for context only
- "code": the current value of every field this mode uses
- "instruction": what the editor wants changed

Rules:
1. Return JSON exactly matching the response schema: one string per requested field plus "summary". No markdown, no commentary, no diffs.
2. Return the COMPLETE final code of every requested field. If a field should stay as it is, return it exactly unchanged. If a field should be emptied, return "".
3. Never invent field names, and never return a field this mode does not use.
4. Preserve every dynamic tag ({{...}}) and shortcode ([...]) already in the code, character for character, unless the instruction explicitly removes it.
5. In HTML mode put markup in "html", presentation in "css" and behaviour in "js". Never put a <script> tag in "html".
6. In React mode put markup in "jsx" and presentation in "css". There is no html or js field. Prefer function components and hooks over imperative DOM code. No imports or external packages.
7. In CSS, use "selector" for the widget's own element; other selectors are global. Prefer responsive layout, accessible markup (semantic elements, alt text, labels, visible focus) and CSS that works on mobile.
8. Do not add analytics, tracking pixels, remote scripts or network calls. Inline SVG, CSS and https images are fine.
9. Keep existing content and functionality unless the instruction asks to change it. Write visible copy in the same language as the existing copy.
10. "summary": one or two sentences about what you changed and how it works.`;


function validateRequest(body) {
  const mode = body?.mode === 'react' ? 'react' : 'html';
  const active = FIELDS_BY_MODE[mode];
  const source = body?.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : {};
  const fields = {};
  let total = 0;

  for (const field of active) {
    const value = source[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new AiError(400, `The ${field} code must be text.`);
    }
    // Normalise line endings so unchanged code is not reported as changed on Windows.
    const text = typeof value === 'string' ? value.replace(/\r\n/g, '\n') : '';
    if (text.length > FIELD_LIMITS[field]) {
      throw new AiError(400, `The ${field} code is ${text.length.toLocaleString('en-US')} characters; the limit is ${FIELD_LIMITS[field].toLocaleString('en-US')}. Ask for a smaller change, or edit this field by hand.`);
    }
    total += text.length;
    fields[field] = text;
  }

  if (total > MAX_INPUT_CHARS) {
    throw new AiError(400, `This widget has ${total.toLocaleString('en-US')} characters of code; the limit is ${MAX_INPUT_CHARS.toLocaleString('en-US')}. Ask for a smaller change, or edit the code by hand.`);
  }

  const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
  if (instruction.length < 3) {
    throw new AiError(400, 'Describe what you want the widget to do. For example: "Make this a responsive pricing table with three plans."');
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new AiError(400, `Keep the instruction under ${MAX_INSTRUCTION_CHARS} characters.`);
  }

  const pageTitle = typeof body?.pageTitle === 'string' ? body.pageTitle.trim().slice(0, 200) : '';
  return { mode, fields, active, instruction, pageTitle };
}

/** The one user turn: the code and the instruction, with no layout JSON the model could edit. */
function buildPrompt(request) {
  return JSON.stringify({
    mode: request.mode,
    pageTitle: request.pageTitle,
    code: request.fields,
    instruction: request.instruction,
  });
}

/** Only the fields this mode uses, so the model cannot spend tokens on the others. */
function responseSchema(active) {
  const properties = {};
  for (const field of active) properties[field] = { type: 'STRING' };
  properties.summary = { type: 'STRING' };
  return { type: 'OBJECT', properties, required: [...active, 'summary'] };
}

const ask = (config, request) => callAiJson(config, {
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', text: buildPrompt(request) }],
  schema: responseSchema(request.active),
  temperature: 0.25,
  timeoutMs: TIMEOUT_MS,
  blocked: 'The AI refused to edit this code. Reword the instruction or edit the code by hand.',
  truncated: 'The generated code was cut off before it finished. Ask for a smaller change, or click Generate again.',
  logTag: 'rwp-page-builder',
});

/** Models sometimes wrap code in a fence even when asked for JSON. Strip only an outer fence. */
function unwrapCode(value) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/^\s*```[a-z0-9-]*[ \t]*\n?/i, '')
    .replace(/\n?```\s*$/i, '');
}

/**
 * Keeps only complete, bounded replacements. A field the model returned unchanged is omitted, so
 * the editor shows nothing to apply for it, and an all-unchanged answer becomes an explicit
 * "no changes" message in the window instead of an empty diff.
 */
function validateResponse(request, parsed) {
  const fields = {};
  let total = 0;

  for (const field of request.active) {
    const raw = parsed?.[field];
    if (typeof raw !== 'string') continue;
    const text = unwrapCode(raw);
    if (text.length > FIELD_LIMITS[field]) {
      throw new AiError(422, `The AI wrote ${text.length.toLocaleString('en-US')} characters for ${field}; the limit is ${FIELD_LIMITS[field].toLocaleString('en-US')}. Ask for a smaller change.`);
    }
    total += text.length;
    if (total > MAX_OUTPUT_CHARS) {
      throw new AiError(422, `The AI wrote more than ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters of code. Ask for a smaller change.`);
    }
    if (text.trim() === (request.fields[field] || '').trim()) continue;
    fields[field] = text;
  }

  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim().slice(0, 600) : '';
  return { fields, summary };
}

/** Route handler. `rest` is the plugin's Supabase REST helper. */
export async function assistCodeRoute(ctx, rest) {
  const config = await ctx.aiConfig();
  if (!isAiConfigured(config)) {
    return { status: 501, body: { error: `The AI code assistant has no key yet. Save one on ${AI_SETTINGS_HINT} and this window starts working.` } };
  }
  if (!ctx.bearerToken) return { status: 401, body: { error: 'Sign in to use the AI code assistant.' } };

  const userResponse = await fetch(`${ctx.supabase.url.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: ctx.supabase.publishableKey, Authorization: `Bearer ${ctx.bearerToken}` },
  });
  if (!userResponse.ok) return { status: 401, body: { error: 'Your session has expired. Sign in again.' } };
  const user = await userResponse.json();
  const allowed = await rest(ctx, 'rpc/user_has_cap', { method: 'POST', body: { capability: 'manage_options' }, auth: 'user' }).catch(() => false);
  if (allowed !== true) {
    return { status: 403, body: { error: 'The AI code assistant needs the manage_options capability (Administrator), because Custom HTML code runs in visitors\' browsers.' } };
  }
  if (rateLimited(user.id)) {
    return { status: 429, body: { error: `You can run the AI code assistant ${USER_LIMIT} times a minute. Wait a moment and try again.` } };
  }

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
export const _internal = { validateRequest, validateResponse, buildPrompt, responseSchema, unwrapCode };

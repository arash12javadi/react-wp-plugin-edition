/**
 * The core AI assistant: `GET /api/ai/assist` and `POST /api/ai/assist`.
 *
 * The editor's ✨ button asks this route to rewrite the text the author selected — tighten it, expand
 * it, change its tone, summarise it, structure it — and the answer goes back where the selection was.
 * It is a *core* route rather than a plugin's: the classic editor is part of this repository, and it
 * should work on a fresh site without anyone installing anything.
 *
 * Three things are deliberately not here. The provider is not: the key and the model come from the row
 * `Settings → Integrations → AI` writes, spent through `server/integrationAi.mjs`, so switching to
 * OpenAI is a settings change and not a change to this file. The prompt's *text* is not: the task
 * vocabulary below is the whole of what an author can ask for, which keeps the answer's shape known
 * and the instruction to the model reviewable in one place. And the HTML is not trusted: whatever the
 * model answers is put through the allowlist in `sanitizeAssistantHtml` before it is returned, so an
 * answer can add a paragraph and a link but never a `<script>`, an event handler or an inline style.
 * The editor's own schema would drop those anyway — this is the layer that means a caller which is not
 * the editor does not have to rely on that.
 *
 * Both hosts answer these paths with this one module: `server.mjs` for the classic Node server, and
 * `src/server/aiAssist.ts` for the universal engine (Vercel, `npm run start:hono`). Each supplies its
 * own `authorize` adapter — the classic one asks Supabase's `user_has_cap`, the engine asks its own
 * auth adapter — which is the only part that differs between them.
 *
 * Plain ESM and no `process.env`: the key arrives from `system_settings`, read through whichever reader
 * the host offers, exactly as `server/integrationsRoutes.mjs` does it.
 */
import { AI_SETTINGS_HINT, AiError, callAiJson, describeAiStatus, isAiConfigured, readAiConfig } from './integrationAi.mjs';

/** The one path this module answers. */
export const AI_ASSIST_PATH = '/api/ai/assist';

/** Writing a draft is not administering the site, so the capability is the author's, not the admin's. */
export const ASSIST_CAPABILITY = 'edit_posts';

/** The paths this module answers, so a host can skip the call without repeating the list. */
export const ownsAiAssistPath = (pathname) => pathname === AI_ASSIST_PATH;

/** How long the model may take before the editor is told, rather than left waiting. */
const TIMEOUT_MS = 45_000;

/** What the assistant is asked to do, in the author's own words. The keys are the API's tasks. */
export const ASSIST_TASKS = {
  improve: 'Fix the grammar, spelling and punctuation, and smooth the sentences so they read naturally. Keep the meaning, the facts and the author\'s voice; do not add new claims.',
  shorten: 'Tighten the text so it says the same thing in fewer words: cut filler and repetition, prefer active voice and plain words. Keep every heading and every list item that carries information.',
  expand: 'Add the detail a reader would ask for next — one concrete example, a clarifying sentence, or the consequence of what was said. Stay strictly within what the text already implies; invent no facts, figures or names.',
  tone: 'Rewrite the text in the requested tone while keeping its meaning and its facts.',
  summarize: 'Summarise the text as a short bulleted list of the points a reader must take away. Each bullet is one line, in the same language as the text. Return no introduction and no closing sentence.',
  outline: 'Turn the text into an outline: a short heading for each part, in order, with the sentences that belong under it kept beneath it as a paragraph or a list. Do not add content that is not in the text.',
};

/** The tones `task: 'tone'` accepts — the same four names the page builder's Section Refine offers. */
export const ASSIST_TONES = {
  professional: 'professional: confident, precise and credible',
  casual: 'casual: friendly, conversational and warm',
  urgent: 'urgent: time-sensitive and direct, without false claims',
  persuasive: 'persuasive: benefit-led, addresses objections, builds desire',
};

/**
 * The sentences a refusal carries, so both hosts refuse in the same words. The capability check itself
 * belongs to the host (`server/integrationSettings.mjs` on the classic server, the auth adapter on the
 * universal engine), which is why only the text lives here.
 */
export const assistAuthMessages = {
  signedOut: 'Sign in to use the AI assistant in the editor.',
  notInstalled: 'This site is not installed, so the AI assistant cannot run.',
  invalidSession: 'Your session is not valid. Sign in again.',
  capabilityFailure: (capability) =>
    `The AI assistant needs the ${capability} capability — a Contributor, Author, Editor or Administrator role.`,
  unreachable: (detail) => `Could not check whether you may use the AI assistant: ${detail}`,
};

/** Limits, each with the sentence its refusal gets. */
const MAX_TEXT_CHARS = 12_000;
const MAX_INSTRUCTION_CHARS = 500;
const MAX_TITLE_CHARS = 240;
const MAX_OUTPUT_TOKENS = 8_192;

const SELECTION_ERROR = 'Select the text you want the assistant to work on, or write a sentence and put the cursor in it first.';
const NOTHING_ERROR = 'The assistant answered with nothing that can be inserted. Try again, or give it a shorter piece of text.';

/**
 * Per-caller rate limit, in memory (per process).
 *
 * The provider meters the site's own account; this keeps one author holding a key down from spending
 * all of it. The key is the caller's token, hashed, because a token is the only identity every host
 * can supply without a second round trip — and two tabs of the same session share the allowance, which
 * is the behaviour an author expects.
 */
const calls = new Map();
const CALL_LIMIT = 12;
const WINDOW_MS = 60_000;

/** FNV-1a, so no token is ever held in a map key (or in a heap dump) in clear. */
const hashKey = (token) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash);
};

const rateLimited = (token) => {
  const key = hashKey(token);
  const now = Date.now();
  const recent = (calls.get(key) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= CALL_LIMIT) return true;
  recent.push(now);
  calls.set(key, recent);
  return false;
};

/** `Authorization: Bearer …`, read the way the rest of the server reads it. */
const bearerToken = (headers = {}) =>
  String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '');

/** A JSON answer in the shape the core routes use. */
const json = (status, payload) => ({ status, body: { success: status < 400, ok: status < 400, ...payload } });

/**
 * The request, or an `AiError` naming what is wrong with it.
 *
 * Validation happens before the key is spent, so a malformed request costs nothing and the author is
 * told which field to change rather than shown a provider's error.
 */
export const validateRequest = (body = {}) => {
  const task = typeof body.task === 'string' ? body.task.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(ASSIST_TASKS, task)) {
    return new AiError(400, `Unknown task "${task || '(none)'}". Send one of: ${Object.keys(ASSIST_TASKS).join(', ')}.`);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return new AiError(400, SELECTION_ERROR);
  if (text.length > MAX_TEXT_CHARS) {
    return new AiError(400, `The selection is ${text.length} characters; the assistant works on at most ${MAX_TEXT_CHARS}. Split it into smaller pieces.`);
  }
  const tone = typeof body.tone === 'string' ? body.tone.trim().toLowerCase() : '';
  if (task === 'tone' && !Object.prototype.hasOwnProperty.call(ASSIST_TONES, tone)) {
    return new AiError(400, `The "tone" task needs a tone: ${Object.keys(ASSIST_TONES).join(', ')}.`);
  }
  return {
    task,
    tone,
    instruction: typeof body.instruction === 'string' ? body.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS) : '',
    title: typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_CHARS) : '',
    text,
  };
};

/** What the author asked for, as one instruction the model can follow. */
export const buildInstructions = (request) => {
  const parts = [ASSIST_TASKS[request.task]];
  if (request.task === 'tone') parts.push(`The tone: ${ASSIST_TONES[request.tone]}.`);
  if (request.instruction) parts.push(`The author also asks: ${request.instruction}`);
  return parts.join(' ');
};

// The prompt ---------------------------------------------------------------------------------------

/**
 * The rules, told before the text, so the model knows what it may return before it is asked.
 *
 * The tag list is the editor's own vocabulary: each name there is a node or a mark the classic
 * editor's schema already understands, so an answer that follows the rules round-trips into the
 * document without anything being silently dropped. `sanitizeAssistantHtml` enforces the same list,
 * which is why the two are next to each other in this file.
 */
const SYSTEM_PROMPT = `You are the writing assistant built into a WordPress-style content editor. You rewrite the text an author selected. You never write a whole article on your own initiative and you never see the rest of the post.

You receive JSON with:
- "instructions": what to do with the text
- "task": which job this is (${Object.keys(ASSIST_TASKS).join(', ')})
- "title": the title of the post the text belongs to, for context only, and possibly empty
- "text": the selected text, as HTML

Rules:
1. Answer with JSON exactly matching the response schema: { "html": string, "summary": string }. Nothing else, no commentary before or after.
2. "html" is the rewritten selection, as HTML, and it is what replaces the selection in the editor. Use only these tags: <p> <br> <strong> <em> <u> <s> <code> <pre> <a> <ul> <ol> <li> <blockquote> <h2> <h3> <h4> <sub> <sup> <kbd> <hr>. Never a <script>, <style>, <iframe>, <img>, never an "on..." attribute, and never a class or an inline style. Only an <a> may carry attributes: href (an http, https, mailto or site-relative address) and title.
3. Keep every link, number, name and fact that the text contains, and add none that it does not.
4. Write in the language of the text.
5. Text without markup is still HTML: answer with <p> paragraphs and <br> where a line break matters.
6. "summary" is one short sentence for the author, in their language, saying what you changed — "Shortened from 180 to 95 words.", "Fixed two run-on sentences." It is shown above the text in the editor and is never inserted into it. At most 200 characters.`;

/**
 * The schema the answer has to match, written Google's way (`type: 'OBJECT'`);
 * `server/integrationAi.mjs` re-cases the types for OpenAI, so this stays the one description of the
 * answer whatever the site is configured with.
 */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { html: { type: 'STRING' }, summary: { type: 'STRING' } },
  required: ['html'],
};

/** How much freedom each task gets: a summary should be dull, an expansion may be imaginative. */
const TEMPERATURES = { improve: 0.4, shorten: 0.3, expand: 0.7, tone: 0.6, summarize: 0.2, outline: 0.4 };

/**
 * One rewrite, from whichever provider the AI card is set to.
 *
 * The retries a provider needs (a retired model name, an OpenAI model without structured outputs) live
 * in `callAiJson`, so nothing below this line is provider-specific.
 */
const ask = (config, request) => callAiJson(config, {
  system: SYSTEM_PROMPT,
  messages: [{
    role: 'user',
    text: JSON.stringify({
      instructions: buildInstructions(request),
      task: request.task,
      title: request.title,
      text: request.text,
    }),
  }],
  schema: RESPONSE_SCHEMA,
  temperature: TEMPERATURES[request.task] ?? 0.4,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  timeoutMs: TIMEOUT_MS,
  blocked: 'The AI provider refused to rewrite this text. Try another task, or edit it by hand.',
  truncated: 'The answer was cut off because it reached the model\'s output limit, so nothing was inserted. Select a smaller piece of text and try again.',
  logTag: 'ai-assist',
});

// The answer ---------------------------------------------------------------------------------------

/**
 * What an answer may contain: the tags the editor's schema already understands, and — on a link — the
 * four attributes that make one usable.
 *
 * Anything else is dropped, tag by tag, and its name is reported in the response's `removed` list. The
 * point is not that a model is likely to write `<script>` (it is told not to); it is that this route
 * hands text to a browser, and a route which hands text to a browser decides what that text may be. A
 * model that has been prompt-injected, or that is simply having a bad day, gets its tag stripped in
 * this function rather than in whichever renderer happens to see it next.
 */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'code', 'pre', 'a',
  'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'h4', 'sub', 'sup', 'kbd', 'hr',
]);

/** Attributes per tag. A tag not named here carries none of its own. */
const ALLOWED_ATTRIBUTES = { a: new Set(['href', 'title', 'rel', 'target']) };

/** Tags that never have a closing partner, so an answer's own `</br>` must not become one. */
const VOID_TAGS = new Set(['br', 'hr']);

/** A link is worth keeping only if it points somewhere a visitor can be sent. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:|\/|#)/i;

/** One tag, attributes included. A stray `<` that is not a tag stays as text, which is the safe way round. */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;

/** `name="value"`, `name='value'` or a bare `name=value` — the three ways a model writes one. */
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** A block-level tag: a line that starts with one is already a block and gets no `<p>`. */
const BLOCK_START = /^<(?:p|ul|ol|li|blockquote|pre|h[1-6]|hr)\b/i;

/** The part of a tag's text that survives, as ` name="value"` pairs. */
const safeAttributes = (raw, tag, removed) => {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  const kept = [];
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_PATTERN.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = String(match[2] ?? match[3] ?? match[4] ?? '').trim().replace(/\s+/g, ' ');
    if (!allowed?.has(name) || (name === 'href' && !SAFE_HREF.test(value)) || (name === 'target' && value !== '_blank')) {
      removed.add(`${tag} ${name}`);
      continue;
    }
    kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
  }
  // A link that opens a new tab without rel hands window.opener to the destination.
  if (tag === 'a' && kept.includes('target="_blank"') && !kept.some((item) => item.startsWith('rel='))) {
    kept.push('rel="noreferrer noopener"');
  }
  return kept.length ? ` ${kept.join(' ')}` : '';
};

/**
 * The answer's HTML with everything unrecognised removed.
 *
 * @param {string} raw the model's `html` string, exactly as it answered
 * @returns {{html: string, removed: string[]}} the surviving HTML, and what was dropped (by name, for
 *   the editor to mention in one line if it wants to)
 */
export const sanitizeAssistantHtml = (raw) => {
  const removed = new Set();
  const source = String(raw ?? '').replace(/<!--[\s\S]*?-->/g, () => {
    removed.add('comment');
    return '';
  });
  let out = '';
  let cursor = 0;
  TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = TAG_PATTERN.exec(source))) {
    const [, closing, rawName, attributes = '', selfClosing = ''] = match;
    const name = rawName.toLowerCase();
    out += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (!ALLOWED_TAGS.has(name)) {
      removed.add(name);
      continue;
    }
    if (closing) {
      if (!VOID_TAGS.has(name)) out += `</${name}>`;
      continue;
    }
    out += `<${name}${safeAttributes(attributes, name, removed)}${VOID_TAGS.has(name) || selfClosing ? ' /' : ''}>`;
  }
  return { html: out + source.slice(cursor), removed: [...removed].sort() };
};

/**
 * Prose in one run — no blank line, no tags — comes back as one paragraph, so the block structure the
 * editor needs is put in here rather than guessed at by whatever inserted the text. A line that already
 * starts with a block tag is left alone; single newlines inside one become `<br>`, which is what the
 * model meant by them.
 */
export const asBlocks = (html) => String(html)
  .split(/\n{2,}/)
  .map((chunk) => chunk.trim())
  .filter(Boolean)
  .map((chunk) => (BLOCK_START.test(chunk) ? chunk : `<p>${chunk.replace(/\n/g, '<br>')}</p>`))
  .join('\n');

/**
 * The answer, checked and cleaned, or an `AiError` saying why it cannot be used.
 *
 * An answer that survives this is HTML built only from `ALLOWED_TAGS`, which is the guarantee the rest
 * of the editor — and any other caller — relies on.
 */
export const validateResponse = (parsed) => {
  const raw = typeof parsed?.html === 'string' ? parsed.html.trim() : '';
  if (!raw) throw new AiError(502, NOTHING_ERROR);
  const { html, removed } = sanitizeAssistantHtml(raw);
  const content = asBlocks(html);
  if (!content.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, '').trim()) throw new AiError(502, NOTHING_ERROR);
  return {
    html: content,
    summary: typeof parsed?.summary === 'string' ? parsed.summary.trim().slice(0, 240) : '',
    removed,
  };
};

// The route ----------------------------------------------------------------------------------------

/**
 * `GET /api/ai/assist` — can the assistant run, and on which provider's account?
 *
 * Public, like the integrations status route and for the same reason: it reports that a setting is
 * present and which provider and model it names, never the key. It is what lets the editor's ✨ button
 * say the assistant is not set up yet, instead of failing after an author has selected a paragraph.
 */
export const assistStatus = (config) => json(200, {
  ...describeAiStatus(config || {}),
  readable: config?.readable === true,
  capability: ASSIST_CAPABILITY,
  tasks: Object.keys(ASSIST_TASKS),
  tones: Object.keys(ASSIST_TONES),
});

/**
 * @param {object} options
 * @param {string} options.method   HTTP method, straight from the request
 * @param {string} options.pathname the path, without the query string
 * @param {object} options.headers  lowercased request headers; only `authorization` is read
 * @param {object} options.body     the parsed JSON body, for the POST
 * @param {object} options.config   the runtime config: `databaseUrl`, `dbType`, `supabaseUrl`, `supabasePublishableKey`
 * @param {object} options.env      the server environment, for the connection and service keys
 * @param {(key: string) => Promise<unknown>} [options.readSetting] the engine's own adapter reader
 * @param {(token: string, capability: string) => Promise<{ok: boolean, status?: number, error?: string}>} [options.authorize]
 * @returns {Promise<{status: number, body?: object} | null>} null when the path is ours but the method
 *   is not (and, defensively, when the path is not ours at all — `ownsAiAssistPath` is the single list,
 *   so the two can never disagree)
 */
export async function handleAiAssistRequest(options = {}) {
  const { method, pathname, headers = {}, body = {}, config = {}, env = {}, readSetting, authorize } = options;
  const reader = {
    readSetting,
    databaseUrl: config.databaseUrl,
    dbType: config.dbType,
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabasePublishableKey,
    env,
  };

  if (pathname === AI_ASSIST_PATH && method === 'GET') {
    return assistStatus(await readAiConfig(reader));
  }

  if (pathname === AI_ASSIST_PATH && method === 'POST') {
    // Identity first: this route spends the site's key on the caller's behalf, so who is asking is
    // settled before the body is even read — and nothing about the site's configuration is told to a
    // caller who has not signed in.
    if (typeof authorize !== 'function') {
      return json(501, { error: 'This host cannot authorize the AI assistant. Use an editor on a host running the Node server.' });
    }
    const token = bearerToken(headers);
    const permission = await authorize(token, ASSIST_CAPABILITY);
    if (!permission?.ok) {
      return json(permission?.status || 403, { error: permission?.error || assistAuthMessages.signedOut });
    }

    // Then the request itself, before the key is spent: a malformed ask costs nothing and is named.
    const request = validateRequest(body);
    if (request instanceof AiError) return json(request.status, { error: request.message });

    const aiConfig = await readAiConfig(reader);
    if (!isAiConfigured(aiConfig)) {
      return json(501, {
        error: aiConfig.readable === false
          ? `This server could not read ${AI_SETTINGS_HINT}: ${aiConfig.error || 'no connection to system_settings'}. The assistant cannot run until it can.`
          : `${AI_SETTINGS_HINT} has no AI key saved yet. Choose a provider there and save its key, and this button starts working.`,
        status: describeAiStatus(aiConfig),
      });
    }
    if (rateLimited(token)) {
      return json(429, { error: `The assistant runs ${CALL_LIMIT} times a minute. Wait a moment and try again.` });
    }

    try {
      const { parsed, model } = await ask(aiConfig, request);
      const answer = validateResponse(parsed);
      return json(200, { ...answer, model });
    } catch (error) {
      // `callAiJson` throws `AiError` for every failure it can name, and carries the status with it.
      if (error instanceof AiError) return json(error.status, { error: error.message });
      console.error('[ai-assist] unexpected failure:', error);
      return json(500, { error: `The assistant failed unexpectedly: ${error instanceof Error ? error.message : 'unknown error'}` });
    }
  }

  // Ours, wrong verb: a null the host turns into a 405 with an Allow header.
  return null;
}





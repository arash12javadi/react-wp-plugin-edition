/**
 * The AI calls behind the Code Snippets screen: "Generate with AI" in the editor, and the
 * system-aware assistant drawer.
 *
 * The key is the one saved on Settings → Integrations → AI: the plugin context resolves it and
 * `server/integrationAi.mjs` spends it, so a site can change provider without this plugin changing.
 * A VITE_ variable would be compiled into the JavaScript every visitor downloads, so anyone could
 * read it out of the bundle and spend the quota — which is also why this is a plugin server route
 * and not a fetch straight from the browser to a provider.
 *
 * Both routes need manage_options, the same capability that may save a snippet: the answer is
 * code that an administrator is about to run on the site.
 */

// `AiError` is core's class, not a local copy: a route catches what `callAiJson` throws with `instanceof`.
import { AI_SETTINGS_HINT, AiError, callAiJson, describeAiStatus, isAiConfigured } from '../../server/integrationAi.mjs';

/** How long the model may take before the administrator is told, rather than left waiting. */
const TIMEOUT_MS = 45_000;
const MAX_PROMPT_CHARS = 2_000;
const MAX_CODE_CHARS = 20_000;
const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 4_000;

/** The AI half of `GET status`, the same shape the other plugins' status routes answer with. */
export const aiStatus = async (ctx) => describeAiStatus(await ctx.aiConfig());

// Per-user rate limit ------------------------------------------------------------------------------
// In-memory, so per process. Every provider meters its own account; this keeps one administrator
// holding down "Generate" from using all of it.

const calls = new Map();
const USER_LIMIT = 12;
const WINDOW_MS = 60_000;

function rateLimited(userId) {
  const now = Date.now();
  const recent = (calls.get(userId) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= USER_LIMIT) return true;
  recent.push(now);
  calls.set(userId, recent);
  if (calls.size > 500) {
    for (const [key, times] of calls) if (!times.some((time) => now - time < WINDOW_MS)) calls.delete(key);
  }
  return false;
}

// What the model is told about this CMS -------------------------------------------------------------
// Everything below is checked against the code it describes. A system prompt that invents hook
// names or a CSS framework the site does not use produces snippets that fail silently, which is
// worse than no assistant at all.

const ARCHITECTURE = `# React-WP, the CMS you are writing code for

React 19 + Vite single-page app. Supabase (Postgres + Auth) is the whole backend; a small Node
server (server.mjs) serves the built site and plugin API routes. There is no PHP and no WordPress.

## Styling — NOT Tailwind
This project does not use Tailwind, and utility classes like "px-4" or "text-sm" do nothing here.
Write plain CSS. Target the global, unhashed class names the app renders:
- theme chrome: rwp-* and rwpt-* (header, footer, sidebar, comments)
- page builder output: rwpb-* (rwpb-root, rwpb-section, rwpb-heading, rwpb-button, …)
Component styles elsewhere are CSS Modules, so their class names are hashed at build time and you
must never target them. Use logical properties (margin-inline-start, padding-inline-end,
inset-inline-start, text-align: start) rather than left/right, because sites run in both
left-to-right and right-to-left languages and dir="rtl" mirrors the layout automatically.

## The hook registry
One registry, WordPress-style: actions are side effects, filters transform a value and MUST return
it. Lower priority runs first; 10 is the default.

A snippet of type "hook" is evaluated in the browser with new Function. It has NO imports, NO JSX
and NO TypeScript — write plain ES2022. It receives one argument, \`rwp\`:
  rwp.addAction(name, callback, priority?)
  rwp.addFilter(name, callback, priority?)      // the callback must return the value
  rwp.addSlotContent(name, id, render, priority?)  // render(args) returns a React node
  rwp.applyFilters(name, value, ...args)
  rwp.doAction(name, ...args)
  rwp.React                                      // use rwp.React.createElement, there is no JSX
Anything registered through \`rwp\` is removed automatically when the snippet is switched off. A
snippet may also return a function, which is called as extra cleanup.

Core actions: rwp_init, rwp_admin_loaded, rwp_admin_ready (receives the role),
rwp_public_loaded, rwp_user_logged_in, rwp_user_logged_out, rwp_post_created, rwp_post_updated,
rwp_post_deleted, rwp_page_created, rwp_page_updated, rwp_page_deleted, rwp_settings_saved,
rwp_menu_saved, rwp_plugin_activated, rwp_plugin_deactivated, rwp_snippets_applied.

Core filters: rwp_site_title, rwp_site_description, rwp_public_menu, rwp_posts, rwp_post_title,
rwp_post_excerpt, rwp_post_content, rwp_page_content, rwp_admin_navigation, the_content
(the HTML of a page body, filtered BEFORE it is sanitized), i18n_translate_key
(translated, key, locale), i18n_locale, i18n_supported_locales, builder_widgets.

Layout zones, added to with rwp.addSlotContent: before_header, after_header, before_content,
after_content, before_footer, after_footer, sidebar_widgets, comment_form_before,
comment_form_after, admin_before_content, admin_after_content, admin_sidebar_after_nav,
builder_sidebar_tabs, builder_topbar_actions.

## Database (Supabase Postgres, reached through PostgREST with row level security)
pages (pages and posts share this table: is_post, title, slug, content, status
'published'/'draft'/'trash', builder_data, builder_data_i18n, locale, is_builder_enabled),
posts, categories, comments, options (option_name/option_value, both text), menus, media,
profiles (this is where a user's role lives — never user_metadata), profile_details (private),
theme_settings, code_snippets, and the shop_* and builder tables when those plugins are active.
Roles: super_admin, administrator, shop_manager, editor, author, contributor, subscriber.
Capabilities are checked in SQL by public.user_has_cap('...').

## Page Builder (plugin rwp-page-builder)
Layouts are JSON in pages.builder_data: sections → columns → widgets, each node
{ id, kind, type, settings, style, children }. Widgets render into global rwpb-* classes, so CSS
snippets can style builder output.

## Where a snippet runs
location decides that: 'head' (public site, in <head>), 'footer' (public site, end of <body>),
'frontend' (public site), 'admin' (admin screens only), 'everywhere' (both).`;

const CODE_RULES = `Rules for the code you return:
1. Return JSON matching the response schema exactly.
2. "code" is the complete snippet body, ready to paste into the editor — no Markdown fences, no
   "\`\`\`js", and no surrounding explanation.
3. Match the requested snippet type:
   - css: plain CSS rules only, no <style> tag.
   - javascript: plain browser JavaScript, no <script> tag, no imports, no JSX.
   - html: markup only. Inline <script> inside it does run.
   - hook: plain JavaScript using the \`rwp\` object described above. No imports, no JSX.
4. Never invent hook names, table names, class names or capabilities. If what is asked for needs
   something this CMS does not have, say so in "explanation" and return the closest thing that
   does work.
5. Guard for elements that may not exist (document.querySelector can return null) and keep the
   code safe to run twice: a snippet is re-applied whenever snippets are reloaded.
6. Comment the non-obvious lines, briefly.
7. "explanation" is one short paragraph: what the code does and where to put it.`;

const GENERATE_PROMPT = `You are a senior React/TypeScript engineer writing code snippets for the React-WP CMS.

${ARCHITECTURE}

${CODE_RULES}`;

const CHAT_PROMPT = `You are the React-WP developer assistant: a senior React/TypeScript engineer who knows this
specific CMS inside out and helps an administrator extend it with code snippets.

${ARCHITECTURE}

How to answer:
- "reply" is your answer in plain prose. Short paragraphs, no Markdown code fences.
- When code helps, put it in "code" (and set "codeType" to css, javascript, html or hook) so it can
  be inserted into the snippet editor with one click. Put at most one snippet in "code"; describe
  any others in "reply".
- Never invent hook names, table names, class names or capabilities. Say plainly when React-WP
  cannot do what was asked, and suggest the nearest thing that works.
- Answer questions about the architecture directly, without code, when that is what was asked.

${CODE_RULES}`;

// Requests --------------------------------------------------------------------------------------

const SNIPPET_TYPES = new Set(['css', 'javascript', 'html', 'hook']);

const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

function validateGenerate(body) {
  const snippetType = SNIPPET_TYPES.has(body?.snippetType) ? body.snippetType : null;
  if (!snippetType) throw new AiError(400, 'Choose a snippet type (CSS, JavaScript, HTML or React hook) before generating code.');
  const prompt = text(body?.prompt, MAX_PROMPT_CHARS);
  if (!prompt) throw new AiError(400, 'Describe what the snippet should do.');
  const existing = text(body?.existingCode, MAX_CODE_CHARS);
  return {
    snippetType,
    prompt,
    existingCode: existing,
    // "refine" rewrites what is already in the editor; "create" starts from nothing.
    mode: existing && body?.mode === 'refine' ? 'refine' : 'create',
    title: text(body?.title, 200),
    location: text(body?.location, 30),
  };
}

function validateChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) throw new AiError(400, 'Write a question for the assistant.');
  if (messages.length > MAX_TURNS) throw new AiError(400, `This conversation is ${messages.length} messages long; the limit is ${MAX_TURNS}. Start a new chat.`);
  const clean = messages.map((message) => {
    const content = text(message?.text, MAX_MESSAGE_CHARS);
    if (!content) throw new AiError(400, 'One of the messages is empty.');
    return { role: message?.role === 'assistant' ? 'assistant' : 'user', text: content };
  });
  if (clean[clean.length - 1].role !== 'user') throw new AiError(400, 'The last message must be the one you are asking.');
  return {
    messages: clean,
    // The snippet open in the editor, so "why does this not work?" has something to look at.
    editorCode: text(body?.editorCode, MAX_CODE_CHARS),
    editorType: SNIPPET_TYPES.has(body?.editorType) ? body.editorType : '',
  };
}

const generateMessages = (request) => {
  const lines = [
    `Snippet type: ${request.snippetType}`,
    request.title ? `Snippet title: ${request.title}` : '',
    request.location ? `It will run at: ${request.location}` : '',
    '',
    request.mode === 'refine' ? 'Rewrite this snippet as asked, keeping everything that still applies:' : 'Write a new snippet.',
    request.mode === 'refine' ? `\n${request.existingCode}\n` : '',
    '',
    `What it should do: ${request.prompt}`,
  ].filter(Boolean);
  return [{ role: 'user', text: lines.join('\n') }];
};

const chatMessages = (request) => {
  const messages = request.messages.map((message) => ({ role: message.role, text: message.text }));
  if (request.editorCode) {
    // Prepended as context rather than merged into the question, so the model treats it as data.
    messages.unshift({
      role: 'user',
      text: `For reference, this ${request.editorType || 'code'} snippet is open in my editor right now:\n\n${request.editorCode}`,
    });
    messages.splice(1, 0, { role: 'assistant', text: 'Thanks — I will keep that snippet in mind.' });
  }
  return messages;
};

const GENERATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    code: { type: 'STRING' },
    explanation: { type: 'STRING' },
  },
  required: ['code'],
};

const CHAT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    code: { type: 'STRING' },
    codeType: { type: 'STRING', enum: ['css', 'javascript', 'html', 'hook'] },
  },
  required: ['reply'],
};

// The call ------------------------------------------------------------------------------------------

/**
 * One generation, from whichever provider the AI card is set to.
 *
 * Neither route below is provider-specific: which URL and body shape the request becomes, and how a
 * failure is worded, is `integrationAi.mjs`'s job. The schema stays written Google's way
 * (`type: 'OBJECT'`) because core re-cases the types for OpenAI, so this is the single description
 * of the answer both routes read.
 */
const ask = (config, { systemPrompt, messages, schema, temperature, blocked, truncated }) => callAiJson(config, {
  system: systemPrompt,
  messages,
  schema,
  temperature,
  timeoutMs: TIMEOUT_MS,
  blocked,
  truncated,
  logTag: 'rwp-code-snippets',
});

/**
 * Models fence code even when told not to, and the fence would end up pasted into the editor.
 * Nothing else is stripped: the code is the answer, and rewriting it would hide what was returned.
 */
export function stripFence(value) {
  const code = String(value ?? '').replace(/\r\n/g, '\n').trim();
  const fenced = code.match(/^```[\w+-]*\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : code).trim();
}

// Routes --------------------------------------------------------------------------------------------

/**
 * Both AI routes need a signed-in administrator. `rest` is the plugin's Supabase REST helper.
 * Returns the user, or a { status, body } response to send back instead.
 */
async function authorize(ctx, rest, config) {
  if (!isAiConfigured(config)) {
    return { response: { status: 501, body: { error: `The AI assistant has no key yet. Save one on ${AI_SETTINGS_HINT} and this button starts working.` } } };
  }
  if (!ctx.bearerToken) return { response: { status: 401, body: { error: 'Sign in to use the AI assistant.' } } };

  const userResponse = await fetch(`${ctx.supabase.url.replace(/\/$/, '')}/auth/v1/user`, {
    headers: { apikey: ctx.supabase.publishableKey, Authorization: `Bearer ${ctx.bearerToken}` },
  });
  if (!userResponse.ok) return { response: { status: 401, body: { error: 'Your session has expired. Sign in again.' } } };
  const user = await userResponse.json();

  const allowed = await rest(ctx, 'rpc/user_has_cap', { method: 'POST', body: { capability: 'manage_options' }, auth: 'user' }).catch(() => false);
  if (allowed !== true) {
    return { response: { status: 403, body: { error: 'The AI assistant writes code that runs on the site, so it needs the “Manage settings” capability (Administrator).' } } };
  }
  if (rateLimited(user.id)) {
    return { response: { status: 429, body: { error: `You can make ${USER_LIMIT} AI requests a minute. Wait a moment and try again.` } } };
  }
  return { user };
}

export async function generateSnippetRoute(ctx, rest) {
  const config = await ctx.aiConfig();
  const { response } = await authorize(ctx, rest, config);
  if (response) return response;
  try {
    const request = validateGenerate(ctx.json());
    const { parsed, model } = await ask(config, {
      systemPrompt: GENERATE_PROMPT,
      messages: generateMessages(request),
      schema: GENERATE_SCHEMA,
      temperature: 0.35,
      blocked: 'The AI refused to write this snippet. Reword what you asked for, or write it by hand.',
      truncated: 'The answer was cut off because it was too long. Ask for a smaller piece of code.',
    });
    const code = stripFence(parsed?.code);
    if (!code) throw new AiError(502, 'The model returned an empty snippet. Try describing what you want in more detail.');
    return { status: 200, body: { code, explanation: String(parsed?.explanation || '').slice(0, 2000), model } };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

export async function chatRoute(ctx, rest) {
  const config = await ctx.aiConfig();
  const { response } = await authorize(ctx, rest, config);
  if (response) return response;
  try {
    const request = validateChat(ctx.json());
    const { parsed, model } = await ask(config, {
      systemPrompt: CHAT_PROMPT,
      messages: chatMessages(request),
      schema: CHAT_SCHEMA,
      temperature: 0.5,
      blocked: 'The AI refused to answer that. Rephrase your question, or ask something narrower.',
      truncated: 'The answer was cut off because it was too long. Ask for a smaller piece of code.',
    });
    const reply = String(parsed?.reply || '').slice(0, 8000);
    if (!reply) throw new AiError(502, 'The model returned an empty answer. Try asking again.');
    return {
      status: 200,
      body: {
        reply,
        code: stripFence(parsed?.code).slice(0, MAX_CODE_CHARS),
        codeType: SNIPPET_TYPES.has(parsed?.codeType) ? parsed.codeType : '',
        model,
      },
    };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

// Exported for tests.
export const _internal = { validateGenerate, validateChat, generateMessages, chatMessages, stripFence };

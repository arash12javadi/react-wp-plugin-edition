/**
 * Server routes for rwp-chat, served at /api/plugins/rwp-chat/<route> by server.mjs
 * (self-hosted) and api/plugins.ts (Vercel). Registered in server/plugins.mjs.
 *
 * Almost all of the chat happens straight between the browser and Supabase, where row level
 * security and the rwp_chat_* functions decide. Only a handful of things have to happen here, and
 * each one is here because it needs something the browser must never hold:
 *
 *   ai/reply            the key saved on Settings → Integrations → AI
 *   agent/notify        the Telegram bot token / WhatsApp API token, from chat_secrets
 *   attachments/record  the Supabase secret key, to write a media row for an anonymous uploader
 *
 * Those three start by proving the caller holds the session's own token. The check runs with the
 * secret key, which bypasses row level security, so it is written out here rather than leaned on:
 * `loadSession` is the only door, and it compares the token in full.
 *
 * Three more routes serve Chat → Knowledge, and are the exception the other way round: they need no
 * secret, only a signed-in administrator, because row level security and the ai_config row already
 * hold everything they touch (sync, refine, search — see serverKnowledge.mjs).
 */

import { aiStatus, replyRoute, describeSubject } from './serverAi.mjs';
import { AgentError, channelReady, notifyAgents } from './serverAgents.mjs';
import {
  combinePassages, describeKnowledge, loadKnowledge, loadLibrary,
  refineRoute, searchRoute, syncRoute,
} from './serverKnowledge.mjs';
// Core's classes, not local copies: a route catches what `callAiJson` throws with `instanceof`.
import { AiError, callAiJson, isAiConfigured } from '../../server/integrationAi.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const base = (ctx) => ctx.supabase.url.replace(/\/$/, '');

async function rest(ctx, path, { method = 'GET', body, auth = 'anon', prefer } = {}) {
  const key = auth === 'service' ? ctx.supabase.secretKey : ctx.supabase.publishableKey;
  if (auth === 'service' && !key) {
    throw new HttpError(501, 'This site has no SUPABASE_SECRET_KEY, which the chat server needs to read a conversation on a visitor\'s behalf. Add it to .env.local and restart the server.');
  }
  const token = auth === 'user' ? ctx.bearerToken : key;
  const response = await fetch(`${base(ctx)}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.message || (typeof payload === 'string' && payload) || `HTTP ${response.status}`;
    // PostgREST answers a table it cannot see with PGRST205 and a function it cannot see with
    // PGRST202 — the second is also what a widget and a database that disagree about a function's
    // arguments look like. Say what PostgREST said, rather than guessing which of the two it is.
    if (payload?.code === 'PGRST205' || payload?.code === 'PGRST202') {
      throw new HttpError(
        500,
        'The chat tables are not installed. Activate the Chatbot under Plugins, which applies plugins/rwp-chat/schema.sql,'
        + ' or paste that file into the Supabase SQL Editor. If the tables already exist, run "notify pgrst, \'reload schema\';".'
        + ` PostgREST said: ${message}`,
      );
    }
    throw new HttpError(response.status >= 500 ? 502 : 400, `Supabase ${method} ${path.split('?')[0]} failed: ${message}`);
  }
  return payload;
}

/** Constant-time-ish comparison, so a token cannot be guessed a character at a time by timing. */
const sameToken = (a, b) => {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length || !left) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session behind a (id, token) pair. Throws for anything else, with one message for all. */
async function loadSession(ctx, sessionId, token) {
  if (!uuidPattern.test(String(sessionId || '')) || !String(token || '').trim()) {
    throw new HttpError(403, 'This chat session could not be found, or the link to it has expired. Start a new conversation.');
  }
  const rows = await rest(ctx, `chat_sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`, { auth: 'service' });
  const session = Array.isArray(rows) ? rows[0] : null;
  if (!session || !sameToken(session.session_token, token)) {
    throw new HttpError(403, 'This chat session could not be found, or the link to it has expired. Start a new conversation.');
  }
  return session;
}

const loadMessages = (ctx, sessionId, limit = 40) =>
  rest(ctx, `chat_messages?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.desc&limit=${limit}&select=*`, { auth: 'service' })
    .then((rows) => (Array.isArray(rows) ? rows.reverse() : []));

const readOptions = async (ctx, names) => {
  const list = names.map((name) => `"${name}"`).join(',');
  const rows = await rest(ctx, `options?option_name=in.(${encodeURIComponent(list)})&select=option_name,option_value`, { auth: 'anon' });
  return Object.fromEntries((rows || []).map((row) => [row.option_name, row.option_value]));
};

const readSecrets = async (ctx) => {
  const rows = await rest(ctx, 'chat_secrets?select=*&limit=1', { auth: 'service' });
  return (Array.isArray(rows) ? rows[0] : null) || {};
};

/**
 * Everything the assistant is told about this site. Facts only — nothing is invented here.
 *
 * Two halves, and the second is the one that lets the assistant actually answer. `pages` is the
 * index: titles and URLs it can point at. `knowledge` is what those pages say, retrieved for the
 * question being asked (see serverKnowledge.mjs), so "what does delivery cost" can be answered
 * from the site's own words instead of refused for lack of them.
 *
 * `knowledge` is drawn from two places that overlap: the curated knowledge base (Chat → Knowledge)
 * first, then the page matcher for whatever budget the library did not use. The order matters —
 * the library can hold things no page says, and a sync keeps it no staler than the pages — and the
 * merge drops the duplicates, so a page is quoted once however many corpora found it. Turning the
 * library off (chat_knowledge_enabled) leaves exactly the behaviour this had before it existed.
 */
async function loadSiteFacts(ctx, session, question = '') {
  // Read first, alone: the library is one more query, and whether to make it is a setting.
  const options = await readOptions(ctx, ['site_title', 'site_tagline', 'site_description', 'chat_bot_name', 'chat_knowledge_enabled']);
  const libraryOn = options.chat_knowledge_enabled !== 'false';
  const [card, pages, library, knowledge] = await Promise.all([
    session.context_type && session.context_id
      ? rest(ctx, 'rpc/rwp_chat_card', {
        method: 'POST',
        body: { p_type: session.context_type, p_id: session.context_id },
        auth: 'anon',
      }).catch(() => null)
      : Promise.resolve(null),
    // Titles and slugs only, so the assistant can point somewhere real instead of guessing a URL.
    rest(ctx, 'pages?status=eq.published&is_site_template=not.is.true&select=title,slug&order=updated_at.desc&limit=40', { auth: 'anon' })
      .catch(() => []),
    // The curated knowledge base. Read with the anon key: rwp_chat_knowledge_search is SECURITY
    // DEFINER and returns published passages only, so a draft stays as invisible to the assistant
    // as it is to the public.
    libraryOn
      ? loadLibrary((term) => rest(ctx, 'rpc/rwp_chat_knowledge_search', {
        method: 'POST',
        auth: 'anon',
        body: { p_query: term, p_limit: 6 },
      }), { question })
      : Promise.resolve([]),
    // The bodies of the pages that fit this question, read with the anon key too, so RLS decides
    // what the public may see; a failure costs the answer its detail, never the whole answer.
    loadKnowledge((path) => rest(ctx, path, { auth: 'anon' }), {
      question,
      contextType: session.context_type || '',
      contextId: session.context_id || '',
    }).catch(() => []),
  ]);
  return {
    title: options.site_title || 'this site',
    tagline: options.site_tagline || options.site_description || '',
    botName: options.chat_bot_name || 'Assistant',
    pageUrl: session.current_page_url || '',
    subject: describeSubject(card),
    pages: (pages || []).map((page) => `"${page.title}" (/${page.slug})`).join(', '),
    knowledge: describeKnowledge(combinePassages(library, knowledge)),
  };
}

/** Writes the assistant's answer as an ordinary transcript row, with the model that produced it. */
async function saveBotMessage(ctx, sessionId, message, metadata) {
  const rows = await rest(ctx, 'chat_messages', {
    method: 'POST',
    auth: 'service',
    prefer: 'return=representation',
    body: [{ session_id: sessionId, sender_type: 'bot', message, metadata }],
  });
  return Array.isArray(rows) ? rows[0] : null;
}

/**
 * manage_options, checked as the caller rather than assumed. Used by the status route and by the
 * three knowledge routes.
 *
 * The knowledge routes write rows that RLS already protects, so this is the same rule a second
 * time — but in a place that can say what is missing instead of an empty result set. `subject` is
 * what the request was about, and only appears in the message.
 */
async function requireAdmin(ctx, subject) {
  if (!ctx.bearerToken) {
    throw new HttpError(401, `Sign in as an administrator to open ${subject}.`);
  }
  const allowed = await rest(ctx, 'rpc/user_has_cap', {
    method: 'POST', body: { capability: 'manage_options' }, auth: 'user',
  }).catch(() => false);
  if (allowed !== true) {
    throw new HttpError(403, `Opening ${subject} needs the “Manage settings” capability (Administrator).`);
  }
}

const handle = async (work) => {
  try {
    return await work();
  } catch (error) {
    const status = Number(error?.status) || 500;
    return { status, body: { error: error instanceof Error ? error.message : 'Unknown chat server error.' } };
  }
};

export default {
  id: 'rwp-chat',
  routes: {
    /**
     * Whether the server half can work at all: is an AI key saved, and is the configured live-agent
     * channel set up. Reports that each credential is set, never its value.
     */
    'GET status': (ctx) => handle(async () => {
      await requireAdmin(ctx, 'the chat server status');
      const [secrets, options, ai] = await Promise.all([
        readSecrets(ctx),
        readOptions(ctx, ['chat_agent_channel']),
        aiStatus(ctx),
      ]);
      const channel = options.chat_agent_channel || 'internal';
      return {
        status: 200,
        body: {
          ai: ai.configured,
          provider: ai.provider,
          provider_name: ai.providerName,
          model: ai.model,
          hint: ai.hint,
          channel,
          channel_ready: channelReady(channel, secrets),
          telegram: Boolean(secrets.telegram_bot_token && secrets.telegram_chat_id),
          whatsapp_api: Boolean(secrets.whatsapp_api_url && secrets.whatsapp_api_token),
        },
      };
    }),

    /** The assistant's answer to whatever the visitor last said. */
    'POST ai/reply': (ctx) => handle(() => replyRoute(ctx, { loadSession, loadMessages, loadSiteFacts, saveBotMessage })),

    /**
     * Copies the published pages and posts into the knowledge base — the "Sync site" button in
     * Chat → Knowledge. Idempotent and one-way: the CMS stays the source of truth for what it owns,
     * and an entry it no longer publishes is archived rather than left quotable.
     */
    'POST knowledge/sync': (ctx) => handle(() => syncRoute(ctx, {
      rest,
      requireAdmin: (caller) => requireAdmin(caller, 'the knowledge base'),
    })),

    /**
     * Rewrites one entry with the AI the site already pays for, so a visitor's question matches it.
     * The result comes back to the screen and is saved only if the administrator saves it: text that
     * will be quoted to customers is never written straight from a model's answer.
     */
    'POST knowledge/refine': (ctx) => handle(() => refineRoute(ctx, { callAiJson, isAiConfigured, AiError })),

    /**
     * What the assistant would be told for a question — the same retrieval a chat reply gets, so an
     * administrator can see whether the answer they expect actually comes back.
     */
    'POST knowledge/search': (ctx) => handle(() => searchRoute(ctx, {
      rest,
      requireAdmin: (caller) => requireAdmin(caller, 'the knowledge base'),
    })),

    /**
     * Makes a phone buzz. The live_agent_requests row already exists — rwp_chat_request_agent
     * wrote it before the browser got here — so a failure here loses the notification, never the
     * request, and the outcome is recorded on the row either way.
     */
    'POST agent/notify': (ctx) => handle(async () => {
      const body = ctx.json();
      const session = await loadSession(ctx, body?.session_id, body?.token);
      const [secrets, options, messages] = await Promise.all([
        readSecrets(ctx),
        readOptions(ctx, ['chat_agent_channel']),
        loadMessages(ctx, session.id, 10),
      ]);
      const channel = options.chat_agent_channel || 'internal';

      const markRequest = (delivery, error) => rest(
        ctx,
        `live_agent_requests?session_id=eq.${encodeURIComponent(session.id)}&status=eq.pending`,
        {
          method: 'PATCH',
          auth: 'service',
          body: { delivery, delivery_error: error ? String(error).slice(0, 500) : null },
        },
      ).catch(() => {});

      try {
        const result = await notifyAgents({ channel, secrets, session, messages, origin: ctx.origin });
        await markRequest(result.delivery);
        return { status: 200, body: { delivered: result.delivery === 'sent', channel: result.channel } };
      } catch (error) {
        await markRequest('failed', error?.message);
        // 200, not 5xx: from the visitor's side the request DID go through — it is in the inbox.
        // Only the instant notification failed, and that is the team's problem, not theirs.
        console.error('[rwp-chat] A live-agent notification failed.', error?.message);
        return {
          status: 200,
          body: {
            delivered: false,
            channel,
            error: error instanceof AgentError || error instanceof HttpError
              ? error.message
              : 'The notification could not be delivered, but the request is waiting in the admin inbox.',
          },
        };
      }
    }),

    /**
     * Records an attachment in the Media Library after the browser has uploaded it to Cloudinary.
     *
     * This cannot be done from the browser: public.media only accepts inserts from someone with
     * upload_files, and most visitors are not signed in at all. The row is written with the
     * secret key, so media_enforce_upload_rules sees no auth.uid() and leaves uploaded_by null —
     * which is correct, because nobody with an account uploaded it.
     *
     * folder is the flat library folder the Media Library hides from "All media". The provider
     * folder is a different thing and was fixed at upload time as plugins/rwp-chat/chat_media,
     * which is what an uninstall would delete by.
     */
    'POST attachments/record': (ctx) => handle(async () => {
      const body = ctx.json();
      await loadSession(ctx, body?.session_id, body?.token);
      const attachment = body?.attachment || {};
      const url = String(attachment.url || '');
      if (!/^https:\/\//i.test(url)) {
        throw new HttpError(400, 'A chat attachment must be an https:// URL from the upload provider.');
      }
      const rows = await rest(ctx, 'media', {
        method: 'POST',
        auth: 'service',
        prefer: 'return=representation',
        body: [{
          url,
          title: String(attachment.name || 'Chat attachment').slice(0, 255),
          alt_text: null,
          provider: attachment.provider === 'imagekit' ? 'imagekit' : 'cloudinary',
          provider_file_id: attachment.provider_file_id || null,
          file_name: String(attachment.name || '').slice(0, 255) || null,
          width: Number.isFinite(attachment.width) ? attachment.width : null,
          height: Number.isFinite(attachment.height) ? attachment.height : null,
          bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : null,
          mime_type: attachment.mime_type ? String(attachment.mime_type).slice(0, 100) : null,
          folder: 'chat_media',
        }],
      });
      const media = Array.isArray(rows) ? rows[0] : null;
      return { status: 200, body: { media_id: media?.id || null } };
    }),
  },
};

/**
 * The half of the chatbot that talks to a model.
 *
 * Which model, and with which key, is the row saved on Settings → Integrations → AI: the plugin
 * context resolves it (`server/integrationAi.mjs` spends it). A key never exists in the browser,
 * and cannot be smuggled there through a VITE_ variable — those are compiled into the JavaScript
 * every visitor downloads. Unlike the admin-only assistants elsewhere in this CMS, this one
 * answers anonymous members of the public, so a leaked key is exactly the quota that would be
 * spent by strangers.
 *
 * The browser sends nothing but a session id and that session's own token. The transcript the
 * model sees is read here, from the database, with the secret key. A visitor therefore cannot
 * put words in the assistant's mouth by forging history, and every reply is written back as a
 * chat_messages row with the model that produced it, which is what makes the AI audit in
 * Chat → Logs mean anything.
 */

// `AiError` is core's class, not a local copy: a route catches what `callAiJson` throws with `instanceof`.
import { AiError, callAiJson, describeAiStatus, isAiConfigured } from '../../server/integrationAi.mjs';

/**
 * How long the assistant may think before the visitor is told, rather than left with a spinner.
 *
 * The widget gives up at 45 seconds (REPLY_TIMEOUT_MS in hooks/useBotReply.ts) so that a stalled
 * request can never leave the typing dots on screen forever: this ceiling plus the one retry
 * `callAiJson` may make has to fit inside it. A two-sentence answer takes a couple of seconds, so
 * 20 is already generous.
 */
const TIMEOUT_MS = 20_000;
/** How much of the conversation the model is shown. Older turns are summarised by being dropped. */
const MAX_TURNS = 24;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_REPLY_CHARS = 2_000;
/** The assistant writes two or three sentences, so a small ceiling is a safety net, not a limit. */
const MAX_REPLY_TOKENS = 600;

/**
 * The AI half of `GET status`: is a key saved, on which provider, and which model a reply would use.
 */
export const aiStatus = async (ctx) => describeAiStatus(await ctx.aiConfig());

// Rate limit -----------------------------------------------------------------------------------
// Per chat session, in memory, so per process. Every provider meters its own account; this stops
// one visitor (or one script holding a valid token) from using all of it. The database already
// caps a session at 20 messages a minute; this caps what those messages cost.

const calls = new Map();
const SESSION_LIMIT = 10;
const WINDOW_MS = 60_000;

function rateLimited(sessionId) {
  const now = Date.now();
  const recent = (calls.get(sessionId) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= SESSION_LIMIT) return true;
  recent.push(now);
  calls.set(sessionId, recent);
  if (calls.size > 1000) {
    for (const [key, times] of calls) if (!times.some((time) => now - time < WINDOW_MS)) calls.delete(key);
  }
  return false;
}

// The prompt -------------------------------------------------------------------------------------

/**
 * What the assistant is allowed to be. Written defensively on purpose: this one talks to the
 * public, so the rules are about not inventing facts, not quoting prices and not promising
 * anything, rather than about code style.
 */
const systemPrompt = (site) => `You are ${site.botName}, the assistant on the website "${site.title}".

You help visitors with questions about this site: what it offers, how to find things, how
accounts work, and where to go next. You are friendly, brief and concrete. Two or three short
sentences is a good answer; a long one is almost never better.

What you know
- The site is called "${site.title}".${site.tagline ? ` Its tagline is "${site.tagline}".` : ''}
- The visitor is on ${site.pageUrl || 'a page of this site'}.
${site.subject ? `- They are looking at: ${site.subject}` : ''}
${site.pages ? `- Pages on this site you may link to: ${site.pages}` : ''}
${site.knowledge ? `
What this site says
Quoted from this site's own pages and its knowledge library, chosen because they match what the
visitor asked. A line marked "from the knowledge base, not a page" is still the site's own wording,
but it has no page behind it. This is your only source of specifics; the titles above are only a map.

${site.knowledge}
` : ''}

Rules you must follow
1. Never invent a fact about this site: a price, a delivery time, a stock level, a refund policy,
   a discount code or a person's name. If it is not in "What this site says", not in what you were
   told above, and not in what the visitor said, you do not know it: say so and offer to fetch a
   human. A plausible guess is worse than "I do not know".
2. Never quote or estimate an amount of money unless it appears verbatim in "What you know" or
   "What this site says". Prices change, and a wrong one said in writing is a promise the site
   has to keep.
3. Never ask for a password, a card number or any other payment detail, and tell the visitor not
   to type one here if they start to.
4. You cannot place orders, change orders, issue refunds or look anything up in an account. If
   that is what they need, say so plainly and set "handoff" to true.
5. For "where is my order", tell them to use the "Track my order" button in this chat, which asks
   for the order number and the email they ordered with. Never ask them for the order number in
   the message itself — you cannot look it up.
6. Answer in the same language the visitor wrote in.
7. Plain prose. No Markdown, no headings, no bullet characters, no code fences.
8. Prefer this site's own wording over your general knowledge. When an answer comes from "What
   this site says", end with the URL shown beside that line, e.g. "More on /delivery." If the line
   says it is from the knowledge base rather than a page, name what it is instead ("our returns
   policy") and cite no URL. Never cite a page that is not in the lists above, and do not describe
   a page you were given no text for.

Set "handoff" to true when the visitor asks for a person, is upset, or needs something only a
human can do. It is not a failure — it is the right answer to a lot of questions.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    handoff: { type: 'BOOLEAN' },
  },
  required: ['reply'],
};

/** chat_messages rows → conversation turns. System lines become context, not dialogue. */
export function buildContents(messages) {
  const turns = messages
    .filter((message) => message.sender_type !== 'system')
    .slice(-MAX_TURNS)
    .map((message) => {
      const text = String(message.message || '').slice(0, MAX_MESSAGE_CHARS);
      const files = Array.isArray(message.attachments) && message.attachments.length
        ? ` [the visitor attached ${message.attachments.length} file(s); you cannot see their contents]`
        : '';
      return {
        // An agent's reply is the assistant's side of the conversation as far as the model is
        // concerned: it is what the visitor was last told.
        role: message.sender_type === 'user' ? 'user' : 'assistant',
        text: (text + files).trim() || '(no text)',
      };
    });

  // A conversation has to start with the visitor and end with them: the last turn is the question.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  while (turns.length && turns[turns.length - 1].role !== 'user') turns.pop();
  return turns;
}

// The call -------------------------------------------------------------------------------------

/**
 * One answer, from whichever provider the AI card is set to.
 *
 * This is the whole provider surface of the chatbot: a system prompt, the transcript, the schema
 * its JSON has to match, and what to say when the answer is refused or cut off. The retries a
 * provider needs (a retired model name, an older OpenAI model with no structured outputs) live in
 * `callAiJson`, together with the request shape, so this file never names a provider.
 */
const ask = (config, { system, turns }) => callAiJson(config, {
  system,
  messages: turns,
  schema: RESPONSE_SCHEMA,
  temperature: 0.4,
  maxOutputTokens: MAX_REPLY_TOKENS,
  timeoutMs: TIMEOUT_MS,
  blocked: 'The assistant could not answer that one. Try rephrasing it, or ask for a person.',
  truncated: 'The assistant ran out of room before it finished. Ask something shorter, or ask for a person.',
  logTag: 'rwp-chat',
});

/** A one-line description of what the visitor is looking at, from public.rwp_chat_card. */
export function describeSubject(card) {
  if (!card) return '';
  const parts = [card.title];
  if (card.price !== undefined && card.price !== null && card.currency) {
    parts.push(`priced ${card.price} ${card.currency}`);
  }
  if (card.stock_status === 'outofstock') parts.push('currently out of stock');
  if (card.excerpt) parts.push(`described as "${String(card.excerpt).slice(0, 300)}"`);
  // The price IS verbatim information here, so rule 2 permits repeating it — it came from
  // shop_effective_price a moment ago, not from the model's imagination.
  return parts.filter(Boolean).join(', ');
}

/**
 * Answers whatever the visitor last said and stores the reply.
 *
 * `ctx` is the plugin route context, `deps` the helpers server.mjs owns: loadSession (verifies
 * the token), loadMessages, loadSiteFacts and saveBotMessage — all of which use the secret key.
 * `loadSiteFacts` takes the question as its third argument so the pages it quotes are the ones
 * that fit what the visitor asked.
 */
export async function replyRoute(ctx, deps) {
  const config = await ctx.aiConfig();
  if (!isAiConfigured(config)) {
    return {
      status: 501,
      body: { error: 'The AI assistant has no key yet. Save one on Settings → Integrations → AI and it can answer; visitors can still reach a person from the chat.' },
    };
  }
  try {
    const body = ctx.json();
    const session = await deps.loadSession(ctx, body?.session_id, body?.token);
    if (session.status === 'closed') throw new AiError(409, 'This conversation has been closed.');
    if (rateLimited(session.id)) {
      throw new AiError(429, 'The assistant is answering as fast as it can. Wait a few seconds before asking again.');
    }

    // The transcript comes first because the last thing the visitor said is the question, and the
    // site's own pages are searched for it. Loading the facts before the question would make the
    // knowledge generic, and on a site with more pages than a prompt can hold, generic is useless.
    const messages = await deps.loadMessages(ctx, session.id);
    const turns = buildContents(messages);
    if (!turns.length) throw new AiError(400, 'There is nothing to answer yet.');
    const question = turns[turns.length - 1].text;
    const site = await deps.loadSiteFacts(ctx, session, question);

    const { parsed, model } = await ask(config, { system: systemPrompt(site), turns });
    const reply = String(parsed?.reply || '').trim().slice(0, MAX_REPLY_CHARS);
    if (!reply) throw new AiError(502, 'The assistant returned an empty answer. Try asking again.');

    const stored = await deps.saveBotMessage(ctx, session.id, reply, {
      model,
      handoff: Boolean(parsed?.handoff),
    });
    return { status: 200, body: { message: stored, model, handoff: Boolean(parsed?.handoff) } };
  } catch (error) {
    if (error instanceof AiError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

// Exported for tests.
export const _internal = { buildContents, describeSubject, systemPrompt };

import { useCallback, useRef, useState } from 'react';
import { callChatServer, ChatEndpointUnavailableError } from '../lib/api';
import type { ChatCredentials, ChatMessage } from '../lib/types';

/**
 * The AI half of a conversation.
 *
 * The browser sends nothing but the session id and its token: the server reads the transcript
 * itself with the secret key, calls whichever provider is saved on Settings → Integrations → AI,
 * writes the reply as a chat_messages row and hands the stored row back. Three reasons it works
 * that way rather than calling the provider from here:
 *
 *  1. The API key must stay on the server: it is a `system_settings` row the browser cannot read,
 *     while a VITE_ variable would be compiled into the JavaScript every visitor downloads, so the
 *     key could be read out of the bundle and the quota spent by anyone. This is the same rule the
 *     page builder's AI Section Refine and the code snippets assistant follow.
 *  2. The transcript the model sees is the one in the database, not one the browser assembled, so
 *     a visitor cannot put words in the bot's mouth by editing what they post.
 *  3. Every bot reply is logged with the model that produced it, which is what makes the AI
 *     performance audit in Chat → Logs meaningful.
 *
 * A site with no AI key, or no server at all, still has a working chat: sendToBot reports that
 * the assistant is unavailable and the visitor is offered a live agent instead.
 */

export interface BotReply {
  message: ChatMessage;
  model: string;
  /** The bot decided this needs a person. The widget then offers the handover button. */
  handoff: boolean;
}

/**
 * Longer than the server's own ceiling plus the one retry it may make (see TIMEOUT_MS in
 * serverAi.mjs), because the server answers the visitor first, always.
 *
 * Without a local timer the typing dots are only cleared when the request settles. A stalled
 * socket, a cold serverless function or a database call behind the route can leave that promise
 * pending indefinitely, and the panel then looks frozen with no way out but a reload.
 */
const REPLY_TIMEOUT_MS = 45_000;

export function useBotReply() {
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  /** Set once the server has told us the assistant cannot answer, so we stop asking it. */
  const [unavailable, setUnavailable] = useState('');
  const inFlight = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setThinking(false);
  }, []);

  /**
   * Asks the assistant to answer whatever the visitor last said. Returns the stored bot message,
   * or null when there is no answer — a reason is then in `error` or `unavailable`.
   */
  const sendToBot = useCallback(async (credentials: ChatCredentials): Promise<BotReply | null> => {
    if (unavailable) return null;
    cancel();
    const controller = new AbortController();
    inFlight.current = controller;
    // `timedOut` rather than the signal's `aborted`: the visitor cancelling and the timer firing
    // share one abort, and only the second is something to tell them about.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REPLY_TIMEOUT_MS);
    setThinking(true);
    setError('');
    try {
      const reply = await callChatServer<BotReply>(
        'ai/reply',
        { session_id: credentials.sessionId, token: credentials.token },
        controller.signal,
      );
      return reply?.message ? reply : null;
    } catch (caught) {
      if (timedOut) {
        setError('The assistant is taking too long to answer. Try again, or ask for a person.');
        return null;
      }
      if (controller.signal.aborted) return null;
      const message = caught instanceof Error ? caught.message : 'The assistant could not answer.';
      // "No server here" and "no key saved on Integrations → AI" are permanent for this page load; a
      // rate limit or a timeout is not, and asking again in a moment is reasonable.
      if (caught instanceof ChatEndpointUnavailableError || /no key yet|is not set up/i.test(message)) {
        setUnavailable(message);
      } else {
        setError(message);
      }
      return null;
    } finally {
      clearTimeout(timer);
      if (inFlight.current === controller) inFlight.current = null;
      setThinking(false);
    }
  }, [cancel, unavailable]);

  return { sendToBot, thinking, error, unavailable, cancel, clearError: () => setError('') };
}

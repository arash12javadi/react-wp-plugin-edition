/**
 * The two fetches the deploy engine makes, and the one rule they enforce: a failure is a sentence.
 *
 * These are the installer's `fetchJson` / `fetchText` / `redact`, lifted into core unchanged — not
 * reimplemented — because they encode three decisions that are easy to lose in a copy:
 *
 *   - A body is JSON *only* when the caller passes an object; a `Buffer` upload sets its own headers and
 *     must not be stringified (`uploadFile` in `vercelApi.mjs` uses `fetch` directly for exactly that).
 *   - An upstream `{ error: { message } }` — Vercel's and GitHub's shape — becomes the message a screen
 *     shows, so a 400 says *why* instead of "HTTP 400".
 *   - Every credential the request carried is scrubbed out of that message before it travels, because an
 *     upstream service happily echoes the token it just refused.
 *
 * `status` is preserved on the thrown `DeployError`, so the caller answers with the upstream status when
 * that is meaningful (401, 404) and with 502/504 when the failure is on the wire.
 */
import { DeployError } from './errors.mjs';

/**
 * Removes every known secret from a message before it is returned to the browser.
 *
 * `length > 3` is the installer's own rule and it is kept: redacting a 2-character value would shred every
 * message it appears in, and no real credential is that short.
 */
export function redactSecrets(secrets, message) {
  let out = String(message || '');
  for (const secret of secrets || []) {
    if (secret && String(secret).length > 3) out = out.split(String(secret)).join('***');
  }
  return out;
}

/** The message inside an upstream error body, or a readable fallback. */
function upstreamMessage(payload, status) {
  return payload?.error?.message
    || payload?.message
    || payload?.msg
    || (typeof payload === 'string' && payload)
    || `HTTP ${status}`;
}

export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) throw new DeployError(response.status, upstreamMessage(payload, response.status));
    return payload;
  } catch (error) {
    if (error instanceof DeployError) throw error;
    if (error?.name === 'AbortError') throw new DeployError(504, 'The request timed out. Try again.', { cause: error });
    throw new DeployError(502, error instanceof Error ? error.message : 'Upstream request failed.', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Plain-text fetch, used for a SQL schema. `?ref=` is dropped from messages, not from the URL. */
export async function fetchText(url, { headers = {}, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new DeployError(502, `Could not fetch the schema from ${String(url).split('?')[0]} (HTTP ${response.status}).`);
    }
    return await response.text();
  } catch (error) {
    if (error instanceof DeployError) throw error;
    if (error?.name === 'AbortError') throw new DeployError(504, 'The schema request timed out.', { cause: error });
    throw new DeployError(502, error instanceof Error ? error.message : 'Could not fetch the schema.', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

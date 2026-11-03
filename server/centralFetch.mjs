/**
 * `fetch` for the calls this site makes to its update platform, with the redirect followed by hand.
 *
 * **Why this file exists.** `react-wp.com` answers `308` to `https://www.react-wp.com/…`, and the Fetch
 * standard deletes `Authorization` when a redirect crosses origins — a redirect to another host is read
 * as another server, so the header is not carried over to it. The platform then receives a POST that
 * carries no token at all and refuses it as exactly that: `401 Send this site's update token as
 * "Authorization: Bearer <token>"`, which the Updates screen reports as *"React-WP.com could not rebuild
 * this site just now (HTTP 401)"*.
 *
 * A **check** survived the same redirect, because a release list is public and needs no credential — so
 * the failure looked like a broken update button under a screen that had just offered an update.
 *
 * So the redirect is followed here instead, and the request is re-issued at the new address with its
 * method, body and headers intact. Every hop is the same request under another name for the same
 * platform (its apex domain canonicalising itself to `www`), never a resource that has turned into a
 * `GET` — which is why `303` keeps its method here rather than becoming the GET the older half of the
 * spec would make it. A response that is not a redirect, or one with no `Location`, is returned as is;
 * so is one that follows more than `CENTRAL_REDIRECT_LIMIT` hops, because a redirect loop is the
 * platform's problem and the caller already has a sentence for "the platform refused".
 *
 * Plain ESM with no imports: `scripts/selfUpdateRun.mjs` imports it in a detached run — where the only
 * thing available is what this file declares — and `server/updateCenter.mjs` bundles it into the Vercel
 * function, so it must not reach for `node:` or a driver.
 */

/** The statuses that mean "the same request, at another address". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** How many hops one request may take before its answer is taken as final. */
export const CENTRAL_REDIRECT_LIMIT = 3;

/**
 * One request to the platform, with any redirect re-issued by hand.
 *
 * `fetchImpl` is threaded through so every caller keeps its own stub (the self-checks do), and because a
 * test that has to prove "the token arrived" needs to see the request this function sent, not a `fetch`
 * it performed internally.
 *
 * @param {string} url the address to ask
 * @param {RequestInit} [init] the request — method, headers, body, signal
 * @param {{ fetchImpl?: typeof fetch, limit?: number }} [options]
 * @returns {Promise<Response>} the platform's answer, at whatever address finally answered it
 */
export async function centralFetch(url, init = {}, { fetchImpl = fetch, limit = CENTRAL_REDIRECT_LIMIT } = {}) {
  let target = String(url);
  let response;
  for (let hop = 0; hop <= limit; hop += 1) {
    // `manual`: the redirect is answered here rather than by `fetch` itself, which is the whole point —
    // the rule that strips `Authorization` is applied to a redirect `fetch` performs on its own.
    response = await fetchImpl(target, { ...init, redirect: 'manual' });
    const location = typeof response?.headers?.get === 'function'
      ? String(response.headers.get('location') || '').trim()
      : '';
    if (!REDIRECT_STATUSES.has(response?.status) || !location) return response;
    try {
      // Relative and absolute `Location` values are both legal, so the new address is resolved against
      // the one that was just asked rather than trusted to be absolute.
      target = new URL(location, target).toString();
    } catch {
      return response;
    }
  }
  return response;
}

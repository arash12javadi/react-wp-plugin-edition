/**
 * The platform's update API on the universal engine (`/api` → Hono).
 *
 * Two routes, both answering the same JSON as the classic host (`server.mjs` → `server/centralUpdates.mjs`),
 * because both call the same module:
 *
 *   POST /api/v1/updates/check            what `react-wp.com` publishes, for a site that reports its version
 *   POST /api/admin/updates/check         the same conversation under the admin API's longer name
 *
 * Registered only on a deployment that *is* the platform. `centralConfigFrom` answers `enabled: false`
 * everywhere else, and then neither route exists — which is the point: a customer's site already owns
 * `/api/admin/updates/check` (its dashboard's own check, below in `index.ts`), and a platform route that
 * quietly answered 401 there would break it.
 *
 * The caller's `Authorization` header is passed through as a plain object rather than the whole request,
 * so nothing else a caller sends can reach the token comparison.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CENTRAL_CHECK_ALIAS,
  CENTRAL_CHECK_PATH,
  centralConfigFrom,
  handleCentralUpdateRequest,
} from '../../../server/centralUpdates.mjs';

/**
 * Mounts the platform routes when this deployment is configured as the central server, and returns whether
 * it did — `index.ts` uses that to place them before the tenant's own admin router.
 *
 * @param app the Hono app the `/api` routes live on
 */
export function registerCentralUpdateRoutes(app: Hono): boolean {
  if (!centralConfigFrom(process.env).enabled) return false;

  const reply = async (c: Context) => {
    // The pathname comes from the URL rather than `c.req.path`, so the two hosts agree on which route was
    // called even when one of them is mounted under a prefix.
    const pathname = new URL(c.req.url).pathname;
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
    const result = await handleCentralUpdateRequest({
      method: c.req.method,
      pathname,
      headers: { authorization: c.req.header('authorization') || '' },
      body,
      env: process.env,
    });
    return c.json(result?.body ?? { error: 'Not found' }, (result?.status ?? 404) as ContentfulStatusCode);
  };

  app.post(CENTRAL_CHECK_PATH, reply);
  app.post(CENTRAL_CHECK_ALIAS, reply);
  return true;
}

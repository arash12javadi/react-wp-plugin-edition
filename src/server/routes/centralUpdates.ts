/**
 * The platform's update API on the universal engine (`/api` → Hono).
 *
 * Three routes, all answered by the module the classic host (`server.mjs` → `server/centralUpdates.mjs`)
 * calls, so the two hosts cannot disagree about who may ask or what a release is:
 *
 *   POST /api/v1/updates/check            what `react-wp.com` publishes, for a site that reports its version
 *   POST /api/admin/updates/check         the same conversation under the admin API's longer name
 *   POST /api/v1/updates/apply            the release package a managed site installs
 *
 * Registered only on a deployment that *is* the platform. `centralConfigFrom` answers `enabled: false`
 * everywhere else, and then none of the three exists — which is the point: a customer's site already owns
 * `/api/admin/updates/check` (its dashboard's own check, below in `index.ts`), and a platform route that
 * quietly answered 401 there would break it.
 *
 * The verbs are registered separately on purpose. `POST` is the only method that does anything, and every
 * other verb on those paths is answered by the same handler — with its own 405 sentence — so a browser GET
 * cannot be mistaken for "this platform has no update API" (see the loop at the bottom of
 * `registerCentralUpdateRoutes`).
 *
 * Which repository that platform publishes from is resolved per request (`centralPlatformConfig`): the
 * environment first, then the repository saved on its own installer/GitHub cards. Resolving it per request
 * rather than at import is what lets an operator who has just named a repository start answering without a
 * redeploy, and what keeps a database read off the cold-start path of every other route.
 *
 * The caller's `Authorization` header is passed through as a plain object rather than the whole request,
 * so nothing else a caller sends can reach the token comparison.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CENTRAL_APPLY_PATH,
  CENTRAL_CHECK_ALIAS,
  CENTRAL_CHECK_PATH,
  centralConfigFrom,
  centralPlatformConfig,
  handleCentralUpdateRequest,
} from '../../../server/centralUpdates.mjs';
import { getRuntimeConfig } from '../config';
import { integrationReadOptions } from '../pluginHostAccess';

/**
 * The configuration these routes answer with.
 *
 * `centralPlatformConfig` returns the environment's answer immediately when it names a repository, so the
 * runtime config is only read when the platform's repository lives on a screen instead. That answer is
 * cached inside `centralUpdates.mjs` for a minute, so a burst of checks costs one row read — and a
 * deployment that is not the platform pays for at most one probe a minute, whatever asks it.
 */
async function platformConfig() {
  const base = centralConfigFrom(process.env);
  if (base.repo) return base;
  return centralPlatformConfig({ env: process.env, readOptions: integrationReadOptions(await getRuntimeConfig()) });
}

/**
 * Mounts the platform routes and returns whether the environment declares this deployment the platform.
 *
 * The two `/api/v1` paths are always mounted, and the handler answers `404` on a deployment that is not the
 * platform: `centralPlatformConfig` can find the release repository in this deployment's own rows, and a
 * platform configured through its installer card must not need an environment variable before it can
 * answer the sites it handed out. The `/api/admin` alias is mounted only when the environment declares it,
 * because on a customer's site that path is the tenant's own dashboard check.
 *
 * @param app the Hono app the `/api` routes live on
 */
export function registerCentralUpdateRoutes(app: Hono): boolean {
  const declared = centralConfigFrom(process.env).enabled;

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
      config: await platformConfig(),
    });
    // A managed update answers with the release package's bytes; every other answer is JSON.
    if (result?.headers && result.body instanceof Uint8Array) {
      return c.body(new Uint8Array(result.body), (result.status ?? 200) as ContentfulStatusCode, result.headers);
    }
    return c.json(result?.body ?? { error: 'Not found' }, (result?.status ?? 404) as ContentfulStatusCode);
  };

  app.post(CENTRAL_CHECK_PATH, reply);
  app.post(CENTRAL_APPLY_PATH, reply);
  if (declared) app.post(CENTRAL_CHECK_ALIAS, reply);
  // Every other verb on the same paths. A browser's address bar sends a GET, and until now that answered
  // the app's own not-found sentence — `No API endpoint at /api/v1/updates/apply.` — which reads as "this
  // platform publishes no update API" to the very person who configured it. `handleCentralUpdateRequest`
  // already has the sentence that explains the verb, so it is asked for it here instead.
  for (const path of [CENTRAL_CHECK_PATH, CENTRAL_APPLY_PATH, ...(declared ? [CENTRAL_CHECK_ALIAS] : [])]) {
    app.all(path, reply);
  }
  return declared;
}

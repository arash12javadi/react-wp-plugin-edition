/**
 * The platform's update API on the universal engine (`/api` → Hono).
 *
 * Four routes, all answered by the module the classic host (`server.mjs` → `server/centralUpdates.mjs`)
 * calls, so the two hosts cannot disagree about who may ask or what a release is:
 *
 *   POST /api/v1/updates/check            what `react-wp.com` publishes, for a site that reports its version
 *   POST /api/admin/updates/check         the same conversation under the admin API's longer name
 *   POST /api/v1/updates/apply            the release package a managed site installs
 *   POST /api/v1/updates/install          the release applied *here*, to a site this platform provisioned
 *
 * The last one is the only route that changes something outside this deployment. It is handed to
 * `platformInstallHandler`, which loads the installer plugin and spends this platform's `RWP_VERCEL_TOKEN`:
 * the site names its own address, the platform resolves the Vercel project it recorded for that address, and
 * the site's `Update now` button works on a host — Vercel — whose files are read-only.
 *
 * Registered only on a deployment that *is* the platform. `centralConfigFrom` answers `enabled: false`
 * everywhere else, and then none of the four exists — which is the point: a customer's site already owns
 * `/api/admin/updates/check` (its dashboard's own check, below in `index.ts`), and a platform route that
 * quietly answered 401 there would break it.
 *
 * The alias is the one path two callers share, so it is the one path that can be handed on: a platform's
 * own Updates screen posts to it too, and its request names no installed version — a site's does. The
 * handler answers `null` for the screen (`isDashboardAliasCheck` in `server/centralUpdates.mjs`) and
 * `reply` below calls `next()` with it, which is what lets the tenant route in `index.ts` answer its own
 * dashboard. Answering 404 there instead is a sentence about a path that exists.
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
import type { Context, Hono, Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  CENTRAL_APPLY_PATH,
  CENTRAL_CHECK_ALIAS,
  CENTRAL_CHECK_PATH,
  CENTRAL_INSTALL_PATH,
  centralConfigFrom,
  centralPlatformConfig,
  handleCentralUpdateRequest,
} from '../../../server/centralUpdates.mjs';
import { platformInstallHandler } from '../../../server/platformInstaller.mjs';
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
 * because on a customer's site that path is the tenant's own dashboard check — and on a platform it is
 * *also* the platform's own dashboard check, which `reply` passes on to that same tenant route.
 *
 * @param app the Hono app the `/api` routes live on
 */
export function registerCentralUpdateRoutes(app: Hono): boolean {
  const declared = centralConfigFrom(process.env).enabled;

  // One handler for the whole process: it resolves the installer plugin once per request (a deleted plugin
  // folder must not stop the server) and reads this deployment's Supabase location lazily, because that is a
  // runtime-config answer on the Hono host and an environment answer on the classic one.
  const install = platformInstallHandler({
    env: process.env,
    supabase: async () => {
      const config = await getRuntimeConfig();
      return {
        url: config.supabaseUrl,
        publishableKey: config.supabasePublishableKey,
        secretKey: config.supabaseServiceRoleKey,
      };
    },
  });

  const reply = async (c: Context, next: Next) => {
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
      install,
    });
    if (!result) {
      // `null` at the alias is this platform's own Updates screen asking, not one of its sites: the screen
      // names no installed version, because the server reads the running build itself
      // (`isDashboardAliasCheck` in `server/centralUpdates.mjs`). `next()` is how the tenant's own
      // `/api/admin/updates/check` answers it — the route registered below in `index.ts`. Answering 404
      // here instead was the sentence an owner saw for a path that does exist.
      if (pathname === CENTRAL_CHECK_ALIAS) return next();
      return c.json({ error: 'Not found' }, 404 as ContentfulStatusCode);
    }
    // A managed update answers with the release package's bytes; every other answer is JSON.
    if (result.headers && result.body instanceof Uint8Array) {
      return c.body(new Uint8Array(result.body), (result.status ?? 200) as ContentfulStatusCode, result.headers);
    }
    return c.json(result.body, (result.status ?? 404) as ContentfulStatusCode);
  };

  app.post(CENTRAL_CHECK_PATH, reply);
  app.post(CENTRAL_APPLY_PATH, reply);
  // Mounted on every deployment so a customer's `POST /api/v1/updates/install` is the 404 it always was: the
  // handler answers `null` there (`config.enabled` is false), and this route is only ever reachable on the
  // platform whose sites call it.
  app.post(CENTRAL_INSTALL_PATH, reply);
  if (declared) app.post(CENTRAL_CHECK_ALIAS, reply);
  // Every other verb on the same paths. A browser's address bar sends a GET, and until now that answered
  // the app's own not-found sentence — `No API endpoint at /api/v1/updates/apply.` — which reads as "this
  // platform publishes no update API" to the very person who configured it. `handleCentralUpdateRequest`
  // already has the sentence that explains the verb, so it is asked for it here instead.
  for (const path of [CENTRAL_CHECK_PATH, CENTRAL_APPLY_PATH, CENTRAL_INSTALL_PATH, ...(declared ? [CENTRAL_CHECK_ALIAS] : [])]) {
    app.all(path, reply);
  }
  return declared;
}

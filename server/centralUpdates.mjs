/**
 * The platform's half of the update centre: the route a customer's site calls, answered from GitHub
 * Releases by the deployment that owns the repository.
 *
 * This is the file that makes the whole feature token-free for customers. A customer's site holds one
 * thing — the update token `react-wp.com` issued it — and never a GitHub credential, never a private
 * repository's URL, and never a tag's commit. The platform holds `RWP_RELEASE_TOKEN` and
 * `RWP_RELEASE_REPO` and answers a question every site is allowed to ask:
 *
 *   POST /api/v1/updates/check            (also /api/admin/updates/check, for clients built on that name)
 *   Authorization: Bearer <the site's update token>
 *   { "installedVersion": "v1.3.1", "channel": "stable", "site": "shop.example.com" }
 *
 *   { "installedVersion": "v1.3.1", "latestVersion": "v2.4.1", "updateAvailable": true,
 *     "releaseNotes": "- …", "releaseUrl": "https://github.com/…/releases/tag/v2.4.1", … }
 *
 * Three rules this file keeps:
 *
 *   - **The tag is the answer.** `latestVersion` is the newest GitHub release tag, chosen by tag order and
 *     filtered by the channel, never a `package.json` version. `server/githubReleases.mjs` does the
 *     parsing; this file decides who may ask and how the answer is shaped.
 *   - **Off unless it is the platform.** No token list, no repository, no route: a customer's site that
 *     happens to run this code answers 404 at `/api/v1/updates/check` and keeps its own
 *     `/api/admin/updates/check` for its dashboard. `enabled` is the switch, and it is set by environment.
 *   - **Cheap and forgiving.** Answers are cached for a minute, and a GitHub failure serves the last
 *     cached answer instead of an error — a platform's rate limit must not blank every customer's Updates
 *     screen.
 *
 * Plain ESM with no `node:` imports, like `server/updateCenter.mjs`, and the tokens are compared without
 * one either: a constant-time comparison in JS is enough here, and it keeps this file bundlable into the
 * Vercel function.
 */
import { fetchGithubReleases, latestReleaseFrom } from './githubReleases.mjs';
import { UPDATE_CHANNELS, checkAnswerFrom } from './updateCenter.mjs';

/** The route the platform publishes. Also `CENTRAL_CHECK_PATH` in `server/updateCenter.mjs`. */
export const CENTRAL_CHECK_PATH = '/api/v1/updates/check';

/** The same conversation under the admin API's path, kept for clients built against the longer name. */
export const CENTRAL_CHECK_ALIAS = '/api/admin/updates/check';

/** Both paths, in the order a caller should try them. */
export const CENTRAL_CHECK_PATHS = [CENTRAL_CHECK_PATH, CENTRAL_CHECK_ALIAS];

/** How long one GitHub answer is reused. A release is published a few times a week, not a few times a second. */
export const CENTRAL_CACHE_SECONDS = 60;

/** A refusal that carries the status code the route answers with. */
export class CentralError extends Error {
  /**
   * @param {string} message shown in the platform's logs and to the calling site
   * @param {number} [status] the HTTP status this refusal wants
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'CentralError';
    this.status = status;
  }
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const environmentOf = (env) => env || globalThis.process?.env || {};

/**
 * What this deployment is: the platform, or an ordinary site.
 *
 * `enabled` needs both halves — a repository to read and at least one token to accept — because either one
 * alone would publish a route that cannot work, and a half-configured platform is worse than one that
 * answers 404 and lets its sites use the public feed.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export const centralConfigFrom = (env) => {
  const environment = environmentOf(env);
  const tokens = `${trimmed(environment.RWP_CENTRAL_TOKENS)},${trimmed(environment.RWP_CENTRAL_TOKEN)}`
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const releaseRepo = trimmed(environment.RWP_RELEASE_REPO);
  const cacheSeconds = Number(environment.RWP_RELEASE_CACHE_SECONDS);
  return {
    tokens,
    /** `owner/name`, or empty. Validated again by `fetchGithubReleases` before it becomes a URL. */
    repo: releaseRepo,
    githubToken: trimmed(environment.RWP_RELEASE_TOKEN) || trimmed(environment.GITHUB_TOKEN),
    channel: trimmed(environment.RWP_RELEASE_CHANNEL).toLowerCase() === 'beta' ? 'beta' : 'stable',
    cacheSeconds: Number.isFinite(cacheSeconds) && cacheSeconds >= 0 ? cacheSeconds : CENTRAL_CACHE_SECONDS,
    enabled: tokens.length > 0 && Boolean(releaseRepo),
  };
};

/** `Authorization: Bearer …` from a plain node header object, a Fetch `Headers`, or a pre-read value. */
const authorizationFrom = (headers) => {
  const raw = typeof headers?.get === 'function'
    ? headers.get('authorization')
    : (headers?.authorization ?? headers?.Authorization);
  return trimmed(String(raw ?? '')).replace(/^Bearer\s+/i, '');
};

/** Equal secrets in the time the length allows, so a token cannot be guessed a character at a time. */
const sameSecret = (given, expected) => {
  if (!given || given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < given.length; index += 1) {
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
};

/**
 * Whether the caller may ask. The answer never says *which* part of a token was wrong, and never says
 * whether a token exists at all for a site the platform does not know.
 *
 * @param {{ headers: any, config: ReturnType<typeof centralConfigFrom> }} input
 */
export const authorizeCentral = ({ headers, config }) => {
  const given = authorizationFrom(headers);
  if (!given) {
    return { ok: false, status: 401, error: 'Send this site\'s update token as "Authorization: Bearer <token>". Settings → Updates shows where it is saved.' };
  }
  if (!config.tokens.some((token) => sameSecret(given, token))) {
    return { ok: false, status: 403, error: 'This update token is not valid for the central server. Issue one per site and save it on Settings → Updates.' };
  }
  return { ok: true };
};

/** Parsed GitHub answers, one per repository, so a hundred checks in a minute cost one API call. */
const releaseCache = new Map();

/** Drops the cache. Exported for the self-check, and for a platform that wants a release to appear now. */
export const clearCentralReleaseCache = () => releaseCache.clear();

/**
 * The repository's releases, cached, with the last good answer standing in for a failed refresh.
 *
 * @param {{ config: ReturnType<typeof centralConfigFrom>, fetchImpl?: typeof fetch, now?: number }} options
 */
const cachedReleases = async ({ config, fetchImpl = fetch, now = Date.now() }) => {
  const cached = releaseCache.get(config.repo);
  if (cached && now - cached.at < config.cacheSeconds * 1000) return cached;
  try {
    const fetched = await fetchGithubReleases({ repo: config.repo, token: config.githubToken, fetchImpl });
    const entry = { at: now, repo: fetched.repo, releases: fetched.releases, stale: false, error: '' };
    releaseCache.set(config.repo, entry);
    return entry;
  } catch (error) {
    // A rate limit or a GitHub outage must not blank every customer's Updates screen: the last answer is
    // still the best answer available, and `stale` says so.
    if (cached) return { ...cached, stale: true, error: error instanceof Error ? error.message : '' };
    throw error;
  }
};

/**
 * The answer for one site: the release list the rest of this project already understands (`app`,
 * `updates`, `update_available`) plus the four names the central contract promises. Building it with
 * `checkAnswerFrom` rather than by hand is what keeps the platform and the site from disagreeing about
 * whether an update exists.
 *
 * @param {{ installedVersion?: string, release: any, channel: string, repo: string, checkedAt?: string, stale?: boolean, note?: string }} input
 */
export const centralAnswerFrom = ({ installedVersion, release, channel, repo, checkedAt = new Date().toISOString(), stale = false, note = '' }) => {
  const installed = trimmed(installedVersion).replace(/^v/i, '');
  return {
    ...checkAnswerFrom({
      source: 'github',
      app: release,
      plugins: {},
      current: { app: installed },
      plugins_installed: [],
      error: note,
    }),
    checked_at: checkedAt,
    repo,
    channel,
    stale,
  };
};

/**
 * One check: who asked, which channel, and what GitHub publishes. The installed version is the caller's
 * to report; the platform has no way to know what a site runs, and no reason to trust a different answer.
 *
 * @param {{ body: any, config: ReturnType<typeof centralConfigFrom>, fetchImpl?: typeof fetch, now?: number }} input
 */
export async function centralCheckAnswer({ body, config, fetchImpl = fetch, now = Date.now() }) {
  const requested = trimmed(body?.channel).toLowerCase();
  const channel = UPDATE_CHANNELS.includes(requested) ? requested : config.channel;
  const installedVersion = trimmed(body?.installedVersion) || trimmed(body?.app?.version);
  const cache = await cachedReleases({ config, fetchImpl, now });
  const release = latestReleaseFrom(cache.releases, { channel });
  if (!release) {
    throw new CentralError(`No ${channel} release is published on ${cache.repo} yet. Publish a GitHub release tagged v1.0.0, and the next check will find it.`, 404);
  }
  return centralAnswerFrom({
    installedVersion,
    release,
    channel,
    repo: cache.repo,
    checkedAt: new Date(now).toISOString(),
    stale: cache.stale === true,
    // Said to the customer in words that do not name this platform's environment variables.
    note: cache.stale ? 'The release list could not be refreshed just now, so this is the last answer GitHub confirmed.' : '',
  });
}

/**
 * The route both hosts mount: `POST /api/v1/updates/check`, and the `/api/admin/updates/check` alias.
 *
 * Returns **null** — not 404 — for a path it does not own, or for a deployment that is not the platform.
 * That is what lets `server.mjs` and the Hono app chain this in front of their own admin routes without
 * changing the answer an ordinary site gives: a customer's `/api/admin/updates/check` is still its own
 * dashboard's check, and `/api/v1/updates/check` is still an unknown path.
 *
 * @param {{ method?: string, pathname?: string, headers?: any, body?: any, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: number }} input
 */
export async function handleCentralUpdateRequest({
  method = 'POST',
  pathname,
  headers = {},
  body = {},
  env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const path = trimmed(String(pathname ?? '')).replace(/\/+$/, '');
  if (!CENTRAL_CHECK_PATHS.includes(path)) return null;
  const config = centralConfigFrom(env);
  if (!config.enabled) return null;
  if (String(method).toUpperCase() !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed. A check is a POST, because it carries the version this site runs.' } };
  }
  try {
    const auth = authorizeCentral({ headers, config });
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    return { status: 200, body: await centralCheckAnswer({ body, config, fetchImpl, now }) };
  } catch (error) {
    // Everything caught here is *this* deployment's problem — the repository name, the release token, a
    // rate limit, a release that has not been published yet. The detail goes to the platform's log, where
    // the owner can act on it, and never into the answer: a customer must not learn from an update check
    // which environment variables this server reads. A 404 is relayed as 502 because a caller reads 404
    // as "wrong path" and would stop asking.
    const status = Number.isInteger(error?.status) ? error.status : 502;
    console.error(`central update check failed (${status}): ${error instanceof Error ? error.message : String(error)}`);
    return {
      status: status === 404 ? 502 : status,
      body: { error: 'The central server could not read the release list from GitHub just now. Try again in a minute; this site keeps its last known release until then.' },
    };
  }
}

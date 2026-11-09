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
 * and two more under the same token:
 *
 *   POST /api/v1/updates/apply            the release package, which the site installs itself
 *   POST /api/v1/updates/install          the same release, applied *by the platform* to the site's own
 *                                         project — for a host that cannot install anything (a Vercel
 *                                         deployment, whose files are read-only). The site names itself
 *                                         (`"site": "https://shop.vercel.app"`), the platform resolves the
 *                                         Vercel project it provisioned for that address, builds the
 *                                         release and uploads it, so the site's `Update now` button works
 *                                         without a Vercel token of its own and without a deploy hook.
 *
 * Five rules this file keeps:
 *
 *   - **The tag is the answer.** `latestVersion` is the newest GitHub release tag, chosen by tag order and
 *     filtered by the channel, never a `package.json` version. `server/githubReleases.mjs` does the
 *     parsing; this file decides who may ask and how the answer is shaped.
 *   - **Only the platform answers, and it does not have to be configured twice.** A deployment that holds
 *     an update token *or* names the repository it publishes mounts these routes; a customer's site holds
 *     neither, answers 404 at `/api/v1/updates/check` and keeps its own `/api/admin/updates/check` for its
 *     dashboard. Requiring both halves at once is what made a real platform answer
 *     `No API endpoint at /api/v1/updates/apply.` to its own sites, so `enabled` is `true` when either
 *     half is present, and the remaining half is reported as the 503 that names it
 *     (`centralRefusalFor`) instead of as a path that does not exist.
 *   - **The release list is public; the package is not.** A check needs no token, because a site that was
 *     provisioned before this feature existed still has to be able to read a version number — and one that
 *     was never handed a token must not be told its platform connection is broken. `apply` hands out the
 *     product's own source, so it stays token-gated; `install` changes a customer's project, so it does
 *     too, and it needs a platform that can deploy at all (an installer, and the Vercel credential the
 *     installer spends) — a platform without one answers 501 with the sentence naming it.
 *     `RWP_CENTRAL_PUBLIC_CHECKS=off` restores the older rule that a check needs a token too.
 *   - **Cheap and forgiving.** Answers are cached for a minute, and a GitHub failure serves the last
 *     cached answer instead of an error — a platform's rate limit must not blank every customer's Updates
 *     screen.
 *
 * Plain ESM with no `node:` imports, like `server/updateCenter.mjs`, and the tokens are compared without
 * one either: a constant-time comparison in JS is enough here, and it keeps this file bundlable into the
 * Vercel function.
 */
import { fetchGithubReleases, latestReleaseFrom } from './githubReleases.mjs';
import { GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY, githubTokenFrom, saasInstallerConfigFrom } from './integrationConfig.mjs';
import { readIntegrationRows } from './integrationSettings.mjs';
import { UPDATE_CHANNELS, checkAnswerFrom, githubUpdateSourceFrom } from './updateCenter.mjs';
import { buildCoreReleaseZip } from './releasePackage.mjs';

/** The route the platform publishes. Also `CENTRAL_CHECK_PATH` in `server/updateCenter.mjs`. */
export const CENTRAL_CHECK_PATH = '/api/v1/updates/check';

/** The same conversation under the admin API's path, kept for clients built against the longer name. */
export const CENTRAL_CHECK_ALIAS = '/api/admin/updates/check';

/** Both paths, in the order a caller should try them. */
export const CENTRAL_CHECK_PATHS = [CENTRAL_CHECK_PATH, CENTRAL_CHECK_ALIAS];

/**
 * The managed-update route: a provisioned site asks the platform for the *release package* its last check
 * found, then applies that package to itself — no Vercel token, no deploy hook, no GitHub name.
 * Same bearer token as the check, so nothing extra is issued for the right to be updated.
 */
export const CENTRAL_APPLY_PATH = '/api/v1/updates/apply';

/**
 * The redeploy route: a provisioned site whose host cannot install a package (a Vercel deployment, whose
 * files are read-only) asks the platform to rebuild the release and upload it to the site's *own* Vercel
 * project. The site names itself; the platform resolves the project it recorded for that address and
 * spends its own Vercel token, so the customer needs neither a token nor a deploy hook for this.
 */
export const CENTRAL_INSTALL_PATH = '/api/v1/updates/install';

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
 * `enabled` — the switch both hosts read before mounting the routes — is `true` as soon as *either* half
 * exists: a token to accept, or a repository to read. Requiring both at once is what made a real platform
 * answer `No API endpoint at /api/v1/updates/apply.` to its own sites: it had saved the repository on the
 * installer card and the token in its environment, and neither half was where this function looked. A
 * deployment with neither half still answers 404 everywhere, which is what keeps a customer's
 * `/api/admin/updates/check` its own.
 *
 * `repo` may legitimately be empty at mount time, because the repository a platform publishes from is
 * usually a `system_settings` row rather than an environment variable; `centralPlatformConfig` fills it in
 * per request from `stored`, and a request that still has none is refused with the sentence naming what to
 * set rather than with a 404.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ repo?: string, token?: string }} [stored] the repository and credential read from this
 *   deployment's own `github_config` / `saas_installer_config` rows
 */
export const centralConfigFrom = (env, stored = {}) => {
  const environment = environmentOf(env);
  const tokens = `${trimmed(environment.RWP_CENTRAL_TOKENS)},${trimmed(environment.RWP_CENTRAL_TOKEN)}`
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const releaseRepo = trimmed(environment.RWP_RELEASE_REPO) || trimmed(stored.repo);
  const cacheSeconds = Number(environment.RWP_RELEASE_CACHE_SECONDS);
  const publicChecks = !/^(off|false|no|0)$/i.test(trimmed(environment.RWP_CENTRAL_PUBLIC_CHECKS));
  return {
    tokens,
    /** `owner/name`, or empty. Validated again by `fetchGithubReleases` before it becomes a URL. */
    repo: releaseRepo,
    githubToken: trimmed(environment.RWP_RELEASE_TOKEN) || trimmed(environment.GITHUB_TOKEN) || trimmed(stored.token),
    channel: trimmed(environment.RWP_RELEASE_CHANNEL).toLowerCase() === 'beta' ? 'beta' : 'stable',
    cacheSeconds: Number.isFinite(cacheSeconds) && cacheSeconds >= 0 ? cacheSeconds : CENTRAL_CACHE_SECONDS,
    /** Whether the routes exist here at all: a token to accept, or a repository to answer from. */
    enabled: tokens.length > 0 || Boolean(releaseRepo),
    /** Whether a release list can be answered: a repository, and a token unless checks are public. */
    checkEnabled: Boolean(releaseRepo) && (publicChecks || tokens.length > 0),
    /** Whether the release *package* may be handed out — that always costs a token. */
    applyEnabled: Boolean(releaseRepo) && tokens.length > 0,
    /** Whether a check may be answered without a token. `RWP_CENTRAL_PUBLIC_CHECKS=off` turns this off. */
    publicChecks,
  };
};

/** How long a repository read from this platform's own settings is reused. */
const STORED_REPO_CACHE_MS = 60_000;

/** The last repository/credential resolved from `system_settings`. Empty until one is found. */
let storedReleaseSource = { at: 0, value: { repo: '', token: '' } };

/** Drops the cached repository. Exported for the self-check, and for a card that just saved a new one. */
export const clearStoredReleaseSource = () => {
  storedReleaseSource = { at: 0, value: { repo: '', token: '' } };
};

/**
 * The configuration the routes actually answer with: the environment first, then the repository and
 * credential this deployment saved on its own cards.
 *
 * The fallback exists because configuring a platform is a screen, not a deploy: the owner names the
 * template repository on the installer card and connects GitHub on the integrations card, which write
 * `saas_installer_config` and `github_config`. A platform whose release repository lives only in those
 * rows used to answer 404 at `/api/v1/updates/apply` — its own sites were told there was no update API.
 *
 * A row that cannot be read is not an error here: it leaves `repo` empty, and the request is refused with
 * the sentence that names the environment variable, which is the one answer that cannot be wrong.
 *
 * @param {{ env?: Record<string, string | undefined>, readOptions?: any, now?: number }} [input]
 */
export async function centralPlatformConfig({ env, readOptions, now = Date.now() } = {}) {
  const base = centralConfigFrom(env);
  // Already configured: no row is read.
  if (base.repo) return base;
  let source = storedReleaseSource.value;
  if (now - storedReleaseSource.at >= STORED_REPO_CACHE_MS) {
    const rows = await readIntegrationRows(
      [GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY],
      readOptions || { env: environmentOf(env) },
    ).catch(() => null);
    const settings = rows?.settings || {};
    const github = githubUpdateSourceFrom(undefined, settings[GITHUB_CONFIG_KEY], '');
    const installer = saasInstallerConfigFrom(settings[SAAS_INSTALLER_CONFIG_KEY]);
    // The credential is read from the GitHub row directly rather than from `githubUpdateSourceFrom`, which
    // answers `null` unless that same row also names a repository — and on a platform the repository is
    // usually on the installer card instead, with only the token here.
    source = {
      repo: trimmed(github?.repo) || installer.template_repo,
      token: githubTokenFrom(settings[GITHUB_CONFIG_KEY]),
    };
    // Cached whether or not it found something: a deployment that is not the platform must not read these
    // rows for every request that happens to ask a platform path, and a platform that has just saved a
    // repository starts answering within the minute.
    storedReleaseSource = { at: now, value: source };
  }
  return centralConfigFrom(env, source);
}

/** `Authorization: Bearer …` from a plain node header object, a Fetch `Headers`, or a pre-read value. */
/** Whether the caller sent a token, read exactly as `authorizeCentral` reads it. Exported for the self-check. */
export const authorizationFrom = (headers) => {
  const raw = typeof headers?.get === 'function'
    ? headers.get('authorization')
    : (headers?.authorization ?? headers?.Authorization);
  return trimmed(String(raw ?? '')).replace(/^Bearer\s+/i, '');
};

/**
 * Whether a request is the dashboard of *this* deployment rather than one of its sites.
 *
 * `/api/admin/updates/check` is two things at once on a platform: the alias a customer's site may ask, and
 * the path the platform's own Updates screen posts to. Until this answered `null` for the second, the
 * owner's own check — a signed-in administrator who never had a token to send — was read as a site with a
 * bad credential and refused with `This update token is not valid for the central server.`, which is a
 * sentence about a field that owner had every right to leave empty. The screen showed it under
 * `check.error`, so the platform's own Updates card could not check itself.
 *
 * The two callers are told apart by what a caller knows and the server does not: a site states the version
 * it runs — the contract in the header of this file starts with `installedVersion` — while this
 * deployment's own screen cannot, because the server reads the running build itself
 * (`resolveInstalledVersion` in `server/updateCenter.mjs`) and the browser has never been told where
 * updates come from. So an alias request that names no installed version belongs to the dashboard, and
 * `null` hands it to the site's own route, exactly as it is handed over on a deployment that is not the
 * platform. A request that *does* name a version is a site, and a token it sends is still verified: a
 * revoked site is still told so, and `/api/v1/updates/check` is never treated this way, because that path
 * belongs to the platform alone.
 *
 * `format` is the third fact, and it is only ever read as a safety net: a client that asks this platform stamps every
 * request it makes with `format: 'rwp-update-center'`, so a caller speaking the site contract stays a site
 * even if the version it reports is blank — a site whose installed version could not be resolved must get a
 * refusal it can read, not this deployment's own dashboard route.
 *
 * @param {string} path the normalised pathname this request asked for
 * @param {any} body the parsed body, or `{}` for a request that had none
 */
export const isDashboardAliasCheck = (path, body) =>
  path === CENTRAL_CHECK_ALIAS
  && !trimmed(body?.installedVersion)
  && !trimmed(body?.app?.version)
  && !trimmed(body?.format);

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
 * The 503 a platform owes its sites when it is switched on but half-configured.
 *
 * This is the answer that replaces a 404 nobody could act on: a site reads 404 as "wrong address" and
 * stops asking, while the operator reads this sentence and sets the variable it names. The text names
 * environment variables, so it is meant for the platform operator and is never shown to a customer.
 *
 * @param {ReturnType<typeof centralConfigFrom>} config
 * @param {'check'|'apply'|'install'} kind
 */
const centralRefusalFor = (config, kind) => {
  if (!config.repo) {
    return {
      status: 503,
      body: { error: 'This platform has no release repository, so it cannot answer update requests yet. Set RWP_RELEASE_REPO on this server, or name the template repository on the installer card.' },
    };
  }
  if (!config.publicChecks && config.tokens.length === 0) {
    return {
      status: 503,
      body: { error: 'This platform publishes releases but accepts no update tokens, so it cannot answer update requests. Set RWP_CENTRAL_TOKEN (or RWP_CENTRAL_TOKENS) on this server.' },
    };
  }
  if (kind === 'apply' && config.tokens.length === 0) {
    return {
      status: 503,
      body: { error: 'This platform accepts no update tokens, so it cannot hand out release packages. Set RWP_CENTRAL_TOKEN (or RWP_CENTRAL_TOKENS) on this server.' },
    };
  }
  if (kind === 'install' && config.tokens.length === 0) {
    return {
      status: 503,
      body: { error: 'This platform accepts no update tokens, so it cannot redeploy a site. Set RWP_CENTRAL_TOKEN (or RWP_CENTRAL_TOKENS) on this server.' },
    };
  }
  return null;
};

/**
 * The route both hosts mount: `POST /api/v1/updates/check`, the `/api/admin/updates/check` alias,
 * `POST /api/v1/updates/apply` and `POST /api/v1/updates/install`.
 *
 * Returns **null** — not 404 — for a path it does not own, or for a deployment that is not the platform.
 * That is what lets `server.mjs` and the Hono app chain this in front of their own admin routes without
 * changing the answer an ordinary site gives: a customer's `/api/admin/updates/check` is still its own
 * dashboard's check, and `/api/v1/updates/check` is still an unknown path.
 *
 * It also returns null for the alias when the caller is this deployment's own dashboard rather than one of
 * its sites (`isDashboardAliasCheck`): a platform's Updates screen posts to the same path, and answering it
 * as a site refused the owner's own check with a sentence about a token they never had.
 *
 * A **check** is answered without a token — the release list is not the product, and a site that was never
 * handed a token still has to be able to read a version number — while a token that *is* sent is still
 * verified, so a revoked site is told so. An **apply** is always token-gated: it hands out the package. An
 * **install** is token-gated for the same reason (it changes a customer's project) and is delegated to the
 * `install` function the host passes in, because the build-and-upload pipeline belongs to the installer
 * plugin (`plugins/rwp-saas-installer/server.mjs`, `platformInstall`) and not to this file: a platform that
 * never activated an installer answers 501 with the sentence naming it, rather than shipping that code to
 * every deployment.
 *
 * @param {{ method?: string, pathname?: string, headers?: any, body?: any, env?: Record<string, string | undefined>, config?: any, fetchImpl?: typeof fetch, now?: number, install?: ((input: { body: any, config: any }) => Promise<{ status?: number, body?: any }>) | null }} input
 */
export async function handleCentralUpdateRequest({
  method = 'POST',
  pathname,
  headers = {},
  body = {},
  env,
  config: resolved = null,
  fetchImpl = fetch,
  now = Date.now(),
  install = null,
} = {}) {
  const path = trimmed(String(pathname ?? '')).replace(/\/+$/, '');
  const isApply = path === CENTRAL_APPLY_PATH;
  const isInstall = path === CENTRAL_INSTALL_PATH;
  if (!CENTRAL_CHECK_PATHS.includes(path) && !isApply && !isInstall) return null;
  const config = resolved || centralConfigFrom(env);
  if (!config.enabled) return null;
  if (String(method).toUpperCase() !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed. A check or an update is a POST, because it carries the site\'s token and version.' } };
  }
  // This deployment's own Updates screen asks its own route, not this one: it names no installed version
  // because the server reads the running build itself. Answering it here is what surfaced the token
  // sentence on the platform's own card, so it is handed back before any credential is looked at.
  if (isDashboardAliasCheck(path, body)) return null;
  try {
    const withheld = centralRefusalFor(config, isInstall ? 'install' : isApply ? 'apply' : 'check');
    if (withheld) return withheld;
    // A token that was sent is always verified, even for a public check: that is how a site learns its
    // credential was revoked. Only its *absence* is tolerated, and only where checks are public.
    if (isApply || isInstall || authorizationFrom(headers) || !config.publicChecks) {
      const auth = authorizeCentral({ headers, config });
      if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    }
    if (isInstall) {
      // The pipeline lives in the installer plugin. Handing the request over rather than importing the
      // plugin here keeps this module free of Vercel upload code, and makes "no installer on this
      // deployment" a sentence instead of a crash.
      if (typeof install !== 'function') {
        return {
          status: 501,
          body: { error: 'This platform has no installer configured, so it cannot redeploy a site. The build-and-upload pipeline lives in the rwp-saas-installer plugin: activate it, or use its own card to deploy.' },
        };
      }
      const answer = await install({ body, config });
      return { status: Number(answer?.status) || 200, body: answer?.body ?? answer ?? {} };
    }
    if (isApply) {
      const pkg = await buildCoreReleaseZip({
        repo: config.repo,
        token: config.githubToken || '',
        version: trimmed(body?.to),
        fetchImpl,
      });
      if (!pkg.ok) return { status: pkg.status || 501, body: { error: pkg.error || 'The platform could not build the release package.' } };
      return {
        status: 200,
        headers: {
          'Content-Type': pkg.contentType || 'application/zip',
          'Content-Disposition': `attachment; filename="${pkg.filename || 'react-wp-update.zip'}"`,
          'Cache-Control': 'no-store',
        },
        body: pkg.bytes,
      };
    }
    return { status: 200, body: await centralCheckAnswer({ body, config, fetchImpl, now }) };
  } catch (error) {
    // Everything caught here is *this* deployment's problem — the repository name, the release token, a
    // rate limit, a release that has not been published yet. The detail goes to the platform's log, where
    // the owner can act on it, and never into the answer: a customer must not learn from an update check
    // which environment variables this server reads. A 404 is relayed as 502 because a caller reads 404
    // as "wrong path" and would stop asking.
    const status = Number.isInteger(error?.status) ? error.status : 502;
    console.error(`central update request failed (${status}): ${error instanceof Error ? error.message : String(error)}`);
    return {
      status: status === 404 ? 502 : status,
      body: {
        error: isInstall
          ? 'The central server could not redeploy this site just now. Nothing has changed on it — try again in a few minutes, and contact React-WP support if it keeps failing.'
          : isApply
            ? 'The central server could not build the release package just now. Try again in a minute; the site keeps its last known release until then.'
            : 'The central server could not read the release list from GitHub just now. Try again in a minute; this site keeps its last known release until then.',
      },
    };
  }
}

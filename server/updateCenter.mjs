/**
 * The update centre: which version this site runs, which version is published, and how an update is
 * applied.
 *
 * Three jobs, one file, because the two hosts (`server.mjs` and the universal engine's
 * `src/server/routes/updates.ts`) must answer with the same JSON:
 *
 *   1. **Ask the central server.** `POST {central}/api/v1/updates/check` reports this site's version and
 *      every installed plugin's, and answers with the releases. The bearer token it uses is
 *      `system_settings.updates_config.token` — written by the signed-in administrator, read here only.
 *      The browser never holds it and never calls GitHub: that is what keeps a private repository
 *      private while still telling an administrator that an update exists.
 *   2. **Read GitHub directly when this deployment owns the repository.** A site reads its release tags
 *      with the GitHub credential the Integrations hub already stores (`github_config`, or
 *      `RWP_RELEASE_TOKEN`/`GITHUB_TOKEN`), from the repository named in `updates_config.repository` when
 *      Settings → Updates names one. One source of truth, the release tag, so a check cannot answer 404
 *      because a JSON file was not published, and a tag cannot disagree with it.
 *   3. **Apply the update.** A Vercel/Netlify host is told to rebuild (`deploy_config`, Settings →
 *      Integrations → Deployments); a host that runs `node server.mjs` runs `server/selfUpdate.mjs`.
 *      Which one is chosen, and why, is `updatePlan`.
 *
 * A version is published by *tagging a release* on GitHub (`v2.4.1`) — that tag is the source of truth,
 * never the `version` field of a `package.json`. The tag travels with the release (`tag`), reaches this
 * file through `releaseFrom`, and is what the screen shows and the check compares; the platform's half of
 * that conversation lives in `server/githubReleases.mjs` and `server/centralUpdates.mjs`, and the direct
 * read in `fetchGithubCheck` below.
 *
 * Plain ESM with no `node:` imports: the same file is bundled into the Vercel function by
 * `vite.api.config.mjs` and imported directly by `server.mjs`. `process.env` is read through
 * `environmentOf`, so a Workers deployment that has none does not crash on import.
 */
import { GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY, githubTokenFrom, saasInstallerConfigFrom } from './integrationConfig.mjs';
import { readIntegrationRows } from './integrationSettings.mjs';
import { fetchGithubReleases, latestReleaseFrom, repoFrom } from './githubReleases.mjs';
import { compareVersions, isVersion } from './versions.mjs';

/** Re-exported so every caller of this module keeps one import, as it always has. */
export { compareVersions, isVersion, parseVersion } from './versions.mjs';


/** `system_settings` rows this feature owns, in step with `src/lib/updateCenter.ts`. */
export const UPDATE_CONFIG_KEY = 'updates_config';
export const VERSION_STATE_KEY = 'version_state';

/** How many past updates `version_state.history` keeps. */
export const VERSION_STATE_HISTORY_LIMIT = 20;

/** Where the central server lives when nothing says otherwise. */
export const DEFAULT_CENTRAL_URL = 'https://react-wp.com';

/**
 * The central endpoints, named once so the client, the docs and this file cannot disagree.
 *
 * `CENTRAL_CHECK_PATH` is the contract this project asks for: the site reports what it runs and the
 * platform answers with the releases. `CENTRAL_CHECK_FALLBACK_PATH` is the same conversation under the
 * path the platform's own admin API uses, tried only when the first answers 404 — a deployment that
 * publishes the shorter route and one that publishes the longer one are both reachable, and no
 * configuration decides which.
 */
export const CENTRAL_CHECK_PATH = '/api/v1/updates/check';
export const CENTRAL_CHECK_FALLBACK_PATH = '/api/admin/updates/check';
export const CENTRAL_CHECK_PATHS = [CENTRAL_CHECK_PATH, CENTRAL_CHECK_FALLBACK_PATH];
/** The managed-update route, in step with `CENTRAL_APPLY_PATH` in `server/centralUpdates.mjs`. */
export const CENTRAL_APPLY_PATH = '/api/v1/updates/apply';
export const PLUGIN_DIRECTORY_PATH = '/api/v1/plugins';

/** The release channels a site may follow. `beta` receives pre-releases, `stable` does not. */
export const UPDATE_CHANNELS = ['stable', 'beta'];

/** The keys `auto_check` accepts, in step with `autoCheckIntervals` in `src/lib/updates.ts`. */
export const AUTO_CHECK_KEYS = ['off', 'admin', 'daily', 'weekly', 'monthly'];

/** A refusal that carries the status code to answer with, the same way `InstallError` does. */
export class UpdateError extends Error {
  /**
   * @param {string} message shown to the administrator as is
   * @param {number} [status] the HTTP status this refusal wants
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'UpdateError';
    this.status = status;
  }
}

/** `process.env` where the runtime has one, and nothing where it does not (Workers, Deno, Bun). */
const environmentOf = (env) => env || globalThis.process?.env || {};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The release tag the SaaS installer recorded when it last built or updated this site, as a plain
 * version (no `v`). Empty when this site was not provisioned through `rwp-saas-installer` — a
 * self-hosted checkout, or a platform instance that has never been deployed from its own card.
 *
 * This is the only record that names the *exact* GitHub release a provisioned site was built from:
 * its `package.json` is the template's own (and lags the tag), while the installer writes the tag it
 * deployed into `saas_installer_config.installed_version`.
 */
export const saasInstalledVersionFrom = (value) => {
  const version = trimmed(saasInstallerConfigFrom(value).installed_version).replace(/^v/i, '');
  return isVersion(version) ? version : '';
};

/**
 * Which version this host reports as installed. One order, shared by both hosts so they cannot disagree:
 *
 *   1. the deploy's own pin (`RWP_APP_VERSION`) — the tag the running code was built from, which cannot lag;
 *   2. the tag the SaaS installer recorded (`saas_installer_config.installed_version`);
 *   3. the `package.json` the build was compiled from.
 *
 * Each answer is normalised to a plain version (no `v`), the shape every comparison in this file expects.
 */
export const resolveInstalledVersion = ({ pinned = '', saas = '', fallback = '' }) =>
  trimmed(pinned).replace(/^v/i, '') || trimmed(saas).replace(/^v/i, '') || trimmed(fallback).replace(/^v/i, '');

/* -- Versions ------------------------------------------------------------------------------------ */

/**
 * `parseVersion`, `compareVersions` and `isVersion` live in `server/versions.mjs`, imported and
 * re-exported above. They moved because `server/githubReleases.mjs` compares tags too and must not
 * import this file to do it — one comparison, one owner, no chance of two answers.
 */

/* -- `system_settings.updates_config` ------------------------------------------------------------ */

/**
 * Whatever is stored in `system_settings.updates_config`, as a complete configuration.
 *
 * Every field falls back rather than throwing: this row is written by a browser, so a half-filled or
 * hand-edited value must still leave the Updates screen usable. The token is the one field with no
 * default — without it this site does not ask a central server, and the check reads this deployment's
 * own GitHub release tags instead (`githubUpdateSourceFrom`).
 *
 * @param {unknown} value
 */
export const updateConfigFrom = (value) => {
  const row = value && typeof value === 'object' ? value : {};
  const central = trimmed(row.central_url).replace(/\/+$/, '');
  const channel = trimmed(row.channel).toLowerCase();
  const autoCheck = trimmed(row.auto_check).toLowerCase();
  const repository = trimmed(row.repository);
  return {
    /** The origin of the update server, without a trailing slash. */
    central_url: /^https?:\/\//i.test(central) ? central : DEFAULT_CENTRAL_URL,
    /** The server-only bearer token. Never sent to the browser, never logged. */
    token: trimmed(row.token),
    /**
     * `owner/name` of the repository whose release tags this site is updated from, as named on
     * Settings → Updates. Empty means "whichever repository the GitHub integration holds", and a value
     * that is not a repository at all reads as empty rather than as a broken URL to fetch.
     */
    repository: repoFrom(repository) ? repository : '',
    channel: UPDATE_CHANNELS.includes(channel) ? channel : 'stable',
    auto_check: AUTO_CHECK_KEYS.includes(autoCheck) ? autoCheck : 'weekly',
    notify: row.notify !== false,
    /**
     * Whether `POST /api/admin/system/update` may run the updater on this server.
     *
     * Opt-in, because the updater rewrites the checkout this site runs from: an administrator has to
     * tick it on Settings → Updates, and `server/selfUpdate.mjs` still refuses a checkout with
     * uncommitted changes. Absent means no — a site that never asked for this must not get it because
     * it happened to be a git clone.
     */
    self_update: row.self_update === true,
  };
};

/**
 * The same configuration, safe to show an administrator: the token becomes `has_token`.
 *
 * Every answer that names the configuration goes through here, so a token pasted into the wrong field
 * cannot travel back through the API it was meant for.
 *
 * `owner` is the one account that may see *where* updates come from. An end user — a provisioned site's
 * `super_admin`, or a role that was merely granted `manage_options` — receives a redacted view: the
 * GitHub repository, the central URL and the token's presence are none of their business, their check
 * is always answered by `react-wp.com`, and the only controls they keep are the scheduling ones below.
 *
 * @param {ReturnType<typeof updateConfigFrom>} config
 * @param {boolean} [owner=true]
 */
export const describeUpdateConfig = (config, owner = true) => ({
  /** The origin of the central update server. Hidden from end users, whose updates are managed. */
  central_url: owner ? config.central_url : '',
  channel: owner ? config.channel : 'stable',
  auto_check: config.auto_check,
  notify: config.notify,
  /** The server never self-updates an end user's managed instance; the platform deploys it. */
  self_update: owner ? config.self_update : false,
  /** The repository a check reads first, when Settings → Updates names one. Hidden from end users. */
  repository: owner ? config.repository : '',
  has_token: owner ? config.token.length > 0 : false,
  /** Whether this site's updates are fetched and applied by the platform (`central`) or by the owner. */
  managed: !owner,
  /**
   * Which source an update check asks first. For an end user this is always `central`: they must never
   * read a GitHub repository, and `react-wp.com` answers on their behalf. For the owner the original rule
   * holds — GitHub when a repository is named or no central token is stored, else the central server.
   */
  source: !owner ? 'central' : (!config.token || config.repository) ? 'github' : 'central',
});

/**
 * The GitHub repository a check may read directly, or null.
 *
 * A deployment owns the repository its releases are tagged on, so it does not need a central server to be
 * told about them — but that read needs a credential for a private repository, and the Integrations hub
 * already stores one (`github_config`, written by Settings → Integrations → GitHub).
 *
 * The order is deliberate, because the wrong repository answers with the wrong release:
 *
 *   - `configured` — `updates_config.repository`, the repository Settings → Updates names. This is the
 *     administrator pointing at the tags this *site* is released on (a plugin edition's own repository,
 *     say), so nothing overrides it, and a check that finds it never asks the platform instead.
 *   - `RWP_RELEASE_REPO` — `owner/name`, the variable a platform build pins (`server/centralUpdates.mjs`
 *     reads the same one).
 *   - `GITHUB_REPO` — the name the GitHub card writes.
 *   - the stored `github_config.repository`.
 *
 * The token is `RWP_RELEASE_TOKEN`, else `GITHUB_TOKEN`, else the token the GitHub integration stored; a
 * public repository needs none, which is why an empty token is a supported state rather than an error.
 *
 * `explicit` says whether the repository came from the screen, which is what `checkForUpdates` reads to
 * decide the order of its two sources.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {unknown} [stored] the `github_config` row
 * @param {unknown} [configured] `updates_config.repository`, as typed on Settings → Updates
 * @returns {{ repo: string, token: string, explicit: boolean } | null}
 */
export const githubUpdateSourceFrom = (env, stored, configured) => {
  const environment = environmentOf(env);
  const row = stored && typeof stored === 'object' ? stored : {};
  const named = trimmed(configured);
  const explicit = Boolean(repoFrom(named));
  const repo = (explicit ? named : '')
    || trimmed(environment.RWP_RELEASE_REPO)
    || trimmed(environment.GITHUB_REPO)
    || trimmed(row.repository);
  const token = trimmed(environment.RWP_RELEASE_TOKEN) || trimmed(environment.GITHUB_TOKEN) || githubTokenFrom(row);
  return repoFrom(repo) ? { repo, token, explicit } : null;
};

/**
 * The resolved GitHub source, safe to show an administrator: which repository, and whether a credential
 * came with it. The token itself never leaves the server, exactly as with the central one.
 *
 * An end user is never told about GitHub at all: their answer is an empty, unconfigured source, because
 * the repository their site is built from is the platform's private template, not their business.
 *
 * @param {{ repo: string, token: string } | null} [source]
 * @param {boolean} [owner=true]
 */
export const describeGithubSource = (source, owner = true) => (owner
  ? {
    repo: trimmed(source?.repo),
    has_token: trimmed(source?.token).length > 0,
    configured: trimmed(source?.repo).length > 0,
  }
  : { repo: '', has_token: false, configured: false });

/**
 * The stored configuration, read the way this deployment can read `system_settings` — through the
 * engine's adapter, a direct connection, or the service key (`server/integrationSettings.mjs`).
 *
 * The GitHub row is read in the same trip because a check may need it: a site with no central token
 * reads its own release tags, and reading both rows separately would mean two round trips to answer one
 * question.
 *
 * A row that cannot be read is reported as exactly that rather than as an unconfigured site: on a
 * Supabase deployment whose server has neither `DATABASE_URL` nor `SUPABASE_SECRET_KEY` the token is
 * stored and simply invisible here, and telling the administrator to paste it again would be a lie.
 *
 * @param {import('./integrationSettings.mjs').IntegrationReadOptions} options
 */
export async function readUpdatesConfig(options) {
  const rows = await readIntegrationRows([UPDATE_CONFIG_KEY, GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY], options);
  const config = updateConfigFrom(rows.settings[UPDATE_CONFIG_KEY]);
  return {
    config,
    github: githubUpdateSourceFrom(undefined, rows.settings[GITHUB_CONFIG_KEY], config.repository),
    /** The release tag the SaaS installer recorded, as a plain version — or '' when it recorded none. */
    installed: saasInstalledVersionFrom(rows.settings[SAAS_INSTALLER_CONFIG_KEY]),
    readable: rows.readable,
    error: rows.readable ? '' : rows.error,
  };
}


/* -- `system_settings.version_state` ------------------------------------------------------------- */

/**
 * The row the browser keeps after an update: which build is installed, when it was installed, and the
 * last few updates with their outcome.
 *
 * The server never writes it. `system_settings` is writable only by a signed-in administrator (RLS says
 * so, and the engine's `/api/db/query` enforces the same rule), so the screen that runs an update writes
 * the result through its own session — which is also the only client that can read it back on every
 * deployment. This function turns that row into something a screen can render.
 *
 * @param {unknown} value
 * @param {{ installed: string }} current the version this build reports
 */
export const versionStateFrom = (value, current) => {
  const row = value && typeof value === 'object' ? value : {};
  const app = row.app && typeof row.app === 'object' ? row.app : {};
  const lastUpdate = row.last_update && typeof row.last_update === 'object' ? row.last_update : null;
  const history = Array.isArray(row.history) ? row.history.filter((entry) => entry && typeof entry === 'object') : [];
  const stored = trimmed(app.installed);
  return {
    /** What the database says is installed; `current.installed` is what is actually running. */
    app_installed: stored,
    app_installed_at: trimmed(app.installed_at),
    /** True when the stored row and the running build disagree — a deploy that has not happened yet. */
    pending: Boolean(stored) && stored !== trimmed(current.installed),
    last_checked_at: trimmed(row.last_checked_at),
    last_update: lastUpdate
      ? {
        at: trimmed(lastUpdate.at),
        from: trimmed(lastUpdate.from),
        to: trimmed(lastUpdate.to),
        mode: trimmed(lastUpdate.mode),
        status: trimmed(lastUpdate.status),
        error: trimmed(lastUpdate.error),
      }
      : null,
    history: history.slice(0, VERSION_STATE_HISTORY_LIMIT),
  };
};

/**
 * The next `version_state` value after an update, ready for the browser to `setSystemSetting`.
 *
 * `mode` says how it was applied (`deploy-hook`, `self`, `manual`) and `status` how it ended:
 * `started`, `triggered`, `completed` or `failed`. A failed update leaves the recorded installed version
 * alone — that is the whole point of recording it — so a half-applied release cannot be reported as
 * installed.
 *
 * @param {unknown} previous the stored row
 * @param {{ at: string, from: string, to: string, mode: string, status: string, error?: string }} entry
 */
export const versionStateAfter = (previous, entry) => {
  const row = previous && typeof previous === 'object' ? previous : {};
  const history = Array.isArray(row.history) ? row.history.filter((item) => item && typeof item === 'object') : [];
  const current = row.app && typeof row.app === 'object' ? row.app : {};
  const record = {
    at: entry.at,
    from: entry.from,
    to: entry.to,
    mode: entry.mode,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
  return {
    ...row,
    app: entry.status === 'failed'
      ? { ...current }
      : { installed: entry.to, installed_at: entry.at },
    last_checked_at: trimmed(row.last_checked_at) || entry.at,
    last_update: record,
    history: [record, ...history].slice(0, VERSION_STATE_HISTORY_LIMIT),
  };
};

/* -- Releases ------------------------------------------------------------------------------------ */

/**
 * One release from any of the shapes this feature reads: the central answer, a GitHub release parsed by
 * `server/githubReleases.mjs`, and a row written by hand. A `version` (or a tag that parses as one) is
 * the only requirement; everything else is optional.
 *
 * @param {unknown} value
 */
export const releaseFrom = (value) => {
  const row = value && typeof value === 'object' ? value : null;
  if (!row) return null;
  // The tag is the source of truth: `{tag: "v2.4.1"}` from GitHub and `{version: "2.4.1"}` from a
  // hand-written feed have to become the same release, so `version` is derived from the tag when the row
  // carries one and no version of its own.
  const tag = trimmed(row.tag) || trimmed(row.tag_name);
  const version = (trimmed(row.version) || tag).replace(/^v/i, '');
  if (!isVersion(version)) return null;
  const declared = row.notes ?? row.releaseNotes ?? row.release_notes ?? row.body;
  const notes = Array.isArray(declared)
    ? declared.map((note) => String(note)).filter(Boolean)
    : trimmed(declared) ? trimmed(declared).split('\n').map((line) => line.trim()).filter(Boolean) : [];
  const changelog = trimmed(row.changelog_url) || trimmed(row.release_url) || trimmed(row.html_url);
  const download = trimmed(row.download_url);
  return {
    version,
    /** The published tag, `v2.4.1`. Shown as is, and what a self-update checks out. */
    tag: tag || `v${version}`,
    released: trimmed(row.released) || trimmed(row.published_at) || trimmed(row.publishedAt),
    notes,
    changelog_url: /^https:\/\//i.test(changelog) ? changelog : '',
    /** Kept out of every browser answer: a paid release's URL is issued per site by the central server. */
    download_url: /^https:\/\//i.test(download) ? download : '',
    critical: row.critical === true || trimmed(row.severity).toLowerCase() === 'critical',
  };
};

/** A release as the browser may see it: no download URL, which only an installer needs. */
export const publicRelease = (release) => (release
  ? {
    version: release.version,
    tag: release.tag || `v${release.version}`,
    released: release.released,
    notes: release.notes,
    changelog_url: release.changelog_url,
    critical: release.critical,
  }
  : null);

/** The bearer header a central request carries. The token never appears in a response or a log line. */
const centralHeaders = (config, appVersion) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': `react-wp/${trimmed(appVersion) || 'unknown'}`,
  ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
});

/** Turns a `fetch` refusal into a sentence an administrator can act on. */
const networkMessage = (error, url) => {
  const name = error?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return `${url} did not answer in time.`;
  if (name === 'TypeError') return `${url} could not be reached. Check the address and this server's network access.`;
  return `${url} could not be reached: ${error?.message || 'unknown error'}.`;
};


/* -- Checking ------------------------------------------------------------------------------------ */

/**
 * The `plugins` map of either source: `{ "<id>": release }`. Entries without a version are dropped
 * rather than refused — one malformed plugin row must not hide the app's own update.
 *
 * @param {unknown} declared
 */
export const pluginReleasesFrom = (declared) => {
  const out = {};
  Object.entries(declared && typeof declared === 'object' ? declared : {}).forEach(([id, value]) => {
    const release = releaseFrom(value);
    if (release) out[id] = release;
  });
  return out;
};

/**
 * The installed-plugin list a request reported, cleaned up into what a check needs.
 *
 * `id` is a plugin slug and `version` a version; anything else is dropped rather than refused, because a
 * stale tab that names a plugin this release no longer has must not stop the app itself from being
 * checked. The list is used for one thing — telling the central server what to compare against, and
 * naming a plugin in the answer — so a wrong entry costs a missing plugin badge, never a wrong core
 * answer. Capped, because it arrives in a request body.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, name: string, version: string }>}
 */
export const installedPluginsFrom = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: trimmed(entry.id),
      name: trimmed(entry.name),
      version: trimmed(entry.version),
    }))
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,63}$/i.test(entry.id) && isVersion(entry.version))
    .slice(0, 200);
};

/**
 * Asks the central server for the latest releases.
 *
 * The body carries what the site runs, which is what lets `react-wp.com` answer for the plugins *this*
 * site has rather than for the whole catalogue. The token is required: without it central cannot tell a
 * licensed site from a stranger, and the caller reads its own GitHub release tags instead.
 *
 * The answer is read in either of the two shapes the platform may speak — the release list below, and the
 * four-field contract (`installedVersion`, `latestVersion`, `updateAvailable`, `releaseNotes`,
 * `releaseUrl`). Both are accepted so that upgrading the platform never strands a site that has not
 * upgraded yet, and the other way round.
 *
 * @param {{ config: any, current: { app: string, site?: string }, plugins: Array<{ id: string, version: string }>, fetchImpl?: typeof fetch }} options
 */
export async function fetchCentralCheck({ config, current, plugins, fetchImpl = fetch }) {
  if (!config.token) {
    throw new UpdateError('No update token is saved, so the central server cannot be asked. Settings → Updates takes one; this deployment\'s own GitHub release tags answer until then.', 400);
  }
  const base = trimmed(config.central_url) || DEFAULT_CENTRAL_URL;
  const request = {
    method: 'POST',
    headers: centralHeaders(config, current.app),
    body: JSON.stringify({
      format: 'rwp-update-center',
      version: 1,
      channel: config.channel,
      site: trimmed(current.site),
      app: { id: 'react-wp', version: current.app },
      /** The same fact in the contract's spelling, for a platform that reads only that. */
      installedVersion: current.app,
      plugins: plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
    }),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  };
  let missing = '';
  for (const path of CENTRAL_CHECK_PATHS) {
    const url = `${base}${path}`;
    let response;
    try {
      response = await fetchImpl(url, request);
    } catch (error) {
      throw new UpdateError(networkMessage(error, url), 502);
    }
    if (response.status === 404) {
      // Not this path. A platform that publishes only one of the two answers 404 for the other, so this
      // is the next path's cue rather than a refusal to report.
      missing = url;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new UpdateError('The central server refused this site\'s update token. Check it on Settings → Updates: a token is issued per site and can be revoked.', 401);
    }
    if (!response.ok) throw new UpdateError(`The central server answered HTTP ${response.status} at ${url}.`, 502);
    const body = await response.json().catch(() => {
      throw new UpdateError(`${url} did not return valid JSON.`, 502);
    });
    return centralReleasesFrom(body);
  }
  throw new UpdateError(`The central server has no update API at ${missing}. A platform deployment answers ${CENTRAL_CHECK_PATHS.join(' or ')}.`, 404);
}

/**
 * The endpoint a managed (end-user) site downloads its release package from. The package itself is
 * applied by `scripts/selfUpdateRun.mjs` in a detached run — nothing here downloads a ZIP in a request,
 * because the request that starts the download is the request the build would replace.
 */
export const centralApplyUrl = (config) =>
  `${trimmed(config.central_url) || DEFAULT_CENTRAL_URL}${CENTRAL_APPLY_PATH}`;

/**
 * The releases inside a central answer, in either shape the platform may answer with.
 *
 * Reading both costs one `||`: a site whose platform has been upgraded, and a site that has not, both keep
 * working. A body with no release at all is refused with the sentence an administrator can act on rather
 * than a half-filled screen.
 *
 * @param {any} body
 */
export const centralReleasesFrom = (body) => {
  const app = releaseFrom(body?.app) || releaseFrom({
    version: body?.latestVersion ?? body?.latest_version,
    tag: body?.latestVersion ?? body?.latest_version ?? body?.release?.tag,
    notes: body?.releaseNotes ?? body?.release_notes ?? body?.release?.notes,
    released: body?.release?.released ?? body?.publishedAt ?? body?.published_at,
    changelog_url: body?.releaseUrl ?? body?.release_url ?? body?.html_url,
    critical: body?.release?.critical,
  });
  if (!app) {
    throw new UpdateError('The central server\'s answer has no release with a version. Expected {"format":"rwp-update-center","version":1,"app":{"version":"1.2.3"}}, or {"latestVersion":"v1.2.3","releaseNotes":"…","releaseUrl":"…"}.', 502);
  }
  return { app, plugins: pluginReleasesFrom(body?.plugins) };
};



/**
 * Reads the release tags of the repository this site is updated from — the repository Settings → Updates
 * names, or the one the GitHub integration holds (`githubUpdateSourceFrom`).
 *
 * The tag GitHub lists *is* the release: there is no file to forget to publish, no cache to go stale and
 * no second copy of a version number to disagree with the first. The whole conversation is
 * `server/githubReleases.mjs` — that file reads `/releases` and falls back to `/tags`, and this function
 * only picks the newest tag the configured channel may be offered and hands it to `checkAnswerFrom` in
 * the same shape a central answer has.
 *
 * A repository with no release tag yet is a *sentence*, not a 404: `null` back from
 * `latestReleaseFrom` means "tag a release" and the administrator is told exactly that.
 *
 * @param {{ source: { repo: string, token: string }, channel?: string, fetchImpl?: typeof fetch }} options
 */
export async function fetchGithubCheck({ source, channel = 'stable', fetchImpl = fetch }) {
  const fetched = await fetchGithubReleases({ repo: source.repo, token: source.token, fetchImpl });
  const release = latestReleaseFrom(fetched.releases, { channel });
  if (!release) {
    throw new UpdateError(`${fetched.repo} has no published ${channel === 'beta' ? 'pre-release' : 'release'} tag yet. Tag a release on GitHub (for example v1.0.0) and the next check finds it.`, 404);
  }
  return { app: release, plugins: {} };
}

/**
 * The whole answer a check produces, built once so both hosts, both sources and the central server agree
 * on its shape.
 *
 * `source` names where the answer came from (`central` or `github`), `error` carries the first failure
 * when a source was tried and refused, and `updates` is what the screen lists — one entry per plugin
 * that has a newer release, plus the app itself.
 *
 * The last block is the contract the central server promises a customer's site, and the shape this route
 * answers with as well, so any client that speaks only that contract can read either:
 *
 *   { "installedVersion": "v1.3.1", "latestVersion": "v2.4.1", "updateAvailable": true,
 *     "releaseNotes": "- …", "releaseUrl": "https://github.com/…/releases/tag/v2.4.1" }
 *
 * `updateAvailable` is about the core only, and the older `update_available` still means "anything here
 * has an update, plugins included". Two names because the two questions are different, and a screen that
 * conflated them would offer an Update Now button for a plugin.
 *
 * @param {{ source: 'central'|'github', app: any, plugins: Record<string, any>, current: { app: string, site?: string }, plugins_installed: Array<{ id: string, name?: string, version: string }>, error?: string, coreOnly?: boolean }} input
 */
export const checkAnswerFrom = ({ source, app, plugins, current, plugins_installed, error = '', coreOnly = false }) => {
  const installed = trimmed(current.app);
  const appUpdateAvailable = compareVersions(app.version, installed) > 0;
  const latestTag = app.tag || `v${app.version}`;
  const updates = [];
  if (appUpdateAvailable) {
    updates.push({ id: 'react-wp', name: 'React-WP', kind: 'app', installed, latest: app.version, release: publicRelease(app) });
  }
  // Core-only is the rule this feature enforces: a plugin release is *reported*, never part of the core
  // update. `coreOnly` removes even the report, so an end user's screen shows one update and one button.
  if (!coreOnly) {
    const named = new Map(plugins_installed.map((plugin) => [plugin.id, plugin]));
    Object.entries(plugins).forEach(([id, release]) => {
      const installedPlugin = named.get(id);
      if (!installedPlugin) return;
      if (compareVersions(release.version, installedPlugin.version) <= 0) return;
      updates.push({
        id,
        name: installedPlugin.name || id,
        kind: 'plugin',
        installed: installedPlugin.version,
        latest: release.version,
        release: publicRelease(release),
      });
    });
  }
  return {
    format: 'rwp-update-center',
    version: 1,
    source,
    checked_at: new Date().toISOString(),
    app: {
      installed,
      latest: app.version,
      latest_tag: latestTag,
      update_available: appUpdateAvailable,
      release: publicRelease(app),
    },
    plugins: coreOnly ? {} : Object.fromEntries(Object.entries(plugins).map(([id, release]) => [id, publicRelease(release)])),
    updates,
    update_available: updates.length > 0,
    /** The central contract, four names a customer's site can rely on without reading anything else. */
    installedVersion: installed ? `v${installed.replace(/^v/i, '')}` : '',
    latestVersion: latestTag,
    updateAvailable: appUpdateAvailable,
    releaseNotes: (app.notes || []).join('\n'),
    releaseUrl: app.changelog_url || '',
    error,
  };
};

/**
 * The check both hosts run: the repository Settings → Updates names, else the central server when this
 * site has a token for it, else the release tags of whichever repository the GitHub integration holds —
 * and a sentence naming what to configure when none of those applies.
 *
 * The order is deliberate, and it is what stops a check answering from the wrong repository:
 *
 *   - A repository named on Settings → Updates is the administrator saying "these are the tags this site
 *     is released on", so it is asked first. A plugin or platform edition whose own repository publishes
 *     these releases must never be answered by the central server's list of the core releases instead.
 *   - A licensed site that names no repository asks the platform, which also answers for the plugins it
 *     sells; its own tags answer when that fails.
 *   - A site with no token has nothing to ask but GitHub.
 *
 * Every attempt that failed is kept as a sentence on the answer (`error`), so an administrator can see
 * why the source they configured was not the one that replied. Both paths end in `checkAnswerFrom`, so
 * the screen cannot tell them apart except by the `source` it is told.
 *
 * Nothing here reads `package.json`: this site's version is whatever the caller reports as installed,
 * which comes from the build's own tag, and the newest version is a release tag. A file that is edited
 * while a release is being prepared can therefore never be mistaken for the release.
 *
 * @param {{ config: any, current: { app: string, site?: string }, plugins: Array<{ id: string, name?: string, version: string }>, github?: { repo: string, token: string, explicit?: boolean } | null, fetchImpl?: typeof fetch, owner?: boolean }} options
 */
export async function checkForUpdates({ config, current, plugins, github = null, fetchImpl = fetch, owner = true }) {
  // An end user's site is managed by the platform: it never reads GitHub directly. The owner's named
  // repository is *their* release channel, but a provisioned instance has exactly one — react-wp.com.
  const source = owner ? (github || githubUpdateSourceFrom(undefined)) : null;
  if (!source && !config.token) {
    if (!owner) {
      throw new UpdateError('Updates for this site are provided by react-wp.com. If the update token cannot be read, ask the site owner to restore the platform connection.', 400);
    }
    throw new UpdateError('No update source is configured for this site. Name the repository the releases are tagged on under Settings → Updates (or Settings → Integrations → GitHub) — a public repository needs no token — or save an update token here to ask the central server.', 400);
  }
  /** GitHub first when the administrator named the repository, and always when there is no token to ask. */
  const order = owner
    ? (source && (source.explicit || !config.token)
      ? ['github', ...(config.token ? ['central'] : [])]
      : [...(config.token ? ['central'] : []), ...(source ? ['github'] : [])])
    : ['central'];
  /** `{ message, status }` per source that refused, in the order they were tried. */
  const failures = [];
  for (const attempt of order) {
    try {
      const releases = attempt === 'github'
        ? await fetchGithubCheck({ source, channel: config.channel, fetchImpl })
        : await fetchCentralCheck({ config, current, plugins, fetchImpl });
      return checkAnswerFrom({
        source: attempt,
        ...releases,
        current,
        plugins_installed: plugins,
        error: failures.map((failure) => failure.message).join(' '),
        // End users see the core only. Plugin releases follow their own lifecycle, never this button.
        coreOnly: !owner,
      });
    } catch (error) {
      failures.push({
        message: error instanceof Error ? error.message : `The ${attempt === 'github' ? 'GitHub release tags' : 'central server'} could not be read.`,
        status: Number(error?.status) || 0,
      });
    }
  }
  // Nothing answered. The last sentence is the most specific, so it is the one the status is taken from.
  const message = failures.map((failure) => failure.message).filter(Boolean).join(' ');
  throw new UpdateError(message || 'No update source answered.', failures[failures.length - 1]?.status || 502);
}

/* -- Applying an update -------------------------------------------------------------------------- */

/**
 * Calls a deploy hook — Vercel's, Netlify's, or any host's "build this branch now" URL.
 *
 * The hook is a pre-shared secret, so it is validated (https only) and never echoed back: the answer
 * says whether it was called and what status it returned, nothing more. `AbortSignal.timeout` because a
 * hook that hangs must not hold an admin request open for a minute.
 *
 * @param {string} hook the saved `deploy_config` URL, or `VERCEL_DEPLOY_HOOK_URL` from the environment
 * @param {{ fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [options]
 */
export async function triggerDeployHookUrl(hook, { fetchImpl = fetch, env } = {}) {
  const environment = environmentOf(env);
  const target = trimmed(hook) || trimmed(environment.VERCEL_DEPLOY_HOOK_URL);
  if (!target) {
    return {
      configured: false,
      triggered: false,
      error: 'No deploy hook is saved. Settings → Integrations → Deployments takes the address your host builds from (Vercel → Project → Settings → Git → Deploy Hooks), or set VERCEL_DEPLOY_HOOK_URL.',
    };
  }
  let url;
  try {
    url = new URL(target);
  } catch {
    return { configured: true, triggered: false, error: 'The deploy hook is not a valid URL. Paste the complete address the platform gave you.' };
  }
  if (url.protocol !== 'https:') return { configured: true, triggered: false, error: 'The deploy hook must be an https:// URL.' };
  try {
    const response = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    return response.ok
      ? { configured: true, triggered: true, status: response.status }
      : { configured: true, triggered: false, status: response.status, error: `The deploy hook answered HTTP ${response.status}.` };
  } catch (error) {
    return { configured: true, triggered: false, error: networkMessage(error, url.origin) };
  }
}

/**
 * How this site would apply an update, and the stages the screen shows while it does.
 *
 * `deploy-hook` is the usual answer for a serverless deployment: the hook starts the build that pulls
 * the new version in, so there is nothing for this request to install. `self` is a host that runs
 * `node server.mjs` from a writable checkout — `server/selfUpdate.mjs` fetches, installs, builds and
 * restarts. `manual` is everything else, and its `reason` says what to configure so that the next
 * attempt can finish by itself; there are no by-hand steps to print, because the deploy hook or the
 * self-updater *is* the way this feature applies a release.
 *
 * @param {{ config: any, deployHook: string, selfUpdate: boolean, latestVersion: string, installedVersion: string }} input
 */
export const updatePlan = ({ config, deployHook, selfUpdate, latestVersion, installedVersion }) => {
  if (!isVersion(latestVersion)) {
    return { mode: 'manual', reason: 'No release is known yet. Run a check for updates first, then try again.', steps: [] };
  }
  if (compareVersions(latestVersion, installedVersion) <= 0) {
    return {
      mode: 'manual',
      up_to_date: true,
      reason: `This site already runs ${installedVersion}, which is the latest release it can see.`,
      steps: [],
    };
  }
  if (trimmed(deployHook)) {
    return {
      mode: 'deploy-hook',
      reason: `This host is built from a Git repository, so the update is applied by starting its build: the deploy hook is called, and the platform checks out and builds ${latestVersion}.`,
      steps: ['triggering-rebuild'],
    };
  }
  if (selfUpdate && config.self_update) {
    return {
      mode: 'self',
      reason: `This server owns its checkout, so it updates itself: fetch ${latestVersion}, install packages, build, restart.`,
      steps: ['fetching', 'installing-packages', 'building', 'restarting'],
    };
  }
  return {
    mode: 'manual',
    reason: selfUpdate
      ? 'Automatic updates are switched off for this site. Turn them on in Settings → Updates, and this server applies the release itself.'
      : 'This deployment cannot update itself yet. Save the deploy hook its host builds from under Settings → Integrations → Deployments (Vercel → Project → Settings → Git → Deploy Hooks), and Update now starts that build.',
    steps: [],
  };
};

/**
 * Runs the one thing a deployed site can do itself: call the hook that starts its build.
 *
 * The caller has already chosen the mode (`updatePlan`), and this only reports what happened — a failed
 * hook call is an answer, not an exception, because the administrator needs the sentence either way.
 *
 * @param {{ deployHook: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch }} options
 */
export async function applyDeployHookUpdate({ deployHook, env, fetchImpl }) {
  const deploy = await triggerDeployHookUrl(deployHook, { env, fetchImpl });
  return {
    mode: 'deploy-hook',
    queued: deploy.triggered,
    deploy,
    message: deploy.triggered
      ? 'The deploy hook was called. The platform is checking out and building the new version now; this site switches over when that build is promoted.'
      : `The update could not be started: ${deploy.error}`,
  };
}

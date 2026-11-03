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
 *      Which one is chosen, and why, is `updatePlan`. A managed site whose files are read-only — a prebuilt
 *      Vercel deployment — has neither, and asks the platform to rebuild it instead
 *      (`POST {central}/api/v1/updates/install`, `platformUpdatePlan` / `requestPlatformInstall`).
 *
 * A **managed site** — a customer's instance, whose signed-in account is not the update owner — is not
 * allowed to reach any of the owner paths. Its check is asked of `react-wp.com` and of nothing else: no
 * GitHub read, no deploy hook, no git checkout, and no sentence about a token or a repository, because
 * none of those are things a customer can act on. `checkForUpdates` forces the single source,
 * `managedUpdateSupport` reports the only way such a site installs a release (the package the platform
 * built, or the redeploy the platform runs for a host that cannot install one), and every refusal it can
 * meet is written in `MANAGED_MESSAGES` for the person who reads it rather than for the administrator who
 * runs the platform.
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
import { centralFetch } from './centralFetch.mjs';
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
/**
 * The redeploy route, in step with `CENTRAL_INSTALL_PATH` in `server/centralUpdates.mjs`: ask the platform to
 * build the release and upload it to *this* site's Vercel project.
 *
 * It is the one managed path that works on a host which cannot install anything — a prebuilt Vercel
 * deployment, whose files are read-only and whose repository never contains `dist/`. The site names itself,
 * because a site knows its own address and the platform is the party that recorded which project is behind
 * it; no Vercel token and no deploy hook is involved on this side.
 */
export const CENTRAL_INSTALL_PATH = '/api/v1/updates/install';
/** How long one redeploy request waits before it gives up. A build plus an upload, not a link check. */
export const CENTRAL_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
export const PLUGIN_DIRECTORY_PATH = '/api/v1/plugins';

/** The release channels a site may follow. `beta` receives pre-releases, `stable` does not. */
export const UPDATE_CHANNELS = ['stable', 'beta'];

/** The keys `auto_check` accepts, in step with `autoCheckIntervals` in `src/lib/updates.ts`. */
export const AUTO_CHECK_KEYS = ['off', 'admin', 'daily', 'weekly', 'monthly'];

/**
 * Everything a *managed* site is told when the one source it has does not answer.
 *
 * A customer's site has exactly one update channel — `react-wp.com` — so a failure there is not a
 * configuration problem it can fix: there is no token to re-enter, no repository to name and no deploy
 * hook to save. The owner-facing sentences this module already had ("paste a token on Settings →
 * Updates", "leave empty to use react-wp.com", "a public repository needs no token") are therefore wrong
 * on that screen, and would send someone looking for a switch that is not there. So the managed wording
 * lives here, in one place, and every managed refusal in this file uses it: `fetchCentralCheck` when the
 * platform refuses or is unreachable, and `managedUpdateSupport` when this host cannot install the package
 * the platform publishes.
 */
export const MANAGED_MESSAGES = {
  /** The platform would not answer without a token, and this site has none (or the row cannot be read). */
  not_connected: 'React-WP.com could not confirm this site’s platform connection, so the release list is not available just now. Contact React-WP support and they will restore it — nothing on this screen needs changing.',
  /** The platform answered 401/403: the token it was given is not one it accepts. */
  refused: 'React-WP.com did not accept this site’s platform connection. Contact React-WP support and they will restore it — nothing on this screen needs changing.',
  /** Nothing answered at all: DNS, TLS, timeout, a firewall. */
  unreachable: 'React-WP.com could not be reached from this server just now, so the release list is not available. Check again in a minute; if it keeps happening, contact React-WP support.',
  /** The platform answered, but not with a release list. */
  unavailable: (status) => `React-WP.com answered HTTP ${status} instead of this site’s release list. Check again in a minute; if it keeps happening, contact React-WP support.`,
  /** The address this site asks has no update API behind it. */
  no_api: 'React-WP.com has no update API at the address this site uses, so no release list could be read. Contact React-WP support and they will point it at the right one.',
  /** The platform answered, but with nothing that names a release. */
  no_release: 'React-WP.com answered without naming a release, so there is nothing to compare this site against just now. Contact React-WP support and they will check what it publishes for this site.',
  /**
   * A host that cannot install a package and has no platform to redeploy it: nothing on this screen can be
   * changed, so it is never an instruction. The screen hides a button it cannot honour, and this sentence is
   * what the space under it says instead.
   */
  cannot_apply: 'React-WP.com publishes this site’s releases and installs them for you, so there is nothing to change here. If a release has not arrived within a day of being published, contact React-WP support.',
  /**
   * The same host, but this site *is* connected to a platform that can redeploy it (`mode: 'platform'`). This
   * is the reason line the button sits under, so it says what the button does and what it does not touch.
   */
  platform_applies: 'React-WP.com builds this site’s releases and uploads them to its project, so Update now asks React-WP.com to rebuild it. Your plugins, uploads and database are not touched.',
  /** The platform has no redeploy API at the address this site uses: a version skew, not a configuration. */
  no_install_api: 'React-WP.com has no update API at the address this site uses, so it could not be asked to rebuild this site. Contact React-WP support and they will point it at the right one.',
  /** The platform answered, and its answer was a refusal. The status is all a customer may be told. */
  install_failed: (status) => `React-WP.com could not rebuild this site just now (HTTP ${status}). Nothing has changed on it — try again in a few minutes, and contact React-WP support if it keeps failing.`,
  /** The request itself never completed: a timeout, a reset, a platform that restarted mid-build. */
  install_unreachable: 'React-WP.com could not be reached from this server while it was rebuilding this site, so it is not known whether the update finished. The site keeps running its current release either way — check again in a few minutes, and contact React-WP support if it stays on the old version.',
};

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
 *   3. `release` — the newest release tag of the repository *this* deployment publishes, which is the only
 *      answer left for a platform that deploys itself from a branch (`latestPublishedVersion`);
 *   4. the `package.json` the build was compiled from.
 *
 * Step 3 exists because a template's manifest is not its release: a platform built from `main` carries
 * whatever number `package.json` happened to hold when the branch was last edited, and its own Updates
 * card then names a version the repository never tagged. It is a *guess* about which release is running,
 * so it sits below both records that actually name one — once the installer has deployed this site, or the
 * deploy pins the tag, that exact answer wins again and a real update is visible again.
 *
 * Each answer is normalised to a plain version (no `v`), the shape every comparison in this file expects.
 */
export const resolveInstalledVersion = ({ pinned = '', saas = '', release = '', fallback = '' }) =>
  trimmed(pinned).replace(/^v/i, '')
  || trimmed(saas).replace(/^v/i, '')
  || trimmed(release).replace(/^v/i, '')
  || trimmed(fallback).replace(/^v/i, '');

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
 *   - `fallbackRepo` — the repository the SaaS installer copies (`saas_installer_config.template_repo`),
 *     which on a platform is the release repository itself. It is last because it is the one value that is
 *     always present on a platform and never a choice: the installer card names the template *every* site
 *     is built from, and its releases are what that card already lists as "Latest".
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
 * @param {unknown} [fallbackRepo] the installer card's template repository, used when nothing else names one
 * @returns {{ repo: string, token: string, explicit: boolean } | null}
 */
export const githubUpdateSourceFrom = (env, stored, configured, fallbackRepo = '') => {
  const environment = environmentOf(env);
  const row = stored && typeof stored === 'object' ? stored : {};
  const named = trimmed(configured);
  const explicit = Boolean(repoFrom(named));
  const installerTemplate = trimmed(fallbackRepo);
  const repo = (explicit ? named : '')
    || trimmed(environment.RWP_RELEASE_REPO)
    || trimmed(environment.GITHUB_REPO)
    || trimmed(row.repository)
    || (repoFrom(installerTemplate) ? installerTemplate : '');
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
 * `RWP_UPDATE_TOKEN` answers when the row holds no token, or when this server cannot read the row at all.
 * That is the escape hatch that keeps a *managed* site updating through `react-wp.com` on a host whose
 * database it can only reach through a key it was not given: the platform owns the environment of the
 * site it provisioned, so it can put the token there, and the site still asks the one place it is
 * supposed to ask. It never turns a configured site into a different one — an environment token only
 * fills a hole.
 *
 * `RWP_CENTRAL_URL` is the same hole for the address, and it is what lets a platform point the sites it
 * provisions at its own domain without editing a row in each of their databases.
 *
 * @param {import('./integrationSettings.mjs').IntegrationReadOptions} options
 */
export async function readUpdatesConfig(options) {
  const rows = await readIntegrationRows([UPDATE_CONFIG_KEY, GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY], options);
  const environment = environmentOf(options?.env);
  const stored = updateConfigFrom(rows.settings[UPDATE_CONFIG_KEY]);
  const row = rows.settings[UPDATE_CONFIG_KEY] && typeof rows.settings[UPDATE_CONFIG_KEY] === 'object' ? rows.settings[UPDATE_CONFIG_KEY] : {};
  const environmentToken = trimmed(environment.RWP_UPDATE_TOKEN);
  const environmentCentral = trimmed(environment.RWP_CENTRAL_URL).replace(/\/+$/, '');
  const config = {
    ...stored,
    // Both environment values fill a hole only: a token or an address saved on Settings → Updates wins.
    ...(stored.token || !environmentToken ? {} : { token: environmentToken }),
    ...(trimmed(row.central_url) || !/^https?:\/\//i.test(environmentCentral) ? {} : { central_url: environmentCentral }),
  };
  const installer = saasInstallerConfigFrom(rows.settings[SAAS_INSTALLER_CONFIG_KEY]);
  // The installer card names the template every site is built from, and on a platform that *is* the release
  // repository. Reading it here is what makes the owner's own screen agree with Settings → Integrations →
  // SaaS Installer, which has been listing those tags all along: without it a platform with an update token
  // stored and no repository named asked *itself* for a version, and reported its `package.json` as the
  // answer.
  const github = githubUpdateSourceFrom(undefined, rows.settings[GITHUB_CONFIG_KEY], config.repository, installer.template_repo);
  return {
    // `repository` is filled from the resolved source so the screen shows the repository a check will read
    // and `checkForUpdates` prefers it over the central server. A site that names one keeps its own answer.
    config: { ...config, ...(config.repository || !github ? {} : { repository: github.repo }) },
    github,
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
 * `title` is what the release is called — `name` on GitHub is read by `releaseFromGithub` before a row gets
 * here, so this only has to recognise the two field names an answer of this feature's own uses. It is *not*
 * read from `name`: in a `plugins` map that field can be the plugin's display name, and a plugin card must
 * not print its own name as a release title.
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
    title: trimmed(row.title) || trimmed(row.release_title),
    released: trimmed(row.released) || trimmed(row.published_at) || trimmed(row.publishedAt),
    notes,
    changelog_url: /^https:\/\//i.test(changelog) ? changelog : '',
    /** Kept out of every browser answer: a paid release's URL is issued per site by the central server. */
    download_url: /^https:\/\//i.test(download) ? download : '',
    critical: row.critical === true || trimmed(row.severity).toLowerCase() === 'critical',
  };
};

/**
 * A release as the browser may see it: no download URL, which only an installer needs.
 *
 * `title` travels with it because it is what the release is *called* — the Updates screen and
 * `[rwp_latest_release]` both print it above the tag, and a card that only ever showed `v2.6.3` was
 * showing half of what the release on GitHub says.
 */
export const publicRelease = (release) => (release
  ? {
    version: release.version,
    tag: release.tag || `v${release.version}`,
    title: release.title || '',
    released: release.released,
    notes: release.notes,
    changelog_url: release.changelog_url,
    critical: release.critical,
  }
  : null);

/**
 * The bearer header a central request carries. The token never appears in a response or a log line.
 *
 * A request built here is *sent* through `centralFetch` rather than `fetch`, never directly: the
 * platform redirects its apex domain to `www`, and a redirect `fetch` follows itself drops this very
 * header (`server/centralFetch.mjs`). That is why an update failed with `HTTP 401` while the check on
 * the same screen worked — a release list is public, a rebuild is not.
 */
const centralHeaders = (config, appVersion) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': `react-wp/${trimmed(appVersion) || 'unknown'}`,
  ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
});

/** One request header, from a `Headers` (Hono, fetch) or a plain Node record. */
const headerOf = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') return trimmed(headers.get(name));
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name);
  return key ? trimmed(headers[key]) : '';
};

/**
 * This site's own public address — the name `react-wp.com` knows it by.
 *
 * A managed site's one credential is the token it was issued, and the platform finds the Vercel project
 * behind a site by matching `saas_installer_installations.site_url`. Something therefore has to state the
 * address, and the site itself is the party that has it: the browser is asked for `window.location.origin`
 * (`src/lib/updateCenter.ts`), and this is the server-side fallback for a request that did not carry one —
 * `X-Forwarded-Host` (what Vercel and Netlify put in front of `Host`), else `Host`, with the protocol from
 * `X-Forwarded-Proto`. An address taken from the request being answered cannot be another site's.
 *
 * `site` wins when it is present, so a caller that knows better than the headers (a script, a test, an
 * operator curling one deployment on behalf of another) is not overruled. The result is exactly the shape
 * the platform's `installationUrl` normalises to: `https://host`, no path, lower case.
 *
 * @param {unknown} headers the request's headers
 * @param {{ site?: string, fallback?: string }} [input]
 */
export const siteAddressFrom = (headers, { site = '', fallback = '' } = {}) => {
  const named = trimmed(site);
  if (named) return named;
  const host = headerOf(headers, 'x-forwarded-host').split(',')[0] || headerOf(headers, 'host').split(',')[0];
  if (!host) return trimmed(fallback);
  const proto = headerOf(headers, 'x-forwarded-proto').split(',')[0].toLowerCase();
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
};

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
 * site has rather than for the whole catalogue.
 *
 * The token is *sent* whenever this site has one, and its absence is no longer a reason to refuse before
 * asking: the release list is public on a platform that publishes it, so a site provisioned before this
 * feature existed — or one whose token was never written into its environment — still learns the newest
 * version instead of being told its platform connection is broken. A platform that wants a token for a
 * check answers 401, which is handled below.
 *
 * `managed` changes only what a failure *says*. A customer cannot save a token, name a repository or
 * publish a release, so every refusal is one of `MANAGED_MESSAGES`; the owner keeps the sentences that
 * name the screen where the missing half is configured. The request itself is identical either way —
 * this is not a second code path, just the same one told to a different reader.
 *
 * The answer is read in either of the two shapes the platform may speak — the release list below, and the
 * four-field contract (`installedVersion`, `latestVersion`, `updateAvailable`, `releaseNotes`,
 * `releaseUrl`). Both are accepted so that upgrading the platform never strands a site that has not
 * upgraded yet, and the other way round.
 *
 * @param {{ config: any, current: { app: string, site?: string }, plugins: Array<{ id: string, version: string }>, fetchImpl?: typeof fetch, managed?: boolean }} options
 */
export async function fetchCentralCheck({ config, current, plugins, fetchImpl = fetch, managed = false }) {
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
      // Through `centralFetch`: the platform's apex domain redirects to `www`, and the token has to survive
      // that hop or a revoked credential would go unreported (`server/centralFetch.mjs`).
      response = await centralFetch(url, request, { fetchImpl });
    } catch (error) {
      throw new UpdateError(managed ? MANAGED_MESSAGES.unreachable : networkMessage(error, url), 502);
    }
    if (response.status === 404) {
      // Not this path. A platform that publishes only one of the two answers 404 for the other, so this
      // is the next path's cue rather than a refusal to report.
      missing = url;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      // A managed site's token is the platform's own connection, issued and revoked by it: asking a
      // customer to re-enter it is asking them for a value they were never given. A site that sent *no*
      // token is told the connection could not be confirmed, which is exactly what happened — the platform
      // would not answer a check without one.
      throw new UpdateError(managed
        ? (config.token ? MANAGED_MESSAGES.refused : MANAGED_MESSAGES.not_connected)
        : 'The central server refused this site\'s update token. Check it on Settings → Updates: a token is issued per site and can be revoked.', 401);
    }
    if (!response.ok) {
      throw new UpdateError(managed
        ? MANAGED_MESSAGES.unavailable(response.status)
        : `The central server answered HTTP ${response.status} at ${url}.`, 502);
    }
    const body = await response.json().catch(() => {
      throw new UpdateError(managed ? MANAGED_MESSAGES.unavailable(response.status) : `${url} did not return valid JSON.`, 502);
    });
    return centralReleasesFrom(body, managed);
  }
  throw new UpdateError(managed
    ? MANAGED_MESSAGES.no_api
    : `The central server has no update API at ${missing}. A platform deployment answers ${CENTRAL_CHECK_PATHS.join(' or ')}.`, 404);
}

/**
 * The endpoint a managed (end-user) site downloads its release package from. The package itself is
 * applied by `scripts/selfUpdateRun.mjs` in a detached run — nothing here downloads a ZIP in a request,
 * because the request that starts the download is the request the build would replace.
 */
export const centralApplyUrl = (config) =>
  `${trimmed(config.central_url) || DEFAULT_CENTRAL_URL}${CENTRAL_APPLY_PATH}`;

/**
 * The endpoint a site that cannot install anything asks to be rebuilt.
 *
 * Same address as `centralApplyUrl` — one `central_url`, one platform — and the same token, so a site that
 * can already check for updates can already install them.
 */
export const centralInstallUrl = (config) =>
  `${trimmed(config.central_url) || DEFAULT_CENTRAL_URL}${CENTRAL_INSTALL_PATH}`;

/**
 * The releases inside a central answer, in either shape the platform may answer with.
 *
 * Reading both costs one `||`: a site whose platform has been upgraded, and a site that has not, both keep
 * working. A body with no release at all is refused with the sentence an administrator can act on rather
 * than a half-filled screen — or, for a managed site, one sentence that does not quote the JSON contract
 * back at a customer.
 *
 * @param {any} body
 * @param {boolean} [managed=false]
 */
export const centralReleasesFrom = (body, managed = false) => {
  const app = releaseFrom(body?.app) || releaseFrom({
    version: body?.latestVersion ?? body?.latest_version,
    tag: body?.latestVersion ?? body?.latest_version ?? body?.release?.tag,
    title: body?.release?.title,
    notes: body?.releaseNotes ?? body?.release_notes ?? body?.release?.notes,
    released: body?.release?.released ?? body?.publishedAt ?? body?.published_at,
    changelog_url: body?.releaseUrl ?? body?.release_url ?? body?.html_url,
    critical: body?.release?.critical,
  });
  if (!app) {
    throw new UpdateError(managed
      ? MANAGED_MESSAGES.no_release
      : 'The central server\'s answer has no release with a version. Expected {"format":"rwp-update-center","version":1,"app":{"version":"1.2.3"}}, or {"latestVersion":"v1.2.3","releaseNotes":"…","releaseUrl":"…"}.', 502);
  }
  return { app, plugins: pluginReleasesFrom(body?.plugins) };
};



/** How long "the newest release of this repository" is reused when it answers which version is installed. */
const PUBLISHED_VERSION_CACHE_MS = 60_000;

/** The last answer `latestPublishedVersion` gave, keyed by repository and channel. */
let publishedVersion = { at: 0, key: '', value: '' };

/** Drops the remembered release. Exported for the self-check, and for a screen that just changed the repository. */
export const clearPublishedVersion = () => {
  publishedVersion = { at: 0, key: '', value: '' };
};

/**
 * The newest release tag of the repository this deployment publishes, as a plain version — or `''` when
 * there is no repository to read, or the read did not answer.
 *
 * This is the `release` input of `resolveInstalledVersion`, and it exists for one deployment: a platform
 * that deploys *itself* from a branch. It has no `RWP_APP_VERSION` pin and no installer record, so the only
 * statement about which release it runs is the release it publishes — which is what Settings → Integrations
 * → SaaS Installer already shows as "Latest". Reading it here makes the two screens name one version.
 *
 * Never throws, and caches for a minute: this is one input to a version string, not a check of its own, so
 * a rate limit or a private repository with no credential must leave the caller on its previous answer
 * (`package.json`) rather than on an error screen.
 *
 * @param {{ source?: { repo?: string, token?: string } | null, channel?: string, fetchImpl?: typeof fetch, now?: number }} [input]
 * @returns {Promise<string>} `2.5.4`, or `''`
 */
export async function latestPublishedVersion({ source, channel = 'stable', fetchImpl = fetch, now = Date.now() } = {}) {
  const repo = trimmed(source?.repo);
  if (!repo) return '';
  const token = trimmed(source?.token);
  const key = `${repo}|${channel}|${token ? 'token' : 'anonymous'}`;
  if (publishedVersion.key === key && now - publishedVersion.at < PUBLISHED_VERSION_CACHE_MS) {
    return publishedVersion.value;
  }
  let version = '';
  try {
    const fetched = await fetchGithubReleases({ repo, token, fetchImpl });
    version = trimmed(latestReleaseFrom(fetched.releases, { channel })?.version).replace(/^v/i, '');
  } catch {
    version = '';
  }
  publishedVersion = { at: now, key, value: version };
  return version;
}

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
 * A **managed site** (`owner: false`) has none of that order: it asks `react-wp.com` and nothing else.
 * `github` is not merely tried last there, it is never read at all — a customer's site is built from the
 * platform's template, so its release tags are not a release channel and a check must not be answered from
 * them even when a repository would have answered. There is no second source to fall back to, so a failure
 * is the `MANAGED_MESSAGES` sentence for it rather than a list of things to configure.
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
  // A managed site asks the platform with or without a token: a check is public, so a site that was never
  // handed one still reads the newest release. Only the owner, who can choose a source and has none, is
  // asked to configure one.
  if (owner && !source && !config.token) {
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
        : await fetchCentralCheck({ config, current, plugins, fetchImpl, managed: !owner });
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
  throw new UpdateError(message || (owner ? 'No update source answered.' : MANAGED_MESSAGES.unreachable), failures[failures.length - 1]?.status || 502);
}

/* -- Applying an update -------------------------------------------------------------------------- */

/**
 * What a managed site can do about a release, from `packageUpdateSupport()` — the capability its host
 * actually has, and nothing about a repository.
 *
 * A customer's site never pulls its own checkout and never calls a deploy hook: the release reaches it as
 * a package `react-wp.com` built, which `server/selfUpdate.mjs` downloads and applies (source `package`).
 * So the caller passes the package check in and this shapes it for the screen — `available` and `repo`
 * are kept because every support answer has them, and `repo` is always false: an end user has no
 * repository to name.
 *
 * Two answers are possible when that probe says no, and they are not the same fact:
 *
 *   - **`mode: 'platform'`** — this site holds a token for the platform that publishes its releases, so the
 *     button is real and the work happens there: `POST /api/v1/updates/install` names this site, and the
 *     platform rebuilds the release and uploads it to this site's own project. That is the only path a
 *     prebuilt Vercel deployment has, because its files are read-only and its repository never carries
 *     `dist/`.
 *   - **`mode: 'manual'`** — neither. `MANAGED_MESSAGES.cannot_apply` says so without naming anything this
 *     reader has no access to, and the support route is what actually resolves it.
 *
 * The caller marks the first case by setting `platform` on the probe (`platformRedeployFrom(config)`),
 * which is why this stays pure: the probe needs `node:fs`, and this module is bundled for runtimes that
 * have neither.
 *
 * @param {{ supported: boolean, reason: string, restart?: 'pm2' | 'manual', app_name?: string, platform?: boolean }} support
 */
export const managedUpdateSupport = (support) => {
  if (support.supported) {
    return {
      available: true,
      repo: false,
      supported: true,
      mode: 'self',
      reason: '',
      restart: support.restart,
      app_name: support.app_name,
    };
  }
  if (support.platform) {
    return {
      available: true,
      repo: false,
      supported: true,
      mode: 'platform',
      reason: MANAGED_MESSAGES.platform_applies,
      // The platform restarts the deployment when it promotes the new build; a customer has nothing to run.
      restart: 'manual',
      app_name: '',
    };
  }
  return { available: false, repo: false, supported: false, mode: 'manual', reason: MANAGED_MESSAGES.cannot_apply, restart: 'manual', app_name: '' };
};

/**
 * Whether this site may ask its platform to redeploy it: it needs a token for one, and nothing else.
 *
 * A managed site's `central_url` falls back to `DEFAULT_CENTRAL_URL`, which is exactly the platform that
 * holds its `saas_installer_installations` row — so the token is the whole test. A site pointed at a
 * platform build that predates the route gets `MANAGED_MESSAGES.no_install_api` from
 * `requestPlatformInstall`, which is the honest answer for a version skew rather than a hidden button.
 *
 * @param {{ token?: string, central_url?: string }} config the `updates_config` row
 */
export const platformRedeployFrom = (config) => Boolean(trimmed(config?.token));

/**
 * The one plan a managed site has when its host cannot install anything: the platform rebuilds it.
 *
 * `mode` is `'platform'` and the steps are the platform's, not this server's — nothing here downloads,
 * extracts or builds, so a screen that showed the self-updater's steps would be describing work that never
 * happens. The reason names what the button does and says the two things that are *not* touched, because a
 * customer about to press an update button is owed that.
 *
 * `up_to_date` and the empty-version case are `manual`, exactly as in `updatePlan`: those are answers to the
 * question rather than failures, and every caller already renders `plan.reason`.
 *
 * @param {{ latestVersion: string, installedVersion: string }} input
 */
export const platformUpdatePlan = ({ latestVersion, installedVersion }) => {
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
  return {
    mode: 'platform',
    reason: `React-WP.com builds this site’s releases and uploads them to its project, so Update now asks it to rebuild ${latestVersion}. Your plugins, uploads and database are not touched.`,
    steps: ['building', 'uploading', 'triggering-rebuild'],
  };
};

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

/**
 * Asks `react-wp.com` to rebuild this site — the way a managed site whose host cannot install a package gets
 * a release.
 *
 * The request is deliberately small: this site's own address, and the release it means to run. The token it
 * already sends for `/check` is the authorisation, and the platform — not this server — decides which Vercel
 * project that address belongs to, spends its own `RWP_VERCEL_TOKEN`, and uploads the release with the same
 * payload path a first provision uses. Nothing here holds a Vercel credential or a deploy hook, which is why
 * a prebuilt deployment can have a working button at all.
 *
 * The wait is long by design (`CENTRAL_INSTALL_TIMEOUT_MS`): the platform builds the release and uploads it
 * before it answers, so a fifteen-second timeout would report a failure for work that then succeeded. Every
 * refusal is one of `MANAGED_MESSAGES`, because the platform's own text names environment variables and file
 * counts that belong to the operator, not to the customer reading this screen.
 *
 * @param {{
 *   config: { token?: string, central_url?: string },
 *   site: string,
 *   version?: string,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} input
 */
export async function requestPlatformInstall({ config, site, version = '', env, fetchImpl = fetch, timeoutMs = CENTRAL_INSTALL_TIMEOUT_MS }) {
  const address = trimmed(site);
  if (!address) {
    // The platform matches on this address; without one it has nothing to match. Only reachable from a tab
    // that was opened on some other hostname, so the sentence tells the reader what to do instead.
    throw new UpdateError('This site has no address to give React-WP.com, so it cannot tell which project to rebuild. Open Settings → Updates from this site’s own address and try again.', 400);
  }
  if (!trimmed(config?.token)) {
    throw new UpdateError(MANAGED_MESSAGES.not_connected, 409);
  }
  const url = centralInstallUrl(config);
  let response;
  try {
    // `centralFetch`, not `fetch`: the platform's apex domain answers `308` to `www`, and a redirect
    // followed by `fetch` itself drops the `Authorization` header — which the platform then reports as a
    // missing token (HTTP 401) rather than as the rebuild it never started.
    response = await centralFetch(url, {
      method: 'POST',
      headers: centralHeaders(config, environmentOf(env).RWP_APP_VERSION),
      body: JSON.stringify({ site: address, ...(isVersion(version) ? { version: trimmed(version) } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    }, { fetchImpl });
  } catch {
    throw new UpdateError(MANAGED_MESSAGES.install_unreachable, 502);
  }
  const body = await response.json().catch(() => null);
  // A 404 that is *not* a refusal is a platform that publishes `/check` and `/apply` but not this route —
  // an older build — and the answer is the same one a wrong address gets. Both shapes a missing route
  // arrives in are covered: no body at all, and this deployment's own fallthrough
  // (`{ error: 'No API endpoint at /api/v1/updates/install.' }`). A refusal from the platform carries
  // `success: false` — `platformInstall` answering "no project is recorded for that address" — and that is
  // a failed rebuild rather than a missing route.
  if (response.status === 404 && body?.success !== false) throw new UpdateError(MANAGED_MESSAGES.no_install_api, 502);
  // 401/403/409/501/500 all land here: the customer is told the rebuild did not happen and given the one
  // action that is theirs. `response.status` is quoted because it is the only detail support will ask for.
  if (!response.ok || !body || body.success === false) {
    throw new UpdateError(MANAGED_MESSAGES.install_failed(response.status), 502);
  }
  const deployed = trimmed(body.version) || trimmed(version);
  return {
    mode: 'platform',
    queued: true,
    project: trimmed(body.projectName),
    version: deployed,
    deployment: body.deployment && typeof body.deployment === 'object'
      ? {
        id: trimmed(body.deployment.id),
        url: trimmed(body.deployment.url || body.deployment.deploymentUrl),
        ready_state: trimmed(body.deployment.readyState),
      }
      : null,
    message: deployed
      ? `React-WP.com rebuilt this site: ${deployed} was uploaded to its project. The new deployment replaces this one as soon as the platform promotes it — this screen reports the new version after that.`
      : 'React-WP.com rebuilt this site. The new deployment replaces this one as soon as the platform promotes it — this screen reports the new version after that.',
  };
}

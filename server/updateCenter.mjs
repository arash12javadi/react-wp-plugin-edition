/**
 * The update centre: which version this site runs, which versions are published, and how an update is
 * applied.
 *
 * A client site reads its releases **directly from GitHub** — the public release repository
 * (`arash12javadi/react-wp-plugin-edition` unless Dashboard → Updates names another) — and nothing in this
 * file's route-facing half calls react-wp.com. Three jobs, one file, because the two hosts
 * (`server.mjs` and the universal engine's `src/server/routes/updates.ts`) must answer with the same JSON:
 *
 *   1. **Check.** `checkForUpdates` reads the stable release tags (`server/releaseList.mjs`: newest five,
 *      cached a few minutes, plain sentences for a rate limit or a missing repository) and compares the
 *      newest with what this site runs. A public repository needs no token; an optional GitHub token saved
 *      under Settings → Integrations → GitHub only lifts GitHub's anonymous rate limit and never leaves the
 *      server.
 *   2. **Choose.** The browser may name one of those five tags to move to, newer or older. The server
 *      accepts only a tag from its own re-read list, and an older one needs an explicit confirmation.
 *   3. **Apply.** On a host that runs `node server.mjs` from a git checkout, `server/selfUpdate.mjs` fetches
 *      the chosen tag, installs, builds and restarts. A host built from a git repository by a platform
 *      (Vercel, Netlify) is rebuilt through its deploy hook; a site connected to its own GitHub repository
 *      and Vercel project updates through the core update on Settings → Integrations → GitHub & Vercel
 *      instead (`server/gitDeploy/coreUpdate.mjs`). Which one is chosen, and why, is `updatePlan`.
 *
 * A version is published by *tagging a release* on GitHub (`v2.4.1`) — that tag is the source of truth,
 * never the `version` field of a `package.json`.
 *
 * Plain ESM with no `node:` imports: the same file is bundled into the Vercel function by
 * `vite.api.config.mjs` and imported directly by `server.mjs`. `process.env` is read through
 * `environmentOf`, so a Workers deployment that has none does not crash on import.
 */
import { GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY, githubTokenFrom, saasInstallerConfigFrom } from './integrationConfig.mjs';
import { readIntegrationRows } from './integrationSettings.mjs';
import { fetchLatestCommit, repoFrom } from './githubReleases.mjs';
import {
  assertDowngradeConfirmed,
  describeRecentReleases,
  listRecentReleases,
  moveKindFor,
  releaseSourceFrom,
  selectRelease,
} from './releaseList.mjs';
import { compareVersions, isVersion } from './versions.mjs';

/** Re-exported so every caller of this module keeps one import, as it always has. */
export { compareVersions, isVersion, parseVersion } from './versions.mjs';


/** `system_settings` rows this feature owns, in step with `src/lib/updateCenter.ts`. */
export const UPDATE_CONFIG_KEY = 'updates_config';
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
    /** Extra fields a route adds to its `{ error }` body, such as `needs_confirmation`. */
    this.extra = {};
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
 *   1. `recorded` — the `.rwp-version` file the update itself writes in the same commit as the code
 *      (`server/gitDeploy/coreMerge.mjs`), so it cannot lag the code it describes;
 *   2. `stamped` — the `package.json` of this build when an update stamped it with the release tag
 *      (`rwpRelease`, `manifestAtVersion`): it is part of the same commit and build as the code, so the very first
 *      deployment of an update already reports the new version even when no `.rwp-version` exists;
 *   3. the deploy's own pin (`RWP_APP_VERSION`) — an owner-only override, never set for a client;
 *   4. the tag the SaaS installer recorded once at install (`saas_installer_config.installed_version`): it never
 *      moves, so it ranks below every source that follows the code;
 *   5. the unstamped `package.json` version, which names no tag at all (the template's own number).
 *
 * The newest published release is never a stand-in: a site with no record would then call itself up to date
 * and hide the update this screen exists to offer. Each answer is normalised to a plain version (no `v`).
 */
export const resolveInstalledVersion = ({ recorded = '', stamped = '', pinned = '', saas = '', fallback = '' }) =>
  trimmed(recorded).replace(/^v/i, '')
  || trimmed(stamped).replace(/^v/i, '')
  || trimmed(pinned).replace(/^v/i, '')
  || trimmed(saas).replace(/^v/i, '')
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
 * hand-edited value must still leave the Updates screen usable.
 *
 * The row holds four settings: the release repository, how often to check, whether to show new releases, and
 * whether this server may update its own checkout. Older versions also stored an update-server address, a
 * bearer token and a channel. They are **not read** — nothing is sent to an update server, and releases are
 * always stable ones — and the browser drops them from the row the next time the settings are saved
 * (`saveUpdateConfig` in `src/lib/updateCenter.ts`), so a token never lingers in the database.
 *
 * @param {unknown} value
 */
export const updateConfigFrom = (value) => {
  const row = value && typeof value === 'object' ? value : {};
  const autoCheck = trimmed(row.auto_check).toLowerCase();
  const repository = trimmed(row.repository);
  return {
    /**
     * `owner/name` of the repository whose release tags this site is updated from, as named on Dashboard →
     * Updates. Empty means the default (`DEFAULT_RELEASE_REPOSITORY`), and a value that is not a repository
     * reads as empty rather than as a broken URL to fetch.
     */
    repository: repoFrom(repository) ? repository : '',
    auto_check: AUTO_CHECK_KEYS.includes(autoCheck) ? autoCheck : 'weekly',
    notify: row.notify !== false,
    /**
     * Whether `POST /api/admin/system/update` may run the updater on this server.
     *
     * Opt-in, because the updater rewrites the checkout this site runs from: an administrator has to
     * tick it on Dashboard → Updates, and `server/selfUpdate.mjs` still refuses a checkout with
     * uncommitted changes. Absent means no — a site that never asked for this must not get it because
     * it happened to be a git clone.
     */
    self_update: row.self_update === true,
  };
};

/**
 * The same configuration, safe to show an administrator. It holds no secret, and no answer carries one.
 *
 * `owner` is the one account that may see *where* updates come from and change them. Anyone else who can
 * open the screen receives the two scheduling settings only.
 *
 * @param {ReturnType<typeof updateConfigFrom>} config
 * @param {boolean} [owner=true]
 */
export const describeUpdateConfig = (config, owner = true) => ({
  auto_check: config.auto_check,
  notify: config.notify,
  /** The server never lets a non-owner switch the self-updater on. */
  self_update: owner ? config.self_update : false,
  /** The repository named on this screen; empty means the default. Hidden from non-owners. */
  repository: owner ? config.repository : '',
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
  // `pinned`: the deployment's own environment names the repository (what the first-install page sets on a
  // client's Vercel project), so the screen shows no field for it — a client has nothing to choose there.
  const pinned = !explicit && trimmed(environment.RWP_RELEASE_REPO).length > 0 && repo === trimmed(environment.RWP_RELEASE_REPO);
  return repoFrom(repo) ? { repo, token, explicit, pinned } : null;
};

/**
 * The resolved release source, safe to show an administrator: which repository, where that name came from,
 * and whether a GitHub token will be used to read it. The token itself never leaves the server.
 *
 * An end user's answer is empty: the repository is the site owner's business.
 *
 * @param {{ repo: string, token?: string, custom?: boolean, origin?: string } | null} [source]
 * @param {boolean} [owner=true]
 */
export const describeGithubSource = (source, owner = true) => (owner
  ? {
    repo: trimmed(source?.repo),
    has_token: trimmed(source?.token).length > 0,
    configured: trimmed(source?.repo).length > 0,
    /** `saved` (named on this screen), `environment` (fixed by the deployment) or `default`. */
    origin: ['saved', 'environment'].includes(source?.origin) ? source.origin : 'default',
  }
  : { repo: '', has_token: false, configured: false, origin: 'default' });

/**
 * The stored configuration, read the way this deployment can read `system_settings` — through the
 * engine's adapter, a direct connection, or the service key (`server/integrationSettings.mjs`).
 *
 * Three rows come back in one trip: `updates_config` (the schedule and, optionally, the release repository),
 * `github_config` (an optional GitHub token that lifts GitHub's anonymous rate limit) and the installer's
 * record of the release a site was built from. A token or an update-server address left in `updates_config`
 * by an older version is ignored here (`updateConfigFrom` does not carry them) and is removed the next time
 * the settings are saved.
 *
 * A row that cannot be read is reported as exactly that (`readable: false`) rather than as defaults that look
 * like a choice: on a Supabase deployment whose server has neither `DATABASE_URL` nor `SUPABASE_SECRET_KEY`
 * the rows are stored and simply invisible here.
 *
 * @param {import('./integrationSettings.mjs').IntegrationReadOptions} options
 */
export async function readUpdatesConfig(options) {
  const rows = await readIntegrationRows([UPDATE_CONFIG_KEY, GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY], options);
  const config = updateConfigFrom(rows.settings[UPDATE_CONFIG_KEY]);
  const github = releaseSourceFrom({ updates: config, github: rows.settings[GITHUB_CONFIG_KEY], env: options?.env });
  return {
    config,
    /** `{ repo, token, custom, origin }` — the repository and optional credential a release list is read with. */
    github,
    /** The release tag the SaaS installer recorded, as a plain version — or '' when it recorded none. */
    installed: saasInstalledVersionFrom(rows.settings[SAAS_INSTALLER_CONFIG_KEY]),
    readable: rows.readable,
    error: rows.readable ? '' : rows.error,
  };
}


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

/** True for the owner on a deployment that sets `OWNER_GITHUB_REPO`: the screen then shows only the latest commit and release. */
export function ownerCommitView(owner = true, env = process.env) {
  return Boolean(owner && trimmed(env.OWNER_GITHUB_REPO));
}

/**
 * The newest commit (title + description) of the repository named by `OWNER_GITHUB_REPO`, read with
 * `OWNER_GITHUB_TOKEN_FOR_COMMIT_READING`. Deliberately independent of the update source (which clients
 * follow): this only feeds the owner's Dashboard → Updates card. Owner only: anyone else gets `null`
 * without any request, and so does a deployment that sets no `OWNER_GITHUB_REPO`. Never throws; the
 * token is never returned.
 *
 * @param {{ owner?: boolean, fetchImpl?: typeof fetch, env?: Record<string, string | undefined> }} [input]
 */
export async function latestCommitFor({ owner = true, fetchImpl = fetch, env = process.env } = {}) {
  const repo = trimmed(env.OWNER_GITHUB_REPO);
  if (!owner || !repo) return null;
  return fetchLatestCommit({ repo, token: trimmed(env.OWNER_GITHUB_TOKEN_FOR_COMMIT_READING), fetchImpl });
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
 * The check both hosts run: read the release tags of the release repository from GitHub, and compare the
 * newest stable one with what this site runs.
 *
 * GitHub is the only source. A client site never asks react-wp.com — the release repository is public (or
 * readable with the site owner's own GitHub token), so there is no platform token, no second source and no
 * "the first source could not be read" note to show before a successful answer. `server/releaseList.mjs`
 * owns the read (stable releases only, newest five, cached for a few minutes, a plain sentence for a rate
 * limit or a 404) and this function only shapes it into the answer the screen already understands, with the
 * five releases attached as `releases` for the version picker.
 *
 * Nothing here reads `package.json`: this site's version is whatever the caller reports as installed, and
 * the newest version is a release tag.
 *
 * @param {{ config?: any, current: { app: string, site?: string }, plugins: Array<{ id: string, name?: string, version: string }>, github?: { repo: string, token?: string } | null, fetchImpl?: typeof fetch, list?: Awaited<ReturnType<typeof listRecentReleases>> | null }} options
 */
export async function checkForUpdates({ current, plugins, github = null, fetchImpl = fetch, list = null, pluginReleases = null }) {
  const source = github || releaseSourceFrom({});
  let recent = list;
  if (!recent) {
    try {
      recent = await listRecentReleases({ source, fetchImpl });
    } catch (error) {
      throw toUpdateError(error);
    }
  }
  const answer = checkAnswerFrom({
    source: 'github',
    app: recent.releases[0],
    // Plugin releases are *reported* (the badge, the banner and the table list them) when the caller read
    // them, but never become part of the core update: `updateAvailable` stays "core only", so no core button
    // is offered for a plugin. Without `pluginReleases` the answer is core-only, as before.
    plugins: pluginReleases || {},
    current,
    plugins_installed: plugins,
    // The list is a warning, not a failure, when GitHub could not be refreshed and the last answer is shown.
    error: recent.stale ? recent.warning : '',
    coreOnly: !pluginReleases,
  });
  return { ...answer, releases: describeRecentReleases(recent, current.app) };
}

/** A release-list refusal as the `UpdateError` every route already maps to a status and a sentence. */
export const toUpdateError = (error) => {
  if (error instanceof UpdateError) return error;
  const message = error instanceof Error && error.message ? error.message : 'The release list could not be read.';
  const wrapped = new UpdateError(message, Number(error?.status) || 502);
  wrapped.extra = error?.extra && typeof error.extra === 'object' ? error.extra : {};
  return wrapped;
};

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
export const updatePlan = ({ config, deployHook, selfUpdate, latestVersion, installedVersion, gitDeploy = false, move = '' }) => {
  if (!isVersion(latestVersion)) {
    return { mode: 'manual', reason: 'No release is known yet. Run a check for updates first, then try again.', steps: [] };
  }
  // `move` is `moveKindFor`'s word for the chosen release against what is installed. Without it (an older
  // caller) the release is the newest one, so only "same or older" means there is nothing to do.
  const kind = move || (compareVersions(latestVersion, installedVersion) > 0 ? 'upgrade' : 'current');
  if (kind === 'current') {
    return {
      mode: 'manual',
      up_to_date: true,
      reason: `This site already runs ${installedVersion}, which is the release you chose.`,
      steps: [],
    };
  }
  // A site that deploys from its own GitHub repository is updated by committing the release there; the
  // deploy hook would only rebuild the commit it already runs. The core update on Settings → Integrations →
  // GitHub & Vercel plans the merge, asks about conflicts and follows the deployment, and Dashboard →
  // Updates shows that same flow — so this answer exists only for a caller that did not use it.
  if (gitDeploy) {
    return {
      mode: 'manual',
      reason: `This site deploys from its own GitHub repository, so ${latestVersion} is applied as a reviewed commit: use Update on Dashboard → Updates (or Settings → Integrations → GitHub & Vercel → Update React-WP core). Vercel then deploys it.`,
      steps: [],
      git: true,
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
      ? 'Automatic updates are switched off for this site. Turn on “Let this server update itself” under Dashboard → Updates → Where updates come from, and Update now applies the release on this server.'
      : 'This site cannot update itself from here. Connect it to its own GitHub repository and Vercel project (Settings → Integrations → GitHub & Vercel), or save a deploy hook its host builds from (Settings → Integrations → Deployments).',
    steps: [],
  };
};

/**
 * What a request to move to a release needs: the five-release list (re-read here, cached), the release the
 * request named — which must be one of them — and a confirmation when it is older than what is installed.
 * Anything refused is an `UpdateError` carrying a sentence, so a route never answers a bare status.
 *
 * @param {{ github: { repo: string, token?: string }, tag?: unknown, confirmDowngrade?: unknown, installed: string, fetchImpl?: typeof fetch }} input
 */
export async function resolveUpdateTarget({ github, tag, confirmDowngrade, installed, fetchImpl = fetch }) {
  try {
    const list = await listRecentReleases({ source: github, fetchImpl });
    const release = selectRelease(list, tag);
    assertDowngradeConfirmed({ installed, release, confirmed: confirmDowngrade === true });
    return { list, release, move: moveKindFor(installed, release.version) };
  } catch (error) {
    throw toUpdateError(error);
  }
}

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

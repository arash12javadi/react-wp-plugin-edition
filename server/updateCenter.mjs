/**
 * The update centre: which version this site runs, which version `react-wp.com` publishes, and how an
 * update is applied.
 *
 * Three jobs, one file, because the two hosts (`server.mjs` and the universal engine's
 * `src/server/routes/updates.ts`) must answer with the same JSON:
 *
 *   1. **Ask the central server.** `POST {central}/api/v1/updates/check` reports this site's version and
 *      every installed plugin's, and answers with the releases. The bearer token it uses is
 *      `system_settings.updates_config.token` — written by the signed-in administrator, read here only.
 *      The browser never holds it and never calls GitHub: that is what keeps a private repository
 *      private while still telling an administrator that an update exists.
 *   2. **Fall back to the public feed.** A site with no token (or a central server that is down) is
 *      answered from the `updates.json` feed Dashboard → Updates has always read, so the feature works
 *      before a central server exists and degrades instead of failing.
 *   3. **Apply the update.** A Vercel/Netlify host is told to rebuild (`deploy_config`, Settings →
 *      Integrations → Deployments); a host that runs `node server.mjs` runs `server/selfUpdate.mjs`.
 *      Which one is chosen, and why, is `updatePlan`.
 *
 * Plain ESM with no `node:` imports: the same file is bundled into the Vercel function by
 * `vite.api.config.mjs` and imported directly by `server.mjs`. `process.env` is read through
 * `environmentOf`, so a Workers deployment that has none does not crash on import.
 */
import { readIntegrationRows } from './integrationSettings.mjs';

/** `system_settings` rows this feature owns, in step with `src/lib/updateCenter.ts`. */
export const UPDATE_CONFIG_KEY = 'updates_config';
export const VERSION_STATE_KEY = 'version_state';

/** How many past updates `version_state.history` keeps. */
export const VERSION_STATE_HISTORY_LIMIT = 20;

/** Where the central server lives when nothing says otherwise. */
export const DEFAULT_CENTRAL_URL = 'https://react-wp.com';

/**
 * The public feed Dashboard → Updates has always read, kept as the fallback source.
 * In step with `defaultFeedUrl` in `src/lib/updates.ts`.
 */
export const DEFAULT_FEED_URL = 'https://raw.githubusercontent.com/arash12javadi/react-wp/main/updates.json';

/** The two central endpoints, named once so the client, the docs and this file cannot disagree. */
export const CENTRAL_CHECK_PATH = '/api/v1/updates/check';
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

/* -- Versions ------------------------------------------------------------------------------------ */

/**
 * A version as `[major, minor, patch, build]` plus its pre-release tag, so `1.10.0` sorts above
 * `1.9.0` and `2.0.0-beta.1` sorts below `2.0.0`. Kept identical to `compareVersions` in
 * `src/lib/updates.ts`: the server decides whether an update exists and the browser writes the badge,
 * and a disagreement between the two would show "up to date" next to an Update Now button.
 */
export const parseVersion = (value) => {
  const [core, pre = ''] = String(value || '').trim().replace(/^v/i, '').split('-', 2);
  return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
};

/** `-1`, `0` or `1`, as a sort comparator. */
export const compareVersions = (a, b) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  // No tag outranks any tag: 2.0.0 ships after 2.0.0-rc.1.
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
};

/** True for something `compareVersions` can sort. */
export const isVersion = (value) => /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed(value));

/* -- `system_settings.updates_config` ------------------------------------------------------------ */

/**
 * Whatever is stored in `system_settings.updates_config`, as a complete configuration.
 *
 * Every field falls back rather than throwing: this row is written by a browser, so a half-filled or
 * hand-edited value must still leave the Updates screen usable. The token is the one field with no
 * default — without it there is no central server to ask, and the public feed answers instead.
 *
 * @param {unknown} value
 */
export const updateConfigFrom = (value) => {
  const row = value && typeof value === 'object' ? value : {};
  const central = trimmed(row.central_url).replace(/\/+$/, '');
  const channel = trimmed(row.channel).toLowerCase();
  const autoCheck = trimmed(row.auto_check).toLowerCase();
  return {
    /** The origin of the update server, without a trailing slash. */
    central_url: /^https?:\/\//i.test(central) ? central : DEFAULT_CENTRAL_URL,
    /** The server-only bearer token. Never sent to the browser, never logged. */
    token: trimmed(row.token),
    /** The public feed used when there is no token, or when the central server cannot answer. */
    feed_url: /^https?:\/\//i.test(trimmed(row.feed_url)) ? trimmed(row.feed_url) : DEFAULT_FEED_URL,
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
 * @param {ReturnType<typeof updateConfigFrom>} config
 */
export const describeUpdateConfig = (config) => ({
  central_url: config.central_url,
  feed_url: config.feed_url,
  channel: config.channel,
  auto_check: config.auto_check,
  notify: config.notify,
  self_update: config.self_update,
  has_token: config.token.length > 0,
  /** Which source an update check asks first. */
  source: config.token ? 'central' : 'feed',
});

/**
 * The stored configuration, read the way this deployment can read `system_settings` — through the
 * engine's adapter, a direct connection, or the service key (`server/integrationSettings.mjs`).
 *
 * A row that cannot be read is reported as exactly that rather than as an unconfigured site: on a
 * Supabase deployment whose server has neither `DATABASE_URL` nor `SUPABASE_SECRET_KEY` the token is
 * stored and simply invisible here, and telling the administrator to paste it again would be a lie.
 *
 * @param {import('./integrationSettings.mjs').IntegrationReadOptions} options
 */
export async function readUpdatesConfig(options) {
  const rows = await readIntegrationRows([UPDATE_CONFIG_KEY], options);
  return {
    config: updateConfigFrom(rows.settings[UPDATE_CONFIG_KEY]),
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
 * One release from any of the shapes this feature reads: the central answer, the public feed, and a
 * hand-written entry. A `version` is the only requirement; everything else is optional so a feed written
 * by hand still works.
 *
 * @param {unknown} value
 */
export const releaseFrom = (value) => {
  const row = value && typeof value === 'object' ? value : null;
  if (!row) return null;
  const version = trimmed(row.version).replace(/^v/i, '');
  if (!isVersion(version)) return null;
  const notes = Array.isArray(row.notes)
    ? row.notes.map((note) => String(note)).filter(Boolean)
    : trimmed(row.notes) ? trimmed(row.notes).split('\n').map((line) => line.trim()).filter(Boolean) : [];
  const changelog = trimmed(row.changelog_url);
  const download = trimmed(row.download_url);
  return {
    version,
    released: trimmed(row.released) || trimmed(row.published_at),
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
 * licensed site from a stranger, and the caller falls back to the feed.
 *
 * @param {{ config: any, current: { app: string, site?: string }, plugins: Array<{ id: string, version: string }>, fetchImpl?: typeof fetch }} options
 */
export async function fetchCentralCheck({ config, current, plugins, fetchImpl = fetch }) {
  if (!config.token) {
    throw new UpdateError('No update token is saved, so the central server cannot be asked. Settings → Updates takes one; the public feed answers until then.', 400);
  }
  const url = `${config.central_url}${CENTRAL_CHECK_PATH}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: centralHeaders(config, current.app),
      body: JSON.stringify({
        format: 'rwp-update-center',
        version: 1,
        channel: config.channel,
        site: trimmed(current.site),
        app: { id: 'react-wp', version: current.app },
        plugins: plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
      }),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new UpdateError(networkMessage(error, url), 502);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpdateError('The central server refused this site\'s update token. Check it on Settings → Updates: a token is issued per site and can be revoked.', 401);
  }
  if (!response.ok) throw new UpdateError(`The central server answered HTTP ${response.status} at ${url}.`, 502);
  const body = await response.json().catch(() => {
    throw new UpdateError(`${url} did not return valid JSON.`, 502);
  });
  const app = releaseFrom(body?.app);
  if (!app) {
    throw new UpdateError('The central server\'s answer has no "app" release with a version. Expected {"format":"rwp-update-center","version":1,"app":{"version":"1.2.3"}}.', 502);
  }
  return { app, plugins: pluginReleasesFrom(body?.plugins) };
}

/**
 * The public `updates.json` feed — the shape Dashboard → Updates has always read
 * (`format: "rwp-update-feed"`, `version: 1`). Needs no token and no central server.
 *
 * @param {{ feedUrl: string, fetchImpl?: typeof fetch }} options
 */
export async function fetchFeedCheck({ feedUrl, fetchImpl = fetch }) {
  const url = trimmed(feedUrl) || DEFAULT_FEED_URL;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new UpdateError(networkMessage(error, url), 502);
  }
  if (response.status === 404) {
    throw new UpdateError(`The update feed returned 404 at ${url}. If that file lives in a private repository, raw.githubusercontent.com will not serve it without a token — save an update token on Settings → Updates instead.`, 404);
  }
  if (!response.ok) throw new UpdateError(`The update feed answered HTTP ${response.status} at ${url}.`, 502);
  const body = await response.json().catch(() => {
    throw new UpdateError(`${url} did not return valid JSON.`, 502);
  });
  if (body?.format !== 'rwp-update-feed') {
    throw new UpdateError('The URL answered, but not with a React-WP update feed (expected "format": "rwp-update-feed").', 502);
  }
  const app = releaseFrom(body.app);
  if (!app) throw new UpdateError('The update feed has no "app" entry with a version.', 502);
  return { app, plugins: pluginReleasesFrom(body.plugins) };
}

/**
 * The whole answer a check produces, built once so both hosts and both sources agree on its shape.
 *
 * `source` names where the answer came from (`central` or `feed`), `error` carries the first failure
 * when a source was tried and refused, and `updates` is what the screen lists — one entry per plugin
 * that has a newer release, plus the app itself.
 *
 * @param {{ source: 'central'|'feed', app: any, plugins: Record<string, any>, current: { app: string, site?: string }, plugins_installed: Array<{ id: string, name?: string, version: string }>, error?: string }} input
 */
export const checkAnswerFrom = ({ source, app, plugins, current, plugins_installed, error = '' }) => {
  const installed = trimmed(current.app);
  const updates = [];
  if (compareVersions(app.version, installed) > 0) {
    updates.push({ id: 'react-wp', name: 'React-WP', kind: 'app', installed, latest: app.version, release: publicRelease(app) });
  }
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
  return {
    format: 'rwp-update-center',
    version: 1,
    source,
    checked_at: new Date().toISOString(),
    app: {
      installed,
      latest: app.version,
      update_available: compareVersions(app.version, installed) > 0,
      release: publicRelease(app),
    },
    plugins: Object.fromEntries(Object.entries(plugins).map(([id, release]) => [id, publicRelease(release)])),
    updates,
    update_available: updates.length > 0,
    error,
  };
};

/**
 * The check both hosts run: central first, the public feed as the fallback.
 *
 * The fallback is deliberate rather than defensive. A site without a token, a central server in the
 * middle of a deploy, and a token that was just revoked all have to leave an administrator able to see
 * that an update exists — and the feed is public, so the downgrade costs nothing.
 *
 * @param {{ config: any, current: { app: string, site?: string }, plugins: Array<{ id: string, name?: string, version: string }>, fetchImpl?: typeof fetch }} options
 */
export async function checkForUpdates({ config, current, plugins, fetchImpl = fetch }) {
  let centralError = '';
  if (config.token) {
    try {
      const central = await fetchCentralCheck({ config, current, plugins, fetchImpl });
      return checkAnswerFrom({ source: 'central', ...central, current, plugins_installed: plugins });
    } catch (error) {
      centralError = error instanceof Error ? error.message : 'The central update server could not be asked.';
    }
  }
  try {
    const feed = await fetchFeedCheck({ feedUrl: config.feed_url, fetchImpl });
    return checkAnswerFrom({ source: 'feed', ...feed, current, plugins_installed: plugins, error: centralError });
  } catch (error) {
    const feedError = error instanceof Error ? error.message : 'The update feed could not be read.';
    throw new UpdateError(centralError ? `${centralError} ${feedError}` : feedError, error?.status || 502);
  }
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
 * How this site would apply an update, and the steps the screen shows while it does.
 *
 * `deploy-hook` is the usual answer for a serverless deployment: the hook starts the build that pulls
 * the new version in, so there is nothing for this request to install. `self` is a host that runs
 * `node server.mjs` from a writable checkout — `server/selfUpdate.mjs` fetches, installs, builds and
 * restarts. `manual` is everything else, and its `reason` is the sentence the screen shows next to the
 * by-hand instructions, so an administrator is never told "no" without being told why.
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
      ? 'Automatic updates are switched off for this site, so the update has to be applied by hand.'
      : 'This host cannot update itself: it is a serverless deployment with no deploy hook saved, or a server whose checkout is read-only.',
    steps: [],
  };
};

/**
 * The by-hand instructions, in the shape the screen renders. Sent with every `manual` answer, because
 * the fallback for a host that cannot update itself is "here is what to do instead".
 */
export const MANUAL_UPDATE_STEPS = [
  'Back up first: Settings → Backup → Export backup.',
  'Pull the new version into the folder or repository this site runs from (git pull, or extract the ZIP over the old folder, keeping .env.local and data/).',
  'Run npm install — an update may add packages.',
  'If the release notes mention a database change, run supabase/schema.sql again. It is safe to re-run.',
  'Rebuild and restart: npm start (or npm run build && pm2 restart <name>). On Vercel, push — it builds on its own.',
];

/**
 * Runs the one thing a deployed site can do itself: call the hook that starts its build.
 *
 * The caller has already chosen the mode (`updatePlan`), and this only reports what happened — a failed
 * hook call is an answer, not an exception, because the administrator needs the sentence and the by-hand
 * steps either way.
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

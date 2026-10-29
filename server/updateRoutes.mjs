/**
 * Settings → Updates, on the classic host (`node server.mjs`).
 *
 * Four routes, and the same JSON the universal engine answers (`src/server/routes/updates.ts`) — both
 * call the same shared module, `server/updateCenter.mjs`, so the two hosts cannot disagree about whether
 * an update exists or how it is applied:
 *
 *   GET  /api/admin/updates                 what is installed, how it is configured, what this host can do
 *   POST /api/admin/updates/check           ask `react-wp.com`, or read this deployment's own GitHub
 *                                           release tags when it owns the repository
 *   POST /api/admin/system/update           apply one: call the deploy hook, or start a self-update run
 *   GET  /api/admin/system/update-status    how a self-update run is going, plus the recent ones
 *
 * Nothing here takes the update token from the browser. The configuration lives in
 * `system_settings.updates_config` and is read server-side through `readIntegrationRows`, so the token
 * reaches `react-wp.com` and nothing else. The browser is told only `has_token` — see
 * `describeUpdateConfig` — and it never calls GitHub at all, which is what makes a private repository
 * private. The GitHub credential a direct check uses never leaves the server either.
 *
 * `handleUpdateRequest` returns `null` for a path that is not one of the four, the same contract
 * `handleAdminRequest` has, so `server.mjs` chains the two.
 */
import { readFile } from 'node:fs/promises';
import { authorizePluginManager } from './pluginFiles.mjs';
import {
  AUTO_CHECK_KEYS,
  PLUGIN_DIRECTORY_PATH,
  UpdateError,
  UPDATE_CHANNELS,
  applyDeployHookUpdate,
  checkForUpdates,
  describeUpdateConfig,
  installedPluginsFrom,
  readUpdatesConfig,
  updatePlan,
} from './updateCenter.mjs';
import {
  listSelfUpdateRuns,
  readSelfUpdateLog,
  readSelfUpdateRun,
  selfUpdateSupport,
  startSelfUpdate,
} from './selfUpdate.mjs';

/** The status code a refusal carries, in step with `SchemaError`'s in `server/adminRoutes.mjs`. */
const fail = (error) => ({
  status: error instanceof UpdateError ? error.status : 500,
  body: { error: error instanceof Error ? error.message : 'Unknown server error.' },
});

/**
 * The version this build reports.
 *
 * `RWP_APP_VERSION` wins when the deployment pins it to the release tag it was built from, which is the
 * only value that cannot lag: a release workflow that checks out `v2.4.1` can export `2.4.1` in the same
 * step. Otherwise the build's own `package.json` — written by the same workflow just before the tag is
 * pushed — is the answer. The number is read on the server, never sent by the browser: a client that
 * could name its own version could hide an update from itself. Cached after the first read, because this
 * file cannot change while the process runs.
 */
let installedVersionCache = '';

export async function installedVersion() {
  if (installedVersionCache) return installedVersionCache;
  const pinned = String(process.env.RWP_APP_VERSION || '').trim().replace(/^v/i, '');
  if (pinned) {
    installedVersionCache = pinned;
    return pinned;
  }
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const version = String(JSON.parse(raw)?.version || '').trim();
    installedVersionCache = version;
    return version;
  } catch {
    return '';
  }
}

/** The caller's permission, or a refusal. Every route below needs an administrator. */
async function requireManager(config, headers) {
  if (!config?.supabaseUrl || !config?.supabasePublishableKey) {
    throw new UpdateError('This site is not installed, so updates cannot be managed.', 501);
  }
  const auth = await authorizePluginManager(
    config.supabaseUrl,
    config.supabasePublishableKey,
    (headers.authorization || '').replace(/^Bearer\s+/i, ''),
  );
  if (!auth.ok) throw new UpdateError(auth.error, auth.status);
  return auth;
}

/**
 * The plugin versions the screen reported, cleaned up — `installedPluginsFrom`'s rules, called through
 * the shared module so both hosts accept exactly the same list.
 */
const pluginList = (value) => installedPluginsFrom(value);

/** GET /api/admin/updates — everything the screen needs before it offers a button. */
async function overview({ readOptions }) {
  const stored = await readUpdatesConfig(readOptions);
  const support = await selfUpdateSupport();
  return {
    installed: await installedVersion(),
    config: describeUpdateConfig(stored.config),
    /** False when this server cannot read `system_settings` at all: the token is stored, not missing. */
    readable: stored.readable,
    error: stored.error,
    support,
    /** Where a plugin catalogue would be asked for, so the screen can say where installs come from. */
    plugin_directory: PLUGIN_DIRECTORY_PATH,
    channels: UPDATE_CHANNELS,
    auto_check: AUTO_CHECK_KEYS,
  };
}

/** POST /api/admin/updates/check { plugins?: [{ id, name?, version }], site? } */
async function check(body, config, readOptions) {
  const stored = await readUpdatesConfig(readOptions);
  const plugins = pluginList(body.plugins);
  const answer = await checkForUpdates({
    config: stored.config,
    current: { app: await installedVersion(), site: String(body.site || '').trim() },
    plugins,
    github: stored.github,
  });
  // `readable: false` is worth saying even when the check succeeded: it means this server could not see
  // the stored rows, so the administrator knows why a configured source looks unconfigured before they go
  // looking in the wrong place.
  return { ...answer, config: describeUpdateConfig(stored.config), readable: stored.readable };
}

/**
 * POST /api/admin/system/update { plugins?: [...], ref? }
 *
 * One route for three ways of applying an update, because the *decision* belongs on the server: the
 * browser asks for an update, and `updatePlan` says what this host can actually do. The three answers are
 * shaped differently on purpose — a started rebuild, a started run, and a refusal that names what to
 * configure — and each carries the check it was based on, so the screen never has to guess which release
 * it just asked for.
 */
async function applyUpdate(body, config, readOptions, readDeployHook) {
  const stored = await readUpdatesConfig(readOptions);
  const installed = await installedVersion();
  const plugins = pluginList(body.plugins);
  const answer = await checkForUpdates({
    config: stored.config,
    current: { app: installed, site: String(body.site || '').trim() },
    plugins,
    github: stored.github,
  });
  const reported = { ...answer, config: describeUpdateConfig(stored.config), readable: stored.readable };
  // Asked only now: the deploy hook is a database read, and most calls to this route end at `up_to_date`.
  const deployHook = String((await readDeployHook().catch(() => '')) || '').trim();
  const support = await selfUpdateSupport();
  const plan = updatePlan({
    config: stored.config,
    deployHook,
    selfUpdate: support.supported,
    latestVersion: answer.app.latest,
    installedVersion: installed,
  });

  if (plan.up_to_date) return { status: 200, body: { ...plan, check: reported } };
  if (plan.mode === 'manual') {
    return { status: 409, body: { ...plan, check: reported } };
  }
  if (plan.mode === 'deploy-hook') {
    const result = await applyDeployHookUpdate({ deployHook, env: process.env });
    // 502 on a hook that refused: the request was fine, the platform it called was not.
    return { status: result.queued ? 200 : 502, body: { ...result, plan, check: reported } };
  }
  const run = await startSelfUpdate({
    to: answer.app.latest,
    from: installed,
    ref: String(body.ref || '').trim(),
  });
  // 202: accepted, not finished. The screen polls `update-status?id=` with the id it just got.
  return { status: 202, body: { mode: 'self', run, plan, check: reported } };
}

/** GET /api/admin/system/update-status?id=<run> — one run with its log, or the recent ones. */
async function updateStatus(query) {
  if (query.id) {
    const run = await readSelfUpdateRun(query.id);
    if (!run) throw new UpdateError('That update run does not exist on this server, or it was cleaned up.', 404);
    return { run, log: await readSelfUpdateLog(run.id) };
  }
  return { runs: await listSelfUpdateRuns(), support: await selfUpdateSupport() };
}

/**
 * Returns null when the path is not one of the four, so `server.mjs` can fall through to
 * `handleAdminRequest`. `body` is already-parsed JSON for POSTs, `readOptions` is what
 * `readIntegrationRows` needs on this host, and `readDeployHook` is a callback rather than a value so a
 * check never costs a wait on a row it will not use.
 */
export async function handleUpdateRequest({
  method,
  pathname,
  query,
  headers,
  body,
  config,
  readOptions,
  readDeployHook = async () => '',
}) {
  const owned = pathname === '/api/admin/updates'
    || pathname === '/api/admin/updates/check'
    || pathname === '/api/admin/system/update'
    || pathname === '/api/admin/system/update-status';
  if (!owned) return null;
  try {
    await requireManager(config, headers);
    if (pathname === '/api/admin/updates') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      return { status: 200, body: await overview({ config, readOptions }) };
    }
    if (pathname === '/api/admin/system/update-status') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      return { status: 200, body: await updateStatus(query) };
    }
    if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
    if (pathname === '/api/admin/updates/check') {
      return { status: 200, body: await check(body, config, readOptions) };
    }
    return await applyUpdate(body, config, readOptions, readDeployHook);
  } catch (error) {
    if (!(error instanceof UpdateError)) console.error(`${pathname} failed:`, error);
    return fail(error);
  }
}

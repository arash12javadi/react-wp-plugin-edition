/**
 * Dashboard → Updates, on the classic host (`node server.mjs`).
 *
 * Five routes, and the same JSON the universal engine answers (`src/server/routes/updates.ts`) — both
 * call the same shared modules (`server/updateCenter.mjs`, `server/updateFlow.mjs`, `server/releaseList.mjs`),
 * so the two hosts cannot disagree about whether an update exists or how it is applied:
 *
 *   GET  /api/admin/updates                 what is installed, how it is configured, what this host can do
 *   POST /api/admin/updates/check           read the stable release tags of the release repository from
 *                                           GitHub and compare the newest with what is installed
 *   POST /api/admin/updates/releases        the five most recent stable releases, for the version picker
 *   POST /api/admin/system/update           apply one of those releases: deploy hook, or a self-update run
 *   GET  /api/admin/system/update-status    how a self-update run is going, plus the recent ones
 *
 * Releases are read **directly from GitHub** — `arash12javadi/react-wp-plugin-edition` unless Dashboard →
 * Updates names another repository. react-wp.com is never called from here. The optional GitHub token
 * (Settings → Integrations → GitHub) only raises GitHub's anonymous rate limit; it is read on the server and
 * never put in an answer. The browser is told which repository is read and whether a token is used, nothing
 * more.
 *
 * Who may do what: any signed-in account that may manage the site can read a check; the version picker is
 * open to the platform owner; applying is the site owner's (`administrator`) alone. A site that deploys from
 * its own GitHub repository applies through the core update on Settings → Integrations → GitHub & Vercel,
 * which Dashboard → Updates embeds — this route answers such a site with the sentence that says so.
 *
 * `handleUpdateRequest` returns `null` for a path that is not one of the five, the same contract
 * `handleAdminRequest` has, so `server.mjs` chains the two.
 */
import { readFile } from 'node:fs/promises';
import { VERCEL_DEPLOY_CONFIG_KEY, deploymentConnectionFrom, isGitDeployConnected, settingsIo } from './gitDeploy/connection.mjs';
import { authorizePluginManager } from './pluginFiles.mjs';
import { authorizePlatformOwner, currentUserRole, isUpdateOwnerRole } from './integrationSettings.mjs';
import {
  AUTO_CHECK_KEYS,
  PLUGIN_DIRECTORY_PATH,
  UpdateError,
  describeGithubSource,
  describeUpdateConfig,
  installedPluginsFrom,
  latestCommitFor,
  ownerCommitView,
  readUpdatesConfig,
  resolveInstalledVersion,
} from './updateCenter.mjs';
import { applyResponse, checkResponse, refusalBody, releasesResponse } from './updateFlow.mjs';
import {
  listSelfUpdateRuns,
  readSelfUpdateLog,
  readSelfUpdateRun,
  selfUpdateSupport,
} from './selfUpdate.mjs';

/**
 * Whether this site deploys from its own GitHub repository through a connected Vercel project — read with
 * the caller's own session. Any failure is `false`, which keeps the plan this route always made.
 */
async function gitDeployConnectedFor(config, headers) {
  try {
    const io = settingsIo({
      supabaseUrl: config?.supabaseUrl,
      supabaseKey: config?.supabasePublishableKey,
      accessToken: String(headers?.authorization || '').replace(/^Bearer\s+/i, ''),
    });
    return isGitDeployConnected(deploymentConnectionFrom(await io.read(VERCEL_DEPLOY_CONFIG_KEY)));
  } catch {
    return false;
  }
}

/** The status code a refusal carries, and always a sentence — never a bare status. */
const fail = (error) => ({
  status: Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500,
  body: refusalBody(error),
});

/**
 * The deploy's own pin — `RWP_APP_VERSION`, the tag a release workflow checked out and exported in the
 * same step. It cannot lag behind the code actually running, so it wins over every other source.
 */
const pinnedVersion = () => String(process.env.RWP_APP_VERSION || '').trim().replace(/^v/i, '');

/**
 * The `package.json` this build was compiled from. The fallback of last resort: it is the template's
 * version for a provisioned site, which is exactly what the SaaS installer's record corrects.
 */
export async function packageVersion() {
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    return String(JSON.parse(raw)?.version || '').trim();
  } catch {
    return '';
  }
}

/**
 * The version this build reports when no SaaS installer record names a release tag.
 *
 * `RWP_APP_VERSION` wins when the deployment pins it to the release tag it was built from, which is the
 * only value that cannot lag: a release workflow that checks out `v2.4.1` can export `2.4.1` in the same
 * step. Otherwise the build's own `package.json` is the answer. Cached after the first read, because this
 * file cannot change while the process runs.
 */
let installedVersionCache = '';

export async function installedVersion() {
  if (installedVersionCache) return installedVersionCache;
  installedVersionCache = pinnedVersion() || await packageVersion();
  return installedVersionCache;
}

/**
 * The version this host reports as installed: the pin, the installer's record, else the manifest —
 * `resolveInstalledVersion`'s order, the same one `src/server/routes/updates.ts` applies.
 *
 * The newest published release is *never* used as a stand-in for "installed": that would make every site
 * built without a pin report itself up to date, hiding exactly the update this screen exists to offer.
 */
const installedFor = async (stored) =>
  resolveInstalledVersion({
    pinned: pinnedVersion(),
    saas: stored.installed,
    fallback: await packageVersion(),
  });

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

const bearer = (headers) => (headers?.authorization || '').replace(/^Bearer\s+/i, '');

/**
 * Who sees the owner's latest-commit view (Dashboard → Updates when OWNER_GITHUB_REPO is set): the platform owner
 * — an administrator or super_admin, narrowed to RWP_OWNER_EMAIL when that is set — whatever the update-channel
 * role is. Only the commit view widens; the release source, deploy hook and Update now still follow viewerOwner.
 */
const viewerCommitOwner = async (config, headers) => {
  if (!ownerCommitView(true)) return false;
  const permission = await authorizePlatformOwner(config?.supabaseUrl, config?.supabasePublishableKey, bearer(headers));
  return permission.ok;
};

/** Whether the caller is the update owner — the Setup Wizard's `administrator` — who alone may apply. */
const viewerOwner = async (config, headers) =>
  isUpdateOwnerRole(await currentUserRole(config?.supabaseUrl, config?.supabasePublishableKey, bearer(headers)));

/** Whether the caller may see the version picker: the update owner, or the platform owner. */
const viewerMayPick = async (config, headers, owner) => {
  if (owner) return true;
  return (await authorizePlatformOwner(config?.supabaseUrl, config?.supabasePublishableKey, bearer(headers))).ok;
};

/** GET /api/admin/updates — everything the screen needs before it offers a button. */
async function overview({ config, headers, readOptions, owner, commitOwner }) {
  const stored = await readUpdatesConfig(readOptions);
  const support = await selfUpdateSupport();
  return {
    installed: await installedFor(stored),
    config: describeUpdateConfig(stored.config, owner),
    /** The repository a release list is read from, and whether a GitHub token is used. Never the token. */
    github: describeGithubSource(stored.github, owner),
    /** False when this server cannot read `system_settings` at all: the saved settings exist but are invisible. */
    readable: stored.readable,
    error: owner ? stored.error : '',
    support,
    /** Whether "let this server update its own checkout" can ever apply here: a git checkout on this machine. */
    can_self_update: owner && support.repo === true,
    /** Whether this site deploys from its own GitHub repository: the core update is then how it updates. */
    git_deploy: (await viewerMayPick(config, headers, owner)) ? await gitDeployConnectedFor(config, headers) : false,
    plugin_directory: PLUGIN_DIRECTORY_PATH,
    auto_check: AUTO_CHECK_KEYS,
    owner_commit_view: ownerCommitView(commitOwner),
  };
}

/** POST /api/admin/updates/check { plugins? } */
async function check(body, config, headers, readOptions, owner) {
  const stored = await readUpdatesConfig(readOptions);
  return checkResponse({
    stored,
    installed: await installedFor(stored),
    plugins: installedPluginsFrom(body.plugins),
    owner,
    latestCommit: await latestCommitFor({ owner: await viewerCommitOwner(config, headers) }),
  });
}

/** POST /api/admin/updates/releases { refresh? } */
async function releases(body, config, headers, readOptions, owner) {
  if (!(await viewerMayPick(config, headers, owner))) {
    throw new UpdateError('Only the site owner can choose a version. Ask the Administrator to open Dashboard → Updates.', 403);
  }
  const stored = await readUpdatesConfig(readOptions);
  return releasesResponse({ stored, installed: await installedFor(stored), owner, force: body.refresh === true });
}

/** POST /api/admin/system/update { tag?, confirmDowngrade?, plugins? } — see `applyResponse`. */
async function applyUpdate(body, headers, config, readOptions, readDeployHook, owner) {
  const stored = await readUpdatesConfig(readOptions);
  // Asked only for the owner, and only now: the hook is a database read, and most calls end at `up_to_date`.
  const deployHook = owner ? String((await readDeployHook().catch(() => '')) || '').trim() : '';
  return applyResponse({
    body,
    stored,
    installed: await installedFor(stored),
    plugins: installedPluginsFrom(body.plugins),
    owner,
    deployHook,
    selfSupport: await selfUpdateSupport(),
    gitDeploy: owner ? await gitDeployConnectedFor(config, headers) : false,
    env: process.env,
  });
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
 * Returns null when the path is not one of the five, so `server.mjs` can fall through to
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
    || pathname === '/api/admin/updates/releases'
    || pathname === '/api/admin/system/update'
    || pathname === '/api/admin/system/update-status';
  if (!owned) return null;
  try {
    await requireManager(config, headers);
    const owner = await viewerOwner(config, headers);
    if (pathname === '/api/admin/updates') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      return { status: 200, body: await overview({ config, headers, readOptions, owner, commitOwner: await viewerCommitOwner(config, headers) }) };
    }
    if (pathname === '/api/admin/system/update-status') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      return { status: 200, body: await updateStatus(query) };
    }
    if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
    const input = body && typeof body === 'object' ? body : {};
    if (pathname === '/api/admin/updates/check') {
      return { status: 200, body: await check(input, config, headers, readOptions, owner) };
    }
    if (pathname === '/api/admin/updates/releases') {
      return { status: 200, body: await releases(input, config, headers, readOptions, owner) };
    }
    return await applyUpdate(input, headers, config, readOptions, readDeployHook, owner);
  } catch (error) {
    if (!(error instanceof UpdateError) && !error?.status) console.error(`${pathname} failed:`, error);
    return fail(error);
  }
}

/**
 * Settings → Updates, on the classic host (`node server.mjs`).
 *
 * Four routes, and the same JSON the universal engine answers (`src/server/routes/updates.ts`) — both
 * call the same shared module, `server/updateCenter.mjs`, so the two hosts cannot disagree about whether
 * an update exists or how it is applied:
 *
 *   GET  /api/admin/updates                 what is installed, how it is configured, what this host can do
 *   POST /api/admin/updates/check           read the release tags of the repository Settings → Updates
 *                                           names, else ask `react-wp.com` (when a token is stored), else
 *                                           read this deployment's own GitHub release tags
 *   POST /api/admin/system/update           apply one: call the deploy hook, or start a self-update run
 *   GET  /api/admin/system/update-status    how a self-update run is going, plus the recent ones
 *
 * The owner (`administrator`) sees those four sources and the three ways to apply a release. A *managed*
 * site — every other signed-in account — sees one source and one way: the check is answered by
 * `react-wp.com`, and Update now installs the package it publishes. No route here can put an end user on
 * the GitHub feed, a deploy hook or a git checkout, and none of them is offered a sentence that names one.
 *
 * Nothing here takes the update token from the browser. The configuration lives in
 * `system_settings.updates_config` (or `RWP_UPDATE_TOKEN`, for a host that was handed the connection
 * through its environment) and is read server-side through `readIntegrationRows`, so the token reaches
 * `react-wp.com` and nothing else. The browser is told only `has_token` — see `describeUpdateConfig` — and
 * it never calls GitHub at all, which is what makes a private repository private. The GitHub credential a
 * direct check uses never leaves the server either.
 *
 * `handleUpdateRequest` returns `null` for a path that is not one of the four, the same contract
 * `handleAdminRequest` has, so `server.mjs` chains the two.
 */
import { readFile } from 'node:fs/promises';
import { authorizePluginManager } from './pluginFiles.mjs';
import { currentUserRole, isUpdateOwnerRole } from './integrationSettings.mjs';
import {
  AUTO_CHECK_KEYS,
  PLUGIN_DIRECTORY_PATH,
  UpdateError,
  UPDATE_CHANNELS,
  applyDeployHookUpdate,
  centralApplyUrl,
  checkForUpdates,
  describeGithubSource,
  describeUpdateConfig,
  installedPluginsFrom,
  latestPublishedVersion,
  managedUpdateSupport,
  platformRedeployFrom,
  platformUpdatePlan,
  readUpdatesConfig,
  requestPlatformInstall,
  resolveInstalledVersion,
  siteAddressFrom,
  updatePlan,
} from './updateCenter.mjs';
import {
  listSelfUpdateRuns,
  packageUpdateSupport,
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
 * The version this host reports as installed: the pin, the installer's record, the release this platform
 * publishes, else the manifest — `resolveInstalledVersion`'s order, and the same one
 * `src/server/routes/updates.ts` applies, so the two hosts cannot disagree about it.
 *
 * The release step is the owner's alone. A managed site is told what it runs by the installer that
 * deployed it (`RWP_APP_VERSION`), and it must never read GitHub; the platform that *publishes* the
 * releases has no such record, so its own newest tag is the only honest answer — and it is the number
 * Settings → Integrations → SaaS Installer already prints as "Latest".
 */
const installedFor = async (stored, owner = true) =>
  resolveInstalledVersion({
    pinned: pinnedVersion(),
    saas: stored.installed,
    release: owner ? await latestPublishedVersion({ source: stored.github, channel: stored.config.channel }) : '',
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

/**
 * Whether the caller is the update owner — the Setup Wizard's `administrator` — who alone may see where
 * updates come from. A provisioned `super_admin` (or a role granted `manage_options`) is an end user, so
 * this answers `false` and the routes below redact GitHub and force the central source.
 */
const viewerOwner = async (config, headers) => {
  const token = (headers?.authorization || '').replace(/^Bearer\s+/i, '');
  return isUpdateOwnerRole(await currentUserRole(config?.supabaseUrl, config?.supabasePublishableKey, token));
};

/**
 * The plugin versions the screen reported, cleaned up — `installedPluginsFrom`'s rules, called through
 * the shared module so both hosts accept exactly the same list.
 */
const pluginList = (value) => installedPluginsFrom(value);

/** GET /api/admin/updates — everything the screen needs before it offers a button. */
async function overview({ readOptions, owner = true }) {
  const stored = await readUpdatesConfig(readOptions);
  // An end user's site installs a package and nothing else: the probe behind `selfUpdateSupport` (a git
  // checkout, a deploy hook) describes ways of updating that are not theirs to choose, so the two branches
  // answer with the one that is. `managedUpdateSupport` also replaces the host's technical refusal with the
  // sentence a customer can act on — and with `platform: true` it reports the third way a managed site has,
  // where the platform rebuilds a host that cannot install a package at all (see `platformRedeployFrom`).
  const support = owner
    ? await selfUpdateSupport()
    : managedUpdateSupport({ ...(await packageUpdateSupport()), platform: platformRedeployFrom(stored.config) });
  const installed = await installedFor(stored, owner);
  return {
    installed,
    config: describeUpdateConfig(stored.config, owner),
    /** The repository a direct read uses, and whether a credential came with it. End users never see this. */
    github: describeGithubSource(stored.github, owner),
    /**
     * False when this server cannot read `system_settings` at all: the token is stored, not missing. The
     * sentence that goes with it names the table and the environment, so it is the owner's alone.
     */
    readable: stored.readable,
    error: owner ? stored.error : '',
    support,
    /** Where a plugin catalogue would be asked for, so the screen can say where installs come from. */
    plugin_directory: PLUGIN_DIRECTORY_PATH,
    channels: UPDATE_CHANNELS,
    auto_check: AUTO_CHECK_KEYS,
  };
}

/** POST /api/admin/updates/check { plugins?: [{ id, name?, version }], site? } */
async function check(body, config, readOptions, owner = true) {
  const stored = await readUpdatesConfig(readOptions);
  const plugins = pluginList(body.plugins);
  const installed = await installedFor(stored, owner);
  const answer = await checkForUpdates({
    config: stored.config,
    current: { app: installed, site: String(body.site || '').trim() },
    plugins,
    github: stored.github,
    owner,
  });
  // `readable: false` is worth saying even when the check succeeded: it means this server could not see
  // the stored rows, so the administrator knows why a configured source looks unconfigured before they go
  // looking in the wrong place. `source` is the engine's word for the source that answered (`central` or
  // `github`), so the screen can name it without guessing from the release itself.
  return {
    ...answer,
    config: describeUpdateConfig(stored.config, owner),
    github: describeGithubSource(stored.github, owner),
    readable: stored.readable,
  };
}

/**
 * POST /api/admin/system/update { plugins?: [...], ref? }
 *
 * One route for three ways of applying an update, because the *decision* belongs on the server: the
 * browser asks for an update, and `updatePlan` says what this host can actually do. The three answers are
 * shaped differently on purpose — a started rebuild, a started run, and a refusal that names what to
 * configure — and each carries the check it was based on, so the screen never has to guess which release
 * it just asked for.
 *
 * `headers` is here for one thing: a managed site that the platform has to rebuild names itself, and when
 * the body carries no address the request's own host is the honest one (`siteAddressFrom`).
 */
async function applyUpdate(body, headers, config, readOptions, readDeployHook, owner = true) {
  const stored = await readUpdatesConfig(readOptions);
  const installed = await installedFor(stored, owner);
  const plugins = pluginList(body.plugins);
  const answer = await checkForUpdates({
    config: stored.config,
    current: { app: installed, site: String(body.site || '').trim() },
    plugins,
    github: stored.github,
    owner,
  });
  const reported = {
    ...answer,
    config: describeUpdateConfig(stored.config, owner),
    github: describeGithubSource(stored.github, owner),
    readable: stored.readable,
  };
  // A managed site's update is applied natively by this server, from a package the central server built.
  // Core-only by construction: the package carries the core release with `plugins/` stripped, and nothing
  // about a plugin travels in either direction. No Vercel token, no deploy hook, no GitHub name.
  if (!owner) {
    if (!answer.app.update_available) {
      return {
        status: 200,
        body: {
          mode: 'self',
          up_to_date: true,
          plan: { mode: 'self', up_to_date: true, reason: `This site already runs ${installed}, the latest release react-wp.com publishes.`, steps: [] },
          check: reported,
        },
      };
    }
    // Asked before the run starts, because `startSelfUpdate` refuses with the probe's own sentence and that
    // sentence is about a filesystem this reader cannot do anything about. A host that cannot install a
    // package answers `managedUpdateSupport`'s reason: contact support, who apply it for them.
    const support = managedUpdateSupport({
      ...(await packageUpdateSupport()),
      platform: platformRedeployFrom(stored.config),
    });
    // …unless the platform is the one that rebuilds it. A prebuilt Vercel deployment — read-only files, no
    // `dist/` in its repository — cannot install a package, and the platform that provisioned it can: it
    // builds the release and uploads it to this site's own project, from the address the site names. That is
    // `platformUpdatePlan`'s `mode: 'platform'`, and the work happens beyond this server, so the answer says
    // which project and which version rather than reporting steps that are not this host's.
    if (support.mode === 'platform') {
      const plan = platformUpdatePlan({ latestVersion: answer.app.latest, installedVersion: installed });
      if (plan.up_to_date) return { status: 200, body: { ...plan, check: reported } };
      const install = await requestPlatformInstall({
        config: stored.config,
        // The body first (a script or a test may name the site it means), else the host that was asked.
        site: siteAddressFrom(headers, { site: body.site }),
        version: answer.app.latest,
        env: process.env,
      });
      return { status: 200, body: { ...install, plan, check: reported } };
    }
    if (!support.supported) throw new UpdateError(support.reason, 409);
    const run = await startSelfUpdate({
      to: answer.app.latest,
      from: installed,
      source: 'package',
      package: {
        url: centralApplyUrl(stored.config),
        token: stored.config.token,
        site: String(body.site || '').trim(),
      },
    });
    return {
      status: 202,
      body: {
        mode: 'self',
        run,
        plan: {
          mode: 'self',
          reason: `React-WP.com is sending the ${answer.app.latest} release package; this server downloads and applies it.`,
          steps: ['downloading', 'extracting', 'applying', 'installing-packages', 'building', 'restarting'],
        },
        check: reported,
      },
    };
  }
  // Asked only now: the deploy hook is a database read, and most calls to this route end at `up_to_date`.
  const deployHook = String((await readDeployHook().catch(() => '')) || '').trim();
  const support = await selfUpdateSupport();
  // Core only: the plan, the deploy hook and the self-updater act on the core release (`answer.app.latest`),
  // never on a plugin release. Plugin updates have their own lifecycle under Plugins → Installed.
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
async function updateStatus(query, readOptions, owner = true) {
  if (query.id) {
    const run = await readSelfUpdateRun(query.id);
    if (!run) throw new UpdateError('That update run does not exist on this server, or it was cleaned up.', 404);
    return { run, log: await readSelfUpdateLog(run.id) };
  }
  // Same support answer as `overview`: a managed site is only ever told about the package it can install —
  // or, when it has a token for the platform, about the redeploy the platform does for it. The stored config
  // is read for that one bit and only for an end user; the owner's answer never depends on it.
  const stored = await readUpdatesConfig(readOptions);
  const support = owner
    ? await selfUpdateSupport()
    : managedUpdateSupport({ ...(await packageUpdateSupport()), platform: platformRedeployFrom(stored.config) });
  return { runs: await listSelfUpdateRuns(), support };
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
    const owner = await viewerOwner(config, headers);
    if (pathname === '/api/admin/updates') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      return { status: 200, body: await overview({ config, readOptions, owner }) };
    }
    if (pathname === '/api/admin/system/update-status') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      return { status: 200, body: await updateStatus(query, readOptions, owner) };
    }
    if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
    if (pathname === '/api/admin/updates/check') {
      return { status: 200, body: await check(body, config, readOptions, owner) };
    }
    return await applyUpdate(body, headers, config, readOptions, readDeployHook, owner);
  } catch (error) {
    if (!(error instanceof UpdateError)) console.error(`${pathname} failed:`, error);
    return fail(error);
  }
}

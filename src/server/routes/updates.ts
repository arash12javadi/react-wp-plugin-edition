/**
 * Settings → Updates on every host that runs the universal engine, at the paths `server.mjs` serves:
 *
 *   GET  /api/admin/updates                 what is installed, how it is configured, what this host can do
 *   POST /api/admin/updates/check           read the release tags of the repository Settings → Updates
 *                                           names, else ask `react-wp.com` (when a token is stored), else
 *                                           read this deployment's own GitHub release tags
 *   POST /api/admin/system/update           apply one: call the deploy hook, or start a self-update run
 *   GET  /api/admin/system/update-status    how a self-update run is going, plus the recent ones
 *
 * The work is `server/updateCenter.mjs` — version comparison, the central check with a direct GitHub
 * release-tag read as the other source, and the decision about how an update is applied — so a Vercel
 * deployment and `npm start` cannot disagree about whether an update exists. What this file adds is the
 * engine's own half:
 *
 *   - **Who may ask.** `requirePluginManager`'s rule (Settings → Integrations uses it too), through this
 *     engine's auth adapter, because an update installs code.
 *   - **Where the token comes from.** `system_settings.updates_config`, read server-side through
 *     `integrationReadOptions` — the same reader the GitHub and deploy-hook credentials use. The browser
 *     is never sent the token, and never calls GitHub: `describeUpdateConfig` masks it as `has_token`.
 *   - **Which version is running.** `RWP_APP_VERSION` when the deploy pins it to the tag it built from,
 *     else `package.json`, inlined at build time. The check compares *the running build* against a
 *     published release tag; a client that could name its own version could hide an update from itself.
 *   - **What "apply" means here.** `pluginHostMode` decides. A host with a writable checkout can rewrite
 *     itself (`server/selfUpdate.mjs`: fetch, install, build, restart). A serverless deployment cannot —
 *     its disk does not survive the request — so it is updated through its deploy hook, and the plan says
 *     so instead of starting work that would fail halfway through.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { version as packageVersion } from '../../../package.json';
import type { RuntimeConfig } from '../../lib/runtime';
import { ensureSiteInstalled, getRuntimeConfig } from '../config';
import { detectPluginHostMode } from '../pluginHostMode';
import {
  HttpError,
  deployHookUrl,
  integrationReadOptions,
  messageOf,
  requirePluginManager,
  statusOf,
} from '../pluginHostAccess';
import { currentUserRole, isUpdateOwnerRole } from '../../../server/integrationSettings.mjs';
import {
  AUTO_CHECK_KEYS,
  PLUGIN_DIRECTORY_PATH,
  UPDATE_CHANNELS,
  applyCentralUpdate,
  applyDeployHookUpdate,
  checkForUpdates,
  describeGithubSource,
  describeUpdateConfig,
  installedPluginsFrom,
  readUpdatesConfig,
  resolveInstalledVersion,
  updatePlan,
} from '../../../server/updateCenter.mjs';
import {
  listSelfUpdateRuns,
  readSelfUpdateLog,
  readSelfUpdateRun,
  selfUpdateSupport,
  startSelfUpdate,
} from '../../../server/selfUpdate.mjs';

export const updatesRouter = new Hono();

/**
 * The version this build reports.
 *
 * `RWP_APP_VERSION` wins when the deployment pins it to the release tag it was built from — a release
 * workflow that checks out `v2.4.1` can export `2.4.1` in the same step, and that is the only value that
 * cannot lag behind the code actually running. Otherwise `package.json`, which the same workflow writes
 * immediately before pushing the tag, is the answer. Read on the server, never sent by the browser.
 *
 * A provisioned site's `package.json` is the *template's* version, so a third source outranks it: the tag
 * the SaaS installer recorded in `saas_installer_config.installed_version`, which `readUpdatesConfig`
 * returns and `installedFor` folds into the same order both hosts share.
 */
const pinnedAppVersion = String(process.env.RWP_APP_VERSION || '').trim().replace(/^v/i, '');
const packageAppVersion = String(packageVersion || '').trim();

/** The installed version, resolving the SaaS installer's recorded tag ahead of the static manifest. */
const installedFor = (stored: { installed: string }) =>
  resolveInstalledVersion({ pinned: pinnedAppVersion, saas: stored.installed, fallback: packageAppVersion });

/**
 * Everything that can be refused with a status before any work starts: whether this site is installed,
 * and who is asking. The auto-heal comes first, exactly as it does on the plugin routes, so a site that
 * is configured but was never marked installed is repaired rather than told to go and run SQL.
 */
async function prepare(c: Context): Promise<RuntimeConfig> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  let config = await getRuntimeConfig();
  if (!config.installed) config = await ensureSiteInstalled();
  if (!config.installed) throw new HttpError(409, 'This site is not installed yet, so updates cannot be managed.');
  await requirePluginManager(token, config);
  return config;
}

/**
 * Whether the caller owns the update channel — the Setup Wizard's `administrator` — and may therefore see
 * where updates come from. A provisioned `super_admin` (or a role granted `manage_options`) is an end
 * user: their check is answered by `react-wp.com` and their screen never names GitHub.
 *
 * Under Supabase the role is resolved from `public.profiles`; every other backend is a self-hosted
 * checkout, whose administrator is its owner.
 */
const viewerOwner = async (config: RuntimeConfig, c: Context): Promise<boolean> => {
  if (config.dbType !== 'supabase') return true;
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  return isUpdateOwnerRole(await currentUserRole(config.supabaseUrl || '', config.supabasePublishableKey || '', token));
};

/** The one shape a refusal takes here: the `{ error }` body both hosts answer with. */
const fail = (c: Context, error: unknown) =>
  c.json(
    { error: messageOf(error) },
    (error instanceof HttpError ? error.status : statusOf(error) ?? 500) as ContentfulStatusCode,
  );

/** A JSON body, or `{}` — `installedPluginsFrom` drops whatever it does not understand. */
const readJson = async (c: Context): Promise<Record<string, unknown>> =>
  (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

/**
 * Whether this host can rewrite its own checkout, with the sentence to show when it cannot.
 *
 * `pluginHostMode` is the authority: it probes for a writable `plugins/` and `.rwp-tmp/`, and answers
 * `github` on a serverless platform. Asking `serverUpdateSupport` there would be worse than useless — it
 * would report "not a git checkout", which is a statement about a filesystem the function does not have —
 * so the reason names the platform and the two ways an update actually happens on one.
 */
async function selfSupport() {
  if (await detectPluginHostMode() !== 'local') {
    return {
      available: true,
      repo: false,
      supported: false,
      reason: 'This deployment is built by its platform and has no checkout to rewrite, so an update is applied by starting a build: save a deploy hook under Settings → Integrations → Deployments, or push the new version to the repository it builds from.',
    };
  }
  return selfUpdateSupport();
}

/**
 * `GET /api/admin/updates` — everything the screen needs before it offers a button.
 *
 * `readable: false` is the interesting field: this deployment stores a token but cannot see
 * `system_settings` (a Supabase URL with no direct connection and no service key), so the check will fall
 * back to this deployment's own GitHub release tags. Saying that here keeps the screen from asking the
 * administrator to paste a token that is already stored.
 */
async function overview(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    return c.json({
      installed: installedFor(stored),
      config: describeUpdateConfig(stored.config, owner),
      github: describeGithubSource(stored.github, owner),
      readable: stored.readable,
      error: stored.error,
      support: await selfSupport(),
      plugin_directory: PLUGIN_DIRECTORY_PATH,
      channels: UPDATE_CHANNELS,
      auto_check: AUTO_CHECK_KEYS,
    });
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * `POST /api/admin/updates/check { plugins?: [{ id, name?, version }], site? }`
 *
 * The plugin list comes from the browser because only it knows which plugins this build activates —
 * `rwp.getPlugins()` after `rwp_active_plugins` is applied. It is used for one thing: telling the central
 * server what to compare against.
 */
async function check(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    const body = await readJson(c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    const answer = await checkForUpdates({
      config: stored.config,
      current: { app: installedFor(stored), site: String(body.site || '').trim() },
      plugins: installedPluginsFrom(body.plugins),
      github: stored.github,
      owner,
    });
    // The configuration goes back with the answer, with the token replaced by `has_token`: the screen
    // shows which source replied, and `readable: false` explains why a stored token looked unconfigured.
    return c.json({
      ...answer,
      config: describeUpdateConfig(stored.config, owner),
      github: describeGithubSource(stored.github, owner),
      readable: stored.readable,
    });
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * `POST /api/admin/system/update { plugins?: [...], ref? }`
 *
 * One route for three ways of applying an update, because the decision belongs here: the browser asks for
 * an update and `updatePlan` says what this host can actually do with one. The three answers are shaped
 * differently on purpose — a started rebuild, a started run, a refusal that names what to configure — and
 * each carries the check it was based on, so the screen never has to guess which release it just asked for.
 */
async function applyUpdate(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    const body = await readJson(c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    const installed = installedFor(stored);
    const answer = await checkForUpdates({
      config: stored.config,
      current: { app: installed, site: String(body.site || '').trim() },
      plugins: installedPluginsFrom(body.plugins),
      github: stored.github,
      owner,
    });
    const reported = {
      ...answer,
      config: describeUpdateConfig(stored.config, owner),
      github: describeGithubSource(stored.github, owner),
      readable: stored.readable,
    };
    // A managed site's update is applied by the platform (react-wp.com), never by this host. Core-only by
    // construction: `to` is the core release (`answer.app.latest`) and nothing about a plugin travels here.
    if (!owner) {
      if (!answer.app.update_available) {
        return c.json({
          mode: 'central',
          up_to_date: true,
          reason: `This site already runs ${installed}, the latest release react-wp.com publishes.`,
          check: reported,
        });
      }
      const result = await applyCentralUpdate({
        config: stored.config,
        current: { app: installed, site: String(body.site || '').trim() },
        to: answer.app.latest,
      });
      return c.json(
        { ...result, plan: { mode: 'central', reason: result.message }, check: reported },
        (result.queued ? 200 : 502) as ContentfulStatusCode,
      );
    }
    // Asked only now: the hook is a database read, and most calls to this route end at `up_to_date`.
    const deployHook = await deployHookUrl(config).catch(() => '');
    const support = await selfSupport();
    // Core only: the plan, the deploy hook and the self-updater act on the core release
    // (`answer.app.latest`), never on a plugin release. Plugin updates have their own lifecycle.
    const plan = updatePlan({
      config: stored.config,
      deployHook,
      selfUpdate: support.supported,
      latestVersion: answer.app.latest,
      installedVersion: installed,
    });

    if (plan.up_to_date) return c.json({ ...plan, check: reported });
    if (plan.mode === 'manual') {
      // 409: nothing is wrong with the request, this host simply has nowhere to send an update —
      // `plan.reason` names the two things that would give it one.
      return c.json({ ...plan, check: reported }, 409 as ContentfulStatusCode);
    }
    if (plan.mode === 'deploy-hook') {
      // The hook is a pre-shared secret: `applyDeployHookUpdate` reports whether it was called and what
      // it answered, never the URL. 502 on a refusal — the request was fine, the platform was not.
      const result = await applyDeployHookUpdate({ deployHook });
      return c.json(
        { ...result, plan, check: reported },
        (result.queued ? 200 : 502) as ContentfulStatusCode,
      );
    }
    const run = await startSelfUpdate({
      to: answer.app.latest,
      from: installed,
      ref: String(body.ref || '').trim(),
    });
    // 202: accepted, not finished. The screen polls `update-status?id=` with the id it just got.
    return c.json({ mode: 'self', run, plan, check: reported }, 202 as ContentfulStatusCode);
  } catch (error) {
    return fail(c, error);
  }
}

/** `GET /api/admin/system/update-status?id=<run>` — one run with its log, or the recent ones. */
async function updateStatus(c: Context): Promise<Response> {
  try {
    await prepare(c);
    const id = c.req.query('id') || '';
    if (!id) return c.json({ runs: await listSelfUpdateRuns(), support: await selfSupport() });
    const run = await readSelfUpdateRun(id);
    if (!run) throw new HttpError(404, 'That update run does not exist on this server, or it was cleaned up.');
    return c.json({ run, log: await readSelfUpdateLog(id) });
  } catch (error) {
    return fail(c, error);
  }
}

updatesRouter.get('/updates', overview);
updatesRouter.post('/updates/check', check);
updatesRouter.post('/system/update', applyUpdate);
updatesRouter.get('/system/update-status', updateStatus);

/**
 * Any other verb on those four paths is a 405 with the body the classic host answers, registered after
 * the handlers above so `GET`/`POST` still win. Without it the engine would leave the path unmatched and
 * answer Hono's own 404 — the same mistake answered two different ways depending on which host served it.
 */
for (const path of ['/updates', '/updates/check', '/system/update', '/system/update-status']) {
  updatesRouter.all(path, (c) => c.json({ error: 'Method not allowed' }, 405));
}


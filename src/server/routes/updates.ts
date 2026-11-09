/**
 * Dashboard → Updates on every host that runs the universal engine, at the paths `server.mjs` serves:
 *
 *   GET  /api/admin/updates                 what is installed, how it is configured, what this host can do
 *   POST /api/admin/updates/check           read the stable release tags of the release repository from
 *                                           GitHub and compare the newest with what is installed
 *   POST /api/admin/updates/releases        the five most recent stable releases, for the version picker
 *   POST /api/admin/system/update           apply one of those releases: deploy hook, or a self-update run
 *   GET  /api/admin/system/update-status    how a self-update run is going, plus the recent ones
 *
 * The work is shared with the classic host: `server/updateCenter.mjs` (versions, the check, the plan),
 * `server/releaseList.mjs` (the five releases, cached) and `server/updateFlow.mjs` (what each route decides
 * and answers), so a Vercel deployment and `npm start` cannot disagree about whether an update exists.
 * Releases come **straight from GitHub** — the public release repository unless Dashboard → Updates names
 * another — and nothing here calls react-wp.com. What this file adds is the engine's own half:
 *
 *   - **Who may ask.** `requirePluginManager`'s rule (Settings → Integrations uses it too), through this
 *     engine's auth adapter, because an update installs code. The version picker is open to the platform
 *     owner, and applying is the site owner's (`administrator`) alone.
 *   - **Where the settings come from.** `system_settings.updates_config` and the optional GitHub token,
 *     read server-side through `integrationReadOptions`. No answer carries a token.
 *   - **Which version is running.** `RWP_APP_VERSION` when the deploy pins it to the tag it built from,
 *     else `package.json`, inlined at build time. The check compares *the running build* against a
 *     published release tag; a client that could name its own version could hide an update from itself.
 *   - **What "apply" means here.** `pluginHostMode` decides. A host with a writable checkout can rewrite
 *     itself (`server/selfUpdate.mjs`: fetch, install, build, restart). A serverless deployment cannot —
 *     its disk does not survive the request — so it is updated through its deploy hook, or, when it is
 *     connected to its own GitHub repository and Vercel project, through the core update.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import packageManifest from '../../../package.json';
import type { RuntimeConfig } from '../../lib/runtime';
import { ensureSiteInstalled, getRuntimeConfig } from '../config';
import { detectPluginHostMode } from '../pluginHostMode';
import {
  HttpError,
  deployHookUrl,
  integrationReadOptions,
  requirePluginManager,
} from '../pluginHostAccess';
import { authorizePlatformOwner, currentUserRole, isUpdateOwnerRole } from '../../../server/integrationSettings.mjs';
import { gitDeploysFor } from '../deployment';
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
} from '../../../server/updateCenter.mjs';
import { applyResponse, checkResponse, refusalBody, releasesResponse } from '../../../server/updateFlow.mjs';
import { installedVersionFor } from '../../../server/installedVersion.mjs';
import {
  listSelfUpdateRuns,
  readSelfUpdateLog,
  readSelfUpdateRun,
  selfUpdateSupport,
} from '../../../server/selfUpdate.mjs';

export const updatesRouter = new Hono();

/** What `readUpdatesConfig` answers, as far as the version question is concerned. */
interface StoredUpdateConfig {
  installed: string;
}

/** The version this build reports — `server/installedVersion.mjs`, the same answer the classic host gives. */
const installedFor = (stored: StoredUpdateConfig): Promise<string> =>
  installedVersionFor({ saas: stored.installed, fallback: String(packageManifest.version || ''), manifest: packageManifest });

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

const bearer = (c: Context): string => (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');

/**
 * Who sees the owner's latest-commit view (Dashboard → Updates when OWNER_GITHUB_REPO is set): the platform owner
 * — an administrator or super_admin, narrowed to RWP_OWNER_EMAIL when that is set. Only the commit view widens;
 * the release source, deploy hook and Update now still follow `viewerOwner`.
 */
const viewerCommitOwner = async (config: RuntimeConfig, c: Context): Promise<boolean> => {
  if (!ownerCommitView(true)) return false;
  if (config.dbType !== 'supabase') return true;
  const permission = await authorizePlatformOwner(config.supabaseUrl || '', config.supabasePublishableKey || '', bearer(c));
  return permission.ok;
};

/**
 * Whether the caller is the update owner — the Setup Wizard's `administrator` — who alone may apply an
 * update. Under Supabase the role is resolved from `public.profiles`; every other backend is a self-hosted
 * checkout, whose administrator is its owner.
 */
const viewerOwner = async (config: RuntimeConfig, c: Context): Promise<boolean> => {
  if (config.dbType !== 'supabase') return true;
  return isUpdateOwnerRole(await currentUserRole(config.supabaseUrl || '', config.supabasePublishableKey || '', bearer(c)));
};

/** Whether the caller may see the version picker: the update owner, or the platform owner. */
const viewerMayPick = async (config: RuntimeConfig, c: Context, owner: boolean): Promise<boolean> => {
  if (owner || config.dbType !== 'supabase') return true;
  return (await authorizePlatformOwner(config.supabaseUrl || '', config.supabasePublishableKey || '', bearer(c))).ok;
};

/** The one shape a refusal takes here: `{ error }` — always a sentence — plus whatever the refusal adds. */
const fail = (c: Context, error: unknown) => {
  const status = Number((error as { status?: number })?.status);
  const known = error instanceof HttpError || error instanceof UpdateError || (status >= 400 && status < 600);
  if (!known) console.error('updates route failed:', error instanceof Error ? error.message : error);
  return c.json(refusalBody(error), (status >= 400 && status < 600 ? status : 500) as ContentfulStatusCode);
};

/** A JSON body, or `{}` — `installedPluginsFrom` drops whatever it does not understand. */
const readJson = async (c: Context): Promise<Record<string, unknown>> =>
  (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

/**
 * Whether this host can rewrite its own checkout, with the sentence to show when it cannot.
 *
 * `pluginHostMode` is the authority: it probes for a writable `plugins/` and `.rwp-tmp/`, and answers
 * `github` on a serverless platform. Asking `serverUpdateSupport` there would be worse than useless — it
 * would report "not a git checkout", which is a statement about a filesystem the function does not have —
 * so the reason names the platform and the ways an update actually happens on one.
 */
async function selfSupport() {
  if (await detectPluginHostMode() !== 'local') {
    return {
      available: true,
      repo: false,
      supported: false,
      reason: 'This deployment is built by its platform and has no checkout to rewrite, so an update is applied by starting a build: connect the site to its own GitHub repository and Vercel project (Settings → Integrations → GitHub & Vercel), or save a deploy hook under Settings → Integrations → Deployments.',
    };
  }
  return selfUpdateSupport();
}

/**
 * `GET /api/admin/updates` — everything the screen needs before it offers a button.
 *
 * `readable: false` is the interesting field: this deployment stores its settings but cannot see
 * `system_settings` (a Supabase URL with no direct connection and no service key), so the screen shows
 * defaults. Saying that here keeps the screen from presenting them as the administrator's choice.
 */
async function overview(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    const support = await selfSupport();
    return c.json({
      installed: await installedFor(stored),
      config: describeUpdateConfig(stored.config, owner),
      github: describeGithubSource(stored.github, owner),
      readable: stored.readable,
      // The sentence behind `readable: false` names the table and the environment, so it is the owner's.
      error: owner ? stored.error : '',
      support,
      can_self_update: owner && support.repo === true,
      git_deploy: (await viewerMayPick(config, c, owner)) ? await gitDeploysFor(config, bearer(c)) : false,
      plugin_directory: PLUGIN_DIRECTORY_PATH,
      auto_check: AUTO_CHECK_KEYS,
      owner_commit_view: ownerCommitView(await viewerCommitOwner(config, c)),
    });
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * `POST /api/admin/updates/check { plugins? }`
 *
 * The plugin list comes from the browser because only it knows which plugins this build activates —
 * `rwp.getPlugins()` after `rwp_active_plugins` is applied. It only names plugins in the answer.
 */
async function check(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    const body = await readJson(c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    return c.json(await checkResponse({
      stored,
      installed: await installedFor(stored),
      plugins: installedPluginsFrom(body.plugins),
      owner,
      latestCommit: await latestCommitFor({ owner: await viewerCommitOwner(config, c) }),
    }));
  } catch (error) {
    return fail(c, error);
  }
}

/** `POST /api/admin/updates/releases { refresh? }` — the five most recent stable releases. */
async function releases(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    if (!(await viewerMayPick(config, c, owner))) {
      throw new UpdateError('Only the site owner can choose a version. Ask the Administrator to open Dashboard → Updates.', 403);
    }
    const body = await readJson(c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    return c.json(await releasesResponse({ stored, installed: await installedFor(stored), owner, force: body.refresh === true }));
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * `POST /api/admin/system/update { tag?, confirmDowngrade?, plugins? }` — see `applyResponse`.
 *
 * The decision belongs on the server: the browser names a release, and `updatePlan` says what this host can
 * actually do with it. Every answer carries the plan and the check it was based on, and every refusal an
 * `error` sentence, so the screen never has to guess which release it just asked for or why it was refused.
 */
async function applyUpdate(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const owner = await viewerOwner(config, c);
    const body = await readJson(c);
    const stored = await readUpdatesConfig(integrationReadOptions(config));
    // Asked only for the owner: the hook is a database read, and most calls end at `up_to_date`.
    const deployHook = owner ? await deployHookUrl(config).catch(() => '') : '';
    const answer = await applyResponse({
      body,
      stored,
      installed: await installedFor(stored),
      plugins: installedPluginsFrom(body.plugins),
      owner,
      deployHook,
      selfSupport: await selfSupport(),
      gitDeploy: owner ? await gitDeploysFor(config, bearer(c)) : false,
    });
    return c.json(answer.body, answer.status as ContentfulStatusCode);
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
updatesRouter.post('/updates/releases', releases);
updatesRouter.post('/system/update', applyUpdate);
updatesRouter.get('/system/update-status', updateStatus);

/**
 * Any other verb on those paths is a 405 with the body the classic host answers, registered after the
 * handlers above so `GET`/`POST` still win. Without it the engine would leave the path unmatched and answer
 * Hono's own 404 — the same mistake answered two different ways depending on which host served it.
 */
for (const path of ['/updates', '/updates/check', '/updates/releases', '/system/update', '/system/update-status']) {
  updatesRouter.all(path, (c) => c.json({ error: 'Method not allowed' }, 405));
}

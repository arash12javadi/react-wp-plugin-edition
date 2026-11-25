/**
 * Settings → Integrations → "GitHub & Vercel": the routes a client installation uses to connect its own
 * repository and Vercel project, follow deployments, and update core through Git. Shared by `server.mjs`
 * and the universal engine (`src/server/deployment.ts`), so both hosts answer identically.
 *
 *   GET  /api/admin/deployment                       the connection, presence only (never a token)
 *   POST /api/admin/deployment/github/inspect        repositories the stored GitHub token can push to;
 *                                                    with `{ repository, branch }`, what that one holds
 *   POST /api/admin/deployment/vercel/inspect        `{ token, teamId?, repository }` → account + projects
 *                                                    already deploying the repository (token not stored)
 *   POST /api/admin/deployment/connect               the confirmed connection (see gitDeploy/setup.mjs)
 *   POST /api/admin/deployment/disconnect            forget the sealed Vercel token and the project
 *   GET  /api/admin/deployment/status?sha=           Vercel's state for one commit (gitDeploy/deploymentStatus.mjs)
 *   POST /api/admin/deployment/core-update/plan      `{ tag? }` → the merge plan and its fingerprint; `tag` must be one of
 *                                                    the five most recent stable releases (empty = latest)
 *   POST /api/admin/deployment/core-update/apply     `{ tag, fingerprint, resolutions, confirmDowngrade? }`; the commit lands on the
 *                                                    branch Vercel deploys to PRODUCTION (read from Vercel); an older
 *                                                    tag than the repository runs needs `confirmDowngrade: true` (428)
 *   POST /api/admin/deployment/core-update/redeploy  `{ sha }` — Retry after a failed build: only the production branch's head
 *   POST /api/admin/deployment/plugin-updates/check  every installed plugin against its own `<id>-v<version>` release
 *   POST /api/admin/deployment/plugin-updates/apply  `{ id, version }` → one commit under plugins/<id>/ (no core change)
 *
 * Every route spends or reveals the shape of a credential, so every route requires the **platform owner**
 * (`administrator` / `super_admin`, `authorizePlatformOwner`) — not merely `manage_options`. Requests are
 * authenticated with a bearer token, not a cookie, so a cross-site form cannot ride on a session (CSRF).
 * Reads and writes of the rows go through the caller's own session, so the database's restrictive policy
 * on `system_settings` decides as well.
 *
 * Nothing here contacts react-wp.com. The Vercel token is accepted only by `vercel/inspect` (used once,
 * not stored) and `connect` (sealed with RWP_SECRET_BOX_KEY, then stored); it is never returned, never
 * logged, and scrubbed from any upstream message before that message is answered.
 */
import { DeployError } from './deploy/errors.mjs';
import { redactSecrets } from './deploy/http.mjs';
import { InstallError } from './pluginInstaller.mjs';
import { githubTokenFrom, GITHUB_CONFIG_KEY } from './integrationConfig.mjs';
import { ReleaseListError, listRecentReleases, moveKindFor, releaseSourceFrom, selectRelease, DOWNGRADE_WARNING } from './releaseList.mjs';
import { UPDATE_CONFIG_KEY } from './updateCenter.mjs';
import {
  VERCEL_DEPLOY_CONFIG_KEY,
  deploymentConnectionFrom,
  isGitDeployConnected,
  openVercelToken,
  publicConnection,
  settingsIo,
} from './gitDeploy/connection.mjs';
import { connectDeployment, deploymentEnvironment, inspectGithub, inspectRepository, inspectVercel, repositoryTarget } from './gitDeploy/setup.mjs';
import { deploymentStatusForCommit } from './gitDeploy/deploymentStatus.mjs';
import { applyCoreUpdate, describeCorePlan, planCoreUpdate } from './gitDeploy/coreUpdate.mjs';
import { deployCommit, describeProject, projectRepository, readProject } from './gitDeploy/vercelGit.mjs';
import { readBranch, readBranchHead } from './pluginGitPush.mjs';
import { applyPluginUpdate, checkPluginUpdates, installedPluginVersions, runningPluginsFrom } from './pluginUpdates.mjs';
import { finishCommitChain, startCommitChain } from './pluginGitInstaller.mjs';
import { LICENSE_LINK_CONFIG_KEY, licenseLinkFrom, updateLicensedPlugin } from './licenseLink.mjs';
import { catalogueFrom, fetchCatalogueReleases } from './catalogueUpdates.mjs';

const PREFIX = '/api/admin/deployment';
const PATHS = new Set([
  PREFIX,
  `${PREFIX}/github/inspect`,
  `${PREFIX}/vercel/inspect`,
  `${PREFIX}/connect`,
  `${PREFIX}/disconnect`,
  `${PREFIX}/status`,
  `${PREFIX}/core-update/plan`,
  `${PREFIX}/core-update/apply`,
  `${PREFIX}/core-update/redeploy`,
  `${PREFIX}/plugin-updates/check`,
  `${PREFIX}/plugin-updates/apply`,
  `${PREFIX}/plugin-updates/apply-all`,
  `${PREFIX}/plugin-updates/install`,
  // The Plugins table's two reads. They are answered below but were missing here, so every request for them was a 404.
  `${PREFIX}/plugin-versions`,
  `${PREFIX}/plugin-latest`,
]);

/** The paths this module answers — the single list both engines route by. */
export const ownsDeploymentPath = (pathname) => PATHS.has(pathname);

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const bearerToken = (headers = {}) => String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
/** What a check says on a site that is not connected: the update exists, and where it can be applied. */
const NOT_CONNECTED_FOR_UPDATE = 'A newer version is out. To install it from here, connect this site to its GitHub repository and Vercel project (Settings → Integrations → GitHub & Vercel).';

/** The Update all list: unique plugin ids, each with the version the screen showed, at most 30. */
const MAX_BATCH = 30;
function batchItems(value) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const id = str(raw?.id);
    const version = str(raw?.version);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !version || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, version, kind: raw?.kind === 'licensed' ? 'licensed' : 'release', backup: raw?.backup === true });
    if (items.length >= MAX_BATCH) break;
  }
  return items;
}

const ok = (status, body) => ({ status, body: { success: true, ok: true, ...body } });
const refuse = (status, error, extra = {}) => ({ status, body: { success: false, ok: false, error, ...extra } });

/**
 * One read of the repository's manifests serves every admin opening the Plugins screen while the branch stays on the same commit: it costs one GitHub call per plugin.
 * The promise is what is kept, so the table's version read and the update check that the screen starts at the same moment share one read
 * instead of making two. A failed read is dropped at once, and a commit made from here (`forgetCommittedVersions`) drops the entry too.
 */
// The key includes the branch's head commit (one small read per call). On a host with several instances (Vercel), the instance that
// committed an update is not the one that answers the next request; a cache keyed by time alone kept showing the versions from
// before the update there for up to a minute, which looked like the update had not happened.
const COMMITTED_TTL_MS = 10 * 60_000;
const COMMITTED_MAX = 20;
const committedCache = new Map();
const committedKey = (target, head) => `${target.owner}/${target.repo}@${target.branch}#${head}`.toLowerCase();
async function committedVersionsCached(target) {
  const key = committedKey(target, await readBranchHead(target));
  const hit = committedCache.get(key);
  if (hit && Date.now() - hit.at < COMMITTED_TTL_MS) return hit.rows;
  const rows = installedPluginVersions(target);
  committedCache.set(key, { at: Date.now(), rows });
  if (committedCache.size > COMMITTED_MAX) committedCache.delete(committedCache.keys().next().value);
  rows.catch(() => { if (committedCache.get(key)?.rows === rows) committedCache.delete(key); });
  return rows;
}
// Every entry, not only this target's: the table reads through `siteRepositoryTarget`, whose branch may be named differently.
const forgetCommittedVersions = () => committedCache.clear();

/**
 * The production branch Vercel reported, kept for a minute for the read-only update check only: asking Vercel costs a round trip on every
 * click. Applying an update always asks Vercel again (`productionTarget`), so a commit never relies on this.
 */
const BRANCH_TTL_MS = 60_000;
const branchCache = new Map();
async function productionTargetForCheck({ githubRow, connection, env }) {
  const key = `${connection.project_id}|${connection.repository}`.toLowerCase();
  const hit = branchCache.get(key);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return repositoryTarget(githubTokenFrom(githubRow), connection.repository, hit.branch);
  const target = await productionTarget({ githubRow, connection, env });
  branchCache.set(key, { at: Date.now(), branch: target.branch });
  return target;
}

/**
 * The repository this site is installed from, in order: the Vercel connection's repository, then `RWP_SITE_REPO` (owner/name, optional
 * `RWP_SITE_BRANCH`), then the repository Vercel itself says built this deployment (`VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG`, set by Vercel),
 * then the repository saved on the GitHub card. The owner's site is therefore react-wp-dev-edition and a client's is its own, whatever the card says.
 * The token is the GitHub card's (or `GITHUB_TOKEN`); a public repository is read without one. Null when no repository can be named.
 */
export function siteRepositoryTarget({ githubRow, connection, env = {} }) {
  const token = githubTokenFrom(githubRow) || str(env.GITHUB_TOKEN);
  const fromVercel = str(env.VERCEL_GIT_REPO_OWNER) && str(env.VERCEL_GIT_REPO_SLUG) ? `${str(env.VERCEL_GIT_REPO_OWNER)}/${str(env.VERCEL_GIT_REPO_SLUG)}` : '';
  const repository = str(connection?.repository) || str(env.RWP_SITE_REPO) || fromVercel || str(githubRow?.repository);
  if (!repository) return null;
  const branch = str(connection?.branch) || str(env.RWP_SITE_BRANCH) || str(env.VERCEL_GIT_COMMIT_REF) || str(githubRow?.branch) || 'main';
  try {
    return repositoryTarget(token, repository, branch);
  } catch {
    return null;
  }
}

/** A repository and branch from the stored GitHub row, for the commit-status fallback. */
export function githubTargetOrNull(githubRow, connection) {
  const token = githubTokenFrom(githubRow);
  const repository = connection.repository || str(githubRow?.repository);
  if (!token || !repository) return null;
  try {
    return repositoryTarget(token, repository, connection.branch || str(githubRow?.branch) || 'main');
  } catch {
    return null;
  }
}

/**
 * Where core releases come from: Dashboard → Updates, else RWP_RELEASE_REPO, else the public default
 * (`arash12javadi/react-wp-plugin-edition`). Never the site's own repository, and never react-wp.com. The
 * token is the site's own optional GitHub token and only lifts GitHub's anonymous rate limit.
 */
const releaseSourceFor = (updatesRow, githubRow, env) => releaseSourceFrom({ updates: updatesRow, github: githubRow, env });

/**
 * The branch Vercel deploys to PRODUCTION, read from the project itself — never assumed to be `main`.
 * A commit anywhere else is only ever a Preview. Refuses when the project deploys another repository, since
 * the commit would then change nothing live. If Vercel cannot be asked, the branch recorded at connect time
 * is used, because the update is still correct there and the status check will say what Vercel did with it.
 */
async function productionTarget({ githubRow, connection, env }) {
  let branch = connection.branch;
  try {
    const project = await readProject(openVercelToken(connection, env), { project: connection.project_id, teamId: connection.team_id });
    if (project) {
      const linked = projectRepository(project);
      if (linked && linked.toLowerCase() !== connection.repository.toLowerCase()) {
        throw new InstallError(`Vercel project "${connection.project_name}" deploys ${linked}, not ${connection.repository}, so an update committed to ${connection.repository} would never go live. Connect the site to the project that deploys ${connection.repository} (Settings → Integrations → GitHub & Vercel).`, 409);
      }
      branch = describeProject(project).productionBranch || branch;
    }
  } catch (error) {
    if (error instanceof InstallError) throw error;
  }
  return repositoryTarget(githubTokenFrom(githubRow), connection.repository, branch);
}

/**
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.pathname
 * @param {Record<string, string>} [options.query]
 * @param {Record<string, string>} options.headers  lowercased; only `authorization` is read
 * @param {object} [options.body]
 * @param {{ supabaseUrl?: string, supabasePublishableKey?: string, dbType?: string }} options.config
 * @param {object} [options.siteConfig]  the resolved site config, for the Vercel environment variables
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(token: string) => Promise<{ ok: boolean, status?: number, error?: string }>} options.authorize
 * @param {() => Promise<string>} [options.installedVersion]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function handleDeploymentRequest(options) {
  const { method, pathname, query = {}, headers = {}, body = {}, config = {}, siteConfig = {}, env = {}, authorize, installedVersion = async () => '', fetchImpl = fetch } = options;
  if (!ownsDeploymentPath(pathname)) return null;

  const accessToken = bearerToken(headers);
  if (typeof authorize !== 'function') return refuse(501, 'This host cannot authorize deployment settings.');
  const auth = await authorize(accessToken);
  if (!auth?.ok) return refuse(auth?.status || 403, auth?.error || 'Only the platform owner can manage deployment.');
  if (config.dbType && config.dbType !== 'supabase') {
    return refuse(501, 'Connecting GitHub and Vercel from the admin needs a Supabase-backed site, which is what this setup stores its connection in.');
  }

  const io = settingsIo({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabasePublishableKey, accessToken, fetchImpl });
  const secrets = [str(body?.token), str(body?.vercelToken)];

  try {
    const githubRow = await io.read(GITHUB_CONFIG_KEY);
    const connection = deploymentConnectionFrom(await io.read(VERCEL_DEPLOY_CONFIG_KEY));

    if (pathname === PREFIX) {
      if (method !== 'GET') return refuse(405, 'Only GET is supported here.');
      return ok(200, {
        connection: publicConnection(connection, env),
        github: { tokenStored: Boolean(githubTokenFrom(githubRow)), username: str(githubRow?.username), repository: str(githubRow?.repository) },
        installedVersion: await installedVersion(),
      });
    }

    if (pathname === `${PREFIX}/status`) {
      if (method !== 'GET') return refuse(405, 'Only GET is supported here.');
      const status = await deploymentStatusForCommit({
        connection,
        sha: str(query.sha),
        githubTarget: githubTargetOrNull(githubRow, connection),
        committedAt: str(query.since),
        env,
      });
      return ok(200, { deployment: status });
    }

    if (method !== 'POST') return refuse(405, 'Only POST is supported here.');

    if (pathname === `${PREFIX}/github/inspect`) {
      const token = githubTokenFrom(githubRow);
      const account = await inspectGithub({ token });
      let repository = null;
      if (str(body.repository)) {
        repository = await inspectRepository(repositoryTarget(token, str(body.repository), str(body.branch) || 'main'));
      }
      return ok(200, { github: account, repository });
    }

    if (pathname === `${PREFIX}/vercel/inspect`) {
      // Used for this call only. A stored token is used when none is sent (re-checking an existing connection).
      let token = str(body.token);
      if (!token && isGitDeployConnected(connection)) {
        token = openVercelToken(connection, env);
      }
      const answer = await inspectVercel({ token, teamId: str(body.teamId), repository: str(body.repository) });
      return ok(200, { vercel: answer });
    }

    if (pathname === `${PREFIX}/connect`) {
      const updatesRow = await io.read(UPDATE_CONFIG_KEY);
      const environment = body?.confirm?.environment === true ? deploymentEnvironment({ siteConfig, env }) : {};
      const result = await connectDeployment({
        githubToken: githubTokenFrom(githubRow),
        repository: str(body.repository),
        branch: str(body.branch),
        createRepository: body.createRepository && typeof body.createRepository === 'object' ? body.createRepository : null,
        vercelToken: str(body.vercelToken),
        teamId: str(body.teamId),
        project: body.project && typeof body.project === 'object' ? body.project : null,
        confirm: body.confirm && typeof body.confirm === 'object' ? body.confirm : {},
        releaseSource: releaseSourceFor(updatesRow, githubRow, env),
        installedVersion: await installedVersion(),
        environment,
        env,
        fetchImpl,
      });
      await io.write(VERCEL_DEPLOY_CONFIG_KEY, result.row);
      // The GitHub card's row keeps its token and gains the repository and branch this site deploys from,
      // so plugin uploads commit where Vercel builds.
      await io.write(GITHUB_CONFIG_KEY, { ...(githubRow && typeof githubRow === 'object' ? githubRow : {}), repository: result.repository, branch: result.branch });
      return ok(200, {
        connection: publicConnection(result.row, env),
        project: result.project,
        head: result.head,
        deployment: result.deployment,
        steps: result.steps,
      });
    }

    if (pathname === `${PREFIX}/disconnect`) {
      await io.remove(VERCEL_DEPLOY_CONFIG_KEY);
      return ok(200, {
        connection: publicConnection(null, env),
        message: 'The Vercel token and project were removed from this site. The project keeps deploying the repository on its own; revoke the token in Vercel (Account Settings → Tokens) if it should stop working everywhere.',
      });
    }

    // The version each plugin has in the repository THIS site is installed from (`siteRepositoryTarget`), read live from GitHub: the Plugins table's
    // Version column. It does not need the Vercel connection: the owner's site reads react-wp-dev-edition, a client's its own repository.
    if (pathname === `${PREFIX}/plugin-versions`) {
      const target = siteRepositoryTarget({ githubRow, connection, env });
      if (!target) return refuse(409, 'The repository this site is installed from is not known. Connect GitHub under Settings → Integrations, or set RWP_SITE_REPO (owner/name).');
      return ok(200, { plugins: await committedVersionsCached(target), repository: target.repository, branch: target.branch });
    }

    // The newest version the marketplace has live for these plugin ids (what its GitHub release says), for the Plugins table. It needs no
    // repository connection, so the owner's own site (which publishes from its plugin repositories) sees it too. Never fails the screen.
    if (pathname === `${PREFIX}/plugin-latest`) {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((id) => str(id)).filter(Boolean).slice(0, 50);
      const offers = await fetchCatalogueReleases({ catalogue: catalogueFrom(env), ids, fetchImpl });
      const latest = {};
      for (const [id, list] of offers) if (list[0]?.version) latest[id] = { version: list[0].version, tag: list[0].tag, paid: list[0].paid === true };
      return ok(200, { latest });
    }

    // Plugin updates are released and installed apart from core: their own tags (`<id>-v<version>`), their
    // own check, one commit under `plugins/<id>/`. See server/pluginUpdates.mjs.
    // The check only reads, so it does not need the Vercel connection: a site that is not connected (the platform's
    // own site, for one) still learns what is new, from the repository it is installed from (`siteRepositoryTarget`).
    // Update needs the connection, so without it each row says why it cannot be applied here (`canApply: false`).
    // A connected site uses the cached production branch and the cached manifest read; the reads run side by side.
    // The repository is compared when it can be read: it is what the next deployment runs. When it cannot (the platform's own site built from a
    // private repository its GitHub token cannot see, a local checkout that names none), the plugins this site is running, which the screen
    // sends as `running`, are compared instead: the check still says what is new, and Update stays off until the repository can be read.
    if (pathname === `${PREFIX}/plugin-updates/check`) {
      const connected = isGitDeployConnected(connection);
      const running = runningPluginsFrom(body.running);
      // Plugins the account link already lists for this site have their own Update button; the check must not announce them twice.
      const [target, linkRow, updatesRow] = await Promise.all([
        connected ? productionTargetForCheck({ githubRow, connection, env }) : Promise.resolve(siteRepositoryTarget({ githubRow, connection, env })),
        io.read(LICENSE_LINK_CONFIG_KEY).catch(() => null),
        io.read(UPDATE_CONFIG_KEY),
      ]);
      if (!target && !running.length) {
        return refuse(409, 'This site does not know which repository it is installed from, so its plugins cannot be compared with their releases. Connect GitHub under Settings → Integrations.');
      }
      let repositoryProblem = target ? '' : 'This site does not know which repository it is installed from.';
      const readInstalled = async (repository) => {
        if (!repository) return running;
        try {
          return await committedVersionsCached(repository);
        } catch (error) {
          if (!running.length) throw error;
          repositoryProblem = error instanceof Error ? error.message : 'The repository could not be read.';
          return running;
        }
      };
      const licensedIds = Object.keys(licenseLinkFrom(linkRow).latest_versions || {});
      const answer = await checkPluginUpdates({
        target, source: releaseSourceFor(updatesRow, githubRow, env), channel: 'stable', fetchImpl, catalogue: catalogueFrom(env), licensedIds, readInstalled,
      });
      const canApply = connected && !repositoryProblem;
      // Connected but unreadable: the commit would fail the same way, so the row says why now instead of after a click.
      const reason = connected ? `${repositoryProblem} Update needs to read the repository, so it is off until that is fixed.` : NOT_CONNECTED_FOR_UPDATE;
      const plugins = canApply ? answer.plugins : answer.plugins.map((row) => (row.state === 'available' ? { ...row, state: 'unavailable', reason } : row));
      return ok(200, {
        ...answer,
        plugins,
        canApply,
        installedFrom: repositoryProblem ? 'running' : 'repository',
        // Shown under the panel: the versions compared are this site's own, and why. The full GitHub sentence stays in the row reasons.
        notice: repositoryProblem && target ? `Compared with the versions this site is running, because ${target.repository} could not be read on branch "${target.branch}". If it is private, the token on Settings → Integrations → GitHub needs access to it.` : '',
      });
    }

    // Core updates.
    if (!isGitDeployConnected(connection)) {
      return refuse(409, 'Connect this site to its GitHub repository and Vercel project first (Settings → Integrations → GitHub & Vercel).');
    }
    const updatesRow = await io.read(UPDATE_CONFIG_KEY);
    const source = releaseSourceFor(updatesRow, githubRow, env);

    const target = await productionTarget({ githubRow, connection, env });
    // `install` is the first install of a marketplace plugin (signed package only); `apply` updates one already here.
    if (pathname === `${PREFIX}/plugin-updates/apply` || pathname === `${PREFIX}/plugin-updates/install`) {
      const result = await applyPluginUpdate({
        firstInstall: pathname.endsWith('/install'),
        target,
        source,
        id: str(body.id),
        version: str(body.version),
        coreVersion: await installedVersion(),
        channel: 'stable',
        fetchImpl,
        catalogue: catalogueFrom(env),
        // The site publishes this plugin itself (the screen asked and the owner agreed): keep a copy of its current code.
        backup: body.backup === true ? 'always' : 'auto',
      });
      // The repository changed: the next version read or check must see the new manifest, not the cached one.
      forgetCommittedVersions();
      return ok(200, { result, deployment: result.deployment });
    }

    // Update all: every listed plugin is committed on one chain of commits and the production branch moves once,
    // so Vercel builds one deployment instead of one per plugin. Each plugin keeps the checks of its own Update
    // button (a newer, published version; a signed package for a sold plugin). One that fails is reported and
    // left out; the others still go out together. Nothing is published until the end, so a failure of the final
    // move leaves the branch exactly as it was.
    if (pathname === `${PREFIX}/plugin-updates/apply-all`) {
      const items = batchItems(body.items);
      if (!items.length) return refuse(400, 'Choose at least one plugin to update.');
      const credentials = { supabaseUrl: config.supabaseUrl, apiKey: config.supabasePublishableKey, accessToken };
      const chain = await startCommitChain(target);
      // The repository's plugin versions, read once for the whole list.
      const installedOnce = installedPluginVersions(target);
      installedOnce.catch(() => undefined);
      const readInstalled = () => installedOnce;
      const coreVersion = await installedVersion();
      const results = [];
      for (const item of items) {
        const backup = item.backup ? 'always' : 'auto';
        try {
          const result = item.kind === 'licensed'
            // A sold plugin, by the same path as its own Update button, on this chain. A button's route, never a sync.
            ? await updateLicensedPlugin({ plugin: item.id, version: item.version, io, credentials, env, fetchImpl, chain, backup, readInstalled })
            : await applyPluginUpdate({
              target, source, id: item.id, version: item.version, coreVersion, channel: 'stable', fetchImpl, catalogue: catalogueFrom(env), chain, backup, readInstalled,
            });
          results.push({
            id: item.id, ok: true, from: result.update.from, to: result.update.to,
            warnings: result.warnings || [], sql: Array.isArray(result.sql) && result.sql.length > 0, backup: result.backup || null,
          });
        } catch (error) {
          results.push({ id: item.id, ok: false, error: error instanceof Error ? error.message : 'This plugin could not be updated.' });
        }
      }
      const deployment = await finishCommitChain(chain);
      forgetCommittedVersions();
      return ok(200, { results, deployment, commits: chain.commits.length });
    }

    // The release to move to is one of the five most recent stable releases, re-read here. Only a tag from
    // that list is accepted — the browser's text is compared for equality with it and never reaches a URL —
    // and an empty choice means the latest.
    const list = await listRecentReleases({ source, fetchImpl });
    const release = selectRelease(list, str(body.tag) || str(body.version));
    // Older releases a site with no version record may be compared against (see resolveBase in coreUpdate).
    const baseCandidates = list.releases.map((item) => item.tag);
    const version = release.version;
    const confirmedDowngrade = body.confirmDowngrade === true;

    if (pathname === `${PREFIX}/core-update/plan`) {
      const plan = await planCoreUpdate({ target, source, toVersion: version, baseCandidates, fetchImpl });
      const downgrade = moveKindFor(plan.fromVersion, plan.toVersion) === 'downgrade';
      return ok(200, { plan: describeCorePlan(plan), downgrade, ...(downgrade ? { warning: DOWNGRADE_WARNING } : {}) });
    }

    if (pathname === `${PREFIX}/core-update/apply`) {
      const resolutions = {};
      if (body.resolutions && typeof body.resolutions === 'object') {
        for (const [path, choice] of Object.entries(body.resolutions)) {
          if (choice === 'release' || choice === 'keep') resolutions[path] = choice;
        }
      }
      const result = await applyCoreUpdate({
        target,
        source,
        toVersion: version,
        fingerprint: str(body.fingerprint),
        resolutions,
        baseCandidates,
        fetchImpl,
        // Asked once the plan matches what the administrator reviewed and before anything is committed, with
        // the version the repository really runs (`plan.fromVersion`), not a guess.
        guard: (plan) => {
          if (moveKindFor(plan.fromVersion, plan.toVersion) !== 'downgrade' || confirmedDowngrade) return;
          throw new ReleaseListError(`${DOWNGRADE_WARNING} Confirm the downgrade to ${release.tag} to continue. Nothing was committed.`, 428, { needs_confirmation: 'downgrade' });
        },
      });
      if (result.error) return refuse(result.status || 502, result.error, { result });
      return ok(200, {
        result,
        // A commit on the production branch starts Vercel's build; the update is installed only once that
        // PRODUCTION deployment is READY, which the screen asks `status?sha=` about. Never reported as done here.
        deployment: result.merged && result.commit ? { sha: result.commit.sha, state: 'pending' } : null,
      });
    }

    if (pathname === `${PREFIX}/core-update/redeploy`) {
      // Retry after a failed build. Only the head of the production branch may be rebuilt, so this can never
      // be used to deploy some other commit from the repository's history.
      const head = (await readBranch(target)).commitSha;
      const sha = str(body.sha).toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(sha) || !head.toLowerCase().startsWith(sha)) {
        throw new InstallError(`Only the newest commit on "${target.branch}" can be rebuilt, and that is not ${sha ? sha.slice(0, 7) : 'the commit you named'}. Press Update to start from its current state.`, 409);
      }
      // A project connected through Git builds every commit by itself, so a second build is only ever legitimate
      // when Vercel says the Production build of this very commit FAILED (or was cancelled). Anything else — queued,
      // building, ready — is refused: a retry there would be the duplicate deployment this route must never cause.
      const current = await deploymentStatusForCommit({ connection, sha: head, githubTarget: githubTargetOrNull(githubRow, connection), committedAt: str(body.since), env });
      if (current?.state !== 'error' && current?.state !== 'canceled') {
        throw new InstallError('Vercel has not reported a failed Production build for this commit, so no second build was started: a build that is queued, running or finished is never repeated.', 409);
      }
      const deployment = await deployCommit(openVercelToken(connection, env), {
        projectId: connection.project_id,
        projectName: connection.project_name,
        repository: connection.repository,
        branch: target.branch,
        sha: head,
        teamId: connection.team_id,
      });
      return ok(200, { deployment: { sha: head, state: 'pending', id: deployment.id } });
    }

    return refuse(404, `No deployment endpoint at ${pathname}.`);
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = redactSecrets(secrets, error instanceof Error ? error.message : String(error));
    if (!(error instanceof DeployError) && !(error instanceof InstallError) && status >= 500) {
      // The message only — never the request body, which may hold a token.
      console.error(`${pathname} failed: ${message}`);
    }
    return refuse(status, message, {
      ...(Array.isArray(error?.steps) && error.steps.length ? { steps: error.steps } : {}),
      ...(Array.isArray(error?.conflicts) ? { conflicts: error.conflicts } : {}),
      ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
    });
  }
}

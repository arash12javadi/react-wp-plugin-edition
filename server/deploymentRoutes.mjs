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
 *   POST /api/admin/deployment/core-update/plan      `{ version? }` → the merge plan and its fingerprint
 *   POST /api/admin/deployment/core-update/apply     `{ version, fingerprint, resolutions, mode }`
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
import { fetchGithubReleases, latestReleaseFrom } from './githubReleases.mjs';
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
]);

/** The paths this module answers — the single list both engines route by. */
export const ownsDeploymentPath = (pathname) => PATHS.has(pathname);

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const bearerToken = (headers = {}) => String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
const ok = (status, body) => ({ status, body: { success: true, ok: true, ...body } });
const refuse = (status, error, extra = {}) => ({ status, body: { success: false, ok: false, error, ...extra } });

/** A repository and branch from the stored GitHub row, for the commit-status fallback. */
function githubTargetOrNull(githubRow, connection) {
  const token = githubTokenFrom(githubRow);
  const repository = connection.repository || str(githubRow?.repository);
  if (!token || !repository) return null;
  try {
    return repositoryTarget(token, repository, connection.branch || str(githubRow?.branch) || 'main');
  } catch {
    return null;
  }
}

/** Where core releases come from: Settings → Updates, else RWP_RELEASE_REPO. Never the site's own repository. */
function releaseSourceFrom(updatesRow, githubRow, env) {
  const repo = str(updatesRow?.repository) || str(env.RWP_RELEASE_REPO);
  if (!repo) return null;
  return { repo, token: str(env.RWP_RELEASE_TOKEN) || githubTokenFrom(githubRow) };
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
        releaseSource: releaseSourceFrom(updatesRow, githubRow, env),
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

    // Core updates.
    if (!isGitDeployConnected(connection)) {
      return refuse(409, 'Connect this site to its GitHub repository and Vercel project first (Settings → Integrations → GitHub & Vercel).');
    }
    const updatesRow = await io.read(UPDATE_CONFIG_KEY);
    const source = releaseSourceFrom(updatesRow, githubRow, env);
    const target = repositoryTarget(githubTokenFrom(githubRow), connection.repository, connection.branch);
    let version = str(body.version).replace(/^v/i, '');
    if (!version) {
      if (!source) return refuse(409, 'No release repository is configured. Name it on Settings → Updates (or set RWP_RELEASE_REPO).');
      const listing = await fetchGithubReleases({ repo: source.repo, token: source.token, fetchImpl });
      const latest = latestReleaseFrom(listing.releases, { channel: str(updatesRow?.channel) || 'stable' });
      if (!latest) return refuse(404, `${source.repo} publishes no release to update to.`);
      version = str(latest.version);
    }

    if (pathname === `${PREFIX}/core-update/plan`) {
      const plan = await planCoreUpdate({ target, source, toVersion: version, fetchImpl });
      return ok(200, { plan: describeCorePlan(plan) });
    }

    if (pathname === `${PREFIX}/core-update/apply`) {
      const mode = str(body.mode) === 'pull_request' ? 'pull_request' : 'direct';
      const resolutions = {};
      if (body.resolutions && typeof body.resolutions === 'object') {
        for (const [path, choice] of Object.entries(body.resolutions)) {
          if (choice === 'release' || choice === 'keep') resolutions[path] = choice;
        }
      }
      const result = await applyCoreUpdate({ target, source, toVersion: version, fingerprint: str(body.fingerprint), resolutions, mode, fetchImpl });
      if (result.error) return refuse(result.status || 502, result.error, { result });
      return ok(200, {
        result,
        // A commit on the production branch starts Vercel's build; the update is installed only once that
        // deployment is READY, which the screen asks `status?sha=` about. Never reported as done here.
        deployment: result.merged ? { sha: result.commit.sha, state: 'pending' } : null,
      });
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
    });
  }
}

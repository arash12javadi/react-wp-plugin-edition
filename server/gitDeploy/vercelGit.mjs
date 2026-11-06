/**
 * The Vercel calls a client's own React-WP installation makes to connect its Vercel project to its GitHub
 * repository, and to follow the deployments Vercel starts from that repository.
 *
 * Every endpoint here was checked against Vercel's REST reference (2026-11) before it was used:
 *
 *   GET  /v2/user                         who the token belongs to (`validateVercelToken`, deploy/vercelApi.mjs)
 *   GET  /v10/projects?repo=owner/name    projects already connected to a repository (`link.repo`/`link.org`)
 *   GET  /v9/projects/:idOrName           one project, with its `link` and `link.productionBranch`
 *   POST /v11/projects                    a new project; `gitRepository: { type: 'github', repo }` connects
 *                                         it, and "any pushes to the specified connected Git Repository will
 *                                         be automatically deployed"
 *   POST /v13/deployments                 `gitSource: { type: 'github', org, repo, ref, sha }` — the one
 *                                         deployment this module starts itself: the first one, because
 *                                         creating a project does not deploy the commit that already exists
 *   GET  /v7/deployments?projectId&sha    the deployments Vercel made for one commit
 *
 * What is deliberately absent: connecting an *existing* project to a repository. The reference does not
 * document a call we could verify for it, and the decision is consequential (it changes what an existing,
 * possibly live, project deploys), so an unconnected existing project is reported with the one manual
 * step that does it — Vercel → Project → Settings → Git → Connect Git Repository — and never relinked.
 *
 * The token is only ever placed in an `Authorization` header (`vercelHeaders`), every response message
 * passes through `redactSecrets` before it can reach a screen, and every call has a timeout
 * (`fetchJson`, 25 s by default).
 */
import { DeployError } from '../deploy/errors.mjs';
import { fetchJson, redactSecrets } from '../deploy/http.mjs';
import { VERCEL_API, teamQuery, vercelHeaders } from '../deploy/vercelApi.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
/** Vercel's own rule for project names: lowercase, digits, `.`, `_`, `-`, at most 100 characters. */
const projectNamePattern = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/;

/** Vercel's GitHub App, which has to be allowed to read the repository before a project can connect to it. */
export const VERCEL_GITHUB_APP_URL = 'https://github.com/apps/vercel/installations/new';

const withTeam = (teamId, query = '') => {
  const team = teamQuery(teamId);
  if (!team) return query ? `?${query}` : '';
  return query ? `${team}&${query}` : team;
};

/** Runs one call, scrubbing the token out of anything Vercel echoes back. */
async function call(token, url, init = {}) {
  try {
    return await fetchJson(url, { ...init, headers: vercelHeaders(token) });
  } catch (error) {
    const status = Number(error?.status) || 502;
    const message = redactSecrets([token], error instanceof Error ? error.message : String(error));
    throw new DeployError(status, message, { code: error?.code || '', cause: error });
  }
}

export const isRepositoryName = (value) => repositoryPattern.test(str(value));
export const isProjectName = (value) => projectNamePattern.test(str(value));

/** The repository a project deploys from, in `owner/name` form, or '' when it deploys from none. */
export function projectRepository(project) {
  const link = project?.link;
  if (!link || link.type !== 'github') return '';
  const org = str(link.org);
  const repo = str(link.repo);
  if (!org || !repo) return '';
  return `${org}/${repo}`;
}

/** The public shape of a project: what a screen may show. No env values, no tokens, no deploy hooks. */
export function describeProject(project) {
  return {
    id: str(project?.id),
    name: str(project?.name),
    framework: str(project?.framework),
    repository: projectRepository(project),
    productionBranch: str(project?.link?.productionBranch),
  };
}

/**
 * The projects the token can see that already deploy from `repository`. The filter is applied again
 * here, case-insensitively, so a looser server-side match can never put an unrelated project on screen.
 */
export async function projectsForRepository(token, { repository, teamId = '' }) {
  if (!isRepositoryName(repository)) throw new DeployError(400, 'Name the repository as owner/name.');
  const answer = await call(token, `${VERCEL_API}/v10/projects${withTeam(teamId, `repo=${encodeURIComponent(repository)}&limit=50`)}`);
  const projects = Array.isArray(answer) ? answer : Array.isArray(answer?.projects) ? answer.projects : [];
  const wanted = repository.toLowerCase();
  return projects.filter((project) => projectRepository(project).toLowerCase() === wanted);
}

/** One project by id or name; `null` when the token cannot see it. */
export async function readProject(token, { project, teamId = '' }) {
  const id = str(project);
  if (!id) throw new DeployError(400, 'A Vercel project id or name is required.');
  try {
    return await call(token, `${VERCEL_API}/v9/projects/${encodeURIComponent(id)}${withTeam(teamId)}`);
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}

/**
 * Creates a project connected to `repository`. Vercel refuses when its GitHub App cannot read the
 * repository; that refusal is turned into the one sentence that names the fix, because it is the single
 * step of this setup that cannot be performed with an API token: the GitHub App is installed by a person,
 * on GitHub, once per account.
 */
export async function createGitProject(token, { name, repository, teamId = '', environmentVariables = [] }) {
  if (!isProjectName(name)) {
    throw new DeployError(400, 'A Vercel project name may use lowercase letters, digits, dots, underscores and hyphens, up to 100 characters, and must start and end with a letter or digit.');
  }
  if (!isRepositoryName(repository)) throw new DeployError(400, 'Name the repository as owner/name.');
  try {
    const project = await call(token, `${VERCEL_API}/v11/projects${withTeam(teamId)}`, {
      method: 'POST',
      body: {
        name,
        framework: 'vite',
        gitRepository: { type: 'github', repo: repository },
        ...(environmentVariables.length ? { environmentVariables } : {}),
      },
    });
    if (!project?.id) throw new DeployError(502, 'Vercel created the project but did not return an id.', { code: 'project_unidentified' });
    return project;
  } catch (error) {
    const message = String(error?.message || '');
    if (/install|github app|git ?integration|repository.*(not found|access)|login connection|connect/i.test(message)
      && Number(error?.status) >= 400 && Number(error?.status) < 500) {
      throw new DeployError(424, `Vercel could not connect to ${repository}: ${message} An API token cannot do this part. Check both: your Vercel account has GitHub connected (Vercel → Account Settings → Authentication), and Vercel's GitHub App is installed on the account that owns the repository with access to ${repository} (${VERCEL_GITHUB_APP_URL}). Then press Connect again — nothing was created.`, { code: 'github_app_missing', details: { vercelMessage: message } });
    }
    if (Number(error?.status) === 409 || /already exists/i.test(message)) {
      throw new DeployError(409, `A Vercel project called "${name}" already exists on this account, so a new one was not created. Pick it from the list if it deploys this repository, or choose another name.`, { code: 'project_exists' });
    }
    throw error;
  }
}

/**
 * Starts the production deployment of one commit from the connected repository. Used once, right after a
 * project is created, because Vercel deploys pushes made *after* the connection and the repository's
 * current commit predates it. Every later deployment is Vercel's own, started by a push.
 */
export async function deployCommit(token, { projectId, projectName, repository, branch, sha, teamId = '' }) {
  const [org, repo] = str(repository).split('/');
  if (!org || !repo || !str(sha) || !str(branch)) throw new DeployError(400, 'A repository, a branch and a commit are required to deploy.');
  const deployment = await call(token, `${VERCEL_API}/v13/deployments${withTeam(teamId)}`, {
    method: 'POST',
    body: {
      name: str(projectName) || str(projectId),
      project: str(projectId),
      target: 'production',
      gitSource: { type: 'github', org, repo, ref: str(branch), sha: str(sha) },
    },
  });
  return { id: str(deployment?.id || deployment?.uid), url: str(deployment?.url), state: str(deployment?.readyState || deployment?.status) || 'QUEUED' };
}

/**
 * Vercel's deployments of one commit, newest first. Vercel's own `sha` filter is used and then checked
 * again against `meta.githubCommitSha`, so a deployment of some other commit can never be reported as
 * this one's.
 */
export async function deploymentsForCommit(token, { projectId, sha, teamId = '' }) {
  const commit = str(sha).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new DeployError(400, 'A commit SHA (7 to 40 hex characters) is required.');
  if (!str(projectId)) throw new DeployError(400, 'The connected Vercel project is not recorded.');
  const answer = await call(token, `${VERCEL_API}/v7/deployments${withTeam(teamId, `projectId=${encodeURIComponent(projectId)}&sha=${encodeURIComponent(commit)}&limit=20`)}`, { timeoutMs: 20_000 });
  const list = Array.isArray(answer?.deployments) ? answer.deployments : [];
  return list
    .filter((deployment) => {
      const deployed = str(deployment?.meta?.githubCommitSha).toLowerCase();
      return deployed ? deployed.startsWith(commit) || commit.startsWith(deployed) : false;
    })
    .sort((a, b) => Number(b?.createdAt || b?.created || 0) - Number(a?.createdAt || a?.created || 0));
}

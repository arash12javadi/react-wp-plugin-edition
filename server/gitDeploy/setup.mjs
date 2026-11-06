/**
 * The one-time connection of a client's React-WP installation to its own GitHub repository and Vercel
 * project. Runs on the client's installation, with the client's credentials, and talks only to
 * api.github.com and api.vercel.com — never to react-wp.com.
 *
 * The flow, as the Settings → Integrations → "GitHub & Vercel" card drives it:
 *
 *   inspect    `inspectGithub` lists the repositories the stored GitHub token can push to (the token is
 *              the GitHub card's `github_config` row); `inspectRepository` says whether one is empty, a
 *              React-WP site, or something else; `inspectVercel` proves a Vercel token and lists the
 *              projects that already deploy that repository. Nothing is created or changed.
 *   connect    `connectDeployment` does what the administrator confirmed — and refuses anything
 *              consequential that was not confirmed:
 *                createRepository       → `confirm.createRepository`
 *                seeding an empty repo  → `confirm.seed`   (never into a non-empty, non-React-WP repo)
 *                using an existing project → `confirm.useProject` (only one already connected to this
 *                                         repository; an unconnected or differently-connected project
 *                                         is never relinked)
 *                creating a project     → `confirm.createProject`
 *                writing project env    → `confirm.environment`
 *              then seals and stores the Vercel token (RWP_SECRET_BOX_KEY is required and checked first,
 *              before anything is created), records the repository and branch, and starts the first
 *              deployment only for a project it just created.
 *
 * Every later change — a plugin install or update, a core update — is a commit to the production branch,
 * which Vercel's Git integration deploys by itself.
 */
import { InstallError } from '../pluginInstaller.mjs';
import { commitFiles, githubRequest, readBranch, readTextFile } from '../pluginGitPush.mjs';
import { DeployError } from '../deploy/errors.mjs';
import { validateVercelToken, upsertProjectEnv } from '../deploy/vercelApi.mjs';
import { redactSecrets } from '../deploy/http.mjs';
import { fetchCoreReleaseFiles } from '../releasePackage.mjs';
import { buildEnvString } from '../installEnv.mjs';
import { assertCoreWritable } from './coreMerge.mjs';
import {
  createGitProject,
  deployCommit,
  describeProject,
  isProjectName,
  isRepositoryName,
  projectRepository,
  projectsForRepository,
  readProject,
} from './vercelGit.mjs';
import { requireSecretBox, sealedConnection } from './connection.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const branchPattern = /^(?!\/)(?!.*\.\.)[^\s~^:?*[\]\\]{1,255}$/;

/**
 * The variables a deployed copy of this site needs to boot, copied from this installation to the Vercel
 * project when the administrator confirms it. Names only ever leave the server in answers; values go to
 * Vercel (stored there as encrypted variables) and nowhere else.
 */
export const DEPLOYMENT_ENV_KEYS = Object.freeze([
  'DB_TYPE', 'VITE_DB_TYPE', 'DATABASE_URL', 'SUPABASE_DB_URL',
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'RWP_SECRET_BOX_KEY', 'RWP_SECRET_BOX_KEY_PREVIOUS', 'JWT_SECRET',
  'RWP_EDITION', 'RWP_RELEASE_REPO', 'RWP_OWNER_EMAIL',
]);

/** The values for `DEPLOYMENT_ENV_KEYS`: the resolved site config first (what the wizard saved), then the environment. */
export function deploymentEnvironment({ siteConfig = {}, env = {} } = {}) {
  const values = {};
  for (const line of buildEnvString(siteConfig || {}).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  for (const key of DEPLOYMENT_ENV_KEYS) {
    if (!str(values[key]) && str(env[key])) values[key] = str(env[key]);
  }
  const out = {};
  for (const key of DEPLOYMENT_ENV_KEYS) if (str(values[key])) out[key] = str(values[key]);
  return out;
}

/** A target for calls that are about the account rather than one repository. */
const accountTarget = (token) => ({ token, owner: '-', repo: '-', repository: '-', branch: 'main' });

export function repositoryTarget(token, repository, branch) {
  if (!isRepositoryName(repository)) throw new InstallError('Name the repository as owner/name.', 400);
  const name = str(branch) || 'main';
  if (!branchPattern.test(name)) throw new InstallError(`"${name}" is not a branch name Git accepts.`, 400);
  const [owner, repo] = repository.split('/');
  return { token, owner, repo, repository, branch: name };
}

/** Who the GitHub token belongs to and which repositories it can push to. */
export async function inspectGithub({ token }) {
  if (!str(token)) throw new InstallError('Connect GitHub first (Settings → Integrations → GitHub): this step uses that token.', 409);
  const target = accountTarget(token);
  const user = await githubRequest(target, 'GET', '/user');
  const repos = await githubRequest(target, 'GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  return {
    login: str(user?.login),
    repositories: (Array.isArray(repos) ? repos : [])
      .filter((repo) => repo?.permissions?.push === true && !repo?.archived)
      .map((repo) => ({
        fullName: str(repo.full_name),
        private: repo.private === true,
        defaultBranch: str(repo.default_branch) || 'main',
        pushedAt: str(repo.pushed_at),
      })),
  };
}

/**
 * What a repository holds on `branch`: `empty` (no commits, or nothing but a README/licence/.gitignore),
 * `react-wp` (a React-WP source tree: `package.json` named react-wp and `server/plugins.mjs`), or `other`.
 */
export async function inspectRepository(target) {
  const repo = await githubRequest(target, 'GET', `/repos/${target.owner}/${target.repo}`);
  const defaultBranch = str(repo?.default_branch) || 'main';
  let branch;
  try {
    branch = await readBranch(target);
  } catch (error) {
    if (/HTTP 404|HTTP 409|empty/i.test(String(error?.message))) {
      return { kind: 'empty', hasCommits: false, defaultBranch, private: repo?.private === true, head: '' };
    }
    throw error;
  }
  const paths = [...branch.paths.keys()];
  const trivial = paths.every((path) => /^(README(\.[a-z]+)?|LICENSE(\.[a-z]+)?|\.gitignore|\.gitattributes)$/i.test(path));
  if (trivial) return { kind: 'empty', hasCommits: true, defaultBranch, private: repo?.private === true, head: branch.commitSha };
  let kind = 'other';
  if (branch.paths.has('package.json') && branch.paths.has('server/plugins.mjs')) {
    try {
      const manifest = JSON.parse(await readTextFile(target, 'package.json') || '{}');
      if (str(manifest?.name) === 'react-wp') kind = 'react-wp';
    } catch {
      kind = 'other';
    }
  }
  return {
    kind,
    hasCommits: true,
    defaultBranch,
    private: repo?.private === true,
    head: branch.commitSha,
    plugins: [...new Set(paths.map((path) => /^plugins\/([^/]+)\/manifest\.json$/.exec(path)?.[1]).filter(Boolean))].sort(),
  };
}

/** Proves a Vercel token and lists the projects already deploying `repository`. */
export async function inspectVercel({ token, teamId = '', repository }) {
  if (!str(token)) throw new DeployError(400, 'Paste a Vercel access token.');
  try {
    const user = await validateVercelToken(token);
    const projects = isRepositoryName(repository) ? await projectsForRepository(token, { repository, teamId }) : [];
    return {
      user: str(user?.username) || str(user?.name) || str(user?.email),
      projects: projects.map(describeProject),
    };
  } catch (error) {
    throw new DeployError(Number(error?.status) || 502, redactSecrets([token], error instanceof Error ? error.message : String(error)), { code: error?.code || '' });
  }
}

/** Commits the release's core files into an empty repository. Plugins are not part of a release. */
async function seedRepository(target, { source, version, fetchImpl }) {
  if (!source?.repo) {
    throw new InstallError('The repository is empty and no release repository is configured to fill it from. Name React-WP\'s release repository on Settings → Updates (or set RWP_RELEASE_REPO), or push this site\'s source to the repository yourself, then connect again.', 409);
  }
  let files = null;
  let lastError = null;
  for (const tag of [`v${version}`, version]) {
    try {
      files = await fetchCoreReleaseFiles({ repo: source.repo, token: source.token, version: tag, fetchImpl });
      break;
    } catch (error) {
      lastError = error;
      if (Number(error?.status) !== 404) break;
    }
  }
  if (!files) throw new InstallError(`Release ${version} could not be read from ${source.repo}: ${lastError instanceof Error ? lastError.message : 'unknown error'}`, Number(lastError?.status) || 502);
  const base = await readBranch(target);
  return commitFiles(target, {
    message: `Install React-WP ${version}\n\nCore files from ${source.repo}. Plugins are installed separately and committed under plugins/.`,
    files: [...files].map(([path, content]) => ({ path, content })),
    base,
    pathPolicy: (path) => {
      try {
        assertCoreWritable(path);
      } catch (error) {
        throw new InstallError(error instanceof Error ? error.message : String(error), 500);
      }
    },
  });
}

/** A repository with no commit yet cannot take a tree; one README written through the contents API fixes that. */
async function ensureFirstCommit(target) {
  const readme = `# ${target.repo}\n\nThis repository holds a React-WP site. Vercel deploys its \`${target.branch}\` branch.\n`;
  await githubRequest(target, 'PUT', `/repos/${target.owner}/${target.repo}/contents/README.md`, {
    message: 'Start the repository',
    content: Buffer.from(readme, 'utf8').toString('base64'),
    branch: target.branch,
  });
}

/**
 * Performs the confirmed connection. Returns the row to store (sealed) and what to tell the screen.
 *
 * @param {{
 *   githubToken: string,
 *   repository: string, branch?: string,
 *   createRepository?: { name: string, private?: boolean, org?: string } | null,
 *   vercelToken: string, teamId?: string,
 *   project: { mode: 'existing', id: string } | { mode: 'create', name: string },
 *   confirm?: { createRepository?: boolean, seed?: boolean, useProject?: boolean, createProject?: boolean, environment?: boolean },
 *   releaseSource?: { repo: string, token?: string } | null,
 *   installedVersion?: string,
 *   environment?: Record<string, string>,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export async function connectDeployment(input) {
  const {
    githubToken, vercelToken, teamId = '', project, confirm = {}, releaseSource = null,
    installedVersion = '', environment = {}, env = globalThis.process?.env || {}, fetchImpl = fetch,
  } = input;
  // Fail closed before any side effect: a token that cannot be sealed is never used to create anything.
  requireSecretBox(env);
  if (!str(githubToken)) throw new InstallError('Connect GitHub first (Settings → Integrations → GitHub): this step uses that token.', 409);
  if (!str(vercelToken)) throw new DeployError(400, 'Paste a Vercel access token.');
  const secrets = [githubToken, vercelToken, ...Object.values(environment)];
  const steps = [];

  try {
    let repository = str(input.repository);
    let branch = str(input.branch);

    if (input.createRepository) {
      if (confirm.createRepository !== true) throw new InstallError('Creating a GitHub repository needs your confirmation. Nothing was created.', 428);
      const name = str(input.createRepository.name);
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new InstallError('A repository name may use letters, digits, dots, hyphens and underscores.', 400);
      const org = str(input.createRepository.org);
      const created = await githubRequest(accountTarget(githubToken), 'POST', org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos', {
        name,
        private: input.createRepository.private !== false,
        auto_init: true,
        description: 'React-WP site',
      });
      repository = str(created?.full_name);
      branch = str(created?.default_branch) || 'main';
      steps.push(`Created the ${input.createRepository.private !== false ? 'private' : 'public'} repository ${repository}.`);
    }

    const target = repositoryTarget(githubToken, repository, branch);
    const inspected = await inspectRepository(target);
    if (inspected.kind === 'other') {
      throw new InstallError(`${repository} already holds something that is not a React-WP site, so it was left alone. Choose an empty repository, a repository that already holds this site, or create a new one.`, 409);
    }
    if (inspected.kind === 'empty') {
      if (confirm.seed !== true) throw new InstallError(`${repository} is empty. Filling it with React-WP ${installedVersion || ''} needs your confirmation. Nothing was written.`, 428);
      if (!inspected.hasCommits) await ensureFirstCommit(target);
      const seeded = await seedRepository(target, { source: releaseSource, version: str(installedVersion).replace(/^v/i, ''), fetchImpl });
      steps.push(`Committed React-WP ${installedVersion} to ${repository}@${target.branch} (${seeded.sha.slice(0, 7)}).`);
    }
    const head = (await readBranch(target)).commitSha;

    // Vercel.
    const user = await validateVercelToken(vercelToken);
    let chosen = null;
    let created = false;
    if (project?.mode === 'existing') {
      if (confirm.useProject !== true) throw new DeployError(428, 'Using an existing Vercel project needs your confirmation. Nothing was changed.');
      const found = await readProject(vercelToken, { project: project.id, teamId });
      if (!found) throw new DeployError(404, 'The Vercel token cannot see that project. Use a token from the account that owns it, or set the team.');
      const linked = projectRepository(found);
      if (!linked) {
        throw new DeployError(409, `Vercel project "${found.name}" is not connected to a Git repository, and this setup never relinks an existing project. Connect it once in Vercel (Project → Settings → Git → Connect Git Repository → ${repository}), or let this screen create a new project.`, { code: 'project_unlinked' });
      }
      if (linked.toLowerCase() !== repository.toLowerCase()) {
        throw new DeployError(409, `Vercel project "${found.name}" deploys ${linked}, not ${repository}, so it was not used. Choose a project connected to ${repository}, or create a new one.`, { code: 'project_other_repository' });
      }
      const productionBranch = str(found?.link?.productionBranch);
      if (productionBranch && productionBranch !== target.branch) {
        throw new DeployError(409, `Vercel project "${found.name}" deploys branch "${productionBranch}" to production, not "${target.branch}". Pick "${productionBranch}" here, or change the production branch in Vercel (Project → Settings → Git).`, { code: 'branch_mismatch' });
      }
      chosen = found;
      steps.push(`Using Vercel project "${found.name}", which already deploys ${repository}.`);
    } else if (project?.mode === 'create') {
      if (confirm.createProject !== true) throw new DeployError(428, 'Creating a Vercel project needs your confirmation. Nothing was created.');
      if (!isProjectName(project.name)) throw new DeployError(400, 'Choose a Vercel project name: lowercase letters, digits, dots, underscores and hyphens.');
      chosen = await createGitProject(vercelToken, { name: str(project.name), repository, teamId });
      created = true;
      const productionBranch = str(chosen?.link?.productionBranch);
      steps.push(`Created Vercel project "${chosen.name}", connected to ${repository}.`);
      if (productionBranch && productionBranch !== target.branch) {
        steps.push(`Vercel chose "${productionBranch}" as the production branch, not "${target.branch}". Change it in Vercel (Project → Settings → Git) or pick that branch here.`);
      }
    } else {
      throw new DeployError(400, 'Choose an existing Vercel project or create a new one.');
    }

    const envNames = Object.keys(environment);
    if (envNames.length) {
      if (confirm.environment !== true) throw new DeployError(428, `Writing ${envNames.length} environment variable(s) to the Vercel project needs your confirmation.`);
      await upsertProjectEnv(vercelToken, { projectId: str(chosen.id), teamId, values: environment });
      steps.push(`Wrote ${envNames.length} environment variable(s) to the project: ${envNames.join(', ')}.`);
    }

    // Only a project this setup created needs its first deployment started; a connected one already
    // deploys pushes, and starting another would build the same commit twice.
    let deployment = null;
    if (created) {
      deployment = await deployCommit(vercelToken, { projectId: str(chosen.id), projectName: str(chosen.name), repository, branch: target.branch, sha: head, teamId });
      steps.push(`Started the first production deployment of ${head.slice(0, 7)}.`);
    }

    const row = sealedConnection({
      token: vercelToken,
      repository,
      branch: target.branch,
      projectId: str(chosen.id),
      projectName: str(chosen.name),
      teamId,
      vercelUser: str(user?.username) || str(user?.name),
    }, env);

    return {
      row,
      repository,
      branch: target.branch,
      head,
      project: describeProject(chosen),
      deployment,
      steps,
    };
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = redactSecrets(secrets, error instanceof Error ? error.message : String(error));
    const wrapped = new DeployError(status, message, { code: error?.code || '' });
    wrapped.steps = steps;
    throw wrapped;
  }
}

/**
 * The Vercel REST client, with no knowledge of who is deploying or why.
 *
 * This is the installer's deployment half — `vercelHeaders`, `teamQuery`, `digestOf`, `uploadVercelFile`,
 * `forEachLimit`, `createFileDeployment`, `findVercelProject`, `deploymentBuildEnv`, `upsertProjectEnv` —
 * moved into core so it can serve three callers that must not each own a copy:
 *
 *   1. the SaaS installer's provision, update and rollback (`plugins/rwp-saas-installer/server.mjs`);
 *   2. the plugin install/update job, which deploys a prebuilt payload that now contains a new plugin;
 *   3. the standalone build worker, which does the same work without a browser waiting on it.
 *
 * A copy per caller would be three places to fix when Vercel changes a route, and the first two would
 * silently disagree about which files are allowed to travel (`assertDeployPayload` is the caller's rule,
 * not this module's — this module uploads exactly the map it is handed).
 *
 * Everything here is a pure function of a token and a payload. Nothing reads `process.env`, nothing reads
 * the database, nothing knows what a plugin is: that is what lets the worker call it on an operator's
 * machine with a token that never reaches a server.
 *
 * ## The deployment is a file upload, not a clone
 *
 * `createFileDeployment` POSTs each distinct file to `/v2/files` under its SHA-1 and then creates a
 * production deployment that names those digests. Vercel never clones anything, so no Vercel account —
 * the customer's or ours — needs a GitHub connection, and no clone token is handed to a third party. It is
 * also why a private template can be deployed onto somebody else's account at all.
 */
import { createHash } from 'node:crypto';
import { DeployError } from './errors.mjs';
import { fetchJson } from './http.mjs';

export const VERCEL_API = 'https://api.vercel.com';

/** How long a source upload may take before it is reported as a timeout rather than hanging a request. */
const UPLOAD_TIMEOUT_MS = 60_000;
/** How many files are uploaded at once. More than this opens sockets faster than Vercel answers them. */
const UPLOAD_CONCURRENCY = 4;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

export const vercelHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

/**
 * `teamId=team_…` for an id, `slug=…` for a team slug, nothing for a personal account. Anything else is
 * rejected here rather than being pasted into a URL unexamined.
 */
export function teamQuery(teamId) {
  const value = str(teamId);
  if (!value) return '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new DeployError(400, 'The Vercel team must be a team id (team_…) or a team slug: letters, digits, hyphens and underscores only.');
  }
  return value.startsWith('team_') ? `?teamId=${encodeURIComponent(value)}` : `?slug=${encodeURIComponent(value)}`;
}

/** The `&teamId=` / `&slug=` form, for a URL that already carries a query string. */
const teamSuffix = (teamId) => {
  const query = teamQuery(teamId);
  return query ? `&${query.slice(1)}` : '';
};

/** Proves the token works and says whose it is, before anything is created or uploaded. */
export async function validateVercelToken(token) {
  try {
    const user = await fetchJson(`${VERCEL_API}/v2/user`, { headers: vercelHeaders(token) });
    if (!user?.user?.id) throw new DeployError(401, 'The Vercel access token is invalid.', { code: 'token_invalid' });
    return user.user;
  } catch (error) {
    if (Number(error?.status) === 401 || Number(error?.status) === 403) {
      throw new DeployError(401, 'The Vercel access token is invalid, or it has no access to the team you named. Create one under Vercel -> Account Settings -> Tokens and paste it again.', { code: 'token_invalid' });
    }
    throw error;
  }
}

/**
 * Creates an *unlinked* project: no `gitRepository` is sent, so Vercel never asks GitHub for anything.
 * Everything a deployment needs is written onto the project's environment afterwards.
 */
export async function createProject(token, { projectName, teamId = '', framework = 'vite' } = {}) {
  const name = str(projectName);
  if (!name) throw new DeployError(400, 'A project name is required to create a Vercel project.');
  const project = await fetchJson(`${VERCEL_API}/v11/projects${teamQuery(teamId)}`, {
    method: 'POST',
    headers: vercelHeaders(token),
    body: { name, framework },
  });
  if (!project?.id) throw new DeployError(502, 'Vercel created the project but did not return an id.', { code: 'project_unidentified' });
  return project;
}

/**
 * The project on the account the token belongs to.
 *
 * Read before anything is uploaded so the common failures — a token for another account, the other team's
 * project name, a site that has been deleted — are one clear sentence instead of a deployment that lands
 * somewhere unexpected.
 */
export async function findProject(token, { projectName, teamId = '' } = {}) {
  const name = str(projectName);
  if (!name) throw new DeployError(400, 'A project name is required to find a Vercel project.');
  try {
    const project = await fetchJson(`${VERCEL_API}/v9/projects/${encodeURIComponent(name)}${teamQuery(teamId)}`, {
      headers: vercelHeaders(token),
    });
    if (!project?.id) throw new DeployError(502, `Vercel answered without a project for "${name}".`);
    return project;
  } catch (error) {
    if (Number(error?.status) === 404) {
      throw new DeployError(404, `The Vercel token cannot see a project named "${name}". Use a token from the account that owns it, or correct the name${str(teamId) ? ' and team' : ''}.`, { code: 'project_not_found' });
    }
    if (Number(error?.status) === 401 || Number(error?.status) === 403) {
      throw new DeployError(401, 'Vercel refused the access token, or it has no access to that project. Create one under Vercel -> Account Settings -> Tokens and paste it again.', { code: 'token_invalid' });
    }
    throw error;
  }
}

/** SHA-1 of a file's bytes: the name Vercel stores an uploaded file under. */
export const digestOf = (bytes) => createHash('sha1').update(bytes).digest('hex');

/**
 * Uploads one file to Vercel's file store, under its own digest.
 *
 * Vercel deduplicates on the digest, so a tree that shares most of its files with the previous release
 * costs nothing for the shared part the second time, and a deployment built from digests can only ever
 * contain bytes somebody uploaded and named.
 */
export async function uploadVercelFile(token, digest, bytes) {
  let response;
  try {
    response = await fetch(`${VERCEL_API}/v2/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': digest,
      },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DeployError(504, `Vercel did not accept a source upload (${error instanceof Error ? error.message : 'network error'}).`, { cause: error });
  }
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new DeployError(401, 'Vercel refused the access token while the source was being uploaded. Create a token under Vercel -> Account Settings -> Tokens that can see this project, and paste it again.', { code: 'token_invalid' });
  }
  const detail = await response.text().catch(() => '');
  throw new DeployError(502, `Vercel refused a source upload (HTTP ${response.status})${detail ? `: ${str(detail).slice(0, 200)}` : ''}.`, { code: 'upload_refused' });
}

/** Runs `worker` over `items`, `limit` at a time, so a large tree does not open one socket per file. */
export async function forEachLimit(items, limit, worker) {
  const queue = items.slice();
  const run = async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, run));
}

/**
 * Deploys a source tree that is already in hand: upload every distinct file, then create a production
 * deployment that references the digests.
 *
 * This is the whole engine for every surface — a first provision, an update, a rollback and a plugin
 * install — because a project Vercel cannot clone is a project whose source has to travel with the
 * deployment.
 *
 * `files` is a `Map<name, Buffer>` and this function uploads all of it. What is *allowed* into that map is
 * the caller's promise (`assertDeployPayload` in the installer, the prebuilt payload in the plugin job), and
 * it has to stay that way: a rule enforced here would have to know what a plugin is.
 */
export async function createFileDeployment(token, { projectName, projectId, teamId = '', files, meta, target = 'production' } = {}) {
  if (!(files instanceof Map) || files.size === 0) {
    throw new DeployError(400, 'There are no files to deploy.', { code: 'empty_payload' });
  }
  const uploads = new Map();
  const listing = [];
  for (const [file, bytes] of files) {
    const digest = digestOf(bytes);
    if (!uploads.has(digest)) uploads.set(digest, bytes);
    listing.push({ file, sha: digest, size: bytes.length });
  }

  await forEachLimit([...uploads], UPLOAD_CONCURRENCY, ([digest, bytes]) => uploadVercelFile(token, digest, bytes));

  const deployment = await fetchJson(`${VERCEL_API}/v13/deployments${teamQuery(teamId)}`, {
    method: 'POST',
    headers: vercelHeaders(token),
    body: {
      name: projectName,
      project: projectId || projectName,
      target,
      files: listing,
      meta,
    },
    timeoutMs: 60_000,
  });
  const host = str(deployment?.url);
  return {
    id: str(deployment?.id),
    readyState: str(deployment?.readyState) || 'QUEUED',
    /** Always the production alias: `deployment.url` names one immutable deployment instead. */
    url: `https://${projectName}.vercel.app`,
    deploymentUrl: host ? `https://${host}` : '',
    uploaded: uploads.size,
    files: listing.length,
  };
}

/** `GET /v13/deployments/:id` — the state of one deployment, as Vercel reports it. */
export async function getDeployment(token, { deploymentId, teamId = '' } = {}) {
  const id = str(deploymentId);
  if (!id) throw new DeployError(400, 'A deployment id is required to read a deployment.');
  return await fetchJson(`${VERCEL_API}/v13/deployments/${encodeURIComponent(id)}${teamQuery(teamId)}`, {
    headers: vercelHeaders(token),
    timeoutMs: 20_000,
  });
}

/** The states Vercel never leaves. `QUEUED`, `INITIALIZING` and `BUILDING` are all "not yet". */
export const TERMINAL_DEPLOYMENT_STATES = Object.freeze(['READY', 'ERROR', 'CANCELED']);

/**
 * Waits until the deployment is `READY` — and refuses to say a site is updated before then.
 *
 * This is the difference between "the deployment was accepted" and "the plugin is installed". Vercel
 * answers `POST /v13/deployments` immediately with `QUEUED`; a build that then fails leaves the site
 * serving its previous deployment, so a job that recorded `installed` at that point would be lying, and the
 * customer's plugin screen would show a plugin that is not running. The install state is written only when
 * this resolves.
 *
 * A failed build is reported as the *build's* failure (with Vercel's own `errorCode` / `errorMessage`),
 * not as a network problem: the two need different sentences in front of a customer.
 *
 * @param {string} token
 * @param {{
 *   deploymentId: string,
 *   teamId?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   onPoll?: (state: string, attempt: number) => void,
 * }} options
 */
export async function waitForDeployment(token, {
  deploymentId,
  teamId = '',
  timeoutMs = 15 * 60 * 1000,
  intervalMs = 3000,
  onPoll,
} = {}) {
  const started = Date.now();
  let attempt = 0;
  let state = 'QUEUED';
  for (;;) {
    attempt += 1;
    const deployment = await getDeployment(token, { deploymentId, teamId });
    state = str(deployment?.readyState).toUpperCase() || state;
    onPoll?.(state, attempt);
    if (state === 'READY') {
      const host = str(deployment?.url);
      return {
        ok: true,
        id: str(deployment?.id) || str(deploymentId),
        readyState: state,
        deploymentUrl: host ? `https://${host}` : '',
        elapsedMs: Date.now() - started,
        attempts: attempt,
      };
    }
    if (TERMINAL_DEPLOYMENT_STATES.includes(state) && state !== 'READY') {
      const code = str(deployment?.errorCode);
      const detail = str(deployment?.errorMessage) || str(deployment?.readySubstate);
      throw new DeployError(
        502,
        `Vercel finished the deployment as ${state}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}. `
        + 'The site still serves its previous deployment, so nothing was marked as installed.',
        { code: 'deployment_failed', details: { readyState: state, errorCode: code, errorMessage: detail } },
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new DeployError(
        504,
        `The deployment is still ${state} after ${Math.round(timeoutMs / 60000)} minutes, so it is not marked as installed yet. `
        + 'Open the project in Vercel to watch it; the job can be checked again without rebuilding.',
        { code: 'deployment_timeout', details: { readyState: state, attempts: attempt } },
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

/**
 * Every variable on a project, decrypted, in Vercel's own list shape.
 *
 * `decrypt=true` is what makes the values usable by a build; without it Vercel answers the ciphertext it
 * stores, and a deployment built from that would carry unreadable Supabase settings.
 */
export async function readProjectEnv(token, { projectId, teamId = '' } = {}) {
  const id = str(projectId);
  if (!id) throw new DeployError(502, 'The project id is missing, so its build settings cannot be read.', { code: 'project_unidentified' });
  const answer = await fetchJson(`${VERCEL_API}/v9/projects/${encodeURIComponent(id)}/env?decrypt=true${teamSuffix(teamId)}`, {
    headers: vercelHeaders(token),
  });
  return Array.isArray(answer?.envs) ? answer.envs : [];
}

/**
 * The variables the *deployment* is built with, read back from its own project.
 *
 * The build inlines configuration — `vite.config.js` bakes `window.__REACT_WP_CONFIG__` from the
 * environment, and Vite inlines every `import.meta.env.VITE_*` — so a release built with a *server's*
 * environment would stamp the wrong Supabase project into a customer's bundle. What Vercel's own build
 * would have had is this project's variables, so that is what is read here, decrypted, and handed to the
 * build. Every one of them, not a chosen few: a site configured through a variable this engine has never
 * heard of must still come up installed.
 *
 * A read that fails is fatal rather than best-effort. Building anyway would produce a site that looks
 * uninstalled and asks the visitor to run the wizard again, which is worse than a deployment refused with
 * the reason.
 */
export async function readBuildEnv(token, { projectId, teamId = '' } = {}) {
  let rows;
  try {
    rows = await readProjectEnv(token, { projectId, teamId });
  } catch (error) {
    throw new DeployError(
      Number(error?.status) || 502,
      `The release has to be built with this site's own settings, and Vercel would not return them: ${error instanceof Error ? error.message : 'the request failed'}`,
      { code: 'env_unreadable', cause: error },
    );
  }
  const env = {};
  for (const row of rows) {
    const key = str(row?.key);
    const value = typeof row?.value === 'string' ? row.value : '';
    if (!key || !value) continue;
    const targets = Array.isArray(row?.target) ? row.target : [];
    // Production is what a deploy to `target: 'production'` runs with; a preview-only value is not it.
    if (targets.length > 0 && !targets.includes('production')) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Writes project environment variables, adding the ones that are missing and updating the ones that are
 * not.
 *
 * Vercel's API is create-or-update: `POST /v10/projects/:id/env` adds a key and refuses one that already
 * exists, while an existing key is updated through its own id. Both paths are needed, because the same call
 * runs on a project created a second ago and on one provisioned months ago.
 */
export async function upsertProjectEnv(token, { projectId, teamId = '', values } = {}) {
  const id = str(projectId);
  if (!id) throw new DeployError(502, 'The project id is missing, so its environment cannot be written.', { code: 'project_unidentified' });
  const query = teamQuery(teamId);
  const headers = vercelHeaders(token);
  let existing = [];
  try {
    existing = await readProjectEnv(token, { projectId: id, teamId });
  } catch {
    // A project whose variables cannot be listed is treated as having none: every write below becomes a
    // create, and one that Vercel refuses is reported to the caller like any other failure.
  }
  for (const [key, value] of Object.entries(values || {})) {
    if (!key || !str(value)) continue;
    // The production row wins when Vercel holds several: that is the one a production deployment reads.
    const row = existing.find((item) => str(item?.key) === key && (!Array.isArray(item?.target) || item.target.includes('production')))
      || existing.find((item) => str(item?.key) === key);
    if (row?.id) {
      await fetchJson(`${VERCEL_API}/v9/projects/${encodeURIComponent(id)}/env/${encodeURIComponent(row.id)}${query}`, {
        method: 'PATCH',
        headers,
        body: { value: str(value) },
      });
      continue;
    }
    await fetchJson(`${VERCEL_API}/v10/projects/${encodeURIComponent(id)}/env${query}`, {
      method: 'POST',
      headers,
      body: { key, value: str(value), type: 'encrypted', target: ['production'] },
    });
  }
}

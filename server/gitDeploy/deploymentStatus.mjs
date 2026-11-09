/**
 * What happened to one commit after it reached the production branch — read, never assumed.
 *
 * A commit is not a deployment. Vercel's Git integration starts one when the push arrives, builds it, and
 * moves the production alias only when the build is `READY`; until then the previous deployment keeps
 * serving. So an install or an update reports exactly what Vercel reports, in this order of authority:
 *
 *   1. Vercel's own deployment list for the commit (`GET /v7/deployments?projectId&sha`), with the
 *      installation's own stored token. This is the only source that can say `ready`.
 *   2. Without a usable Vercel token, the commit status Vercel's GitHub App posts on the commit
 *      (`GET /repos/:o/:r/commits/:sha/status`, context starting with "Vercel"), with the GitHub token.
 *      Labelled `source: 'github-status'` so a screen can say whose report it is.
 *   3. Otherwise `unknown`, with the reason. Never a guess, and never `ready`.
 *
 * `not_started` is its own answer: Vercel can take a few seconds to register a push, and a commit that
 * still has no deployment after `STALE_AFTER_MS` is reported with the likely cause (the project is not
 * connected to this repository, or the push was to a branch Vercel does not deploy to production).
 */
import { githubRequest } from '../pluginGitPush.mjs';
import { deploymentsForCommit } from './vercelGit.mjs';
import { openVercelToken, isGitDeployConnected, deploymentConnectionFrom } from './connection.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** After this long without a deployment for a commit, "not started" becomes a warning with a cause. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

const VERCEL_STATES = {
  QUEUED: 'queued',
  INITIALIZING: 'building',
  BUILDING: 'building',
  READY: 'ready',
  ERROR: 'error',
  CANCELED: 'canceled',
  DELETED: 'canceled',
  BLOCKED: 'error',
};

/** One Vercel deployment as a screen may see it. The URL is public anyway; nothing else is copied. */
export function describeVercelDeployment(deployment) {
  const raw = str(deployment?.readyState || deployment?.state).toUpperCase();
  const state = VERCEL_STATES[raw] || 'unknown';
  const substate = str(deployment?.readySubstate).toUpperCase();
  const production = str(deployment?.target) === 'production';
  return {
    id: str(deployment?.uid || deployment?.id),
    state,
    vercelState: raw,
    production,
    // A READY production deployment that was not promoted (auto-assign switched off) is built but not live.
    serving: state === 'ready' && production && (substate ? substate === 'PROMOTED' : true),
    url: str(deployment?.url) ? `https://${str(deployment.url).replace(/^https?:\/\//, '')}` : '',
    inspectorUrl: str(deployment?.inspectorUrl),
    error: state === 'error' ? str(deployment?.errorMessage) || str(deployment?.errorCode) : '',
    createdAt: Number(deployment?.createdAt || deployment?.created || 0) || 0,
  };
}

/** Maps GitHub's combined status of Vercel's context to the same vocabulary. */
function fromGithubStatus(payload) {
  const statuses = Array.isArray(payload?.statuses) ? payload.statuses : [];
  const vercel = statuses.find((status) => /^vercel/i.test(str(status?.context)));
  if (!vercel) return null;
  const map = { success: 'ready', pending: 'building', failure: 'error', error: 'error' };
  return {
    state: map[str(vercel.state)] || 'unknown',
    url: str(vercel.target_url),
    description: str(vercel.description),
  };
}

/**
 * The state of `sha` on the connected project.
 *
 * @param {{ connection: unknown, sha: string, githubTarget?: object | null, committedAt?: string, env?: object, now?: () => number }} input
 */
export async function deploymentStatusForCommit({ connection, sha, githubTarget = null, committedAt = '', env = globalThis.process?.env || {}, now = Date.now }) {
  const commit = str(sha).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    return { sha: commit, state: 'unknown', source: 'none', reason: 'That is not a commit SHA.' };
  }
  const row = deploymentConnectionFrom(connection);
  const notes = [];

  if (isGitDeployConnected(row)) {
    let token = '';
    try {
      token = openVercelToken(row, env);
    } catch (error) {
      notes.push(error instanceof Error ? error.message : 'The stored Vercel token could not be opened.');
    }
    if (token) {
      try {
        const deployments = await deploymentsForCommit(token, { projectId: row.project_id, sha: commit, teamId: row.team_id });
        const production = deployments.filter((deployment) => str(deployment?.target) === 'production');
        // Only a PRODUCTION deployment can be the result of an update. A Preview of the same commit (what a
        // commit on a side branch gets) never changes the live site, so it is never reported as the answer.
        const chosen = production[0];
        if (chosen) {
          return { sha: commit, source: 'vercel', project: row.project_name, ...describeVercelDeployment(chosen) };
        }
        if (deployments.length) {
          return {
            sha: commit,
            source: 'vercel',
            state: 'not_started',
            production: false,
            serving: false,
            previewOnly: true,
            project: row.project_name,
            reason: `Vercel built this commit only as a Preview, which does not change the live site. Project "${row.project_name}" must deploy "${row.branch}" to Production (Vercel → Project → Settings → Git → Production Branch). The previous version is still serving.`,
          };
        }
        const age = committedAt ? now() - Date.parse(committedAt) : 0;
        return {
          sha: commit,
          source: 'vercel',
          state: 'not_started',
          project: row.project_name,
          reason: Number.isFinite(age) && age > STALE_AFTER_MS
            ? `Vercel has no deployment of this commit after ${Math.round(age / 60000)} minutes. Check that project "${row.project_name}" is connected to ${row.repository} and deploys "${row.branch}" to production (Vercel → Project → Settings → Git). The previous deployment is still serving.`
            : 'Vercel has not registered a deployment for this commit yet. It usually appears within a few seconds of the push.',
        };
      } catch (error) {
        notes.push(`Vercel could not be asked: ${error instanceof Error ? error.message : 'request failed'}`);
      }
    }
  } else {
    notes.push('This site is not connected to a Vercel project, so Vercel cannot be asked directly.');
  }

  if (githubTarget) {
    try {
      const payload = await githubRequest(githubTarget, 'GET', `/repos/${githubTarget.owner}/${githubTarget.repo}/commits/${commit}/status`);
      const reported = fromGithubStatus(payload);
      if (reported) {
        return {
          sha: commit,
          source: 'github-status',
          // GitHub's status cannot say Production from Preview, so it can say "building" or "failed" but
          // never "ready": that word is reserved for a production deployment Vercel itself reported.
          state: reported.state === 'ready' ? 'building' : reported.state,
          production: null,
          serving: null,
          url: reported.url,
          reason: `Reported by Vercel's commit status on GitHub${reported.description ? `: ${reported.description}` : ''}.${reported.state === 'ready' ? ' This site still cannot confirm that the build is live in Production, because Vercel itself could not be asked.' : ''}${notes.length ? ` ${notes.join(' ')}` : ''}`,
        };
      }
      notes.push('GitHub has no Vercel status on this commit yet.');
    } catch (error) {
      notes.push(`GitHub could not be asked: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }

  return { sha: commit, source: 'none', state: 'unknown', reason: notes.join(' ') || 'No deployment source is available.' };
}

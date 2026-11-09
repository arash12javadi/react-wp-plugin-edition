/**
 * What `POST /api/admin/updates/check`, `POST /api/admin/updates/releases` and `POST /api/admin/system/update`
 * decide, written once for both hosts (`server/updateRoutes.mjs` and `src/server/routes/updates.ts`) so they
 * cannot answer differently.
 *
 * Three rules this file keeps:
 *
 *   - **Every refusal carries a sentence.** A non-2xx answer always has `error`, and an apply answer always
 *     has `plan` and `check` next to it, so the screen shows the real reason and never "(HTTP 409)". (The
 *     old answers spread the plan's fields over the top level of the body instead of nesting them under
 *     `plan`, which the browser did not recognise — that was the "could not be started (HTTP 409)" screen on
 *     a site that deploys from its own GitHub repository, and "(HTTP 200)" on an up-to-date one.)
 *   - **Only the site owner applies.** Anyone else who can open the screen may read the check; applying is
 *     refused with a sentence that names who can.
 *   - **A version is a tag from the server's own list.** `resolveUpdateTarget` re-reads the five releases and
 *     accepts only one of them; the tag then goes to `git` as a ref and nowhere else.
 *
 * Nothing here calls react-wp.com.
 */
import { UpdateError, applyDeployHookUpdate, checkForUpdates, describeGithubSource, describeUpdateConfig, resolveUpdateTarget, toUpdateError, updatePlan } from './updateCenter.mjs';
import { describeRecentReleases, listRecentReleases } from './releaseList.mjs';
import { startSelfUpdate } from './selfUpdate.mjs';

const NOT_OWNER = 'Only the site owner (the Administrator account) can apply an update. Ask them to open Dashboard → Updates.';

/** The body every route answers a refusal with: the sentence, plus whatever the refusal adds to it. */
export const refusalBody = (error) => ({
  error: error instanceof Error && error.message ? error.message : 'The request failed for a reason the server did not name. Try again, and check the server log if it repeats.',
  ...(error && typeof error === 'object' && error.extra && typeof error.extra === 'object' ? error.extra : {}),
});

/** The configuration and GitHub source as the viewer may see them, with the repository hidden from non-owners. */
const viewOf = (stored, owner) => ({
  config: describeUpdateConfig(stored.config, owner),
  github: describeGithubSource(stored.github, owner),
  readable: stored.readable,
});

/** `releases` with the repository name left out when the viewer is not the owner. */
const releasesFor = (list, installed, owner) => {
  const view = describeRecentReleases(list, installed);
  return owner ? view : { ...view, repository: '' };
};

/**
 * The answer to a check.
 *
 * @param {{ stored: any, installed: string, plugins: any[], owner: boolean, fetchImpl?: typeof fetch, latestCommit?: unknown }} input
 */
export async function checkResponse({ stored, installed, plugins, owner, fetchImpl, latestCommit = null }) {
  const { releases, ...rest } = await checkForUpdates({ current: { app: installed, site: '' }, plugins, github: stored.github, fetchImpl });
  return { ...rest, releases: owner ? releases : { ...releases, repository: '' }, ...viewOf(stored, owner), latestCommit };
}

/** `POST /api/admin/updates/releases` — the five most recent stable releases, for the version picker. */
export async function releasesResponse({ stored, installed, owner, force = false, fetchImpl }) {
  try {
    const list = await listRecentReleases({ source: stored.github, fetchImpl, force });
    return releasesFor(list, installed, owner);
  } catch (error) {
    throw toUpdateError(error);
  }
}

/**
 * Applies the release the request named, however this host can.
 *
 * @param {{
 *   body: Record<string, unknown>, stored: any, installed: string, plugins: any[], owner: boolean,
 *   deployHook: string, selfSupport: { supported: boolean }, gitDeploy: boolean,
 *   fetchImpl?: typeof fetch, env?: Record<string, string | undefined>,
 * }} input
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function applyResponse({ body, stored, installed, plugins, owner, deployHook, selfSupport, gitDeploy, fetchImpl, env }) {
  if (!owner) throw new UpdateError(NOT_OWNER, 403);
  const target = await resolveUpdateTarget({ github: stored.github, tag: body.tag, confirmDowngrade: body.confirmDowngrade, installed, fetchImpl });
  const check = {
    ...(await checkForUpdates({ current: { app: installed, site: '' }, plugins, github: stored.github, fetchImpl, list: target.list })),
    ...viewOf(stored, owner),
  };
  const plan = updatePlan({
    config: stored.config,
    deployHook,
    selfUpdate: selfSupport.supported,
    latestVersion: target.release.version,
    installedVersion: installed,
    gitDeploy,
    move: target.move,
  });
  if (plan.up_to_date) return { status: 200, body: { up_to_date: true, plan, check } };
  if (plan.mode === 'manual') return { status: 409, body: { plan, check, error: plan.reason } };
  if (plan.mode === 'deploy-hook') {
    if (target.release.tag !== target.list.releases[0].tag) {
      const reason = `This host is rebuilt from its repository's branch by a deploy hook, and a hook cannot pick a version. Choose the latest release (${target.list.releases[0].tag}), or connect the site to its own GitHub repository and Vercel project (Settings → Integrations → GitHub & Vercel) to install ${target.release.tag}.`;
      return { status: 409, body: { plan: { ...plan, mode: 'manual', reason }, check, error: reason } };
    }
    const result = await applyDeployHookUpdate({ deployHook, env, fetchImpl });
    // 502 on a hook that refused: the request was fine, the platform it called was not.
    return { status: result.queued ? 200 : 502, body: { ...result, plan, check, ...(result.queued ? {} : { error: result.message }) } };
  }
  try {
    // The tag is the one the list vouched for, so the runner checks out exactly that release.
    const run = await startSelfUpdate({ to: target.release.version, from: installed, ref: target.release.tag });
    // 202: accepted, not finished. The screen polls `update-status?id=` with the id it just got.
    return { status: 202, body: { mode: 'self', run, plan, check } };
  } catch (error) {
    throw toUpdateError(error);
  }
}

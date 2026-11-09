/**
 * A React-WP core update, applied to the client's own GitHub repository.
 *
 * The client's repository is the source of truth and Vercel deploys its production branch, so "updating
 * core" is one commit on that branch — made safely:
 *
 *   1. plan    Read the branch, fetch the installed release (the merge base) and the new one, and work
 *              out every write, deletion, kept file and conflict (`coreMerge.mjs`). Nothing is written.
 *              The plan carries a fingerprint over all of that plus the branch head it was made against.
 *   2. apply   Requires the fingerprint the administrator saw and a choice for every conflict. The plan is
 *              rebuilt; a different fingerprint (the branch or the release changed since) is refused.
 *              The commit goes onto a staging branch `rwp/core-<version>-<head>` first, so a half-finished
 *              update can never be on the production branch, and then `landOnProduction` puts it on the
 *              branch Vercel really deploys to production — by itself, never by leaving work for a person:
 *                1. fast-forward (`force: false`: nothing is overwritten),
 *                2. else a merge through GitHub's merge API (the branch moved on, or refuses a fast-forward),
 *                3. else a pull request opened and merged through the API (a protected branch that only
 *                   accepts merges from pull requests).
 *              If none is possible the staging branch and the pull request are removed again and the answer
 *              names the one rule that blocks it, so nothing is left lying around.
 *   3. Vercel builds the new production commit itself. Until that deployment is READY the previous one
 *      keeps serving; `deploymentStatus.mjs` reports which of the two is true, and only a PRODUCTION
 *      deployment of the commit can say so. A commit is never reported as an installed update.
 *
 * The release that was applied is written to `.rwp-version` in the same commit (`VERSION_PATH`): the one
 * record of what this repository runs, read before the package.json (whose version need not match a tag).
 *
 * Release files come from a GitHub release repository (public, or readable with the client's own token).
 * react-wp.com is never sent a credential by this module.
 */
import { createHash } from 'node:crypto';
import { InstallError } from '../pluginInstaller.mjs';
import { commitFiles, createBranch, fastForwardBranch, githubRequest, readBranch, readTextFile } from '../pluginGitPush.mjs';
import { fetchCoreReleaseFiles, manifestAtVersion } from '../releasePackage.mjs';
import {
  PACKAGE_PATH,
  REGISTRY_PATH,
  VERSION_PATH,
  assertCoreWritable,
  mergePackageJson,
  mergeRegistry,
  planCoreFiles,
  readStamp,
  readVersionRecord,
} from './coreMerge.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const plainVersion = (value) => str(value).replace(/^v/i, '');
const isVersion = (value) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(plainVersion(value));
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A release tag as the repository names it: the `v`-prefixed spelling first, the bare one second. */
async function fetchRelease(source, version, fetchImpl) {
  const tried = [];
  for (const tag of [`v${plainVersion(version)}`, plainVersion(version)]) {
    try {
      return { tag, files: await fetchCoreReleaseFiles({ repo: source.repo, token: source.token, version: tag, fetchImpl }) };
    } catch (error) {
      tried.push(error);
      if (Number(error?.status) !== 404) break;
    }
  }
  const last = tried[tried.length - 1];
  throw new InstallError(last instanceof Error ? last.message : `Release ${version} could not be read.`, Number(last?.status) || 502);
}

/** The version the repository's own package.json names — what the production branch is running. */
const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const versionOf = (packageSource) => {
  try {
    return plainVersion(JSON.parse(packageSource)?.version);
  } catch {
    return '';
  }
};

/** How many files of the repository a release would leave as conflicts if it were the installed one. */
const conflictsAgainst = (base, next, branch) => planCoreFiles({ repo: branch.paths, base: base.files, next: next.files }).conflicts.length;

const MAX_BASE_GUESSES = 5;

/**
 * The release the repository runs now — the merge base.
 *
 * With a `.rwp-version` record that is the answer. Without one (a site never updated from here) the
 * package.json version is only a hint — it need not be a tag at all — so the candidates (that hint, then the
 * recent releases the caller lists) are each fetched and the one whose files the repository matches best
 * wins. At most MAX_BASE_GUESSES releases are downloaded. The choice is reported in a warning; with no
 * usable candidate every differing file is a conflict the administrator settles with one button each.
 */
async function resolveBase({ recorded, packageVersion, candidates, source, next, branch, fetchImpl }) {
  if (recorded) {
    try {
      return { base: await fetchRelease(source, recorded, fetchImpl), fromVersion: recorded, baseNote: '' };
    } catch (error) {
      return { base: null, fromVersion: recorded, baseNote: `The installed release ${recorded} could not be read from ${source.repo} (${error instanceof Error ? error.message : 'unknown error'}), so every core file that differs from ${plainVersion(next.tag)} needs your decision.` };
    }
  }
  const tags = [...new Set([packageVersion, ...candidates].map(plainVersion).filter((tag) => isVersion(tag) && tag !== plainVersion(next.tag)))].slice(0, MAX_BASE_GUESSES);
  let best = null;
  for (const tag of tags) {
    try {
      const base = await fetchRelease(source, tag, fetchImpl);
      const score = conflictsAgainst(base, next, branch);
      if (!best || score < best.score) best = { base, score, tag };
      if (score === 0) break;
    } catch {
      // A tag that cannot be read is not a candidate.
    }
  }
  if (best) {
    return { base: best.base, fromVersion: plainVersion(best.tag), baseNote: `This site has no version record yet, so the installed release was worked out from your files: they match ${plainVersion(best.tag)} best. It is recorded in ${VERSION_PATH} with this update.` };
  }
  return { base: null, fromVersion: packageVersion, baseNote: 'This site has no version record and none of the recent releases could be read, so every core file that differs from the release needs your decision.' };
}

const fingerprintOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/**
 * Builds the plan. `resolutions` may already be given (apply rebuilds the plan with them); the
 * fingerprint deliberately does not cover them, so choosing a resolution does not invalidate the plan.
 *
 * @param {{ target: object, source: { repo: string, token?: string }, toVersion: string, resolutions?: Record<string, string>, baseCandidates?: string[], fetchImpl?: typeof fetch }} input
 */
export async function planCoreUpdate({ target, source, toVersion, resolutions = {}, baseCandidates = [], fetchImpl = fetch }) {
  if (!source?.repo) {
    throw new InstallError('No release repository is configured, so there is nothing to update from. Name it on Settings → Updates (or set RWP_RELEASE_REPO).', 409);
  }
  if (source.repo.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()) {
    throw new InstallError(`The release repository and this site's own repository are the same (${source.repo}). A site cannot update itself from its own branch; name React-WP's release repository on Settings → Updates.`, 409);
  }
  if (!isVersion(toVersion)) throw new InstallError(`"${toVersion}" is not a release version.`, 400);

  const branch = await readBranch(target);
  const repoPackage = branch.paths.has(PACKAGE_PATH) ? await readTextFile(target, PACKAGE_PATH) : null;
  const recordSource = branch.paths.has(VERSION_PATH) ? await readTextFile(target, VERSION_PATH) : '';
  // The stamp an update put on package.json says the same thing as the record, so a site updated by code that
  // wrote no record still has an exact base.
  const recorded = readVersionRecord(recordSource) || readStamp(safeJson(repoPackage));
  const packageVersion = repoPackage ? versionOf(repoPackage) : '';

  const next = await fetchRelease(source, toVersion, fetchImpl);
  const { base, fromVersion, baseNote } = await resolveBase({ recorded, packageVersion, candidates: baseCandidates, source, next, branch, fetchImpl });

  const files = planCoreFiles({ repo: branch.paths, base: base?.files || null, next: next.files, resolutions });
  const stamp = `v${plainVersion(toVersion)}\n`;
  if (recordSource !== stamp) files.writes.push({ path: VERSION_PATH, content: encoder.encode(stamp), change: branch.paths.has(VERSION_PATH) ? 'updated' : 'added' });

  // The two merged files.
  const merged = [];
  const mergeConflicts = [];
  const registryRelease = next.files.get(REGISTRY_PATH);
  if (registryRelease) {
    const repoRegistry = branch.paths.has(REGISTRY_PATH) ? await readTextFile(target, REGISTRY_PATH) : null;
    const registry = mergeRegistry({ releaseSource: decoder.decode(registryRelease), repoSource: repoRegistry, repoPaths: branch.paths });
    if (registry.ok) {
      if (registry.source !== repoRegistry) {
        files.writes.push({ path: REGISTRY_PATH, content: encoder.encode(registry.source), change: 'merged' });
      }
      merged.push({ path: REGISTRY_PATH, carried: registry.carried, dropped: registry.dropped });
    } else {
      mergeConflicts.push({ path: REGISTRY_PATH, reason: registry.reason, resolution: null });
    }
  }
  // The release's manifest named at the tag being installed, so package.json never has to match the tag by hand.
  const packageRelease = next.files.get(PACKAGE_PATH) ? manifestAtVersion(next.files.get(PACKAGE_PATH), next.tag) : null;
  if (packageRelease) {
    const pkg = mergePackageJson({
      releaseSource: decoder.decode(packageRelease),
      repoSource: repoPackage,
      baseSource: base?.files.get(PACKAGE_PATH) ? decoder.decode(base.files.get(PACKAGE_PATH)) : null,
    });
    if (pkg.ok) {
      if (pkg.source !== repoPackage) files.writes.push({ path: PACKAGE_PATH, content: encoder.encode(pkg.source), change: 'merged' });
      merged.push({ path: PACKAGE_PATH, carried: pkg.carried, dropped: [] });
    } else {
      mergeConflicts.push({ path: PACKAGE_PATH, reason: pkg.reason, resolution: null });
    }
  }

  const conflicts = [...files.conflicts, ...mergeConflicts];
  const unresolved = [...files.unresolved, ...mergeConflicts.map((item) => item.path)];
  const warnings = [];
  if (baseNote) warnings.push(baseNote);
  const carriedDeps = merged.find((item) => item.path === PACKAGE_PATH)?.carried || [];
  if (carriedDeps.length) {
    warnings.push(`Kept ${carriedDeps.length} dependenc${carriedDeps.length === 1 ? 'y' : 'ies'} this repository added (${carriedDeps.slice(0, 5).join(', ')}${carriedDeps.length > 5 ? ', …' : ''}). package-lock.json comes from the release and does not list them; Vercel's install resolves them during the build.`);
  }

  const fingerprint = fingerprintOf({
    head: branch.commitSha,
    from: fromVersion,
    to: plainVersion(toVersion),
    release: next.tag,
    writes: files.writes.map((write) => [write.path, createHash('sha1').update(write.content).digest('hex')]).sort(),
    deletions: [...files.deletions].sort(),
    conflicts: conflicts.map((item) => item.path).sort(),
  });

  return {
    fingerprint,
    head: branch.commitSha,
    repository: `${target.owner}/${target.repo}`,
    branch: target.branch,
    fromVersion,
    toVersion: plainVersion(toVersion),
    releaseTag: next.tag,
    releaseRepository: source.repo,
    writes: files.writes,
    deletions: files.deletions,
    kept: files.kept,
    unchanged: files.unchanged,
    merged,
    conflicts,
    unresolved,
    warnings,
  };
}

/** The plan as a screen sees it: paths and counts, no file bodies. */
export function describeCorePlan(plan) {
  return {
    fingerprint: plan.fingerprint,
    head: plan.head,
    repository: plan.repository,
    branch: plan.branch,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    releaseTag: plan.releaseTag,
    releaseRepository: plan.releaseRepository,
    added: plan.writes.filter((write) => write.change === 'added').map((write) => write.path),
    updated: plan.writes.filter((write) => write.change === 'updated').map((write) => write.path),
    merged: plan.merged,
    deleted: plan.deletions,
    kept: plan.kept,
    unchanged: plan.unchanged,
    conflicts: plan.conflicts,
    unresolved: plan.unresolved,
    warnings: plan.warnings,
    upToDate: plan.writes.length === 0 && plan.deletions.length === 0 && plan.conflicts.length === 0,
  };
}


const refPath = (target, branch) => `/repos/${target.owner}/${target.repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

/** Removes a staging branch; a branch that is already gone is fine, any other failure only leaves a branch behind. */
async function dropBranch(target, branch) {
  try {
    await githubRequest(target, 'DELETE', refPath(target, branch));
    return true;
  } catch (error) {
    return /HTTP 404|HTTP 422/.test(String(error?.message || ''));
  }
}

const mentions = (error, pattern) => pattern.test(String(error instanceof Error ? error.message : error || ''));

/**
 * Puts `sha` (the head of the staging branch) on the production branch, resolving every obstacle itself.
 *
 * @returns {Promise<{ sha: string, how: 'fast-forward' | 'merge' | 'pull-request' }>}
 */
export async function landOnProduction({ target, updateBranch, sha, title, body }) {
  const where = `${target.owner}/${target.repo}`;
  try {
    // The commit exists but no branch points at it, so this one ref move is the only thing Vercel sees:
    // exactly one (Production) deployment and no staging branch.
    await fastForwardBranch(target, target.branch, sha);
    return { sha, how: 'fast-forward', staged: false };
  } catch (forwardError) {
    // Anything that stopped a direct move — the branch moved on, or a rule refuses direct updates — is
    // tried again as a merge, which GitHub performs on the server against the branch's current head. A merge
    // and a pull request need a branch to merge from, so the staging branch exists only from here on.
    // (A branch of that name left by an earlier attempt holds an older commit, so it is replaced.)
    await dropBranch(target, updateBranch);
    await createBranch(target, updateBranch, sha);
    let mergeError = forwardError;
    try {
      const merged = await githubRequest(target, 'POST', `/repos/${target.owner}/${target.repo}/merges`, {
        base: target.branch,
        head: updateBranch,
        commit_message: title,
      });
      // 204 (an empty body): the branch already contains the update.
      return { sha: str(merged?.sha) || sha, how: 'merge', staged: true };
    } catch (error) {
      mergeError = error;
    }
    if (mentions(mergeError, /HTTP 409/) && mentions(mergeError, /conflict/i)) {
      await dropBranch(target, updateBranch);
      const conflict = new InstallError(`The files changed on "${target.branch}" while the update was being prepared and GitHub could not merge the update into them automatically. Nothing was changed on "${target.branch}". Press Update again to start from its current state.`, 409);
      throw conflict;
    }
    // A branch that only accepts pull requests: open one and merge it through the API with the same token.
    let pullNumber = 0;
    try {
      const pull = await githubRequest(target, 'POST', `/repos/${target.owner}/${target.repo}/pulls`, { title, head: updateBranch, base: target.branch, body });
      pullNumber = Number(pull?.number) || 0;
      if (!pullNumber) throw new InstallError('GitHub opened the pull request but did not return its number.', 502);
      const merged = await githubRequest(target, 'PUT', `/repos/${target.owner}/${target.repo}/pulls/${pullNumber}/merge`, { merge_method: 'merge', sha });
      return { sha: str(merged?.sha) || sha, how: 'pull-request', staged: true };
    } catch (pullError) {
      if (pullNumber) {
        await githubRequest(target, 'PATCH', `/repos/${target.owner}/${target.repo}/pulls/${pullNumber}`, { state: 'closed' }).catch(() => {});
      }
      const reason = pullError instanceof Error ? pullError.message : 'GitHub refused the merge.';
      throw new InstallError(`"${target.branch}" in ${where} could not be updated: ${reason} It looks protected by a rule this token cannot satisfy (required reviews or status checks, or a push restriction). Nothing was changed on "${target.branch}" and the temporary branch was removed. In GitHub → Settings → Branches, allow the connected account to merge to "${target.branch}" (or switch the rule off), then press Update again.`, Number(pullError?.status) || 409);
    }
  }
}

/**
 * Applies a plan the administrator approved. On success the update is on the production branch; the caller
 * then follows Vercel's PRODUCTION deployment of `commit.sha`.
 *
 * @param {{ target: object, source: object, toVersion: string, fingerprint: string, resolutions?: Record<string, string>, baseCandidates?: string[], fetchImpl?: typeof fetch, guard?: ((plan: object) => void) | null }} input
 */
export async function applyCoreUpdate({ target, source, toVersion, fingerprint, resolutions = {}, baseCandidates = [], fetchImpl = fetch, guard = null }) {
  if (!str(fingerprint)) throw new InstallError('Review the update plan first: applying it needs the plan\'s fingerprint.', 428);
  const plan = await planCoreUpdate({ target, source, toVersion, resolutions, baseCandidates, fetchImpl });
  if (plan.fingerprint !== str(fingerprint)) {
    throw new InstallError('The repository or the release changed after the plan you reviewed was made, so nothing was applied. Press Update again to review the current state.', 409);
  }
  // An optional last check the caller owns (the downgrade confirmation), run on the plan that is about to be
  // committed and before anything is written. It throws to refuse.
  if (typeof guard === 'function') guard(plan);
  if (plan.unresolved.length) {
    const error = new InstallError(`${plan.unresolved.length} file(s) need your decision before the update can be applied: ${plan.unresolved.slice(0, 5).join(', ')}${plan.unresolved.length > 5 ? ', …' : ''}. Nothing was committed.`, 409);
    error.conflicts = plan.unresolved;
    throw error;
  }
  if (!plan.writes.length && !plan.deletions.length) {
    return { applied: false, upToDate: true, plan: describeCorePlan(plan), commit: null, merged: false, productionBranch: target.branch };
  }

  const updateBranch = `rwp/core-${plan.toVersion}-${plan.head.slice(0, 7)}`.replace(/[^A-Za-z0-9._/-]/g, '-');
  const base = await readBranch(target);
  if (base.commitSha !== plan.head) {
    throw new InstallError(`Branch "${target.branch}" changed while the update was being prepared. Nothing was committed; press Update again.`, 409);
  }
  const title = `Update React-WP core ${plan.fromVersion || 'unknown'} → ${plan.toVersion}`;
  const commit = await commitFiles(target, {
    message: `${title}\n\nRelease ${plan.releaseRepository}@${plan.releaseTag}. Plugins and site files were left as they were.`,
    files: plan.writes.map((write) => ({ path: write.path, content: write.content })),
    deletions: plan.deletions,
    base,
    pathPolicy: (path) => {
      try {
        assertCoreWritable(path);
      } catch (error) {
        throw new InstallError(error instanceof Error ? error.message : String(error), 500);
      }
    },
    ref: { none: true },
  });

  let landed;
  try {
    landed = await landOnProduction({
      target,
      updateBranch,
      sha: commit.sha,
      title,
      body: `Applied by this site's update screen from ${plan.releaseRepository}@${plan.releaseTag}. Plugins under plugins/ were not touched.`,
    });
  } catch (error) {
    // Nothing reached production, so the staging branch has no job left.
    await dropBranch(target, updateBranch);
    throw error;
  }
  const leftover = landed.staged && !(await dropBranch(target, updateBranch)) ? updateBranch : '';
  return {
    applied: true,
    merged: true,
    landedBy: landed.how,
    productionBranch: target.branch,
    plan: describeCorePlan(plan),
    // `sha` is the commit now at the tip of the production branch: the one Vercel deploys.
    commit: { sha: landed.sha, url: landed.sha === commit.sha ? commit.url : `https://github.com/${target.owner}/${target.repo}/commit/${landed.sha}`, branch: target.branch, updateBranch: leftover },
  };
}

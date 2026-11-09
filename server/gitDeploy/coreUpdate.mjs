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
 *              The commit goes onto a new branch `rwp/core-<version>-<head>` first, so a half-finished
 *              update can never be on the production branch, and then:
 *                - `direct`: the production branch is fast-forwarded to it (`force: false`, so a branch
 *                  that moved in the meantime refuses and nothing is overwritten — the update branch is
 *                  left for a pull request), or
 *                - `pull_request`: a pull request is opened and nothing touches production until a
 *                  person merges it.
 *   3. Vercel builds the new production commit itself. Until that deployment is READY the previous one
 *      keeps serving; `deploymentStatus.mjs` reports which of the two is true. A commit is never reported
 *      as an installed update.
 *
 * Release files come from a GitHub release repository (public, or readable with the client's own token).
 * react-wp.com is never sent a credential by this module.
 */
import { createHash } from 'node:crypto';
import { InstallError } from '../pluginInstaller.mjs';
import { commitFiles, fastForwardBranch, githubRequest, readBranch, readTextFile } from '../pluginGitPush.mjs';
import { fetchCoreReleaseFiles } from '../releasePackage.mjs';
import {
  PACKAGE_PATH,
  REGISTRY_PATH,
  assertCoreWritable,
  mergePackageJson,
  mergeRegistry,
  planCoreFiles,
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
const versionOf = (packageSource) => {
  try {
    return plainVersion(JSON.parse(packageSource)?.version);
  } catch {
    return '';
  }
};

const fingerprintOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/**
 * Builds the plan. `resolutions` may already be given (apply rebuilds the plan with them); the
 * fingerprint deliberately does not cover them, so choosing a resolution does not invalidate the plan.
 *
 * @param {{ target: object, source: { repo: string, token?: string }, toVersion: string, resolutions?: Record<string, string>, fetchImpl?: typeof fetch }} input
 */
export async function planCoreUpdate({ target, source, toVersion, resolutions = {}, fetchImpl = fetch }) {
  if (!source?.repo) {
    throw new InstallError('No release repository is configured, so there is nothing to update from. Name it on Settings → Updates (or set RWP_RELEASE_REPO).', 409);
  }
  if (source.repo.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase()) {
    throw new InstallError(`The release repository and this site's own repository are the same (${source.repo}). A site cannot update itself from its own branch; name React-WP's release repository on Settings → Updates.`, 409);
  }
  if (!isVersion(toVersion)) throw new InstallError(`"${toVersion}" is not a release version.`, 400);

  const branch = await readBranch(target);
  const repoPackage = branch.paths.has(PACKAGE_PATH) ? await readTextFile(target, PACKAGE_PATH) : null;
  const fromVersion = repoPackage ? versionOf(repoPackage) : '';

  const next = await fetchRelease(source, toVersion, fetchImpl);
  let base = null;
  let baseNote = '';
  if (isVersion(fromVersion)) {
    try {
      base = await fetchRelease(source, fromVersion, fetchImpl);
    } catch (error) {
      baseNote = `The installed release ${fromVersion} could not be read from ${source.repo} (${error instanceof Error ? error.message : 'unknown error'}), so every core file that differs from ${toVersion} needs your decision.`;
    }
  } else {
    baseNote = 'The repository\'s package.json names no release version, so every core file that differs from the release needs your decision.';
  }

  const files = planCoreFiles({ repo: branch.paths, base: base?.files || null, next: next.files, resolutions });

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
  const packageRelease = next.files.get(PACKAGE_PATH);
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

/**
 * Applies a plan the administrator approved.
 *
 * @param {{ target: object, source: object, toVersion: string, fingerprint: string, resolutions?: Record<string, string>, mode?: 'direct' | 'pull_request', fetchImpl?: typeof fetch, guard?: ((plan: object) => void) | null }} input
 */
export async function applyCoreUpdate({ target, source, toVersion, fingerprint, resolutions = {}, mode = 'direct', fetchImpl = fetch, guard = null }) {
  if (!str(fingerprint)) throw new InstallError('Review the update plan first: applying it needs the plan\'s fingerprint.', 428);
  const plan = await planCoreUpdate({ target, source, toVersion, resolutions, fetchImpl });
  if (plan.fingerprint !== str(fingerprint)) {
    throw new InstallError('The repository or the release changed after the plan you reviewed was made, so nothing was applied. Review the new plan and apply that one.', 409);
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
    return { applied: false, upToDate: true, plan: describeCorePlan(plan), commit: null, merged: false, pullRequest: null };
  }

  const updateBranch = `rwp/core-${plan.toVersion}-${plan.head.slice(0, 7)}`.replace(/[^A-Za-z0-9._/-]/g, '-');
  const base = await readBranch(target);
  if (base.commitSha !== plan.head) {
    throw new InstallError(`Branch "${target.branch}" changed while the update was being prepared. Nothing was committed; review the plan again.`, 409);
  }
  const commit = await commitFiles(target, {
    message: `Update React-WP core ${plan.fromVersion || 'unknown'} → ${plan.toVersion}\n\nRelease ${plan.releaseRepository}@${plan.releaseTag}. Plugins and site files were left as they were.`,
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
    ref: { create: updateBranch },
  });

  if (mode === 'pull_request') {
    const pull = await githubRequest(target, 'POST', `/repos/${target.owner}/${target.repo}/pulls`, {
      title: `Update React-WP core to ${plan.toVersion}`,
      head: updateBranch,
      base: target.branch,
      body: `Prepared by this site's update screen from ${plan.releaseRepository}@${plan.releaseTag}.\n\nUpdated: ${plan.writes.length} file(s); deleted: ${plan.deletions.length}; plugins under plugins/ were not touched.\n\nMerging deploys it to production through Vercel; the current deployment keeps serving until the new one is READY.`,
    });
    return {
      applied: true,
      merged: false,
      plan: describeCorePlan(plan),
      commit: { sha: commit.sha, url: commit.url, branch: updateBranch },
      pullRequest: { number: Number(pull?.number) || 0, url: str(pull?.html_url) },
    };
  }

  try {
    await fastForwardBranch(target, target.branch, commit.sha);
  } catch (error) {
    return {
      applied: false,
      merged: false,
      plan: describeCorePlan(plan),
      commit: { sha: commit.sha, url: commit.url, branch: updateBranch },
      pullRequest: null,
      error: `${error instanceof Error ? error.message : 'The production branch could not be moved.'} The update is waiting on branch "${updateBranch}"; open a pull request from it, or review the plan again.`,
      status: Number(error?.status) || 502,
    };
  }
  // The staging branch has done its job; production now points at the same commit. A failed delete only
  // leaves a branch behind, so it is reported rather than treated as a failed update.
  let leftover = '';
  try {
    await githubRequest(target, 'DELETE', `/repos/${target.owner}/${target.repo}/git/refs/heads/${updateBranch.split('/').map(encodeURIComponent).join('/')}`);
  } catch {
    leftover = updateBranch;
  }
  return {
    applied: true,
    merged: true,
    plan: describeCorePlan(plan),
    commit: { sha: commit.sha, url: commit.url, branch: target.branch, updateBranch: leftover },
    pullRequest: null,
  };
}

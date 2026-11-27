/**
 * "Roll back": puts a paid plugin's folder back the way it was before its last update, from the repository's own history.
 *
 * An update of a licensed plugin (react-wp.com's RWP2 plugins, another seller's plugin sold there, or a developer's RWPD1 plugin)
 * records a rollback point in `license_link_config.rollback_points` (`{ [id]: { version, commit, at } }`): the version that was
 * replaced and the commit the update made. Rolling back reads the tree of that commit's parent (the repository as it was just
 * before) and commits `plugins/<id>/` from it, by blob id (nothing is downloaded, nothing is re-signed: the bytes are the ones the
 * site already verified and ran), deleting what the newer version added. One commit, the installer's own write rules
 * (`commitFiles` only writes inside `plugins/<folder>/`). The point is used once; a second rollback needs a second update.
 *
 * Only from the Roll back button (`POST /api/admin/license-link/rollback`). Throws `InstallError` with a sentence.
 */
import { InstallError } from './pluginInstaller.mjs';
import { commitFiles, githubRequest, githubTargetFrom, readBranch } from './pluginGitPush.mjs';

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Rolls `plugin` back to the files it had before `point.commit`. `deps` are test seams (`readBranch`, `commitFiles`, `githubRequest`).
 * @returns {Promise<{ commit: object, rollback: { id: string, to: string } }>}
 */
export async function rollbackPlugin({ plugin, point, target, deps = {} }) {
  const d = { readBranch, commitFiles, githubRequest, ...deps };
  const id = str(plugin);
  if (!SAFE_PLUGIN_ID.test(id) || !point) throw new InstallError(`There is no earlier version of ${id || 'this plugin'} to go back to from here.`, 404);
  const folder = `plugins/${id}/`;
  const updateCommit = await d.githubRequest(target, 'GET', `/repos/${target.owner}/${target.repo}/git/commits/${point.commit}`);
  const parent = str(updateCommit?.parents?.[0]?.sha);
  if (!SHA.test(parent)) throw new InstallError('The commit before the last update could not be read from GitHub.', 502);
  const before = await d.githubRequest(target, 'GET', `/repos/${target.owner}/${target.repo}/git/commits/${parent}`);
  const treeSha = str(before?.tree?.sha);
  const tree = SHA.test(treeSha) ? await d.githubRequest(target, 'GET', `/repos/${target.owner}/${target.repo}/git/trees/${treeSha}?recursive=1`) : null;
  if (!tree || tree.truncated === true) throw new InstallError('The repository as it was before the update could not be listed from GitHub, so nothing was rolled back.', 501);
  const old = (Array.isArray(tree.tree) ? tree.tree : [])
    .filter((entry) => entry?.type === 'blob' && str(entry.path).startsWith(folder) && SHA.test(str(entry.sha)))
    .map((entry) => ({ path: str(entry.path), sha: str(entry.sha), mode: str(entry.mode) || '100644' }));
  if (!old.length) throw new InstallError(`${id} was not in the repository before its last update, so there is nothing to go back to. Uninstall it instead.`, 409);
  const base = await d.readBranch(target);
  const keep = new Set(old.map((entry) => entry.path));
  const deletions = [...base.paths.keys()].filter((path) => path.startsWith(folder) && !keep.has(path));
  const commit = await d.commitFiles(target, {
    message: `Roll back ${id} to ${point.version}\n\nRestored plugins/${id}/ as it was before commit ${point.commit.slice(0, 7)} (Plugins → Roll back).`,
    files: old,
    base,
    deletions,
  });
  return { commit, rollback: { id, to: point.version } };
}

export { githubTargetFrom };

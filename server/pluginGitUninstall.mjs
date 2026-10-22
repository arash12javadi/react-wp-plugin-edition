/**
 * Plugins → Uninstall, the code half, on a host that cannot write to its own filesystem.
 *
 * `deletePluginFolder` removes `plugins/<id>/` with `rm`, which a serverless deployment cannot do
 * (`EROFS`) — and a plugin folder only leaves the site after a build anyway. So the same decisions
 * are made against the repository instead: every file of the folder is deleted and the plugin's
 * `server.mjs` import is removed from `server/plugins.mjs`, both in ONE commit, after which the
 * platform is asked to rebuild (`triggerDeployHook`, i.e. `VERCEL_DEPLOY_HOOK_URL`). The database half
 * of an uninstall — export, media, drop — runs exactly as it does on a host with a disk, because it
 * needs a connection and not a filesystem.
 *
 * The rules are the disk path's rules, enforced here for the same reason: only an inactive plugin may
 * be deleted, and a plugin whose code another plugin imports is refused, because the next build would
 * fail. That importer list comes from the build (`pluginCatalogue()` runs `findImporters` on the
 * checkout the deployment was built from) — a request-time scan of every other plugin's source is not
 * something a function with no filesystem can do.
 *
 * Every refusal throws with the sentence `deletePluginFolder` answers with, so the uninstall route
 * reports a kept folder identically on both hosts.
 */
import { InstallError, triggerDeployHook } from './pluginInstaller.mjs';
import { commitFiles, readBranch, readTextFile } from './pluginGitPush.mjs';
import { removeServerPluginImportFromSource } from './serverPluginImports.mjs';

const REGISTRY_PATH = 'server/plugins.mjs';
const PLUGINS_ROOT = 'plugins';
const encoder = new TextEncoder();

/** One uninstall at a time, as the upload path allows one install at a time: same branch, same files. */
let uninstalling = false;

/**
 * `target` is `githubTargetFrom(row)` on the stored `github_config` row, `plugin` is the plugin as the
 * catalogue knows it (`{ id, folder, name, version }`), `activeIds` is `rwp_active_plugins` (`null`
 * when the option is missing) and `importers` is the build's list of plugins importing this one.
 *
 * Returns `{ serverImportRemoved, commit, warnings }`.
 */
export async function uninstallPluginFromGit({ target, plugin, activeIds = null, importers = [] }) {
  if (uninstalling) throw new InstallError('Another plugin is being uninstalled right now. Wait for it to finish, then try again.', 409);
  uninstalling = true;
  try {
    const where = `${target.owner}/${target.repo}`;
    // The disk path's two refusals, in its order and in its words.
    if (activeIds === null || activeIds.includes(plugin.id)) {
      throw new InstallError(`"${plugin.id}" is active. Deactivate it before deleting it.`, 409);
    }
    if (importers.length) {
      throw new InstallError(`"${plugin.id}" cannot be deleted: ${importers.join(', ')} import${importers.length === 1 ? 's' : ''} its code, so the next build would fail. Delete that plugin first.`, 409);
    }

    const base = await readBranch(target);
    const prefix = `${PLUGINS_ROOT}/${plugin.folder}/`;
    const deletions = [...base.paths.keys()].filter((path) => path.startsWith(prefix));

    // The server import goes in the same commit, and is read first: if the edit is refused, the folder
    // was never touched, so the plugin is left fully installed rather than half-removed.
    const files = [];
    let serverImportRemoved = false;
    if (base.paths.has(`${prefix}server.mjs`)) {
      const current = await readTextFile(target, REGISTRY_PATH);
      if (current === null) {
        throw new InstallError(`This plugin ships a server.mjs, but ${REGISTRY_PATH} was not found on branch "${target.branch}" of ${where}, so its import could not be removed. Restore the file, then uninstall the plugin again.`, 500);
      }
      let edit;
      try {
        edit = removeServerPluginImportFromSource(current, plugin.folder);
      } catch (error) {
        throw new InstallError(`The plugin's import could not be removed from ${REGISTRY_PATH}, so nothing was committed: ${error?.message || error}`, 500);
      }
      serverImportRemoved = edit.changed;
      if (edit.changed) files.push({ path: REGISTRY_PATH, content: encoder.encode(edit.source) });
    }

    if (!deletions.length && !files.length) {
      // A previous uninstall already removed it from this branch, or it was never there. Nothing to
      // commit, and saying so is more honest than an empty commit.
      return {
        serverImportRemoved: false,
        commit: null,
        warnings: [`plugins/${plugin.folder}/ is not on branch "${target.branch}" of ${where} any more, so the repository was left alone. This deployment keeps the plugin's code until it is built again from that branch.`],
      };
    }

    const commit = await commitFiles(target, {
      message: `Uninstall plugin ${plugin.id} ${plugin.version} (from the admin)`,
      files,
      base,
      deletions,
      // The registry is the one file outside the plugin folder an uninstall is allowed to touch.
      allowPaths: [REGISTRY_PATH],
    });

    const warnings = [
      `${commit.repository} has this change in one commit (${commit.sha.slice(0, 7)}): plugins/${plugin.folder}/ is gone from the site once that commit is built and deployed.`,
    ];
    if (!deletions.length) {
      warnings.push(`plugins/${plugin.folder}/ was not on the branch: only its server import was removed.`);
    }
    if (serverImportRemoved) {
      warnings.push(`Its import was removed from ${REGISTRY_PATH} in the same commit, so the next build cannot load a plugin that is no longer there.`);
    }
    if (commit.deletionsSkipped.length) {
      warnings.push(`GitHub did not accept the deletion of ${commit.deletionsSkipped.length} file(s) (${commit.deletionsSkipped.slice(0, 3).join(', ')}${commit.deletionsSkipped.length > 3 ? ', …' : ''}). They are still in plugins/${plugin.folder}/ and may end up in the build; delete them on GitHub.`);
    }

    const deploy = await triggerDeployHook();
    if (!deploy.configured) {
      warnings.push('No rebuild was triggered: this deployment has no VERCEL_DEPLOY_HOOK_URL. The repository no longer holds the plugin, so building or redeploying from there leaves it out. Create a deploy hook (Vercel → the project → Settings → Git → Deploy Hooks) and set VERCEL_DEPLOY_HOOK_URL to have uninstalls redeploy themselves.');
    }

    return {
      serverImportRemoved,
      commit: { sha: commit.sha, url: commit.url, repository: commit.repository, branch: target.branch, deletions: commit.deletions },
      warnings,
    };
  } finally {
    uninstalling = false;
  }
}

/**
 * The code half of an uninstall, for a host whose `plugins/` folder belongs to the repository its
 * deployment is built from: the deletion is committed instead of made, because a serverless
 * filesystem would refuse the `rm` and forget the folder before the next request anyway.
 *
 * Returned in the shape `pluginUninstall.mjs`'s `removeFolder` expects, and it never throws for the
 * same reason `removePluginFolderFromDisk` does not: "this plugin is still active", "another plugin
 * imports it", "GitHub refused the commit" are each a warning beside the code they concern, not a 500
 * that would throw away the report of a wipe that has already happened.
 *
 * `resolveTarget` is a function rather than the connection, and that is the point of it: reading the
 * stored `github_config` row can fail — it is `githubTarget`'s 501, "the connection is stored but
 * cannot be read" — and asking for it before the database half ran would fail an uninstall whose
 * tables are already dropped over a missing credential.
 */
export function pluginFolderRemover({ resolveTarget }) {
  return async ({ plugin, importers = [], readActiveIds }) => {
    try {
      const result = await uninstallPluginFromGit({
        target: await resolveTarget(),
        plugin,
        activeIds: await readActiveIds(),
        importers,
      });
      return {
        // A commit means the branch no longer holds the plugin; this deployment keeps it until that
        // commit is built, which is what the warnings say in as many words.
        folderDeleted: Boolean(result.commit),
        serverImportRemoved: result.serverImportRemoved,
        git: result.commit,
        warnings: result.warnings,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      return { folderDeleted: false, serverImportRemoved: false, warnings: [`plugins/${plugin.folder}/ was kept: ${reason}`] };
    }
  };
}

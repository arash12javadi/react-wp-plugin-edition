/**
 * Plugins → Upload Plugin on a host that cannot write to its own filesystem.
 *
 * A serverless deployment has no writable disk: `server/pluginInstaller.mjs` fails there with
 * `EROFS` when it creates `plugins/<id>/`, and a plugin folder only becomes part of the site after a
 * build anyway. So the steps are the same ones the admin already sees in the upload dialog — and the
 * ZIP is checked by the very same functions — but the file work happens on the repository instead:
 * one commit adds `plugins/<id>/`, removes what a previous version left behind, and registers the
 * plugin's `server.mjs` in `server/plugins.mjs`, and then the platform is asked to rebuild from that
 * commit (`triggerDeployHook`, with the hook saved on Settings → Integrations → Deployments, or
 * `VERCEL_DEPLOY_HOOK_URL` where the host has no hub in front of it).
 *
 * Everything the classic installer reports is still reported: the SQL files to run, the npm packages
 * the build would miss, the `rwp_active_plugins` pinning that keeps a new plugin inactive, and the
 * deploy hook's answer. The result is the same shape `src/components/PluginUploadModal.tsx` renders
 * for the classic path, so both hosts show the same screen.
 *
 * The credential is the stored `github_config` row (Settings → Integrations → GitHub) — see
 * `pluginGitPush.mjs`, which owns the API calls and refuses to write outside `plugins/<folder>/`.
 */
import {
  InstallError,
  downloadZip,
  inspectDependencies,
  pinActivePluginsWithStore,
  readManifest,
  sqlFiles,
  triggerDeployHook,
  unpack,
} from './pluginInstaller.mjs';
import { commitFiles, readBranch, readTextFile } from './pluginGitPush.mjs';
import { addServerPluginImportToSource, removeServerPluginImportFromSource } from './serverPluginImports.mjs';
import { PUBLIC_EDITION, currentEdition, isDevEditionPlugin } from '../src/lib/pluginEdition.js';

/** Where a plugin's server routes are registered, as `plugins/README.md` documents. */
const REGISTRY_PATH = 'server/plugins.mjs';
const PLUGINS_ROOT = 'plugins';
const encoder = new TextEncoder();

let installing = false;

/** The plugin ids the repository already carries: `plugins/<id>/manifest.json` and nothing else. */
function pluginFolderIds(paths) {
  const ids = [];
  for (const path of paths) {
    const match = /^plugins\/([a-z0-9][a-z0-9-]{0,63})\/manifest\.json$/.exec(path);
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)].sort();
}

// The rwp_active_plugins guard — a new plugin must arrive inactive — is `pinActivePluginsWithStore` in
// pluginInstaller.mjs: the disk path needs the identical guard, so it lives with the installer both
// paths share instead of in two copies that could drift.

/**
 * Installs one plugin by committing it to the repository the deployment is built from.
 *
 * `source` is `{ zip }` (uploaded) or `{ url }` (fetched), exactly as the classic installer takes it,
 * because the dialog offers both. `target` is `githubTargetFrom(row)` on the stored `github_config`
 * row. `onStep` receives the step ids `PluginUploadModal` renders, in the order it expects them;
 * `optionStore` is the engine's database adapter, used only to pin `rwp_active_plugins`; `deployHook` is
 * the URL saved on Settings → Integrations → Deployments, resolved by the caller. The return value is the
 * shape that dialog renders.
 */
export async function installPluginFromGit({ source, target, optionStore, deployHook, onStep = () => {}, expectedId = '', gitDeploys = false }) {
  if (installing) throw new InstallError('Another plugin is being installed right now. Wait for it to finish, then try again.', 409);
  installing = true;
  try {
    let zip = source?.zip;
    if (!zip) {
      onStep('downloading');
      zip = await downloadZip(String(source?.url || ''));
    }

    onStep('extracting');
    const entries = unpack(zip);

    onStep('validating');
    if (!entries.has('manifest.json')) throw new InstallError('No manifest.json was found in the ZIP.');
    const manifest = readManifest(entries);
    if (!entries.has('index.tsx')) {
      throw new InstallError(`index.tsx is missing next to manifest.json. The build loads plugins from plugins/${manifest.id}/index.tsx.`);
    }
    // The edition rule `registerPlugin` and `server/plugins.mjs` enforce at run time, enforced before the
    // commit as well: a development-edition plugin must never enter a client's public-edition repository.
    if (currentEdition() === PUBLIC_EDITION && isDevEditionPlugin(manifest.id)) {
      throw new InstallError(`"${manifest.id}" is a development-edition plugin and is not installed on this edition of React-WP.`, 403);
    }
    // An update names the plugin it updates; a package for a different id is refused instead of being
    // committed beside it (or over a different plugin's folder).
    if (expectedId && manifest.id !== expectedId) {
      throw new InstallError(`This package is plugin "${manifest.id}", not "${expectedId}", so it was not installed as an update of "${expectedId}". Nothing was committed.`, 409);
    }
    const sql = sqlFiles(entries);
    // The function's own folder has no package.json; the repository the site is built from does.
    const rootPackage = await readTextFile(target, 'package.json').catch(() => null);
    const dependencies = await inspectDependencies(entries, rootPackage === null ? {} : { rootPackage });
    const hasServer = entries.has('server.mjs');

    onStep('installing');
    const base = await readBranch(target);
    const folder = `${PLUGINS_ROOT}/${manifest.id}`;
    const previous = [...base.paths.keys()].filter((path) => path.startsWith(`${folder}/`));
    const files = [...entries].map(([name, bytes]) => ({ path: `${folder}/${name}`, content: bytes }));

    let registryChanged = false;
    let registryRemoved = false;
    if (!hasServer && previous.includes(`${folder}/server.mjs`)) {
      // The previous version had server routes and this one has none: its import must leave the registry in
      // the same commit, or the build would import a file the commit deletes. Only this plugin's line goes.
      const current = await readTextFile(target, REGISTRY_PATH);
      if (current !== null) {
        let edit;
        try {
          edit = removeServerPluginImportFromSource(current, manifest.id);
        } catch (error) {
          throw new InstallError(`This version drops the plugin's server.mjs, but its import could not be removed from ${REGISTRY_PATH}, so nothing was committed: ${error?.message || error}`, 500);
        }
        if (edit.changed) {
          registryRemoved = true;
          files.push({ path: REGISTRY_PATH, content: encoder.encode(edit.source) });
        }
      }
    }
    if (hasServer) {
      const current = await readTextFile(target, REGISTRY_PATH);
      if (current === null) {
        throw new InstallError(`This plugin ships a server.mjs, but ${REGISTRY_PATH} was not found on branch "${target.branch}" of ${target.owner}/${target.repo}. Restore it, then upload the plugin again.`, 500);
      }
      let edit;
      try {
        edit = addServerPluginImportToSource(current, manifest.id);
      } catch (error) {
        throw new InstallError(`The plugin has a server.mjs, but its import could not be added to ${REGISTRY_PATH}, so nothing was committed: ${error?.message || error}`, 500);
      }
      registryChanged = edit.changed;
      if (edit.changed) files.push({ path: REGISTRY_PATH, content: encoder.encode(edit.source) });
    }

    const commit = await commitFiles(target, {
      message: `${previous.length ? 'Update' : 'Install'} plugin ${manifest.id} ${manifest.version} (uploaded from the admin)`,
      files,
      base,
      deletions: previous.filter((path) => !files.some((file) => file.path === path)),
      allowPaths: [REGISTRY_PATH],
    });

    const serverRoutes = { detected: hasServer, registered: hasServer && registryChanged };
    if (hasServer) onStep('registering-routes');

    const warnings = commit.unchanged ? [
      `${commit.repository} already holds exactly this version of the plugin, so no commit was made — this is what a retried install looks like after the first attempt landed.`,
    ] : [
      `${commit.repository} now has this plugin in one commit (${commit.sha.slice(0, 7)}): it becomes part of the site — and can be activated under Plugins — once that commit is built and deployed.`,
    ];
    if (previous.length) {
      warnings.push(`plugins/${manifest.id}/ already existed on this branch; its ${previous.length} file(s) were replaced by this upload.`);
    }
    if (commit.deletions) warnings.push(`${commit.deletions} file(s) an earlier version left in plugins/${manifest.id}/ were deleted in the same commit.`);
    if (commit.deletionsSkipped.length) {
      warnings.push(`GitHub did not accept the deletion of ${commit.deletionsSkipped.length} file(s) (${commit.deletionsSkipped.slice(0, 3).join(', ')}${commit.deletionsSkipped.length > 3 ? ', …' : ''}). They are still in plugins/${manifest.id}/ and may end up in the build; delete them on GitHub.`);
    }

    if (dependencies.unchecked) warnings.push(dependencies.unchecked);
    const pinWarning = await pinActivePluginsWithStore(optionStore, pluginFolderIds(base.paths.keys()));
    if (pinWarning) warnings.push(pinWarning);

    if (registryRemoved) warnings.push(`This version has no server.mjs, so its import was removed from ${REGISTRY_PATH}; every other plugin's line was left as it was.`);

    onStep('triggering-rebuild');
    // A project connected to this repository through Vercel's Git integration deploys the commit by itself.
    // Calling the deploy hook too would start a second build of the same commit, so it is skipped, and the
    // dialog follows the deployment for this commit instead (GET /api/admin/deployment/status?sha=).
    const deploy = gitDeploys
      ? { configured: true, triggered: false, git: true, skipped: 'git-integration' }
      : commit.unchanged
        ? { configured: Boolean(deployHook), triggered: false, skipped: 'unchanged' }
        : await triggerDeployHook(deployHook);
    if (gitDeploys) {
      warnings.push(commit.unchanged
        ? 'No new deployment starts, because nothing was committed.'
        : 'Vercel deploys this commit by itself (the project is connected to this repository). The plugin is part of the site once that deployment is READY; Settings → Integrations → GitHub & Vercel shows its state, and Plugins lists it as inactive until you activate it.');
    } else if (!deploy.configured) {
      warnings.push('No rebuild was triggered: this deployment has no deploy hook, so a platform that builds from the repository does not know this commit exists. The plugin is in the repository already, so building or redeploying from there installs it. Create one (Vercel → the project → Settings → Git → Deploy Hooks) and paste it under Settings → Integrations → Deployments to have uploads redeploy themselves.');
    }

    return {
      plugin: { id: manifest.id, name: manifest.name, version: manifest.version, folder: manifest.id },
      files: entries.size,
      serverRoutes,
      sql,
      dependencies,
      deploy,
      restart: {
        required: false,
        reason: `Nothing on this host has to be restarted: it is built from ${target.owner}/${target.repo}, and that platform redeploys when it builds the commit this upload just made.`,
      },
      warnings,
      commit: { sha: commit.sha, url: commit.url, repository: commit.repository, branch: target.branch, deletions: commit.deletions, unchanged: Boolean(commit.unchanged) },
      // Only "pending": the commit exists, nothing is known about its deployment yet. The real state comes
      // from Vercel (GET /api/admin/deployment/status?sha=), never from this answer.
      deployment: gitDeploys && !commit.unchanged ? { sha: commit.sha, state: 'pending' } : null,
    };
  } finally {
    installing = false;
  }
}

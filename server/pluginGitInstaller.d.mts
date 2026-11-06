/**
 * Types for `server/pluginGitInstaller.mjs` — Plugins → Upload Plugin on a host with no writable disk.
 *
 * Plain ESM for the same reason as `pluginGitPush.mjs` (see its declarations): one implementation of
 * the upload, run by whichever engine the site is deployed on. `PluginGitInstallResult` below is kept
 * equal to the interface `src/components/PluginUploadModal.tsx` renders — the dialog is deliberately
 * one component for both hosts, so a field renamed here has to be renamed there.
 *
 * The shared half of that contract — the step ids, what to install, the adapter the `rwp_active_plugins`
 * guard uses, and the two shapes the result is built from — is declared in `pluginInstaller.mjs`, which
 * implements all of it for both installers. It is re-exported here so a caller that already names one of
 * these types for the disk path does not have to name a second, identical type for the repository path.
 */
import type { GithubCommitTarget } from './pluginGitPush.mjs';
import type {
  PluginInstallDependency,
  PluginInstallOptionStore,
  PluginInstallSource,
  PluginInstallSqlFile,
  PluginInstallStep,
} from './pluginInstaller.mjs';

export type {
  PluginInstallDependency,
  PluginInstallOptionStore,
  PluginInstallSource,
  PluginInstallSqlFile,
  PluginInstallStep,
};

/** What `installPluginFromGit` resolves with, and what the dialog renders. */
export interface PluginGitInstallResult {
  plugin: { id: string; name: string; version: string; folder: string };
  /** Files committed, i.e. the plugin's own entries. */
  files: number;
  serverRoutes: { detected: boolean; registered: boolean };
  sql: PluginInstallSqlFile[];
  dependencies: { missing: PluginInstallDependency[]; installCommand: string | null };
  deploy: { configured: boolean; triggered: boolean; status?: number; error?: string; git?: boolean; skipped?: string };
  /**
   * Always `required: false` here: the site is built from the repository, and the platform under it
   * redeploys when it builds the commit. There is no local process to restart.
   */
  restart: { required: boolean; reason: string };
  warnings: string[];
  /** The one commit the upload made — the Git host's answer to what the classic path wrote to disk. */
  commit: {
    sha: string;
    url: string;
    repository: string;
    branch: string;
    deletions: number;
    /** True when the branch already held this exact tree (a retry that had landed), so nothing was committed. */
    unchanged?: boolean;
  };
  /** Set when the project deploys from Git by itself; the state is only ever `pending` here. */
  deployment?: { sha: string; state: 'pending' } | null;
}

/**
 * Installs one plugin by committing it to the repository the deployment is built from.
 *
 * `target` is `githubTargetFrom(row)` on the stored `github_config` row. `onStep` receives the step ids
 * the dialog renders, in the order it expects them. Only one install runs at a time: a second call while
 * one is in flight throws an `InstallError` with status 409 rather than interleaving two commits.
 *
 * `deployHook` is the saved hook (`deploy_config`, Settings → Integrations → Deployments) the commit is
 * followed by. It is a secret the caller reads and hands over — the installer only spends it — and an
 * empty one means the site has no rebuild target yet, which the warning in the result says out loud.
 */
export function installPluginFromGit(options: {
  source: PluginInstallSource;
  target: GithubCommitTarget;
  optionStore?: PluginInstallOptionStore;
  deployHook?: string;
  onStep?: (step: PluginInstallStep) => void;
  /** When set, a package for any other plugin id is refused (an update of one named plugin). */
  expectedId?: string;
  /** True when the Vercel project deploys this repository by itself, so no deploy hook is called. */
  gitDeploys?: boolean;
}): Promise<PluginGitInstallResult>;

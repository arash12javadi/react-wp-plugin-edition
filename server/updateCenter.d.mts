/**
 * Types for `server/updateCenter.mjs` — the check, the plan and the deploy-hook call, shared by
 * `server.mjs` (`server/updateRoutes.mjs`) and the universal engine (`src/server/routes/updates.ts`).
 *
 * The implementation is plain ESM because the classic host cannot import TypeScript. This declaration
 * is what lets the type-checked Hono routes call it, and it is the one place the JSON these routes
 * answer with is written down: `src/lib/updateCenter.ts` mirrors `UpdateCheck`, `UpdatePlan` and
 * `UpdateConfigView` field for field.
 */
import type { IntegrationReadOptions } from './integrationSettings.mjs';

/** The `system_settings` rows this feature owns. */
export const UPDATE_CONFIG_KEY: string;
export const VERSION_STATE_KEY: string;
export const VERSION_STATE_HISTORY_LIMIT: number;

export const DEFAULT_CENTRAL_URL: string;
export const CENTRAL_CHECK_PATH: string;
export const CENTRAL_CHECK_FALLBACK_PATH: string;
export const CENTRAL_CHECK_PATHS: readonly string[];
export const CENTRAL_APPLY_PATH: string;
export const CENTRAL_INSTALL_PATH: string;
export const CENTRAL_INSTALL_TIMEOUT_MS: number;
export const PLUGIN_DIRECTORY_PATH: string;

export const UPDATE_CHANNELS: readonly string[];
export const AUTO_CHECK_KEYS: readonly string[];

/**
 * The sentences a managed (customer) site is told when its one source — `react-wp.com` — does not answer.
 *
 * They name no token, no repository, no deploy hook and no git: none of those are things the reader of
 * that screen can act on. `unavailable` takes the status the platform answered with.
 */
export const MANAGED_MESSAGES: {
  not_connected: string;
  refused: string;
  unreachable: string;
  unavailable(status: number): string;
  no_api: string;
  no_release: string;
  cannot_apply: string;
  /** `mode: 'platform'`: the platform rebuilds this site when the button is pressed. */
  platform_applies: string;
  /** The platform this site uses was built before `/api/v1/updates/install` existed. */
  no_install_api: string;
  /** The platform answered with a refusal; the status is the only detail a customer is told. */
  install_failed(status: number): string;
  /** The platform has no record of the address this site reports (`code: 'no_project_recorded'`). */
  install_no_project: string;
  /** The platform's Vercel account cannot see the site's project (`code: 'project_not_found'`). */
  install_project_missing: string;
  /** No token of the owner's is stored for the project (`code: 'no_credential'`). */
  install_no_credential: string;
  /** The owner's stored token no longer works (`code: 'stored_token_rejected'`). */
  install_token_rejected: string;
  /** The rebuild request never completed, so whether it finished is unknown. */
  install_unreachable: string;
};

/** A refusal that carries the status code to answer with. */
export class UpdateError extends Error {
  constructor(message: string, status?: number);
  status: number;
}

/** One release, from the central answer or a GitHub release tag. */
export interface UpdateRelease {
  version: string;
  /** The published tag, `v2.4.1` — the one thing this feature treats as the version. */
  tag: string;
  released: string;
  notes: string[];
  changelog_url: string;
  /** Server-side only: a per-site download URL is never sent to a browser. */
  download_url: string;
  critical: boolean;
}

/** A release as a browser sees it. */
export type PublicUpdateRelease = Omit<UpdateRelease, 'download_url'>;

/** `system_settings.updates_config`, normalised. */
export interface UpdateConfig {
  central_url: string;
  token: string;
  /** `owner/name` of the repository this site is updated from, or empty to use the GitHub integration's. */
  repository: string;
  channel: string;
  auto_check: string;
  notify: boolean;
  self_update: boolean;
}

/**
 * The repository a check reads release tags from when this deployment owns it. `token` is empty for a
 * public repository, which is a supported state rather than an error.
 */
export interface GithubUpdateSource {
  repo: string;
  token: string;
  /** True when `updates_config.repository` named it, which is what makes GitHub the first source asked. */
  explicit?: boolean;
}

/** The same configuration with the token replaced by `has_token`. */
export interface UpdateConfigView {
  central_url: string;
  /** The repository named on Settings → Updates, or empty when the GitHub integration names it instead. */
  repository: string;
  channel: string;
  auto_check: string;
  notify: boolean;
  self_update: boolean;
  has_token: boolean;
  source: 'central' | 'github';
  /** True for an end user whose updates are managed by react-wp.com. */
  managed?: boolean;
}

/** What the browser knows and the server cannot: which build is running. */
export interface CurrentVersion {
  app: string;
  site?: string;
}

/** One installed plugin, as the check reports it to the central server. */
export interface InstalledPluginVersion {
  id: string;
  name?: string;
  version: string;
}

/** The newest release and where it came from. */
export interface UpdateCheck {
  format: 'rwp-update-center';
  version: 1;
  source: 'central' | 'github';
  checked_at: string;
  app: {
    installed: string;
    latest: string;
    /** The published tag, `v2.4.1`. What the screen shows as "latest". */
    latest_tag: string;
    update_available: boolean;
    release: PublicUpdateRelease | null;
  };
  plugins: Record<string, PublicUpdateRelease | null>;
  updates: Array<{
    id: string;
    name: string;
    kind: 'app' | 'plugin';
    installed: string;
    latest: string;
    release: PublicUpdateRelease | null;
  }>;
  update_available: boolean;
  /** The central contract: four names any client can rely on without reading the rest. */
  installedVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes: string;
  releaseUrl: string;
  /** A source that was tried and refused, worded for the administrator. */
  error: string;
}

/** The stages a plan runs, in order. The screen names them; there are no by-hand steps to print. */
export interface UpdatePlan {
  /**
   * `deploy-hook` and `self` run on this site. `platform` means the platform rebuilds it, so nothing here
   * builds anything and `requestPlatformInstall` is what the button calls.
   */
  mode: 'deploy-hook' | 'self' | 'platform' | 'manual';
  reason: string;
  steps: string[];
  up_to_date?: boolean;
}

/** `system_settings.version_state`, as a screen renders it. */
export interface VersionStateView {
  app_installed: string;
  app_installed_at: string;
  pending: boolean;
  last_checked_at: string;
  last_update: null | {
    at: string;
    from: string;
    to: string;
    mode: string;
    status: string;
    error: string;
  };
  history: Array<Record<string, unknown>>;
}

export function parseVersion(value: unknown): { parts: number[]; pre: string };
export function compareVersions(a: string, b: string): number;
export function isVersion(value: unknown): boolean;

export function updateConfigFrom(value: unknown): UpdateConfig;
export function describeUpdateConfig(config: UpdateConfig, owner?: boolean): UpdateConfigView;
export function saasInstalledVersionFrom(value: unknown): string;

/**
 * The version this host reports, in one order shared by both hosts: the deploy's pin, the installer's
 * record, the newest release this deployment publishes, then the `package.json` the build compiled.
 */
export function resolveInstalledVersion(input: {
  pinned?: string;
  saas?: string;
  release?: string;
  fallback?: string;
}): string;

/** Drops the remembered release, so the next `latestPublishedVersion` reads GitHub again. */
export function clearPublishedVersion(): void;

/** Newest commit of the owner's update repository (owner only; `null` otherwise or on failure). */
export function latestCommitFor(options?: {
  source?: { repo?: string; token?: string } | null;
  owner?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ sha: string; title: string; description: string; author: string; date: string; url: string } | null>;

/**
 * The newest release tag of the repository this deployment publishes, as a plain version — or `''` when
 * there is nothing to read or the read failed. Cached for a minute; never throws.
 */
export function latestPublishedVersion(options?: {
  source?: { repo?: string; token?: string } | null;
  channel?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<string>;

/**
 * The repository a check may read directly: `updates_config.repository` when Settings → Updates names one,
 * else `RWP_RELEASE_REPO`/`GITHUB_REPO` and `RWP_RELEASE_TOKEN`/`GITHUB_TOKEN` from the environment, else
 * the stored `github_config` row, else the SaaS installer card's template repository.
 */
export function githubUpdateSourceFrom(
  env?: Record<string, string | undefined>,
  stored?: unknown,
  configured?: unknown,
  fallbackRepo?: unknown,
): GithubUpdateSource | null;

/** Which repository a direct release-tag read uses, and whether a credential came with it. */
export function describeGithubSource(source?: GithubUpdateSource | null, owner?: boolean): {
  repo: string;
  has_token: boolean;
  configured: boolean;
};

export function readUpdatesConfig(options?: IntegrationReadOptions): Promise<{
  /**
   * The configuration a check answers with. `repository` is filled from the resolved GitHub source when the
   * screen names none — the installer card's template is the repository a platform publishes from.
   */
  config: UpdateConfig;
  /** The GitHub repository this deployment may read release tags from, or null. */
  github: GithubUpdateSource | null;
  /** The release tag the SaaS installer recorded, as a plain version — or ''. */
  installed: string;
  readable: boolean;
  error: string;
}>;

/**
 * A managed site's support answer, from `packageUpdateSupport()`. `repo` is always false and the refusal
 * is the customer-facing sentence, never the host's own (`MANAGED_MESSAGES.cannot_apply`).
 */
export function managedUpdateSupport(support: {
  supported: boolean;
  reason: string;
  restart?: 'pm2' | 'manual';
  app_name?: string;
  /** True when this site holds a token for the platform that publishes its releases. */
  platform?: boolean;
}): {
  available: boolean;
  repo: boolean;
  supported: boolean;
  /** `self` installs the package here, `platform` asks the platform to rebuild, `manual` is support. */
  mode: 'self' | 'platform' | 'manual';
  reason: string;
  restart: 'pm2' | 'manual';
  app_name: string;
};

/**
 * This site's own public address: what the caller named, else `X-Forwarded-Host`/`Host` from the request
 * being answered, else `fallback`. Empty when there is nothing to go on.
 */
export function siteAddressFrom(
  headers: unknown,
  input?: { site?: string; fallback?: string },
): string;

/** True when the stored configuration holds a platform token, which is what a rebuild needs. */
export function platformRedeployFrom(config: { token?: string; central_url?: string } | null | undefined): boolean;

/** The plan for a managed site whose host cannot install a package: the platform rebuilds it. */
export function platformUpdatePlan(input: {
  latestVersion: string;
  installedVersion: string;
}): UpdatePlan;

/** Asks the platform to rebuild this site and upload the release to its project. */
export function requestPlatformInstall(input: {
  config: { token?: string; central_url?: string };
  /** This site's own address; the platform matches its Vercel project on it. */
  site: string;
  version?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{
  mode: 'platform';
  queued: boolean;
  project: string;
  version: string;
  deployment: { id: string; url: string; ready_state: string } | null;
  message: string;
}>;

export function versionStateFrom(value: unknown, current: { installed: string }): VersionStateView;
export function versionStateAfter(
  previous: unknown,
  entry: { at: string; from: string; to: string; mode: string; status: string; error?: string },
): Record<string, unknown>;

export function releaseFrom(value: unknown): UpdateRelease | null;
export function publicRelease(release: UpdateRelease | null): PublicUpdateRelease | null;
export function pluginReleasesFrom(declared: unknown): Record<string, UpdateRelease>;
export function installedPluginsFrom(value: unknown): InstalledPluginVersion[];

export function fetchCentralCheck(options: {
  config: UpdateConfig;
  current: CurrentVersion;
  plugins: InstalledPluginVersion[];
  fetchImpl?: typeof fetch;
  /** True for a managed site: every refusal is `MANAGED_MESSAGES`, never the owner's configuration advice. */
  managed?: boolean;
}): Promise<{ app: UpdateRelease; plugins: Record<string, UpdateRelease> }>;

export function fetchGithubCheck(options: {
  source: GithubUpdateSource;
  channel?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ app: UpdateRelease; plugins: Record<string, UpdateRelease> }>;

/** The central endpoint a managed site downloads its release package from. */
export function centralApplyUrl(config: UpdateConfig): string;

/**
 * The central endpoint a site that cannot install anything asks to be rebuilt. Same host and token as
 * `centralApplyUrl`: a site that can check for updates can already install them.
 */
export function centralInstallUrl(config: UpdateConfig): string;

export function checkAnswerFrom(input: {
  source: 'central' | 'github';
  app: UpdateRelease;
  plugins: Record<string, UpdateRelease>;
  current: CurrentVersion;
  plugins_installed: InstalledPluginVersion[];
  error?: string;
  coreOnly?: boolean;
}): UpdateCheck;

export function checkForUpdates(options: {
  config: UpdateConfig;
  current: CurrentVersion;
  plugins: InstalledPluginVersion[];
  /** The repository this deployment may read directly; defaults to `githubUpdateSourceFrom()`. */
  github?: GithubUpdateSource | null;
  fetchImpl?: typeof fetch;
  /**
   * False for an end user, whose check is answered by the central server and by nothing else: `github` is
   * ignored, and every refusal is a `MANAGED_MESSAGES` sentence rather than configuration advice.
   */
  owner?: boolean;
}): Promise<UpdateCheck>;

export function triggerDeployHookUrl(
  hook: string,
  options?: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<{ configured: boolean; triggered: boolean; status?: number; error?: string }>;

export function updatePlan(input: {
  config: UpdateConfig;
  deployHook: string;
  selfUpdate: boolean;
  latestVersion: string;
  installedVersion: string;
}): UpdatePlan;

export function applyDeployHookUpdate(options: {
  deployHook: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<{
  mode: 'deploy-hook';
  queued: boolean;
  deploy: { configured: boolean; triggered: boolean; status?: number; error?: string };
  message: string;
}>;

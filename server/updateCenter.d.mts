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
export const PLUGIN_DIRECTORY_PATH: string;

export const UPDATE_CHANNELS: readonly string[];
export const AUTO_CHECK_KEYS: readonly string[];

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
}

/** The same configuration with the token replaced by `has_token`. */
export interface UpdateConfigView {
  central_url: string;
  channel: string;
  auto_check: string;
  notify: boolean;
  self_update: boolean;
  has_token: boolean;
  source: 'central' | 'github';
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
  mode: 'deploy-hook' | 'self' | 'manual';
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
export function describeUpdateConfig(config: UpdateConfig): UpdateConfigView;

/**
 * The repository a check may read directly: `RWP_RELEASE_REPO`/`GITHUB_REPO` and
 * `RWP_RELEASE_TOKEN`/`GITHUB_TOKEN` from the environment, else the stored `github_config` row.
 */
export function githubUpdateSourceFrom(
  env?: Record<string, string | undefined>,
  stored?: unknown,
): GithubUpdateSource | null;

/** Which repository a direct release-tag read uses, and whether a credential came with it. */
export function describeGithubSource(source?: GithubUpdateSource | null): {
  repo: string;
  has_token: boolean;
  configured: boolean;
};

export function readUpdatesConfig(options?: IntegrationReadOptions): Promise<{
  config: UpdateConfig;
  /** The GitHub repository this deployment may read release tags from, or null. */
  github: GithubUpdateSource | null;
  readable: boolean;
  error: string;
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
}): Promise<{ app: UpdateRelease; plugins: Record<string, UpdateRelease> }>;

export function fetchGithubCheck(options: {
  source: GithubUpdateSource;
  channel?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ app: UpdateRelease; plugins: Record<string, UpdateRelease> }>;

export function checkAnswerFrom(input: {
  source: 'central' | 'github';
  app: UpdateRelease;
  plugins: Record<string, UpdateRelease>;
  current: CurrentVersion;
  plugins_installed: InstalledPluginVersion[];
  error?: string;
}): UpdateCheck;

export function checkForUpdates(options: {
  config: UpdateConfig;
  current: CurrentVersion;
  plugins: InstalledPluginVersion[];
  /** The repository this deployment may read directly; defaults to `githubUpdateSourceFrom()`. */
  github?: GithubUpdateSource | null;
  fetchImpl?: typeof fetch;
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

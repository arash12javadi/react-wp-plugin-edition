/**
 * Types for `server/selfUpdate.mjs` — one-click updates on a host that owns its checkout.
 *
 * See the implementation for why a run is a detached process with a status file rather than work done
 * inside the request, and for the four guards that run before anything is touched. The record below is
 * also what `scripts/selfUpdateRun.mjs` writes, so it is the contract between the two processes.
 */

/** Where a run's status record and log live. */
export const SELF_UPDATE_DIR: string;
export const SELF_UPDATE_SCRIPT: string;
export const SELF_UPDATE_RUN_LIMIT: number;

/** A refusal that carries the status code to answer with. */
export class SelfUpdateError extends Error {
  constructor(message: string, status?: number);
  status: number;
}

/** Where one run has got to. `step` is the name the screen shows; `status` is what happened overall. */
export interface SelfUpdateRun {
  id: string;
  status: 'running' | 'done' | 'failed';
  step: string;
  started_at: string;
  finished_at: string;
  /** The version the site was running when the update was asked for. */
  from: string;
  /** The version the central server said to update to. */
  to: string;
  /** `git` (fetch + merge) or `package` (download a release ZIP from the central server). */
  source?: 'git' | 'package';
  /** The git ref that was merged, e.g. `origin/main`. */
  ref: string;
  /** The commit the checkout was on — what a failed git run is rolled back to. */
  previous: string;
  /** The commit that was merged, once `fetching` succeeded. */
  target: string;
  /** The central package endpoint and bearer token, when `source === 'package'`. */
  package_url?: string;
  package_token?: string;
  site?: string;
  /** Where the runner backed up the files a package update replaced, for its rollback. */
  backup?: string;
  /** `pm2` when the app was started by PM2 (its environment says so), otherwise `manual`. */
  restart: 'pm2' | 'manual';
  app_name: string;
  restart_required: boolean;
  log_path: string;
  error: string;
}

/** This checkout, ready or not. */
export interface GitState {
  available: boolean;
  repo: boolean;
  branch: string;
  head: string;
  dirty: boolean;
  error: string;
}

/** What the screen needs to know before it offers the button. */
export interface SelfUpdateSupport extends GitState {
  supported: boolean;
  reason: string;
  restart?: 'pm2' | 'manual';
  app_name?: string;
}

export function gitState(cwd?: string): Promise<GitState>;
export function selfUpdateSupport(): Promise<SelfUpdateSupport>;

/** Whether this server can apply a package update (writable folder + package.json, no git needed). */
export function packageUpdateSupport(): Promise<{ supported: boolean; reason: string; restart: 'pm2' | 'manual'; app_name: string }>;

export function writeSelfUpdateRun(record: SelfUpdateRun): Promise<SelfUpdateRun>;
export function readSelfUpdateRun(id: unknown): Promise<SelfUpdateRun | null>;
export function listSelfUpdateRuns(limit?: number): Promise<SelfUpdateRun[]>;
export function isSafeRef(ref: unknown): boolean;
export function startSelfUpdate(options: {
  to: string;
  from: string;
  ref?: string;
  source?: 'git' | 'package';
  package?: { url: string; token: string; site?: string };
}): Promise<SelfUpdateRun>;
export function readSelfUpdateLog(id: unknown, maxLines?: number): Promise<string>;

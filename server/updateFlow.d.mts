/** Types for `server/updateFlow.mjs` — what the update routes answer, shared by both hosts. */
import type { RecentReleasesView } from './releaseList.mjs';

export function refusalBody(error: unknown): { error: string } & Record<string, unknown>;

export function checkResponse(input: {
  stored: any;
  installed: string;
  plugins: Array<{ id: string; name?: string; version: string }>;
  owner: boolean;
  fetchImpl?: typeof fetch;
  latestCommit?: unknown;
}): Promise<Record<string, unknown> & { releases: RecentReleasesView }>;

export function releasesResponse(input: {
  stored: any;
  installed: string;
  owner: boolean;
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<RecentReleasesView>;

export function applyResponse(input: {
  body: Record<string, unknown>;
  stored: any;
  installed: string;
  plugins: Array<{ id: string; name?: string; version: string }>;
  owner: boolean;
  deployHook: string;
  selfSupport: { supported: boolean };
  gitDeploy: boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<{ status: number; body: Record<string, unknown> }>;

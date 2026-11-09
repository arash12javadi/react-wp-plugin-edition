/** Types for `server/releaseList.mjs` — the five most recent stable releases, read from GitHub and cached. */
import type { UpdateRelease } from './updateCenter.mjs';

export const DEFAULT_RELEASE_REPOSITORY: string;
export const RECENT_RELEASE_COUNT: number;
export const RELEASE_CACHE_MS: number;
export const FORCE_REFRESH_MIN_MS: number;
export const DOWNGRADE_WARNING: string;

export class ReleaseListError extends Error {
  constructor(message: string, status?: number, extra?: Record<string, unknown>);
  status: number;
  extra: Record<string, unknown>;
}

/** A release as the server holds it (with the download URL, which no answer carries). */
export type ListedRelease = UpdateRelease & { title?: string; commit?: string; draft?: boolean; prerelease?: boolean };

export interface RecentReleaseList {
  repo: string;
  source: string;
  checked_at: string;
  cached: boolean;
  stale: boolean;
  warning: string;
  releases: ListedRelease[];
}

/** One release as a screen sees it. */
export interface RecentReleaseView {
  tag: string;
  version: string;
  title: string;
  released: string;
  notes: string[];
  changelog_url: string;
  critical: boolean;
  latest: boolean;
  installed: boolean;
  move: 'upgrade' | 'current' | 'downgrade';
}

export interface RecentReleasesView {
  repository: string;
  checked_at: string;
  cached: boolean;
  stale: boolean;
  warning: string;
  installed: string;
  latest_tag: string;
  releases: RecentReleaseView[];
}

export function releaseSourceFrom(input?: {
  updates?: unknown;
  github?: unknown;
  env?: Record<string, string | undefined>;
}): { repo: string; token: string; custom: boolean; origin: 'saved' | 'environment' | 'default' };

export function clearReleaseCache(): void;
export function recentStableReleases(releases: unknown, limit?: number): ListedRelease[];
export function listRecentReleases(options: {
  source: { repo: string; token?: string };
  fetchImpl?: typeof fetch;
  now?: number;
  force?: boolean;
}): Promise<RecentReleaseList>;
export function moveKindFor(installed: string, version: string): 'upgrade' | 'current' | 'downgrade';
export function describeRecentReleases(list: RecentReleaseList, installed?: string): RecentReleasesView;
export function selectRelease(list: RecentReleaseList, tag: unknown): ListedRelease;
export function assertDowngradeConfirmed(input: { installed: string; release: { version: string; tag: string }; confirmed?: boolean }): void;

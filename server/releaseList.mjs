/**
 * The one place that answers "which releases can this site move to?" — the five most recent stable release
 * tags of the release repository, read straight from GitHub.
 *
 * Every screen and every route that offers or accepts a version goes through this module: Dashboard →
 * Updates (check, picker, apply), Settings → Integrations → GitHub & Vercel (core update), and the routes
 * behind both hosts (`server/updateRoutes.mjs`, `src/server/routes/updates.ts`,
 * `server/deploymentRoutes.mjs`). There is no second list and no second GitHub client: the HTTP work is
 * `fetchGithubReleases` in `server/githubReleases.mjs`.
 *
 *   - **Source.** The release repository is `updates_config.repository`, else `RWP_RELEASE_REPO`, else
 *     `arash12javadi/react-wp-plugin-edition` (public — no token needed). It is never the site's own
 *     repository and react-wp.com is never asked.
 *   - **Stable only.** Drafts and pre-releases are dropped (`isChannelRelease`), the rest is sorted by
 *     version (not by the order GitHub lists them in), and the newest five are kept.
 *   - **Cached.** GitHub limits anonymous requests per IP and serverless sites share IPs, so the list is kept
 *     in memory for `RELEASE_CACHE_MS`. A failed refresh falls back to the last good list (`stale: true`
 *     with the reason in `warning`) instead of blanking the screen. The token only selects the cache entry;
 *     it is never stored in it.
 *   - **A tag is only accepted from this list.** `selectRelease` compares the browser's text for equality
 *     against the tags it just read, so nothing the browser sends — a branch, a path, a flag — can reach
 *     `git` or a URL. A move to an older tag needs an explicit confirmation (`assertDowngradeConfirmed`).
 *
 * Plain ESM with no `node:` imports, because the same file is bundled into the serverless function.
 */
import { GithubReleaseError, fetchGithubReleases, isChannelRelease, repoFrom } from './githubReleases.mjs';
import { githubTokenFrom } from './integrationConfig.mjs';
import { compareVersions } from './versions.mjs';

/** The maintainer's public release repository: what a client site reads when nothing else is named. */
export const DEFAULT_RELEASE_REPOSITORY = 'arash12javadi/react-wp-plugin-edition';

/** How many releases the picker offers. */
export const RECENT_RELEASE_COUNT = 5;

/** How long a release list is reused before GitHub is asked again. */
export const RELEASE_CACHE_MS = 5 * 60 * 1000;

/** The soonest a manual reload may bypass the cache. */
export const FORCE_REFRESH_MIN_MS = 30 * 1000;

/** The notes the picker shows per release: a taste, not the whole body. */
const SHORT_NOTE_LINES = 3;
const SHORT_NOTE_CHARS = 160;
const MAX_CACHE_ENTRIES = 20;

/** Shown beside a downgrade, and carried by the 428 that asks for the confirmation. */
export const DOWNGRADE_WARNING = 'This is an older version than the one installed. Database changes made by newer versions are not undone, so an older release may not work with your current data. Back up first.';

/** A refusal with the status code the route should answer with, like `UpdateError`. */
export class ReleaseListError extends Error {
  /**
   * @param {string} message a sentence shown to the site owner as it is
   * @param {number} [status]
   * @param {Record<string, unknown>} [extra] fields the route adds to its `{ error }` body
   */
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'ReleaseListError';
    this.status = status;
    this.extra = extra;
  }
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const environmentOf = (env) => env || globalThis.process?.env || {};

/** `owner/name` from anything `repoFrom` accepts, or `''`. */
const nameOf = (value) => {
  const target = repoFrom(value);
  return target ? `${target.owner}/${target.repo}` : '';
};

/**
 * The repository and the optional credential a release list is read with.
 *
 * `githubRow` is the `github_config` row Settings → Integrations → GitHub writes. Its token is used only to
 * lift GitHub's anonymous rate limit and only on this server; its `repository` is the site's *own* code
 * repository and is deliberately ignored here, because releases never come from there.
 *
 * @param {{ updates?: unknown, github?: unknown, env?: Record<string, string | undefined> }} input
 * @returns {{ repo: string, token: string, custom: boolean, origin: 'saved' | 'environment' | 'default' }}
 */
export const releaseSourceFrom = ({ updates, github, env } = {}) => {
  const environment = environmentOf(env);
  const row = updates && typeof updates === 'object' ? updates : {};
  const saved = nameOf(row.repository);
  const fixed = nameOf(environment.RWP_RELEASE_REPO);
  const repo = saved || fixed || DEFAULT_RELEASE_REPOSITORY;
  const token = str(environment.RWP_RELEASE_TOKEN) || githubTokenFrom(github);
  return {
    repo,
    token,
    custom: repo.toLowerCase() !== DEFAULT_RELEASE_REPOSITORY.toLowerCase(),
    origin: saved ? 'saved' : fixed ? 'environment' : 'default',
  };
};

/** What was last read, by repository — never holds a token. */
const cache = new Map();

/** Forgets every remembered list. For tests, and for a screen that just changed the repository. */
export const clearReleaseCache = () => cache.clear();

/** The newest stable releases, newest first, at most `limit`. Pure. */
export const recentStableReleases = (releases, limit = RECENT_RELEASE_COUNT) => {
  const seen = new Set();
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => isChannelRelease(release, 'stable') && release.version)
    .sort((a, b) => compareVersions(b.version, a.version) || (Date.parse(b.released || 0) || 0) - (Date.parse(a.released || 0) || 0))
    .filter((release) => {
      if (seen.has(release.version)) return false;
      seen.add(release.version);
      return true;
    })
    .slice(0, limit);
};

/**
 * Reads the five most recent stable releases of a repository (cached).
 *
 * @param {{ source: { repo: string, token?: string }, fetchImpl?: typeof fetch, now?: number, force?: boolean }} options
 * @returns {Promise<{ repo: string, source: string, checked_at: string, cached: boolean, stale: boolean, warning: string, releases: any[] }>}
 */
export async function listRecentReleases({ source, fetchImpl = fetch, now = Date.now(), force = false }) {
  const repo = nameOf(source?.repo);
  if (!repo) {
    throw new ReleaseListError('The release repository must look like owner/repository (or https://github.com/owner/repository). Site owner: fix it under Dashboard → Updates → Release repository.', 400);
  }
  const token = str(source?.token);
  const key = `${repo.toLowerCase()}|${token ? 'token' : 'anonymous'}`;
  const hit = cache.get(key);
  // `force` (the Reload button) is honoured at most once every `FORCE_REFRESH_MIN_MS`, so it cannot be used
  // to spend the shared GitHub allowance.
  if (hit && (!force || now - hit.at < FORCE_REFRESH_MIN_MS) && now - hit.at < RELEASE_CACHE_MS) return { ...hit.value, cached: true, stale: false, warning: '' };
  try {
    let fetched;
    try {
      fetched = await fetchGithubReleases({ repo, token, fetchImpl });
    } catch (error) {
      // A stored token that GitHub no longer accepts must not break reading a public repository.
      if (!token || Number(error?.status) !== 401) throw error;
      fetched = await fetchGithubReleases({ repo, token: '', fetchImpl });
    }
    const releases = recentStableReleases(fetched.releases);
    if (!releases.length) {
      throw new ReleaseListError(`${repo} has no stable release yet (drafts and pre-releases are not offered). Site owner: publish a release tagged like v1.2.3, or check the repository name under Dashboard → Updates → Release repository.`, 404);
    }
    const value = { repo, source: fetched.source, checked_at: new Date(now).toISOString(), releases };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now, value });
    return { ...value, cached: false, stale: false, warning: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The release list could not be read.';
    if (hit) return { ...hit.value, cached: true, stale: true, warning: message };
    if (error instanceof ReleaseListError) throw error;
    throw new ReleaseListError(message, error instanceof GithubReleaseError ? error.status : 502);
  }
}

const clip = (line) => (line.length > SHORT_NOTE_CHARS ? `${line.slice(0, SHORT_NOTE_CHARS - 1)}…` : line);

/** Whether moving to `version` is an upgrade, the same version, or a downgrade from `installed`. */
export const moveKindFor = (installed, version) => {
  const current = str(installed).replace(/^v/i, '');
  if (!current) return 'upgrade';
  const order = compareVersions(version, current);
  return order > 0 ? 'upgrade' : order === 0 ? 'current' : 'downgrade';
};

/**
 * The list as a screen may see it: tag, date, short notes — no download URL, no commit, no token.
 *
 * @param {Awaited<ReturnType<typeof listRecentReleases>>} list
 * @param {string} installed the plain version this site runs
 */
export const describeRecentReleases = (list, installed = '') => ({
  repository: list.repo,
  checked_at: list.checked_at,
  cached: list.cached,
  stale: list.stale,
  warning: list.warning,
  installed: str(installed).replace(/^v/i, ''),
  latest_tag: list.releases[0]?.tag || '',
  releases: list.releases.map((release, index) => ({
    tag: release.tag,
    version: release.version,
    title: release.title || '',
    released: release.released || '',
    notes: (release.notes || []).slice(0, SHORT_NOTE_LINES).map(clip),
    changelog_url: release.changelog_url || '',
    critical: release.critical === true,
    latest: index === 0,
    installed: compareVersions(release.version, installed || '0.0.0') === 0 && Boolean(str(installed)),
    move: moveKindFor(installed, release.version),
  })),
});

/**
 * The release a request named. Empty means the latest. Anything that is not exactly one of the listed tags
 * is refused — equality only, so free text never reaches a URL or `git`.
 *
 * @param {Awaited<ReturnType<typeof listRecentReleases>>} list
 * @param {unknown} tag
 */
export const selectRelease = (list, tag) => {
  const refuse = () => new ReleaseListError(`That version is not one of the ${list.releases.length} most recent releases (${list.releases.map((release) => release.tag).join(', ')}). Reload the list and pick one of them.`, 400);
  if (tag !== undefined && tag !== null && typeof tag !== 'string') throw refuse();
  const wanted = typeof tag === 'string' ? tag.trim() : '';
  if (!wanted) return list.releases[0];
  if (wanted.length > 64) throw refuse();
  // Equality with a listed tag (`v1.2.3`) or its bare version (`1.2.3`, what an older client sends).
  const found = list.releases.find((release) => release.tag === wanted || release.version === wanted);
  // The text the browser sent is compared and then dropped: it is never echoed back or used for anything else.
  if (!found) throw refuse();
  return found;
};

/** Refuses a downgrade the caller has not explicitly confirmed. */
export const assertDowngradeConfirmed = ({ installed, release, confirmed }) => {
  if (moveKindFor(installed, release.version) !== 'downgrade' || confirmed === true) return;
  throw new ReleaseListError(`${DOWNGRADE_WARNING} Confirm the downgrade to ${release.tag} to continue.`, 428, { needs_confirmation: 'downgrade' });
};

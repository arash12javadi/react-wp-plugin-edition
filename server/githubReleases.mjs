/**
 * GitHub Releases, read as the one source of truth for "which version is published".
 *
 * The rule this file exists to keep: a release is published by tagging a commit (`v2.4.1`) and writing
 * release notes on GitHub, and *that* is what an administrator is offered. Never the `version` field of
 * a `package.json` — that number is written while a release is being prepared, lags the tag, and a site
 * that compared against it would be told it is up to date while a newer tag exists, or offered an update
 * that was never published. So the tag is parsed once, here, and the central server, the check answer and
 * the screen all name the same release.
 *
 * Parsing and fetching are separate on purpose. `releaseFromGithub`, `releasesFromGithub`,
 * `releaseFromTag`, `releasesFromTags` and `latestReleaseFrom` are pure, which is what lets
 * `scripts/checkUpdateEngine.mjs` prove the tag rules without a network; `fetchGithubReleases` is the only
 * function that knows the REST API. It reads `/releases` first and falls back to `/tags`, because a
 * repository can publish a version by tagging a commit without ever drafting a Release.
 *
 * The repository may be private, and only the platform is ever given a credential — `RWP_RELEASE_TOKEN`,
 * or a `GITHUB_TOKEN` where one already exists. A customer's site reads central's answer and never sees a
 * token, a commit SHA or an asset URL. Nothing here logs a token, and the headers built below carry one
 * only when the caller passed one, so a public repository works with no credential at all.
 *
 * Plain ESM with no `node:` imports, like `server/updateCenter.mjs`: the same file is bundled into the
 * Vercel function by `vite.api.config.mjs` and imported directly by `server.mjs`.
 */
import { compareVersions, isVersion } from './versions.mjs';

/** The REST origin. Named once so a test can point at a stub without touching the call sites. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** The API version GitHub asks a client to pin. */
export const GITHUB_API_VERSION = '2022-11-28';

/** How many releases one page asks for. Enough that the newest stable release is on it. */
export const GITHUB_RELEASES_PER_PAGE = 30;

/** A refusal that carries the status code the route should answer with, like `UpdateError`. */
export class GithubReleaseError extends Error {
  /**
   * @param {string} message shown to the platform owner as is
   * @param {number} [status] the HTTP status this refusal wants
   */
  constructor(message, status = 502) {
    super(message);
    this.name = 'GithubReleaseError';
    this.status = status;
  }
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * `owner/name` from what a human pastes: `acme/react-wp`, a clone URL, or the address bar's
 * `https://github.com/acme/react-wp`. Returns null for anything else, because the value reaches a URL and
 * a caller must not be able to point this at another host.
 *
 * @param {unknown} value
 * @returns {{ owner: string, repo: string } | null}
 */
export const repoFrom = (value) => {
  const raw = trimmed(String(value ?? ''))
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(raw);
  return match ? { owner: match[1], repo: match[2] } : null;
};

/**
 * The version inside a tag: `v2.4.1` → `2.4.1`, `2.4.1-rc.1` → `2.4.1-rc.1`, `release-notes` → ``.
 * A tag that is not a version is not a release this feature can compare, and is dropped rather than
 * guessed at.
 *
 * @param {unknown} value
 */
export const tagVersionFrom = (value) => {
  const version = trimmed(String(value ?? '')).replace(/^v/i, '');
  return isVersion(version) ? version : '';
};

/**
 * A release body as the lines the screen shows: headings lose their hashes, bullets lose their mark,
 * emphasis and inline code lose their markers, and a link keeps its address next to its text because the
 * screen renders plain text. Capped: a body is written by a human, and a pasted document must not become
 * an unbounded response.
 *
 * @param {unknown} body
 * @returns {string[]}
 */
export const notesFromGithubBody = (body) => String(body ?? '')
  .replace(/\r\n?/g, '\n')
  .split('\n')
  .map((line) => line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .trim())
  .filter(Boolean)
  .slice(0, 40);

/** The `.zip` asset a by-hand installer would take, else GitHub's own source archive. Never public. */
const downloadUrlFrom = (row) => {
  const assets = Array.isArray(row?.assets) ? row.assets : [];
  const zip = assets.find((asset) => /\.zip$/i.test(trimmed(asset?.name))
    && /^https:\/\//i.test(trimmed(asset?.browser_download_url)));
  const assetUrl = trimmed(zip?.browser_download_url);
  if (assetUrl) return assetUrl;
  const archive = trimmed(row?.zipball_url);
  return /^https:\/\//i.test(archive) ? archive : '';
};

/**
 * One row of `GET /repos/{owner}/{repo}/releases`, in the shape `releaseFrom` in
 * `server/updateCenter.mjs` already understands — so an answer built from GitHub and one built from the
 * public feed are indistinguishable to the screen.
 *
 * `draft` and `prerelease` ride along because `latestReleaseFrom` needs them and the public answer does
 * not: a draft is visible only to the owner's token, and a pre-release is what the `beta` channel is for.
 *
 * @param {unknown} value
 */
export const releaseFromGithub = (value) => {
  const row = value && typeof value === 'object' ? value : null;
  if (!row) return null;
  const tag = trimmed(row.tag_name);
  const version = tagVersionFrom(tag);
  if (!version) return null;
  const page = trimmed(row.html_url);
  return {
    version,
    tag: /^v/i.test(tag) ? `v${version}` : tag,
    released: trimmed(row.published_at) || trimmed(row.created_at),
    notes: notesFromGithubBody(row.body),
    changelog_url: /^https:\/\//i.test(page) ? page : '',
    download_url: downloadUrlFrom(row),
    /** The branch or SHA the tag points at, for a self-update that checks the tag out. */
    commit: trimmed(row.target_commitish),
    draft: row.draft === true,
    prerelease: row.prerelease === true,
    critical: row.critical === true,
  };
};

/**
 * The release list of an API answer, with the entries this feature cannot compare dropped. A malformed
 * row costs its own release, never the whole check.
 *
 * @param {unknown} value
 */
export const releasesFromGithub = (value) => (Array.isArray(value)
  ? value.map(releaseFromGithub).filter(Boolean)
  : []);

/**
 * One row of `GET /repos/{owner}/{repo}/tags`, in the shape `releaseFromGithub` answers with.
 *
 * A repository that publishes by tagging a commit and never drafting a GitHub Release answers `[]` to the
 * releases endpoint, and its tags are the same fact one endpoint over: the tag *is* the published version.
 * Reading them means a repository tagged `v2.4.2` is offered `v2.4.2` instead of "no release yet".
 *
 * A tag carries less than a release — no notes, no publish date, no asset — so `notes` stays empty and
 * `changelog_url` points at GitHub's own page for that tag. `prerelease` is inferred from the tag itself
 * (`v2.5.0-rc.1`), so a candidate tag is never offered on the stable channel.
 *
 * @param {unknown} value one tag row
 * @param {string} [repo] `owner/name`, for the URL to open
 */
export const releaseFromTag = (value, repo = '') => {
  const row = value && typeof value === 'object' ? value : null;
  if (!row) return null;
  const tag = trimmed(row.name);
  const version = tagVersionFrom(tag);
  if (!version) return null;
  const name = trimmed(String(repo ?? ''));
  return {
    version,
    tag: /^v/i.test(tag) ? `v${version}` : tag,
    released: '',
    notes: [],
    changelog_url: name ? `https://github.com/${name}/releases/tag/${encodeURIComponent(tag)}` : '',
    /** A tag has no asset, and the source archive URL is not part of this endpoint's answer. */
    download_url: '',
    commit: trimmed(row.commit?.sha),
    draft: false,
    prerelease: version.includes('-'),
    critical: false,
  };
};

/**
 * The tag list of an API answer, with the tags this feature cannot compare dropped — a tag called
 * `nightly` costs its own entry, never the whole check.
 *
 * @param {unknown} value
 * @param {string} [repo]
 */
export const releasesFromTags = (value, repo = '') => (Array.isArray(value)
  ? value.map((row) => releaseFromTag(row, repo)).filter(Boolean)
  : []);

/** True when a release may be offered on `channel`: a draft never, a pre-release only on `beta`. */
export const isChannelRelease = (release, channel = 'stable') => Boolean(release)
  && release.draft !== true
  && (channel === 'beta' || release.prerelease !== true);

/**
 * The newest release a channel may be offered, by tag order rather than by the order GitHub lists them in.
 * `released` breaks a tie between two tags that parse to the same version, which is the only case where
 * "newest" is ambiguous.
 *
 * @param {Array<any>} releases
 * @param {{ channel?: 'stable' | 'beta' }} [options]
 */
export const latestReleaseFrom = (releases, { channel = 'stable' } = {}) => {
  const candidates = (Array.isArray(releases) ? releases : []).filter((release) => isChannelRelease(release, channel));
  return candidates.reduce((best, release) => {
    if (!best) return release;
    const order = compareVersions(release.version, best.version);
    if (order > 0) return release;
    if (order === 0 && Date.parse(release.released || 0) > Date.parse(best.released || 0)) return release;
    return best;
  }, null);
};

/** The release notes as one string, the shape the central contract promises. */
export const releaseNotesText = (release) => (release?.notes || []).join('\n');

/**
 * One GitHub list endpoint, answered as JSON.
 *
 * Only this function holds the credential: `token` empty is a supported state (public repository), which
 * is what makes the platform's answer token-free for everyone else. The errors are sentences a platform
 * owner can act on — a 404 is the usual "private repo, no token", and a 403 with an exhausted rate limit
 * says so instead of looking like a permissions problem.
 *
 * @param {{ name: string, url: string, token?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<any[]>}
 */
async function githubList({ name, url, token = '', fetchImpl = fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'react-wp-update-center',
    ...(trimmed(token) ? { Authorization: `Bearer ${trimmed(token)}` } : {}),
  };
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  } catch (error) {
    throw new GithubReleaseError(error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `${url} did not answer in time.`
      : `${url} could not be reached. Check this server's network access.`, 502);
  }
  if (response.status === 404) {
    throw new GithubReleaseError(`GitHub has no repository or no release tags at ${name}. A private repository answers 404 without a token, so set RWP_RELEASE_TOKEN on the central server if the repository is not public.`, 404);
  }
  if (response.status === 401) {
    throw new GithubReleaseError('GitHub refused the release token. Set RWP_RELEASE_TOKEN to a token that can read the repository\'s releases (Contents: read is enough).', 401);
  }
  if (response.status === 403 || response.status === 429) {
    if (response.headers?.get?.('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) || 0;
      const at = reset ? new Date(reset * 1000).toISOString() : 'later';
      throw new GithubReleaseError(`GitHub's rate limit for this server is used up; it resets at ${at}. The last answer stays cached until then.`, 429);
    }
    throw new GithubReleaseError(`GitHub refused the release request (HTTP ${response.status}). Check RWP_RELEASE_TOKEN and the repository name.`, 403);
  }
  if (!response.ok) throw new GithubReleaseError(`GitHub answered HTTP ${response.status} for ${name}'s releases.`, 502);
  const body = await response.json().catch(() => {
    throw new GithubReleaseError(`${url} did not return valid JSON.`, 502);
  });
  if (!Array.isArray(body)) throw new GithubReleaseError(`${url} did not return a release list.`, 502);
  return body;
}

/**
 * `GET /repos/{owner}/{repo}/releases`, newest first, and `GET /repos/{owner}/{repo}/tags` when that list
 * has nothing that can be compared.
 *
 * The tags fallback is the whole point of the second request: a repository publishes a version by tagging
 * a commit (`git tag v2.4.2 && git push --tags`), and a GitHub Release for that tag is optional. A
 * repository tagged that way answers `[]` for releases, so a check that stopped there would tell an
 * administrator "no release yet" while the tag it should be offered is one endpoint away.
 *
 * It is a *fallback* and not a merge, deliberately: a draft Release has a tag too, and a merged list would
 * offer a version its author has not published yet. Tags are read only when there is no Release to compare
 * — the draft rule stays exactly as it was.
 *
 * @param {{ repo: string, token?: string, fetchImpl?: typeof fetch, perPage?: number, origin?: string }} options
 * @returns {Promise<{ repo: string, url: string, source: 'releases' | 'tags', releases: any[], authenticated: boolean }>}
 */
export async function fetchGithubReleases({
  repo,
  token = '',
  fetchImpl = fetch,
  perPage = GITHUB_RELEASES_PER_PAGE,
  origin = GITHUB_API_ORIGIN,
}) {
  const target = repoFrom(repo);
  if (!target) {
    throw new GithubReleaseError('Set RWP_RELEASE_REPO to the repository the releases are published on, as "owner/name" (or https://github.com/owner/name).', 400);
  }
  const name = `${target.owner}/${target.repo}`;
  const size = Math.min(Math.max(Number(perPage) || GITHUB_RELEASES_PER_PAGE, 1), 100);
  const base = trimmed(origin) || GITHUB_API_ORIGIN;
  const releasesUrl = `${base}/repos/${name}/releases?per_page=${size}`;
  const releases = releasesFromGithub(await githubList({ name, url: releasesUrl, token, fetchImpl }));
  if (releases.length > 0) {
    return { repo: name, url: releasesUrl, source: 'releases', releases, authenticated: Boolean(trimmed(token)) };
  }
  const tagsUrl = `${base}/repos/${name}/tags?per_page=${size}`;
  const tags = releasesFromTags(await githubList({ name, url: tagsUrl, token, fetchImpl }), name);
  return {
    repo: name,
    url: tags.length ? tagsUrl : releasesUrl,
    source: tags.length ? 'tags' : 'releases',
    releases: tags,
    authenticated: Boolean(trimmed(token)),
  };
}


/**
 * Publishing a free plugin from the author's own GitHub release.
 *
 * The author keeps the code in their repository and publishes an ordinary GitHub release (tag `v1.0.1`). The
 * marketplace is given only the repository address. This module is the part that talks to GitHub and turns
 * "the latest release" into one scanned, normalised package; it never touches the database, so every step can
 * be tested with a fake `fetch`.
 *
 * Security properties, each of which a test pins:
 *   - only `https://github.com/<owner>/<repo>` addresses are accepted, and only PUBLIC repositories (the server
 *     holds no token that could read a private one, and does not ask anyone for theirs);
 *   - the package is fetched from the release (an attached `.zip` asset, else the source of that exact tag), never
 *     from a branch, and only from GitHub's own download hosts, with every redirect checked against that list;
 *   - the downloaded file is capped in size, and an archive that expands beyond the limits is refused unread;
 *   - the stored package is re-packed from the verified entries with the manifest at its root, so the copy the
 *     marketplace serves is the file that was scanned, whatever shape the author's ZIP had;
 *   - the tag, the manifest version and the manifest id must agree, and a sold or development-edition plugin id
 *     can never be claimed through this route.
 */
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { isCommercialPlugin } from '../src/lib/pluginLicense.js';
import { isDevEditionPlugin } from '../src/lib/pluginEdition.js';
import { vetFiles } from './pluginVet.mjs';

export class ReleaseSourceError extends Error {
  /** @param {number} status HTTP status for the caller  @param {string} message a sentence the author can act on  @param {string} [code] */
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const GITHUB_API = 'https://api.github.com';
/** Hosts a release package may come from, after any redirect. */
export const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 150 * 1024 * 1024;
export const MAX_ENTRIES = 3000;
const MAX_REDIRECTS = 5;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,30})?$/;

/** `https://github.com/owner/repo[.git][/anything]` to `{ owner, repo, fullName, url }`. Anything else is refused. */
export function parseRepositoryUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new ReleaseSourceError(400, 'Enter the address of your GitHub repository, for example https://github.com/your-name/your-plugin.', 'repository_missing');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ReleaseSourceError(400, 'That is not a web address. Use the form https://github.com/your-name/your-plugin.', 'repository_invalid');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port) {
    throw new ReleaseSourceError(400, 'Only GitHub repositories are supported, with an address like https://github.com/your-name/your-plugin.', 'repository_host');
  }
  const [owner, rawRepo] = url.pathname.split('/').filter(Boolean);
  const repo = String(rawRepo || '').replace(/\.git$/i, '');
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new ReleaseSourceError(400, 'The address must name the owner and the repository, like https://github.com/your-name/your-plugin.', 'repository_invalid');
  }
  return { owner, repo, fullName: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
}

/** `v1.0.1`, `1.0.1` and `my-plugin-v1.0.1` all mean 1.0.1; anything that is not a release version is `''`. */
export function versionFromTag(tag) {
  const match = /^(?:.*?-)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag || '').trim());
  return match && VERSION.test(match[1]) ? match[1] : '';
}

const parts = (version) => {
  const [core, pre = ''] = String(version).split(/-(.+)/);
  return { numbers: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
};

/** Negative when `a` is older than `b`, zero when equal, positive when newer (semver precedence). */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] || 0) - (right.numbers[index] || 0);
    if (difference) return difference;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) {
      const difference = Number(x) - Number(y);
      if (difference) return difference;
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const apiHeaders = (token) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'react-wp-plugin-marketplace',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const rateLimitMessage = (response) => {
  const reset = Number(response.headers?.get?.('x-ratelimit-reset')) || 0;
  const when = reset ? ` It resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC.` : '';
  return `GitHub is limiting how often this marketplace may ask about repositories.${when} Try again later; the owner can raise the limit by saving a GitHub token under Marketplace → Repository & settings.`;
};

/** GET one api.github.com path as JSON. `404` is returned as `null`, every other failure is a sentence. */
async function githubJson(path, { token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API}${path}`, { headers: apiHeaders(token), redirect: 'error' });
  } catch {
    throw new ReleaseSourceError(502, 'GitHub could not be reached just now. Try again in a few minutes.', 'github_unreachable');
  }
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) throw new ReleaseSourceError(429, rateLimitMessage(response), 'github_rate_limit');
  if (response.status === 401) throw new ReleaseSourceError(502, 'GitHub refused the marketplace\'s token. The owner must replace it under Marketplace → Repository & settings, or remove it.', 'github_token');
  if (!response.ok) throw new ReleaseSourceError(502, `GitHub answered HTTP ${response.status} while reading the repository. Try again later.`, 'github_error');
  return response.json();
}

/**
 * Downloads one file from GitHub with the size cap enforced while reading, following at most a few redirects and
 * only to GitHub's own download hosts. No credential is sent: every package here is public.
 */
export async function downloadLimited(url, { fetchImpl = fetch, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new ReleaseSourceError(502, 'GitHub sent an address the marketplace cannot read.', 'download_url');
    }
    if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new ReleaseSourceError(502, `The release package points at ${parsed.hostname}, which is not a GitHub download host, so it was not fetched.`, 'download_host');
    }
    let response;
    try {
      response = await fetchImpl(parsed.href, { redirect: 'manual', headers: { 'User-Agent': 'react-wp-plugin-marketplace' } });
    } catch {
      throw new ReleaseSourceError(502, 'The release package could not be downloaded from GitHub. Try again in a few minutes.', 'download_failed');
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) throw new ReleaseSourceError(502, 'GitHub redirected the download without saying where.', 'download_failed');
      target = new URL(next, parsed).href;
      continue;
    }
    if (!response.ok) throw new ReleaseSourceError(502, `GitHub answered HTTP ${response.status} for the release package.`, 'download_failed');
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > maxBytes) throw tooLarge(maxBytes);
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw tooLarge(maxBytes);
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  throw new ReleaseSourceError(502, 'GitHub redirected the download too many times.', 'download_failed');
}

const tooLarge = (maxBytes) => new ReleaseSourceError(413, `The release package is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, which is the limit.`, 'too_large');

/** The latest published release of a public repository, in the shape the rest of this module uses. */
export async function fetchLatestRelease(repository, { token = '', fetchImpl = fetch } = {}) {
  const meta = await githubJson(`/repos/${repository.owner}/${repository.repo}`, { token, fetchImpl });
  if (!meta) {
    throw new ReleaseSourceError(404, `${repository.fullName} was not found. Check the address, and that the repository is public: the marketplace cannot read a private one.`, 'repository_not_found');
  }
  if (meta.private) {
    throw new ReleaseSourceError(422, `${repository.fullName} is private. A plugin offered to everyone has to come from a public repository.`, 'repository_private');
  }
  if (meta.archived || meta.disabled) {
    throw new ReleaseSourceError(422, `${repository.fullName} is archived or disabled on GitHub, so it cannot publish new releases.`, 'repository_archived');
  }
  const release = await githubJson(`/repos/${repository.owner}/${repository.repo}/releases/latest`, { token, fetchImpl });
  if (!release) {
    throw new ReleaseSourceError(404, `${repository.fullName} has no published release yet. On GitHub open Releases, choose "Draft a new release", give it a tag such as v1.0.0 and publish it (a draft or a pre-release is not enough), then try again.`, 'release_missing');
  }
  if (release.draft || release.prerelease) {
    throw new ReleaseSourceError(422, 'GitHub returned a draft or pre-release as the latest release. Publish a normal release and try again.', 'release_not_final');
  }
  return {
    repository: {
      id: String(meta.id),
      fullName: String(meta.full_name || repository.fullName),
      url: String(meta.html_url || repository.url),
      description: String(meta.description || ''),
    },
    release: {
      id: String(release.id),
      tag: String(release.tag_name || ''),
      name: String(release.name || ''),
      body: String(release.body || ''),
      url: String(release.html_url || ''),
      publishedAt: String(release.published_at || ''),
      assets: (Array.isArray(release.assets) ? release.assets : [])
        .filter((asset) => asset && asset.state !== 'uploading')
        .map((asset) => ({ name: String(asset.name || ''), size: Number(asset.size) || 0, url: String(asset.browser_download_url || '') })),
    },
  };
}

/**
 * Which file of the release is the package. An attached `.zip` is what the author built on purpose, so it wins
 * (the one named `<id>-<version>.zip` first); with none attached the source of that exact tag is used.
 * Returns `{ url, kind }`; an asset's address must belong to this repository's own release downloads.
 */
export function choosePackage({ repository, release, version }) {
  const prefix = `https://github.com/${repository.fullName}/releases/download/`.toLowerCase();
  const zips = release.assets.filter((asset) => /\.zip$/i.test(asset.name) && asset.url.toLowerCase().startsWith(prefix));
  const repoName = repository.fullName.split('/')[1].toLowerCase();
  const exact = zips.find((asset) => asset.name.toLowerCase() === `${repoName}-${version}.zip`)
    || zips.find((asset) => asset.name.toLowerCase().includes(version.toLowerCase()))
    || zips.find((asset) => asset.name.toLowerCase().includes(repoName));
  const asset = exact || (zips.length === 1 ? zips[0] : null) || zips[0];
  if (asset) return { url: asset.url, kind: 'asset', name: asset.name };
  return {
    url: `https://codeload.github.com/${repository.fullName}/zip/refs/tags/${encodeURIComponent(release.tag)}`,
    kind: 'source',
    name: `${repoName}-${release.tag}.zip`,
  };
}

const SKIPPED = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /^\.git\//, /^\.github\//, /(^|\/)node_modules\//, /(^|\/)Thumbs\.db$/i];

const safePath = (name) => {
  const value = String(name).replace(/^\/+/, '');
  if (!value || value.includes('\\') || value.includes('\0') || value.split('/').some((segment) => segment === '..')) return null;
  return value;
};

/** Unpacks with limits applied before anything is inflated. */
export function unpackLimited(bytes) {
  let total = 0;
  let count = 0;
  try {
    unzipSync(bytes, { filter: (file) => { total += file.originalSize; count += 1; return false; } });
  } catch {
    throw new ReleaseSourceError(422, 'The release package is not a readable ZIP file.', 'zip_unreadable');
  }
  if (count > MAX_ENTRIES) throw new ReleaseSourceError(422, `The release package holds ${count} files, which is more than the ${MAX_ENTRIES} allowed.`, 'zip_entries');
  if (total > MAX_UNPACKED_BYTES) throw new ReleaseSourceError(422, `The release package expands to ${Math.round(total / 1024 / 1024)} MB, more than the ${Math.round(MAX_UNPACKED_BYTES / 1024 / 1024)} MB allowed.`, 'zip_expanded');
  try {
    return Object.entries(unzipSync(bytes));
  } catch {
    throw new ReleaseSourceError(422, 'The release package is not a readable ZIP file.', 'zip_unreadable');
  }
}

/**
 * Re-packs the verified entries so `manifest.json` sits at the root of the ZIP, whatever folder GitHub or the
 * author wrapped them in. The output is deterministic (fixed timestamps, sorted names), so the same release always
 * gives the same checksum.
 */
export function normalisePackage(entries) {
  const files = new Map();
  for (const [name, content] of entries) {
    if (name.endsWith('/')) continue;
    const path = safePath(name);
    if (!path) throw new ReleaseSourceError(422, `The release package holds an unsafe path (${name.slice(0, 80)}).`, 'zip_unsafe');
    files.set(path, content);
  }
  const manifestPaths = [...files.keys()].filter((path) => /^(?:[^/]+\/)?manifest\.json$/i.test(path));
  if (!manifestPaths.length) {
    throw new ReleaseSourceError(422, 'There is no manifest.json at the top of the release package (or one folder down). A plugin package needs one.', 'manifest_missing');
  }
  const manifestPath = manifestPaths.sort((a, b) => a.length - b.length)[0];
  const prefix = manifestPath.slice(0, manifestPath.length - 'manifest.json'.length);
  const output = {};
  for (const path of [...files.keys()].sort()) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (!relative || SKIPPED.some((pattern) => pattern.test(relative))) continue;
    output[relative] = files.get(path);
  }
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(output['manifest.json']));
  } catch {
    throw new ReleaseSourceError(422, 'manifest.json in the release package is not valid JSON.', 'manifest_invalid');
  }
  const zip = zipSync(output, { level: 9, mtime: new Date('2000-01-01T00:00:00Z') });
  return { zip, manifest, entries: Object.entries(output), prefix };
}

const OWNER_REVIEWABLE = new Set(['disallowed imports / dynamic code', 'server secret usage']);

/**
 * How serious the scan's findings are. `critical` blocks a plugin outright (no valid manifest or entry file,
 * dynamic code, or a server secret); `advisory` is something a person should read (network calls, storage access,
 * obfuscation markers, no registration hook); `clean` is neither.
 */
export function severityOf(report, { ownerRepository = false } = {}) {
  if (!report) return 'critical';
  const failed = new Set((report.checks || []).filter((check) => !check.ok).map((check) => check.name));
  const critical = ['archive', 'manifest.json', 'manifest fields', 'entry file', 'disallowed imports / dynamic code', 'server secret usage'];
  // The marketplace owner's own repository (a plugin such as RWP Developers legitimately names `service_role` or
  // describes `eval` in its own checker). The two content findings are then something the owner reads and approves,
  // never an automatic publish and never an automatic rejection. A broken package stays blocked.
  const blocking = ownerRepository ? critical.filter((name) => !OWNER_REVIEWABLE.has(name)) : critical;
  if (blocking.some((name) => failed.has(name))) return 'critical';
  if (ownerRepository && critical.some((name) => failed.has(name))) return 'advisory';
  return report.pass && !failed.size ? 'clean' : 'advisory';
}

/**
 * What to do with a scanned release. Only the marketplace owner's own repositories are published without a human
 * decision, and only when the scan found nothing; every other author's release waits for the owner, because a free
 * plugin can run server code on a client's site and a text scan is not proof of anything.
 */
export function decidePolicy({ severity, isOwner }) {
  if (severity === 'critical') return { verdict: 'rejected', publish: false, reason: 'The automatic scan found a problem that blocks this plugin. The report lists it.' };
  if (severity === 'advisory') return { verdict: 'pending', publish: false, reason: 'The scan found something the marketplace owner has to read before this is published.' };
  if (isOwner) return { verdict: 'approved', publish: true, reason: 'The scan found nothing, and the repository belongs to the marketplace owner.' };
  return { verdict: 'pending', publish: false, reason: 'The scan found nothing. A plugin from another author goes live once the marketplace owner approves it.' };
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Everything from a repository address to a scanned, normalised package.
 *
 * @param {string} repositoryUrl
 * @param {{ expectedSlug?: string, token?: string, fetchImpl?: typeof fetch, isOwner?: boolean }} [options]
 * `expectedSlug`: the plugin this repository is already linked to; the manifest's id has to equal it.
 */
export async function resolveReleaseCandidate(repositoryUrl, { expectedSlug = '', token = '', fetchImpl = fetch, isOwner = false } = {}) {
  const repository = parseRepositoryUrl(repositoryUrl);
  const latest = await fetchLatestRelease(repository, { token, fetchImpl });
  const { release } = latest;

  const tagVersion = versionFromTag(release.tag);
  if (!tagVersion) {
    throw new ReleaseSourceError(422, `The release tag "${release.tag}" is not a version. Use a tag such as v1.0.1 (three numbers), so the marketplace can tell which release is newer.`, 'tag_invalid');
  }

  const choice = choosePackage({ repository: latest.repository, release, version: tagVersion });
  const bytes = await downloadLimited(choice.url, { fetchImpl });
  const unpacked = normalisePackage(unpackLimited(bytes));
  const manifest = unpacked.manifest;

  const id = String(manifest.id || '');
  if (!PLUGIN_ID.test(id)) {
    throw new ReleaseSourceError(422, 'The manifest id has to be lower-case letters, digits and hyphens (for example my-plugin).', 'manifest_id');
  }
  if (isCommercialPlugin(id) || isDevEditionPlugin(id)) {
    throw new ReleaseSourceError(422, `"${id}" is the id of a plugin that ships with React-WP. Choose another id in manifest.json.`, 'manifest_reserved');
  }
  if (manifest.edition === 'dev') {
    throw new ReleaseSourceError(422, 'manifest.json says "edition": "dev", which is only for plugins that never leave the vendor.', 'manifest_edition');
  }
  if (expectedSlug && id !== expectedSlug) {
    throw new ReleaseSourceError(422, `This repository is linked to "${expectedSlug}", but the manifest in release ${release.tag} says "${id}". The id of a published plugin cannot change.`, 'manifest_id_changed');
  }
  const manifestVersion = String(manifest.version || '').trim();
  if (manifestVersion !== tagVersion) {
    throw new ReleaseSourceError(422, `The release is tagged ${release.tag}, but manifest.json inside it says version ${manifestVersion || '(none)'}. Change the manifest to ${tagVersion}, publish the release again and retry.`, 'version_mismatch');
  }

  const report = vetFiles(unpacked.entries, { docsAreInert: true });
  const severity = severityOf(report, { ownerRepository: isOwner });
  if (isOwner && severity === 'advisory' && severityOf(report) === 'critical') {
    report.flags = [...(report.flags || []), 'Owner repository: the blocking findings above are held for the marketplace owner to read and approve; nothing is published automatically.'];
  }
  const policy = decidePolicy({ severity, isOwner });
  const zip = unpacked.zip;
  return {
    repository: latest.repository,
    release,
    package: { kind: choice.kind, name: choice.name },
    id,
    version: tagVersion,
    manifest: {
      name: String(manifest.name || id),
      description: String(manifest.description || ''),
      category: String(manifest.category || ''),
      author: String(manifest.author || ''),
    },
    zip,
    size: zip.length,
    sha256: sha256Hex(zip),
    report: { ...report, source: { repository: latest.repository.fullName, tag: release.tag, package: choice.kind, sha256: sha256Hex(zip) }, severity },
    severity,
    policy,
  };
}

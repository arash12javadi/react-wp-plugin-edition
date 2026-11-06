/**
 * The platform's half of the managed-update package.
 *
 * `POST /api/v1/updates/apply` on the central server answers with the release package an end-user site
 * downloads and applies to itself. This module builds that package from the platform's *release*
 * repository — `RWP_RELEASE_REPO` + `RWP_RELEASE_TOKEN`, the same pair the central check reads — so the
 * end user never learns a GitHub name and never needs a Vercel token or a deploy hook.
 *
 * The answer is a ZIP of the tag's committed files (GitHub's own `git archive` tarball) with `plugins/`
 * stripped: a core update may overwrite everything else, but the user's plugins directory is off limits
 * by construction, exactly as `scripts/selfUpdateRun.mjs` preserves it on the way in.
 *
 * Plain ESM with no `node:` imports: `fflate` is pure JavaScript, so this file bundles into the Vercel
 * function by `vite.api.config.mjs` the same way `centralUpdates.mjs` does. The tar reader below is the
 * same minimal ustar/pax reader the SaaS installer uses, kept here so the two hosts and the central
 * route share one package format.
 */
import { gunzipSync, zipSync } from 'fflate';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_USER_AGENT = 'react-wp';

/** One invocation's limits, so a rogue release cannot make the platform hold an unbounded archive. */
const TARBALL_LIMIT_BYTES = 64 * 1024 * 1024;
const TARBALL_LIMIT_ENTRY = 32 * 1024 * 1024;
const TARBALL_LIMIT_FILES = 20_000;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A release manifest with `version` set to the tag being packaged, or the same bytes when there is nothing
 * to correct.
 *
 * A tag's `package.json` lags the tag often enough to matter: the number is written while the release is
 * being prepared, and the file committed beside the tag can still name the previous one. The site that
 * applies this package reports its own manifest when nothing pins it (`resolveInstalledVersion`, step 4), so
 * packaging it unchanged would leave a site that has just updated to `2.5.4` answering `1.3.1` on the very
 * next check — and being offered the same update again. The ZIP is an archive of *a release*, so its
 * manifest carries the release's version; a body that is not JSON, or a `version` that is not a version, is
 * passed through untouched rather than guessed at.
 *
 * `TextDecoder`/`TextEncoder` rather than `Buffer`: this file is bundled into the Vercel function and keeps
 * its promise of no `node:` imports.
 *
 * @param {Uint8Array} bytes the release's own `package.json`
 * @param {string} version the tag, `v2.5.4` or `2.5.4`
 * @returns {Uint8Array}
 */
function manifestAtVersion(bytes, version) {
  const plain = trimmed(version).replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(plain)) return bytes;
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return bytes;
    manifest.version = plain;
    return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    return bytes;
  }
}

/** A refusal that carries the HTTP status the route should answer with. */
class ReleasePackageError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ReleasePackageError';
    this.status = status;
  }
}

const utf8 = new TextDecoder('utf-8');

/** A NUL-terminated utf8 field of a tar header. */
function tarField(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  // TextDecoder, not toString: fflate hands back a Uint8Array, whose toString ignores 'utf8' and joins
  // the byte values with commas — every name would come out as '112,97,99,…' and no file would match.
  return utf8.decode(slice.subarray(0, end === -1 ? slice.length : end));
}

/** A tar header's size: octal, or GNU's base-256 encoding when the high bit of the first byte is set. */
function tarSize(header) {
  if ((header[124] & 0x80) !== 0) {
    let size = 0;
    for (const byte of header.subarray(125, 136)) size = size * 256 + byte;
    return size;
  }
  const text = tarField(header, 124, 12).trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : 0;
}

/** The `key=value` records of a pax header, counted in bytes as the format counts them. */
function paxRecords(data) {
  const records = new Map();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(utf8.decode(data.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = utf8.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/** The regular files in a gzipped tar, as `path → bytes`, keyed by the path inside the archive. */
function readTarFiles(gzipped) {
  let archive;
  try {
    archive = gunzipSync(gzipped);
  } catch {
    throw new ReleasePackageError('GitHub returned a tarball this server could not decompress.');
  }
  const files = new Map();
  let offset = 0;
  let longName = '';
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = tarField(header, 0, 100);
    if (!name) break;
    const size = tarSize(header);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > archive.length) break;
    const data = archive.subarray(dataStart, dataEnd);

    if (type === 'x') {
      longName = trimmed(paxRecords(data).get('path')) || longName;
    } else if (type === 'L') {
      longName = tarField(data, 0, data.length);
    } else if (type === '0' || type === '\0') {
      const prefix = tarField(header, 345, 155);
      const full = longName || (prefix ? `${prefix}/${name}` : name);
      longName = '';
      const parts = full.split('/');
      const safe = parts.length > 1
        && !parts.some((part) => part === '..' || part === '.')
        && !/^\/|^[A-Za-z]:/.test(parts[0])
        && size <= TARBALL_LIMIT_ENTRY;
      if (safe) {
        files.set(full, data);
        if (files.size > TARBALL_LIMIT_FILES) {
          throw new ReleasePackageError(`The release has more than ${TARBALL_LIMIT_FILES} files.`, 413);
        }
      }
    } else {
      longName = '';
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Drops the archive's single wrapper directory (`owner-repo-<sha>/` in GitHub's layout). */
function stripArchiveRoot(files) {
  const names = [...files.keys()];
  if (!names.length) return files;
  const root = names[0].split('/')[0];
  if (!root || !names.every((name) => name.startsWith(`${root}/`))) return files;
  const stripped = new Map();
  for (const [name, bytes] of files) {
    const relative = name.slice(root.length + 1);
    if (relative) stripped.set(relative, bytes);
  }
  return stripped;
}

/** Follows GitHub's tarball redirect by hand, keeping the credential only on GitHub hosts. */
async function fetchTarball(repo, ref, token, fetchImpl = fetch) {
  const [owner, name] = repo.split('/');
  const endpoint = `${GITHUB_API}/repos/${owner}/${name}/tarball/${encodeURIComponent(ref)}`;
  const signal = AbortSignal.timeout(90_000);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': GITHUB_USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    throw new ReleasePackageError(`GitHub did not answer the tarball request for ${repo}@${ref} (${error instanceof Error ? error.message : 'network error'}).`, 504);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = trimmed(response.headers?.get?.('location') ?? '');
    let target = null;
    try { target = new URL(location); } catch { target = null; }
    if (!target || !/(^|\.)github(usercontent)?\.com$/i.test(target.hostname)) {
      throw new ReleasePackageError(`GitHub answered the tarball request with a redirect to ${target ? target.hostname : 'no location'}, which this server will not follow with its repository credential.`);
    }
    try {
      response = await fetchImpl(target.toString(), {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'User-Agent': GITHUB_USER_AGENT,
          Accept: 'application/x-gzip',
        },
        signal,
      });
    } catch (error) {
      throw new ReleasePackageError(`GitHub's archive host did not answer for ${repo}@${ref} (${error instanceof Error ? error.message : 'network error'}).`, 504);
    }
  }

  if (response.status === 404) {
    throw new ReleasePackageError(`The release repository has no tag "${ref}".`, 404);
  }
  if (!response.ok) {
    throw new ReleasePackageError(`GitHub answered HTTP ${response.status} for ${repo}@${ref}.`, 502);
  }

  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > TARBALL_LIMIT_BYTES) {
    throw new ReleasePackageError(`The release is larger than ${Math.round(TARBALL_LIMIT_BYTES / (1024 * 1024))} MB.`, 413);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > TARBALL_LIMIT_BYTES) {
    throw new ReleasePackageError(`The release is larger than ${Math.round(TARBALL_LIMIT_BYTES / (1024 * 1024))} MB.`, 413);
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new ReleasePackageError(`GitHub answered ${repo}@${ref} with something that is not a gzipped tarball.`);
  }
  return bytes;
}

/**
 * Builds the core release ZIP for one tag: fetch the tarball, drop the wrapper and `plugins/`, zip the
 * rest. `package.json` must be present at the root, exactly the check the SaaS installer makes.
 *
 * @param {{ repo: string, token: string, version: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: true, version: string, filename: string, contentType: string, bytes: Uint8Array } | { ok: false, status: number, error: string }>}
 */
export async function buildCoreReleaseZip({ repo, token, version, fetchImpl = fetch }) {
  const target = trimmed(repo);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(target)) {
    return { ok: false, status: 400, error: 'The release repository is not owner/name.' };
  }
  if (!/^v?\d+\.\d+\.\d+/.test(trimmed(version))) {
    return { ok: false, status: 400, error: `"${trimmed(version)}" is not a release tag.` };
  }
  try {
    const files = stripArchiveRoot(readTarFiles(await fetchTarball(target, trimmed(version), trimmed(token), fetchImpl)));
    const core = {};
    let hasManifest = false;
    for (const [name, bytes] of files) {
      if (name === 'plugins' || name.startsWith('plugins/')) continue;
      if (name === 'package.json') hasManifest = true;
      core[name] = bytes;
    }
    if (!hasManifest) {
      return { ok: false, status: 502, error: `${target}@${version} has no package.json at its root, so it is not a release of this template.` };
    }
    // The archive is a release, so its manifest names the release — see `manifestAtVersion`.
    core['package.json'] = manifestAtVersion(core['package.json'], trimmed(version));
    return {
      ok: true,
      version: trimmed(version),
      filename: `react-wp-${trimmed(version)}.zip`,
      contentType: 'application/zip',
      bytes: zipSync(core, { level: 6 }),
    };
  } catch (error) {
    if (error instanceof ReleasePackageError) {
      return { ok: false, status: error.status, error: error.message };
    }
    return { ok: false, status: 502, error: error instanceof Error ? error.message : 'The release package could not be built.' };
  }
}

/**
 * The core files of one release, as a map — what the Git-based core updater (`server/gitDeploy/coreUpdate.mjs`)
 * merges into a client's repository. The same fetch and the same safety rules as `buildCoreReleaseZip`: the
 * tarball comes from api.github.com over https (redirects are followed only to GitHub hosts), entries with a
 * `..` segment, an absolute path or an oversized body are dropped by `readTarFiles`, symlinks and other
 * non-file entries are never produced, and `plugins/` is left out because plugins are the client's.
 *
 * @param {{ repo: string, token?: string, version: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<Map<string, Uint8Array>>} throws a `ReleasePackageError` (with `status`) on any refusal
 */
export async function fetchCoreReleaseFiles({ repo, token = '', version, fetchImpl = fetch }) {
  const target = trimmed(repo);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(target)) {
    throw new ReleasePackageError('The release repository is not owner/name.', 400);
  }
  if (!/^v?\d+\.\d+\.\d+/.test(trimmed(version))) {
    throw new ReleasePackageError(`"${trimmed(version)}" is not a release tag.`, 400);
  }
  const files = stripArchiveRoot(readTarFiles(await fetchTarball(target, trimmed(version), trimmed(token), fetchImpl)));
  const core = new Map();
  for (const [name, bytes] of files) {
    if (name === 'plugins' || name.startsWith('plugins/')) continue;
    core.set(name, new Uint8Array(bytes));
  }
  if (!core.has('package.json')) {
    throw new ReleasePackageError(`${target}@${trimmed(version)} has no package.json at its root, so it is not a release of this template.`, 502);
  }
  core.set('package.json', manifestAtVersion(core.get('package.json'), trimmed(version)));
  return core;
}

export { ReleasePackageError };

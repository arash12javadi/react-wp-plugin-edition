/**
 * The merge policy of a React-WP core update applied to a client's GitHub repository.
 *
 * A core update must change core and nothing else. The repository holds three kinds of path, and each has
 * one rule:
 *
 *   client-owned   `plugins/**`, `data/**`, `.env*` (except `.env.example`), `react-wp-config*.json`,
 *                  `.rwp-worker.json`, `.rwp-tmp/**`, `.vercel/**`, `state/**`, `.state/**`.
 *                  Never written, never deleted, whatever the release contains.
 *   merged         `server/plugins.mjs` and `package.json`: core files that also carry the client's state
 *                  (plugin server registrations; dependencies a plugin needed). The release's copy is the
 *                  starting point and the client's part is carried onto it (`mergeRegistry`,
 *                  `mergePackageJson`).
 *   core-owned     every other path the release ships. Updated by a three-way comparison:
 *
 *     base = the release the repository runs now (its package.json version, fetched as that tag)
 *     ours = the file on the production branch
 *     next = the file in the release being installed
 *
 *     ours == next                  nothing to do
 *     ours missing                  added
 *     ours == base                  replaced by next (the client never touched it)
 *     next == base (ours differs)   kept: the client changed a file this release does not change
 *     anything else                 a CONFLICT — reported, never silently overwritten
 *
 *   A path the base release had and the next one drops is deleted only when the repository still holds
 *   the base's exact bytes; a locally changed copy is a conflict. Without a base release (the installed
 *   tag cannot be fetched) every differing core file is a conflict, so stale core files are not kept by
 *   accident and customised ones are not lost by accident: the administrator decides, per file.
 *
 *   A conflict is resolved only by an explicit choice per path — `release` (take the new file, or the
 *   deletion) or `keep` (leave the repository's file) — and an update with an unresolved conflict is
 *   refused before anything is committed.
 *
 * Files the repository has that neither release knows (a client's own additions outside plugins/) are
 * untouched. Everything here is pure: no network, no clock, no filesystem — `coreUpdate.mjs` does the I/O.
 */
import { createHash } from 'node:crypto';
import { VERSION_PATH, readStamp, readVersionRecord } from '../versionRecord.mjs';
import {
  addServerPluginImportToSource,
  removeServerPluginImportFromSource,
  serverPluginImportsFromSource,
} from '../serverPluginImports.mjs';

export const REGISTRY_PATH = 'server/plugins.mjs';
export const PACKAGE_PATH = 'package.json';
export const MERGED_PATHS = Object.freeze([REGISTRY_PATH, PACKAGE_PATH]);
export { VERSION_PATH, readStamp, readVersionRecord };

const CLIENT_OWNED_PREFIXES = ['plugins/', 'data/', '.rwp-tmp/', '.vercel/', 'state/', '.state/', 'node_modules/', 'dist/', 'src/server-dist/'];

/** Whether a core update must leave `path` exactly as the repository has it. */
export function isClientOwnedPath(path) {
  const value = String(path || '');
  if (CLIENT_OWNED_PREFIXES.some((prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix))) return true;
  const name = value.split('/').pop() || '';
  if (/^\.env(\..*)?$/.test(name) && name !== '.env.example') return true;
  if (/^react-wp-config.*\.json$/.test(name)) return true;
  if (name === '.rwp-worker.json' || /^\.plugins\..*\.mjs$/.test(name)) return true;
  return false;
}

/** The path rule the commit enforces for a core update: anything a release may own, never a client path. */
export function assertCoreWritable(path) {
  if (isClientOwnedPath(path)) {
    throw new Error(`Refusing to write "${path}" during a core update: it belongs to the site, not to core.`);
  }
}

/** Git's object id for a file's bytes: sha1("blob <length>\0" + bytes). Comparable to a tree entry's `sha`. */
export function gitBlobSha(bytes) {
  const body = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes ?? ''));
  return createHash('sha1').update(`blob ${body.byteLength}\0`).update(body).digest('hex');
}

const sameBytesSha = (map, path) => (map && map.has(path) ? gitBlobSha(map.get(path)) : null);

/**
 * Plans the core-owned part of an update.
 *
 * @param {{
 *   repo: Map<string, { sha: string }>,
 *   base: Map<string, Uint8Array> | null,
 *   next: Map<string, Uint8Array>,
 *   resolutions?: Record<string, 'release' | 'keep'>,
 * }} input
 */
export function planCoreFiles({ repo, base, next, resolutions = {} }) {
  const writes = [];
  const deletions = [];
  const conflicts = [];
  const kept = [];
  let unchanged = 0;

  const conflict = (path, reason, action) => {
    const choice = resolutions[path];
    conflicts.push({ path, reason, resolution: choice === 'release' || choice === 'keep' ? choice : null });
    if (choice === 'release') action();
    else if (choice === 'keep') kept.push({ path, reason: 'kept by your choice' });
  };

  for (const [path, bytes] of next) {
    if (isClientOwnedPath(path) || MERGED_PATHS.includes(path) || path === VERSION_PATH) continue;
    const nextSha = gitBlobSha(bytes);
    const oursSha = repo.get(path)?.sha || null;
    if (!oursSha) {
      writes.push({ path, content: bytes, change: 'added' });
      continue;
    }
    if (oursSha === nextSha) {
      unchanged += 1;
      continue;
    }
    const baseSha = sameBytesSha(base, path);
    if (base && baseSha === oursSha) {
      writes.push({ path, content: bytes, change: 'updated' });
    } else if (base && baseSha === nextSha) {
      kept.push({ path, reason: 'changed in this repository; this release does not change it' });
    } else {
      conflict(path, base ? (baseSha ? 'changed here and in the release' : 'added here and in the release with different contents') : 'differs from the release, and the installed release could not be read to tell whether it was changed here', () => writes.push({ path, content: bytes, change: 'updated' }));
    }
  }

  if (base) {
    for (const [path, bytes] of base) {
      if (next.has(path) || isClientOwnedPath(path) || MERGED_PATHS.includes(path) || path === VERSION_PATH) continue;
      const oursSha = repo.get(path)?.sha || null;
      if (!oursSha) continue;
      if (oursSha === gitBlobSha(bytes)) {
        deletions.push(path);
      } else {
        conflict(path, 'removed by the release but changed here', () => deletions.push(path));
      }
    }
  }

  return {
    writes,
    deletions,
    conflicts,
    unresolved: conflicts.filter((item) => !item.resolution).map((item) => item.path),
    kept,
    unchanged,
  };
}

/**
 * The release's `server/plugins.mjs`, with exactly the plugin registrations this repository will have.
 *
 * A registration stays when `plugins/<folder>/server.mjs` exists on the branch; the release's own list is
 * not trusted for the client's plugins (a release ships without `plugins/`, so a folder it imports may not
 * exist here, and the build would fail importing it).
 *
 * @returns {{ ok: true, source: string, carried: string[], dropped: string[] } | { ok: false, reason: string }}
 */
export function mergeRegistry({ releaseSource, repoSource, repoPaths }) {
  if (typeof releaseSource !== 'string') return { ok: false, reason: 'The release has no server/plugins.mjs.' };
  let released;
  let ours = [];
  try {
    released = serverPluginImportsFromSource(releaseSource);
    if (typeof repoSource === 'string') ours = serverPluginImportsFromSource(repoSource);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const present = (folder) => repoPaths.has(`plugins/${folder}/server.mjs`);
  let source = releaseSource;
  const dropped = [];
  for (const folder of released) {
    if (!present(folder)) {
      source = removeServerPluginImportFromSource(source, folder).source;
      dropped.push(folder);
    }
  }
  const carried = [];
  for (const folder of ours) {
    if (!present(folder)) continue;
    const edit = addServerPluginImportToSource(source, folder);
    source = edit.source;
    if (edit.changed) carried.push(folder);
  }
  return { ok: true, source, carried, dropped };
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * The release's `package.json`, plus the dependencies this repository added itself (the ones neither the
 * installed release nor the new one declares — what a plugin asked to be installed). A dependency the new
 * release declares takes the release's version; one the installed release had and the new one dropped is
 * dropped.
 *
 * @returns {{ ok: true, source: string, carried: string[] } | { ok: false, reason: string }}
 */
export function mergePackageJson({ releaseSource, repoSource, baseSource = null }) {
  let next;
  let ours = {};
  let base = null;
  try {
    next = JSON.parse(releaseSource);
    if (typeof repoSource === 'string') ours = JSON.parse(repoSource);
    if (typeof baseSource === 'string') base = JSON.parse(baseSource);
  } catch (error) {
    return { ok: false, reason: `package.json could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!next || typeof next !== 'object' || Array.isArray(next)) return { ok: false, reason: 'The release package.json is not an object.' };
  const carried = [];
  for (const field of DEPENDENCY_FIELDS) {
    const mine = ours?.[field] && typeof ours[field] === 'object' ? ours[field] : {};
    for (const [name, range] of Object.entries(mine)) {
      if (typeof range !== 'string') continue;
      const declaredByRelease = DEPENDENCY_FIELDS.some((any) => next?.[any] && Object.hasOwn(next[any], name));
      const declaredByBase = base ? DEPENDENCY_FIELDS.some((any) => base?.[any] && Object.hasOwn(base[any], name)) : false;
      if (declaredByRelease || declaredByBase) continue;
      next[field] = { ...(next[field] || {}), [name]: range };
      carried.push(`${name}@${range}`);
    }
  }
  // The installer chains the bundle lock (`node scripts/rwp-lock-bundle.mjs`) onto this repository's build.
  // The release's own build script does not carry it, so replacing it would silently ship a readable bundle.
  const lockStep = 'node scripts/rwp-lock-bundle.mjs';
  const oursBuild = typeof ours?.scripts?.build === 'string' ? ours.scripts.build : '';
  const nextBuild = typeof next?.scripts?.build === 'string' ? next.scripts.build : '';
  if (oursBuild.includes('rwp-lock-bundle.mjs') && nextBuild && !nextBuild.includes('rwp-lock-bundle.mjs')) {
    next.scripts = { ...next.scripts, build: `${nextBuild} && ${lockStep}` };
  }
  return { ok: true, source: `${JSON.stringify(next, null, 2)}\n`, carried };
}

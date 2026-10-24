/**
 * Plugins → Upload Plugin: installs a plugin ZIP (uploaded, or downloaded from an https URL)
 * into plugins/<id>/.
 *
 * The archive is unpacked in memory, checked, written to .rwp-tmp/ and only then moved into
 * plugins/, so a failed install never leaves a half-written plugin folder for the build to pick
 * up. The move is a rename where it can be and a copy where it cannot — see `moveIntoPlace`. SQL is
 * never run and npm packages are never installed: both are reported for the admin
 * to do by hand, because the app cannot change its own database schema and `npm install`
 * would run arbitrary package scripts.
 *
 * This module is the disk path: `server.mjs`, and the universal engine
 * (`src/server/routes/plugins.ts`) on a host whose filesystem an install survives on, which
 * `src/server/pluginHostMode.ts` establishes. The checks, the unpacking and the ZIP download are shared
 * with the Git-backed installer (`server/pluginGitInstaller.mjs`), which runs where nothing can be
 * written — its own steps only differ in what "installing" means: one commit on the repository the
 * deployment is built from. Keeping one copy of `unpack`/`readManifest`/`sqlFiles`/`inspectDependencies`
 * is what makes the two paths agree about which ZIPs are acceptable; they are exported for exactly that
 * reason, as is the `rwp_active_plugins` guard both of them apply.
 */
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { isIP } from 'node:net';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { listPluginFolders } from './pluginFiles.mjs';
import { addServerPluginImport } from './serverPluginImports.mjs';

/** Kept equal to MAX_PLUGIN_ZIP_BYTES in src/components/PluginUploadModal.tsx. */
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 150 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_REDIRECTS = 3;

const projectRoot = path.resolve('.');
const pluginsRoot = path.resolve('plugins');
const stagingRoot = path.resolve('.rwp-tmp');
const pluginIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ignoredEntries = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/];
const builtins = new Set(builtinModules);

/** An expected failure: `message` is shown to the admin as is. */
export class InstallError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

let installing = false;

// ---------------------------------------------------------------------------------------------
// Download

const privateV4 = (address) => {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
};

const privateAddress = (address) => {
  if (isIP(address) === 4) return privateV4(address);
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return privateV4(mapped[1]);
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
};

/** Refuses URLs that point into this server's own network (the request comes from the server). */
async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InstallError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:') throw new InstallError('Only https:// plugin URLs are accepted.');
  if (url.username || url.password) throw new InstallError('Plugin URLs must not contain a username or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new InstallError(`The host "${host}" could not be resolved.`);
  }
  if (addresses.some(({ address }) => privateAddress(address))) {
    throw new InstallError(`"${host}" resolves to a private or local network address, which plugin downloads may not use.`);
  }
  return url;
}

/** Downloads a plugin ZIP after refusing anything that could reach a private address. */
export async function downloadZip(raw) {
  let url = await assertPublicUrl(raw);
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new InstallError(`Downloading ${url.href} failed: ${error?.name === 'TimeoutError' ? 'no response within 60 seconds' : error?.cause?.message || error?.message || 'network error'}.`, 502);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirects >= MAX_REDIRECTS) throw new InstallError(`${raw} redirected more than ${MAX_REDIRECTS} times.`, 502);
      url = await assertPublicUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok) throw new InstallError(`Downloading ${url.href} failed: the server answered HTTP ${response.status}.`, 502);
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_ZIP_BYTES) throw new InstallError(`The file at ${url.href} is ${formatBytes(declared)}; plugin ZIPs may be at most ${formatBytes(MAX_ZIP_BYTES)}.`, 413);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ZIP_BYTES) throw new InstallError(`The file at ${url.href} is larger than ${formatBytes(MAX_ZIP_BYTES)}, the plugin ZIP limit.`, 413);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

const formatBytes = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

// ---------------------------------------------------------------------------------------------
// Unpacking

const safeEntryName = (name) => {
  const normalised = name.replace(/\\/g, '/');
  const segments = normalised.split('/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return null;
  // Control characters, and ":" (Windows drive letters and alternate data streams).
  if (/[\u0000-\u001f:]/.test(normalised)) return null;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment))) return null;
  return normalised;
};

/**
 * Returns Map<path relative to the plugin root, bytes>.
 *
 * Exported because the Git-backed installer commits exactly these entries, so both installers reject
 * the same archives: same unsafe-path rules, same file and size ceilings, same "one plugin per ZIP".
 */
export function unpack(zip) {
  if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50) {
    throw new InstallError(zip.length === 0 ? 'The uploaded file is empty.' : 'The file is not a ZIP archive (it does not start with a ZIP header).');
  }
  let files = 0;
  let unpackedBytes = 0;
  const unsafe = [];
  let archive;
  try {
    archive = unzipSync(new Uint8Array(zip.buffer, zip.byteOffset, zip.length), {
      filter: (file) => {
        if (file.name.endsWith('/') || ignoredEntries.some((pattern) => pattern.test(file.name))) return false;
        if (!safeEntryName(file.name)) {
          unsafe.push(file.name);
          return false;
        }
        files += 1;
        unpackedBytes += file.originalSize;
        if (files > MAX_FILES) throw new InstallError(`The ZIP contains more than ${MAX_FILES} files.`, 413);
        if (unpackedBytes > MAX_UNPACKED_BYTES) throw new InstallError(`The ZIP unpacks to more than ${formatBytes(MAX_UNPACKED_BYTES)}.`, 413);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError(`The ZIP archive is damaged or uses an unsupported format (only stored and deflate-compressed entries are supported): ${error?.message || error}.`);
  }
  if (unsafe.length) {
    throw new InstallError(`The ZIP contains unsafe file paths, so nothing was installed: ${unsafe.slice(0, 5).map((name) => JSON.stringify(name)).join(', ')}${unsafe.length > 5 ? ` and ${unsafe.length - 5} more` : ''}.`);
  }

  // Declared sizes are only a hint; check what was actually produced.
  const actualBytes = Object.values(archive).reduce((total, data) => total + data.length, 0);
  if (actualBytes > MAX_UNPACKED_BYTES) throw new InstallError(`The ZIP unpacks to more than ${formatBytes(MAX_UNPACKED_BYTES)}.`, 413);

  const names = Object.keys(archive);
  if (!names.length) throw new InstallError('The ZIP archive contains no files.');

  // Accept manifest.json at the root, or inside one top-level folder (as GitHub "Download ZIP" makes).
  let prefix = '';
  if (!names.includes('manifest.json')) {
    const nested = names.filter((name) => /^[^/]+\/manifest\.json$/.test(name));
    const top = nested.length === 1 ? nested[0].slice(0, nested[0].indexOf('/') + 1) : '';
    if (!top || !names.every((name) => name.startsWith(top))) {
      throw new InstallError(nested.length > 1
        ? `The ZIP contains several plugins (${nested.join(', ')}). Upload one plugin per ZIP.`
        : 'No manifest.json was found. It must be at the root of the ZIP, or inside a single top-level folder.');
    }
    prefix = top;
  }

  const entries = new Map();
  const lowerCase = new Map();
  for (const name of names) {
    const relative = name.slice(prefix.length);
    // Windows and macOS treat these as one file; the second would silently overwrite the first.
    const clash = lowerCase.get(relative.toLowerCase());
    if (clash) throw new InstallError(`The ZIP contains both "${clash}" and "${relative}", which are the same file on Windows and macOS.`);
    lowerCase.set(relative.toLowerCase(), relative);
    entries.set(relative, archive[name]);
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Validation and inspection

const decode = (bytes) => new TextDecoder('utf-8').decode(bytes);

/** Validates manifest.json and returns it; every problem is one `InstallError` listing all of them. */
export function readManifest(entries) {
  let manifest;
  try {
    manifest = JSON.parse(decode(entries.get('manifest.json')).replace(/^﻿/, ''));
  } catch (error) {
    throw new InstallError(`manifest.json is not valid JSON: ${error?.message || error}.`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new InstallError('manifest.json must contain a JSON object.');
  const problems = [];
  if (typeof manifest.id !== 'string' || !pluginIdPattern.test(manifest.id)) {
    problems.push(`"id" must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit (got ${JSON.stringify(manifest.id)})`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 200) {
    problems.push(`"name" must be a non-empty string of at most 200 characters (got ${JSON.stringify(manifest.name)})`);
  }
  if (typeof manifest.version !== 'string' || !versionPattern.test(manifest.version)) {
    problems.push(`"version" must look like 1.2.3 (got ${JSON.stringify(manifest.version)})`);
  }
  if (problems.length) throw new InstallError(`manifest.json is invalid: ${problems.join('; ')}.`);
  return manifest;
}

async function assertNoCollision(id) {
  const { plugins } = await listPluginFolders();
  const existing = plugins.find((plugin) => plugin.id === id);
  if (existing) {
    throw new InstallError(`A plugin with the id "${id}" is already installed (plugins/${existing.folder}, version ${existing.version || 'unknown'}). Delete it first to install this copy.`, 409);
  }
  try {
    await access(path.join(pluginsRoot, id));
  } catch {
    return;
  }
  throw new InstallError(`The folder plugins/${id} already exists but is not a valid plugin. Remove or rename it on the server first.`, 409);
}

/** Every .sql file in the archive, in the order the admin should run them. */
export const sqlFiles = (entries) => [...entries.keys()]
  .filter((name) => name.toLowerCase().endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((name) => ({ path: name, sql: decode(entries.get(name)) }));

const importPattern = /(?:import|export)\s+(?:[^'"`;]*?\sfrom\s*)?['"]([^'"\n]+)['"]|import\(\s*['"]([^'"\n]+)['"]\s*\)|require\(\s*['"]([^'"\n]+)['"]\s*\)/g;

const packageOf = (specifier) => {
  if (/^(?:\.|\/|[a-z]+:|#|@\/|~\/|\0)/i.test(specifier)) return null; // relative, absolute, node:, virtual:, aliases
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtins.has(name) || !packageNamePattern.test(name)) return null;
  return name;
};

/**
 * Reports the npm packages the plugin imports that this project does not have.
 *
 * Exported for the Git-backed installer: it runs in the same project, from the same `package.json`
 * and `node_modules`, so the same answer — and the same copy-pasteable `npm install` line — is right
 * for both.
 */
export async function inspectDependencies(entries) {
  const used = new Map();
  for (const [name, bytes] of entries) {
    if (name.split('/').includes('node_modules') || !sourceExtensions.has(path.extname(name))) continue;
    const text = decode(bytes).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] || match[2] || match[3];
      const pkg = packageOf(specifier);
      if (!pkg) continue;
      const files = used.get(pkg) || new Set();
      files.add(name);
      used.set(pkg, files);
    }
  }

  let pluginPackage = {};
  if (entries.has('package.json')) {
    try {
      pluginPackage = JSON.parse(decode(entries.get('package.json')));
    } catch {
      pluginPackage = {};
    }
  }
  const wantedRanges = { ...(pluginPackage.peerDependencies || {}), ...(pluginPackage.dependencies || {}) };
  for (const name of Object.keys(wantedRanges)) {
    if (packageNamePattern.test(name) && !used.has(name)) used.set(name, new Set(['package.json']));
  }

  const rootPackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const declared = { ...(rootPackage.devDependencies || {}), ...(rootPackage.dependencies || {}) };

  const missing = [];
  for (const [name, files] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.has(`node_modules/${name}/package.json`)) continue; // shipped inside the plugin
    const range = typeof wantedRanges[name] === 'string' && /^[\w.^~<>=|*\s-]+$/.test(wantedRanges[name]) ? wantedRanges[name].trim() : undefined;
    let installed = true;
    try {
      await access(path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json'));
    } catch {
      installed = false;
    }
    if (declared[name] && installed) continue;
    missing.push({ name, range, reason: declared[name] ? 'not-installed' : 'not-declared', usedIn: [...files].slice(0, 5) });
  }
  const toInstall = missing.map(({ name, range, reason }) => (reason === 'not-declared' && range ? `"${name}@${range}"` : name));
  return { missing, installCommand: toInstall.length ? `npm install ${toInstall.join(' ')}` : null };
}

// ---------------------------------------------------------------------------------------------
// Install

async function writeStaging(entries) {
  const staging = path.join(stagingRoot, `plugin-${randomUUID()}`);
  for (const [name, bytes] of entries) {
    const target = path.resolve(staging, ...name.split('/'));
    if (!target.startsWith(`${staging}${path.sep}`)) throw new InstallError(`Refusing to write "${name}" outside the plugin folder.`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return staging;
}

/**
 * The errors that mean "not now" rather than "never". A handle held anywhere inside the tree —
 * antivirus, the Vite watcher, a search indexer, an editor — is enough for Windows to refuse to move
 * the *directory* with `EPERM`, and to refuse to copy it with `EBUSY`, however idle the machine is.
 * Measured on Windows 11 with one child file open `FileShare.None`: `rename` answered EPERM and `cp`
 * answered EBUSY. Both are cleared by the same thing — patience — which is what `withLockRetries` is.
 */
const lockCodes = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE']);

/**
 * The errors that mean a rename cannot work at all, so there is no point waiting for one: `EXDEV` is
 * a different mount/volume (a Docker bind mount, a WSL path, a junction), and the rest are a
 * destination that is in the way (a leftover directory, a stray file where the folder goes).
 */
const unmovableCodes = new Set(['EXDEV', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR']);

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Runs a filesystem call again while a lock is on it: up to six attempts, 250 ms apart and growing,
 * so about 5s of patience for a scanner or a watcher to let go. Anything else — and a lock that
 * outlives the attempts — is handed to the caller, because a folder another process is holding open
 * for good is a real failure, not a race.
 */
async function withLockRetries(operation, attempts = 6) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts - 1 || !lockCodes.has(error?.code)) throw error;
      await pause(250 * (attempt + 1));
    }
  }
}

/**
 * `rm -rf` that reports rather than throws. A tree another process holds open cannot be deleted at
 * all, and failing an install over one is not worth it: `installPlugin` clears `.rwp-tmp/`
 * (`rm(stagingRoot, …)`) at the start of every install, so a leftover the lock outlives is collected
 * by the next upload. The one caller that acts on `false` is the copy fallback in `moveIntoPlace`,
 * where a destination that would not go away is part of what must be told to the administrator.
 */
const remove = (target) => withLockRetries(() => rm(target, { recursive: true, force: true })).then(() => true, () => false);

/**
 * Puts the staged folder at `plugins/<id>/`: clear the destination, rename, and — when the rename is
 * refused for a reason a retry cannot clear — copy the tree and delete the original. The copy is what
 * makes this survive Windows, because it writes new files into a directory of its own instead of
 * asking the filesystem to swap one directory for another while a handle is open on it. It is also
 * the documented answer for `EXDEV` (Node's own recommendation): two mounts cannot be renamed across.
 *
 * The destination is cleared first because a rename onto an existing directory fails on Windows
 * whatever its contents are. That is safe *here* and only here: `assertNoCollision` has already run,
 * so a plugin with this id is a 409 before this function is reached and a *valid* folder can never be
 * the thing being deleted. What is left is a leftover — including the case that used to reach `rename`
 * and fail, where the folder exists but `access()` could not see it (a locked or ACL-denied path made
 * the collision check pass) and the rename then landed on it.
 *
 * Staging is removed last and its failure is ignored: the plugin is installed by that point, and
 * failing the call would roll a finished install back. Exported because it is the whole of
 * Windows-tolerant staging — a second caller must not have to re-derive it.
 */
export async function moveIntoPlace(staging, target) {
  await remove(target);
  try {
    await withLockRetries(() => rename(staging, target));
    return;
  } catch (error) {
    // Only the codes a copy can rescue. ENOSPC, ENOENT and a genuine permission error on a *read* are
    // real failures and belong to the caller's rollback (it deletes `installedFolder`/`staging`).
    if (!lockCodes.has(error?.code) && !unmovableCodes.has(error?.code)) throw error;
  }
  await remove(target);
  try {
    await withLockRetries(() => cp(staging, target, { recursive: true, force: true }));
  } catch (error) {
    // A copy is not atomic, and the promise this module makes in its header is that a failed install
    // leaves nothing half-written for the build to find. So undo what arrived — and if even that is
    // refused, say so, rather than report a failure that the next build would meet as a broken plugin.
    if (await remove(target)) throw error;
    throw new InstallError(`plugins/${path.basename(target)} could not be written (${error?.code || error}) and the partial copy could not be removed either. Delete or empty that folder on the server, then upload the plugin again.`, 500);
  }
  await remove(staging);
}

/**
 * The rwp_active_plugins option missing means "every bundled plugin is active" (App.tsx), which
 * would switch the new plugin on at the next build. Pin the current set first so it arrives inactive.
 */
async function pinActivePlugins(auth, existingIds) {
  const read = await fetch(`${auth.baseUrl}/rest/v1/options?option_name=eq.rwp_active_plugins&select=option_name`, { headers: auth.headers });
  if (!read.ok) return `Could not read rwp_active_plugins (HTTP ${read.status}), so the new plugin may start active.`;
  if ((await read.json()).length) return null;
  const write = await fetch(`${auth.baseUrl}/rest/v1/options`, {
    method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ option_name: 'rwp_active_plugins', option_value: JSON.stringify(existingIds) }),
  });
  if (!write.ok) {
    return `rwp_active_plugins is not set, and saving it failed (HTTP ${write.status}; it needs the manage_options capability). Until it is saved, every plugin — including this one — is active after the next build. Activate or deactivate any plugin under Plugins to save it.`;
  }
  return null;
}

/**
 * The same guard, for a host whose database is not reachable over Supabase REST.
 *
 * The option is read and written through an engine database adapter's `getOption`/`setOption`, which
 * every adapter implements, so a SQLite or Postgres installation is pinned the same way one on Supabase
 * is. The Git-backed installer applies this before it commits and the universal engine applies it before
 * it writes `plugins/<id>/`, and both have to tell the administrator the same thing — which is why there
 * is one copy of it here rather than one beside each installer.
 */
export async function pinActivePluginsWithStore(optionStore, existingIds) {
  if (!optionStore) return null;
  try {
    const current = await optionStore.getOption('rwp_active_plugins');
    if (current !== null && current !== undefined) return null;
    await optionStore.setOption('rwp_active_plugins', existingIds);
    return null;
  } catch (error) {
    return `rwp_active_plugins could not be saved (${error?.message || error}). Until it is, every installed plugin — including this one — is active after the next build. Activate or deactivate any plugin under Plugins to save it.`;
  }
}

/**
 * POSTs the site's deploy hook — the one saved on Settings → Integrations → Deployments
 * (`deploy_config`, which the caller resolves and passes in) or, for a host with no hub in front of it,
 * `VERCEL_DEPLOY_HOOK_URL`.
 *
 * Shared with the Git-backed installer and the uninstall path, which trigger the same rebuild after
 * their commit: one implementation of "is a hook configured, and did it answer" keeps all three halves
 * of the plugin work telling the admin the same thing. The hook URL is a secret — it is the whole
 * credential, since the platform accepts an unauthenticated POST — and is never echoed back.
 *
 * `configuredHook` first, the environment second: a row saved from the admin wins over a variable left
 * in `.env`, because that is the one an administrator can rotate without a redeploy.
 */
export async function triggerDeployHook(configuredHook = '') {
  const hook = String(configuredHook || '').trim() || String(process.env.VERCEL_DEPLOY_HOOK_URL || '').trim();
  if (!hook) return { configured: false, triggered: false };
  // Parsed before the network try, so a half-pasted URL is reported as the wrong value rather than as a
  // failure to reach it: "Invalid URL" next to a timeout message would send the admin looking at their
  // network for what is a copy-paste mistake in the card.
  let url;
  try {
    url = new URL(hook);
  } catch {
    return { configured: true, triggered: false, error: 'The deploy hook is not a valid URL. Paste the complete address the platform gave you.' };
  }
  if (url.protocol !== 'https:') return { configured: true, triggered: false, error: 'The deploy hook must be an https:// URL.' };
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    // The hook URL is a secret; it is never echoed back.
    return response.ok
      ? { configured: true, triggered: true, status: response.status }
      : { configured: true, triggered: false, status: response.status, error: `The deploy hook answered HTTP ${response.status}.` };
  } catch (error) {
    return { configured: true, triggered: false, error: `Calling the deploy hook failed: ${error?.name === 'TimeoutError' ? 'no response within 15 seconds' : error?.message || 'network error'}.` };
  }
}

/**
 * @param {{ zip?: Buffer, url?: string }} source
 * @param {{ baseUrl: string, headers: Record<string,string> } | null} auth  From authorizePluginManager; null when `options.optionStore` does the pinning.
 * @param {(step: string) => void} onStep  downloading | extracting | validating | installing | registering-routes | triggering-rebuild
 * @param {{ optionStore?: { getOption: (name: string) => Promise<unknown>, setOption: (name: string, value: unknown) => Promise<unknown> }, deployHook?: string }} [options]
 *   `optionStore` pins `rwp_active_plugins` through an engine's own database adapter instead of the
 *   Supabase REST call `auth` implies — what the universal engine passes, whose database is whichever
 *   `DB_TYPE` selects. `deployHook` is the `deploy_config` URL the caller resolved (Settings →
 *   Integrations → Deployments); left out, `VERCEL_DEPLOY_HOOK_URL` is used. Nothing else differs
 *   between the two callers: one `plugins/<id>/` either way.
 */
export async function installPlugin(source, auth, onStep, { optionStore, deployHook } = {}) {
  if (installing) throw new InstallError('Another plugin is being installed right now. Wait for it to finish, then try again.', 409);
  installing = true;
  let staging = null;
  let installedFolder = null;
  try {
    let zip = source.zip;
    if (!zip) {
      onStep('downloading');
      zip = await downloadZip(String(source.url || ''));
    }

    onStep('extracting');
    const entries = unpack(zip);

    onStep('validating');
    if (!entries.has('manifest.json')) throw new InstallError('No manifest.json was found in the ZIP.');
    const manifest = readManifest(entries);
    if (!entries.has('index.tsx')) {
      throw new InstallError(`index.tsx is missing next to manifest.json. The build loads plugins from plugins/${manifest.id}/index.tsx.`);
    }
    await assertNoCollision(manifest.id);
    const sql = sqlFiles(entries);
    const dependencies = await inspectDependencies(entries);
    const hasServer = entries.has('server.mjs');

    onStep('installing');
    const warnings = [];
    const { plugins } = await listPluginFolders();
    const known = plugins.map((plugin) => plugin.id);
    const pinWarning = optionStore
      ? await pinActivePluginsWithStore(optionStore, known)
      : await pinActivePlugins(auth, known);
    if (pinWarning) warnings.push(pinWarning);
    await rm(stagingRoot, { recursive: true, force: true }); // leftovers of an interrupted install
    staging = await writeStaging(entries);
    const target = path.join(pluginsRoot, manifest.id);
    await assertNoCollision(manifest.id); // the folder could have appeared while files were written
    await mkdir(pluginsRoot, { recursive: true });
    await moveIntoPlace(staging, target);
    staging = null;
    installedFolder = target;

    const serverRoutes = { detected: hasServer, registered: false };
    if (hasServer) {
      onStep('registering-routes');
      try {
        serverRoutes.registered = (await addServerPluginImport(manifest.id)).changed;
      } catch (error) {
        throw new InstallError(`The plugin has a server.mjs, but its import could not be added to server/plugins.mjs, so the install was rolled back: ${error?.message || error}`, 500);
      }
    }
    installedFolder = null; // committed: from here on nothing is rolled back

    onStep('triggering-rebuild');
    const deploy = await triggerDeployHook(deployHook);
    if (deploy.triggered) {
      warnings.push('This host installs plugins on its own disk, so the rebuild it just triggered is of the repository the platform builds from: that build includes plugins/' + manifest.id + (hasServer ? ' and the updated server/plugins.mjs' : '') + ' only once they are committed and pushed.');
    }

    return {
      plugin: { id: manifest.id, name: manifest.name, version: manifest.version, folder: manifest.id },
      files: entries.size,
      serverRoutes,
      sql,
      dependencies,
      deploy,
      restart: {
        required: true,
        reason: hasServer
          ? 'Restart the server with npm start (or npm run start:hono): it rebuilds the site, and a plugin\'s server routes are only loaded at startup.'
          : 'Restart the server with npm start (or npm run start:hono) so the site is rebuilt with the plugin. Under npm run dev it is picked up after a page reload.',
      },
      warnings,
    };
  } catch (error) {
    if (installedFolder) await rm(installedFolder, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    installing = false;
  }
}

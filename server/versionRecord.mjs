/**
 * The record of which release this checkout runs: `.rwp-version`, one line, the tag (`v3.0.5`).
 *
 * The update writes it in the same commit as the code (`server/gitDeploy/coreUpdate.mjs`) and the self-update
 * runner writes it after a successful build, so it cannot lag the code it describes — unlike `package.json`,
 * whose version need not match any tag. It is update-owned: never taken from a release, never merged.
 *
 * Plain ESM with a single `node:` import, which the Vercel bundle keeps external. A serverless function has no
 * repository on disk, so `vite.api.config.mjs` inlines the file's text as `__RWP_VERSION_RECORD__` at build time.
 */
import { readFile, writeFile } from 'node:fs/promises';

export const VERSION_PATH = '.rwp-version';

/** The release version (no `v`) a `.rwp-version` text names, or '' when it is not a version. */
export function readVersionRecord(source) {
  const text = typeof source === 'string' ? source : source instanceof Uint8Array ? new TextDecoder().decode(source) : '';
  const first = text.split(/\r?\n/)[0].trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(first) ? first : '';
}

/**
 * The release a `package.json` was stamped with by an update (`manifestAtVersion`): its `rwpRelease` marker, but only
 * when `version` repeats it. The template's own unstamped version (which names no tag) gives ''.
 */
export function readStamp(manifest) {
  if (!manifest || typeof manifest !== 'object') return '';
  const marked = readVersionRecord(String(manifest.rwpRelease || ''));
  return marked && readVersionRecord(String(manifest.version || '')) === marked ? marked : '';
}

/** The stamp of the `package.json` beside this code ('' on a serverless host, where only the bundle exists). */
export async function loadPackageStamp() {
  try {
    return readStamp(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
  } catch {
    return '';
  }
}

/**
 * A site that has a stamped `package.json` but no `.rwp-version` (it was updated by code that did not write one) records
 * the release itself, with no commit: on a host whose checkout is writable the file is written; everywhere else the
 * stamp is read directly every time, so nothing is lost. Never throws and never asks anyone for anything.
 *
 * @returns {Promise<{ version: string, wrote: boolean }>}
 */
export async function ensureVersionRecord({ stamp = null, env = globalThis.process?.env || {}, file = null } = {}) {
  const existing = file ? await readFile(file, 'utf8').then(readVersionRecord, () => '') : await loadVersionRecord();
  if (existing) return { version: existing, wrote: false };
  const version = stamp === null ? await loadPackageStamp() : String(stamp || '');
  if (!version || env.VERCEL) return { version, wrote: false };
  try {
    await writeFile(file || new URL(`../${VERSION_PATH}`, import.meta.url), `v${version}\n`, { flag: 'wx' });
    return { version, wrote: true };
  } catch {
    return { version, wrote: false };
  }
}

/** The record this build or checkout carries: the inlined text first, else the file beside the code. */
export async function loadVersionRecord() {
  const inlined = typeof __RWP_VERSION_RECORD__ === 'string' ? readVersionRecord(__RWP_VERSION_RECORD__) : '';
  if (inlined) return inlined;
  try {
    return readVersionRecord(await readFile(new URL(`../${VERSION_PATH}`, import.meta.url), 'utf8'));
  } catch {
    return '';
  }
}

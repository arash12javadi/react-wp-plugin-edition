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
import { readFile } from 'node:fs/promises';

export const VERSION_PATH = '.rwp-version';

/** The release version (no `v`) a `.rwp-version` text names, or '' when it is not a version. */
export function readVersionRecord(source) {
  const text = typeof source === 'string' ? source : source instanceof Uint8Array ? new TextDecoder().decode(source) : '';
  const first = text.split(/\r?\n/)[0].trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(first) ? first : '';
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

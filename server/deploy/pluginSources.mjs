/**
 * The plugin code a release does not carry.
 *
 * A customer-facing release repository (`react-wp-plugin-edition`) holds the core only: the plugins are kept
 * out of it on purpose, because the code that reaches a customer's Vercel project must be built and locked by
 * this platform first. Without them a build finds `server/plugins.mjs` importing folders that are not there,
 * `pruneMissingPluginImports()` drops those imports, and the site comes up with none of its plugins.
 *
 * This module is the other half: a directory on the platform that holds the plugin folders, read into the
 * release's source tree *before* it is built. The build then compiles them like any other source, the
 * allowlist in `prebuilt.mjs` keeps `plugins/` from ever being uploaded, and `obfuscateBuiltBundle()` locks
 * what the build produced.
 *
 * Where the directory is, in order:
 *   1. `RWP_PLUGIN_SOURCE_DIR` (absolute, or relative to the platform's working directory);
 *   2. `plugin-sources/` in the working directory.
 * A platform with neither deploys the release as it is, exactly as before; nothing is guessed.
 *
 * What is never read from it: the development-edition plugins (`isDevEditionPlugin`), whatever the folder
 * holds. They are the vendor's own tools and must not reach a customer even if someone copies them in.
 * What is never overwritten: a file the release already carries - the release wins, so a plugin the
 * repository does ship is not replaced by a different copy.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDevEditionPlugin } from '../../src/lib/pluginEdition.js';

const FOLDER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKIPPED_DIRECTORY = /^(?:node_modules|\.git|\.state|coverage)$/;
const MAX_FILES = 4000;
const MAX_BYTES = 40 * 1024 * 1024;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The directory plugin code is read from, or `''` when this platform keeps none. */
export async function pluginSourceDirectory(env = process.env || {}, cwd = process.cwd()) {
  const named = str(env.RWP_PLUGIN_SOURCE_DIR);
  const candidates = named ? [path.resolve(cwd, named)] : [path.join(cwd, 'plugin-sources')];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) return candidate;
  }
  return '';
}

async function readTree(root, relative, into, budget) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORY.test(entry.name)) await readTree(root, next, into, budget);
    } else if (entry.isFile()) {
      const bytes = await readFile(path.join(root, next));
      budget.files += 1;
      budget.bytes += bytes.length;
      if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) {
        throw new Error(`The plugin source directory is larger than a deployment accepts (${MAX_FILES} files, ${MAX_BYTES / 1024 / 1024} MB).`);
      }
      into.set(next, bytes);
    }
  }
}

/**
 * Adds the plugin folders under the source directory to `source` (a `Map<path, Buffer>`), in place.
 *
 * @param {Map<string, Buffer>} source the release's tree
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, log?: (line: string) => void }} [options]
 * @returns {Promise<{ directory: string, added: string[], skipped: string[] }>}
 */
export async function mergePluginSources(source, { env = process.env || {}, cwd = process.cwd(), log = () => {} } = {}) {
  const directory = await pluginSourceDirectory(env, cwd);
  const result = { directory, added: [], skipped: [] };
  if (!directory) return result;

  const folders = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && FOLDER_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const budget = { files: 0, bytes: 0 };
  for (const folder of folders) {
    if (isDevEditionPlugin(folder)) {
      result.skipped.push(folder);
      continue;
    }
    const files = new Map();
    await readTree(directory, folder, files, budget);
    if (!files.has(`${folder}/manifest.json`)) {
      result.skipped.push(folder);
      log(`plugin source ${folder} skipped: it has no manifest.json`);
      continue;
    }
    for (const [name, bytes] of files) {
      const target = `plugins/${name}`;
      if (!source.has(target)) source.set(target, bytes);
    }
    result.added.push(folder);
  }
  if (result.added.length) log(`added plugin source from ${path.basename(directory)}/: ${result.added.join(', ')}`);
  return result;
}

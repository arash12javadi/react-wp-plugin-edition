/**
 * `npm run check:plugins` - the licensing and edition policy, checked against the folders on disk.
 *
 * Two business rules, both declared in code and both easy to break by adding or renaming a plugin:
 *
 *   1. Exactly four plugins are sold and enforce a license gate - `rwp-page-builder`, `rwp-shop`,
 *      `rwp-chat`, `rwp-code-snippets` (`COMMERCIAL_PLUGIN_ADDONS` in `src/lib/pluginLicense.js`).
 *      Every other plugin is free and can never be locked.
 *   2. Exactly two plugins belong to the development edition and never ship to a customer -
 *      `rwp-ai-factory`, `rwp-saas-installer` (`DEV_EDITION_PLUGINS` in `src/lib/pluginEdition.js`),
 *      each marked `export-ignore` so no archive of this repository carries them.
 *   3. A sold plugin listed under a different catalogue slug - `rwp-chat` as
 *      `rwp-chat-ai-assistant` - is bridged by `MARKETPLACE_PLUGIN_SLUGS`, and the bridge has to land on
 *      the addon that plugin itself verifies.
 *
 * The declarations are the policy; this script is what keeps them true. It reads `plugins/` and
 * `.gitattributes` and fails with a sentence per disagreement, because the failure mode is silent: a
 * plugin folder whose id drifts from the map is simply *never gated*, and a dev-edition folder missing
 * its `export-ignore` line ships to every customer without anything looking wrong.
 *
 * Read-only and offline: no database, no network, no build. Run it before a release.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_PLUGIN_ADDONS, MARKETPLACE_PLUGIN_SLUGS, isCommercialPlugin, pluginLicenseAddon,
} from '../src/lib/pluginLicense.js';
import { marketplaceAddonFor } from '../server/pluginLicense.mjs';
import { DEV_EDITION_PLUGINS, isDevEditionPlugin, pluginEdition } from '../src/lib/pluginEdition.js';

/**
 * The commercial set, written out again on purpose.
 *
 * Comparing the map with a copy of itself would pass whatever the map said; this is the business rule
 * as a reviewer reads it. Changing either side without the other is exactly the edit this check exists
 * to stop.
 */
const EXPECTED_COMMERCIAL = [
  ['rwp-page-builder', 'PAGE-BUILDER'],
  ['rwp-shop', 'SHOP'],
  ['rwp-chat', 'CHAT'],
  ['rwp-code-snippets', 'CODE-SNIPPETS'],
];

/** The development-edition set, likewise fixed here. */
const EXPECTED_DEV = ['rwp-ai-factory', 'rwp-saas-installer', 'rwp-plugin-marketplace'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = path.join(root, 'plugins');

const problems = [];
const fail = (message) => problems.push(message);

const exists = async (file) => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Every folder in `plugins/` that carries a `manifest.json`, with the manifest loaded. */
async function readPlugins() {
  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(pluginsRoot, entry.name);
    const manifestFile = path.join(folder, 'manifest.json');
    if (!(await exists(manifestFile))) {
      fail(`plugins/${entry.name} has no manifest.json, so it is not a plugin the site can name.`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch (error) {
      fail(`plugins/${entry.name}/manifest.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const serverFile = path.join(folder, 'server.mjs');
    plugins.push({
      folder: entry.name,
      manifest,
      server: (await exists(serverFile)) ? await readFile(serverFile, 'utf8') : '',
    });
  }
  return plugins;
}

const plugins = await readPlugins();
const ids = plugins.map((plugin) => plugin.folder);

// ---- Rule 1: the commercial set ---------------------------------------------------------------

const declared = Object.entries(COMMERCIAL_PLUGIN_ADDONS);
if (!sameSet(declared.map(([id]) => id), EXPECTED_COMMERCIAL.map(([id]) => id))) {
  fail(`COMMERCIAL_PLUGIN_ADDONS lists ${declared.map(([id]) => id).join(', ') || 'nothing'}; the business rule is ${EXPECTED_COMMERCIAL.map(([id]) => id).join(', ')}.`);
}
for (const [expectedId, expectedAddon] of EXPECTED_COMMERCIAL) {
  const addon = COMMERCIAL_PLUGIN_ADDONS[expectedId];
  if (addon !== expectedAddon) {
    fail(`COMMERCIAL_PLUGIN_ADDONS maps ${expectedId} to ${addon ?? '(nothing)'}; keys are issued as ${expectedAddon}-*, so it must be ${expectedAddon}.`);
  }
  // The addon must be what `pluginLicenseAddon` derives, or `mint --plugin <id>` would issue a key the
  // plugin's own gate rejects - a customer paying for a key that never verifies.
  const derived = pluginLicenseAddon(expectedId);
  if (addon !== derived) {
    fail(`COMMERCIAL_PLUGIN_ADDONS gives ${expectedId} the addon ${addon}, but a key minted for that id carries ${derived}.`);
  }
  if (!ids.includes(expectedId)) {
    fail(`${expectedId} is sold, but there is no folder plugins/${expectedId}.`);
    continue;
  }
  const plugin = plugins.find((item) => item.folder === expectedId);
  if (plugin.manifest?.id !== expectedId) {
    fail(`plugins/${expectedId}/manifest.json declares the id "${plugin.manifest?.id ?? ''}"; the folder and the id have to match or the gate never finds the plugin.`);
  }
  // The gate lives on the plugin's server routes: without a server module there is nothing to hold
  // back, and a "commercial" plugin would be free in practice while looking locked on the screen.
  if (!plugin.server) {
    fail(`${expectedId} is sold, but it has no server.mjs, so it has no route to gate. Remove it from COMMERCIAL_PLUGIN_ADDONS or give it a server module.`);
  }
}

// ---- Rule 2: everything else is free ----------------------------------------------------------

for (const plugin of plugins) {
  const id = plugin.folder;
  if (isCommercialPlugin(id)) {
    if (isDevEditionPlugin(id)) {
      fail(`${id} is both commercial and development-edition-only. A plugin that never ships has nothing to sell.`);
    }
    continue;
  }
  // Free means free: nothing in the plugin may ask for a key, and the old opt-in flag is gone from the
  // codebase. A leftover `license` declaration reads like the plugin can lock itself - the map is the
  // only place a requirement comes from - so it is a failure, not a comment.
  if (/(^|[\s,{])license\s*:/.test(plugin.server)) {
    fail(`plugins/${id}/server.mjs still declares \`license\`; licensing is decided by COMMERCIAL_PLUGIN_ADDONS, and ${id} is free. Delete the declaration.`);
  }
}

// ---- Rule 3: a catalogue slug that names another plugin -----------------------------------------

// A marketplace listing is signed for the addon its *plugin* will verify, which means the listing's
// slug has to resolve to a plugin folder. `rwp-chat-ai-assistant` is listed under its marketing name but
// the gate on a site asks for `CHAT`, so `MARKETPLACE_PLUGIN_SLUGS` carries that bridge. Each entry is
// checked from both ends: the target must be a sold plugin *and* a folder on disk, and the addon the
// marketplace would sign must be the one the plugin derives for itself - otherwise an admin grants a
// licence whose key the plugin rejects, which looks like success in the table.
for (const [slug, target] of Object.entries(MARKETPLACE_PLUGIN_SLUGS)) {
  if (slug === target) {
    fail(`MARKETPLACE_PLUGIN_SLUGS maps ${slug} to itself. An identity alias reads like a fix while changing nothing; delete the entry.`);
    continue;
  }
  if (!Object.hasOwn(COMMERCIAL_PLUGIN_ADDONS, target)) {
    fail(`MARKETPLACE_PLUGIN_SLUGS maps the catalogue slug ${slug} to ${target}, which is not a sold plugin. A licence for that listing would be signed for an addon no plugin verifies.`);
    continue;
  }
  if (!ids.includes(target)) {
    fail(`MARKETPLACE_PLUGIN_SLUGS maps the catalogue slug ${slug} to ${target}, but there is no folder plugins/${target}.`);
    continue;
  }
  const signed = marketplaceAddonFor(slug);
  const expected = pluginLicenseAddon(target);
  if (signed !== expected) {
    fail(`A licence for the catalogue slug ${slug} is signed as ${signed || '(an opaque token)'}, but plugins/${target} verifies ${expected}. The key would be refused by the plugin.`);
  }
  if (COMMERCIAL_PLUGIN_ADDONS[target] !== expected) {
    fail(`COMMERCIAL_PLUGIN_ADDONS gives ${target} the addon ${COMMERCIAL_PLUGIN_ADDONS[target]}, but its own gate asks for ${expected}.`);
  }
}

// ---- Rule 4: the development-edition set ------------------------------------------------------

if (!sameSet(DEV_EDITION_PLUGINS, EXPECTED_DEV)) {
  fail(`DEV_EDITION_PLUGINS lists ${DEV_EDITION_PLUGINS.join(', ') || 'nothing'}; the business rule is ${EXPECTED_DEV.join(', ')}.`);
}
const gitattributes = await readFile(path.join(root, '.gitattributes'), 'utf8');
for (const id of EXPECTED_DEV) {
  if (!DEV_EDITION_PLUGINS.includes(id)) {
    fail(`${id} is development-edition-only, but DEV_EDITION_PLUGINS does not list it.`);
    continue;
  }
  if (!ids.includes(id)) {
    fail(`${id} is development-edition-only, but there is no folder plugins/${id}.`);
    continue;
  }
  const plugin = plugins.find((item) => item.folder === id);
  if (plugin.manifest?.edition !== 'dev') {
    fail(`plugins/${id}/manifest.json should say "edition": "dev"; it says ${JSON.stringify(plugin.manifest?.edition ?? null)}.`);
  }
  if (pluginEdition(id) !== 'dev') {
    fail(`${id} is listed as development-edition-only but pluginEdition() answers "${pluginEdition(id)}".`);
  }
  if (!new RegExp(`^\\s*plugins/${id}\\s+export-ignore\\s*$`, 'm').test(gitattributes)) {
    fail(`.gitattributes does not mark plugins/${id} export-ignore, so \`git archive\` would ship it to customers.`);
  }
}
for (const plugin of plugins) {
  const id = plugin.folder;
  if (isDevEditionPlugin(id)) continue;
  if (plugin.manifest?.edition === 'dev') {
    fail(`plugins/${id}/manifest.json claims "edition": "dev", but it is not in DEV_EDITION_PLUGINS - the list decides, so the manifest is misleading.`);
  }
}

// ---- Report -----------------------------------------------------------------------------------

const pad = (value, width) => value.padEnd(width);
const rows = plugins
  .map((plugin) => ({
    id: plugin.folder,
    name: plugin.manifest?.name ?? '',
    edition: pluginEdition(plugin.folder),
    license: COMMERCIAL_PLUGIN_ADDONS[plugin.folder] ? `key ${COMMERCIAL_PLUGIN_ADDONS[plugin.folder]}` : 'free',
  }))
  .sort((a, b) => a.edition.localeCompare(b.edition) || a.id.localeCompare(b.id));

const idWidth = Math.max(4, ...rows.map((row) => row.id.length));
const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
const editionWidth = Math.max(7, ...rows.map((row) => row.edition.length));
console.log(`${pad('plugin', idWidth)}  ${pad('name', nameWidth)}  ${pad('edition', editionWidth)}  license`);
console.log(`${'-'.repeat(idWidth)}  ${'-'.repeat(nameWidth)}  ${'-'.repeat(editionWidth)}  ${'-'.repeat(12)}`);
for (const row of rows) {
  console.log(`${pad(row.id, idWidth)}  ${pad(row.name, nameWidth)}  ${pad(row.edition, editionWidth)}  ${row.license}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s) with the plugin licensing and edition rules:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nLicensing and edition rules hold: four commercial plugins, everything else free, every development-edition plugin kept out of every archive.');
}


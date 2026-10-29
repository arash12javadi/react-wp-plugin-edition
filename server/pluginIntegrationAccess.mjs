/**
 * Which `system_settings` rows a plugin may read, and the only way it may read them.
 *
 * A plugin's server module is not sandboxed: `handlePluginRequest` (`server/plugins.mjs`) hands it the
 * service key, so a `readIntegrationRows([...])` called from a plugin route reads whatever the table
 * holds — the rows other cards own, and the credential rows an administrator pasted to connect this
 * site's GitHub account, its AI provider, its media bucket and its deploy hook. A plugin that needs a
 * row therefore does not name a key on its own: it is granted the rows it consumes under its id in
 * `PLUGIN_INTEGRATION_KEYS` below, and asks for them through `readPluginIntegrationRows`. The grant is
 * one reviewable line per plugin, in this file, rather than an argument buried in a route module — and
 * a key outside the grant is refused instead of read, so a plugin granted `github_config` cannot also
 * quietly read `ai_config` or `media_storage_config`.
 *
 * Plain ESM for the reason `integrationConfig.mjs` is: `plugins/<id>/server.mjs` runs as it is under
 * `npm start` and cannot import TypeScript, while the universal engine (`src/server/pluginHostAccess.ts`)
 * imports this policy as well. One declaration, both hosts, and the plugin authors' rule in
 * `plugins/README.md` § "Reading the site's settings".
 */
import { DEPLOY_CONFIG_KEY, GITHUB_CONFIG_KEY, SAAS_INSTALLER_CONFIG_KEY } from './integrationConfig.mjs';
import { readIntegrationRows } from './integrationSettings.mjs';

/**
 * The rows each plugin may read, by plugin id. Adding a plugin here is a deliberate grant, reviewed
 * like any other capability: `rwp-saas-installer` provisions sites from the template repository, so it
 * reads the repository and branch an administrator saved (`saas_installer_config`) and the one GitHub
 * credential the GitHub card stores (`github_config`) — the same pair its own card writes. It also reads
 * the deploy hook (`deploy_config`) because the platform owner's "Test deploy hook" button is one of its
 * routes: the hook is what a plugin upload spends, and the card that saves it now lives in the same
 * plugin. A plugin absent from this map may read nothing, which is the answer for a plugin whose needs
 * are its own tables rather than this site's connections.
 */
export const PLUGIN_INTEGRATION_KEYS = Object.freeze({
  'rwp-saas-installer': Object.freeze([SAAS_INSTALLER_CONFIG_KEY, GITHUB_CONFIG_KEY, DEPLOY_CONFIG_KEY]),
});

/** The rows `pluginId` declared, or none. Never the whole table. */
export const pluginIntegrationKeys = (pluginId) =>
  PLUGIN_INTEGRATION_KEYS[String(pluginId ?? '')] || [];

/**
 * The keys in `requested` that this plugin did not declare — empty when the request may go ahead.
 * Compared as a set, so asking for a declared key twice is not an escalation, and an unknown plugin
 * fails on its first key rather than on all of them.
 */
export const undeclaredIntegrationKeys = (pluginId, requested) => {
  const declared = new Set(pluginIntegrationKeys(pluginId));
  return [...new Set((Array.isArray(requested) ? requested : []).map(String))]
    .filter((key) => !declared.has(key));
};

/** The sentence a refused read carries. It names the plugin, the row and where the grant lives. */
export const undeclaredKeyRefusal = (pluginId, keys) =>
  `The plugin "${String(pluginId ?? '')}" may not read ${keys.map((key) => `system_settings.${key}`).join(', ')}: `
  + 'a plugin route reads only the rows it declares in PLUGIN_INTEGRATION_KEYS (server/pluginIntegrationAccess.mjs).';

/**
 * `readIntegrationRows` for a plugin route: the same options and the same result, with the key list
 * checked against the plugin's declaration first.
 *
 * A refusal answers in the shape the caller already handles — `readable: false` and a sentence, which
 * is exactly how a row this server cannot read is reported — rather than throwing. The site owner's
 * view of "this plugin asked for something it was not granted" is then the same warning it shows for
 * an unreadable table, and a route cannot turn a refusal into a 500 by forgetting a try/catch. The
 * reason is logged where an administrator running `npm start` will see it.
 *
 * @param {string} pluginId                  the plugin's id, as registered in `server/plugins.mjs`
 * @param {string[]} requested               the `system_settings` keys the route wants
 * @param {object} [options]                 the `readIntegrationRows` options, unchanged
 * @returns {Promise<{settings: Record<string, unknown>, readable: boolean, source: string, error: string}>}
 */
export async function readPluginIntegrationRows(pluginId, requested, options = {}) {
  const keys = [...new Set((Array.isArray(requested) ? requested : []).map(String))];
  const undeclared = undeclaredIntegrationKeys(pluginId, keys);
  if (undeclared.length > 0) {
    console.error('[PLUGIN_INTEGRATION_REFUSED]', { pluginId: String(pluginId ?? ''), keys: undeclared });
    return {
      settings: {},
      readable: false,
      source: 'unavailable',
      error: undeclaredKeyRefusal(pluginId, undeclared),
    };
  }
  // Nothing to ask for: an empty read is not a failed one, so no query is opened for it.
  if (keys.length === 0) return { settings: {}, readable: true, source: 'unavailable', error: '' };
  return readIntegrationRows(keys, options);
}

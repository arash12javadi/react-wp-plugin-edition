/**
 * Server-side plugin routes, served at /api/plugins/<plugin-id>/<route>.
 *
 * Plugins are imported by literal path rather than discovered with readdir: Vercel bundles a
 * function by tracing its imports, so a module found at runtime (and its npm dependencies)
 * would be missing from the deployment. There is one import per plugin that ships a server.mjs.
 * The imports are dynamic so a plugin folder deleted from the Plugins screen does not stop
 * the server from starting; any other load error is still logged.
 *
 * The lines between the rwp:server-plugin-imports markers are rewritten by the plugin
 * uploader and Delete (server/serverPluginImports.mjs). Keep exactly one
 * import('../plugins/<folder>/server.mjs'), per line there, or those actions refuse to edit.
 *
 * A plugin server module default-exports { id, routes }, where routes maps
 * "METHOD path" (e.g. "POST stripe/session") to async (context) => response.
 * A response is { status, body } (body is sent as JSON), { status, redirect },
 * or { status, text, headers }.
 *
 * The context also carries `aiConfig()`, the AI row saved on Settings → Integrations → AI
 * (`server/integrationAi.mjs` reads it), so a plugin that generates text never has to know how this
 * server reaches `system_settings` — and a site's key lives in the database rather than in an
 * environment variable. It is a function, not a value: a route that does not call it (a form
 * submission, a webhook) pays nothing for it.
 *
 * Commercial plugins are gated here, and only here. The list is `COMMERCIAL_PLUGIN_ADDONS` in
 * `src/lib/pluginLicense.js` - `rwp-page-builder`, `rwp-shop`, `rwp-chat` and `rwp-code-snippets` - and
 * each of them answers 402 to every route until the key stored for it in the `rwp_plugin_licenses`
 * option verifies. Everything else - the setup wizard, site provisioning, and every plugin that is not
 * on that list - is untouched, and a plugin cannot join the list by declaring anything itself.
 * The activation check below is license-aware too (`licensedActivePluginIds`): one of the four with no
 * verified key is inactive even when `rwp_active_plugins` still lists it, because "Active" is a state a
 * site either may be in or may not. `GET <plugin-id>/license` reports the state (never the key) for
 * every plugin, so the Plugins screen can tell a free plugin (`required: false`) from a locked one; a
 * plugin that declares that route itself keeps it.
 *
 * The development-edition plugins (`rwp-ai-factory`, `rwp-saas-installer` and `rwp-plugin-marketplace`,
 * listed in `src/lib/pluginEdition.js`) are not registered at all when this is built as a public site
 * (`RWP_EDITION=public`), so their routes answer 404 there whatever is in `plugins/`.
 */
import { readAiConfig } from './integrationAi.mjs';
import { currentEdition, editionKeepsPlugin } from '../src/lib/pluginEdition.js';
import {
  PLUGIN_LICENSES_OPTION, PLUGIN_LICENSE_SHOP_URL, defaultActivePluginIds, licensedActivePluginIds,
  pluginLicenseAddonFor, pluginLicenseGate, pluginLicenseState, readPluginLicenses,
} from './pluginLicense.mjs';

const loaded = await Promise.allSettled([
  // rwp:server-plugin-imports:start
  import('../plugins/rwp-code-snippets/server.mjs'),
  import('../plugins/rwp-chat/server.mjs'),
  import('../plugins/rwp-saas-installer/server.mjs'),
  import('../plugins/rwp-page-builder/server.mjs'),
  import('../plugins/rwp-shop/server.mjs'),
  import('../plugins/rwp-plugin-marketplace/server.mjs'),
  // rwp:server-plugin-imports:end
]);

const bundledPlugins = loaded.flatMap((result) => {
  if (result.status === 'fulfilled') return [result.value.default];
  // A deleted plugin folder is expected; anything else is a real error in the plugin.
  const folderDeleted = result.reason?.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find module .*server\.mjs'/.test(String(result.reason?.message));
  if (!folderDeleted) console.error('A plugin server module failed to load:', result.reason);
  return [];
});

/**
 * The plugins this deployment serves.
 *
 * The two development-edition plugins (`src/lib/pluginEdition.js`) are dropped on a public build rather
 * than merely hidden in the UI: their import stays above so the development edition keeps them, but a
 * site deployed with `RWP_EDITION=public` answers 404 for every one of their routes - including the
 * installer's provisioning endpoint - even if the folder was copied into `plugins/` by hand. The log
 * line is for the person who did that, who would otherwise see a 404 and look for a routing bug.
 */
const edition = currentEdition();
const serverPlugins = bundledPlugins.filter((plugin) => {
  if (editionKeepsPlugin(plugin.id, edition)) return true;
  console.warn(`[plugin-edition] ${plugin.id} is a development-edition plugin and is not served by a ${edition} deployment.`);
  return false;
});

/**
 * The options a plugin request depends on, read together and cached for half a minute.
 *
 * `active: null` means the option is absent, which App.tsx reads as "every free plugin is active and
 * none of the sold ones is" (`defaultActivePluginIds`), so the four commercial plugins are off until
 * somebody activates them; when the option is present, `licensedActivePluginIds` drops any sold plugin
 * whose key does not verify, so "active" here is always a state the site is allowed to be in.
 * `licenses: null` means the license option could not be read at all, which the gate treats as
 * "unknown" rather than as "nothing licensed" - see pluginLicenseGate().
 */
const optionCache = { at: 0, active: null, licenses: null };
const OPTION_CACHE_MS = 30_000;

/**
 * Mirrors App.tsx: a missing rwp_active_plugins option means every free plugin is active and the four
 * sold ones are not (`defaultActivePluginIds`).
 *
 * `fresh` re-reads both options instead of trusting the cache. `GET <plugin>/license` asks for a fresh
 * read so an administrator who has just saved a key sees the truth immediately, and that read also
 * refreshes the cache the gate uses, so activating the plugin right afterwards is not refused by a
 * copy of the option that is 30 seconds old.
 */
async function readPluginOptions(supabaseUrl, supabaseKey, { fresh = false } = {}) {
  if (!fresh && Date.now() - optionCache.at < OPTION_CACHE_MS) return optionCache;
  const base = supabaseUrl.replace(/\/$/, '');
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const read = async (name) => {
    const response = await fetch(`${base}/rest/v1/options?option_name=eq.${name}&select=option_value`, { headers });
    if (!response.ok) throw new Error(`Could not read the ${name} option (HTTP ${response.status}).`);
    const [row] = await response.json();
    if (!row) return null;
    try {
      return JSON.parse(row.option_value);
    } catch {
      return null;
    }
  };
  // The activation option decides whether a plugin answers at all, so failing to read it is an error.
  // The license option only decides whether a *commercial* plugin answers: taking a working shop down
  // because the key store hiccuped would be worse than honouring what is already known, so that
  // failure is logged and the previous answer (or "unknown") is kept.
  const [active, licenses] = await Promise.all([
    read('rwp_active_plugins'),
    read(PLUGIN_LICENSES_OPTION).catch((error) => {
      console.error('The plugin license option could not be read:', error);
      return undefined;
    }),
  ]);
  optionCache.at = Date.now();
  optionCache.active = Array.isArray(active) ? active : null;
  if (licenses !== undefined) optionCache.licenses = readPluginLicenses(licenses);
  return optionCache;
}

const matchRoute = (routes, method, path) => {
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(' ');
    if (routeMethod !== method) continue;
    const patternParts = routePath.split('/').filter(Boolean);
    const pathParts = path.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    const matches = patternParts.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(pathParts[index]);
        return true;
      }
      return part === pathParts[index];
    });
    if (matches) return { handler, params };
  }
  return null;
};

/**
 * @param {object} request
 * @param {string} request.method
 * @param {string} request.path        Everything after /api/plugins/
 * @param {Record<string,string>} request.query
 * @param {Record<string,string|string[]|undefined>} request.headers  Lower-case names.
 * @param {Buffer} request.rawBody
 * @param {{ url: string, publishableKey: string }} request.supabase
 * @param {string} request.origin      Public origin of the site, e.g. https://shop.example.com
 * @returns {Promise<{status:number, body?:unknown, redirect?:string, text?:string, headers?:Record<string,string>}>}
 */
export async function handlePluginRequest(request) {
  const [pluginId, ...rest] = request.path.split('/').filter(Boolean);
  const plugin = serverPlugins.find((item) => item.id === pluginId);
  const routePath = rest.join('/');

  // A plugin's `cors` list names the few routes a *different site's browser* is meant to call directly
  // (a buyer's own site reading its license against the marketplace, for example) - everything else on
  // every plugin stays same-origin, which is the default a browser already enforces. Only an anon-safe,
  // credential-less route (the caller's proof is a value in the body, not a cookie) belongs on that
  // list: CORS controls who may *read the response*, not who may make the request, so it must never be
  // added to a route a signed-in session alone protects. Handled before any other check - including
  // whether the plugin exists - because a browser sends the preflight with no route-specific context.
  const corsRoute = plugin?.cors?.find((entry) => entry.endsWith(` ${routePath}`));
  if (request.method === 'OPTIONS') {
    if (!corsRoute) return { status: 404, body: {} };
    return {
      status: 204,
      body: {},
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': corsRoute.split(' ')[0],
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    };
  }
  const withCors = (result) => (corsRoute && corsRoute.startsWith(`${request.method} `)
    ? { ...result, headers: { ...result.headers, 'Access-Control-Allow-Origin': '*' } }
    : result);

  if (!plugin) return withCors({ status: 404, body: { error: `No server plugin is registered with the id "${pluginId}".` } });
  if (!request.supabase?.url || !request.supabase?.publishableKey) {
    return withCors({ status: 501, body: { error: 'This site is not installed, so plugin endpoints are unavailable.' } });
  }

  return withCors(await routeWithinPlugin({ request, plugin, routePath }));
}

/** Everything past the plugin/installed checks, pulled out so every exit point passes through `withCors`. */
async function routeWithinPlugin({ request, plugin, routePath }) {
  const addon = pluginLicenseAddonFor(plugin);
  const readOptions = (options) => readPluginOptions(request.supabase.url, request.supabase.publishableKey, options);

  // The license report, for the Plugins screen. It is host-owned, read-only, public and safe to cache
  // nowhere: it says whether this plugin needs a key and whether the stored one still holds, and never
  // returns a key. It is answered before the activation and license checks on purpose - an inactive or
  // locked plugin is exactly when the screen needs to say why - and `fresh` refreshes the cache the
  // gate reads, so a key saved a second ago is already in force for the next request.
  //
  // Every plugin answers here, not only a commercial one: `required: false` is how the screen learns a
  // plugin is free, which is the common case and the one that must never look locked. A plugin that
  // declares `GET license` itself keeps it - the host only claims the path when nothing else does.
  const pluginOwnsLicenseRoute = Boolean(plugin.routes?.['GET license'])
    || Boolean(matchRoute(plugin.routes || {}, 'GET', 'license'));
  if (request.method === 'GET' && routePath === 'license' && !pluginOwnsLicenseRoute) {
    if (!addon) {
      return {
        status: 200,
        body: {
          success: true,
          required: false,
          licensed: true,
          status: 'free',
          addon: '',
          pluginId: plugin.id,
          message: `${plugin.id} is free: it needs no license key.`,
        },
      };
    }
    const licenseOptions = await readOptions({ fresh: true });
    if (licenseOptions.licenses === null) {
      return {
        status: 200,
        body: {
          success: true,
          required: true,
          licensed: false,
          status: 'unknown',
          addon,
          pluginId: plugin.id,
          message: `The stored license keys could not be read, so ${plugin.id} keeps answering as it did. Reload this screen in a moment.`,
        },
      };
    }
    const state = pluginLicenseState({ pluginId: plugin.id, key: licenseOptions.licenses[plugin.id], addon });
    return { status: 200, body: { success: true, required: true, ...state } };
  }

  const options = await readOptions();
  // A sold plugin whose key does not verify is inactive here even when `rwp_active_plugins` still lists
  // it: the state is forced rather than merely refused, so no route of an unlicensed plugin can run and
  // the answer is the same one an administrator sees on the Plugins screen, which writes the correction
  // back (it has the administrator's own token; this server holds the publishable key and may not).
  // Nothing chosen yet: the free plugins answer and the four sold ones do not, so a site handed out
  // by the installer never runs a plugin nobody licensed. Activating one writes the option.
  const activeIds = licensedActivePluginIds(
    options.active ?? defaultActivePluginIds(serverPlugins.map((item) => item.id)),
    options.licenses,
  );

  // A commercial plugin answers nothing until its key verifies. 402 rather than 403: the request is
  // well formed and nothing is forbidden - what is missing is this site's right to use the plugin. The
  // body carries the same sentence the Plugins screen shows, so a plugin's own UI can display it, plus
  // a `code` a client can branch on without matching prose, and the address a key comes from. Asked
  // before the activation check because "this site has no key" is the more useful answer for one of the
  // four, and because it is the same verdict that emptied `activeIds` above.
  const gate = pluginLicenseGate({ plugin, licenses: options.licenses });
  if (gate && !gate.licensed) {
    return {
      status: 402,
      body: {
        error: gate.message,
        code: 'license_required',
        plugin: plugin.id,
        addon: gate.addon,
        license: gate,
        shop: PLUGIN_LICENSE_SHOP_URL,
      },
    };
  }

  if (!activeIds.includes(plugin.id)) {
    return { status: 404, body: { error: `The plugin "${plugin.id}" is not active. Activate it under Plugins.` } };
  }

  const route = matchRoute(plugin.routes, request.method, routePath);
  if (!route) return { status: 404, body: { error: `${plugin.id} has no route ${request.method} ${routePath}.` } };

  let parsed;
  const json = () => {
    if (parsed !== undefined) return parsed;
    const text = request.rawBody?.length ? request.rawBody.toString('utf8') : '';
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error('The request body is not valid JSON.'), { status: 400 });
    }
    return parsed;
  };

  try {
    return await route.handler({
      ...request,
      params: route.params,
      json,
      supabase: { ...request.supabase, secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '' },
      bearerToken: String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''),
      // Read per call rather than cached: an administrator who saves a key on the AI card expects the
      // very next Generate to use it, and only the routes that actually generate ever call this.
      aiConfig: () => readAiConfig({
        supabaseUrl: request.supabase.url,
        supabaseKey: request.supabase.publishableKey,
        env: process.env,
      }),
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return { status, body: { error: error instanceof Error ? error.message : 'Unknown plugin error.' } };
  }
}

/** Public origin for building absolute return URLs (payment redirects, email links). */
export function resolveOrigin(headers) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(headers['x-forwarded-host'] || headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

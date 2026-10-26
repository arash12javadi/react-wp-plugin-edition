/**
 * Plugin licenses: the shape of a key, the option that holds them, and how a key names the plugin it
 * unlocks. The *verification* lives in `server/pluginLicense.mjs`, which has the secret.
 *
 * Plain JavaScript, not TypeScript, for the same reason `src/lib/mediaScope.js` is plain: the browser
 * bundle, `server/plugins.mjs` (self-hosted) and `api/plugins.ts` (Vercel) all import this file, and
 * each has a different build step. Nothing here may touch `node:crypto` or `process`, because this
 * file ships to the browser.
 *
 * A plugin license is deliberately the same format `plugins/rwp-saas-installer/license.mjs` mints,
 * scoped to one plugin instead of one site, so there is one thing to learn and one thing to paste:
 *
 *     RWP1-SHOP-20270630-4K7QM2XZ8B
 *     ^^^^ ^^^^ ^^^^^^^^ ^^^^^^^^^^
 *     |    |    |        signature: 10 characters of Crockford base32 (no I, L, O or U)
 *     |    |    last valid day, inclusive, in UTC
 *     |    the plugin it unlocks: "SHOP" for plugins/rwp-shop
 *     version of the key format
 *
 * What this file answers is "is this shaped like a key, which plugin does it name, and when does it
 * expire?" - enough for a settings screen to refuse an obvious typo before a round trip, and for the
 * server to know which stored key belongs to the plugin it is about to serve. Whether a key is
 * *genuine* is only ever answered on the server, because the signing secret must never reach a
 * browser.
 *
 * Which plugins need a key at all is answered here too, by `COMMERCIAL_PLUGIN_ADDONS` below: four sold
 * plugins, and every other plugin free - see that map before changing anything about licensing.
 */

/**
 * The option every plugin key is stored in, in `public.options`:
 *
 *     { "rwp-shop": "RWP1-SHOP-20270630-4K7QM2XZ8B" }
 *
 * One row rather than one row per plugin, so saving a key is the same single write the activation
 * option already makes, and reading every key is one request rather than one per plugin.
 */
export const PLUGIN_LICENSES_OPTION = 'rwp_plugin_licenses';

/** Version of the key format, so a future one is told apart rather than rejected as junk. */
export const PLUGIN_LICENSE_PREFIX = 'RWP1';

/**
 * Where a key is bought.
 *
 * One constant, because it is said in three places that must not disagree: the Plugins screen beside a
 * locked plugin, the sentence a plugin's own 402 carries, and the "no key stored" verdict the license
 * route returns. It points at the plugins page, not the shop's cart: a customer arriving from a locked
 * plugin wants to read what the plugin does and pick the one they need, and the shop is one click from
 * there. A browser-side constant is enough - nothing here is a secret or per-site.
 */
export const PLUGIN_LICENSE_SHOP_URL = 'https://react-wp.com/plugins';

/**
 * The plugins that are sold, and the addon code each one's key carries.
 *
 * This map *is* the licensing policy, and it is deliberately the only place the policy lives. A plugin
 * id in it is **commercial**: every server route of that plugin answers 402 until a key naming its
 * addon verifies. A plugin id that is not in it is **free**: no stored key, no option value and
 * nothing an uploaded plugin ships can lock it, because the requirement is never read from the plugin
 * itself.
 *
 * Why a central list rather than a `license: true` flag in each plugin's `server.mjs`: the flag made
 * licensing opt-in for anything that could write a server module - including a plugin uploaded as a
 * ZIP - and left the actual commercial set implicit in six separate files. Here it is one reviewable
 * answer to "what do we sell?", and `npm run check:plugins` fails the build if a folder is missing
 * from the list or if a free plugin tries to claim a key.
 *
 * The addon is the id with the `rwp-` prefix dropped (`pluginLicenseAddon` below), so `rwp-shop` is
 * keyed by `RWP1-SHOP-…` and `rwp-page-builder` by `RWP1-PAGE-BUILDER-…`. The signature covers the
 * addon, so a key cannot be re-scoped to another plugin by editing its text.
 */
export const COMMERCIAL_PLUGIN_ADDONS = Object.freeze({
  'rwp-page-builder': 'PAGE-BUILDER',
  'rwp-shop': 'SHOP',
  'rwp-chat': 'CHAT',
  'rwp-code-snippets': 'CODE-SNIPPETS',
});

/**
 * `RWP1-ADDON-YYYYMMDD-SIGNATURE`.
 *
 * The addon is what ties a key to a plugin, and the signature covers it, so a key minted for one
 * plugin cannot be moved to another by editing the text: it simply stops verifying.
 */
const PLUGIN_LICENSE_PATTERN = /^RWP1-([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)-(\d{8})-([0-9A-HJKMNP-TV-Z]{10})$/;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The addon code a plugin id maps to: `rwp-shop` -> `SHOP`, `my-plugin` -> `MY-PLUGIN`.
 *
 * A leading `rwp-`/`rwp_` is dropped because every bundled plugin carries it and repeating it in a key
 * would only make the key longer to read aloud. Anything else is upper-cased and its runs of
 * punctuation become one hyphen, so the result always matches the pattern above.
 */
export const pluginLicenseAddon = (pluginId) => str(pluginId)
  .toUpperCase()
  .replace(/^RWP[_-]/, '')
  .replace(/[^A-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * A key as it was meant to be written: no whitespace, upper case, and `.`/`_`/`:` read as hyphens.
 *
 * Anything else is left alone so a typo stays visible in the field being looked at, exactly as
 * `licenseKeyFrom` does for the installer.
 */
export const pluginLicenseKeyFrom = (value) => str(value)
  .replace(/\s+/g, '')
  .toUpperCase()
  .replace(/[._:]+/g, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^-+|-+$/g, '');

/** `YYYY-MM-DD` from the eight-digit stamp a key carries. */
const isoDate = (stamp) => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;

/** The UTC instant a stamp stops being valid: the end of that day, inclusive. */
const expiryInstant = (stamp) => new Date(Date.UTC(
  Number(stamp.slice(0, 4)),
  Number(stamp.slice(4, 6)) - 1,
  Number(stamp.slice(6, 8)),
  23, 59, 59, 999,
));

/**
 * What a key says about itself, or `null` when it is not shaped like one.
 *
 * The plugin id is not part of the answer: the caller knows which plugin it is asking about, and the
 * signature - which only the server checks - is what proves the key was minted for that plugin.
 */
export const pluginLicenseParts = (value) => {
  const key = pluginLicenseKeyFrom(value);
  const match = PLUGIN_LICENSE_PATTERN.exec(key);
  if (!match) return null;
  const [, addon, stamp, signature] = match;
  const ends = expiryInstant(stamp);
  return {
    key,
    addon,
    stamp,
    signature,
    expiresOn: isoDate(stamp),
    expiresAt: ends.toISOString(),
    daysLeft: Math.max(0, Math.ceil((ends.getTime() - Date.now()) / DAY_MS)),
  };
};

/** True when the value is shaped like a plugin key. It says nothing about whether it is genuine. */
export const isPluginLicenseKey = (value) => pluginLicenseParts(value) !== null;

/** A key as it may be shown in a table or a notice: enough to recognise, not to reuse. */
export const maskPluginLicense = (value) => {
  const parts = pluginLicenseParts(value);
  if (!parts) return str(value) ? `${str(value).slice(0, 4)}...` : '';
  return `${PLUGIN_LICENSE_PREFIX}-${parts.addon}-...-${parts.signature.slice(-3)}`;
};

/**
 * The stored option, as `{ [pluginId]: key }`.
 *
 * Accepts the JSON text straight out of the options row, or an already-parsed value, because the
 * browser reads it through the database adapter and the server reads it through PostgREST. Anything
 * that is not an object of keys is treated as "no keys stored", which is also what a site that has
 * never entered one has.
 */
export const readPluginLicenses = (value) => {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source || '{}');
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const licenses = {};
  for (const [pluginId, key] of Object.entries(source)) {
    const normalised = pluginLicenseKeyFrom(key);
    if (pluginId && normalised) licenses[pluginId] = normalised;
  }
  return licenses;
};

/**
 * The addon a plugin requires, or `''` when it is free.
 *
 * `plugin` is a plugin record (`{ id }` - a server module's default export, a row on the Plugins
 * screen) or a bare plugin id, so every caller can ask the question with whatever it already holds.
 * The answer comes from `COMMERCIAL_PLUGIN_ADDONS` and from nowhere else: a plugin that is not in that
 * map is free, which is what keeps a plugin from locking itself - or from unlocking itself - with a
 * flag it ships.
 */
export const pluginLicenseAddonFor = (plugin) => {
  const id = typeof plugin === 'string' ? plugin.trim() : str(plugin?.id);
  if (!id || !Object.hasOwn(COMMERCIAL_PLUGIN_ADDONS, id)) return '';
  return COMMERCIAL_PLUGIN_ADDONS[id];
};

/** True for the four sold plugins in `COMMERCIAL_PLUGIN_ADDONS`; false for everything else. */
export const isCommercialPlugin = (plugin) => pluginLicenseAddonFor(plugin) !== '';

/**
 * True when a plugin may not be active because its key has not verified.
 *
 * `licensed` is the host's own verdict - the `licensed` field of `GET <plugin>/license` - and anything
 * other than a literal `true` counts as unverified, including "no verdict yet" and "the host did not
 * answer". That strictness is the point: a sold plugin is inactive until a key checks out, so there is
 * no moment in which the Plugins screen could paint a green **Active** badge beside a **Locked** one.
 * Free plugins are never locked, which is why this reads `COMMERCIAL_PLUGIN_ADDONS` and never the
 * report alone - a host that answers nothing must not turn a free plugin into a locked one.
 *
 * One predicate for the places that decide what runs:
 *   - the Plugins screen, for the badge, the Activate button and the state it writes back;
 *   - `server/plugins.mjs`, through `licensedActivePluginIds()` in `server/pluginLicense.mjs`;
 *   - `App.tsx`, which refuses to run a sold plugin on a settled "no". It uses the same rule but reads
 *     "no answer" and `status: 'unknown'` as "keep the stored choice", because a published page must not
 *     lose a renderer to a request that failed - and the routes are still gated on the server, so a
 *     tolerated answer is never an unlocked one.
 */
export const pluginActivationLocked = (plugin, licensed) => isCommercialPlugin(plugin) && licensed !== true;

/**
 * The host's verdict on one plugin's license, or `null` when the host could not be asked.
 *
 * `null` is not "free": it is "no answer", and each caller decides what that means for the plugin in
 * front of it. The Plugins screen reads it as locked for a sold plugin (`pluginActivationLocked`),
 * because a plugin nobody verified may not be shown as active; `App.tsx` keeps the stored choice,
 * because a public page must not lose its renderer to a request that failed. The server still gates
 * every route of the four sold plugins either way, so no answer is never an unlock.
 *
 * `GET <plugin>/license` is host-owned and read-only (see `server/plugins.mjs`): it reports whether the
 * plugin needs a key and whether the stored one still holds, and never returns a key.
 */
export const fetchPluginLicenseReport = async (pluginId) => {
  try {
    const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/license`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.success ? payload : null;
  } catch {
    return null;
  }
};

/**
 * The plugins a site runs when nobody has chosen: every free plugin, and none of the sold ones.
 *
 * A missing `rwp_active_plugins` option used to mean "every bundled plugin is active", which switched
 * the four commercial plugins on for a site that had never heard of them and had no key for them -
 * they then answered 402 (or 404 once the front end learned to keep them off) to every visitor. The
 * default is the set a site can actually use: the sold four start inactive and are switched on from
 * Plugins once their key verifies.
 *
 * One definition, used by `App.tsx`, the Plugins screen, `server/plugins.mjs` (which answers plugin
 * routes) and the installers that pin the option before adding a folder, so a fresh site, a rebuilt
 * one and a self-hosted one agree on what "nothing chosen yet" means.
 */
export const defaultActivePluginIds = (pluginIds) => (Array.isArray(pluginIds) ? pluginIds : [])
  .filter((pluginId) => !isCommercialPlugin(pluginId));

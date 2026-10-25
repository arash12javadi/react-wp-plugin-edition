/**
 * Server-side plugin licenses: minted offline, verified offline, one key per commercial plugin.
 *
 * A plugin listed in `COMMERCIAL_PLUGIN_ADDONS` (`src/lib/pluginLicense.js`) is locked until this file
 * says the key stored for it is genuine: `rwp-page-builder`, `rwp-shop`, `rwp-chat` and
 * `rwp-code-snippets`, and nothing else. Every other plugin in the site - the setup wizard, site
 * provisioning, a plugin uploaded as a ZIP - is free and never touches this file, because the list is
 * the only place a requirement is read from.
 *
 * A key is self-describing: it names the plugin it unlocks and the last day it is valid, and carries
 * a signature over both, so this server can answer "is this plugin licensed, and until when?" from
 * the key alone - no license server, no network call, and no per-customer secret stored next to the
 * answer. The format and the reader that accepts a key however it survived being pasted live in
 * `src/lib/pluginLicense.js`, which the browser also imports; only the signature is here, because
 * only the server may see the secret.
 *
 * The honest limitation, stated once and identical to the installer's: an offline check runs on the
 * customer's own server, so the secret that signs keys ships with the site. The default secret below
 * is therefore not a cryptographic paywall - anyone holding this file can mint a key with it. What a
 * key buys is a single, reviewable place where an entitlement is written down and displayed (the
 * Plugins screen, `GET <plugin>/license`), and what the default buys is keys that work out of the box
 * for everyone running this code unmodified. An operator who sells plugins sets their own secret in
 * `PLUGIN_LICENSE_SECRET` on every deployment that should honour their keys; a key minted under a
 * different secret is invalid there, which is exactly what `invalid` means.
 *
 * Mint a key from this repository:
 *
 *     node server/pluginLicense.mjs mint --plugin rwp-shop --days 365
 *     node server/pluginLicense.mjs mint --plugin rwp-shop --expires 2027-06-30
 *     node server/pluginLicense.mjs verify RWP1-SHOP-20270630-4K7QM2XZ8B
 *
 * Plain ESM for the same reason `server/plugins.mjs` is: it runs as it is under `npm start`, on
 * Vercel, and under `node -e`, and never reaches the browser bundle.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  COMMERCIAL_PLUGIN_ADDONS, PLUGIN_LICENSE_PREFIX, PLUGIN_LICENSE_SHOP_URL, PLUGIN_LICENSES_OPTION,
  defaultActivePluginIds, isCommercialPlugin, maskPluginLicense, pluginLicenseAddon, pluginLicenseAddonFor,
  pluginLicenseKeyFrom, pluginLicenseParts, readPluginLicenses,
} from '../src/lib/pluginLicense.js';

export {
  COMMERCIAL_PLUGIN_ADDONS, PLUGIN_LICENSES_OPTION, PLUGIN_LICENSE_SHOP_URL, defaultActivePluginIds,
  isCommercialPlugin, maskPluginLicense, pluginLicenseAddonFor, readPluginLicenses,
};

/** Where an operator's own signing secret is read from. Empty means the default below. */
export const PLUGIN_LICENSE_SECRET_ENV = 'PLUGIN_LICENSE_SECRET';

/**
 * The secret keys are signed with when nothing is configured.
 *
 * It is in the repository on purpose (see the file header): keys work out of the box, and a vendor
 * overrides it. Changing this string invalidates every key ever minted under it.
 */
const DEFAULT_SECRET = 'rwp-plugin-license-v1';

/** Crockford base32: no I, L, O or U, so a signature cannot be misread as a word. */
const SIGNATURE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SIGNATURE_LENGTH = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The secret in force: `PLUGIN_LICENSE_SECRET` when set, the default above otherwise. */
export const pluginLicenseSecret = (secret) =>
  str(secret) || str(typeof process !== 'undefined' ? process.env?.[PLUGIN_LICENSE_SECRET_ENV] : '') || DEFAULT_SECRET;

/** `YYYYMMDD` from a `YYYY-MM-DD`, `YYYYMMDD` or `Date`, or `''` when it is not a calendar date. */
export const pluginExpiryStamp = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const digits = str(value).replace(/[-/.]/g, '');
  if (!/^\d{8}$/.test(digits)) return '';
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // A date that survives a round trip is a date: 2027-02-30 becomes 2027-03-02 and is refused here,
  // because a key that silently expires on a different day than it prints is worse than an invalid one.
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? digits
    : '';
};

/** The first `length` characters of `buffer` in Crockford base32. */
const base32 = (buffer, length) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += SIGNATURE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) return out.slice(0, length);
  }
  return out.slice(0, length);
};

/**
 * The signature over the fields a key names.
 *
 * The payload is delimiter-separated with the format version in front, so a signature cannot be moved
 * from a `SHOP` key to a `CHAT` one, and cannot be moved between format versions.
 */
export const pluginLicenseSignature = ({ addon, expiresOn }, secret) => base32(
  createHmac('sha256', pluginLicenseSecret(secret))
    .update(`${PLUGIN_LICENSE_PREFIX}|${addon}|${expiresOn}`, 'utf8')
    .digest(),
  SIGNATURE_LENGTH,
);

/**
 * A key for one plugin: `RWP1-SHOP-20270630-4K7QM2XZ8B`.
 *
 * `plugin` may be an id (`rwp-shop`) or an addon (`SHOP`); both normalise to the same code, so a
 * vendor does not have to remember which one a key wants. `expiresOn` defaults to a year out.
 */
export const signPluginLicense = ({ plugin, expiresOn, days, secret } = {}) => {
  const addon = pluginLicenseAddon(plugin);
  if (!addon) throw new Error('A plugin key needs a plugin: pass --plugin rwp-shop (or --plugin SHOP).');
  const stamp = expiresOn
    ? pluginExpiryStamp(expiresOn)
    : pluginExpiryStamp(new Date(Date.now() + (Number(days) > 0 ? Number(days) : 365) * DAY_MS));
  if (!stamp) throw new Error(`"${expiresOn}" is not a calendar date: write it as YYYY-MM-DD, for example 2027-06-30.`);
  return `${PLUGIN_LICENSE_PREFIX}-${addon}-${stamp}-${pluginLicenseSignature({ addon, expiresOn: stamp }, secret)}`;
};

/**
 * The verdict on one plugin's stored key, in one object, so every caller says the same thing about the
 * same key: the Plugins screen, `GET <plugin>/license` and the 402 a locked plugin's routes answer.
 *
 * `key` is masked here and never returned whole: the answer may reach a browser. `licensed` is the
 * only field a caller has to branch on; `status` and `message` exist so it can say why.
 *
 * @param {object} options
 * @param {string} options.pluginId   The plugin the key is being checked for, e.g. rwp-shop.
 * @param {string} [options.key]      The stored key, as it came out of the option.
 * @param {string} [options.addon]    What the plugin declares; defaults to the addon of `pluginId`.
 * @param {Date}   [options.now]      Injectable clock, for tests and for the CLI.
 * @param {string} [options.secret]   Defaults to PLUGIN_LICENSE_SECRET, then the built-in secret.
 */
export const pluginLicenseState = ({ pluginId, key, addon, now = new Date(), secret } = {}) => {
  const required = addon || pluginLicenseAddon(pluginId);
  const mint = `node server/pluginLicense.mjs mint --plugin ${pluginId || 'PLUGIN'} --days 365`;
  const empty = {
    pluginId: pluginId || '',
    addon: required,
    key: '',
    licensed: false,
    status: 'missing',
    expiresOn: '',
    daysLeft: 0,
    message: `${required || 'This plugin'} needs a license key, and this site has not stored one. Enter it under Plugins -> License, or buy one at ${PLUGIN_LICENSE_SHOP_URL}; a key is minted with \`${mint}\`.`,
  };

  const parts = pluginLicenseParts(key);
  if (!parts) {
    if (!str(key)) return empty;
    return {
      ...empty,
      status: 'invalid',
      message: `That is not a ${required} license key: a key reads ${PLUGIN_LICENSE_PREFIX}-ADDON-YYYYMMDD-SIGNATURE, for example ${PLUGIN_LICENSE_PREFIX}-${required}-20270630-4K7QM2XZ8B.`,
    };
  }

  if (required && parts.addon !== required) {
    return {
      ...empty,
      key: maskPluginLicense(parts.key),
      status: 'wrong-plugin',
      message: `That key was issued for ${parts.addon}, not for ${required}, so ${pluginId || 'this plugin'} stays locked.`,
    };
  }

  const expected = Buffer.from(pluginLicenseSignature({ addon: parts.addon, expiresOn: parts.stamp }, secret), 'utf8');
  const given = Buffer.from(parts.signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return {
      ...empty,
      key: maskPluginLicense(parts.key),
      status: 'invalid',
      message: `That ${required} license key does not check out. Paste it again exactly as it was issued - a key is case-insensitive, but one character short is a different key.`,
    };
  }

  const state = {
    pluginId: pluginId || '',
    addon: parts.addon,
    key: maskPluginLicense(parts.key),
    licensed: true,
    status: 'licensed',
    expiresOn: parts.expiresOn,
    daysLeft: Math.max(0, Math.ceil((new Date(parts.expiresAt).getTime() - now.getTime()) / DAY_MS)),
    message: `The ${parts.addon} license is valid through ${parts.expiresOn}.`,
  };
  if (new Date(parts.expiresAt).getTime() < now.getTime()) {
    return {
      ...state,
      licensed: false,
      status: 'expired',
      daysLeft: 0,
      message: `The ${parts.addon} license expired on ${parts.expiresOn}, so ${pluginId || 'the plugin'} stays locked until a current key is entered. Renew at ${PLUGIN_LICENSE_SHOP_URL}.`,
    };
  }
  return state;
};

/**
 * What a gated request needs to know about one plugin, or `null` when the plugin is free.
 *
 * `licenses` is the parsed `PLUGIN_LICENSES_OPTION` (`{ [pluginId]: key }`), or `null` when the option
 * could not be read at all. A `null` means "unknown", and unknown is not the same as unlicensed: a
 * database hiccup must not take a working shop down, so the caller lets the request through and logs.
 */
export const pluginLicenseGate = ({ plugin, licenses, now, secret } = {}) => {
  const addon = pluginLicenseAddonFor(plugin);
  if (!addon) return null;
  if (licenses === null || licenses === undefined) return null;
  return pluginLicenseState({ pluginId: plugin.id, key: licenses[plugin.id], addon, now, secret });
};

/**
 * The command line, for the vendor who issues keys.
 *
 * Argv is parsed by hand rather than with `util.parseArgs` so `node server/pluginLicense.mjs mint
 * --days 30` works on every Node the site supports. Output is text a person reads, not JSON: this is
 * a command run rarely, by hand, and the key it prints is pasted into an email.
 */
function cli(argv) {
  const [command = '', ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument.startsWith('--')) {
      const [name, inline] = argument.slice(2).split('=');
      if (inline !== undefined) options[name] = inline;
      else if (rest[index + 1] && !rest[index + 1].startsWith('--')) {
        options[name] = rest[index + 1];
        index += 1;
      } else options[name] = 'true';
    } else positional.push(argument);
  }

  // `help` in each of its spellings is a request rather than a mistake, and is answered before any
  // command runs: `mint --help` must not mint a key with defaults the operator was trying to replace.
  if (command === 'help' || command === '--help' || command === '-h'
    || options.help === 'true' || options.h === 'true') return usage(0);

  if (command === 'mint') {
    if (!str(options.plugin)) {
      console.error('Name the plugin the key is for: --plugin rwp-shop (or --plugin SHOP).');
      return 1;
    }
    const key = signPluginLicense({
      plugin: options.plugin,
      expiresOn: options.expires,
      days: options.days,
      secret: options.secret,
    });
    const state = pluginLicenseState({ pluginId: pluginLicenseAddon(options.plugin), key, secret: options.secret });
    console.log(key);
    console.log('');
    console.log(`Plugin: ${state.addon}`);
    console.log(`Valid through: ${state.expiresOn} (${state.daysLeft} days)`);
    // Which secret signed it matters to the vendor: a key minted under PLUGIN_LICENSE_SECRET verifies
    // on no deployment that does not set the same value, and one minted under the default verifies
    // everywhere this file is unmodified.
    let signedWith = 'the built-in default';
    if (options.secret) signedWith = 'the --secret you supplied';
    else if (str(process.env?.[PLUGIN_LICENSE_SECRET_ENV])) signedWith = `${PLUGIN_LICENSE_SECRET_ENV} from this shell`;
    console.log(`Signed with: ${signedWith}`);
    // A key that is already dead is a typo in --expires far more often than a deliberate choice, so it
    // is said out loud; it is still printed, because `mint` is also how a date is checked.
    if (!state.licensed) console.log(`Warning: this key is already ${state.status}, so it unlocks nothing.`);
    return 0;
  }

  if (command === 'verify') {
    const parts = pluginLicenseParts(positional[0]);
    const state = pluginLicenseState({
      pluginId: str(options.plugin) || pluginLicenseAddon(parts?.addon || ''),
      key: positional[0],
      secret: options.secret,
    });
    console.log(`${state.status}: ${state.message}`);
    // ASCII only, like every other console line in this repository: a middle dot or an arrow survives
    // UTF-8 but not the Windows console, and this text is read in a terminal on whatever machine the
    // vendor happens to be sitting at.
    if (state.expiresOn) console.log(`Plugin: ${state.addon} - Expires: ${state.expiresOn}`);
    return state.licensed ? 0 : 1;
  }

  // A bare command line is an operator who started typing and stopped: the same text as `help`, and a
  // failure, because nothing was asked for and nothing was done. An unknown word is the same case.
  return usage(1);
}

/** The commands, in one place, so `--help` on any of them prints the same text. */
function usage(exitCode = 0) {
  console.log('Usage:');
  console.log('  node server/pluginLicense.mjs mint --plugin rwp-shop --days 365');
  console.log('  node server/pluginLicense.mjs mint --plugin rwp-shop --expires 2027-06-30');
  console.log('  node server/pluginLicense.mjs verify RWP1-SHOP-20270630-4K7QM2XZ8B');
  console.log('');
  console.log(`Keys are signed with ${PLUGIN_LICENSE_SECRET_ENV} when it is set, and with the built-in default otherwise.`);
  return exitCode;
}

// Run as a script, but never when imported by server/plugins.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Server-side plugin licenses: signed by the vendor, verified offline against the vendor's PUBLIC key.
 *
 * A plugin listed in `COMMERCIAL_PLUGIN_ADDONS` (`src/lib/pluginLicense.js`) is locked until this file
 * says the key stored for it is genuine: `rwp-page-builder`, `rwp-shop`, `rwp-chat` and
 * `rwp-code-snippets`, and nothing else. Every other plugin in the site - the setup wizard, site
 * provisioning, a plugin uploaded as a ZIP - is free and never touches this file, because the list is
 * the only place a requirement is read from.
 *
 * A key is self-describing: it names the plugin it unlocks, the last day it is valid and a serial, and
 * carries an Ed25519 signature over all three (`RWP2-ADDON-YYYYMMDD-SERIAL-SIGNATURE`). A site answers
 * "is this plugin licensed, and until when?" from the key and the vendor's public key alone - no network
 * call per request. The format and the reader that accepts a key however it survived being pasted live in
 * `src/lib/pluginLicense.js`, which the browser also imports.
 *
 * **What this does and does not protect.** The private key exists only on the deployment that sells
 * licences (`PLUGIN_LICENSE_PRIVATE_KEY`); a site holds the public key and can verify but never mint, so
 * a customer cannot forge a key from the code they received. A serial can be revoked
 * (`server/licenseRevocations.mjs`). What it cannot do: a customer who can edit this server's code can
 * delete the check. The protection against that is not here - sold plugin source is never committed to a
 * client's repository (`isCommercialPlugin` in `clientRepositoryFiles`) and is delivered built, not as
 * source. This file is the entitlement record and the gate, not DRM.
 *
 *     node server/pluginLicense.mjs keygen                          (once, by the owner)
 *     node server/pluginLicense.mjs mint --plugin rwp-shop --days 365   (needs PLUGIN_LICENSE_PRIVATE_KEY)
 *     node server/pluginLicense.mjs verify RWP2-SHOP-...            (uses the public key)
 *
 * Plain ESM for the same reason `server/plugins.mjs` is: it runs as it is under `npm start`, on
 * Vercel, and under `node -e`, and never reaches the browser bundle.
 */
import { pathToFileURL } from 'node:url';
import {
  COMMERCIAL_PLUGIN_ADDONS, PLUGIN_LICENSE_PREFIX, PLUGIN_LICENSE_SHOP_URL, PLUGIN_LICENSES_OPTION,
  defaultActivePluginIds, isCommercialPlugin, isLegacyPluginLicenseKey, maskPluginLicense, pluginIdForSlug,
  pluginLicenseAddon, pluginLicenseAddonFor, pluginLicenseParts, readPluginLicenses,
} from '../src/lib/pluginLicense.js';
import {
  PLUGIN_LICENSE_PRIVATE_KEY_ENV, PLUGIN_LICENSE_PUBLIC_KEY_ENV, generateLicenseKeyPair, licensePrivateKey,
  licensePublicKey, newLicenseSerial, signPayload, verifyPayload,
} from './licenseCrypto.mjs';
import { revokedSerials } from './licenseRevocations.mjs';

export {
  COMMERCIAL_PLUGIN_ADDONS, PLUGIN_LICENSES_OPTION, PLUGIN_LICENSE_SHOP_URL, defaultActivePluginIds,
  isCommercialPlugin, maskPluginLicense, pluginIdForSlug, pluginLicenseAddonFor, readPluginLicenses,
  PLUGIN_LICENSE_PRIVATE_KEY_ENV, PLUGIN_LICENSE_PUBLIC_KEY_ENV,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a site keeps its last good licence verdict when the `rwp_plugin_licenses` option cannot be read.
 * After this the sold plugins lock (fail closed) until the option can be read again. 72 hours survives a
 * weekend database outage without handing a paid customer a broken shop on Monday.
 */
export const LICENSE_GRACE_MS = 72 * 60 * 60 * 1000;

/**
 * Days a sold plugin keeps working after its key's last day, with a warning, before it locks. This is a
 * different grace from the one above (an unreadable store): that one protects against our outage, this
 * one against a late renewal. Revoked and invalid keys never get it.
 */
export const LICENSE_EXPIRY_GRACE_DAYS = 14;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

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

/**
 * What the signature covers: format version, addon, last day and serial, delimiter-separated, so a
 * signature cannot move between plugins, days, serials or format versions.
 */
export const pluginLicensePayload = ({ addon, expiresOn, serial }) =>
  `${PLUGIN_LICENSE_PREFIX}|${addon}|${expiresOn}|${serial}`;

/**
 * A key for one plugin: `RWP2-SHOP-20270630-<serial>-<signature>`.
 *
 * Needs the private key (`privateKey`, else `PLUGIN_LICENSE_PRIVATE_KEY`) and throws a sentence saying so
 * when there is none - there is no default key and no fallback. `plugin` may be an id (`rwp-shop`) or an
 * addon (`SHOP`). `expiresOn` defaults to a year out; `serial` is random unless a test pins one.
 */
export const signPluginLicense = ({ plugin, expiresOn, days, privateKey, serial } = {}) => {
  const addon = pluginLicenseAddon(plugin);
  if (!addon) throw new Error('A plugin key needs a plugin: pass --plugin rwp-shop (or --plugin SHOP).');
  const stamp = expiresOn
    ? pluginExpiryStamp(expiresOn)
    : pluginExpiryStamp(new Date(Date.now() + (Number(days) > 0 ? Number(days) : 365) * DAY_MS));
  if (!stamp) throw new Error(`"${expiresOn}" is not a calendar date: write it as YYYY-MM-DD, for example 2027-06-30.`);
  const id = serial || newLicenseSerial();
  const signature = signPayload(pluginLicensePayload({ addon, expiresOn: stamp, serial: id }), licensePrivateKey(privateKey));
  return `${PLUGIN_LICENSE_PREFIX}-${addon}-${stamp}-${id}-${signature}`;
};

/**
 * The addon a marketplace catalogue slug names, when that slug is one of the four sold plugins.
 *
 * The marketplace lists plugins by `slug` (`rwp-shop`, or a slug whose addon is `SHOP`), not by the
 * id `pluginLicenseAddonFor` keys off. Matching a slug to its commercial addon here is what lets the
 * marketplace mint the same `RWP2-…` key the plugin's own gate verifies, without the browser or the
 * database ever holding the signing key. A slug that is not a sold plugin returns `''`, and the
 * marketplace keeps issuing its opaque `RWPM-…` update token for it.
 *
 * The slug is first translated to a plugin id (`pluginIdForSlug`), because a listing may be named for
 * its marketing rather than its folder - `rwp-chat-ai-assistant` is `rwp-chat`, and the gate on a site
 * asks for `CHAT`. Signing `CHAT-AI-ASSISTANT` would produce a key shaped like a real one that no
 * plugin accepts, which is worse than issuing the opaque token.
 */
export const marketplaceAddonFor = (slug) => {
  const id = pluginIdForSlug(slug);
  if (!id) return '';
  if (Object.hasOwn(COMMERCIAL_PLUGIN_ADDONS, id)) return COMMERCIAL_PLUGIN_ADDONS[id];
  const addon = pluginLicenseAddon(id);
  return Object.values(COMMERCIAL_PLUGIN_ADDONS).includes(addon) ? addon : '';
};

/**
 * The key the marketplace hands a buyer for one plugin, and the addon it unlocks.
 *
 * For a sold plugin this is the signed `RWP2-…` key `pluginLicenseState` verifies, so pasting it into a
 * site's Plugins screen lifts the gate immediately - no restart, no re-upload. For any other plugin both
 * fields are empty and the caller keeps its opaque token. For a sold plugin with no private key
 * configured this THROWS: handing out an opaque token for a plugin that has a gate would be a licence
 * that unlocks nothing.
 */
export const marketplacePluginKey = ({ slug, days, expiresOn, privateKey } = {}) => {
  const addon = marketplaceAddonFor(slug);
  if (!addon) return { addon: '', key: '' };
  return { addon, key: signPluginLicense({ plugin: addon, days, expiresOn, privateKey }) };
};

/** The serial a key carries, or `''`. Used by the marketplace to record and revoke a key. */
export const pluginLicenseSerial = (key) => pluginLicenseParts(key)?.serial || '';

/**
 * The verdict on one plugin's stored key, in one object, so every caller says the same thing about the
 * same key: the Plugins screen, `GET <plugin>/license` and the 402 a locked plugin's routes answer.
 *
 * `key` is masked here and never returned whole: the answer may reach a browser. `licensed` is the
 * only field a caller has to branch on; `status` and `message` exist so it can say why.
 *
 * Checked in this order: shape, retired format, addon, public key present, signature, revoked, expiry.
 *
 * @param {object} options
 * @param {string} options.pluginId   The plugin the key is being checked for, e.g. rwp-shop.
 * @param {string} [options.key]      The stored key, as it came out of the option.
 * @param {string} [options.addon]    What the plugin declares; defaults to the addon of `pluginId`.
 * @param {Date}   [options.now]      Injectable clock, for tests and for the CLI.
 * @param {string} [options.publicKey]  Defaults to PLUGIN_LICENSE_PUBLIC_KEY, then the built-in key.
 * @param {Iterable<string>} [options.revoked]  Revoked serials; defaults to the verified list this site holds.
 */
export const pluginLicenseState = ({ pluginId, key, addon, now = new Date(), publicKey, revoked } = {}) => {
  const required = addon || pluginLicenseAddon(pluginId);
  const empty = {
    pluginId: pluginId || '',
    addon: required,
    key: '',
    licensed: false,
    status: 'missing',
    expiresOn: '',
    daysLeft: 0,
    message: `${required || 'This plugin'} needs a license key, and this site has not stored one. Enter it under Plugins -> License, or buy one at ${PLUGIN_LICENSE_SHOP_URL}.`,
  };

  const parts = pluginLicenseParts(key);
  if (!parts) {
    if (!str(key)) return empty;
    if (isLegacyPluginLicenseKey(key)) {
      return {
        ...empty,
        status: 'invalid',
        message: `That is an old-format (RWP1) key, which this version no longer accepts. Request a replacement ${required} key at ${PLUGIN_LICENSE_SHOP_URL} or from your vendor; it starts with ${PLUGIN_LICENSE_PREFIX}-.`,
      };
    }
    return {
      ...empty,
      status: 'invalid',
      message: `That is not a ${required} license key: a key reads ${PLUGIN_LICENSE_PREFIX}-${required}-YYYYMMDD-SERIAL-SIGNATURE and is about 140 characters long. Paste it whole.`,
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

  const verdict = verifyPayload(
    pluginLicensePayload({ addon: parts.addon, expiresOn: parts.stamp, serial: parts.serial }),
    parts.signature,
    licensePublicKey(publicKey),
  );
  if (verdict === 'no-key') {
    return {
      ...empty,
      key: maskPluginLicense(parts.key),
      status: 'unverifiable',
      message: `This build has no license public key (${PLUGIN_LICENSE_PUBLIC_KEY_ENV} is not set and none is built in), so no key can be verified and ${pluginId || 'the plugin'} stays locked. Ask the vendor for a current release.`,
    };
  }
  if (verdict !== 'ok') {
    return {
      ...empty,
      key: maskPluginLicense(parts.key),
      status: 'invalid',
      message: `That ${required} license key does not check out. Paste it again exactly as it was issued - a key is case-insensitive, but one character short is a different key.`,
    };
  }

  const revokedSet = revoked ? new Set(revoked) : revokedSerials();
  if (revokedSet.has(parts.serial)) {
    return {
      ...empty,
      key: maskPluginLicense(parts.key),
      expiresOn: parts.expiresOn,
      status: 'revoked',
      message: `That ${required} license was revoked by the vendor (refunded or withdrawn), so ${pluginId || 'the plugin'} stays locked. Contact the vendor or buy a new license at ${PLUGIN_LICENSE_SHOP_URL}.`,
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
  const endsAt = new Date(parts.expiresAt).getTime();
  if (endsAt < now.getTime()) {
    // The grace runs from the end of the expiry day, so a buyer who is a day late is not locked out of a
    // live shop. It is only ever reached with a verified, unrevoked key: both checks above come first.
    const graceEndsAt = endsAt + LICENSE_EXPIRY_GRACE_DAYS * DAY_MS;
    if (now.getTime() <= graceEndsAt) {
      const graceDaysLeft = Math.max(1, Math.ceil((graceEndsAt - now.getTime()) / DAY_MS));
      return {
        ...state,
        licensed: true,
        status: 'grace',
        daysLeft: 0,
        graceDaysLeft,
        graceEndsOn: new Date(graceEndsAt).toISOString().slice(0, 10),
        message: `The ${parts.addon} license expired on ${parts.expiresOn}. ${pluginId || 'The plugin'} keeps working for ${graceDaysLeft} more day${graceDaysLeft === 1 ? '' : 's'} and then locks. Renew at ${PLUGIN_LICENSE_SHOP_URL} and enter the new key.`,
      };
    }
    return {
      ...state,
      licensed: false,
      status: 'expired',
      daysLeft: 0,
      message: `The ${parts.addon} license expired on ${parts.expiresOn} and its ${LICENSE_EXPIRY_GRACE_DAYS}-day grace period has ended, so ${pluginId || 'the plugin'} stays locked until a current key is entered. Renew at ${PLUGIN_LICENSE_SHOP_URL}.`,
    };
  }
  return state;
};

/**
 * What a gated request needs to know about one plugin, or `null` when the plugin is free.
 *
 * `licenses` is the parsed `PLUGIN_LICENSES_OPTION` (`{ [pluginId]: key }`), or `null` when the option
 * could not be read and no verdict within the grace window is held. **That is a lock, not an unlock**:
 * the answer is `licensed: false` with status `unknown`. A site that has never stored a key is `{}` and
 * is locked the ordinary way (`missing`).
 */
export const pluginLicenseGate = ({ plugin, licenses, now, publicKey, revoked } = {}) => {
  const addon = pluginLicenseAddonFor(plugin);
  if (!addon) return null;
  if (licenses === null || licenses === undefined) {
    return {
      pluginId: plugin.id,
      addon,
      key: '',
      licensed: false,
      status: 'unknown',
      expiresOn: '',
      daysLeft: 0,
      message: `This site could not read its stored license keys and has no recent verdict to fall back on, so ${plugin.id} stays locked until it can. Reload in a moment; if it persists, check the database connection.`,
    };
  }
  return pluginLicenseState({ pluginId: plugin.id, key: licenses[plugin.id], addon, now, publicKey, revoked });
};

/**
 * The active ids a site may actually run: every free plugin, plus a sold one only while its key holds.
 *
 * `rwp_active_plugins` is where an administrator's choice is written, but it is not the last word: a
 * commercial plugin whose key is missing, expired, revoked or for another addon is *inactive*, whatever
 * that option or the `plugins` row still says. `server/plugins.mjs` calls this before it answers a route.
 *
 * `licenses === null` (unreadable, no verdict within grace) drops every sold id: fail closed.
 */
export const licensedActivePluginIds = (activeIds, licenses, { now, publicKey, revoked } = {}) => {
  if (!Array.isArray(activeIds)) return activeIds;
  return activeIds.filter((pluginId) => {
    const gate = pluginLicenseGate({ plugin: { id: pluginId }, licenses, now, publicKey, revoked });
    return !gate || gate.licensed;
  });
};

/**
 * The licence-store read policy: which `licenses` value a request may use after a read attempt.
 *
 * - A successful read replaces the cache and restarts the grace clock.
 * - A failed read keeps the last good value for `graceMs`, then falls to `null` (locked).
 * - A site that never had a good read (`at === 0`) has nothing to keep: `null`.
 *
 * Pure and clock-injected, so the policy is testable without a database. `readFailed` carries only
 * whether it failed; the caller logs the reason (never a key).
 *
 * @param {{ licenses: object|null, at: number }} cache  Last good verdict and when it was read (epoch ms).
 * @param {{ ok: boolean, licenses?: object }} read      The result of this attempt.
 * @returns {{ licenses: object|null, at: number, degraded: boolean }}
 */
export const applyLicenseGrace = (cache, read, { now = Date.now(), graceMs = LICENSE_GRACE_MS } = {}) => {
  if (read.ok) return { licenses: read.licenses, at: now, degraded: false };
  const held = cache?.licenses && cache.at > 0 && now - cache.at <= graceMs;
  return held
    ? { licenses: cache.licenses, at: cache.at, degraded: true }
    : { licenses: null, at: cache?.at || 0, degraded: true };
};

/**
 * The command line, for the owner who issues keys.
 *
 * Argv is parsed by hand rather than with `util.parseArgs` so `node server/pluginLicense.mjs mint
 * --days 30` works on every Node the site supports. Output is text a person reads, not JSON: this is
 * a command run rarely, by hand, and the key it prints is pasted into an email. The private key is read
 * from the environment only - never from an argument, which would land in shell history.
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

  if (command === 'keygen') {
    const pair = generateLicenseKeyPair();
    console.log('Public key (safe to commit: paste into BUILT_IN_PUBLIC_KEY in server/licenseCrypto.mjs):');
    console.log(pair.publicKey);
    console.log('');
    console.log(`Private key (SECRET: set it as ${PLUGIN_LICENSE_PRIVATE_KEY_ENV} on the deployment that sells licenses, and nowhere else; it is not stored anywhere):`);
    console.log(pair.privateKey);
    return 0;
  }

  if (command === 'mint') {
    if (!str(options.plugin)) {
      console.error('Name the plugin the key is for: --plugin rwp-shop (or --plugin SHOP).');
      return 1;
    }
    if (!licensePrivateKey()) {
      console.error(`Refusing to mint: ${PLUGIN_LICENSE_PRIVATE_KEY_ENV} is not set in this shell. Only the vendor holds it. Run "node server/pluginLicense.mjs keygen" once to create a pair.`);
      return 1;
    }
    const key = signPluginLicense({
      plugin: options.plugin,
      expiresOn: options.expires,
      days: options.days,
    });
    const state = pluginLicenseState({ pluginId: pluginLicenseAddon(options.plugin), key });
    console.log(key);
    console.log('');
    console.log(`Plugin: ${pluginLicenseParts(key).addon}`);
    console.log(`Serial: ${pluginLicenseSerial(key)} (record it: a revocation names this)`);
    console.log(`Valid through: ${pluginLicenseParts(key).expiresOn}`);
    // A key that is already dead, or that this build cannot verify, is a typo in --expires or a
    // public key that does not match the private one far more often than a deliberate choice.
    if (!state.licensed) console.log(`Warning: this key does not verify here (${state.status}): ${state.message}`);
    return 0;
  }

  if (command === 'verify') {
    const parts = pluginLicenseParts(positional[0]);
    const state = pluginLicenseState({
      pluginId: str(options.plugin) || pluginLicenseAddon(parts?.addon || ''),
      key: positional[0],
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
  console.log('  node server/pluginLicense.mjs keygen');
  console.log('  node server/pluginLicense.mjs mint --plugin rwp-shop --days 365');
  console.log('  node server/pluginLicense.mjs mint --plugin rwp-shop --expires 2027-06-30');
  console.log('  node server/pluginLicense.mjs verify RWP2-SHOP-20270630-<serial>-<signature>');
  console.log('');
  console.log(`mint needs ${PLUGIN_LICENSE_PRIVATE_KEY_ENV} in the environment and refuses without it. verify uses the public key (${PLUGIN_LICENSE_PUBLIC_KEY_ENV}, else the one built in).`);
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

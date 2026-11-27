/**
 * The site half of the account link: this installation fetches its own licence keys from the react-wp.com
 * account that bought them, instead of a person pasting a 140-character key.
 *
 * How it works
 * ------------
 *   1. The customer opens My licenses on react-wp.com, chooses "Connect a site" and gets a one-time code
 *      (`XXXXX-XXXXX`, 10 minutes).
 *   2. The site owner enters it on Plugins. `connectSite` sends the code and this site's host name to
 *      `POST <base>/connect` and receives a read-only **site token**.
 *   3. The token is sealed with RWP_SECRET_BOX_KEY (AES-256-GCM) into the `license_link_config` row of
 *      `system_settings` - a platform-owner row (administrator / super_admin), never readable by a role that
 *      merely holds `manage_options`, and never sent to a browser. A missing secret-box key is a refusal.
 *   4. `syncLicenses` asks `GET <base>/sync` for the key list (`If-None-Match`: an unchanged list is a 304 and
 *      costs next to nothing). Only a key whose signature verifies **here** for the plugin it names is ever
 *      stored, and only when it is better than the one already held (later expiry, or the stored one does not
 *      verify): a hostile or broken answer cannot overwrite a good key with a worse one.
 *
 * When it runs
 * ------------
 * "Sync now" on the Plugins screen, and automatically once a day. The automatic run does **not** happen at
 * the same moment everywhere: each site's slot within the UTC day is derived from its own token
 * (`syncSlotMs`), so ten thousand sites do not call the platform at midnight. There are no timers on a
 * serverless host, so the run is started by whatever request next reads the licence option after the slot
 * (`backgroundLicenseSync`), and it needs the server's secret key to write the option - without one the daily
 * run is skipped and "Sync now" (which writes with the administrator's own session) still works. A failed
 * attempt is not retried for an hour. The platform also rate limits each token.
 *
 * Nothing here ever logs, returns or stores the token or a key in readable form outside the sealed row and
 * the licence option the keys belong in.
 */
import { createHash } from 'node:crypto';
import { SECRET_BOX_KEY_ENV, openSecret, sealSecret, secretFingerprint } from './deploy/secretBox.mjs';
import { requireSecretBox, safeSecretBoxEnabled, settingsIo } from './gitDeploy/connection.mjs';
import { centralFetch } from './centralFetch.mjs';
import { PLUGIN_LICENSES_OPTION, isCommercialPlugin, pluginLicenseState, readPluginLicenses } from './pluginLicense.mjs';

export const LICENSE_LINK_CONFIG_KEY = 'license_link_config';
export const LICENSE_LINK_URL_ENV = 'RWP_LICENSE_LINK_URL';
export const DEFAULT_LICENSE_LINK_URL = 'https://react-wp.com/api/v1/licenses';

const DAY_MS = 24 * 60 * 60 * 1000;
/** After a failed attempt the automatic run waits this long; a person can still press "Sync now". */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** A site that has not synced for this long syncs at the next opportunity whatever its slot says. */
const OVERDUE_MS = 2 * DAY_MS;
const REQUEST_TIMEOUT_MS = 12_000;

export class LicenseLinkError extends Error {
  constructor(status, message, code = 'license_link') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The row, normalised: every field present, nothing that is not a string where a string is expected. */
export function licenseLinkFrom(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = row.last_result && typeof row.last_result === 'object' ? row.last_result : {};
  return {
    token_sealed: str(row.token_sealed),
    token_fingerprint: str(row.token_fingerprint),
    domain: str(row.domain),
    etag: str(row.etag),
    connected_at: str(row.connected_at),
    last_sync_at: str(row.last_sync_at),
    last_attempt_at: str(row.last_attempt_at),
    last_result: { ok: result.ok === true, message: str(result.message), at: str(result.at) },
    // Consent to commit the plugins assigned to this site on react-wp.com. Only an explicit `true` counts, so a
    // site that connected before this option existed has not agreed to anything.
    auto_install: row.auto_install === true,
    latest_versions: latestVersionsFrom(row.latest_versions),
    // Plugins bought from developers' own shops (RWPD1), as react-wp.com last delivered them: installed and updated from that shop.
    developer_licenses: developerLicensesFrom(row.developer_licenses),
    // What "Roll back" may restore: per plugin, the version an update replaced and the commit it made (server/pluginRollback.mjs).
    rollback_points: rollbackPointsFrom(row.rollback_points),
  };
}

const SHOP_HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const PUBLIC_KEY = /^[A-Za-z0-9+/]{40,200}={0,2}$/;

/**
 * The developer purchases react-wp.com delivered: `[{ plugin, name, key, seller_domain, public_key, version, expires_on }]`. Only a
 * safe id, an RWPD1 key of that plugin, a plain host and a plausible public key are kept; at most 200.
 */
export function developerLicensesFrom(value) {
  const out = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const plugin = str(item?.plugin);
    const key = str(item?.key);
    const shop = str(item?.seller_domain).toLowerCase();
    const publicKey = str(item?.public_key);
    if (!SAFE_PLUGIN_ID.test(plugin) || !key.startsWith(`RWPD1.${plugin}.`) || key.length > 400 || !SHOP_HOST.test(shop) || !PUBLIC_KEY.test(publicKey)) continue;
    out.set(plugin, {
      plugin,
      name: str(item?.name).slice(0, 120) || plugin,
      key,
      seller_domain: shop,
      public_key: publicKey,
      version: VERSION.test(str(item?.version)) ? str(item.version) : '',
      expires_on: /^\d{4}-\d{2}-\d{2}$/.test(str(item?.expires_on)) ? str(item.expires_on) : '',
    });
    if (out.size >= 200) break;
  }
  return [...out.values()];
}

/** The developer purchase the sync delivered for `plugin` (with a key and a shop to ask), or null. */
export function developerEntryFor(row, plugin) {
  const id = str(plugin);
  const entry = (Array.isArray(row?.developer_licenses) ? row.developer_licenses : []).find((item) => str(item?.plugin) === id);
  return SAFE_PLUGIN_ID.test(id) && entry && str(entry.key) && str(entry.public_key) && SHOP_HOST.test(str(entry.seller_domain)) ? entry : null;
}

const SHA1 = /^[0-9a-f]{40}$/;

/** The rollback points of a settings row, cleaned (a damaged row offers nothing). */
export function rollbackPointsFrom(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [id, point] of Object.entries(source)) {
    if (!SAFE_PLUGIN_ID.test(id) || !VERSION.test(str(point?.version)) || !SHA1.test(str(point?.commit))) continue;
    out[id] = { version: str(point.version), commit: str(point.commit), at: str(point.at) };
  }
  return out;
}

/** The point to keep after an update answered `result` (what `installPluginFromGit` returns, with `update.from`). */
export function pointAfterUpdate(result, now = new Date()) {
  const commit = str(result?.commit?.sha);
  const version = str(result?.update?.from);
  if (!SHA1.test(commit) || !VERSION.test(version)) return null;
  return { version, commit, at: now.toISOString() };
}

/** `RWPD1.plugin.…ABCD`: enough to recognise a key on screen, not enough to use it. */
const keyHint = (key) => {
  const parts = String(key || '').split('.');
  return parts.length === 5 ? `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, 4)}…` : '';
};

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * `{ "rwp-shop": "1.3.0" }`: the newest version of each sold plugin this site is licensed for, as the platform last
 * said. Only a sold plugin with a safe id and a plain version is kept, so a damaged row or a hostile answer
 * cannot put anything else on the Plugins screen.
 */
export function latestVersionsFrom(value) {
  const entries = Array.isArray(value)
    ? value.map((item) => [str(item?.plugin), str(item?.version)])
    : value && typeof value === 'object' ? Object.entries(value).map(([plugin, version]) => [str(plugin), str(version)]) : [];
  return Object.fromEntries(entries.filter(([plugin, version]) => SAFE_PLUGIN_ID.test(plugin) && VERSION.test(version)));
}

export const isLicenseLinked = (row) => Boolean(row?.token_sealed && row?.domain);

/**
 * Where the platform's licence API lives: `RWP_LICENSE_LINK_URL` or react-wp.com. https only (a token must
 * not cross a network in clear); plain http is accepted for a loopback address so a developer can test.
 */
export function licenseLinkBase(env = globalThis.process?.env || {}) {
  const raw = (str(env[LICENSE_LINK_URL_ENV]) || DEFAULT_LICENSE_LINK_URL).replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new LicenseLinkError(500, `${LICENSE_LINK_URL_ENV} is not a URL.`, 'bad_link_url');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new LicenseLinkError(500, `${LICENSE_LINK_URL_ENV} must be an https address.`, 'bad_link_url');
  }
  return url.toString().replace(/\/+$/, '');
}

/** What a browser may be told: presence, names and dates - never the token, its envelope or a key. */
export function publicLicenseLink(value, { env = globalThis.process?.env || {}, now = new Date() } = {}) {
  const row = licenseLinkFrom(value);
  return {
    connected: isLicenseLinked(row),
    domain: row.domain,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastResult: row.last_result.message ? row.last_result : null,
    nextSyncAt: isLicenseLinked(row) ? nextSyncAt(row, { env, now }) : '',
    tokenFingerprint: row.token_fingerprint,
    secretBox: safeSecretBoxEnabled(env),
    autoInstall: row.auto_install,
    // Developer plugins are offered as updates too: the version react-wp.com lists for each purchase.
    latestVersions: {
      ...Object.fromEntries(row.developer_licenses.filter((entry) => entry.version).map((entry) => [entry.plugin, entry.version])),
      ...row.latest_versions,
    },
    developerLicenses: row.developer_licenses.map((entry) => ({
      plugin: entry.plugin, name: entry.name, sellerDomain: entry.seller_domain, version: entry.version, expiresOn: entry.expires_on, keyHint: keyHint(entry.key),
    })),
    rollbackPoints: Object.fromEntries(Object.entries(row.rollback_points).map(([id, point]) => [id, { version: point.version, at: point.at }])),
  };
}

// ---------------------------------------------------------------------------------------------------
// Jitter: when this site syncs

/**
 * Milliseconds into the UTC day at which this site's automatic sync becomes due. Derived from the token's
 * SHA-256, so it is stable for a site (it does not move between restarts) and spread evenly over the day
 * across sites, with no state to store and nothing a visitor can influence.
 */
export const syncSlotMs = (tokenOrFingerprint) =>
  createHash('sha256').update(`rwp-license-sync|${tokenOrFingerprint}`).digest().readUInt32BE(0) % DAY_MS;

const startOfUtcDay = (now) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/**
 * Whether the automatic run is due: today's slot has passed and nothing has synced since it; or the site is
 * badly overdue. Never within an hour of a failed attempt.
 *
 * `seed` is the token fingerprint (not the token): a sealed row can be scheduled without opening it.
 */
export function isSyncDue({ seed, lastSyncAt = '', lastAttemptAt = '', now = new Date() }) {
  const nowMs = now.getTime();
  const attempt = Date.parse(lastAttemptAt);
  if (!Number.isNaN(attempt) && nowMs - attempt < RETRY_AFTER_FAILURE_MS && nowMs >= attempt) return false;
  const last = Date.parse(lastSyncAt);
  if (Number.isNaN(last) || nowMs - last > OVERDUE_MS) return true;
  const slot = startOfUtcDay(now) + syncSlotMs(seed);
  return nowMs >= slot && last < slot;
}

/** The next moment the automatic run is due, as an ISO date, for the screen. */
export function nextSyncAt(row, { now = new Date() } = {}) {
  const seed = row.token_fingerprint || row.domain;
  const slot = startOfUtcDay(now) + syncSlotMs(seed);
  const last = Date.parse(row.last_sync_at);
  const doneToday = !Number.isNaN(last) && last >= slot;
  // Done today: tomorrow's slot. Not yet reached: today's. Passed and not done: due now.
  const next = doneToday ? slot + DAY_MS : now.getTime() < slot ? slot : now.getTime();
  return new Date(next).toISOString();
}

// ---------------------------------------------------------------------------------------------------
// Talking to the platform

const hostOf = (siteUrl) => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const platformMessage = async (response) => {
  const body = await response.json().catch(() => null);
  return str(body?.error) || str(body?.message) || `HTTP ${response.status}`;
};

/** Connects this site with a pairing code. Returns the row that was stored (never the token). */
export async function connectSite({ code, siteUrl, io, autoInstall = true, env = globalThis.process?.env || {}, fetchImpl = fetch, now = new Date() }) {
  requireSecretBox(env);
  const domain = hostOf(str(siteUrl));
  if (!domain) throw new LicenseLinkError(400, 'This site cannot tell its own address from the request, so it cannot be connected.', 'no_site_address');
  if (!str(code)) throw new LicenseLinkError(400, 'Enter the pairing code from react-wp.com (it looks like ABCDE-12345).', 'code_missing');

  let response;
  try {
    response = await centralFetch(`${licenseLinkBase(env)}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code: str(code), domain }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { fetchImpl });
  } catch (error) {
    throw new LicenseLinkError(502, `react-wp.com could not be reached: ${error instanceof Error ? error.message : 'network error'}.`, 'unreachable');
  }
  if (!response.ok) throw new LicenseLinkError(response.status === 429 ? 429 : 400, await platformMessage(response), 'refused');

  const answer = await response.json().catch(() => null);
  const token = str(answer?.token);
  if (!/^rwps_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new LicenseLinkError(502, 'react-wp.com answered, but not with a site token. Nothing was stored.', 'bad_answer');
  }
  const row = {
    token_sealed: sealSecret(token, { env }),
    token_fingerprint: secretFingerprint(token),
    domain: str(answer?.domain) || domain,
    etag: '',
    connected_at: now.toISOString(),
    last_sync_at: '',
    last_attempt_at: '',
    last_result: { ok: true, message: 'Connected. Keys are fetched next.', at: now.toISOString() },
    auto_install: autoInstall !== false,
  };
  await io.write(LICENSE_LINK_CONFIG_KEY, row);
  return row;
}

/**
 * Updates one installed sold plugin to the newest version this site is licensed for. Called by the Update
 * button's route and by nothing else (`tests/updateRelease.test.mjs` pins that): an update is a deliberate act,
 * unlike the opt-in install of a plugin that is missing.
 */
export async function updateLicensedPlugin({ plugin, version = '', io, credentials = null, env = globalThis.process?.env || {}, fetchImpl = fetch, now = new Date(), chain = null, backup = 'auto', readInstalled = null }) {
  const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
  if (!isLicenseLinked(row)) throw new LicenseLinkError(409, 'This site is not connected to a react-wp.com account.', 'not_connected');
  requireSecretBox(env);
  let token;
  try {
    token = openSecret(row.token_sealed, { env });
  } catch (error) {
    throw new LicenseLinkError(503, error instanceof Error ? error.message : `The stored site token could not be opened with ${SECRET_BOX_KEY_ENV}.`, 'token_unreadable');
  }
  // A plugin bought from a developer's own shop updates from that shop, with the shop's signature (server/developerPackages.mjs).
  const developer = developerEntryFor(row, plugin);
  let result;
  if (developer) {
    const { updateDeveloperPlugin } = await import('./developerPackages.mjs');
    result = await updateDeveloperPlugin({ entry: developer, domain: row.domain, version, io, credentials, now, fetchImpl, chain, backup, readInstalled });
  } else {
    const { updateSoldPlugin } = await import('./pluginAutoInstall.mjs');
    result = await updateSoldPlugin({ plugin, version, token, domain: row.domain, baseUrl: licenseLinkBase(env), io, credentials, now, fetchImpl, licensedIds: Object.keys(row.latest_versions || {}), chain, backup, readInstalled });
  }
  await rememberRollback({ io, plugin: str(plugin), result, now });
  return result;
}

/** Keeps the version an update replaced, for "Roll back". A failure here never fails the update that already landed. */
async function rememberRollback({ io, plugin, result, now }) {
  const point = pointAfterUpdate(result, now);
  if (!point) return;
  try {
    const current = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
    await io.write(LICENSE_LINK_CONFIG_KEY, { ...current, rollback_points: { ...current.rollback_points, [plugin]: point } });
  } catch {
    // The plugin was updated; only the way back is not offered.
  }
}

/**
 * Puts a licensed plugin back to the version its last update replaced (Plugins → Roll back). Called by that button's route only.
 */
export async function rollbackLicensedPlugin({ plugin, io }) {
  const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
  const id = str(plugin);
  const point = row.rollback_points[id];
  if (!point) throw new LicenseLinkError(404, `There is no earlier version of ${id || 'this plugin'} kept to go back to. A rollback is offered after an update made from this screen.`, 'no_rollback');
  const { GITHUB_CONFIG_KEY } = await import('./pluginAutoInstall.mjs');
  const { rollbackPlugin, githubTargetFrom } = await import('./pluginRollback.mjs');
  let target;
  try {
    target = githubTargetFrom(await io.read(GITHUB_CONFIG_KEY));
  } catch {
    throw new LicenseLinkError(501, 'Connect GitHub and Vercel under Settings → Integrations first, then try again.', 'no_github');
  }
  const result = await rollbackPlugin({ plugin: id, point, target });
  const rest = { ...row.rollback_points };
  delete rest[id];
  await io.write(LICENSE_LINK_CONFIG_KEY, { ...row, rollback_points: rest }).catch(() => {});
  return result;
}

/**
 * Installs one purchased sold plugin that this site does not have yet, for the Install button on My Purchases and
 * on a Marketplace card. Called by that button's route and nothing else (`tests/updateRelease.test.mjs`).
 */
export async function installLicensedPlugin({ plugin, version = '', io, credentials = null, env = globalThis.process?.env || {}, fetchImpl = fetch, now = new Date() }) {
  const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
  if (!isLicenseLinked(row)) {
    throw new LicenseLinkError(409, 'Connect this site to your react-wp.com account first (Plugins → Connect to react-wp.com), then install it here.', 'not_connected');
  }
  requireSecretBox(env);
  let token;
  try {
    token = openSecret(row.token_sealed, { env });
  } catch (error) {
    throw new LicenseLinkError(503, error instanceof Error ? error.message : `The stored site token could not be opened with ${SECRET_BOX_KEY_ENV}.`, 'token_unreadable');
  }
  const developer = developerEntryFor(row, plugin);
  if (developer) {
    const { installDeveloperPlugin } = await import('./developerPackages.mjs');
    return installDeveloperPlugin({ entry: developer, domain: row.domain, version, io, credentials, now, fetchImpl });
  }
  const { installSoldPlugin } = await import('./pluginAutoInstall.mjs');
  return installSoldPlugin({ plugin, version, token, domain: row.domain, baseUrl: licenseLinkBase(env), io, credentials, now, fetchImpl, licensedIds: Object.keys(row.latest_versions || {}) });
}

/** Turns the automatic install of assigned plugins on or off. Everything else on the row stays as it is. */
export async function setAutoInstall({ io, enabled }) {
  const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
  if (!isLicenseLinked(row)) throw new LicenseLinkError(409, 'This site is not connected to a react-wp.com account.', 'not_connected');
  // The stored ETag is dropped so the next sync asks for the full answer: a "nothing changed" reply would
  // otherwise hide the plugins that were waiting for this switch.
  await io.write(LICENSE_LINK_CONFIG_KEY, { ...row, auto_install: enabled === true, etag: '' });
  return enabled === true;
}

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Which of the platform's keys to store: a key that verifies on this site for a sold plugin, and beats the
 * one held (a later last day, or the held one is not valid). Pure, so the "never make it worse" rule is tested.
 *
 * @returns {{ next: Record<string, string>, updated: string[], ignored: number }}
 */
export function mergeDeliveredKeys({ delivered, held, now = new Date() }) {
  const next = { ...held };
  const updated = [];
  let ignored = 0;
  for (const item of Array.isArray(delivered) ? delivered : []) {
    const plugin = str(item?.plugin);
    const key = str(item?.key);
    if (!SAFE_PLUGIN_ID.test(plugin) || !isCommercialPlugin(plugin) || !key) { ignored += 1; continue; }
    const incoming = pluginLicenseState({ pluginId: plugin, key, now });
    // `grace` is a verified key past its last day: still verifies, still honoured, but never *better*.
    if (!incoming.licensed) { ignored += 1; continue; }
    const current = pluginLicenseState({ pluginId: plugin, key: held[plugin], now });
    const better = !current.licensed || (incoming.status === 'licensed' && incoming.expiresOn > current.expiresOn)
      || (current.status === 'grace' && incoming.status === 'licensed');
    if (better && key !== held[plugin]) {
      next[plugin] = key;
      updated.push(plugin);
    }
  }
  return { next, updated, ignored };
}

/**
 * One sync. `licenseIo.read()` / `licenseIo.write(next)` are the licence option; `io` the settings rows.
 * Records the outcome on the row either way, and returns what a screen can say.
 */
export async function syncLicenses({ io, licenseIo, credentials = null, env = globalThis.process?.env || {}, fetchImpl = fetch, now = new Date() }) {
  const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
  if (!isLicenseLinked(row)) throw new LicenseLinkError(409, 'This site is not connected to a react-wp.com account.', 'not_connected');
  requireSecretBox(env);
  let token;
  try {
    token = openSecret(row.token_sealed, { env });
  } catch (error) {
    throw new LicenseLinkError(503, error instanceof Error ? error.message : `The stored site token could not be opened with ${SECRET_BOX_KEY_ENV}.`, 'token_unreadable');
  }

  const record = async (patch, message, ok) => {
    await io.write(LICENSE_LINK_CONFIG_KEY, {
      ...row,
      ...patch,
      last_attempt_at: now.toISOString(),
      last_result: { ok, message, at: now.toISOString() },
    }).catch(() => {});
  };

  let response;
  try {
    response = await centralFetch(`${licenseLinkBase(env)}/sync`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-RWP-Site': row.domain,
        ...(row.etag ? { 'If-None-Match': row.etag } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { fetchImpl });
  } catch (error) {
    const message = `react-wp.com could not be reached: ${error instanceof Error ? error.message : 'network error'}.`;
    await record({}, message, false);
    throw new LicenseLinkError(502, message, 'unreachable');
  }

  if (response.status === 304) {
    await record({ last_sync_at: now.toISOString() }, 'Up to date: nothing changed on react-wp.com.', true);
    return { changed: false, updated: [], message: 'Up to date: nothing changed on react-wp.com.' };
  }
  if (!response.ok) {
    const platform = await platformMessage(response);
    const message = response.status === 401
      ? `react-wp.com no longer accepts this connection (${platform}) Connect the site again with a new code.`
      // Only what the customer can act on is passed on. Anything else is react-wp.com's own business and is not
      // forwarded word for word (it may name its configuration).
      : response.status === 429 ? `react-wp.com asks this site to wait: ${platform}` : 'react-wp.com could not complete the check just now. It tries again by itself.';
    await record({}, message, false);
    throw new LicenseLinkError(response.status === 429 ? 429 : 502, message, response.status === 401 ? 'disconnected' : 'refused');
  }

  const answer = await response.json().catch(() => null);
  if (!answer || !Array.isArray(answer.licenses)) {
    await record({}, 'react-wp.com could not complete the check just now. It tries again by itself.', false);
    throw new LicenseLinkError(502, 'react-wp.com could not complete the check just now. It tries again by itself.', 'bad_answer');
  }
  const held = readPluginLicenses(await licenseIo.read());
  const { next, updated, ignored } = mergeDeliveredKeys({ delivered: answer.licenses, held, now });
  if (updated.length) await licenseIo.write(next);
  const message = updated.length
    ? `Updated ${updated.length} key${updated.length === 1 ? '' : 's'}: ${updated.join(', ')}.`
    : `Checked ${answer.licenses.length} key${answer.licenses.length === 1 ? '' : 's'}: the keys on this site are already current${ignored ? ` (${ignored} ignored)` : ''}.`;

  // Plugins the customer assigned to this site. The ONLY automatic commit this site makes: it needs the owner's
  // consent on the connection (`auto_install`), credentials to read GitHub and the options (`credentials`), and
  // it is handled in `pluginAutoInstall.mjs`, loaded only now so the sync itself stays light.
  let install = { complete: true, installed: [], message: '' };
  if (row.auto_install && credentials && Array.isArray(answer.installs) && answer.installs.length) {
    try {
      const { autoInstallAssigned } = await import('./pluginAutoInstall.mjs');
      install = await autoInstallAssigned({
        installs: answer.installs, token, domain: row.domain, baseUrl: licenseLinkBase(env), io, credentials, now, fetchImpl,
      });
    } catch (error) {
      install = { complete: false, installed: [], message: `Assigned plugins were not installed: ${error instanceof Error ? error.message : 'unexpected error'}.` };
    }
  }
  const fullMessage = [message, install.message].filter(Boolean).join(' ');
  // The ETag is kept only after the keys it describes were stored and every assigned plugin was handled, so a
  // failed write or install is fetched (and tried) again instead of being answered "unchanged".
  await record(
    {
      last_sync_at: now.toISOString(),
      etag: install.complete ? str(response.headers.get('etag')) : '',
      // Kept as it was when an older platform sends no list.
      ...(Array.isArray(answer.latest) ? { latest_versions: latestVersionsFrom(answer.latest) } : {}),
      ...(Array.isArray(answer.developer_licenses) ? { developer_licenses: developerLicensesFrom(answer.developer_licenses) } : {}),
    },
    fullMessage,
    install.complete,
  );
  return { changed: updated.length > 0, updated, installed: install.installed.map((row) => row.plugin), message: fullMessage };
}

// ---------------------------------------------------------------------------------------------------
// Developer requests: a plugin acting for this site's owner on react-wp.com

/** The only platform paths `platformRequest` may call: the developer listing routes, nothing that delivers keys or packages. */
const DEVELOPER_PATH = /^developer\/[a-z-]{1,40}$/;
/** The buyer paths the Plugins screen itself calls (`accountRequest`): claim a developer key, see and change this site's seats. */
const BUYER_PATH = /^buyer\/(claim|seats|seat)$/;

/**
 * One request from the Plugins screen to react-wp.com as the connected account's buyer (claim a developer key, use or free a seat
 * for this site). Called only from `server/licenseLinkRoutes.mjs`, which the platform owner reaches; a plugin uses
 * `platformRequest`, which cannot reach these paths.
 */
export async function accountRequest({ io, path, method = 'GET', body, env = globalThis.process?.env || {}, fetchImpl = fetch }) {
  if (!BUYER_PATH.test(String(path || ''))) throw new LicenseLinkError(400, 'That react-wp.com address is not one this screen may call.', 'bad_platform_path');
  return platformRequest({ io, path, method, body, env, fetchImpl, timeoutMs: 20_000, allow: BUYER_PATH });
}

/**
 * One request from this site to react-wp.com in the connected account's name (RWP Developers sending a plugin to the
 * marketplace). The sealed site token is opened here and sent only to `licenseLinkBase(env)`; it is never returned.
 * `path` must be a `developer/...` route. `body` may be a FormData (the package) or a plain object (sent as JSON).
 * A 4xx answer's own sentence is passed on, because these routes tell the developer what to fix in their own plugin
 * (a scan finding, an id that is taken); a 5xx or an unreachable platform is one neutral sentence.
 *
 * @returns {Promise<{ status: number, body: any, domain: string }>}
 */
export async function platformRequest({ io, path, method = 'GET', body, env = globalThis.process?.env || {}, fetchImpl = fetch, timeoutMs = 60_000, allow = DEVELOPER_PATH }) {
  // `allow` is DEVELOPER_PATH for plugins; only `accountRequest` passes BUYER_PATH, and a plugin cannot widen it past these two.
  const pattern = allow === BUYER_PATH ? BUYER_PATH : DEVELOPER_PATH;
  if (!pattern.test(String(path || ''))) throw new LicenseLinkError(400, 'That react-wp.com address is not one a plugin may call.', 'bad_platform_path');
  const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
  if (!isLicenseLinked(row)) {
    throw new LicenseLinkError(409, 'This site is not connected to a react-wp.com account. Connect it under Plugins → Connect to react-wp.com, then try again.', 'not_connected');
  }
  requireSecretBox(env);
  let token;
  try {
    token = openSecret(row.token_sealed, { env });
  } catch (error) {
    throw new LicenseLinkError(503, error instanceof Error ? error.message : `The stored site token could not be opened with ${SECRET_BOX_KEY_ENV}.`, 'token_unreadable');
  }
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let response;
  try {
    response = await centralFetch(`${licenseLinkBase(env)}/${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-RWP-Site': row.domain,
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    }, { fetchImpl });
  } catch (error) {
    throw new LicenseLinkError(502, `react-wp.com could not be reached: ${error instanceof Error ? error.message : 'network error'}.`, 'unreachable');
  }
  if (response.status === 401) {
    throw new LicenseLinkError(401, `react-wp.com no longer accepts this connection (${await platformMessage(response)}) Connect the site again with a new code.`, 'disconnected');
  }
  if (response.status >= 400 && response.status < 500) {
    throw new LicenseLinkError(response.status, await platformMessage(response), 'refused');
  }
  if (!response.ok) throw new LicenseLinkError(502, 'react-wp.com could not complete the request just now. Try again later.', 'refused');
  return { status: response.status, body: await response.json().catch(() => ({})), domain: row.domain };
}

// ---------------------------------------------------------------------------------------------------
// The licence option, with whichever credential the caller has

const restBase = (supabaseUrl) => String(supabaseUrl || '').replace(/\/+$/, '');

/**
 * Read and write `rwp_plugin_licenses` through PostgREST. `accessToken` is an administrator's own session
 * (so RLS decides) or the server's secret key (the daily run). The write is verified by the row it returns:
 * an RLS refusal can answer 2xx with no rows, and reporting success then would be a lie.
 */
export function licenseOptionIo({ supabaseUrl, apiKey, accessToken, fetchImpl = fetch }) {
  const base = restBase(supabaseUrl);
  const headers = { apikey: apiKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  return {
    async read() {
      const response = await fetchImpl(`${base}/rest/v1/options?option_name=eq.${PLUGIN_LICENSES_OPTION}&select=option_value`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new LicenseLinkError(502, `The licence keys could not be read (HTTP ${response.status}).`, 'option_unreadable');
      const rows = await response.json().catch(() => []);
      return Array.isArray(rows) && rows[0] ? rows[0].option_value : null;
    },
    async write(next) {
      const response = await fetchImpl(`${base}/rest/v1/options?on_conflict=option_name`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ option_name: PLUGIN_LICENSES_OPTION, option_value: JSON.stringify(next) }),
        signal: AbortSignal.timeout(15_000),
      });
      const rows = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(rows) || rows.length !== 1) {
        throw new LicenseLinkError(403, `The licence keys were not saved (HTTP ${response.status}). Your role needs permission to manage options.`, 'option_unwritable');
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The automatic daily run

let backgroundState = { checkedAt: 0, inflight: null };
const BACKGROUND_CHECK_MS = 10 * 60 * 1000;

/**
 * Starts the daily sync when it is due. Called (not awaited) after the licence option was read; never
 * throws and never blocks a request. Needs the server's secret key, the secret box and a connected row;
 * with any of them missing it does nothing - the site is then synced by "Sync now".
 *
 * @returns {Promise<{ ran: boolean, reason?: string, changed?: boolean }>}
 */
export function backgroundLicenseSync({ supabaseUrl, secretKey, env = globalThis.process?.env || {}, fetchImpl = fetch, now = new Date() }) {
  if (backgroundState.inflight) return backgroundState.inflight;
  if (now.getTime() - backgroundState.checkedAt < BACKGROUND_CHECK_MS) return Promise.resolve({ ran: false, reason: 'checked recently' });
  backgroundState.checkedAt = now.getTime();
  if (!supabaseUrl || !secretKey || !safeSecretBoxEnabled(env)) return Promise.resolve({ ran: false, reason: 'not configured' });

  backgroundState.inflight = (async () => {
    try {
      const io = settingsIo({ supabaseUrl, supabaseKey: secretKey, accessToken: secretKey, fetchImpl });
      const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
      if (!isLicenseLinked(row)) return { ran: false, reason: 'not connected' };
      if (!isSyncDue({ seed: row.token_fingerprint || row.domain, lastSyncAt: row.last_sync_at, lastAttemptAt: row.last_attempt_at, now })) {
        return { ran: false, reason: 'not due' };
      }
      const licenseIo = licenseOptionIo({ supabaseUrl, apiKey: secretKey, accessToken: secretKey, fetchImpl });
      const credentials = { supabaseUrl, apiKey: secretKey, accessToken: secretKey };
      const result = await syncLicenses({ io, licenseIo, credentials, env, fetchImpl, now });
      return { ran: true, changed: result.changed };
    } catch (error) {
      // The outcome is already on the row; the log carries the sentence, never a token or key.
      console.error('The daily licence sync did not complete:', error instanceof Error ? error.message : String(error));
      return { ran: true, reason: 'failed' };
    } finally {
      backgroundState.inflight = null;
    }
  })();
  return backgroundState.inflight;
}

/** For tests: forget the in-process throttle. */
export const resetBackgroundLicenseSync = () => { backgroundState = { checkedAt: 0, inflight: null }; };

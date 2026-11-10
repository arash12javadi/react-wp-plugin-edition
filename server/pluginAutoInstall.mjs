/**
 * Automatic install of the plugins a customer assigned to this site on react-wp.com.
 *
 * Called from `syncLicenses` (`server/licenseLink.mjs`) and nowhere else, and only when the site owner left
 * "Install my assigned plugins automatically" ticked on the connection (`auto_install`). It is the one place
 * where something reaches this site's repository without a button being pressed for that exact change, so it
 * is deliberately narrow:
 *
 *   - only the four sold plugins (`COMMERCIAL_PLUGIN_ADDONS`), by a safe id;
 *   - only a plugin that is not in the repository yet. An update, or a plugin already there, is never touched
 *     (`applyPluginUpdate` still refuses sold plugins);
 *   - nothing is committed until the package verified: its description is signed by react-wp.com's package
 *     key for THIS site's host, the exact plugin and version, and the sha256 of the bytes that were downloaded
 *     (`server/packageCrypto.mjs`);
 *   - the commit is the installer's own (`installPluginFromGit`): one commit, the plugin arrives inactive, the
 *     deployment is reported as pending until Vercel says READY.
 *
 * It never throws. Every refusal is a sentence in `message` that names what to fix, and `complete: false`,
 * which makes the caller forget its ETag so the next sync tries again instead of answering "unchanged".
 */
import { COMMERCIAL_PLUGIN_ADDONS } from '../src/lib/pluginLicense.js';
import { centralFetch } from './centralFetch.mjs';
import { packagePublicKey, sha256Hex, verifyPackage } from './packageCrypto.mjs';
import { InstallError, downloadZip } from './pluginInstaller.mjs';
import { compareVersions } from './versions.mjs';
import { githubTargetFrom } from './pluginGitPush.mjs';
import { installPluginFromGit } from './pluginGitInstaller.mjs';
import { assertPackageMatches, installedPluginVersions } from './pluginUpdates.mjs';

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_TIMEOUT_MS = 20_000;
/** No new plugin is started after this long into one run (a Vercel function is cut off at about 60 s). */
const RUN_BUDGET_MS = 30_000;
export const GITHUB_CONFIG_KEY = 'github_config';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * What a client is told when the cause is on react-wp.com's side (the package key is not set, a signature does not
 * verify, the description is wrong, the platform answered 5xx). The client can do nothing about any of those, and the
 * names of the vendor's keys are none of their business: they get one calm sentence, and the vendor sees the real
 * state on their own dashboard ("Finish setting up").
 */
export const NOT_READY = 'This plugin cannot be installed from here right now. Please try again later.';
/** A failure the vendor must fix: shown to clients as `NOT_READY`, and silent during a sync. */
class NotReadyError extends Error {}

/**
 * `getOption` / `setOption` over PostgREST on `public.options`, the two calls the installer pins
 * `rwp_active_plugins` with (so the new plugin arrives inactive). The credential is whoever started the sync:
 * an administrator's own session, or the server's secret key for the daily run.
 */
export function optionStoreFrom({ supabaseUrl, apiKey, accessToken, fetchImpl = fetch }) {
  const base = str(supabaseUrl).replace(/\/+$/, '');
  const headers = { apikey: apiKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  return {
    async getOption(name) {
      const response = await fetchImpl(`${base}/rest/v1/options?option_name=eq.${encodeURIComponent(name)}&select=option_value`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = await response.json().catch(() => []);
      if (!Array.isArray(rows) || !rows[0]) return null;
      try {
        return JSON.parse(rows[0].option_value);
      } catch {
        return rows[0].option_value;
      }
    },
    async setOption(name, value) {
      const response = await fetchImpl(`${base}/rest/v1/options?on_conflict=option_name`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ option_name: name, option_value: JSON.stringify(value) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    },
  };
}

/** The platform's signed description of one package, or a sentence for why there is none. */
async function fetchPackageDescription({ baseUrl, token, domain, id, mode = 'install', fetchImpl }) {
  let response;
  try {
    response = await centralFetch(`${baseUrl}/package?plugin=${encodeURIComponent(id)}${mode === 'update' ? '&mode=update' : ''}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-RWP-Site': domain, 'X-RWP-Plugin': id,
        ...(mode === 'update' ? { 'X-RWP-Mode': 'update' } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { fetchImpl });
  } catch (error) {
    throw new Error(`react-wp.com could not be reached for ${id}: ${error instanceof Error ? error.message : 'network error'}.`);
  }
  const body = await response.json().catch(() => null);
  // A refusal the customer can act on (not licensed, not assigned, renew) is passed on; anything the vendor must fix is not.
  if (!response.ok) throw response.status >= 500 || !str(body?.error) ? new NotReadyError(NOT_READY) : new Error(str(body.error));
  return body;
}

/**
 * Asks for one package and proves it before anything is committed: the platform's description must name this
 * plugin and the expected version, its signature must verify for THIS site's host, and the downloaded bytes
 * must have the signed sha256. Throws a sentence on any failure; returns the verified zip.
 */
async function fetchVerifiedPackage({ id, wantedVersion, mode, baseUrl, token, domain, publicKey, now, fetchImpl, d }) {
  const description = await fetchPackageDescription({ baseUrl, token, domain, id, mode, fetchImpl });
  const sha256 = str(description?.sha256).toLowerCase();
  const version = str(description?.version);
  if (str(description?.plugin) !== id || (wantedVersion && version !== wantedVersion) || !version || !SHA256.test(sha256) || !str(description?.url)) {
    throw new NotReadyError(NOT_READY);
  }
  const verdict = verifyPackage({ pluginId: id, version, domain, sha256, exp: str(description?.exp), sig: str(description?.sig) }, { publicKey, now });
  if (verdict !== 'ok') {
    throw new NotReadyError(NOT_READY);
  }
  const zip = await d.downloadZip(str(description.url));
  if (sha256Hex(zip) !== sha256) {
    throw new NotReadyError(NOT_READY);
  }
  d.assertPackageMatches({ zip, id, version });
  return { zip, version };
}

/**
 * @param {object} input
 * @param {Array<{ plugin: string, version: string }>} input.installs  what the platform says this site should have
 * @param {string} input.token       this site's token (never logged or returned)
 * @param {string} input.domain      this site's own host, as it connected
 * @param {string} input.baseUrl     the platform's licence API base (`licenseLinkBase`)
 * @param {{ read: (key: string) => Promise<unknown> }} input.io  the settings rows, for `github_config`
 * @param {{ supabaseUrl: string, apiKey: string, accessToken: string }} input.credentials  for `rwp_active_plugins`
 * @param {object} [input.deps]      test seams: `installedPluginVersions`, `installPluginFromGit`, `downloadZip`,
 *                                   `githubTargetFrom`, `assertPackageMatches`, `publicKey`
 * @returns {Promise<{ complete: boolean, installed: Array<{ plugin: string, version: string, sha: string }>, message: string }>}
 */
export async function autoInstallAssigned({ installs, token, domain, baseUrl, io, credentials, now = new Date(), fetchImpl = fetch, deps = {} }) {
  const d = {
    installedPluginVersions, installPluginFromGit, downloadZip, githubTargetFrom, assertPackageMatches, ...deps,
  };
  const wanted = (Array.isArray(installs) ? installs : [])
    .map((item) => ({ plugin: str(item?.plugin), version: str(item?.version) }))
    .filter((item) => SAFE_PLUGIN_ID.test(item.plugin) && Object.hasOwn(COMMERCIAL_PLUGIN_ADDONS, item.plugin) && item.version);
  if (!wanted.length) return { complete: true, installed: [], message: '' };

  // Without a package key this release cannot verify anything, which is the safe direction: install nothing.
  const publicKey = deps.publicKey ?? packagePublicKey();
  if (!publicKey) {
    // Silent on purpose: the missing key is the vendor's to set, and the next sync tries again.
    return { complete: false, installed: [], message: '' };
  }

  let target;
  try {
    target = d.githubTargetFrom(await io.read(GITHUB_CONFIG_KEY));
  } catch (error) {
    return { complete: false, installed: [], message: 'Your purchased plugins are waiting: connect GitHub and Vercel under Settings → Integrations and they install by themselves.' };
  }

  let present;
  try {
    present = new Set((await d.installedPluginVersions(target)).map((row) => row.id));
  } catch (error) {
    return { complete: false, installed: [], message: `Plugins assigned to this site were not installed: the repository could not be read (${error instanceof Error ? error.message : 'unknown error'}).` };
  }

  const optionStore = credentials?.supabaseUrl ? optionStoreFrom({ ...credentials, fetchImpl }) : null;
  const installed = [];
  const failures = [];
  const later = [];
  let vendorSide = false;
  const startedAt = Date.now();
  for (const item of wanted) {
    if (present.has(item.plugin)) continue;
    // A serverless function is cut off after about a minute, and each plugin is a download plus a commit. What
    // does not fit is left for the next sync, which the caller is told about by `complete: false`.
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      later.push(item.plugin);
      continue;
    }
    try {
      const { zip, version } = await fetchVerifiedPackage({
        id: item.plugin, wantedVersion: item.version, mode: 'install', baseUrl, token, domain, publicKey, now, fetchImpl, d,
      });
      const result = await d.installPluginFromGit({
        source: { zip }, target, optionStore, deployHook: '', expectedId: item.plugin, gitDeploys: true,
      });
      installed.push({ plugin: item.plugin, version, name: str(result?.plugin?.name) || item.plugin, sha: str(result?.commit?.sha).slice(0, 7) });
      present.add(item.plugin);
    } catch (error) {
      if (error instanceof NotReadyError) vendorSide = true;
      else failures.push(`${item.plugin}: ${error instanceof Error ? error.message : 'the install failed'}`);
    }
  }

  const parts = [];
  if (installed.length) {
    parts.push(`Installed ${installed.map((row) => `${row.name} ${row.version}${row.sha ? ` (commit ${row.sha})` : ''}`).join(', ')}. Vercel is deploying ${installed.length === 1 ? 'it' : 'them'}; activate ${installed.length === 1 ? 'it' : 'them'} under Plugins when the deployment finishes.`);
  }
  if (failures.length) parts.push(`Not installed: ${failures.join(' ')}`);
  if (later.length) parts.push(`Still to install on the next sync: ${later.join(', ')}.`);
  return { complete: failures.length === 0 && later.length === 0 && !vendorSide, installed, message: parts.join(' ') };
}

/**
 * Updates one sold plugin that is already installed, to the newest version react-wp.com licenses this site
 * for. Called only from the Update button's route (`POST /api/admin/license-link/update`), never from a sync.
 *
 * The same proof as the first install (signature for this site's host, sha256 of the bytes), plus the rules of
 * an update: the plugin must already be in the repository, the new version must be newer (never a downgrade),
 * and it must be the version the screen showed. The commit is the installer's own: it replaces only
 * `plugins/<id>/` and that plugin's line in `server/plugins.mjs`, and the deployment is `pending` until Vercel
 * says READY.
 *
 * Unlike the sync's install this throws: the owner pressed a button and is owed the real reason.
 *
 * @returns {Promise<object>} what `installPluginFromGit` answers, plus `update: { id, from, to }`
 */
export async function updateSoldPlugin({ plugin, version = '', token, domain, baseUrl, io, credentials, now = new Date(), fetchImpl = fetch, deps = {} }) {
  const d = {
    installedPluginVersions, installPluginFromGit, downloadZip, githubTargetFrom, assertPackageMatches, ...deps,
  };
  const id = str(plugin);
  if (!SAFE_PLUGIN_ID.test(id) || !Object.hasOwn(COMMERCIAL_PLUGIN_ADDONS, id)) {
    throw new InstallError('Only the sold plugins are updated from react-wp.com. Free plugins update from their own releases under Plugins → Plugin updates.', 400);
  }
  const publicKey = deps.publicKey ?? packagePublicKey();
  if (!publicKey) {
    throw new InstallError(NOT_READY, 503);
  }
  let target;
  try {
    target = d.githubTargetFrom(await io.read(GITHUB_CONFIG_KEY));
  } catch {
    throw new InstallError('Connect GitHub and Vercel under Settings → Integrations first, then try again.', 501);
  }
  const present = (await d.installedPluginVersions(target)).find((row) => row.id === id);
  if (!present) {
    throw new InstallError(`"${id}" is not in ${target.owner}/${target.repo}, so there is nothing to update. Install it first.`, 404);
  }

  let verified;
  try {
    verified = await fetchVerifiedPackage({
      id, wantedVersion: str(version), mode: 'update', baseUrl, token, domain, publicKey, now, fetchImpl, d,
    });
  } catch (error) {
    throw new InstallError(error instanceof Error ? error.message : 'The package could not be fetched.', 502);
  }
  if (compareVersions(verified.version, present.version) <= 0) {
    throw new InstallError(`${id} ${present.version} is already installed; ${verified.version} is not newer, and a plugin is never downgraded from here.`, 409);
  }
  const optionStore = credentials?.supabaseUrl ? optionStoreFrom({ ...credentials, fetchImpl }) : null;
  const result = await d.installPluginFromGit({
    source: { zip: verified.zip }, target, optionStore, deployHook: '', expectedId: id, gitDeploys: true,
  });
  return { ...result, update: { id, from: present.version, to: verified.version } };
}

/**
 * Installs one sold plugin that is NOT in the repository yet: the button on My Purchases and on a Marketplace card.
 * Called only from `POST /api/admin/license-link/install`, so it is a click, never a sync. It is the same proof as
 * the automatic install (a package signed for this site's host, its sha256, the installer's own one commit) and,
 * unlike it, throws the real reason, because someone pressed a button and is owed it. A plugin that is already in
 * the repository is refused (that is an update, with its own button); a free plugin is not installed from here.
 *
 * @returns {Promise<object>} what `installPluginFromGit` answers, plus `install: { id, version }`
 */
export async function installSoldPlugin({ plugin, version = '', token, domain, baseUrl, io, credentials, now = new Date(), fetchImpl = fetch, deps = {} }) {
  const d = {
    installedPluginVersions, installPluginFromGit, downloadZip, githubTargetFrom, assertPackageMatches, ...deps,
  };
  const id = str(plugin);
  if (!SAFE_PLUGIN_ID.test(id) || !Object.hasOwn(COMMERCIAL_PLUGIN_ADDONS, id)) {
    throw new InstallError('Only the plugins sold on react-wp.com are installed from here. A free plugin is added from Plugins → Upload.', 400);
  }
  const publicKey = deps.publicKey ?? packagePublicKey();
  if (!publicKey) {
    throw new InstallError(NOT_READY, 503);
  }
  let target;
  try {
    target = d.githubTargetFrom(await io.read(GITHUB_CONFIG_KEY));
  } catch (error) {
    throw new InstallError(`Connect GitHub and Vercel under Settings → Integrations first. (${error instanceof Error ? error.message : 'The GitHub connection could not be read.'})`, 501);
  }
  const present = (await d.installedPluginVersions(target)).find((row) => row.id === id);
  if (present) {
    throw new InstallError(`${id} ${present.version} is already installed on this site. Use Update when a newer version is available.`, 409);
  }
  let verified;
  try {
    verified = await fetchVerifiedPackage({
      id, wantedVersion: str(version), mode: 'install', baseUrl, token, domain, publicKey, now, fetchImpl, d,
    });
  } catch (error) {
    throw new InstallError(error instanceof Error ? error.message : 'The package could not be fetched.', 502);
  }
  const optionStore = credentials?.supabaseUrl ? optionStoreFrom({ ...credentials, fetchImpl }) : null;
  const result = await d.installPluginFromGit({
    source: { zip: verified.zip }, target, optionStore, deployHook: '', expectedId: id, gitDeploys: true,
  });
  return { ...result, install: { id, version: verified.version } };
}

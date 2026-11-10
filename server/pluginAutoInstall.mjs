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
import { downloadZip } from './pluginInstaller.mjs';
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
async function fetchPackageDescription({ baseUrl, token, domain, id, fetchImpl }) {
  let response;
  try {
    response = await centralFetch(`${baseUrl}/package?plugin=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-RWP-Site': domain, 'X-RWP-Plugin': id },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, { fetchImpl });
  } catch (error) {
    throw new Error(`react-wp.com could not be reached for ${id}: ${error instanceof Error ? error.message : 'network error'}.`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(str(body?.error) || `react-wp.com refused to hand over ${id} (HTTP ${response.status}).`);
  return body;
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
    return { complete: false, installed: [], message: 'Plugins assigned to this site were not installed: this release has no package verification key yet, so it cannot check them. Update React-WP, or upload the plugin by hand.' };
  }

  let target;
  try {
    target = d.githubTargetFrom(await io.read(GITHUB_CONFIG_KEY));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The GitHub connection could not be read.';
    return { complete: false, installed: [], message: `Plugins assigned to this site were not installed. Connect GitHub and Vercel under Settings → Integrations first. (${reason})` };
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
      const description = await fetchPackageDescription({ baseUrl, token, domain, id: item.plugin, fetchImpl });
      const sha256 = str(description?.sha256).toLowerCase();
      const version = str(description?.version);
      if (str(description?.plugin) !== item.plugin || version !== item.version || !SHA256.test(sha256) || !str(description?.url)) {
        throw new Error('react-wp.com described a different package than the one asked for, so it was not installed.');
      }
      const verdict = verifyPackage({ pluginId: item.plugin, version, domain, sha256, exp: str(description?.exp), sig: str(description?.sig) }, { publicKey, now });
      if (verdict !== 'ok') {
        throw new Error(verdict === 'expired'
          ? 'The package description had already expired. It will be asked for again on the next sync.'
          : `The package signature for ${item.plugin} did not verify (${verdict}), so nothing was committed.`);
      }
      const zip = await d.downloadZip(str(description.url));
      if (sha256Hex(zip) !== sha256) {
        throw new Error(`The downloaded ${item.plugin} does not match the signed checksum, so nothing was committed.`);
      }
      d.assertPackageMatches({ zip, id: item.plugin, version });
      const result = await d.installPluginFromGit({
        source: { zip }, target, optionStore, deployHook: '', expectedId: item.plugin, gitDeploys: true,
      });
      installed.push({ plugin: item.plugin, version, name: str(result?.plugin?.name) || item.plugin, sha: str(result?.commit?.sha).slice(0, 7) });
      present.add(item.plugin);
    } catch (error) {
      failures.push(`${item.plugin}: ${error instanceof Error ? error.message : 'the install failed'}`);
    }
  }

  const parts = [];
  if (installed.length) {
    parts.push(`Installed ${installed.map((row) => `${row.name} ${row.version}${row.sha ? ` (commit ${row.sha})` : ''}`).join(', ')}. Vercel is deploying ${installed.length === 1 ? 'it' : 'them'}; activate ${installed.length === 1 ? 'it' : 'them'} under Plugins when the deployment finishes.`);
  }
  if (failures.length) parts.push(`Not installed: ${failures.join(' ')}`);
  if (later.length) parts.push(`Still to install on the next sync: ${later.join(', ')}.`);
  return { complete: failures.length === 0 && later.length === 0, installed, message: parts.join(' ') };
}

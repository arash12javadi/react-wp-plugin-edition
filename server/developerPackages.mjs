/**
 * Installing and updating a plugin bought from a developer's own shop (RWP Developers, RWPD1 licence keys), on the buyer's
 * connected site.
 *
 * The account link delivers, per developer purchase on the account, the key, the shop's domain and the shop's licence PUBLIC key
 * (`license_link_config.developer_licenses`, written by `syncLicenses` from react-wp.com's answer). The package itself never comes
 * from react-wp.com: the site asks the developer's shop (`POST https://<shop>/api/plugins/rwp-developers/package` with the key and
 * this site's host). The shop answers with a description signed by its licence key pair:
 *
 *     RWPDPKG1|<plugin>|<version>|<this site's host>|<sha256>|<expiry, ISO, 10 minutes>
 *
 * Nothing is committed until that signature verifies with the public key react-wp.com delivered (so a shop cannot be impersonated
 * by whoever answers on its domain without its private key), the description names this plugin and this host, the download's
 * sha256 equals the signed one, and the ZIP's manifest names the plugin and the version. Then the installer's own one commit.
 *
 * Both functions are reached only from the Install / Update buttons (`POST /api/admin/license-link/install|update`), never from
 * a sync or a timer (`tests/updateRelease.test.mjs`). They throw `InstallError` with a sentence the site owner can act on.
 */
import { verifyPayload } from './licenseCrypto.mjs';
import { sha256Hex } from './packageCrypto.mjs';
import { InstallError, downloadZip } from './pluginInstaller.mjs';
import { compareVersions } from './versions.mjs';
import { githubTargetFrom } from './pluginGitPush.mjs';
import { installPluginFromGit } from './pluginGitInstaller.mjs';
import { assertPackageMatches, installedPluginVersions } from './pluginUpdates.mjs';
import { optionStoreFrom, GITHUB_CONFIG_KEY } from './pluginAutoInstall.mjs';

export const DEVELOPER_PACKAGE_PREFIX = 'RWPDPKG1';
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The text a developer's shop signs for one package (`server/platformSync.mjs` in rwp-developers builds the same). */
export const developerPackagePayload = ({ plugin, version, domain, sha256, exp }) =>
  `${DEVELOPER_PACKAGE_PREFIX}|${plugin}|${version}|${String(domain || '').toLowerCase()}|${sha256}|${exp}`;

/**
 * `'ok'`, `'expired'` or `'bad'` for a description, checked against the shop's public key, this site's host and the clock.
 * Pure, so the rules are tested without a network.
 */
export function verifyDeveloperPackage(description, { plugin, domain, publicKey, now = new Date() }) {
  const sha256 = str(description?.sha256).toLowerCase();
  const version = str(description?.version);
  const exp = str(description?.exp);
  if (str(description?.plugin) !== plugin || !VERSION.test(version) || !SHA256.test(sha256) || str(description?.domain).toLowerCase() !== String(domain).toLowerCase()) return 'bad';
  const expires = Date.parse(exp);
  if (!Number.isFinite(expires)) return 'bad';
  let genuine = false;
  try {
    genuine = verifyPayload(developerPackagePayload({ plugin, version, domain, sha256, exp }), str(description?.sig), publicKey) === 'ok';
  } catch {
    genuine = false;
  }
  if (!genuine) return 'bad';
  return expires < now.getTime() ? 'expired' : 'ok';
}

/** Where a shop answers package requests; https, or http for a loopback shop a developer runs locally. */
export const developerPackageUrl = (shopDomain) => {
  const host = str(shopDomain).toLowerCase();
  if (!HOST.test(host)) return '';
  const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${loopback ? 'http' : 'https'}://${host}/api/plugins/rwp-developers/package`;
};

async function fetchVerified({ entry, domain, wantedVersion, now, fetchImpl, d }) {
  const url = developerPackageUrl(entry.seller_domain);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: entry.key, domain }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new InstallError(`${entry.seller_domain} could not be reached: ${error instanceof Error ? error.message : 'network error'}. Try again later.`, 502);
  }
  const description = await response.json().catch(() => null);
  if (!response.ok) {
    // The shop's own sentence (revoked, expired, used on another site) is about the buyer's licence, so it is passed on.
    throw new InstallError(str(description?.error) || `${entry.seller_domain} did not hand out the package (HTTP ${response.status}).`, response.status >= 500 ? 502 : 409);
  }
  const verdict = verifyDeveloperPackage(description, { plugin: entry.plugin, domain, publicKey: entry.public_key, now });
  if (verdict === 'expired') throw new InstallError('The package description from the developer\'s shop has expired. Try again.', 502);
  if (verdict !== 'ok') throw new InstallError(`The package from ${entry.seller_domain} is not signed by the key react-wp.com knows for that shop, so it was not installed.`, 502);
  const version = str(description.version);
  if (wantedVersion && version !== wantedVersion) throw new InstallError(`${entry.seller_domain} offered ${version}, not ${wantedVersion}. Check for updates again.`, 409);
  if (!/^https:\/\//i.test(str(description.url)) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(str(description.url))) {
    throw new InstallError('The developer\'s shop gave no secure download address.', 502);
  }
  const zip = await d.downloadZip(str(description.url));
  if (sha256Hex(zip) !== str(description.sha256).toLowerCase()) {
    throw new InstallError('The downloaded package does not match the checksum the developer\'s shop signed, so it was not installed.', 502);
  }
  d.assertPackageMatches({ zip, id: entry.plugin, version });
  return { zip, version };
}

const resolveTarget = async (io, d) => {
  try {
    return d.githubTargetFrom(await io.read(GITHUB_CONFIG_KEY));
  } catch (error) {
    throw new InstallError(`Connect GitHub and Vercel under Settings → Integrations first. (${error instanceof Error ? error.message : 'The GitHub connection could not be read.'})`, 501);
  }
};

/** Installs a developer plugin that is not in the repository yet. */
export async function installDeveloperPlugin({ entry, domain, version = '', io, credentials, now = new Date(), fetchImpl = fetch, deps = {} }) {
  const d = { installedPluginVersions, installPluginFromGit, downloadZip, githubTargetFrom, assertPackageMatches, ...deps };
  const target = await resolveTarget(io, d);
  const present = (await d.installedPluginVersions(target)).find((row) => row.id === entry.plugin);
  if (present) throw new InstallError(`${entry.plugin} ${present.version} is already installed on this site. Use Update when a newer version is available.`, 409);
  const verified = await fetchVerified({ entry, domain, wantedVersion: str(version), now, fetchImpl, d });
  const optionStore = credentials?.supabaseUrl ? optionStoreFrom({ ...credentials, fetchImpl }) : null;
  const result = await d.installPluginFromGit({
    source: { zip: verified.zip }, target, optionStore, deployHook: '', expectedId: entry.plugin, gitDeploys: true,
  });
  return { ...result, install: { id: entry.plugin, version: verified.version } };
}

/** Updates an installed developer plugin to the shop's current version (never a downgrade). */
export async function updateDeveloperPlugin({ entry, domain, version = '', io, credentials, now = new Date(), fetchImpl = fetch, deps = {}, chain = null, backup = 'auto', readInstalled = null }) {
  const d = { installedPluginVersions, installPluginFromGit, downloadZip, githubTargetFrom, assertPackageMatches, ...deps };
  let target = await resolveTarget(io, d);
  if (chain && `${target.owner}/${target.repo}@${target.branch}`.toLowerCase() !== `${chain.target.owner}/${chain.target.repo}@${chain.target.branch}`.toLowerCase()) {
    throw new InstallError(`${entry.plugin} is installed from ${target.owner}/${target.repo}@${target.branch}, not the branch the other updates go to. Update it on its own.`, 409);
  }
  if (chain) target = chain.target;
  const present = (await (readInstalled || d.installedPluginVersions)(target)).find((row) => row.id === entry.plugin);
  if (!present) throw new InstallError(`"${entry.plugin}" is not in ${target.owner}/${target.repo}, so there is nothing to update. Install it first.`, 404);
  const verified = await fetchVerified({ entry, domain, wantedVersion: str(version), now, fetchImpl, d });
  if (compareVersions(verified.version, present.version) <= 0) {
    throw new InstallError(`${entry.plugin} ${present.version} is already installed; ${verified.version} is not newer, and a plugin is never downgraded from here (use Roll back for that).`, 409);
  }
  const optionStore = credentials?.supabaseUrl ? optionStoreFrom({ ...credentials, fetchImpl }) : null;
  const result = await d.installPluginFromGit({
    source: { zip: verified.zip }, target, optionStore, deployHook: '', expectedId: entry.plugin, gitDeploys: true, chain, backup,
  });
  return { ...result, update: { id: entry.plugin, from: present.version, to: verified.version } };
}

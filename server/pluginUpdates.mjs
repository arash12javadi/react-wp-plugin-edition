/**
 * Plugin updates, released and installed independently of React-WP core.
 *
 * A plugin is published as its own GitHub release in the release repository:
 *
 *     tag     <plugin-id>-v<version>            rwp-shop-v1.4.0
 *     asset   <plugin-id>-<version>.zip         rwp-shop-1.4.0.zip   (or <plugin-id>.zip)
 *
 * The asset is the plugin folder zipped exactly as Plugins → Upload takes it (manifest.json at the root,
 * or inside one top-level folder). Core releases are tagged `v1.2.3`, and `tagVersionFrom` in
 * `githubReleases.mjs` drops any tag that is not a bare version, so a plugin tag never reaches the core
 * update check and a core tag never reaches this one — publishing one plugin does not offer core an
 * update, and publishing core does not touch any plugin.
 *
 * Installing is the commit `installPluginFromGit` already makes for an uploaded ZIP (`plugins/<id>/` and
 * that plugin's line in `server/plugins.mjs`, nothing else), so a plugin update obeys the same rules as an
 * upload: it can only write under `plugins/<id>/`, it is not reported installed until Vercel's deployment
 * is READY, and the previous deployment keeps serving until then.
 *
 * What this module deliberately does not do:
 *   - It never installs a plugin that is not already in the repository (an update, not an install).
 *   - It never downgrades, and never installs a package whose manifest names another id or another
 *     version than the release it came from.
 *   - It does not deliver the four sold plugins. Their package must be licence-gated, and a public
 *     release asset is not. `commercialRefusal` says so instead of pretending.
 */
import { githubList, repoFrom } from './githubReleases.mjs';
import { compareVersions } from './versions.mjs';
import { InstallError, MAX_ZIP_BYTES, readManifest, unpack } from './pluginInstaller.mjs';
import { isCommercialPlugin } from '../src/lib/pluginLicense.js';
import { installPluginFromGit } from './pluginGitInstaller.mjs';
import { readBranch, readTextFile } from './pluginGitPush.mjs';

export const PLUGIN_TAG_PATTERN = /^([a-z0-9][a-z0-9-]{0,63})-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

const GITHUB_API_ORIGIN = 'https://api.github.com';
const ALLOWED_ASSET_HOSTS = new Set(['api.github.com', 'github.com']);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/** `{ id, version }` from `rwp-shop-v1.4.0`, or null when the tag is not a plugin release. */
export const pluginTagFrom = (tag) => {
  const match = PLUGIN_TAG_PATTERN.exec(trimmed(tag));
  return match ? { id: match[1], version: match[2] } : null;
};

/** The ZIP asset a release carries for this plugin. Exact names only: a repository archive is not a plugin. */
const assetFrom = (row, id, version) => {
  const wanted = new Set([`${id}-${version}.zip`, `${id}.zip`].map((name) => name.toLowerCase()));
  const assets = Array.isArray(row?.assets) ? row.assets : [];
  const asset = assets.find((item) => wanted.has(trimmed(item?.name).toLowerCase()));
  if (!asset) return null;
  return {
    name: trimmed(asset.name),
    apiUrl: trimmed(asset.url),
    browserUrl: trimmed(asset.browser_download_url),
    size: Number(asset.size) || 0,
  };
};

/**
 * Every plugin release in a GitHub release list, newest first per plugin.
 *
 * @param {unknown} rows GitHub's `/releases` answer
 * @param {{ channel?: 'stable' | 'beta' }} [options] a draft is never offered; a pre-release only on `beta`
 * @returns {Map<string, Array<{ id: string, version: string, tag: string, title: string, released: string, notes: string[], url: string, prerelease: boolean, asset: object | null }>>}
 */
export function pluginReleasesFrom(rows, { channel = 'stable' } = {}) {
  const byId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.draft === true) continue;
    const parsed = pluginTagFrom(row.tag_name);
    if (!parsed) continue;
    const prerelease = row.prerelease === true || parsed.version.includes('-');
    if (prerelease && channel !== 'beta') continue;
    const release = {
      id: parsed.id,
      version: parsed.version,
      tag: trimmed(row.tag_name),
      title: trimmed(row.name),
      released: trimmed(row.published_at) || trimmed(row.created_at),
      notes: String(row.body ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*+]\s+/, '').trim()).filter(Boolean).slice(0, 30),
      url: /^https:\/\//i.test(trimmed(row.html_url)) ? trimmed(row.html_url) : '',
      prerelease,
      asset: assetFrom(row, parsed.id, parsed.version),
    };
    byId.set(parsed.id, [...(byId.get(parsed.id) || []), release]);
  }
  for (const list of byId.values()) list.sort((a, b) => compareVersions(b.version, a.version));
  return byId;
}

/** Reads the release repository's list. One request: 100 releases is far more than a site's plugins need. */
export async function fetchPluginReleases({ repo, token = '', channel = 'stable', fetchImpl = fetch, origin = GITHUB_API_ORIGIN }) {
  const target = repoFrom(repo);
  if (!target) {
    throw new InstallError('No release repository is configured, so there is nothing to update plugins from. Name it on Settings → Updates (or set RWP_RELEASE_REPO).', 409);
  }
  const name = `${target.owner}/${target.repo}`;
  const rows = await githubList({ name, url: `${origin}/repos/${name}/releases?per_page=100`, token, fetchImpl });
  return { repo: name, releases: pluginReleasesFrom(rows, { channel }) };
}

const RELEASE_CACHE_MS = 5 * 60 * 1000;
/** `repo|auth` to the last good answer, so many admins opening the dashboard make one GitHub call, not many. */
const releaseCache = new Map();

export const clearPluginReleaseCache = () => releaseCache.clear();

/**
 * The newest stable release of each **free** plugin that has an installable asset, shaped the way the update
 * check reports a release (`version`, `tag`, `title`, `released`, `notes`, `changelog_url`). This is what lets
 * the daily check, the sidebar badge and the dashboard say "a new version of plugin X is available".
 *
 * Sold plugins are left out (their updates come from react-wp.com with a licence, never from a public
 * release). It never throws: a GitHub outage or rate limit answers with the last good list, or none, because a
 * plugin notice must never make the core check fail.
 *
 * @param {{ source: { repo: string, token?: string }, fetchImpl?: typeof fetch, now?: number }} input
 * @returns {Promise<Record<string, { version: string, tag: string, title: string, released: string, notes: string[], changelog_url: string, critical: boolean }>>}
 */
export async function latestFreePluginReleases({ source, fetchImpl = fetch, now = Date.now() }) {
  const key = `${trimmed(source?.repo).toLowerCase()}|${trimmed(source?.token) ? 'auth' : 'anon'}`;
  const hit = releaseCache.get(key);
  if (hit && now - hit.at < RELEASE_CACHE_MS) return hit.value;
  try {
    const listing = await fetchPluginReleases({ repo: source?.repo, token: source?.token, fetchImpl });
    const value = {};
    for (const [id, list] of listing.releases) {
      const latest = list[0];
      if (!latest || !latest.asset || isCommercialPlugin(id)) continue;
      value[id] = {
        version: latest.version, tag: latest.tag, title: latest.title, released: latest.released,
        notes: latest.notes, changelog_url: latest.url, critical: false,
      };
    }
    releaseCache.set(key, { at: now, value });
    return value;
  } catch {
    return hit ? hit.value : {};
  }
}

/** The sentence for a sold plugin: its package is not served from a public release. */
export const commercialRefusal = (id) => `"${id}" is a licensed plugin. Its package is only handed out against a valid licence key, which this update path does not do yet, so it is not updated from here. Install the new version from the Plugins screen once it is delivered with your licence.`;

/**
 * What can be updated, given what the repository holds.
 *
 * @param {{ installed: Array<{ id: string, version: string }>, releases: Map<string, any[]> }} input
 */
export function planPluginUpdates({ installed, releases }) {
  return installed.map(({ id, version }) => {
    const latest = (releases.get(id) || [])[0] || null;
    const newer = latest && compareVersions(latest.version, version) > 0;
    let state = 'up-to-date';
    let reason = '';
    if (!latest) {
      state = 'no-release';
    } else if (newer) {
      state = 'available';
      if (isCommercialPlugin(id)) {
        state = 'unavailable';
        reason = commercialRefusal(id);
      } else if (!latest.asset) {
        state = 'unavailable';
        reason = `Release ${latest.tag} has no ${id}-${latest.version}.zip asset to install.`;
      }
    }
    return {
      id,
      installed: version,
      latest: latest ? latest.version : '',
      state,
      reason,
      release: latest && newer ? { tag: latest.tag, title: latest.title, released: latest.released, notes: latest.notes, url: latest.url, prerelease: latest.prerelease } : null,
    };
  });
}

/** Downloads a release asset. Only GitHub hosts are asked, with the token only when the repository is private. */
export async function downloadReleaseAsset({ asset, token = '', fetchImpl = fetch }) {
  const secret = trimmed(token);
  const url = new URL(secret && asset.apiUrl ? asset.apiUrl : (asset.browserUrl || asset.apiUrl));
  if (url.protocol !== 'https:' || !ALLOWED_ASSET_HOSTS.has(url.hostname)) {
    throw new InstallError(`The release asset points at ${url.hostname}, which is not GitHub, so it was not downloaded.`, 400);
  }
  if (asset.size > MAX_ZIP_BYTES) throw new InstallError(`The release asset is ${asset.size} bytes; plugin ZIPs may be at most ${MAX_ZIP_BYTES}.`, 413);
  let response;
  try {
    response = await fetchImpl(url.href, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'react-wp-plugin-updates',
        ...(secret && url.hostname === 'api.github.com' ? { Authorization: `Bearer ${secret}` } : {}),
      },
      signal: AbortSignal.timeout(60_000),
      redirect: 'follow',
    });
  } catch (error) {
    throw new InstallError(`The plugin package could not be downloaded: ${error?.message || error}.`, 502);
  }
  if (!response.ok) throw new InstallError(`GitHub answered HTTP ${response.status} for the plugin package.`, 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ZIP_BYTES) throw new InstallError(`The plugin package is larger than ${MAX_ZIP_BYTES} bytes, the plugin ZIP limit.`, 413);
  return bytes;
}

/**
 * Checks a downloaded package against the release it claims to be, before anything is committed:
 * same id, same version, and a core new enough for `requires.core` when the manifest names one.
 */
export function assertPackageMatches({ zip, id, version, coreVersion = '' }) {
  const manifest = readManifest(unpack(zip));
  if (manifest.id !== id) {
    throw new InstallError(`The package is plugin "${manifest.id}", not "${id}". Nothing was installed.`, 409);
  }
  if (manifest.version !== version) {
    throw new InstallError(`The release is tagged ${version} but the package's manifest says ${manifest.version}. Nothing was installed; the release needs to be republished.`, 409);
  }
  const needed = trimmed(manifest.requires?.core).replace(/^>=\s*/, '');
  if (needed && coreVersion && compareVersions(coreVersion, needed) < 0) {
    throw new InstallError(`${id} ${version} needs React-WP core ${needed} or newer, and this site runs ${coreVersion}. Update core first, then update the plugin.`, 409);
  }
  return manifest;
}

/**
 * The plugins the repository holds and the version each one's manifest names: what is committed, which is
 * what the next deployment runs. A manifest that cannot be read costs that plugin its row, not the check.
 */
export async function installedPluginVersions(target) {
  const branch = await readBranch(target);
  const ids = [...new Set([...branch.paths.keys()]
    .map((path) => /^plugins\/([a-z0-9][a-z0-9-]{0,63})\/manifest\.json$/.exec(path)?.[1])
    .filter(Boolean))].sort();
  const rows = await Promise.all(ids.map(async (id) => {
    try {
      const manifest = JSON.parse(await readTextFile(target, `plugins/${id}/manifest.json`) || '{}');
      return { id, name: trimmed(manifest.name) || id, version: trimmed(manifest.version) };
    } catch {
      return null;
    }
  }));
  return rows.filter((row) => row && row.version);
}

/** The check: every installed plugin against the release repository. Writes nothing. */
export async function checkPluginUpdates({ target, source, channel = 'stable', fetchImpl = fetch }) {
  const [installed, listing] = await Promise.all([
    installedPluginVersions(target),
    fetchPluginReleases({ repo: source?.repo, token: source?.token, channel, fetchImpl }),
  ]);
  const names = new Map(installed.map((row) => [row.id, row.name]));
  return {
    repository: `${target.owner}/${target.repo}`,
    releaseRepository: listing.repo,
    plugins: planPluginUpdates({ installed, releases: listing.releases }).map((row) => ({ ...row, name: names.get(row.id) || row.id })),
  };
}

/**
 * Updates one installed plugin to one named release: a single commit under `plugins/<id>/`.
 * The caller has already required the platform owner and a connected Git deployment.
 */
export async function applyPluginUpdate({ target, source, id, version, coreVersion = '', channel = 'stable', fetchImpl = fetch }) {
  const pluginId = trimmed(id);
  const wanted = trimmed(version).replace(/^v/i, '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginId)) throw new InstallError('A plugin id is required.', 400);
  if (!wanted) throw new InstallError('Name the version to install.', 400);
  if (isCommercialPlugin(pluginId)) throw new InstallError(commercialRefusal(pluginId), 403);

  const installed = (await installedPluginVersions(target)).find((row) => row.id === pluginId);
  if (!installed) {
    throw new InstallError(`"${pluginId}" is not in ${target.owner}/${target.repo}, so there is nothing to update. Install it from Plugins → Upload first.`, 404);
  }
  if (compareVersions(wanted, installed.version) <= 0) {
    throw new InstallError(`${pluginId} ${installed.version} is already installed; ${wanted} is not newer, and a plugin is never downgraded from here.`, 409);
  }
  const listing = await fetchPluginReleases({ repo: source?.repo, token: source?.token, channel, fetchImpl });
  const release = (listing.releases.get(pluginId) || []).find((item) => item.version === wanted);
  if (!release) throw new InstallError(`${listing.repo} has no published release ${pluginId}-v${wanted}.`, 404);
  if (!release.asset) throw new InstallError(`Release ${release.tag} has no ${pluginId}-${wanted}.zip asset to install.`, 409);

  const zip = await downloadReleaseAsset({ asset: release.asset, token: source?.token, fetchImpl });
  assertPackageMatches({ zip, id: pluginId, version: wanted, coreVersion });

  const result = await installPluginFromGit({
    source: { zip },
    target,
    optionStore: null,
    deployHook: '',
    expectedId: pluginId,
    gitDeploys: true,
  });
  return { ...result, update: { id: pluginId, from: installed.version, to: wanted, tag: release.tag } };
}

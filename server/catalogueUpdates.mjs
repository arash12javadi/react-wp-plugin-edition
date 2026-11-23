/**
 * Updates of free plugins from the marketplace catalogue.
 *
 * A plugin a site installed from the marketplace is updated from the same place: react-wp.com lists, for each plugin
 * it has approved, the newest approved version with the checksum of the copy it scanned and stored, and signs that
 * description (`signPackage`, domain "catalogue", the same Ed25519 package key the site already trusts for sold plugins).
 *
 * What a site verifies before it commits anything, each step refusing with a sentence:
 *   1. the description is signed by the vendor's package key and has not expired (ten minutes);
 *   2. the bytes it downloads hash to exactly the signed checksum;
 *   3. the manifest inside names the plugin and the version that were offered (`assertPackageMatches`, the caller's job).
 * So neither a changed file in storage nor a changed answer from the network can install anything the vendor did not
 * approve. The download address is a redirect into the vendor's own storage; every hop must be https, and the checksum
 * makes the host it ends on irrelevant to trust.
 *
 * Opt-in by the caller: nothing here runs unless a caller passes `catalogue`, and every failure degrades to "no catalogue
 * update" (a plugin notice must never fail a check). Applying is still only ever started by a button.
 */
import { createHash } from 'node:crypto';
import { centralFetch } from './centralFetch.mjs';
import { verifyPackage } from './packageCrypto.mjs';
import { InstallError, MAX_ZIP_BYTES } from './pluginInstaller.mjs';

export const DEFAULT_CATALOGUE_ORIGIN = 'https://react-wp.com';
export const CATALOGUE_DOMAIN = 'catalogue';
const LATEST_PATH = '/api/plugins/rwp-plugin-marketplace/source/latest';
const PACKAGE_PATH = '/api/plugins/rwp-plugin-marketplace/source/package';
const MAX_HOPS = 4;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * `{ origin }` for the catalogue this site asks, or null when updates from it are switched off.
 * `RWP_MARKETPLACE_URL` names another vendor's catalogue (https only); `off` disables the catalogue for this site.
 */
export function catalogueFrom(env = globalThis.process?.env || {}) {
  const raw = trimmed(env.RWP_MARKETPLACE_URL);
  if (raw.toLowerCase() === 'off') return null;
  const origin = (raw || DEFAULT_CATALOGUE_ORIGIN).replace(/\/+$/, '');
  return /^https:\/\/[^/\s]+$/i.test(origin) ? { origin } : null;
}

/**
 * What the catalogue offers for these plugin ids: `Map<id, release[]>` in the shape `pluginUpdates` already uses, with
 * `asset.kind === 'catalogue'`. Never throws; an unreachable or malformed answer is an empty map.
 */
export async function fetchCatalogueReleases({ catalogue, ids, fetchImpl = fetch }) {
  const wanted = [...new Set((ids || []).filter((id) => PLUGIN_ID.test(String(id))))].slice(0, 50);
  const result = new Map();
  if (!catalogue?.origin || !wanted.length) return result;
  try {
    const response = await centralFetch(`${catalogue.origin}${LATEST_PATH}?ids=${encodeURIComponent(wanted.join(','))}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'react-wp-plugin-updates' },
      signal: AbortSignal.timeout(10_000),
    }, { fetchImpl });
    if (!response.ok) return result;
    const body = await response.json();
    for (const [id, row] of Object.entries(body?.plugins && typeof body.plugins === 'object' ? body.plugins : {})) {
      if (!wanted.includes(id) || !row || typeof row !== 'object') continue;
      const version = trimmed(row.version);
      if (row.paid === true) {
        // A plugin for sale: only the fact that a newer version exists. No package comes with it (asset: null). The platform's own four
        // sold plugins are announced the same way: a site that is connected to the account already has its own Update button (the
        // account link, `licensedIds` in `planPluginUpdates`), and a site that is not connected is told where the update comes from.
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) continue;
        result.set(id, [{
          id, version, paid: true, tag: trimmed(row.tag) || `v${version}`, title: `${id} ${version}`, released: trimmed(row.released),
          notes: (Array.isArray(row.notes) ? row.notes : []).map((line) => trimmed(String(line)).slice(0, 240)).filter(Boolean).slice(0, 30),
          url: /^https:\/\//i.test(trimmed(row.url)) ? trimmed(row.url) : '', prerelease: false, asset: null,
        }]);
        continue;
      }
      const sha256 = trimmed(row.sha256).toLowerCase();
      const size = Number(row.size) || 0;
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^[0-9a-f]{64}$/.test(sha256) || size > MAX_ZIP_BYTES) continue;
      result.set(id, [{
        id,
        version,
        tag: trimmed(row.tag) || `v${version}`,
        title: `${id} ${version}`,
        released: trimmed(row.released),
        notes: (Array.isArray(row.notes) ? row.notes : []).map((line) => trimmed(String(line)).slice(0, 240)).filter(Boolean).slice(0, 30),
        url: /^https:\/\//i.test(trimmed(row.url)) ? trimmed(row.url) : '',
        prerelease: false,
        asset: { kind: 'catalogue', name: `${id}-${version}.zip`, size, sha256, exp: trimmed(String(row.exp ?? '')), sig: trimmed(row.sig) },
      }]);
    }
  } catch {
    return new Map();
  }
  return result;
}

const VERDICT_SENTENCES = {
  'no-key': 'This site holds no package verification key, so it cannot confirm the update comes from the marketplace. Nothing was installed.',
  expired: 'The marketplace\'s signed description of this update has expired. Check for updates again, then update.',
  bad: 'The marketplace\'s signed description of this update does not verify, so nothing was installed.',
};

/**
 * Downloads one catalogue package and proves it. Throws `InstallError` with the sentence for each way it can fail.
 * @param {{ release: { id: string, version: string, asset: any }, catalogue: { origin: string }, fetchImpl?: typeof fetch, publicKey?: string, now?: Date }} input
 */
export async function downloadCataloguePackage({ release, catalogue, fetchImpl = fetch, publicKey, now = new Date() }) {
  const { id, version, asset } = release;
  const verdict = verifyPackage({ pluginId: id, version, domain: CATALOGUE_DOMAIN, sha256: asset.sha256, exp: asset.exp, sig: asset.sig }, { publicKey, now });
  if (verdict !== 'ok') throw new InstallError(VERDICT_SENTENCES[verdict] || VERDICT_SENTENCES.bad, 409);

  let target = `${catalogue.origin}${PACKAGE_PATH}?plugin=${encodeURIComponent(id)}&version=${encodeURIComponent(version)}`;
  let response;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    if (!/^https:\/\//i.test(target)) throw new InstallError('The marketplace sent the update package from an address that is not https, so it was not downloaded.', 502);
    try {
      response = await fetchImpl(target, { redirect: 'manual', headers: { 'User-Agent': 'react-wp-plugin-updates' }, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new InstallError(`The update package could not be downloaded: ${error?.message || error}.`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) throw new InstallError('The marketplace redirected the download without saying where.', 502);
      target = new URL(next, target).href;
      response = null;
      continue;
    }
    break;
  }
  if (!response) throw new InstallError('The marketplace redirected the download too many times.', 502);
  if (!response.ok) {
    throw new InstallError(response.status === 404
      ? `The marketplace no longer offers ${id} ${version}. Check for updates again.`
      : `The marketplace answered HTTP ${response.status} for the update package.`, 502);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ZIP_BYTES) throw new InstallError(`The update package is larger than ${MAX_ZIP_BYTES} bytes, the plugin ZIP limit.`, 413);
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new InstallError('The downloaded package does not match the checksum the marketplace signed, so nothing was installed.', 409);
  }
  return bytes;
}

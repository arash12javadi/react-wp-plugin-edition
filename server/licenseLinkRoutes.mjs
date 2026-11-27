/**
 * Plugins → "Connect to react-wp.com": the routes behind the account link (see `server/licenseLink.mjs`).
 * Shared by `server.mjs` and the universal engine (`src/server/licenseLink.ts`), so both answer identically.
 *
 *   GET  /api/admin/license-link              the connection, presence only (never a token or a key)
 *   POST /api/admin/license-link/connect      `{ code }` → connects this site with a pairing code
 *   POST /api/admin/license-link/sync         fetches the keys now ("Sync now")
 *   POST /api/admin/license-link/disconnect   forgets the sealed token on this site
 *   POST /api/admin/license-link/claim        `{ license_key }` → binds a developer's RWPD1 key to the account, then syncs
 *   GET  /api/admin/license-link/seats        which of the account's licences use this site
 *   POST /api/admin/license-link/seat         `{ plugin, action: 'activate' | 'deactivate' }` → uses or frees this site's seat
 *   POST /api/admin/license-link/rollback     `{ plugin }` → puts a licensed plugin back to the version its last update replaced
 *
 * Every route needs the **platform owner** (`administrator` / `super_admin`, `authorizePlatformOwner`): the
 * connection decides which licences this installation runs, and its row is a platform-owner row. Requests
 * carry a bearer token, not a cookie, so a cross-site form cannot ride on a session (CSRF). The settings row
 * and the licence option are read and written with the caller's own session, so the database's policies
 * decide as well. Disconnecting here does not revoke the token on react-wp.com; the customer does that under
 * My licenses (the response says so).
 */
import {
  LICENSE_LINK_CONFIG_KEY, LicenseLinkError, accountRequest, connectSite, licenseLinkFrom, licenseOptionIo, installLicensedPlugin, publicLicenseLink, rollbackLicensedPlugin,
  setAutoInstall, syncLicenses, updateLicensedPlugin,
} from './licenseLink.mjs';
import { settingsIo } from './gitDeploy/connection.mjs';

const PREFIX = '/api/admin/license-link';
const PATHS = new Set([
  PREFIX, `${PREFIX}/connect`, `${PREFIX}/sync`, `${PREFIX}/settings`, `${PREFIX}/install`, `${PREFIX}/update`, `${PREFIX}/disconnect`,
  `${PREFIX}/claim`, `${PREFIX}/seats`, `${PREFIX}/seat`, `${PREFIX}/rollback`,
]);

/** The paths this module answers - the single list both engines route by. */
export const ownsLicenseLinkPath = (pathname) => PATHS.has(pathname);

const bearerToken = (headers = {}) => String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
const ok = (status, body) => ({ status, body: { success: true, ok: true, ...body } });
const refuse = (status, error, extra = {}) => ({ status, body: { success: false, ok: false, error, ...extra } });

/**
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.pathname
 * @param {Record<string, string>} options.headers  only `authorization` is read
 * @param {object} [options.body]
 * @param {{ supabaseUrl?: string, supabasePublishableKey?: string, dbType?: string }} options.config
 * @param {string} options.siteUrl  this site's own address, as the request reached it
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(token: string) => Promise<{ ok: boolean, status?: number, error?: string }>} options.authorize
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function handleLicenseLinkRequest(options) {
  const { method, pathname, headers = {}, body = {}, config = {}, siteUrl = '', env = {}, authorize, fetchImpl = fetch } = options;
  if (!ownsLicenseLinkPath(pathname)) return null;

  const accessToken = bearerToken(headers);
  if (typeof authorize !== 'function') return refuse(501, 'This host cannot authorize licence settings.');
  const auth = await authorize(accessToken);
  if (!auth?.ok) return refuse(auth?.status || 403, auth?.error || 'Only the platform owner can connect this site to a react-wp.com account.');
  if (config.dbType && config.dbType !== 'supabase') {
    return refuse(501, 'Connecting to a react-wp.com account needs a Supabase-backed site, which is what this setup stores its connection in.');
  }

  const io = settingsIo({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabasePublishableKey, accessToken, fetchImpl });
  const licenseIo = licenseOptionIo({ supabaseUrl: config.supabaseUrl, apiKey: config.supabasePublishableKey, accessToken, fetchImpl });
  // What an automatic install needs to pin `rwp_active_plugins`: the owner's own session, never more.
  const credentials = { supabaseUrl: config.supabaseUrl, apiKey: config.supabasePublishableKey, accessToken };

  try {
    if (pathname === PREFIX) {
      if (method !== 'GET') return refuse(405, 'Only GET is supported here.');
      return ok(200, { link: publicLicenseLink(await io.read(LICENSE_LINK_CONFIG_KEY), { env }) });
    }
    if (pathname === `${PREFIX}/seats`) {
      if (method !== 'GET') return refuse(405, 'Only GET is supported here.');
      const answer = await accountRequest({ io, path: 'buyer/seats', method: 'GET', env, fetchImpl });
      return ok(200, { seats: Array.isArray(answer.body?.seats) ? answer.body.seats : [], domain: answer.domain });
    }
    if (method !== 'POST') return refuse(405, 'Only POST is supported here.');

    if (pathname === `${PREFIX}/connect`) {
      const row = await connectSite({ code: body?.code, siteUrl, io, autoInstall: body?.autoInstall !== false, env, fetchImpl });
      // Keys are fetched straight away, so a customer is not left looking at "Connected" with locked plugins.
      let sync = null;
      try {
        sync = await syncLicenses({ io, licenseIo, credentials, env, fetchImpl });
      } catch (error) {
        sync = { changed: false, updated: [], message: error instanceof Error ? error.message : 'The first sync did not complete.' };
      }
      return ok(200, { link: publicLicenseLink(await io.read(LICENSE_LINK_CONFIG_KEY), { env }), sync, domain: row.domain });
    }
    if (pathname === `${PREFIX}/sync`) {
      const sync = await syncLicenses({ io, licenseIo, credentials, env, fetchImpl });
      return ok(200, { link: publicLicenseLink(await io.read(LICENSE_LINK_CONFIG_KEY), { env }), sync });
    }
    if (pathname === `${PREFIX}/install`) {
      // The owner pressed Install on a purchased plugin. Never reached from a sync or a timer.
      const result = await installLicensedPlugin({ plugin: body?.plugin, version: body?.version, io, credentials, env, fetchImpl });
      return ok(200, { result, deployment: result.deployment ?? null });
    }
    if (pathname === `${PREFIX}/update`) {
      // The owner pressed Update on a sold plugin. Never reached from a sync or a timer.
      // `backup: true`: the site publishes this plugin itself, so a copy of its current code is kept in the same commit.
      const result = await updateLicensedPlugin({ plugin: body?.plugin, version: body?.version, io, credentials, env, fetchImpl, backup: body?.backup === true ? 'always' : 'auto' });
      return ok(200, { result, deployment: result.deployment ?? null });
    }
    if (pathname === `${PREFIX}/claim`) {
      // A key a developer's shop issued: react-wp.com checks its signature and binds it to the account, then the sync delivers it here.
      const key = String(body?.license_key || '').trim();
      if (!key) return refuse(400, 'Paste the licence key you got from the developer.');
      const answer = await accountRequest({ io, path: 'buyer/claim', method: 'POST', body: { license_key: key }, env, fetchImpl });
      let sync = null;
      try {
        sync = await syncLicenses({ io, licenseIo, credentials, env, fetchImpl });
      } catch (error) {
        sync = { changed: false, updated: [], message: error instanceof Error ? error.message : 'The sync did not complete.' };
      }
      return ok(200, { claim: answer.body, sync, link: publicLicenseLink(await io.read(LICENSE_LINK_CONFIG_KEY), { env }) });
    }
    if (pathname === `${PREFIX}/seat`) {
      const action = body?.action === 'activate' ? 'activate' : body?.action === 'deactivate' ? 'deactivate' : '';
      if (!action) return refuse(400, 'Send { "plugin": "...", "action": "activate" } or "deactivate".');
      const answer = await accountRequest({ io, path: 'buyer/seat', method: 'POST', body: { plugin: String(body?.plugin || ''), action }, env, fetchImpl });
      return ok(200, { seat: answer.body });
    }
    if (pathname === `${PREFIX}/rollback`) {
      // The owner pressed Roll back. Never reached from a sync or a timer.
      const result = await rollbackLicensedPlugin({ plugin: body?.plugin, io });
      return ok(200, { result, link: publicLicenseLink(await io.read(LICENSE_LINK_CONFIG_KEY), { env }) });
    }
    if (pathname === `${PREFIX}/settings`) {
      if (typeof body?.autoInstall !== 'boolean') return refuse(400, 'Send { "autoInstall": true } or { "autoInstall": false }.');
      await setAutoInstall({ io, enabled: body.autoInstall });
      return ok(200, { link: publicLicenseLink(await io.read(LICENSE_LINK_CONFIG_KEY), { env }) });
    }
    if (pathname === `${PREFIX}/disconnect`) {
      const before = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
      await io.remove(LICENSE_LINK_CONFIG_KEY);
      return ok(200, {
        link: publicLicenseLink(null, { env }),
        message: before.token_sealed
          ? 'This site forgot its connection. To also stop react-wp.com from honouring that token, disconnect the site under My licenses on react-wp.com.'
          : 'This site was not connected.',
      });
    }
    return refuse(404, `No API endpoint at ${pathname}.`);
  } catch (error) {
    if (error instanceof LicenseLinkError) return refuse(error.status, error.message, { code: error.code });
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return refuse(status, error instanceof Error ? error.message : 'The licence link request failed.');
  }
}

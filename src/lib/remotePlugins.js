/**
 * The Remote Plugin Loader, built into the react-wp core.
 *
 * This is the customer-side half of the hybrid architecture. The premium plugin *source* never ships
 * to the customer's Vercel instance; this loader asks the central server for them at boot, and only
 * runs a plugin whose license verifies. A license that is `pending_renewal`, `expired`, `revoked` or
 * `invalid` blocks the plugin instantly, because this loader simply does not inject it.
 *
 * Where the two secrets live
 * --------------------------
 *   - `siteToken` and `licenseKey` are stored in `localStorage` under the keys below. They are written
 *     once, by the activation flow (`activateRemoteLicense`), and read on every boot. They are not
 *     baked into the bundle and they never appear in a plugin URL — the central server hands out a
 *     short-lived, single-plugin `assetToken` for the `<script>` load instead.
 *
 * The remote bundle contract
 * --------------------------
 *   A remote plugin is an obfuscated, classic (non-module) script that calls, when it loads:
 *
 *       window.__RWP_REMOTE__.register({
 *         id, name, version,
 *         register(ctx) { ... same shape as defineRwpPlugin's callback ... },
 *       });
 *
 *   `register()` here wraps `rwp.registerPlugin` and then activates the plugin, so the bundle does not
 *   need to import anything from core.
 *
 * Plain JavaScript, like `pluginLicense.js`, because it ships to the browser and must not touch
 * `node:crypto`. It is safe to call before the database is configured: with no stored identity it is a
 * silent no-op, and every network failure degrades to "no remote plugins".
 */
import { rwp } from './rwp';

/** localStorage keys for the site identity the central server issued. */
export const REMOTE_SITE_TOKEN_KEY = 'rwp_site_token';
export const REMOTE_LICENSE_KEY_KEY = 'rwp_license_key';

/** Vite-inlined: the central licensing server's origin, e.g. `https://admin.example.com`. */
const remoteLicenseBaseUrl = () => {
  const configured = typeof import.meta.env !== 'undefined' ? import.meta.env.VITE_RWP_REMOTE_LICENSE_URL : '';
  return String(configured || '').replace(/\/+$/, '');
};

/** The central `remote/*` route prefix, named once so the loader and the server cannot disagree. */
const remoteRoute = (suffix) =>
  `${remoteLicenseBaseUrl()}/api/plugins/rwp-saas-installer/remote/${suffix}`;

/** Reads the stored site identity, or empty values when the free core has not been activated. */
export const readSiteIdentity = () => {
  try {
    return {
      siteToken: String(window.localStorage.getItem(REMOTE_SITE_TOKEN_KEY) || '').trim(),
      licenseKey: String(window.localStorage.getItem(REMOTE_LICENSE_KEY_KEY) || '').trim(),
      siteUrl: window.location.origin,
    };
  } catch {
    return { siteToken: '', licenseKey: '', siteUrl: '' };
  }
};

/** Writes the identity the activation flow received back from the central server. */
export const storeSiteIdentity = ({ siteToken, licenseKey } = {}) => {
  try {
    if (siteToken) window.localStorage.setItem(REMOTE_SITE_TOKEN_KEY, String(siteToken).trim());
    if (licenseKey) window.localStorage.setItem(REMOTE_LICENSE_KEY_KEY, String(licenseKey).trim());
  } catch {
    /* storage unavailable — the identity is lost on reload, but nothing else breaks */
  }
};

/** Forgets the identity, e.g. when an administrator deactivates the remote license. */
export const clearSiteIdentity = () => {
  try {
    window.localStorage.removeItem(REMOTE_SITE_TOKEN_KEY);
    window.localStorage.removeItem(REMOTE_LICENSE_KEY_KEY);
  } catch {
    /* ignore */
  }
};

/**
 * The global a remote bundle registers through. Exposed once, so the bridge exists before any script
 * has loaded, and reused on later boots.
 */
export const installRemoteRegistry = () => {
  if (window.__RWP_REMOTE__) return window.__RWP_REMOTE__;
  const registry = {
    register(plugin) {
      try {
        rwp.registerPlugin(plugin);
        rwp.activatePlugin(plugin?.id);
        return () => rwp.deactivatePlugin(plugin?.id);
      } catch (error) {
        console.warn('[remote-plugins]', error instanceof Error ? error.message : error);
        return () => {};
      }
    },
  };
  window.__RWP_REMOTE__ = registry;
  return registry;
};
/**
 * The boot-time license check. Returns the central server's verdict; any status other than `active`
 * is reported faithfully so callers can block. Never throws.
 */
export const verifyRemoteLicense = async (identity = readSiteIdentity()) => {
  const base = remoteLicenseBaseUrl();
  if (!base || !identity.licenseKey || !identity.siteToken) {
    return { ok: false, status: 'invalid', reason: 'not_configured', plugins: [] };
  }
  try {
    const params = new URLSearchParams({
      siteToken: identity.siteToken,
      licenseKey: identity.licenseKey,
      domain: identity.siteUrl,
    });
    const response = await fetch(`${remoteRoute('verify')}?${params.toString()}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      return {
        ok: false,
        status: payload?.status || 'invalid',
        reason: payload?.reason || 'http_error',
        plugins: [],
      };
    }
    return payload;
  } catch {
    return { ok: false, status: 'invalid', reason: 'network_error', plugins: [] };
  }
};

/** Activates a paid license key against a domain and stores the issued site identity. */
export const activateRemoteLicense = async (licenseKey, domain = window.location.origin) => {
  const base = remoteLicenseBaseUrl();
  if (!base || !licenseKey) return { ok: false, status: 'invalid', reason: 'not_configured' };
  try {
    const params = new URLSearchParams({ licenseKey, domain });
    const response = await fetch(`${remoteRoute('activate')}?${params.toString()}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.status === 'active' && payload.siteToken) {
      storeSiteIdentity({ siteToken: payload.siteToken, licenseKey });
    }
    return payload || { ok: false, status: 'invalid', reason: 'http_error' };
  } catch {
    return { ok: false, status: 'invalid', reason: 'network_error' };
  }
};

const injectedScripts = new Map();

/** Injects one remote bundle. Returns a cleanup that removes the script. */
export const injectRemoteScript = ({ pluginId, entryUrl, integrity } = {}) => {
  const previous = injectedScripts.get(pluginId);
  if (previous) previous.remove();
  const script = document.createElement('script');
  script.src = entryUrl;
  script.async = true;
  script.dataset.rwpRemote = pluginId;
  if (integrity) {
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
  }
  document.head.appendChild(script);
  injectedScripts.set(pluginId, script);
  return () => {
    script.remove();
    injectedScripts.delete(pluginId);
  };
};

let booted = false;

/**
 * Boots every remote plugin the central server entitles this site to. Idempotent and safe to call at
 * startup: with no stored identity it is a no-op, and a non-`active` verdict injects nothing (which is
 * how `pending_renewal`, `expired`, `revoked` and `invalid` block access instantly).
 */
export const bootRemotePlugins = async () => {
  if (booted) return [];
  booted = true;
  installRemoteRegistry();

  const identity = readSiteIdentity();
  if (!identity.siteToken || !identity.licenseKey) return [];

  const report = await verifyRemoteLicense(identity);
  if (!report || report.status !== 'active') return [];

  const cleanups = [];
  for (const plugin of report.plugins || []) {
    if (!plugin.pluginId || !plugin.assetToken) continue;
    const entryUrl = `${remoteRoute(`plugins/${encodeURIComponent(plugin.pluginId)}/entry`)}?t=${encodeURIComponent(plugin.assetToken)}`;
    cleanups.push(injectRemoteScript({ pluginId: plugin.pluginId, entryUrl, integrity: plugin.integrity }));
  }
  return cleanups;
};

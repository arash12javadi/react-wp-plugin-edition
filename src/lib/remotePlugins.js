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
import { currentEdition, DEV_EDITION } from './pluginEdition';
import { rwp } from './rwp';

/** localStorage keys for the site identity the central server issued. */
export const REMOTE_SITE_TOKEN_KEY = 'rwp_site_token';
export const REMOTE_LICENSE_KEY_KEY = 'rwp_license_key';

/**
 * Vite-inlined: the central licensing server's origin, e.g. `https://admin.example.com`.
 *
 * A customer build sets `VITE_RWP_REMOTE_LICENSE_URL` at build time. The development edition *is*
 * the marketplace — its own deployment answers `remote/*` — so it falls back to its own origin and
 * the admin tab works before that variable is configured anywhere.
 */
const remoteLicenseBaseUrl = () => {
  const configured = typeof import.meta.env !== 'undefined' ? import.meta.env.VITE_RWP_REMOTE_LICENSE_URL : '';
  const resolved = String(configured || '').replace(/\/+$/, '');
  if (resolved) return resolved;
  if (typeof window !== 'undefined' && currentEdition() === DEV_EDITION) return window.location.origin;
  return '';
};

/** The central `remote/*` route prefix, named once so the loader and the server cannot disagree. */
const remoteRoute = (suffix) =>
  `${remoteLicenseBaseUrl()}/api/plugins/rwp-saas-installer/remote/${suffix}`;

/**
 * Where the public marketplace lives when this build names no licensing server of its own. The same
 * host `defaultCentralUrl` (`src/lib/updateCenter.ts`) points updates at — spelled with `www` here
 * because that is the canonical host the deployment answers on: the apex 308-redirects every path to
 * it, and a catalogue read should not pay that round-trip.
 *
 * The marketplace is public — browsing it is exactly what `Plugins → Marketplace` is for — so a
 * customer build that never set `VITE_RWP_REMOTE_LICENSE_URL` still lists every published plugin, and
 * a first read that renders nothing is retried here (see `fetchRemoteCatalog`).
 * Installing, buying and the boot-time licence check keep using `remoteLicenseBaseUrl()` and stay off
 * until an operator points them at a server, so a licence key is never sent anywhere unasked.
 */
export const PUBLIC_MARKETPLACE_ORIGIN = 'https://www.react-wp.com';

/** The origin a catalogue read goes to; deliberately wider than `remoteLicenseBaseUrl()`. */
const catalogBaseUrl = () => remoteLicenseBaseUrl() || PUBLIC_MARKETPLACE_ORIGIN;

/** The origin catalogue reads are addressed to — also the fallback host for a listing with no product URL. */
export const marketplaceOrigin = () => catalogBaseUrl();

/** What one catalogue row is: a bundle this site installs in place, or a storefront listing. */
export const isMarketplaceListing = (item) => String(item?.source || '') === 'marketplace';

/**
 * A listing's product page made absolute against the origin that answered. The catalogue is read from
 * whichever origin replied — this build's own server, or the public marketplace when that one had
 * nothing to show — and that origin is where the listing is actually sold, so a relative path a server
 * sent must not be resolved against the admin's own domain.
 */
const absoluteStoreUrl = (item, base) => {
  const sent = String(item.storeUrl || '').trim();
  if (/^https?:\/\//i.test(sent)) return sent;
  return `${base}${sent || `/plugins/${encodeURIComponent(item.pluginId)}`}`;
};

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
 * The event a freshly loaded remote bundle announces itself with: `new CustomEvent('rwp:remote-plugin',
 * { detail: { pluginId } })`. The admin marketplace listens for it so an install can say "active now"
 * instead of asking the administrator to reload.
 */
export const REMOTE_PLUGIN_EVENT = 'rwp:remote-plugin';

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
        // A bundle is a plain script with no way to tell the app it arrived; this is that signal.
        try {
          window.dispatchEvent(new CustomEvent(REMOTE_PLUGIN_EVENT, { detail: { pluginId: String(plugin?.id || '') } }));
        } catch {
          /* an old browser without CustomEvent still gets a working plugin, just no live announcement */
        }
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
 * Resolves `true` once a remote bundle has registered and activated itself, or `false` after
 * `timeoutMs`. A just-granted plugin arrives as `<script src>`: the server has said yes, but the
 * browser still has to fetch and run it, so "installed" is only true when the registry agrees.
 */
export const waitForRemotePlugin = (pluginId, timeoutMs = 8000) => new Promise((resolve) => {
  const target = String(pluginId || '');
  const isActive = () => Boolean(rwp.getPlugins().some((plugin) => plugin.id === target && plugin.active));
  if (!target) {
    resolve(false);
    return;
  }
  if (isActive()) {
    resolve(true);
    return;
  }

  let finished = false;
  let poll = 0;
  let deadline = 0;
  const stop = (value) => {
    if (finished) return;
    finished = true;
    window.clearInterval(poll);
    window.clearTimeout(deadline);
    window.removeEventListener(REMOTE_PLUGIN_EVENT, onEvent);
    resolve(value);
  };
  function onEvent(event) {
    if (String(event?.detail?.pluginId || '') === target && isActive()) stop(true);
  }

  deadline = window.setTimeout(() => stop(isActive()), timeoutMs);
  poll = window.setInterval(() => { if (isActive()) stop(true); }, 200);
  window.addEventListener(REMOTE_PLUGIN_EVENT, onEvent);
});
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

/**
 * The orderings the storefront offers. `remote/catalog` accepts the same names, so the admin tab and
 * the public `[rwp_marketplace]` block cannot drift apart in what they offer.
 */
export const CATALOG_SORTS = ['popular', 'newest', 'rating', 'price', 'price-desc'];

/** How many cards one catalogue page holds unless the caller asks for something else. */
export const CATALOG_PAGE_SIZE = 12;

const catalogSort = (value) => (CATALOG_SORTS.includes(String(value || '')) ? String(value) : 'popular');

const numberOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const stringList = (value) => (Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : []);

/**
 * One catalogue row, coerced into the storefront shape. The central server sends these fields from
 * `catalogEntry`; the camel⇄snake fallbacks keep an older deployment — or a raw `rwp_remote_plugins`
 * row — readable rather than rendering a card of blanks.
 */
const catalogItem = (item) => ({
  pluginId: String(item?.pluginId || item?.plugin_id || '').trim(),
  // `marketplace` rows are storefront listings: browsed here, bought and installed from `storeUrl`.
  source: isMarketplaceListing(item) ? 'marketplace' : 'remote',
  storeUrl: String(item?.storeUrl || item?.store_url || '').trim(),
  name: String(item?.name || '').trim(),
  version: String(item?.version || '').trim(),
  plan: String(item?.plan || '').trim(),
  priceUsd: numberOr(item?.priceUsd ?? item?.price_usd),
  billingInterval: ['lifetime', 'monthly', 'yearly'].includes(String(item?.billingInterval || item?.billing_interval || ''))
    ? String(item?.billingInterval || item?.billing_interval)
    : 'lifetime',
  description: String(item?.description || '').trim(),
  category: String(item?.category || 'utility').trim() || 'utility',
  author: String(item?.author || '').trim(),
  tags: stringList(item?.tags),
  features: stringList(item?.features),
  docsUrl: String(item?.docsUrl || item?.docs_url || '').trim(),
  ratingAvg: numberOr(item?.ratingAvg ?? item?.rating_avg),
  ratingCount: numberOr(item?.ratingCount ?? item?.rating_count),
  installs: numberOr(item?.installs),
  updatedAt: String(item?.updatedAt || item?.updated_at || '').trim(),
  integrity: String(item?.integrity || '').trim(),
});

/** The comparators behind `CATALOG_SORTS`, tolerant of a missing field. */
const CATALOG_COMPARATORS = {
  popular: (a, b) => b.installs - a.installs || b.ratingCount - a.ratingCount || a.name.localeCompare(b.name),
  newest: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name),
  rating: (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount || a.name.localeCompare(b.name),
  price: (a, b) => a.priceUsd - b.priceUsd || a.name.localeCompare(b.name),
  'price-desc': (a, b) => b.priceUsd - a.priceUsd || a.name.localeCompare(b.name),
};

const catalogMatches = (item, search, category) => {
  if (category && item.category.toLowerCase() !== category.toLowerCase()) return false;
  if (!search) return true;
  const haystack = [item.name, item.description, item.category, item.author, ...item.tags].join(' ').toLowerCase();
  return haystack.includes(search.toLowerCase());
};

/**
 * The central marketplace catalogue (metadata only). Never throws, so the admin tab can render a
 * friendly "the licensing server is unreachable" state instead of crashing the screen.
 *
 * Every row is either a remote bundle this site may install in place (`source: 'remote'`) or a
 * storefront listing to buy on its product page (`source: 'marketplace'` + `storeUrl`), and reading
 * either one needs no licence — only installing or buying does.
 *
 * The read takes two steps: the server this build names, then — when that renders nothing — the public
 * marketplace. Browsing therefore works before activation, in a build with no licensing server, and on
 * a deployment whose own catalogue is still empty.
 *
 * `{ search, category, orderby, page, perPage }` is the same query the public `[rwp_marketplace]`
 * block sends. A central server that predates the query contract ignores it and answers with the
 * whole catalogue, which is why the filtering, sorting and paging is repeated here: the tab then
 * behaves identically against either server.
 */
export const fetchRemoteCatalog = async (query = {}) => {
  const page = Math.max(numberOr(query.page, 1), 1);
  const perPage = Math.min(Math.max(numberOr(query.perPage, CATALOG_PAGE_SIZE), 1), 60);
  const search = String(query.search || '').trim();
  const category = String(query.category || '').trim();
  const orderby = catalogSort(query.orderby);
  const empty = { items: [], total: 0, page, perPage, categories: [], orderby };

  /** One read against one origin. Never throws: every failure is a reason the tab can phrase. */
  const read = async (base) => {
    try {
      const params = new URLSearchParams({ orderby, page: String(page), per_page: String(perPage) });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      const response = await fetch(`${base}/api/plugins/rwp-saas-installer/remote/catalog?${params.toString()}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        return { ok: false, reason: payload?.reason || 'http_error', error: String(payload?.error || ''), ...empty };
      }

      const rows = (Array.isArray(payload.items) ? payload.items : [])
        .map(catalogItem)
        .filter((item) => item.pluginId)
        // Verified against the origin that answered, before the page is paged: a link that outlives the
        // request must not depend on where this admin happens to be hosted.
        .map((item) => (item.source === 'marketplace' ? { ...item, storeUrl: absoluteStoreUrl(item, base) } : item));
      let items = rows;
      let total = Number(payload.total);
      if (!Number.isFinite(total)) {
        const matched = rows
          .filter((item) => catalogMatches(item, search, category))
          .sort(CATALOG_COMPARATORS[orderby] || CATALOG_COMPARATORS.popular);
        total = matched.length;
        items = matched.slice((page - 1) * perPage, page * perPage);
      }
      const categories = Array.isArray(payload.categories) && payload.categories.length
        ? payload.categories.map((entry) => String(entry).trim()).filter(Boolean)
        : [...new Set(rows.map((item) => item.category))].sort((a, b) => a.localeCompare(b));

      return {
        ok: true,
        items,
        total,
        page: numberOr(payload.page, page),
        perPage: numberOr(payload.per_page, perPage),
        categories,
        orderby,
      };
    } catch {
      return { ok: false, reason: 'network_error', ...empty };
    }
  };

  const base = catalogBaseUrl();
  const first = await read(base);
  if (base === PUBLIC_MARKETPLACE_ORIGIN) return first;

  // The catalogue is public, so a first read that renders nothing is worth a second opinion from the
  // public marketplace: a customer build whose licensing server predates this catalogue contract, the
  // development edition running locally (`remoteLicenseBaseUrl()` answers with its own origin), or a
  // host whose licensing database is empty all end up here. Installing and buying still go to the
  // server this build names — only browsing borrows the public catalogue.
  if (first.ok && first.items.length) return first;
  const published = await read(PUBLIC_MARKETPLACE_ORIGIN);
  // A server that could not be configured has nothing to report, so its verdict is dropped in favour of
  // the public one — that is the catalogue the administrator is being shown either way.
  if (first.reason === 'not_configured') return published;
  return published.ok ? published : first;
};

/**
 * Opens a NOWPayments invoice for one plugin, authenticated by the site identity already stored in
 * this browser. A GET on purpose (see the server's `remote/checkout`), so the cross-origin request
 * needs no CORS preflight. Returns `{ ok, paymentUrl, orderId, pluginId }` or a reason to show.
 */
export const startRemoteCheckout = async (pluginId, domain = window.location.origin) => {
  const identity = readSiteIdentity();
  const base = remoteLicenseBaseUrl();
  if (!base) return { ok: false, reason: 'not_configured' };
  if (!identity.siteToken || !identity.licenseKey) return { ok: false, reason: 'not_activated' };
  try {
    const params = new URLSearchParams({
      siteToken: identity.siteToken,
      licenseKey: identity.licenseKey,
      pluginId,
      domain,
    });
    const response = await fetch(`${remoteRoute('checkout')}?${params.toString()}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    return payload || { ok: false, reason: 'http_error' };
  } catch {
    return { ok: false, reason: 'network_error' };
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

let syncInFlight = null;

/**
 * A post-purchase "state sync": re-verify the license and inject any plugin that is now entitled but
 * was not loaded at boot. Used by the admin marketplace after a payment confirms, so a plugin the user
 * just bought starts working without a page reload. Idempotent; concurrent calls share one request.
 */
export const syncRemotePlugins = async () => {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const identity = readSiteIdentity();
    if (!identity.siteToken || !identity.licenseKey) return [];
    installRemoteRegistry();
    const report = await verifyRemoteLicense(identity);
    if (!report || report.status !== 'active') return [];

    const cleanups = [];
    for (const plugin of report.plugins || []) {
      if (!plugin.pluginId || !plugin.assetToken) continue;
      const entryUrl = `${remoteRoute(`plugins/${encodeURIComponent(plugin.pluginId)}/entry`)}?t=${encodeURIComponent(plugin.assetToken)}`;
      // injectRemoteScript replaces any previous script for the same plugin id, so re-syncing is safe.
      cleanups.push(injectRemoteScript({ pluginId: plugin.pluginId, entryUrl, integrity: plugin.integrity }));
    }
    return cleanups;
  })().finally(() => { syncInFlight = null; });
  return syncInFlight;
};

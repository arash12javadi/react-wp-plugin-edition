/**
 * The marketplace catalogue for the admin "Plugins → Plugins Marketplace" tab.
 *
 * The catalogue is published by the marketplace plugin on react-wp.com (`GET /api/plugins/rwp-plugin-marketplace/catalog/feed`,
 * public, read-only, any origin). It used to be served by the SaaS installer together with a remote script loader and its own
 * USDT checkout; plugin listings, sales and licences now belong to the marketplace alone (20261127), so this file only reads the
 * catalogue. Buying happens on the plugin's product page on react-wp.com, and installing goes through the account link
 * (`src/lib/purchasedPlugins.ts`), where every package's signature and SHA-256 are checked on the site's server.
 *
 * Plain JavaScript because it ships to the browser. It never sends a key or a token anywhere: a catalogue read is anonymous.
 */
import { currentEdition, DEV_EDITION } from './pluginEdition';

/**
 * Where the public marketplace lives when this build names none of its own: the canonical `www` host (the apex
 * 308-redirects every path to it, and a catalogue read should not pay that round-trip).
 */
export const PUBLIC_MARKETPLACE_ORIGIN = 'https://www.react-wp.com';

/**
 * Vite-inlined: the marketplace's origin when it is not react-wp.com (`VITE_RWP_REMOTE_LICENSE_URL`, the name the SaaS installer
 * already writes into every site it creates). The development edition *is* the marketplace, so it reads its own origin first.
 */
const configuredOrigin = () => {
  const configured = typeof import.meta.env !== 'undefined' ? import.meta.env.VITE_RWP_REMOTE_LICENSE_URL : '';
  const resolved = String(configured || '').replace(/\/+$/, '');
  if (/^https?:\/\//i.test(resolved)) return resolved;
  if (typeof window !== 'undefined' && currentEdition() === DEV_EDITION) return window.location.origin;
  return '';
};

/** The origin catalogue reads are addressed to — also the fallback host for a listing with no product URL. */
export const marketplaceOrigin = () => configuredOrigin() || PUBLIC_MARKETPLACE_ORIGIN;

/** Every row of the feed is a marketplace listing (bought and supported on its product page). */
export const isMarketplaceListing = (item) => String(item?.source || 'marketplace') === 'marketplace';

/** The orderings the storefront offers; the feed accepts the same names. */
export const CATALOG_SORTS = ['popular', 'newest', 'rating', 'price', 'price-desc'];

/** How many cards one catalogue page holds unless the caller asks for something else. */
export const CATALOG_PAGE_SIZE = 12;

const catalogSort = (value) => (CATALOG_SORTS.includes(String(value || '')) ? String(value) : 'popular');
const numberOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const stringList = (value) => (Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : []);

/** A listing's product page made absolute against the origin that answered. */
const absoluteStoreUrl = (item, base) => {
  const sent = String(item.storeUrl || '').trim();
  if (/^https?:\/\//i.test(sent)) return sent;
  return `${base}${sent || `/plugins/${encodeURIComponent(item.pluginId)}`}`;
};

/** One catalogue row, coerced into the card shape (an older feed's snake_case names are read too). */
const catalogItem = (item) => ({
  pluginId: String(item?.pluginId || item?.plugin_id || item?.slug || '').trim(),
  source: 'marketplace',
  storeUrl: String(item?.storeUrl || item?.store_url || '').trim(),
  name: String(item?.name || item?.title || '').trim(),
  version: String(item?.version || '').trim(),
  plan: String(item?.plan || '').trim(),
  priceUsd: numberOr(item?.priceUsd ?? item?.price_usd ?? item?.price),
  billingInterval: ['lifetime', 'monthly', 'yearly'].includes(String(item?.billingInterval || item?.billing_interval || ''))
    ? String(item?.billingInterval || item?.billing_interval)
    : 'lifetime',
  description: String(item?.description || '').trim(),
  category: String(item?.category || 'utility').trim() || 'utility',
  author: String(item?.author || '').trim(),
  official: item?.official === true,
  // Only a plain host: shown as text ("sold by …"), never followed from here.
  sellerDomain: /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(String(item?.sellerDomain || '')) ? String(item.sellerDomain).toLowerCase() : '',
  // Only an https image: the address comes from the marketplace feed and is put in an <img src>.
  iconUrl: /^https:\/\//i.test(String(item?.iconUrl || item?.icon_url || '')) ? String(item?.iconUrl || item?.icon_url).trim() : '',
  tags: stringList(item?.tags),
  features: stringList(item?.features),
  docsUrl: /^https:\/\//i.test(String(item?.docsUrl || '')) ? String(item.docsUrl) : '',
  ratingAvg: numberOr(item?.ratingAvg ?? item?.rating_avg),
  ratingCount: numberOr(item?.ratingCount ?? item?.rating_count),
  installs: numberOr(item?.installs),
  updatedAt: String(item?.updatedAt || item?.updated_at || '').trim(),
  integrity: '',
});

/**
 * One page of the marketplace catalogue. Never throws, so the tab can render a friendly "the marketplace is unreachable"
 * state. `{ search, category, orderby, page, perPage }` is the query the public `[rwp_marketplace]` block sends too.
 * When this build's own marketplace has nothing to show (a local development edition with an empty database), the public
 * marketplace is asked as well.
 */
export const fetchRemoteCatalog = async (query = {}) => {
  const page = Math.max(numberOr(query.page, 1), 1);
  const perPage = Math.min(Math.max(numberOr(query.perPage, CATALOG_PAGE_SIZE), 1), 60);
  const search = String(query.search || '').trim();
  const category = String(query.category || '').trim();
  const orderby = catalogSort(query.orderby);
  const empty = { items: [], total: 0, page, perPage, categories: [], orderby };

  const read = async (base) => {
    try {
      const params = new URLSearchParams({ orderby, page: String(page), per_page: String(perPage) });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      const response = await fetch(`${base}/api/plugins/rwp-plugin-marketplace/catalog/feed?${params.toString()}`, { cache: 'no-store', credentials: 'omit' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) return { ok: false, reason: 'http_error', ...empty };
      const items = (Array.isArray(payload.items) ? payload.items : [])
        .map(catalogItem)
        .filter((item) => item.pluginId)
        .map((item) => ({ ...item, storeUrl: absoluteStoreUrl(item, base) }));
      const categories = Array.isArray(payload.categories) && payload.categories.length
        ? payload.categories.map((entry) => String(entry).trim()).filter(Boolean)
        : [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b));
      return {
        ok: true,
        items,
        total: numberOr(payload.total, items.length),
        page: numberOr(payload.page, page),
        perPage: numberOr(payload.per_page, perPage),
        categories,
        orderby,
      };
    } catch {
      return { ok: false, reason: 'network_error', ...empty };
    }
  };

  const base = marketplaceOrigin();
  const first = await read(base);
  if (base === PUBLIC_MARKETPLACE_ORIGIN || (first.ok && first.items.length)) return first;
  const published = await read(PUBLIC_MARKETPLACE_ORIGIN);
  return published.ok ? published : first;
};

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CATALOG_PAGE_SIZE, fetchRemoteCatalog, marketplaceOrigin } from '../lib/remotePlugins';
import { installMarketplacePlugin } from '../lib/gitDeployment';
import { compareVersions } from '../lib/updates';
import { rwp } from '../lib/rwp';
import { installPurchased, loadPurchases, purchaseFor, updatePurchased, type Purchase, type PurchaseOverview } from '../lib/purchasedPlugins';
import styles from './AdminPluginsMarketplace.module.css';

interface Props {
  navigate?: (section: string, subsection?: string) => void;
}

/** One card of the catalogue react-wp.com publishes (`GET /api/plugins/rwp-plugin-marketplace/catalog/feed`). */
interface CatalogItem {
  pluginId: string;
  source: 'remote' | 'marketplace';
  /** The product page on react-wp.com, where a plugin is bought. */
  storeUrl: string;
  name: string;
  version: string;
  plan: string;
  priceUsd: number;
  billingInterval: 'lifetime' | 'monthly' | 'yearly';
  description: string;
  category: string;
  integrity: string;
  author: string;
  /** Published by the marketplace owner: shown as "by React-WP.com" with five bold stars on a gold card. */
  official?: boolean;
  /** Sold from a developer's own shop: that shop takes the payment and delivers the plugin. */
  sellerDomain?: string;
  iconUrl: string;
  tags: string[];
  features: string[];
  docsUrl: string;
  ratingAvg: number;
  ratingCount: number;
  installs: number;
  updatedAt: string;
}

/** One page of the catalogue, as `fetchRemoteCatalog` normalises it. */
interface CatalogPage {
  ok: boolean;
  reason?: string;
  items: CatalogItem[];
  total: number;
  page: number;
  perPage: number;
  categories: string[];
}

const SORT_OPTIONS = [
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Recently updated' },
  { value: 'rating', label: 'Top rated' },
  { value: 'price', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
];

const EMPTY_PAGE: CatalogPage = { ok: true, items: [], total: 0, page: 1, perPage: CATALOG_PAGE_SIZE, categories: [] };

/** "2026-10-29" → "29/10/2026"; an unparseable value is shown as nothing rather than "Invalid Date". */
const day = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
};

/** The category ids are slugs (`seo`, `commerce`); a card heading wants the word. */
const label = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

/** A price, with the term only when there is one to charge. */
const money = (item: CatalogItem) => {
  if (item.priceUsd <= 0) return 'Free';
  const term = item.billingInterval === 'monthly' ? '/mo' : item.billingInterval === 'yearly' ? '/yr' : '';
  return `$${item.priceUsd.toFixed(2)}${term}`;
};

/** A listing's product page: absolute as the server sent it, else built on the origin the catalogue was read from. */
const storeUrlOf = (item: CatalogItem) => {
  const sent = String(item.storeUrl || '').trim();
  if (/^https?:\/\//i.test(sent)) return sent;
  return `${marketplaceOrigin()}${sent || `/plugins/${encodeURIComponent(item.pluginId)}`}`;
};

/** Why the catalogue is empty, in words an administrator can act on. */
const catalogProblem = (reason?: string) => {
  if (reason === 'network_error') return 'The marketplace server could not be reached. Check this site\'s connection, then press Check again.';
  return 'The marketplace catalogue could not be read. Press Check again in a moment.';
};

/**
 * What a card's button is, from what this site already has:
 *   installed  the plugin is in this build (perhaps with a newer version to update to);
 *   install    bought (a key or a developer purchase is on the connected account) or free: one click installs it here;
 *   buy        a paid plugin this site does not own: its product page on react-wp.com (signed in there, the purchase
 *              comes back to this site through the account link, also when the developer's own shop sells it).
 */
type CardState = { kind: 'installed'; newer: string; purchase: Purchase | null } | { kind: 'install'; purchase: Purchase | null } | { kind: 'buy' };

const cardState = (plugin: CatalogItem, purchases: PurchaseOverview | null, running: Map<string, string>): CardState => {
  const purchase = purchaseFor(purchases, plugin.pluginId);
  const runningVersion = running.get(plugin.pluginId) || purchase?.installedVersion || '';
  if (running.has(plugin.pluginId) || purchase?.installed) {
    const latest = purchase?.latestVersion || plugin.version;
    return { kind: 'installed', newer: runningVersion && latest && compareVersions(latest, runningVersion) > 0 ? latest : '', purchase };
  }
  if (purchase?.licensed) return { kind: 'install', purchase };
  if (plugin.priceUsd <= 0) return { kind: 'install', purchase: null };
  return { kind: 'buy' };
};

/**
 * The admin "Plugins → Plugins Marketplace" tab.
 *
 * Browse every plugin published on react-wp.com (free to browse, no account needed). A plugin this site already owns shows
 * Install (or Installed, with Update when a newer version exists) instead of Buy: ownership comes from the account link
 * (`loadPurchases`: RWP2 keys, licences of other sellers, developer purchases). Installing is one click and always goes through a
 * signed package whose signature and SHA-256 are checked on this server before anything is committed. Buying happens on the
 * plugin's product page on react-wp.com; a plugin sold from a developer's own shop is paid there and reported back to the
 * buyer's account, so it appears here as Install after the next sync.
 */
export default function AdminPluginsMarketplace({ navigate }: Props) {
  const [catalog, setCatalog] = useState<CatalogPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [orderby, setOrderby] = useState('popular');
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [details, setDetails] = useState<CatalogItem | null>(null);
  const [purchases, setPurchases] = useState<PurchaseOverview | null>(null);
  const refreshPurchases = useCallback(async () => {
    setPurchases(await loadPurchases().catch(() => null));
  }, []);
  useEffect(() => { void refreshPurchases(); }, [refreshPurchases]);

  // Every plugin this build runs, with its version: a plugin installed from the marketplace is in here, which is what makes its card
  // say Installed instead of offering the install again.
  const running = new Map(rwp.getPlugins().map((plugin) => [plugin.id, plugin.version]));
  const pages = Math.max(1, Math.ceil(catalog.total / Math.max(catalog.perPage, 1)));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced, category, orderby]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void (fetchRemoteCatalog({ search: debounced, category, orderby, page, perPage: CATALOG_PAGE_SIZE }) as Promise<CatalogPage>)
      .then((result) => {
        if (!live) return;
        setCatalog(result.ok ? result : EMPTY_PAGE);
        setError(result.ok ? '' : catalogProblem(result.reason));
        setLoading(false);
      });
    return () => { live = false; };
  }, [debounced, category, orderby, page, reloadToken]);

  /** Runs one card action and shows its sentence. */
  const run = async (plugin: CatalogItem, action: () => Promise<string>) => {
    setBusy(plugin.pluginId);
    setError('');
    setNotice('');
    try {
      setNotice(await action());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `${plugin.name || plugin.pluginId} could not be installed.`);
    } finally {
      setBusy('');
      void refreshPurchases();
    }
  };

  // A free marketplace plugin installs itself: the site fetches the package the marketplace scanned and signed, checks the
  // signature and checksum, commits it to its own repository and redeploys. No ZIP is downloaded or uploaded by hand.
  const installFree = (plugin: CatalogItem) => run(plugin, async () => {
    await installMarketplacePlugin({ id: plugin.pluginId, version: plugin.version });
    return `${plugin.name || plugin.pluginId} ${plugin.version} was added to your site and is being deployed. When the deployment finishes (about a minute), switch it on under Plugins.`;
  });

  const install = (plugin: CatalogItem, purchase: Purchase | null) => (purchase
    ? run(plugin, () => installPurchased(purchase.id, purchase.latestVersion))
    : installFree(plugin));

  const update = (plugin: CatalogItem, purchase: Purchase | null, version: string) => (purchase
    ? run(plugin, () => updatePurchased(purchase.id, version))
    : Promise.resolve(navigate?.('plugins', 'installed')));

  const refreshAll = async () => {
    if (busy) return;
    setBusy('refresh');
    setNotice('');
    setReloadToken((token) => token + 1);
    await refreshPurchases();
    setBusy('');
    setNotice('Marketplace refreshed.');
  };

  const action = (plugin: CatalogItem) => {
    const state = cardState(plugin, purchases, running);
    const working = busy === plugin.pluginId;
    if (state.kind === 'installed') {
      return state.newer ? (
        <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void update(plugin, state.purchase, state.newer)}>
          {working ? 'Updating…' : `Update to v${state.newer}`}
        </button>
      ) : <span className={styles.owned} title="Already installed on this site">✓ Installed</span>;
    }
    if (state.kind === 'install') {
      return (
        <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void install(plugin, state.purchase)}>
          {working ? 'Installing…' : 'Install'}
        </button>
      );
    }
    return (
      <a className={styles.primary} href={storeUrlOf(plugin)} target="_blank" rel="noreferrer">
        Buy{plugin.sellerDomain ? ' from the developer' : ''}
      </a>
    );
  };

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Plugins Marketplace</h2>
          <p className={styles.subtitle}>
            Every plugin published on react-wp.com. Plugins you already own say <strong>Install</strong> or <strong>Installed</strong>;
            {purchases?.connected
              ? ' your purchases come from your connected react-wp.com account.'
              : ' connect this site to your react-wp.com account (Plugins → Connect to react-wp.com) so what you buy shows up here.'}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => void refreshAll()}>
            {busy === 'refresh' ? 'Refreshing…' : 'Check again'}
          </button>
        </div>
      </header>

      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the catalogue…"
          aria-label="Search plugins"
        />
        <select className={styles.select} value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {catalog.categories.map((id) => <option key={id} value={id}>{label(id)}</option>)}
        </select>
        <select className={styles.select} value={orderby} onChange={(event) => setOrderby(event.target.value)} aria-label="Sort plugins">
          {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      {loading && !catalog.items.length ? (
        <p className={styles.muted} role="status">Loading the catalogue…</p>
      ) : !catalog.items.length ? (
        <p className={styles.muted}>
          {search || category
            ? 'No plugin matches that search. Clear the filters to see the whole catalogue.'
            : 'No plugin is published in the marketplace yet.'}
        </p>
      ) : (
        <ul className={styles.grid}>
          {catalog.items.map((plugin) => (
            <li key={plugin.pluginId} className={plugin.official ? `${styles.card} ${styles.cardOfficial}` : styles.card}>
              <div className={styles.cardTop}>
                {plugin.iconUrl ? <img className={styles.cardIcon} src={plugin.iconUrl} alt="" width={32} height={32} loading="lazy" referrerPolicy="no-referrer" /> : null}
                <span className={styles.category}>{label(plugin.category)}</span>
                {plugin.sellerDomain ? <span className={styles.listing} title={`Sold and delivered by ${plugin.sellerDomain}`}>Developer</span> : null}
                {plugin.version ? <em className={styles.version}>v{plugin.version}</em> : null}
              </div>
              <button type="button" className={styles.name} onClick={() => setDetails(plugin)}>
                {plugin.name || plugin.pluginId}
              </button>
              {plugin.author ? <span className={styles.author}>by {plugin.author}{plugin.sellerDomain ? ` · ${plugin.sellerDomain}` : ''}</span> : null}
              {plugin.official ? (
                <span className={styles.officialStars} role="img" aria-label="Official React-WP.com plugin, rated 5 out of 5 stars">
                  <span aria-hidden="true">★★★★★</span> <em>Official</em>
                </span>
              ) : null}
              <p className={styles.excerpt}>{plugin.description || 'The publisher has not described this plugin yet.'}</p>
              {plugin.tags.length > 0 && (
                <ul className={styles.tags}>
                  {plugin.tags.slice(0, 4).map((tag) => <li key={tag} className={styles.tag}>{tag}</li>)}
                </ul>
              )}
              <div className={styles.cardFooter}>
                <strong className={styles.price}>{money(plugin)}</strong>
                {action(plugin)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav className={styles.pagination} aria-label="Catalogue pages">
          <button type="button" className={styles.secondary} disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            Previous
          </button>
          <span className={styles.pageInfo}>
            Page {catalog.page} of {pages} · {catalog.total} plugin{catalog.total === 1 ? '' : 's'}
          </span>
          <button type="button" className={styles.secondary} disabled={page >= pages || loading} onClick={() => setPage((current) => current + 1)}>
            Next
          </button>
        </nav>
      )}

      <p className={styles.footerNote}>
        Free plugins install here in one click. Paid plugins are bought on react-wp.com (or on the developer&apos;s own shop it sends you
        to) and then install here from your connected account. Every package is checked on this server, signature and SHA-256 checksum,
        before it is committed to your repository. Manage what you own under{' '}
        <button type="button" className={styles.link} onClick={() => navigate?.('plugins', 'my-purchases')}>My Purchases</button>.
      </p>

      {details ? (
        <PluginDialog plugin={details} action={action(details)} onClose={() => setDetails(null)} />
      ) : null}
    </div>
  );
}

/**
 * What one catalogue entry says about itself, opened from a card so the grid stays scannable. Same focus, Escape and backdrop
 * conventions as `PluginDetailsModal`, and the card's own button is repeated here so a detail view is never a dead end.
 */
function PluginDialog({ plugin, action, onClose }: { plugin: CatalogItem; action: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Held in a ref so a parent re-render (busy state, for instance) does not re-run the focus effect.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="rwp-marketplace-dialog-title" tabIndex={-1}>
        <div className={styles.dialogHeader}>
          <div>
            <h3 id="rwp-marketplace-dialog-title" className={styles.dialogTitle}>{plugin.name || plugin.pluginId}</h3>
            <p className={styles.dialogMeta}>
              {label(plugin.category)}
              {plugin.version ? ` · v${plugin.version}` : ''}
              {plugin.author ? ` · ${plugin.author}` : ''}
              {plugin.plan ? ` · plan ${plugin.plan}` : ''}
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={styles.dialogBody}>
          <p className={styles.description}>{plugin.description || 'The publisher has not described this plugin yet.'}</p>
          {plugin.sellerDomain ? (
            <p className={styles.listingNote}>
              Sold by {plugin.sellerDomain}, the developer&apos;s own shop: you pay there, and the developer handles support and refunds.
              Buy while signed in to react-wp.com and the purchase appears under your account and on this site.
            </p>
          ) : null}
          {plugin.features.length > 0 && (
            <ul className={styles.features}>{plugin.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
          )}
          <ul className={styles.dialogFacts}>
            <li><span>Price</span><strong>{money(plugin)}</strong></li>
            <li><span>Plugin id</span><code>{plugin.pluginId}</code></li>
            {plugin.ratingCount > 0 ? <li><span>Rating</span><strong>{plugin.ratingAvg.toFixed(1)} ({plugin.ratingCount})</strong></li> : null}
            {day(plugin.updatedAt) ? <li><span>Updated</span><strong>{day(plugin.updatedAt)}</strong></li> : null}
            <li>
              <span>Product page</span>
              <a className={styles.link} href={storeUrlOf(plugin)} target="_blank" rel="noreferrer">Reviews, questions and support</a>
            </li>
          </ul>
        </div>

        <div className={styles.dialogFooter}>
          {action}
          <button type="button" className={styles.secondary} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

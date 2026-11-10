import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CATALOG_PAGE_SIZE,
  fetchRemoteCatalog,
  isMarketplaceListing,
  marketplaceOrigin,
  readSiteIdentity,
  startRemoteCheckout,
  syncRemotePlugins,
  verifyRemoteLicense,
  waitForRemotePlugin,
} from '../lib/remotePlugins';
import { installPurchased, loadPurchases, purchaseFor, type Purchase, type PurchaseOverview } from '../lib/purchasedPlugins';
import styles from './AdminPluginsMarketplace.module.css';

interface Props {
  navigate?: (section: string, subsection?: string) => void;
}

/** The site identity the central server issued, as stored in this browser. */
interface SiteIdentity {
  siteToken: string;
  licenseKey: string;
  siteUrl: string;
}

/** The storefront shape the central server's `remote/catalog` returns (metadata only). */
interface RemoteCatalogItem {
  pluginId: string;
  /** `remote` = a bundle this site installs in place; `marketplace` = a storefront listing. */
  source: 'remote' | 'marketplace';
  /** Where a listing is bought and downloaded; empty for a remote bundle. */
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
  items: RemoteCatalogItem[];
  total: number;
  page: number;
  perPage: number;
  categories: string[];
}

/** A plugin the licensing server says this site may load. */
interface EntitledPlugin {
  pluginId: string;
  name: string;
  version: string;
  plan: string;
}

interface LicenceState {
  status: string;
  reason: string;
  plan: string;
  expiresAt: string | null;
  plugins: EntitledPlugin[];
}

const SORT_OPTIONS = [
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Recently updated' },
  { value: 'rating', label: 'Top rated' },
  { value: 'price', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
];

const EMPTY_PAGE: CatalogPage = { ok: true, items: [], total: 0, page: 1, perPage: CATALOG_PAGE_SIZE, categories: [] };

const LICENCE_STATUS: Record<string, string> = {
  active: 'Active',
  expired: 'Expired',
  pending_renewal: 'Renewal due',
  revoked: 'Revoked',
  invalid: 'Not verified',
};

const LICENCE_REASONS: Record<string, string> = {
  not_activated: 'no licence key is stored in this browser',
  missing_license: 'no licence key was sent',
  unknown_license: 'the licence key is not recognised',
  site_token_mismatch: 'this browser\'s site token does not match the licence',
  domain_mismatch: 'the licence is bound to another domain',
  license_expired: 'the licence has expired',
  license_revoked: 'the licence has been revoked',
  license_pending_renewal: 'a renewal is due',
  not_configured: 'the marketplace is not available right now',
  network_error: 'the licensing server could not be reached',
};

/** "2026-10-29" → "29/10/2026"; an unparseable value is shown as nothing rather than "Invalid Date". */
const day = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
};

/** The category ids are slugs (`seo`, `commerce`); a card heading wants the word. */
const label = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

/** A price, with the term only when there is one to charge. */
const money = (item: RemoteCatalogItem) => {
  if (item.priceUsd <= 0) return 'Free';
  const term = item.billingInterval === 'monthly' ? '/mo' : item.billingInterval === 'yearly' ? '/yr' : '';
  return `$${item.priceUsd.toFixed(2)}${term}`;
};

const reasonText = (reason: string) => LICENCE_REASONS[reason] || reason.replace(/_/g, ' ') || 'unknown reason';

/**
 * A listing's product page: absolute as the server sent it, else built on the origin the catalogue was
 * read from, so a server that only knows the path still produces a link that works.
 */
const storeUrlOf = (item: RemoteCatalogItem) => {
  const sent = String(item.storeUrl || '').trim();
  if (/^https?:\/\//i.test(sent)) return sent;
  return `${marketplaceOrigin()}${sent || `/plugins/${encodeURIComponent(item.pluginId)}`}`;
};

/**
 * What the card's primary action says. The two halves of the catalogue differ in where the plugin comes
 * from — a listing is bought and downloaded on its product page, a remote bundle is installed here —
 * so the button never promises something this screen cannot do.
 */
const actionLabel = (item: RemoteCatalogItem) => {
  if (isMarketplaceListing(item)) return item.priceUsd <= 0 ? 'Get it free' : 'Buy';
  return item.priceUsd <= 0 ? 'Install free' : 'Buy now';
};

/** Why a remote plugin cannot be installed yet; browsing never asks for a licence. */
const NOT_ACTIVATED_HINT = 'Browsing is free — add your licence key under Plugins → My Purchases to install from here.';

/** Why the catalogue is empty, in words an administrator can act on. */
const catalogProblem = (reason?: string) => {
  if (reason === 'not_configured') {
    // The tab always asks *somewhere* — react-wp.com when this build names no licensing server — so this
    // is the host that answered, not a variable this administrator could have set.
    return 'The marketplace is not available right now. Please try again later.';
  }
  if (reason === 'network_error') {
    return 'The marketplace server could not be reached. Check this site\'s connection, then press Check again.';
  }
  return 'The marketplace catalogue could not be read. Press Check again in a moment.';
};

/** Why checkout was refused, including the verdict the server sent back with it. */
const checkoutProblem = (result: { reason?: string; status?: string } | null, plugin: RemoteCatalogItem) => {
  if (!result) return 'Checkout could not be started.';
  if (result.reason === 'not_activated' || result.reason === 'missing_identity') {
    return 'This site has no stored licence identity yet. Add your licence key under Plugins → My Purchases, then buy.';
  }
  if (result.reason === 'not_configured') return 'The marketplace is not available right now. Please try again later.';
  if (result.reason === 'network_error') return 'The marketplace server could not be reached. Try again in a moment.';
  if (result.reason === 'unknown_plugin') return `${plugin.name} is no longer listed in the marketplace.`;
  if (result.reason === 'missing_plugin') return 'No plugin was named in the checkout request.';
  if (result.status && result.status !== 'active') {
    return `This site's licence is ${result.status}, so ${plugin.name} cannot be bought until it is active again.`;
  }
  return `Checkout for ${plugin.name} failed (${reasonText(result.reason || 'unknown')}).`;
};

/**
 * The admin "Plugins → Marketplace" tab.
 *
 * Browse the central premium-plugin catalogue, install a free plugin or buy a paid one. Browsing is
 * public: the grid renders every published plugin whether or not this site holds a licence, and only
 * installing or buying asks for one. Checkout binds the licence to this domain, so the site's token
 * travels with the request instead of anybody copying a key. What is installed then comes from the
 * licensing server's verdict: a plugin the site is entitled to is injected by the remote loader, which
 * is why a free install can say "active" a second later instead of asking for a reload.
 */
export default function AdminPluginsMarketplace({ navigate }: Props) {
  const [identity, setIdentity] = useState<SiteIdentity>(() => readSiteIdentity() as SiteIdentity);
  const [licence, setLicence] = useState<LicenceState>({ status: 'unknown', reason: '', plan: '', expiresAt: null, plugins: [] });
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
  const [details, setDetails] = useState<RemoteCatalogItem | null>(null);
  // What this site bought through its react-wp.com account (the keys the account link fetched). A plugin it holds a
  // key for says Install, not Buy.
  const [purchases, setPurchases] = useState<PurchaseOverview | null>(null);
  const refreshPurchases = useCallback(async () => {
    setPurchases(await loadPurchases().catch(() => null));
  }, []);
  useEffect(() => { void refreshPurchases(); }, [refreshPurchases]);
  const installSold = async (plugin: RemoteCatalogItem, purchase: Purchase) => {
    setBusy(plugin.pluginId);
    setError('');
    setNotice('');
    try {
      setNotice(await installPurchased(purchase.id, purchase.latestVersion));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `${plugin.name} could not be installed.`);
    } finally {
      setBusy('');
      void refreshPurchases();
    }
  };

  const activated = licence.status === 'active';
  const entitled = useMemo(() => new Set(licence.plugins.map((plugin) => plugin.pluginId)), [licence.plugins]);
  const pages = Math.max(1, Math.ceil(catalog.total / Math.max(catalog.perPage, 1)));

  const refreshLicence = useCallback(async () => {
    const current = readSiteIdentity() as SiteIdentity;
    setIdentity(current);
    if (!current.siteToken || !current.licenseKey) {
      setLicence({ status: 'inactive', reason: 'not_activated', plan: '', expiresAt: null, plugins: [] });
      return;
    }
    const report = (await verifyRemoteLicense(current)) as {
      status?: string;
      reason?: string;
      license?: { plan?: string; expiresAt?: string | null };
      plugins?: EntitledPlugin[];
    };
    setLicence({
      status: String(report?.status || 'invalid'),
      reason: String(report?.reason || ''),
      plan: String(report?.license?.plan || ''),
      expiresAt: report?.license?.expiresAt ? String(report.license.expiresAt) : null,
      plugins: Array.isArray(report?.plugins) ? report.plugins : [],
    });
  }, []);

  // Typing reaches the server only once the administrator has paused; a stale response is dropped.
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


  /**
   * The first licence check, plus the return trip from NOWPayments. Both run once on mount: the
   * `?purchase=` markers are then stripped from the URL, so reloading the tab cannot replay a sync.
   */
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    handledReturn.current = true;

    const params = new URLSearchParams(window.location.search);
    const purchase = params.get('purchase');
    if (!purchase) {
      void refreshLicence();
      return;
    }

    const pluginId = params.get('plugin') || '';
    params.delete('purchase');
    params.delete('plugin');
    const rest = params.toString();
    window.history.replaceState({}, '', `/admin${rest ? `?${rest}` : ''}`);

    if (purchase === 'cancelled') {
      setNotice('Checkout cancelled — nothing was charged.');
      void refreshLicence();
      return;
    }

    setBusy(pluginId || 'return');
    setNotice('Payment received — binding the licence to this site…');
    void (async () => {
      // NOWPayments redirects the buyer back before the IPN necessarily arrives, so the licence is
      // re-checked a few times instead of once: the webhook usually lands within a couple of seconds.
      let loaded = false;
      for (let attempt = 0; attempt < 4 && !loaded; attempt += 1) {
        if (attempt) await new Promise((resolve) => window.setTimeout(resolve, 2500));
        await syncRemotePlugins();
        if (pluginId) loaded = await waitForRemotePlugin(pluginId, 1500);
      }
      await refreshLicence();
      setBusy('');
      setNotice(loaded
        ? 'Payment confirmed. The plugin is licensed to this site and is loading now.'
        : 'Payment confirmed. The new plugin is licensed to this site; reload the admin if it does not appear under Installed Plugins.');
    })();
  }, [refreshLicence]);

  /** One button for both cases: a free plugin is granted on the spot, a paid one leaves for checkout. */
  const install = async (plugin: RemoteCatalogItem) => {
    if (busy) return;
    // A storefront listing is bought and downloaded on its product page — never here, and never
    // against this site's licence. The card renders a link; this guard keeps the two honest.
    if (isMarketplaceListing(plugin)) {
      window.open(storeUrlOf(plugin), '_blank', 'noopener');
      return;
    }
    setBusy(plugin.pluginId);
    setError('');
    setNotice('');

    const result = (await startRemoteCheckout(plugin.pluginId, identity.siteUrl || window.location.origin)) as {
      ok?: boolean;
      free?: boolean;
      paymentUrl?: string;
      reason?: string;
      status?: string;
    };

    if (!result?.ok) {
      setError(checkoutProblem(result, plugin));
      setBusy('');
      await refreshLicence();
      return;
    }

    if (result.free) {
      setNotice(`Adding ${plugin.name} to this site…`);
      // The grant is already recorded server-side; the bundle still has to arrive and register.
      await syncRemotePlugins();
      const loaded = await waitForRemotePlugin(plugin.pluginId);
      await refreshLicence();
      setBusy('');
      setNotice(loaded
        ? `${plugin.name} is installed and active. Its screens are in the sidebar now.`
        : `${plugin.name} is licensed to this site. Reload the admin to finish loading it.`);
      return;
    }

    if (result.paymentUrl) {
      setNotice(`Opening the USDT (TRC20) checkout for ${plugin.name}…`);
      window.location.assign(result.paymentUrl);
      return;
    }

    setBusy('');
    setError(`${plugin.name} could not be sent to checkout. Try again in a moment.`);
  };

  const refreshAll = async () => {
    if (busy) return;
    setBusy('refresh');
    setNotice('Checking the licence and the catalogue…');
    setReloadToken((token) => token + 1);
    await refreshLicence();
    setBusy('');
    setNotice('Marketplace refreshed.');
  };

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Plugins Marketplace</h2>
          <p className={styles.subtitle}>
            Every plugin in the React-WP marketplace, free to browse — no activation needed. A licence
            is only asked for when you install or buy one here, and it binds to{' '}
            <strong>{identity.siteUrl || 'this domain'}</strong>.
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
        <select
          className={styles.select}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {catalog.categories.map((id) => <option key={id} value={id}>{label(id)}</option>)}
        </select>
        <select
          className={styles.select}
          value={orderby}
          onChange={(event) => setOrderby(event.target.value)}
          aria-label="Sort plugins"
        >
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
          {catalog.items.map((plugin) => {
            const sold = isMarketplaceListing(plugin) ? purchaseFor(purchases, plugin.pluginId) : null;
            const owned = entitled.has(plugin.pluginId) || Boolean(sold?.installed);
            const working = busy === plugin.pluginId;
            return (
              <li key={plugin.pluginId} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.category}>{label(plugin.category)}</span>
                  {isMarketplaceListing(plugin) ? <span className={styles.listing}>Marketplace</span> : null}
                  {plugin.version ? <em className={styles.version}>v{plugin.version}</em> : null}
                </div>
                <button type="button" className={styles.name} onClick={() => setDetails(plugin)}>
                  {plugin.name || plugin.pluginId}
                </button>
                {plugin.author ? <span className={styles.author}>by {plugin.author}</span> : null}
                <p className={styles.excerpt}>
                  {plugin.description || 'The publisher has not described this plugin yet.'}
                </p>
                {plugin.tags.length > 0 && (
                  <ul className={styles.tags}>
                    {plugin.tags.slice(0, 4).map((tag) => <li key={tag} className={styles.tag}>{tag}</li>)}
                  </ul>
                )}
                <div className={styles.cardFooter}>
                  <strong className={styles.price}>{money(plugin)}</strong>
                  {owned ? (
                    <span className={styles.owned} title="Already licensed to this site">✓ Installed</span>
                  ) : sold?.licensed ? (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={Boolean(busy)}
                      onClick={() => void installSold(plugin, sold)}
                    >
                      {working ? 'Installing…' : 'Install'}
                    </button>
                  ) : isMarketplaceListing(plugin) ? (
                    <a className={styles.primary} href={storeUrlOf(plugin)} target="_blank" rel="noreferrer">
                      {actionLabel(plugin)}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={Boolean(busy) || !activated}
                      title={activated ? undefined : NOT_ACTIVATED_HINT}
                      onClick={() => void install(plugin)}
                    >
                      {working ? (plugin.priceUsd <= 0 ? 'Installing…' : 'Opening…') : actionLabel(plugin)}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <nav className={styles.pagination} aria-label="Catalogue pages">
          <button
            type="button"
            className={styles.secondary}
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span className={styles.pageInfo}>
            Page {catalog.page} of {pages} · {catalog.total} plugin{catalog.total === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className={styles.secondary}
            disabled={page >= pages || loading}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </nav>
      )}

      {licence.plugins.length > 0 && (
        <section className={styles.entitlements} aria-label="Plugins licensed to this site">
          <div className={styles.entitlementHead}>
            <h3 className={styles.entitlementTitle}>Licensed to this site</h3>
            <button type="button" className={styles.link} onClick={() => navigate?.('plugins', 'installed')}>
              Manage installed plugins
            </button>
          </div>
          <ul className={styles.entitlementList}>
            {licence.plugins.map((plugin) => (
              <li key={plugin.pluginId} className={styles.entitlement}>
                <strong className={styles.entitlementName}>{plugin.name || plugin.pluginId}</strong>
                <span className={styles.entitlementMeta}>
                  <code>{plugin.pluginId}</code>
                  {plugin.version ? ` · v${plugin.version}` : ''}
                  {plugin.plan ? ` · ${plugin.plan}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className={styles.footerNote}>
        Remote plugins install here against this site's licence. A marketplace listing links to its
        product page instead: the package is bought or downloaded there and installed from Plugins →
        Upload Plugin, so it works with or without a licence. Paid plugins are billed in Tether (USDT,
        TRC20) through NOWPayments and confirmed by the licensing server, which binds the entitlement to
        this domain — a second site cannot use it. A free remote plugin is granted the moment you press
        Install, and the loader switches it on without a reload.
      </p>

      {details ? (
        <PluginDialog
          plugin={details}
          owned={entitled.has(details.pluginId)}
          activated={activated}
          busy={busy}
          onClose={() => setDetails(null)}
          onInstall={(plugin) => { setDetails(null); void install(plugin); }}
        />
      ) : null}
    </div>
  );
}

/**
 * What one catalogue entry says about itself, opened from a card so the grid stays scannable. Same
 * focus, Escape and backdrop conventions as `PluginDetailsModal`, because it is the same kind of
 * dialog — and the install button is repeated here so a detail view is never a dead end.
 */
function PluginDialog({ plugin, owned, activated, busy, onClose, onInstall }: {
  plugin: RemoteCatalogItem;
  owned: boolean;
  activated: boolean;
  busy: string;
  onClose: () => void;
  onInstall: (plugin: RemoteCatalogItem) => void;
}) {
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
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rwp-marketplace-dialog-title"
        tabIndex={-1}
      >
        <div className={styles.dialogHeader}>
          <div>
            <h3 id="rwp-marketplace-dialog-title" className={styles.dialogTitle}>
              {plugin.name || plugin.pluginId}
            </h3>
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
          <p className={styles.description}>
            {plugin.description || 'The publisher has not described this plugin yet.'}
          </p>
          {isMarketplaceListing(plugin) ? (
            <p className={styles.listingNote}>
              A marketplace listing — reading about it is free on any site. You buy or download it on its
              product page, then install the package from Plugins → Upload Plugin, so this site's licence
              is never involved.
            </p>
          ) : null}
          {plugin.features.length > 0 && (
            <ul className={styles.features}>
              {plugin.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
          )}
          {plugin.tags.length > 0 && (
            <ul className={styles.tags}>
              {plugin.tags.map((tag) => <li key={tag} className={styles.tag}>{tag}</li>)}
            </ul>
          )}
          <ul className={styles.dialogFacts}>
            <li><span>Price</span><strong>{money(plugin)}</strong></li>
            <li><span>Plugin id</span><code>{plugin.pluginId}</code></li>
            {plugin.ratingCount > 0 ? (
              <li><span>Rating</span><strong>{plugin.ratingAvg.toFixed(1)} ({plugin.ratingCount})</strong></li>
            ) : null}
            {day(plugin.updatedAt) ? <li><span>Updated</span><strong>{day(plugin.updatedAt)}</strong></li> : null}
            {plugin.docsUrl ? (
              <li>
                <span>Docs</span>
                <a className={styles.link} href={plugin.docsUrl} target="_blank" rel="noreferrer">Open documentation</a>
              </li>
            ) : null}
          </ul>
        </div>

        <div className={styles.dialogFooter}>
          {owned ? (
            <span className={styles.owned}>✓ Licensed to this site</span>
          ) : isMarketplaceListing(plugin) ? (
            <a className={styles.primary} href={storeUrlOf(plugin)} target="_blank" rel="noreferrer">
              {actionLabel(plugin)}
            </a>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={Boolean(busy) || !activated}
              title={activated ? undefined : NOT_ACTIVATED_HINT}
              onClick={() => onInstall(plugin)}
            >
              {busy === plugin.pluginId ? 'Working…' : actionLabel(plugin)}
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}


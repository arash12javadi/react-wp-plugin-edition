import { useCallback, useEffect, useState } from 'react';
import {
  fetchRemoteCatalog,
  readSiteIdentity,
  startRemoteCheckout,
  syncRemotePlugins,
  verifyRemoteLicense,
} from '../lib/remotePlugins';
import styles from './AdminPluginsMarketplace.module.css';

/** The storefront shape the central server's `remote/catalog` returns (metadata only). */
interface RemoteCatalogItem {
  pluginId: string;
  name: string;
  version: string;
  plan: string;
  priceUsd: number;
  billingInterval: 'lifetime' | 'monthly' | 'yearly';
  description: string;
  category: string;
  integrity: string;
}

const money = (value: number): string => (value <= 0 ? 'Free' : `$${Number(value).toFixed(2)}`);

/**
 * The admin "Plugins → Marketplace" tab: browse the central premium-plugin catalogue, buy a plugin
 * with the site's own token (NOWPayments, USDT TRC20), and — after the IPN confirms — the remote
 * loader recognises the new entitlement on the next sync, no manual key entry.
 */
export default function AdminPluginsMarketplace() {
  const [identity] = useState(() => readSiteIdentity());
  const [catalog, setCatalog] = useState<RemoteCatalogItem[] | null>(null);
  const [entitled, setEntitled] = useState<Set<string>>(new Set());
  const [licenseActive, setLicenseActive] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setError('');
    const [catalogResult, report] = await Promise.all([fetchRemoteCatalog(), verifyRemoteLicense()]);
    if (!catalogResult.ok) {
      setError('The plugin marketplace could not be reached. Check that the licensing server is configured.');
      setCatalog([]);
    } else {
      setCatalog(catalogResult.items);
    }
    setLicenseActive(report?.status === 'active');
    setEntitled(new Set((report?.plugins || []).map((plugin) => plugin.pluginId)));
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Returning from the NOWPayments redirect: success/cancelled are carried in the admin URL.
  useEffect(() => {
    const purchase = new URLSearchParams(window.location.search).get('purchase');
    if (purchase === 'success') {
      setNotice('Payment received — syncing your new plugin…');
      void syncRemotePlugins().then(() => void load());
    } else if (purchase === 'cancelled') {
      setNotice('Checkout was cancelled. Nothing was charged.');
    }
  }, [load]);

  const buy = async (plugin: RemoteCatalogItem) => {
    setBusy(plugin.pluginId);
    setError('');
    setNotice('');
    const result = await startRemoteCheckout(plugin.pluginId);
    if (!result?.ok) {
      setError(result?.reason === 'not_activated'
        ? 'Activate this site\'s premium license before buying plugins from the marketplace.'
        : 'Checkout could not be started. Is the licensing server reachable?');
      setBusy('');
      return;
    }
    if (result.free) {
      setNotice(`${plugin.name} is now active on this site.`);
      await syncRemotePlugins();
      await load();
    } else if (result.paymentUrl) {
      // Same-tab redirect, like the public storefront: NOWPayments returns the buyer to the admin
      // marketplace URL with `?purchase=success|cancelled`, which the effect above handles.
      window.location.assign(result.paymentUrl);
      return;
    }
    setBusy('');
  };

  const checkAgain = async () => {
    setBusy('check');
    setNotice('Checking…');
    await syncRemotePlugins();
    await load();
    setBusy('');
    setNotice('Licence checked. Entitled plugins are active on this site.');
  };

  const activated = Boolean(identity.siteToken && identity.licenseKey) && licenseActive;

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Plugins Marketplace</h2>
          <p className={styles.subtitle}>
            Browse and buy premium plugins from the central React-WP catalogue. Purchases are paid with
            Tether (USDT, TRC20) and are bound to this site automatically.
          </p>
        </div>
        <button type="button" className={styles.secondary} disabled={busy === 'check'} onClick={() => void checkAgain()}>
          {busy === 'check' ? 'Checking…' : 'Check again'}
        </button>
      </header>

      {!activated && (
        <p className={styles.banner}>
          This site has no active premium license, so purchases are disabled. Activate your license first —
          the marketplace will then bind new plugins to this site automatically.
        </p>
      )}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      {!catalog ? (
        <p className={styles.muted}>Loading plugins…</p>
      ) : !catalog.length ? (
        <p className={styles.muted}>No plugins are published in the marketplace yet.</p>
      ) : (
        <ul className={styles.grid}>
          {catalog.map((plugin) => {
            const owned = entitled.has(plugin.pluginId);
            const buying = busy === plugin.pluginId;
            return (
              <li key={plugin.pluginId} className={styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.category}>{plugin.category}</span>
                  <strong className={styles.name}>{plugin.name}</strong>
                  {plugin.version && <em className={styles.version}>v{plugin.version}</em>}
                </div>
                {plugin.description && <p className={styles.description}>{plugin.description}</p>}
                <div className={styles.cardFooter}>
                  <strong className={styles.price}>
                    {money(plugin.priceUsd)}
                    {plugin.priceUsd > 0 && plugin.billingInterval === 'monthly' ? '/mo' : ''}
                    {plugin.priceUsd > 0 && plugin.billingInterval === 'yearly' ? '/yr' : ''}
                  </strong>
                  {owned ? (
                    <span className={styles.owned} title="Already entitled">✓ Active</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={buying || !activated}
                      onClick={() => void buy(plugin)}
                    >
                      {buying ? 'Opening…' : plugin.priceUsd <= 0 ? 'Install free' : 'Buy / Checkout'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className={styles.footerNote}>
        Entitlements are verified by the central licensing server on every state sync. A plugin bought here
        is loaded automatically — no license key to copy.
      </p>
    </div>
  );
}

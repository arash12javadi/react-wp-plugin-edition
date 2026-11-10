import { useCallback, useEffect, useState } from 'react';
import { client, getSystemSetting, setSystemSetting } from '../lib/db';
import { installPurchased, loadPurchases, type Purchase, type PurchaseOverview } from '../lib/purchasedPlugins';
import styles from './MyPurchases.module.css';

/**
 * Plugins → My Purchases.
 *
 * What this site bought on react-wp.com, with one button. A site connected to its react-wp.com account already
 * holds its keys (the account link fetches them), so each purchase is listed by name and **Install** adds it the one
 * safe way: react-wp.com signs the package for this site, the site checks it, and only then commits it to its own
 * repository (`POST /api/admin/license-link/install`).
 *
 * A site that is not connected can still paste a key by hand (the closed section at the bottom). That older path
 * asks the marketplace to verify the key and then uploads the package by URL, exactly like Plugins → Upload.
 * Those keys live in `system_settings.plugin_purchase_licenses` rather than `options`: every `options` row is public,
 * and a licence key is a credential a visitor must never be able to read back.
 */

const MARKETPLACE_ORIGIN = 'https://www.react-wp.com';
const SETTING_KEY = 'plugin_purchase_licenses';
const UPLOAD_ENDPOINT = '/api/admin/plugins/upload';
const PLUGINS_SCREEN = '/admin?section=plugins&tab=installed';

interface VerifyResult {
  plugin_id: string;
  title: string;
  slug: string;
  version: string;
  download_url: string;
  status: string;
}

interface Entry {
  key: string;
  result: VerifyResult | null;
  checked: boolean;
  error: string;
}

interface StoredSettings {
  keys?: string[];
}

const domain = () => (typeof window !== 'undefined' ? window.location.origin : '');

async function accessToken(): Promise<string> {
  const { data } = await client.auth.getSession();
  return data.session?.access_token || '';
}

/** `POST <marketplace>/verify` — public, anon-callable: the key in the body is the credential. */
async function verifyKey(key: string): Promise<VerifyResult | null> {
  const response = await fetch(`${MARKETPLACE_ORIGIN}/api/plugins/rwp-plugin-marketplace/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: key, domain: domain() }),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const body = await response.json().catch(() => null) as VerifyResult | null;
  return body || null;
}

/** `POST <marketplace>/download` — resolves a protected, signed, short-lived package URL. */
async function resolveDownloadUrl(key: string): Promise<string> {
  const response = await fetch(`${MARKETPLACE_ORIGIN}/api/plugins/rwp-plugin-marketplace/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: key, domain: domain() }),
  });
  const body = await response.json().catch(() => null) as { download_url?: string; error?: string } | null;
  if (!response.ok || !/^https:\/\//i.test(String(body?.download_url || ''))) {
    throw new Error(body?.error || 'The marketplace did not return a package for this licence.');
  }
  return String(body?.download_url);
}

type InstallEvent =
  | { type: 'step'; step: string }
  | { type: 'result'; result: { plugin: { name: string; version: string }; mode?: string; commit?: { repository: string; branch: string } } }
  | { type: 'error'; error: string };

const parseLine = (line: string, onStep: (step: string) => void, last: InstallEvent): InstallEvent => {
  if (!line.trim()) return last;
  try {
    const event = JSON.parse(line) as InstallEvent;
    if (event.type === 'step') {
      onStep(event.step);
      return last;
    }
    return event;
  } catch {
    // A line that is not JSON is skipped rather than failing the whole install over one bad chunk.
    return last;
  }
};

/** Streams `/api/admin/plugins/upload`'s NDJSON response and returns the last event reached. */
async function installFromUrl(url: string, onStep: (step: string) => void): Promise<InstallEvent> {
  const token = await accessToken();
  if (!token) throw new Error('Sign in again as a plugin manager, then retry.');
  const response = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  });
  // A refusal is one JSON body, not a stream: read it as the reason instead of waiting for steps that never come.
  if (!response.ok || !(response.headers.get('content-type') || '').includes('ndjson')) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error || 'This site could not install the package. Try again in a moment.');
  }
  if (!response.body) throw new Error('This site could not install the package. Try again in a moment.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: InstallEvent = { type: 'error', error: 'The install did not finish. Try again in a moment.' };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      last = parseLine(buffer.slice(0, newline), onStep, last);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  // The last line has no newline after it when the stream ends, and it is usually the one that says how it went.
  return parseLine(buffer + decoder.decode(), onStep, last);
}

const readStoredKeys = (value: unknown): string[] => {
  const keys = (value as StoredSettings | null)?.keys;
  return Array.isArray(keys) ? keys.filter((item): item is string => typeof item === 'string') : [];
};

export default function MyPurchases() {
  const [overview, setOverview] = useState<PurchaseOverview | null>(null);
  const [working, setWorking] = useState('');
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});

  const [entries, setEntries] = useState<Entry[]>([]);
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<string>('');
  const [installStep, setInstallStep] = useState('');
  const [installMessage, setInstallMessage] = useState<Record<string, { ok: boolean; text: string }>>({});

  const refreshOverview = useCallback(async () => {
    setOverview(await loadPurchases().catch(() => ({ connected: false, purchases: [] })));
  }, []);

  const refreshOne = useCallback(async (key: string): Promise<Entry> => {
    const result = await verifyKey(key);
    return { key, result, checked: true, error: result ? '' : 'Not active for this site. Check the key.' };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const stored = await getSystemSetting<StoredSettings>(SETTING_KEY, { keys: [] });
      const keys = readStoredKeys(stored);
      const checked = await Promise.all(keys.map(refreshOne));
      setEntries(checked);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not read the stored licence keys.');
    } finally {
      setLoading(false);
    }
  }, [refreshOne]);

  useEffect(() => { void refreshOverview(); void load(); }, [refreshOverview, load]);

  const installOne = async (purchase: Purchase) => {
    setWorking(purchase.id);
    setNotes((current) => ({ ...current, [purchase.id]: { ok: true, text: '' } }));
    try {
      const text = await installPurchased(purchase.id, purchase.latestVersion);
      setNotes((current) => ({ ...current, [purchase.id]: { ok: true, text } }));
    } catch (failure) {
      setNotes((current) => ({
        ...current,
        [purchase.id]: { ok: false, text: failure instanceof Error ? failure.message : `${purchase.name} could not be installed.` },
      }));
    } finally {
      setWorking('');
    }
  };

  const saveKeys = async (keys: string[]) => {
    const ok = await setSystemSetting(SETTING_KEY, { keys });
    if (!ok) throw new Error('This browser is not allowed to store licence keys here. Sign in again as an administrator.');
  };

  const install = async (key: string) => {
    setInstalling(key);
    setInstallStep('downloading');
    setInstallMessage((prev) => ({ ...prev, [key]: { ok: true, text: '' } }));
    try {
      const url = await resolveDownloadUrl(key);
      const outcome = await installFromUrl(url, setInstallStep);
      if (outcome.type === 'error') throw new Error(outcome.error);
      if (outcome.type === 'result') {
        const { plugin, mode, commit } = outcome.result;
        const where = mode === 'github' && commit
          ? 'was added to your site and goes live with the next build'
          : 'is installed';
        setInstallMessage((prev) => ({ ...prev, [key]: { ok: true, text: `${plugin.name} ${plugin.version} ${where}.` } }));
      }
    } catch (installError) {
      setInstallMessage((prev) => ({
        ...prev,
        [key]: { ok: false, text: installError instanceof Error ? installError.message : 'Could not install this plugin.' },
      }));
    } finally {
      setInstalling('');
      setInstallStep('');
    }
  };

  const addKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    setError('');
    const entry = await refreshOne(key);
    const next = [...entries.filter((item) => item.key !== key), entry];
    setEntries(next);
    setNewKey('');
    try {
      await saveKeys(next.map((item) => item.key));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this licence key.');
    }
  };

  const removeKey = async (key: string) => {
    const next = entries.filter((item) => item.key !== key);
    setEntries(next);
    try {
      await saveKeys(next.map((item) => item.key));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not remove this licence key.');
    }
  };

  const purchases = overview?.purchases || [];

  return (
    <div className={styles.panel}>
      <h1 className={styles.heading}>My Purchases</h1>
      <p className={styles.intro}>
        Plugins you bought on <a href={MARKETPLACE_ORIGIN} target="_blank" rel="noreferrer">react-wp.com</a>.
      </p>

      {overview === null ? (
        <p className={styles.muted} role="status">Looking for your purchases…</p>
      ) : purchases.length > 0 ? (
        <ul className={styles.cards}>
          {purchases.map((purchase) => (
            <li key={purchase.id} className={styles.card}>
              <div className={styles.cardMain}>
                <span className={styles.cardName}>{purchase.name}</span>
                {purchase.installed ? (
                  <span className={styles.chipOk}>Installed{purchase.installedVersion ? ` · v${purchase.installedVersion}` : ''}</span>
                ) : purchase.licensed ? (
                  <span className={styles.chipWait}>Ready to install</span>
                ) : (
                  <span className={styles.chipBad}>Licence expired</span>
                )}
              </div>
              {!purchase.installed && purchase.licensed && (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={working !== ''}
                  onClick={() => void installOne(purchase)}
                >
                  {working === purchase.id ? 'Installing…' : 'Install'}
                </button>
              )}
              {notes[purchase.id]?.text && (
                <p className={notes[purchase.id].ok ? styles.notice : styles.error} role="status">{notes[purchase.id].text}</p>
              )}
            </li>
          ))}
        </ul>
      ) : overview.connected ? (
        <p className={styles.empty}>
          Nothing to install yet. When you buy a plugin on react-wp.com it shows up here by itself.
        </p>
      ) : (
        <div className={styles.empty}>
          <p>Connect this site to your react-wp.com account and what you bought appears here, ready to install.</p>
          <a className={styles.primary} href={PLUGINS_SCREEN}>Connect this site</a>
        </div>
      )}

      <details className={styles.more}>
        <summary>Have a licence key? Add it by hand</summary>
        <div className={styles.addRow}>
          <input
            className={styles.input}
            value={newKey}
            onChange={(event) => setNewKey(event.target.value)}
            placeholder="RWPM-… or RWP2-…"
            onKeyDown={(event) => { if (event.key === 'Enter') void addKey(); }}
          />
          <button type="button" className={styles.secondary} onClick={() => void addKey()} disabled={!newKey.trim()}>
            Add key
          </button>
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}
        {loading ? (
          <p className={styles.muted} role="status">Checking your keys…</p>
        ) : entries.length > 0 && (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.key} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.title}>
                    {entry.result ? `${entry.result.title} v${entry.result.version}` : 'Licence key'}
                  </span>
                  <span className={entry.result ? styles.statusOk : styles.statusBad}>
                    {entry.result ? entry.result.status : entry.error || 'Not active'}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={!entry.result || installing === entry.key}
                    onClick={() => void install(entry.key)}
                  >
                    {installing === entry.key ? `${installStep || 'working'}…` : 'Install'}
                  </button>
                  <button type="button" className={styles.danger} onClick={() => void removeKey(entry.key)}>Remove</button>
                </div>
                {installMessage[entry.key]?.text && (
                  <p className={installMessage[entry.key].ok ? styles.notice : styles.error} role="status">
                    {installMessage[entry.key].text}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { client, getSystemSetting, setSystemSetting } from '../lib/db';
import styles from './MyPurchases.module.css';

/**
 * Plugins → My Purchases.
 *
 * A marketplace purchase happens on react-wp.com (the marketplace is development-edition-only and
 * never ships here), so this site cannot read it from its own database — it has to ask the
 * marketplace, by the one thing a buyer actually holds: the licence key. Pasting it here is the
 * handshake; after that this screen re-checks it on its own, and installing is one click that reuses
 * the exact path Plugins → Upload Plugin already uses (`/api/admin/plugins/upload` with a URL), so a
 * licensed plugin lands the same way an uploaded ZIP would — on disk, or committed to this site's
 * connected GitHub repository, whichever this host does.
 *
 * Stored keys live in `system_settings.plugin_purchase_licenses` rather than `options`: every `options`
 * row is public (the homepage reads `site_title` before anyone signs in), and a licence key is a
 * credential a visitor must never be able to read back.
 */

const MARKETPLACE_ORIGIN = 'https://www.react-wp.com';
const SETTING_KEY = 'plugin_purchase_licenses';
const UPLOAD_ENDPOINT = '/api/admin/plugins/upload';

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
  if (!response.ok || !body?.download_url) {
    throw new Error(body?.error || 'The marketplace did not return a package for this licence.');
  }
  return body.download_url;
}

type InstallEvent =
  | { type: 'step'; step: string }
  | { type: 'result'; result: { plugin: { name: string; version: string }; mode?: string; commit?: { repository: string; branch: string } } }
  | { type: 'error'; error: string };

/** Streams `/api/admin/plugins/upload`'s NDJSON response and returns the last step reached. */
async function installFromUrl(url: string, onStep: (step: string) => void): Promise<InstallEvent> {
  const token = await accessToken();
  if (!token) throw new Error('Sign in again as a plugin manager, then retry.');
  const response = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  });
  if (!response.body) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `The upload endpoint answered HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: InstallEvent = { type: 'error', error: 'The install produced no result.' };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const event = JSON.parse(line) as InstallEvent;
        if (event.type === 'step') onStep(event.step);
        else last = event;
      } catch {
        // A line that is not JSON is skipped rather than failing the whole install over one bad chunk.
      }
    }
  }
  return last;
}

const readStoredKeys = (value: unknown): string[] => {
  const keys = (value as StoredSettings | null)?.keys;
  return Array.isArray(keys) ? keys.filter((item): item is string => typeof item === 'string') : [];
};

export default function MyPurchases() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<string>('');
  const [installStep, setInstallStep] = useState('');
  const [installMessage, setInstallMessage] = useState<Record<string, { ok: boolean; text: string }>>({});

  const refreshOne = useCallback(async (key: string): Promise<Entry> => {
    const result = await verifyKey(key);
    return { key, result, checked: true, error: result ? '' : 'Not active for this site (check the key, or activate it here first).' };
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

  useEffect(() => { void load(); }, [load]);

  const saveKeys = async (keys: string[]) => {
    const ok = await setSystemSetting(SETTING_KEY, { keys });
    if (!ok) throw new Error('This browser is not allowed to store licence keys here. Sign in again as an administrator.');
  };

  const install = async (key: string) => {
    setInstalling(key);
    setInstallStep('downloading from the marketplace');
    setInstallMessage((prev) => ({ ...prev, [key]: { ok: true, text: '' } }));
    try {
      const url = await resolveDownloadUrl(key);
      const outcome = await installFromUrl(url, setInstallStep);
      if (outcome.type === 'error') throw new Error(outcome.error);
      if (outcome.type === 'result') {
        const { plugin, mode, commit } = outcome.result;
        const where = mode === 'github' && commit
          ? `committed to ${commit.repository}@${commit.branch} — it goes live on the next build`
          : 'installed';
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
      return;
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

  return (
    <div className={styles.panel}>
      <h1 className={styles.heading}>My Purchases</h1>
      <p className={styles.intro}>
        Plugins bought on <a href={MARKETPLACE_ORIGIN} target="_blank" rel="noreferrer">react-wp.com</a>.
        Paste a licence key once — it is checked against this site's domain. When it is active, press
        Install to add the plugin to this site. A saved key is re-checked and can be reinstalled (for an update) any time.
      </p>

      <div className={styles.addRow}>
        <input
          className={styles.input}
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
          placeholder="RWPM-… or RWP1-…"
          onKeyDown={(event) => { if (event.key === 'Enter') void addKey(); }}
        />
        <button type="button" className={styles.primary} onClick={() => void addKey()} disabled={!newKey.trim()}>
          Add licence key
        </button>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {loading ? (
        <p className={styles.muted} role="status">Checking your licences…</p>
      ) : entries.length === 0 ? (
        <p className={styles.muted}>No licence keys yet. Paste one above after buying a plugin.</p>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.key} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.title}>
                  {entry.result ? `${entry.result.title} v${entry.result.version}` : entry.key}
                </span>
                <code className={styles.key}>{entry.key}</code>
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
                <p className={installMessage[entry.key].ok ? styles.notice : styles.error}>
                  {installMessage[entry.key].text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

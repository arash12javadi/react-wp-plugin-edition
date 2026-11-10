import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { callLink, type LinkState } from '../lib/licenseLinkApi';
import { PLUGIN_LICENSE_SHOP_URL } from '../lib/pluginLicense.js';
import styles from './LicenseLinkPanel.module.css';

const readable = (value: string): string => {
  const parsed = new Date(value);
  return value && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString() : 'never';
};

/**
 * Plugins → "Connect to react-wp.com". The platform owner pastes the one-time code from My licenses on
 * react-wp.com; from then on this site fetches its own keys (once a day at a time derived from the site, and
 * on "Sync now"). Shown to the platform owner only: for anyone else the server answers 403 and nothing renders.
 * Calls `onChanged` after keys were stored, so the table above re-reads its License column.
 */
export default function LicenseLinkPanel({ onChanged }: { onChanged?: () => void }) {
  const [link, setLink] = useState<LinkState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [code, setCode] = useState('');
  const [autoInstall, setAutoInstall] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { status, answer } = await callLink('', 'GET');
    if (status === 401 || status === 403 || status === 404 || status === 501) { setHidden(true); return; }
    if (answer.link) setLink(answer.link);
    else if (answer.error) setError(answer.error);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (name: string, path: string, body?: Record<string, unknown>) => {
    setBusy(name);
    setError('');
    setMessage('');
    const { status, answer } = await callLink(path, 'POST', body ?? {});
    setBusy('');
    if (answer.link) setLink(answer.link);
    if (status >= 400 || answer.ok === false) {
      setError(answer.error || `The request failed (HTTP ${status}).`);
      return false;
    }
    setMessage(answer.sync?.message || answer.message || 'Done.');
    if (answer.sync?.changed) onChanged?.();
    return true;
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (await run('connect', '/connect', { code: code.trim(), autoInstall })) setCode('');
  };

  if (hidden) return null;
  if (!link) return error ? <p className={styles.error} role="alert">{error}</p> : null;

  return (
    <section className={styles.panel} aria-labelledby="license-link-heading">
      <h3 id="license-link-heading">Connect to react-wp.com</h3>
      {link.connected ? (
        <>
          <p>
            This site (<strong>{link.domain}</strong>) fetches its licence keys from your react-wp.com account, so renewals arrive by themselves.
            Last checked: {readable(link.lastSyncAt)}. Next automatic check: {readable(link.nextSyncAt)}.
          </p>
          {link.lastResult && (
            <p className={link.lastResult.ok ? styles.ok : styles.error} role="status">{link.lastResult.message}</p>
          )}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={link.autoInstall}
              disabled={Boolean(busy)}
              onChange={(event) => void run('settings', '/settings', { autoInstall: event.target.checked })}
            />{' '}
            Install the plugins I assigned to this site on react-wp.com automatically
          </label>
          <p className={styles.hint}>
            A plugin is added to this site&rsquo;s GitHub repository only after its signature and checksum verify, arrives switched off,
            and needs GitHub and Vercel connected under Settings → Integrations. You still press Activate.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void run('sync', '/sync')}>
              {busy === 'sync' ? 'Checking…' : 'Sync now'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={Boolean(busy)}
              onClick={() => { if (window.confirm('Disconnect this site? It keeps the keys it already has, but stops receiving renewals.')) void run('disconnect', '/disconnect'); }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={connect}>
          <p>
            Skip pasting keys: on <a href={PLUGIN_LICENSE_SHOP_URL} target="_blank" rel="noreferrer noopener">react-wp.com</a> open
            <strong> My licenses → Connect a site</strong>, then enter the code it shows. You never type your account password here.
          </p>
          {!link.secretBox && (
            <p className={styles.error} role="alert">
              This server cannot store the connection yet: set <code>RWP_SECRET_BOX_KEY</code> in its environment and restart it.
            </p>
          )}
          <div className={styles.actions}>
            <label htmlFor="license-link-code" className={styles.srOnly}>Pairing code</label>
            <input
              id="license-link-code"
              className={styles.input}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCDE-12345"
              autoComplete="off"
              spellCheck={false}
              maxLength={16}
            />
            <button type="submit" className={styles.primary} disabled={Boolean(busy) || !code.trim() || !link.secretBox}>
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={autoInstall} onChange={(event) => setAutoInstall(event.target.checked)} />{' '}
            Install the plugins I assign to this site on react-wp.com automatically
          </label>
        </form>
      )}
      {message && !link.lastResult?.message && <p className={styles.ok} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}

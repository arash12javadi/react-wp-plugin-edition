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

  // The sync's one-line result is shown only when there is something to say: it did something, or it went wrong.
  // "Checked 1 key: already current" every time would be noise.
  const result = link.lastResult;
  const worthShowing = Boolean(result && (!result.ok || /installed|updated|not installed|still to install/i.test(result.message)));

  if (link.connected) {
    return (
      <section className={styles.strip} aria-labelledby="license-link-heading">
        <div className={styles.stripMain}>
          <span className={styles.dot} aria-hidden="true" />
          <div className={styles.stripText}>
            <strong id="license-link-heading">Connected to react-wp.com</strong>
            <span className={styles.sub}>{link.domain} · checked {readable(link.lastSyncAt)}</span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void run('sync', '/sync')}>
              {busy === 'sync' ? 'Checking…' : 'Sync now'}
            </button>
            <details className={styles.menu}>
              <summary className={styles.secondary}>Settings</summary>
              <div className={styles.menuBody}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={link.autoInstall}
                    disabled={Boolean(busy)}
                    onChange={(event) => void run('settings', '/settings', { autoInstall: event.target.checked })}
                  />{' '}
                  Install what I buy automatically
                </label>
                <p className={styles.hint}>New plugins are added to your site switched off; you turn them on yourself.</p>
                <button
                  type="button"
                  className={styles.link}
                  disabled={Boolean(busy)}
                  onClick={() => { if (window.confirm('Disconnect this site? It keeps the keys it already has, but stops receiving renewals.')) void run('disconnect', '/disconnect'); }}
                >
                  Disconnect this site
                </button>
              </div>
            </details>
          </div>
        </div>
        {worthShowing && result && (
          <p className={result.ok ? styles.ok : styles.error} role="status">{result.message}</p>
        )}
        {message && !worthShowing && <p className={styles.ok} role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section className={styles.strip} aria-labelledby="license-link-heading">
      <div className={styles.stripText}>
        <strong id="license-link-heading">Connect your react-wp.com account</strong>
        <span className={styles.sub}>Plugins you buy show up here and install with one click.</span>
      </div>
      <form onSubmit={connect} className={styles.connectForm}>
        {!link.secretBox && (
          <p className={styles.error} role="alert">
            This site cannot store the connection yet: set <code>RWP_SECRET_BOX_KEY</code> in its environment and restart it.
          </p>
        )}
        <div className={styles.actions}>
          <label htmlFor="license-link-code" className={styles.srOnly}>Pairing code</label>
          <input
            id="license-link-code"
            className={styles.input}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Code, like ABCDE-12345"
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
          Install what I buy automatically
        </label>
        <p className={styles.hint}>
          Find the code on <a href={PLUGIN_LICENSE_SHOP_URL} target="_blank" rel="noreferrer noopener">react-wp.com</a> under
          My licenses → Connect a site.
        </p>
      </form>
      {message && <p className={styles.ok} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}

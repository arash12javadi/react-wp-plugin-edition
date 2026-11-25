/**
 * The question asked before updates are applied, when it matters (see `usePluginUpdates().requestUpdate`):
 *
 * - **Several plugins** (Update all): the list is shown first, and the owner learns that they go out together
 *   in one deployment.
 * - **A plugin this site publishes itself** (a product under Developers): the release replaces the code in the
 *   repository. If that code has changes that were never released (a version number not raised, say), they would
 *   be lost. (A developer's own plugin, paid ones included, is delivered to their own account as readable source, never
 *   obfuscated: `packageFor` on react-wp.com.) A copy of the current code is kept in
 *   `plugin-backups/<id>/` in the same commit unless the owner unticks it, and the owner can leave their own
 *   plugins out of Update all altogether.
 */
import { useEffect, useRef, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import type { PluginUpdates } from './PluginUpdatesPanel';
import styles from './PluginUpdateDialog.module.css';

export default function PluginUpdateDialog({ updates }: { updates: PluginUpdates }) {
  const items = updates.confirming || [];
  const own = items.filter((item) => item.own);
  const others = items.filter((item) => !item.own);
  const [backupOwn, setBackupOwn] = useState(true);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const { cancelUpdate } = updates;

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelUpdate(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelUpdate]);

  if (!items.length) return null;
  const several = items.length > 1;
  const title = several ? `Update ${items.length} plugins?` : `Update ${items[0].name}?`;

  return (
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) cancelUpdate(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="plugin-update-dialog-title">
        <div className={styles.header}>
          <h3 id="plugin-update-dialog-title">{title}</h3>
          <button type="button" className={styles.close} onClick={cancelUpdate} aria-label="Close"><X size={18} aria-hidden="true" /></button>
        </div>

        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id}>
              <span className={styles.name}>{item.name}</span>
              <span className={styles.versions}>{item.installed} → {item.latest}</span>
              {item.own && <span className={styles.ownTag}>Yours</span>}
            </li>
          ))}
        </ul>

        {several && (
          <p className={styles.note}>
            They are committed to your repository together, so the site is rebuilt and deployed once. The current
            version keeps running until the new one is live.
          </p>
        )}

        {own.length > 0 && (
          <div className={styles.warning} role="note">
            <ShieldAlert size={18} aria-hidden="true" />
            <div>
              <strong>{own.length === 1 ? `You publish ${own[0].name} yourself.` : `You publish ${own.length} of these plugins yourself.`}</strong>
              <p>
                Updating replaces the code of {own.length === 1 ? 'that plugin' : 'those plugins'} in your repository with the
                released version. Changes you have not released yet would be lost. Through the react-wp.com account that
                publishes it, your own plugin arrives as your readable source, never obfuscated, paid or free.
              </p>
              <label className={styles.check}>
                <input type="checkbox" checked={backupOwn} onChange={(event) => setBackupOwn(event.target.checked)} />
                <span>Keep a copy of my current code in <code>plugin-backups/</code> (recommended)</span>
              </label>
            </div>
          </div>
        )}

        <div className={styles.actions}>
          <button
            ref={confirmRef}
            type="button"
            className={styles.primary}
            onClick={() => updates.confirmUpdate({ includeOwn: true, backupOwn })}
          >
            {several ? `Update all ${items.length}` : 'Update'}
          </button>
          {own.length > 0 && others.length > 0 && (
            <button type="button" className={styles.secondary} onClick={() => updates.confirmUpdate({ includeOwn: false, backupOwn })}>
              Update the other {others.length}, skip mine
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={cancelUpdate}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

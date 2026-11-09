import { useCallback, useEffect, useState } from 'react';
import { client } from '../../lib/db';
import { fetchProfile } from '../../lib/profiles';
import { getUserRole, isPlatformOwner, type UserRole } from '../../lib/roles';
import { fetchSchemaUpdate, runSchemaUpdateNow, type SchemaUpdateResult } from '../../lib/schemaUpdate';
import styles from './SchemaUpdateCard.module.css';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

function useOwnerRole(): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const { data } = await client.auth.getSession();
        const user = data.session?.user;
        if (!user) return;
        const profile = await fetchProfile(user.id);
        const role = profile?.role ? (profile.role as UserRole) : getUserRole(user);
        if (mounted) setOwner(Boolean(role && isPlatformOwner(role)));
      } catch {
        // Not signed in, or the profile cannot be read: the card simply stays hidden.
      }
    })();
    return () => { mounted = false; };
  }, []);
  return owner;
}

const labels: Record<string, string> = {
  ok: 'Up to date',
  pending: 'Update waiting',
  manual: 'Manual step needed',
  failed: 'Rolled back',
  needs_connection: 'Needs a connection',
};

/**
 * Dashboard → Updates → Database.
 *
 * After a release the site's own database must follow the code. The server does that by itself when it can
 * (`server/schemaMigrate.mjs`: guarded so it can never drop or overwrite data, locked, one transaction, rolled
 * back on failure). On a serverless host the start-up run may be cut short, so when this card opens and an update
 * is waiting it applies it — the same safe path as the button. Platform owner only; the routes refuse everyone else.
 */
export default function SchemaUpdateCard() {
  const owner = useOwnerRole();
  const [result, setResult] = useState<SchemaUpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (apply: boolean) => {
    setBusy(true);
    setError('');
    try {
      // Opening the card applies a waiting update (guarded and rolled back on failure, like the button); a
      // manual, failed or connection problem is only reported, never retried on its own.
      if (apply) {
        setResult(await runSchemaUpdateNow());
      } else {
        const status = await fetchSchemaUpdate();
        setResult(status.state === 'pending' && status.status === 'pending' ? await runSchemaUpdateNow() : status);
      }
    } catch (failure) {
      setError(messageOf(failure, 'The database status could not be read.'));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (owner) void run(false);
  }, [owner, run]);

  if (!owner) return null;

  return (
    <section className={styles.card} aria-label="Database updates">
      <div className={styles.head}>
        <h3>Database</h3>
        {result && <span className={`${styles.pill} ${styles[result.state] || ''}`}>{labels[result.state] || result.state}</span>}
      </div>
      {!result && !error && <p className={styles.text}>Checking the database…</p>}
      {error && <p className={styles.text} role="alert">{error}</p>}
      {result && (
        <>
          <p className={styles.text}><strong>{result.headline}.</strong> {result.detail}</p>
          {result.action && <p className={styles.action}>{result.action}</p>}
          {result.units.length > 0 && result.state !== 'ok' && (
            <ul className={styles.units}>
              {result.units.map((unit) => <li key={unit.id}>{unit.label}: {unit.status}</li>)}
            </ul>
          )}
          {result.lastAppliedAt && result.state === 'ok' && (
            <p className={styles.action}>Last database update: {new Date(result.lastAppliedAt).toLocaleString()}</p>
          )}
        </>
      )}
      <div className={styles.buttons}>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void run(true)}>
          {busy ? 'Working…' : result?.state === 'ok' ? 'Check again' : 'Update database now'}
        </button>
      </div>
    </section>
  );
}

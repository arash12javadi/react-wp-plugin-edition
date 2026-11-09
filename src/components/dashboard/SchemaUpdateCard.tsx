import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { client } from '../../lib/db';
import { fetchProfile } from '../../lib/profiles';
import { getUserRole, isPlatformOwner, type UserRole } from '../../lib/roles';
import { ensureSchemaUpdate, runSchemaUpdateNow, saveDatabaseConnection, type SchemaUpdateResult } from '../../lib/schemaUpdate';
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
  manual: 'Held back',
  failed: 'Rolled back',
  needs_connection: 'Needs a connection',
};

/**
 * Dashboard → Updates → Database.
 *
 * After a release the site's own database must follow the code. The server does that by itself
 * (`server/schemaMigrate.mjs`: guarded so it can never drop or overwrite data, locked, one transaction, rolled
 * back on failure) — at start-up, and again here when an owner opens the admin and an update is waiting
 * (`ensureSchemaUpdate`). The button is only a retry. A site with no direct database connection asks for it once
 * here, in plain words; it is stored sealed and never shown again. Platform owner only; the routes refuse everyone else.
 */
export default function SchemaUpdateCard() {
  const owner = useOwnerRole();
  const [result, setResult] = useState<SchemaUpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');

  const run = useCallback(async (retry: boolean) => {
    setBusy(true);
    setError('');
    try {
      setResult(retry ? await runSchemaUpdateNow() : await ensureSchemaUpdate());
    } catch (failure) {
      setError(messageOf(failure, 'The database status could not be read. Reload this page to try again.'));
    } finally {
      setBusy(false);
    }
  }, []);

  const saveConnection = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await saveDatabaseConnection(connection));
      setConnection('');
    } catch (failure) {
      setError(messageOf(failure, 'The connection could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

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
      {result && ['needs_connection', 'failed'].includes(result.state) && ['needs_connection', 'unreachable'].includes(result.status) ? (
        <form className={styles.action} onSubmit={(event) => void saveConnection(event)}>
          <label>
            Database connection string (Session pooler)
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={connection}
              onChange={(event) => setConnection(event.target.value)}
              placeholder="postgresql://postgres.…:[password]@…pooler.supabase.com:5432/postgres"
              style={{ display: 'block', width: '100%', marginBlock: '6px' }}
            />
          </label>
          <button type="submit" className={styles.button} disabled={busy || !connection.trim()}>Save and update the database</button>
        </form>
      ) : null}
      <div className={styles.buttons}>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void run(true)}>
          {busy ? 'Working…' : result?.state === 'ok' ? 'Check again' : 'Try again'}
        </button>
      </div>
    </section>
  );
}

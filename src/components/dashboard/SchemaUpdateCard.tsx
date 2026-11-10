import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
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
  updating: 'Updating',
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
 *
 * While another run holds the update lock the card says the database is being updated and asks again by itself
 * every few seconds, so it settles on the real answer without a click. When all is well it is one quiet line.
 */
const SETTLE_EVERY_MS = 3000;
const SETTLE_TRIES = 20;

export default function SchemaUpdateCard() {
  const owner = useOwnerRole();
  const [result, setResult] = useState<SchemaUpdateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [stalled, setStalled] = useState(false);

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

  // The first read can fail while the database is busy (it answers 5xx for a moment during an update). Ask again a
  // few times, quietly, before leaving the sentence and the button to the owner.
  const readAgain = useRef(0);
  useEffect(() => {
    if (!owner || !error || result || readAgain.current >= 3) return undefined;
    const timer = window.setTimeout(() => {
      readAgain.current += 1;
      void run(false);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [owner, error, result, run]);

  // "Being updated" is not an answer to wait for in silence: ask again (this applies what is waiting, if the other
  // run did not) until the database says something else, for about a minute, and only then hand over to the button.
  const updating = result?.retry === true;
  useEffect(() => {
    if (!owner || !updating) {
      setStalled(false);
      return undefined;
    }
    let tries = 0;
    let cancelled = false;
    const timer = window.setInterval(() => {
      tries += 1;
      void ensureSchemaUpdate().then((next) => {
        if (cancelled) return;
        setResult(next);
        if (!next.retry) window.clearInterval(timer);
      }).catch(() => undefined);
      if (tries >= SETTLE_TRIES) {
        window.clearInterval(timer);
        if (!cancelled) setStalled(true);
      }
    }, SETTLE_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [owner, updating]);

  if (!owner) return null;

  // Everything is fine: one quiet line, not a card of controls.
  if (result?.state === 'ok' && !error) {
    return (
      <section className={styles.card} aria-label="Database updates">
        <p className={styles.text}>
          <strong>Database is up to date.</strong>{' '}
          {(result.ran || []).length ? 'It was updated automatically just now.' : result.lastAppliedAt ? `Last database update: ${new Date(result.lastAppliedAt).toLocaleString()}.` : ''}{' '}
          <button type="button" className={styles.link} disabled={busy} onClick={() => void run(true)}>{busy ? 'Checking…' : 'Check again'}</button>
        </p>
      </section>
    );
  }

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
          {result.units.length > 0 && result.state !== 'ok' && result.state !== 'updating' && !result.units.some((unit) => unit.reason) && (
            <ul className={styles.units}>
              {result.units.map((unit) => <li key={unit.id}>{unit.label}: {unit.status}</li>)}
            </ul>
          )}
          {result.lastAppliedAt && result.state === 'ok' && (
            <p className={styles.action}>Last database update: {new Date(result.lastAppliedAt).toLocaleString()}</p>
          )}
        </>
      )}
      {stalled && <p className={styles.action}>This is taking longer than usual. Press &quot;Try again&quot; in a minute.</p>}
      {result && result.units.some((unit) => unit.reason) && ['failed', 'manual', 'updating'].includes(result.state) && (
        <details className={styles.tech}>
          <summary>Technical details</summary>
          <ul className={styles.units}>
            {result.units.filter((unit) => unit.reason).map((unit) => <li key={unit.id}>{unit.reason}</li>)}
          </ul>
        </details>
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
      {(!updating || stalled) && (
        <div className={styles.buttons}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => void run(true)}>
            {busy ? 'Working…' : 'Try again'}
          </button>
        </div>
      )}
    </section>
  );
}

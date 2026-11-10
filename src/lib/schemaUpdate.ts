/**
 * Dashboard → Updates → Database: the browser's half of automatic database updates.
 * The rules live in `server/schemaMigrate.mjs`; the server answers every sentence shown here
 * (`presentSchemaResult` in `server/schemaRoutes.mjs`), so the screen never invents a status.
 */
import { client } from './db';
import { sentenceForStatus } from './updateCenter';

export type SchemaUpdateState = 'ok' | 'pending' | 'updating' | 'manual' | 'failed' | 'needs_connection';

export interface SchemaUpdateUnit {
  id: string;
  label: string;
  status: 'ok' | 'pending' | 'manual' | 'failed';
  reason: string;
  at: string | null;
}

export interface SchemaUpdateResult {
  /** The server's own status word (`ok`, `pending`, `manual`, `failed`, `busy`, `needs_connection`, `unreachable`). */
  status: string;
  /** What the screen draws: one of the five states below. */
  state: SchemaUpdateState;
  headline: string;
  detail: string;
  action: string;
  /** The server will try again by itself (another run holds the lock, or the database was busy): ask again soon. */
  retry?: boolean;
  units: SchemaUpdateUnit[];
  ran?: string[];
  lastAppliedAt: string | null;
}

const call = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<SchemaUpdateResult> => {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as { result?: SchemaUpdateResult; error?: string };
  if (!response.ok || !parsed.result) throw new Error(parsed.error || sentenceForStatus(response.status));
  return parsed.result;
};

export const fetchSchemaUpdate = () => call('/api/admin/schema-update', 'GET');
let ensureInFlight: Promise<SchemaUpdateResult> | null = null;
/**
 * Applies whatever is waiting (and only that). Called when the admin opens; safe to call every time.
 *
 * The admin shell and the Updates card both ask the moment an owner opens the admin. They share one request
 * while it is running, so the site no longer races itself for the database lock; a call made after it finished
 * asks again.
 */
export const ensureSchemaUpdate = (): Promise<SchemaUpdateResult> => {
  if (!ensureInFlight) {
    ensureInFlight = call('/api/admin/schema-update/ensure', 'POST').finally(() => { ensureInFlight = null; });
  }
  return ensureInFlight;
};
let ensuredThisSession = false;
/** `ensureSchemaUpdate` once per page load, for the admin shell; a failure is left for the Updates screen to report. */
export function ensureSchemaUpdateOnce(): void {
  if (ensuredThisSession) return;
  ensuredThisSession = true;
  void ensureSchemaUpdate().catch(() => undefined);
}
/** The "Try again" button. */
export const runSchemaUpdateNow = () => call('/api/admin/schema-update/run', 'POST');
/** Saves the database connection once. The server seals it and never sends it back. */
export const saveDatabaseConnection = (connectionString: string) => call('/api/admin/schema-update/connection', 'POST', { connectionString });
export const removeDatabaseConnection = () => call('/api/admin/schema-update/connection', 'POST', { remove: true });

/**
 * Dashboard → Updates → Database: the browser's half of automatic database updates.
 * The rules live in `server/schemaMigrate.mjs`; the server answers every sentence shown here
 * (`presentSchemaResult` in `server/schemaRoutes.mjs`), so the screen never invents a status.
 */
import { client } from './db';

export type SchemaUpdateState = 'ok' | 'pending' | 'manual' | 'failed' | 'needs_connection';

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
  units: SchemaUpdateUnit[];
  ran?: string[];
  lastAppliedAt: string | null;
}

const call = async (path: string, method: 'GET' | 'POST'): Promise<SchemaUpdateResult> => {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  const response = await fetch(path, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
  const body = (await response.json().catch(() => ({}))) as { result?: SchemaUpdateResult; error?: string };
  if (!response.ok || !body.result) throw new Error(body.error || `${path} returned HTTP ${response.status}.`);
  return body.result;
};

export const fetchSchemaUpdate = () => call('/api/admin/schema-update', 'GET');
export const runSchemaUpdateNow = () => call('/api/admin/schema-update/run', 'POST');

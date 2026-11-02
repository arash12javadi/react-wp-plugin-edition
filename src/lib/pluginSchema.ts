/**
 * Browser half of per-plugin database provisioning and the site reset.
 *
 * Schema status, install-schema and uninstall are served by the universal API on every host that runs
 * it — `npm start`, `npm run start:hono` and a Vercel deployment alike, through
 * `src/server/routes/pluginSchema.ts` — so the first three work wherever the site is deployed.
 * `resetSite` is the one call that still needs the Node server (`npm start`), because a serverless
 * function cannot drop the schema it is running on.
 *
 * A host without the endpoint — the static SPA with no functions, or a fetch that never reached a
 * server — answers 404 with no body at all. That is reported as "this host cannot do it" rather than
 * as a database failure, because the two send you to completely different places to look; a 404 *with*
 * an `error` is a real answer from the universal API (an unknown plugin id, say) and is shown as one.
 */
import { client } from './db';

export interface PluginSchemaStatus {
  plugin: string;
  name: string;
  /** The plugin ships a schema.sql and declares it in manifest.json. */
  hasSchema: boolean;
  /** It also ships an uninstall.sql, so "wipe data" can be offered. */
  canDrop: boolean;
  tables: string[];
  /**
   * The RPCs the plugin's screens call, as its manifest declares them. A database can hold every table
   * and none of the functions — an older copy of schema.sql, or a run that stopped half way — and that
   * reads on screen as "no data" rather than as "the migration never ran here".
   */
  functions: string[];
  /** Things the plugin's uninstall.sql deliberately leaves alone, shown in the dialog. */
  retains: string[];
  /** Provider folders the plugin owns, e.g. ["plugins/rwp-shop"]. Wiped only on a wipe. */
  mediaPrefixes: string[];
  /** The server has Cloudinary API credentials, so files can actually be deleted. */
  cloudinaryConfigured: boolean;
  /** The server holds a database URL (SUPABASE_DB_URL or DATABASE_URL), so no password prompt is needed. */
  storedCredentials: boolean;
  /** False when the table state could not be read; `reason` says why. */
  checked: boolean;
  reason?: string;
  present?: string[];
  missing?: string[];
  rowCounts?: Record<string, number>;
  /** Which of the declared functions exist. Flat, so they do not collide with the `functions` above. */
  functionsPresent?: string[];
  functionsMissing?: string[];
}

export interface PluginBackup {
  format: 'react-wp-plugin-backup';
  version: number;
  plugin: { id: string; name: string; version: string };
  created_at: string;
  missing_tables: string[];
  tables: Record<string, unknown[]>;
  options: Array<{ option_name: string; option_value: string }>;
}

/** What happened at Cloudinary. `attempted: false` means no credentials, not "nothing to do". */
export interface MediaWipeSummary {
  attempted: boolean;
  deleted: number;
  notFound: number;
  warnings: string[];
  /** Plugin uninstall only: the provider prefixes that were cleared. */
  prefixes?: string[];
  /** Plugin uninstall only: media library rows removed alongside the files. */
  rowsRemoved?: number;
  /** Site reset only: how many Cloudinary files the media table knew about. */
  recorded?: number;
}

export interface UninstallResult {
  plugin: string;
  mode: 'keep' | 'wipe';
  backup: PluginBackup | null;
  media: MediaWipeSummary | null;
  dropped: { dropped: string[]; plugin: string } | null;
  folderDeleted: boolean;
  serverImportRemoved?: boolean;
  warnings: string[];
}

/** Credentials the server may still need, when it holds no database URL of its own. */
export interface DbCredentials {
  dbPassword?: string;
  connectionString?: string;
}

const accessToken = async (): Promise<string> => {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  return token;
};

/**
 * "This host cannot do it" is a different problem from "the database refused it", and the two
 * send you to completely different places. Tagged rather than string-matched so callers can
 * decide: activating a plugin on a static host should warn and carry on, but a real SQL failure
 * must stop the activation.
 */
export class EndpointUnavailableError extends Error {}

export const isEndpointUnavailable = (error: unknown): error is EndpointUnavailableError =>
  error instanceof EndpointUnavailableError;

const request = async <T>(path: string, init: RequestInit): Promise<T> => {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new EndpointUnavailableError(
      `The server could not be reached for ${path}. In development, is server.mjs running on :3000?`);
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 404 && !body.error) {
      // Plugin schema status, install and uninstall are answered by the universal API on every host, so
      // a bodyless 404 here is the site reset — the one call in this file that still needs `npm start`.
      throw new EndpointUnavailableError(
        `This host has no ${path} endpoint. Resetting the site needs the Node server (npm start); a serverless deployment cannot drop the schema it is running on.`);
    }
    throw new Error(body.error || `${path} returned HTTP ${response.status}.`);
  }
  return body;
};

export const fetchPluginSchemaStatus = (id: string) =>
  request<PluginSchemaStatus>(`/api/admin/plugins/schema-status?id=${encodeURIComponent(id)}`, { method: 'GET' });

/**
 * Runs the plugin's schema.sql. Idempotent, so this is safe to call on every activation rather
 * than tracking installed-ness in a column that can drift from the actual database. The answer is
 * read back from the database, so `stillMissing` and `missingFunctions` are what is actually there
 * afterwards — a schema.sql that creates the tables but not an RPC reports both.
 */
export const installPluginSchema = (id: string, credentials: DbCredentials = {}) =>
  request<{
    installed: boolean; reason?: string; plugin: string; tables: string[]; functions?: string[];
    created?: string[]; stillMissing?: string[]; missingFunctions?: string[];
  }>(
    '/api/admin/plugins/install-schema',
    { method: 'POST', body: JSON.stringify({ id, ...credentials }) },
  );

export const uninstallPlugin = (
  id: string,
  options: { mode: 'keep' | 'wipe'; backup: boolean; confirm?: string; deleteFolder?: boolean } & DbCredentials,
) => request<UninstallResult>('/api/admin/plugins/uninstall', { method: 'POST', body: JSON.stringify({ id, ...options }) });

export const resetSite = (options: { password: string; confirm: string; wipeMedia?: boolean } & DbCredentials) =>
  request<{ success: true; usersDeleted: number; remoteFiles: number; media: MediaWipeSummary; next: string }>(
    '/api/admin/reset-site',
    { method: 'POST', body: JSON.stringify(options) },
  );

/** Hands the browser a .json file. Used for the pre-wipe backup, which exists only in that response. */
export const downloadJson = (filename: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: Safari cancels the download if the object URL goes away immediately.
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
};

export const backupFilename = (pluginId: string) =>
  `${pluginId}-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;

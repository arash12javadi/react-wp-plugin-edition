import { client } from './db';

/** What `GET /api/admin/license-link` says: presence, dates and versions, never a token or a key. */
export interface LinkState {
  connected: boolean;
  domain: string;
  connectedAt: string;
  lastSyncAt: string;
  lastResult: { ok: boolean; message: string; at: string } | null;
  nextSyncAt: string;
  secretBox: boolean;
  autoInstall: boolean;
  /** The newest version of each sold plugin this site is licensed for, as react-wp.com last said. */
  latestVersions: Record<string, string>;
}

export interface LinkAnswer {
  ok?: boolean;
  error?: string;
  message?: string;
  link?: LinkState;
  sync?: { changed: boolean; updated: string[]; message: string };
  /** `POST /update`: what the installer answered, with `update: { id, from, to }`. */
  result?: {
    plugin: { name: string };
    commit: { sha: string };
    warnings: string[];
    sql: string[];
    update: { id: string; from: string; to: string };
    install?: { id: string; version: string };
  };
  deployment?: { sha: string } | null;
}

/** One call to this site's own account-link routes, with the administrator's session. */
export const callLink = async (path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<{ status: number; answer: LinkAnswer }> => {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { status: 401, answer: { error: 'Your session has expired. Sign in again.' } };
  let response: Response;
  try {
    response = await fetch(`/api/admin/license-link${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    return { status: 0, answer: { error: 'The site server could not be reached.' } };
  }
  return { status: response.status, answer: await response.json().catch(() => ({})) as LinkAnswer };
};

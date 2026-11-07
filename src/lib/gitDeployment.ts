/**
 * The browser half of Settings → Integrations → GitHub & Vercel (`server/deploymentRoutes.mjs`).
 *
 * The Vercel token is sent twice at most — once to check it, once to connect — and only to this site's own
 * server, which seals it. It is held in component state while the form is open, never in localStorage, and
 * no answer ever carries it back. Nothing here talks to react-wp.com, GitHub or Vercel directly.
 */
import { client } from './db';

export interface DeploymentConnectionView {
  connected: boolean;
  repository: string;
  branch: string;
  project: { id: string; name: string; team: string } | null;
  vercelUser: string;
  tokenStored: boolean;
  tokenFingerprint: string;
  connectedAt: string;
  verifiedAt: string;
  /** Whether RWP_SECRET_BOX_KEY is set on this server, i.e. whether a token can be stored at all. */
  secretBox: boolean;
}

export interface DeploymentOverview {
  connection: DeploymentConnectionView;
  github: { tokenStored: boolean; username: string; repository: string };
  installedVersion: string;
}

export interface RepositoryChoice { fullName: string; private: boolean; defaultBranch: string; pushedAt: string }
export interface RepositoryInspection { kind: 'empty' | 'react-wp' | 'other'; hasCommits: boolean; defaultBranch: string; private: boolean; head: string; plugins?: string[] }
export interface VercelProjectView { id: string; name: string; framework: string; repository: string; productionBranch: string }

export interface DeploymentState {
  sha: string;
  source: 'vercel' | 'github-status' | 'none';
  state: 'queued' | 'building' | 'ready' | 'error' | 'canceled' | 'not_started' | 'unknown' | 'pending';
  production?: boolean | null;
  serving?: boolean | null;
  url?: string;
  inspectorUrl?: string;
  error?: string;
  reason?: string;
}

export interface CoreUpdatePlanView {
  fingerprint: string;
  head: string;
  repository: string;
  branch: string;
  fromVersion: string;
  toVersion: string;
  releaseTag: string;
  releaseRepository: string;
  added: string[];
  updated: string[];
  merged: Array<{ path: string; carried: string[]; dropped: string[] }>;
  deleted: string[];
  kept: Array<{ path: string; reason: string }>;
  unchanged: number;
  conflicts: Array<{ path: string; reason: string; resolution: 'release' | 'keep' | null }>;
  unresolved: string[];
  warnings: string[];
  upToDate: boolean;
}

/** A finished deployment state: polling stops here. */
export const isTerminalDeploymentState = (state: DeploymentState['state']): boolean =>
  state === 'ready' || state === 'error' || state === 'canceled';

const accessToken = async (): Promise<string> => {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  return token;
};

export class DeploymentRequestError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method || 'GET',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new Error(`This site's server could not be reached for ${path}. In development, is the API server running?`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 404 && !body.error) {
      throw new DeploymentRequestError(`This host has no ${path} endpoint. It needs the API server that answers /api (npm start, npm run start:hono, or the deployed functions).`, 404, body);
    }
    throw new DeploymentRequestError(String(body.error || `The request failed (HTTP ${response.status}).`), response.status, body);
  }
  return body as T;
}

const BASE = '/api/admin/deployment';

export const fetchDeploymentOverview = () => call<DeploymentOverview>(BASE);

export const inspectGithubAccount = (repository = '', branch = '') =>
  call<{ github: { login: string; repositories: RepositoryChoice[] }; repository: RepositoryInspection | null }>(`${BASE}/github/inspect`, {
    method: 'POST',
    body: repository ? { repository, branch } : {},
  });

export const inspectVercelAccount = (input: { token: string; teamId: string; repository: string }) =>
  call<{ vercel: { user: string; projects: VercelProjectView[] } }>(`${BASE}/vercel/inspect`, { method: 'POST', body: input });

export interface ConnectInput {
  repository: string;
  branch: string;
  createRepository: { name: string; private: boolean; org?: string } | null;
  vercelToken: string;
  teamId: string;
  project: { mode: 'existing'; id: string } | { mode: 'create'; name: string };
  confirm: { createRepository?: boolean; seed?: boolean; useProject?: boolean; createProject?: boolean; environment?: boolean };
}

export const connectDeployment = (input: ConnectInput) =>
  call<{ connection: DeploymentConnectionView; head: string; deployment: { id: string; url: string; state: string } | null; steps: string[] }>(`${BASE}/connect`, { method: 'POST', body: input });

export const disconnectDeployment = () => call<{ connection: DeploymentConnectionView; message: string }>(`${BASE}/disconnect`, { method: 'POST', body: {} });

export const fetchDeploymentState = (sha: string, since = '') =>
  call<{ deployment: DeploymentState }>(`${BASE}/status?sha=${encodeURIComponent(sha)}${since ? `&since=${encodeURIComponent(since)}` : ''}`);

export const planCoreUpdate = (version = '') =>
  call<{ plan: CoreUpdatePlanView }>(`${BASE}/core-update/plan`, { method: 'POST', body: version ? { version } : {} });

export const applyCoreUpdate = (input: { version: string; fingerprint: string; resolutions: Record<string, 'release' | 'keep'>; mode: 'direct' | 'pull_request' }) =>
  call<{
    result: { applied: boolean; merged: boolean; upToDate?: boolean; commit: { sha: string; url: string; branch: string } | null; pullRequest: { number: number; url: string } | null };
    deployment: { sha: string; state: 'pending' } | null;
  }>(`${BASE}/core-update/apply`, { method: 'POST', body: input });

export interface PluginUpdateRow {
  id: string;
  name: string;
  installed: string;
  latest: string;
  state: 'up-to-date' | 'available' | 'unavailable' | 'no-release';
  reason: string;
  release: { tag: string; title: string; released: string; notes: string[]; url: string; prerelease: boolean } | null;
}

/** Plugins are released on their own tags, apart from core: see `server/pluginUpdates.mjs`. */
export const checkPluginUpdates = () =>
  call<{ repository: string; releaseRepository: string; plugins: PluginUpdateRow[] }>(`${BASE}/plugin-updates/check`, { method: 'POST', body: {} });

export const applyPluginUpdate = (input: { id: string; version: string }) =>
  call<{
    result: { update: { id: string; from: string; to: string; tag: string }; commit: { sha: string; url: string; unchanged: boolean }; warnings: string[]; sql: Array<{ path: string }> };
    deployment: { sha: string; state: 'pending' } | null;
  }>(`${BASE}/plugin-updates/apply`, { method: 'POST', body: input });

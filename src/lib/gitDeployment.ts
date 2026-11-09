/**
 * The browser half of Settings → Integrations → GitHub & Vercel (`server/deploymentRoutes.mjs`).
 *
 * The Vercel token is sent twice at most — once to check it, once to connect — and only to this site's own
 * server, which seals it. It is held in component state while the form is open, never in localStorage, and
 * no answer ever carries it back. Nothing here talks to react-wp.com, GitHub or Vercel directly.
 */
import { client } from './db';
import { sentenceForStatus } from './updateCenter';

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
  /** Vercel built the commit only as a Preview: it never changed the live site. */
  previewOnly?: boolean;
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
    throw new Error('This site’s server could not be reached, so nothing was changed. Check your internet connection and try again.');
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 404 && !body.error) {
      throw new DeploymentRequestError(sentenceForStatus(404), 404, body);
    }
    throw new DeploymentRequestError(String(body.error || sentenceForStatus(response.status)), response.status, body);
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

/**
 * Plans a core update to `tag` — one of the five most recent stable releases (empty = the latest). The server
 * re-reads that list and refuses any other text. `downgrade` is true when `tag` is older than what the
 * repository runs; `warning` then says what that risks.
 */
export const planCoreUpdate = (tag = '') =>
  call<{ plan: CoreUpdatePlanView; downgrade: boolean; warning?: string }>(`${BASE}/core-update/plan`, { method: 'POST', body: tag ? { tag } : {} });

/**
 * Applies the reviewed plan: the commit lands on the branch Vercel deploys to PRODUCTION, resolved by the server
 * (never a pull request left for a person). An older `tag` than the repository runs needs `confirmDowngrade: true`
 * (the server answers 428 without it).
 */
export const applyCoreUpdate = (input: { tag: string; fingerprint: string; resolutions: Record<string, 'release' | 'keep'>; confirmDowngrade?: boolean }) =>
  call<{
    result: { applied: boolean; merged: boolean; upToDate?: boolean; landedBy?: string; productionBranch?: string; commit: { sha: string; url: string; branch: string } | null };
    deployment: { sha: string; state: 'pending' } | null;
  }>(`${BASE}/core-update/apply`, { method: 'POST', body: input });

/** Retry after a failed build: asks Vercel to build the production branch's newest commit again. */
export const redeployCoreUpdate = (sha: string) =>
  call<{ deployment: { sha: string; state: 'pending'; id: string } }>(`${BASE}/core-update/redeploy`, { method: 'POST', body: { sha } });

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

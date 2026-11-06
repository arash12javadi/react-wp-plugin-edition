/**
 * The client installation's record of where it deploys from: one `system_settings` row,
 * `vercel_deploy_config`, beside the existing `github_config` row the GitHub card writes.
 *
 * What the row holds
 * ------------------
 *   repository, branch            the GitHub repository and production branch Vercel builds
 *   project_id, project_name      the Vercel project connected to that repository
 *   team_id                       the Vercel team, or '' for a personal account
 *   token_sealed                  the Vercel token, sealed with RWP_SECRET_BOX_KEY (AES-256-GCM,
 *                                 `server/deploy/secretBox.mjs`) — never stored readable
 *   token_fingerprint             `sha256:<12 hex>`, so a screen can say *which* token without holding it
 *   vercel_user                   the account name Vercel reported for the token
 *   connected_at, verified_at     ISO dates
 *
 * Why it is safe where it is
 * --------------------------
 * The row lives in the client's own database, on the client's own Supabase project. It is one of the
 * platform-owner rows (`rwp_platform_setting()` in `supabase/schema.sql`, `PLATFORM_SETTING_KEYS` in
 * `server/integrationConfig.mjs`), so a role that was merely granted `manage_options` cannot read or write
 * it, and even the owner's browser only ever sees ciphertext: the key that opens it exists in this
 * installation's server environment and nowhere else (no `VITE_` prefix, so Vite cannot inline it).
 * Nothing here is ever sent to react-wp.com.
 *
 * A missing RWP_SECRET_BOX_KEY is a refusal (`secret_box_unconfigured`, 503), never a plaintext fallback.
 *
 * Reads and writes go through the caller's own Supabase session (PostgREST with their access token), so
 * the database's own policies decide — the server holds no broader credential for this. Where the engine
 * has a database adapter instead (a non-Supabase backend), `readSetting`/`writeSetting` are used.
 */
import { DeployError } from '../deploy/errors.mjs';
import { SECRET_BOX_KEY_ENV, openSecret, sealSecret, secretBoxEnabled, secretFingerprint } from '../deploy/secretBox.mjs';
import { parseSettingValue } from '../integrationSettings.mjs';

export const VERCEL_DEPLOY_CONFIG_KEY = 'vercel_deploy_config';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The row, normalised: every field present, nothing that is not a string where a string is expected. */
export function deploymentConnectionFrom(value) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    repository: str(row.repository),
    branch: str(row.branch) || 'main',
    project_id: str(row.project_id),
    project_name: str(row.project_name),
    team_id: str(row.team_id),
    token_sealed: str(row.token_sealed),
    token_fingerprint: str(row.token_fingerprint),
    vercel_user: str(row.vercel_user),
    connected_at: str(row.connected_at),
    verified_at: str(row.verified_at),
  };
}

/** Whether this installation deploys from GitHub through a connected Vercel project. */
export const isGitDeployConnected = (connection) => Boolean(
  connection?.repository && connection?.project_id && connection?.token_sealed,
);

/** What a browser may be told: presence and names, never the token or its envelope. */
export function publicConnection(connection, env = globalThis.process?.env || {}) {
  const row = deploymentConnectionFrom(connection);
  return {
    connected: isGitDeployConnected(row),
    repository: row.repository,
    branch: row.branch,
    project: row.project_id ? { id: row.project_id, name: row.project_name, team: row.team_id } : null,
    vercelUser: row.vercel_user,
    tokenStored: Boolean(row.token_sealed),
    tokenFingerprint: row.token_fingerprint,
    connectedAt: row.connected_at,
    verifiedAt: row.verified_at,
    secretBox: safeSecretBoxEnabled(env),
  };
}

/** `secretBoxEnabled` throws on a malformed key; a status read reports that as "not usable" instead. */
export function safeSecretBoxEnabled(env) {
  try {
    return secretBoxEnabled(env);
  } catch {
    return false;
  }
}

/** Refuses, with the variable to set, when this installation cannot seal or open a credential. */
export function requireSecretBox(env = globalThis.process?.env || {}) {
  let enabled = false;
  try {
    enabled = secretBoxEnabled(env);
  } catch (error) {
    throw new DeployError(503, error instanceof Error ? error.message : `${SECRET_BOX_KEY_ENV} is not a valid key.`, { code: 'secret_box_invalid' });
  }
  if (!enabled) {
    throw new DeployError(503, `This installation cannot store the Vercel token yet: set ${SECRET_BOX_KEY_ENV} to 32 random bytes (base64 or hex) in this server's environment, restart it, and try again. Nothing was stored. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`, { code: 'secret_box_unconfigured' });
  }
}

/** Seals the token and builds the row. The plaintext token is not part of what this returns. */
export function sealedConnection({ token, repository, branch, projectId, projectName, teamId = '', vercelUser = '', now = new Date() }, env = globalThis.process?.env || {}) {
  requireSecretBox(env);
  const sealed = sealSecret(String(token || ''), { env });
  const at = now.toISOString();
  return {
    repository: str(repository),
    branch: str(branch) || 'main',
    project_id: str(projectId),
    project_name: str(projectName),
    team_id: str(teamId),
    token_sealed: sealed,
    token_fingerprint: secretFingerprint(String(token || '')),
    vercel_user: str(vercelUser),
    connected_at: at,
    verified_at: at,
  };
}

/** Opens the stored token, or refuses with a sentence that names the variable — never the token. */
export function openVercelToken(connection, env = globalThis.process?.env || {}) {
  const row = deploymentConnectionFrom(connection);
  if (!row.token_sealed) {
    throw new DeployError(409, 'No Vercel token is stored for this site. Connect it on Settings → Integrations → GitHub & Vercel.', { code: 'credential_missing' });
  }
  try {
    return openSecret(row.token_sealed, { env });
  } catch (error) {
    throw new DeployError(503, error instanceof Error ? error.message : 'The stored Vercel token could not be opened.', { code: 'token_unreadable' });
  }
}

// ---------------------------------------------------------------------------------------------------
// Reading and writing the rows with the caller's own session

const restBase = (supabaseUrl) => String(supabaseUrl || '').replace(/\/+$/, '');

/**
 * The settings I/O for one request. `readSetting`/`writeSetting` (an engine's adapter) win when given;
 * otherwise PostgREST is called with the caller's own access token and the publishable key.
 */
export function settingsIo({ supabaseUrl, supabaseKey, accessToken, readSetting, writeSetting, fetchImpl = fetch }) {
  const base = restBase(supabaseUrl);
  const headers = () => ({
    apikey: supabaseKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  });
  const usable = Boolean(base && supabaseKey && accessToken);

  return {
    async read(key) {
      if (typeof readSetting === 'function') return parseSettingValue(await readSetting(key));
      if (!usable) throw new DeployError(501, 'This host cannot read its deployment settings: it is not connected to Supabase.');
      const response = await fetchImpl(`${base}/rest/v1/system_settings?setting_key=eq.${encodeURIComponent(key)}&select=setting_value`, {
        headers: headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new DeployError(502, `The deployment settings could not be read (HTTP ${response.status}).`);
      const rows = await response.json().catch(() => []);
      return Array.isArray(rows) && rows.length ? parseSettingValue(rows[0]?.setting_value) : null;
    },
    async write(key, value) {
      if (typeof writeSetting === 'function') {
        const ok = await writeSetting(key, value);
        if (ok === false) throw new DeployError(502, `The ${key} setting could not be saved.`);
        return;
      }
      if (!usable) throw new DeployError(501, 'This host cannot save its deployment settings: it is not connected to Supabase.');
      const response = await fetchImpl(`${base}/rest/v1/system_settings?on_conflict=setting_key`, {
        method: 'POST',
        headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ setting_key: key, setting_value: JSON.stringify(value) }),
        signal: AbortSignal.timeout(15_000),
      });
      // An RLS refusal of an upsert can answer 2xx with no rows: only the returned row proves it landed.
      const rows = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(rows) || rows.length !== 1) {
        throw new DeployError(response.status === 401 || response.status === 403 ? 403 : 502,
          `The ${key} setting was not saved (HTTP ${response.status}). Only the platform owner (administrator or super_admin) can save it; sign in as that account and try again.`);
      }
    },
    async remove(key) {
      if (typeof writeSetting === 'function') {
        await writeSetting(key, null);
        return;
      }
      if (!usable) throw new DeployError(501, 'This host cannot change its deployment settings: it is not connected to Supabase.');
      const response = await fetchImpl(`${base}/rest/v1/system_settings?setting_key=eq.${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { ...headers(), Prefer: 'return=representation' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new DeployError(502, `The ${key} setting could not be removed (HTTP ${response.status}).`);
    },
  };
}

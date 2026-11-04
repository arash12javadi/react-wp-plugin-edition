/**
 * The customer's Vercel token, kept the way `secretBox.mjs` says it must be kept: sealed, never logged,
 * never returned to a browser.
 *
 * This module is the *lifecycle* of that credential, not its cryptography. Everything that decides what a
 * sealed envelope looks like lives in `./secretBox.mjs`; everything that decides whether a token still works
 * lives in `./vercelApi.mjs` (`validateVercelToken`). What is left — and what this file owns — is the three
 * answers a screen needs and no more:
 *
 *   - **Save.** Verify the token against Vercel first, then seal it. A token that cannot deploy is worse than
 *     no token: the customer would save it, see a green card, and discover the problem days later at the
 *     first build.
 *   - **Read.** Server-side only, and only through `loadCredential()`, which returns the plaintext token to
 *     the *deployment engine* and to nothing else. `publicCredential()` is the shape any route, log line or
 *     error may hold: a fingerprint (`sha256:…`), the project it belongs to, and when it was last written.
 *   - **Revoke.** A row with `revoked_at` set is not deleted, because "this installation used to deploy to
 *     project X and stopped on date Y" is the fact an operator needs after an incident. `loadCredential()`
 *     refuses a revoked row, so revocation takes effect on the very next job.
 *
 * The storage port
 * ----------------
 * `credentials.mjs` knows nothing about tables. PostgREST (the installer plugin's job store) and a test's
 * `Map` implement the same methods, and the module is a pure function of the port:
 *
 *   `findCredential(projectName)`       → row or null, including revoked rows
 *   `listCredentials()`                 → every row, newest first (for the public status list)
 *   `upsertCredential(row)`             → write by `project_name`, returning the stored row
 *   `revokeCredential(projectName, at)` → set `revoked_at`, return the row or null
 *   `deleteCredential(projectName)`     → remove the row, and the sealed token with it
 *
 * A row is `{ project_name, project_id, team_id, sealed, fingerprint, created_by, created_at, updated_at,
 * revoked_at }` — the snake_case column names, because the PostgREST store passes rows straight through and
 * a translation layer here would be one more place for the token to be copied.
 */
import { DeployError } from './errors.mjs';
import { SECRET_BOX_KEY_ENV, openSecret, sealSecret, secretBoxEnabled, secretFingerprint } from './secretBox.mjs';
import { validateVercelToken } from './vercelApi.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** Vercel project names: lowercase, digits, `.`, `_` and `-`. Checked before anything is written. */
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * Refuses a request that cannot produce a usable credential, before Vercel is called.
 *
 * A project name is the key of the whole feature — a job deploys *to a project* — so a typo here is a
 * deployment onto somebody else's site. It is validated rather than trusted for the same reason
 * `teamQuery()` validates a team id.
 */
function assertProjectName(projectName) {
  const name = str(projectName);
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new DeployError(
      400,
      'The Vercel project name is required, and must be the project\'s own name (lowercase letters, digits, dots, hyphens and underscores), for example "my-site".',
      { code: 'project_name_invalid' },
    );
  }
  return name;
}

/** The sentence a site without a secret-box key gets. Actionable, and names the variable exactly. */
const noKeyMessage = () =>
  `This site cannot store a Vercel token yet: set ${SECRET_BOX_KEY_ENV} to 32 random bytes (base64 or hex) `
  + 'in the deployment\'s environment and redeploy. The key is what keeps the token encrypted in the database.';


/**
 * Saves (or replaces) the credential for one project.
 *
 * `validate` is injected so the tests never reach Vercel, and defaults to the real `validateVercelToken`. It
 * returns Vercel's user object, which is *not* stored: the scope of a token (`user.id`, teams) is Vercel's
 * business, and a copy here would go stale the moment the token is re-scoped.
 */
export async function saveCredential({
  store,
  token,
  projectName,
  projectId = '',
  teamId = '',
  userId = null,
  validate = validateVercelToken,
  env = globalThis.process?.env || {},
  now = () => new Date(),
}) {
  const name = assertProjectName(projectName);
  const value = str(token);
  if (!value) {
    throw new DeployError(400, 'Paste the Vercel access token to save it.', { code: 'token_missing' });
  }
  if (!secretBoxEnabled(env)) throw new DeployError(503, noKeyMessage(), { code: 'secret_box_unconfigured' });

  // `validateVercelToken` already answers 401 with a sentence; anything else is passed through so a 502
  // stays a 502 instead of becoming "your token is wrong".
  const owner = await validate(value);

  const at = now().toISOString();
  const existing = await store.findCredential(name);
  const row = {
    project_name: name,
    project_id: str(projectId),
    team_id: str(teamId),
    sealed: sealSecret(value, { env }),
    fingerprint: secretFingerprint(value),
    created_by: existing?.created_by || userId,
    created_at: existing?.created_at || at,
    updated_at: at,
    // A saved credential is live again: re-saving a revoked token is how an operator recovers from a
    // rotation that went wrong, and leaving `revoked_at` set would make the save look like it failed.
    revoked_at: null,
  };
  const stored = await store.upsertCredential(row);
  return publicCredential(stored || row, { owner });
}


/**
 * The plaintext token, for the deployment engine only.
 *
 * Every failure here is a refusal with its own `code`, because the three causes need three different
 * sentences in front of a customer: no row (save one), a revoked row (re-save it), an envelope this
 * installation cannot open (the secret-box key changed).
 */
export async function loadCredential({ store, projectName, env = globalThis.process?.env || {} }) {
  const name = assertProjectName(projectName);
  const row = await store.findCredential(name);
  if (!row) {
    throw new DeployError(
      409,
      `No Vercel token is stored for the project "${name}" yet, so nothing can be deployed to it. Save one under Settings → Integrations → Plugin installs.`,
      { code: 'credential_missing' },
    );
  }
  if (row.revoked_at) {
    throw new DeployError(
      409,
      `The Vercel token stored for "${name}" was revoked on ${String(row.revoked_at).slice(0, 10)}, so deployments are stopped. Save a new token to resume.`,
      { code: 'credential_revoked' },
    );
  }
  let token;
  try {
    token = openSecret(row.sealed, { env });
  } catch (error) {
    throw new DeployError(503, error instanceof Error ? error.message : 'The stored Vercel token cannot be opened.', {
      code: 'token_unreadable',
      cause: error,
    });
  }
  return {
    token,
    projectName: name,
    projectId: str(row.project_id),
    teamId: str(row.team_id),
    fingerprint: str(row.fingerprint),
    updatedAt: str(row.updated_at),
  };
}

/** Revocation: the row stays (as history), the token stops working on the next job. */
export async function revokeCredential({ store, projectName, now = () => new Date() }) {
  const name = assertProjectName(projectName);
  const row = await store.revokeCredential(name, now().toISOString());
  if (!row) throw new DeployError(404, `There is no stored Vercel token for "${name}".`, { code: 'credential_missing' });
  return publicCredential(row);
}

/** Deletion: the sealed token leaves the database, and with it any way to undo the deletion. */
export async function deleteCredential({ store, projectName }) {
  const name = assertProjectName(projectName);
  const removed = await store.deleteCredential(name);
  if (!removed) throw new DeployError(404, `There is no stored Vercel token for "${name}".`, { code: 'credential_missing' });
  return { projectName: name, deleted: true };
}

/** The status list: every project this installation can deploy to, and whether it still can. */
export async function credentialStatus({ store, env = globalThis.process?.env || {} }) {
  const rows = await store.listCredentials();
  return {
    secretBox: secretBoxEnabled(env),
    credentials: rows.map((row) => publicCredential(row)),
  };
}

/**
 * What a route, a log line or an error may carry. Deliberately an allowlist, not `{...row, sealed: '***'}`:
 * a column added later cannot leak through a feed that never names it.
 */
export function publicCredential(row, { owner = null } = {}) {
  return {
    projectName: str(row?.project_name),
    projectId: str(row?.project_id),
    teamId: str(row?.team_id),
    fingerprint: str(row?.fingerprint),
    createdAt: str(row?.created_at),
    updatedAt: str(row?.updated_at),
    revokedAt: str(row?.revoked_at),
    active: Boolean(row?.sealed) && !row?.revoked_at,
    owner: owner ? { id: str(owner.id), username: str(owner.username) || str(owner.email) } : null,
  };
}

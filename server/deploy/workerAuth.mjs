/**
 * The credential a *build environment* holds, and the one-time code that gives it out.
 *
 * Why this exists
 * ---------------
 * The build has to run somewhere with a checkout and a Node toolchain — a workstation, or the customer's own
 * CI. That machine is not signed in to the site: it has no browser session, no Supabase JWT, and no business
 * holding either. What it needs is permission to do two things for a bounded time: take a queued install job,
 * and hand back the payload it built. That is what a worker token is, and the pairing code is how a human on
 * the dashboard hands it over without ever typing a long-lived secret.
 *
 * The properties, in the order they matter
 * ----------------------------------------
 *   1. **The code is short-lived and single use.** It is shown once, on screen, and it expires in fifteen
 *      minutes. It is stored hashed (`sha256`), so a database dump cannot be replayed as a pairing.
 *   2. **The token is stored hashed, and shown once.** `redeemPairing()` is the only function that ever
 *      returns the plaintext, to the request that redeemed it. Losing it means pairing again, which is one
 *      click — not a rotation procedure.
 *   3. **Revocation is a column.** A worker that is decommissioned or whose machine was lost stops claiming
 *      jobs on its next request, without touching the jobs it already finished.
 *   4. **A worker cannot deploy.** It builds and uploads a payload; the deployment is made by the site's own
 *      server with the sealed Vercel token (`pipeline.mjs`). So the blast radius of a leaked worker token is
 *      "can hand in a build for a queued job", not "can deploy to the customer's account".
 *
 * The storage port (implemented by `plugins/rwp-saas-installer/jobStore.mjs`):
 *
 *   `insertPairing({ hash, name, created_by, expires_at })` -> row
 *   `consumePairing(hash, atIso)` -> row | null     atomic: deletes where hash = ? and expires_at > ?
 *   `insertWorker(row)` -> row
 *   `findWorkerByHash(hash)` -> row | null          includes revoked rows, so a revoked token gets a sentence
 *   `touchWorker(id, atIso)` -> void                best effort
 *   `listWorkers()` -> rows, newest first
 *   `revokeWorker(id, atIso)` -> row | null
 */
import { createHash, randomBytes } from 'node:crypto';
import { DeployError } from './errors.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** Every worker token starts with this, so a leaked string is recognisable in a log or a scan. */
export const WORKER_TOKEN_PREFIX = 'rwpw_';

/** How long a pairing code is good for. Long enough to walk to the terminal, short enough to be useless later. */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

/** The alphabet pairings are written in: no `0`/`O`, no `1`/`I`/`L`, so nothing has to be read aloud twice. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const toIso = (now) => (typeof now === 'function' ? now() : new Date(now)).toISOString();

/** `sha256:<hex>` with the prefix, so a column cannot be mistaken for a plaintext token by a reader. */
export const hashWorkerSecret = (value) => `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;

/** A fresh worker token, its stored hash, and the prefix a screen may show. */
export function newWorkerToken() {
  const token = `${WORKER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashWorkerSecret(token), prefix: token.slice(0, 14) };
}

/**
 * A pairing code, and the hash of what the worker will send back.
 *
 * Ten characters out of a 31-letter alphabet is a shade over 49 bits: an online guesser gets one attempt per
 * request against a code that lives fifteen minutes, and the code is deleted the moment it is used.
 */
export function newPairingCode({ now = () => new Date(), ttlMs = PAIRING_TTL_MS } = {}) {
  const bytes = randomBytes(10);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return {
    code: `${code.slice(0, 5)}-${code.slice(5)}`,
    hash: hashWorkerSecret(normalisePairingCode(code)),
    expiresAt: new Date(new Date(toIso(now)).getTime() + ttlMs).toISOString(),
  };
}

/**
 * What a person typing the code produces, in the one form both halves agree on: upper case, no separators.
 * A dash, a space, or lower case pasted from a terminal all work; anything that is not ten characters of the
 * alphabet is refused before it reaches the database.
 */
export function normalisePairingCode(input) {
  const compact = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!compact) return '';
  return compact;
}

/** True when the shape is plausible — used to answer 400 rather than 401 for a typo. */
export const looksLikePairingCode = (input) => /^[0-9A-Z]{10}$/.test(normalisePairingCode(input));

/** The shape of a worker token as it arrives in an `Authorization` header. */
export const looksLikeWorkerToken = (value) => {
  const token = str(value);
  return token.startsWith(WORKER_TOKEN_PREFIX) && token.length > WORKER_TOKEN_PREFIX.length + 20;
};

/**
 * Exchanges a pairing code for a worker token — the one moment the plaintext exists outside the worker.
 *
 * The name is what the dashboard lists the machine as ("ana-laptop", "github-actions"), defaulted rather than
 * required, because a blank name is a support question and a wrong one is nothing.
 */
export async function redeemPairing({ store, code, name = '', createdBy = null, now = () => new Date(), ttlMs = PAIRING_TTL_MS }) {
  const normalised = normalisePairingCode(code);
  if (!looksLikePairingCode(normalised)) {
    throw new DeployError(400, 'That pairing code is not complete. It is ten characters, shown as XXXXX-XXXXX.', { code: 'pairing_malformed' });
  }
  const at = toIso(now);
  const pairing = await store.consumePairing(hashWorkerSecret(normalised), at);
  if (!pairing) {
    throw new DeployError(
      401,
      'That pairing code is not valid any more. Generate a new one under Settings → Integrations → Plugin installs: codes expire after fifteen minutes and work once.',
      { code: 'pairing_invalid' },
    );
  }
  const { token, hash, prefix } = newWorkerToken();
  const worker = await store.insertWorker({
    name: str(name) || str(pairing.name) || 'build environment',
    token_hash: hash,
    token_prefix: prefix,
    created_by: pairing.created_by || createdBy,
    created_at: at,
    last_seen_at: at,
    revoked_at: null,
  });
  // `token` is returned exactly here and nowhere else. The route answers with it once, and the worker stores
  // it in its own environment file.
  return { worker: publicWorker(worker), token, expiresAt: str(pairing.expires_at) };
}

/**
 * Authenticates a worker request from its `Authorization` header.
 *
 * A token that is malformed, unknown or revoked is one answer (`401`), because a caller that has to tell them
 * apart is a caller trying tokens one at a time. The `code` still differs, for the site's own logs.
 */
export async function authenticateWorker({ store, authorization = '', now = () => new Date() }) {
  const token = str(authorization).replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new DeployError(401, 'A build worker authenticates with its own token: send Authorization: Bearer <worker token>. Pair one under Settings → Integrations → Plugin installs.', { code: 'worker_unauthorized' });
  }
  if (!looksLikeWorkerToken(token)) {
    throw new DeployError(401, 'That is not a build worker token. Pair this machine again to get one.', { code: 'worker_token_malformed' });
  }
  const row = await store.findWorkerByHash(hashWorkerSecret(token));
  if (!row) {
    throw new DeployError(401, 'This build worker token is not recognised. It may have been revoked, or it belongs to another site. Pair this machine again.', { code: 'worker_unknown' });
  }
  if (row.revoked_at) {
    throw new DeployError(401, `This build worker was revoked on ${str(row.revoked_at).slice(0, 10)}, so it cannot claim jobs. Pair this machine again to get a new token.`, { code: 'worker_revoked' });
  }
  await store.touchWorker(row.id, toIso(now)).catch(() => {});
  return publicWorker(row);
}

/** Every paired build environment, for the dashboard list. */
export async function listWorkers({ store }) {
  const rows = await store.listWorkers();
  return rows.map((row) => publicWorker(row));
}

/** Decommissioning a machine. The row stays so the list can say what was revoked and when. */
export async function revokeWorker({ store, workerId, now = () => new Date() }) {
  const row = await store.revokeWorker(str(workerId), toIso(now));
  if (!row) throw new DeployError(404, 'That build environment is not paired with this site.', { code: 'worker_missing' });
  return publicWorker(row);
}

/** What a route may show about a worker: never the hash, never the token. */
export function publicWorker(row) {
  return {
    id: str(row?.id),
    name: str(row?.name) || 'build environment',
    prefix: str(row?.token_prefix),
    createdAt: str(row?.created_at),
    lastSeenAt: str(row?.last_seen_at),
    revokedAt: str(row?.revoked_at),
    active: Boolean(row?.token_hash) && !row?.revoked_at,
  };
}


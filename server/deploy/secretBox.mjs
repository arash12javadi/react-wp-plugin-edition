/**
 * Sealed storage for the one credential a customer site has to keep: its Vercel access token.
 *
 * Why a token is stored at all
 * ----------------------------
 * A plugin that has to be compiled into a site cannot be installed from a browser alone: something has to
 * run the build and hand the result to Vercel. This repository already knows how to do both
 * (`plugins/rwp-saas-installer/prebuilt.mjs` builds, `createFileDeployment` deploys), and it deliberately
 * throws the visitor's token away afterwards (`server.mjs`, "used for this deployment and never stored") —
 * the right default for a one-off provision and the wrong one for "install this plugin, then publish it",
 * where the deploy happens minutes after the browser that started it has gone.
 *
 * So the token is kept, and keeping it is only acceptable if the database never holds it in readable
 * form. That is all this module is: AES-256-GCM over a key that exists **only** in the site's own
 * environment (`RWP_SECRET_BOX_KEY`), never in a table, never in the bundle (no `VITE_` prefix, so Vite
 * cannot inline it) and never in a message.
 *
 * The envelope
 * ------------
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64url, one dot-separated line — a `text` column, a JSON
 * field and a log line all carry it without escaping. `v1` is the format version: `openSecret` tries the
 * current key and then each key in `RWP_SECRET_BOX_KEY_PREVIOUS`, which is what makes rotation a change
 * here plus a re-seal on the next write, with no downtime and no re-entry of the token.
 *
 * Failure is a refusal, not a fallback: a missing key, a truncated envelope or a tampered tag throws. A
 * token that cannot be proven intact is worse than no token — the deployment would 401 and the operator
 * would go looking for a Vercel problem that does not exist (`token_unreadable` says otherwise).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Where the key lives. Deliberately not `VITE_`-prefixed: the browser bundle must never see it. */
export const SECRET_BOX_KEY_ENV = 'RWP_SECRET_BOX_KEY';

/** Older keys, still able to *open* an envelope, until the next write re-seals it under the current one. */
export const SECRET_BOX_PREVIOUS_ENV = 'RWP_SECRET_BOX_KEY_PREVIOUS';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
/** GCM's tag is 128 bits; a shorter one weakens the integrity guarantee for no gain. */
const TAG_BYTES = 16;
const VERSION = 'v1';

/** base64, base64url and hex are all what an operator has to hand; only the length has to be right. */
function decodeKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const attempts = [];
  if (/^[0-9a-fA-F]{64}$/.test(value)) attempts.push(Buffer.from(value, 'hex'));
  attempts.push(Buffer.from(value, 'base64'));
  attempts.push(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  for (const key of attempts) if (key.length === KEY_BYTES) return key;
  return null;
}

/**
 * The key this site seals with, or null when none is configured.
 *
 * A configured-but-wrong key throws instead of returning null: an operator who pasted a 31-byte secret
 * needs to read that, not to be told the feature is switched off.
 */
export function secretBoxKey(env = globalThis.process?.env || {}) {
  const raw = String(env[SECRET_BOX_KEY_ENV] || '').trim();
  if (!raw) return null;
  const key = decodeKey(raw);
  if (!key) {
    throw new Error(
      `${SECRET_BOX_KEY_ENV} must be 32 bytes, written as base64 or 64 hex characters. Generate one with: `
      + 'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

/** Every key an envelope may have been sealed with: the current one first, then the rotated-out ones. */
function openableKeys(env = globalThis.process?.env || {}) {
  const keys = [];
  const current = secretBoxKey(env);
  if (current) keys.push(current);
  for (const raw of String(env[SECRET_BOX_PREVIOUS_ENV] || '').split(',')) {
    const key = decodeKey(raw);
    if (key) keys.push(key);
  }
  return keys;
}

/** Whether this installation can hold a credential at all. A route answers 503 from this before asking. */
export const secretBoxEnabled = (env = globalThis.process?.env || {}) => Boolean(secretBoxKey(env));

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * Seals one secret. Returns the envelope string that goes into the column.
 *
 * A fresh random IV per call is what keeps two seals of the same token different, so a database reader
 * cannot tell "same token" by comparing rows.
 */
export function sealSecret(plaintext, { env = globalThis.process?.env || {}, key = null } = {}) {
  const value = typeof plaintext === 'string' ? plaintext : '';
  if (!value) throw new Error('There is no secret to seal.');
  const sealingKey = key || secretBoxKey(env);
  if (!sealingKey) {
    throw new Error(`This site cannot store credentials yet: set ${SECRET_BOX_KEY_ENV} to 32 random bytes (base64 or hex).`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, sealingKey, iv, { authTagLength: TAG_BYTES });
  // The version travels as authenticated data, so a `v1` envelope's bytes cannot be relabelled as another
  // format and still verify.
  cipher.setAAD(Buffer.from(VERSION, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join('.');
}

/**
 * Opens an envelope, or throws with a sentence that says which of the two things went wrong: the envelope
 * is not one of ours, or the key that would open it is not held here.
 */
export function openSecret(envelope, { env = globalThis.process?.env || {}, keys = null } = {}) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('The stored credential is not in a format this installation recognises. Store the token again.');
  }
  const [, ivRaw, tagRaw, ciphertextRaw] = parts;
  const iv = Buffer.from(ivRaw, 'base64url');
  const tag = Buffer.from(tagRaw, 'base64url');
  const ciphertext = Buffer.from(ciphertextRaw, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || !ciphertext.length) {
    throw new Error('The stored credential is damaged, so it cannot be used. Store the token again.');
  }
  const candidates = keys || openableKeys(env);
  if (!candidates.length) {
    throw new Error(`The stored credential cannot be opened: ${SECRET_BOX_KEY_ENV} is not set on this installation.`);
  }
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(VERSION, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // The wrong key fails the tag check; the right one is tried next.
    }
  }
  throw new Error(
    `The stored credential could not be decrypted with this installation's ${SECRET_BOX_KEY_ENV}. `
    + `If the key was rotated, keep the old one in ${SECRET_BOX_PREVIOUS_ENV} or store the token again.`,
  );
}

/**
 * A stable, non-reversible label for a secret — `sha256:<first 12 hex>` — for a screen or an audit row
 * that has to say *which* token is stored without holding it.
 */
export function secretFingerprint(secret) {
  const value = String(secret || '');
  if (!value) return '';
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** Generates a key an operator can paste into the environment. Used by a CLI, never by a request. */
export const generateSecretBoxKey = () => randomBytes(KEY_BYTES).toString('base64');

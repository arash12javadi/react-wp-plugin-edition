/**
 * Credentials in `system_settings` that are stored sealed (AES-256-GCM, `RWP_SECRET_BOX_KEY`).
 *
 * The site's email row and the rows of the plugins that ship to clients (shop email, shop payments, page
 * builder email) hold keys that send mail or move money. A row in `system_settings` is readable by
 * anyone who can read that table — a database backup, a leaked dump, a role granted `manage_options` —
 * so those fields are sealed on the way in. The browser can never seal anything (the key is server-only),
 * so these rows are saved through `POST /api/integrations/row/save`, which seals, and the database
 * refuses a plain-text secret in them (`rwp_sealed_setting_guard` in supabase/schema.sql).
 *
 * A stored value looks like `rwp-sealed:<envelope>`. A browser that loads the row keeps the opaque string
 * and sends it back unchanged on the next save, which is how "leave the password alone" works without
 * the plain text ever being on screen. Reading is tolerant of a plain value, because a site that saved
 * these rows before sealing existed must keep sending until an administrator saves them again.
 *
 * Plain ESM with no browser imports, like the other modules the plugin servers import.
 */
import { openSecret, sealSecret, secretBoxEnabled, SECRET_BOX_KEY_ENV } from './deploy/secretBox.mjs';

export const SEALED_PREFIX = 'rwp-sealed:';

/**
 * Row key -> the dotted paths of its secret fields. The same lists are in `rwp_sealed_setting_guard`
 * (supabase/schema.sql); change both or neither (`tests/sealedRows.test.mjs` compares them).
 */
export const SEALED_ROW_SECRETS = Object.freeze({
  email_config: Object.freeze(['api_key', 'smtp.password']),
  shop_email_config: Object.freeze(['api_key', 'smtp.password']),
  page_builder_email_config: Object.freeze(['api_key', 'smtp.password']),
  shop_payments_config: Object.freeze(['stripe_secret_key', 'stripe_webhook_secret', 'paypal_client_secret']),
});

export const isSealedRowKey = (key) => Object.prototype.hasOwnProperty.call(SEALED_ROW_SECRETS, String(key));

export const isSealedValue = (value) => typeof value === 'string' && value.startsWith(SEALED_PREFIX);

export class SealedRowError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SealedRowError';
    this.status = status;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

const getPath = (object, dotted) => dotted.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), object);

const setPath = (object, dotted, value) => {
  const parts = dotted.split('.');
  let node = object;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
};

/** The secret paths of `key` whose value is a non-empty string that is not sealed. */
export function plaintextSecrets(key, value) {
  if (!isSealedRowKey(key) || !value || typeof value !== 'object') return [];
  return SEALED_ROW_SECRETS[key].filter((path) => {
    const secret = getPath(value, path);
    return typeof secret === 'string' && secret.trim() !== '' && !isSealedValue(secret);
  });
}

/**
 * The row as it is stored: every plain secret sealed, every already-sealed one checked and kept, empty
 * ones left empty. Throws `SealedRowError` — with a sentence an administrator can act on — when the site
 * cannot seal, or when a sealed value sent back cannot be opened any more (the key was changed).
 */
export function sealRow(key, value, env = globalThis.process?.env || {}) {
  if (!isSealedRowKey(key)) throw new SealedRowError(400, `"${String(key)}" is not a setting this route stores.`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SealedRowError(400, 'The setting must be an object.');
  const row = clone(value);
  for (const path of SEALED_ROW_SECRETS[key]) {
    const secret = getPath(row, path);
    if (typeof secret !== 'string' || secret.trim() === '') {
      if (secret !== undefined) setPath(row, path, '');
      continue;
    }
    if (isSealedValue(secret)) {
      try {
        openSecret(secret.slice(SEALED_PREFIX.length), { env });
      } catch {
        throw new SealedRowError(409, `The saved ${path} can no longer be opened (${SECRET_BOX_KEY_ENV} was changed). Remove it and type it again.`);
      }
      continue;
    }
    if (!secretBoxEnabled(env)) {
      throw new SealedRowError(503, `This site cannot store credentials yet: set ${SECRET_BOX_KEY_ENV} (32 random bytes, base64) on the server and redeploy. Nothing was saved.`);
    }
    setPath(row, path, SEALED_PREFIX + sealSecret(secret.trim(), { env }));
  }
  return row;
}

/**
 * The row with every secret opened, for a server route that is about to use it. A plain value passes
 * through (a row saved before sealing existed). A sealed one that cannot be opened throws, naming the
 * variable, so the caller reports the real cause instead of sending with a garbage key.
 */
export function openRow(key, value, env = globalThis.process?.env || {}) {
  if (!isSealedRowKey(key) || !value || typeof value !== 'object') return value;
  const row = clone(value);
  for (const path of SEALED_ROW_SECRETS[key]) {
    const secret = getPath(row, path);
    if (!isSealedValue(secret)) continue;
    try {
      setPath(row, path, openSecret(secret.slice(SEALED_PREFIX.length), { env }));
    } catch (error) {
      throw new SealedRowError(503, error instanceof Error ? error.message : 'A stored credential could not be opened.');
    }
  }
  return row;
}

/**
 * Reading the Integrations credentials out of `system_settings` — for the server.
 *
 * The rows are written by the signed-in administrator's own browser (only a session with
 * `manage_options` may touch them: Supabase RLS says so, and the universal engine's `/api/db/query`
 * checks the same capability). The server therefore has to read them *somewhere else*, and which
 * somewhere depends on the deployment. Four ways are tried, in this order, and the first that can
 * answer wins:
 *
 *   1. **An injected reader** — the universal engine passes one backed by the database adapter it
 *      already has open. This is the only path that works on MySQL, SQLite and LibSQL.
 *   2. **A direct connection string** — `DATABASE_URL` (or the older `SUPABASE_DB_URL`) pointing at
 *      the site's PostgreSQL database. RLS does not apply to a direct session, so every row is
 *      readable.
 *   3. **The service key**, when the deployment sets `SUPABASE_SECRET_KEY`: PostgREST with a key RLS
 *      lets through.
 *   4. **Nothing.** Under Supabase the publishable key can never read these rows, so that is reported
 *      as `readable: false` together with the sentence that says what to set — far more useful than
 *      telling the administrator every card is unconfigured.
 *
 * Plain ESM for the same reason as `integrationConfig.mjs`: `server.mjs`, the Hono app and the
 * `api/*` functions all use this file. `pg` is imported on demand, so a deployment that never opens a
 * direct connection does not load a database driver for it.
 */
import {
  MEDIA_STORAGE_CONFIG_KEY,
  mediaCredentialsFrom,
  mediaStorageConfigFrom,
} from './integrationConfig.mjs';

/** The table the hub writes to. */
const SETTINGS_TABLE = 'system_settings';

/** What to tell an administrator whose server cannot read the rows. */
const UNREADABLE_REASON = 'This server cannot read the Integrations credentials: Supabase protects '
  + 'system_settings with row level security, which only a signed-in administrator can satisfy. Set '
  + 'DATABASE_URL to this project\'s connection string (Supabase → Project Settings → Database → '
  + 'Connection string → URI) and restart, or set SUPABASE_SECRET_KEY.';

/**
 * The hosts `.env.example` (and the Setup Wizard's sample block) use as stand-ins rather than
 * addresses. A site that copied the example without editing that one line has a connection string
 * that parses perfectly and resolves to nothing.
 */
const PLACEHOLDER_HOSTS = new Set([
  'host',
  'your-db-host',
  'your-project-ref',
  'db.your-project-ref.supabase.co',
]);

/** True for the example's own `postgres://user:password@host:5432/react_wp`. */
const isPlaceholderConnection = (value) => {
  try {
    const { hostname, username, password } = new URL(value);
    return PLACEHOLDER_HOSTS.has(hostname) || (username === 'user' && password === 'password');
  } catch {
    // Not a URL at all (a unix-socket path, a libpq keyword list) — `pg` may still open it.
    return false;
  }
};

/**
 * Which connection string to use for a direct read, if any.
 *
 * `SUPABASE_DB_URL` is tried first, the same order `server/db.mjs` resolves the pair in. The two
 * names are the same fact, but `.env.example` ships `DATABASE_URL` as a placeholder, so a Supabase
 * site that set only `SUPABASE_DB_URL` used to hand `pg` the example's `…@host/react_wp`, fail with
 * `ENOTFOUND host`, and report every Integrations card as unreadable until the service-key fallback
 * happened to answer. A stand-in is therefore skipped while a real string is available, and still
 * reported when it is the only one — an unopenable URL is worth saying out loud.
 */
const connectionStringFrom = ({ databaseUrl, env = {}, dbType = '' }) => {
  const type = String(dbType || '').toLowerCase();
  // A MySQL or SQLite URL cannot be opened by the Postgres driver, so it is not offered as one.
  if (type && type !== 'postgres' && type !== 'supabase') return '';
  const candidates = [databaseUrl, env.SUPABASE_DB_URL, env.DATABASE_URL]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return candidates.find((value) => !isPlaceholderConnection(value)) || candidates[0] || '';
};

const serviceKeyFrom = (env = {}) =>
  String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/** Reads keys over PostgREST with whatever key is given. Resolves null when the read failed. */
const readViaRest = async (supabaseUrl, key, keys) => {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  if (!base || !key) return null;
  const filter = keys.map((name) => `"${name.replace(/"/g, '')}"`).join(',');
  const url = `${base}/rest/v1/${SETTINGS_TABLE}?setting_key=in.(${filter})&select=setting_key,setting_value`;
  try {
    const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
};

/**
 * The connection string with every SSL directive `pg-connection-string` would act on removed.
 *
 * `pg` merges a parsed connection string *over* the config it was given (`connection-parameters.js`:
 * `config = Object.assign({}, config, parse(config.connectionString))`), so an `sslmode` in the URL
 * replaces any `ssl` object passed alongside it — and `sslmode=require` (or `verify-full`, or
 * `ssl=true`) parses to `{}`/`true`, i.e. `rejectUnauthorized: true`, which is the
 * `SELF_SIGNED_CERT_IN_CHAIN` failure against Supabase. Dropping the directives is what lets the
 * `rejectUnauthorized: false` in `readViaPostgres` be the value `pg` finally connects with. A string
 * that is not a URL (a unix-socket path, a libpq keyword/value list) is returned untouched.
 */
const withoutSslDirectives = (connectionString) => {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }
  let stripped = false;
  for (const key of [...url.searchParams.keys()]) {
    if (key === 'ssl' || key.startsWith('ssl') || key === 'uselibpqcompat') {
      url.searchParams.delete(key);
      stripped = true;
    }
  }
  return stripped ? url.toString() : connectionString;
};

/**
 * Reads keys from a PostgreSQL database directly. Resolves null when the connection failed.
 *
 * A failure is logged with the full error rather than swallowed: every browser-visible symptom of it is
 * the same `credentials.readable: false` banner, so the transport error, the authentication failure or
 * the firewall rule that caused it can only be told apart in the server's own logs.
 */
const readViaPostgres = async (connectionString, keys) => {
  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch (err) {
    // The driver could not be loaded at all — on a serverless host that means `pg` did not make it into
    // the deployment. The browser sees the same unreadable-settings banner either way, so this is
    // logged under the same tag rather than swallowed.
    console.error('[DATABASE_CONNECT_FAILED]', err);
    return null;
  }
  const client = new Client({
    connectionString: withoutSslDirectives(connectionString),
    // Supabase presents a certificate chain Node does not trust by default, so verification is turned
    // off here. `pg` only keeps this value if the connection string carries no SSL directive of its own,
    // which is why those are stripped first — see `withoutSslDirectives`.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select setting_key, setting_value from public.${SETTINGS_TABLE} where setting_key = any($1::text[])`,
      [keys],
    );
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    // Everything the browser gets for a failed connection is `credentials.readable: false` — the same
    // banner for a transaction-pooler URL, a rotated password, a paused project and a firewall rule —
    // so the exact reason has to be in the server's own logs. Vercel keeps `console.error` in Runtime
    // Logs, and the whole object is handed over so the message, the stack and `pg`'s own `code`/`detail`
    // all come out (`pg-connection-string` redacts the password from a parse error, so the connection
    // string cannot leak here).
    console.error('[DATABASE_CONNECT_FAILED]', err);
    // A log drain that JSON-serialises an Error keeps nothing but `{}`, so the fields are also emitted
    // as plain values.
    console.error('[DATABASE_CONNECT_FAILED]', {
      message: err instanceof Error ? err.message : String(err),
      code: err?.code ?? null,
      stack: err instanceof Error ? err.stack : null,
    });
    return null;
  } finally {
    await client.end().catch(() => {});
  }
};

/** `setting_value` is JSON with a string fallback, exactly like every other reader of this table. */
export const parseSettingValue = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Turns rows into `{ setting_key: value }`, dropping a key the deployment does not have. */
const rowsToSettings = (rows) => {
  const settings = {};
  for (const row of rows || []) settings[row.setting_key] = parseSettingValue(row.setting_value);
  return settings;
};

/**
 * The active media provider and the credentials built from it — the one call every media route makes.
 *
 * `credentials` is what a delete or an upload signature needs; `configuration` is what a screen shows.
 * Both come from the same read, so the Media screen can never be told deletion works while the delete
 * route is looking at a different row.
 */
export async function readMediaStorageSettings(options = {}) {
  const rows = await readIntegrationRows([MEDIA_STORAGE_CONFIG_KEY], options);
  const configuration = mediaStorageConfigFrom(rows.settings[MEDIA_STORAGE_CONFIG_KEY]);
  return {
    configuration,
    credentials: mediaCredentialsFrom(configuration),
    readable: rows.readable,
    error: rows.error,
  };
}

/**
 * Reads the rows the hub owns.
 *
 * @param {string[]} keys                     the `system_settings` keys to read
 * @param {object}   options
 * @param {(key: string) => Promise<unknown>} [options.readSetting] a reader the caller already has
 *   (the universal engine's database adapter). Takes precedence over every connection below.
 * @param {string}   [options.databaseUrl]     a PostgreSQL connection string, from the runtime config
 * @param {string}   [options.dbType]          the resolved database type, so a MySQL URL is not offered to pg
 * @param {string}   [options.supabaseUrl]     the project URL, for the PostgREST fallbacks
 * @param {string}   [options.supabaseKey]     the publishable key (only useful if policies allow reads)
 * @param {object}   [options.env]             the server environment, for the connection and service keys
 * @returns {Promise<{settings: Record<string, unknown>, readable: boolean, source: string, error: string}>}
 *   `settings` holds only the keys that exist. `readable: false` means the server *cannot* know —
 *   never that the site is unconfigured.
 */
export async function readIntegrationRows(keys, options = {}) {
  const { readSetting, supabaseUrl, supabaseKey, env = {} } = options;

  if (typeof readSetting === 'function') {
    const settings = {};
    for (const name of keys) settings[name] = parseSettingValue(await readSetting(name));
    return { settings, readable: true, source: 'adapter', error: '' };
  }

  const connectionString = connectionStringFrom(options);
  if (connectionString) {
    const rows = await readViaPostgres(connectionString, keys);
    if (rows) return { settings: rowsToSettings(rows), readable: true, source: 'database', error: '' };
    // A connection string that does not open is worth saying out loud: provisioning or a network rule
    // changed, and every card would otherwise simply look unconfigured.
    const fallback = await readViaRest(supabaseUrl, serviceKeyFrom(env), keys);
    if (fallback) return { settings: rowsToSettings(fallback), readable: true, source: 'rest', error: '' };
    return {
      settings: {},
      readable: false,
      source: 'unavailable',
      error: 'This server has a database connection string but could not open it, so the Integrations '
        + 'credentials could not be read. Check DATABASE_URL — a Supabase transaction-pooler URL cannot '
        + 'be used here, its session-mode URL can — then reload this screen.',
    };
  }

  const serviceKey = serviceKeyFrom(env);
  if (serviceKey && supabaseUrl) {
    const rows = await readViaRest(supabaseUrl, serviceKey, keys);
    if (rows) return { settings: rowsToSettings(rows), readable: true, source: 'rest', error: '' };
  }

  // Last resort: the publishable key. It answers on a backend whose policies allow it, and returns
  // nothing at all under Supabase — in which case saying so is the honest answer.
  const publishable = await readViaRest(supabaseUrl, supabaseKey, keys);
  if (publishable && publishable.length > 0) {
    return { settings: rowsToSettings(publishable), readable: true, source: 'rest', error: '' };
  }

  return { settings: {}, readable: false, source: 'unavailable', error: UNREADABLE_REASON };
}

/** The sentences a refusal carries when nobody overrode them — the Settings → Integrations wording. */
const SETTINGS_MESSAGES = {
  signedOut: 'Sign in as an administrator to change integrations.',
  notInstalled: 'This site is not installed, so its integrations cannot be managed.',
  invalidSession: 'Your session is not valid. Sign in again.',
  capabilityFailure: (capability) =>
    `Your role cannot change integrations: it does not have the ${capability} capability.`,
  unreachable: (detail) => `The site could not be reached to check your permission: ${detail}`,
};

/**
 * Confirms the caller holds a capability, using their own access token and the publishable key — no
 * service key and no server-side session. It asks the same `user_has_cap` the rest of the server
 * asks, so a role granted a capability under Settings → Roles is recognised.
 *
 * The capability is a parameter because more than one route now borrows a saved credential on a
 * caller's behalf: the three integration probes want `manage_options` (they are the settings screen),
 * while the core AI assistant wants `edit_posts` (writing a draft is not administering the site).
 * Both sentences and status codes are the ones this server has always answered with, so a caller
 * cannot tell which helper a route went through.
 *
 * `messages` overrides any sentence, so a route's refusal names that route rather than the settings
 * screen; every field is optional and a function value is called with the capability.
 *
 * Only the classic server needs this: the universal engine already has an authenticated adapter.
 */
export async function authorizeCapabilityOnSupabase(supabaseUrl, supabaseKey, accessToken, capability = 'manage_options', messages = {}) {
  const text = { ...SETTINGS_MESSAGES, ...messages };
  if (!accessToken) {
    return { ok: false, status: 401, error: text.signedOut };
  }
  const baseUrl = String(supabaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !supabaseKey) {
    return { ok: false, status: 501, error: text.notInstalled };
  }
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${accessToken}` };
  try {
    const userResponse = await fetch(`${baseUrl}/auth/v1/user`, { headers });
    if (!userResponse.ok) return { ok: false, status: 401, error: text.invalidSession };
    const capResponse = await fetch(`${baseUrl}/rest/v1/rpc/user_has_cap`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability }),
    });
    if (!capResponse.ok) {
      return { ok: false, status: 502, error: `Could not check your permission: user_has_cap returned HTTP ${capResponse.status}.` };
    }
    if (await capResponse.json() !== true) {
      return { ok: false, status: 403, error: text.capabilityFailure(capability) };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: text.unreachable(error instanceof Error ? error.message : 'unknown error'),
    };
  }
}

/** The Settings → Integrations spelling of the check above: the administrator's capability. */
export const authorizeSettingsManager = (supabaseUrl, supabaseKey, accessToken) =>
  authorizeCapabilityOnSupabase(supabaseUrl, supabaseKey, accessToken, 'manage_options');

/**
 * The roles that own an installation, spelled once for the check below and its sentences.
 *
 * `administrator` is the site's own owner — the role the Setup Wizard gives the first account — and
 * `super_admin` is the one a provisioned installation has. `src/lib/roles.ts` (`platformOwnerRoles`) is
 * the browser's copy and the restrictive `system_settings` policy in `supabase/schema.sql` (and
 * `server/schemaPrivileges.mjs`) spells the same two names in SQL: change one, change all three.
 */
export const PLATFORM_OWNER_ROLES = ['administrator', 'super_admin'];

/** The sentences a platform-owner refusal carries. */
const PLATFORM_OWNER_MESSAGES = {
  signedOut: 'Sign in as the platform owner to change what this installation publishes through.',
  notInstalled: 'This site is not installed, so its publishing settings cannot be managed.',
  invalidSession: 'Your session is not valid. Sign in again.',
  roleFailure: (role) =>
    `Your role cannot change what this installation publishes through: `
    + (role
      ? `${role} is not the platform owner (${PLATFORM_OWNER_ROLES.join(' or ')}).`
      : `this account has no role on this site, and only the platform owner (${PLATFORM_OWNER_ROLES.join(' or ')}) can.`),
  unreachable: (detail) => `The site could not be reached to check your permission: ${detail}`,
};

/**
 * Confirms the caller is the *platform owner* — an account holding one of {@link PLATFORM_OWNER_ROLES},
 * which is the site's own `administrator` or the `super_admin` a provisioned site has — rather than a
 * role that was only *granted* `manage_options`.
 *
 * `authorizeSettingsManager` above is deliberately not reused here: it asks `user_has_cap`, and
 * `public.user_has_cap` answers `true` for `administrator` for *every* capability name, so a
 * `manage_platform` capability would either desync the browser (`isPlatformOwner`, `src/lib/roles.ts`)
 * from the database or quietly mean nothing. The role is the authority in `public.profiles`, so this
 * asks `public.current_user_role()` and compares it, which is exactly what the RLS policies on
 * `system_settings` compare for the rows these routes touch.
 *
 * This is the check the platform-owner cards use: the GitHub credential this installation commits with
 * (`github_config`), the deploy hook that spends a build (`deploy_config`) and the SaaS installer's
 * template bookkeeping describe what the installation *is*, not how this site is configured, so a role
 * that merely holds `manage_options` — granted to it under Settings → Roles — is not the right holder.
 * `messages` overrides any sentence, so a
 * route's refusal names that route; every field is optional and a function value is called with the
 * role the caller turned out to hold (`''` when they hold none).
 *
 * The role comes back in the answer (`role`), because a route that reports success may also want to say
 * *who* it recognised rather than re-reading the profile.
 */
export async function authorizePlatformOwner(supabaseUrl, supabaseKey, accessToken, messages = {}) {
  const text = { ...PLATFORM_OWNER_MESSAGES, ...messages };
  if (!accessToken) {
    return { ok: false, status: 401, error: text.signedOut };
  }
  const baseUrl = String(supabaseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !supabaseKey) {
    return { ok: false, status: 501, error: text.notInstalled };
  }
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${accessToken}` };
  try {
    const userResponse = await fetch(`${baseUrl}/auth/v1/user`, { headers });
    if (!userResponse.ok) return { ok: false, status: 401, error: text.invalidSession };
    const roleResponse = await fetch(`${baseUrl}/rest/v1/rpc/current_user_role`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // The function takes no arguments; PostgREST still wants a body for a POST.
      body: '{}',
    });
    if (!roleResponse.ok) {
      return { ok: false, status: 502, error: `Could not check your permission: current_user_role returned HTTP ${roleResponse.status}.` };
    }
    // A scalar function answers as a JSON string (or null when the caller has no profile row).
    const answer = await roleResponse.json();
    const role = typeof answer === 'string' ? answer.trim() : '';
    if (!PLATFORM_OWNER_ROLES.includes(role)) {
      return { ok: false, status: 403, error: text.roleFailure(role) };
    }
    return { ok: true, role };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: text.unreachable(error instanceof Error ? error.message : 'unknown error'),
    };
  }
}

/**
 * Dashboard → Updates → "Database": the routes behind automatic database updates (`server/schemaMigrate.mjs`).
 * Shared by `server.mjs` and the universal engine (`src/server/schemaUpdate.ts`), so both answer identically.
 *
 *   GET  /api/admin/schema-update             what has been applied and what is waiting, in plain language
 *   POST /api/admin/schema-update/ensure      applies whatever is waiting (the admin calls it when it opens)
 *   POST /api/admin/schema-update/run         the same, as the "Try again" button
 *   POST /api/admin/schema-update/connection  `{ connectionString }` stores the database connection once, sealed
 *                                             (`{ remove: true }` forgets it); the string is never returned
 *
 * All need the **platform owner** (`administrator` / `super_admin`, `authorizePlatformOwner`): they open a direct
 * database session. Requests carry a bearer token, not a cookie, so a cross-site form cannot ride on a session.
 * Answers carry statuses, plugin names and sentences — never a connection string, key or SQL value
 * (`describeDbError` strips them from driver messages).
 *
 * Where the connection comes from, in this order: `SUPABASE_DB_URL` / `DATABASE_URL` in the environment (the
 * first-install wizard sets it), else the one the owner pasted here — kept in the platform-owner row
 * `db_connection_config`, sealed with RWP_SECRET_BOX_KEY. The sealed row is read with the caller's own session,
 * so it is used while an owner has the admin open; the start-up run (`auto()`) has no session and uses the
 * environment only.
 *
 * `createSchemaUpdater` is also what each host starts at boot (`auto()`): once per process, never throwing, and a
 * no-op when the recorded fingerprints already match the release.
 */
import { projectRefFromUrl, resolveConnectionString } from './db.mjs';
import { planSchemaUpdate, readSchemaStatus, runSchemaUpdate } from './schemaMigrate.mjs';
import { DB_CONNECTION_SETTING_KEY } from './integrationConfig.mjs';
import { requireSecretBox, settingsIo } from './gitDeploy/connection.mjs';
import { ensureVersionRecord } from './versionRecord.mjs';
import { openSecret, sealSecret, secretFingerprint } from './deploy/secretBox.mjs';

const PREFIX = '/api/admin/schema-update';
const PATHS = new Set([PREFIX, `${PREFIX}/run`, `${PREFIX}/ensure`, `${PREFIX}/connection`]);

/** The paths this module answers — the single list both engines route by. */
export const ownsSchemaUpdatePath = (pathname) => PATHS.has(pathname);

const bearerToken = (headers = {}) => String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
const ok = (status, body) => ({ status, body: { success: true, ok: true, ...body } });
const refuse = (status, error) => ({ status, body: { success: false, ok: false, error } });

const CONNECTION_HELP = 'Paste your database connection string once in the box below. In Supabase open your project, click Connect, choose "Session pooler" and copy the string (it ends in :5432/postgres), replacing [YOUR-PASSWORD] with your database password. It is stored encrypted and is never shown again.';

/** The sentence block the screen shows for a result. `result` is what `readSchemaStatus` / `runSchemaUpdate` answered. */
export function presentSchemaResult(result) {
  const names = (status) => (result.units || []).filter((unit) => unit.status === status);
  switch (result.status) {
    case 'needs_connection':
      return { state: 'needs_connection', headline: 'The database cannot update itself yet', detail: 'This site has no direct database connection saved, so it cannot change its own database. The site keeps working; releases that add database features need this one-time step.', action: CONNECTION_HELP };
    case 'unreachable':
      return { state: 'failed', headline: 'The database could not be reached', detail: result.reason || 'The connection to the database failed. Nothing was changed.', action: 'Paste the connection string again in the box below (Supabase → Connect → Session pooler, ending in :5432/postgres; not the Transaction pooler on port 6543), then press "Try again".' };
    case 'busy':
      return { state: 'pending', headline: 'An update is already running', detail: 'Another copy of this site is updating the database right now.', action: 'Press "Try again" in a minute.' };
    case 'failed':
      return { state: 'failed', headline: 'A database update failed and was rolled back', detail: names('failed').map((unit) => unit.reason).join(' '), action: 'Nothing was lost. Press "Try again"; if it fails again, send the message above to whoever maintains the site.' };
    case 'manual':
      return { state: 'manual', headline: 'A database update could not be applied automatically', detail: names('manual').map((unit) => unit.reason).join(' '), action: 'It was held back on purpose so that no data can be lost. Send the message above to whoever maintains the site.' };
    case 'pending':
      return { state: 'pending', headline: 'A database update is waiting', detail: `${names('pending').map((unit) => unit.label).join(', ')} ${names('pending').length === 1 ? 'has' : 'have'} database changes from the latest release.`, action: 'It is applied by itself when this page opens. Existing content is not touched.' };
    default:
      return {
        state: 'ok',
        headline: (result.ran || []).length ? 'Database updated automatically' : 'Database is up to date',
        detail: (result.ran || []).length ? `Applied: ${(result.ran || []).join(', ')}. No content was changed or removed.` : 'Nothing to do for this release.',
        action: '',
      };
  }
}

const CONNECTION_SHAPE = 'That does not look like a connection string. It starts with postgresql:// and is copied from Supabase → Connect → Session pooler.';

/**
 * A Postgres connection string an owner pasted, checked before it is tried: protocol, a Supabase host, password,
 * not the Transaction pooler — and, when the site's project is known, THIS project's (`postgres.<ref>` or
 * `db.<ref>.supabase.co`), so the updater can never be pointed at another database or at a host of someone's choosing.
 */
export function checkPastedConnection(value, projectRef = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: CONNECTION_SHAPE };
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname) return { ok: false, error: CONNECTION_SHAPE };
  if (/\[YOUR-PASSWORD\]/i.test(text) || !url.password) {
    return { ok: false, error: 'The connection string still needs your database password: replace [YOUR-PASSWORD] with it (Supabase → Project Settings → Database lets you reset it if you do not have it).' };
  }
  if (!/\.supabase\.(com|co)$/i.test(url.hostname)) {
    return { ok: false, error: 'That connection string is not for a Supabase database. Copy the Session pooler string from Supabase → Connect.' };
  }
  if (projectRef && decodeURIComponent(url.username) !== `postgres.${projectRef}` && !url.hostname.toLowerCase().startsWith(`db.${projectRef.toLowerCase()}.`)) {
    return { ok: false, error: 'That connection string belongs to a different Supabase project than this site. Open this site\'s own project in Supabase → Connect and copy its Session pooler string.' };
  }
  if (url.port === '6543') {
    return { ok: false, error: 'That is the Transaction pooler (port 6543). Choose "Session pooler" in Supabase → Connect instead: its string ends in :5432/postgres. The Transaction pooler cannot keep two updates apart.' };
  }
  return { ok: true, url: text };
}

/**
 * @param {object} options
 * @param {{ coreSql: () => Promise<string>, plugins: () => Promise<object[]> }} options.sources
 * @param {{ supabaseUrl?: string }} [options.config]
 * @param {typeof import('./db.mjs').withClient} [options.withClient]
 */
export function createSchemaUpdater({ sources, config = null, withClient }) {
  let autoPromise = null;
  /** The environment's connection, else `stored` (the sealed one an owner pasted, opened by the caller). */
  const connection = (stored = '') => {
    const resolved = resolveConnectionString({}, config);
    return resolved.ok ? resolved.url : stored;
  };
  const units = async () => planSchemaUpdate({ coreSql: await sources.coreSql(), plugins: await sources.plugins() });
  const options = async (stored = '') => ({ connectionString: connection(stored), units: await units(), ...(withClient ? { withClient } : {}) });
  const status = async (stored = '') => readSchemaStatus(await options(stored));
  const run = async (stored = '') => runSchemaUpdate(await options(stored));
  return {
    status,
    run,
    /** Applies what is waiting and nothing else: a status read first, so an up-to-date site opens no write session. */
    async ensure(stored = '') {
      const current = await status(stored);
      return current.status === 'pending' ? run(stored) : current;
    },
    /** Reads the status through `connectionString` without applying anything — used to test a pasted string. */
    probe: async (connectionString) => readSchemaStatus({ connectionString, units: await units(), ...(withClient ? { withClient } : {}) }),
    /** Once per process; never throws; logs one line without any connection detail. */
    auto() {
      if (!autoPromise) {
        autoPromise = (async () => {
          const result = await runSchemaUpdate(await options());
          if (result.ran?.length) console.log(`Database updated automatically: ${result.ran.join(', ')}.`);
          else if (['failed', 'manual', 'unreachable'].includes(result.status)) console.warn(`Automatic database update: ${result.status}. See Dashboard → Updates.`);
          return result;
        })().catch((error) => {
          console.warn(`Automatic database update did not run: ${error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : 'unknown error'}`);
          return { status: 'unreachable', units: [], ran: [] };
        });
      }
      return autoPromise;
    },
  };
}

/** The connection string an owner pasted earlier, opened with this server's secret key — or '' (never throws). */
async function storedConnection(io, env) {
  try {
    const row = await io.read(DB_CONNECTION_SETTING_KEY);
    const sealed = row && typeof row === 'object' && typeof row.sealed === 'string' ? row.sealed : '';
    return sealed ? openSecret(sealed, { env }) : '';
  } catch {
    return '';
  }
}

/**
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.pathname
 * @param {Record<string, string>} options.headers  only `authorization` is read
 * @param {Record<string, unknown>} [options.body]
 * @param {{ supabaseUrl?: string, supabasePublishableKey?: string }} [options.config]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {ReturnType<typeof createSchemaUpdater>} options.updater
 * @param {(token: string) => Promise<{ ok: boolean, status?: number, error?: string }>} options.authorize
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function handleSchemaUpdateRequest({ method, pathname, headers = {}, body = {}, config = {}, env = globalThis.process?.env || {}, updater, authorize, fetchImpl = fetch }) {
  if (!ownsSchemaUpdatePath(pathname)) return null;
  if (typeof authorize !== 'function') return refuse(501, 'This host cannot authorize database updates.');
  const accessToken = bearerToken(headers);
  const auth = await authorize(accessToken);
  if (!auth?.ok) return refuse(auth?.status || 403, auth?.error || 'Only the platform owner can update the database.');
  const io = settingsIo({ supabaseUrl: config?.supabaseUrl, supabaseKey: config?.supabasePublishableKey, accessToken, fetchImpl });
  const present = (result) => ({ result: { ...result, ...presentSchemaResult(result) } });
  try {
    if (pathname === `${PREFIX}/connection`) {
      if (method !== 'POST') return refuse(405, 'Use POST to save the database connection.');
      if (body?.remove === true) {
        await io.remove(DB_CONNECTION_SETTING_KEY);
        return ok(200, present(await updater.status('')));
      }
      const checked = checkPastedConnection(body?.connectionString, projectRefFromUrl(config?.supabaseUrl));
      if (!checked.ok) return refuse(400, checked.error);
      // Fails closed, before the string is tried or stored: without the key it could only be kept in the clear.
      requireSecretBox(env);
      const tried = await updater.probe(checked.url);
      if (tried.status === 'unreachable') return ok(200, present(tried));
      await io.write(DB_CONNECTION_SETTING_KEY, { sealed: sealSecret(checked.url, { env }), fingerprint: secretFingerprint(checked.url), saved_at: new Date().toISOString() });
      // The first update runs now, so the owner sees the result of pasting it.
      return ok(200, present(await updater.ensure(checked.url)));
    }
    const stored = await storedConnection(io, env);
    if (pathname === PREFIX) {
      if (method !== 'GET') return refuse(405, 'Use GET to read the database update status.');
      return ok(200, present(await updater.status(stored)));
    }
    if (method !== 'POST') return refuse(405, 'Use POST to apply the database update.');
    if (pathname === `${PREFIX}/ensure`) {
      // Opening the admin also lets a site that has a stamped package.json but no `.rwp-version` record its release
      // by itself (no commit, no question): see `ensureVersionRecord`.
      await ensureVersionRecord().catch(() => null);
      return ok(200, present(await updater.ensure(stored)));
    }
    return ok(200, present(await updater.run(stored)));
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0].slice(0, 220) : 'unknown error';
    return refuse(Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500, `The database update could not start: ${message}`);
  }
}

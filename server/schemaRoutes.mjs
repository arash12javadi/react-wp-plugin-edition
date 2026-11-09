/**
 * Dashboard → Updates → "Database": the routes behind automatic database updates (`server/schemaMigrate.mjs`).
 * Shared by `server.mjs` and the universal engine (`src/server/schemaUpdate.ts`), so both answer identically.
 *
 *   GET  /api/admin/schema-update       what has been applied and what is waiting, in plain language
 *   POST /api/admin/schema-update/run   applies whatever changed ("Update database now")
 *
 * Both need the **platform owner** (`administrator` / `super_admin`, `authorizePlatformOwner`): they open a direct
 * database session. Requests carry a bearer token, not a cookie, so a cross-site form cannot ride on a session.
 * Answers carry statuses, plugin names and sentences — never a connection string, key or SQL value
 * (`describeDbError` strips them from driver messages).
 *
 * `createSchemaUpdater` is also what each host starts at boot (`auto()`): once per process, never throwing, and a
 * no-op when the recorded fingerprints already match the release.
 */
import { resolveConnectionString } from './db.mjs';
import { planSchemaUpdate, readSchemaStatus, runSchemaUpdate } from './schemaMigrate.mjs';

const PREFIX = '/api/admin/schema-update';
const PATHS = new Set([PREFIX, `${PREFIX}/run`]);

/** The paths this module answers — the single list both engines route by. */
export const ownsSchemaUpdatePath = (pathname) => PATHS.has(pathname);

const bearerToken = (headers = {}) => String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
const ok = (status, body) => ({ status, body: { success: true, ok: true, ...body } });
const refuse = (status, error) => ({ status, body: { success: false, ok: false, error } });

const CONNECTION_HELP = 'Add your database connection string as SUPABASE_DB_URL (or DATABASE_URL) in your host\'s environment variables — in Supabase: Project Settings → Database → Connection string → Session pooler (port 5432; not the Transaction pooler on port 6543, where the lock that keeps two updates apart is unreliable) — and redeploy. Or, once per release, open the Supabase SQL Editor and run supabase/schema.sql.';

/** The sentence block the screen shows for a result. `result` is what `readSchemaStatus` / `runSchemaUpdate` answered. */
export function presentSchemaResult(result) {
  const names = (status) => (result.units || []).filter((unit) => unit.status === status);
  switch (result.status) {
    case 'needs_connection':
      return { state: 'needs_connection', headline: 'Automatic database updates are off', detail: 'This site has no direct database connection, so it cannot change its own database. The site keeps working; new releases that add database features need one step from you.', action: CONNECTION_HELP };
    case 'unreachable':
      return { state: 'failed', headline: 'The database could not be reached', detail: result.reason || 'The connection to the database failed. Nothing was changed.', action: 'Check SUPABASE_DB_URL (or DATABASE_URL): it must be the Session pooler string (port 5432), not the Transaction pooler (port 6543). Then press "Check again".' };
    case 'busy':
      return { state: 'pending', headline: 'An update is already running', detail: 'Another copy of this site is updating the database right now. Check again in a minute.', action: '' };
    case 'failed':
      return { state: 'failed', headline: 'A database update failed and was rolled back', detail: names('failed').map((unit) => unit.reason).join(' '), action: 'Nothing was lost. Press "Update database now" to retry; if it fails again, send the message above to whoever maintains the site.' };
    case 'manual':
      return { state: 'manual', headline: 'A database update needs one manual step', detail: names('manual').map((unit) => unit.reason).join(' '), action: 'It was not applied automatically so that no data can be lost.' };
    case 'pending':
      return { state: 'pending', headline: 'A database update is waiting', detail: `${names('pending').map((unit) => unit.label).join(', ')} ${names('pending').length === 1 ? 'has' : 'have'} database changes from the latest release.`, action: 'Press "Update database now". Existing content is not touched.' };
    default:
      return {
        state: 'ok',
        headline: (result.ran || []).length ? 'Database updated automatically' : 'Database is up to date',
        detail: (result.ran || []).length ? `Applied: ${(result.ran || []).join(', ')}. No content was changed or removed.` : 'Nothing to do for this release.',
        action: '',
      };
  }
}

/**
 * @param {object} options
 * @param {{ coreSql: () => Promise<string>, plugins: () => Promise<object[]> }} options.sources
 * @param {{ supabaseUrl?: string }} [options.config]
 * @param {typeof import('./db.mjs').withClient} [options.withClient]
 */
export function createSchemaUpdater({ sources, config = null, withClient }) {
  let autoPromise = null;
  const connection = () => {
    const resolved = resolveConnectionString({}, config);
    return resolved.ok ? resolved.url : '';
  };
  const units = async () => planSchemaUpdate({ coreSql: await sources.coreSql(), plugins: await sources.plugins() });
  const options = async () => ({ connectionString: connection(), units: await units(), ...(withClient ? { withClient } : {}) });
  return {
    status: async () => readSchemaStatus(await options()),
    run: async () => runSchemaUpdate(await options()),
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

/**
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.pathname
 * @param {Record<string, string>} options.headers  only `authorization` is read
 * @param {ReturnType<typeof createSchemaUpdater>} options.updater
 * @param {(token: string) => Promise<{ ok: boolean, status?: number, error?: string }>} options.authorize
 */
export async function handleSchemaUpdateRequest({ method, pathname, headers = {}, updater, authorize }) {
  if (!ownsSchemaUpdatePath(pathname)) return null;
  if (typeof authorize !== 'function') return refuse(501, 'This host cannot authorize database updates.');
  const auth = await authorize(bearerToken(headers));
  if (!auth?.ok) return refuse(auth?.status || 403, auth?.error || 'Only the platform owner can update the database.');
  try {
    if (pathname === PREFIX) {
      if (method !== 'GET') return refuse(405, 'Use GET to read the database update status.');
      const result = await updater.status();
      return ok(200, { result: { ...result, ...presentSchemaResult(result) } });
    }
    if (method !== 'POST') return refuse(405, 'Use POST to apply the database update.');
    const result = await updater.run();
    return ok(200, { result: { ...result, ...presentSchemaResult(result) } });
  } catch (error) {
    return refuse(500, `The database update could not start: ${error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'unknown error'}`);
  }
}

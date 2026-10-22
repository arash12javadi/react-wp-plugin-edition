/**
 * The one question a page has to answer before it renders anything: does this site have a database
 * it can read?
 *
 * `App.tsx` used to answer it with a bare boolean — `checkDatabase()` caught everything and returned
 * `false` — and `false` rendered the **Setup Wizard**. That conflated two different situations:
 * "this site was never installed" and "the database could not be read". A paused Supabase project, a
 * blocked request, a rejected credential, a 5xx, a still-migrating schema and a page cached from
 * before the install all arrived at the same screen: a wizard asking for credentials nobody needs,
 * on a site that already has them. That is worse than a wrong label. The wizard never re-checks the
 * database, and nothing in the app ever cleared the one piece of browser-local state that can make
 * *every* read fail — a stored session the backend no longer accepts (rotated project keys, a
 * deleted auth user, a project that was replaced). `@supabase/supabase-js` discards a session only
 * when its *refresh* is rejected, so an access token that has not expired yet is replayed on every
 * request and answered with 401 for as long as its `expires_at` says it is valid. Ctrl+Shift+R
 * re-runs that same failing read, so the browser stayed on the wizard while every other browser
 * opened the site normally.
 *
 * This module keeps the three answers apart (`freshInstall`, a live client, or a failure with its
 * reason), recovers the browser automatically when a stored session is what broke the read, and asks
 * the server before it ever calls a site "not installed".
 */
import { describeDbError, resetClient, tryGetClient, type Client } from './db';
import { isConfigured, resolveRuntimeConfig } from './runtime';
import { AUTH_TOKEN_KEY } from './auth/token';

/** How many times a failed read is retried before the failure is reported to the screen. */
const PROBE_ATTEMPTS = 3;
/** Pause between attempts: a cold PostgREST/SQLite connection and a wifi handover both need one. */
const PROBE_RETRY_DELAY_MS = 400;
/** Where the server reports whether its own environment describes a provisioned site. */
const INSTALL_CHECK_ENDPOINT = '/api/install/check';
/** How long that answer may take before the question is abandoned and treated as unknown. */
const INSTALL_CHECK_TIMEOUT_MS = 5000;
/** Supabase stores its session as `sb-<project-ref>-auth-token`, plus `-user` / `-code-verifier`. */
const SUPABASE_SESSION_KEY = /^sb-.*-auth-token/;
/**
 * Failures a stored credential can cause, and that signing out can therefore fix: PostgREST's
 * `PGRST30x` (JWT expired, invalid claim, no signature), a rejected API key, `42501` on a table the
 * signed-in role may not read, and Supabase Auth's own token errors. A missing table, a DNS failure
 * or a 5xx does not match, and must not sign anybody out for a network blip.
 */
const AUTH_FAILURE = /PGRST30[0-9]|JWT|token|Invalid API key|invalid claim|not authenticated|\b40[13]\b|permission denied|row-level security|\bRLS\b|policy/i;

/** Which kind of trouble the boot hit, so the recovery screen can give the right advice. */
export type BootProblem = 'auth' | 'connection';

export interface BootFailure {
  problem: BootProblem;
  /** The driver's own words, printed verbatim: a pause and a lock-out read differently. */
  message: string;
}

export interface BootResult {
  /** The live client when the site booted; null when it did not. */
  client: Client | null;
  /** True when this page *and* the server agree the site has no database yet: show the Setup Wizard. */
  freshInstall: boolean;
  /** Set when the site is configured but unreadable. Never set together with `freshInstall`. */
  failure: BootFailure | null;
  /** Session keys dropped from this browser's storage to recover the read, for the log line. */
  clearedSession: string[];
  /** What the page's own configuration claimed, for the recovery screen's diagnostics. */
  configured: boolean;
  /** The backend it names (`supabase`, `postgres`, …), for the same line. */
  dbType: string;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** True when the failure looks like a rejected credential rather than a broken connection. */
export const looksLikeAuthFailure = (message: string): boolean => AUTH_FAILURE.test(message);

/**
 * One read of `options` — the table every install has and every visitor may read — reported as its
 * error text instead of a boolean, so the caller can tell a pause from a lock-out.
 */
const probeOnce = async (): Promise<{ ok: boolean; error: string }> => {
  const client = tryGetClient();
  if (!client) {
    return {
      ok: false,
      error: isConfigured(resolveRuntimeConfig())
        ? 'The database client could not be created from the configuration in this page.'
        : 'This page carries no database configuration.',
    };
  }
  try {
    const { error } = await client.from('options').select('option_name').limit(1);
    return error ? { ok: false, error: describeDbError(error) } : { ok: true, error: '' };
  } catch (error) {
    // A driver that throws instead of answering `{ error }`: a blocked request, a storage that
    // refuses access, a table that does not exist. Its message is what tells those apart.
    return { ok: false, error: describeDbError(error) };
  }
};

/** The read above, retried: a single blip must not be reported as an unreadable database. */
const probeDatabase = async (): Promise<{ ok: boolean; error: string }> => {
  let result = await probeOnce();
  for (let attempt = 1; !result.ok && attempt < PROBE_ATTEMPTS; attempt += 1) {
    await wait(PROBE_RETRY_DELAY_MS);
    result = await probeOnce();
  }
  return result;
};

/**
 * Every session credential this browser holds for this site, removed and reported.
 *
 * Clearing them is the recovery step. `@supabase/supabase-js` keeps its session under
 * `sb-<ref>-auth-token*` and only discards it when the refresh token is rejected, so a session whose
 * access token has not expired is handed to every request even after the project's keys were rotated
 * — a 401 on every read, which from the outside is indistinguishable from an uninstalled site. The
 * universal engine keeps its JWT under `AUTH_TOKEN_KEY`; the server treats an unreadable one as a
 * visitor, but it still belongs to a sign-in that no longer exists. Storage can refuse access
 * (private windows, blocked site data); that is not an error here, it only means there is nothing to
 * clear.
 */
export function clearStoredSession(): string[] {
  const cleared: string[] = [];
  try {
    // Downwards, because removing an entry shifts every index above it.
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key && SUPABASE_SESSION_KEY.test(key)) {
        window.localStorage.removeItem(key);
        cleared.push(key);
      }
    }
  } catch {
    // Blocked or unavailable storage: nothing to clear.
  }
  try {
    if (window.localStorage.getItem(AUTH_TOKEN_KEY) !== null) {
      window.localStorage.removeItem(AUTH_TOKEN_KEY);
      cleared.push(AUTH_TOKEN_KEY);
    }
  } catch {
    // As above.
  }
  return cleared;
}

/**
 * Asks the server whether *it* considers this site installed (`GET /api/install/check`).
 *
 * The server knows things the page cannot. For a SQLite/PostgreSQL/MySQL site the browser holds no
 * connection details at all — it reads through `/api/db/query`, so its own configuration proves
 * nothing — and on a host whose environment carries the database URL the answer does not depend on
 * whatever copy of `index.html` the browser was handed. That is what makes it a second opinion worth
 * having before calling a site "not installed". `null` means the question could not be asked (a
 * static host with no API, an HTML answer, an offline visitor), never "not installed".
 */
export async function checkInstallOnServer(): Promise<boolean | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INSTALL_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(INSTALL_CHECK_ENDPOINT, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as { installed?: unknown } | null;
    return typeof payload?.installed === 'boolean' ? payload.installed : null;
  } catch {
    // A static host answers with the SPA's own index.html, a missing server throws, an offline
    // visitor rejects and a hanging endpoint times out; all are "unknown", never `false`: guessing
    // here is what shows a wizard on an installed site.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Decides what this page should render, in one place.
 *
 * 1. A page with no configuration is a fresh install — unless the server says otherwise, in which
 *    case the page is stale (an HTML cache, a deploy missing its environment variables) and the
 *    recovery screen says so instead of pretending the site is new.
 * 2. A configured page is never a fresh install: an unreadable database is not an empty one. The
 *    read is retried, then retried once more after dropping a stored session that the failure says
 *    is being rejected, and only then reported.
 */
export async function bootDatabase(): Promise<BootResult> {
  const config = resolveRuntimeConfig();
  const configured = isConfigured(config);
  const base: BootResult = {
    client: null,
    freshInstall: false,
    failure: null,
    clearedSession: [],
    configured,
    dbType: config.dbType,
  };

  if (!configured) {
    if (await checkInstallOnServer() === true) {
      return {
        ...base,
        failure: {
          problem: 'connection',
          message: 'The server reports an installed site, but this page carries no database configuration.',
        },
      };
    }
    return { ...base, freshInstall: true };
  }

  const first = await probeDatabase();
  if (first.ok) return { ...base, client: tryGetClient() };

  const clearedSession = looksLikeAuthFailure(first.error) ? clearStoredSession() : [];
  if (!clearedSession.length) {
    return { ...base, failure: { problem: looksLikeAuthFailure(first.error) ? 'auth' : 'connection', message: first.error } };
  }

  // A fresh client, so the retry reads the storage that was just emptied instead of the session the
  // old one still holds in memory.
  resetClient();
  const second = await probeDatabase();
  if (second.ok) return { ...base, client: tryGetClient(), clearedSession };
  return { ...base, clearedSession, failure: { problem: 'auth', message: second.error } };
}

/**
 * The boot verdict this browser reached last time, remembered between page loads.
 *
 * Every page load began with the same blocking read: `bootDatabase()` (`src/lib/boot.ts`) asks the
 * database for one row before the app renders anything, because it has to tell "this site has no
 * database" (the Setup Wizard) from "this database could not be read" (the recovery screen). The
 * answer, though, does not change between one page load and the next — so a visitor paid a full
 * round trip to the backend before the first pixel of *every* page, on a site that had already
 * answered the very same question a minute earlier.
 *
 * This module remembers the **positive** answer only: "this browser reached this site's database
 * at …". With it in hand, `App.tsx` builds the client from the page's own configuration (no
 * request) and paints immediately, while `bootDatabase()` re-checks behind the paint. A failure
 * means `clearBootCache()`, so the next load checks before it paints instead of flashing a page
 * that then turns into the recovery screen.
 *
 * Two decisions are load-bearing:
 *
 * - **Only successes are stored.** A failure is transient by nature — a paused project, a wifi
 *   handover, a session `bootDatabase()` repairs by itself — and caching one would keep a browser
 *   on the recovery screen after the problem was fixed, with no way out but clearing site data.
 *   A site with no database yet is not stored either: the Setup Wizard is the first visit, and it
 *   hard-navigates to the installed site when it is done.
 * - **The entry is tied to the page's configuration and expires.** `configurationSignature()`
 *   names the backend and, for Supabase, the project URL, so a site that was reconfigured, moved
 *   to another project or reset is checked from scratch, and `MAX_AGE_MS` bounds how long a
 *   browser may trust a verdict before its first paint even if that check never runs.
 */
import { isConfigured, resolveRuntimeConfig } from './runtime';

/** Where the verdict is kept. Bumping `CACHE_VERSION` retires entries written by an older shape. */
const STORAGE_KEY = 'rwp_boot_cache';
const CACHE_VERSION = 1;

/**
 * A day. Only the *first paint* depends on this window: every warm load re-checks in the
 * background, so the entry is refreshed on each success and a stale one costs one optimistic
 * render, not a wrong screen. The window exists for the case where that check cannot run at all.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A remembered successful boot: when it happened, and the configuration it happened against. */
export interface BootCacheEntry {
  /** Epoch milliseconds of the last successful boot. */
  at: number;
  /** The configuration the verdict belongs to (see `configurationSignature`). */
  signature: string;
}

/**
 * What the page's own configuration says, in one string. The browser holds no connection details
 * for the server-only backends (it reads through `/api/db/query`), so for those the backend and
 * whether it is configured at all is everything this page can know.
 */
const configurationSignature = (): string => {
  const config = resolveRuntimeConfig();
  const endpoint = config.dbType === 'supabase' ? config.supabaseUrl || '' : '';
  return `${config.dbType}|${isConfigured(config) ? 'configured' : 'unconfigured'}|${endpoint}`;
};

/**
 * The remembered verdict, or null when there is none this page may use: no entry, storage that
 * cannot be read (private windows, blocked site data), an entry written for another configuration,
 * one older than `MAX_AGE_MS`, or one whose timestamp is in the future (a clock that moved
 * backwards is not evidence of anything).
 */
export function readBootCache(now = Date.now()): BootCacheEntry | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<BootCacheEntry> & { version?: number } | null;
    if (!stored || stored.version !== CACHE_VERSION) return null;
    if (typeof stored.at !== 'number' || !Number.isFinite(stored.at)) return null;
    if (stored.signature !== configurationSignature()) return null;
    const age = now - stored.at;
    if (age < 0 || age > MAX_AGE_MS) return null;
    return { at: stored.at, signature: stored.signature };
  } catch {
    return null;
  }
}

/** Records that this browser has just read this site's database, refreshing the window. */
export function writeBootCache(now = Date.now()): void {
  try {
    const entry = { version: CACHE_VERSION, at: now, signature: configurationSignature() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Full or blocked storage only costs the next page load the round trip it has always paid.
  }
}

/**
 * Drops the remembered verdict. Called when a re-check contradicts it, so the next load blocks on
 * the answer rather than painting a page that is about to be replaced by the recovery screen.
 */
export function clearBootCache(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

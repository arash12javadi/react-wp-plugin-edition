/**
 * WordPress's Options and Transients API.
 *
 * SECURITY: the `options` table is readable by anyone, including visitors who are not signed in
 * (the public site needs the site title before login). Everything stored with rwp_update_option is
 * public. In WordPress an option is private; here it is not. Never store a password, an API key or
 * personal data in an option. Use Settings → Integrations (system_settings, sealed server-side) for
 * credentials, and a plugin table with row level security for private data.
 *
 * Every function is async because the data lives in the database.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client, getOption, updateOption } from '../db';

const MISSING = Symbol('rwp-missing');

/** The value of an option, or `defaultValue` when it does not exist. */
export async function rwp_get_option<T = unknown>(option: string, defaultValue: T | false = false): Promise<T | false> {
  const name = option.trim();
  if (!name) return false;
  const fallback = applyFilters<T | false>(`rwp_default_option_${name}`, defaultValue, name, defaultValue !== false);
  const value = await getOption<unknown>(name, MISSING);
  return (value === MISSING ? fallback : value) as T | false;
}

/**
 * Creates the option, or does nothing and returns false when it already exists. Fires
 * rwp_add_option, rwp_add_option_{name} and rwp_added_option through updateOption.
 */
export async function rwp_add_option(option: string, value: unknown = ''): Promise<boolean> {
  const name = option.trim();
  if (!name) return false;
  if ((await getOption<unknown>(name, MISSING)) !== MISSING) return false;
  return updateOption(name, value);
}

/** Creates or changes an option. Fires WordPress's update_option hooks. Returns whether it was saved. */
export async function rwp_update_option(option: string, value: unknown): Promise<boolean> {
  const name = option.trim();
  if (!name) return false;
  return updateOption(name, value);
}

/** Removes an option. Fires rwp_delete_option, rwp_delete_option_{name}, rwp_deleted_option. */
export async function rwp_delete_option(option: string): Promise<boolean> {
  const name = option.trim();
  if (!name) return false;
  doAction('rwp_delete_option', name);
  const { data, error } = await client.from('options').delete().eq('option_name', name).select('option_name');
  if (error) throw error;
  const removed = Array.isArray(data) && data.length > 0;
  if (removed) {
    doAction(`rwp_delete_option_${name}`, name);
    doAction('rwp_deleted_option', name);
  }
  return removed;
}

// Transients ------------------------------------------------------------------------------------
// Not in the options table: that table is public, and a transient is a cache, often of something that
// should not be. They live in this browser's localStorage, so they are per-browser, never shared and
// never visible to anyone else. For a value that must be shared, use an option (public) or a table.

const TRANSIENT_PREFIX = 'rwp_transient:';

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The cached value, or false when it is missing or expired. */
export function rwp_get_transient<T = unknown>(transient: string): T | false {
  const pre = applyFilters<unknown>(`rwp_pre_transient_${transient}`, false, transient);
  if (pre !== false) return pre as T;
  const raw = storage()?.getItem(`${TRANSIENT_PREFIX}${transient}`);
  let value: unknown = false;
  if (raw) {
    try {
      const entry = JSON.parse(raw) as { v: unknown; e: number };
      if (entry.e === 0 || entry.e > Date.now()) value = entry.v;
      else storage()?.removeItem(`${TRANSIENT_PREFIX}${transient}`);
    } catch {
      storage()?.removeItem(`${TRANSIENT_PREFIX}${transient}`);
    }
  }
  return applyFilters<T | false>(`rwp_transient_${transient}`, value as T | false, transient);
}

/** Caches a value for `expiration` seconds (0 = until it is deleted). Returns whether it was stored. */
export function rwp_set_transient(transient: string, value: unknown, expiration = 0): boolean {
  const filtered = applyFilters<unknown>(`rwp_pre_set_transient_${transient}`, value, expiration, transient);
  const lifetime = applyFilters<number>(`rwp_expiration_of_transient_${transient}`, expiration, filtered, transient);
  try {
    storage()?.setItem(`${TRANSIENT_PREFIX}${transient}`, JSON.stringify({ v: filtered, e: lifetime > 0 ? Date.now() + lifetime * 1000 : 0 }));
  } catch {
    return false;
  }
  doAction(`rwp_set_transient_${transient}`, filtered, lifetime, transient);
  doAction('rwp_set_transient', transient, filtered, lifetime);
  return true;
}

/** Removes a cached value. */
export function rwp_delete_transient(transient: string): boolean {
  const had = storage()?.getItem(`${TRANSIENT_PREFIX}${transient}`) != null;
  doAction(`rwp_delete_transient_${transient}`, transient);
  storage()?.removeItem(`${TRANSIENT_PREFIX}${transient}`);
  if (had) doAction('rwp_deleted_transient', transient);
  return had;
}

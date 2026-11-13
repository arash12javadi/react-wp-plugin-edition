/**
 * Site, network, user and theme options (get_site_option, get_user_option, get_theme_mod ...).
 *
 * React-WP is one site per project, so a "site option" and a "network option" are the ordinary option:
 * the same public options table (see options.ts for what that means for secrets). A user option is a
 * user's meta (public only to that user and to list_users, see meta.ts). Theme mods are one option
 * (`theme_mods`) holding an object, so they are public too. User settings are per-browser interface
 * preferences kept in localStorage. Every database-backed function is async.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { rwp_add_option, rwp_delete_option, rwp_get_option, rwp_update_option, rwp_delete_transient, rwp_get_transient, rwp_set_transient } from './options';
import { rwp_delete_user_meta, rwp_get_user_meta, rwp_update_user_meta } from './meta';

// Site and network options -----------------------------------------------------------------------------

export const rwp_get_site_option = <T = unknown>(option: string, defaultValue: T | false = false) => rwp_get_option<T>(option, defaultValue);
export const rwp_add_site_option = (option: string, value: unknown) => rwp_add_option(option, value);
export const rwp_update_site_option = (option: string, value: unknown) => rwp_update_option(option, value);
export const rwp_delete_site_option = (option: string) => rwp_delete_option(option);
export const rwp_get_network_option = <T = unknown>(networkId: number | null, option: string, defaultValue: T | false = false) => rwp_get_option<T>(option, defaultValue);
export const rwp_add_network_option = (networkId: number | null, option: string, value: unknown) => rwp_add_option(option, value);
export const rwp_update_network_option = (networkId: number | null, option: string, value: unknown) => rwp_update_option(option, value);
export const rwp_delete_network_option = (networkId: number | null, option: string) => rwp_delete_option(option);

export const rwp_get_site_transient = <T = unknown>(transient: string) => rwp_get_transient<T>(transient);
export const rwp_set_site_transient = (transient: string, value: unknown, expiration = 0) => rwp_set_transient(transient, value, expiration);
export const rwp_delete_site_transient = (transient: string) => rwp_delete_transient(transient);

/** Several options at once: { name: value }. A missing option is false. */
export async function rwp_get_options(options: string[]): Promise<Record<string, unknown>> {
  const entries = await Promise.all(options.map(async (name) => [name, await rwp_get_option(name)] as const));
  return Object.fromEntries(entries);
}

/** WordPress's form_option: the option's value escaped for an attribute, returned as a string. */
export async function rwp_form_option(option: string): Promise<string> {
  const value = await rwp_get_option(option);
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

// User options -----------------------------------------------------------------------------------------

const userId = async (): Promise<string | null> => (await client.auth.getUser()).data.user?.id ?? null;

/** An option of the signed-in person (or of `user`), kept as user meta. */
export async function rwp_get_user_option(option: string, user: string | number = 0): Promise<unknown> {
  const id = user ? String(user) : await userId();
  if (!id) return false;
  const value = await rwp_get_user_meta(id, option, true);
  return applyFilters<unknown>(`rwp_get_user_option_${option}`, value === '' ? false : value, option, id);
}

export async function rwp_update_user_option(user: string | number, optionName: string, newValue: unknown): Promise<number | boolean> {
  return rwp_update_user_meta(user, optionName, newValue);
}

export async function rwp_delete_user_option(user: string | number, optionName: string): Promise<boolean> {
  return rwp_delete_user_meta(user, optionName);
}

// Theme mods -------------------------------------------------------------------------------------------------

const THEME_MODS = 'theme_mods';

async function mods(): Promise<Record<string, unknown>> {
  const stored = await rwp_get_option<Record<string, unknown>>(THEME_MODS, {});
  return stored && typeof stored === 'object' ? stored : {};
}

/** One theme setting, or `defaultValue`. */
export async function rwp_get_theme_mod<T = unknown>(name: string, defaultValue: T | false = false): Promise<T | false> {
  const all = await mods();
  const value = name in all ? (all[name] as T) : defaultValue;
  return applyFilters<T | false>(`rwp_theme_mod_${name}`, value);
}

export async function rwp_get_theme_mods(): Promise<Record<string, unknown>> {
  return mods();
}

export async function rwp_set_theme_mod(name: string, value: unknown): Promise<void> {
  const all = await mods();
  const next = applyFilters<unknown>(`rwp_pre_set_theme_mod_${name}`, value, all[name]);
  await rwp_update_option(THEME_MODS, { ...all, [name]: next });
}

export async function rwp_remove_theme_mod(name: string): Promise<void> {
  const all = { ...(await mods()) };
  delete all[name];
  await rwp_update_option(THEME_MODS, all);
}

export async function rwp_remove_theme_mods(): Promise<void> {
  await rwp_delete_option(THEME_MODS);
}

// User settings (interface preferences, per browser) ----------------------------------------------------------

const SETTINGS_KEY = 'rwp_user_settings';

const readSettings = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const writeSettings = (settings: Record<string, string>): boolean => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
};

export const rwp_get_user_setting = (name: string, defaultValue: string | false = false): string | false => readSettings()[name] ?? defaultValue;
export const rwp_set_user_setting = (name: string, value: string): boolean => writeSettings({ ...readSettings(), [name]: String(value) });
export function rwp_delete_user_setting(names: string | string[]): void {
  const settings = readSettings();
  for (const name of Array.isArray(names) ? names : names.split(',')) delete settings[name.trim()];
  writeSettings(settings);
}
export const rwp_get_all_user_settings = (): Record<string, string> => readSettings();
export const rwp_set_all_user_settings = (settings: Record<string, string>): boolean => writeSettings(settings);
export const rwp_delete_all_user_settings = (): void => { try { localStorage.removeItem(SETTINGS_KEY); } catch { /* storage unavailable */ } };

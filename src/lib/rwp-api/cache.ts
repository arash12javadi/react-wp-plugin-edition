/**
 * WordPress's object cache (wp_cache_get, wp_cache_set ...) as an in-memory cache.
 *
 * It lives in the page's memory and is gone on reload: a per-page-load cache, like WordPress's own
 * default object cache without a persistent backend. Groups keep keys apart; values are stored by
 * reference. `expire` is accepted and ignored (nothing outlives the page). For data that must survive a
 * reload use rwp_set_transient (per browser) or an option (public).
 */
const groups = new Map<string, Map<string, unknown>>();

const space = (group: string): Map<string, unknown> => {
  const name = group || 'default';
  let found = groups.get(name);
  if (!found) { found = new Map(); groups.set(name, found); }
  return found;
};

const cacheKey = (key: string | number): string => String(key);

/** Whether the cache is initialised: always, here. */
export function rwp_cache_init(): void {
  // Nothing to set up: the cache is created on first use.
}

export function rwp_cache_add(key: string | number, data: unknown, group = '', expire = 0): boolean {
  void expire;
  const bucket = space(group);
  if (bucket.has(cacheKey(key))) return false;
  bucket.set(cacheKey(key), data);
  return true;
}

export function rwp_cache_set(key: string | number, data: unknown, group = '', expire = 0): boolean {
  void expire;
  space(group).set(cacheKey(key), data);
  return true;
}

export function rwp_cache_replace(key: string | number, data: unknown, group = '', expire = 0): boolean {
  void expire;
  const bucket = space(group);
  if (!bucket.has(cacheKey(key))) return false;
  bucket.set(cacheKey(key), data);
  return true;
}

/** The cached value, or false. `found` receives whether the key existed. */
export function rwp_cache_get<T = unknown>(key: string | number, group = '', force = false, found: { value?: boolean } = {}): T | false {
  void force;
  const bucket = space(group);
  found.value = bucket.has(cacheKey(key));
  return found.value ? (bucket.get(cacheKey(key)) as T) : false;
}

export function rwp_cache_delete(key: string | number, group = ''): boolean {
  return space(group).delete(cacheKey(key));
}

export function rwp_cache_incr(key: string | number, offset = 1, group = ''): number | false {
  const bucket = space(group);
  const current = bucket.get(cacheKey(key));
  if (typeof current !== 'number') return false;
  const next = Math.max(0, current + offset);
  bucket.set(cacheKey(key), next);
  return next;
}

export function rwp_cache_decr(key: string | number, offset = 1, group = ''): number | false {
  return rwp_cache_incr(key, -offset, group);
}

export function rwp_cache_add_multiple(data: Record<string, unknown>, group = '', expire = 0): Record<string, boolean> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, rwp_cache_add(key, value, group, expire)]));
}

export function rwp_cache_set_multiple(data: Record<string, unknown>, group = '', expire = 0): Record<string, boolean> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, rwp_cache_set(key, value, group, expire)]));
}

export function rwp_cache_get_multiple(keys: Array<string | number>, group = '', force = false): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [String(key), rwp_cache_get(key, group, force)]));
}

export function rwp_cache_delete_multiple(keys: Array<string | number>, group = ''): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [String(key), rwp_cache_delete(key, group)]));
}

/** Empties the whole cache. */
export function rwp_cache_flush(): boolean {
  groups.clear();
  return true;
}

export const rwp_cache_flush_runtime = rwp_cache_flush;

/** Empties one group. */
export function rwp_cache_flush_group(group: string): boolean {
  groups.delete(group || 'default');
  return true;
}

// WordPress groups can be declared global or non-persistent; with one in-memory cache both are no-ops.
export function rwp_cache_add_global_groups(names: string | string[]): void {
  void names;
}

export function rwp_cache_add_non_persistent_groups(names: string | string[]): void {
  void names;
}

export function rwp_cache_close(): boolean {
  return true;
}

export function rwp_cache_switch_to_blog(blogId: number): void {
  void blogId;
}

/** Whether the cache supports a feature: all of the multiple-key and group operations do. */
export function rwp_cache_supports(feature: string): boolean {
  return ['add_multiple', 'set_multiple', 'get_multiple', 'delete_multiple', 'flush_runtime', 'flush_group'].includes(feature);
}

// "Salted" keys: the value is stored with the salt it was made with and ignored when the salt changed.
const saltOf = (salt: string | string[]): string => (Array.isArray(salt) ? salt.join(':') : salt);

export function rwp_cache_set_salted(key: string | number, data: unknown, group = '', expire = 0, salt: string | string[] = ''): boolean {
  return rwp_cache_set(key, { data, salt: saltOf(salt) }, group, expire);
}

export function rwp_cache_get_salted<T = unknown>(key: string | number, group = '', salt: string | string[] = ''): T | false {
  const entry = rwp_cache_get<{ data: T; salt: string }>(key, group);
  return entry && entry.salt === saltOf(salt) ? entry.data : false;
}

export function rwp_cache_set_multiple_salted(data: Record<string, unknown>, group = '', salt: string | string[] = '', expire = 0): Record<string, boolean> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, rwp_cache_set_salted(key, value, group, expire, salt)]));
}

export function rwp_cache_get_multiple_salted(keys: Array<string | number>, group = '', salt: string | string[] = ''): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [String(key), rwp_cache_get_salted(key, group, salt)]));
}

/**
 * WordPress's metadata API (wp-includes/meta.php) over public.rwp_meta.
 *
 *   get_post_meta( $id, 'color', true )   ->   await rwp_get_post_meta(id, 'color', true)
 *
 * One table holds post, user, term and comment meta, keyed by (object_type, object_id, meta_key). A
 * value is JSON, so a number, a list or an object is stored as it is, without serialising. A key may
 * repeat, as in WordPress. Every function is async.
 *
 * SECURITY: who may read or write is decided by row level security (supabase/schema.sql), not here.
 * A key that starts with an underscore is protected: only someone who may change the object can read
 * it. Every other key is as public as the object it belongs to (a published post's meta is readable by
 * visitors). Never store a secret in meta.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client } from '../db';

export type MetaType = 'post' | 'user' | 'term' | 'comment';

const TYPES: readonly MetaType[] = ['post', 'user', 'term', 'comment'];

interface MetaRow {
  id: number;
  object_type: MetaType;
  object_id: string;
  meta_key: string;
  meta_value: unknown;
}

// Registered meta keys ---------------------------------------------------------------------------

export interface RegisterMetaArgs {
  type?: 'string' | 'boolean' | 'integer' | 'number' | 'array' | 'object';
  description?: string;
  single?: boolean;
  default?: unknown;
  /** Return the cleaned value. Runs before every write of this key. */
  sanitize_callback?: (value: unknown, key: string, objectType: string, objectSubtype: string) => unknown;
  /** Receives (allowed, key, objectId, userId, capability, caps); informational in React-WP, see rwp_user_can. */
  auth_callback?: (...args: unknown[]) => boolean;
  show_in_rest?: boolean | Record<string, unknown>;
  object_subtype?: string;
}

const registered = new Map<string, RegisterMetaArgs>(); // `${type}:${subtype}:${key}`

const registryKey = (type: string, key: string, subtype = '') => `${type}:${subtype}:${key}`;

/** Declares a meta key: its type, default and sanitiser. Returns false when the key is already registered. */
export function rwp_register_meta(objectType: MetaType, metaKey: string, args: RegisterMetaArgs = {}): boolean {
  const merged = applyFilters<RegisterMetaArgs>('rwp_register_meta_args', { type: 'string', single: false, ...args }, { type: 'string', single: false }, objectType, metaKey);
  const key = registryKey(objectType, metaKey, merged.object_subtype);
  if (registered.has(key)) return false;
  registered.set(key, merged);
  return true;
}

export function rwp_unregister_meta_key(objectType: MetaType, metaKey: string, objectSubtype = ''): boolean {
  return registered.delete(registryKey(objectType, metaKey, objectSubtype));
}

export function rwp_get_registered_meta_keys(objectType: MetaType, objectSubtype = ''): Record<string, RegisterMetaArgs> {
  const out: Record<string, RegisterMetaArgs> = {};
  for (const [key, args] of registered) {
    const [type, subtype, name] = key.split(':');
    if (type === objectType && subtype === objectSubtype) out[name] = args;
  }
  return out;
}

export function rwp_get_registered_metadata(objectType: MetaType, objectId: string | number, metaKey = ''): unknown {
  void objectId;
  const keys = rwp_get_registered_meta_keys(objectType);
  return metaKey ? keys[metaKey] ?? false : keys;
}

const registration = (type: string, key: string, subtype = ''): RegisterMetaArgs | undefined =>
  registered.get(registryKey(type, key, subtype)) ?? registered.get(registryKey(type, key, ''));

/** Whether a key is protected (starts with an underscore). `rwp_is_protected_meta` may change the answer. */
export function rwp_is_protected_meta(metaKey: string, metaType = ''): boolean {
  return applyFilters<boolean>('rwp_is_protected_meta', metaKey.startsWith('_'), metaKey, metaType);
}

const coerce = (value: unknown, type?: RegisterMetaArgs['type']): unknown => {
  switch (type) {
    case 'boolean': return value === true || value === 'true' || value === 1 || value === '1';
    case 'integer': return Math.trunc(Number(value)) || 0;
    case 'number': return Number(value) || 0;
    case 'string': return typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    default: return value;
  }
};

/** Cleans a value for storing: the registered type, then `rwp_sanitize_{type}_meta_{key}` and the key's sanitize_callback. */
export function rwp_sanitize_meta(metaKey: string, metaValue: unknown, objectType: string, objectSubtype = ''): unknown {
  const args = registration(objectType, metaKey, objectSubtype);
  let value = args ? coerce(metaValue, args.type) : metaValue;
  if (args?.sanitize_callback) value = args.sanitize_callback(value, metaKey, objectType, objectSubtype);
  value = applyFilters<unknown>(`rwp_sanitize_${objectType}_meta_${metaKey}`, value, metaKey, objectType, objectSubtype);
  if (objectSubtype) value = applyFilters<unknown>(`rwp_sanitize_${objectType}_meta_${metaKey}_for_${objectSubtype}`, value, metaKey, objectType, objectSubtype);
  return value;
}

// Core ------------------------------------------------------------------------------------------------

const validKey = (key: string): boolean => typeof key === 'string' && key.length > 0 && key.length <= 255;

const idOf = (id: number | string | { ID?: number | string; id?: number | string }): string => String(typeof id === 'object' ? (id.ID ?? id.id) : id);

async function fetchRows(type: MetaType, objectId: string, key = ''): Promise<MetaRow[]> {
  let request = client.from('rwp_meta').select('*').eq('object_type', type).eq('object_id', objectId).order('id');
  if (key) request = request.eq('meta_key', key);
  const { data, error } = await request;
  if (error) throw error;
  return (data || []) as MetaRow[];
}

/**
 * Reads meta. With a key: its values (an array, or the first value with `single`, '' when missing).
 * Without one: every key, as { key: [values] }. Filtered through `rwp_get_{type}_metadata`.
 */
export async function rwp_get_metadata(metaType: MetaType, objectId: number | string, metaKey = '', single = false): Promise<unknown> {
  const id = idOf(objectId);
  if (!TYPES.includes(metaType) || !id) return false;
  const pre = applyFilters<unknown>(`rwp_get_${metaType}_metadata`, null, id, metaKey, single, metaType);
  if (pre !== null) return single && Array.isArray(pre) ? pre[0] : pre;
  let rows: MetaRow[];
  try {
    rows = await fetchRows(metaType, id, metaKey);
  } catch {
    return single ? '' : [];
  }
  if (!metaKey) {
    const all: Record<string, unknown[]> = {};
    for (const row of rows) (all[row.meta_key] ||= []).push(row.meta_value);
    return all;
  }
  if (!rows.length) {
    const def = applyFilters<unknown>(`rwp_default_${metaType}_metadata`, single ? '' : [], id, metaKey, single, metaType);
    const registeredDefault = registration(metaType, metaKey)?.default;
    return registeredDefault !== undefined && single ? registeredDefault : def;
  }
  return single ? rows[0].meta_value : rows.map((row) => row.meta_value);
}

/** Whether the object has this key. */
export async function rwp_metadata_exists(metaType: MetaType, objectId: number | string, metaKey: string): Promise<boolean> {
  const rows = await fetchRows(metaType, idOf(objectId), metaKey).catch(() => []);
  return rows.length > 0;
}

/** Adds a meta row. With `unique`, does nothing and returns false when the key already exists. Returns the meta id. */
export async function rwp_add_metadata(metaType: MetaType, objectId: number | string, metaKey: string, metaValue: unknown, unique = false): Promise<number | false> {
  const id = idOf(objectId);
  if (!TYPES.includes(metaType) || !validKey(metaKey) || !id) return false;
  const key = metaKey.trim();
  const check = applyFilters<unknown>(`rwp_add_${metaType}_metadata`, null, id, key, metaValue, unique);
  if (check !== null) return check as number | false;
  if (unique && await rwp_metadata_exists(metaType, id, key)) return false;
  const value = rwp_sanitize_meta(key, metaValue, metaType);
  doAction(`rwp_add_${metaType}_meta`, id, key, value);
  const { data, error } = await client.from('rwp_meta').insert({ object_type: metaType, object_id: id, meta_key: key, meta_value: value }).select('id');
  const mid = (data as Array<{ id: number }> | null)?.[0]?.id;
  if (error || mid === undefined) return false;
  doAction(`rwp_added_${metaType}_meta`, mid, id, key, value);
  if (metaType === 'user') doAction('rwp_added_usermeta', mid, id, key, value);
  return mid;
}

/** Changes the value of a key (all its rows, or only the one equal to `prevValue`); adds it when missing. Returns true, or the new meta id. */
export async function rwp_update_metadata(metaType: MetaType, objectId: number | string, metaKey: string, metaValue: unknown, prevValue: unknown = ''): Promise<number | boolean> {
  const id = idOf(objectId);
  if (!TYPES.includes(metaType) || !validKey(metaKey) || !id) return false;
  const key = metaKey.trim();
  const check = applyFilters<unknown>(`rwp_update_${metaType}_metadata`, null, id, key, metaValue, prevValue);
  if (check !== null) return Boolean(check);
  const existing = await fetchRows(metaType, id, key).catch(() => []);
  if (!existing.length) return rwp_add_metadata(metaType, id, key, metaValue);
  const targets = prevValue === '' ? existing : existing.filter((row) => JSON.stringify(row.meta_value) === JSON.stringify(prevValue));
  if (!targets.length) return false;
  const value = rwp_sanitize_meta(key, metaValue, metaType);
  if (prevValue === '' && existing.length === 1 && JSON.stringify(existing[0].meta_value) === JSON.stringify(value)) return false;
  for (const row of targets) {
    doAction(`rwp_update_${metaType}_meta`, row.id, id, key, value);
    if (metaType === 'post') doAction('rwp_update_postmeta', row.id, id, key, value);
    if (metaType === 'user') doAction('rwp_update_usermeta', row.id, id, key, value);
  }
  const { data, error } = await client.from('rwp_meta').update({ meta_value: value, updated_at: new Date().toISOString() }).in('id', targets.map((row) => row.id)).select('id');
  if (error || !(data as unknown[] | null)?.length) return false;
  for (const row of targets) {
    doAction(`rwp_updated_${metaType}_meta`, row.id, id, key, value);
    if (metaType === 'post') doAction('rwp_updated_postmeta', row.id, id, key, value);
    if (metaType === 'user') doAction('rwp_updated_usermeta', row.id, id, key, value);
  }
  return true;
}

/** Removes a key (every row, or only those equal to `metaValue`; `deleteAll` ignores the object). */
export async function rwp_delete_metadata(metaType: MetaType, objectId: number | string, metaKey: string, metaValue: unknown = '', deleteAll = false): Promise<boolean> {
  const id = idOf(objectId);
  if (!TYPES.includes(metaType) || !validKey(metaKey) || (!id && !deleteAll)) return false;
  const key = metaKey.trim();
  const check = applyFilters<unknown>(`rwp_delete_${metaType}_metadata`, null, id, key, metaValue, deleteAll);
  if (check !== null) return Boolean(check);
  let request = client.from('rwp_meta').select('*').eq('object_type', metaType).eq('meta_key', key);
  if (!deleteAll) request = request.eq('object_id', id);
  const { data: found } = await request;
  let rows = (found || []) as MetaRow[];
  if (metaValue !== '') rows = rows.filter((row) => JSON.stringify(row.meta_value) === JSON.stringify(metaValue));
  if (!rows.length) return false;
  const ids = rows.map((row) => row.id);
  doAction(`rwp_delete_${metaType}_meta`, ids, id, key, metaValue);
  if (metaType === 'post') doAction('rwp_delete_postmeta', ids);
  if (metaType === 'user') doAction('rwp_delete_usermeta', ids);
  const { data, error } = await client.from('rwp_meta').delete().in('id', ids).select('id');
  if (error || !(data as unknown[] | null)?.length) return false;
  doAction(`rwp_deleted_${metaType}_meta`, ids, id, key, metaValue);
  if (metaType === 'post') doAction('rwp_deleted_postmeta', ids);
  if (metaType === 'user') doAction('rwp_deleted_usermeta', ids);
  return true;
}

/** One meta row by its meta id (WordPress's get_metadata_by_mid). */
export async function rwp_get_metadata_by_mid(metaType: MetaType, metaId: number): Promise<MetaRow | false> {
  const { data } = await client.from('rwp_meta').select('*').eq('object_type', metaType).eq('id', metaId).maybeSingle();
  return (data as MetaRow | null) ?? false;
}

export async function rwp_update_metadata_by_mid(metaType: MetaType, metaId: number, metaValue: unknown, metaKey: string | false = false): Promise<boolean> {
  const row = await rwp_get_metadata_by_mid(metaType, metaId);
  if (!row) return false;
  const key = metaKey || row.meta_key;
  const { data, error } = await client.from('rwp_meta').update({ meta_key: key, meta_value: rwp_sanitize_meta(key, metaValue, metaType), updated_at: new Date().toISOString() }).eq('id', metaId).select('id');
  return !error && Boolean((data as unknown[] | null)?.length);
}

export async function rwp_delete_metadata_by_mid(metaType: MetaType, metaId: number): Promise<boolean> {
  const { data, error } = await client.from('rwp_meta').delete().eq('object_type', metaType).eq('id', metaId).select('id');
  return !error && Boolean((data as unknown[] | null)?.length);
}

// The four families -------------------------------------------------------------------------------------

type Id = number | string | { ID?: number | string; id?: number | string };

export const rwp_get_post_meta = (postId: Id, key = '', single = false) => rwp_get_metadata('post', idOf(postId), key, single);
export const rwp_add_post_meta = (postId: Id, key: string, value: unknown, unique = false) => rwp_add_metadata('post', idOf(postId), key, value, unique);
export const rwp_update_post_meta = (postId: Id, key: string, value: unknown, prev: unknown = '') => rwp_update_metadata('post', idOf(postId), key, value, prev);
export const rwp_delete_post_meta = (postId: Id, key: string, value: unknown = '') => rwp_delete_metadata('post', idOf(postId), key, value);
/** Removes a key from every post. */
export const rwp_delete_post_meta_by_key = (key: string) => rwp_delete_metadata('post', '', key, '', true);

export const rwp_get_user_meta = (userId: Id, key = '', single = false) => rwp_get_metadata('user', idOf(userId), key, single);
export const rwp_add_user_meta = (userId: Id, key: string, value: unknown, unique = false) => rwp_add_metadata('user', idOf(userId), key, value, unique);
export const rwp_update_user_meta = (userId: Id, key: string, value: unknown, prev: unknown = '') => rwp_update_metadata('user', idOf(userId), key, value, prev);
export const rwp_delete_user_meta = (userId: Id, key: string, value: unknown = '') => rwp_delete_metadata('user', idOf(userId), key, value);

export const rwp_get_term_meta = (termId: Id, key = '', single = false) => rwp_get_metadata('term', idOf(termId), key, single);
export const rwp_add_term_meta = (termId: Id, key: string, value: unknown, unique = false) => rwp_add_metadata('term', idOf(termId), key, value, unique);
export const rwp_update_term_meta = (termId: Id, key: string, value: unknown, prev: unknown = '') => rwp_update_metadata('term', idOf(termId), key, value, prev);
export const rwp_delete_term_meta = (termId: Id, key: string, value: unknown = '') => rwp_delete_metadata('term', idOf(termId), key, value);

export const rwp_get_comment_meta = (commentId: Id, key = '', single = false) => rwp_get_metadata('comment', idOf(commentId), key, single);
export const rwp_add_comment_meta = (commentId: Id, key: string, value: unknown, unique = false) => rwp_add_metadata('comment', idOf(commentId), key, value, unique);
export const rwp_update_comment_meta = (commentId: Id, key: string, value: unknown, prev: unknown = '') => rwp_update_metadata('comment', idOf(commentId), key, value, prev);
export const rwp_delete_comment_meta = (commentId: Id, key: string, value: unknown = '') => rwp_delete_metadata('comment', idOf(commentId), key, value);

/** Every meta key of a post with its values: { key: [values] }, protected keys included for those who may read them. */
export async function rwp_get_post_custom(postId: Id): Promise<Record<string, unknown[]>> {
  return (await rwp_get_metadata('post', idOf(postId))) as Record<string, unknown[]>;
}

/** The meta keys of a post. */
export async function rwp_get_post_custom_keys(postId: Id): Promise<string[] | undefined> {
  const keys = Object.keys(await rwp_get_post_custom(postId));
  return keys.length ? keys : undefined;
}

/** The values of one meta key of a post. */
export async function rwp_get_post_custom_values(key: string, postId: Id): Promise<unknown[] | null> {
  const values = (await rwp_get_post_custom(postId))[key];
  return values?.length ? values : null;
}


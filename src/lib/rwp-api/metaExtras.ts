/** The remaining metadata helpers that are not SQL: lookups of registration and subtype. */
import { applyFilters } from '../../core/hooks';
import { rwp_get_metadata, rwp_get_registered_meta_keys, type MetaType } from './meta';

/** Whether a meta key was registered with rwp_register_meta. */
export function rwp_registered_meta_key_exists(objectType: MetaType, metaKey: string, objectSubtype = ''): boolean {
  return metaKey in rwp_get_registered_meta_keys(objectType, objectSubtype);
}

/** The subtype of an object: a post's type; a term's taxonomy is looked up by the caller. */
export function rwp_get_object_subtype(objectType: MetaType, objectId: number | string, subtype = ''): string {
  return applyFilters<string>(`rwp_get_object_subtype_${objectType}`, subtype, objectId);
}

/** Meta without the `rwp_get_{type}_metadata` filter short-circuit; the stored value or false. */
export async function rwp_get_metadata_raw(metaType: MetaType, objectId: number | string, metaKey = '', single = false): Promise<unknown> {
  return rwp_get_metadata(metaType, objectId, metaKey, single);
}

/** A key's default when it has none: false, or the registered default. */
export async function rwp_get_metadata_default(metaType: MetaType, objectId: number | string, metaKey: string, single = false): Promise<unknown> {
  const value = await rwp_get_metadata(metaType, objectId, metaKey, single);
  return value === '' || (Array.isArray(value) && !value.length) ? false : value;
}

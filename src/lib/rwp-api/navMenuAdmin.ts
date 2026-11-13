/**
 * Creating and editing navigation menus (wp_create_nav_menu, wp_update_nav_menu_item ...) over
 * public.menus. Who may write is decided by row level security (manage_options). A refused write is
 * reported as an RWP_Error, not skipped.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client } from '../db';
import { RWP_Error } from './errors';
import { rwp_sanitize_title, rwp_strip_all_tags } from './formatting';
import { rwp_get_nav_menu_locations, rwp_get_nav_menu_object, rwp_get_nav_menus } from './navMenus';

interface StoredItem { id: string; label: string; url: string; type: string; depth?: number }

/** Whether a menu is assigned to a location. */
export async function rwp_has_nav_menu(location: string): Promise<boolean> {
  return Boolean((await rwp_get_nav_menu_locations())[location]);
}

/** Whether a value is a menu (id, slug or name). */
export async function rwp_is_nav_menu(menu: string | number): Promise<boolean> {
  return Boolean(await rwp_get_nav_menu_object(menu));
}

/** The name of the menu assigned to a location, or ''. */
export async function rwp_get_nav_menu_name(location: string): Promise<string> {
  const id = (await rwp_get_nav_menu_locations())[location];
  const menu = id ? await rwp_get_nav_menu_object(id) : false;
  return menu ? menu.name : '';
}

/** Creates a menu. Returns its id, or an RWP_Error. */
export async function rwp_create_nav_menu(menuName: string): Promise<string | number | RWP_Error> {
  const name = rwp_strip_all_tags(menuName).trim();
  if (!name) return new RWP_Error('menu_name', 'Menu name should not be empty.');
  const slug = rwp_sanitize_title(name);
  if ((await rwp_get_nav_menus()).some((menu) => menu.slug === slug || menu.name === name)) return new RWP_Error('menu_exists', `The menu name “${name}” conflicts with another menu name.`);
  const { data, error } = await client.from('menus').insert({ name, slug, location: '', items: [] }).select('id');
  const id = (data as Array<{ id: string | number }> | null)?.[0]?.id;
  if (error || id === undefined) return new RWP_Error('db_insert_error', error?.message ?? 'The database did not save the menu. Managing menus needs manage_options.');
  doAction('rwp_create_nav_menu', id, { menu_name: name });
  return id;
}

/** Renames a menu or changes its location. Returns the id, or an RWP_Error. */
export async function rwp_update_nav_menu_object(menuId: string | number, menuData: { 'menu-name'?: string; location?: string } = {}): Promise<string | number | RWP_Error> {
  const changes: Record<string, unknown> = {};
  if (menuData['menu-name']) { changes.name = rwp_strip_all_tags(menuData['menu-name']).trim(); changes.slug = rwp_sanitize_title(String(changes.name)); }
  if (menuData.location !== undefined) changes.location = menuData.location;
  const { data, error } = await client.from('menus').update(changes).eq('id', menuId).select('id');
  if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_update_error', error?.message ?? 'The database skipped this menu.');
  doAction('rwp_update_nav_menu', menuId, menuData);
  return menuId;
}

/** Deletes a menu. Returns true, false when it does not exist, or an RWP_Error. */
export async function rwp_delete_nav_menu(menu: string | number): Promise<boolean | RWP_Error> {
  const object = await rwp_get_nav_menu_object(menu);
  if (!object) return false;
  const { data, error } = await client.from('menus').delete().eq('id', object.id).select('id');
  if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_delete_error', error?.message ?? 'The database skipped this menu.');
  doAction('rwp_delete_nav_menu', object.id);
  return true;
}

/** Adds an item to a menu (menuItemId 0), or changes one. Returns the item id, or an RWP_Error. */
export async function rwp_update_nav_menu_item(menuId: string | number, menuItemDbId: string | number = 0, args: { 'menu-item-title'?: string; 'menu-item-url'?: string; 'menu-item-parent-id'?: string | number; 'menu-item-type'?: string } = {}): Promise<string | RWP_Error> {
  const { data } = await client.from('menus').select('items').eq('id', menuId).maybeSingle();
  if (!data) return new RWP_Error('invalid_menu_id', 'Invalid menu ID.');
  const items = ((data as { items?: StoredItem[] }).items ?? []).slice();
  const existing = items.findIndex((item) => String(item.id) === String(menuItemDbId));
  const title = rwp_strip_all_tags(args['menu-item-title'] ?? (existing >= 0 ? items[existing].label : '')).trim();
  const url = args['menu-item-url'] ?? (existing >= 0 ? items[existing].url : '');
  const depth = Number(args['menu-item-parent-id'] ?? 0) > 0 ? 1 : (existing >= 0 ? items[existing].depth ?? 0 : 0);
  const item: StoredItem = { id: existing >= 0 ? items[existing].id : `item-${Date.now().toString(36)}`, label: title, url, type: args['menu-item-type'] ?? 'custom', depth };
  const filtered = applyFilters<StoredItem>('rwp_nav_menu_item_args', item, menuId);
  if (existing >= 0) items[existing] = filtered; else items.push(filtered);
  const { data: saved, error } = await client.from('menus').update({ items }).eq('id', menuId).select('id');
  if (error || !(saved as unknown[] | null)?.length) return new RWP_Error('db_update_error', error?.message ?? 'The database skipped this menu.');
  doAction('rwp_update_nav_menu_item', menuId, filtered.id, args);
  return filtered.id;
}

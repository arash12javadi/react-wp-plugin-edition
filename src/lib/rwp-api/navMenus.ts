/**
 * WordPress's navigation menu functions over public.menus (Appearance → Menus).
 *
 * A menu row is { id, name, slug, location, items }, where items is a flat list with a `depth` (0 top
 * level, 1 a child of the item above). Menu items come back in WordPress's shape (`ID`, `title`, `url`,
 * `menu_order`, `menu_item_parent`, `classes`, `type`). `rwp_nav_menu()` returns the menu as an HTML
 * string (WordPress echoes it). Every function is async.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { rwp_esc_attr, rwp_esc_html, rwp_esc_url } from './formatting';

interface MenuRow {
  id: string | number;
  name: string;
  slug: string;
  location?: string | null;
  items?: Array<{ id?: string; label: string; url: string; type?: string; depth?: number }> | null;
}

export interface RWP_Nav_Menu {
  term_id: string | number;
  id: string | number;
  name: string;
  slug: string;
  location: string;
  count: number;
}

export interface RWP_Nav_Menu_Item {
  ID: string;
  title: string;
  url: string;
  menu_order: number;
  menu_item_parent: string;
  type: string;
  classes: string[];
  object_id: string;
}

const toMenu = (row: MenuRow): RWP_Nav_Menu => ({ term_id: row.id, id: row.id, name: row.name, slug: row.slug, location: row.location ?? '', count: row.items?.length ?? 0 });

/** Every menu. Filtered through `rwp_get_nav_menus`. */
export async function rwp_get_nav_menus(args: { orderby?: string } = {}): Promise<RWP_Nav_Menu[]> {
  void args;
  const { data } = await client.from('menus').select('id,name,slug,location,items').order('name');
  return applyFilters<RWP_Nav_Menu[]>('rwp_get_nav_menus', ((data || []) as MenuRow[]).map(toMenu), args);
}

/** One menu by id, slug or name, or false. */
export async function rwp_get_nav_menu_object(menu: string | number): Promise<RWP_Nav_Menu | false> {
  const all = await rwp_get_nav_menus();
  const key = String(menu);
  const found = all.find((item) => String(item.id) === key || item.slug === key || item.name === key);
  return applyFilters<RWP_Nav_Menu | false>('rwp_get_nav_menu_object', found ?? false, menu);
}

/** { location: menu id }: which menu each location uses. */
export async function rwp_get_nav_menu_locations(): Promise<Record<string, string | number>> {
  const menus = await rwp_get_nav_menus();
  return Object.fromEntries(menus.filter((menu) => menu.location).map((menu) => [menu.location, menu.id]));
}

/** The items of a menu (id, slug or name). Filtered through `rwp_get_nav_menu_items`. */
export async function rwp_get_nav_menu_items(menu: string | number, args: Record<string, unknown> = {}): Promise<RWP_Nav_Menu_Item[] | false> {
  const object = await rwp_get_nav_menu_object(menu);
  if (!object) return false;
  const { data } = await client.from('menus').select('items').eq('id', object.id).maybeSingle();
  const raw = ((data as { items?: MenuRow['items'] } | null)?.items ?? []);
  let parent = '0';
  const items = raw.map((item, index): RWP_Nav_Menu_Item => {
    const id = String(item.id ?? index + 1);
    const depth = item.depth ?? 0;
    const own: RWP_Nav_Menu_Item = { ID: id, title: item.label, url: item.url, menu_order: index + 1, menu_item_parent: depth > 0 ? parent : '0', type: item.type ?? 'custom', classes: [], object_id: id };
    if (depth === 0) parent = id;
    return own;
  });
  return applyFilters<RWP_Nav_Menu_Item[]>('rwp_get_nav_menu_items', items, object, args);
}

export interface NavMenuArgs {
  menu?: string | number;
  theme_location?: string;
  container?: string | false;
  container_class?: string;
  menu_class?: string;
  menu_id?: string;
  before?: string;
  after?: string;
  link_before?: string;
  link_after?: string;
  fallback_cb?: (() => string) | false;
  items_wrap?: string;
}

/** A menu as an HTML string: <nav><ul><li><a>... Items are escaped. Returns '' (or the fallback) when there is no menu. */
export async function rwp_nav_menu(args: NavMenuArgs = {}): Promise<string> {
  const a = applyFilters<NavMenuArgs>('rwp_nav_menu_args', { container: 'div', menu_class: 'menu', items_wrap: '<ul id="%1$s" class="%2$s">%3$s</ul>', ...args });
  const pre = applyFilters<string | null>('rwp_pre_wp_nav_menu', null, a);
  if (pre !== null) return pre;
  let key: string | number | undefined = a.menu;
  if (!key && a.theme_location) key = (await rwp_get_nav_menu_locations())[a.theme_location];
  const items = key ? await rwp_get_nav_menu_items(key) : false;
  if (!items) return a.fallback_cb ? a.fallback_cb() : '';
  const filtered = applyFilters<RWP_Nav_Menu_Item[]>('rwp_nav_menu_objects', items, a);
  const render = (parentId: string): string => filtered
    .filter((item) => item.menu_item_parent === parentId)
    .map((item) => {
      const children = render(item.ID);
      const link = `<a href="${rwp_esc_attr(rwp_esc_url(item.url))}">${a.link_before ?? ''}${rwp_esc_html(item.title)}${a.link_after ?? ''}</a>`;
      return `<li id="menu-item-${rwp_esc_attr(item.ID)}" class="menu-item${children ? ' menu-item-has-children' : ''}">${a.before ?? ''}${link}${a.after ?? ''}${children ? `<ul class="sub-menu">${children}</ul>` : ''}</li>`;
    })
    .join('');
  const list = render('0');
  const withItems = applyFilters<string>('rwp_nav_menu_items', list, a);
  const wrapped = (a.items_wrap ?? '<ul>%3$s</ul>').replace('%1$s', rwp_esc_attr(a.menu_id ?? '')).replace('%2$s', rwp_esc_attr(a.menu_class ?? 'menu')).replace('%3$s', withItems);
  // The container is a tag name from the caller; anything else than letters and digits is not a tag name.
  const container = a.container && /^[a-z][a-z0-9]*$/i.test(a.container) ? a.container : a.container ? 'div' : false;
  const html = container ? `<${container}${a.container_class ? ` class="${rwp_esc_attr(a.container_class)}"` : ''}>${wrapped}</${container}>` : wrapped;
  return applyFilters<string>('rwp_nav_menu', html, a);
}

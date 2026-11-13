/**
 * WordPress's admin menu functions over the admin page registry.
 *
 *   add_menu_page( $page_title, $menu_title, $capability, $menu_slug, $callback, $icon_url, $position )
 *   add_submenu_page( $parent_slug, $page_title, $menu_title, $capability, $menu_slug, $callback )
 *
 * `callback` is a React component (WordPress's is a function that prints). It receives
 * `{ subsection, navigate }`. Every `rwp_add_*_page` helper (options, tools, media, ...) puts the page
 * in the admin sidebar like add_menu_page does: React-WP's sidebar is one list, not WordPress's fixed
 * groups. `icon_url` is an emoji. A capability name React-WP does not define hides the page from
 * everyone but administrators, which is the safe direction.
 *
 * The page is shown to people with the capability; the data behind it is protected by the database.
 */
import type { ComponentType } from 'react';
import { rwp, type RwpAdminPageProps } from '../rwp';

type AdminCallback = ComponentType<RwpAdminPageProps>;

interface SubPage {
  id: string;
  label: string;
  capability: string;
  component: AdminCallback;
}

interface TopPage {
  slug: string;
  label: string;
  capability: string;
  icon: string;
  component: AdminCallback;
  position: number | null;
  subs: SubPage[];
  remove: () => void;
}

const pages = new Map<string, TopPage>();

const asCapability = (capability: string): string => capability || 'manage_options';

function publish(page: TopPage): void {
  page.remove();
  const subs = page.subs;
  const Parent = page.component;
  const Component: AdminCallback = (props) => {
    const sub = subs.find((item) => item.id === props.subsection);
    const Selected = sub ? sub.component : Parent;
    return <Selected {...props} />;
  };
  page.remove = rwp.admin.registerPage({
    id: page.slug,
    label: page.label,
    icon: page.icon || '🔌',
    capability: asCapability(page.capability) as never,
    submenu: subs.length ? [{ id: '', label: page.label }, ...subs.map((sub) => ({ id: sub.id, label: sub.label, capability: asCapability(sub.capability) as never }))] : undefined,
    component: Component,
  });
}

/** Adds a top-level admin screen. Returns the slug. */
export function rwp_add_menu_page(
  pageTitle: string,
  menuTitle: string,
  capability: string,
  menuSlug: string,
  callback: AdminCallback,
  iconUrl = '',
  position: number | null = null,
): string {
  void pageTitle;
  const existing = pages.get(menuSlug);
  existing?.remove();
  const page: TopPage = {
    slug: menuSlug,
    label: menuTitle,
    capability,
    icon: /^[^\w/.]/u.test(iconUrl) ? iconUrl : '',
    component: callback,
    position,
    subs: existing?.subs ?? [],
    remove: () => undefined,
  };
  pages.set(menuSlug, page);
  publish(page);
  return menuSlug;
}

/**
 * Adds an item under a screen made with rwp_add_menu_page. If the parent does not exist (a WordPress
 * core slug such as "options-general.php", which React-WP has no counterpart of), the item becomes a
 * top-level screen of its own. Returns the slug.
 */
export function rwp_add_submenu_page(
  parentSlug: string,
  pageTitle: string,
  menuTitle: string,
  capability: string,
  menuSlug: string,
  callback: AdminCallback,
): string {
  const parent = pages.get(parentSlug);
  if (!parent) return rwp_add_menu_page(pageTitle, menuTitle, capability, menuSlug, callback);
  parent.subs = [...parent.subs.filter((sub) => sub.id !== menuSlug), { id: menuSlug, label: menuTitle, capability, component: callback }];
  publish(parent);
  return menuSlug;
}

const addTo = (pageTitle: string, menuTitle: string, capability: string, menuSlug: string, callback: AdminCallback): string =>
  rwp_add_menu_page(pageTitle, menuTitle, capability, menuSlug, callback);

export const rwp_add_options_page = addTo;
export const rwp_add_management_page = addTo;
export const rwp_add_dashboard_page = addTo;
export const rwp_add_posts_page = addTo;
export const rwp_add_media_page = addTo;
export const rwp_add_pages_page = addTo;
export const rwp_add_comments_page = addTo;
export const rwp_add_theme_page = addTo;
export const rwp_add_plugins_page = addTo;
export const rwp_add_users_page = addTo;
export const rwp_add_links_page = addTo;

/** Removes a screen added with rwp_add_menu_page. */
export function rwp_remove_menu_page(menuSlug: string): boolean {
  const page = pages.get(menuSlug);
  if (!page) return false;
  page.remove();
  pages.delete(menuSlug);
  return true;
}

/** Removes one item added with rwp_add_submenu_page. */
export function rwp_remove_submenu_page(menuSlug: string, submenuSlug: string): boolean {
  const parent = pages.get(menuSlug);
  if (!parent || !parent.subs.some((sub) => sub.id === submenuSlug)) return false;
  parent.subs = parent.subs.filter((sub) => sub.id !== submenuSlug);
  publish(parent);
  return true;
}

/** The address of a screen added with rwp_add_menu_page. */
export function rwp_menu_page_url(menuSlug: string): string {
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  return `${base}/admin?section=${encodeURIComponent(menuSlug)}`;
}

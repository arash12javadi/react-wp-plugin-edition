/**
 * "The main query": what the visitor is looking at now, so WordPress's conditional tags work.
 *
 * WordPress builds a global query for every request and `is_single()` reads it. React-WP renders by
 * component, so the component that knows what is on screen (a page, the home screen, an archive, a
 * search, a 404) announces it with `rwp_set_queried_object`, and the conditionals read it back. The
 * public screens in this repository already do; a plugin that renders its own public route announces
 * its own view the same way.
 *
 *   rwp_set_queried_object({ kind: 'single', post })    a blog post
 *   rwp_set_queried_object({ kind: 'page', post })      a static page
 *   rwp_set_queried_object({ kind: 'home' })            the front page / blog index
 *   rwp_set_queried_object({ kind: 'archive', taxonomy: 'category', term: 'news' })
 *   rwp_set_queried_object({ kind: 'search', search: 'hello' })
 *   rwp_set_queried_object({ kind: '404' })
 */
import { applyFilters, doAction } from '../../core/hooks';

export type QueriedKind = 'single' | 'page' | 'home' | 'archive' | 'search' | '404' | 'other';

export interface QueriedObject {
  kind: QueriedKind;
  /** The post or page being shown, in WordPress's shape (see rwp_post_from_row). */
  post?: { ID?: number; id?: number; post_type?: string; post_name?: string; post_title?: string; [key: string]: unknown } | null;
  taxonomy?: string;
  term?: string;
  search?: string;
}

let current: QueriedObject = { kind: 'other' };

/** Announces what is on screen. Fires rwp_the_post when a post or page is set. */
export function rwp_set_queried_object(next: QueriedObject): void {
  current = next;
  if (next.post) doAction('rwp_the_post', next.post, current);
}

export function rwp_get_queried_object(): QueriedObject {
  return current;
}

/** The id of the post or page on screen, or 0. */
export function rwp_get_queried_object_id(): number {
  return Number(current.post?.ID ?? current.post?.id ?? 0);
}

/** WordPress's get_the_ID(): the post being shown, or false. */
export function rwp_get_the_ID(): number | false {
  const id = rwp_get_queried_object_id();
  return id || false;
}

export const rwp_is_single = (): boolean => current.kind === 'single';
export const rwp_is_page = (): boolean => current.kind === 'page';
export const rwp_is_singular = (): boolean => current.kind === 'single' || current.kind === 'page';
export const rwp_is_search = (): boolean => current.kind === 'search';
export const rwp_is_404 = (): boolean => current.kind === '404';
export const rwp_is_archive = (): boolean => current.kind === 'archive';
export const rwp_is_category = (): boolean => current.kind === 'archive' && current.taxonomy === 'category';
export const rwp_is_tax = (taxonomy = ''): boolean => current.kind === 'archive' && (!taxonomy || current.taxonomy === taxonomy);
export const rwp_is_tag = (): boolean => current.kind === 'archive' && current.taxonomy === 'post_tag';

/**
 * The classes WordPress puts on <body>, as a string. Pass extra classes to add. Runs `rwp_body_class`.
 * (WordPress prints them; here you put the string where you render the element.)
 */
export function rwp_body_class(extra: string | string[] = []): string {
  const classes: string[] = [];
  const add = (value: string) => classes.push(value);
  if (typeof window !== 'undefined' && window.location.pathname === '/') add('home');
  if (current.kind === 'single') add('single');
  if (current.kind === 'page') add('page');
  if (current.kind === 'archive') add('archive');
  if (current.kind === 'search') add('search');
  if (current.kind === '404') add('error404');
  const id = rwp_get_queried_object_id();
  if (id) add(`postid-${id}`);
  if (current.post?.post_name) add(`${current.kind === 'page' ? 'page' : 'single'}-${String(current.post.post_name)}`);
  const more = Array.isArray(extra) ? extra : extra.split(/\s+/).filter(Boolean);
  const filtered = applyFilters<string[]>('rwp_body_class', [...classes, ...more], more);
  return [...new Set(filtered)].join(' ');
}

/** The classes for a post's container element, as a string. Runs `rwp_post_class`. */
export function rwp_post_class(post: { ID?: number; id?: number; post_type?: string; post_status?: string }, extra: string | string[] = []): string {
  const id = Number(post.ID ?? post.id ?? 0);
  const more = Array.isArray(extra) ? extra : extra.split(/\s+/).filter(Boolean);
  const base = [`post-${id}`, post.post_type ?? 'post', `type-${post.post_type ?? 'post'}`, `status-${post.post_status ?? 'publish'}`, 'hentry'];
  const filtered = applyFilters<string[]>('rwp_post_class', [...base, ...more], more, id);
  return [...new Set(filtered)].join(' ');
}

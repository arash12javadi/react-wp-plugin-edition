/**
 * The filters WordPress's template tags apply to a title, an excerpt and a list of posts, run in
 * WordPress's order and ahead of React-WP's own filters.
 *
 *   rwp_the_title(title, id)                       -> rwp_post_title(title, page)
 *   rwp_get_the_excerpt(excerpt, page), rwp_the_excerpt(excerpt) -> rwp_post_excerpt(excerpt, page)
 *   rwp_the_posts(posts, query)                    -> rwp_posts(posts)
 *
 * The WordPress-named filters come first because they are string filters written against WordPress's
 * contract; a React-WP filter may return a React element (Persian Origins does, at priority 100), and
 * a string filter must never be handed one.
 */
import { applyFilters } from '../../core/hooks';

interface Titled {
  id: number | string;
  title?: string | null;
  excerpt?: string | null;
}

/** The title as it should be shown, after WordPress's `the_title` and React-WP's `rwp_post_title`. */
export function filterTitle<T = string>(title: string, page: Titled): T {
  const wp = applyFilters<string>('rwp_the_title', title, page.id);
  return applyFilters<T>('rwp_post_title', wp as unknown as T, page);
}

/** The excerpt as it should be shown, after `get_the_excerpt`, `the_excerpt` and `rwp_post_excerpt`. */
export function filterExcerpt<T = string>(excerpt: string, page: Titled): T {
  const got = applyFilters<string>('rwp_get_the_excerpt', excerpt, page);
  const wp = applyFilters<string>('rwp_the_excerpt', got);
  return applyFilters<T>('rwp_post_excerpt', wp as unknown as T, page);
}

/** A list of posts after WordPress's `the_posts` and React-WP's `rwp_posts`. */
export function filterPosts<T>(posts: T[], query: Record<string, unknown> = {}): T[] {
  const wp = applyFilters<T[]>('rwp_the_posts', posts, query);
  return applyFilters<T[]>('rwp_posts', Array.isArray(wp) ? wp : posts);
}

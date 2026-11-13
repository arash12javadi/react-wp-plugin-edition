/**
 * WordPress's template tags for the post being shown (get_the_title, the_content, get_the_excerpt ...).
 *
 * WordPress's tags read "the current post" from a global. Here the current post is the one the public
 * screen announced with rwp_set_queried_object (see query.ts), and every tag also takes a post object
 * (as returned by rwp_get_post). A tag that is "echoed" in PHP (`the_title()`) RETURNS its string
 * here: render it where you want it. A numeric id is not enough, because looking one up is async: pass
 * the object, or `await rwp_get_post(id)` first.
 */
import { applyFilters } from '../../core/hooks';
import { rwp_get_queried_object } from './query';
import { rwp_get_permalink } from './posts';
import { rwp_get_post } from './posts';

export interface PostLike {
  ID?: number;
  id?: number;
  post_title?: string;
  post_content?: string;
  post_excerpt?: string;
  post_name?: string;
  post_status?: string;
  post_type?: string;
  [key: string]: unknown;
}

const current = (post?: PostLike | number | null): PostLike | null => {
  if (post && typeof post === 'object') return post;
  const queried = rwp_get_queried_object().post as PostLike | null | undefined;
  if (typeof post === 'number' && post && Number(queried?.ID ?? queried?.id) !== post) return null;
  return queried ?? null;
};

const idOf = (post: PostLike): number => Number(post.ID ?? post.id ?? 0);

/** The post's title through `rwp_the_title` ('' when there is no post). */
export function rwp_get_the_title(post: PostLike | number | null = null): string {
  const found = current(post);
  if (!found) return '';
  return applyFilters<string>('rwp_the_title', String(found.post_title ?? ''), idOf(found));
}

/** rwp_get_the_title wrapped in `before` and `after`; '' when the title is empty. */
export function rwp_the_title(before = '', after = '', post: PostLike | number | null = null): string {
  const title = rwp_get_the_title(post);
  return title ? `${before}${title}${after}` : '';
}

/** The post's id, or 0. */
export function rwp_the_ID(post: PostLike | null = null): number {
  const found = current(post);
  return found ? idOf(found) : 0;
}

/** The raw post content, with WordPress's more-tag split applied when `moreLinkText` is given. */
export function rwp_get_the_content(moreLinkText: string | null = null, stripTeaser = false, post: PostLike | null = null): string {
  const found = current(post);
  if (!found) return '';
  let content = String(found.post_content ?? '');
  const more = /<!--more(?:\s+(.*?))?-->/i.exec(content);
  if (more && moreLinkText !== null) {
    const teaser = content.slice(0, more.index);
    const link = `<a href="${rwp_get_permalink(found as { post_name?: string })}#more-${idOf(found)}" class="more-link">${applyFilters<string>('rwp_the_content_more_link', moreLinkText, moreLinkText)}</a>`;
    content = `${stripTeaser ? '' : teaser}${link}`;
  }
  return content;
}

/** The post content through the `rwp_the_content` filter, the one that renders shortcodes and extra markup. */
export function rwp_the_content(moreLinkText: string | null = null, stripTeaser = false, post: PostLike | null = null): string {
  const content = rwp_get_the_content(moreLinkText, stripTeaser, post);
  return applyFilters<string>('rwp_the_content', content).replace(/\]\]>/g, ']]&gt;');
}

/** The post excerpt through `rwp_get_the_excerpt`. */
export function rwp_get_the_excerpt(post: PostLike | null = null): string {
  const found = current(post);
  if (!found) return '';
  return applyFilters<string>('rwp_get_the_excerpt', String(found.post_excerpt ?? ''), found);
}

/** The post excerpt through `rwp_get_the_excerpt` and `rwp_the_excerpt`. */
export function rwp_the_excerpt(post: PostLike | null = null): string {
  return applyFilters<string>('rwp_the_excerpt', rwp_get_the_excerpt(post));
}

/** The post's address, through `rwp_the_permalink`. */
export function rwp_the_permalink(post: PostLike | null = null): string {
  const found = current(post);
  return found ? applyFilters<string>('rwp_the_permalink', rwp_get_permalink(found as { post_name?: string }), found) : '';
}

/** One field of a post: 'post_title', 'post_content', 'post_status', 'ID' ... Async because it may look the post up. */
export async function rwp_get_post_field(field: string, post: PostLike | number | string | null = null, context = 'display'): Promise<string | number | false> {
  void context;
  const found = typeof post === 'object' && post ? post : typeof post === 'number' || typeof post === 'string' ? await rwp_get_post(post) : current(null);
  if (!found || !(field in found)) return '';
  return found[field] as string | number;
}

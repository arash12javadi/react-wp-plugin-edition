/**
 * Address builders (wp-includes/link-template.php) and the "next / previous post" helpers.
 *
 * Addresses are built from the page's own origin and React-WP's fixed routes: /slug for pages and
 * posts, /category/slug, /author/id, /date/year[/month], /search?s=, /admin?section=. Most take the
 * post or term object (see posts.ts, terms.ts); a plain id cannot be turned into a slug without a
 * query, so those that need one are async. Every address is passed through the WordPress filter of
 * the same name so a plugin can change it.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { rwp_get_permalink, rwp_post_from_row, rwp_get_post, type RWP_Post } from './posts';
import { rwp_get_term, rwp_get_term_link, type RWP_Term } from './terms';
import { rwp_admin_url, rwp_home_url, rwp_site_url } from './runtime';
import { rwp_esc_attr, rwp_esc_html, rwp_esc_url } from './formatting';
import { rwp_get_queried_object } from './query';

const origin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);

type PostRef = RWP_Post | number | string;

async function resolvePost(post: PostRef): Promise<RWP_Post | null> {
  return typeof post === 'object' ? post : rwp_get_post(post);
}

export const rwp_get_home_url = (blogId: number | null = null, path = '', scheme: string | null = null): string => { void blogId; return rwp_home_url(path, scheme); };
export const rwp_get_site_url = (blogId: number | null = null, path = '', scheme: string | null = null): string => { void blogId; return rwp_site_url(path, scheme); };
export const rwp_get_admin_url = (blogId: number | null = null, path = '', scheme = 'admin'): string => { void blogId; return rwp_admin_url(path, scheme); };
export const rwp_get_dashboard_url = (userId = 0, path = '', scheme = 'admin'): string => { void userId; return applyFilters<string>('rwp_user_dashboard_url', `${origin()}/dashboard${path ? `/${path}` : ''}`, userId, path, scheme); };
export const rwp_get_edit_profile_url = (userId = 0, scheme = 'admin'): string => applyFilters<string>('rwp_edit_profile_url', `${origin()}/profile`, userId, scheme);
export const rwp_get_edit_user_link = (userId: string): string => applyFilters<string>('rwp_get_edit_user_link', rwp_admin_url(`users&id=${encodeURIComponent(userId)}`), userId);

/** Where a post is edited in the admin, or null. */
export function rwp_get_edit_post_link(post: PostRef, context = 'display'): string | null {
  const id = typeof post === 'object' ? post.ID : post;
  if (!id) return null;
  const link = `${origin()}/admin?section=${(typeof post === 'object' && post.post_type === 'post') ? 'posts' : 'pages'}&edit=${id}`;
  return applyFilters<string | null>('rwp_get_edit_post_link', link, id, context);
}

export function rwp_get_delete_post_link(post: PostRef, deepLink = '', forceDelete = false): string | undefined {
  const id = typeof post === 'object' ? post.ID : post;
  if (!id) return undefined;
  return applyFilters<string | undefined>('rwp_get_delete_post_link', `${origin()}/admin?section=pages&${forceDelete ? 'delete' : 'trash'}=${id}`, id, deepLink);
}

export async function rwp_get_preview_post_link(post: PostRef = 0): Promise<string | null> {
  const found = await resolvePost(post);
  if (!found) return null;
  return applyFilters<string>('rwp_preview_post_link', `${rwp_get_permalink(found)}?preview=1`, found);
}

/** The address of a post or page (by object or id). */
export async function rwp_get_page_link(post: PostRef = 0, leaveName = false, sample = false): Promise<string> {
  void sample;
  const found = await resolvePost(post || Number(rwp_get_queried_object().post?.ID ?? 0));
  return applyFilters<string>('_rwp_get_page_link', found ? rwp_get_permalink(found, leaveName) : '', found?.ID ?? 0, leaveName);
}

export const rwp_get_the_permalink = rwp_get_permalink;

/** The address of a post by id or object (WordPress's get_post_permalink). */
export async function rwp_get_post_permalink(post: PostRef = 0, leaveName = false, sample = false): Promise<string> {
  void sample;
  const found = await resolvePost(post || Number(rwp_get_queried_object().post?.ID ?? 0));
  return found ? applyFilters<string>('rwp_post_link', rwp_get_permalink(found, leaveName), found, leaveName) : '';
}

export function rwp_get_search_link(query = ''): string {
  return applyFilters<string>('rwp_search_link', `${origin()}/search?s=${encodeURIComponent(query)}`, query);
}

export const rwp_get_year_link = (year: number | false = false): string => applyFilters<string>('rwp_year_link', `${origin()}/date/${year || new Date().getFullYear()}`, year);
export const rwp_get_month_link = (year: number | false = false, month: number | false = false): string => applyFilters<string>('rwp_month_link', `${origin()}/date/${year || new Date().getFullYear()}/${String(month || new Date().getMonth() + 1).padStart(2, '0')}`, year, month);
export const rwp_get_day_link = (year: number | false = false, month: number | false = false, day: number | false = false): string => applyFilters<string>('rwp_day_link', `${rwp_get_month_link(year, month)}/${String(day || new Date().getDate()).padStart(2, '0')}`, year, month, day);

/** The address of page `pagenum` of the current list: ?paged=n. */
export function rwp_get_pagenum_link(pagenum = 1, escape = true): string {
  const url = new URL(typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
  if (pagenum <= 1) url.searchParams.delete('paged'); else url.searchParams.set('paged', String(pagenum));
  const link = `${url.pathname}${url.search}`;
  return applyFilters<string>('rwp_get_pagenum_link', escape ? rwp_esc_url(link) : link);
}

export const rwp_get_post_type_archive_link = (postType: string): false => { void postType; return false; };

// Terms ------------------------------------------------------------------------------------------------------

export async function rwp_get_category_link(category: string | RWP_Term): Promise<string> {
  const term = typeof category === 'object' ? category : await rwp_get_term(category, 'category');
  return term && !(term instanceof Error) && 'slug' in term ? applyFilters<string>('rwp_category_link', rwp_get_term_link(term as RWP_Term, 'category'), (term as RWP_Term).term_id) : '';
}

export async function rwp_get_tag_link(tag: string | RWP_Term): Promise<string> {
  const term = typeof tag === 'object' ? tag : await rwp_get_term(tag, 'post_tag');
  return term && !(term instanceof Error) && 'slug' in term ? applyFilters<string>('rwp_tag_link', rwp_get_term_link(term as RWP_Term, 'post_tag'), (term as RWP_Term).term_id) : '';
}

// Neighbours ------------------------------------------------------------------------------------------------------

/** The post published just before (previous) or after (next) this one, of the same type; null when none. */
async function neighbour(post: PostRef, direction: 'previous' | 'next'): Promise<RWP_Post | null> {
  const current = await resolvePost(post || Number(rwp_get_queried_object().post?.ID ?? 0));
  if (!current || !current.post_date) return null;
  const before = direction === 'previous';
  let request = client.from('pages').select('*').eq('status', 'published').eq('is_post', current.post_type === 'post');
  request = before ? request.lt('created_at', current.post_date) : request.gt('created_at', current.post_date);
  const { data } = await request.order('created_at', { ascending: !before }).limit(1).maybeSingle();
  return data ? rwp_post_from_row(data as Record<string, unknown> & { id: number }) : null;
}

export async function rwp_get_previous_post(inSameTerm = false, excluded: string[] = [], taxonomy = 'category', post: PostRef = 0): Promise<RWP_Post | null> {
  void inSameTerm; void excluded; void taxonomy;
  return neighbour(post, 'previous');
}

export async function rwp_get_next_post(inSameTerm = false, excluded: string[] = [], taxonomy = 'category', post: PostRef = 0): Promise<RWP_Post | null> {
  void inSameTerm; void excluded; void taxonomy;
  return neighbour(post, 'next');
}

/** An <a> to the previous post (default format "« %link"), or ''. */
export async function rwp_get_previous_post_link(format = '&laquo; %link', link = '%title'): Promise<string> {
  const post = await rwp_get_previous_post();
  if (!post) return '';
  const anchor = `<a href="${rwp_esc_attr(rwp_esc_url(rwp_get_permalink(post)))}" rel="prev">${link.replace('%title', rwp_esc_html(post.post_title))}</a>`;
  const adjacent = 'previous';
  return applyFilters<string>(`rwp_${adjacent}_post_link`, format.replace('%link', anchor), format, link, post, '');
}

export async function rwp_get_next_post_link(format = '%link &raquo;', link = '%title'): Promise<string> {
  const post = await rwp_get_next_post();
  if (!post) return '';
  const anchor = `<a href="${rwp_esc_attr(rwp_esc_url(rwp_get_permalink(post)))}" rel="next">${link.replace('%title', rwp_esc_html(post.post_title))}</a>`;
  const adjacent = 'next';
  return applyFilters<string>(`rwp_${adjacent}_post_link`, format.replace('%link', anchor), format, link, post, '');
}

export const rwp_previous_post_link = rwp_get_previous_post_link;
export const rwp_next_post_link = rwp_get_next_post_link;

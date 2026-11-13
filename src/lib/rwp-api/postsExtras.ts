/**
 * More post functions: conditional tags for archives, post statuses, counts, page lists, sticky posts,
 * featured images (as the `_thumbnail_id` meta, as in WordPress) and a few lookups.
 *
 * Posts are rows of public.pages; see posts.ts for the shape and the rules (async, RLS decides writes).
 * There is no post hierarchy, revision history, post format or password protection in React-WP, so
 * rwp_get_post_ancestors() answers [], rwp_post_password_required() answers false, and nothing here
 * pretends otherwise.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client } from '../db';
import { rwp_delete_post_meta, rwp_get_post_meta, rwp_update_post_meta } from './meta';
import { rwp_get_option, rwp_update_option } from './options';
import { rwp_get_post, rwp_get_posts, rwp_get_permalink, type PostsQuery, type RWP_Post } from './posts';
import { firePostSaved, toWpStatus, type PostRow } from './postEvents';
import { rwp_get_queried_object, rwp_body_class, rwp_post_class } from './query';
import { rwp_get_attachment_image, rwp_get_attachment_url } from './attachments';
import { rwp_esc_attr, rwp_esc_html, rwp_esc_url, rwp_sanitize_title, rwp_strip_all_tags } from './formatting';
import { RWP_Error } from './errors';

type PostRef = number | string | { ID?: number; id?: number };
const idOf = (post: PostRef): number => Number(typeof post === 'object' ? (post.ID ?? post.id) : post);

// Conditional tags ------------------------------------------------------------------------------------------

const search = (): URLSearchParams => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

export const rwp_is_attachment = (): boolean => false;
export const rwp_is_local_attachment = (): boolean => false;
export const rwp_is_embed = (): boolean => false;
export const rwp_is_feed = (): boolean => false;
export const rwp_is_comment_feed = (): boolean => false;
export const rwp_is_trackback = (): boolean => false;
export const rwp_is_robots = (): boolean => false;
export const rwp_is_favicon = (): boolean => false;
export const rwp_is_sitemap = (): boolean => false;
export const rwp_is_post_type_archive = (): boolean => false;
export const rwp_is_page_template = (): boolean => false;
export const rwp_is_main_query = (): boolean => true;
export const rwp_in_the_loop = (): boolean => false;
export const rwp_is_preview = (): boolean => search().has('preview');
export const rwp_is_paged = (): boolean => Number(search().get('paged') || 1) > 1;
export const rwp_is_author = (): boolean => (rwp_get_queried_object() as { taxonomy?: string }).taxonomy === 'author';
export const rwp_is_date = (): boolean => ['date', 'year', 'month', 'day'].includes(String((rwp_get_queried_object() as { taxonomy?: string }).taxonomy));
export const rwp_is_year = (): boolean => rwp_is_date();
export const rwp_is_month = (): boolean => rwp_is_date();
export const rwp_is_day = (): boolean => false;
export const rwp_is_time = (): boolean => false;
export const rwp_is_post_type_hierarchical = (): boolean => false;
export const rwp_have_comments = (): boolean => false;

/** Whether a post may be viewed by anyone: it is published. */
export async function rwp_is_post_publicly_viewable(post: PostRef): Promise<boolean> {
  const found = await rwp_get_post(post);
  return Boolean(found && found.post_status === 'publish');
}

export const rwp_is_post_status_viewable = (status: string): boolean => applyFilters<boolean>('rwp_is_post_status_viewable', status === 'publish', status);

// Statuses ------------------------------------------------------------------------------------------------------

interface PostStatus { name: string; label: string; public: boolean; internal: boolean }

const statuses = new Map<string, PostStatus>([
  ['publish', { name: 'publish', label: 'Published', public: true, internal: false }],
  ['draft', { name: 'draft', label: 'Draft', public: false, internal: false }],
  ['trash', { name: 'trash', label: 'Trash', public: false, internal: true }],
]);

/** Adds a status name to the registry. The database only stores publish, draft and trash. */
export function rwp_register_post_status(name: string, args: Partial<PostStatus> = {}): PostStatus {
  const entry: PostStatus = { name, label: args.label ?? name, public: Boolean(args.public), internal: Boolean(args.internal) };
  statuses.set(name, entry);
  return entry;
}

export const rwp_get_post_status_object = (name: string): PostStatus | null => statuses.get(name) ?? null;

export function rwp_get_post_stati(args: { public?: boolean; internal?: boolean } = {}, output: 'names' | 'objects' = 'names'): string[] | Record<string, PostStatus> {
  const list = [...statuses.values()].filter((entry) => (args.public === undefined || entry.public === args.public) && (args.internal === undefined || entry.internal === args.internal));
  return output === 'names' ? list.map((entry) => entry.name) : Object.fromEntries(list.map((entry) => [entry.name, entry]));
}

export const rwp_get_post_statuses = (): Record<string, string> => ({ draft: 'Draft', publish: 'Published' });
export const rwp_get_page_statuses = rwp_get_post_statuses;
export const rwp_get_available_post_statuses = (): string[] => ['publish', 'draft', 'trash'];
export const rwp_get_default_comment_status = (): 'open' => 'open';

// Counts and lists --------------------------------------------------------------------------------------------

/** How many posts there are in each status: { publish, draft, trash }. */
export async function rwp_count_posts(type = 'post'): Promise<Record<string, number>> {
  const counts: Record<string, number> = { publish: 0, draft: 0, trash: 0 };
  let request = client.from('pages').select('status');
  request = type === 'post' ? request.eq('is_post', true) : type === 'page' ? request.eq('is_post', false) : request.eq('post_type', type);
  const { data } = await request.limit(10000);
  for (const row of (data || []) as Array<{ status: string }>) {
    const key = toWpStatus(row.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return applyFilters<Record<string, number>>('rwp_count_posts', counts, type, 'readable');
}

/** How many media items there are, by mime type group: { image, video, ... }. */
export async function rwp_count_attachments(): Promise<Record<string, number>> {
  const { data } = await client.from('media').select('mime_type').limit(10000);
  const counts: Record<string, number> = {};
  for (const row of (data || []) as Array<{ mime_type: string | null }>) {
    const key = (row.mime_type ?? 'other').split('/')[0];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return applyFilters<Record<string, number>>('rwp_count_attachments', counts, null);
}

/** The newest posts, as plain rows (WordPress's wp_get_recent_posts). */
export async function rwp_get_recent_posts(args: PostsQuery = {}): Promise<RWP_Post[]> {
  return rwp_get_posts({ numberposts: 10, post_status: 'any', ...args });
}

/** Pages, as WordPress's get_pages: published pages by default, ordered by title. */
export async function rwp_get_pages(args: { number?: number; sort_column?: 'post_title' | 'post_date'; post_status?: string } = {}): Promise<RWP_Post[]> {
  const pages = await rwp_get_posts({ post_type: 'page', post_status: (args.post_status as PostsQuery['post_status']) ?? 'publish', numberposts: args.number ?? 0, orderby: args.sort_column === 'post_date' ? 'date' : 'title', order: 'ASC' });
  return applyFilters<RWP_Post[]>('rwp_get_pages', pages, args, args);
}

export const rwp_get_all_page_ids = async (): Promise<number[]> => (await rwp_get_pages({ post_status: 'any' })).map((page) => page.ID);

/** A page list as <ul><li><a>…: WordPress's wp_list_pages, returned. Items are escaped. */
export async function rwp_list_pages(args: { title_li?: string; number?: number } = {}): Promise<string> {
  const pages = await rwp_get_pages({ number: args.number });
  const items = pages.map((page) => `<li class="page_item page-item-${page.ID}"><a href="${rwp_esc_attr(rwp_esc_url(rwp_get_permalink(page)))}">${rwp_esc_html(page.post_title)}</a></li>`).join('');
  const heading = args.title_li === undefined ? 'Pages' : args.title_li;
  const html = heading ? `<li class="pagenav">${rwp_esc_html(heading)}<ul>${items}</ul></li>` : items;
  return applyFilters<string>('rwp_list_pages', html, args, pages);
}

/** Whether a post with this title (and optionally content and date) exists: its id, or 0. */
export async function rwp_post_exists(title: string, content = '', date = '', type = ''): Promise<number> {
  let request = client.from('pages').select('id').eq('title', title);
  if (type) request = type === 'post' ? request.eq('is_post', true) : request.eq('is_post', false);
  if (content) request = request.eq('content', content);
  if (date) request = request.eq('created_at', date);
  const { data } = await request.limit(1).maybeSingle();
  return (data as { id: number } | null)?.id ?? 0;
}

/** A slug that no other post uses: "hello", then "hello-2", "hello-3" ... */
export async function rwp_unique_post_slug(slug: string, postId: number | string = 0, postStatus = 'publish', postType = 'post'): Promise<string> {
  const base = rwp_sanitize_title(slug) || 'post';
  const { data } = await client.from('pages').select('id,slug').like('slug', `${base}%`).limit(500);
  const taken = new Set(((data || []) as Array<{ id: number; slug: string }>).filter((row) => String(row.id) !== String(postId)).map((row) => row.slug));
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  return applyFilters<string>('rwp_unique_post_slug', candidate, postId, postStatus, postType, 0, slug);
}

/** Publishes a post. Fires the status transition and save_post hooks. */
export async function rwp_publish_post(post: PostRef): Promise<RWP_Post | RWP_Error> {
  const found = await rwp_get_post(post);
  if (!found) return new RWP_Error('invalid_post', 'Invalid post ID.');
  if (found.post_status === 'publish') return found;
  const { data, error } = await client.from('pages').update({ status: 'published', updated_at: new Date().toISOString() }).eq('id', found.ID).select('id');
  if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_update_error', error?.message ?? 'The database skipped this post. Publishing needs the publish_posts capability.');
  const after = { ...found, status: 'published' } as unknown as PostRow;
  firePostSaved({ id: found.ID, post: after, previous: found as unknown as PostRow, update: true });
  return { ...found, post_status: 'publish', status: 'published' };
}

/** Fires the status-transition hooks for a change you made yourself (WordPress's wp_transition_post_status). */
export function rwp_transition_post_status(newStatus: string, oldStatus: string, post: RWP_Post): void {
  if (newStatus !== oldStatus) {
    doAction('rwp_transition_post_status', newStatus, oldStatus, post);
    doAction(`rwp_${oldStatus}_to_${newStatus}`, post);
  }
  doAction(`rwp_${newStatus}_${post.post_type}`, post.ID, post, oldStatus);
}

// Text of a post ----------------------------------------------------------------------------------------------------

/** Whether the post has a hand-written excerpt. */
export function rwp_has_excerpt(post: { post_excerpt?: string } | null = null): boolean {
  const found = post ?? (rwp_get_queried_object().post as { post_excerpt?: string } | null | undefined);
  return Boolean(found?.post_excerpt);
}

/** Splits content at the <!--more--> tag: { main, extended, more_text }. */
export function rwp_get_extended(post: string): { main: string; extended: string; more_text: string } {
  const match = /<!--more(?:\s+(.*?))?-->/i.exec(post);
  if (!match) return { main: post, extended: '', more_text: '' };
  return { main: post.slice(0, match.index), extended: post.slice(match.index + match[0].length), more_text: match[1] ?? '' };
}

/** The post's address as its GUID. */
export const rwp_get_the_guid = (post: { post_name?: string } | null = null): string => {
  const found = post ?? (rwp_get_queried_object().post as { post_name?: string } | null | undefined);
  return applyFilters<string>('rwp_get_the_guid', found ? rwp_get_permalink(found) : '', found ? 0 : 0);
};
export const rwp_the_guid = rwp_get_the_guid;

/** The title as text for an attribute (tags removed, escaped). */
export function rwp_the_title_attribute(title: string): string {
  return rwp_esc_attr(rwp_strip_all_tags(title));
}

/** A permalink preview: [template with %pagename%, the slug]. */
export function rwp_get_sample_permalink(post: { post_name?: string; post_title?: string }): [string, string] {
  const slug = post.post_name || rwp_sanitize_title(post.post_title ?? '');
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  return applyFilters<[string, string]>('rwp_get_sample_permalink', [`${base}/%pagename%`, slug], 0, post.post_title ?? '', slug, post);
}

/** The classes for the <body> element as a list. */
export const rwp_get_body_class = (extra: string | string[] = []): string[] => rwp_body_class(extra).split(/\s+/).filter(Boolean);

/** The classes for a post's element as a list. */
export const rwp_get_post_class = (post: { ID?: number; post_type?: string; post_status?: string }, extra: string | string[] = []): string[] => rwp_post_class(post, extra).split(/\s+/).filter(Boolean);

/** Cleans a post field for storing or showing: titles lose tags; slugs become slugs. */
export function rwp_sanitize_post_field(field: string, value: unknown, postId = 0, context = 'display'): unknown {
  const text = String(value ?? '');
  if (field === 'post_title' || field === 'post_excerpt') {
    return context === 'db'
      ? applyFilters<unknown>(`rwp_pre_${field}`, rwp_strip_all_tags(text), postId, context)
      : applyFilters<unknown>(`rwp_${field}`, text, postId, context);
  }
  if (field === 'post_name') return rwp_sanitize_title(text);
  return value;
}

export function rwp_sanitize_post<T extends Record<string, unknown>>(post: T, context = 'display'): T {
  return Object.fromEntries(Object.entries(post).map(([key, value]) => [key, key.startsWith('post_') ? rwp_sanitize_post_field(key, value, Number(post.ID ?? 0), context) : value])) as T;
}

/** Whether a post needs a password: React-WP has none. */
export const rwp_post_password_required = (): boolean => false;

// Sticky posts (an option of ids) --------------------------------------------------------------------------------------

const STICKY = 'sticky_posts';

export async function rwp_is_sticky(postId: PostRef = 0): Promise<boolean> {
  const stored = await rwp_get_option<number[]>(STICKY, []);
  const id = idOf(postId) || Number(rwp_get_queried_object().post?.ID ?? 0);
  return applyFilters<boolean>('rwp_is_sticky', Array.isArray(stored) && stored.includes(id), id);
}

export async function rwp_stick_post(postId: PostRef): Promise<void> {
  const stored = await rwp_get_option<number[]>(STICKY, []);
  const list = Array.isArray(stored) ? stored : [];
  if (!list.includes(idOf(postId))) await rwp_update_option(STICKY, [idOf(postId), ...list]);
  doAction('rwp_post_stuck', idOf(postId));
}

export async function rwp_unstick_post(postId: PostRef): Promise<void> {
  const stored = await rwp_get_option<number[]>(STICKY, []);
  const list = Array.isArray(stored) ? stored : [];
  if (list.includes(idOf(postId))) await rwp_update_option(STICKY, list.filter((id) => id !== idOf(postId)));
  doAction('rwp_post_unstuck', idOf(postId));
}

// Featured image: the `_thumbnail_id` meta, as in WordPress --------------------------------------------------------

export async function rwp_get_post_thumbnail_id(post: PostRef = 0): Promise<string | false> {
  const id = idOf(post) || Number(rwp_get_queried_object().post?.ID ?? 0);
  const value = id ? await rwp_get_post_meta(id, '_thumbnail_id', true) : '';
  return applyFilters<string | false>('rwp_post_thumbnail_id', value ? String(value) : false, id || null);
}

export async function rwp_has_post_thumbnail(post: PostRef = 0): Promise<boolean> {
  return applyFilters<boolean>('rwp_has_post_thumbnail', Boolean(await rwp_get_post_thumbnail_id(post)), post, await rwp_get_post_thumbnail_id(post));
}

export async function rwp_set_post_thumbnail(post: PostRef, thumbnailId: string): Promise<boolean> {
  const result = await rwp_update_post_meta(idOf(post), '_thumbnail_id', thumbnailId);
  return result !== false;
}

export const rwp_delete_post_thumbnail = (post: PostRef): Promise<boolean> => rwp_delete_post_meta(idOf(post), '_thumbnail_id');

/** The featured image as an <img> string, or ''. */
export async function rwp_get_the_post_thumbnail(post: PostRef = 0, size: string | number[] = 'post-thumbnail', attr: Record<string, string> = {}): Promise<string> {
  const id = await rwp_get_post_thumbnail_id(post);
  if (!id) return '';
  const html = await rwp_get_attachment_image(id, size, false, attr);
  return applyFilters<string>('rwp_post_thumbnail_html', html, idOf(post), id, size, attr);
}

export async function rwp_get_the_post_thumbnail_url(post: PostRef = 0): Promise<string | false> {
  const id = await rwp_get_post_thumbnail_id(post);
  return id ? rwp_get_attachment_url(id) : false;
}

export const rwp_the_post_thumbnail = rwp_get_the_post_thumbnail;
export const rwp_the_post_thumbnail_url = rwp_get_the_post_thumbnail_url;

export async function rwp_get_the_post_thumbnail_caption(post: PostRef = 0): Promise<string> {
  const id = await rwp_get_post_thumbnail_id(post);
  if (!id) return '';
  const { data } = await client.from('media').select('title').eq('id', id).maybeSingle();
  return applyFilters<string>('rwp_the_post_thumbnail_caption', (data as { title?: string } | null)?.title ?? '', post);
}

export const rwp_the_post_thumbnail_caption = rwp_get_the_post_thumbnail_caption;

// Terms and meta shortcuts ---------------------------------------------------------------------------------------------

export const rwp_post_custom = async (post: PostRef, key = ''): Promise<unknown> => (key ? rwp_get_post_meta(idOf(post), key) : rwp_get_post_meta(idOf(post)));

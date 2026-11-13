/**
 * WordPress's post functions over public.pages.
 *
 * React-WP keeps pages and blog posts in one table, `pages`; `is_post` is WordPress's post_type
 * ('post' when true, 'page' when false). Rows are returned in WordPress's shape (`ID`, `post_title`,
 * `post_content`, `post_excerpt`, `post_status`, `post_name`, `post_type`, `post_author`,
 * `post_date`, `post_modified`) with the original columns alongside, so ported code that reads
 * `$post->post_title` and code that reads `page.title` both work.
 *
 * Differences that matter:
 *   - Every function that touches the database is async.
 *   - Statuses are WordPress's: 'publish', 'draft', 'trash' ('published' is how the table spells it).
 *   - Whether a write is allowed is decided by row level security in the database, not by a
 *     capability check here. A write the database refuses comes back as an RWP_Error (or false).
 *   - There is no post meta, post parent, menu_order, custom post types or taxonomies-by-object yet.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client } from '../db';
import { deleteContent, setContentStatus } from '../contentBulk';
import { RWP_Error } from './errors';
import { rwp_sanitize_title, rwp_strip_all_tags } from './formatting';
import { filterPostData, firePostSaved, firePrePostUpdate, postTypeOf, toWpStatus, type PostRow } from './postEvents';
import { hasCustomPostTypes, rwp_post_type_exists } from './postTypes';

export interface RWP_Post extends Record<string, unknown> {
  ID: number;
  id: number;
  post_title: string;
  post_name: string;
  post_content: string;
  post_excerpt: string;
  post_status: string;
  post_type: string;
  post_author: string | null;
  post_date: string | null;
  post_modified: string | null;
}

type Row = Record<string, unknown> & { id: number };

const dbStatus = (status: string): string => (status === 'publish' ? 'published' : status);

/** Wraps a pages row in WordPress's shape. */
export function rwp_post_from_row(row: Row): RWP_Post {
  const typed = row as Row & { post_type?: string | null; title?: string; slug?: string; content?: string; excerpt?: string; status?: string; is_post?: boolean; author_id?: string; created_at?: string; updated_at?: string };
  return {
    ...row,
    ID: row.id,
    post_title: typed.title ?? '',
    post_name: typed.slug ?? '',
    post_content: typed.content ?? '',
    post_excerpt: typed.excerpt ?? '',
    post_status: toWpStatus(typed.status),
    post_type: typed.post_type || postTypeOf({ is_post: typed.is_post }),
    post_author: typed.author_id ?? null,
    post_date: typed.created_at ?? null,
    post_modified: typed.updated_at ?? null,
  } as RWP_Post;
}

const idOf = (post: number | string | { ID?: number; id?: number }): number => Number(typeof post === 'object' ? (post.ID ?? post.id) : post);

/** One post or page by id, or null. */
export async function rwp_get_post(post: number | string | { ID?: number; id?: number }): Promise<RWP_Post | null> {
  const id = idOf(post);
  if (!Number.isFinite(id)) return null;
  const { data, error } = await client.from('pages').select('*').eq('id', id).maybeSingle();
  if (error || !data) return null;
  return rwp_post_from_row(data as Row);
}

/** A page or post by its path (the slug). */
export async function rwp_get_page_by_path(path: string, output: 'object' = 'object', postType: 'page' | 'post' = 'page'): Promise<RWP_Post | null> {
  void output;
  const slug = path.replace(/^\/+|\/+$/g, '');
  const { data, error } = await client.from('pages').select('*').eq('slug', slug).eq('is_post', postType === 'post').maybeSingle();
  if (error || !data) return null;
  return rwp_post_from_row(data as Row);
}

export interface PostsQuery {
  /** How many to return. Default 5 (WordPress's numberposts). -1 for as many as the database allows. */
  numberposts?: number;
  posts_per_page?: number;
  post_type?: string;
  post_status?: 'publish' | 'draft' | 'trash' | 'any';
  orderby?: 'date' | 'title' | 'modified' | 'ID' | 'name';
  order?: 'ASC' | 'DESC' | 'asc' | 'desc';
  /** Search in the title. */
  s?: string;
  /** A category id (posts only). */
  cat?: string;
  /** One slug. */
  name?: string;
  offset?: number;
  /** Only these ids. */
  include?: number[];
}

const ORDER_COLUMN: Record<string, string> = { date: 'created_at', title: 'title', modified: 'updated_at', ID: 'id', name: 'slug' };

/**
 * Posts and pages matching a WordPress-style query. `rwp_pre_get_posts` fires with the query object
 * first, so a plugin can change it (its changes are read back), and the result goes through
 * `rwp_the_posts`. Visitors see published rows only; the database enforces that.
 */
export async function rwp_get_posts(args: PostsQuery = {}): Promise<RWP_Post[]> {
  const query: PostsQuery = { numberposts: 5, post_type: 'post', post_status: 'publish', orderby: 'date', order: 'DESC', ...args };
  doAction('rwp_pre_get_posts', query);
  const limit = query.posts_per_page ?? query.numberposts ?? 5;
  let request = client.from('pages').select('*');
  if (query.post_type && query.post_type !== 'any') {
    if (query.post_type === 'post') request = request.eq('is_post', true);
    else if (query.post_type === 'page') request = hasCustomPostTypes() ? request.eq('is_post', false).is('post_type', null) : request.eq('is_post', false);
    else request = request.eq('post_type', query.post_type);
  }
  if (query.post_status && query.post_status !== 'any') request = request.eq('status', dbStatus(query.post_status));
  if (query.s) request = request.ilike('title', `%${query.s.replace(/[%_]/g, '')}%`);
  if (query.cat) request = request.eq('category_id', query.cat);
  if (query.name) request = request.eq('slug', query.name);
  if (query.include?.length) request = request.in('id', query.include);
  request = request.order(ORDER_COLUMN[query.orderby || 'date'] || 'created_at', { ascending: String(query.order).toUpperCase() === 'ASC' });
  if (limit > 0) {
    const from = query.offset ?? 0;
    request = request.range(from, from + limit - 1);
  }
  const { data, error } = await request;
  if (error) return [];
  const posts = ((data || []) as Row[]).map(rwp_post_from_row);
  return applyFilters<RWP_Post[]>('rwp_the_posts', posts, query);
}

/** The status of a post in WordPress's words, or false. */
export async function rwp_get_post_status(post: number | { ID?: number; id?: number }): Promise<string | false> {
  const found = await rwp_get_post(post);
  return found ? applyFilters<string>('rwp_get_post_status', found.post_status, found) : false;
}

/** The public address of a post or page. Needs the post object (or its slug), so it needs no query. */
export function rwp_get_permalink(post: { post_name?: string; slug?: string; ID?: number; id?: number } | string, leaveName = false): string {
  const slug = typeof post === 'string' ? post : (post.post_name ?? post.slug ?? '');
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  const url = slug ? `${base}/${leaveName ? '%postname%' : slug}` : `${base}/`;
  return applyFilters<string>('rwp_post_link', url, typeof post === 'string' ? { post_name: post } : post, leaveName);
}

export interface PostArray {
  ID?: number;
  post_title?: string;
  post_name?: string;
  post_content?: string;
  post_excerpt?: string;
  post_status?: 'publish' | 'draft' | 'trash';
  post_type?: string;
  category_id?: string | null;
}

/**
 * Inserts a post (no ID) or updates one (with ID). Runs WordPress's whole lifecycle: the
 * rwp_insert_post_data filter, rwp_pre_post_update, then — once the database confirmed the write —
 * transition_post_status, save_post and wp_insert_post. Returns the post id, or 0 on failure; with
 * `wpError` true it returns an RWP_Error describing the failure instead.
 */
export async function rwp_insert_post(postarr: PostArray, wpError = false): Promise<number | RWP_Error> {
  const fail = (code: string, message: string): number | RWP_Error => (wpError ? new RWP_Error(code, message) : 0);
  const existing = postarr.ID ? await rwp_get_post(postarr.ID) : null;
  if (postarr.ID && !existing) return fail('invalid_post', 'Invalid post ID.');
  const { data: userData } = await client.auth.getUser();
  if (!userData.user) return fail('not_signed_in', 'You must be signed in to save content.');

  const title = rwp_strip_all_tags(postarr.post_title ?? existing?.post_title ?? '');
  const slug = rwp_sanitize_title(postarr.post_name || title, '');
  if (!title || !slug || applyFilters<boolean>('rwp_insert_post_empty_content', false, postarr)) return fail('empty_content', 'A title and a slug are required.');
  const type = postarr.post_type ?? existing?.post_type ?? 'post';
  if (!rwp_post_type_exists(type)) return fail('invalid_post_type', `Invalid post type "${type}".`);
  const status = dbStatus(postarr.post_status ?? existing?.post_status ?? 'draft');
  const row = {
    title,
    slug,
    content: postarr.post_content ?? existing?.post_content ?? '',
    excerpt: postarr.post_excerpt ?? existing?.post_excerpt ?? '',
    status,
    is_post: type === 'post',
    // Only a custom type names its type: the column may not exist on a database that has none.
    ...(type === 'post' || type === 'page' ? {} : { post_type: type }),
    category_id: type === 'post' ? (postarr.category_id ?? (existing?.category_id as string | null | undefined) ?? null) : null,
    updated_at: new Date().toISOString(),
    author_id: existing?.post_author ?? userData.user.id,
  };
  const data = filterPostData(row, { id: existing?.ID ?? null, update: Boolean(existing) });
  if (existing) firePrePostUpdate(existing.ID, data);
  const result = existing
    ? await client.from('pages').update(data).eq('id', existing.ID).select('id')
    : await client.from('pages').insert(data).select('id');
  if (result.error) return fail('db_insert_error', result.error.code === '23505' ? 'That slug is already in use.' : result.error.message);
  const savedId = existing?.ID ?? (result.data as Array<{ id: number }> | null)?.[0]?.id;
  if (savedId === undefined || (existing && !((result.data as unknown[] | null)?.length))) {
    return fail('db_insert_error', 'The database did not save this row. Your role may not be allowed to change it.');
  }
  firePostSaved({
    id: savedId,
    post: { ...data, id: savedId } as PostRow,
    previous: existing ? (existing as unknown as PostRow) : null,
    update: Boolean(existing),
  });
  return savedId;
}

/** rwp_insert_post for an existing post (`ID` is required). */
export async function rwp_update_post(postarr: PostArray & { ID: number }, wpError = false): Promise<number | RWP_Error> {
  if (!postarr.ID) return wpError ? new RWP_Error('invalid_post', 'Invalid post ID.') : 0;
  return rwp_insert_post(postarr, wpError);
}

/** Moves a post to the trash. Fires wp_trash_post and trashed_post. */
export async function rwp_trash_post(post: number | { ID?: number; id?: number }): Promise<RWP_Post | false> {
  const found = await rwp_get_post(post);
  if (!found || found.post_status === 'trash') return false;
  const result = await setContentStatus([{ id: found.ID, status: dbStatus(found.post_status), is_post: found.post_type === 'post', title: found.post_title }], 'trash');
  return result.changed.length ? { ...found, post_status: 'trash', status: 'trash' } : false;
}

/** Restores a trashed post as a draft. */
export async function rwp_untrash_post(post: number | { ID?: number; id?: number }): Promise<RWP_Post | false> {
  const found = await rwp_get_post(post);
  if (!found || found.post_status !== 'trash') return false;
  const result = await setContentStatus([{ id: found.ID, status: 'trash', is_post: found.post_type === 'post', title: found.post_title }], 'draft');
  return result.changed.length ? { ...found, post_status: 'draft', status: 'draft' } : false;
}

/** Trashes a post, or deletes it permanently with `forceDelete`. Returns the post, or false. */
export async function rwp_delete_post(post: number | { ID?: number; id?: number }, forceDelete = false): Promise<RWP_Post | false> {
  const found = await rwp_get_post(post);
  if (!found) return false;
  if (!forceDelete && found.post_status !== 'trash') return rwp_trash_post(found);
  const result = await deleteContent([{ id: found.ID, status: dbStatus(found.post_status), is_post: found.post_type === 'post', title: found.post_title }]);
  return result.changed.length ? found : false;
}

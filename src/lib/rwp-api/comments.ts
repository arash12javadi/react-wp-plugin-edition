/**
 * WordPress's comment functions over public.comments.
 *
 * Rows come back in WordPress's shape (`comment_ID`, `comment_post_ID`, `comment_content`,
 * `comment_author`, `comment_approved`, `comment_date`, `comment_parent`, `user_id`) beside the
 * original columns. `comment_approved` is '1', '0' or 'spam'. Every function is async. Who may
 * write is decided by row level security: moderators change statuses, an author may delete their own.
 * A refused write comes back as false (or an RWP_Error where WordPress returns one).
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client } from '../db';
import { fireCommentInserted, fireCommentsDeleted, fireCommentsDeleting, fireCommentStatusChanged, filterCommentData, toWpCommentStatus, type CommentRow } from './commentEvents';
import { RWP_Error } from './errors';
import { rwp_strip_all_tags } from './formatting';

type Row = Record<string, unknown> & { id: number };

export interface RWP_Comment extends Record<string, unknown> {
  comment_ID: number;
  id: number;
  comment_post_ID: number;
  comment_content: string;
  comment_author: string;
  comment_approved: '1' | '0' | 'spam';
  comment_date: string | null;
  comment_parent: number;
  comment_type: 'comment';
  user_id: string | null;
}

const dbStatus = (value: string): string => {
  if (value === '1' || value === 'approve' || value === 'approved') return 'approved';
  if (value === '0' || value === 'hold' || value === 'unapproved' || value === 'pending') return 'pending';
  return value;
};

export function rwp_comment_from_row(row: Row): RWP_Comment {
  const typed = row as Row & { page_id?: number; content?: string; author_name?: string; status?: string; created_at?: string; parent_id?: number | null; author_id?: string | null };
  const wp = toWpCommentStatus(typed.status);
  return {
    ...row,
    comment_ID: row.id,
    comment_post_ID: Number(typed.page_id ?? 0),
    comment_content: typed.content ?? '',
    comment_author: typed.author_name ?? '',
    comment_approved: wp === 'approved' ? '1' : wp === 'spam' ? 'spam' : '0',
    comment_date: typed.created_at ?? null,
    comment_parent: Number(typed.parent_id ?? 0),
    comment_type: 'comment',
    user_id: typed.author_id ?? null,
  } as RWP_Comment;
}

/** One comment by id, or null. */
export async function rwp_get_comment(id: number | string): Promise<RWP_Comment | null> {
  const { data, error } = await client.from('comments').select('*').eq('id', Number(id)).maybeSingle();
  if (error || !data) return null;
  return applyFilters<RWP_Comment>('rwp_get_comment', rwp_comment_from_row(data as Row));
}

export interface CommentsQuery {
  post_id?: number;
  /** 'approve' / 'approved' (default), 'hold' / 'unapproved', 'spam', or 'all'. */
  status?: string;
  number?: number;
  offset?: number;
  orderby?: 'comment_date' | 'comment_ID';
  order?: 'ASC' | 'DESC';
  parent?: number;
}

/** Comments matching a WordPress-style query. Filtered through `rwp_comments_array`. */
export async function rwp_get_comments(args: CommentsQuery = {}): Promise<RWP_Comment[]> {
  const query = { status: 'approve', order: 'DESC', orderby: 'comment_date', ...args } as CommentsQuery;
  let request = client.from('comments').select('*');
  if (query.post_id) request = request.eq('page_id', query.post_id);
  if (query.status && query.status !== 'all') request = request.eq('status', dbStatus(query.status));
  if (query.parent !== undefined) request = query.parent ? request.eq('parent_id', query.parent) : request.is('parent_id', null);
  request = request.order(query.orderby === 'comment_ID' ? 'id' : 'created_at', { ascending: String(query.order).toUpperCase() === 'ASC' });
  if (query.number) request = request.range(query.offset ?? 0, (query.offset ?? 0) + query.number - 1);
  const { data, error } = await request;
  if (error) return [];
  const comments = ((data || []) as Row[]).map(rwp_comment_from_row);
  return applyFilters<RWP_Comment[]>('rwp_comments_array', comments, query.post_id ?? 0);
}

export interface CommentArray {
  comment_post_ID: number;
  comment_content: string;
  comment_author?: string;
  comment_parent?: number;
  comment_approved?: '1' | '0' | 'spam' | number;
}

/**
 * Inserts a comment as the signed-in person. Runs rwp_preprocess_comment, then rwp_insert_comment and
 * rwp_comment_post once the database confirmed it. Returns the id, or false when the database refused
 * (a closed post, a missing sign-in, row level security).
 */
export async function rwp_insert_comment(commentdata: CommentArray): Promise<number | false> {
  const { data: userData } = await client.auth.getUser();
  if (!userData.user) return false;
  const row = filterCommentData({
    page_id: commentdata.comment_post_ID,
    parent_id: commentdata.comment_parent || null,
    author_id: userData.user.id,
    author_name: rwp_strip_all_tags(commentdata.comment_author ?? userData.user.email?.split('@')[0] ?? ''),
    content: commentdata.comment_content,
    status: commentdata.comment_approved === 1 || commentdata.comment_approved === '1' ? 'approved' : 'pending',
  });
  const { data, error } = await client.from('comments').insert(row).select('id');
  if (error) return false;
  const id = (data as Array<{ id: number }> | null)?.[0]?.id;
  if (id === undefined) return false;
  fireCommentInserted({ ...row, id });
  return id;
}

/** Changes a comment's status: 'approve', 'hold', 'spam', 'trash' (as 'spam' is the only other status React-WP stores). */
export async function rwp_set_comment_status(commentId: number, status: string, wpError = false): Promise<boolean | RWP_Error> {
  const before = await rwp_get_comment(commentId);
  if (!before) return wpError ? new RWP_Error('invalid_comment', 'Invalid comment ID.') : false;
  const next = dbStatus(status);
  const { data, error } = await client.from('comments').update({ status: next }).eq('id', commentId).select('id');
  if (error || !(data as unknown[] | null)?.length) return wpError ? new RWP_Error('db_update_error', error?.message ?? 'The database skipped this row. Moderating comments needs the moderate_comments capability.') : false;
  fireCommentStatusChanged([before as unknown as CommentRow], next, new Map([[commentId, String(before.status)]]));
  return true;
}

/** Deletes a comment (and its replies). Fires rwp_delete_comment and rwp_deleted_comment. */
export async function rwp_delete_comment(commentId: number): Promise<boolean> {
  const before = await rwp_get_comment(commentId);
  if (!before) return false;
  fireCommentsDeleting([before as unknown as CommentRow]);
  const { data, error } = await client.from('comments').delete().eq('id', commentId).select('id');
  if (error || !(data as unknown[] | null)?.length) return false;
  fireCommentsDeleted([before as unknown as CommentRow]);
  return true;
}

export interface CommentUpdate {
  comment_ID: number;
  comment_content?: string;
  comment_author?: string;
  comment_approved?: '1' | '0' | 'spam' | number;
}

/**
 * Changes a comment's text, author name or status. Runs `rwp_wp_update_comment_data`, then
 * rwp_edit_comment(id, data) once the database confirmed it. Returns 1 when changed, 0 when nothing
 * changed, or an RWP_Error. A refused row (moderating needs moderate_comments) is an error, not a 0.
 */
export async function rwp_update_comment(commentarr: CommentUpdate, wpError = false): Promise<number | RWP_Error> {
  const fail = (code: string, message: string): number | RWP_Error => (wpError ? new RWP_Error(code, message) : 0);
  const before = await rwp_get_comment(commentarr.comment_ID);
  if (!before) return fail('invalid_comment_id', 'Invalid comment ID.');
  const data = applyFilters<CommentUpdate>('rwp_update_comment_data', commentarr, before, commentarr);
  const changes: Record<string, unknown> = {};
  if (data.comment_content !== undefined) changes.content = data.comment_content;
  if (data.comment_author !== undefined) changes.author_name = rwp_strip_all_tags(data.comment_author);
  if (data.comment_approved !== undefined) changes.status = dbStatus(String(data.comment_approved));
  if (!Object.keys(changes).length) return 0;
  const { data: rows, error } = await client.from('comments').update(changes).eq('id', commentarr.comment_ID).select('id');
  if (error || !(rows as unknown[] | null)?.length) return fail('db_update_error', error?.message ?? 'The database skipped this comment. Editing comments needs moderate_comments.');
  if (changes.status && changes.status !== before.status) {
    fireCommentStatusChanged([before as unknown as CommentRow], String(changes.status), new Map([[before.id, String(before.status)]]));
  }
  doAction('rwp_edit_comment', commentarr.comment_ID, data);
  return 1;
}

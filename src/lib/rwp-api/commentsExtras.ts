/**
 * More comment functions: readers for a comment's fields, counts, status changes, and the open/closed
 * flags. Comment objects are rwp_get_comment()'s; counts and status changes are async.
 *
 * Not provided: pings and trackbacks (React-WP has none), the comment-form and comment-list renderers
 * (the Comments section is a React component with its own theme blocks), and flood control.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { rwp_get_comment, rwp_get_comments, rwp_set_comment_status, rwp_insert_comment, type CommentArray, type RWP_Comment } from './comments';
import { rwp_esc_attr, rwp_esc_html, rwp_esc_url, rwp_trim_words } from './formatting';
import { fireCommentStatusChanged, toWpCommentStatus, type CommentRow } from './commentEvents';
import { rwp_get_queried_object } from './query';

type C = Pick<RWP_Comment, 'comment_ID' | 'comment_content' | 'comment_author' | 'comment_date' | 'comment_approved'> & Record<string, unknown>;

export const rwp_get_comment_ID = (comment: C): number => comment.comment_ID;
export const rwp_get_comment_author = (comment: C): string => applyFilters<string>('rwp_get_comment_author', comment.comment_author || 'Anonymous', comment.comment_ID, comment);
export const rwp_get_comment_author_email = (comment: C): string => applyFilters<string>('rwp_get_comment_author_email', String(comment.author_email ?? ''), comment.comment_ID, comment);
export const rwp_get_comment_author_url = (comment: C): string => applyFilters<string>('rwp_get_comment_author_url', String(comment.author_url ?? ''), comment.comment_ID, comment);
export const rwp_get_comment_author_IP = (): string => '';
export const rwp_get_comment_date = (comment: C, format = ''): string => applyFilters<string>('rwp_get_comment_date', format ? String(new Date(String(comment.comment_date)).toLocaleDateString()) : String(comment.comment_date ?? ''), format, comment);
export const rwp_get_comment_time = (comment: C): string => applyFilters<string>('rwp_get_comment_time', comment.comment_date ? new Date(String(comment.comment_date)).toLocaleTimeString() : '', '', false, true, comment);
export const rwp_get_comment_type = (): 'comment' => 'comment';
export const rwp_get_comment_text = (comment: C): string => applyFilters<string>('rwp_get_comment_text', String(comment.comment_content ?? ''), comment, {});
export const rwp_get_comment_excerpt = (comment: C): string => applyFilters<string>('rwp_get_comment_excerpt', rwp_trim_words(String(comment.comment_content ?? ''), 20), comment.comment_ID, comment);

/** The comment's text through `rwp_comment_text`, returned (WordPress echoes it). */
export const rwp_comment_text = (comment: C): string => applyFilters<string>('rwp_comment_text', rwp_get_comment_text(comment), comment, {});

export const rwp_comment_author = (comment: C): string => applyFilters<string>('rwp_comment_author', rwp_get_comment_author(comment), comment.comment_ID);
export const rwp_comment_author_email = (comment: C): string => rwp_get_comment_author_email(comment);
export const rwp_comment_author_url = (comment: C): string => rwp_get_comment_author_url(comment);
export const rwp_comment_date = (comment: C, format = ''): string => rwp_get_comment_date(comment, format);
export const rwp_comment_time = (comment: C): string => rwp_get_comment_time(comment);
export const rwp_comment_excerpt = (comment: C): string => applyFilters<string>('rwp_comment_excerpt', rwp_get_comment_excerpt(comment), comment.comment_ID);
export const rwp_comment_type = rwp_get_comment_type;
export const rwp_comment_ID = rwp_get_comment_ID;

/** The author's name as a link when they gave a website. */
export function rwp_get_comment_author_link(comment: C): string {
  const url = rwp_get_comment_author_url(comment);
  const name = rwp_esc_html(rwp_get_comment_author(comment));
  const html = url ? `<a href="${rwp_esc_attr(rwp_esc_url(url))}" rel="external nofollow ugc" class="url">${name}</a>` : name;
  return applyFilters<string>('rwp_get_comment_author_link', html, comment.comment_author, comment.comment_ID);
}

export const rwp_comment_author_link = (comment: C): string => rwp_get_comment_author_link(comment);

/** A comment's address: the post's, with #comment-id. */
export function rwp_get_comment_link(comment: C & { comment_post_ID?: number }, postAddress = ''): string {
  const base = postAddress || (typeof window === 'undefined' ? '' : window.location.pathname);
  return applyFilters<string>('rwp_get_comment_link', `${base}#comment-${comment.comment_ID}`, comment, {}, 0);
}

export const rwp_comment_link = rwp_get_comment_link;

// Counts -------------------------------------------------------------------------------------------------------

interface CommentCounts { approved: number; moderated: number; spam: number; 'post-trashed': number; total_comments: number; all: number }

/** Counts of comments by status, for one post or the whole site. */
export async function rwp_count_comments(postId = 0): Promise<CommentCounts> {
  let request = client.from('comments').select('status');
  if (postId) request = request.eq('page_id', postId);
  const { data } = await request.limit(20000);
  const counts: CommentCounts = { approved: 0, moderated: 0, spam: 0, 'post-trashed': 0, total_comments: 0, all: 0 };
  for (const row of (data || []) as Array<{ status: string | null }>) {
    const status = toWpCommentStatus(row.status);
    if (status === 'approved') counts.approved += 1;
    else if (status === 'spam') counts.spam += 1;
    else counts.moderated += 1;
    counts.total_comments += 1;
    if (status !== 'spam') counts.all += 1;
  }
  return applyFilters<CommentCounts>('rwp_count_comments', counts, postId);
}

/** The same counts in WordPress's get_comment_count shape. */
export async function rwp_get_comment_count(postId = 0): Promise<{ approved: number; awaiting_moderation: number; spam: number; trash: number; 'post-trashed': number; total_comments: number; all: number }> {
  const c = await rwp_count_comments(postId);
  return { approved: c.approved, awaiting_moderation: c.moderated, spam: c.spam, trash: 0, 'post-trashed': c['post-trashed'], total_comments: c.total_comments, all: c.all };
}

/** How many approved comments a post has (the post, or the one on screen). */
export async function rwp_get_comments_number(post: number | { ID?: number } = 0): Promise<number> {
  const id = typeof post === 'object' ? Number(post.ID ?? 0) : post || Number(rwp_get_queried_object().post?.ID ?? 0);
  const count = (await rwp_count_comments(id)).approved;
  return applyFilters<number>('rwp_get_comments_number', count, id);
}

export const rwp_comments_number = rwp_get_comments_number;

/** The number of comments waiting for approval. */
export async function rwp_get_pending_comments_num(postId: number | number[] = 0): Promise<number | Record<number, number>> {
  if (Array.isArray(postId)) return Object.fromEntries(await Promise.all(postId.map(async (id) => [id, (await rwp_count_comments(id)).moderated] as const)));
  return (await rwp_count_comments(postId)).moderated;
}

/** The approved comments of a post. */
export const rwp_get_approved_comments = (postId: number, args: { number?: number } = {}): Promise<RWP_Comment[]> => rwp_get_comments({ post_id: postId, status: 'approve', ...args });

/** Whether a comment with this id exists: its id, or null. */
export async function rwp_comment_exists(commentId: number): Promise<number | null> {
  return (await rwp_get_comment(commentId))?.comment_ID ?? null;
}

export const rwp_get_comment_statuses = (): Record<string, string> => ({ hold: 'Unapproved', approve: 'Approved', spam: 'Spam', trash: 'Trash' });

/** The status of a comment in WordPress's words: 'approved', 'unapproved', 'spam', or false. */
export async function rwp_get_comment_status(comment: number | C): Promise<string | false> {
  const found = typeof comment === 'object' ? comment : await rwp_get_comment(comment);
  if (!found) return false;
  const s = found.comment_approved === '1' ? 'approved' : found.comment_approved === 'spam' ? 'spam' : 'unapproved';
  return s;
}

// Posting and moderating --------------------------------------------------------------------------------------------

/** Adds a comment as the signed-in person (rwp_insert_comment with WordPress's `new comment` filters). Returns the id. */
export async function rwp_new_comment(commentdata: CommentArray): Promise<number | false> {
  const data = applyFilters<CommentArray>('rwp_preprocess_comment', commentdata);
  return rwp_insert_comment(data);
}

export const rwp_spam_comment = async (id: number): Promise<boolean> => Boolean(await rwp_set_comment_status(id, 'spam'));
export const rwp_unspam_comment = async (id: number): Promise<boolean> => Boolean(await rwp_set_comment_status(id, 'approve'));

/** Fires the status-transition hooks for a change you made yourself. */
export function rwp_transition_comment_status(newStatus: string, oldStatus: string, comment: C): void {
  fireCommentStatusChanged([{ id: comment.comment_ID, ...comment } as unknown as CommentRow], newStatus, new Map([[comment.comment_ID, oldStatus]]));
}

// Flags -----------------------------------------------------------------------------------------------------------------

/** Whether comments are open on a post (the post's flag; open unless it was switched off). */
export function rwp_comments_open(post: { comments_open?: boolean } | number | null = null): boolean {
  const found = typeof post === 'object' && post ? post : (rwp_get_queried_object().post as { comments_open?: boolean } | null | undefined);
  return applyFilters<boolean>('rwp_comments_open', found?.comments_open !== false, typeof post === 'number' ? post : 0);
}

/** Pings and trackbacks do not exist. */
export const rwp_pings_open = (): boolean => applyFilters<boolean>('rwp_pings_open', false, 0);

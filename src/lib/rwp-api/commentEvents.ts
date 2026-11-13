/**
 * WordPress's comment lifecycle hooks, fired from the writers of public.comments.
 *
 *   rwp_preprocess_comment (filter)              the comment about to be stored
 *   rwp_insert_comment(id, comment)              WordPress's wp_insert_comment
 *   rwp_comment_post(id, approved, comment)      approved is 1 (approved), 0 (awaiting) or 'spam'
 *   rwp_transition_comment_status(new, old, comment)
 *   rwp_comment_{old}_to_{new}(comment)
 *   rwp_comment_{new}_{type}(id, comment)
 *   rwp_set_comment_status(id, status)           WordPress's wp_set_comment_status
 *   rwp_delete_comment(id, comment) / rwp_deleted_comment(id, comment)
 *
 * Status names are WordPress's: React-WP's 'pending' is 'unapproved' here.
 */
import { applyFilters, doAction } from '../../core/hooks';

export interface CommentRow {
  id: number;
  status?: string | null;
  [key: string]: unknown;
}

export const toWpCommentStatus = (status: string | null | undefined): string => {
  if (!status || status === 'pending' || status === 'hold') return 'unapproved';
  return status;
};

const asWpComment = (row: CommentRow) => ({
  ...row,
  comment_ID: row.id,
  comment_approved: toWpCommentStatus(row.status) === 'approved' ? '1' : toWpCommentStatus(row.status) === 'spam' ? 'spam' : '0',
  comment_type: 'comment',
});

/** Runs the comment about to be stored through `rwp_preprocess_comment`. Anything but an object is ignored. */
export function filterCommentData<T extends Record<string, unknown>>(data: T): T {
  const filtered = applyFilters<T>('rwp_preprocess_comment', data);
  return filtered && typeof filtered === 'object' && !Array.isArray(filtered) ? filtered : data;
}

/** After a comment was stored and the database returned its id. */
export function fireCommentInserted(row: CommentRow): void {
  const comment = asWpComment(row);
  doAction('rwp_insert_comment', row.id, comment);
  const approved = comment.comment_approved === '1' ? 1 : comment.comment_approved === 'spam' ? 'spam' : 0;
  doAction('rwp_comment_post', row.id, approved, comment);
}

/** After the database confirmed a status change for these comments. `previous` holds the old status by id. */
export function fireCommentStatusChanged(rows: CommentRow[], newStatus: string, previous: Map<number, string | null | undefined>): void {
  const next = toWpCommentStatus(newStatus);
  for (const row of rows) {
    const old = toWpCommentStatus(previous.get(row.id));
    const comment = asWpComment({ ...row, status: newStatus });
    if (old !== next) {
      doAction('rwp_transition_comment_status', next, old, comment);
      doAction(`rwp_comment_${old}_to_${next}`, comment);
      doAction(`rwp_comment_${next}_${comment.comment_type}`, row.id, comment);
    }
    if (next === 'spam' && old !== 'spam') { doAction('rwp_spam_comment', row.id, comment); doAction('rwp_spammed_comment', row.id, comment); }
    if (old === 'spam' && next !== 'spam') { doAction('rwp_unspam_comment', row.id, comment); doAction('rwp_unspammed_comment', row.id, comment); }
    doAction('rwp_set_comment_status', row.id, next);
  }
}

/** Before and after permanent deletion; the database decides which rows really went. */
export function fireCommentsDeleting(rows: CommentRow[]): void {
  for (const row of rows) doAction('rwp_delete_comment', row.id, asWpComment(row));
}

export function fireCommentsDeleted(rows: CommentRow[]): void {
  for (const row of rows) doAction('rwp_deleted_comment', row.id, asWpComment(row));
}

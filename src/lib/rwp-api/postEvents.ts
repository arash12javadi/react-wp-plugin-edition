/**
 * The WordPress post lifecycle, fired from the places that really write public.pages.
 *
 * React-WP has no single save function (the editors, the bulk actions and the Page Builder each
 * write the table themselves), so this module is the one place that knows WordPress's hook order and
 * every writer calls it after a write that the database confirmed:
 *
 *   rwp_pre_post_update(id, data)                     before an update is sent
 *   rwp_insert_post_data (filter)                     the row about to be written
 *   rwp_transition_post_status(new, old, post)        only when the status changed ('new' for an insert)
 *   rwp_{old}_to_{new}(post)
 *   rwp_{new}_{type}(id, post, old)
 *   rwp_save_post_{type}(id, post, update)
 *   rwp_save_post(id, post, update)
 *   rwp_insert_post(id, post, update)                 WordPress's wp_insert_post
 *   rwp_after_insert_post(id, post, update, before)   WordPress's wp_after_insert_post
 *
 * The status names are WordPress's ('publish', not React-WP's 'published'), so a hook written from
 * WordPress documentation compares against the strings it expects. The older React-WP events
 * (rwp_post_created, rwp_post_updated with one object, rwp_page_*) were removed: this is the one
 * lifecycle, and rwp_post_updated(post_id, post_after, post_before) is WordPress's.
 */
import { applyFilters, doAction } from '../../core/hooks';

export interface PostRow {
  id: number;
  title?: string;
  slug?: string;
  status?: string | null;
  is_post?: boolean | null;
  [key: string]: unknown;
}

/** React-WP's status values on the way to WordPress's. */
export const toWpStatus = (status: string | null | undefined): string => {
  if (!status) return 'draft';
  return status === 'published' ? 'publish' : status;
};

/** 'post' for a blog post, 'page' for a static page. Site templates are pages. */
export const postTypeOf = (row: Pick<PostRow, 'is_post'>): 'post' | 'page' => (row.is_post ? 'post' : 'page');

/** The row as a plugin sees it: WordPress's status vocabulary plus a post_type. */
export const asWpPost = (row: PostRow): PostRow & { post_type: string; post_status: string; ID: number } => ({
  ...row,
  ID: row.id,
  post_type: postTypeOf(row),
  post_status: toWpStatus(row.status),
});

/**
 * Runs the row about to be written through `rwp_insert_post_data`. A filter that returns something
 * other than an object is ignored, so a broken plugin cannot turn a save into a write of nothing.
 */
export function filterPostData<T extends Record<string, unknown>>(data: T, context: { id?: number | null; update: boolean }): T {
  const filtered = applyFilters<T>('rwp_insert_post_data', data, { id: context.id ?? null }, context.update);
  return filtered && typeof filtered === 'object' && !Array.isArray(filtered) ? filtered : data;
}

/** Before an existing post is updated. */
export function firePrePostUpdate(id: number, data: Record<string, unknown>): void {
  doAction('rwp_pre_post_update', id, data);
}

interface SavedArgs {
  id: number;
  /** The row after the write. */
  post: PostRow;
  /** The row before it, for an update. */
  previous?: PostRow | null;
  update: boolean;
}

/** After a post was inserted or updated and the database confirmed it. */
export function firePostSaved({ id, post, previous, update }: SavedArgs): void {
  const after = asWpPost({ ...post, id });
  const before = previous ? asWpPost(previous) : null;
  const type = after.post_type;
  const newStatus = after.post_status;
  const oldStatus = update && before ? before.post_status : 'new';

  if (newStatus !== oldStatus) {
    doAction('rwp_transition_post_status', newStatus, oldStatus, after);
    doAction(`rwp_${oldStatus}_to_${newStatus}`, after);
  }
  doAction(`rwp_${newStatus}_${type}`, id, after, oldStatus);
  if (update && before) doAction('rwp_post_updated', id, after, before);
  if (update) {
    doAction(`rwp_edit_post_${type}`, id, after);
    doAction('rwp_edit_post', id, after);
  }
  doAction(`rwp_save_post_${type}`, id, after, update);
  doAction('rwp_save_post', id, after, update);
  doAction('rwp_insert_post', id, after, update);
  doAction('rwp_after_insert_post', id, after, update, before);
}

/** Moving to or from the trash, on top of the status transition. */
export function firePostTrashChange(row: PostRow, from: string | null | undefined, to: string): void {
  const previousStatus = toWpStatus(from);
  if (to === 'trash' && previousStatus !== 'trash') {
    doAction('rwp_trash_post', row.id, previousStatus);
    doAction('rwp_trashed_post', row.id, previousStatus);
  } else if (previousStatus === 'trash' && to !== 'trash') {
    doAction('rwp_untrash_post', row.id, 'trash');
    doAction('rwp_untrashed_post', row.id, 'trash');
  }
}

/** Before a post is permanently deleted. Fires for the rows requested; the database may still refuse some under RLS. */
export function fireBeforePostDelete(rows: PostRow[]): void {
  for (const row of rows) {
    const post = asWpPost(row);
    doAction('rwp_before_delete_post', row.id, post);
    doAction('rwp_delete_post', row.id, post);
    doAction(`rwp_delete_post_${post.post_type}`, row.id, post);
  }
}

/** After rows were permanently deleted and the database confirmed which. */
export function firePostDeleted(rows: PostRow[]): void {
  for (const row of rows) {
    const post = asWpPost(row);
    doAction('rwp_deleted_post', row.id, post);
    doAction(`rwp_deleted_post_${post.post_type}`, row.id, post);
    doAction('rwp_after_delete_post', row.id, post);
  }
}

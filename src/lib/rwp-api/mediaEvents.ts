/**
 * WordPress's attachment hooks, fired from the Media Library after the database confirmed the write.
 *
 *   rwp_add_attachment(id)                           a file was added to the library
 *   rwp_edit_attachment(id)                          a library entry was changed
 *   rwp_attachment_updated(id, after, before)
 *   rwp_delete_attachment(id, attachment)            just before an entry is deleted
 *
 * Attachment ids are the media row's uuid (WordPress uses an integer post id). The "attachment"
 * argument is the media row. Moving a file to another library folder is an edit; the file itself is
 * never touched.
 */
import { doAction } from '../../core/hooks';

export interface MediaRow {
  id: string;
  [key: string]: unknown;
}

export function fireAttachmentAdded(row: MediaRow): void {
  doAction('rwp_add_attachment', row.id);
}

export function fireAttachmentUpdated(after: MediaRow, before?: MediaRow | null): void {
  doAction('rwp_edit_attachment', after.id);
  doAction('rwp_attachment_updated', after.id, after, before ?? after);
}

export function fireAttachmentDeleting(rows: MediaRow[]): void {
  for (const row of rows) doAction('rwp_delete_attachment', row.id, row);
}

/**
 * WordPress's attachment functions over the Media Library (public.media).
 *
 * An attachment id is the media row's uuid (WordPress's is an integer). The file lives at the storage
 * provider (Cloudinary, ImageKit ...), so there are no generated sizes on disk: every "size" is the
 * original, and rwp_get_attachment_image_src() says so with `false` in its fourth element. Every
 * function is async.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { rwp_esc_attr, rwp_esc_url } from './formatting';

interface MediaRow {
  id: string;
  title: string | null;
  alt_text: string | null;
  url: string;
  file_name: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  mime_type: string | null;
  folder?: string;
}

async function row(id: string | number): Promise<MediaRow | null> {
  const { data } = await client.from('media').select('*').eq('id', String(id)).maybeSingle();
  return (data as MediaRow | null) ?? null;
}

/** The public address of an attachment, or false. */
export async function rwp_get_attachment_url(attachmentId: string | number = 0): Promise<string | false> {
  const media = await row(attachmentId);
  if (!media) return false;
  const url = applyFilters<string | false>('rwp_get_attachment_url', media.url, String(attachmentId));
  return url || false;
}

/** [url, width, height, is_intermediate] for an image. `size` is accepted and ignored: there is one size. */
export async function rwp_get_attachment_image_src(attachmentId: string | number, size: string | number[] = 'thumbnail', icon = false): Promise<[string, number, number, boolean] | false> {
  void icon;
  const media = await row(attachmentId);
  if (!media || !(media.mime_type ?? '').startsWith('image/')) return false;
  const image: [string, number, number, boolean] = [media.url, media.width ?? 0, media.height ?? 0, false];
  return applyFilters<[string, number, number, boolean] | false>('rwp_get_attachment_image_src', image, String(attachmentId), size, icon);
}

/** An <img> element as a string, with the alt text. `attr` adds or overrides attributes. */
export async function rwp_get_attachment_image(attachmentId: string | number, size: string | number[] = 'thumbnail', icon = false, attr: Record<string, string> = {}): Promise<string> {
  const media = await row(attachmentId);
  const src = media ? await rwp_get_attachment_image_src(attachmentId, size, icon) : false;
  if (!media || !src) return '';
  const attributes = applyFilters<Record<string, string>>('rwp_get_attachment_image_attributes', {
    src: src[0], class: `attachment-${typeof size === 'string' ? size : 'custom'} size-${typeof size === 'string' ? size : 'custom'}`, alt: media.alt_text ?? '', loading: 'lazy', decoding: 'async',
    ...(src[1] ? { width: String(src[1]) } : {}), ...(src[2] ? { height: String(src[2]) } : {}), ...attr,
  }, media, size);
  const html = `<img ${Object.entries(attributes).map(([key, value]) => `${key}="${key === 'src' ? rwp_esc_url(value) : rwp_esc_attr(value)}"`).join(' ')} />`;
  return applyFilters<string>('rwp_get_attachment_image', html, String(attachmentId), size, icon, attr);
}

/** What WordPress keeps in `_wp_attachment_metadata`: width, height, file and size. */
export async function rwp_get_attachment_metadata(attachmentId: string | number = 0, unfiltered = false): Promise<Record<string, unknown> | false> {
  void unfiltered;
  const media = await row(attachmentId);
  if (!media) return false;
  const data = { width: media.width ?? 0, height: media.height ?? 0, file: media.file_name ?? '', filesize: media.bytes ?? 0, sizes: {}, image_meta: {} };
  return applyFilters<Record<string, unknown> | false>('rwp_get_attachment_metadata', data, String(attachmentId));
}

/** The attachment whose address is `url`, or 0. */
export async function rwp_attachment_url_to_postid(url: string): Promise<string | 0> {
  const { data } = await client.from('media').select('id').eq('url', url).limit(1).maybeSingle();
  const id = (data as { id: string } | null)?.id ?? 0;
  return applyFilters<string | 0>('rwp_attachment_url_to_postid', id, url);
}

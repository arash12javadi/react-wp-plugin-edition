/**
 * Site information, dates, text typography, pagination and upload types.
 *
 * Nothing here needs more than the browser and the site settings, so most of it is synchronous. The
 * exception is rwp_get_bloginfo(): the site name and tagline come from the saved settings, so it is
 * async.
 */
import { applyFilters } from '../../core/hooks';
import { getLocale } from '../i18n';
import { loadSettings } from '../settings';
import { rwp_esc_attr, rwp_esc_html, rwp_esc_url } from './formatting';

const origin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);

/**
 * Information about the site: 'name', 'description', 'url', 'wpurl', 'siteurl', 'home', 'language',
 * 'charset', 'html_type', 'text_direction', 'version'. Async: the name and tagline are saved settings.
 * Private values such as 'admin_email' are not available from the browser and answer ''.
 */
export async function rwp_get_bloginfo(show = '', filter = 'raw'): Promise<string> {
  void filter;
  let output = '';
  switch (show) {
    case 'name': output = (await loadSettings().catch(() => null))?.site_title ?? ''; break;
    case 'description': output = (await loadSettings().catch(() => null))?.site_tagline ?? ''; break;
    case 'url': case 'wpurl': case 'siteurl': case 'home': output = applyFilters<string>('rwp_bloginfo_url', origin(), show); break;
    case 'language': output = getLocale(); break;
    case 'charset': output = 'UTF-8'; break;
    case 'html_type': output = 'text/html'; break;
    case 'text_direction': output = /^(ar|fa|he|ur|ps|sd|ckb|ug|yi|dv)(-|_|$)/i.test(getLocale()) ? 'rtl' : 'ltr'; break;
    case 'version': output = 'react-wp'; break;
    default: output = (await loadSettings().catch(() => null))?.site_title ?? '';
  }
  return applyFilters<string>('rwp_bloginfo', output, show);
}

/** WordPress's bloginfo(): the same as rwp_get_bloginfo, returned instead of echoed. */
export const rwp_bloginfo = rwp_get_bloginfo;

// Dates ---------------------------------------------------------------------------------------------

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const dayOfYear = (d: Date, utc: boolean): number => {
  const start = utc ? Date.UTC(d.getUTCFullYear(), 0, 1) : new Date(d.getFullYear(), 0, 1).getTime();
  const now = utc ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((now - start) / 86400000);
};

const isoWeek = (d: Date, utc: boolean): { week: number; year: number } => {
  const t = new Date(Date.UTC(utc ? d.getUTCFullYear() : d.getFullYear(), utc ? d.getUTCMonth() : d.getMonth(), utc ? d.getUTCDate() : d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return { week: Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7), year: t.getUTCFullYear() };
};

/**
 * Formats a UNIX timestamp (seconds) with PHP's date() letters: d D j l N S w z W F m M n t L o Y y
 * a A g G h H i s u e T P O Z c r U. Escape a letter with a backslash. `timezone` is 'UTC' or empty
 * (the browser's zone).
 */
export function rwp_date(format: string, timestamp: number | null = null, timezone: string | null = null): string | false {
  const seconds = timestamp ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(seconds)) return false;
  const d = new Date(seconds * 1000);
  const utc = /^(utc|gmt|z)$/i.test(timezone ?? '');
  const get = {
    Y: utc ? d.getUTCFullYear() : d.getFullYear(), m: (utc ? d.getUTCMonth() : d.getMonth()) + 1, d: utc ? d.getUTCDate() : d.getDate(),
    H: utc ? d.getUTCHours() : d.getHours(), i: utc ? d.getUTCMinutes() : d.getMinutes(), s: utc ? d.getUTCSeconds() : d.getSeconds(),
    w: utc ? d.getUTCDay() : d.getDay(),
  };
  const offset = utc ? 0 : -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  const hour12 = get.H % 12 || 12;
  const zone = utc ? 'UTC' : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const suffix = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const iso = isoWeek(d, utc);
  const letters: Record<string, () => string> = {
    d: () => pad(get.d), D: () => DAYS[get.w].slice(0, 3), j: () => String(get.d), l: () => DAYS[get.w], N: () => String(get.w || 7), S: () => suffix(get.d),
    w: () => String(get.w), z: () => String(dayOfYear(d, utc)), W: () => pad(iso.week), F: () => MONTHS[get.m - 1], m: () => pad(get.m), M: () => MONTHS[get.m - 1].slice(0, 3),
    n: () => String(get.m), t: () => String(new Date(get.Y, get.m, 0).getDate()), L: () => (leap(get.Y) ? '1' : '0'), o: () => String(iso.year), Y: () => String(get.Y),
    y: () => pad(get.Y % 100), a: () => (get.H < 12 ? 'am' : 'pm'), A: () => (get.H < 12 ? 'AM' : 'PM'), g: () => String(hour12), G: () => String(get.H), h: () => pad(hour12),
    H: () => pad(get.H), i: () => pad(get.i), s: () => pad(get.s), u: () => '000000', v: () => '000', e: () => zone, T: () => (utc ? 'UTC' : zone),
    P: () => `${sign}${oh}:${om}`, p: () => (offset === 0 ? 'Z' : `${sign}${oh}:${om}`), O: () => `${sign}${oh}${om}`, Z: () => String(offset * 60), U: () => String(seconds),
    c: () => `${get.Y}-${pad(get.m)}-${pad(get.d)}T${pad(get.H)}:${pad(get.i)}:${pad(get.s)}${sign}${oh}:${om}`,
    r: () => `${DAYS[get.w].slice(0, 3)}, ${pad(get.d)} ${MONTHS[get.m - 1].slice(0, 3)} ${get.Y} ${pad(get.H)}:${pad(get.i)}:${pad(get.s)} ${sign}${oh}${om}`,
  };
  let out = '';
  for (let i = 0; i < format.length; i += 1) {
    const ch = format[i];
    if (ch === '\\') { out += format[i + 1] ?? ''; i += 1; } else out += letters[ch] ? letters[ch]() : ch;
  }
  return applyFilters<string | false>('rwp_date', out, format, seconds, timezone);
}

/**
 * The current time. `type` is 'mysql' (Y-m-d H:i:s), 'timestamp' (UNIX seconds), 'U', or a PHP date
 * format. With `gmt` it is UTC, otherwise the browser's zone. Note: the browser's clock, not the server's.
 */
export function rwp_current_time(type: string = 'mysql', gmt: boolean | number = false): string | number {
  const now = Math.floor(Date.now() / 1000);
  const zone = gmt ? 'UTC' : null;
  const result: string | number = type === 'timestamp' || type === 'U' ? now : (rwp_date(type === 'mysql' ? 'Y-m-d H:i:s' : type, now, zone) as string);
  return result;
}

// Typography --------------------------------------------------------------------------------------------

/** Smart quotes, dashes and ellipses, as WordPress's wptexturize() does for plain text (tags are left alone). */
export function rwptexturize(text: string): string {
  return String(text ?? '').split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) return part;
    return part
      .replace(/\.\.\./g, '…')
      .replace(/(^|[\s([{])"/g, '$1“').replace(/"/g, '”')
      .replace(/(^|[\s([{])'/g, '$1‘').replace(/'/g, '’')
      .replace(/\s--\s/g, ' — ').replace(/(\w)--(\w)/g, '$1—$2')
      .replace(/(\d)x(\d)/g, '$1×$2');
  }).join('');
}

// Pagination ----------------------------------------------------------------------------------------------

export interface PaginateArgs {
  base?: string;
  format?: string;
  total?: number;
  current?: number;
  show_all?: boolean;
  end_size?: number;
  mid_size?: number;
  prev_next?: boolean;
  prev_text?: string;
  next_text?: string;
  type?: 'plain' | 'list' | 'array';
  add_args?: Record<string, string>;
}

/**
 * Page links for archives, as HTML (type 'plain' or 'list') or an array of strings (type 'array'). `base`
 * holds a %_% placeholder replaced by `format` (default "?paged=%#%") for pages after the first.
 */
export function rwp_paginate_links(args: PaginateArgs = {}): string | string[] {
  const a = { base: '%_%', format: '?paged=%#%', total: 1, current: 1, show_all: false, end_size: 1, mid_size: 2, prev_next: true, prev_text: '« Previous', next_text: 'Next »', type: 'plain', add_args: undefined, ...args } as Required<PaginateArgs>;
  const total = Math.max(1, Math.floor(a.total));
  const current = Math.min(Math.max(1, Math.floor(a.current)), total);
  if (total < 2) return a.type === 'array' ? [] : '';
  const link = (n: number): string => {
    const query = n > 1 ? a.format.replace('%#%', String(n)) : '';
    let url = a.base.replace('%_%', query);
    if (a.add_args) url += `${url.includes('?') ? '&' : '?'}${new URLSearchParams(a.add_args).toString()}`;
    return rwp_esc_url(url) || '/';
  };
  const items: string[] = [];
  if (a.prev_next && current > 1) items.push(`<a class="prev page-numbers" href="${rwp_esc_attr(link(current - 1))}">${a.prev_text}</a>`);
  let dots = false;
  for (let n = 1; n <= total; n += 1) {
    const show = a.show_all || n <= a.end_size || (n >= current - a.mid_size && n <= current + a.mid_size) || n > total - a.end_size;
    if (show) {
      dots = true;
      items.push(n === current
        ? `<span aria-current="page" class="page-numbers current">${rwp_esc_html(n)}</span>`
        : `<a class="page-numbers" href="${rwp_esc_attr(link(n))}">${rwp_esc_html(n)}</a>`);
    } else if (dots) {
      items.push('<span class="page-numbers dots">…</span>');
      dots = false;
    }
  }
  if (a.prev_next && current < total) items.push(`<a class="next page-numbers" href="${rwp_esc_attr(link(current + 1))}">${a.next_text}</a>`);
  const out = a.type === 'array' ? items : a.type === 'list' ? `<ul class="page-numbers">\n\t<li>${items.join('</li>\n\t<li>')}</li>\n</ul>` : items.join('\n');
  return applyFilters<string | string[]>('rwp_paginate_links', out);
}

// Upload types ----------------------------------------------------------------------------------------------

/** The file types uploads may use: { 'jpg|jpeg|jpe': 'image/jpeg', ... }. `rwp_upload_mimes` changes the list. */
export function rwp_get_allowed_mime_types(): Record<string, string> {
  const defaults: Record<string, string> = {
    'jpg|jpeg|jpe': 'image/jpeg', gif: 'image/gif', png: 'image/png', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
    pdf: 'application/pdf', 'doc|docx': 'application/msword', 'xls|xlsx': 'application/vnd.ms-excel', 'ppt|pptx': 'application/vnd.ms-powerpoint',
    txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', 'mp3|m4a': 'audio/mpeg', wav: 'audio/wav', 'mp4|m4v': 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  };
  return applyFilters<Record<string, string>>('rwp_upload_mimes', defaults, null);
}

/** The extension and mime type of a file name when its type is allowed, otherwise { ext: false, type: false }. */
export function rwp_check_filetype(filename: string, mimes: Record<string, string> | null = null): { ext: string | false; type: string | false } {
  const list = mimes ?? rwp_get_allowed_mime_types();
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  for (const [pattern, type] of Object.entries(list)) {
    if (pattern.split('|').includes(ext)) return { ext, type };
  }
  return { ext: false, type: false };
}

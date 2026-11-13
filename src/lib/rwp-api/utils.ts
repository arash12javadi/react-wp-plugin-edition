/**
 * WordPress's small pure helpers (functions.php, formatting.php, link-template.php): lists, query
 * strings, URLs, uuids, dates and a few text cleaners. All synchronous, none touches the database.
 *
 * PHP serialisation (maybe_serialize, is_serialized) is not provided: values are JSON here.
 */
import { applyFilters } from '../../core/hooks';
import { getLocale } from '../i18n';
import { rwp_date } from './site';
import { rwp_esc_url } from './formatting';

type Obj = Record<string, unknown>;

// Lists -------------------------------------------------------------------------------------------------

/** The value of `field` from each item; with `indexKey`, an object keyed by that field. */
export function rwp_list_pluck(list: Obj[], field: string, indexKey: string | null = null): unknown[] | Record<string, unknown> {
  if (indexKey === null) return list.map((item) => item[field]);
  return Object.fromEntries(list.map((item) => [String(item[indexKey]), item[field]]));
}

/** The items whose fields match `args` ('AND'), any of them ('OR') or none of them ('NOT'). With `field`, only that field. */
export function rwp_list_filter(list: Obj[], args: Obj = {}, operator: 'AND' | 'OR' | 'NOT' = 'AND', field: string | false = false): unknown[] {
  const keys = Object.keys(args);
  const kept = keys.length === 0 ? list : list.filter((item) => {
    const matches = keys.filter((key) => item[key] === args[key]).length;
    if (operator === 'AND') return matches === keys.length;
    if (operator === 'OR') return matches > 0;
    return matches === 0;
  });
  return field ? kept.map((item) => item[field]) : kept;
}

/** Sorts a list of objects by one or more fields. `orderby` is a field name or { field: 'ASC' | 'DESC' }. */
export function rwp_list_sort<T extends Obj>(list: T[], orderby: string | Record<string, 'ASC' | 'DESC'> = {}, order: 'ASC' | 'DESC' = 'ASC'): T[] {
  const rules = typeof orderby === 'string' ? { [orderby]: order } : orderby;
  return [...list].sort((a, b) => {
    for (const [key, direction] of Object.entries(rules)) {
      const x = a[key] as string | number; const y = b[key] as string | number;
      if (x === y) continue;
      const result = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return direction.toUpperCase() === 'DESC' ? -result : result;
    }
    return 0;
  });
}

/** Only the listed keys of an object. */
export function rwp_array_slice_assoc<T extends Obj>(source: T, keys: string[]): Partial<T> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]])) as Partial<T>;
}

/** Whether every key of an array is a number (an ordinary list, not a map). */
export function rwp_is_numeric_array(data: unknown): boolean {
  return Array.isArray(data);
}

/** 'yes'/'true'/'1'/'on' -> true; 'false'/'0'/'' -> false. */
export function rwp_validate_boolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.toLowerCase() === 'false') return false;
  return Boolean(value) && value !== '0' && value !== 0;
}

let uniqueCounter = 0;

/** A unique id for this page load, with an optional prefix. */
export function rwp_unique_id(prefix = ''): string {
  uniqueCounter += 1;
  return `${prefix}${uniqueCounter}`;
}

/** A random version 4 uuid from the browser's secure generator. */
export function rwp_generate_uuid4(): string {
  return globalThis.crypto.randomUUID();
}

// URLs ---------------------------------------------------------------------------------------------------

/** Adds or changes query arguments on a URL (default: the current address). `null` removes one. */
export function rwp_add_query_arg(args: Record<string, string | number | boolean | null>, url?: string): string {
  const base = url ?? (typeof window === 'undefined' ? '' : window.location.href);
  const hash = base.includes('#') ? base.slice(base.indexOf('#')) : '';
  const [path, query = ''] = base.replace(hash, '').split('?');
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(args)) {
    if (value === null) params.delete(key); else params.set(key, String(value));
  }
  const text = params.toString();
  return `${path}${text ? `?${text}` : ''}${hash}`;
}

/** Removes query arguments from a URL (default: the current address). */
export function rwp_remove_query_arg(keys: string | string[], url?: string): string {
  return rwp_add_query_arg(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, null])), url);
}

/** Builds a query string from an object; arrays become key[]=... */
export function rwp_build_query(data: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => params.append(`${key}[]`, String(item))); else params.set(key, String(value));
  }
  return params.toString();
}

/** The parts of a URL, or false. `component` returns one part: 'scheme', 'host', 'port', 'path', 'query', 'fragment'. */
export function rwp_parse_url(url: string, component = -1): Record<string, string> | string | false | null {
  try {
    const parsed = new URL(url, 'http://placeholder.invalid');
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url);
    const parts: Record<string, string> = {};
    if (!relative) { parts.scheme = parsed.protocol.replace(':', ''); parts.host = parsed.hostname; if (parsed.port) parts.port = parsed.port; }
    if (parsed.pathname && (!relative || url.startsWith('/'))) parts.path = parsed.pathname;
    if (parsed.search) parts.query = parsed.search.slice(1);
    if (parsed.hash) parts.fragment = parsed.hash.slice(1);
    return component === -1 ? parts : parts[String(component)] ?? null;
  } catch {
    return false;
  }
}

/** The URL when it is a well-formed http or https address, otherwise false. */
export function rwp_http_validate_url(url: string): string | false {
  try {
    const parsed = new URL(url);
    const ok = /^https?:$/.test(parsed.protocol) && Boolean(parsed.hostname);
    return ok ? url : false;
  } catch {
    return false;
  }
}

/** Makes an absolute URL on this site relative ("/path?query"). Other addresses are returned unchanged. */
export function rwp_make_link_relative(link: string): string {
  if (typeof window === 'undefined') return link;
  return link.startsWith(window.location.origin) ? link.slice(window.location.origin.length) || '/' : link;
}

/** esc_url for storing: no HTML entity encoding of the quote. */
export const rwp_esc_url_raw = (url: unknown, protocols: string[] | null = null): string => rwp_esc_url(url, protocols).replace(/&#039;/g, "'");

/** encodeURIComponent applied to every string in a value. */
export function rwp_urlencode_deep<T>(value: T): T {
  if (typeof value === 'string') return encodeURIComponent(value) as unknown as T;
  if (Array.isArray(value)) return value.map(rwp_urlencode_deep) as unknown as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rwp_urlencode_deep(v)])) as T;
  return value;
}

/** The last part of a path (PHP's basename, safe for any slashes). */
export const rwp_basename = (path: string, suffix = ''): string => {
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
};

// Dates ----------------------------------------------------------------------------------------------------

/** Whether year-month-day is a real date. */
export function rwp_checkdate(month: number, day: number, year: number, sourceDate = ''): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  const ok = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  return applyFilters<boolean>('rwp_checkdate', ok, sourceDate);
}

/** The browser's time zone name. */
export const rwp_timezone_string = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** A "Y-m-d H:i:s" (UTC) string formatted with a PHP date format; `translate` is accepted and ignored. */
export function rwp_mysql2date(format: string, date: string, translate = true): string | number | false {
  void translate;
  const ms = Date.parse(`${date.replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return false;
  const seconds = Math.floor(ms / 1000);
  return format === 'G' || format === 'U' ? seconds : rwp_date(format, seconds, 'UTC');
}

/** A UTC "Y-m-d H:i:s" date as a local one. */
export function rwp_get_date_from_gmt(string: string, format = 'Y-m-d H:i:s'): string {
  const ms = Date.parse(`${string.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? '' : (rwp_date(format, Math.floor(ms / 1000)) as string);
}

/** A local "Y-m-d H:i:s" date as a UTC one. */
export function rwp_get_gmt_from_date(string: string, format = 'Y-m-d H:i:s'): string {
  const ms = Date.parse(string.replace(' ', 'T'));
  return Number.isNaN(ms) ? '' : (rwp_date(format, Math.floor(ms / 1000), 'UTC') as string);
}

/** A number formatted for the active language: 1234.5 -> "1,234.5" (or the locale's own separators). */
export function rwp_number_format_i18n(number: number, decimals = 0): string {
  const formatted = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(number);
  return applyFilters<string>('rwp_number_format_i18n', formatted, number, decimals);
}

// Text -------------------------------------------------------------------------------------------------------

/** Accented letters to plain ones: "Café" -> "Cafe". */
export function rwp_remove_accents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/Æ/g, 'AE').replace(/æ/g, 'ae').replace(/Ø/g, 'O').replace(/ø/g, 'o').replace(/Đ/g, 'D').replace(/đ/g, 'd');
}

/** A user name: letters, digits, spaces and . _ @ - only. */
export function rwp_sanitize_user(username: string, strict = false): string {
  let clean = String(username).replace(/<[^>]*>/g, '').replace(/%[a-f0-9]{2}/gi, '');
  clean = strict ? clean.replace(/[^a-z0-9 _.\-@]/gi, '') : clean.replace(/[^\w .\-@*]/g, '');
  clean = clean.trim().replace(/ +/g, ' ');
  return applyFilters<string>('rwp_sanitize_user', clean, username, strict);
}

/** A mime type with only the characters one may contain. */
export function rwp_sanitize_mime_type(mimeType: string): string {
  const clean = String(mimeType).replace(/[^-+*.a-zA-Z0-9=/]/g, '');
  return applyFilters<string>('rwp_sanitize_mime_type', clean, mimeType);
}

/** The first `length` characters of a text, tags removed, with `more` appended when cut. */
export function rwp_html_excerpt(text: string, length: number, more: string | null = null): string {
  const plain = String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const ellipsis = more ?? '…';
  return plain.length > length ? `${plain.slice(0, length)}${ellipsis}` : plain;
}

/** An excerpt made from content: the first words, through `rwp_excerpt_length` and `rwp_excerpt_more`. */
export function rwp_trim_excerpt(text = ''): string {
  const length = applyFilters<number>('rwp_excerpt_length', 55);
  const more = applyFilters<string>('rwp_excerpt_more', '…');
  const words = String(text).replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean);
  const excerpt = words.length > length ? `${words.slice(0, length).join(' ')}${more}` : words.join(' ');
  return applyFilters<string>('rwp_trim_excerpt', excerpt, text);
}

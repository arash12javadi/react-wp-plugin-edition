/**
 * The rest of WordPress's text helpers that make sense in a browser: deep transforms, entity and
 * whitespace cleaners, colours, link rel, shortened URLs, sprintf.
 *
 * kses internals (wp_kses_split, wp_kses_hair ...) are not provided: rwp_kses and rwp_kses_post do the
 * job with the browser's own parser. SQL escaping (esc_sql) has no meaning without SQL strings.
 */
import { applyFilters } from '../../core/hooks';
import { rwp_esc_url, rwp_strip_all_tags, rwp_unslash } from './formatting';

type Deep = unknown;

/** Applies `callback` to every scalar inside an array or object. */
export function rwp_map_deep<T>(value: T, callback: (item: unknown) => unknown): T {
  if (Array.isArray(value)) return value.map((item) => rwp_map_deep(item, callback)) as unknown as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rwp_map_deep(v, callback)])) as T;
  return callback(value) as T;
}

export const rwp_stripslashes_deep = <T>(value: T): T => rwp_unslash(value);
export const rwp_urldecode_deep = <T>(value: T): T => rwp_map_deep(value, (v) => (typeof v === 'string' ? decodeURIComponent(v.replace(/\+/g, ' ')) : v));
export const rwp_rawurlencode_deep = <T>(value: T): T => rwp_map_deep(value, (v) => (typeof v === 'string' ? encodeURIComponent(v) : v));
export const rwp_stripslashes_from_strings_only = (value: Deep): Deep => (typeof value === 'string' ? rwp_unslash(value) : value);

/** Parses a query string into an object, as PHP's parse_str. Filtered through `rwp_parse_str`. */
export function rwp_parse_str(input: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(input)) {
    const list = /^(.*)\[\]$/.exec(key);
    if (list) out[list[1]] = [...(Array.isArray(out[list[1]]) ? (out[list[1]] as string[]) : []), value];
    else out[key] = value;
  }
  return applyFilters<Record<string, string | string[]>>('rwp_parse_str', out);
}

/** Collapses runs of whitespace to one space and trims. */
export const rwp_normalize_whitespace = (text: string): string => text.replace(/[\s ]+/g, ' ').trim();

/** Removes backslashes before a character. */
export const rwp_backslashit = (value: string): string => value.replace(/^(\d)/, '\\\\$1').replace(/([a-z])/gi, '\\$1');

/** A tag name safe to use as an element or hook suffix. */
export const rwp_tag_escape = (tagName: string): string => applyFilters<string>('rwp_tag_escape', tagName.replace(/[^a-z0-9-_:]/gi, '').toLowerCase(), tagName);

/** Validates a URL for storing, as esc_url_raw does (alias of rwp_esc_url without the entity encoding). */
export const rwp_sanitize_url = (url: string, protocols: string[] | null = null): string => rwp_esc_url(url, protocols).replace(/&#039;/g, "'");

/** Shortens a URL for display: no scheme, cut with … after `length`. */
export function rwp_url_shorten(url: string, length = 35): string {
  const bare = url.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:www\.)?/i, '').replace(/\/$/, '');
  return bare.length > length ? `${bare.slice(0, length - 3)}…` : bare;
}

/** The first URL found in a text, or '' (WordPress's get_url_in_content, for plain text and <a href>). */
export function rwp_get_url_in_content(content: string): string | false {
  const link = /<a\s[^>]*href=(["'])(.*?)\1/i.exec(content);
  return link ? rwp_esc_url(link[2]) || false : false;
}

/** A #rgb or #rrggbb colour, or '' / null when it is not one. */
export function rwp_sanitize_hex_color(color: string): string | null {
  return /^#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(color) ? color : null;
}

export function rwp_sanitize_hex_color_no_hash(color: string): string | null {
  const clean = color.replace(/^#/, '');
  return rwp_sanitize_hex_color(`#${clean}`) ? clean : null;
}

/** Adds the hash to a bare hex colour. */
export function rwp_maybe_hash_hex_color(color: string): string {
  const clean = rwp_sanitize_hex_color_no_hash(color);
  return clean ? `#${clean}` : color;
}

/** Adds rel="nofollow" to every link in the HTML. */
export function rwp_rel_nofollow(html: string): string {
  return html.replace(/<a\s([^>]*)>/gi, (whole, attrs: string) => (/\brel=/.test(attrs) ? whole.replace(/\brel=(["'])(.*?)\1/i, (_m, q: string, v: string) => `rel=${q}${[...new Set([...v.split(/\s+/), 'nofollow'])].join(' ')}${q}`) : `<a ${attrs} rel="nofollow">`));
}

export const rwp_rel_ugc = (html: string): string => rwp_rel_nofollow(html).replace(/rel="nofollow"/g, 'rel="nofollow ugc"');

/** A plain-text excerpt-safe version of text with entities decoded once. */
export function rwp_htmlentities2(text: string): string {
  return text.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Escapes text for use inside XML. */
export function rwp_esc_xml(text: string): string {
  const safe = text.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return applyFilters<string>('rwp_esc_xml', safe, text);
}

/** Closes unclosed tags (a simple balancer for fragments). */
export function rwp_balanceTags(text: string, force = false): string {
  void force;
  const stack: string[] = [];
  const voids = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
  let out = '';
  const pattern = /<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>|[^<]+|</gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (!m[2]) { out += m[0]; continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.lastIndexOf(tag);
      if (at === -1) continue;
      while (stack.length > at) out += `</${stack.pop()}>`;
    } else {
      out += m[0];
      if (!m[3] && !voids.has(tag)) stack.push(tag);
    }
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

export const rwp_force_balance_tags = (text: string): string => rwp_balanceTags(text, true);

/** Removes shortcode text (`[tag attr]`) left in plain text without removing the content between tags. */
export function rwp_strip_shortcode_tag(match: string): string {
  return rwp_strip_all_tags(match).replace(/\[[^\]]*\]/g, '');
}

/** PHP-style sprintf: %s, %d, %f, %%, %1$s positions and %05.2f padding. */
export function rwp_sprintf(format: string, ...args: unknown[]): string {
  let next = 0;
  return format.replace(/%(?:(\d+)\$)?([-+ 0]*)(\d+)?(?:\.(\d+))?([sdfFeExXobc%])/g, (whole, pos: string | undefined, flags: string, width: string | undefined, precision: string | undefined, type: string) => {
    if (type === '%') return '%';
    const value = args[pos ? Number(pos) - 1 : next++];
    let out: string;
    if (type === 'd') out = String(Math.trunc(Number(value)));
    else if (type === 'f' || type === 'F') out = Number(value).toFixed(precision === undefined ? 6 : Number(precision));
    else if (type === 'x') out = Number(value).toString(16);
    else if (type === 'X') out = Number(value).toString(16).toUpperCase();
    else if (type === 'o') out = Number(value).toString(8);
    else if (type === 'b') out = Number(value).toString(2);
    else if (type === 'c') out = String.fromCharCode(Number(value));
    else out = precision !== undefined ? String(value).slice(0, Number(precision)) : String(value);
    if (flags.includes('+') && /^\d/.test(out) && (type === 'd' || type === 'f')) out = `+${out}`;
    if (width) out = flags.includes('-') ? out.padEnd(Number(width)) : out.padStart(Number(width), flags.includes('0') ? '0' : ' ');
    return whole && out;
  });
}

/** A list in words: "a, b and c". */
export function rwp_sprintf_l(pattern: string, args: string[]): string {
  const list = args.length < 2 ? args.join('') : `${args.slice(0, -1).join(', ')} and ${args[args.length - 1]}`;
  return pattern.replace(/%l/g, list);
}

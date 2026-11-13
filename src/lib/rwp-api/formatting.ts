/**
 * WordPress's escaping, sanitising and text helpers (wp-includes/formatting.php, kses.php), under the
 * same names with the rwp_ prefix. All of them are synchronous and pure, and each applies the filter
 * WordPress applies, so a ported plugin's filters keep working.
 *
 * Escape late, sanitise early, as in WordPress:
 *   - rwp_esc_*  make a value safe for the place it is about to be printed (HTML text, an attribute,
 *     a URL, inline JavaScript). Use them when you build a string of markup yourself. Text rendered
 *     by React is already escaped; do not escape it twice.
 *   - rwp_sanitize_* clean input before it is stored or compared.
 *
 * `rwp_kses` and `rwp_kses_post` need a DOM. Outside a browser they fall back to stripping every
 * tag, which is the safe direction.
 */
import { applyFilters } from '../../core/hooks';

const ENTITY = /&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi;

const escapeSpecial = (text: string, doubleEncode = false): string => {
  const amp = doubleEncode ? text.replace(/&/g, '&amp;') : text.replace(ENTITY, '&amp;');
  return amp.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
};

/** Makes text safe for an HTML text node. Valid entities already in it are kept, as in WordPress. */
export function rwp_esc_html(text: unknown): string {
  const raw = String(text ?? '');
  return applyFilters<string>('rwp_esc_html', escapeSpecial(raw), raw);
}

/** Makes text safe for an HTML attribute value. */
export function rwp_esc_attr(text: unknown): string {
  const raw = String(text ?? '');
  return applyFilters<string>('rwp_attribute_escape', escapeSpecial(raw), raw);
}

/** Makes text safe for the inside of a <textarea>. */
export function rwp_esc_textarea(text: unknown): string {
  const raw = String(text ?? '');
  return applyFilters<string>('rwp_esc_textarea', escapeSpecial(raw, true), raw);
}

/** Makes text safe for a string literal in inline JavaScript. */
export function rwp_esc_js(text: unknown): string {
  const raw = String(text ?? '');
  const safe = escapeSpecial(raw).replace(/\\/g, '\\\\').replace(/&#039;/g, "\\'").replace(/\r?\n/g, '\\n').replace(/\r/g, '');
  return applyFilters<string>('rwp_js_escape', safe, raw);
}

/** Reverses rwp_esc_html for the five characters it changes. */
export function rwp_specialchars_decode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
}

const SAFE_PROTOCOLS = ['http', 'https', 'ftp', 'ftps', 'mailto', 'news', 'irc', 'irc6', 'ircs', 'gopher', 'nntp', 'feed', 'telnet', 'mms', 'rtsp', 'sms', 'svn', 'tel', 'fax', 'xmpp', 'webcal', 'urn'];

/**
 * Makes a URL safe to put in an href or src. Returns '' for a scheme that is not allowed (so
 * `javascript:` and `data:` are dropped). A relative URL, a #fragment and a ?query are fine.
 */
export function rwp_esc_url(url: unknown, protocols: string[] | null = null): string {
  const raw = String(url ?? '');
  // eslint-disable-next-line no-control-regex
  let clean = raw.trim().replace(/[\u0000-\u001f\u007f\s]+/g, (run) => (run.includes(' ') ? '%20' : ''));
  if (!clean) return applyFilters<string>('rwp_clean_url', '', raw, 'display');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean.replace(/%20/g, ''));
  if (scheme && !(protocols ?? SAFE_PROTOCOLS).includes(scheme[1].toLowerCase())) clean = '';
  else clean = clean.replace(/'/g, '&#039;').replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  return applyFilters<string>('rwp_clean_url', clean, raw, 'display');
}

/** Removes every tag, including the contents of <script> and <style>. */
export function rwp_strip_all_tags(text: unknown, removeBreaks = false): string {
  let out = String(text ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '');
  if (removeBreaks) out = out.replace(/[\r\n\t ]+/g, ' ');
  return out.trim();
}

const checkInvalidUtf8 = (text: string): string => text.replace(/�/g, '');

const sanitizeTextual = (value: unknown, keepNewlines: boolean): string => {
  if (typeof value === 'object' && value !== null) return '';
  let filtered = checkInvalidUtf8(String(value ?? ''));
  filtered = rwp_strip_all_tags(filtered, false);
  if (!keepNewlines) filtered = filtered.replace(/[\r\n\t ]+/g, ' ');
  else filtered = filtered.replace(/[ \t]+/g, ' ').replace(/ ?\r?\n ?/g, '\n');
  // Percent-encoded octets are an old trick for smuggling markup past a filter.
  return filtered.replace(/%[a-f0-9]{2}/gi, '').trim();
};

/** Cleans a single-line text input: no tags, no line breaks, collapsed whitespace. */
export function rwp_sanitize_text_field(value: unknown): string {
  return applyFilters<string>('rwp_sanitize_text_field', sanitizeTextual(value, false), String(value ?? ''));
}

/** Like rwp_sanitize_text_field but keeps line breaks. */
export function rwp_sanitize_textarea_field(value: unknown): string {
  return applyFilters<string>('rwp_sanitize_textarea_field', sanitizeTextual(value, true), String(value ?? ''));
}

/** Lowercase letters, digits, dashes and underscores only. For keys and slugs of settings. */
export function rwp_sanitize_key(key: unknown): string {
  const raw = String(key ?? '');
  return applyFilters<string>('rwp_sanitize_key', raw.toLowerCase().replace(/[^a-z0-9_-]/g, ''), raw);
}

/** A URL-safe slug. Letters with accents lose them; letters outside Latin are dropped. */
export function rwp_sanitize_title_with_dashes(title: unknown): string {
  return String(title ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&[^;\s]+;/g, '')
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function rwp_sanitize_title(title: unknown, fallback = ''): string {
  const raw = String(title ?? '');
  const slug = rwp_sanitize_title_with_dashes(rwp_strip_all_tags(raw));
  return applyFilters<string>('rwp_sanitize_title', slug || fallback, raw, fallback, 'save');
}

/** Returns the address when it is valid, '' otherwise. */
export function rwp_sanitize_email(email: unknown): string {
  const raw = String(email ?? '');
  const cleaned = raw.trim().replace(/[^a-z0-9+_.@-]/gi, '');
  const valid = /^[a-z0-9+_.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(cleaned) && cleaned.length <= 254;
  return applyFilters<string>('rwp_sanitize_email', valid ? cleaned : '', cleaned, valid ? null : 'email_invalid');
}

/** Whether a string is an email address; returns it, or false. */
export function rwp_is_email(email: unknown): string | false {
  const raw = String(email ?? '');
  const valid = /^[a-z0-9+_.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(raw) && raw.length >= 6 && raw.length <= 254;
  return applyFilters<string | false>('rwp_is_email', valid ? raw : false, raw, valid ? null : 'email_invalid');
}

/** A file name with nothing in it a file system or a URL would object to. */
export function rwp_sanitize_file_name(name: unknown): string {
  const raw = String(name ?? '');
  const cleaned = raw
    .replace(/[?[\]/\\=<>:;,'"&$#*()|~`!{}%+‘’“” –—]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-_]+|[.\-_]+$/g, '');
  return applyFilters<string>('rwp_sanitize_file_name', cleaned, raw);
}

/** A string usable as an HTML class name. */
export function rwp_sanitize_html_class(value: unknown, fallback = ''): string {
  const raw = String(value ?? '');
  const cleaned = raw.replace(/%[a-f0-9]{2}/gi, '').replace(/[^A-Za-z0-9_-]/g, '');
  return applyFilters<string>('rwp_sanitize_html_class', cleaned || fallback, raw, fallback);
}

/** A non-negative integer. */
export function rwp_absint(value: unknown): number {
  return Math.abs(Math.trunc(Number(value))) || 0;
}

type AllowedAttributes = Record<string, boolean | Record<string, unknown>>;
export type AllowedHtml = Record<string, AllowedAttributes | boolean | []>;

const POST_ATTRIBUTES: AllowedAttributes = {
  href: true, src: true, alt: true, title: true, class: true, id: true, width: true, height: true, rel: true, target: true,
  colspan: true, rowspan: true, lang: true, dir: true, loading: true, datetime: true, cite: true, name: true, align: true,
};

/** The tags `rwp_kses_post` keeps: what an author may put in a post. */
export const RWP_ALLOWED_POST_TAGS: AllowedHtml = Object.fromEntries([
  'a', 'abbr', 'acronym', 'address', 'b', 'bdo', 'big', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del',
  'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var',
].map((tag) => [tag, POST_ATTRIBUTES]));

const URL_ATTRIBUTES = new Set(['href', 'src', 'cite', 'action', 'poster']);

/**
 * Keeps only the tags and attributes in `allowed` (tag -> attribute names), drops everything else,
 * and removes URL attributes whose scheme is not safe. Text content is always kept.
 */
export function rwp_kses(html: string, allowed: AllowedHtml = RWP_ALLOWED_POST_TAGS): string {
  const source = String(html ?? '');
  if (typeof document === 'undefined') return rwp_strip_all_tags(source);
  const template = document.createElement('template');
  template.innerHTML = source;
  const walk = (parent: Element | DocumentFragment) => {
    [...parent.children].forEach((element) => {
      const tag = element.tagName.toLowerCase();
      const rule = allowed[tag];
      if (!rule) {
        // Unknown element: drop its tag but keep (and sanitise) its children, except for the ones
        // whose contents are code, which go with the tag.
        if (/^(script|style|iframe|object|embed|template|noscript|textarea)$/.test(tag)) {
          element.remove();
          return;
        }
        walk(element);
        element.replaceWith(...element.childNodes);
        return;
      }
      [...element.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const permitted = rule === true || (typeof rule === 'object' && !Array.isArray(rule) && Boolean(rule[name]))
          || name.startsWith('data-') && typeof rule === 'object' && !Array.isArray(rule) && Boolean(rule['data-*']);
        if (!permitted || name.startsWith('on') || (URL_ATTRIBUTES.has(name) && rwp_esc_url(attribute.value) === '')) {
          element.removeAttribute(attribute.name);
        }
      });
      walk(element);
    });
  };
  walk(template.content);
  return template.innerHTML;
}

/** The allowed set for post content. WordPress's wp_kses_post. */
export function rwp_kses_post(html: string): string {
  return rwp_kses(html, applyFilters<AllowedHtml>('rwp_kses_allowed_html', RWP_ALLOWED_POST_TAGS, 'post'));
}

/** Allows no tags at all. WordPress's wp_kses_data's strictest sibling. */
export function rwp_kses_data(html: string): string {
  return rwp_kses(html, { a: { href: true, title: true }, abbr: { title: true }, b: {}, blockquote: { cite: true }, cite: {}, code: {}, del: { datetime: true }, em: {}, i: {}, q: { cite: true }, strike: {}, strong: {} });
}

/** Turns paragraphs separated by blank lines into <p> elements and single line breaks into <br />. */
export function rwpautop(text: string, br = true): string {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) return '';
  const BLOCK = /^<(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)\b/i;
  const html = source.split(/\n\s*\n/).map((chunk) => {
    const part = chunk.trim();
    if (!part) return '';
    return BLOCK.test(part) ? part : `<p>${br ? part.replace(/\n/g, '<br />\n') : part}</p>`;
  }).filter(Boolean).join('\n');
  return html;
}

/** Turns bare URLs into links (with rel="nofollow", as WordPress does). */
export function rwp_make_clickable(text: string): string {
  return String(text ?? '').replace(/(^|[\s>(])((?:https?|ftp):\/\/[^\s<>"')]+)/gi, (_match, lead: string, url: string) => {
    const trail = /[.,;:!?]+$/.exec(url)?.[0] ?? '';
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `${lead}<a href="${rwp_esc_url(clean)}" rel="nofollow">${rwp_esc_html(clean)}</a>${trail}`;
  });
}

/** The first `num` words of a text, with tags removed. */
export function rwp_trim_words(text: string, num = 55, more: string | null = null): string {
  const ellipsis = more ?? '…';
  const words = rwp_strip_all_tags(text).split(/\s+/).filter(Boolean);
  const trimmed = words.length > num ? `${words.slice(0, num).join(' ')}${ellipsis}` : words.join(' ');
  return applyFilters<string>('rwp_trim_words', trimmed, num, ellipsis, text);
}

const mapDeep = (value: unknown, fn: (text: string) => string): unknown => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapDeep(v, fn)]));
  return value;
};

/** Removes the backslashes WordPress adds to input (stripslashes_deep). */
export function rwp_unslash<T>(value: T): T {
  return mapDeep(value, (text) => text.replace(/\\(.?)/g, '$1')) as T;
}

/** Adds slashes before quotes, backslashes and NUL (addslashes_gpc). */
export function rwp_slash<T>(value: T): T {
  return mapDeep(value, (text) => text.replace(/([\\'"])/g, '\\$1').replace(/\0/g, '\\0')) as T;
}

/** Merges user arguments over defaults. A query string ("a=1&b=2") is accepted as well as an object. */
export function rwp_parse_args<D extends Record<string, unknown>>(args: string | Record<string, unknown> | null | undefined, defaults: D): D & Record<string, unknown> {
  const parsed: Record<string, unknown> = typeof args === 'string'
    ? Object.fromEntries(new URLSearchParams(args))
    : { ...(args ?? {}) };
  return { ...defaults, ...parsed } as D & Record<string, unknown>;
}

/** JSON.stringify, named as WordPress's wp_json_encode. */
export function rwp_json_encode(data: unknown, flags = 0, depth = 512): string | false {
  void flags;
  void depth;
  try {
    return JSON.stringify(data) ?? false;
  } catch {
    return false;
  }
}

/** A random password from the browser's cryptographic generator. */
export function rwp_generate_password(length = 12, specialChars = true, extraSpecialChars = false): string {
  let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  if (specialChars) chars += '!@#$%^&*()';
  if (extraSpecialChars) chars += '-_ []{}<>~`+=,.;:/?|';
  const bytes = new Uint32Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[bytes[i] % chars.length];
  return applyFilters<string>('rwp_random_password', out, length, specialChars, extraSpecialChars);
}

/** Pads a number with leading zeros. */
export function rwp_zeroise(number: number | string, threshold: number): string {
  return String(number).padStart(threshold, '0');
}

export function rwp_trailingslashit(value: string): string {
  return `${value.replace(/[/\\]+$/, '')}/`;
}

export function rwp_untrailingslashit(value: string): string {
  return value.replace(/[/\\]+$/, '');
}

/** Forward slashes, no doubles. */
export function rwp_normalize_path(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/** "5 minutes", "2 days": the distance between two UNIX timestamps (in seconds). */
export function rwp_human_time_diff(from: number, to: number = Math.floor(Date.now() / 1000)): string {
  const diff = Math.abs(to - from);
  const steps: Array<[number, string]> = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  let since = `${Math.max(1, diff)} ${diff === 1 ? 'second' : 'seconds'}`;
  for (const [seconds, unit] of steps) {
    if (diff >= seconds) {
      const count = Math.round(diff / seconds);
      since = `${count} ${unit}${count === 1 ? '' : 's'}`;
      break;
    }
  }
  return applyFilters<string>('rwp_human_time_diff', since, diff, from, to);
}

/** "1.5 MB": a byte count in the largest sensible unit. */
export function rwp_size_format(bytes: number | string, decimals = 0): string | false {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return false;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

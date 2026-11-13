/**
 * WordPress's shortcode functions over the shortcode registry.
 *
 *   add_shortcode( 'greeting', function ( $atts, $content, $tag ) { ... } )
 *   -> rwp_add_shortcode('greeting', (atts, content, tag) => <p>Hello {atts.name}</p>)
 *
 * On the public site shortcodes are rendered by React inside ContentRenderer, so a callback may
 * return a React node as well as a string. `rwp_do_shortcode` (text in, text out) can only run
 * callbacks that return strings; a shortcode that returns a React node is left as written there.
 * Shortcode names are lowercase letters, digits, dashes and underscores.
 */
import type { ReactNode } from 'react';
import { applyFilters } from '../../core/hooks';
import { rwp } from '../rwp';

export type ShortcodeAtts = Record<string, string>;
export type ShortcodeCallback = (atts: ShortcodeAtts, content: string | null, tag: string) => ReactNode;

const callbacks = new Map<string, ShortcodeCallback>();
const removers = new Map<string, () => void>();

const VALID = /^[a-z0-9_-]+$/;

/** Registers a shortcode. Returns false for a name that is not allowed. */
export function rwp_add_shortcode(tag: string, callback: ShortcodeCallback): boolean {
  if (!VALID.test(tag)) return false;
  removers.get(tag)?.();
  callbacks.set(tag, callback);
  removers.set(tag, rwp.shortcodes.register({ name: tag, render: (attributes) => callback(attributes, null, tag) }));
  return true;
}

export function rwp_remove_shortcode(tag: string): void {
  removers.get(tag)?.();
  removers.delete(tag);
  callbacks.delete(tag);
}

export function rwp_remove_all_shortcodes(): void {
  [...callbacks.keys()].forEach(rwp_remove_shortcode);
}

export function rwp_shortcode_exists(tag: string): boolean {
  return callbacks.has(tag) || rwp.getShortcodes().some((shortcode) => shortcode.name === tag);
}

/** Merges the attributes a shortcode was given over its defaults, keeping only the known ones. */
export function rwp_shortcode_atts<T extends Record<string, unknown>>(pairs: T, atts: Record<string, unknown> | string | null | undefined, shortcode = ''): T {
  const given = typeof atts === 'object' && atts !== null ? atts : {};
  const out: Record<string, unknown> = { ...pairs };
  for (const key of Object.keys(pairs)) if (key in given) out[key] = given[key];
  return (shortcode ? applyFilters<T>(`rwp_shortcode_atts_${shortcode}`, out as T, pairs, given, shortcode) : (out as T));
}

const attributePattern = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'|([\w-]+)\s*=\s*([^\s'"]+)|"([^"]*)"|(\S+)/g;

/** Parses the attribute text of a shortcode: `a="1" b='2' c=3 flag`. */
export function rwp_shortcode_parse_atts(text: string): ShortcodeAtts {
  const atts: ShortcodeAtts = {};
  let index = 0;
  let match: RegExpExecArray | null;
  attributePattern.lastIndex = 0;
  while ((match = attributePattern.exec(text))) {
    if (match[1]) atts[match[1]] = match[2];
    else if (match[3]) atts[match[3]] = match[4];
    else if (match[5]) atts[match[5]] = match[6];
    else if (match[7] !== undefined) { atts[String(index)] = match[7]; index += 1; }
    else if (match[8]) { atts[String(index)] = match[8]; index += 1; }
  }
  return atts;
}

const escapeTag = (tag: string) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the text contains the shortcode `tag`. */
export function rwp_has_shortcode(content: string, tag: string): boolean {
  if (!rwp_shortcode_exists(tag)) return false;
  return new RegExp(`\\[\\[?${escapeTag(tag)}(?![\\w-])`).test(content);
}

/** Removes every registered shortcode (and its enclosed content) from a text. */
export function rwp_strip_shortcodes(content: string): string {
  const tags = [...new Set([...callbacks.keys(), ...rwp.getShortcodes().map((s) => s.name)])];
  if (!tags.length) return content;
  const names = tags.map(escapeTag).join('|');
  return content.replace(new RegExp(`\\[(${names})\\b[^\\]]*\\](?:[\\s\\S]*?\\[/\\1\\])?`, 'g'), '');
}

/**
 * Replaces shortcodes in a text with what their callbacks return, for callbacks that return a
 * string. `[[tag]]` is an escaped shortcode and comes out as `[tag]`.
 */
export function rwp_do_shortcode(content: string, ignoreHtml = false): string {
  void ignoreHtml;
  if (!callbacks.size || !content.includes('[')) return content;
  const names = [...callbacks.keys()].map(escapeTag).join('|');
  const pattern = new RegExp(`\\[(\\[?)(${names})(?![\\w-])([^\\]/]*(?:/(?!\\])[^\\]/]*)*?)(?:(/)\\]|\\](?:([^\\[]*(?:\\[(?!/\\2\\])[^\\[]*)*)\\[/\\2\\])?)(\\]?)`, 'g');
  return content.replace(pattern, (whole, open: string, tag: string, attText: string, _selfClose: string, inner: string | undefined, close: string) => {
    if (open === '[' && close === ']') return whole.slice(1, -1);
    const callback = callbacks.get(tag);
    if (!callback) return whole;
    const output = callback(rwp_shortcode_parse_atts(attText.trim()), inner ?? null, tag);
    if (typeof output !== 'string' && typeof output !== 'number') return whole;
    return applyFilters<string>('rwp_do_shortcode_tag', String(output), tag, rwp_shortcode_parse_atts(attText.trim()), []);
  });
}

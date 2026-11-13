/**
 * WordPress's gettext functions, over React-WP's one translate().
 *
 *   __( 'Save', 'my-plugin' )          ->  rwp__('Save', 'my-plugin')
 *   _x( 'Post', 'noun', 'my-plugin' )  ->  rwp_x('Post', 'noun', 'my-plugin')
 *   _n( '%d item', '%d items', n )     ->  rwp_n('%d item', '%d items', n)
 *
 * The English text is the translation key, exactly as in WordPress, so a string written for gettext
 * can be translated under Settings → Translations (or by a plugin's own dictionary) without being
 * renamed. The text domain is accepted and passed to the filters; it does not partition the keys.
 * Unlike PHP's, none of these echo: the `_e` family returns the string, because React renders what
 * a component returns.
 */
import { applyFilters } from '../../core/hooks';
import { getLocale, translate } from '../i18n';
import { rwp_esc_attr, rwp_esc_html } from './formatting';

export function rwp__(text: string, domain = 'default'): string {
  const translated = applyFilters<string>('rwp_gettext', translate(text, text), text, domain);
  return applyFilters<string>(`rwp_gettext_${domain}`, translated, text, domain);
}

/** WordPress's _e. Returns the text instead of printing it. */
export function rwp_e(text: string, domain = 'default'): string {
  return rwp__(text, domain);
}

export function rwp_x(text: string, context: string, domain = 'default'): string {
  // The context is part of the key, so "Post" the noun and "Post" the verb translate separately.
  const translated = translate(`${context}\u0004${text}`, text);
  return applyFilters<string>(`rwp_gettext_with_context_${domain}`, applyFilters<string>('rwp_gettext_with_context', translated, text, context, domain), text, context, domain);
}

export function rwp_ex(text: string, context: string, domain = 'default'): string {
  return rwp_x(text, context, domain);
}

const pluralOf = (number: number): 'one' | 'other' => {
  try {
    return new Intl.PluralRules(getLocale()).select(number) === 'one' ? 'one' : 'other';
  } catch {
    return number === 1 ? 'one' : 'other';
  }
};

export function rwp_n(single: string, plural: string, number: number, domain = 'default'): string {
  const text = pluralOf(number) === 'one' ? single : plural;
  const translated = translate(text, text);
  return applyFilters<string>(`rwp_ngettext_${domain}`, applyFilters<string>('rwp_ngettext', translated, single, plural, number, domain), single, plural, number, domain);
}

export function rwp_nx(single: string, plural: string, number: number, context: string, domain = 'default'): string {
  const text = pluralOf(number) === 'one' ? single : plural;
  const translated = translate(`${context}\u0004${text}`, text);
  return applyFilters<string>(`rwp_ngettext_with_context_${domain}`, applyFilters<string>('rwp_ngettext_with_context', translated, single, plural, number, context, domain), single, plural, number, context, domain);
}

/** Marks a plural pair for later translation with rwp_n(). Returns the pair untouched. */
export function rwp_n_noop(singular: string, plural: string, domain: string | null = null): { singular: string; plural: string; context: null; domain: string | null } {
  return { singular, plural, context: null, domain };
}

export function rwp_nx_noop(singular: string, plural: string, context: string, domain: string | null = null): { singular: string; plural: string; context: string; domain: string | null } {
  return { singular, plural, context, domain };
}

export const rwp_esc_html__ = (text: string, domain = 'default'): string => rwp_esc_html(rwp__(text, domain));
export const rwp_esc_attr__ = (text: string, domain = 'default'): string => rwp_esc_attr(rwp__(text, domain));
export const rwp_esc_html_e = (text: string, domain = 'default'): string => rwp_esc_html__(text, domain);
export const rwp_esc_attr_e = (text: string, domain = 'default'): string => rwp_esc_attr__(text, domain);
export const rwp_esc_html_x = (text: string, context: string, domain = 'default'): string => rwp_esc_html(rwp_x(text, context, domain));
export const rwp_esc_attr_x = (text: string, context: string, domain = 'default'): string => rwp_esc_attr(rwp_x(text, context, domain));

/** The active locale code, passed through `rwp_locale` as WordPress's get_locale() is. */
export function rwp_get_locale(): string {
  return applyFilters<string>('rwp_locale', getLocale());
}

/** Whether the active locale is written right to left. */
export function rwp_is_rtl(): boolean {
  return /^(ar|fa|he|ur|ps|sd|ckb|ug|yi|dv)(-|_|$)/i.test(getLocale());
}

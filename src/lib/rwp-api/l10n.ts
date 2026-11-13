/**
 * More of WordPress's localisation functions: the locale in use, switching it for a moment, the
 * languages the site offers, and the plural / context helpers behind rwp_n and rwp_x.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { currentI18nSettings, getLocale, setLocale, translate } from '../i18n';
import { roleLabels, type UserRole } from '../roles';
import { rwp_n, rwp_x } from './i18n';

/** The locale in use, passed through `rwp_determine_locale`. */
export function rwp_determine_locale(): string {
  return applyFilters<string>('rwp_determine_locale', getLocale());
}

/** The signed-in person's language: React-WP has one language setting per browser, so it is the locale in use. */
export function rwp_get_user_locale(user: string | number = 0): string {
  void user;
  return rwp_determine_locale();
}

/** The languages the site offers (codes). */
export function rwp_get_available_languages(): string[] {
  const settings = currentI18nSettings() as { supported_languages?: string[]; default_site_language?: string };
  return settings.supported_languages?.length ? settings.supported_languages : [settings.default_site_language || 'en'];
}

// Switching the locale for a moment ---------------------------------------------------------------------

const stack: string[] = [];

/** Uses another locale until rwp_restore_previous_locale(). Returns whether it was switched. */
export function rwp_switch_to_locale(locale: string): boolean {
  const current = getLocale();
  if (locale === current) { stack.push(current); return false; }
  stack.push(current);
  setLocale(locale, { persist: false });
  doAction('rwp_switch_locale', locale);
  return true;
}

export function rwp_switch_to_user_locale(userId: string | number): boolean {
  return rwp_switch_to_locale(rwp_get_user_locale(userId));
}

/** Goes back to the locale before the last rwp_switch_to_locale(). Returns the locale restored, or false. */
export function rwp_restore_previous_locale(): string | false {
  const previous = stack.pop();
  if (!previous) return false;
  if (previous !== getLocale()) {
    setLocale(previous, { persist: false });
    doAction('rwp_restore_previous_locale', previous, getLocale());
  }
  return previous;
}

export function rwp_restore_current_locale(): string | false {
  const first = stack[0];
  if (!first) return false;
  stack.length = 0;
  setLocale(first, { persist: false });
  return first;
}

export const rwp_is_locale_switched = (): boolean => stack.length > 0;

// Lookups ---------------------------------------------------------------------------------------------------------

/** WordPress's translate(): the translation of a text, or the text. */
export const rwp_translate = (text: string, domain = 'default'): string => {
  void domain;
  return translate(text, text);
};

/** The translation of a text in a context. */
export const rwp_translate_with_gettext_context = (text: string, context: string, domain = 'default'): string => rwp_x(text, context, domain);

/** The right form of a rwp_n_noop() pair for a number. */
export const rwp_translate_nooped_plural = (nooped: { singular: string; plural: string; domain?: string | null }, count: number, domain = 'default'): string =>
  rwp_n(nooped.singular, nooped.plural, count, nooped.domain ?? domain);

/** The translated label of a role. */
export const rwp_translate_user_role = (name: string): string => (roleLabels as Record<string, string>)[name as UserRole] ?? name;

/** Whether a translation exists for a text in the locale in use. */
export function rwp_has_translation(text: string): boolean {
  return translate(text, '\u0000') !== '\u0000';
}

/** The text after the last "|" (WordPress's old context separator). */
export const rwp_before_last_bar = (text: string): string => (text.includes('|') ? text.slice(0, text.lastIndexOf('|')) : text);

/** The separator between list items in the current language: a comma, or its Arabic form. */
export const rwp_get_list_item_separator = (): string => (/^(ar|fa|ur)/i.test(getLocale()) ? '، ' : ', ');

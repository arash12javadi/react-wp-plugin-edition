/**
 * Addresses, request context and redirects (wp-includes/link-template.php, load.php, pluggable.php).
 *
 * WordPress asks PHP what the current request is. React-WP is a single-page app, so "the request" is
 * the browser's location, read when you call these. They are synchronous and need no database.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { RWP_Error } from './errors';

const origin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);
const pathname = (): string => (typeof window === 'undefined' ? '/' : window.location.pathname);

const withPath = (base: string, path: string): string => (path ? `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}` : base);

/** The address of the public site, with an optional path. */
export function rwp_home_url(path = '', scheme: string | null = null): string {
  let url = withPath(origin(), path);
  if (scheme === 'https' || scheme === 'http') url = url.replace(/^https?:/, `${scheme}:`);
  return applyFilters<string>('rwp_home_url', url, path, scheme, null);
}

/** React-WP has one address per site, so this equals rwp_home_url. */
export function rwp_site_url(path = '', scheme: string | null = null): string {
  let url = withPath(origin(), path);
  if (scheme === 'https' || scheme === 'http') url = url.replace(/^https?:/, `${scheme}:`);
  return applyFilters<string>('rwp_site_url', url, path, scheme, null);
}

/**
 * An admin address. The admin is one React app, so a WordPress path is translated: `page=slug` in a
 * query string (or a bare section id such as "settings") becomes `/admin?section=slug`.
 */
export function rwp_admin_url(path = '', scheme = 'admin'): string {
  void scheme;
  let url = `${origin()}/admin`;
  const page = /[?&]page=([^&]+)/.exec(path)?.[1];
  const bare = path.replace(/\.php.*$/, '').replace(/^\/+/, '');
  if (page) url += `?section=${encodeURIComponent(decodeURIComponent(page))}`;
  else if (bare && !/\.php/.test(path)) url += `?section=${encodeURIComponent(bare)}`;
  return applyFilters<string>('rwp_admin_url', url, path, null);
}

/** The login page address, with an optional redirect target. */
export function rwp_login_url(redirect = '', forceReauth = false): string {
  let url = `${origin()}/login`;
  const query = new URLSearchParams();
  if (redirect) query.set('redirect', redirect);
  if (forceReauth) query.set('reauth', '1');
  if ([...query].length) url += `?${query.toString()}`;
  return applyFilters<string>('rwp_login_url', url, redirect, forceReauth);
}

/** True while the admin app is open. */
export function rwp_is_admin(): boolean {
  return pathname().startsWith('/admin');
}

/** True on the home page. React-WP's front page and posts page are both "/" until Settings says otherwise. */
export function rwp_is_front_page(): boolean {
  return pathname() === '/';
}

export const rwp_is_home = rwp_is_front_page;

/** True for the address of the login screen. */
export function rwp_is_login(): boolean {
  return pathname() === '/login';
}

/** The path of the current page, without the query string. */
export function rwp_get_request_path(): string {
  return pathname();
}

/** The value of one query-string parameter of the current address, or null. */
export function rwp_get_query_var(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

/** Whether `url` stays on this site (relative, or the same origin). */
export function rwp_is_local_url(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    return new URL(url, origin() || 'http://localhost').origin === (origin() || 'http://localhost');
  } catch {
    return false;
  }
}

/**
 * Sends the browser to another address. Fires `rwp_redirect` (a filter on the location) and
 * `rwp_x_redirect_by` first; a filter that returns false cancels it. WordPress calls exit afterwards;
 * here, code that follows still runs, so return straight after calling it.
 */
export function rwp_redirect(location: string, status = 302, xRedirectBy = 'RWP'): boolean {
  const target = applyFilters<string | false>('rwp_redirect', location, status);
  if (!target) return false;
  doAction('rwp_x_redirect_by', xRedirectBy, target, status);
  if (typeof window !== 'undefined') window.location.assign(target);
  return true;
}

/** rwp_redirect, but only to addresses on this site; anything else goes to the fallback (default: the admin). */
export function rwp_safe_redirect(location: string, status = 302, xRedirectBy = 'RWP'): boolean {
  const fallback = applyFilters<string>('rwp_safe_redirect_fallback', rwp_admin_url(), status);
  return rwp_redirect(rwp_is_local_url(location) ? location : fallback, status, xRedirectBy);
}

/** Thrown by rwp_die so a caller further up can render the message; nothing else catches it by accident. */
export class RWP_DieError extends Error {
  readonly title: string;

  readonly status: number;

  constructor(message: string, title = '', status = 500) {
    super(message);
    this.name = 'RWP_DieError';
    this.title = title;
    this.status = status;
  }
}

/**
 * Stops the current operation with a message. An RWP_Error is turned into its first message. It
 * throws an RWP_DieError; React-WP has no page of its own to print it on.
 */
export function rwp_die(message: string | RWP_Error = '', title: string | number = '', args: { response?: number } | number = {}): never {
  const text = message instanceof RWP_Error ? message.get_error_message() : message;
  const status = typeof args === 'number' ? args : args.response ?? (typeof title === 'number' ? title : 500);
  throw new RWP_DieError(text || 'The request could not be completed.', typeof title === 'string' ? title : '', status);
}

/** Whether a Promise-returning or plain value is a WordPress-style failure. */
export function rwp_is_error_like(value: unknown): value is RWP_Error {
  return value instanceof RWP_Error;
}

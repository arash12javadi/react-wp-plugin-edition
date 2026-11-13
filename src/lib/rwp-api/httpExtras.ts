/**
 * The "safe" HTTP functions and the origin helpers.
 *
 * rwp_safe_remote_* are rwp_remote_* that refuse any address that is not a well-formed http(s) URL.
 * (WordPress's also refuse private network addresses; a browser cannot see where a name resolves, and
 * its own same-origin and CORS rules already stop it reaching an internal service.)
 */
import { applyFilters } from '../../core/hooks';
import { RWP_Error } from './errors';
import { rwp_remote_get, rwp_remote_head, rwp_remote_post, rwp_remote_request, type HttpArgs, type HttpResponse } from './http';
import { rwp_http_validate_url } from './utils';

const guard = (url: string): RWP_Error | null =>
  (rwp_http_validate_url(url) ? null : new RWP_Error('http_request_failed', 'A valid URL was not provided.'));

export const rwp_safe_remote_request = async (url: string, args: HttpArgs = {}): Promise<HttpResponse | RWP_Error> => guard(url) ?? rwp_remote_request(url, args);
export const rwp_safe_remote_get = async (url: string, args: HttpArgs = {}): Promise<HttpResponse | RWP_Error> => guard(url) ?? rwp_remote_get(url, args);
export const rwp_safe_remote_post = async (url: string, args: HttpArgs = {}): Promise<HttpResponse | RWP_Error> => guard(url) ?? rwp_remote_post(url, args);
export const rwp_safe_remote_head = async (url: string, args: HttpArgs = {}): Promise<HttpResponse | RWP_Error> => guard(url) ?? rwp_remote_head(url, args);

/** Cookies are not visible to scripts (HttpOnly), so a response has none. */
export const rwp_remote_retrieve_cookies = (): never[] => [];
export const rwp_remote_retrieve_cookie = (): '' => '';
export const rwp_remote_retrieve_cookie_value = (): '' => '';

/** Whether the transport supports a feature: only 'ssl' and 'json' do, as a browser's does. */
export const rwp_http_supports = (capabilities: string[] = []): boolean => capabilities.every((name) => ['ssl', 'json', 'cors'].includes(name));

/** The origins that may call this site: its own. `rwp_allowed_http_origins` adds more. */
export function rwp_get_allowed_http_origins(): string[] {
  const own = typeof window === 'undefined' ? [] : [window.location.origin];
  return applyFilters<string[]>('rwp_allowed_http_origins', own);
}

/** The origin of the current page. */
export const rwp_get_http_origin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);

/** Whether an origin may call this site. */
export function rwp_is_allowed_http_origin(origin: string | null = null): string {
  const target = origin ?? rwp_get_http_origin();
  const allowed = rwp_get_allowed_http_origins();
  const found = allowed.includes(target) ? target : '';
  return applyFilters<string>('rwp_allowed_http_origin', found, target);
}

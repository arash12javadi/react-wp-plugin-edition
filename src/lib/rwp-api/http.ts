/**
 * WordPress's HTTP API (wp_remote_get, wp_remote_post ...) over the browser's fetch.
 *
 * Differences that matter:
 *   - These run in the visitor's browser, so the browser's rules apply: the other site must allow
 *     cross-origin requests (CORS), and cookies are not sent unless you ask for them.
 *   - Never put a secret in a request made from here: the browser, and anyone using it, can read it.
 *     A request that needs a credential belongs in a plugin's server.mjs route.
 *   - They are async and return the WordPress response shape, or an RWP_Error when the request fails.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { RWP_Error } from './errors';

export interface HttpArgs {
  method?: string;
  timeout?: number;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown> | null;
  /** 'include' sends cookies for cross-origin requests. Default: same-origin only. */
  credentials?: RequestCredentials;
  redirection?: number;
}

export interface HttpResponse {
  headers: Record<string, string>;
  body: string;
  response: { code: number; message: string };
  cookies: never[];
}

async function request(url: string, args: HttpArgs): Promise<HttpResponse | RWP_Error> {
  const parsed = applyFilters<HttpArgs>('rwp_http_request_args', { method: 'GET', timeout: 5000, headers: {}, ...args }, url);
  const pre = applyFilters<HttpResponse | RWP_Error | false>('rwp_pre_http_request', false, parsed, url);
  if (pre !== false) return pre;
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) return new RWP_Error('http_request_failed', 'Only http, https and same-site addresses can be requested.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, applyFilters<number>('rwp_http_request_timeout', parsed.timeout ?? 5000, url)));
  try {
    const body = parsed.body && typeof parsed.body === 'object' ? new URLSearchParams(parsed.body as Record<string, string>).toString() : parsed.body ?? undefined;
    const headers = { ...(parsed.headers || {}) };
    if (body && typeof parsed.body === 'object' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const raw = await fetch(url, {
      method: parsed.method,
      headers,
      body: parsed.method === 'GET' || parsed.method === 'HEAD' ? undefined : body,
      credentials: parsed.credentials ?? 'same-origin',
      signal: controller.signal,
    });
    const text = parsed.method === 'HEAD' ? '' : await raw.text();
    const result: HttpResponse = {
      headers: Object.fromEntries([...raw.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
      body: text,
      response: { code: raw.status, message: raw.statusText },
      cookies: [],
    };
    doAction('rwp_http_api_debug', result, 'response', 'fetch', parsed, url);
    return applyFilters<HttpResponse>('rwp_http_response', result, parsed, url);
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return new RWP_Error('http_request_failed', aborted ? 'The request timed out.' : `The request failed: ${error instanceof Error ? error.message : 'network error'}. If it is another site, it may not allow requests from this page (CORS).`);
  } finally {
    clearTimeout(timer);
  }
}

export const rwp_remote_request = (url: string, args: HttpArgs = {}) => request(url, args);
export const rwp_remote_get = (url: string, args: HttpArgs = {}) => request(url, { ...args, method: 'GET' });
export const rwp_remote_post = (url: string, args: HttpArgs = {}) => request(url, { ...args, method: 'POST' });
export const rwp_remote_head = (url: string, args: HttpArgs = {}) => request(url, { ...args, method: 'HEAD' });

export function rwp_remote_retrieve_body(response: HttpResponse | RWP_Error): string {
  return response instanceof RWP_Error ? '' : response.body;
}

export function rwp_remote_retrieve_response_code(response: HttpResponse | RWP_Error): number | '' {
  return response instanceof RWP_Error ? '' : response.response.code;
}

export function rwp_remote_retrieve_response_message(response: HttpResponse | RWP_Error): string {
  return response instanceof RWP_Error ? '' : response.response.message;
}

export function rwp_remote_retrieve_headers(response: HttpResponse | RWP_Error): Record<string, string> {
  return response instanceof RWP_Error ? {} : response.headers;
}

export function rwp_remote_retrieve_header(response: HttpResponse | RWP_Error, header: string): string {
  return response instanceof RWP_Error ? '' : response.headers[header.toLowerCase()] ?? '';
}

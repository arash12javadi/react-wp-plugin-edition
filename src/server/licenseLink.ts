/**
 * Plugins → "Connect to react-wp.com", on the universal engine (Vercel functions, `npm run start:hono`).
 *
 * The routes, the rules and the sentences are `server/licenseLinkRoutes.mjs`, which `server.mjs` runs too -
 * this file only adapts a Hono request to it. Every route needs the platform owner.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getRuntimeConfig } from './config';
import { handleLicenseLinkRequest, ownsLicenseLinkPath } from '../../server/licenseLinkRoutes.mjs';
import { authorizePlatformOwner } from '../../server/integrationSettings.mjs';

const serverEnvironment = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

async function handle(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  if (!ownsLicenseLinkPath(url.pathname)) {
    return c.json({ success: false, ok: false, error: `No API endpoint at ${url.pathname}.` }, 404);
  }
  const config = await getRuntimeConfig();
  const result = await handleLicenseLinkRequest({
    method: c.req.method,
    pathname: url.pathname,
    headers: c.req.header() ?? {},
    body: c.req.method === 'POST' ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : {},
    config: config as unknown as Record<string, unknown>,
    siteUrl: url.origin,
    env: serverEnvironment(),
    authorize: (token: string) => authorizePlatformOwner(config.supabaseUrl ?? '', config.supabasePublishableKey ?? '', token),
  });
  if (!result) return c.json({ success: false, ok: false, error: `No API endpoint at ${url.pathname}.` }, 404);
  return c.json(result.body ?? {}, result.status as ContentfulStatusCode);
}

/** Mounts the shared handler at the paths it owns. */
export function registerLicenseLinkRoutes(app: Hono): void {
  app.all('/api/admin/license-link', (c) => handle(c));
  app.all('/api/admin/license-link/*', (c) => handle(c));
}

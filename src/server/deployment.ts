/**
 * Settings → Integrations → GitHub & Vercel, on the universal engine (Vercel functions, `npm run start:hono`).
 *
 * The routes, the rules and the sentences are `server/deploymentRoutes.mjs`, which `server.mjs` runs too —
 * this file only adapts a Hono request to it. `ownsDeploymentPath` is the single list of paths, so nothing
 * is repeated here. Every route needs the platform owner (`authorizePlatformOwner`, which asks Supabase for
 * the caller's role with the caller's own token).
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getRuntimeConfig } from './config';
import packageManifest from '../../package.json';
import { handleDeploymentRequest, ownsDeploymentPath } from '../../server/deploymentRoutes.mjs';
import { authorizePlatformOwner } from '../../server/integrationSettings.mjs';
import { installedVersionFor } from '../../server/installedVersion.mjs';
import {
  VERCEL_DEPLOY_CONFIG_KEY,
  deploymentConnectionFrom,
  isGitDeployConnected,
  settingsIo,
} from '../../server/gitDeploy/connection.mjs';

const serverEnvironment = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const installedVersion = (): Promise<string> => installedVersionFor({ fallback: String(packageManifest.version || ''), manifest: packageManifest });

async function handle(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  if (!ownsDeploymentPath(url.pathname)) {
    return c.json({ success: false, ok: false, error: `No API endpoint at ${url.pathname}.` }, 404);
  }
  const config = await getRuntimeConfig();
  const result = await handleDeploymentRequest({
    method: c.req.method,
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: c.req.header() ?? {},
    body: c.req.method === 'POST' ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : {},
    config: config as unknown as Record<string, unknown>,
    siteConfig: config as unknown as Record<string, unknown>,
    env: serverEnvironment(),
    installedVersion,
    authorize: (token: string) => authorizePlatformOwner(config.supabaseUrl ?? '', config.supabasePublishableKey ?? '', token),
  });
  if (!result) return c.json({ success: false, ok: false, error: `No API endpoint at ${url.pathname}.` }, 404);
  return c.json(result.body ?? {}, result.status as ContentfulStatusCode);
}

/**
 * Whether this site's Vercel project deploys its repository by itself (a stored, connected
 * `vercel_deploy_config`), read with the caller's own session. A plugin upload uses it to skip the deploy
 * hook, which would otherwise start a second build of the same commit. Any failure answers `false`: the
 * old behaviour (call the hook if one is saved) is the safe default.
 */
export async function gitDeploysFor(config: { supabaseUrl?: string; supabasePublishableKey?: string }, accessToken: string): Promise<boolean> {
  try {
    const io = settingsIo({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabasePublishableKey, accessToken });
    return isGitDeployConnected(deploymentConnectionFrom(await io.read(VERCEL_DEPLOY_CONFIG_KEY)));
  } catch {
    return false;
  }
}

/** Mounts the shared handler at the paths it owns. */
export function registerDeploymentRoutes(app: Hono): void {
  app.all('/api/admin/deployment', (c) => handle(c));
  app.all('/api/admin/deployment/*', (c) => handle(c));
}

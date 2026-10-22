/**
 * The core AI assistant, on the universal engine.
 *
 * The path, the task vocabulary, the prompt and the HTML allowlist live in `server/aiAssist.mjs`, which
 * `server.mjs` also runs — an answer the model wrote is cleaned once, in one function, whichever host
 * served it, so a deployment cannot be the one that forgets to. This file is the Hono half: the
 * capability check the POST needs, and the reader that lets the shared module find the AI key in
 * `system_settings`.
 *
 * Registration is a plain function that mounts the shared handler at `/api/ai/*` rather than a Hono
 * sub-router: `ownsAiAssistPath` is already the list of paths, so a second copy of it here could only
 * drift from the first.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getRuntimeConfig } from './config';
import { createServerDbAdapter } from '../lib/db/index';
import { createServerAuthAdapter } from '../lib/auth/index';
import { hasCapability, type Capability, type UserRole } from '../lib/roles';
import {
  assistAuthMessages,
  handleAiAssistRequest,
  ownsAiAssistPath,
} from '../../server/aiAssist.mjs';
import { authorizeCapabilityOnSupabase } from '../../server/integrationSettings.mjs';
import { serverEnvironment, systemSettingReader } from './pluginHostAccess';

/**
 * Confirms the caller may spend the site's AI key, against the capability the shared module names —
 * `edit_posts`, because writing a draft is not administering the site: the policies in
 * `supabase/schema.sql` let that capability write a post, and a Contributor holds it.
 *
 * Under Supabase the token is put to the project itself through the shared
 * `authorizeCapabilityOnSupabase` (`/auth/v1/user`, then `user_has_cap`) — the very check `server.mjs`
 * makes, with the assistant's own sentences. Resolving it through this engine's own auth adapter
 * answered "Your session is not valid. Sign in again." for every caller, because on a server that
 * adapter holds no session of its own, its Supabase client speaks the publishable key, and `profiles`
 * is readable by `authenticated` only. Every other backend keeps the universal JWT engine below.
 */
async function authorizeAssistCaller(
  token: string,
  capability: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!token) return { ok: false, status: 401, error: assistAuthMessages.signedOut };
  const config = await getRuntimeConfig();
  if (config.dbType === 'supabase') {
    return authorizeCapabilityOnSupabase(
      config.supabaseUrl ?? '',
      config.supabasePublishableKey ?? '',
      token,
      capability,
      assistAuthMessages,
    );
  }
  let db;
  try {
    db = await createServerDbAdapter(config);
    const auth = await createServerAuthAdapter(config, db);
    const user = await auth.authenticate(token);
    const role = user?.role as UserRole | undefined;
    if (!role) return { ok: false, status: 401, error: assistAuthMessages.invalidSession };
    if (!hasCapability(role, capability as Capability)) {
      return { ok: false, status: 403, error: assistAuthMessages.capabilityFailure(capability) };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: assistAuthMessages.unreachable(error instanceof Error ? error.message : 'unknown error'),
    };
  } finally {
    await db?.close().catch(() => undefined);
  }
}

/**
 * What the shared module needs to read the AI row: the runtime config and the environment, plus the
 * reader whose one answer — "which credential source does this deployment have" — is
 * `systemSettingReader`'s, already used by the Integrations hub and the plugin routes. It is imported
 * rather than written again here, because the reason Supabase gets no reader from this engine (its
 * adapter speaks the publishable key, which RLS does not let near `system_settings`) is the sort of
 * sentence that ends up wrong in the second copy.
 */
async function assistAccess(): Promise<{
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
  readSetting?: (key: string) => Promise<unknown>;
  authorize: (token: string, capability: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
}> {
  const config = await getRuntimeConfig();
  return {
    config: config as unknown as Record<string, unknown>,
    env: serverEnvironment(),
    readSetting: systemSettingReader(config),
    authorize: authorizeAssistCaller,
  };
}

/** Registers the status read and the one generation, at the path the shared module owns. */
export function registerAiAssistRoutes(app: Hono): void {
  /**
   * Everything under the prefix, matched once: `ownsAiAssistPath` — the shared module's own list —
   * decides whether a path is ours, so a path added there cannot be forgotten here.
   */
  app.all('/api/ai/*', (c) => handleRequest(c));
}

async function handleRequest(c: Context): Promise<Response> {
  const { pathname } = new URL(c.req.url);
  if (!ownsAiAssistPath(pathname)) {
    // A sub-path this module does not answer. The `/api/ai/*` pattern matched, so the honest answer is
    // the same 404 the rest of the API gives, not an empty 200.
    return c.json({ success: false, ok: false, error: `No API endpoint at ${pathname}.` }, 404);
  }

  const access = await assistAccess();
  const result = await handleAiAssistRequest({
    method: c.req.method,
    pathname,
    headers: c.req.header() ?? {},
    body: c.req.method === 'POST' ? await requestBody(c) : {},
    config: access.config,
    env: access.env,
    readSetting: access.readSetting,
    authorize: access.authorize,
  });

  if (!result) {
    // Ours, wrong verb: 405 with Allow beats a 404 that hides the mistake. Both verbs are the assistant's
    // — the status read and the one generation — so both are named.
    c.header('Allow', 'GET, POST');
    return c.json({ success: false, ok: false, error: `Only GET and POST are supported at ${pathname}.` }, 405);
  }

  return c.json(result.body ?? {}, result.status as ContentfulStatusCode);
}

/** The parsed body, or nothing at all: the shared module is what reports a malformed request. */
const requestBody = async (c: Context): Promise<Record<string, unknown>> =>
  (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

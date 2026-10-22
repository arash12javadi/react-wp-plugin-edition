/**
 * Admin-only endpoints that need a direct database connection: per-plugin schema install,
 * plugin uninstall with an optional backup, and the site reset.
 *
 * These live under /api/admin/ rather than /api/plugins/ on purpose. server.mjs routes the whole
 * /api/plugins/ prefix to plugin-registered server routes, so an endpoint named
 * /api/plugins/install-schema would shadow a name a third-party plugin is entitled to use.
 *
 * The plugin half is thin on purpose: it answers *who is asking* (a Supabase token with
 * `manage_options`, below) and hands the work itself to `pluginUninstall.mjs`, which is the same
 * code the universal engine's route (`src/server/routes/pluginSchema.ts`) runs. One implementation
 * of "export, then drop, then remove the code", two hosts.
 */
import { resolveConnectionString } from './db.mjs';
import { SchemaError } from './pluginSchema.mjs';
import { installPluginSchemaFor, pluginSchemaStatus, uninstallPlugin } from './pluginUninstall.mjs';
import { authorizePluginManager, readActivePluginIds } from './pluginFiles.mjs';
import { authorizeSiteReset, markUninstalled, ResetError, resetSite, wipeSiteMedia } from './siteReset.mjs';

const fail = (error) => ({
  status: error instanceof SchemaError || error instanceof ResetError ? error.status : 500,
  body: { error: error instanceof Error ? error.message : 'Unknown server error.' },
});

/** The caller's plugin permission, or a ready-to-send error. Shared by every route below. */
const requireManager = async (config, headers) => {
  if (!config?.supabaseUrl || !config?.supabasePublishableKey) {
    throw new SchemaError(501, 'This site is not installed, so plugins cannot be managed.');
  }
  const auth = await authorizePluginManager(
    config.supabaseUrl,
    config.supabasePublishableKey,
    (headers.authorization || '').replace(/^Bearer\s+/i, ''),
  );
  if (!auth.ok) throw new SchemaError(auth.status, auth.error);
  return auth;
};

/**
 * GET /api/admin/plugins/schema-status?id=<plugin>
 */
async function schemaStatus(config, headers, id) {
  await requireManager(config, headers);
  return { status: 200, body: await pluginSchemaStatus(config, id) };
}

/** POST /api/admin/plugins/install-schema { id, dbPassword? | connectionString? } */
async function installSchema(config, headers, body) {
  await requireManager(config, headers);
  return { status: 200, body: await installPluginSchemaFor(config, String(body.id || ''), body) };
}

/**
 * POST /api/admin/plugins/uninstall
 *   { id, mode: 'keep' | 'wipe', backup: boolean, confirm?: 'DELETE',
 *     deleteFolder?: boolean, dbPassword? | connectionString? }
 *
 * This host answers the two things `pluginUninstall.mjs` cannot answer for itself and leaves the
 * rest alone. The active ids are read with the caller's own token — the reader `server.mjs`'s own
 * Delete route uses, so a refusal to remove the folder is worded from the same list — and the code
 * is removed from this machine's `plugins/` folder, which is what the default remover does.
 *
 * The body shape, and the fact that this is only ever called after the caller saw what would be
 * destroyed, are documented in the file that does the work.
 */
async function uninstall(config, headers, body) {
  const auth = await requireManager(config, headers);
  return {
    status: 200,
    body: await uninstallPlugin(config, body, { readActiveIds: () => readActivePluginIds(auth) }),
  };
}

/** POST /api/admin/reset-site { password, confirm: 'RESET', dbPassword? | connectionString? } */
async function handleReset(config, headers, body) {
  if (String(body.confirm || '') !== 'RESET') {
    throw new ResetError(400, 'Type RESET in the confirmation box to wipe this site.');
  }
  await authorizeSiteReset(
    config,
    (headers.authorization || '').replace(/^Bearer\s+/i, ''),
    body.password,
  );
  const resolved = resolveConnectionString(body, config);
  if (!resolved.ok) throw new ResetError(resolved.status, resolved.error);

  // Media first: the list of what this site uploaded lives in the media table, which the reset
  // is about to drop. Opt-out rather than opt-in, because a factory reset that leaves the files
  // behind is not a factory reset — but a shared Cloudinary cloud is a real enough situation
  // that the operator gets a way to say no.
  const media = body.wipeMedia === false
    ? { attempted: false, deleted: 0, notFound: 0, recorded: 0, warnings: ['Cloudinary files were kept: you cleared "also delete uploaded files".'] }
    : await wipeSiteMedia(resolved.url, config);

  const result = await resetSite(resolved.url);
  // Only after the database is actually empty, or a failed reset would strand the site in the
  // wizard with all its data intact.
  await markUninstalled();
  // The Setup Wizard has no route of its own: App.tsx renders it whenever checkDatabase() fails,
  // which it now will, because public.options no longer exists. So the way back to the wizard is
  // the site root, not "/setup" — that path would fall through to the SPA 404.
  return { status: 200, body: { success: true, ...result, media, next: '/' } };
}

/**
 * Returns null when the path is not one of ours, so server.mjs can fall through to its other
 * routes. `body` is already-parsed JSON for POSTs.
 */
export async function handleAdminRequest({ method, pathname, query, headers, body, config }) {
  try {
    if (pathname === '/api/admin/plugins/schema-status') {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      if (!query.id) return { status: 400, body: { error: 'Pass ?id=<plugin id>.' } };
      return await schemaStatus(config, headers, String(query.id));
    }
    if (pathname === '/api/admin/plugins/install-schema') {
      if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
      return await installSchema(config, headers, body);
    }
    if (pathname === '/api/admin/plugins/uninstall') {
      if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
      return await uninstall(config, headers, body);
    }
    if (pathname === '/api/admin/reset-site') {
      if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
      return await handleReset(config, headers, body);
    }
    return null;
  } catch (error) {
    if (!(error instanceof SchemaError) && !(error instanceof ResetError)) {
      console.error(`${pathname} failed:`, error);
    }
    return fail(error);
  }
}

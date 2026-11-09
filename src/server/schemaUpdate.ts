/**
 * Dashboard → Updates → "Database", on the universal engine (Vercel functions, `npm run start:hono`).
 *
 * The routes, the rules and the sentences are `server/schemaRoutes.mjs`, which `server.mjs` runs too — this file
 * only adapts a Hono request to it and says where this host keeps its schema text: the bundle's inlined
 * `__RWP_SCHEMA_SQL__` and plugin catalogue on a serverless host, the checkout on a persistent one. Every route
 * needs the platform owner.
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getRuntimeConfig } from './config';
import { supabaseSchemaSql } from './schemaText';
import { pluginCatalogueFromBuild } from './routes/pluginSchema';
import { createSchemaUpdater, handleSchemaUpdateRequest, ownsSchemaUpdatePath } from '../../server/schemaRoutes.mjs';
import type { SchemaSources, SchemaUpdater } from '../../server/schemaRoutes.mjs';
import { diskSources, inlineSources } from '../../server/schemaSources.mjs';
import { authorizePlatformOwner } from '../../server/integrationSettings.mjs';

let updater: SchemaUpdater | null = null;

/** One updater per process; the catalogue (serverless) or the plugins folder (persistent) is read when first needed. */
function schemaUpdater(): SchemaUpdater {
  if (!updater) {
    const catalogue = pluginCatalogueFromBuild();
    const sources: SchemaSources = catalogue
      ? inlineSources({ coreSql: supabaseSchemaSql, catalogue })
      : { coreSql: supabaseSchemaSql, plugins: diskSources().plugins };
    updater = createSchemaUpdater({ sources });
  }
  return updater;
}

/**
 * Called once from the adapters at start-up. A new deployment's first cold start runs the update in the
 * background; a serverless function may be frozen once it has answered, so the Dashboard card — which calls the
 * status route and offers "Update database now" — is the path that is guaranteed to complete.
 */
export async function runSchemaUpdateOnStart(): Promise<void> {
  try {
    const config = await getRuntimeConfig();
    if (!config.installed || config.dbType !== 'supabase') return;
    await schemaUpdater().auto();
  } catch {
    // Never fail a start-up over a database update; the Dashboard reports the state.
  }
}

async function handle(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  if (!ownsSchemaUpdatePath(url.pathname)) {
    return c.json({ success: false, ok: false, error: `No API endpoint at ${url.pathname}.` }, 404);
  }
  const config = await getRuntimeConfig();
  const result = await handleSchemaUpdateRequest({
    method: c.req.method,
    pathname: url.pathname,
    headers: c.req.header() ?? {},
    updater: schemaUpdater(),
    authorize: (token: string) => authorizePlatformOwner(config.supabaseUrl ?? '', config.supabasePublishableKey ?? '', token),
  });
  if (!result) return c.json({ success: false, ok: false, error: `No API endpoint at ${url.pathname}.` }, 404);
  return c.json(result.body ?? {}, result.status as ContentfulStatusCode);
}

/** Mounts the shared handler at the paths it owns. */
export function registerSchemaUpdateRoutes(app: Hono): void {
  app.all('/api/admin/schema-update', (c) => handle(c));
  app.all('/api/admin/schema-update/run', (c) => handle(c));
}

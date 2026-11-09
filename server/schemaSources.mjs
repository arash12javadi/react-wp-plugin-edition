/**
 * Where the schema text comes from, per host (see `server/schemaMigrate.mjs` for what is done with it).
 *
 * A persistent host (`npm start`) reads `supabase/schema.sql` and every `plugins/<id>/schema.sql` from disk. A
 * serverless host has no repository, so the bundle carries the core schema (`__RWP_SCHEMA_SQL__`) and the plugin
 * catalogue (`__RWP_PLUGIN_CATALOGUE__`) inline and passes them in; nothing here may be called with a path on such a
 * host. Both answer the same shape, `{ coreSql(), plugins() }`, with `plugins()` listing every plugin that ships a
 * schema — which of them is *active* is decided later, on the database connection, by `onlyActive`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPluginFolders } from './pluginFiles.mjs';
import { readPluginDatabase } from './pluginSchema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Disk-backed sources for a host with a checkout. */
export function diskSources() {
  return {
    coreSql: () => readFile(path.join(root, 'supabase', 'schema.sql'), 'utf8'),
    plugins: async () => {
      const { plugins } = await listPluginFolders();
      const found = [];
      for (const plugin of plugins) {
        try {
          const { database } = await readPluginDatabase(plugin.id);
          if (!database?.schema?.path) continue;
          found.push({ id: plugin.id, label: plugin.name || plugin.id, version: plugin.version || '', sql: await readFile(database.schema.path, 'utf8') });
        } catch {
          // A plugin whose manifest or schema cannot be read is simply not updated automatically.
        }
      }
      return found;
    },
  };
}

/** Sources for a host that carries its schemas inline: `coreSql` is the bundled text, `catalogue` the build's entries. */
export function inlineSources({ coreSql, catalogue }) {
  return {
    coreSql: async () => {
      const text = await coreSql();
      if (typeof text !== 'string' || !text.trim()) throw new Error('The core schema is not part of this build.');
      return text;
    },
    plugins: async () => (Array.isArray(catalogue) ? catalogue : [])
      .map((entry) => ({
        id: entry?.plugin?.id,
        label: entry?.plugin?.name || entry?.plugin?.id,
        version: entry?.plugin?.version || '',
        sql: entry?.database?.schema?.text,
      }))
      .filter((item) => item.id && typeof item.sql === 'string' && item.sql.trim()),
  };
}

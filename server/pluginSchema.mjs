/**
 * Per-plugin database provisioning.
 *
 * supabase/schema.sql installs the core CMS only. A plugin that needs tables ships its own
 * schema.sql and declares it in manifest.json:
 *
 *   "database": {
 *     "schema": "./schema.sql",          // run on Activate, must be safely re-runnable
 *     "uninstall": "./uninstall.sql",    // run only when an admin asks for a wipe
 *     "tables": ["shop_orders", ...],    // exported to the backup file, in this order
 *     "options": ["shop\\_%"],           // option_name LIKE patterns the plugin owns
 *     "retains": ["..."]                 // shown in the uninstall dialog as "kept"
 *   }
 *
 * Both SQL files run inside one transaction, so a half-applied schema is impossible.
 *
 * A host whose filesystem holds no repository (a Vercel function) has no manifest to read at request
 * time, so `vite.pluginCatalogue.mjs` inlines every plugin's manifest and both SQL files into the
 * bundle and every reader below takes that catalogue as an optional second argument. The catalogue is
 * built by `pluginCatalogue()` at the bottom of this file — on a real checkout, through these very
 * readers — so the two hosts share one set of rules and answer with the same body.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describeDbError, withClient } from './db.mjs';
import { findImporters, listPluginFolders } from './pluginFiles.mjs';
import { pluginMediaPrefix } from '../src/lib/mediaScope.js';
import { parseCloudinaryUrl } from './media.mjs';

const pluginsRoot = path.resolve('plugins');
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;

export class SchemaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Resolves a manifest path, refusing anything that escapes the plugin's own folder. */
const insideFolder = (folder, relative, field) => {
  if (typeof relative !== 'string' || !relative.trim()) return null;
  const base = path.join(pluginsRoot, folder);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new SchemaError(400, `manifest.json field "${field}" (${relative}) points outside plugins/${folder}.`);
  }
  return resolved;
};

/**
 * The provider folder prefixes a plugin owns and may delete on uninstall. The default is
 * plugins/<id>; a manifest may narrow it with "media": { "prefixes": [...] } but never widen it.
 *
 * Every prefix must sit under plugins/<this plugin's id>/. That rule is the whole safety model
 * for Rule A ("preserve the Media Library"): without it a manifest could declare "media" as its
 * prefix and an uninstall would delete every file the site has ever uploaded. It is enforced
 * here, on the server, because manifest.json travels inside an uploaded ZIP.
 */
function readMediaPrefixes(manifest, plugin) {
  const own = pluginMediaPrefix(plugin.id);
  const declared = Array.isArray(manifest?.media?.prefixes) ? manifest.media.prefixes.map(String) : null;
  if (!declared || !declared.length) return [own];

  const allowed = [];
  for (const raw of declared) {
    const prefix = raw.replace(/^\/+|\/+$/g, '');
    if (prefix === own || prefix.startsWith(`${own}/`)) allowed.push(prefix);
    else {
      throw new SchemaError(400,
        `plugins/${plugin.folder}/manifest.json claims the media prefix "${raw}", which is outside its own "${own}/". A plugin may only delete files it uploaded itself.`);
    }
  }
  return allowed;
}

/**
 * The plugin's declared database contract, or null when it needs no tables. Table and option
 * names are validated here rather than at query time: they are interpolated into SQL below,
 * because table names cannot be bound as parameters.
 *
 * Pass `catalogue` on a host without a `plugins/` folder; the entry is returned as built (by
 * `pluginCatalogue()`), so `importers` is the build's answer there and `null` here, where the
 * filesystem is asked at deletion time instead.
 */
export async function readPluginDatabase(id, catalogue = null) {
  if (catalogue) return cataloguePlugin(id, catalogue);
  const { plugins } = await listPluginFolders();
  const plugin = plugins.find((item) => item.id === id);
  if (!plugin) {
    throw new SchemaError(404, `No folder in plugins/ has a manifest.json with the id "${id}".`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(pluginsRoot, plugin.folder, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new SchemaError(500, `plugins/${plugin.folder}/manifest.json could not be read: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  const database = manifest.database;
  // A plugin can own uploaded files without owning any tables, so the media prefixes are
  // resolved before this early return rather than inside the database block.
  const mediaPrefixes = readMediaPrefixes(manifest, plugin);
  if (!database || typeof database !== 'object') return { plugin, mediaPrefixes, importers: null, database: null };

  const tables = Array.isArray(database.tables) ? database.tables.map(String) : [];
  const invalid = tables.filter((name) => !identifier.test(name));
  if (invalid.length) {
    throw new SchemaError(400, `plugins/${plugin.folder}/manifest.json lists invalid table name(s): ${invalid.join(', ')}.`);
  }
  const options = (Array.isArray(database.options) ? database.options : []).map(String);

  return {
    plugin,
    mediaPrefixes,
    importers: null,
    database: {
      tables,
      options,
      retains: (Array.isArray(database.retains) ? database.retains : []).map(String),
      schema: sqlSource(plugin.folder, database.schema, 'database.schema', 'schema.sql'),
      uninstall: sqlSource(plugin.folder, database.uninstall, 'database.uninstall', 'uninstall.sql'),
    },
  };
}

/**
 * One declared SQL file, as `readSql` reads it: the path to open on a host with a `plugins/` folder,
 * or the text itself when the catalogue carried it. `label` is how both hosts name the file in an
 * error message, which is why it reads `plugins/<folder>/schema.sql` either way.
 */
function sqlSource(folder, relative, field, fileName, inline = null) {
  const file = insideFolder(folder, relative, field);
  if (!file) return null;
  const label = `plugins/${folder}/${fileName}`;
  return typeof inline === 'string' ? { path: null, text: inline, label } : { path: file, text: null, label };
}

/** The catalogue's entry for one plugin, checked enough that a stale bundle fails loudly. */
function cataloguePlugin(id, catalogue) {
  const entry = (Array.isArray(catalogue) ? catalogue : []).find((item) => item?.plugin?.id === id);
  if (!entry) {
    throw new SchemaError(404, `This deployment was built without a plugin with the id "${id}". Add it to plugins/ and redeploy.`);
  }
  if (typeof entry.plugin.folder !== 'string') {
    throw new SchemaError(500, `The bundled catalogue entry for "${id}" is malformed. Rebuild the site.`);
  }
  return {
    plugin: entry.plugin,
    mediaPrefixes: Array.isArray(entry.mediaPrefixes) ? entry.mediaPrefixes : [],
    importers: Array.isArray(entry.importers) ? entry.importers : [],
    database: entry.database || null,
  };
}

const readSql = async ({ text, path: file, label }) => {
  try {
    const sql = typeof text === 'string' ? text : await readFile(file, 'utf8');
    if (!sql.trim()) throw new SchemaError(400, `${label} is empty.`);
    return sql;
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError(error?.code === 'ENOENT' ? 404 : 500,
      `${label} could not be read: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
};

/** Which of the plugin's declared tables already exist, so the UI can say "installed" truthfully. */
export async function readSchemaState(client, tables) {
  if (!tables.length) return { present: [], missing: [], rowCounts: {} };
  const { rows } = await client.query(
    `select c.relname as name, coalesce(s.n_live_tup, 0)::bigint as approx_rows
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])`,
    [tables],
  );
  const present = rows.map((row) => row.name);
  return {
    present,
    missing: tables.filter((name) => !present.includes(name)),
    rowCounts: Object.fromEntries(rows.map((row) => [row.name, Number(row.approx_rows)])),
  };
}

/**
 * Runs the plugin's schema.sql. Idempotent by contract, so re-activating a plugin whose tables
 * are already there is a no-op rather than an error — the same promise supabase/schema.sql makes.
 */
export async function installPluginSchema(connectionString, id, catalogue = null) {
  const { plugin, database } = await readPluginDatabase(id, catalogue);
  if (!database || !database.schema) {
    return { installed: false, reason: 'no-schema', plugin: plugin.id, tables: [] };
  }
  const sql = await readSql(database.schema);
  try {
    return await withClient(connectionString, async (client) => {
      const before = await readSchemaState(client, database.tables);
      await client.query(sql);
      const after = await readSchemaState(client, database.tables);
      return {
        installed: true,
        plugin: plugin.id,
        tables: after.present,
        // "already there" vs "just created", so the Plugins screen can say which happened.
        created: after.present.filter((name) => !before.present.includes(name)),
        stillMissing: after.missing,
      };
    }, { transaction: true });
  } catch (error) {
    throw new SchemaError(500,
      `plugins/${plugin.folder}/schema.sql failed, and nothing was applied: ${describeDbError(error, connectionString)}`);
  }
}

/**
 * Every row of every table the plugin owns, plus its option rows, as one JSON document.
 * Shaped like rwp_backup_export so the same restore path can read it.
 */
export async function exportPluginData(connectionString, id, catalogue = null) {
  const { plugin, database } = await readPluginDatabase(id, catalogue);
  if (!database) throw new SchemaError(400, `"${id}" declares no database tables, so there is nothing to export.`);
  try {
    return await withClient(connectionString, async (client) => {
      const state = await readSchemaState(client, database.tables);
      const tables = {};
      for (const name of state.present) {
        // Identifier, not a parameter: readPluginDatabase has already checked it against
        // /^[a-z_][a-z0-9_]{0,62}$/, and format(%I) quotes it again.
        const { rows } = await client.query(
          `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as data from public.${name} t`,
        );
        tables[name] = rows[0].data;
      }
      let options = [];
      if (database.options.length) {
        const { rows } = await client.query(
          'select option_name, option_value from public.options where option_name like any($1::text[]) order by option_name',
          [database.options],
        );
        options = rows;
      }
      return {
        format: 'react-wp-plugin-backup',
        version: 1,
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
        created_at: new Date().toISOString(),
        // Declared but absent: recorded so a restore does not silently skip a table.
        missing_tables: state.missing,
        tables,
        options,
      };
    });
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError(500, `Exporting ${plugin.id} data failed, so nothing was wiped: ${describeDbError(error, connectionString)}`);
  }
}

/** `_` and `%` are wildcards in LIKE, so a prefix has to be escaped before it is used as one. */
const likePrefix = (prefix) => `${prefix.replace(/([\\%_])/g, '\\$1')}/%`;

/**
 * Media rows whose provider file sits under one of the plugin's prefixes.
 *
 * Matched on provider_file_id, the stored public id, and not on media.folder: media.folder is
 * the library folder shown in the admin and moving an item changes it without touching the
 * provider file. Rows uploaded before provider_file_id existed have their id recovered from the
 * delivery URL, the same way /api/media-delete does it.
 */
export async function readPluginMedia(client, prefixes) {
  if (!prefixes?.length) return [];
  const { rows } = await client.query(
    `select id, provider, provider_file_id, url
       from public.media
      where provider = 'cloudinary'
        and (provider_file_id like any($1::text[]) or url like any($2::text[]))`,
    [prefixes.map(likePrefix), prefixes.map((prefix) => `%/${prefix}/%`)],
  );
  return rows.map((row) => {
    const fromUrl = row.url ? parseCloudinaryUrl(row.url) : null;
    return {
      id: row.id,
      url: row.url || '',
      publicId: row.provider_file_id || fromUrl?.publicId || null,
      resourceType: fromUrl?.resourceType || 'image',
    };
  }).filter((item) => item.publicId && prefixes.some((prefix) =>
    // Fixed-folder clouds put the folder in the public id. Dynamic-folder clouds do not, and the
    // only trace of the folder is in the delivery URL, so both are accepted. Deleting by prefix
    // alone would silently miss every asset in a dynamic-folder cloud.
    item.publicId.startsWith(`${prefix}/`) || item.url.includes(`/${prefix}/`)));
}

/** Removes the library rows for files that have just been deleted at the provider. */
export async function deleteMediaRows(client, ids) {
  if (!ids.length) return 0;
  const { rowCount } = await client.query('delete from public.media where id = any($1::uuid[])', [ids]);
  return rowCount || 0;
}

/** Runs the plugin's uninstall.sql in one transaction. Only ever called after an explicit confirmation. */
export async function dropPluginSchema(connectionString, id, catalogue = null) {
  const { plugin, database } = await readPluginDatabase(id, catalogue);
  if (!database || !database.uninstall) {
    throw new SchemaError(400,
      `"${id}" ships no uninstall.sql, so its tables cannot be dropped automatically. Remove them by hand in the Supabase SQL Editor.`);
  }
  const sql = await readSql(database.uninstall);
  try {
    return await withClient(connectionString, async (client) => {
      await client.query(sql);
      const after = await readSchemaState(client, database.tables);
      if (after.present.length) {
        // The transaction is still open, so this rolls the whole thing back.
        throw new Error(`uninstall.sql ran without error but left ${after.present.join(', ')} in place.`);
      }
      return { dropped: database.tables, plugin: plugin.id };
    }, { transaction: true });
  } catch (error) {
    throw new SchemaError(500,
      `plugins/${plugin.folder}/uninstall.sql failed, and nothing was dropped: ${describeDbError(error, connectionString)}`);
  }
}

/**
 * The catalogue `vite.pluginCatalogue.mjs` inlines into the serverless bundle: for every plugin in
 * `plugins/`, what a live install would have answered for this checkout — its manifest facts, the
 * text of both SQL files, and the plugins whose code imports it.
 *
 * That last one cannot be asked at request time on a host with no filesystem, and it is the check
 * that stops an uninstall from breaking the next build (another plugin importing the folder about to
 * go), so it is answered here, at build time, by the same scan `deletePluginFolder` runs.
 *
 * Returns `{ entries, problems }`: the folders `listPluginFolders` refused to call a plugin have no
 * entry, so they answer 404 at request time, and the build prints them.
 */
export async function pluginCatalogue() {
  const { plugins, problems } = await listPluginFolders();
  const entries = [];
  for (const plugin of plugins) {
    const { mediaPrefixes, database } = await readPluginDatabase(plugin.id);
    entries.push({
      plugin,
      mediaPrefixes,
      database: database ? {
        tables: database.tables,
        options: database.options,
        retains: database.retains,
        // Declared but unreadable is recorded as `text: null`, so the request reports the same 404
        // a host with a disk would have produced rather than pretending the file is not declared.
        schema: await inlineSql(database.schema),
        uninstall: await inlineSql(database.uninstall),
      } : null,
      importers: await findImporters(plugin.folder),
    });
  }
  return { entries, problems };
}

/** The declared file, as the catalogue carries it: its text, and no path to open at request time. */
const inlineSql = async (source) => {
  if (!source) return null;
  return { path: null, text: await readFile(source.path, 'utf8').catch(() => null), label: source.label };
};

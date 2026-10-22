/**
 * The plugin lifecycle work both hosts share: what a plugin's database holds now, installing its
 * schema, and the uninstall — export, then drop, then remove the code.
 *
 * `server/adminRoutes.mjs` serves these to `server.mjs`, and `src/server/routes/pluginSchema.ts`
 * serves them to the universal engine, so a Vercel deployment answers exactly what `npm start`
 * answers. Only two things differ between hosts, and both are passed in rather than looked up here:
 *
 *   - who may run it. `adminRoutes.mjs` asks Supabase with the caller's own token (`requireManager`);
 *     the universal route asks through the engine's adapters — the same split
 *     `POST /api/admin/plugins/upload` already makes. A refusal never reaches this module.
 *   - where a plugin's manifest is read from, and what happens to its code. `catalogue` is a host
 *     with no `plugins/` folder reading the build's answer instead of the disk, and `removeFolder` is
 *     the step that deletes a directory on one host and commits a deletion on another.
 *
 * The order inside an uninstall is not negotiable, and it is written down once, here: export, then
 * drop, then remove the code. Each step runs only if the one before it succeeded, so nobody ends up
 * with wiped tables and no backup file.
 */
import { hasStoredCredentials, resolveConnectionString, withClient } from './db.mjs';
import { deletePluginFolder } from './pluginFiles.mjs';
import { readMediaStorageSettings } from './integrationSettings.mjs';
import { wipePluginMedia } from './pluginMediaWipe.mjs';
import {
  dropPluginSchema, exportPluginData, installPluginSchema, readPluginDatabase, readSchemaState, SchemaError,
} from './pluginSchema.mjs';

/** Connection string, or the 400/501 that names both ways of supplying one. */
const requireConnection = (body, config) => {
  const resolved = resolveConnectionString(body, config);
  if (!resolved.ok) throw new SchemaError(resolved.status, resolved.error);
  return resolved.url;
};

/** `process.env` where there is one, and nothing where there is not (Workers, Deno, Bun). */
const serverEnvironment = () => globalThis.process?.env ?? {};

/**
 * Whether Cloudinary could delete files right now: presence only, never a value. The keys are read
 * from the row the Integrations hub writes, so the uninstall dialog and the delete itself always
 * agree: the screen cannot be told deletion works while the route is looking at another row.
 *
 * `readSetting` is the engine's own database handle on a host that has one. `readIntegrationRows`
 * takes it in preference to opening a connection, which is why the universal route passes it.
 */
export const cloudinaryConfigured = async (config, options = {}) => {
  const media = await readMediaStorageSettings({
    readSetting: options.readSetting,
    databaseUrl: config?.databaseUrl,
    dbType: config?.dbType,
    supabaseUrl: config?.supabaseUrl,
    supabaseKey: config?.supabasePublishableKey,
    env: options.env ?? serverEnvironment(),
  });
  return Boolean(media.credentials.cloudinary.apiKey && media.credentials.cloudinary.apiSecret);
};

/**
 * `GET /api/admin/plugins/schema-status?id=<plugin>` — what the Plugins screen needs to decide whether
 * to offer Install schema, and what the uninstall dialog needs to tell the truth about how much data
 * is at stake.
 *
 * Never fails over a missing connection or an unreadable table: `checked: false` plus a `reason` says
 * the state could not be read, which is a different thing from "the plugin owns no tables", and the
 * dialog keeps working either way.
 */
export async function pluginSchemaStatus(config, id, options = {}) {
  const { plugin, database, mediaPrefixes } = await readPluginDatabase(id, options.catalogue ?? null);
  const base = {
    plugin: plugin.id,
    name: plugin.name,
    hasSchema: Boolean(database?.schema),
    canDrop: Boolean(database?.uninstall),
    tables: database?.tables || [],
    retains: database?.retains || [],
    mediaPrefixes,
    cloudinaryConfigured: await cloudinaryConfigured(config, options),
    storedCredentials: hasStoredCredentials(),
  };
  if (!database?.tables.length) return { ...base, checked: false };

  const resolved = resolveConnectionString({}, config);
  if (!resolved.ok) {
    // Not an error: without credentials the screen still works, it just cannot show row counts.
    return { ...base, checked: false, reason: resolved.error };
  }
  try {
    const state = await withClient(resolved.url, (client) => readSchemaState(client, database.tables));
    return { ...base, checked: true, ...state };
  } catch (error) {
    return { ...base, checked: false, reason: error instanceof Error ? error.message : 'unknown error' };
  }
}

/** `POST /api/admin/plugins/install-schema { id, dbPassword? | connectionString? }` */
export async function installPluginSchemaFor(config, id, body = {}, options = {}) {
  const { database } = await readPluginDatabase(id, options.catalogue ?? null);
  // Asked before the connection is resolved, so a plugin that owns no tables answers "no-schema"
  // rather than demanding credentials this server may not have.
  if (!database?.schema) {
    return { installed: false, reason: 'no-schema', plugin: id, tables: [] };
  }
  return installPluginSchema(requireConnection(body, config), id, options.catalogue ?? null);
}

/**
 * `POST /api/admin/plugins/uninstall`
 *   { id, mode: 'keep' | 'wipe', backup: boolean, confirm?: 'DELETE',
 *     deleteFolder?: boolean, dbPassword? | connectionString? }
 *
 * `options` carries what only a host can answer:
 *
 *   - `catalogue`     the build's manifest facts, on a host with no `plugins/` folder to read
 *   - `readActiveIds` the `rwp_active_plugins` list, or `null` when the option row is missing — read
 *                     through the reader the caller already has: Supabase with the caller's own token
 *                     on the classic host, the engine's database adapter everywhere else. It is a
 *                     function, not an array, so a failure to read it stays a warning about the code
 *                     (below) instead of failing an uninstall whose database half already committed
 *   - `readSetting`   that same adapter, for the Cloudinary key check while a wipe is prepared
 *   - `removeFolder`  what to do with the code. Defaults to deleting the folder; a serverless host
 *                     commits the removal to the repository its deployment is built from instead
 */
export async function uninstallPlugin(config, body = {}, options = {}) {
  const id = String(body.id || '');
  const mode = body.mode === 'wipe' ? 'wipe' : 'keep';
  const wantsBackup = body.backup !== false;
  const removeCode = body.deleteFolder !== false;
  const catalogue = options.catalogue ?? null;

  const { plugin, database, mediaPrefixes, importers } = await readPluginDatabase(id, catalogue);

  if (mode === 'wipe') {
    if (String(body.confirm || '') !== 'DELETE') {
      throw new SchemaError(400, 'Type DELETE in the confirmation box to wipe this plugin\'s data.');
    }
    if (!database?.uninstall) {
      throw new SchemaError(400,
        `"${plugin.id}" ships no uninstall.sql, so its tables cannot be dropped automatically. Choose "keep data", then remove them by hand in the Supabase SQL Editor.`);
    }
  }

  // Resolved up front: finding out the password is wrong only after the code is gone would be the
  // worst possible ordering. A plugin that owns no tables never opens a connection at all, so
  // uninstalling one must not demand credentials this server may not have.
  // A wipe always connects (it was refused above unless the plugin ships uninstall.sql). A backup
  // only connects when there is something to read, so uninstalling a code-only plugin works on a
  // server that has no database credentials at all.
  const needsDatabase = mode === 'wipe' || (wantsBackup && Boolean(database?.tables.length));
  const connectionString = needsDatabase ? requireConnection(body, config) : '';

  const result = { plugin: plugin.id, mode, backup: null, media: null, dropped: null, folderDeleted: false, warnings: [] };

  if (wantsBackup) {
    if (!database?.tables.length) {
      result.warnings.push(`${plugin.name} declares no tables in its manifest, so the backup file is empty.`);
      result.backup = {
        format: 'react-wp-plugin-backup', version: 1,
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
        created_at: new Date().toISOString(), missing_tables: [], tables: {}, options: [],
      };
    } else {
      result.backup = await exportPluginData(connectionString, id, catalogue);
    }
  }

  if (mode === 'wipe') {
    // Media before tables, as specified: once the rows are gone there is no record of which
    // Cloudinary files this plugin owned, and the delivery URLs are unrecoverable.
    result.media = await wipePluginMedia(connectionString, config, mediaPrefixes);
    result.warnings.push(...result.media.warnings);
    result.dropped = await dropPluginSchema(connectionString, id, catalogue);
  }

  if (removeCode) {
    const removeFolder = options.removeFolder ?? removePluginFolderFromDisk;
    const removal = await removeFolder({ plugin, importers, readActiveIds: options.readActiveIds });
    result.folderDeleted = Boolean(removal?.folderDeleted);
    result.serverImportRemoved = Boolean(removal?.serverImportRemoved);
    // A git-backed uninstall reports the commit it made; the dialog names the repository from it,
    // so "the folder is still here" is never said about code that has already been committed away.
    if (removal?.git) result.git = removal.git;
    result.warnings.push(...(removal?.warnings || []));
  }

  return result;
}

/**
 * The deletion a host with a writable `plugins/` folder makes. Which plugin may go stays
 * `deletePluginFolder`'s rule: the plugin must be inactive, and no other plugin may import its code.
 *
 * It never throws. The database half above has already run and an error response would throw that
 * report away, so a refusal — or a failure — is a warning beside the code it concerns.
 *
 * `importers` is unused here for the same reason: on this host the importer scan runs inside
 * `deletePluginFolder`, at deletion time, against the folders that are actually on disk. A
 * catalogue host has to be told the build's answer instead, because there is nothing to scan.
 */
export async function removePluginFolderFromDisk({ plugin, readActiveIds }) {
  try {
    const folder = await deletePluginFolder(plugin.id, { activeIds: await readActiveIds() });
    if (folder.status === 200) {
      return { folderDeleted: true, serverImportRemoved: Boolean(folder.body.serverImportRemoved), warnings: [] };
    }
    return { folderDeleted: false, serverImportRemoved: false, warnings: [`The plugin folder was kept: ${folder.body.error}`] };
  } catch (error) {
    return {
      folderDeleted: false,
      serverImportRemoved: false,
      warnings: [`The plugin folder was kept: ${error instanceof Error ? error.message : 'unknown error'}`],
    };
  }
}

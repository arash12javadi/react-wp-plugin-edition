/**
 * Deleting the files a plugin uploaded, together with the matching `media` rows.
 *
 * Rule A lives here: only the plugin's own prefixes go (`plugins/<id>/…`), never `media/`, and the
 * files are found through `provider_file_id`/delivery-URL matching rather than through the plugin's
 * own tables — a shop row may point at a Media Library file the administrator also used on a page.
 *
 * The uninstall route calls this on both hosts (`server/adminRoutes.mjs` where the site's own
 * filesystem is writable, `src/server/routes/pluginSchema.ts` where it is not), and both have an
 * already-resolved working connection by then, which is the only thing this needs besides the
 * request config.
 */
import { cloudinaryConfig, deleteCloudinaryFolder, deleteCloudinaryMediaByIds, mergeResults } from './cloudinary.mjs';
import { withClient } from './db.mjs';
import { deleteMediaRows, readPluginMedia } from './pluginSchema.mjs';

/** @param prefixes the `plugins/<id>/…` prefixes read from the plugin's manifest */
export async function wipePluginMedia(connectionString, config, prefixes) {
  const summary = { attempted: true, deleted: 0, notFound: 0, rowsRemoved: 0, prefixes, warnings: [] };
  // The uninstall already holds a working database connection, so the Cloudinary keys are read through
  // it — that is the one reader that works on every deployment, including Supabase.
  const cloud = await cloudinaryConfig({ ...config, databaseUrl: connectionString, dbType: 'postgres' });
  if (!cloud.ok) {
    summary.attempted = false;
    summary.warnings.push(cloud.reason);
    return summary;
  }
  try {
    const items = await withClient(connectionString, (client) => readPluginMedia(client, prefixes));
    const results = [];
    for (const prefix of prefixes) results.push(await deleteCloudinaryFolder(prefix, cloud));
    if (items.length) results.push(await deleteCloudinaryMediaByIds(items, cloud));
    const merged = mergeResults(...results);

    summary.deleted = new Set(merged.deleted).size;
    summary.notFound = new Set(merged.notFound).size;
    summary.warnings.push(...merged.warnings);

    // The rows go even for ids Cloudinary reported as not_found: the file is gone either way,
    // and leaving the row behind would show a broken image in the library forever.
    if (items.length) {
      summary.rowsRemoved = await withClient(connectionString,
        (client) => deleteMediaRows(client, items.map((item) => item.id)));
    }
  } catch (error) {
    summary.warnings.push(`Media cleanup for ${prefixes.join(', ')} did not finish: ${error instanceof Error ? error.message : 'unknown error'}. The database cleanup continued.`);
  }
  return summary;
}

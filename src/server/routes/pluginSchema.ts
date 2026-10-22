/**
 * Plugins → Schema status, Install schema and Uninstall, on every host that runs the universal engine.
 *
 * The work itself is `server/pluginUninstall.mjs`: one implementation of "what the database holds now,
 * install the declared schema, and uninstall in the only safe order — export, then drop, then remove
 * the code" — shared with `server/adminRoutes.mjs`, which is how `npm start` answers these three paths.
 * What this file adds is the universal engine's own half: the caller is authorised through the engine's
 * adapters (or, under Supabase, by the project itself), and the two questions only a host can answer
 * are answered here.
 *
 *   - Where a manifest is read from. A serverless function has no `plugins/` folder, so the build's
 *     `pluginCatalogue()` is inlined into the bundle by `vite.pluginCatalogue.mjs`
 *     (`__RWP_PLUGIN_CATALOGUE__`) and passed as the catalogue. A persistent host has the folder, so it
 *     passes no catalogue at all and every reader falls back to the disk, exactly as `npm start` does.
 *   - What happens to the code. `server/pluginGitUninstall.mjs` commits the deletion to the repository
 *     the deployment is built from; on a host whose disk outlives the request the shared module's own
 *     `removePluginFolderFromDisk` deletes the folder, so no remover is passed at all.
 *
 * With `POST /api/admin/plugins/upload` this completes the plugin administration API, and because
 * `vercel.json` rewrites every unmatched `/api/*` path to this Hono app, a Vercel deployment answers
 * all three of these the way `npm start` does. That is what `src/lib/pluginSchema.ts` counts on when it
 * reads a 404 *with no `error` in the body* as "this host cannot do it": a 404 from here always carries
 * one, including "this deployment was built without a plugin with that id".
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ensureSiteInstalled, getRuntimeConfig } from '../config';
import { detectPluginHostMode } from '../pluginHostMode';
import {
  HttpError,
  githubTarget,
  messageOf,
  requirePluginManager,
  settingsStore,
  statusOf,
  systemSettingReader,
} from '../pluginHostAccess';
import type { RuntimeConfig } from '../../lib/runtime';
import { installPluginSchemaFor, pluginSchemaStatus, uninstallPlugin } from '../../../server/pluginUninstall.mjs';
import { pluginFolderRemover } from '../../../server/pluginGitUninstall.mjs';

export const pluginSchemaRouter = new Hono();

/**
 * The build's plugin catalogue, inlined by `vite.pluginCatalogue.mjs`
 * (`define: __RWP_PLUGIN_CATALOGUE__`).
 *
 * `typeof` is load-bearing, exactly as it is for `__RWP_SCHEMA_SQL__` in `src/server/index.ts`: on a
 * builder that does not define it — `tsx`, `npm run start:hono` — the identifier is never declared, and
 * reading it directly would be a `ReferenceError`. `typeof` never dereferences an undeclared name.
 *
 * It arrives as JSON text in a string literal — `vite.pluginCatalogue.mjs` stringifies twice to get
 * there, and documents why — rather than as the array itself. Both halves of that matter here: handed an
 * array literal, `JSON.parse` would be reading `"[object Object]"`, and the guard below would not fire
 * at all, because a non-primitive `define` is not substituted inside `typeof`. The read would then
 * answer "this host has a folder to read" on a host that has none, and every plugin would 404 in
 * production with nothing from the build to say so.
 *
 * Absent means "this host has a `plugins/` folder to read", which is the answer the shared module wants
 * there: no catalogue, so every manifest comes off the disk. An empty catalogue is a different thing and
 * is passed on as one — this deployment was built with no plugin folder carrying that id, and the 404
 * the shared module answers with says so instead of blaming a disk.
 */
declare const __RWP_PLUGIN_CATALOGUE__: string | undefined;

/**
 * `undefined` until the first call. The catalogue is the whole of every manifest, `schema.sql` and
 * `uninstall.sql` — hundreds of KB of text that cannot change while the process runs — so the parse
 * happens when a plugin route is actually reached, and once.
 */
let catalogueFromBuild: unknown[] | null | undefined;

const pluginCatalogueFromBuild = (): unknown[] | null => {
  if (catalogueFromBuild === undefined) catalogueFromBuild = readCatalogueFromBuild();
  return catalogueFromBuild;
};

/**
 * `null` when the build declared no catalogue at all, otherwise the entries it inlined — and `[]` when
 * the inlined text cannot be read.
 *
 * Unreadable is treated as built-without-everything rather than as absent: falling back to the disk
 * would answer "no plugin folder has that id", which is a statement about a filesystem this host does
 * not have. The message an empty catalogue produces names the build, which is where the problem is.
 */
function readCatalogueFromBuild(): unknown[] | null {
  if (typeof __RWP_PLUGIN_CATALOGUE__ !== 'string') return null;
  try {
    const entries = JSON.parse(__RWP_PLUGIN_CATALOGUE__) as unknown;
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/**
 * `rwp_active_plugins`, read through this engine's own adapter.
 *
 * `null` means the option row is missing, which `App.tsx` reads as "every bundled plugin is active" —
 * so nothing may be deactivated or deleted on the strength of that answer. A value that is not an array
 * is read as `[]` instead: the row exists, it just does not list anything this release understands.
 * `server/pluginFiles.mjs`'s own reader (the classic host's, with the caller's token) has made that same
 * choice since it was written, so the two hosts cannot disagree about which plugin may be removed.
 */
async function readActiveIds(config: RuntimeConfig): Promise<string[] | null> {
  const value = await settingsStore(config).getOption('rwp_active_plugins');
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The function `pluginUninstall.mjs` calls once the database half has committed.
 *
 * Derived from `pluginGitUninstall.mjs` rather than written out here, deliberately: the remover is the
 * one argument the two hosts answer differently, so if the commit path changes what it returns — the
 * commit it names, the warnings it leaves behind — the shape `pluginUninstall.mjs` reads has to change
 * with it, and deriving the type is what turns that into a compile error rather than a field that
 * quietly goes missing at runtime.
 */
type PluginFolderRemover = ReturnType<typeof pluginFolderRemover>;

/**
 * The code half of an uninstall, as this host can do it.
 *
 * A host that can write `plugins/` gets no remover at all: the shared module's default deletes the
 * folder, with the importer scan that guards it running against the folders actually on disk — the
 * stronger check, since a catalogue only knows what the build saw.
 *
 * A host that cannot gets `server/pluginGitUninstall.mjs`, built with the connection resolved lazily:
 * `githubTarget` throws its 501 when the stored `github_config` row cannot be read, and asking for it
 * here would turn a missing credential into a failed uninstall whose tables have already been dropped.
 * As a warning it says exactly what is left instead: the code, and where to go and delete it.
 */
async function folderRemover(config: RuntimeConfig): Promise<PluginFolderRemover | undefined> {
  if (await detectPluginHostMode() === 'local') return undefined;
  return pluginFolderRemover({ resolveTarget: () => githubTarget(config) });
}

/**
 * Everything that can be refused with a status before any work starts: whether this site is installed,
 * and who is asking.
 *
 * The auto-heal comes before the refusal — the same repair `server.mjs` applies on boot and the upload
 * route applies — so a site that is configured but was never marked installed has its `options.installed`
 * row written here, rather than the caller being told to go and run SQL.
 */
async function prepare(c: Context): Promise<RuntimeConfig> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  let config = await getRuntimeConfig();
  if (!config.installed) config = await ensureSiteInstalled();
  if (!config.installed) throw new HttpError(409, 'This site is not installed yet, so plugins cannot be managed.');
  await requirePluginManager(token, config);
  return config;
}

/**
 * The one shape a refusal takes here. The status is the one a shared module asked for — `SchemaError`,
 * `InstallError` and `HttpError` all carry it — or 500, and the body is the `{ error }` the classic host
 * answers with, so `src/lib/pluginSchema.ts` shows one sentence whichever host produced it.
 */
const fail = (c: Context, error: unknown) =>
  c.json(
    { error: messageOf(error) },
    (error instanceof HttpError ? error.status : statusOf(error) ?? 500) as ContentfulStatusCode,
  );

/** A JSON body, or `{}`: the shared module validates the fields it needs (`id`, `mode`, `confirm`). */
const readJson = async (c: Context): Promise<Record<string, unknown>> =>
  (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

/**
 * `GET /api/admin/plugins/schema-status?id=<plugin>` — what the Plugins screen reads before it offers
 * "Install schema", and what the uninstall dialog reads to say how much data is at stake.
 *
 * The shared module never fails over a missing connection or an unreadable table: it answers
 * `checked: false` plus a reason, which is a different thing from "the plugin owns no tables", so the
 * dialog keeps working either way. What can fail here is the authorisation and, on a catalogue host, an
 * id the build does not know — both of which the caller has to be told about.
 */
async function schemaStatus(c: Context): Promise<Response> {
  try {
    // The query is checked before the caller is, which is the order `server/adminRoutes.mjs` answers in:
    // a client that forgot `?id=` gets the same 400 with the same sentence from either host, and that
    // sentence says nothing a caller does not already know.
    const id = c.req.query('id') || '';
    if (!id) throw new HttpError(400, 'Pass ?id=<plugin id>.');
    const config = await prepare(c);
    return c.json(await pluginSchemaStatus(config, id, {
      catalogue: pluginCatalogueFromBuild(),
      readSetting: systemSettingReader(config),
    }));
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * `POST /api/admin/plugins/install-schema { id, dbPassword? | connectionString? }`
 *
 * Idempotent, so the Plugins screen can call it on every activation rather than tracking installed-ness
 * in a column that drifts from the database. The connection is resolved by the shared module — the URL
 * this deployment holds, or the one in the body — so `npm start` and a serverless host behave
 * identically, including the 400/501 that names both ways of supplying one.
 */
async function installSchema(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const body = await readJson(c);
    return c.json(await installPluginSchemaFor(config, String(body.id || ''), body, {
      catalogue: pluginCatalogueFromBuild(),
    }));
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * `POST /api/admin/plugins/uninstall`
 *   { id, mode: 'keep' | 'wipe', backup: boolean, confirm?: 'DELETE',
 *     deleteFolder?: boolean, dbPassword? | connectionString? }
 *
 * The order — export, then drop and wipe, then remove the code — is `pluginUninstall.mjs`'s, written
 * once there for both hosts. What is settled here is the two things only this host knows: the importer
 * list (from the build, when there is no folder to scan) and what "remove the code" means (a commit,
 * when the disk does not survive the request). Everything the shared module needs to read, it reads
 * through the readers passed in, so a failure to read the active list stays a warning beside the code
 * instead of a 500 that would discard the report of a wipe that already happened.
 *
 * `folderRemover` is only built when the code is actually going: the host probe writes a file into
 * `plugins/` and `.rwp-tmp/` to answer, which is work an uninstall that keeps the folder has no reason
 * to do.
 */
async function uninstall(c: Context): Promise<Response> {
  try {
    const config = await prepare(c);
    const body = await readJson(c);
    return c.json(await uninstallPlugin(config, body, {
      catalogue: pluginCatalogueFromBuild(),
      readSetting: systemSettingReader(config),
      readActiveIds: () => readActiveIds(config),
      removeFolder: body.deleteFolder === false ? undefined : await folderRemover(config),
    }));
  } catch (error) {
    return fail(c, error);
  }
}

pluginSchemaRouter.get('/schema-status', schemaStatus);
pluginSchemaRouter.post('/install-schema', installSchema);
pluginSchemaRouter.post('/uninstall', uninstall);

/**
 * Any other verb on those three paths is a 405 with the body `server/adminRoutes.mjs` answers — the
 * generic handlers are registered above, so they still win for `GET`/`POST`.
 *
 * Without this the engine would leave `/api/admin/plugins/*` unmatched, and the caller would read
 * `No API endpoint at …` (Hono's own 404) instead of `Method not allowed`: the same mistake answered
 * two different ways depending on which host served it, which is exactly the drift these routes exist
 * to avoid.
 */
for (const path of ['/schema-status', '/install-schema', '/uninstall']) {
  pluginSchemaRouter.all(path, (c) => c.json({ error: 'Method not allowed' }, 405));
}



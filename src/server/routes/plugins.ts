/**
 * Plugins → Upload Plugin, on every host that runs the universal engine.
 *
 * Two installers, and the host chooses. `server/pluginInstaller.mjs` writes `plugins/<id>/`, which is the
 * classic path and the right one wherever that folder survives the request. A serverless function's
 * filesystem is read-only (`EROFS`), and a folder only becomes part of the site after a build anyway, so
 * there the work does not disappear, it moves: `server/pluginGitInstaller.mjs` applies the same checks
 * with the same code and then commits the plugin to the repository the deployment is built from, so an
 * upload arrives with the next build instead of failing on a disk that will never be writable. The
 * commit, and the credential it uses, are `server/pluginGitPush.mjs`; the choice itself is
 * `src/server/pluginHostMode.ts`, asked before the body is read. Who may upload, and where a commit's
 * credential comes from, are `src/server/pluginHostAccess.ts` — the same module the schema and
 * uninstall routes ask, so the three plugin paths authorise and read alike.
 *
 * The order below is deliberate. Identity, capability and "is this site installed" are settled first; the
 * GitHub connection is then required of the hosts that need it and of no others; the ZIP is read last, so
 * a 25 MB body is never buffered for a caller who may not upload one, and "paste a GitHub token first" is a
 * JSON status the dialog can show rather than a sentence buried in a stream. Everything after that point
 * streams NDJSON — one `{ type: 'step' }` per step, carrying the mode it belongs to, then
 * `{ type: 'result' }` or `{ type: 'error' }` — because HTTP has no second status code to give once the
 * answer has started.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ensureSiteInstalled, getRuntimeConfig } from '../config';
import type { PluginHostMode } from '../pluginHostMode';
import type { RuntimeConfig } from '../../lib/runtime';
import {
  HttpError,
  deployHookUrl,
  messageOf,
  pluginHostPlan,
  requirePluginManager,
  settingsStore,
  statusOf,
  type PluginHostPlan,
} from '../pluginHostAccess';
import {
  installPlugin,
  MAX_ZIP_BYTES,
  type PluginInstallSource,
  type PluginInstallStep,
} from '../../../server/pluginInstaller.mjs';
import { installPluginFromGit } from '../../../server/pluginGitInstaller.mjs';

export const pluginsRouter = new Hono();

/** The raw ZIP bytes, in whichever of the two shapes a client may have sent them. */
async function readZipBytes(c: Context): Promise<Buffer> {
  const contentType = (c.req.header('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (file instanceof File) return Buffer.from(await file.arrayBuffer());
    // A part sent as text — `curl -F file=@plugin.zip` after a client re-encoded it — arrives as a data
    // URI, which is how the classic route read it too.
    const dataUrl = typeof file === 'string' ? /^data:[^,]*;base64,([\s\S]*)$/.exec(file) : null;
    if (dataUrl) return Buffer.from(dataUrl[1], 'base64');
    return Buffer.alloc(0);
  }
  return Buffer.from(await c.req.raw.arrayBuffer());
}

/**
 * What to install: the ZIP the dialog posted, or the `https://` URL it asked us to fetch.
 *
 * The size is checked before the bytes are unpacked so an oversized body is refused as a size problem
 * rather than as a broken archive, and the URL is restricted to `https://` — the classic route's rule,
 * kept, because a plaintext download of executable code is worth refusing twice.
 */
async function readSource(c: Context): Promise<PluginInstallSource> {
  const contentType = (c.req.header('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) throw new HttpError(400, 'A .zip plugin package, or a URL to one, is required.');
    if (!/^https:\/\//i.test(url)) throw new HttpError(400, 'A plugin URL must start with https://.');
    return { url };
  }
  const zip = await readZipBytes(c);
  if (zip.length === 0) throw new HttpError(400, 'A .zip plugin package is required.');
  if (zip.length > MAX_ZIP_BYTES) throw new HttpError(413, 'The plugin ZIP is larger than the 25 MB limit.');
  return { zip };
}

/**
 * `POST /api/admin/plugins/upload` — the whole of what the dialog calls.
 *
 * Two phases, and the split is the point: everything that can be refused with a status happens first
 * and answers JSON, carrying the status that says what to do about it. The install then answers NDJSON,
 * because by then the response has begun — and the steps keep arriving while a folder is written or a
 * commit is made, so the dialog shows where the upload is rather than a spinner and a guess.
 *
 * Where the plugin goes is settled once, in `pluginHostPlan`, and travels on every event and in the result:
 * the dialog labels its steps with it, so "installing" reads as one thing on a host that writes
 * `plugins/<id>/` and another on a host that commits.
 */
async function upload(c: Context): Promise<Response> {
  let config: RuntimeConfig;
  let plan: PluginHostPlan;
  let source: PluginInstallSource;
  let deployHook: string;
  let mode: PluginHostMode | undefined;
  try {
    const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
    config = await getRuntimeConfig();
    // The auto-heal, *before* the refusal: a site that is configured but was never marked installed has
    // its `options.installed` row and `data/react-wp-config.json` written here, instead of the caller
    // being told to go and run SQL. This is the same repair `server.mjs` applies on boot, and it is what
    // makes this route work on the hosts that never run `server.mjs` (Vercel, and `npm run start:hono`).
    if (!config.installed) config = await ensureSiteInstalled();
    if (!config.installed) {
      throw new HttpError(409, 'This site is not installed yet, so plugins cannot be installed.');
    }
    await requirePluginManager(token, config);
    plan = await pluginHostPlan(config);
    mode = plan.mode;
    source = await readSource(c);
    // After the host question, before the work: the hook is a `system_settings` read, and both paths read
    // it — a host that writes `plugins/<id>/` asks its deploy hook to rebuild too, and the installer's own
    // warning says that the platform's build only picks the folder up once it is committed and pushed.
    deployHook = await deployHookUrl(config);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : statusOf(error) ?? 500;
    // `mode`, once the host question is answered, says which path refused: a host with no disk and no
    // GitHub connection is a different problem from a ZIP this installer will not accept.
    return c.json({ error: messageOf(error), ...(mode ? { mode } : {}) }, status as ContentfulStatusCode);
  }

  const optionStore = settingsStore(config);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      const onStep = (step: PluginInstallStep) => send({ type: 'step', step, mode: plan.mode });
      try {
        const result = plan.mode === 'github'
          ? await installPluginFromGit({ source, target: plan.target, optionStore, deployHook, onStep })
          : await installPlugin(source, null, onStep, { optionStore, deployHook });
        send({ type: 'result', result: { ...result, mode: plan.mode } });
      } catch (error) {
        // The response is already a 200 with bytes in flight; the installer's own status travels in the
        // event, and `src/components/PluginUploadModal.tsx` is what turns it back into a message.
        send({ type: 'error', error: messageOf(error), status: statusOf(error) ?? 500 });
      } finally {
        controller.close();
      }
    },
  });

  return c.newResponse(stream, 200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    // A proxy that buffers answers would hold every step back until the last one, which is the single
    // thing the progress list must not do.
    'X-Accel-Buffering': 'no',
  });
}

pluginsRouter.post('/upload', upload);

/** The name this route had before the dialog existed; kept so an existing `curl` keeps working. */
pluginsRouter.post('/upload-zip', upload);

/**
 * Persistent Node.js server entry point.
 *
 * `npm run start:hono` builds the SPA and runs this: the universal API on Hono plus static serving
 * of `dist/` with SPA fallback, and of `<dataDir>/uploads` for sites that store media on disk.
 *
 * Route order is deliberate: every `/api/*` handler is registered **before** any static file
 * middleware or the catch-all SPA fallback, so `/api/install/check` (and friends) can never be
 * swallowed by `serveStatic` and answered with `index.html`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { app } from '../index';
import { ensureSiteInstalled, getRuntimeConfig, publicConfig, runStartupMigrations } from '../config';

const port = Number(process.env.PORT || 3000);
const indexHtmlPath = resolve(process.cwd(), 'dist/index.html');

/**
 * Where on-disk uploads live, for `RWP_STORAGE=local` (or a `storage` row in `system_settings`).
 *
 * `LocalStorageAdapter` (src/lib/storage/adapters/local.ts) writes `<dataDir>/uploads/<key>` and answers
 * `/uploads/<key>` as the file's public URL, so the directory has to be served from the same origin —
 * this adapter is the only server that does. `REACT_WP_DATA_DIR` is read here rather than hard-coded to
 * `data` because the adapter honours it too, and the two must agree.
 */
const dataDir = resolve(process.cwd(), process.env.REACT_WP_DATA_DIR || 'data');

/**
 * Renders `dist/index.html` with the *current* public config injected. The file is a build-time
 * artifact, so without this a site that finishes the Setup Wizard after the build would keep loading
 * the stale `installed: false`. Reading it per request lets Step 5 -> Dashboard work with no rebuild.
 */
async function renderIndexHtml(): Promise<string> {
  const template = await readFile(indexHtmlPath, 'utf8');
  const injected = `window.__REACT_WP_CONFIG__=${JSON.stringify(publicConfig(await getRuntimeConfig()))};`;
  if (template.includes('window.__REACT_WP_CONFIG__=null;')) {
    return template.replace('window.__REACT_WP_CONFIG__=null;', injected);
  }
  return template.replace(/window\.__REACT_WP_CONFIG__=[^;]*;/, injected);
}

const renderIndex = async (c: Context) => {
  try {
    return c.html(await renderIndexHtml());
  } catch {
    return c.text('dist/index.html is missing. Run "npm run build" before starting the server.', 500);
  }
};

const full = new Hono();

// 1. The universal API first — nothing below this may shadow an /api/* request.
full.route('/', app);

// 2. An unmatched /api/* path is an API 404 (JSON), never the SPA fallback.
full.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// 3. The site root gets index.html with the live config (registered before serveStatic, which would
//    otherwise serve the stale build-time index.html for '/').
full.get('/', renderIndex);

// 3b. Uploaded media. `serveStatic` below reads `./dist`, where `<dataDir>/uploads/<key>` is not, so
//     without this an image URL stored by the local storage driver answered with the SPA shell
//     (HTTP 200, `text/html`) — a broken image that no log line explains. The trailing handler keeps a
//     genuinely missing file a 404 instead of letting the SPA fallback claim it.
full.use('/uploads/*', serveStatic({ root: dataDir }));
full.all('/uploads/*', (c) => c.text('Not found', 404));

// 4. Static build assets (JS, CSS, images). Only ever reached when no API route matched.
full.use('*', serveStatic({ root: './dist' }));

// 5. SPA fallback for client-side routes (/admin, /login, ...).
full.get('*', renderIndex);

// Site auto-setup before anything else, then the core schema migrations: the auto-setup is what writes
// `options.installed` (and `data/react-wp-config.json`) on a site that was configured by hand, and the
// migration below is skipped entirely on a site that is not installed yet. Fire-and-forget, memoised,
// failure-safe — and it logs the `[Auto-Setup] Site installation verified/auto-seeded ...` line.
void ensureSiteInstalled()
  .then(() => runStartupMigrations())
  .catch(() => undefined);

serve({ fetch: full.fetch, port }, (info) => {
  console.log(`React-WP (Hono) listening on http://localhost:${info.port}`);
});

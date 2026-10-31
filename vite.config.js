import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { publicConfig } from './server/config.mjs'
import { resolveSiteConfig } from './server/autoSetup.mjs'
import { resolveEdition } from './src/lib/pluginEdition.js'
import { generateScopedName } from './vite.cssModules.mjs'
import { apiPort, devApiServer } from './vite.devApi.mjs'

/**
 * Where the dev server sends `/api`.
 *
 * Those routes are not the SPA's: the Setup Wizard's Step 3 probe, sessions, media deletes and DDL
 * live on the Node server, which `devApiServer()` starts for `npm run dev`. Both read the same
 * `PORT`, so moving the API server moves the proxy with it instead of leaving it aimed at :3000.
 */
const apiOrigin = `http://localhost:${apiPort()}`

/**
 * Which server `npm run dev` starts on that port.
 *
 * `server.mjs` speaks Supabase only — it says so, and tells you to run the universal server instead —
 * so a site on SQLite/Turso, PostgreSQL or MySQL gets the universal engine's entry
 * (`src/server/adapters/node.ts`, the same one `npm run start:hono` runs) and `npm run dev` keeps
 * working. Without this, a local `.env.local` with `VITE_DB_TYPE=libsql` started a server that refused
 * the very database the SPA next to it was reading, and `/api` answered with that refusal.
 *
 * The decision is the *site's*, not this build's: `resolveSiteConfig()` reads `dbType` from
 * `data/react-wp-config.json` with `.env.local` filling what the file does not carry, exactly as the
 * server and the injected client config do.
 */
const devApiEntry = (config) => (config.dbType && config.dbType !== 'supabase'
  ? 'src/server/adapters/node.ts'
  : 'server.mjs')

/**
 * Resolved once, when this config is loaded — the same moment the API server is started, and the same
 * module `devApiServer` reads `PORT` from. `resolveSiteConfig()` is async (it reads
 * `data/react-wp-config.json`), which is exactly why a top-level `await` is used here rather than an
 * async config factory: the rest of this file is plain data, and the site's answer is not.
 */
const siteConfig = await resolveSiteConfig()

export default defineConfig({
  /**
   * CSS Modules render readable, stable class names instead of Vite's hashed ones.
   *
   * The default is postcss-modules' `_<local>_<hash>_<line>` (`_containerFull_1wxc3_13`), which is
   * anonymous in devtools and is renamed whenever the stylesheet's bytes or line numbers change.
   * `vite.cssModules.mjs` derives the name from the module's own path instead —
   * `src/components/PublicHome.module.css` `.containerFull` becomes
   * `rwp-public-home-containerFull`, the builder's admin becomes `rwp-page-builder-admin-*` — so the
   * class says where it comes from and survives a rebuild, a redeploy and a CSS edit. The path is
   * what keeps the two `admin.module.css` files, and the many `.panel`/`.input` locals, apart, which
   * a bare `[local]` would not. Read that file before changing the scheme.
   */
  css: {
    modules: { generateScopedName },
  },
  /**
   * The edition the browser bundle is built for, inlined into `src/lib/pluginEdition.js`.
   *
   * `RWP_EDITION=public npm run build` produces a customer's build, in which `rwp-ai-factory` and
   * `rwp-saas-installer` refuse to register; the default - no variable, or anything unrecognised - is
   * the development edition, which is this repository's whole point. The Node server reads the same
   * variable at runtime (`server/plugins.mjs`), so a self-hosted deployment needs no rebuild to change
   * its mind, while a static bundle has to be told at build time. Inlined rather than read from
   * `import.meta.env` because Vite only exposes `VITE_`-prefixed variables to the browser, and this one
   * is a build decision, not a site setting.
   */
  define: {
    __RWP_EDITION__: JSON.stringify(resolveEdition(process.env.RWP_EDITION)),
  },
  build: {
    // Split the always-loaded third-party libraries into their own long-lived
    // chunks so a vendor chunk can be reused from the browser cache across
    // deploys. Vite 8 bundles with Rolldown, which replaces Rollup's object-form
    // `manualChunks` with `output.codeSplitting.groups`. Use [\\/] so the test
    // matches on Windows too.
    //
    // With the vendors split out, every library chunk is under 500 kB; the
    // remaining entry chunk is this app's own code (App.tsx eagerly imports the
    // admin screens, including the TipTap-based editor). The limit is raised so
    // the warning again means "a library chunk got unusually big". Lazy-loading
    // the admin screens in src/App.tsx would shrink the entry chunk further.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      // Server-only drivers are loaded lazily (src/lib/db/adapters, src/lib/auth, src/lib/storage)
      // and must never be bundled into the browser build. Mark them external so Rolldown leaves the
      // dynamic import() calls untouched; they only resolve at runtime on a Node/edge server.
      external: (id) => {
        const serverOnly = ['pg', 'mysql2', 'better-sqlite3', '@libsql/client', 'bcryptjs', 'jose', '@aws-sdk/client-s3'];
        return serverOnly.some((module) => id === module || id.startsWith(`${module}/`));
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 20 },
            { name: 'tiptap', test: /node_modules[\\/](@tiptap|prosemirror-)/, priority: 20 },
            // CodeMirror belongs to the two screens that embed a code field — the builder's inspector
            // (plugins/rwp-page-builder/editor/CodeField.tsx) and the Code Snippets editor
            // (plugins/rwp-code-snippets/SnippetCodeField.tsx) — and to nothing else; both are plugin
            // screens, which load lazily. Left in the catch-all below it would be *shared* with the entry
            // chunk, so index.html would preload the whole editor into every visitor's page — and a
            // CodeMirror upgrade would invalidate the vendor chunk they already have cached. Its own group
            // keeps it behind those two imports.
            { name: 'codemirror', test: /node_modules[\\/](@codemirror|@lezer|@uiw|crelt|style-mod|w3c-keyname)[\\/]/, priority: 20 },
            // Catch-all for the rest of the third-party code, lowest priority so
            // the named groups above win. Keeps app code in the entry chunk.
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  plugins: [
    react(),
    {
      name: 'react-wp-server-config',
      async transformIndexHtml(html) {
        // `resolveSiteConfig` (server/autoSetup.mjs), not the file alone: in dev the SPA is served by
        // *this* process, which has loaded no `.env.local` of its own, and a site configured entirely
        // through `.env.local` would otherwise be told `installed: false` while the API server next to it
        // (which does load it) answered as an installed site.
        const config = publicConfig(await resolveSiteConfig())
        return html.replace(
          'window.__REACT_WP_CONFIG__=null;',
          `window.__REACT_WP_CONFIG__=${JSON.stringify(config)};`,
        )
      },
    },
    // The API server itself, so `npm run dev` is enough on its own. Which one is the site's choice —
    // see `devApiEntry` above.
    devApiServer({ entry: devApiEntry(siteConfig) }),
  ],
  server: {
    proxy: {
      '/api': {
        target: apiOrigin,
        /**
         * Names the one failure the browser could not: an unreachable API server.
         *
         * Vite answers a proxy error with a bare `502` and an empty body, so a missing `server.mjs`
         * reached the Setup Wizard as `Connection test failed (HTTP 502)` — for a Supabase project
         * that was perfectly reachable, on a step whose every other error is specific. This hook is
         * registered before Vite's own (which runs after `configure`), and Vite writes its plain 502
         * only when nothing has been sent yet, so the JSON body below is the one that survives and
         * every caller can print it verbatim.
         */
        configure(proxy) {
          proxy.on('error', (error, _request, response) => {
            if (typeof response?.writeHead !== 'function' || response.headersSent || response.writableEnded) return
            const message = `The React-WP API server at ${apiOrigin} could not be reached (${error.code || error.message}). `
              + 'Run "npm run dev", which starts it, or start it yourself with "npm start".'
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ success: false, ok: false, error: message, message }))
          })
        },
      },
      /**
       * Uploaded media, when the site stores files on disk (`RWP_STORAGE=local`, the default for a
       * self-hosted or local SQLite site). `npm run dev` serves the SPA from memory, so `/uploads/…` is
       * not a file Vite can find: the API server next to it owns that directory
       * (`src/server/adapters/node.ts`). Proxied rather than left to fall through, because an image that
       * loads under `npm run start:hono` and 404s under `npm run dev` is the kind of difference that
       * hides a storage bug until deploy.
       */
      '/uploads': { target: apiOrigin },
    },
  },
})

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

/**
 * Database, auth and storage drivers that only ever run on a Node/edge server. The adapters under
 * src/lib/db, src/lib/auth and src/lib/storage import them lazily, so they are left out of the browser
 * build (`external` below) and out of the dev server's dependency scan (`optimizeDeps.exclude`). Some are
 * optional dependencies that a given install does not have at all.
 */
const serverOnlyModules = ['pg', 'mysql2', 'better-sqlite3', '@libsql/client', 'bcryptjs', 'jose', '@aws-sdk/client-s3']

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
    // remaining entry chunk is this app's own code — mostly the Page Builder's
    // widget renderers, which every builder-designed page draws. The admin
    // screens, editors and plugin admin pages are lazy (src/App.tsx and each
    // plugin's index.tsx). The limit is raised so the warning again means "a
    // library chunk got unusually big"; `npm run check:bundle` is the real
    // budget for what a first visit downloads.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      // Server-only drivers are loaded lazily (src/lib/db/adapters, src/lib/auth, src/lib/storage)
      // and must never be bundled into the browser build. Mark them external so Rolldown leaves the
      // dynamic import() calls untouched; they only resolve at runtime on a Node/edge server.
      external: (id) => {
        return serverOnlyModules.some((module) => id === module || id.startsWith(`${module}/`));
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 20 },
            { name: 'tiptap', test: /node_modules[\\/](@tiptap|prosemirror-)/, priority: 20 },
            // @dnd-kit is class-based (sensors, `extends`/`new` chains) and, like the editor, breaks under the
            // deployment's obfuscation (`_0x… is not a function` on the first Theme Editor drag). Its own
            // `dnd-<hash>.js` chunk is what `EDITOR_CHUNK_NAME` in server/deploy/obfuscate.mjs leaves readable.
            { name: 'dnd', test: /node_modules[\\/]@dnd-kit[\\/]/, priority: 20 },
            // CodeMirror belongs to the two screens that embed a code field — the builder's inspector
            // (plugins/rwp-page-builder/editor/CodeField.tsx) and the Code Snippets editor
            // (plugins/rwp-code-snippets/SnippetCodeField.tsx) — and to nothing else; both are plugin
            // screens, which load lazily. Left in the catch-all below it would be *shared* with the entry
            // chunk, so index.html would preload the whole editor into every visitor's page — and a
            // CodeMirror upgrade would invalidate the vendor chunk they already have cached. Its own group
            // keeps it behind those two imports.
            { name: 'codemirror', test: /node_modules[\\/](@codemirror|@lezer|@uiw|crelt|style-mod|w3c-keyname)[\\/]/, priority: 20 },
            // The TypeScript compiler (about 9 MB) is used by exactly one thing: the Plugin Check screen
            // (plugins/rwp-developers/check/lib/syntax.ts), through a dynamic import that runs only when an
            // administrator checks a ZIP. In the catch-all below it would be shared with the entry chunk
            // and every visitor would download it. Its own group keeps it behind that import.
            { name: 'typescript', test: /node_modules[\\/]typescript[\\/]/, priority: 20 },
            // The same trap, smaller: libraries reached only through a dynamic import() must not fall into the
            // catch-all, or they ride along in `vendor`, which index.html preloads for every visitor.
            // lottie-web (about 165 kB) belongs to the builder's Lottie widget alone
            // (plugins/rwp-page-builder/render/widgets/pro-content.tsx); fflate to the ZIP backup, import and
            // Plugin Check screens. Both are behind lazy imports, and their own groups keep them there.
            { name: 'lottie', test: /node_modules[\\/]lottie-web[\\/]/, priority: 20 },
            { name: 'fflate', test: /node_modules[\\/]fflate[\\/]/, priority: 20 },
            // Catch-all for the rest of the third-party code, lowest priority so
            // the named groups above win. Keeps app code in the entry chunk.
            //
            // lucide-react is left out on purpose. It ships one module per icon, and without a group Rolldown
            // places each icon with the code that imports it: the ones the public widgets draw stay in the
            // entry, while the builder's wide icon catalogue (plugins/rwp-page-builder/lib/iconCatalog.tsx,
            // loaded lazily) takes its own icons into its own chunk. Inside `vendor` every one of them was
            // preloaded on every page.
            { name: 'vendor', test: /node_modules[\\/](?!lucide-react[\\/])/, priority: 1 },
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
  /**
   * `npm run dev` only: what Vite pre-bundles when the server starts.
   *
   * `exclude` is what makes the start-up scan work at all. The SQLite adapter imports `better-sqlite3`,
   * an optional dependency most installs do not have, and one unresolvable import made Vite print
   * "Failed to run dependency scan. Skipping dependency pre-bundling." From there every library was
   * discovered while pages loaded, and each discovery answered `504 Outdated Optimize Dep` and reloaded
   * the whole page mid-boot — on the first visit to the site, again to the admin, again to the builder.
   * Excluded modules are left external by the scan instead of failing it.
   *
   * `include` lists the libraries only the lazy screens use (the Page Builder, the Classic Editor, the
   * code fields), so they are bundled up front too rather than on their first visit. Only
   * `dependencies` belong there: an optional one missing from an install would stop the server.
   */
  optimizeDeps: {
    exclude: serverOnlyModules,
    include: [
      '@codemirror/autocomplete', '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/lang-javascript',
      '@codemirror/state', '@codemirror/view', '@uiw/react-codemirror',
      '@dnd-kit/core',
      '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-image', '@tiptap/extension-table',
      '@tiptap/extension-text-align', '@tiptap/extension-text-style',
      'fflate', 'lottie-web/build/player/lottie_light',
    ],
  },
  server: {
    /**
     * Transform the app's entry and everything it imports as soon as the dev server starts, instead
     * of one request at a time while the first page load waits on each.
     */
    warmup: {
      clientFiles: ['./src/main.jsx', './src/App.tsx'],
    },
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

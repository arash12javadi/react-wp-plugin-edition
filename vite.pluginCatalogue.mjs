/**
 * The plugin catalogue, inlined into the serverless bundle as `__RWP_PLUGIN_CATALOGUE__`.
 *
 * A Vercel function has no `plugins/` folder to read at request time, so every question the plugin
 * lifecycle asks about a plugin's code — what its manifest declares, the text of its `schema.sql` and
 * `uninstall.sql`, and which other plugins import it — is answered here, once, on the checkout the
 * deployment is built from. `src/server/routes/pluginSchema.ts` reads the define and passes it to
 * `server/pluginUninstall.mjs` as `catalogue`; on any host that does have the folder (`npm start`,
 * `npm run start:hono`) the define is absent, the catalogue is `null`, and the shared module asks the
 * disk exactly as it always did.
 *
 * The work is `pluginCatalogue()` in `server/pluginSchema.mjs` — the same readers, validators and
 * importer scan an install uses, run against real files — so the build cannot disagree with the
 * request about what a plugin declares. It returns `{ entries, problems }`: a folder that is not a
 * plugin gets no entry (it answers 404 at request time, which is the truth about it) and its problem is
 * printed here, where the fix is. Two files inlined by this module used to be two runtime reads; the
 * third, the importer list, is a decision only a build can make.
 *
 * Callers spread the return value into Vite's `define` (`vite.api.config.mjs`), which is why it is a
 * plain object of replacements rather than the catalogue itself.
 */
import { pluginCatalogue } from './server/pluginSchema.mjs'

/**
 * `{ __RWP_PLUGIN_CATALOGUE__: <the catalogue as JSON text> }`.
 *
 * JSON text, not an array literal, for the reason `supabase/schema.sql` travels as a string: a plugin
 * manifest is arbitrary UTF-8 written by a third party, and `JSON.stringify` of the string escapes
 * what a raw literal would not. Read back with `JSON.parse` at request time.
 *
 * Which is why it is stringified **twice**. A string passed to Vite's `define` is used verbatim as the
 * replacement source, so one `JSON.stringify(entries)` inlines the array itself — `[{ "plugin": … }]` —
 * and that is where this went wrong the first time: `JSON.parse` handed that array at the reading site
 * parses `"[object Object]"`, and, worse, Vite 8 (rolldown/oxc) substitutes a non-primitive `define`
 * only where the identifier is a plain expression. Inside `typeof` — the guard that keeps
 * `src/server/routes/pluginSchema.ts` from throwing `ReferenceError` on a builder that declares nothing
 * — the identifier was left alone, read as `"undefined"`, and the catalogue came back absent: every
 * plugin answered 404 in production while the build reported nothing wrong. Two stringify calls inline
 * a string literal, which is valid at either site, so the guard sees a string and the catalogue arrives.
 */
export default async function pluginCatalogueDefine() {
  const { entries, problems } = await pluginCatalogue()
  for (const problem of problems) {
    // `console.warn`, not a silent skip: this is the build's only chance to say a plugin is missing
    // from the deployment it is producing — an id that answers 404 in production and works on :3000.
    console.warn(`[plugin-catalogue] ${problem}`)
  }
  return { __RWP_PLUGIN_CATALOGUE__: JSON.stringify(JSON.stringify(entries)) }
}

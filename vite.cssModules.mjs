/**
 * Readable, stable, collision-free class names for CSS Modules.
 *
 * Vite leaves `generateScopedName` to postcss-modules, whose default is
 * `_<local>_<hash>_<line>` — the `_containerFull_1wxc3_13` the admin, the public components and the
 * theme editor rendered. That name says nothing about where it comes from, and it moves whenever the
 * stylesheet's bytes or its line numbers change, so it can neither be read in devtools nor handed to
 * a site owner. This replaces the hash with the module's own path:
 *
 *   src/components/PublicHome.module.css       .containerFull -> rwp-public-home-containerFull
 *   plugins/rwp-page-builder/admin/admin.module.css .panel   -> rwp-page-builder-admin-panel
 *
 * **Encapsulation is kept.** Many modules here declare the same local name — `.panel`, `.input`,
 * `.header` and `.status` are in dozens of files, and `admin.module.css` exists in both
 * `rwp-page-builder` and `rwp-shop` — so a bare `[local]` (or `[name]__[local]`) would make two
 * components one class and leak styles between them. The module path is what keeps them apart.
 *
 * **The local name is kept exactly as written** in the stylesheet (`.containerFull`, not
 * `container-full`), so `styles.containerFull` reads like the selector it renders.
 *
 * **No content hash, on purpose.** A class must survive a rebuild, a redeploy and an edit to the CSS
 * without being renamed: that is the whole point of the change. Cache busting already belongs to the
 * emitted file name (`index-BaiMv3H6.css`), which Vite hashes when the rules change.
 *
 * Used by `vite.config.js` (`css.modules.generateScopedName`); `scopedClassName` and `moduleSlug`
 * are exported so a plain node script can check the names without running a build.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** This checkout, from this file's own URL, so the names do not depend on the shell's cwd. */
const projectRoot = fileURLToPath(new URL('.', import.meta.url))

const posix = (value) => String(value).replace(/\\/g, '/')

/** `containerFull` -> `container-full`, `APIKey` -> `api-key`; anything else becomes `-`. */
const kebab = (value) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase()

/** The path that names a module: `.../src/components/PublicHome.module.css` -> `public-home`. */
function moduleSegments(filename) {
  const file = posix(filename).split('?')[0].split('#')[0]
  const relative = posix(path.posix.relative(posix(projectRoot), file))
  // A module from outside the checkout (or a virtual id) keeps its own path, rather than a `../..`
  // prefix that would turn into `-` in the middle of the class name.
  const source = relative.startsWith('..') || path.posix.isAbsolute(relative) ? file : relative
  const segments = source.split('/').filter(Boolean)
  const last = segments.length - 1
  if (last >= 0) segments[last] = segments[last].replace(/\.module\.[^.]*$/i, '')
  if (last >= 0 && !segments[last]) segments.length = last
  if (segments[0] === 'src') {
    segments.shift()
    // `src/components` names a container, not a feature; dropping it keeps 26 names readable.
    if (segments[0] === 'components') segments.shift()
  } else if (segments[0] === 'plugins') {
    segments.shift()
    // The plugin id already says `rwp-`, and so does the class prefix.
    if (segments[0]?.startsWith('rwp-')) segments[0] = segments[0].slice(4)
  }
  // An id that resolved to nothing but its own name still has to become a legal, non-empty class.
  return segments.length ? segments : ['app']
}

/**
 * The path half of a generated class name: `page-builder-admin` for that plugin's `admin.module.css`,
 * `dashboard-dashboard` for `src/components/dashboard/Dashboard.module.css` (which is *not* the same
 * module as `src/Dashboard.module.css` -> `dashboard`).
 */
export function moduleSlug(filename) {
  return moduleSegments(filename).map(kebab).filter(Boolean).join('-') || 'app'
}

/**
 * One CSS Module class, as Vite (postcss-modules) asks for it: `(localName, filename, css)`.
 *
 * `css` is unused deliberately — a name must not depend on the stylesheet's contents.
 */
export function scopedClassName(localName, filename) {
  return `rwp-${moduleSlug(filename)}-${localName}`
}

/** Vite's `css.modules.generateScopedName` (`vite.config.js`). */
export const generateScopedName = scopedClassName

/**
 * Which edition a plugin belongs to: the **public** template that ships to customers, or the
 * **development** edition this repository is - the central administration, where the vendor's own
 * tools live.
 *
 * Two plugins exist only here and must never travel: `rwp-ai-factory` (writes code and packaged plugin
 * ZIPs) and `rwp-saas-installer` (provisions new sites on a visitor's own Vercel and Supabase accounts,
 * and releases to sites that already exist). They are labeled "exclusive" in the product for the same
 * reason: they are the storefront, not a thing a customer runs on their own site.
 *
 * Isolation is enforced in three places, all reading this list:
 *
 *   - `server/plugins.mjs` does not register their server routes when `RWP_EDITION=public`, so a public
 *     deployment answers 404 for them even if one of the folders is present.
 *   - `src/lib/rwp.tsx` refuses to register them in a public build, so they cannot appear under
 *     Plugins, add an admin screen or claim a shortcode there.
 *   - `.gitattributes` marks both folders `export-ignore`, so `git archive` - GitHub's "Download ZIP",
 *     a template export, `npm pack` - never contains them, while `git clone` of this repository, which
 *     is the development edition, does.
 *
 * Plain JavaScript, like `src/lib/pluginLicense.js`, because the browser bundle, `server/plugins.mjs`
 * and the check script (`npm run check:plugins`) all import this file and each has a different build
 * step. Nothing here may touch `node:crypto`, and `process` is only read through `globalThis` in
 * `currentEdition`.
 */

/* global __RWP_EDITION__ -- inlined by Vite (vite.config.js) from RWP_EDITION at build time. */

/** This repository: the central administration, with every plugin. The default. */
export const DEV_EDITION = 'dev';

/** A build that ships to customers: public plugins only. Set `RWP_EDITION=public` to build one. */
export const PUBLIC_EDITION = 'public';

/**
 * The plugins that never leave the development edition.
 *
 * Adding an id here is a promise that the folder is also `export-ignore` in `.gitattributes` and that
 * its manifest says `"edition": "dev"`; `npm run check:plugins` fails if the three disagree.
 */
export const DEV_EDITION_PLUGINS = Object.freeze(['rwp-ai-factory', 'rwp-saas-installer']);

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** True for the two exclusive plugins above. Nothing else is edition-restricted. */
export const isDevEditionPlugin = (pluginId) => DEV_EDITION_PLUGINS.includes(str(pluginId));

/**
 * `RWP_EDITION` as one of the two names. Anything unrecognised - including unset - is the development
 * edition, so a checkout behaves like this repository until a build says otherwise.
 */
export const resolveEdition = (value) =>
  (str(value).toLowerCase() === PUBLIC_EDITION ? PUBLIC_EDITION : DEV_EDITION);

/**
 * The edition in force for the code that is running.
 *
 * `__RWP_EDITION__` is inlined by Vite (`vite.config.js`, `vite.api.config.mjs`) from `RWP_EDITION` at
 * build time, which is the only value a browser can be told; on Node the environment variable is read
 * directly, so `npm start` obeys an operator's choice without a rebuild. The `typeof` guard is what
 * lets both hosts import the same file.
 */
export const currentEdition = () => {
  const injected = typeof __RWP_EDITION__ !== 'undefined' ? __RWP_EDITION__ : '';
  // `globalThis.process`, not `process`: this file is also a browser module, where the identifier does
  // not exist, and the chain simply ends in `undefined` there.
  const fromEnv = globalThis.process?.env?.RWP_EDITION;
  return resolveEdition(str(injected) || str(fromEnv));
};

/** The edition one plugin belongs to, independent of where the code is running. */
export const pluginEdition = (pluginId) => (isDevEditionPlugin(pluginId) ? DEV_EDITION : PUBLIC_EDITION);

/** Whether `pluginId` may be registered and served in `edition` (default: the one in force). */
export const editionKeepsPlugin = (pluginId, edition = currentEdition()) =>
  pluginEdition(pluginId) === PUBLIC_EDITION || edition === DEV_EDITION;

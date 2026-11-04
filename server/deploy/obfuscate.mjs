/**
 * Auto-obfuscation for the react-wp core, run by the SaaS installer *before* the locked build is
 * packaged and deployed to a customer's Vercel account.
 *
 * The security model in one sentence: the customer's Vercel instance must never contain readable
 * JavaScript. Nothing here ships to the customer — this module lives in `rwp-saas-installer`, which is
 * development-edition-only and `export-ignore` in `.gitattributes`. The installer calls
 * `obfuscateSourceTree()` on the tree it is about to upload, and the same logic is a standalone CLI an
 * operator runs in CI to build + obfuscate the template and hand the locked output to the installer.
 *
 * Why obfuscate the *built* output rather than the Vite source: `javascript-obfuscator` renames
 * identifiers and flattens control flow. That is safe for the minified, self-contained chunks Vite
 * emits into `dist/assets/*.js`, but it would break `export const ...` / `import` edges in the source
 * tree (and `.tsx`/`.jsx` are not plain JavaScript anyway). The deployment path is therefore:
 *
 *   1. `obfuscateBuiltBundle()` — every build-output JavaScript file *in the payload the installer is
 *      about to upload* (`dist/`, `build/`, `out/`, `.vercel/output/static/`) is rewritten into its
 *      obfuscated form before the bytes leave this server. This is the pass that covers a release
 *      shipping prebuilt output, and it reports what it did instead of skipping silently.
 *   2. `bundle-lock.mjs` — a source release has no build output to obfuscate, because the tarball is a
 *      `git archive` of committed files and Vercel compiles it *after* the upload. The installer
 *      therefore writes `scripts/rwp-lock-bundle.mjs` into the payload and chains it into
 *      `npm run build`, so Vercel's own build ends by obfuscating the `dist/` it just emitted.
 *   3. Operators can do the same locally: `npm run build`, then
 *      `node plugins/rwp-saas-installer/obfuscate.mjs ./dist`.
 *
 * What is deliberately *not* obfuscated: the Vite/build config (it must stay importable), the
 * serverless API bundle (`src/server-dist/vercel.mjs`), whose literal `import('pg')`-style specifiers
 * `@vercel/nft` has to trace, and the rich-text editor's chunk (Tiptap/ProseMirror — see
 * `protectedChunkReason()`). The browser bundle is what a visitor can read, so that is the target;
 * the editor is the one exception, because it is the one chunk whose corruption a customer sees as a
 * blank editor rather than as a page that still works.
 *
 * What *is* still obfuscated, but with its class/function names kept (`reservedNamesFor`): chunks like
 * `@supabase/supabase-js`'s, whose named class expressions reference their own name. The renamer
 * resolves those references by name across scopes, so a chunk that imports `e` *and* declares
 * `class e { … e.nextInstanceID … }` ends up reading a property off the import — which is how locked
 * deployments threw `Cannot read properties of undefined (reading 'sb-<ref>-auth-token')` at
 * `createClient()` and could not reach Supabase at all.
 *
 * Usage:
 *
 *     node plugins/rwp-saas-installer/obfuscate.mjs ./template            # obfuscate ./template/dist in place
 *     node plugins/rwp-saas-installer/obfuscate.mjs ./dist --out ./locked # obfuscate one directory to another
 *     node plugins/rwp-saas-installer/obfuscate.mjs ./dist --all          # obfuscate every JS file, not only built assets
 *
 * `RWP_SAAS_OBFUSCATE=off` disables the installer-time transform entirely (development escape hatch).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Set `RWP_SAAS_OBFUSCATE=off` to skip the installer-time transform. */
const OBFUSCATE_ENV = 'RWP_SAAS_OBFUSCATE';

/** The file extensions that are plain, obfuscatable JavaScript. `.ts/.tsx/.jsx` are not. */
const JS_EXTENSIONS = /\.(?:mjs|cjs|js)$/i;

/**
 * Paths that must never be obfuscated (dependencies, repository metadata, coverage reports).
 *
 * `.vercel/` is not skipped wholesale: `.vercel/output/` is the Build Output API tree — the one
 * payload a deployment serves without building — so it is exactly where an obfuscated bundle can be.
 * Skipping the whole directory here silently disarmed obfuscation for every prebuilt release.
 */
const SKIP_ENTRY = /^(?:node_modules|\.git|coverage|\.next|\.vercel\/(?!output\/))\//;

/**
 * The build-output directories — the only things it is safe to obfuscate by default, and the only
 * JavaScript a visitor's browser can download. `public/build` is Laravel-style, `.vercel/output/static`
 * is the Build Output API's static tree.
 */
const BUILT_ENTRY = /^(?:dist|dist-ssr|build|out|public\/build|\.vercel\/output\/static)\//;

/**
 * Chunk names that belong to the rich-text editor: Vite's `tiptap` code-splitting group
 * (`vite.config.js`) and the ProseMirror packages under it, which a build without that group may name
 * after themselves. Matched against the file name only, so `dist/assets/tiptap-CRJxO9ru.js` and
 * `prosemirror-model-<hash>.js` are caught wherever they are emitted.
 */
const EDITOR_CHUNK_NAME = /(?:^|[^a-z0-9])(?:tiptap|prosemirror)(?:[^a-z0-9]|$)/i;

/**
 * Strings that survive minification *inside* a bundled editor chunk, so a build that put the editor in
 * a chunk nobody named can still be recognised. Property names and error messages are the reliable
 * ones — module paths and local identifiers are gone by then:
 *
 *   - `pmViewDesc`      — `prosemirror-view` stamps it on every DOM node it renders.
 *   - `data-pm-slice`   — the attribute it writes when copying a slice.
 *   - `ProseMirror`     — the class names on the editor DOM (`ProseMirror-focused`, …).
 *   - `NodeType.create can't construct` — a `prosemirror-model` error message.
 *
 * Two of them must be present. One is not proof: `ProseMirror` alone is a string this project's own
 * code may carry for styling, and protecting a whole app chunk by accident would leave the site's own
 * JavaScript readable. Measured on this repository's build, they match `tiptap-<hash>.js` and nothing
 * else.
 */
const EDITOR_CHUNK_MARKERS = Object.freeze([
  'pmViewDesc',
  'data-pm-slice',
  'ProseMirror',
  "NodeType.create can't construct",
  'prosemirror-',
]);

/** How many markers of `EDITOR_CHUNK_MARKERS` contents alone have to show before a chunk counts. */
const EDITOR_MARKER_THRESHOLD = 2;

/**
 * The rule above, in the form the injected build-time step needs it (`installBundleLockStep()` writes
 * that script into the payload, so a second copy of the rule would drift from this one).
 */
export const PROTECTED_CHUNK_RULE = Object.freeze({
  module: EDITOR_CHUNK_NAME.source,
  flags: 'i',
  markers: EDITOR_CHUNK_MARKERS,
  threshold: EDITOR_MARKER_THRESHOLD,
});

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Every `class <name>` / `function <name>` binding in a chunk, as the anchored regexes the obfuscator's
 * `reservedNames` option takes.
 *
 * This is the fix for the deployment that broke Supabase. `@supabase/supabase-js` keeps its auth client
 * in a *named class expression* — `wi = class e { constructor(){ … e.nextInstanceID[this.storageKey] … }
 * }` — and the same chunk starts with `import { n as e } from "./rolldown-runtime-….js"`. The renamer
 * maps by original name, not by scope: it left the class's inner name `e` alone, renamed the import to
 * `_0x57bda8`, and rewrote the reference inside the constructor to the *import's* name. The browser then
 * threw `TypeError: Cannot read properties of undefined (reading 'sb-gtpdhupngbjnhffroiov-auth-token')`
 * at `createClient()` — on every page, before any query ran, which is why fresh deployments "could not
 * connect to Supabase" while the untouched build worked.
 *
 * Reserving the name `e` fixes it for both bindings: nothing named `e` is renamed, so the reference
 * resolves to the class's inner name again. It costs nothing in readability — in build output these
 * names are already minified to one or two letters (`e`, `o`, `wi`), so the bytes an attacker reads are
 * the same bytes they could read before. The transforms that actually hide logic — string array,
 * control-flow flattening, self-defending — are untouched.
 *
 * Failure is silent by nature: the rename produces valid JavaScript, so only a *browser* running the
 * specific class expression notices. Checking the shape in the source is therefore the only reliable
 * guard, and it is cheap enough to do on every chunk.
 */
const NAMED_BINDING = /\b(?:class|function)\s*\*?\s*([A-Za-z_$][\w$]*)/g;

/**
 * The identifier half of the rule above, in the form the injected build-time step needs it — that script
 * runs on the customer's Vercel account, where this module does not exist (`installBundleLockStep()`
 * writes it into the payload), so the pattern travels with it rather than being written down twice.
 */
export const RESERVED_NAME_RULE = Object.freeze({ named: NAMED_BINDING.source, flags: 'g' });

/** `^name$`, with the one regex character an identifier can contain escaped. */
const anchoredName = (name) => `^${name.split('$').join('\\$')}$`;

/** The reserved names for one chunk's source. Empty for anything that names nothing. */
export function reservedNamesFor(source) {
  const text = typeof source === 'string' ? source : '';
  if (!text) return [];
  const names = new Set();
  NAMED_BINDING.lastIndex = 0;
  let match;
  while ((match = NAMED_BINDING.exec(text)) !== null) names.add(anchoredName(match[1]));
  return [...names];
}

/**
 * Supabase's storage/auth surface, kept out of the string array (`reservedStrings`).
 *
 * This is belt to the `reservedNamesFor()` braces. Those names fix the crash; these keep a key that a
 * support engineer has to read. A literal `'sb-<ref>-auth-token'`, `'access_token'`, `'refresh_token'`,
 * the persistence options — anything matching these entries stays a plain string in the bundle instead
 * of a base64 entry in the string array, which is the difference between "the visitor's token is
 * still there, under this key" and a wall of `_0x…` lookups when a sign-in goes wrong.
 *
 * Two limits, stated so nobody trusts it further than it goes. Entries are regexes, as the package
 * defines the option. And the option only rewrites *string literals*: `@supabase/supabase-js` builds
 * its own key from a template literal (`` `sb-${ref}-auth-token` ``), and the obfuscator still encodes
 * template quasis — the key is reconstructed at runtime exactly as before, it just is not greppable in
 * that chunk. Nothing here changes behaviour; the collision in `NAMED_BINDING` was the behaviour.
 */
export const SUPABASE_RESERVED_STRINGS = Object.freeze([
  'sb-[A-Za-z0-9_-]+-auth-token',
  '^-auth-token$',
  'access_token',
  'refresh_token',
  'provider_token',
  'provider_refresh_token',
  'expires_at',
  'expires_in',
  'token_type',
  'persistSession',
  'autoRefreshToken',
  'detectSessionInUrl',
  'storageKey',
]);

/** True while the installer should obfuscate what it deploys (everything except the explicit off). */
export const obfuscationEnabled = () => str(process.env?.[OBFUSCATE_ENV] || 'on').toLowerCase() !== 'off';

/**
 * The obfuscation profile. Deliberately strong but not the slowest knobs: `controlFlowFlattening` and
 * `stringArray` are on, `deadCodeInjection` is off by default because it is the slowest option and can
 * change a bundle's observable behaviour. Pass `--strong` (CLI) or `{ strong: true }` to add it.
 *
 * `reservedStrings` is part of the profile so both passes get it (the injected build-time step copies
 * this object verbatim); `reservedNames` cannot be — it depends on the chunk being transformed, so
 * `obfuscatorOptionsFor()` adds it per file.
 */
export function defaultObfuscatorOptions({ seed = 0, strong = false } = {}) {
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: strong ? 0.75 : 0.5,
    deadCodeInjection: Boolean(strong),
    deadCodeInjectionThreshold: 0.4,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    reservedStrings: [...SUPABASE_RESERVED_STRINGS],
    rotateStringArray: true,
    selfDefending: true,
    shuffleStringArray: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayIndexesType: ['hexadecimal-number'],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    target: 'browser',
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    seed,
  };
}

/**
 * The profile, plus the names this particular chunk cannot afford to have renamed
 * (`reservedNamesFor`), plus whatever the caller overrides in `options.obfuscatorOptions`.
 *
 * Every pass goes through here rather than calling `defaultObfuscatorOptions()` directly: the reserved
 * names are the difference between a locked bundle that connects to Supabase and one that throws at
 * `createClient()` (see `NAMED_BINDING`).
 */
export function obfuscatorOptionsFor(source, options = {}) {
  const { obfuscatorOptions, ...rest } = options || {};
  const reservedNames = reservedNamesFor(source);
  return {
    ...defaultObfuscatorOptions(rest),
    ...(reservedNames.length ? { reservedNames } : {}),
    ...(obfuscatorOptions || {}),
  };
}

/**
 * Loads `javascript-obfuscator` lazily so the installer's server bundle does not drag the library in
 * unless a deployment actually obfuscates, and so the two public API shapes the package has shipped
 * (default export in v2/v3, named `obfuscate` in v4) both work.
 */
async function loadObfuscator() {
  const mod = await import(/* @vite-ignore */ 'javascript-obfuscator');
  const obfuscate = mod.obfuscate || mod.default?.obfuscate || mod.default;
  if (typeof obfuscate !== 'function') {
    throw new Error('javascript-obfuscator did not expose an obfuscate() function. Install it (npm i javascript-obfuscator) and retry.');
  }
  return obfuscate;
}
/**
 * Obfuscates one JavaScript source string and returns the replacement source.
 *
 * Contents alone decide whether it is touched (`protectedChunkReason`), since a caller handing over a
 * whole chunk has no file name to offer: a string that is the rich-text editor comes back unchanged.
 */
export async function obfuscateJavaScript(source, options = {}) {
  const text = String(source);
  if (protectedChunkReason('', text)) return text;
  const obfuscate = await loadObfuscator();
  return obfuscate(text, obfuscatorOptionsFor(text, options)).getObfuscatedCode();
}

/**
 * Whether `name` (a repository-relative path) should be obfuscated.
 *
 * By default only the built bundle — `dist/` or `build/` JavaScript, plus anything under an `assets/`
 * directory or already minified. `{ all: true }` widens that to every plain `.js/.mjs/.cjs` file,
 * which is correct for a codebase that ships plain scripts rather than a Vite build.
 */
export function shouldObfuscate(name, { all = false } = {}) {
  if (!name || SKIP_ENTRY.test(name)) return false;
  if (!JS_EXTENSIONS.test(name)) return false;
  if (/\.map$/i.test(name)) return false;
  if (all) return true;
  return BUILT_ENTRY.test(name) || /\/assets\//.test(name) || /\.min\.js$/i.test(name);
}

/**
 * True when `name` is build output: the minified, self-contained JavaScript Vite/Rollup emitted, which
 * is the only JavaScript a visitor's browser can download and therefore the only code worth locking.
 *
 * Separate from `shouldObfuscate()` because this one has no `all` escape hatch and no `/assets/`
 * heuristic: it is the exact predicate the deployment pipeline reports on.
 */
export function isBuiltBundleEntry(name) {
  if (!name || SKIP_ENTRY.test(name)) return false;
  if (!BUILT_ENTRY.test(name)) return false;
  if (!JS_EXTENSIONS.test(name)) return false;
  return !/\.map$/i.test(name);
}

/** The build-output JavaScript entries of a `Map<path, Buffer>`, sorted so a report is stable. */
export function builtBundleEntries(files) {
  if (!(files instanceof Map)) return [];
  return [...files.keys()].filter(isBuiltBundleEntry).sort();
}

/**
 * Why `name` (and its contents) must be left alone, or `''` when it may be locked: the rich-text
 * editor's chunk.
 *
 * The failure this exists for: after a deployment the browser threw
 * `TypeError: _0x5e0cec is not a constructor at e.create` from `tiptap-<hash>.js` and the admin editor
 * never rendered. `create` there is the editor's static factory — `ViewDesc.create()` builds its node
 * views with `new MarkViewDesc(...)`, `NodeType.create()` with `new Node(...)` — so the locked bundle
 * had renamed a class that is then constructed by name, and the renamed binding no longer resolved to
 * it. Those classes are `extends`/`super()` chains reached only from static factories and they run only
 * in a browser, which is why no Node-side check in this repository can catch the damage: the build
 * succeeds, the chunk downloads, and the editor throws on its first render.
 *
 * Skipping beats a gentler profile here. No knob makes `new SomeClass(...)` safe: `identifierNamesGenerator`,
 * `controlFlowFlattening`, `simplify` and `selfDefending` are precisely the transforms involved in class
 * construction, so a "conservative" pass would still rename the constructor and still fail. Nothing is
 * lost by leaving it readable: this is third-party editor code, while the code worth hiding — routes,
 * licensing, admin screens — lives in the entry and plugin chunks, which stay locked.
 *
 * Detection is by name first (the `tiptap` group in `vite.config.js` emits `tiptap-<hash>.js`), then by
 * contents, so a release whose Vite config has no such group is protected too. Returns the reason for
 * the report, or `''`.
 */
export function protectedChunkReason(name, source = '') {
  const base = str(typeof name === 'string' ? name.split('/').pop() : '');
  if (base && EDITOR_CHUNK_NAME.test(base)) return 'the rich-text editor chunk';
  if (!source) return '';
  let seen = 0;
  for (const marker of EDITOR_CHUNK_MARKERS) {
    if (source.includes(marker)) seen += 1;
    if (seen >= EDITOR_MARKER_THRESHOLD) return 'the rich-text editor code it contains';
  }
  return '';
}

/**
 * True for JavaScript that is *already* the locked form.
 *
 * Two signals, because either alone can lie: the obfuscator always emits at least one
 * `function _0x<hex>(…)` string-array reader, and every identifier it generates is `_0x<hex>`.
 *
 * Why it matters: this profile sets `selfDefending: true`, which the obfuscator documents as breaking
 * when its own output is transformed again. Re-locking a release that already ships a locked `dist/`
 * — a redeploy, or a maintainer who ran the CLI before tagging — would turn a working site into a
 * blank page. The deploy report counts these files instead of silently transforming them.
 */
export function looksLocked(source) {
  if (!source || source.length < 64) return false;
  if (!/function\s+_0x[0-9a-f]{2,}\s*\(/.test(source)) return false;
  return (source.match(/_0x[0-9a-f]{2,}/g) || []).length >= 10;
}

/**
 * Obfuscates the named entries of `files`, in place, and reports what changed.
 *
 * The one loop both passes share. `seed` is offset per file so two files never receive the same string
 * array, an entry that is empty (a stub chunk) is left alone rather than fed to the parser, an entry
 * that already reads `_0x…` is skipped rather than transformed twice (see `looksLocked`), and an entry
 * that is the rich-text editor is skipped outright (see `protectedChunkReason`) — that last one is the
 * difference between a deployment whose editor works and one whose editor throws on first render.
 * The obfuscator itself is loaded on first use, so a payload made only of editor and locked chunks
 * never pulls the library in.
 */
async function obfuscateEntries(files, targets, options = {}) {
  const seedBase = Number(options.seed) || 0;
  let obfuscate = null;
  let obfuscated = 0;
  let bytes = 0;
  const skipped = [];
  const protectedChunks = [];
  for (const name of targets) {
    const source = files.get(name).toString('utf8');
    if (!source.trim()) continue;
    if (looksLocked(source)) {
      skipped.push(name);
      continue;
    }
    const reason = protectedChunkReason(name, source);
    if (reason) {
      protectedChunks.push({ name, reason });
      continue;
    }
    obfuscate = obfuscate || (await loadObfuscator());
    const result = obfuscate(source, obfuscatorOptionsFor(source, { ...options, seed: seedBase + obfuscated }));
    const locked = Buffer.from(result.getObfuscatedCode(), 'utf8');
    files.set(name, locked);
    obfuscated += 1;
    bytes += locked.length;
  }
  return { obfuscated, bytes, skipped, protectedChunks };
}

/**
 * The payload pass: obfuscates every build-output JavaScript file in a tree that is about to be
 * uploaded, and returns a report instead of a bare map.
 *
 * The report is the point. `obfuscateSourceTree()` below answers with `if (!targets.length) return
 * files`, which is indistinguishable from success — and that is exactly how every deployment shipped
 * readable JavaScript: the tarball is a `git archive` of committed files, `dist/` is git-ignored, so
 * the default target set was empty on every release and the transform was a silent no-op. A caller
 * that must not ship clean code reads `obfuscated` — and `alreadyLocked`, which counts build output
 * that arrived locked and was therefore left alone — and refuses when both are zero.
 *
 * `protectedChunks` is the third answer, and it is not a failure: those files are the rich-text
 * editor's, left readable on purpose (`protectedChunkReason()`), and a caller's "is anything locked?"
 * check has to count them rather than reject a payload whose only JavaScript is the editor.
 */
export async function obfuscateBuiltBundle(files, options = {}) {
  const enabled = obfuscationEnabled();
  const report = { enabled, targets: 0, obfuscated: 0, alreadyLocked: 0, protectedChunks: [], bytes: 0, files };
  if (!enabled || !(files instanceof Map)) return report;
  const targets = builtBundleEntries(files);
  report.targets = targets.length;
  if (!targets.length) return report;
  const { obfuscated, bytes, skipped, protectedChunks } = await obfuscateEntries(files, targets, options);
  return { ...report, obfuscated, alreadyLocked: skipped.length, protectedChunks, bytes };
}

/**
 * Obfuscates, in place, the JavaScript files in a `Map<path, Buffer>` — the exact shape the installer's
 * tarball reader produces. Returns the same map so it composes with the rest of the pipeline.
 *
 * Kept for the CLI and for callers that only need the map; the deployment pipeline uses
 * `obfuscateBuiltBundle()` because it needs the count.
 */
export async function obfuscateSourceTree(files, options = {}) {
  if (!obfuscationEnabled()) return files;
  if (!(files instanceof Map)) return files;
  const targets = [...files.keys()].filter((name) => shouldObfuscate(name, options));
  if (!targets.length) return files;
  await obfuscateEntries(files, targets, options);
  return files;
}

/** SRI hash for an obfuscated bundle, as `sha384-<base64>` — the value `rwp_remote_plugins.integrity` stores. */
export const computeIntegrity = (bytes) => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^(?:node_modules|\.git|\.vercel|coverage|\.next)$/.test(entry.name)) continue;
      files.push(...await walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Obfuscates every eligible file under `dir`, writing to `outDir` (default: in place).
 *
 * The rich-text editor's chunk is written through unchanged (`protectedChunkReason`), and it is
 * written even in `--out` mode: skipping it there would leave a locked tree whose `index.html` points
 * at a `tiptap-<hash>.js` that was never produced.
 */
export async function obfuscateDirectory(dir, { outDir, all = false, strong = false, seed = 0 } = {}) {
  const root = path.resolve(dir);
  const targetRoot = path.resolve(outDir || root);
  const obfuscate = await loadObfuscator();
  const files = await walk(root);
  let changed = 0;
  let kept = 0;
  let integrity = '';
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    // Matched with the root's own name in front: `shouldObfuscate()` looks for build output, and the
    // documented `obfuscate.mjs ./dist` hands it `assets/x.js` — no `dist/`, no `/assets/` at the start
    // of the path, no match, and the command quietly locked nothing. Any other root still matches
    // through its own `/assets/` segment, so nothing that used to be obfuscated stops being obfuscated.
    if (!shouldObfuscate(`${path.basename(root)}/${relative}`, { all })) continue;
    const source = await readFile(file, 'utf8');
    if (!source.trim()) continue;
    const out = path.join(targetRoot, relative);
    const reason = protectedChunkReason(relative, source);
    if (reason) {
      kept += 1;
      if (out !== file) {
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, source, 'utf8');
      }
      continue;
    }
    const result = obfuscate(source, obfuscatorOptionsFor(source, { seed, strong }));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, result.getObfuscatedCode(), 'utf8');
    integrity = computeIntegrity(Buffer.from(result.getObfuscatedCode(), 'utf8'));
    changed += 1;
  }
  return { root: targetRoot, changed, kept, integrity };
}

// Run as a CLI, never when imported by the installer's server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  // `--out <dir>` and `--out=<dir>` both work: the usage above spells it with a space, and a
  // value-taking flag that quietly ignored its value would rewrite the source directory in place.
  const valueFlags = new Set(['--out', '--seed']);
  const flag = (name) => {
    const inline = args.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      if (valueFlags.has(args[index])) index += 1;
      continue;
    }
    positional.push(args[index]);
  }
  const dir = positional[0] || 'dist';
  const outDir = flag('out');
  const all = args.includes('--all');
  const strong = args.includes('--strong');
  const seed = Number(flag('seed') || 0);
  try {
    const report = await obfuscateDirectory(dir, { outDir, all, strong, seed });
    console.log(`Obfuscated ${report.changed} file(s) into ${report.root}`);
    if (!report.changed && !report.kept) {
      console.log(`Nothing matched in ${dir}: no build output found. Pass the project root, or --all to lock plain scripts.`);
    }
    if (report.kept) console.log(`Left ${report.kept} rich-text editor chunk(s) readable on purpose: obfuscating them breaks the editor's class construction.`);
    if (report.integrity) console.log(`Last bundle SRI: ${report.integrity}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

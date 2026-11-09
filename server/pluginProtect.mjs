/**
 * Turns a plugin ZIP into the copy a buyer receives: compiled, obfuscated and watermarked.
 *
 * A plugin is stored as readable source (`index.tsx`, `admin/*.tsx`, `server.mjs`). That master never
 * leaves the marketplace. What a buyer downloads — and what the install flow commits to their GitHub
 * repository — is produced here, per licence, at download time. Doing it at download time (not at
 * publish time) is what makes every previous purchase protected too: nothing has to be re-published.
 *
 * The result must still install without a single complaint, so the *shape* of the package is untouched:
 *
 *   - every file keeps its name and extension. `index.tsx` stays `index.tsx` (the build loads plugins
 *     from `plugins/<id>/index.tsx`, and both installers refuse a ZIP without it), `server.mjs` stays
 *     `server.mjs`. A `.tsx` file whose body is now plain JavaScript is valid input for Vite.
 *   - `manifest.json`, `schema.sql`, `uninstall.sql`, CSS, images and every other non-code file are
 *     copied byte for byte. The SQL has to stay readable: the admin approves it before it runs.
 *   - `import` specifiers and relative `import('./x')` paths are never rewritten. Vite resolves them at
 *     build time, so a string moved into an obfuscator string table would turn a lazy chunk into a
 *     runtime failure. Each protected file is checked against that rule and falls back to the compiled,
 *     un-obfuscated code if the obfuscator would have disturbed it — a buyer never gets a broken file.
 *
 * Two options are deliberately off: `selfDefending` and `debugProtection`. The site's own Vite build
 * minifies the plugin after the install commit, and self-defending code aborts on reformatted source.
 *
 * Honest limit: obfuscation raises the price of copying, it does not make copying impossible. The real
 * controls are the licence key (checked by the plugin's own gate and by the marketplace) and the
 * watermark added here, which names the licence a leaked copy came from.
 */
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { isCommercialPlugin, pluginIdForSlug } from '../src/lib/pluginLicense.js';

/**
 * Marks a file this module has already protected, so a second pass (a retried download, a package that went
 * through the marketplace twice) leaves it as it is: obfuscating obfuscated code only makes it slower and larger.
 */
export const PROTECTED_MARK = '/*rwp:protected*/';

/**
 * Whether a listing is a paid plugin and therefore protected at delivery. The answer is `COMMERCIAL_PLUGIN_ADDONS`
 * (via the marketplace slug alias) and nothing a package says about itself: core and every free plugin are
 * shipped as readable source, by design.
 */
export const shouldProtectPlugin = (idOrSlug) => isCommercialPlugin(pluginIdForSlug(idOrSlug) || idOrSlug);

/**
 * Obfuscated TypeScript-family files carry compiled JavaScript under a `.tsx` name, which a type checker reads as
 * TypeScript and answers with thousands of errors about names like `_0x5720`. This directive tells it to skip the
 * file; the build (Vite) does not type-check, so nothing else changes.
 */
export const TS_NOCHECK = '// @ts-nocheck';

const CODE_TS = /\.(?:tsx|ts|jsx)$/i;
const CODE_JS = /\.(?:mjs|cjs|js)$/i;
const TYPES_ONLY = /\.d\.(?:ts|mts|cts)$/i;
const SKIP_DIR = /(?:^|\/)(?:node_modules|\.git|__MACOSX)\//;

/** Files the obfuscator is given: plugin code only, never a bundled dependency. */
const isCode = (name) => (CODE_TS.test(name) || CODE_JS.test(name)) && !TYPES_ONLY.test(name);

/** Strings that must stay literal: relative imports, and the `plugin-api` path every plugin imports. */
const RESERVED_STRINGS = ['^\\.{1,2}/', '^\\.\\./\\.\\./src/', '^react(?:/.*)?$', '^react-dom(?:/.*)?$'];

/** Escapes one literal string for use inside a RegExp pattern built from a template literal. */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const obfuscatorOptions = (seed, target, literals = []) => ({
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  reservedStrings: [...RESERVED_STRINGS, ...literals.map((value) => `^${escapeRe(value)}$`)],
  rotateStringArray: true,
  selfDefending: false,
  debugProtection: false,
  shuffleStringArray: true,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  target,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  sourceType: 'module',
  seed,
});

const seedFor = (text) => parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);

async function loadTypeScript() {
  try {
    const mod = await import('typescript');
    return mod.default || mod;
  } catch {
    throw new Error('The TypeScript compiler is not available on this server, so the plugin could not be prepared for download. Keep "typescript" installed where the marketplace runs.');
  }
}

async function loadObfuscator() {
  const mod = await import('javascript-obfuscator');
  const obfuscate = mod.obfuscate || mod.default?.obfuscate || mod.default;
  if (typeof obfuscate !== 'function') throw new Error('javascript-obfuscator did not expose obfuscate().');
  return obfuscate;
}

/** `.ts/.tsx/.jsx` → plain ES module JavaScript. Imports are kept exactly as written. */
function compile(ts, name, source) {
  const out = ts.transpileModule(source, {
    fileName: name,
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      importsNotUsedAsValues: undefined,
      verbatimModuleSyntax: false,
      isolatedModules: true,
      removeComments: true,
      sourceMap: false,
    },
  });
  return out.outputText;
}

/** Every import specifier (static and dynamic) in a source text, sorted, for before/after comparison. */
const specifiers = (text) => {
  const found = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;
  for (const match of text.matchAll(pattern)) found.push(match[2]);
  return found.sort();
};

/** True when `text` parses as a module. */
const parses = (ts, name, text) => {
  const file = ts.createSourceFile(name.replace(/\.[^.]+$/, '.mjs'), text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  return !file.parseDiagnostics?.length;
};

/**
 * @param {Uint8Array|Buffer} zipBytes  the master package
 * @param {{ watermark?: string, label?: string, pluginId?: string }} [options]
 *   `pluginId`, when given, must be a paid plugin (`shouldProtectPlugin`); any other id is returned unchanged.
 *   `watermark` is any string naming the licence (an id, never the key itself); it is embedded in the entry
 *   file and in a small manifest field so a leaked copy can be traced.
 * @returns {Promise<{ zip: Uint8Array, report: { protected: string[], compiledOnly: string[], copied: number } }>}
 */
export async function protectPluginZip(zipBytes, options = {}) {
  const watermark = String(options.watermark || '').slice(0, 64);
  if (options.pluginId && !shouldProtectPlugin(options.pluginId)) {
    return { zip: new Uint8Array(zipBytes), report: { protected: [], compiledOnly: [], copied: 0, skipped: 'free plugin: shipped as readable source' } };
  }
  const ts = await loadTypeScript();
  const obfuscate = await loadObfuscator();

  const archive = unzipSync(new Uint8Array(zipBytes));
  const names = Object.keys(archive).filter((name) => !name.endsWith('/') && !SKIP_DIR.test(name));

  // Plugins are zipped with or without a wrapping folder; protect whichever it is, in place.
  const out = {};
  const report = { protected: [], compiledOnly: [], copied: 0 };

  for (const name of names) {
    const bytes = archive[name];
    if (TYPES_ONLY.test(name)) continue; // type declarations expose the source's shape and are not needed to run.
    if (!isCode(name)) {
      out[name] = bytes;
      report.copied += 1;
      continue;
    }

    const source = strFromU8(bytes);
    if (source.includes(PROTECTED_MARK)) {
      // Already protected once: copied as it is.
      out[name] = bytes;
      report.copied += 1;
      continue;
    }
    const isServer = CODE_JS.test(name);
    let compiled = isServer ? source : compile(ts, name, source);

    let result = compiled;
    let obfuscated = false;
    try {
      const candidate = obfuscate(compiled, obfuscatorOptions(seedFor(`${watermark}:${name}`), isServer ? 'node' : 'browser', specifiers(compiled))).getObfuscatedCode();
      const same = JSON.stringify(specifiers(compiled)) === JSON.stringify(specifiers(candidate));
      if (same && parses(ts, name, candidate)) {
        result = candidate;
        obfuscated = true;
      }
    } catch {
      // Fall through to the compiled text.
    }
    (obfuscated ? report.protected : report.compiledOnly).push(name);
    out[name] = strToU8(`${CODE_TS.test(name) ? `${TS_NOCHECK}\n` : ''}${PROTECTED_MARK}\n${result}`);
  }

  if (watermark) {
    const entry = Object.keys(out).find((name) => /(?:^|\/)index\.tsx$/.test(name));
    if (entry && !strFromU8(out[entry]).includes('__rwpLicensedTo')) {
      out[entry] = strToU8(`${strFromU8(out[entry])}\n;export const __rwpLicensedTo=${JSON.stringify(watermark)};\n`);
    }
  }

  return { zip: zipSync(out, { level: 6 }), report };
}

/**
 * prebuilt.mjs — turns a template *source* tarball into the *only* payload a deployment may carry:
 * compiled function entries and an obfuscated `dist/`, and nothing else.
 *
 * The problem this exists for is a leak, not a build preference. Vercel shows a deployment's uploaded
 * files under "Source", so a deployment made from `git archive` handed the customer a browsable copy of
 * `src/`, `plugins/` and every config file — the product's whole source, readable and copyable from
 * their own dashboard. Obfuscating `dist/` could never fix that on its own: on a source release there
 * is no `dist/` to obfuscate, and the archive Vercel receives is the source tree itself.
 *
 * So the order is inverted here. The installer builds the template *on this server*, obfuscates the
 * bundle it produced, and uploads only:
 *
 *     dist/**                     the compiled SPA (obfuscated by `obfuscate.mjs` afterwards)
 *     api/<name>.mjs              each Vercel function, bundled into one self-contained module
 *     package.json                the release's own manifest — dependencies as released, `version` as the
 *                                 tag being deployed, so the site reports the release it was built from
 *     package-lock.json           the same lockfile the local build used, so the install is identical
 *     vercel.json                 the release's rewrites + the overrides below
 *
 * `assertDeployPayload()` then refuses anything outside that list, which is the part that makes the
 * guarantee hold: a future template file cannot quietly travel to a customer's dashboard because the
 * allowlist is the default and the error names the offender.
 *
 * Why the functions are bundled rather than uploaded as `.ts`: `api/index.ts` imports the pre-built
 * Hono bundle and the other three import `server/*.mjs` helpers, so uploading them as written means
 * uploading `src/` and `server/` beside them. The release's own Vite resolves the whole graph into one
 * module per entry, exactly like `npm run build:api` does for the Hono app, and leaves *packages*
 * external — which is what Vercel's own `@vercel/nft` step traces from the installed `node_modules`.
 * Whatever the graph names but the release does not carry is dropped before it is bundled, because the
 * alternative to dropping a plugin folder with no code behind it is a deployment that never starts:
 * see `pruneMissingPluginImports`.
 *
 * Deliberately not obfuscated: the function bundles. Their `import('pg')` / `import('mysql2/promise')`
 * specifiers are how `@vercel/nft` finds those drivers, and the string-array transform would move them
 * out of the `import()` call and into an array lookup — a deployment that then answers 500 on the first
 * database query. They are minified and self-contained instead (no comments, no module boundaries, no
 * source paths), which is what the browser bundle's obfuscation buys for the public half.
 *
 * `RWP_SAAS_LOCAL_BUILD=off` restores the old behaviour — upload the source tree and let Vercel build
 * it — for an operator who builds elsewhere or needs to debug a release. It is an escape hatch and the
 * report says plainly what it costs: the customer can read the source.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Set `RWP_SAAS_LOCAL_BUILD=off` to upload the source tree instead (exposes the source). */
const LOCAL_BUILD_ENV = 'RWP_SAAS_LOCAL_BUILD';

/** Set `RWP_SAAS_NPM_CACHE` to choose the directory builds use as npm's cache. */
const NPM_CACHE_ENV = 'RWP_SAAS_NPM_CACHE';

/** The directory name this module adds under the temp directory, and under a build tree as a fallback. */
const NPM_CACHE_DIR = 'rwp-npm-cache';

/**
 * The edition a customer's site is built for.
 *
 * `public`, not the repository default: the default edition registers this plugin, the AI factory and
 * the marketplace — internal tools whose code would otherwise be compiled into every provisioned site
 * and readable in its bundle. `RWP_SAAS_BUILD_EDITION` (or a `RWP_EDITION` among the deployment's own
 * variables) overrides it.
 */
const DEFAULT_EDITION = 'public';

/** How long the whole build may take: `npm ci` plus Vite on a cold cache is minutes, not seconds. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** How many built payloads are kept for a repeat deploy, and for how long. */
const CACHE_ENTRIES = 3;
const CACHE_MS = 15 * 60 * 1000;

/**
 * The deployment's own variables, never this server's.
 *
 * A build inlines whatever it can see: `vite.config.js` bakes `window.__REACT_WP_CONFIG__` from the
 * environment and Vite inlines `import.meta.env.VITE_*`. Inheriting this process's environment would
 * therefore stamp *this* site's Supabase project, `RWP_EDITION` and any secret the operator exported
 * into a customer's bundle. Every key that could do that is dropped, the OS essentials are kept so npm
 * and Vite can run, and only the deployment's own variables are added back.
 */
const INHERITED_SECRET = /^(?:vite_|supabase_|rwp_|github_|database_url$|db_|jwt_|stripe_|resend_|smtp_|openai_|anthropic_|google_|cloudinary_|imagekit_|node_env$|node_options$)/i;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** True while this server builds the template itself (everything except the explicit off). */
export const localBuildEnabled = () => str(process.env?.[LOCAL_BUILD_ENV] || 'on').toLowerCase() !== 'off';

/** The edition the prebuilt bundle is compiled for. */
export const buildEdition = (env = {}) =>
  str(env?.RWP_EDITION) || str(process.env?.RWP_SAAS_BUILD_EDITION) || DEFAULT_EDITION;


/**
 * Whether one payload path is allowed to reach a customer's project.
 *
 * An allowlist, not a denylist. A denylist of `src/`, `plugins/` and "source configs" is one template
 * file away from leaking the next directory somebody adds; this list can only grow by editing the
 * deployment path itself, deliberately.
 */
const ALLOWED_PAYLOAD_ENTRY = /^(?:dist\/|api\/[A-Za-z0-9._-]+\.mjs$|package\.json$|package-lock\.json$|vercel\.json$)/;

/** What a failure here means for the caller: Vercel was never called, and the release is not to blame. */
const buildFailure = (message) => Object.assign(new Error(message), { status: 502 });

/** The last few lines of a build log, so a failure is a sentence with its cause instead of a shrug. */
const tail = (lines, count = 10) => lines.slice(-count).join(' | ');

/**
 * Appends the one sentence an npm cache failure needs to the tail it already reports.
 *
 * An install that dies because npm could not write somewhere gives the operator
 * `npm error code ENOENT | npm error path /home/sbx_user1051` and nothing else; the cause (a home
 * directory that does not exist) and the fix (point the cache elsewhere) are both absent from it. Only a
 * failure that names a filesystem problem is annotated — an install that failed on a missing package
 * keeps its own message, because that message is the useful one.
 */
function npmCacheHint(error, env) {
  const message = error instanceof Error ? error.message : '';
  if (!/npm error (?:code )?(?:ENOENT|EACCES|EPERM)|npm error path \S/i.test(message)) return error;
  const cache = env?.npm_config_cache || 'its cache';
  return buildFailure(`${message} npm could not write to ${cache}; set ${NPM_CACHE_ENV} to a directory this server can write in.`);
}

/** True for a repository-relative path that stays inside the tree it was read from. */
function isSafeRelative(name) {
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

/** True when a path exists and is a directory, not a file that merely shares the name. */
async function isDirectory(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates `dir` if it is missing, then reports whether this process can write in it.
 *
 * `mkdir` rather than a bare check, because the interesting case is a directory that does not exist yet.
 * npm would create it too — except when it cannot, and then the only thing the operator receives is a
 * path in an `ENOENT` nobody can act on.
 */
async function isWritableDirectory(dir) {
  if (!dir) return false;
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The home directory this process was given, before anything in here reinterprets it.
 *
 * Windows answers this question with `USERPROFILE` — or a `HOMEDRIVE`+`HOMEPATH` pair — and everything
 * else with `HOME`. Nothing is created or repaired here; that is `usableHome()`'s job.
 */
function inheritedHome(env) {
  if (process.platform === 'win32') {
    return str(env?.USERPROFILE) || str(env?.HOME) || `${str(env?.HOMEDRIVE)}${str(env?.HOMEPATH)}`;
  }
  return str(env?.HOME);
}

/**
 * The directory a template build keeps npm's cache in.
 *
 * npm derives its cache from `$HOME/.npm`, and a sandbox is free to hand this server a home directory that
 * does not exist. `npm ci` then dies *before* it installs anything —
 * `npm error code ENOENT | npm error syscall mkdir | npm error path /home/sbx_user1051`, exit code 254 —
 * which reads like a broken release and is entirely a broken machine layout. So the cache is passed
 * explicitly, to a directory this process has proven writable, in this order:
 *
 *   1. `RWP_SAAS_NPM_CACHE` — an operator who wants the cache on a named volume;
 *   2. an `npm_config_cache` inherited from this process, if that directory is usable: whatever started
 *      this server knows more about the machine than this module does;
 *   3. `<home>/.npm`, but only when that cache already exists. On the usual Linux host it is npm's own
 *      default and warm from the `npm install` that set the project up, and a build has no business
 *      scattering a directory of its own through a home it did not create;
 *   4. `<tmp>/rwp-npm-cache` — created if needed and shared between builds, so a second deployment installs
 *      from a warm cache instead of the network (npm's cache is content-addressed and safe for two builds
 *      at once);
 *   5. `<work>/.npm-cache` — a build directory is writable by definition, which covers the sandbox whose
 *      `/tmp` is read-only. It dies with the build, which is the price of being the last resort.
 */
async function buildCacheDirectory(work, home) {
  const candidates = [
    { dir: str(process.env?.[NPM_CACHE_ENV]) },
    { dir: str(process.env?.npm_config_cache) },
    { dir: home ? path.join(home, '.npm') : '', existing: true },
    { dir: path.join(tmpdir(), NPM_CACHE_DIR) },
    { dir: work ? path.join(work, '.npm-cache') : '' },
  ];
  for (const { dir, existing } of candidates) {
    if (!dir) continue;
    const target = path.resolve(dir);
    // `existing` asks for a cache that is already there: `isWritableDirectory()` would happily create the
    // one thing this candidate is not allowed to create.
    if (existing && !await isDirectory(target)) continue;
    if (await isWritableDirectory(target)) return target;
  }
  // Nothing was writable. npm fails on its own cache again and `npmCacheHint()` turns that log into the
  // instruction this branch could not give.
  return path.join(tmpdir(), NPM_CACHE_DIR);
}

/**
 * A home directory the build can use, or `''` when the inherited one is fine.
 *
 * npm is not the only writer in a build: any install script that calls `os.homedir()` — esbuild's
 * postinstall, a package's opt-in telemetry — inherits `HOME` from this env, and a home that does not
 * exist makes it fail *after* npm has already succeeded, which is a far harder failure to read than npm's
 * own. The substitution happens only when the inherited path is missing, is not a directory, or cannot be
 * written in, so a real home — with its `~/.npmrc` and credentials — is left exactly as it was.
 */
async function usableHome(home) {
  if (home && await isDirectory(home) && await isWritableDirectory(home)) return '';
  const fallback = path.join(tmpdir(), 'rwp-npm-home');
  await mkdir(fallback, { recursive: true }).catch(() => {});
  return fallback;
}

/**
 * The environment a template build runs in: this machine's PATH and temp directory, the deployment's
 * own variables, and nothing this server was configured with. See `INHERITED_SECRET`.
 *
 * `npm_config_cache` and the home directory are the two exceptions, and both are there so a restricted
 * sandbox cannot stop a deployment: see `buildCacheDirectory()` and `usableHome()`.
 */
async function buildEnvironment(env, edition, { work } = {}) {
  const child = {};
  for (const [key, value] of Object.entries(process.env || {})) {
    if (typeof value !== 'string') continue;
    if (INHERITED_SECRET.test(key)) continue;
    child[key] = value;
  }
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === 'string' && value) child[key] = value;
  }
  const inherited = inheritedHome(child);
  // Resolved against the home this process was *given*, not the substitute one: a `~/.npm` that already
  // exists is worth reusing, and repairing the home must not change which cache that is.
  const cache = await buildCacheDirectory(work, inherited);
  const home = await usableHome(inherited);
  return {
    ...child,
    RWP_EDITION: edition,
    // Passed explicitly rather than left to npm's `$HOME/.npm` default: this is the line that keeps a
    // build alive on a machine whose home directory does not exist.
    npm_config_cache: cache,
    // Only when the inherited home is unusable. `HOME` is what `os.homedir()` answers in the child, and
    // `USERPROFILE` is the same question on Windows.
    ...(home ? { HOME: home, USERPROFILE: home } : {}),
    // A build must not try to be helpful: no audit, no funding notice, no update banner, and no colour
    // codes in the log this server quotes back to the operator.
    CI: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

/**
 * Runs one command to completion, quoting its own output back on failure.
 *
 * `shell` is not decoration: on Windows `npm` is `npm.cmd` and cannot be spawned directly, and the
 * template's build script is a shell pipeline on every platform. The process tree is killed on timeout
 * — a stopped `npm run build` that leaves esbuild running would keep a deployment's temp directory busy
 * until the machine is restarted, which is how this sort of pipeline earns a reputation.
 */
function run(command, args, { cwd, env, timeoutMs, log }) {
  return new Promise((resolve, reject) => {
    const output = [];
    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: true, windowsHide: true });
    } catch (error) {
      reject(buildFailure(`${command} could not be started: ${error instanceof Error ? error.message : 'unknown error'}`));
      return;
    }
    const record = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        output.push(text);
        if (output.length > 200) output.shift();
      }
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(buildFailure(`${command} ${args.join(' ')} did not finish within ${Math.round(timeoutMs / 1000)} s, so the deployment was stopped. Raise RWP_SAAS_BUILD_TIMEOUT_MS on a slow machine. log: ${tail(output)}`));
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(buildFailure(`${command} could not be started: ${error instanceof Error ? error.message : 'unknown error'}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        log?.(`${command} ${args.join(' ')} finished`);
        resolve(output);
        return;
      }
      reject(buildFailure(`${command} ${args.join(' ')} exited with code ${code}. log: ${tail(output) || 'no output'}`));
    });
  });
}

/**
 * Ends a build and everything it started. `child.kill()` only reaches the shell on Windows, and the
 * `npm` → `vite` → `esbuild` chain underneath it is what actually holds the CPU.
 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    child.kill('SIGKILL');
  } catch {
    // A process that is already gone is the outcome this was after.
  }
}

/**
 * A specifier that resolves through `node_modules` rather than through the tree being bundled:
 * `hono`, `pg`, `@supabase/supabase-js`, `node:crypto`.
 *
 * Copied in intent from `vite.api.config.mjs`, which bundles the same graph for `api/index.ts`. The
 * relative ids are what this step is *for* — `../server/media.mjs` and the pre-built Hono bundle are
 * pulled in, and a bare specifier is left for Vercel's `@vercel/nft` to trace from `node_modules`.
 *
 * A pattern rather than a predicate because it crosses into the bundler process as JSON: `rollupOptions`
 * takes strings and `RegExp`s, so the rule survives the trip while a function would not.
 */
const PACKAGE_SPECIFIER = new RegExp(String.raw`^(?![./\\\0]|[a-zA-Z]:[\\/])`);

/** A build script that does nothing, for a deployment whose bundle is already compiled. */
const NOOP_BUILD = 'node -e "process.exit(0)"';

/**
 * Whether a release's own install will provide Vite.
 *
 * The template carries Vite in `devDependencies`, so this is the question that decides whether the
 * functions can be bundled at all: the bundler runs *inside* the build tree and loads the tree's own copy.
 */
const declaresVite = (manifest) =>
  ['dependencies', 'devDependencies'].some((field) => {
    const declared = manifest?.[field];
    return Boolean(declared) && typeof declared === 'object' && 'vite' in declared;
  });

/**
 * What an operator can do about a build that has no Vite, said once for every message that needs it.
 *
 * The advice used to be "run npm install", which asked the operator to install this repository's
 * devDependencies on a server that only ever runs its compiled output. What a release needs is its *own*
 * Vite — the copy its lockfile pins — and a release is built by running its install, which is step one of
 * the deployment.
 */
const VITE_ADVICE =
  `A release is bundled with its own Vite (a devDependency of the template, installed by the release's `
  + `own npm ci). Deploy from a machine that can run that install, or set ${LOCAL_BUILD_ENV}=off, which `
  + `uploads the source tree and lets the customer read it.`;

/** The three files the bundling step puts in the build tree: its plan, its runner, and its report. */
const BUNDLE_PLAN = '.rwp-bundle.json';
const BUNDLE_RUNNER = '.rwp-bundle.mjs';
const BUNDLE_RESULT = '.rwp-bundle-result.json';

/** Where the bundled function modules are written, inside the build tree. */
const FUNCTIONS_DIR = '.rwp-functions';

/**
 * The script that bundles the function entries, written into the build tree and run from there.
 *
 * It is written into the tree rather than done in this process because `import('vite')` means different
 * things in the two places. Here it resolves against *this file's* `node_modules` — the server's, which a
 * production install does not have, and which does not exist at all in `api/plugins.mjs`, where
 * `@vercel/nft` leaves the specifier unresolvable. There it resolves against the release's own
 * `node_modules`, which the install just populated: the version its lockfile pins, present on any host,
 * and the same toolchain that compiled `dist/`. That difference is the whole bug this step is fixing.
 *
 * It is a *process* rather than a function for the other half of the same problem. Vite loads its native
 * bundler into whoever imports it and can never unload it, so a server that imported Vite out of a build
 * tree could not delete that tree again on Windows — a few hundred megabytes of `node_modules` per
 * deployment, kept until the machine is restarted. A short-lived process releases all of it, and a
 * bundler that crashes takes only that process with it.
 *
 * Its plan and its report are JSON, so the parent neither parses prose nor guesses which entries were
 * emitted: `BUNDLE_RESULT` is what it reads back, and a run that wrote no report is a failed run.
 */
const BUNDLE_SCRIPT = `import { readFile, writeFile } from 'node:fs/promises';

let vite;
try {
  vite = await import('vite');
} catch (error) {
  // Matched by the caller, which turns it into the sentence an operator can act on.
  console.error('VITE_MISSING', String((error && error.message) || error));
  process.exit(1);
}

const plan = JSON.parse(await readFile(${JSON.stringify(BUNDLE_PLAN)}, 'utf8'));
const external = new RegExp(plan.external.source, plan.external.flags);
const written = [];
for (const item of plan.entries) {
  item.options.build.rolldownOptions.external = external;
  try {
    await vite.build(item.options);
  } catch (error) {
    // Rolldown's message is a multi-screen code frame with ANSI colour; the operator needs the first few
    // lines of it, and the whole of it belongs in the server log.
    const detail = String((error && error.message) || error)
      .split('\\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' | ');
    console.error('BUNDLE_FAILED', item.name, detail);
    process.exit(1);
  }
  written.push(item.name);
}
await writeFile(${JSON.stringify(BUNDLE_RESULT)}, JSON.stringify({ vite: vite.version, entries: written }));
`;

/**
 * The failure a bundling run produces, as the sentence the deployment report should carry.
 *
 * `run()` quotes the whole command line, which for this step is a generated script nobody has heard of —
 * so the label the operator knows replaces it. `VITE_MISSING` is the one failure with a fix worth spelling
 * out: it means the tree has no Vite, and `VITE_ADVICE` says what that costs and how to get out of it.
 */
function bundlerFailure(error, label) {
  const detail = str(error?.message || error)
    .replace(/^node \.rwp-bundle\.mjs /, '')
    // Rolldown code frames carry colour even when a tool in between drops NO_COLOR.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  if (/VITE_MISSING/.test(detail)) {
    return buildFailure(`${label} has no Vite in its build tree, so its api/ entries could not be bundled into deployment functions. ${VITE_ADVICE}`);
  }
  // The script marks the entry it could not bundle. Vite logs a summary line of its own before it, which
  // says the same thing far less specifically, so the sentence starts at the marker when there is one.
  const marker = detail.indexOf('BUNDLE_FAILED');
  if (marker !== -1) {
    return buildFailure(`${label}: ${detail.slice(marker).replace(/^BUNDLE_FAILED\s*/, '')}`);
  }
  return buildFailure(`${label}: ${detail.replace(/^exited with code \d+\. log: /, '') || 'the bundler stopped without saying why'}`);
}

/**
 * One plugin server import, exactly as `server/plugins.mjs` writes it.
 *
 * The same shape the Plugins screen's uploader and Delete edit (`server/serverPluginImports.mjs`), read
 * here rather than shared because this step edits a *release's* file, not the server's own: a tree from a
 * tag is a document this process reads, whatever version of that helper the tag happens to carry.
 */
const PLUGIN_IMPORT = /^\s*import\('\.\.\/plugins\/([a-z0-9][a-z0-9-]{0,63})\/server\.mjs'\),\s*$/;

/** The plugin folders a registry file lists, in order — one per `import('../plugins/<folder>/server.mjs'),`. */
const listedPluginFolders = (registry) =>
  registry.split(/\r?\n/)
    .map((line) => PLUGIN_IMPORT.exec(line)?.[1])
    .filter((folder) => typeof folder === 'string');

/**
 * Drops the plugin imports a release lists but does not carry, before any of it is bundled.
 *
 * `server/plugins.mjs` imports each plugin's server module by literal path, because Vercel bundles a
 * function by tracing its imports and a module found with `readdir` would not travel — and every one of
 * those imports is *dynamic* so that a plugin folder deleted from the Plugins screen is skipped rather
 * than stopping the server. A bundler keeps no such promise: an unresolvable import is a build error, so
 * a release that lists a plugin it does not ship — every commercial plugin kept out of a public
 * repository, or a folder deleted without editing the registry, which is what a release prepared by
 * stripping `plugins/` looks like — failed the deployment with six frames of rolldown output.
 *
 * The tree is what is being deployed, so the tree is the truth: an import whose `plugins/<folder>/` is
 * absent is removed, exactly as the Plugins screen's Delete removes it, and each one is logged so an
 * operator can see that this release carries two plugins and not eight. Removing whole statements cannot
 * leave broken syntax behind, and a list emptied completely is still a valid `Promise.allSettled([])`.
 *
 * Returns the folders it dropped, for the deployment report.
 */
async function pruneMissingPluginImports(root, log) {
  const registry = path.join(root, 'server', 'plugins.mjs');
  const source = await readFile(registry, 'utf8').catch(() => null);
  if (source === null) return [];

  const lines = source.split(/\r?\n/);
  const folders = [...new Set(listedPluginFolders(source))];
  const carried = new Map(await Promise.all(folders.map(async (folder) => [
    folder,
    await isFile(path.join(root, 'plugins', folder, 'server.mjs')),
  ])));
  const missing = folders.filter((folder) => !carried.get(folder));
  if (missing.length === 0) return [];

  const kept = lines.filter((line) => {
    const folder = PLUGIN_IMPORT.exec(line)?.[1];
    return !folder || carried.get(folder);
  });
  await writeFile(registry, kept.join(source.includes('\r\n') ? '\r\n' : '\n'), 'utf8');
  for (const folder of missing) {
    log?.(`left out plugins/${folder}: server/plugins.mjs imports it, but the release does not carry that folder`);
  }
  return missing;
}

/**
 * Bundles every function entry into one self-contained ESM module, in the release's own tree.
 *
 * Vite's JS API rather than a second bundler: this is the same tool, the same transform and the same
 * `external` rule `vite.api.config.mjs` applies to the Hono app, so a function bundled here behaves like
 * the one the repository's own `npm run build:api` produces — including the `import('pg')` calls
 * `@vercel/nft` has to see. The API is reached through `BUNDLE_SCRIPT`, which runs in the tree: see there
 * for why this is a process and not a call.
 *
 * One consequence of bundling the *installer's* graph this way, worth knowing before adding an import
 * here: `api/plugins.ts` reaches this file, so a customer's `api/plugins.mjs` carries everything in it —
 * ~250 KB, the plugin registry included. Nothing of Vite travels with it any more, because the specifier
 * lives in a script written at build time; before that it was a literal `@vercel/nft` could not resolve,
 * which is what made a Vercel-hosted installer fail at this step.
 *
 * Returns the names of the modules it wrote, as the bundler reported them.
 */
async function bundleFunctions(root, entries, { env, timeoutMs, log, label }) {
  const outDir = path.join(root, FUNCTIONS_DIR);
  const plan = entries.map((entry) => {
    const input = path.join(root, 'api', entry);
    const name = entry.replace(/\.(?:ts|js|mjs)$/, '.mjs');
    return {
      name,
      options: {
        configFile: false,
        root,
        publicDir: false,
        appType: 'custom',
        logLevel: 'warn',
        build: {
          ssr: input,
          outDir,
          // Each entry is emitted beside the previous one; emptying the directory would delete it.
          emptyOutDir: false,
          target: 'esnext',
          minify: true,
          sourcemap: false,
          reportCompressedSize: false,
          rolldownOptions: {
            input,
            output: { entryFileNames: name, format: 'es', codeSplitting: false },
          },
        },
      },
    };
  });

  // `external` travels beside the entries rather than in them, because JSON has no `RegExp`: the script
  // rebuilds it and puts it on each entry's rolldown options before it bundles.
  await writeFile(path.join(root, BUNDLE_PLAN), JSON.stringify({ external: { source: PACKAGE_SPECIFIER.source, flags: PACKAGE_SPECIFIER.flags }, entries: plan }));
  await writeFile(path.join(root, BUNDLE_RUNNER), BUNDLE_SCRIPT);
  try {
    await run('node', [BUNDLE_RUNNER], { cwd: root, env, timeoutMs, log });
  } catch (error) {
    throw bundlerFailure(error, label);
  }

  // Read back rather than assumed: a bundler that wrote nothing has to be a failed build, not an empty
  // `api/` in a deployment.
  const result = readJson(await readFile(path.join(root, BUNDLE_RESULT)).catch(() => null));
  if (!result || !Array.isArray(result.entries) || result.entries.length !== entries.length) {
    throw buildFailure(`${label}'s api/ entries could not be bundled into deployment functions: the bundler finished without reporting what it wrote.`);
  }
  log?.(`bundled ${result.entries.length} function ${result.entries.length === 1 ? 'entry' : 'entries'} with vite ${result.vite} from the release's own node_modules`);
  return result.entries;
}

/**
 * The release's own `vercel.json`, with the three overrides a prebuilt payload needs.
 *
 * The rewrites are kept untouched — they are the routing the site was designed around. What changes is
 * that Vercel must not run this project's build: its devDependencies were omitted from the install, and
 * a successful build would replace the obfuscated `dist/` with the readable one it compiled from the
 * source that is no longer there. `installCommand` is only the runtime dependencies for the same
 * reason, and `outputDirectory` is where the uploaded bundle already sits.
 */
function deployedVercelJson(source) {
  let original = {};
  const raw = source.get('vercel.json');
  if (raw) {
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) original = parsed;
    } catch {
      // A release whose vercel.json is not JSON is a release Vercel would have rejected too; the
      // rewrites are then simply absent, and the SPA still has its index.html.
    }
  }
  return {
    ...original,
    buildCommand: NOOP_BUILD,
    installCommand: source.has('package-lock.json')
      ? 'npm ci --omit=dev --no-audit --no-fund'
      : 'npm install --omit=dev --no-audit --no-fund',
    outputDirectory: 'dist',
  };
}

/**
 * Refuses a payload that could put source code in a customer's dashboard.
 *
 * The check is deliberately blunt and runs on the finished map, after every step that adds to it. It is
 * the last thing between a mistake in this file and a release that hands out `src/`, so it fails the
 * deployment rather than trimming it: a payload that needed trimming is a payload nobody has looked at.
 */
export function assertDeployPayload(files, label = 'The deployment payload') {
  if (!(files instanceof Map) || files.size === 0) {
    throw buildFailure(`${label} is empty, so there is nothing to deploy.`);
  }
  const names = [...files.keys()];
  const offenders = names.filter((name) => !ALLOWED_PAYLOAD_ENTRY.test(name));
  if (offenders.length > 0) {
    const shown = offenders.slice(0, 6).join(', ');
    throw buildFailure(`${label} would upload ${offenders.length} file(s) that are not build output (${shown}${offenders.length > 6 ? ', …' : ''}). The deployment was stopped: a customer can open "Source" on their own Vercel project, so raw src/, plugins/ and config files must never reach it.`);
  }
  if (!files.has('dist/index.html')) {
    throw buildFailure(`${label} has no dist/index.html, so the site would answer 404 at / .`);
  }
  const entries = names.filter((name) => name.startsWith('api/'));
  if (entries.length === 0) {
    throw buildFailure(`${label} has no api/*.mjs function entry, so every /api/* request would 404.`);
  }
  return { files: names.length, entries };
}

/** Writes the extracted source tree to `root`, refusing any entry that would escape it. */
async function materialise(source, root, log) {
  let written = 0;
  for (const [name, bytes] of source) {
    if (!isSafeRelative(name)) {
      log?.(`skipped unsafe path ${name}`);
      continue;
    }
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    written += 1;
  }
  return written;
}

/** Every file under `dir`, as repository-style relative paths. */
async function walk(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      found.push(...await walk(path.join(dir, entry.name), name));
    } else if (entry.isFile()) {
      found.push(name);
    }
  }
  return found;
}

/** True when `target` exists and is a file. */
async function isFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** A JSON file from the payload, or null — a release whose manifest is not JSON is caught elsewhere. */
function readJson(bytes) {
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The shape of a value that may be written into a manifest's `version`: `2.5.4`, or `2.5.4-beta.1`. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * `manifest` with its `version` set to the tag being deployed — or **null** when there is nothing to change.
 *
 * A release is a tag, and the `package.json` committed beside it is written while the release is being
 * prepared, so the two disagree often enough that the site ends up reporting a version nobody published.
 * The prebuilt payload carries that manifest, and `RWP_APP_VERSION` is only written when the deployment's
 * environment can be edited, so stamping the file is what makes the *build itself* answer correctly.
 *
 * Null rather than the same object, because the caller must be able to tell "write these bytes" from
 * "upload the release's own file": a branch name (`main`) is not a version and never changes anything.
 */
function manifestAtVersion(manifest, version) {
  const plain = str(version).replace(/^v/i, '');
  if (!RELEASE_VERSION.test(plain) || manifest.version === plain) return null;
  return { ...manifest, version: plain };
}

/**
 * The same correction for the source-mode upload (`RWP_SAAS_LOCAL_BUILD=off`), where the tree goes to
 * Vercel as-is: the returned map is a copy with `package.json` naming the release, or `files` unchanged.
 *
 * @param {Map<string, Buffer>} files the extracted release
 * @param {string} [version] the tag being deployed
 */
export function withReleaseVersion(files, version = '') {
  const manifest = manifestAtVersion(readJson(files?.get?.('package.json')), version);
  if (!manifest) return files;
  const next = new Map(files);
  next.set('package.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return next;
}

/**
 * Payloads already built by this process, so a retried update — or the card's "check release" and then
 * the deploy — do not pay for the same build twice. Keyed by release, edition *and* the deployment's
 * own variables, because those are inlined into the bundle: the same tag for another site is a
 * different payload.
 */
const payloadCache = new Map();

function cacheKey(label, env, edition) {
  const fingerprint = JSON.stringify(Object.keys(env || {}).sort().map((key) => [key, String(env[key])]));
  return createHash('sha256').update(`${label}\n${edition}\n${fingerprint}`).digest('hex');
}

function readCache(key) {
  const hit = payloadCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    payloadCache.delete(key);
    return null;
  }
  // Re-inserted, so the Map's own order doubles as recency order for the size cap below.
  payloadCache.delete(key);
  payloadCache.set(key, hit);
  return hit;
}

function writeCache(key, files, report) {
  payloadCache.set(key, { files: new Map(files), report, at: Date.now() });
  while (payloadCache.size > CACHE_ENTRIES) payloadCache.delete(payloadCache.keys().next().value);
}

/** Test seam: drop every cached payload. */
export const clearPayloadCache = () => payloadCache.clear();

/**
 * Builds one template release into the payload a deployment may carry, on this machine.
 *
 * `source` is the extracted tarball — the tree `templateSourceFiles()` already filters — and `env` is
 * the *deployment's* configuration (`VITE_SUPABASE_URL` and friends), which the build inlines. The work
 * happens in a fresh temp directory so nothing this server owns (`node_modules`, `.env`, `data/`) can be
 * read, and the directory is removed whatever the outcome: a failed build must not leave a half-written
 * tree behind for the next one to pick up.
 *
 * `version` is the release tag being deployed (`v2.5.4`), and it is written into the `package.json` that
 * travels: a tag whose manifest still carries the previous number would make the site report a version it
 * does not run — on its own Update screen, and in every check it asks. A value that is not a version (a
 * branch name, for a deploy that is not a release) changes nothing.
 *
 * `steps` exists for the tests, which assemble a payload from a tree that is already built. In
 * production it is left undefined and the release's own `npm ci` / `npm run build` run.
 */
export async function buildDeployPayload({ source, label = 'the release', env = {}, version = '', steps = {}, timeoutMs, log } = {}) {
  if (!(source instanceof Map) || source.size === 0) {
    throw buildFailure('The release expands to no files, so there is nothing to build.');
  }
  const manifest = readJson(source.get('package.json'));
  if (!manifest) {
    throw buildFailure(`${label} has no readable package.json, so its dependencies cannot be installed.`);
  }
  const versioned = manifestAtVersion(manifest, version);

  const edition = buildEdition(env);
  const budget = Number(timeoutMs || process.env.RWP_SAAS_BUILD_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const key = cacheKey(label, env, edition);
  const cached = readCache(key);
  if (cached) {
    log?.(`reusing the payload built for ${label} in this process`);
    return { files: new Map(cached.files), report: { ...cached.report, cached: true } };
  }

  const started = Date.now();
  const install = steps.install === undefined
    ? {
      command: 'npm',
      args: source.has('package-lock.json')
        ? ['ci', '--no-audit', '--no-fund', '--loglevel=error']
        : ['install', '--no-audit', '--no-fund', '--loglevel=error'],
    }
    : steps.install;
  const buildStep = steps.build === undefined ? { command: 'npm', args: ['run', 'build'] } : steps.build;

  // Checked before the install rather than after it: a release that declares no Vite can never be
  // bundled, and finding that out after two minutes of `npm ci` and a Vite build is not an error message,
  // it is a waste of the operator's afternoon.
  if (install && !declaresVite(manifest)) {
    throw buildFailure(`${label} declares no Vite, so its api/ entries could not be bundled into deployment functions. ${VITE_ADVICE}`);
  }

  const work = await mkdtemp(path.join(tmpdir(), 'rwp-build-'));
  try {
    const workFiles = await materialise(source, work, log);
    // `work` is passed so the cache can fall back to a directory inside the build tree when this
    // machine's temp directory is not writable — see `buildCacheDirectory()`.
    const childEnv = await buildEnvironment(env, edition, { work });

    try {
      if (install) {
        await run(install.command, install.args, { cwd: work, env: childEnv, timeoutMs: budget, log });
      }
      if (buildStep) {
        await run(buildStep.command, buildStep.args, { cwd: work, env: childEnv, timeoutMs: budget, log });
      }
    } catch (error) {
      // A build that could not write its cache is a machine problem, and the report says so instead of
      // leaving the operator with npm's path in an `ENOENT`. See `npmCacheHint()`.
      throw npmCacheHint(error, childEnv);
    }

    const distRoot = path.join(work, 'dist');
    if (!await isFile(path.join(distRoot, 'index.html'))) {
      throw buildFailure(`${label}'s build finished but produced no dist/index.html, so Vercel would serve a 404 at / . Check the release's build script.`);
    }

    const files = new Map();
    let staticBytes = 0;
    for (const name of await walk(distRoot)) {
      // Source maps are the compiled code in readable form under another extension. They are not part
      // of what a deployment serves and they are exactly what the obfuscation is protecting.
      if (name.endsWith('.map')) continue;
      const bytes = await readFile(path.join(distRoot, ...name.split('/')));
      files.set(`dist/${name}`, bytes);
      staticBytes += bytes.length;
    }

    const apiRoot = path.join(work, 'api');
    const entries = await readdir(apiRoot).catch(() => []);
    const sources = entries.filter((name) => /^[A-Za-z0-9._-]+\.(?:ts|js|mjs)$/.test(name)).sort();
    if (sources.length === 0) {
      throw buildFailure(`${label} has no api/ function entry, so every /api/* request would 404.`);
    }
    const outDir = path.join(work, FUNCTIONS_DIR);
    // A release's registry can import a plugin its tree does not carry — the runtime skips those, the
    // bundler refuses them, so the tree is made consistent first. See `pruneMissingPluginImports`.
    const missingPlugins = await pruneMissingPluginImports(work, log);
    // Bundled after the build, because the release's install is what puts Vite in the tree — and in a
    // process that starts from that tree, so the tree stays deletable afterwards. See `BUNDLE_SCRIPT`.
    const bundled = await bundleFunctions(work, sources, { env: childEnv, timeoutMs: budget, log, label });
    const functions = [];
    let functionBytes = 0;
    for (const name of bundled) {
      const bytes = await readFile(path.join(outDir, name));
      files.set(`api/${name}`, bytes);
      functions.push(`api/${name}`);
      functionBytes += bytes.length;
    }

    // The release's own manifest and lockfile: the install Vercel runs is then the install this build ran,
    // rather than a second resolution of the same ranges. The manifest is the one exception to "untouched"
    // — its `version` is the tag being deployed, because that is the file the site answers with.
    for (const name of ['package.json', 'package-lock.json']) {
      const bytes = source.get(name);
      if (!bytes) continue;
      files.set(name, name === 'package.json' && versioned
        ? Buffer.from(`${JSON.stringify(versioned, null, 2)}\n`, 'utf8')
        : bytes);
    }
    files.set('vercel.json', Buffer.from(`${JSON.stringify(deployedVercelJson(source), null, 2)}\n`, 'utf8'));

    const checked = assertDeployPayload(files, label);

    // How much of the release stayed here. This is the number the card reports, because "N files
    // uploaded" says nothing about the source that was not.
    const uploadedFromSource = [...files.keys()].filter((name) => source.has(name)).length;
    const report = {
      mode: 'prebuilt',
      label,
      edition,
      /** The version the payload's own `package.json` names: the release tag, or the manifest's number. */
      version: versioned?.version || str(manifest.version),
      workFiles,
      dependencies: manifest.dependencies && typeof manifest.dependencies === 'object'
        ? Object.keys(manifest.dependencies).length
        : 0,
      install: install ? `${install.command} ${install.args.join(' ')}`.trim() : 'skipped',
      build: buildStep ? `${buildStep.command} ${buildStep.args.join(' ')}`.trim() : 'skipped',
      files: checked.files,
      bytes: staticBytes + functionBytes,
      staticFiles: files.size - functions.length - 1 - (files.has('package-lock.json') ? 1 : 0),
      staticBytes,
      functions,
      functionBytes,
      // Plugins the release's registry named but did not carry, left out of the function bundles. Empty
      // for a release that ships every plugin it lists, which is every release of this repository.
      missingPlugins,
      withheld: Math.max(source.size - uploadedFromSource, 0),
      ms: Date.now() - started,
      cached: false,
    };
    log?.(`built ${report.files} deployable files from ${workFiles} source files in ${Math.round(report.ms / 1000)} s`);
    writeCache(key, files, report);
    return { files, report };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * What the escape hatch costs, in the words the installer's own messages use.
 *
 * Written in the present tense on purpose: it is appended to a deployment's report ("this is how that
 * release went out") *and* to the release preview ("this is how it would go out"), and a past-tense
 * sentence would be a lie in the second place — nothing has been uploaded when the preview runs.
 */
export const SOURCE_MODE_WARNING =
  'RWP_SAAS_LOCAL_BUILD=off: this release is deployed as a source tree rather than as build output, so its '
  + 'src/, plugins/ and configuration files are readable under the project\'s "Source" tab.';

/**
 * What deploying this release *will* do, without doing it.
 *
 * `GET release/:version` is the card's "check this release" preview: pressing it must not spend minutes
 * of npm and Vite, so it reports the plan — the function entries the archive carries, the lockfile that
 * makes Vercel's install deterministic, the edition the bundle will be compiled for — and the deploy
 * itself is where the build happens.
 *
 * `edition` is what *this* server compiles for, which is the edition it writes onto every project it
 * creates. A project that already carries its own `RWP_EDITION` builds for that instead, and this
 * preview cannot know it: it holds no Vercel token, so it never reads another project's environment.
 * The deployment's own report does, and it is the authoritative word on which edition went out.
 */
export function describePrebuiltPlan({ source, env = {} } = {}) {
  const files = source instanceof Map ? source : new Map();
  const names = [...files.keys()];
  const functions = names
    .filter((name) => /^api\/[A-Za-z0-9._-]+\.(?:ts|js|mjs)$/.test(name))
    .map((name) => `api/${name.slice('api/'.length).replace(/\.[^.]+$/, '.mjs')}`)
    .sort();
  // The registry a release ships against the plugin folders it ships beside it. A release prepared by
  // stripping `plugins/` still lists their imports; the deploy drops those (`pruneMissingPluginImports`),
  // so a preview that stayed silent about them would describe a different deployment from the one it
  // announces — one that comes up, and answers no route for the plugins it names.
  const registry = files.get('server/plugins.mjs');
  const missingPlugins = registry
    ? listedPluginFolders(registry.toString('utf8'))
      .filter((folder) => !files.has(`plugins/${folder}/server.mjs`))
    : [];
  return {
    mode: localBuildEnabled() ? 'prebuilt' : 'source',
    edition: buildEdition(env),
    functions,
    lockfile: names.includes('package-lock.json'),
    sourceFiles: names.length,
    missingPlugins,
  };
}

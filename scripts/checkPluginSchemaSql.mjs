/**
 * `npm run check:schema` - every plugin's `schema.sql`, checked for calls that cannot resolve at run time.
 *
 * `node scripts/checkPluginSchemaSql.mjs <dir>` points the same check at another directory (a plugin
 * being reviewed, or a fixture in the tests), which is how its own rules are tested.
 *
 * A plugin schema is PostgreSQL that runs inside Supabase, and a `security definer` function in it is
 * pinned with `set search_path = public` so its body cannot be redirected by whatever `search_path` the
 * caller happens to have. That pinning is also a trap: such a body may only reach `public` and
 * `pg_catalog` (always searched first). pgcrypto - `gen_random_bytes`, `crypt`, `digest`, `hmac`,
 * `gen_salt` - is installed in the `extensions` schema on Supabase, so an unqualified call to it raises
 * `42883 function ... does not exist` the first time that branch runs.
 *
 * That failure deserves a check of its own because of how it surfaces: PostgREST answers a function that
 * raises `42883` with **404**, and a 404 from `/rpc/<name>` reads as "the function is not installed".
 * The licence grant route spent a while reporting `The database function
 * rwp_marketplace_owner_grant_license is missing` about a function that was installed, identical to this
 * file, and simply failed on the line that minted an opaque token.
 *
 * Read-only and offline: it reads `plugins/`, no database and no network. Run it before a release, and
 * after adding any function that generates a value, hashes something or calls an extension.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Routines that live outside `public`/`pg_catalog` on Supabase, so a pinned body cannot see them. */
const EXTENSION_ROUTINES = [
  'gen_random_bytes', 'crypt', 'gen_salt', 'digest', 'hmac', 'pgp_sym_encrypt', 'pgp_sym_decrypt',
  'uuid_generate_v1', 'uuid_generate_v4',
];

/** The schemas a pinned function may rely on. */
const SAFE_SCHEMAS = new Set(['public', 'pg_catalog']);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const exists = async (file) => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

/**
 * The function bodies in one schema file, as `{ name, searchPath, body }`.
 *
 * Deliberately small: the file is a script of `create … function … as $$ … $$;` statements, and the
 * question is only what each body calls. A regex over that shape is enough to catch a pinned body
 * reaching for an extension routine; a SQL parser would be a much larger thing to keep correct.
 */
export const readFunctions = (sql) => {
  const functions = [];
  const pattern = /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\)\s*([\s\S]*?)\$\$([\s\S]*?)\$\$\s*;/gi;
  for (const match of sql.matchAll(pattern)) {
    const [, rawName, , header, body] = match;
    // The clause is `set search_path = public as $$`, and the outer match stops at `$$`, so the captured
    // header ends with `as `: the value has to stop at that keyword rather than at a `$` that is no
    // longer there. `[\\w\\s,.]+` alone reads "public as", which no schema is called, and an unrecognised
    // schema is skipped as "not pinned" - a check that then examines nothing at all.
    const clause = /set\s+search_path\s*=\s*([\w\s,.]+?)\s+as\b/i.exec(header)?.[1] || '';
    functions.push({
      name: rawName.replace(/^public\./, ''),
      searchPath: clause.split(',').map((part) => part.trim()).filter(Boolean),
      body,
    });
  }
  return functions;
};

/** SQL comments stripped, so a comment that *names* a routine is documentation and not a call. */
const withoutComments = (sql) => sql.replace(/--[^\n]*/g, '');

/** Calls to an extension routine that are not qualified with a schema the body may use. */
export const unqualifiedCalls = (body) => {
  const found = [];
  const code = withoutComments(body);
  for (const routine of EXTENSION_ROUTINES) {
    for (const match of code.matchAll(new RegExp(`(^|[^.\\w])${routine}\\s*\\(`, 'gi'))) {
      // The character before the name decides whether it is a qualified call: `extensions.gen_…` is
      // deliberate and resolves whatever the pin is, because the caller said which schema it wants.
      const before = code.slice(Math.max(0, match.index - 32), match.index + 1);
      const qualifier = /([\w"]+)\s*\.\s*$/.exec(before)?.[1];
      if (qualifier && !SAFE_SCHEMAS.has(qualifier.replace(/"/g, ''))) continue;
      found.push({ routine, reason: qualifier ? `${qualifier}.${routine} is in another schema` : `a bare ${routine}(…) call` });
    }
  }
  return found;
};

/**
 * Everything wrong with one schema file, as sentences.
 *
 * Pure, so the tests can hand it a file containing the exact call that broke the licence grant and
 * assert that it is reported - a check that only ever sees good input proves nothing.
 */
export const schemaProblems = (sql, label = 'schema.sql') => {
  const problems = [];

  for (const fn of readFunctions(sql)) {
    // Only a *pinned* search path can hide `extensions`. An unpinned body inherits the caller's path,
    // which is a separate (and larger) design question this check does not try to answer.
    if (!fn.searchPath.length) continue;
    if (fn.searchPath.some((schema) => !SAFE_SCHEMAS.has(schema))) continue;
    for (const { routine, reason } of unqualifiedCalls(fn.body)) {
      problems.push(`${label}: ${fn.name}() calls ${routine}(), which is ${reason}. Its \`set search_path = ${fn.searchPath.join(', ')}\` cannot reach pgcrypto, so the call raises 42883 the first time that branch runs. Use a pg_catalog function (gen_random_uuid() replaces gen_random_bytes()), or qualify the call as extensions.${routine}().`);
    }
  }

  // The opaque marketplace token has a shape the partial unique index depends on: `like 'RWPM-%'` is the
  // predicate, so a rewrite that changes the generator is a rewrite of the index's meaning too.
  for (const match of withoutComments(sql).matchAll(/v_key\s*:=\s*'RWPM-'\s*\|\|\s*([^;]+);/gi)) {
    if (/gen_random_uuid\s*\(\s*\)/.test(match[1])) continue;
    problems.push(`${label} mints a token as \`'RWPM-' || ${match[1].trim()}\` without gen_random_uuid(); the index's \`like 'RWPM-%'\` predicate is what keeps it unique, so the generator has to stay a random UUID call.`);
  }

  return problems;
};

/** Every problem under a plugins directory, plus how many schema files were read. */
export const checkPlugins = async (directory) => {
  const problems = [];
  let scanned = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const schemaFile = path.join(directory, entry.name, 'schema.sql');
    if (!(await exists(schemaFile))) continue;
    scanned += 1;
    problems.push(...schemaProblems(await readFile(schemaFile, 'utf8'), `plugins/${entry.name}/schema.sql`));
  }
  return { scanned, problems };
};

/** The command line: report and set the exit code. Nothing runs when the module is imported. */
const main = async () => {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'plugins');
  const { scanned, problems } = await checkPlugins(directory);
  if (!scanned) problems.push(`No plugin declares a database schema under ${directory}, so this check examined nothing.`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s) with plugin schema SQL:\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Plugin schema SQL is clean (${scanned} schema file${scanned === 1 ? '' : 's'} checked).`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();


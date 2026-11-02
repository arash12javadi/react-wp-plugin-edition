/**
 * `npm run db:plugin-schema -- <plugin-id>` — installs a plugin's schema.sql into the database this
 * checkout is configured for, from a terminal, in one command.
 *
 * It exists because the alternative kept being silently wrong. A Supabase site whose project never ran
 * `plugins/rwp-plugin-marketplace/schema.sql` answers its Licence screen with an empty table and its
 * write routes with "database function rwp_marketplace_owner_grant_license is missing" — neither of
 * which says "the schema is not in *this* project". Activating the plugin needs a server that can
 * reach Postgres, and the SQL Editor needs the file pasted into the right dashboard tab. This does the
 * same work from the checkout, naming the project it targets before it writes anything.
 *
 * The guard is the point: `SUPABASE_DB_URL` and `VITE_SUPABASE_URL` can name different projects (a
 * dev checkout pointed at a live site does), and an install into the wrong one looks like success
 * until the screen is still empty. So the project ref inside the connection string is compared with
 * the one the site queries, and a disagreement stops the run unless `--force` says otherwise.
 *
 * `--check` makes the same comparison and prints what is present without writing anything: the
 * diagnosis on its own, for when a site is misbehaving and nothing should be touched.
 *
 * Reads only what the server reads (`server/env.mjs` → `.env.local`, then `.env`, then the extra file
 * named by `--env`, default `.env.live.local`), and writes nothing but the schema.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFiles } from '../server/env.mjs';
import { describeDbError, projectRefFromUrl, resolveConnectionString, withClient } from '../server/db.mjs';
import { installPluginSchema, readPluginDatabase, readSchemaState } from '../server/pluginSchema.mjs';

const usage = `Usage: npm run db:plugin-schema -- <plugin-id> [options]

  <plugin-id>     a folder in plugins/ whose manifest.json declares database.schema
  --check         report what is installed and apply nothing
  --force         install even when the target project is not the one the site queries
  --url <string>  the Postgres connection string to use, instead of SUPABASE_DB_URL
  --env <file>    an extra env file to fill missing values from (default: .env.live.local)
  --help          this text

Examples:
  npm run db:plugin-schema -- rwp-plugin-marketplace --check
  npm run db:plugin-schema -- rwp-plugin-marketplace`;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const options = { id: '', check: false, force: false, url: '', env: '.env.live.local', help: false };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--check') options.check = true;
  else if (arg === '--force') options.force = true;
  else if (arg === '--help' || arg === '-h') options.help = true;
  else if (arg === '--url' || arg === '--env') {
    index += 1;
    options[arg === '--url' ? 'url' : 'env'] = argv[index] || '';
  } else if (arg.startsWith('-')) fail(`Unknown option ${arg}.`);
  else if (options.id) fail(`Unexpected argument ${arg}.`);
  else options.id = arg;
}

/**
 * The project ref inside a connection string. Not `projectRefFromUrl`: that one reads an https URL,
 * and the ref lives in different places for the two Supabase connection styles — in the host for a
 * direct `db.<ref>.supabase.co` connection, and in the user name for the pooler
 * (`postgres.<ref>@aws-0-….pooler.supabase.com`).
 */
function projectRefFromConnectionString(value) {
  try {
    const url = new URL(value);
    const direct = /^db\.([a-z0-9-]+)\.supabase\.(?:co|in)$/i.exec(url.hostname || '');
    if (direct) return direct[1];
    const pooled = /^postgres\.([a-z0-9-]+)$/i.exec(decodeURIComponent(url.username || ''));
    return pooled ? pooled[1] : '';
  } catch {
    return '';
  }
}

/** The site's own config, as `server.mjs` reads it: `data/react-wp-config.json`, or null. */
async function readSiteConfig() {
  try {
    return JSON.parse(await readFile(path.resolve(process.env.REACT_WP_DATA_DIR || 'data', 'react-wp-config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is the core schema in this database? `public.profiles` and `public.user_has_cap()` are what the
 * plugin schemas build on — foreign keys on one, policy predicates on the other — so either one missing
 * means "this project has never had supabase/schema.sql applied", a different problem from "this
 * plugin's tables are missing", needing a different file. Queried through the catalogue rather than by
 * calling the function, so a permission error is never mistaken for an absent object.
 */
async function readCoreSchema(client) {
  const { rows } = await client.query(
    `select to_regclass('public.profiles') is not null as profiles,
            exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'user_has_cap') as user_has_cap`,
  );
  return { profiles: rows[0]?.profiles === true, userHasCap: rows[0]?.user_has_cap === true };
}

/** The core objects this database lacks, named one per line under `Core schema`. */
function coreProblems(core) {
  const missing = [];
  if (!core.profiles) missing.push('public.profiles');
  if (!core.userHasCap) missing.push('public.user_has_cap()');
  return missing;
}

/** One line per declared object, so a half-installed schema is readable at a glance. */
function report(state) {
  const line = (name, present) => say(`  ${present ? 'ok     ' : 'MISSING'} ${name}`);
  say(`Tables        ${state.present.length}/${state.present.length + state.missing.length} present`);
  for (const name of state.present) line(name, true);
  for (const name of state.missing) line(name, false);
  const declared = state.functionsPresent.length + state.functionsMissing.length;
  say(`Functions     ${state.functionsPresent.length}/${declared} present`);
  for (const name of state.functionsMissing) line(name, false);
}

async function main() {
  if (options.help || !options.id) {
    say(usage);
    process.exit(options.help ? 0 : 1);
  }

  const site = await readSiteConfig();
  // `.env.local` and `.env` are already in process.env (server/env.mjs loads them on import); the
  // extra file only fills what those left empty, which is how a checkout keeps live database
  // credentials beside a local sqlite dev setup.
  const filled = options.env ? loadEnvFiles([options.env]) : {};
  const filledKeys = Object.keys(filled);

  const resolved = resolveConnectionString({ connectionString: options.url }, site || {});
  if (!resolved.ok) {
    fail(`There is no database to install into.\n${resolved.error}\n`
      + 'Put the Supabase connection string in SUPABASE_DB_URL (Project Settings -> Database -> Connection string -> URI), or pass --url.');
  }

  const target = describeTarget(resolved.url);
  const siteRef = projectRefFromUrl(site?.supabaseUrl || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '');
  const from = options.url ? '--url' : 'SUPABASE_DB_URL';
  const where = filledKeys.length ? `${options.env} (filled ${filledKeys.join(', ')})` : 'environment';
  const siteLabel = site ? `${site.dbType || 'supabase'} (data/react-wp-config.json)` : 'no data/react-wp-config.json';
  const siteWhere = siteRef ? `which queries project ${siteRef}` : 'which names no Supabase project';

  say(`Plugin     ${options.id}`);
  say(`Database   ${target.ref ? `project ${target.ref}` : target.host} at ${target.host} (from ${from}, ${where})`);
  say(`Site       ${siteLabel}, ${siteWhere}`);

  if (siteRef && target.ref && siteRef !== target.ref) {
    const warning = `The site queries project ${siteRef}, but this connection string points at project ${target.ref}.\n`
      + 'Installing there would create the tables in a database no screen reads — the failure this command exists\n'
      + `to stop. Point SUPABASE_DB_URL at ${siteRef}, or pass --force if ${target.ref} is really the target.`;
    if (!options.force) fail(warning);
    say(`Warning    the site queries ${siteRef}; installing into ${target.ref} because --force was given`);
  } else if (!siteRef && site?.dbType && site.dbType !== 'supabase' && site.dbType !== 'postgres') {
    say(`Note       this checkout runs on ${site.dbType}, so it has no project of its own to compare against:`
      + ` the schema goes into ${target.ref || target.host}, taken from ${where}`);
  }

  let contract;
  try {
    contract = await readPluginDatabase(options.id);
  } catch (error) {
    fail(error instanceof Error ? error.message : `Could not read the manifest for "${options.id}".`);
  }
  const database = contract.database;
  if (!database?.schema) {
    fail(`"${options.id}" declares no database.schema in its manifest, so there is no schema.sql to install.`);
  }

  const label = database.schema.label;
  say(`Source     ${label} — ${database.tables.length} tables and ${database.functions.length} functions declared`);
  say('');

  if (options.check) {
    const state = await withClient(resolved.url, async (client) => ({
      core: await readCoreSchema(client),
      schema: await readSchemaState(client, database.tables, database.functions),
    })).catch((error) => fail(`Could not read the database: ${describeDbError(error, resolved.url)}`));
    const absentCore = coreProblems(state.core);
    say(absentCore.length
      ? `Core schema   MISSING ${absentCore.join(', ')} — run supabase/schema.sql in this project first`
      : 'Core schema   present (public.profiles, public.user_has_cap)');
    report(state.schema);
    if (absentCore.length) {
      say('');
      say('A site that renders and has an admin screen must have core schema in the database it queries, so a');
      say('project without it is usually the wrong project. Before running supabase/schema.sql here, check that');
      say(`SUPABASE_DB_URL and the site's own VITE_SUPABASE_URL name the same ref (${target.ref || target.host} above).`);
    }
    const incomplete = absentCore.length > 0
      || state.schema.missing.length > 0 || state.schema.functionsMissing.length > 0;
    say('');
    say(incomplete
      ? 'This database is not ready for this plugin. Run the same command without --check to install it.'
      : 'Everything this plugin declares is installed. Nothing to do.');
    process.exit(incomplete ? 1 : 0);
  }

  say(`Installing ${label}…`);
  let result;
  try {
    result = await installPluginSchema(resolved.url, options.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${message}\n`
      + (/does not exist/i.test(message)
        // 42P01 (relation) and 42883 (function) both land here, and both mean the same thing: the
        // plugin's SQL is written against core, and this project has never had core applied.
        ? 'That points at the core schema rather than the plugin\'s: this project has never had\n'
          + 'supabase/schema.sql applied, so the profiles table and user_has_cap() the plugin builds on are\n'
          + 'missing. Run supabase/schema.sql in this project\'s SQL Editor first, then repeat this command.\n'
          + 'If the site is already installed and rendering, this is the wrong project: compare the ref above\n'
          + 'with the VITE_SUPABASE_URL the site was built with.'
        : 'Nothing was applied: schema.sql runs in one transaction.'));
  }

  if (!result.installed) fail(`Nothing was installed (${result.reason || 'unknown reason'}).`);

  say(`Created    ${result.created.length ? result.created.join(', ') : 'nothing — the tables were already there'}`);
  const leftOver = [...result.stillMissing, ...result.missingFunctions];
  if (leftOver.length) {
    say(`MISSING    ${leftOver.join(', ')}`);
    fail(`${label} ran without an error but did not create ${leftOver.length} object(s). The server log is the next place to look.`);
  }
  say(`Ready      ${result.tables.length} tables and ${result.functions.length} functions in ${target.ref || target.host}.`);
  say('Reload the Licence screen: it asks the database again on every load.');
}

/** The target, as the two facts that make a wrong-project install visible. */
function describeTarget(connectionString) {
  let host = 'unknown host';
  try { host = new URL(connectionString).hostname; } catch { /* falls back to the label */ }
  return { ref: projectRefFromConnectionString(connectionString), host };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

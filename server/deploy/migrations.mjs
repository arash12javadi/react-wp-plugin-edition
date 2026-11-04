/**
 * A plugin's schema changes, applied only when a human said yes to *these* statements — and backed up first.
 *
 * Why consent is not a checkbox
 * -----------------------------
 * A plugin that installs itself cannot be trusted to run arbitrary DDL on a live site: `plugins/<id>/schema.sql`
 * is a file in a ZIP, and a ZIP is somebody else's code. So nothing here runs on its own. The dashboard shows
 * exactly what would run — how many statements, which tables they touch, which of them destroy data — and a
 * human approves *that summary*. The approval carries the summary's fingerprint, so a schema that changed
 * between being shown and being approved is refused rather than executed.
 *
 * Why a backup, when the statements run in a transaction
 * -----------------------------------------------------
 * A transaction covers a statement that fails half way. It does not cover the two things that actually go
 * wrong: a statement that succeeds and destroys data (`drop table`, `delete from`, `alter table … drop column`),
 * and a migration that is valid on the day and wrong a week later. So every table the statements touch has its
 * rows read into a JSON snapshot *before* anything runs, the snapshot is handed back to the caller to store, and
 * a failure restores from it where it can. A migration that cannot be backed up is refused.
 *
 * The functions are pure over two injected ports, so the tests never open a database:
 *
 *   `backup.snapshot({ tables })` → any JSON-serialisable value
 *   `backup.restore(snapshot)`    → void   (best effort; a failure is reported, not thrown)
 *   `run(statements)`             → void   (executes them in one transaction)
 */
import { createHash } from 'node:crypto';
import { DeployError } from './errors.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The code a route answers with when consent is missing or stale. */
export const MIGRATION_CONSENT_CODE = 'migration_consent_required';

/**
 * Statements that can lose data. Matched on the *beginning* of a statement, because that is where the verb is;
 * a `comment on … 'drop table'` is not a drop, and this must not claim it is.
 */
const DESTRUCTIVE_PATTERN = /^(?:drop|truncate)\b|^alter\s+table\b[\s\S]*\bdrop\b|^delete\s+from\b|^update\b\s+\w+\s+set\b/i;

/** `create table public.x`, `alter table if exists x`, `drop view x` — the objects a file touches. */
const TABLE_PATTERN = /\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:table|view)\s+(?:if\s+(?:not\s+)?exists\s+)?((?:"[^"]+"|[a-z0-9_$]+)(?:\.(?:"[^"]+"|[a-z0-9_$]+))?)/gi;

/**
 * Splits a schema file into statements.
 *
 * Dollar-quoted bodies (`do $$ … $$`, `create function … $$ … $$`) are the reason this is not `split(';')`: a
 * body contains semicolons of its own, and splitting inside one produces two broken statements and a migration
 * that fails on the site it was approved for. Line and block comments are dropped, because a trailing
 * `-- drop table x` in prose must never be counted as a destructive statement.
 */
export function splitStatements(sql) {
  const source = String(sql || '');
  const statements = [];
  let current = '';
  let index = 0;
  let dollarTag = '';
  while (index < source.length) {
    const rest = source.slice(index);
    if (dollarTag) {
      const close = rest.indexOf(dollarTag);
      if (close === -1) {
        current += rest;
        break;
      }
      current += rest.slice(0, close + dollarTag.length);
      index += close + dollarTag.length;
      dollarTag = '';
      continue;
    }
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      index += end === -1 ? rest.length : end + 1;
      current += '\n';
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      index += end === -1 ? rest.length : end + 2;
      continue;
    }
    const dollar = /^\$([A-Za-z0-9_]*)\$/.exec(rest);
    if (dollar) {
      dollarTag = dollar[0];
      current += dollar[0];
      index += dollar[0].length;
      continue;
    }
    if (source[index] === ';') {
      if (str(current)) statements.push(str(current));
      current = '';
      index += 1;
      continue;
    }
    current += source[index];
    index += 1;
  }
  if (str(current)) statements.push(str(current));
  return statements.filter((statement) => statement.length > 1);
}

/** The tables one statement touches, normalised to `schema.table` with `public` implied. */
function tablesIn(statement) {
  const found = new Set();
  for (const match of statement.matchAll(TABLE_PATTERN)) {
    const name = match[1].replace(/"/g, '').toLowerCase();
    found.add(name.includes('.') ? name : `public.${name}`);
  }
  return [...found];
}

/**
 * What one schema file would do — the shape the dashboard renders and the fingerprint is computed from.
 *
 * `sqlFiles` is `[{ path, sql }]`, the shape `server/pluginInstaller.mjs` already produces (`sqlFiles(entries)`),
 * so a ZIP install and a marketplace install describe their migrations the same way.
 */
export function plannedMigrations(sqlFiles = []) {
  return (Array.isArray(sqlFiles) ? sqlFiles : []).map((file) => {
    const statements = splitStatements(file?.sql);
    const tables = new Set();
    let destructive = 0;
    for (const statement of statements) {
      for (const table of tablesIn(statement)) tables.add(table);
      if (DESTRUCTIVE_PATTERN.test(statement)) destructive += 1;
    }
    return {
      path: str(file?.path),
      statements: statements.length,
      destructive,
      tables: [...tables].sort(),
      sql: statements,
    };
  });
}

/**
 * The plan without its SQL: what a screen shows and what a consent refers to.
 *
 * The SQL itself is deliberately absent — a summary that carries the statements is a summary somebody can diff
 * into a different one. `migrationFingerprint()` hashes the whole plan, statements included.
 */
export function summariseMigrations(plans = []) {
  const files = plans.map((plan) => ({
    path: plan.path,
    statements: plan.statements,
    destructive: plan.destructive,
    tables: plan.tables,
  }));
  return {
    files,
    statements: files.reduce((total, file) => total + file.statements, 0),
    destructive: files.reduce((total, file) => total + file.destructive, 0),
    tables: [...new Set(files.flatMap((file) => file.tables))].sort(),
    fingerprint: migrationFingerprint(plans),
  };
}

/** A hash of *these* statements: what makes an approval specific instead of general. */
export function migrationFingerprint(plans = []) {
  const material = plans.map((plan) => JSON.stringify({ path: plan.path, sql: plan.sql }));
  return `mig_${createHash('sha256').update(material.join('\n')).digest('hex').slice(0, 32)}`;
}

/**
 * Applies the migrations, or refuses with the summary in hand.
 *
 * `consent` is `{ fingerprint }` as the dashboard sends it back. Anything else — `true`, a different
 * fingerprint, nothing at all — is the same answer: 428 with the plan attached, so the screen can render exactly
 * what it wants approved without a second round trip.
 */
export async function applyMigrations({ plans = [], consent = null, backup = null, run, now = () => new Date() }) {
  const summary = summariseMigrations(plans);
  if (!summary.statements) return { applied: false, reason: 'no_migrations', summary };
  if (typeof run !== 'function') {
    throw new DeployError(500, 'This installation cannot run SQL directly, so the plugin\'s schema cannot be applied from here. Run its .sql file in the Supabase SQL editor, then install the plugin again.', { code: 'migrations_unavailable' });
  }
  if (!consent || str(consent.fingerprint) !== summary.fingerprint) {
    throw new DeployError(
      428,
      `This plugin changes the database: ${summary.statements} statement${summary.statements === 1 ? '' : 's'} across ${summary.tables.length} table${summary.tables.length === 1 ? '' : 's'}${summary.destructive ? `, ${summary.destructive} of which can destroy data` : ''}. Approve the change to continue.`,
      { code: MIGRATION_CONSENT_CODE, details: { summary } },
    );
  }
  if (typeof backup?.snapshot !== 'function') {
    throw new DeployError(500, 'This installation cannot back up the tables this plugin changes, so its schema was not applied. Nothing was modified.', { code: 'migration_backup_unavailable' });
  }

  const snapshot = await backup.snapshot({ tables: summary.tables });
  const at = (typeof now === 'function' ? now() : new Date(now)).toISOString();
  const statements = plans.flatMap((plan) => plan.sql);
  try {
    await run(statements);
  } catch (error) {
    const restored = await restore(backup, snapshot);
    throw new DeployError(
      500,
      `The plugin's schema failed part way and was rolled back: ${error instanceof Error ? error.message : 'the database refused a statement'}. `
      + (restored
        ? 'The affected tables were restored from the backup taken before it ran.'
        : 'The transaction was rolled back, but the backup could not be re-applied — check the tables named above.'),
      { code: 'migration_failed', cause: error, details: { restored, tables: summary.tables } },
    );
  }
  return { applied: true, summary, appliedAt: at, snapshot, statements: statements.length };
}

/** Best effort, and honest about it: a failed restore is reported by the caller, never thrown over the cause. */
async function restore(backup, snapshot) {
  if (typeof backup?.restore !== 'function') return false;
  try {
    await backup.restore(snapshot);
    return true;
  } catch {
    return false;
  }
}


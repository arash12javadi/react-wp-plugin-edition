/**
 * Brings a site's own database up to date after a release, without losing a row.
 *
 * The schema files (`supabase/schema.sql` and each plugin's `schema.sql`) are written to be re-runnable, so
 * "apply the new release's schema" is safe *as long as the file only adds things*. This module is what makes that
 * a checked property instead of a hope:
 *
 *   1. {@link classifyStatement} reads every top-level statement and refuses the ones that can lose or overwrite
 *      data (drop table/column/schema/type, truncate, delete, update, `insert … on conflict do update`, a column
 *      type change, a rename). A unit
 *      with such a statement is not run at all: it is reported as `manual`, with a sentence a non-developer can act on.
 *   2. A unit is run only when its fingerprint differs from the one recorded after the last successful run, so a
 *      restart costs one read and a release that did not touch the schema costs nothing.
 *   3. Each unit runs in ONE transaction, behind a session advisory lock (two servers cold-starting together cannot
 *      overlap; the loser reports `busy` and does nothing). A failing statement rolls the whole unit back, which in
 *      Postgres includes DDL, so the database is exactly as it was. There is deliberately no row snapshot on this
 *      path: nothing that could destroy rows is allowed to run, and the transaction covers the rest.
 *   4. For core, `SCHEMA_PRIVILEGES_SQL` runs last in the same transaction — the grants first, the revokes that
 *      withhold the secret tables after them, exactly the order `server/schemaPrivileges.mjs` documents. It is
 *      imported, never copied.
 *
 * The outcome is stored in the platform-owner `system_settings` row {@link SCHEMA_STATE_KEY}: hashes, statuses,
 * timestamps and one sentence per problem — never a connection string, a key or a SQL value.
 *
 * Only a *direct* Postgres session can run DDL. With none configured nothing here throws: the answer is
 * `needs_connection` and the dashboard says what to set.
 */
import { createHash } from 'node:crypto';
import { splitStatements } from './deploy/migrations.mjs';
import { SCHEMA_PRIVILEGES_SQL } from './schemaPrivileges.mjs';
import { describeDbError, withClient as defaultWithClient } from './db.mjs';
import { SCHEMA_STATE_SETTING_KEY } from './integrationConfig.mjs';

/** The platform-owner `system_settings` row holding the outcome. Listed in PLATFORM_SETTING_KEYS and rwp_platform_setting(). */
export const SCHEMA_STATE_KEY = SCHEMA_STATE_SETTING_KEY;

/** One fixed bigint for `pg_try_advisory_lock`: "RWPSCHEM" folded into 53 bits, so it is a safe JS integer. */
export const SCHEMA_LOCK_KEY = 5_757_464_716_333;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

const REFUSALS = [
  { kind: 'drop_table', pattern: /^drop\s+(?:table|schema|type|extension|sequence|materialized\s+view)\b/i, what: 'removes a table or another stored object' },
  { kind: 'truncate', pattern: /^truncate\b/i, what: 'empties a table' },
  { kind: 'delete', pattern: /^delete\s+from\b/i, what: 'deletes rows' },
  { kind: 'update', pattern: /^update\b/i, what: 'rewrites existing rows' },
  // `insert … on conflict do nothing` and a plain insert only add rows; `do update` overwrites what a user saved.
  { kind: 'upsert', pattern: /^insert\s+into\b[\s\S]*?\bon\s+conflict\b[\s\S]*?\bdo\s+update\b/i, what: 'overwrites existing rows' },
  { kind: 'drop_column', pattern: /^alter\s+table\b[\s\S]*?\bdrop\s+column\b/i, what: 'removes a column' },
  { kind: 'column_type', pattern: /^alter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\b(?:set\s+data\s+)?type\b/i, what: 'changes the type of a column' },
  { kind: 'rename', pattern: /^alter\s+table\b[\s\S]*?\brename\b/i, what: 'renames a table or column' },
  { kind: 'with_write', pattern: /^with\b[\s\S]*?\b(?:delete|update)\b/i, what: 'changes existing rows' },
];

/** Inside a `DO $$ … $$` block the verb is not at the start of a line, so the body is scanned for the worst four. */
const DO_BODY_REFUSALS = [
  { kind: 'drop_table', pattern: /\bdrop\s+(?:table|schema|type|extension|sequence)\b/i, what: 'removes a table or another stored object' },
  { kind: 'drop_column', pattern: /\bdrop\s+column\b/i, what: 'removes a column' },
  { kind: 'truncate', pattern: /\btruncate\b/i, what: 'empties a table' },
  { kind: 'delete', pattern: /\bdelete\s+from\b/i, what: 'deletes rows' },
  { kind: 'update', pattern: /\bupdate\s+(?:only\s+)?[\w."]+\s+set\b/i, what: 'rewrites existing rows' },
  { kind: 'upsert', pattern: /\bon\s+conflict\b[\s\S]*?\bdo\s+update\b/i, what: 'overwrites existing rows' },
];

/** Splits on commas that are not inside parentheses or quotes, so `set a = f(x, y), b = 1` is two assignments. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * True for `update T set c = … where c is null [and …]`: every assigned column must be tested `is null` in a
 * `where` that has no `or`. Such a statement can only fill values that are empty — it never overwrites one — which
 * is what a re-runnable backfill is. Anything else (no where, `or`, a column that is not tested) is refused.
 */
export function isNullFillUpdate(statement) {
  const match = /^update\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set\s+([\s\S]+?)\s+where\s+([\s\S]+)$/i.exec(str(statement));
  if (!match) return false;
  const [, assignments, condition] = match;
  if (/\bor\b/i.test(condition) || /;/.test(condition)) return false;
  const targets = topLevelParts(assignments).map((part) => /^\s*"?(\w+)"?\s*=/.exec(part)?.[1]).filter(Boolean);
  if (!targets.length || targets.length !== topLevelParts(assignments).length) return false;
  return targets.every((column) => new RegExp(`\\b${column}\\s+is\\s+null\\b`, 'i').test(condition));
}

/** A statement with its whitespace collapsed and shortened, for an error sentence. Schemas hold no secrets. */
const excerpt = (statement) => statement.replace(/\s+/g, ' ').slice(0, 90);

/**
 * `{ ok: true }` or `{ ok: false, kind, what, statement }`.
 *
 * Only the *beginning* of a top-level statement is read, plus the body of a `DO` block. A `create function` whose
 * body deletes rows (a trigger, an RPC) is not a migration step — it is code that runs later, on purpose — so it is
 * not refused. `drop policy|trigger|function|index|constraint|view if exists` are the re-run idiom and are allowed.
 */
export function classifyStatement(statement) {
  const text = str(statement);
  for (const rule of REFUSALS) {
    if (rule.kind === 'update' && isNullFillUpdate(text)) continue;
    if (rule.pattern.test(text)) return { ok: false, kind: rule.kind, what: rule.what, statement: excerpt(text) };
  }
  if (/^do\b/i.test(text)) {
    for (const rule of DO_BODY_REFUSALS) {
      if (rule.pattern.test(text)) return { ok: false, kind: rule.kind, what: rule.what, statement: excerpt(text) };
    }
  }
  return { ok: true };
}

const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * One schema file as a unit of work.
 * `id` is `core` or a plugin id; `tail` is SQL that must run after the file in the same transaction (core's privileges).
 */
export function planUnit({ id, label, version = '', sql, tail = '' }) {
  const statements = splitStatements(sql);
  const refused = statements.map(classifyStatement).filter((verdict) => !verdict.ok);
  return {
    id,
    label: label || id,
    version: str(version),
    statements,
    tail,
    refused,
    fingerprint: `sch_${sha(JSON.stringify({ statements, tail }))}`,
  };
}

/** Core first, then every plugin passed in — callers pass ACTIVE plugins only. */
export function planSchemaUpdate({ coreSql, plugins = [] }) {
  const units = [];
  if (str(coreSql)) units.push(planUnit({ id: 'core', label: 'React-WP core', sql: coreSql, tail: SCHEMA_PRIVILEGES_SQL }));
  for (const plugin of plugins) {
    if (!str(plugin?.sql)) continue;
    units.push(planUnit({ id: plugin.id, label: plugin.label || plugin.id, version: plugin.version, sql: plugin.sql }));
  }
  return units;
}

/** The sentence shown when a unit needs a human. Plain words, one next step. */
export function manualReason(unit) {
  const first = unit.refused[0];
  const more = unit.refused.length > 1 ? ` (and ${unit.refused.length - 1} more like it)` : '';
  const what = first.kind === 'upsert'
    ? 'would overwrite existing rows (it re-inserts settings and replaces the value you may have saved)'
    : first.what;
  return `${unit.label}'s update ${what}${more}, so it was NOT applied automatically and nothing was changed. `
    + 'Take a backup (Settings → Backup), then run the update by hand: open the Supabase SQL Editor and run '
    + (unit.id === 'core' ? 'supabase/schema.sql' : `plugins/${unit.id}/schema.sql`) + ' from this release.';
}

/** Parses the stored row; anything unreadable is "nothing recorded yet", never an error. */
export function parseState(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && parsed.units && typeof parsed.units === 'object' ? parsed : { units: {} };
  } catch {
    return { units: {} };
  }
}

const unitDone = (state, unit) => {
  const recorded = state.units?.[unit.id];
  return recorded && recorded.fingerprint === unit.fingerprint && recorded.status === 'ok';
};

/** What the dashboard shows: one status for the whole database and the units behind it. */
export function summariseState(units, state) {
  const rows = units.map((unit) => {
    const recorded = state.units?.[unit.id] || null;
    let status = 'pending';
    let reason = '';
    if (unit.refused.length) {
      status = 'manual';
      reason = manualReason(unit);
    } else if (unitDone(state, unit)) {
      status = 'ok';
    } else if (recorded && recorded.fingerprint === unit.fingerprint && recorded.status === 'failed') {
      status = 'failed';
      reason = recorded.reason || 'The last attempt failed and was rolled back.';
    }
    return { id: unit.id, label: unit.label, status, reason, at: recorded?.at || null };
  });
  const pick = (status) => rows.find((row) => row.status === status);
  const overall = pick('failed') ? 'failed' : pick('manual') ? 'manual' : pick('pending') ? 'pending' : 'ok';
  return { status: overall, units: rows, lastAppliedAt: rows.map((row) => row.at).filter(Boolean).sort().pop() || null };
}

const upsertState = (client, state) => client.query(
  `insert into public.system_settings (setting_key, setting_value) values ($1, $2)
   on conflict (setting_key) do update set setting_value = excluded.setting_value`,
  [SCHEMA_STATE_KEY, JSON.stringify(state)],
);

/** `undefined_table` (42P01) means a database that has not had the core schema yet: no state, not an error. */
async function readState(client) {
  try {
    const { rows } = await client.query('select setting_value from public.system_settings where setting_key = $1', [SCHEMA_STATE_KEY]);
    return parseState(rows[0]?.setting_value);
  } catch (error) {
    if (error?.code === '42P01') return { units: {} };
    throw error;
  }
}

/**
 * The ids in `rwp_active_plugins`, or `null` when the row is missing or unreadable.
 *
 * A plugin schema is applied automatically only for a plugin the administrator has already activated, and a
 * missing list is NOT read as "everything is active" (which is what the browser does): it means no plugin
 * schema is touched, so an unknown state can never apply a plugin's SQL.
 */
export async function readActivePluginIds(client) {
  try {
    const { rows } = await client.query("select option_value from public.options where option_name = 'rwp_active_plugins'");
    if (!rows.length) return null;
    const parsed = JSON.parse(rows[0].option_value);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/** Core always; a plugin only when it is in the active list. */
export const onlyActive = (units, activeIds) =>
  units.filter((unit) => unit.id === 'core' || (Array.isArray(activeIds) && activeIds.includes(unit.id)));

/**
 * Reads what has been recorded, without changing anything. `connectionString` empty → `needs_connection`.
 */
export async function readSchemaStatus({ connectionString, units, withClient = defaultWithClient }) {
  if (!str(connectionString)) return { status: 'needs_connection', units: [], lastAppliedAt: null };
  try {
    const { state, active } = await withClient(connectionString, async (client) => ({
      state: await readState(client),
      active: await readActivePluginIds(client),
    }));
    return summariseState(onlyActive(units, active), state);
  } catch (error) {
    return { status: 'unreachable', units: [], lastAppliedAt: null, reason: describeDbError(error, connectionString) };
  }
}

/**
 * Applies every unit whose fingerprint changed. Never throws: each outcome is data.
 *
 * Returns `{ status: 'busy' | 'needs_connection' | 'unreachable' | <summary status>, units, ran }`.
 * `ran` lists the unit ids that were actually executed this call.
 */
export async function runSchemaUpdate({ connectionString, units, withClient = defaultWithClient, now = () => new Date() }) {
  if (!str(connectionString)) return { status: 'needs_connection', units: [], ran: [], lastAppliedAt: null };
  const ran = [];
  try {
    return await withClient(connectionString, async (client) => {
      const lock = await client.query('select pg_try_advisory_lock($1) as locked', [SCHEMA_LOCK_KEY]);
      if (!lock.rows[0]?.locked) return { status: 'busy', units: [], ran, lastAppliedAt: null };
      try {
        const state = await readState(client);
        state.units = state.units || {};
        let coreOk = true;
        // Read after core has run: a fresh database has no options table until core is applied.
        let activeIds;
        for (const unit of units) {
          if (unit.id !== 'core') {
            if (!coreOk) continue; // plugin schemas build on core; wait for it
            if (activeIds === undefined) activeIds = await readActivePluginIds(client);
            if (!(activeIds || []).includes(unit.id)) continue;
          }
          const at = now().toISOString();
          if (unit.refused.length) {
            state.units[unit.id] = { fingerprint: unit.fingerprint, status: 'manual', at, reason: manualReason(unit) };
            if (unit.id === 'core') coreOk = false;
            continue;
          }
          if (unitDone(state, unit)) continue;
          try {
            await client.query('begin');
            for (const statement of unit.statements) await client.query(statement);
            if (unit.tail) await client.query(unit.tail);
            state.units[unit.id] = { fingerprint: unit.fingerprint, status: 'ok', at, version: unit.version, statements: unit.statements.length };
            await upsertState(client, state); // same transaction: applied and recorded together
            await client.query('commit');
            ran.push(unit.id);
          } catch (error) {
            await client.query('rollback').catch(() => {});
            state.units[unit.id] = {
              fingerprint: unit.fingerprint,
              status: 'failed',
              at,
              reason: `${unit.label}'s database update failed and was rolled back, so the database is unchanged: ${describeDbError(error, connectionString)}`,
            };
            if (unit.id === 'core') coreOk = false;
          }
        }
        // Manual and failed outcomes are recorded after the fact (their transactions are gone). The row may not
        // exist yet on a database that never had core; a failed write here must not hide the real answer.
        await upsertState(client, state).catch(() => {});
        if (activeIds === undefined) activeIds = await readActivePluginIds(client);
        return { ...summariseState(onlyActive(units, activeIds), state), ran };
      } finally {
        await client.query('select pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
      }
    });
  } catch (error) {
    return { status: 'unreachable', units: [], ran, lastAppliedAt: null, reason: describeDbError(error, connectionString) };
  }
}

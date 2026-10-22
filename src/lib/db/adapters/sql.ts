/**
 * A small, dialect-aware SQL builder shared by the PostgreSQL, MySQL and SQLite drivers.
 *
 * It exists so the three "real SQL" backends translate the same `DbFilter` / CRUD calls into the
 * same semantics with only their dialect's quoting, placeholders and upsert syntax differing.
 */
import type { DbFilter, DbNegatableOperator, DbOrder, DbRow, DbValue } from '../types';

export interface SqlDialect {
  readonly name: 'postgres' | 'mysql' | 'sqlite';
  /** Quotes an identifier: `"col"` for Postgres/SQLite, `` `col` `` for MySQL. */
  quote(ident: string): string;
  /** A positional placeholder for the nth (1-based) parameter: `$1` or `?`. */
  placeholder(index: number): string;
  /** True when the dialect supports `RETURNING` after INSERT/UPDATE. */
  returning: boolean;
}

export const postgresDialect: SqlDialect = {
  name: 'postgres',
  quote: (ident) => `"${ident.replace(/"/g, '""')}"`,
  placeholder: (index) => `$${index}`,
  returning: true,
};

export const mysqlDialect: SqlDialect = {
  name: 'mysql',
  quote: (ident) => `\`${ident.replace(/`/g, '``')}\``,
  placeholder: () => '?',
  returning: false,
};

export const sqliteDialect: SqlDialect = {
  name: 'sqlite',
  quote: (ident) => `"${ident.replace(/"/g, '""')}"`,
  placeholder: () => '?',
  returning: true,
};

/** Converts a value for a bound parameter: objects/arrays become JSON text, Dates become ISO text. */
export function bindValue(value: DbValue): DbValue {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export interface BuiltQuery {
  sql: string;
  params: DbValue[];
}

/** The comparison operators that map straight onto SQL, plus the two pattern matches. */
const sqlOperators: Partial<Record<DbNegatableOperator, string>> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  ilike: 'ilike',
};

/** Accumulates bound parameters while a clause is rendered, so every value stays out of the SQL text. */
interface ConditionContext {
  dialect: SqlDialect;
  params: DbValue[];
}

/** Binds one value and returns its placeholder. */
function bind(context: ConditionContext, value: DbValue): string {
  context.params.push(bindValue(value));
  return context.dialect.placeholder(context.params.length);
}

/**
 * Renders one comparison: `col = ?`, `col is null`, `col in (?, ?)`, `col like ?`.
 *
 * `ilike` is spelled `like` on SQLite: its LIKE is already case-insensitive for ASCII and the
 * keyword `ilike` does not exist there. An empty `in ()` becomes `1 = 0` — an empty list matches
 * nothing (as PostgREST does), and `in ()` is a syntax error on PostgreSQL.
 */
function comparison(column: string, operator: DbNegatableOperator, value: DbValue | DbValue[] | undefined, context: ConditionContext): string {
  const quoted = context.dialect.quote(column);

  if (value === null || value === undefined) {
    return operator === 'neq' ? `${quoted} is not null` : `${quoted} is null`;
  }
  if (operator === 'in' || Array.isArray(value)) {
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) return '1 = 0';
    return `${quoted} in (${values.map((item) => bind(context, item ?? null)).join(', ')})`;
  }
  if (operator === 'is') return `${quoted} = ${bind(context, value)}`;
  if (operator === 'like' || operator === 'ilike') {
    // SQLite has no default LIKE escape character, so the `\%` / `\_` a caller escaped for
    // PostgreSQL/MySQL would be read as literals there. Declaring the same escape character makes
    // one pattern mean the same thing on every backend.
    const keyword = context.dialect.name === 'sqlite' ? 'like' : sqlOperators[operator];
    const escape = context.dialect.name === 'sqlite' ? " escape '\\'" : '';
    return `${quoted} ${keyword} ${bind(context, String(value))}${escape}`;
  }
  return `${quoted} ${sqlOperators[operator] ?? '='} ${bind(context, value)}`;
}

/**
 * Splits a comma-separated PostgREST expression at its top level only, so commas inside
 * `(a,b,c)` lists or `"quoted, values"` stay part of their term.
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of input) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Reads one PostgREST value: `"text"`, `null`, `true`/`false`, `(a,b)`, or a bare literal. */
function parseOrValue(raw: string): DbValue | DbValue[] {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  if (text.startsWith('(') && text.endsWith(')')) {
    return splitTopLevel(text.slice(1, -1)).map((item) => parseOrValue(item) as DbValue);
  }
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

/** One `.or()` group: `col.op.value` terms, optionally nested in `and(…)`/`or(…)`. */
function parseOrGroup(input: string, context: ConditionContext): string {
  const terms = splitTopLevel(input).map((term) => parseOrTerm(term, context));
  if (!terms.length) return '1 = 0';
  return terms.length === 1 ? terms[0] : `(${terms.join(' or ')})`;
}

function parseOrTerm(term: string, context: ConditionContext): string {
  const group = /^(and|or)\(([\s\S]*)\)$/i.exec(term);
  if (group) {
    const joiner = group[1].toLowerCase() === 'and' ? ' and ' : ' or ';
    const inner = splitTopLevel(group[2]).map((part) => parseOrTerm(part, context));
    if (!inner.length) return joiner === ' and ' ? '1 = 1' : '1 = 0';
    return inner.length === 1 ? inner[0] : `(${inner.join(joiner)})`;
  }
  const first = term.indexOf('.');
  const second = first < 0 ? -1 : term.indexOf('.', first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`Could not read the or() condition "${term}". Use the PostgREST form column.operator.value, e.g. "status.is.null,status.neq.trash".`);
  }
  const rawColumn = term.slice(0, first).trim();
  const column = rawColumn.length >= 2 && rawColumn.startsWith('"') && rawColumn.endsWith('"') ? rawColumn.slice(1, -1) : rawColumn;
  const operator = term.slice(first + 1, second).trim().toLowerCase() as DbNegatableOperator;
  if (!(operator in sqlOperators) && operator !== 'is' && operator !== 'in') {
    throw new Error(`Unsupported or() operator "${operator}" in "${term}".`);
  }
  const parsed = parseOrValue(term.slice(second + 1));
  // PostgREST spells the like/ilike wildcard `*` in an `or()` expression (`title.ilike.*foo*`), and
  // resolves it to `%` before the query reaches the database. `%` keeps working as well.
  const value = operator === 'like' || operator === 'ilike'
    ? String(Array.isArray(parsed) ? parsed.join(',') : parsed ?? '').replace(/\*/g, '%')
    : parsed;
  return comparison(column, operator, value, context);
}

/**
 * Renders every narrowing condition a `DbFilter` carries — the one place SELECT, UPDATE and DELETE
 * agree on what a filter means, including the operators Supabase exposes but SQL needed spelled out.
 */
export function buildConditions(filter: DbFilter, dialect: SqlDialect, params: DbValue[]): string[] {
  const context: ConditionContext = { dialect, params };
  const conditions: string[] = [];
  const each = (group: Record<string, DbValue> | undefined, operator: DbNegatableOperator) => {
    for (const [column, value] of Object.entries(group ?? {})) {
      if (value === undefined) continue;
      conditions.push(comparison(column, operator, value, context));
    }
  };

  each(filter.where, 'eq');
  each(filter.notEq, 'neq');
  each(filter.gt, 'gt');
  each(filter.gte, 'gte');
  each(filter.lt, 'lt');
  each(filter.lte, 'lte');
  for (const [column, values] of Object.entries(filter.in ?? {})) {
    conditions.push(comparison(column, 'in', values ?? [], context));
  }
  for (const [column, pattern] of Object.entries(filter.ilike ?? {})) {
    if (pattern === undefined) continue;
    conditions.push(comparison(column, 'ilike', pattern, context));
  }
  for (const [column, pattern] of Object.entries(filter.like ?? {})) {
    if (pattern === undefined) continue;
    // SQLite's LIKE ignores case for ASCII unless the case_sensitive_like pragma is set, so `like`
    // reads as `ilike` there — the one difference a caller cannot see from a `DbFilter`.
    conditions.push(comparison(column, 'like', pattern, context));
  }
  for (const condition of filter.not ?? []) {
    conditions.push(`not (${comparison(condition.column, condition.operator, condition.value, context)})`);
  }
  if (filter.or?.trim()) conditions.push(parseOrGroup(filter.or, context));
  return conditions;
}

/**
 * Renders one `order by` term.
 *
 * `nullsFirst` is only spelled out when the caller asked for one: left undefined, each engine keeps
 * its own default (Postgres sorts nulls last for `asc`, MySQL and SQLite first), exactly as before —
 * which is also why it can never be translated as plain `NULLS FIRST`: MySQL rejects that keyword, so
 * there the null rows are pushed to the front/back with `col is null`.
 */
function orderClause(order: DbOrder, dialect: SqlDialect): string {
  const quoted = dialect.quote(order.column);
  const direction = order.direction === 'desc' ? 'desc' : 'asc';
  if (order.nullsFirst === undefined) return `${quoted} ${direction}`;
  if (dialect.name === 'postgres') return `${quoted} ${direction} ${order.nullsFirst ? 'nulls first' : 'nulls last'}`;
  return `${quoted} is null ${order.nullsFirst ? 'desc' : 'asc'}, ${quoted} ${direction}`;
}

/** Builds `SELECT cols FROM t [WHERE …] [ORDER BY …] [LIMIT …] [OFFSET …]`. */
export function buildSelect(table: string, filter: DbFilter, dialect: SqlDialect): BuiltQuery {
  const params: DbValue[] = [];
  const conditions = buildConditions(filter, dialect, params);

  let sql = `select ${filter.columns || '*'} from ${dialect.quote(table)}`;
  if (conditions.length) sql += ` where ${conditions.join(' and ')}`;
  const orders = (filter.orderBy ?? []).map((order) => orderClause(order, dialect));
  if (orders.length) sql += ` order by ${orders.join(', ')}`;
  if (filter.limit) sql += ` limit ${Math.floor(filter.limit)}`;
  if (filter.offset) sql += ` offset ${Math.floor(filter.offset)}`;

  return { sql, params };
}

/** Builds `INSERT INTO t (cols) VALUES (…), (…)`. */
export function buildInsert(table: string, rows: DbRow | DbRow[], dialect: SqlDialect): BuiltQuery {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) throw new Error('insert() needs at least one row.');
  const columns = [...new Set(list.flatMap((row) => Object.keys(row)))];
  const params: DbValue[] = [];
  const placeholders = list.map((row) => {
    const ph = columns.map((column) => {
      params.push(bindValue(row[column] ?? null));
      return dialect.placeholder(params.length);
    });
    return `(${ph.join(', ')})`;
  });
  const sql = `insert into ${dialect.quote(table)} (${columns.map((c) => dialect.quote(c)).join(', ')}) values ${placeholders.join(', ')}`;
  return { sql, params };
}

/**
 * Refuses a write that no condition narrows. `buildConditions` understands every operator a
 * `DbFilter` can carry, so an unqualified `UPDATE`/`DELETE` would mean the caller genuinely did not
 * scope the change — and would hit every row in the table.
 */
function assertScoped(conditions: string[], operation: 'update' | 'delete'): void {
  if (!conditions.length) {
    throw new Error(`Refusing to run a ${operation} without a filter: it would affect every row in the table. Add .eq(column, value) (or .in/.gt/.not/.or) to scope it.`);
  }
}

/** Builds `UPDATE t SET col = ?, … WHERE …`. */
export function buildUpdate(table: string, filter: DbFilter, patch: DbRow, dialect: SqlDialect): BuiltQuery {
  const params: DbValue[] = [];
  const columns = Object.keys(patch);
  if (!columns.length) throw new Error('update() needs at least one column to set.');
  const assignments = columns.map((column) => {
    params.push(bindValue(patch[column] ?? null));
    return `${dialect.quote(column)} = ${dialect.placeholder(params.length)}`;
  });
  // Set-values first, then the filter: MySQL/SQLite placeholders are positional, so the parameter
  // array has to follow the order the clauses appear in the statement.
  const conditions = buildConditions(filter, dialect, params);
  assertScoped(conditions, 'update');
  return { sql: `update ${dialect.quote(table)} set ${assignments.join(', ')} where ${conditions.join(' and ')}`, params };
}

/** Builds `DELETE FROM t WHERE …`. */
export function buildDelete(table: string, filter: DbFilter, dialect: SqlDialect): BuiltQuery {
  const params: DbValue[] = [];
  const conditions = buildConditions(filter, dialect, params);
  assertScoped(conditions, 'delete');
  return { sql: `delete from ${dialect.quote(table)} where ${conditions.join(' and ')}`, params };
}

/**
 * `INSERT … ON CONFLICT (…) DO NOTHING`: a row that is already there keeps every value it has.
 *
 * MySQL has no such clause, so updating the conflict key with itself stands in for it — `INSERT
 * IGNORE` would also swallow the errors that are not a conflict at all.
 */
function keepExistingRow(insert: BuiltQuery, conflict: string[], quotedConflict: string, dialect: SqlDialect): BuiltQuery {
  return dialect.name === 'mysql'
    ? { sql: `${insert.sql} on duplicate key update ${conflict.map((c) => `${dialect.quote(c)} = ${dialect.quote(c)}`).join(', ')}`, params: insert.params }
    : { sql: `${insert.sql} on conflict (${quotedConflict}) do nothing`, params: insert.params };
}

/** Builds a dialect-correct upsert for one or more rows. */
export function buildUpsert(
  table: string,
  rows: DbRow[],
  conflictColumns: string[],
  dialect: SqlDialect,
  ignoreDuplicates = false,
): BuiltQuery {
  if (!rows.length) throw new Error('upsert() needs at least one row.');
  const insert = buildInsert(table, rows, dialect);
  const conflict = conflictColumns.length ? conflictColumns : ['id'];
  const quotedConflict = conflict.map((c) => dialect.quote(c)).join(', ');
  if (ignoreDuplicates) return keepExistingRow(insert, conflict, quotedConflict, dialect);
  // Every inserted column except the conflict key is refreshed. Writing back only the key would
  // leave the previous value of every other column in place, so a second save would silently no-op.
  const updated = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((column) => !conflict.includes(column));
  if (!updated.length) {
    // A row that carries nothing but its key: there is nothing to refresh, so keep the existing row.
    return keepExistingRow(insert, conflict, quotedConflict, dialect);
  }

  if (dialect.name === 'mysql') {
    const updates = updated.map((column) => `${dialect.quote(column)} = values(${dialect.quote(column)})`);
    return { sql: `${insert.sql} on duplicate key update ${updates.join(', ')}`, params: insert.params };
  }

  const updates = updated.map((column) => `${dialect.quote(column)} = excluded.${dialect.quote(column)}`);
  return {
    sql: `${insert.sql} on conflict (${quotedConflict}) do update set ${updates.join(', ')}`,
    params: insert.params,
  };
}

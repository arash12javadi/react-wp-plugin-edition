/**
 * Universal client facade.
 *
 * The one object every UI/admin module uses for data + auth. It exposes the familiar Supabase-shaped
 * surface — `from(table).select().eq()…`, `rpc()`, `auth.*` — but routes every call through the
 * `DBAdapter` / `AuthAdapter` abstraction: **Supabase mode** delegates to the real client (embeds,
 * RPCs, realtime, OAuth behave exactly as before); **universal mode** uses the query builder and
 * bcrypt+JWT auth engine below. This is what makes the app 100% database-agnostic.
 */
import { getDbAdapter, type DBAdapter } from './db/index';
import { getAuthAdapter, type AuthAdapter } from './auth/index';
import { readAuthToken, writeAuthToken } from './auth/token';
import { resolveRuntimeConfig, isConfigured } from './runtime';
import type { DbFilter, DbNegatableOperator, DbValue } from './db/types';
import { hasFilterScope } from './db/types';
import type { SupabaseAdapter } from './db/adapters/supabase';
import { describeDbError } from './db/errors';

// -- Shared shapes (structurally compatible with @supabase/supabase-js) --------

export interface User {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  role?: string;
  /**
   * The account's sign-in identities. A repeated sign-up is answered with a user that has an empty
   * list rather than an error, which is how the register form recognises an existing address — so
   * the field has to be typed, not merely reachable through the index signature below.
   */
  identities?: UserIdentity[] | null;
  [key: string]: unknown;
}

/** One sign-in identity on a user: Supabase's `UserIdentity`, as much of it as anything reads. */
export interface UserIdentity {
  id?: string;
  provider?: string;
  identity_data?: Record<string, unknown>;
}

export interface Session {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  user: User;
}

/**
 * The error half of every result — Supabase's own shape, so an error read from either backend still
 * has a `code`, the `details`/`hint` PostgREST adds, and the class `name` an auth error carries.
 */
export type DbError = { message: string; code?: string; details?: string; hint?: string; name?: string } | null;

/**
 * What awaiting a query resolves to — `PostgrestResponse`, so a call written against either backend
 * destructures the same fields.
 *
 * `data` is deliberately loose: on Supabase it is the real client's typed payload, while the
 * universal builder only knows it built `DbRow[]`, and every caller assigns it to its own row type.
 */
export interface QueryResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: DbError;
  /** The rows a read returned; `null` for a write or a single-row read, as PostgREST reports it. */
  count: number | null;
}

/**
 * One realtime subscription, as the screens that use it need it: watch a table, then subscribe.
 *
 * Supabase Realtime is what provides this; a universal backend has no live connection, so
 * `client.channel()` there returns a channel that simply never fires (see `buildClient`).
 */
export interface RwpRealtimeChannel {
  on(
    event: 'postgres_changes',
    filter: { event: string; schema: string; table: string; filter?: string },
    callback: (payload: unknown) => void,
  ): RwpRealtimeChannel;
  subscribe(callback?: (status: string) => void): RwpRealtimeChannel;
  unsubscribe(): Promise<'ok'>;
}

export interface Client {
  from(table: string): QueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: DbError }>;
  auth: AuthFacade;
  /** Opens a Realtime channel (Supabase); a no-op channel on every other backend. */
  channel(name: string): RwpRealtimeChannel;
  /** Closes a channel `channel()` opened. */
  removeChannel(channel: RwpRealtimeChannel): Promise<'ok'>;
}

export interface AuthFacade {
  getSession(): Promise<{ data: { session: Session | null }; error: DbError }>;
  getUser(): Promise<{ data: { user: User | null }; error: DbError }>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<{ data: { session: Session | null; user: User | null }; error: DbError }>;
  signUp(credentials: { email: string; password: string; options?: Record<string, unknown> }): Promise<{ data: { session: Session | null; user: User | null }; error: DbError }>;
  signOut(options?: { scope?: 'global' | 'local' | 'others' }): Promise<{ error: DbError }>;
  onAuthStateChange(callback: (event: string, session: Session | null) => void): { data: { subscription: { unsubscribe: () => void } } };
  updateUser(attributes: Record<string, unknown>): Promise<{ data: { user: User | null }; error: DbError }>;
  signInWithOAuth(input: { provider: string; options?: Record<string, unknown> }): Promise<{ data: { provider: string; url: string }; error: DbError }>;
  /** Emails a link that signs the visitor in on `redirectTo` to choose a new password. */
  resetPasswordForEmail(email: string, options?: { redirectTo?: string }): Promise<{ data: unknown; error: DbError }>;
}

const safeColumns = (columns: string | undefined): string | undefined => {
  if (!columns) return undefined;
  // PostgREST embeds (…) and aliases (a:b) are Supabase-only; universal backends read the whole row.
  if (/[!():]/.test(columns)) return undefined;
  return columns;
};

export class QueryBuilder {
  private adapter: DBAdapter;
  private readonly table: string;
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private payload: any;
  private onConflict: string[] | undefined;
  private ignoreDuplicates = false;
  private selectState: { columns?: string; count?: boolean; head?: boolean } = {};
  private filter: DbFilter = {};
  private singleMode = false;
  private maybeSingleMode = false;

  constructor(adapter: DBAdapter, table: string) {
    this.adapter = adapter;
    this.table = table;
  }

  // Thenable: `await db.from('t').select('*').eq(...)` resolves to `{ data, error, count }`.
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult> {
    try {
      switch (this.op) {
        case 'select': {
          const columns = safeColumns(this.selectState.columns);
          const filter: DbFilter = { ...this.filter };
          if (columns) filter.columns = columns;
          if (this.singleMode || this.maybeSingleMode) {
            const row = await this.adapter.selectOne(this.table, { ...filter, limit: 1 });
            if (this.singleMode && !row) return { data: null, error: { message: 'No rows found.' }, count: null };
            return { data: row, error: null, count: null };
          }
          const rows = await this.adapter.select(this.table, filter);
          return { data: rows, error: null, count: rows.length };
        }
        case 'insert': {
          const rows = await this.adapter.insert(this.table, this.payload);
          return { data: rows, error: null, count: null };
        }
        case 'update': {
          // Any narrowing condition the builder can carry counts as scope: `.eq()`, but also
          // `.in()`, `.gt()`/`.lt()`, `.not()` and `.or()`. Only a genuinely unscoped write is
          // refused, since it would rewrite every row in the table.
          if (!hasFilterScope(this.filter)) {
            return { data: null, error: { message: 'Refusing to update without a filter. Add .eq(column, value) (or .in/.gt/.not/.or) to scope the change.' }, count: null };
          }
          const rows = await this.adapter.update(this.table, this.writeFilter(), this.payload);
          return { data: rows, error: null, count: null };
        }
        case 'upsert': {
          const rows = await this.adapter.upsert(
            this.table,
            Array.isArray(this.payload) ? this.payload : [this.payload],
            this.onConflict,
            this.ignoreDuplicates,
          );
          return { data: rows, error: null, count: null };
        }
        case 'delete': {
          if (!hasFilterScope(this.filter)) {
            return { data: null, error: { message: 'Refusing to delete without a filter. Add .eq(column, value) (or .in/.gt/.not/.or) to scope the change.' }, count: null };
          }
          const rows = await this.adapter.delete(this.table, this.writeFilter());
          return { data: rows, error: null, count: null };
        }
        default:
          return { data: null, error: null, count: null };
      }
    } catch (error) {
      return { data: null, error: { message: describeDbError(error) }, count: null };
    }
  }

  /**
   * The filter a write runs with: the narrow conditions, plus the column list `.select()` asked for
   * (so the driver can hand the written rows back).
   */
  private writeFilter(): DbFilter {
    const filter: DbFilter = { ...this.filter };
    const columns = safeColumns(this.selectState.columns);
    if (columns) filter.columns = columns;
    return filter;
  }

  select(columns = '*', options?: { count?: 'exact'; head?: boolean }): this {
    // `.select()` after a write (insert/update/upsert/delete) selects the return columns; it must
    // not turn the write back into a plain SELECT. The op is only ever 'select' when this builder
    // was created via from(table).select(...).
    this.selectState = { columns, count: options?.count === 'exact', head: options?.head === true };
    return this;
  }

  eq(column: string, value: DbValue): this {
    this.filter.where = { ...(this.filter.where ?? {}), [column]: value };
    return this;
  }

  neq(column: string, value: DbValue): this {
    this.filter.notEq = { ...(this.filter.notEq ?? {}), [column]: value };
    return this;
  }

  gt(column: string, value: DbValue): this {
    this.filter.gt = { ...(this.filter.gt ?? {}), [column]: value };
    return this;
  }

  gte(column: string, value: DbValue): this {
    this.filter.gte = { ...(this.filter.gte ?? {}), [column]: value };
    return this;
  }

  lt(column: string, value: DbValue): this {
    this.filter.lt = { ...(this.filter.lt ?? {}), [column]: value };
    return this;
  }

  lte(column: string, value: DbValue): this {
    this.filter.lte = { ...(this.filter.lte ?? {}), [column]: value };
    return this;
  }

  in(column: string, values: DbValue[]): this {
    this.filter.in = { ...(this.filter.in ?? {}), [column]: values };
    return this;
  }

  /** Case-insensitive pattern match. Supabase's `ilike()`; SQLite emulates it with `lower()`. */
  ilike(column: string, pattern: string): this {
    this.filter.ilike = { ...(this.filter.ilike ?? {}), [column]: pattern };
    return this;
  }

  /** Case-sensitive pattern match. Supabase's `like()`; SQLite's `LIKE` also ignores ASCII case. */
  like(column: string, pattern: string): this {
    this.filter.like = { ...(this.filter.like ?? {}), [column]: pattern };
    return this;
  }

  /**
   * Negates one condition: `not('status', 'eq', 'draft')`, `not('email', 'is', null)`,
   * `not('id', 'in', ids)`. Several calls are ANDed together, exactly as PostgREST chains them.
   */
  not(column: string, operator: DbNegatableOperator, value?: DbValue | DbValue[] | null): this {
    this.filter.not = [...(this.filter.not ?? []), { column, operator, value: value ?? null }];
    return this;
  }

  /**
   * A PostgREST-style disjunction, e.g. `.or('status.is.null,status.neq.trash')`: the terms are
   * grouped and the whole group is ANDed with the rest of the filter. Chained calls extend the same
   * group, so they stay a union rather than becoming separate ANDed groups.
   */
  or(conditions: string): this {
    const extra = conditions.trim();
    if (extra) this.filter.or = this.filter.or ? `${this.filter.or},${extra}` : extra;
    return this;
  }

  is(column: string, value: DbValue): this {
    return value === null || value === undefined ? this.eq(column, null) : this.eq(column, value);
  }

  /**
   * `nullsFirst` mirrors PostgREST's: left undefined, each engine keeps its own default (Postgres
   * puts nulls last for `ascending`, MySQL and SQLite put them first).
   */
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.filter.orderBy = [
      ...(this.filter.orderBy ?? []),
      { column, direction: options?.ascending === false ? 'desc' : 'asc', nullsFirst: options?.nullsFirst },
    ];
    return this;
  }

  limit(count: number): this {
    this.filter.limit = count;
    return this;
  }

  range(from: number, to: number): this {
    this.filter.offset = from;
    this.filter.limit = to - from + 1;
    return this;
  }

  single(): this {
    this.singleMode = true;
    this.maybeSingleMode = false;
    return this;
  }

  maybeSingle(): this {
    this.maybeSingleMode = true;
    this.singleMode = false;
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }

  /**
   * `ignoreDuplicates` leaves a row that already uses the conflict key untouched — Supabase's own
   * `ignoreDuplicates` (PostgREST's `resolution=ignore-duplicates`).
   */
  upsert(payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = 'upsert';
    this.payload = payload;
    this.onConflict = options?.onConflict ? options.onConflict.split(',').map((c) => c.trim()) : undefined;
    this.ignoreDuplicates = options?.ignoreDuplicates === true;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }
}

// -- Universal auth facade -----------------------------------------------------

export class UniversalAuthFacade implements AuthFacade {
  private adapter: AuthAdapter;
  private listeners: Array<(event: string, session: Session | null) => void> = [];

  constructor(adapter: AuthAdapter) {
    this.adapter = adapter;
  }

  // The token lives under one key (see ./auth/token) that HttpDBAdapter also reads to authorize its
  // /api/db/query calls, so the two halves of the universal stack stay in sync.
  private token(): string | null {
    return readAuthToken();
  }

  private setToken(value: string | null): void {
    writeAuthToken(value);
  }

  private emit(event: string, session: Session | null): void {
    this.listeners.forEach((cb) => cb(event, session));
  }

  async getSession(): Promise<{ data: { session: Session | null }; error: DbError }> {
    const token = this.token();
    if (!token) return { data: { session: null }, error: null };
    const user = await this.adapter.authenticate(token);
    if (!user) return { data: { session: null }, error: null };
    return { data: { session: { access_token: token, user: user as User } }, error: null };
  }

  async getUser(): Promise<{ data: { user: User | null }; error: DbError }> {
    const token = this.token();
    if (!token) return { data: { user: null }, error: null };
    const user = await this.adapter.authenticate(token);
    return { data: { user: user as User | null }, error: null };
  }

  async signInWithPassword(credentials: { email: string; password: string }): Promise<{ data: { session: Session | null; user: User | null }; error: DbError }> {
    try {
      const session = await this.adapter.signIn(credentials.email, credentials.password);
      this.setToken(session.accessToken);
      const result = {
        data: {
          session: { access_token: session.accessToken, expires_at: session.expiresAt, user: session.user as User },
          user: session.user as User,
        },
        error: null as DbError,
      };
      this.emit('SIGNED_IN', result.data.session);
      return result;
    } catch (error) {
      return { data: { session: null, user: null }, error: { message: describeDbError(error) } };
    }
  }

  async signUp(credentials: { email: string; password: string; options?: Record<string, unknown> }): Promise<{ data: { session: Session | null; user: User | null }; error: DbError }> {
    try {
      const role = (credentials.options?.data as { role?: string } | undefined)?.role;
      const result = await this.adapter.signUp(credentials.email, credentials.password, role);
      if (result.session) {
        this.setToken(result.session.accessToken);
        this.emit('SIGNED_IN', { access_token: result.session.accessToken, expires_at: result.session.expiresAt, user: result.session.user as User });
      }
      return {
        data: {
          session: result.session ? { access_token: result.session.accessToken, expires_at: result.session.expiresAt, user: result.session.user as User } : null,
          user: result.user as User | null,
        },
        error: null,
      };
    } catch (error) {
      return { data: { session: null, user: null }, error: { message: describeDbError(error) } };
    }
  }

  async signOut(): Promise<{ error: DbError }> {
    this.setToken(null);
    this.emit('SIGNED_OUT', null);
    return { error: null };
  }

  onAuthStateChange(callback: (event: string, session: Session | null) => void): { data: { subscription: { unsubscribe: () => void } } } {
    this.listeners.push(callback);
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.listeners = this.listeners.filter((cb) => cb !== callback);
          },
        },
      },
    };
  }

  async updateUser(): Promise<{ data: { user: User | null }; error: DbError }> {
    return { data: { user: null }, error: { message: 'updateUser is not available in universal authentication mode.' } };
  }

  async signInWithOAuth(): Promise<{ data: { provider: string; url: string }; error: DbError }> {
    return { data: { provider: '', url: '' }, error: { message: 'OAuth sign-in is not available in universal authentication mode.' } };
  }

  // A reset link has to be mailed out by a service this backend does not ship, so it reports the
  // same "not available" error as the other Supabase-only auth calls.
  async resetPasswordForEmail(): Promise<{ data: unknown; error: DbError }> {
    return { data: null, error: { message: 'Password reset emails are not available in universal authentication mode.' } };
  }
}

// -- The universal client ------------------------------------------------------

let resolvedClient: Client | null = null;

/**
 * The channel a universal backend hands out. Realtime runs over Supabase's websocket, so `on()`
 * registers nothing and `subscribe()` never fires — the screens that use Realtime also poll, so they
 * keep working; only the live push is missing.
 */
const noopChannel: RwpRealtimeChannel = {
  on: () => noopChannel,
  subscribe: () => noopChannel,
  unsubscribe: () => Promise.resolve('ok' as const),
};

function buildClient(): Client {
  const config = resolveRuntimeConfig();
  if (config.dbType === 'supabase') {
    const adapter = getDbAdapter(config) as SupabaseAdapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = adapter.getClient() as any;
    return {
      from: (table: string) => supabase.from(table),
      rpc: (fn: string, args?: Record<string, unknown>) => supabase.rpc(fn, args),
      auth: supabase.auth,
      channel: (name: string) => supabase.channel(name),
      removeChannel: (channel: RwpRealtimeChannel) => supabase.removeChannel(channel),
    };
  }
  const adapter = getDbAdapter(config);
  return {
    from: (table: string) => new QueryBuilder(adapter, table),
    rpc: (fn: string) => Promise.resolve({ data: null, error: { message: `RPC ${fn} is a Supabase-specific database function and is not available on the ${config.dbType} backend.` } }),
    auth: new UniversalAuthFacade(getAuthAdapter(config)),
    channel: () => noopChannel,
    removeChannel: async () => 'ok',
  };
}

/** The universal client. Throws when the CMS is not yet configured. */
export const client: Client = new Proxy({} as Client, {
  get(_target, prop: string) {
    if (!resolvedClient) resolvedClient = buildClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (resolvedClient as any)[prop];
  },
});

/** The universal client, or null when the CMS is not configured. */
export const tryGetClient = (): Client | null => {
  try {
    if (!isConfigured(resolveRuntimeConfig())) return null;
    if (!resolvedClient) resolvedClient = buildClient();
    return resolvedClient;
  } catch {
    return null;
  }
};

/** Resets the cached client so a config change (after the Setup Wizard) takes effect. */
export const resetClient = (): void => {
  resolvedClient = null;
};


export type SchemaSources = {
  coreSql: () => Promise<string>;
  plugins: () => Promise<Array<{ id: string; label?: string; version?: string; sql: string }>>;
};

type Result = Promise<Record<string, unknown>>;

export type SchemaUpdater = {
  /** `stored` is the connection an owner pasted earlier (already opened); the environment's wins over it. */
  status: (stored?: string) => Result;
  run: (stored?: string) => Result;
  /** Applies what is waiting and nothing else. */
  ensure: (stored?: string) => Result;
  /** Reads the status through a pasted connection string without applying anything. */
  probe: (connectionString: string) => Result;
  auto: () => Result;
};

export function ownsSchemaUpdatePath(pathname: string): boolean;
export function presentSchemaResult(result: Record<string, unknown>): Record<string, unknown>;
export function checkPastedConnection(value: unknown): { ok: true; url: string } | { ok: false; error: string };
export function createSchemaUpdater(options: { sources: SchemaSources; config?: { supabaseUrl?: string } | null; withClient?: unknown }): SchemaUpdater;
export function handleSchemaUpdateRequest(options: {
  method: string;
  pathname: string;
  headers?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  config?: { supabaseUrl?: string; supabasePublishableKey?: string };
  env?: Record<string, string | undefined>;
  updater: SchemaUpdater;
  authorize: (token: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: Record<string, unknown> } | null>;

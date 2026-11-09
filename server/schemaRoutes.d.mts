export type SchemaSources = {
  coreSql: () => Promise<string>;
  plugins: () => Promise<Array<{ id: string; label?: string; version?: string; sql: string }>>;
};

export type SchemaUpdater = {
  status: () => Promise<Record<string, unknown>>;
  run: () => Promise<Record<string, unknown>>;
  auto: () => Promise<Record<string, unknown>>;
};

export function ownsSchemaUpdatePath(pathname: string): boolean;
export function presentSchemaResult(result: Record<string, unknown>): Record<string, unknown>;
export function createSchemaUpdater(options: { sources: SchemaSources; config?: { supabaseUrl?: string } | null; withClient?: unknown }): SchemaUpdater;
export function handleSchemaUpdateRequest(options: {
  method: string;
  pathname: string;
  headers?: Record<string, string | undefined>;
  updater: SchemaUpdater;
  authorize: (token: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
}): Promise<{ status: number; body: Record<string, unknown> } | null>;

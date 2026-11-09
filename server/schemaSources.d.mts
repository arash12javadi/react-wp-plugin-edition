import type { SchemaSources } from './schemaRoutes.mjs';

export function diskSources(): SchemaSources;
export function inlineSources(options: { coreSql: () => Promise<string> | string; catalogue: unknown[] | null }): SchemaSources;

/**
 * The Supabase schema as text, inlined into the bundle by `vite.api.config.mjs`
 * (`define: __RWP_SCHEMA_SQL__`). A serverless function's filesystem is read-only and does not
 * contain the repository, so the DDL has to travel inside the function that runs it.
 *
 * `typeof` is load-bearing: on a builder that does not define it — `tsx`, a plain Node host — the
 * identifier is never declared, and reading it directly would be the very `ReferenceError:
 * __dirname is not defined` this replaced. `typeof` never dereferences an undeclared name.
 */
declare const __RWP_SCHEMA_SQL__: string | undefined;

/**
 * `supabase/schema.sql` for a fresh Supabase install and for automatic updates (`server/schemaMigrate.mjs`).
 *
 * A bundled run carries it in the bundle. A persistent host (`npm run start:hono`, `tsx`) reads the
 * file, resolved from this module's own URL: not `__dirname` (absent in ES modules) and not
 * `process.cwd()` (not the project root inside a function, and not guaranteed anywhere). `src/server/`
 * and the built `src/server-dist/` sit at the same depth, so one relative path suits either.
 */
export async function supabaseSchemaSql(): Promise<string> {
  if (typeof __RWP_SCHEMA_SQL__ === 'string') return __RWP_SCHEMA_SQL__;
  const { readFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/schema.sql'),
    resolve(process.cwd(), 'supabase/schema.sql'),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error('supabase/schema.sql could not be read. Run it in the Supabase SQL Editor instead.');
}

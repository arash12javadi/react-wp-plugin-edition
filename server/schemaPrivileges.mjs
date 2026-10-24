/**
 * The privileges a freshly installed database needs, run immediately after the core schema.
 *
 * A Supabase project created from the dashboard hands `anon` and `authenticated` full table
 * privileges in `public`, so the RLS policies in `supabase/schema.sql` are all that stand between a
 * visitor and a row. A project provisioned by this app cannot assume that: the direct Postgres
 * session that applies the schema does not necessarily run with the dashboard's default privileges,
 * and when it does not, `anon` holds *no* grant at all. The first page load then asks PostgREST for
 * `public.options`, PostgreSQL answers `permission denied for table options (42501)` even though the
 * table's own policy says "Allow public read access on options", and the client reads that failure as
 * "this site is not installed" and shows the Setup Wizard instead of the homepage.
 *
 * The same statements are the last section of `supabase/schema.sql`, which is what a site installed
 * by pasting the file into the Supabase SQL editor runs. This copy exists because the schema text is
 * not always ours: `POST provision` in plugins/rwp-saas-installer applies the *template release's*
 * `supabase/schema.sql` (or `RWP_SAAS_SCHEMA_URL`), so a site built from a tag that predates that
 * section would still install without privileges. Keep the two in sync; the block is written to be
 * idempotent and safe to run over a live database.
 *
 * The grants are blanket on purpose — every table the app and its plugins will ever add inherits
 * them, which is what stops the next table from reintroducing the same 42501 — and the sensitive
 * tables are then withheld again, after them, exactly as they are withheld in the schema sections
 * that create them. RLS still filters every row; the missing grant is the second lock.
 */
export const SCHEMA_PRIVILEGES_SQL = `grant usage on schema public to anon, authenticated;

-- Visitors read, signed-in users write, and RLS policies decide which rows either one sees.
grant select on all tables in schema public to anon;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;

-- Tables created after this point inherit the same privileges: a plugin schema applied from the
-- Plugins screen, and anything a later migration adds.
alter default privileges in schema public grant select on tables to anon;
alter default privileges in schema public grant all on tables to authenticated;
alter default privileges in schema public grant all on sequences to authenticated;

-- Withheld again, and last. Each of these is revoked in the section that creates it; repeating the
-- revokes here is what keeps the blanket grants above from re-opening them.
revoke all on table public.rwp_security_secrets from anon, authenticated;
revoke all on table public.rwp_view_salts from anon, authenticated;
revoke all on table public.page_views from anon, authenticated;
revoke all on table public.profile_details from anon;
revoke all on table public.rwp_user_capabilities from anon;
revoke all on table public.likes from anon;
revoke all on table public.follows from anon;
revoke all on table public.taxonomy_follows from anon;
revoke all on table public.bookmarks from anon;
revoke insert, update, delete on table public.theme_settings from anon;
revoke insert, update, delete on table public.rwp_translations from anon;`;

/**
 * Runs {@link SCHEMA_PRIVILEGES_SQL} on an open connection.
 *
 * Deliberately not wrapped in a transaction and not caught: the caller has just applied the schema
 * on the same connection, the statements are idempotent, and a GRANT that fails means the site will
 * fail on its first request — reporting that here, naming the table it could not grant on, is better
 * than a deployment that answers `42501` to every visitor afterwards. `client` is anything with a
 * `query` method: `pg`'s `Client` from `server/db.mjs`'s `withClient`, or the one the Setup Wizard
 * opens in `src/server/index.ts`.
 */
export async function applySchemaPrivileges(client) {
  await client.query(SCHEMA_PRIVILEGES_SQL);
}

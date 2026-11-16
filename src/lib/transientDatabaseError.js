/**
 * PostgREST answers 503 `PGRST002` while it rebuilds its schema cache, which a schema change or a
 * Supabase restart triggers. It clears by itself, so callers wait it out instead of reporting it.
 * A missing table (`PGRST205`) also mentions the schema cache but is a different failure, and is not
 * matched. A cancelled statement (`57014`, "canceling statement due to statement timeout") is the same
 * kind of failure: Supabase cuts a query short while the database is busy (a fresh schema install, an
 * overloaded small compute), and the next attempt usually succeeds. Plain JavaScript so `tests/` can
 * import it without a TypeScript step.
 */
const TRANSIENT_FAILURE = /PGRST002|Could not query the database for the schema cache|\b503\b|Service Unavailable|\b57014\b|statement timeout/i;

/** True when the database API is only busy rebuilding its schema cache and will answer again shortly. */
export const isTransientDatabaseError = (message) => TRANSIENT_FAILURE.test(String(message ?? ''));

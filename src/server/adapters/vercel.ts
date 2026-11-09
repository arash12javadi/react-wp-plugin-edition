/**
 * Vercel serverless entry point.
 *
 * Deploy this as a single Node function; it adapts the Hono app to Vercel's request/response.
 */
import { handle } from '@hono/node-server/vercel';
import { app } from '../index';
import { runStartupMigrations } from '../config';
import { runSchemaUpdateOnStart } from '../schemaUpdate';

// Migrate on cold start (fire-and-forget). Memoised, idempotent and failure-safe.
void runStartupMigrations();
// Bring a Supabase site's own database up to date after a release (guarded, locked, never throws). A function
// may be frozen once it has answered, so Dashboard → Updates → Database is the path that always completes it.
void runSchemaUpdateOnStart();

export default handle(app);

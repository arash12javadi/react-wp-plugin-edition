// Read-only: who may see the platform owner's cards.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const profiles = await client.query('select email, role from public.profiles order by email');
console.log('profiles:', profiles.rows);
await client.end();

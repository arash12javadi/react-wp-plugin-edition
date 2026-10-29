// Read-only inspection: which plugins are active, and which integration rows exist.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const connectionString = env.SUPABASE_DB_URL || env.DATABASE_URL;
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const options = await client.query(
  "select option_name, length(option_value::text) as size, option_value::text as value from options where option_name in ('rwp_active_plugins')",
);
console.log('options:', JSON.stringify(options.rows, null, 2));

const settings = await client.query('select setting_key from system_settings order by setting_key');
console.log('system_settings keys:', settings.rows.map((row) => row.setting_key).join(', '));

// Masked: which fields are set, never the credential itself.
const github = await client.query("select setting_value from system_settings where setting_key = 'github_config'");
for (const row of github.rows) {
  const raw = row.setting_value;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const summary = {};
  for (const [key, field] of Object.entries(value || {})) {
    summary[key] = typeof field === 'string'
      ? (field ? `<${field.length} chars>` : '')
      : Array.isArray(field) ? `<${field.length} items>` : field;
  }
  console.log('github_config fields:', JSON.stringify(summary));
}

await client.end();

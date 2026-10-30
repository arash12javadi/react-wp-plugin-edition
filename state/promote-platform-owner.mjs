/**
 * Makes an account the platform owner (`public.profiles.role = 'super_admin'`), or puts it back.
 *
 * The platform owner is a role list, not one role. The hub shows GitHub, Deployments and RWP SaaS
 * Installer only to `platformOwnerOnly` cards, and `system_settings` refuses those rows to every other
 * role — and both answers accept `administrator`, the role the Setup Wizard gives a site's first
 * account, as well as `super_admin`. So this script is not the only way to reach those cards any more;
 * it is how an account is made a `super_admin` *on purpose* — before its `administrator` role is taken
 * away, or on an installation whose owner holds some other role.
 *
 * No screen can hand out `super_admin` either: `profiles_guard_role` (`supabase/schema.sql`) raises
 * `You cannot change your own role.` for any `profiles` write made by the account whose role is being
 * changed, so the first super admin cannot grant the role to themselves from Settings → Users. It lets
 * `auth.uid()` through as null for the installer, a service-role client and a direct connection, which
 * is the door this script uses.
 *
 * Usage: node state/promote-platform-owner.mjs <email> [role]
 *   role defaults to super_admin; pass `administrator` to undo it.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const [email, wanted = 'super_admin'] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node state/promote-platform-owner.mjs <email> [super_admin|administrator]');
  process.exit(1);
}
if (!['super_admin', 'administrator'].includes(wanted)) {
  console.error(`"${wanted}" is not a role this script hands out. Use super_admin or administrator.`);
  process.exit(1);
}

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const before = await client.query('select id, email, role from public.profiles where email = $1', [email]);
if (before.rowCount === 0) {
  console.error(`No profile for ${email}. Sign in once so the trigger creates it, then run this again.`);
  await client.end();
  process.exit(1);
}
console.log('before:', before.rows[0]);

const updated = await client.query(
  'update public.profiles set role = $2, updated_at = timezone(\'utc\'::text, now()) where email = $1 returning id, email, role',
  [email, wanted],
);
console.log('after:', updated.rows[0]);

await client.end();

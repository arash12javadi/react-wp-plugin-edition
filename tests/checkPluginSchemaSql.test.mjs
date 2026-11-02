/**
 * The `check:schema` guard has to fail on the bug it exists for, not just pass on the fixed file.
 *
 * The defect: `gen_random_bytes()` is pgcrypto, which Supabase installs in `extensions`, and a function
 * declared `security definer set search_path = public` cannot resolve an unqualified call to it. The
 * first grant that needed an opaque token therefore raised SQLSTATE 42883 *after* every check had
 * passed, PostgREST answered 404, and the route reported "the database function ... is missing".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPlugins, readFunctions, schemaProblems, unqualifiedCalls } from '../scripts/checkPluginSchemaSql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketplaceSchema = path.join(root, 'plugins/rwp-plugin-marketplace/schema.sql');

/** A minimal schema of the shape that broke, so the check can be handed bad input on purpose. */
const BROKEN = `
create or replace function public.rwp_marketplace_mint_license(p_plugin_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_key text;
begin
  v_key := 'RWPM-' || upper(encode(gen_random_bytes(12), 'hex'));
  return jsonb_build_object('license_key', v_key);
end;
$$;
`;

test('the guard reports the pgcrypto call that broke the grant route', () => {
  const problems = schemaProblems(BROKEN, 'fixture/schema.sql');
  // Two sentences, because the fixture has two faults: the body calls an extension routine, and the
  // token it mints is no longer a `gen_random_uuid()` one.
  assert.equal(problems.length, 2, problems.join('\n'));
  const body = problems.find((problem) => problem.includes('calls gen_random_bytes()'));
  assert.ok(body, problems.join('\n'));
  assert.match(body, /rwp_marketplace_mint_license\(\) calls gen_random_bytes\(\)/);
  assert.match(body, /set search_path = public/);
  assert.match(body, /42883/);
});

test('a qualified call is accepted, because it names the schema it wants', () => {
  const qualified = BROKEN
    .replace('gen_random_bytes(12)', 'extensions.gen_random_bytes(12)')
    .replace("v_key := 'RWPM-' || upper(encode(extensions.gen_random_bytes(12), 'hex'));", "v_key := 'RWPM-' || upper(replace(gen_random_uuid()::text, '-', ''));");
  assert.deepEqual(schemaProblems(qualified, 'fixture/schema.sql'), []);

  const keep = `select extensions.gen_random_bytes(12) as bytes, gen_random_uuid() as id`;
  assert.deepEqual(unqualifiedCalls(keep), []);
});

test('a comment that names the routine is documentation, not a call', () => {
  const commented = `
create or replace function public.sample() returns int language sql stable set search_path = public as $$
  -- never call gen_random_bytes() here: it lives in extensions
  select 1;
$$;
`;
  assert.deepEqual(schemaProblems(commented, 'fixture/schema.sql'), []);
});

test('a token minted from something other than a UUID is reported', () => {
  const problems = schemaProblems(`
create or replace function public.sample() returns text language sql volatile as $$
  select 'x';
$$;
`, 'fixture/schema.sql');
  assert.deepEqual(problems, [], 'no token in this file to check');

  const badToken = `v_key := 'RWPM-' || upper(encode(extensions.gen_random_bytes(12), 'hex'));`;
  assert.equal(schemaProblems(badToken, 'fixture/schema.sql').length, 1);
});

test('the real marketplace schema is clean, and its grant function is one of the bodies read', async () => {
  const sql = await readFile(marketplaceSchema, 'utf8');
  assert.deepEqual(schemaProblems(sql, 'plugins/rwp-plugin-marketplace/schema.sql'), []);

  const names = readFunctions(sql).map((fn) => fn.name);
  assert.ok(names.includes('rwp_marketplace_owner_grant_license'), 'the grant function is parsed');
  assert.ok(names.includes('rwp_marketplace_mint_license'), 'the checkout mint is parsed');

  const { scanned, problems } = await checkPlugins(path.join(root, 'plugins'));
  assert.deepEqual(problems, []);
  assert.ok(scanned >= 1);
});

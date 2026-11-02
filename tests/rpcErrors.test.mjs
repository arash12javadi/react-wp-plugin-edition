/**
 * `rpc()` is where a database fault becomes a sentence an operator reads, so its mapping is tested case
 * by case: PostgREST answers 404 for both "no such function" and "that function raised an error about
 * something it could not find", and telling those apart is the difference between "reinstall the
 * schema" and "the schema's own body is wrong".
 *
 * `fetch` is replaced per test, so nothing here reaches a network.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { rpc, select } from '../plugins/rwp-plugin-marketplace/server/supabase.mjs';

const ctx = {
  supabase: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test', secretKey: 'sb_secret_test' },
  bearerToken: 'user-jwt',
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answers the next `fetch` with a PostgREST-shaped response. */
const answering = (status, payload) => {
  globalThis.fetch = async () => new Response(payload === undefined ? '' : JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

/** The error a call settled with, or a failure if it resolved instead. */
const rejection = async (call) => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
};

test('PGRST202 with a candidate signature means the database is behind the code', async () => {
  answering(404, {
    code: 'PGRST202',
    message: 'Could not find the function public.rwp_marketplace_owner_grant_license(p_plugin_id) in the schema cache',
    hint: 'Perhaps you meant to call the function public.rwp_marketplace_owner_grant_license(p_plugin_id, p_user_id)',
  });
  const error = await rejection(() => rpc(ctx, 'rwp_marketplace_owner_grant_license', {}));
  assert.equal(error.status, 500);
  assert.match(error.message, /not with the arguments this build sends/);
});

test('PGRST202 with no hint means the function was never installed there', async () => {
  answering(404, {
    code: 'PGRST202',
    message: 'Could not find the function public.rwp_marketplace_owner_grant_license in the schema cache',
    hint: null,
  });
  const error = await rejection(() => rpc(ctx, 'rwp_marketplace_owner_grant_license', {}));
  assert.equal(error.status, 500);
  assert.match(error.message, /is missing from https:\/\/example\.supabase\.co/);
});

test('a 404 that carries a SQLSTATE is a failure inside the function, and says so', async () => {
  // The real one: pgcrypto lives in `extensions`, and a `search_path = public` body cannot resolve it.
  answering(404, {
    code: '42883',
    message: 'function gen_random_bytes(integer) does not exist',
    hint: null,
  });
  const error = await rejection(() => rpc(ctx, 'rwp_marketplace_owner_grant_license', {}));
  assert.equal(error.status, 500);
  assert.match(error.message, /failed inside/);
  assert.match(error.message, /gen_random_bytes\(integer\) does not exist/);
  assert.match(error.message, /SQLSTATE 42883/);
  // The misdiagnosis that cost the investigation: it must not claim the function is missing.
  assert.doesNotMatch(error.message, /is missing from/);
});

test('a refusal the function raised on purpose is a 400 with its own sentence', async () => {
  answering(500, { code: 'P0002', message: 'No account uses that email address.', details: null, hint: null });
  const error = await rejection(() => rpc(ctx, 'rwp_marketplace_owner_grant_license', {}));
  assert.equal(error.status, 400);
  assert.match(error.message, /No account uses that email address/);
});

test('an unpermitted call keeps its 401/403', async () => {
  answering(403, { code: '42501', message: 'Your role cannot grant marketplace licenses.', hint: null });
  const forbidden = await rejection(() => rpc(ctx, 'rwp_marketplace_owner_grant_license', {}, 'user'));
  assert.equal(forbidden.status, 403);

  answering(401, { code: 'PGRST301', message: 'JWT expired', hint: null });
  const unauthorised = await rejection(() => rpc(ctx, 'rwp_marketplace_owner_grant_license', {}, 'user'));
  assert.equal(unauthorised.status, 401);
});

test('a service-key rejection names the key rather than blaming the function', async () => {
  answering(401, { message: 'Invalid API key', hint: null });
  const error = await rejection(() => rpc(ctx, 'rwp_marketplace_mint_license', {}, 'service'));
  assert.equal(error.status, 500);
  assert.match(error.message, /SUPABASE_SECRET_KEY/);
});

test('an unknown 5xx is a 502 with the SQLSTATE, not a silent 400', async () => {
  answering(500, { code: 'XX000', message: 'internal error', hint: null });
  const error = await rejection(() => rpc(ctx, 'rwp_marketplace_mint_license', {}));
  assert.equal(error.status, 502);
  assert.match(error.message, /SQLSTATE XX000/);
});

test('a successful call returns the payload untouched', async () => {
  answering(200, { id: 'abc', license_key: 'RWPM-AB' });
  const result = await rpc(ctx, 'rwp_marketplace_owner_grant_license', {}, 'user');
  assert.deepEqual(result, { id: 'abc', license_key: 'RWPM-AB' });
});

test('a failed read says which table and what Supabase answered', async () => {
  answering(401, { message: 'Invalid API key', hint: null });
  const error = await rejection(() => select(ctx, 'rwp_plugins?id=eq.1&select=id', 'service'));
  assert.equal(error.status, 500);
  assert.match(error.message, /Supabase read of rwp_plugins failed \(HTTP 401\): Invalid API key/);
});

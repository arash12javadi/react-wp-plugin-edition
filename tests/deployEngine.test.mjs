/**
 * The deploy engine's two guarantees, tested without a network and without a Vercel account.
 *
 * What is asserted here is exactly what the customer-facing features depend on:
 *
 *   1. `server/deploy/secretBox.mjs` — a stored Vercel token is ciphertext, survives a key rotation, and
 *      refuses to open when it has been tampered with. A bug here is a token in a database dump, or a
 *      deployment that 401s for no visible reason.
 *   2. `server/deploy/vercelApi.mjs` — a payload is uploaded by digest, a deployment is only "done" when
 *      Vercel says `READY`, and a failed build is reported as a build failure rather than as success. A bug
 *      here is a plugin marked installed that is not running.
 *
 * `fetch` is replaced per test with a stub that records requests, so every Vercel route and every body this
 * engine sends is checked, including the ones a real token would be needed to reach.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeployError, asDeployError, errorStatus } from '../server/deploy/errors.mjs';
import { fetchJson, redactSecrets } from '../server/deploy/http.mjs';
import {
  SECRET_BOX_KEY_ENV, SECRET_BOX_PREVIOUS_ENV, generateSecretBoxKey, openSecret, sealSecret,
  secretBoxEnabled, secretBoxKey, secretFingerprint,
} from '../server/deploy/secretBox.mjs';
import {
  createFileDeployment, digestOf, forEachLimit, readBuildEnv, teamQuery, upsertProjectEnv, waitForDeployment,
} from '../server/deploy/vercelApi.mjs';

/** A 32-byte key written the way an operator pastes it: base64. */
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const envWith = (values = {}) => ({ [SECRET_BOX_KEY_ENV]: KEY_B64, ...values });

/** Runs `task` with `fetch` replaced, and restores the previous implementation afterwards. */
async function withFetch(handler, task) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return await handler(String(url), options);
  };
  try {
    return { result: await task(calls), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** A `Response`-shaped object; the engine only reads `ok`, `status`, `text()`. */
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
});

test('a sealed Vercel token opens again, and only with this installation key', () => {
  const token = 'vercel_token_value_1234567890';
  const envelope = sealSecret(token, { env: envWith() });

  assert.match(envelope, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(envelope.includes(token), false, 'the plaintext never appears in the envelope');
  assert.equal(openSecret(envelope, { env: envWith() }), token);
});

test('two seals of the same token differ, so rows cannot be compared', () => {
  const first = sealSecret('same-token', { env: envWith() });
  const second = sealSecret('same-token', { env: envWith() });
  assert.notEqual(first, second);
  assert.equal(openSecret(first, { env: envWith() }), openSecret(second, { env: envWith() }));
});

test('a tampered payload is refused instead of being deployed', () => {
  const envelope = sealSecret('vercel_token_value_1234567890', { env: envWith() });
  const parts = envelope.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join('.');

  assert.throws(() => openSecret(tampered, { env: envWith() }), /could not be decrypted/);
  assert.throws(() => openSecret('v1.not.a.real.envelope', { env: envWith() }), /not in a format/);
  // Right shape, wrong number of bytes: the damaged case, which must not be confused with a wrong key.
  assert.throws(() => openSecret('v1.AAAA.AAAA.AAAA', { env: envWith() }), /damaged/);
  assert.throws(() => openSecret('not-an-envelope', { env: envWith() }), /not in a format/);
  assert.throws(() => openSecret(envelope, { env: {} }), new RegExp(SECRET_BOX_KEY_ENV));
});

test('rotation opens old envelopes while sealing new ones under the current key', () => {
  const sealedWithOld = sealSecret('rotation-token', { env: { [SECRET_BOX_KEY_ENV]: OTHER_KEY_B64 } });
  // The new key alone cannot read it: that is the failure an operator sees before keeping the old key.
  assert.throws(() => openSecret(sealedWithOld, { env: envWith() }), /could not be decrypted/);
  // With the old key kept in RWP_SECRET_BOX_KEY_PREVIOUS, nothing is lost and no token has to be re-entered.
  const rotating = envWith({ [SECRET_BOX_PREVIOUS_ENV]: OTHER_KEY_B64 });
  assert.equal(openSecret(sealedWithOld, { env: rotating }), 'rotation-token');
});

test('the key may be base64 or hex, and a wrong length is named rather than ignored', () => {
  const hex = Buffer.alloc(32, 3).toString('hex');
  assert.equal(secretBoxKey({ [SECRET_BOX_KEY_ENV]: hex }).length, 32);
  assert.equal(secretBoxEnabled({ [SECRET_BOX_KEY_ENV]: KEY_B64 }), true);
  assert.equal(secretBoxEnabled({}), false);
  assert.throws(() => secretBoxKey({ [SECRET_BOX_KEY_ENV]: 'too-short' }), /must be 32 bytes/);
  assert.match(generateSecretBoxKey(), /^[A-Za-z0-9+/]{43}=$/);
});

test('a fingerprint identifies a token without holding it', () => {
  const fingerprint = secretFingerprint('vercel_token_value_1234567890');
  assert.match(fingerprint, /^sha256:[0-9a-f]{12}$/);
  assert.equal(fingerprint.includes('vercel_token'), false);
  assert.equal(secretFingerprint(''), '');
  assert.equal(secretFingerprint('a-token'), secretFingerprint('a-token'));
});


test('the team query is a team id, a slug, or nothing at all', () => {
  assert.equal(teamQuery(''), '');
  assert.equal(teamQuery('  '), '');
  assert.equal(teamQuery('team_abc123'), '?teamId=team_abc123');
  assert.equal(teamQuery('my-team'), '?slug=my-team');
  assert.throws(() => teamQuery('bad team/../'), DeployError);
});

test('a file is named by the SHA-1 of its bytes', () => {
  // The digest Vercel stores `hello` under; anything else and the deployment names a file nobody uploaded.
  assert.equal(digestOf(Buffer.from('hello')), 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
});

test('the upload pool runs every item and never more than its limit at once', async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  await forEachLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => { setTimeout(resolve, 2); });
    seen.push(item);
    active -= 1;
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the limit`);
  assert.equal(await forEachLimit([], 4, async () => { throw new Error('never called'); }), undefined);
});

test('a deployment uploads one copy of a repeated file and names every path', async () => {
  const files = new Map([
    ['dist/index.html', Buffer.from('<html></html>')],
    ['dist/assets/app.js', Buffer.from('console.log(1)')],
    // The same bytes under a second name: Vercel is charged, and called, once.
    ['vercel.json', Buffer.from('console.log(1)')],
  ]);
  const { result, calls } = await withFetch(
    (url) => (url.endsWith('/v2/files')
      ? jsonResponse(undefined, 200)
      : jsonResponse({ id: 'dpl_1', url: 'site-abc123.vercel.app', readyState: 'QUEUED' }, 200)),
    () => createFileDeployment('token', { projectName: 'site', files, meta: { rwpPayload: 'prebuilt' } }),
  );

  const uploads = calls.filter((call) => call.url.endsWith('/v2/files'));
  const deployment = calls.find((call) => call.url.includes('/v13/deployments'));
  assert.equal(uploads.length, 2, 'the shared bytes are uploaded once');
  assert.equal(uploads[0].options.headers['x-vercel-digest'], digestOf(Buffer.from('<html></html>')));
  assert.equal(deployment.options.headers.Authorization, 'Bearer token');

  const body = JSON.parse(deployment.options.body);
  assert.equal(body.target, 'production');
  assert.equal(body.project, 'site', 'without a project id the name is used');
  assert.equal(body.files.length, 3);
  assert.deepEqual(body.meta, { rwpPayload: 'prebuilt' });

  assert.deepEqual(result, {
    id: 'dpl_1',
    readyState: 'QUEUED',
    url: 'https://site.vercel.app',
    deploymentUrl: 'https://site-abc123.vercel.app',
    uploaded: 2,
    files: 3,
  });
});

test('an empty payload is refused before Vercel is called', async () => {
  const { calls } = await withFetch(
    () => jsonResponse({}, 200),
    async () => {
      await assert.rejects(createFileDeployment('token', { projectName: 'site', files: new Map() }), /no files to deploy/);
    },
  );
  assert.equal(calls.length, 0);
});

test('a deployment is only ready when Vercel says READY', async () => {
  const states = ['QUEUED', 'INITIALIZING', 'BUILDING', 'READY'];
  let index = 0;
  const polls = [];
  const { result } = await withFetch(
    () => jsonResponse({ id: 'dpl_2', readyState: states[Math.min(index++, states.length - 1)], url: 'site-abc.vercel.app' }, 200),
    () => waitForDeployment('token', { deploymentId: 'dpl_2', intervalMs: 1, onPoll: (state) => polls.push(state) }),
  );
  assert.equal(result.readyState, 'READY');
  assert.equal(result.deploymentUrl, 'https://site-abc.vercel.app');
  assert.deepEqual(polls, states);
  assert.equal(result.attempts, 4);
});

test('a failed build is reported as a failure, never as an install', async () => {
  await withFetch(
    () => jsonResponse({ id: 'dpl_3', readyState: 'ERROR', errorCode: 'BUILD_FAILED', errorMessage: 'Command "vite build" exited with 1' }, 200),
    async () => {
      const error = await waitForDeployment('token', { deploymentId: 'dpl_3', intervalMs: 1 }).catch((thrown) => thrown);
      assert.ok(error instanceof DeployError);
      assert.equal(error.status, 502);
      assert.equal(error.code, 'deployment_failed');
      assert.match(error.message, /BUILD_FAILED/);
      assert.match(error.message, /vite build/);
      assert.match(error.message, /previous deployment/);
      assert.equal(error.details.errorCode, 'BUILD_FAILED');
    },
  );
});

test('a deployment that never settles times out instead of hanging a request', async () => {
  await withFetch(
    () => jsonResponse({ id: 'dpl_4', readyState: 'BUILDING' }, 200),
    async () => {
      const error = await waitForDeployment('token', { deploymentId: 'dpl_4', intervalMs: 1, timeoutMs: 0 }).catch((thrown) => thrown);
      assert.equal(error.status, 504);
      assert.equal(error.code, 'deployment_timeout');
    },
  );
});

test('a build environment carries production values only', async () => {
  const { result } = await withFetch(
    () => jsonResponse({
      envs: [
        { key: 'VITE_SUPABASE_URL', value: 'https://ref.supabase.co', target: ['production', 'preview'] },
        { key: 'PREVIEW_ONLY', value: 'nope', target: ['preview'] },
        { key: 'RWP_EDITION', value: 'customer', target: ['production'] },
        { key: 'EMPTY', value: '', target: ['production'] },
        // No `target` at all is Vercel's "every environment".
        { key: 'SHARED', value: 'yes' },
      ],
    }, 200),
    () => readBuildEnv('token', { projectId: 'prj_1' }),
  );
  assert.deepEqual(result, {
    VITE_SUPABASE_URL: 'https://ref.supabase.co',
    RWP_EDITION: 'customer',
    SHARED: 'yes',
  });
});

test('an unreadable environment is fatal for a build, with the reason attached', async () => {
  await withFetch(
    () => jsonResponse({ error: { message: 'Not authorized' } }, 403),
    async () => {
      const error = await readBuildEnv('token', { projectId: 'prj_1' }).catch((thrown) => thrown);
      assert.equal(error.code, 'env_unreadable');
      assert.match(error.message, /Not authorized/);
    },
  );
});

test('project variables are patched when they exist and created when they do not', async () => {
  const { calls } = await withFetch(
    (url, options) => {
      if (!options.method || options.method === 'GET') {
        return jsonResponse({ envs: [{ id: 'env_1', key: 'RWP_APP_VERSION', value: '1.3.0', target: ['production'] }] }, 200);
      }
      return jsonResponse({}, 200);
    },
    () => upsertProjectEnv('token', { projectId: 'prj_1', values: { RWP_APP_VERSION: '1.3.1', RWP_UPDATE_TOKEN: 'central' } }),
  );
  const patch = calls.find((call) => call.options.method === 'PATCH');
  const post = calls.find((call) => call.options.method === 'POST');
  assert.match(patch.url, /\/v9\/projects\/prj_1\/env\/env_1$/);
  assert.deepEqual(JSON.parse(patch.options.body), { value: '1.3.1' });
  assert.match(post.url, /\/v10\/projects\/prj_1\/env$/);
  assert.deepEqual(JSON.parse(post.options.body), { key: 'RWP_UPDATE_TOKEN', value: 'central', type: 'encrypted', target: ['production'] });
});

test('an upstream failure keeps its status and its own sentence', async () => {
  const { result } = await withFetch(
    () => jsonResponse({ error: { message: 'Project not found' } }, 404),
    async () => {
      const error = await fetchJson('https://api.vercel.com/v9/projects/nope').catch((thrown) => thrown);
      assert.ok(error instanceof DeployError);
      assert.equal(error.status, 404);
      assert.equal(error.message, 'Project not found');
      return error;
    },
  );
  assert.equal(errorStatus(result), 404);
  assert.equal(errorStatus({ status: 999 }, 500), 500);
  assert.equal(asDeployError(new Error('boom')).status, 502);
  assert.equal(asDeployError(result), result, 'a DeployError is passed through unchanged');
});

test('a secret never survives into a message that leaves the server', () => {
  const token = 'vercel_token_value_1234567890';
  const scrubbed = redactSecrets([token, '', 'ab'], `Vercel refused ${token} for project site.`);
  assert.equal(scrubbed.includes(token), false);
  assert.match(scrubbed, /\*\*\*/);
  // A two-character "secret" is not a credential, and redacting it would shred the sentence.
  assert.equal(redactSecrets(['ab'], 'about ab'), 'about ab');
});

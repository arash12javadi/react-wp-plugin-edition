/**
 * The install-job engine, tested without a database, a Vercel account or a network.
 *
 * What is asserted here is what the customer-visible promises rest on:
 *
 *   1. A job is created once per request, claimed exactly once, and survives a build environment that
 *      disappears (`server/deploy/jobs.mjs`).
 *   2. A build worker authenticates with a token that is stored hashed, from a pairing code that works once
 *      (`server/deploy/workerAuth.mjs`).
 *   3. A payload crosses from the builder to the deployer in verified chunks, and a payload that does not match
 *      its digest is refused rather than deployed (`server/deploy/artifacts.mjs`).
 *   4. A deployment is only `installed` when Vercel says `READY`; a build failure leaves the previous
 *      deployment serving and the plugin inactive (`server/deploy/pipeline.mjs`).
 *   5. A plugin's schema runs only against an approval of *those* statements, and only after a backup
 *      (`server/deploy/migrations.mjs`).
 *   6. The Vercel token is never stored or returned in the clear (`server/deploy/credentials.mjs`).
 *
 * The store below implements the same port the PostgREST store does, including the compare-and-set, so a
 * transition that is only correct because "nothing else happened at the same time" fails here.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  JOB_STATUS, SERVER_WORKER, attachArtifact, claimJob, cleanupJobs, createJob, jobRecord, listJobs, markFailed, publicJob,
  requeueExpiredLeases, setJobStep,
} from '../server/deploy/jobs.mjs';
import {
  authenticateWorker, looksLikeWorkerToken, newPairingCode, redeemPairing, revokeWorker,
} from '../server/deploy/workerAuth.mjs';
import {
  filesToZip, payloadZipToFiles, putArtifactChunk, readArtifact, sha256Of,
} from '../server/deploy/artifacts.mjs';
import { advanceJob } from '../server/deploy/pipeline.mjs';
import { applyMigrations, plannedMigrations, splitStatements, summariseMigrations } from '../server/deploy/migrations.mjs';
import {
  credentialStatus, loadCredential, revokeCredential, saveCredential,
} from '../server/deploy/credentials.mjs';
import { clientBuildEnv, readRepoFiles } from '../server/deploy/repoBuild.mjs';
import { postgrestStore } from '../plugins/rwp-saas-installer/jobStore.mjs';
import { SECRET_BOX_KEY_ENV } from '../server/deploy/secretBox.mjs';
import { DeployError } from '../server/deploy/errors.mjs';

// rwp_installer_jobs.worker_id is a uuid foreign key to rwp_installer_workers, so a worker id in a test must be one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_A = '11111111-1111-4111-8111-111111111111';
const WORKER_B = '22222222-2222-4222-8222-222222222222';

const KEY_B64 = Buffer.alloc(32, 3).toString('base64');
const secretEnv = { [SECRET_BOX_KEY_ENV]: KEY_B64 };
const PLUGIN = 'rwp-shop';
const PROJECT = 'ana-site';

/** An in-memory implementation of every port the engine defines. */
function memoryStore() {
  const state = {
    jobs: new Map(), byKey: new Map(), pairings: new Map(), workers: new Map(), blobs: new Map(),
    credentials: new Map(), seq: 0,
  };
  const LOCKED = ['building', 'built', 'deploying'];
  const nextId = (prefix) => {
    state.seq += 1;
    return `${prefix}-${state.seq}`;
  };
  /** The partial unique index `rwp_installer_jobs_project_lock_idx`, as an insert/update would meet it. */
  const clash = (candidate) => [...state.jobs.values()].find(
    (row) => row.id !== candidate.id && row.project_name === candidate.project_name && LOCKED.includes(row.status),
  );
  return {
    state,
    // ---- jobs -------------------------------------------------------------------------------------
    async insertJob(row) {
      if (state.byKey.has(row.idempotency_key)) throw new Error('duplicate key value violates unique constraint');
      const record = { ...row, id: nextId('job') };
      if (LOCKED.includes(record.status) && clash(record)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "rwp_installer_jobs_project_lock_idx"'), { code: 'project_busy', status: 409 });
      }
      state.jobs.set(record.id, record);
      state.byKey.set(record.idempotency_key, record.id);
      return record;
    },
    async findJob(id) {
      return state.jobs.get(id) || null;
    },
    async findJobByIdempotencyKey(key) {
      const id = state.byKey.get(key);
      return id ? state.jobs.get(id) : null;
    },
    async findActiveProjectJob(projectName, { excludeJobId = '' } = {}) {
      return [...state.jobs.values()].find(
        (row) => row.project_name === projectName && LOCKED.includes(row.status) && row.id !== excludeJobId,
      ) || null;
    },
    async updateJob({ id, patch, expect = null, expectWorker = null, expectUnowned = false }) {
      const job = state.jobs.get(id);
      if (!job) return null;
      // Postgres types: worker_id is a uuid, so anything else is SQLSTATE 22P02 (HTTP 400), not "no match".
      for (const candidate of [patch.worker_id, expectWorker]) {
        if (candidate !== null && candidate !== undefined && !UUID.test(candidate)) {
          throw Object.assign(new Error(`invalid input syntax for type uuid: "${candidate}"`), { code: '22P02', status: 400 });
        }
      }
      if (expectUnowned && job.worker_id) return null;
      if (Array.isArray(expect) && !expect.includes(job.status)) return null;
      if (expectWorker !== null && job.worker_id !== expectWorker) return null;
      const next = { ...job, ...patch };
      if (LOCKED.includes(next.status) && clash(next)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "rwp_installer_jobs_project_lock_idx"'), { code: 'project_busy', status: 409 });
      }
      state.jobs.set(id, next);
      return next;
    },
    async listJobs({ statuses = null, limit = 20, order = 'newest' } = {}) {
      let rows = [...state.jobs.values()];
      if (Array.isArray(statuses) && statuses.length) rows = rows.filter((job) => statuses.includes(job.status));
      // `localeCompare(b, a)` is already newest-first, so `oldest` is the same comparator negated.
      const direction = order === 'oldest' ? -1 : 1;
      rows.sort((a, b) => direction * String(b.created_at).localeCompare(String(a.created_at)));
      return rows.slice(0, limit);
    },
    async deleteJob(id) {
      return state.jobs.delete(id);
    },
    // ---- pairings and workers ---------------------------------------------------------------------
    async insertPairing(row) {
      const record = { ...row, id: nextId('pair') };
      state.pairings.set(row.hash, record);
      return record;
    },
    async consumePairing(hash, atIso) {
      const row = state.pairings.get(hash);
      if (!row) return null;
      state.pairings.delete(hash);
      return new Date(row.expires_at).getTime() > new Date(atIso).getTime() ? row : null;
    },
    async insertWorker(row) {
      const record = { ...row, id: nextId('worker') };
      state.workers.set(record.id, record);
      return record;
    },
    async findWorkerByHash(hash) {
      return [...state.workers.values()].find((worker) => worker.token_hash === hash) || null;
    },
    async touchWorker(id, atIso) {
      const worker = state.workers.get(id);
      if (worker) state.workers.set(id, { ...worker, last_seen_at: atIso });
    },
    async listWorkers() {
      return [...state.workers.values()];
    },
    async revokeWorker(id, atIso) {
      const worker = state.workers.get(id);
      if (!worker) return null;
      const next = { ...worker, revoked_at: atIso };
      state.workers.set(id, next);
      return next;
    },
    // ---- artifacts --------------------------------------------------------------------------------
    async putBlobChunk({ job_id: jobId, kind, chunk, total, sha256, size, data }) {
      state.blobs.set(`${jobId}|${kind}|${chunk}`, { job_id: jobId, kind, chunk, total, sha256, size, data });
    },
    async blobManifest(jobId, kind) {
      const rows = [...state.blobs.values()].filter((row) => row.job_id === jobId && row.kind === kind);
      if (!rows.length) return null;
      const first = rows[0];
      return {
        sha256: first.sha256,
        size: first.size,
        total: first.total,
        received: new Set(rows.map((row) => row.chunk)).size,
      };
    },
    async readBlobChunks(jobId, kind) {
      return [...state.blobs.values()].filter((row) => row.job_id === jobId && row.kind === kind);
    },
    async deleteArtifact(jobId) {
      for (const key of [...state.blobs.keys()]) if (key.startsWith(`${jobId}|`)) state.blobs.delete(key);
    },
    // ---- credentials ------------------------------------------------------------------------------
    async findCredential(projectName) {
      return state.credentials.get(projectName) || null;
    },
    async listCredentials() {
      return [...state.credentials.values()];
    },
    async upsertCredential(row) {
      state.credentials.set(row.project_name, { ...row });
      return state.credentials.get(row.project_name);
    },
    async revokeCredential(projectName, atIso) {
      const row = state.credentials.get(projectName);
      if (!row) return null;
      const next = { ...row, revoked_at: atIso };
      state.credentials.set(projectName, next);
      return next;
    },
    async deleteCredential(projectName) {
      return state.credentials.delete(projectName);
    },
  };
}

/** A job in `queued`, the way the install route creates one. */
async function queuedJob(store, overrides = {}) {
  const { job } = await createJob({
    store,
    source: 'upload',
    pluginId: PLUGIN,
    pluginVersion: '1.2.0',
    projectName: PROJECT,
    ...overrides,
  });
  return job;
}

test('a pairing code becomes a worker token once, and the token is stored hashed', async () => {
  const store = memoryStore();
  const pairing = newPairingCode({ now: () => new Date('2026-02-01T00:00:00Z') });
  await store.insertPairing({ hash: pairing.hash, name: 'ana-laptop', created_by: null, expires_at: pairing.expiresAt });

  const redeemed = await redeemPairing({ store, code: pairing.code, name: 'ana-laptop', now: () => new Date('2026-02-01T00:01:00Z') });
  assert.equal(looksLikeWorkerToken(redeemed.token), true);
  assert.equal(redeemed.worker.name, 'ana-laptop');

  // The row keeps a hash, never the token.
  const stored = [...store.state.workers.values()][0];
  assert.equal(stored.token_hash.includes(redeemed.token), false);

  const worker = await authenticateWorker({ store, authorization: `Bearer ${redeemed.token}` });
  assert.equal(worker.id, redeemed.worker.id);

  // The same code cannot be used twice.
  await assert.rejects(
    () => redeemPairing({ store, code: pairing.code, now: () => new Date('2026-02-01T00:02:00Z') }),
    (error) => error instanceof DeployError && error.status === 401 && error.code === 'pairing_invalid',
  );
});

test('an expired pairing code is refused, and a revoked worker token stops working', async () => {
  const store = memoryStore();
  const pairing = newPairingCode({ now: () => new Date('2026-02-01T00:00:00Z'), ttlMs: 1000 });
  await store.insertPairing({ hash: pairing.hash, name: 'ci', created_by: null, expires_at: pairing.expiresAt });

  await assert.rejects(
    () => redeemPairing({ store, code: pairing.code, now: () => new Date('2026-02-01T00:00:05Z') }),
    (error) => error.code === 'pairing_invalid',
  );

  const fresh = newPairingCode();
  await store.insertPairing({ hash: fresh.hash, name: 'ci', created_by: null, expires_at: fresh.expiresAt });
  const redeemed = await redeemPairing({ store, code: fresh.code });
  await revokeWorker({ store, workerId: redeemed.worker.id });

  await assert.rejects(
    () => authenticateWorker({ store, authorization: `Bearer ${redeemed.token}` }),
    (error) => error instanceof DeployError && error.status === 401 && error.code === 'worker_revoked',
  );
  await assert.rejects(
    () => authenticateWorker({ store, authorization: '' }),
    (error) => error.code === 'worker_unauthorized',
  );
});

test('a payload crosses in chunks, and an incomplete or altered one is refused', async () => {
  const store = memoryStore();
  const job = await queuedJob(store);
  const zip = filesToZip(new Map([['dist/index.js', Buffer.from('console.log(1)')]]));
  const digest = sha256Of(zip);
  const total = Math.ceil(zip.length / (512 * 1024));

  await putArtifactChunk({ store, jobId: job.id, kind: 'payload', index: 0, total, sha256: digest, size: zip.length, data: zip.toString('base64') });
  const read = await readArtifact({ store, jobId: job.id, kind: 'payload' });
  assert.equal(read.sha256, digest);
  assert.deepEqual([...payloadZipToFiles(read.bytes).keys()], ['dist/index.js']);

  // A digest that does not match what arrived is refused, not deployed.
  await assert.rejects(
    () => readArtifact({ store, jobId: job.id, kind: 'payload', expectedSha256: 'deadbeef' }),
    (error) => error instanceof DeployError && error.status === 409 && error.code === 'artifact_digest_mismatch',
  );

  // A missing chunk says how many arrived, so the worker knows how much it still owes.
  const twoChunk = Buffer.concat([Buffer.alloc(512 * 1024, 1), Buffer.from('tail')]);
  const twoTotal = Math.ceil(twoChunk.length / (512 * 1024));
  await putArtifactChunk({ store, jobId: job.id, kind: 'package', index: 0, total: twoTotal, sha256: sha256Of(twoChunk), size: twoChunk.length, data: twoChunk.subarray(0, 512 * 1024).toString('base64') });
  await assert.rejects(
    () => readArtifact({ store, jobId: job.id, kind: 'package' }),
    (error) => error.code === 'artifact_incomplete' && error.details.received === 1 && error.details.total === 2,
  );
});

test('a payload with a traversal path never reaches a deployment', async () => {
  const zip = filesToZip(new Map([['../escape.js', Buffer.from('x')]]));
  assert.throws(
    () => payloadZipToFiles(zip),
    (error) => error instanceof DeployError && error.code === 'payload_unsafe_path',
  );
});

/** A Vercel stand-in that records what the engine asked it to do, and can fail on demand. */
function stubVercel({ fail = null } = {}) {
  const calls = { created: [], waited: [] };
  return {
    calls,
    async createFileDeployment(token, { files, meta, projectName }) {
      calls.created.push({ token, projectName, meta, count: files?.size ?? null });
      if (fail === 'create') throw new DeployError(502, 'Vercel did not accept the upload.', { code: 'upload_failed' });
      return {
        id: 'dpl_1',
        readyState: 'QUEUED',
        url: `https://${projectName}.vercel.app`,
        deploymentUrl: 'https://dpl_1.vercel.app',
        uploaded: 1,
        files: files.size,
      };
    },
    async waitForDeployment(token, { deploymentId }) {
      calls.waited.push(deploymentId);
      if (fail === 'build') {
        throw new DeployError(502, 'Vercel finished the deployment as ERROR (BUILD_FAILED): src/main.tsx(3,1) failed to compile.', { code: 'deployment_failed' });
      }
      if (fail === 'timeout') throw new DeployError(504, 'The deployment is still BUILDING after 15 minutes.', { code: 'deployment_timeout' });
      return { ok: true, id: deploymentId, readyState: 'READY', deploymentUrl: 'https://dpl_1.vercel.app', elapsedMs: 1, attempts: 1 };
    },
  };
}

/** A payload the allowlist accepts: built output plus one function entry. */
const payloadFiles = () => new Map([
  ['dist/index.html', Buffer.from('<!doctype html><title>site</title>')],
  ['dist/assets/app.js', Buffer.from('console.log("built")')],
  ['api/index.mjs', Buffer.from('export default () => new Response("ok")')],
  ['package.json', Buffer.from('{"name":"site"}')],
]);

const credential = () => ({ token: 'vercel_token_1234567890', projectName: PROJECT, projectId: 'prj_1', teamId: '' });

/** The worker half of a job: claimed, payload uploaded, waiting for the server to deploy it. */
async function builtJob(store, { files = payloadFiles(), overrides = {} } = {}) {
  const job = await queuedJob(store, overrides);
  const claimed = await claimJob({ store, workerId: WORKER_A });
  const zip = filesToZip(files);
  const digest = sha256Of(zip);
  await putArtifactChunk({
    store, jobId: job.id, kind: 'payload', index: 0, total: 1, sha256: digest, size: zip.length, data: zip.toString('base64'),
  });
  await attachArtifact({
    store, jobId: job.id, workerId: claimed.worker_id, sha256: digest, size: zip.length, files: files.size,
  });
  return job;
}

test('an installed plugin is marked installed only after Vercel says READY', async () => {
  const store = memoryStore();
  const job = await builtJob(store);
  const vercel = stubVercel();
  const activated = [];

  const result = await advanceJob({
    store,
    jobId: job.id,
    vercel,
    resolveCredential: async () => credential(),
    onInstalled: async ({ job: installedJob }) => activated.push(installedJob.plugin_id),
  });

  assert.equal(result.state, JOB_STATUS.INSTALLED);
  assert.equal(result.job.status, JOB_STATUS.INSTALLED);
  assert.equal(result.job.deployment_id, 'dpl_1');
  assert.deepEqual(vercel.calls.waited, ['dpl_1']);
  assert.equal(vercel.calls.created.length, 1);
  assert.equal(vercel.calls.created[0].meta.rwpPlugin, PLUGIN);
  assert.deepEqual(activated, [PLUGIN]);
  assert.equal(publicJob(result.job).finished, true);
});

test('a failed Vercel build leaves the job failed, the plugin inactive, and the payload deployed once', async () => {
  const store = memoryStore();
  const job = await builtJob(store);
  const vercel = stubVercel({ fail: 'build' });
  const activated = [];

  const result = await advanceJob({
    store,
    jobId: job.id,
    vercel,
    resolveCredential: async () => credential(),
    onInstalled: async () => activated.push('installed'),
  });

  assert.equal(result.job.status, JOB_STATUS.FAILED);
  assert.equal(result.job.error_code, 'deployment_failed');
  assert.match(result.job.error_message, /BUILD_FAILED/);
  assert.deepEqual(activated, []);
  // The deployment id is kept: Vercel is the record of what was attempted, and its alias never moved.
  assert.equal(result.job.deployment_id, 'dpl_1');
  assert.equal(vercel.calls.created.length, 1);
});

test('a deployment that is still building is not a failure: the next call resumes the same deployment', async () => {
  const store = memoryStore();
  const job = await builtJob(store);

  const timedOut = await advanceJob({
    store,
    jobId: job.id,
    vercel: stubVercel({ fail: 'timeout' }),
    resolveCredential: async () => credential(),
  });
  assert.equal(timedOut.retryLater, true);
  assert.equal(timedOut.job.status, JOB_STATUS.DEPLOYING);
  assert.equal(timedOut.job.deployment_id, 'dpl_1');

  const healthy = stubVercel();
  const resumed = await advanceJob({ store, jobId: job.id, vercel: healthy, resolveCredential: async () => credential() });
  assert.equal(resumed.state, JOB_STATUS.INSTALLED);
  // No second upload: the deployment that was already created is the one that was waited on.
  assert.equal(healthy.calls.created.length, 0);
  assert.deepEqual(healthy.calls.waited, ['dpl_1']);
});

test('advancing an installed job does nothing at all', async () => {
  const store = memoryStore();
  const job = await builtJob(store);
  await advanceJob({ store, jobId: job.id, vercel: stubVercel(), resolveCredential: async () => credential() });

  const again = stubVercel();
  const result = await advanceJob({ store, jobId: job.id, vercel: again, resolveCredential: async () => credential() });
  assert.equal(result.done, true);
  assert.equal(again.calls.created.length, 0);
  assert.equal(again.calls.waited.length, 0);
});

test('a payload that carries source is rejected before anything is uploaded', async () => {
  const store = memoryStore();
  const job = await builtJob(store, {
    files: new Map([
      ['dist/index.html', Buffer.from('<!doctype html>')],
      ['api/index.mjs', Buffer.from('export default () => 1')],
      ['src/App.tsx', Buffer.from('export default function App() { return null }')],
    ]),
  });
  const vercel = stubVercel();

  const result = await advanceJob({ store, jobId: job.id, vercel, resolveCredential: async () => credential() });

  assert.equal(result.job.status, JOB_STATUS.FAILED);
  assert.equal(result.job.error_code, 'payload_rejected');
  assert.match(result.job.error_message, /not build output/);
  assert.equal(vercel.calls.created.length, 0);
});

test('a job with no build environment waits, and the site can build it itself', async () => {
  const store = memoryStore();
  const job = await queuedJob(store, { buildMode: 'server' });

  const waiting = await advanceJob({ store, jobId: job.id, resolveCredential: async () => credential() });
  assert.equal(waiting.awaitingBuilder, true);
  assert.equal(waiting.job.status, JOB_STATUS.QUEUED);

  const vercel = stubVercel();
  const built = await advanceJob({
    store,
    jobId: job.id,
    vercel,
    resolveCredential: async () => credential(),
    builder: async () => ({ files: payloadFiles() }),
  });

  assert.equal(built.state, JOB_STATUS.INSTALLED);
  assert.equal(built.job.attempts, 1);
  assert.equal(vercel.calls.created[0].count, 4);
});

test('the server claims its own job without writing a worker id the uuid column would refuse', async () => {
  const store = memoryStore();
  const job = await queuedJob(store, { buildMode: 'server' });

  const claimed = await claimJob({ store, workerId: SERVER_WORKER });
  assert.equal(claimed.status, JOB_STATUS.BUILDING);
  assert.equal(claimed.worker_id, null);

  // Its own later writes are guarded as "unowned", so they succeed...
  const stepped = await setJobStep({ store, jobId: job.id, step: 'building', progress: 35, workerId: SERVER_WORKER });
  assert.equal(stepped.step, 'building');
  const built = await attachArtifact({ store, jobId: job.id, workerId: SERVER_WORKER, sha256: '', size: 0, files: 1 });
  assert.equal(built.status, JOB_STATUS.BUILT);

  // ...and a job a paired worker owns is not the server's to write.
  const other = await queuedJob(store, { buildMode: 'worker', pluginId: 'rwp-shop', projectName: 'other-site' });
  await claimJob({ store, workerId: WORKER_A });
  assert.equal(await attachArtifact({ store, jobId: other.id, workerId: SERVER_WORKER, sha256: '', size: 0, files: 1 }), null);
});

test('a worker id that is not a uuid fails the way Postgres fails it, so a mismatch cannot hide in a test', async () => {
  const store = memoryStore();
  await queuedJob(store);
  const error = await claimJob({ store, workerId: 'worker-a' }).catch((caught) => caught);
  assert.equal(error.code, '22P02');
});

test('a schema is applied only against an approval of those statements, and only after a backup', async () => {
  const plans = plannedMigrations([{
    path: 'schema.sql',
    sql: 'create table if not exists public.shop_orders (id uuid primary key);\nalter table public.options drop column if exists legacy;',
  }]);
  const summary = summariseMigrations(plans);
  assert.equal(summary.statements, 2);
  assert.equal(summary.destructive, 1);
  assert.deepEqual(summary.tables, ['public.options', 'public.shop_orders']);

  // No approval at all: the refusal carries the summary the screen needs to ask for one.
  const refused = await applyMigrations({ plans, run: async () => {} }).catch((error) => error);
  assert.equal(refused.status, 428);
  assert.equal(refused.code, 'migration_consent_required');
  assert.equal(refused.details.summary.fingerprint, summary.fingerprint);

  // An approval of *different* statements is not an approval of these.
  const stale = await applyMigrations({ plans, consent: { fingerprint: 'mig_somethingelse' }, run: async () => {} })
    .catch((error) => error);
  assert.equal(stale.status, 428);

  // A migration that cannot be backed up is refused even when approved.
  const unbacked = await applyMigrations({ plans, consent: { fingerprint: summary.fingerprint }, run: async () => {} })
    .catch((error) => error);
  assert.equal(unbacked.code, 'migration_backup_unavailable');

  const statements = [];
  const snapshots = [];
  const applied = await applyMigrations({
    plans,
    consent: { fingerprint: summary.fingerprint },
    backup: {
      snapshot: async ({ tables }) => {
        snapshots.push(tables);
        return { tables, rows: [] };
      },
      restore: async () => {},
    },
    run: async (sql) => statements.push(...sql),
  });

  assert.equal(applied.applied, true);
  assert.deepEqual(snapshots, [['public.options', 'public.shop_orders']]);
  assert.equal(statements.length, 2);
});

test('a schema that fails part way is reported as restored, not as applied', async () => {
  const plans = plannedMigrations([{
    path: 'schema.sql',
    sql: 'create table public.a (id int); create table public.a (id int);',
  }]);
  const summary = summariseMigrations(plans);
  const restored = [];

  const failure = await applyMigrations({
    plans,
    consent: { fingerprint: summary.fingerprint },
    backup: {
      snapshot: async () => ({ marker: 'before' }),
      restore: async (data) => restored.push(data.marker),
    },
    run: async () => {
      throw new Error('relation "public.a" already exists');
    },
  }).catch((error) => error);

  assert.equal(failure.code, 'migration_failed');
  assert.match(failure.message, /already exists/);
  assert.match(failure.message, /restored from the backup/);
  assert.deepEqual(restored, ['before']);
});

test('a schema splitter keeps a dollar-quoted body together and ignores commented-out DDL', () => {
  const statements = splitStatements(`
    -- drop table public.old;
    create table if not exists public.t (id int);
    create or replace function public.f() returns trigger as $$
    begin
      insert into public.log values (1);
      return new;
    end;
    $$ language plpgsql;
    /* drop table public.also_not_real; */
    alter table public.t add column if not exists note text;
  `);
  assert.equal(statements.length, 3);
  assert.match(statements[1], /insert into public.log/);
  assert.equal(summariseMigrations(plannedMigrations([{ path: 's.sql', sql: statements.join(';') }])).destructive, 0);
});

test('a build that throws fails the job with the build\'s own sentence, and nothing is uploaded', async () => {
  const store = memoryStore();
  const job = await queuedJob(store, { buildMode: 'server' });
  const vercel = stubVercel();

  const result = await advanceJob({
    store,
    jobId: job.id,
    vercel,
    resolveCredential: async () => credential(),
    builder: async () => {
      throw Object.assign(new Error('npm run build exited with code 1: TS2307 cannot find module'), { code: 'build_failed' });
    },
  });

  assert.equal(result.job.status, JOB_STATUS.FAILED);
  assert.equal(result.job.error_code, 'build_failed');
  assert.match(result.job.error_message, /TS2307/);
  assert.equal(vercel.calls.created.length, 0);
});

test('the Vercel token is sealed at rest, readable only by the server, and gone once revoked', async () => {
  const store = memoryStore();
  const token = 'vercel_token_abcdefghijklmnop';

  const saved = await saveCredential({
    store,
    token,
    projectName: PROJECT,
    teamId: 'team_1',
    validate: async () => ({ id: 'user_1', username: 'ana' }),
    env: secretEnv,
  });

  assert.equal(saved.projectName, PROJECT);
  assert.equal(saved.active, true);
  assert.match(saved.fingerprint, /^sha256:/);
  assert.equal(JSON.stringify(saved).includes(token), false);

  // The row holds an envelope, not the token.
  const row = await store.findCredential(PROJECT);
  assert.equal(String(row.sealed).includes(token), false);
  assert.match(String(row.sealed), /^v1\./);

  const loaded = await loadCredential({ store, projectName: PROJECT, env: secretEnv });
  assert.equal(loaded.token, token);
  assert.equal(loaded.teamId, 'team_1');

  // Without the key, a stored token is a refusal rather than a silent plaintext fallback.
  await assert.rejects(
    () => loadCredential({ store, projectName: PROJECT, env: {} }),
    (error) => error instanceof DeployError && error.code === 'token_unreadable',
  );
  await assert.rejects(
    () => saveCredential({ store, token, projectName: PROJECT, validate: async () => ({ id: 'u' }), env: {} }),
    (error) => error instanceof DeployError && error.code === 'secret_box_unconfigured',
  );

  await revokeCredential({ store, projectName: PROJECT, now: () => new Date('2026-03-01T00:00:00Z') });
  await assert.rejects(
    () => loadCredential({ store, projectName: PROJECT, env: secretEnv }),
    (error) => error instanceof DeployError && error.code === 'credential_revoked',
  );

  const status = await credentialStatus({ store, env: secretEnv });
  assert.equal(status.secretBox, true);
  assert.equal(status.credentials.length, 1);
  assert.equal(status.credentials[0].active, false);
  assert.equal(JSON.stringify(status).includes(token), false);
});

test('a credential for an unnamed project is refused before Vercel is called', async () => {
  const store = memoryStore();
  let called = false;
  await assert.rejects(
    () => saveCredential({
      store,
      token: 'vercel_token_abcdefghijklmnop',
      projectName: 'Not A Project',
      env: secretEnv,
      validate: async () => {
        called = true;
        return { id: 'u' };
      },
    }),
    (error) => error instanceof DeployError && error.code === 'project_name_invalid',
  );
  assert.equal(called, false);
});

test('reading the repository skips the dependency tree, build output and env files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rwp-repo-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'public'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.tsx'), 'export default 1');
    await writeFile(path.join(root, 'public', 'logo.svg'), '<svg />');
    await writeFile(path.join(root, 'package.json'), '{"name":"site"}');
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'nope');
    await writeFile(path.join(root, 'dist', 'app.js'), 'built');
    await writeFile(path.join(root, '.env'), 'SUPABASE_SECRET_KEY=nope');

    const files = await readRepoFiles({ root });
    assert.deepEqual([...files.keys()].sort(), ['package.json', 'public/logo.svg', 'src/main.tsx']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only VITE_ variables may be compiled into a browser bundle', () => {
  const env = clientBuildEnv({
    VITE_SUPABASE_URL: 'https://x.supabase.co',
    VITE_DB_TYPE: 'supabase',
    SUPABASE_SECRET_KEY: 'service-role-key',
    RWP_SECRET_BOX_KEY: 'box-key',
    DATABASE_URL: 'postgres://user:pass@host/db',
  });
  assert.deepEqual(Object.keys(env).sort(), ['VITE_DB_TYPE', 'VITE_SUPABASE_URL']);
  assert.equal(JSON.stringify(env).includes('service-role-key'), false);
});

test('cleanup deletes only finished jobs past their retention, and their artifacts with them', async () => {
  const store = memoryStore();
  const job = await queuedJob(store);
  await claimJob({ store, workerId: WORKER_A });
  await attachArtifact({ store, jobId: job.id, workerId: WORKER_A, sha256: 'x', size: 10, files: 1 });
  await putArtifactChunk({ store, jobId: job.id, kind: 'payload', index: 0, total: 1, sha256: 'x', size: 10, data: 'cGF5bG9hZA==' });
  await markFailed({ store, jobId: job.id, code: 'build_failed', message: 'nope', now: () => new Date('2026-01-01T00:00:00Z') });

  // Inside the window: nothing is collected.
  const early = await cleanupJobs({ store, now: () => new Date('2026-01-03T00:00:00Z'), retentionMs: 7 * 24 * 3600 * 1000 });
  assert.deepEqual(early, []);
  assert.equal(await store.findJob(job.id) !== null, true);

  // Past it: the row and its blobs go together.
  const late = await cleanupJobs({ store, now: () => new Date('2026-01-20T00:00:00Z'), retentionMs: 7 * 24 * 3600 * 1000 });
  assert.deepEqual(late, [job.id]);
  assert.equal(await store.findJob(job.id), null);
  assert.deepEqual(await store.readBlobChunks(job.id, 'payload'), []);
});



test('a job is created once, even when the same request arrives twice', async () => {
  const store = memoryStore();
  const first = await createJob({ store, source: 'upload', pluginId: PLUGIN, pluginVersion: '1.2.0', projectName: PROJECT });
  const second = await createJob({ store, source: 'upload', pluginId: PLUGIN, pluginVersion: '1.2.0', projectName: PROJECT });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(first.job.status, JOB_STATUS.QUEUED);

  // A deliberate second install is a different request, and must be a different job.
  const forced = await createJob({ store, source: 'upload', pluginId: PLUGIN, pluginVersion: '1.2.0', projectName: PROJECT, nonce: 'again' });
  assert.equal(forced.created, true);
  assert.notEqual(forced.job.id, first.job.id);
});

test('a job refuses input that would deploy to the wrong project', () => {
  assert.throws(
    () => jobRecord({ source: 'upload', pluginId: 'RWP Shop', projectName: PROJECT }),
    (error) => error instanceof DeployError && error.status === 400 && /pluginId/.test(error.message),
  );
  assert.throws(
    () => jobRecord({ source: 'upload', pluginId: PLUGIN, projectName: '../other' }),
    (error) => error instanceof DeployError && /projectName/.test(error.message),
  );
  assert.throws(
    () => jobRecord({ source: 'ftp', pluginId: PLUGIN, projectName: PROJECT }),
    (error) => error instanceof DeployError && /source/.test(error.message),
  );
});

test('two workers cannot claim the same job', async () => {
  const store = memoryStore();
  await queuedJob(store);

  const first = await claimJob({ store, workerId: WORKER_A });
  const second = await claimJob({ store, workerId: WORKER_B });

  assert.equal(first.status, JOB_STATUS.BUILDING);
  assert.equal(first.worker_id, WORKER_A);
  assert.equal(first.attempts, 1);
  assert.equal(second, null);
  const stored = await store.findJob(first.id);
  assert.equal(stored.worker_id, WORKER_A);
});

test('a claim whose worker disappeared is put back in the queue, then failed once the budget is spent', async () => {
  const store = memoryStore();
  const job = await queuedJob(store, { maxAttempts: 2 });
  const claimed = await claimJob({ store, workerId: WORKER_A, now: () => new Date('2026-01-01T00:00:00Z') });
  assert.equal(claimed.status, JOB_STATUS.BUILDING);

  // The lease has not expired yet: nothing happens.
  const early = await requeueExpiredLeases({ store, now: () => new Date('2026-01-01T00:05:00Z') });
  assert.deepEqual(early, []);

  const late = await requeueExpiredLeases({ store, now: () => new Date('2026-01-01T01:00:00Z') });
  assert.equal(late.length, 1);
  assert.equal(late[0].status, JOB_STATUS.QUEUED);
  assert.equal(late[0].error_code, 'lease_expired');

  // Attempt two fails for good once it too runs out of time.
  await claimJob({ store, workerId: WORKER_B, now: () => new Date('2026-01-01T02:00:00Z') });
  const spent = await requeueExpiredLeases({ store, now: () => new Date('2026-01-01T03:00:00Z') });
  assert.equal(spent.length, 1);
  assert.equal(spent[0].status, JOB_STATUS.FAILED);
  assert.equal((await store.findJob(job.id)).finished_at !== null, true);
});

test('progress never goes backwards, and every step is kept as history', async () => {
  const store = memoryStore();
  const job = await queuedJob(store);
  await claimJob({ store, workerId: WORKER_A });

  await setJobStep({ store, jobId: job.id, step: 'installing-plugin', progress: 30 });
  const late = await setJobStep({ store, jobId: job.id, step: 'running-npm', progress: 60 });
  const back = await setJobStep({ store, jobId: job.id, step: 'uploading', progress: 40 });

  assert.equal(late.progress, 60);
  assert.equal(back.progress, 60);
  assert.deepEqual(back.steps.map((step) => step.step).slice(0, 3), ['queued', 'claimed', 'installing-plugin']);
});

test('a retryable failure requeues the job until the attempt budget is spent', async () => {
  const store = memoryStore();
  const job = await queuedJob(store, { maxAttempts: 2 });
  await claimJob({ store, workerId: WORKER_A });

  const retried = await markFailed({ store, jobId: job.id, code: 'network', message: 'Vercel did not answer.', retryable: true });
  assert.equal(retried.status, JOB_STATUS.QUEUED);
  assert.equal(retried.finished_at, null);

  await claimJob({ store, workerId: WORKER_B });
  const failed = await markFailed({ store, jobId: job.id, code: 'network', message: 'Vercel did not answer.', retryable: true });
  assert.equal(failed.status, JOB_STATUS.FAILED);
  assert.notEqual(failed.finished_at, null);
  assert.equal(publicJob(failed).canRetry, false);
});



// ## One install per project ##
//
// A second job for a project that is already installing must wait, and must never take the project from the job
// that holds it — two deployments reaching READY for the same project would replace each other's plugin. The store
// below refuses the write the way `rwp_installer_jobs_project_lock_idx` refuses it, so these tests fail if the
// claim stops being a compare-and-set that the database backs up.

/** Two queued installs for the same project: `first` is older, so it is the one a claim should take. */
async function twoQueued(store) {
  const first = await queuedJob(store, { pluginId: 'rwp-shop', pluginVersion: '1.0.0' });
  const second = await queuedJob(store, { pluginId: 'rwp-blog', pluginVersion: '1.0.0' });
  return { first, second };
}

/** The payload half, for a job that is already claimed and `building`. */
async function uploadPayload(store, job, workerId) {
  const files = payloadFiles();
  const zip = filesToZip(files);
  const digest = sha256Of(zip);
  await putArtifactChunk({
    store, jobId: job.id, kind: 'payload', index: 0, total: 1, sha256: digest, size: zip.length, data: zip.toString('base64'),
  });
  return await attachArtifact({ store, jobId: job.id, workerId, sha256: digest, size: zip.length, files: files.size });
}

test('a second install for the same project stays queued until the first is installed', async () => {
  const store = memoryStore();
  const { first, second } = await twoQueued(store);
  const claimed = await claimJob({ store, workerId: WORKER_A });
  // Oldest first: the job somebody queued first is the one that starts.
  assert.equal(claimed.id, first.id);

  // The other job is not taken, and the worker is told there is nothing to do rather than blocked.
  assert.equal(await claimJob({ store, workerId: WORKER_B }), null);
  assert.equal((await store.findJob(second.id)).status, JOB_STATUS.QUEUED);

  // The site's own build path answers with a sentence instead of a second build.
  const refused = await advanceJob({
    store,
    jobId: second.id,
    builder: async () => ({ files: payloadFiles() }),
    resolveCredential: async () => credential(),
  });
  assert.equal(refused.queuedBehind, true);
  assert.equal(refused.state, JOB_STATUS.QUEUED);
  assert.match(refused.reason, /Another install for ana-site is in progress/);

  // Once the first one is installed the project is free, and the queued job is claimed as normal.
  await uploadPayload(store, first, claimed.worker_id);
  const installed = await advanceJob({ store, jobId: first.id, vercel: stubVercel(), resolveCredential: async () => credential() });
  assert.equal(installed.state, JOB_STATUS.INSTALLED);

  const next = await claimJob({ store, workerId: WORKER_B });
  assert.equal(next.id, second.id);
});

test('the database refuses a second claim even when the check before it is skipped', async () => {
  const store = memoryStore();
  const { first, second } = await twoQueued(store);
  await claimJob({ store, workerId: WORKER_A });

  // Exactly the write `claimJobById()` makes, without its read: the partial unique index is what stops it.
  await assert.rejects(
    () => store.updateJob({ id: second.id, expect: [JOB_STATUS.QUEUED], patch: { status: JOB_STATUS.BUILDING } }),
    (error) => error.code === 'project_busy' && error.status === 409,
  );
  assert.equal((await store.findJob(second.id)).status, JOB_STATUS.QUEUED);
  assert.equal((await store.findJob(first.id)).status, JOB_STATUS.BUILDING);
});


test('a build environment that disappears frees its project and keeps its place in the queue', async () => {
  const store = memoryStore();
  const { first } = await twoQueued(store);
  const start = new Date('2026-03-01T10:00:00Z');
  await claimJob({ store, workerId: WORKER_A, now: () => start });

  const requeued = await requeueExpiredLeases({ store, now: () => new Date('2026-03-01T10:21:00Z') });
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].id, first.id);
  assert.equal(requeued[0].status, JOB_STATUS.QUEUED);

  // Still first in line: the requeued job is not pushed behind the one created after it.
  const taken = await claimJob({ store, workerId: WORKER_B, now: () => new Date('2026-03-01T10:22:00Z') });
  assert.equal(taken.id, first.id);
  assert.equal(taken.attempts, 2);
});

test('a deployment nobody followed up is put back, so its project is never locked for good', async () => {
  const store = memoryStore();
  const { first, second } = await twoQueued(store);
  const start = new Date('2026-03-02T09:00:00Z');
  const claimed = await claimJob({ store, workerId: WORKER_A, now: () => start });
  await uploadPayload(store, first, claimed.worker_id);

  // Vercel accepted the deployment and then never answered: the job is `deploying`, not failed.
  const stalling = {
    async createFileDeployment() { return { id: 'dpl_stuck', url: 'stuck.vercel.app' }; },
    async waitForDeployment() { throw new DeployError(504, 'Vercel did not answer while this deployment was being built.', { code: 'deployment_timeout' }); },
  };
  const stuck = await advanceJob({ store, jobId: first.id, vercel: stalling, resolveCredential: async () => credential(), now: () => start });
  assert.equal(stuck.retryLater, true);
  assert.equal((await store.findJob(first.id)).status, JOB_STATUS.DEPLOYING);
  assert.equal((await store.findJob(first.id)).deployment_id, 'dpl_stuck');

  // Ten minutes in, that is a deployment still building: untouched.
  assert.equal((await requeueExpiredLeases({ store, now: () => new Date('2026-03-02T09:10:00Z') })).length, 0);

  // Past three waits it is abandoned, and the retry asks about `dpl_stuck` instead of uploading again.
  const aged = await requeueExpiredLeases({ store, now: () => new Date('2026-03-02T09:46:00Z') });
  assert.equal(aged.length, 1);
  assert.equal(aged[0].error_code, 'deploy_stalled');
  assert.equal(aged[0].status, JOB_STATUS.QUEUED);
  assert.equal((await store.findJob(second.id)).status, JOB_STATUS.QUEUED);

  const vercel = stubVercel();
  const retried = await claimJob({ store, workerId: WORKER_B, now: () => new Date('2026-03-02T09:47:00Z') });
  assert.equal(retried.id, first.id);
  // A retried job is rebuilt and re-uploaded, but the deployment it already created is the one it follows:
  // uploading a second one here is exactly the duplicate this whole section exists to prevent.
  await uploadPayload(store, first, retried.worker_id);
  const resumed = await advanceJob({ store, jobId: first.id, vercel, resolveCredential: async () => credential() });
  assert.equal(resumed.state, JOB_STATUS.INSTALLED);
  assert.equal(vercel.calls.created.length, 0, 'the retry resumes the deployment it already created');
  assert.deepEqual(vercel.calls.waited, ['dpl_stuck']);
});


// ## The PostgREST store ##
//
// The store is the half that cannot be reached from a unit test with a database, so the queries it makes are asserted
// here against a stubbed `fetch`. A filter that is one character wrong is not a crash: PostgREST answers 200 with the
// wrong rows, and the project lock would silently stop working.

/** A stubbed `fetch` that records every call, and answers what the test tells it to. */
function stubPostgrest(answers = []) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const answer = answers.shift() || { status: 200, body: [] };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('the store asks PostgREST the two questions the project lock depends on', async () => {
  const stub = stubPostgrest([
    { status: 200, body: [{ id: 'job-1', status: 'building', project_name: PROJECT }] },
    { status: 200, body: [] },
  ]);
  try {
    const store = postgrestStore({ supabaseUrl: 'https://demo.supabase.co', secretKey: 'service-key' });

    const holder = await store.findActiveProjectJob(PROJECT, { excludeJobId: 'job-9' });
    assert.equal(holder.id, 'job-1');
    const lockUrl = decodeURIComponent(stub.calls[0].url);
    assert.match(lockUrl, /\/rest\/v1\/rwp_installer_jobs\?/);
    assert.match(lockUrl, /project_name=eq\.ana-site/);
    assert.match(lockUrl, /status=in\.\(building,built,deploying\)/);
    assert.match(lockUrl, /id=neq\.job-9/);
    assert.match(lockUrl, /limit=1/);

    // A claim wants the oldest queued row; the dashboard wants the newest finished one.
    await store.listJobs({ statuses: [JOB_STATUS.QUEUED], limit: 20, order: 'oldest' });
    assert.match(stub.calls[1].url, /order=created_at\.asc/);
    assert.match(stub.calls[1].url, /status=in\.\(queued\)/);
    await store.listJobs({ limit: 5 });
    assert.match(stub.calls[2].url, /order=created_at\.desc/);

    // The server's own writes ask for an unowned job. worker_id is a uuid, so never `worker_id=eq.server`.
    await store.updateJob({ id: 'job-1', expect: ['building'], expectUnowned: true, patch: { step: 'building' } });
    const unowned = decodeURIComponent(stub.calls[3].url);
    assert.match(unowned, /worker_id=is\.null/);
    assert.doesNotMatch(unowned, /worker_id=eq/);
  } finally {
    stub.restore();
  }
});

test('a unique violation on the project lock is the same 409 the claim check produces', async () => {
  const stub = stubPostgrest([
    { status: 409, body: '{"code":"23505","message":"duplicate key value violates unique constraint \\"rwp_installer_jobs_project_lock_idx\\""}' },
  ]);
  try {
    const store = postgrestStore({ supabaseUrl: 'https://demo.supabase.co', secretKey: 'service-key' });
    await assert.rejects(
      () => store.updateJob({ id: 'job-2', expect: ['queued'], patch: { status: 'building' } }),
      (error) => error.code === 'project_busy' && error.status === 409,
    );
    assert.equal(stub.calls[0].method, 'PATCH');
  } finally {
    stub.restore();
  }
});


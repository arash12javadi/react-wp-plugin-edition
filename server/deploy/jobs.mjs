/**
 * Durable, authenticated, idempotent install jobs — the state machine, and nothing that talks to a network.
 *
 * A plugin is not installed by writing a row: it is installed by *building* the site with the plugin in it
 * and *replacing* the deployment that is serving. That takes minutes, happens outside any request, and can
 * fail at six different points, so the browser cannot be the thing that remembers where it got to. A job row
 * is: what is being installed, where it is up to, who is doing it, and what the last failure was. Every step
 * below is written so that repeating it is safe.
 *
 *   queued --claim--> building --artifact--> built --> deploying --READY--> installed
 *     ^                  |                     |            |
 *     +--lease expired---+                     +------------+--> failed (error_code)
 *
 * `queued` is durable; `building` is *leased* (a worker that dies leaves a lease that expires, and
 * `requeueExpiredLeases()` puts the job back); `built` means the artifact is complete, so the expensive part
 * happens once per attempt; `deploying` stores `deployment_id` as soon as Vercel answers, which is what makes
 * a retry poll the deployment it already created instead of uploading a second one; and `installed` is
 * written only after Vercel reports `READY`.
 *
 * A failed job leaves nothing behind: the previous deployment still serves, because Vercel only moves a
 * project's alias when a new deployment becomes `READY`, and the plugin is switched on in
 * `rwp_active_plugins` only after that point.
 *
 * One build at a time per project. `building`, `built` and `deploying` are the statuses in which a job *owns its
 * Vercel project* (`PROJECT_LOCK_STATUSES`); a second claim for the same project is refused, and the partial unique
 * index `rwp_installer_jobs_project_lock_idx` is what makes that true when two workers poll in the same instant.
 * Everything else waits in `queued`, oldest first, which is why `listJobs({ order: 'oldest' })` exists.
 *
 * No table names live here. The port is implemented by `plugins/rwp-saas-installer/jobStore.mjs` over
 * PostgREST and by `tests/pluginInstallJobs.test.mjs` over a Map:
 *
 *   insertJob(row) -> row
 *   findJob(id) -> row | null
 *   findJobByIdempotencyKey(key) -> row | null
 *   updateJob({ id, patch, expect, expectWorker }) -> row | null   (CAS; null is "not in that state")
 *   listJobs({ statuses, limit, order }) -> rows, newest first unless `order: 'oldest'`
 *   findActiveProjectJob(projectName, { excludeJobId }) -> row | null   (the project lock, one row)
 *   deleteJob(id) -> boolean
 */
import { createHash } from 'node:crypto';
import { DeployError } from './errors.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** Every state a job may be in. Anything else in the column is a corrupt row, not a new state. */
export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  BUILDING: 'building',
  BUILT: 'built',
  DEPLOYING: 'deploying',
  INSTALLED: 'installed',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

export const JOB_STATUSES = Object.freeze(Object.values(JOB_STATUS));

/** The states still moving. A job in one of these is worth polling. */
export const ACTIVE_JOB_STATUSES = Object.freeze([
  JOB_STATUS.QUEUED, JOB_STATUS.BUILDING, JOB_STATUS.BUILT, JOB_STATUS.DEPLOYING,
]);

/** The states nothing else may leave. */
export const FINISHED_JOB_STATUSES = Object.freeze([
  JOB_STATUS.INSTALLED, JOB_STATUS.FAILED, JOB_STATUS.CANCELED,
]);

/** Where the *build* runs. `worker` is a paired checkout, `server` is this site's own Node process. */
export const BUILD_MODES = Object.freeze(['worker', 'server']);

/** Where the package came from. `upload` is a ZIP an administrator chose, `marketplace` a paid download. */
export const JOB_SOURCES = Object.freeze(['marketplace', 'upload']);

/** How many times one job may be attempted before it is failed for good. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * How long a claim is good for.
 *
 * A build is `npm ci` plus Vite plus obfuscation: minutes on a cold cache, and up to fifteen on a slow link.
 * The lease is longer than that plus the upload, because a lease that expires *during* a healthy build would
 * hand the same job to a second worker. The worker heartbeats, so a live build keeps extending it; only a
 * dead one runs out.
 */
export const JOB_LEASE_MS = 20 * 60 * 1000;

/**
 * The statuses in which a job *owns its project*.
 *
 * A plugin install is not a row: it is a build and then an alias move on one Vercel project. Two jobs for the
 * same project running at once would each build a site containing their own plugin and the second one to
 * reach `READY` would silently replace the first — the customer would be told two plugins installed and find
 * one. So from the moment a job is claimed until the moment it is finished or back in the queue, it holds its
 * project, and every other job for that project waits in `queued`.
 *
 * `queued` is deliberately *not* in this list: queueing is free, and a customer may queue several installs
 * before a build environment is awake. The lock is taken by `claimJobById()`, backed by the partial unique
 * index `rwp_installer_jobs_project_lock_idx` in `schema.sql`, so two workers racing cannot both take it.
 */
export const PROJECT_LOCK_STATUSES = Object.freeze([JOB_STATUS.BUILDING, JOB_STATUS.BUILT, JOB_STATUS.DEPLOYING]);

/**
 * How long a job may sit in `built` — payload ready, deploy not started — before it is treated as abandoned.
 *
 * Long, because the machine that built it may have been closed for the night and the customer may simply not
 * have pressed Deploy yet. The cost of waiting is a project that queues; the cost of being impatient is
 * throwing away a finished build.
 */
export const BUILT_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * How long a job may sit in `deploying` before it is treated as abandoned.
 *
 * `waitForDeployment()` gives up after fifteen minutes, so a job still in `deploying` three waits later is not
 * mid-deploy: its caller died between creating the deployment and recording the answer. Failing it as
 * retryable re-polls the deployment it already created, which is exactly the recovery that exists.
 */
export const DEPLOY_STALE_MS = 45 * 60 * 1000;

/** How many queued rows one claim looks at. Busy projects are skipped, so a small page could miss a free one. */
const CLAIM_SCAN = 20;

/** How many steps of history a job keeps. The UI shows the tail; the history is not a log sink. */
const MAX_STEPS = 24;

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const toIso = (now) => (typeof now === 'function' ? now() : new Date(now)).toISOString();

// ## Records and validation ##

/**
 * The key that makes a re-submitted request the *same* job.
 *
 * Derived from what the customer asked for, not from the request: a marketplace webhook that fires twice, a
 * button double-clicked and a retry after a browser crash all name the same plugin, version, project and
 * source, so they must not each start a build. A deliberate second install differs in one of those fields, or
 * passes `nonce`.
 */
export function jobIdempotencyKey({ source, pluginId, pluginVersion = '', projectName, nonce = '' }) {
  const material = [str(source), str(pluginId), str(pluginVersion), str(projectName), str(nonce)].join('|');
  return `job_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

/** Validates what a job cannot be created without, before a row exists. */
export function assertJobInput({ source, pluginId, pluginVersion = '', projectName, buildMode = 'worker' }) {
  const problems = [];
  if (!JOB_SOURCES.includes(str(source))) problems.push(`source must be one of ${JOB_SOURCES.join(', ')}`);
  if (!PLUGIN_ID_PATTERN.test(str(pluginId))) problems.push('pluginId must be 1-64 lowercase letters, digits or hyphens');
  if (str(pluginVersion) && !VERSION_PATTERN.test(str(pluginVersion))) problems.push('pluginVersion must look like 1.2.3');
  if (!PROJECT_NAME_PATTERN.test(str(projectName))) problems.push('projectName must be the Vercel project\'s own name');
  if (!BUILD_MODES.includes(str(buildMode))) problems.push(`buildMode must be one of ${BUILD_MODES.join(', ')}`);
  if (problems.length) {
    throw new DeployError(400, `That install cannot be started: ${problems.join('; ')}.`, { code: 'job_invalid' });
  }
}

/**
 * A new job row — separate from `createJob()` so the record a caller *would* write can be shown, and
 * asserted, without a store.
 */
export function jobRecord({
  source,
  pluginId,
  pluginVersion = '',
  projectName,
  teamId = '',
  buildMode = 'worker',
  requestedBy = null,
  packageSha256 = '',
  packageSize = 0,
  idempotencyKey = '',
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  migrations = null,
  nonce = '',
  now = () => new Date(),
}) {
  assertJobInput({ source, pluginId, pluginVersion, projectName, buildMode });
  const at = toIso(now);
  return {
    idempotency_key: str(idempotencyKey) || jobIdempotencyKey({ source, pluginId, pluginVersion, projectName, nonce }),
    plugin_id: str(pluginId),
    plugin_version: str(pluginVersion),
    source: str(source),
    build_mode: str(buildMode),
    project_name: str(projectName),
    team_id: str(teamId),
    status: JOB_STATUS.QUEUED,
    step: 'queued',
    progress: 0,
    attempts: 0,
    max_attempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : DEFAULT_MAX_ATTEMPTS,
    error_code: '',
    error_message: '',
    deployment_id: '',
    deployment_url: '',
    worker_id: null,
    lease_expires_at: null,
    package_sha256: str(packageSha256),
    package_size: Number(packageSize) || 0,
    payload_sha256: '',
    payload_size: 0,
    payload_files: 0,
    migrations: migrations && typeof migrations === 'object' ? migrations : null,
    migrations_consent_at: null,
    requested_by: requestedBy || null,
    steps: [{ step: 'queued', at, progress: 0 }],
    created_at: at,
    updated_at: at,
    finished_at: null,
  };
}

/**
 * Creates the job, or returns the one that already exists for this request.
 *
 * `created: false` is not an error: it is the answer to a duplicated marketplace webhook, and the caller
 * should show the same job it showed the first time rather than start a second build. The insert failure
 * path re-reads by key, because two requests can pass the `find` check at once and only one insert can win —
 * the loser must adopt the winner's job, not fail.
 */
export async function createJob({ store, now = () => new Date(), ...input }) {
  const record = jobRecord({ ...input, now });
  const existing = await store.findJobByIdempotencyKey(record.idempotency_key);
  if (existing) return { job: existing, created: false };
  try {
    const job = await store.insertJob(record);
    return { job: job || record, created: true };
  } catch (error) {
    const raced = await store.findJobByIdempotencyKey(record.idempotency_key).catch(() => null);
    if (raced) return { job: raced, created: false };
    throw error;
  }
}

/**
 * The job that currently owns a project, if any.
 *
 * Two readers ask this question: a worker picking something to do (so it skips a project that is mid-install
 * rather than blocking on it) and `claimJobById()` (so a specific job cannot start while its project is busy).
 * `excludeJobId` is the job asking about itself.
 */
export async function projectLockHolder({ store, projectName, excludeJobId = '' }) {
  const name = str(projectName);
  if (!name) return null;
  if (typeof store.findActiveProjectJob === 'function') {
    return await store.findActiveProjectJob(name, { excludeJobId: str(excludeJobId) });
  }
  // A store without the query: fall back to scanning the lock statuses, which is what the query does.
  const rows = await store.listJobs({ statuses: PROJECT_LOCK_STATUSES, limit: 100 });
  return rows.find((row) => str(row.project_name) === name && str(row.id) !== str(excludeJobId)) || null;
}

/**
 * Takes the next queued job, atomically.
 *
 * The loop over the candidates is deliberate: `listJobs` is a read, so between reading and claiming another
 * worker may have taken the row. A compare-and-set that returns null means exactly that, and the next
 * candidate is tried. Returning null after the loop means "nothing to do", which is what an idle worker
 * polls for.
 *
 * Oldest first, and projects that are already building are skipped rather than waited on: an idle worker
 * should find work, and a queued install for a *different* project is work. The skipped job stays `queued`
 * and is claimed by whoever polls next after its project's current install finishes.
 */
export async function claimJob({ store, workerId, now = () => new Date(), leaseMs = JOB_LEASE_MS }) {
  const id = str(workerId);
  if (!id) throw new DeployError(400, 'A worker id is required to claim a job.', { code: 'worker_missing' });
  const candidates = await store.listJobs({ statuses: [JOB_STATUS.QUEUED], limit: CLAIM_SCAN, order: 'oldest' });
  for (const candidate of candidates) {
    try {
      const claimed = await claimJobById({ store, jobId: candidate.id, workerId: id, now, leaseMs });
      if (claimed) return claimed;
    } catch (error) {
      // The project is being installed right now, or another worker won the row: both mean "try the next one".
      if (str(error?.code) !== 'project_busy') throw error;
    }
  }
  return null;
}

/**
 * Claims one *specific* job — the shape the site's own server needs, because it was asked to run this job and
 * not "whatever is queued". Same compare-and-set as `claimJob()`, so a paired worker and the server can never
 * both own it.
 *
 * A project that another job is already installing is a `409 project_busy` rather than `null`: `null` means
 * "somebody claimed this row a moment ago", and a person pressing Build deserves to be told which of the two
 * happened. The unique index behind the check is what makes it true under a race, not this read.
 */
export async function claimJobById({ store, jobId, workerId, now = () => new Date(), leaseMs = JOB_LEASE_MS }) {
  const id = str(jobId);
  const worker = str(workerId);
  if (!id || !worker) throw new DeployError(400, 'A job id and a worker id are required to claim a job.', { code: 'job_missing' });
  const job = await store.findJob(id);
  if (!job) throw new DeployError(404, 'That install job does not exist.', { code: 'job_missing' });
  if (job.status !== JOB_STATUS.QUEUED) return null;
  const holder = await projectLockHolder({ store, projectName: job.project_name, excludeJobId: id });
  if (holder) {
    throw new DeployError(
      409,
      `Another install for ${str(job.project_name)} is in progress (${str(holder.plugin_id)} — ${str(holder.status)}), so this one stays queued. It starts as soon as that install finishes.`,
      { code: 'project_busy', details: { blockingJobId: str(holder.id), blockingStatus: str(holder.status) } },
    );
  }
  const at = new Date(toIso(now));
  const history = Array.isArray(job.steps) ? job.steps : [];
  return await store.updateJob({
    id,
    expect: [JOB_STATUS.QUEUED],
    patch: {
      status: JOB_STATUS.BUILDING,
      step: 'claimed',
      worker_id: worker,
      attempts: (Number(job.attempts) || 0) + 1,
      lease_expires_at: new Date(at.getTime() + leaseMs).toISOString(),
      updated_at: at.toISOString(),
      steps: [...history, { step: 'claimed', at: at.toISOString(), progress: Number(job.progress) || 0 }].slice(-MAX_STEPS),
    },
  });
}

/**
 * Extends a claim, while a worker builds.
 *
 * `expectWorker` is part of the compare-and-set: a job whose lease expired and was claimed by another worker
 * must not have its lease extended by the worker that lost it. The loser gets null, and its next upload is
 * refused by `attachArtifact` for the same reason.
 */
export async function heartbeatJob({ store, jobId, workerId, now = () => new Date(), leaseMs = JOB_LEASE_MS }) {
  return await store.updateJob({
    id: str(jobId),
    expect: [JOB_STATUS.BUILDING],
    expectWorker: str(workerId),
    patch: {
      lease_expires_at: new Date(new Date(toIso(now)).getTime() + leaseMs).toISOString(),
      updated_at: toIso(now),
    },
  });
}

/**
 * Records a step and its progress.
 *
 * Progress never goes backwards: a worker that repeats an earlier step (a retried upload, say) would
 * otherwise make the bar jump back and look like the job restarted. The step *name* is still recorded,
 * because the history is how an operator sees that the retry happened.
 */
export async function setJobStep({ store, jobId, step, progress, workerId = '', note = '', now = () => new Date() }) {
  const job = await store.findJob(str(jobId));
  if (!job) throw new DeployError(404, 'That install job does not exist.', { code: 'job_missing' });
  if (FINISHED_JOB_STATUSES.includes(job.status)) return job;
  const wanted = Number(progress);
  const next = Number.isFinite(wanted)
    ? Math.min(100, Math.max(Number(job.progress) || 0, Math.round(wanted)))
    : Number(job.progress) || 0;
  const at = toIso(now);
  const name = str(step) || job.step;
  const history = Array.isArray(job.steps) ? job.steps : [];
  const steps = history.length && history[history.length - 1]?.step === name
    ? history
    : [...history, { step: name, at, progress: next, ...(str(note) ? { note: str(note) } : {}) }].slice(-MAX_STEPS);
  return await store.updateJob({
    id: job.id,
    expect: ACTIVE_JOB_STATUSES,
    ...(str(workerId) ? { expectWorker: str(workerId) } : {}),
    patch: { step: name, progress: next, steps, updated_at: at },
  });
}

/**
 * The built payload has arrived: `building -> built`.
 *
 * Only the worker that holds the lease may do this (`expectWorker`), and only once: an upload after the job
 * has moved on returns null, which the route reports as 409 rather than silently accepting bytes nobody will
 * deploy.
 */
export async function attachArtifact({ store, jobId, workerId, sha256, size, files, now = () => new Date() }) {
  return await store.updateJob({
    id: str(jobId),
    expect: [JOB_STATUS.BUILDING],
    ...(str(workerId) ? { expectWorker: str(workerId) } : {}),
    patch: {
      status: JOB_STATUS.BUILT,
      step: 'built',
      progress: 100,
      payload_sha256: str(sha256),
      payload_size: Number(size) || 0,
      payload_files: Number(files) || 0,
      lease_expires_at: null,
      updated_at: toIso(now),
    },
  });
}

/** `built -> deploying`. The compare-and-set stops two pollers uploading the same payload twice. */
export async function beginDeploy({ store, jobId, now = () => new Date() }) {
  return await store.updateJob({
    id: str(jobId),
    expect: [JOB_STATUS.BUILT],
    patch: { status: JOB_STATUS.DEPLOYING, step: 'uploading', worker_id: null, updated_at: toIso(now) },
  });
}

/**
 * Remembers the deployment Vercel created.
 *
 * This is the whole of "resumable": a job that times out waiting for `READY` keeps this id, and the next
 * advance polls *this* deployment instead of uploading a second one. Vercel builds and bills both, so a
 * duplicate here is real money and a real race for the project's alias.
 */
export async function recordDeployment({ store, jobId, deploymentId, deploymentUrl = '', now = () => new Date() }) {
  return await store.updateJob({
    id: str(jobId),
    expect: [JOB_STATUS.DEPLOYING],
    patch: {
      deployment_id: str(deploymentId),
      deployment_url: str(deploymentUrl),
      step: 'vercel-building',
      progress: 90,
      updated_at: toIso(now),
    },
  });
}

/** `deploying -> installed`. The only writer of this status, and only after Vercel answered `READY`. */
export async function markInstalled({ store, jobId, deployment = {}, now = () => new Date() }) {
  const at = toIso(now);
  const job = await store.findJob(str(jobId));
  if (!job) throw new DeployError(404, 'That install job does not exist.', { code: 'job_missing' });
  if (job.status === JOB_STATUS.INSTALLED) return job;
  const history = Array.isArray(job.steps) ? job.steps : [];
  return await store.updateJob({
    id: job.id,
    expect: [JOB_STATUS.DEPLOYING],
    patch: {
      status: JOB_STATUS.INSTALLED,
      step: 'installed',
      progress: 100,
      deployment_id: str(deployment.id) || str(job.deployment_id),
      deployment_url: str(deployment.deploymentUrl) || str(job.deployment_url),
      lease_expires_at: null,
      finished_at: at,
      updated_at: at,
      steps: [...history, { step: 'installed', at, progress: 100 }].slice(-MAX_STEPS),
    },
  });
}

/**
 * Records a failure, and decides whether it is worth another attempt.
 *
 * `retryable` is the caller's judgement — a build that fails on a TypeScript error is not retryable, a lease
 * that expired is — and the attempt budget is what turns "retryable" into a bounded number of builds instead
 * of a loop that spends the customer's Vercel minutes.
 */
export async function markFailed({ store, jobId, code = '', message = '', retryable = false, now = () => new Date() }) {
  const job = await store.findJob(str(jobId));
  if (!job) throw new DeployError(404, 'That install job does not exist.', { code: 'job_missing' });
  if (job.status === JOB_STATUS.INSTALLED || job.status === JOB_STATUS.CANCELED) return job;
  const attempts = Number(job.attempts) || 0;
  const maxAttempts = Number(job.max_attempts) || DEFAULT_MAX_ATTEMPTS;
  const again = Boolean(retryable) && attempts < maxAttempts;
  const at = toIso(now);
  const history = Array.isArray(job.steps) ? job.steps : [];
  const patch = {
    status: again ? JOB_STATUS.QUEUED : JOB_STATUS.FAILED,
    step: again ? 'retrying' : 'failed',
    error_code: str(code),
    error_message: str(message),
    worker_id: null,
    lease_expires_at: null,
    updated_at: at,
    steps: [
      ...history,
      { step: again ? 'retrying' : 'failed', at, progress: Number(job.progress) || 0, note: str(code) },
    ].slice(-MAX_STEPS),
  };
  if (!again) patch.finished_at = at;
  return await store.updateJob({ id: job.id, expect: ACTIVE_JOB_STATUSES, patch });
}

/** An operator's "stop": no refund for work already done, but nothing further is deployed. */
export async function cancelJob({ store, jobId, now = () => new Date() }) {
  const job = await store.findJob(str(jobId));
  if (!job) throw new DeployError(404, 'That install job does not exist.', { code: 'job_missing' });
  if (FINISHED_JOB_STATUSES.includes(job.status)) {
    throw new DeployError(409, `That install is already ${job.status}, so there is nothing to cancel.`, { code: 'job_finished' });
  }
  const at = toIso(now);
  return await store.updateJob({
    id: job.id,
    expect: ACTIVE_JOB_STATUSES,
    patch: {
      status: JOB_STATUS.CANCELED,
      step: 'canceled',
      worker_id: null,
      lease_expires_at: null,
      finished_at: at,
      updated_at: at,
    },
  });
}

/**
 * Puts back the jobs of workers that died, and the jobs whose owner vanished between two steps.
 *
 * Without this, a laptop closed mid-build would leave a job in `building` forever and the customer's plugin
 * would never install. The lease is the only signal available — there is no session to notice — so expiry is
 * treated as a retryable failure, which costs one more build and never a manual fix.
 *
 * A job that reached `built` or `deploying` has no lease, because nobody is holding it: the payload is safe in
 * the database and any caller may take the next step. So it is aged instead — `BUILT_STALE_MS` for a payload
 * nobody deployed, `DEPLOY_STALE_MS` for a deployment record nobody followed up. Both matter for the project
 * lock as much as for the job: a stuck job in one of those states keeps its project queued for everyone else,
 * and an operator should never have to discover that by hand.
 */
export async function requeueExpiredLeases({ store, now = () => new Date() }) {
  const at = new Date(toIso(now)).getTime();
  const requeued = [];

  /** Marks one stale row retryable, and collects it when that worked. */
  const expire = async (row, { code, message }) => {
    const job = await markFailed({ store, jobId: row.id, code, message, retryable: true, now }).catch(() => null);
    if (job) requeued.push(job);
  };

  const building = await store.listJobs({ statuses: [JOB_STATUS.BUILDING], limit: 50 });
  for (const row of building) {
    const lease = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
    if (!lease || lease > at) continue;
    await expire(row, {
      code: 'lease_expired',
      message: 'The build environment stopped reporting progress, so the install was put back in the queue. It is picked up again when a worker asks for work.',
    });
  }

  // `built` and `deploying` are separate queries with separate ages, so a long queue of payloads waiting for a
  // deploy cannot hide a stuck one behind the page limit.
  for (const [status, staleMs, code, message] of [
    [
      JOB_STATUS.BUILT,
      BUILT_STALE_MS,
      'deploy_abandoned',
      'The build was finished hours ago but was never deployed, so it was put back in the queue to be built again.',
    ],
    [
      JOB_STATUS.DEPLOYING,
      DEPLOY_STALE_MS,
      'deploy_stalled',
      'The deployment stopped being followed, so the install was put back in the queue. The next attempt checks the deployment it already created rather than uploading a second one.',
    ],
  ]) {
    const rows = await store.listJobs({ statuses: [status], limit: 50 });
    for (const row of rows) {
      const touched = new Date(str(row.updated_at) || str(row.created_at) || 0).getTime();
      if (!touched || at - touched < staleMs) continue;
      await expire(row, { code, message });
    }
  }

  return requeued;
}

/**
 * Deletes finished jobs past their retention, and the artifact rows that went with them.
 *
 * An artifact is a whole built site, so keeping them forever is a database that grows by megabytes per
 * install. `deleteArtifact` is optional so a store without one (a test) can still run this.
 */
export async function cleanupJobs({ store, now = () => new Date(), retentionMs = 7 * 24 * 60 * 60 * 1000 }) {
  const at = new Date(toIso(now)).getTime();
  const rows = await store.listJobs({ statuses: FINISHED_JOB_STATUSES, limit: 100 });
  const deleted = [];
  for (const row of rows) {
    const finished = row.finished_at ? new Date(row.finished_at).getTime() : 0;
    if (finished && at - finished < retentionMs) continue;
    if (typeof store.deleteArtifact === 'function') await store.deleteArtifact(row.id).catch(() => {});
    if (await store.deleteJob(row.id)) deleted.push(row.id);
  }
  return deleted;
}

/** Every job, newest first — the list the dashboard shows. */
export async function listJobs({ store, statuses = null, limit = 20 } = {}) {
  const wanted = Array.isArray(statuses) && statuses.length
    ? statuses.filter((status) => JOB_STATUSES.includes(status))
    : null;
  return await store.listJobs({ statuses: wanted, limit });
}

/**
 * The shape a screen and a worker both read.
 *
 * `stalled` is computed rather than stored: a job whose lease ran out *now* is the one thing a reader needs to
 * see before the next cleanup pass touches it. Nothing here is a token, a path or a file.
 */
export function publicJob(row, { now = () => new Date() } = {}) {
  const at = new Date(toIso(now)).getTime();
  const lease = row?.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
  const status = str(row?.status);
  const code = str(row?.error_code);
  const message = str(row?.error_message);
  return {
    id: str(row?.id),
    pluginId: str(row?.plugin_id),
    pluginVersion: str(row?.plugin_version),
    source: str(row?.source),
    buildMode: str(row?.build_mode),
    projectName: str(row?.project_name),
    status,
    step: str(row?.step),
    progress: Number(row?.progress) || 0,
    attempts: Number(row?.attempts) || 0,
    maxAttempts: Number(row?.max_attempts) || DEFAULT_MAX_ATTEMPTS,
    error: code || message ? { code, message } : null,
    deployment: str(row?.deployment_id) ? { id: str(row?.deployment_id), url: str(row?.deployment_url) } : null,
    payload: {
      sha256: str(row?.payload_sha256),
      bytes: Number(row?.payload_size) || 0,
      files: Number(row?.payload_files) || 0,
    },
    migrations: row?.migrations && typeof row.migrations === 'object' ? row.migrations : null,
    migrationConsentAt: str(row?.migrations_consent_at),
    steps: Array.isArray(row?.steps) ? row.steps : [],
    finished: FINISHED_JOB_STATUSES.includes(status),
    active: ACTIVE_JOB_STATUSES.includes(status),
    stalled: status === JOB_STATUS.BUILDING && Boolean(lease) && lease <= at,
    canRetry: [JOB_STATUS.FAILED, JOB_STATUS.CANCELED].includes(status)
      && (Number(row?.attempts) || 0) < (Number(row?.max_attempts) || DEFAULT_MAX_ATTEMPTS),
    createdAt: str(row?.created_at),
    updatedAt: str(row?.updated_at),
    finishedAt: str(row?.finished_at),
  };
}

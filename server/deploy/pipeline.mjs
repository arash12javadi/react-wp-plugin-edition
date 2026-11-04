/**
 * One step of an install job, end to end: build (or receive a build), upload it to Vercel, wait for `READY`.
 *
 * Why a step machine and not a queue worker
 * ----------------------------------------
 * The site this runs on is usually a serverless function that is suspended between requests. A process that
 * "runs in the background" does not exist there: the invocation that returns is frozen. So progress is made
 * *when someone asks* — a worker hands in a build, a dashboard polls, a cron pokes — and each call does the
 * next bounded thing and returns. That is what makes the same code work on `server.mjs`, on the Hono host and
 * on Vercel, and it is why every transition is a compare-and-set in the job store: two pollers racing is
 * normal, and only one of them may upload.
 *
 * Where the build happens
 * -----------------------
 * `builder` is injected, and there are two shapes of it:
 *
 *   - **not provided** — the job waits for a *paired build environment*: a checkout with Node and the plugin
 *     installed, on the customer's machine or CI, which claims the job, builds it with
 *     `server/deploy/prebuilt.mjs`, and uploads the payload (`scripts/rwpBuildWorker.mjs`). This is the only
 *     option on a host that cannot build, which is every Vercel deployment: `npm ci && vite build` needs a
 *     repository checkout, writes hundreds of megabytes and takes minutes, none of which a function may do.
 *   - **provided** — the site's own Node process builds in place, which is what a `npm start` deployment can
 *     do today (`localBuildEnabled()`), and what a test stubs out.
 *
 * The deploy half is the same in both cases, and it is the half where the failure has to be handled
 * carefully:
 *
 *   - The payload is verified (`readArtifact`) before a single byte is uploaded.
 *   - `assertDeployPayload()` — the allowlist in `prebuilt.mjs` — runs on the assembled tree, so a worker
 *     cannot smuggle `src/` into a customer's project by building it itself.
 *   - `markInstalled` is reached only through `waitForDeployment`, i.e. only after Vercel reports `READY`.
 *     A build that fails leaves the alias on the previous deployment, and the plugin is not activated.
 *
 * One build per project, too. A job owns its Vercel project from the claim until it finishes, so a job that would
 * start while another install for the same project is running is reported as `{ queuedBehind: true }` — it stays
 * `queued` and is claimed when the project is free, rather than building a second deployment that would replace
 * the first one's plugin.
 */
import {
  ACTIVE_JOB_STATUSES, FINISHED_JOB_STATUSES, JOB_STATUS, attachArtifact, beginDeploy, claimJobById,
  markFailed, markInstalled, recordDeployment, setJobStep,
} from './jobs.mjs';
import { payloadZipToFiles, readArtifact } from './artifacts.mjs';
import { DeployError } from './errors.mjs';
import { assertDeployPayload } from './prebuilt.mjs';
import { createFileDeployment, waitForDeployment } from './vercelApi.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** The defaults, so a caller passes only what it wants to fake. */
const defaultVercel = { createFileDeployment, waitForDeployment };

const toIso = (now) => (typeof now === 'function' ? now() : new Date(now)).toISOString();

/**
 * Which failures are worth another attempt.
 *
 * A `deployment_failed` is Vercel's own build saying no: the same bytes would fail the same way, so retrying
 * spends the customer's minutes for nothing. Everything a network or a timeout did is worth another go, and
 * the attempt budget in `markFailed()` is what bounds it.
 */
export function isRetryableDeployFailure(error) {
  const code = str(error?.code);
  if (code === 'deployment_failed') return false;
  if (['payload_unsafe_path', 'payload_unreadable', 'payload_empty', 'payload_too_large', 'artifact_digest_mismatch'].includes(code)) return false;
  const status = Number(error?.status);
  return code === 'deployment_timeout' || status === 504 || status === 502 || status === 429;
}

/** The sentence a failure is recorded with: its own message, never a stack and never a token. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error || 'The install failed.'));

/** The `meta` Vercel records on the deployment, so its own dashboard says which plugin produced it. */
const deploymentMeta = (job) => ({
  rwpPlugin: str(job.plugin_id),
  rwpPluginVersion: str(job.plugin_version),
  rwpJobId: str(job.id),
  rwpPayload: 'prebuilt',
  rwpInstaller: 'plugin-job',
});

/**
 * Uploads a payload and waits for it to be `READY` — the half both build paths share.
 *
 * The order here is the whole of "the previous deployment is preserved": nothing is deleted, nothing is
 * repointed, and `installed` is written only after Vercel reports `READY`. A failure at any point leaves the
 * project serving exactly what it served before, which is what makes `failed` safe to show a customer.
 */
async function deployPayload({ store, job, files, resolveCredential, vercel, onInstalled, now }) {
  const credential = await resolveCredential();
  if (!credential?.token) {
    throw new DeployError(503, 'This job has no Vercel token to deploy with. Save one for the project first.', { code: 'credential_missing' });
  }
  await beginDeploy({ store, jobId: job.id, now });
  let current = (await store.findJob(job.id)) || job;
  // A job that is already `installed` (a second poller, a reloaded page) is not deployed a second time.
  if (current.status === JOB_STATUS.INSTALLED) return { job: current, state: JOB_STATUS.INSTALLED, done: true };

  if (!str(current.deployment_id)) {
    const deployment = await vercel.createFileDeployment(credential.token, {
      projectName: credential.projectName || current.project_name,
      projectId: credential.projectId,
      teamId: credential.teamId,
      files,
      meta: deploymentMeta(current),
    });
    if (!deployment?.id) {
      throw new DeployError(502, 'Vercel accepted the upload but did not return a deployment id, so this job cannot be followed. Check the project in Vercel.', { code: 'deployment_unidentified' });
    }
    await recordDeployment({ store, jobId: current.id, deploymentId: deployment.id, deploymentUrl: deployment.url, now });
    current = (await store.findJob(current.id)) || current;
  }

  const ready = await vercel.waitForDeployment(credential.token, {
    deploymentId: current.deployment_id,
    teamId: credential.teamId,
  });
  const installed = (await markInstalled({ store, jobId: current.id, deployment: ready, now })) || current;
  if (typeof onInstalled === 'function') await onInstalled({ job: installed, deployment: ready });
  return { job: installed, state: JOB_STATUS.INSTALLED, deployment: ready, done: true };
}

/**
 * Advances one job by one step. Idempotent: calling it twice never deploys twice.
 *
 * The return value says what happened, and every branch is one of four things:
 *   - `awaitingBuilder` — nothing to do here; a worker (or a builder) has to produce the payload.
 *   - `retryLater` — Vercel is still building, or the wait timed out. Nothing failed; poll again.
 *   - `done` — `installed`, or a job that was already finished.
 *   - `failed` — the job is failed and the sentence is in `job.error`.
 */
export async function advanceJob({
  store,
  jobId,
  resolveCredential = async () => {
    throw new DeployError(503, 'This job has no stored Vercel token, so it cannot deploy. Save one for the project first.', { code: 'credential_missing' });
  },
  builder = null,
  vercel = defaultVercel,
  assertFiles = assertDeployPayload,
  onInstalled = null,
  now = () => new Date(),
}) {
  const job = await store.findJob(str(jobId));
  if (!job) throw new DeployError(404, 'That install job does not exist.', { code: 'job_missing' });
  if (FINISHED_JOB_STATUSES.includes(job.status)) return { job, state: job.status, done: true };

  if (job.status === JOB_STATUS.QUEUED) {
    if (typeof builder !== 'function') return { job, state: JOB_STATUS.QUEUED, awaitingBuilder: true };
    let claimed = null;
    try {
      claimed = await claimJobById({ store, jobId: job.id, workerId: 'server', now });
    } catch (error) {
      // Another install for the same project holds it. Nothing failed and nothing is deployed: the job is
      // still queued, and this answers with the sentence that says so.
      if (str(error?.code) !== 'project_busy') throw error;
      return {
        job: (await store.findJob(job.id)) || job,
        state: JOB_STATUS.QUEUED,
        queuedBehind: true,
        reason: messageOf(error),
      };
    }
    // Someone else got there first (a worker claimed it between the read and the write): report, do not retry.
    if (!claimed) return { job: (await store.findJob(job.id)) || job, state: job.status, awaitingBuilder: true };
    await setJobStep({ store, jobId: job.id, step: 'building', progress: 20, workerId: 'server', now });
    let files;
    try {
      const built = await builder({ job: claimed, store, now });
      files = built?.files instanceof Map ? built.files : null;
    } catch (error) {
      const failed = await markFailed({
        store,
        jobId: job.id,
        code: str(error?.code) || 'build_failed',
        message: messageOf(error),
        retryable: Boolean(error?.retryable),
        now,
      });
      return { job: failed || claimed, state: JOB_STATUS.FAILED, error };
    }
    if (!files || files.size === 0) {
      const failed = await markFailed({
        store,
        jobId: job.id,
        code: 'build_empty',
        message: 'The build produced no deployable files, so nothing was deployed.',
        now,
      });
      return { job: failed || claimed, state: JOB_STATUS.FAILED };
    }
    try {
      assertFiles(files, str(job.plugin_id));
    } catch (error) {
      const failed = await markFailed({
        store,
        jobId: job.id,
        code: 'payload_rejected',
        message: messageOf(error),
        now,
      });
      return { job: failed || claimed, state: JOB_STATUS.FAILED, error };
    }
    await setJobStep({ store, jobId: job.id, step: 'built', progress: 80, workerId: 'server', now });
    await attachArtifact({ store, jobId: job.id, workerId: 'server', sha256: '', size: 0, files: files.size, now });
    return await deploySafely({ store, job, files, resolveCredential, vercel, onInstalled, now });
  }

  // A worker has finished a payload: the same deploy, from the uploaded bytes.
  if (job.status === JOB_STATUS.BUILT || job.status === JOB_STATUS.DEPLOYING) {
    if (job.status === JOB_STATUS.DEPLOYING && str(job.deployment_id)) {
      return await deploySafely({ store, job, files: null, resolveCredential, vercel, onInstalled, now });
    }
    let files;
    try {
      const artifact = await readArtifact({ store, jobId: job.id, kind: 'payload', expectedSha256: str(job.payload_sha256) });
      files = payloadZipToFiles(artifact.bytes);
      assertFiles(files, str(job.plugin_id));
    } catch (error) {
      // A payload that is incomplete is worth another upload; one that is rejected by the allowlist is not.
      const failed = await markFailed({
        store,
        jobId: job.id,
        code: str(error?.code) || 'payload_rejected',
        message: messageOf(error),
        retryable: ['artifact_incomplete', 'artifact_missing'].includes(str(error?.code)),
        now,
      });
      return { job: failed || job, state: failed?.status || JOB_STATUS.FAILED, error };
    }
    return await deploySafely({ store, job, files, resolveCredential, vercel, onInstalled, now });
  }

  // `building`: a worker is on it. Nothing to do but say so.
  return { job, state: job.status, awaitingBuilder: true };
}

/** `deployPayload()` with the failure policy around it: retryable becomes "later", the rest becomes `failed`. */
async function deploySafely({ store, job, files, resolveCredential, vercel, onInstalled, now }) {
  try {
    return await deployPayload({ store, job, files, resolveCredential, vercel, onInstalled, now });
  } catch (error) {
    const code = str(error?.code);
    // A wait that ran out is not a failure: the deployment exists, and the next poll picks it up where this
    // one left off. Marking it failed would throw away a build that is very likely still running.
    if (code === 'deployment_timeout') {
      const latest = (await store.findJob(job.id)) || job;
      return { job: latest, state: latest.status, retryLater: true, error };
    }
    const failed = await markFailed({
      store,
      jobId: job.id,
      code: code || 'deploy_failed',
      message: messageOf(error),
      retryable: isRetryableDeployFailure(error),
      now,
    });
    return { job: failed || job, state: failed?.status || JOB_STATUS.FAILED, error };
  }
}

/** True while a job is worth another `advanceJob()` call. Used by the routes to decide what to answer. */
export const jobIsAdvanceable = (job) => ACTIVE_JOB_STATUSES.includes(str(job?.status));


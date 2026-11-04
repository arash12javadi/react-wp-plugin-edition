#!/usr/bin/env node
/**
 * The build environment: the machine that compiles a plugin into a site and hands the result back.
 *
 * Why this is a separate process
 * -----------------------------
 * A React-WP site on Vercel is a static bundle plus serverless functions. Installing a plugin means recompiling
 * that bundle with the plugin in it — `npm ci`, Vite, the obfuscation pass — which cannot happen inside a
 * serverless function: there is no checkout, the filesystem is read-only apart from `/tmp`, and the invocation is
 * gone in seconds. So the build runs where the source is: **this machine**, with the repository checked out.
 *
 * What it is allowed to do
 * -----------------------
 * A worker holds one credential of its own (`rwpw_…`, from a pairing code), and with it can claim a queued install,
 * read the plugin package, read the deployment's build variables, and hand back a payload. It cannot choose a
 * project, create a job, activate a plugin or deploy: the deployment is made by the site's own server, with the
 * Vercel token sealed in its database, which never travels here. A leaked worker token costs a wasted build, not a
 * deployment to the customer's account.
 *
 * Usage
 * -----
 *   npm run install:worker -- --site https://my-site.example --code ABCDE-FGHJK
 *   RWP_SITE_URL=https://my-site.example RWP_WORKER_TOKEN=rwpw_… npm run install:worker
 *
 * `--once` claims at most one job and exits, which is what a CI job wants; without it the worker polls. Each step
 * is printed, so a terminal (or a CI log) shows the same progress the dashboard shows.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unpack } from '../server/pluginInstaller.mjs';
import { ARTIFACT_CHUNK_BYTES, filesToZip, sha256Of } from '../server/deploy/artifacts.mjs';
import { buildSiteWithPlugin, clientBuildEnv, readRepoFiles } from '../server/deploy/repoBuild.mjs';
import { WORKER_TOKEN_PREFIX } from '../server/deploy/workerAuth.mjs';

const PLUGIN_ID = 'rwp-saas-installer';
const TOKEN_FILE = path.resolve('.rwp-worker.json');
/** How often a heartbeat is sent while a build runs, so a slow build is not mistaken for a dead worker. */
const HEARTBEAT_MS = 2 * 60 * 1000;

const args = (() => {
  const parsed = { once: false, interval: 15, name: '' };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') parsed.once = true;
    else if (arg === '--site') parsed.site = argv[++index];
    else if (arg === '--code') parsed.code = argv[++index];
    else if (arg === '--token') parsed.token = argv[++index];
    else if (arg === '--name') parsed.name = argv[++index];
    else if (arg === '--interval') parsed.interval = Number(argv[++index]) || 15;
    else if (arg.startsWith('--site=')) parsed.site = arg.slice(7);
    else if (arg.startsWith('--code=')) parsed.code = arg.slice(7);
    else if (arg.startsWith('--token=')) parsed.token = arg.slice(8);
    else if (arg.startsWith('--name=')) parsed.name = arg.slice(7);
  }
  return parsed;
})();

const say = (message) => console.log(`[install-worker] ${message}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const site = String(args.site || process.env.RWP_SITE_URL || '').replace(/\/+$/, '');
if (!site) {
  console.error('A site is required: npm run install:worker -- --site https://my-site.example --code XXXXX-XXXXX');
  process.exit(1);
}

/** One call to the site's plugin routes. `token` is the worker's own; it is never logged. */
async function call(pathname, { method = 'GET', body, token = '', raw = false } = {}) {
  const response = await fetch(`${site}/api/plugins/${PLUGIN_ID}/${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(raw ? 120_000 : 60_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 500) };
  }
  if (!response.ok || payload?.success === false) {
    const error = new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.code || '';
    throw error;
  }
  return payload || {};
}

/** A stored token, so a run does not need the pairing code twice. */
async function savedToken() {
  if (args.token) return args.token;
  if (process.env.RWP_WORKER_TOKEN) return process.env.RWP_WORKER_TOKEN;
  try {
    const saved = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    if (typeof saved.token === 'string' && saved.token.startsWith(WORKER_TOKEN_PREFIX)) return saved.token;
  } catch {
    // No file yet: the pairing code below is the other way in.
  }
  return '';
}

/** Pairs this machine, and keeps the token where the next run can find it (mode 600 where the OS allows it). */
async function pair() {
  const code = String(args.code || process.env.RWP_WORKER_CODE || '').trim();
  if (!code) {
    console.error('Pairing needs the code from Settings → Integrations → Plugin installs: --code XXXXX-XXXXX');
    process.exit(1);
  }
  const name = args.name || process.env.RWP_WORKER_NAME || `${process.platform}-${process.env.USERNAME || process.env.USER || 'machine'}`;
  const answer = await call('worker/pair', { method: 'POST', body: { code, name } });
  await writeFile(TOKEN_FILE, JSON.stringify({ site, token: answer.token, worker: answer.worker }, null, 2), { mode: 0o600 }).catch(() => {});
  say(`paired as "${answer.worker?.name || name}" (${answer.worker?.prefix || 'token'}…). The token is in ${TOKEN_FILE}; keep it out of git.`);
  return answer.token;
}

/** Reads a package, chunk by chunk, and checks it against the digest the job recorded. */
async function fetchPackage(token, jobId) {
  const first = await call(`worker/jobs/${jobId}/package?chunk=0`, { token });
  const total = Number(first.total) || 1;
  const chunks = [Buffer.from(first.data, 'base64')];
  for (let index = 1; index < total; index += 1) {
    const next = await call(`worker/jobs/${jobId}/package?chunk=${index}`, { token });
    chunks.push(Buffer.from(next.data, 'base64'));
  }
  const bytes = Buffer.concat(chunks);
  const digest = sha256Of(bytes);
  if (first.sha256 && digest !== first.sha256) {
    throw Object.assign(new Error(`The package the site sent does not match its digest (${digest.slice(0, 12)}… instead of ${String(first.sha256).slice(0, 12)}…).`), { code: 'package_digest_mismatch' });
  }
  say(`package: ${bytes.length} bytes, ${total} chunk(s), sha256 ${digest.slice(0, 12)}…`);
  return bytes;
}

/** Uploads the built payload in chunks, then tells the site it is complete. */
async function uploadPayload(token, jobId, files) {
  const zip = filesToZip(files);
  const digest = sha256Of(zip);
  const total = Math.max(1, Math.ceil(zip.length / ARTIFACT_CHUNK_BYTES));
  for (let index = 0; index < total; index += 1) {
    const slice = zip.subarray(index * ARTIFACT_CHUNK_BYTES, (index + 1) * ARTIFACT_CHUNK_BYTES);
    await call(`worker/jobs/${jobId}/payload/${index}`, {
      method: 'PUT',
      token,
      body: { total, size: zip.length, sha256: digest, data: slice.toString('base64') },
    });
    if (total > 1) say(`uploaded chunk ${index + 1}/${total}`);
  }
  say(`payload: ${files.size} file(s), ${zip.length} bytes, sha256 ${digest.slice(0, 12)}…`);
  return await call(`worker/jobs/${jobId}/payload`, {
    method: 'POST',
    token,
    body: { sha256: digest, size: zip.length, files: files.size },
  });
}

/** The build's own digest of the plugin package — printed so a log says exactly what was compiled. */
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;

/**
 * One claimed job, from package to payload.
 *
 * The heartbeat runs on a timer beside the build: `npm ci` plus Vite plus obfuscation easily outlives the lease, and
 * a lease that expires mid-build would hand the same job to a second machine — the duplicate work the claim exists
 * to prevent.
 */
async function runJob(token, job) {
  say(`claimed ${job.pluginId} ${job.pluginVersion || ''} for ${job.projectName} (job ${job.id})`);
  let heartbeat = setInterval(() => {
    call(`worker/jobs/${job.id}/heartbeat`, { method: 'POST', token }).catch((error) => say(`heartbeat failed: ${error.message}`));
  }, HEARTBEAT_MS);
  try {
    const packageBytes = await fetchPackage(token, job.id);
    say(`plugin package ${digestOf(packageBytes)}`);
    const entries = unpack(packageBytes);
    await call(`worker/jobs/${job.id}/step`, { method: 'POST', token, body: { step: 'reading-build-env', progress: 15 } });

    // The deployment's own variables — what Vercel's build would have had. Falling back to this machine's `VITE_*`
    // is deliberate and announced: a bundle built with the wrong Supabase settings would come up uninstalled.
    let env = clientBuildEnv();
    try {
      const answer = await call(`worker/jobs/${job.id}/build-env`, { token });
      if (answer.env && Object.keys(answer.env).length) {
        env = { ...env, ...answer.env };
        say(`using ${Object.keys(answer.env).length} variable(s) read from the Vercel project`);
      } else {
        say('the Vercel project has no variables to read; building with this machine\'s VITE_* values');
      }
    } catch (error) {
      say(`could not read the project's variables (${error.message}); building with this machine's VITE_* values`);
    }

    await call(`worker/jobs/${job.id}/step`, { method: 'POST', token, body: { step: 'reading-site', progress: 25 } });
    const repoFiles = await readRepoFiles({ log: (line) => say(line) });
    say(`read ${repoFiles.size} file(s) from ${process.cwd()}`);

    await call(`worker/jobs/${job.id}/step`, { method: 'POST', token, body: { step: 'building', progress: 35 } });
    const built = await buildSiteWithPlugin({
      repoFiles,
      pluginId: job.pluginId,
      entries,
      env,
      version: job.pluginVersion,
      label: `${job.pluginId}@${job.pluginVersion || 'plugin'}`,
      log: (line) => say(line),
    });
    say(`built ${built.files.size} deployable file(s)`);

    // The timer is cleared before the upload: the site extends nothing from here, and a heartbeat that arrives after
    // the payload would only race the deploy.
    clearInterval(heartbeat);
    heartbeat = null;
    await call(`worker/jobs/${job.id}/step`, { method: 'POST', token, body: { step: 'uploading', progress: 70 } });
    const answer = await uploadPayload(token, job.id, built.files);
    say(answer.message || `the install is ${answer.state}`);
    return answer;
  } catch (error) {
    const code = String(error?.code || 'build_failed');
    const message = error instanceof Error ? error.message : 'The build failed.';
    console.error(`[install-worker] ${job.id} failed: ${message}`);
    await call(`worker/jobs/${job.id}/fail`, {
      method: 'POST',
      token,
      body: { code, message, retryable: !['package_digest_mismatch', 'payload_unsafe_path'].includes(code) },
    }).catch((reportError) => say(`could not report the failure: ${reportError.message}`));
    return { state: 'failed', message };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

/** The loop: claim, build, repeat. `--once` is for a CI job that wants exactly one. */
async function main() {
  let token = await savedToken();
  if (!token) token = await pair();
  say(`watching ${site} from ${process.cwd()}`);

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    say('stopping after the current step');
  });

  for (;;) {
    let answer;
    try {
      answer = await call('worker/claim', { method: 'POST', token });
    } catch (error) {
      if (error.status === 401) {
        console.error(`[install-worker] ${error.message}`);
        process.exit(1);
      }
      say(`could not ask for work (${error.message}); will try again`);
      await sleep(Number(args.interval) * 1000);
      continue;
    }
    if (answer.job) {
      await runJob(token, answer.job);
      if (args.once) return;
      continue;
    }
    if (args.once) {
      say(answer.message || 'nothing is queued');
      return;
    }
    if (stopping) return;
    await sleep(Number(args.interval) * 1000);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[install-worker] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * `npm run verify:install` — the end-to-end check for plugin installs, against a *real* site, Supabase project and
 * Vercel project. Nothing here is a stub: every step is the same route or the same Vercel call the app makes, so a
 * green run is evidence that the feature works and a red one names the step that does not.
 *
 * Why a script and not a test: this needs an administrator's session, a service key, a Vercel token and minutes of
 * build time. Those are exactly the things a unit test must not have, and the things a release check must.
 *
 *   npm run verify:install -- --check        # what is configured, and what is missing (no secrets printed)
 *   npm run verify:install -- --run          # the whole path, ending in `installed` and a READY deployment
 *   npm run verify:install -- --run --fail   # ...then a build that must fail and leave the site serving
 *
 * What it needs, in the environment and never on the command line (a secret in `argv` is a secret in the shell
 * history and in `ps`):
 *
 *   RWP_E2E_SITE            https://the-site-under-test.example      (or --site)
 *   RWP_E2E_PROJECT         the Vercel project name                  (or --project)
 *   RWP_E2E_ACCESS_TOKEN    a Supabase access token for an administrator of that site
 *   RWP_E2E_VERCEL_TOKEN    a Vercel token that can deploy to that project
 *   SUPABASE_URL            the project's URL (VITE_SUPABASE_URL is accepted too)
 *   SUPABASE_SECRET_KEY     the service role key, to prove the schema and read rwp_active_plugins
 *   RWP_E2E_ZIP             the plugin ZIP to install                (or --zip)
 *   RWP_E2E_TEAM            the Vercel team id, when the project is in a team (optional)
 *
 * The worker step runs `scripts/rwpBuildWorker.mjs --once` from this checkout, because that is what the dashboard's
 * pairing command does. Pass `--no-worker` on a site that builds in its own process (`build_mode: server`), where
 * `POST installs/jobs/:id/advance` is the build.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { filesToZip } from '../server/deploy/artifacts.mjs';
import { readManifest, unpack } from '../server/pluginInstaller.mjs';
import {
  VERCEL_API, findProject, getDeployment, teamQuery, validateVercelToken, vercelHeaders,
} from '../server/deploy/vercelApi.mjs';

const PLUGIN_ID = 'rwp-saas-installer';

const { values: args } = parseArgs({
  options: {
    check: { type: 'boolean' },
    run: { type: 'boolean' },
    fail: { type: 'boolean' },
    'no-worker': { type: 'boolean' },
    site: { type: 'string' },
    project: { type: 'string' },
    team: { type: 'string' },
    zip: { type: 'string' },
    timeout: { type: 'string' },
  },
});

const str = (value) => (typeof value === 'string' ? value.trim() : '');

const config = {
  site: str(args.site || process.env.RWP_E2E_SITE).replace(/\/+$/, ''),
  project: str(args.project || process.env.RWP_E2E_PROJECT),
  team: str(args.team || process.env.RWP_E2E_TEAM),
  zip: str(args.zip || process.env.RWP_E2E_ZIP),
  accessToken: str(process.env.RWP_E2E_ACCESS_TOKEN),
  vercelToken: str(process.env.RWP_E2E_VERCEL_TOKEN),
  supabaseUrl: str(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL).replace(/\/+$/, ''),
  secretKey: str(process.env.SUPABASE_SECRET_KEY),
  timeoutMs: Math.max(2, Number(args.timeout) || 20) * 60 * 1000,
};

/** How long to wait between polls of a job. */
const POLL_MS = 5000;

let failures = 0;
const say = (message) => console.log(`  ${message}`);
const step = (title) => console.log(`\n== ${title}`);
const ok = (message) => console.log(`  ✓ ${message}`);
const warn = (message) => console.log(`  ! ${message}`);
const bad = (message) => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A presence check that never prints a value, only a length, so the output can be pasted into an issue. */
function presence(name, value, { required = true } = {}) {
  if (value) {
    ok(`${name} is set (${value.length} characters)`);
    return true;
  }
  if (required) bad(`${name} is not set`);
  else warn(`${name} is not set (optional)`);
  return false;
}

/** One call to the site's plugin routes, authorised as the administrator whose token was supplied. */
async function call(pathname, { method = 'GET', body, token = config.accessToken } = {}) {
  const response = await fetch(`${config.site}/api/plugins/${PLUGIN_ID}/${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 300) };
  }
  if (!response.ok || payload?.success === false || payload?.ok === false) {
    const error = new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload?.code || '';
    throw error;
  }
  return payload || {};
}

/** One PostgREST read with the service key — the job table, and `rwp_active_plugins`. */
async function rest(pathname) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${pathname}`, {
    headers: { apikey: config.secretKey, Authorization: `Bearer ${config.secretKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`PostgREST ${pathname} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return await response.json();
}

/** The ids `rwp_active_plugins` currently holds, as the site's own option row stores them. */
async function activePluginIds() {
  const rows = await rest('options?option_name=eq.rwp_active_plugins&select=option_value');
  if (!Array.isArray(rows) || !rows.length) return [];
  try {
    const parsed = JSON.parse(rows[0].option_value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** The deployment Vercel currently serves for this project — what a failed install must leave alone. */
async function productionDeployment(projectId) {
  const response = await fetch(
    `${VERCEL_API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=1${teamQuery(config.team)}`,
    { headers: vercelHeaders(config.vercelToken), signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`Vercel refused the deployment list (HTTP ${response.status}).`);
  const payload = await response.json();
  return (payload?.deployments || [])[0] || null;
}

/** The plugin package, as the bytes a job carries. */
async function packageBytes() {
  const file = path.resolve(config.zip);
  const bytes = await readFile(file);
  // The same checks the route makes, run here so a wrong ZIP fails before anything is queued.
  const entries = unpack(bytes);
  const manifest = readManifest(entries);
  if (!entries.has('index.tsx')) throw new Error(`${file} has no index.tsx, so it is not a plugin package.`);
  return { bytes, manifest, entries, file };
}

/**
 * Preflight: everything that can be checked without deploying anything.
 *
 * Deliberately exhaustive — each answer names the variable or the route, because the failure of an end-to-end run
 * is almost always a missing variable rather than a broken pipeline.
 */
async function preflight() {
  step('Configuration');
  const ready = [
    presence('RWP_E2E_SITE', config.site),
    presence('RWP_E2E_PROJECT', config.project),
    presence('SUPABASE_URL', config.supabaseUrl),
    presence('SUPABASE_SECRET_KEY', config.secretKey),
    presence('RWP_E2E_ACCESS_TOKEN', config.accessToken),
    presence('RWP_E2E_VERCEL_TOKEN', config.vercelToken),
    presence('RWP_E2E_ZIP', config.zip),
    presence('RWP_E2E_TEAM', config.team, { required: false }),
  ].every(Boolean);
  if (!ready) {
    warn('Nothing was deployed. Set the missing values and run again.');
    return false;
  }

  step('The plugin-install tables');
  try {
    await rest('rwp_installer_jobs?select=id&limit=1');
    ok('rwp_installer_jobs is reachable with the service key');
  } catch (error) {
    bad(`${error.message}. Run the plugin schema (Plugins → RWP SaaS Installer → Install schema) first.`);
  }

  step('The Vercel token and the project it names');
  let projectId = '';
  try {
    const owner = await validateVercelToken(config.vercelToken);
    ok(`the token belongs to ${str(owner?.user?.username) || str(owner?.user?.email) || 'a Vercel account'}`);
    const project = await findProject(config.vercelToken, { projectName: config.project, teamId: config.team });
    projectId = str(project?.id);
    ok(`project ${config.project} resolved (${projectId || 'no id'})`);
  } catch (error) {
    bad(`Vercel: ${error.message}`);
  }

  step('The site, and the session');
  try {
    const answer = await call('installs/credential');
    ok('GET installs/credential answered with this access token');
    if (answer.secretBox) ok('RWP_SECRET_BOX_KEY is set on the site, so a token can be sealed');
    else bad('the site has no RWP_SECRET_BOX_KEY, so it cannot store a Vercel token');
    if (str(answer.projectHint)) ok(`the site already records its project as ${answer.projectHint}`);
  } catch (error) {
    const hint = error.status === 401 || error.status === 403
      ? ' — the access token is not an administrator of this site, or it expired'
      : error.code === 'job_store_unconfigured'
        ? ' — the site has no SUPABASE_SECRET_KEY in its deployment environment'
        : '';
    bad(`GET installs/credential: ${error.message}${hint}`);
  }

  step('The package');
  try {
    const { manifest, file } = await packageBytes();
    ok(`${path.basename(file)} is ${manifest.id} ${manifest.version} ("${manifest.name}")`);
  } catch (error) {
    bad(`${config.zip}: ${error.message}`);
  }

  return failures === 0 ? { projectId } : false;
}


/**
 * Waits for one job to finish, nudging it forward.
 *
 * `advance` is idempotent and a compare-and-set internally, so calling it on every poll is safe: a worker-built
 * job is only advanced once its payload has arrived, and a server-built one builds once. Without it, a job that a
 * worker built would sit in `built` forever — the worker is not allowed to deploy.
 */
async function settle(jobId, { buildMode = '' } = {}) {
  const deadline = Date.now() + config.timeoutMs;
  let seen = '';
  for (;;) {
    const { job } = await call(`installs/jobs/${encodeURIComponent(jobId)}`);
    if (job.status !== seen) {
      say(`${job.status} — ${job.step} (${job.progress}%)`);
      seen = job.status;
    }
    if (job.finished) return job;
    if (Date.now() > deadline) {
      warn(`gave up after ${Math.round(config.timeoutMs / 60000)} minutes with the job in ${job.status}`);
      return job;
    }
    if (job.status !== 'queued' || buildMode === 'server') {
      try {
        await call(`installs/jobs/${encodeURIComponent(jobId)}/advance`, { method: 'POST' });
      } catch (error) {
        // A busy project, a deployment still building: expected while settling, and the next poll asks again.
        say(`advance: ${error.message}`);
      }
    }
    await sleep(POLL_MS);
  }
}

/** Runs this checkout's worker for one job, exactly as the dashboard's command would. */
async function runWorker({ code = '', name = 'verify-script' } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = [path.join(root, 'scripts', 'rwpBuildWorker.mjs'), '--site', config.site, '--name', name, '--once'];
  if (code) argv.push('--code', code);
  const worker = spawn(process.execPath, argv, { stdio: 'inherit', cwd: root });
  return await new Promise((resolve) => {
    worker.on('exit', (code_) => resolve(code_ ?? 1));
    worker.on('error', () => resolve(1));
  });
}

/** The whole path, in the order a customer performs it. */
async function runEndToEnd({ projectId }) {
  step('1. Saving the Vercel token through the dashboard route');
  const saved = await call('installs/credential', {
    method: 'POST',
    body: { projectName: config.project, token: config.vercelToken, teamId: config.team },
  });
  ok(saved.message || `saved a token for ${config.project}`);

  step('2. Pairing a build environment');
  const pairing = await call('installs/build-environments', { method: 'POST', body: { name: 'verify-script' } });
  ok(`paired; the code expires ${pairing.expiresAt}`);
  say(`the dashboard would offer: ${pairing.command}`);

  step('3. Queueing the install');
  const servedBefore = await productionDeployment(projectId).catch(() => null);
  if (servedBefore) say(`before this run the project serves ${servedBefore.uid}`);
  const { bytes, manifest, entries } = await packageBytes();
  const started = await call('installs/jobs', {
    method: 'POST',
    body: { source: 'upload', file: bytes.toString('base64'), projectName: config.project },
  });
  ok(`${started.created ? 'queued' : 'already queued'}: ${started.job.pluginId} ${started.job.pluginVersion}, build mode ${started.job.buildMode}`);

  step('4. Building it with a paired worker');
  if (args['no-worker']) {
    say('skipped (--no-worker): this site builds in its own process, so step 5 builds it');
  } else {
    const exitCode = await runWorker({ code: pairing.code });
    if (exitCode !== 0) warn(`the worker exited ${exitCode}; the job status below is what counts`);
  }

  step('5. Deploying, and waiting for READY');
  const job = await settle(started.job.id, { buildMode: started.job.buildMode });
  if (job.status !== 'installed') {
    bad(`the install ended ${job.status}${job.error ? `: ${job.error.message}` : ''}`);
    return;
  }
  ok(`installed; deployment ${job.deployment?.id} for ${job.projectName}`);

  step('6. Vercel says READY, and the plugin is switched on');
  const deployment = await getDeployment(config.vercelToken, {
    deploymentId: job.deployment.id,
    teamId: config.team,
  });
  if (String(deployment.readyState).toUpperCase() === 'READY') ok(`${job.deployment.id} is READY (${deployment.url})`);
  else bad(`Vercel reports ${deployment.readyState} for ${job.deployment.id}`);
  const active = await activePluginIds();
  if (active.includes(manifest.id)) ok(`rwp_active_plugins contains ${manifest.id}`);
  else bad(`rwp_active_plugins does not contain ${manifest.id}: the plugin is deployed but not enabled`);

  if (args.fail) await failingInstall({ projectId, manifest, entries, installedUid: deployment.uid || deployment.id });
}


/**
 * The failure case: a build that cannot succeed must leave the previous deployment serving.
 *
 * The package is the one that just installed, with `index.tsx` replaced by something Vite cannot compile — the same
 * plugin id and version, so it is *the same install* unless a `nonce` says otherwise, which is why one is passed.
 * What is asserted afterwards is the promise the whole design rests on: nothing repointed the project's production
 * alias, so the site a customer sees is the one from step 6.
 */
async function failingInstall({ projectId, manifest, entries, installedUid }) {
  step('7. A build that must fail');
  const files = new Map();
  for (const [name, bytes] of entries) files.set(name, bytes);
  files.set('index.tsx', Buffer.from('export const broken = (\n', 'utf8'));
  const zip = filesToZip(files);

  const started = await call('installs/jobs', {
    method: 'POST',
    body: {
      source: 'upload',
      file: zip.toString('base64'),
      projectName: config.project,
      nonce: `verify-fail-${Date.now()}`,
    },
  });
  ok(`queued ${started.job.id}: ${manifest.id} with an index.tsx that cannot compile`);

  if (!args['no-worker']) await runWorker({ name: 'verify-script' });

  const job = await settle(started.job.id, { buildMode: started.job.buildMode });
  if (job.status === 'failed') {
    ok(`the install failed as it should (${job.error?.code || 'no code'}): ${job.error?.message || ''}`);
  } else if (job.status === 'queued' && job.error?.code) {
    // An attempt that is retryable is queued again rather than failed; that is still not an install.
    ok(`the attempt failed and was requeued (${job.error.code}), so nothing was deployed`);
  } else {
    bad(`the install ended ${job.status} instead of failing`);
  }

  step('8. The site still serves the last good deployment');
  const servedAfter = await productionDeployment(projectId);
  if (!servedAfter) {
    warn('Vercel listed no production deployment for this project, so this could not be checked');
    return;
  }
  if (String(servedAfter.uid) === String(installedUid)) {
    ok(`${servedAfter.uid} is still the production deployment`);
  } else {
    bad(`production is now ${servedAfter.uid}, not ${installedUid}: a failed install moved the alias`);
  }
  const stillActive = await activePluginIds();
  if (stillActive.includes(manifest.id)) ok(`rwp_active_plugins still lists ${manifest.id}`);
  else warn(`rwp_active_plugins no longer lists ${manifest.id}`);
}

/** The order above, with a summary and an exit code a CI job can use. */
async function main() {
  console.log('Plugin install — end-to-end verification');
  if (!args.run && !args.check) {
    console.log('\nNothing to do: pass --check to see what is configured, or --run to deploy.');
    process.exit(0);
  }

  const preflightResult = await preflight();
  if (!preflightResult) {
    step('Summary');
    console.log(`\n${failures} problem(s) above. Nothing was deployed.`);
    process.exit(1);
  }
  if (args.check) {
    step('Summary');
    ok('everything a real run needs is configured — run again with --run to install a plugin');
    process.exit(failures ? 1 : 0);
  }

  try {
    await runEndToEnd(preflightResult);
  } catch (error) {
    bad(`the run stopped: ${error.message}`);
  }

  step('Summary');
  if (failures) {
    console.log(`\n${failures} problem(s). A real end-to-end test has NOT passed.`);
    process.exit(1);
  }
  console.log('\nAll steps passed against a real site, Supabase project and Vercel project.');
  process.exit(0);
}

await main();


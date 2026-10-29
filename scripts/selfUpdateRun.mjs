#!/usr/bin/env node
/**
 * The detached worker `server/selfUpdate.mjs` starts: fetch the release, install packages, build, restart.
 *
 * It runs as its own process, in the folder it was started from, with one argument — the path to the run
 * record JSON that `startSelfUpdate` wrote. That record is the whole conversation between the two: this
 * script reads the target ref and the commit to roll back to from it, and writes the status after every
 * step so `GET /api/admin/system/update-status` can answer while the work is still going.
 *
 * Why a committed script rather than a string handed to `node -e`: an administrator runs this with the
 * site's own privileges, it edits the site's own files, and a file in the repository is the only version
 * of it anyone can read before it runs.
 *
 * The rollback is the important half. If the build fails after the merge, the folder is put back on the
 * commit it was on, its packages are installed again and it is rebuilt — a failed update that leaves a
 * site serving a half-built bundle is worse than no update at all. Every failure is recorded with the
 * sentence to show, and the log keeps the raw output.
 */
import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const recordFile = process.argv[2];
if (!recordFile) {
  console.error('Usage: node scripts/selfUpdateRun.mjs <run record json>');
  process.exit(2);
}

const record = JSON.parse(await readFile(recordFile, 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Appends one line to the run's log. Never throws: losing a log line must not stop an update. */
const log = (line) => appendFile(record.log_path, `[${new Date().toISOString()}] ${line}\n`, 'utf8').catch(() => undefined);

/** Persists the record. Awaited before and after every step, so a poll always sees the current one. */
const save = async (patch) => {
  Object.assign(record, patch);
  await writeFile(recordFile, JSON.stringify(record, null, 2), 'utf8').catch(() => undefined);
};

/** Runs one command, streaming both outputs into the log. Resolves with its stdout. */
const run = (command, args) => new Promise((resolve, reject) => {
  log(`$ ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    // A shell on Windows only: npm is a `.cmd` shim there, and Node refuses to exec one without it. The
    // arguments are this file's own literals, never anything a request supplied.
    shell: process.platform === 'win32',
    windowsHide: true,
    env: { ...process.env, CI: '1' },
  });
  let stdout = '';
  const forward = (chunk) => {
    const text = String(chunk);
    stdout += text;
    appendFile(record.log_path, text, 'utf8').catch(() => undefined);
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  child.on('error', (error) => reject(error));
  child.on('close', (code) => (code === 0
    ? resolve(stdout.trim())
    : reject(new Error(`${command} ${args[0] || ''} exited with code ${code}.`))));
});

/** Writes the failure, rebuilds the previous commit, and stops. */
const fail = async (message) => {
  await log(`FAILED: ${message}`);
  if (record.target && record.previous) {
    await log(`Rolling back to ${record.previous}…`);
    try {
      await run('git', ['reset', '--hard', record.previous]);
      await run(npm, ['install', '--no-audit', '--no-fund']);
      await run(npm, ['run', 'build']);
      await log('Rollback complete: the previous version is restored and rebuilt.');
    } catch (error) {
      await log(`ROLLBACK FAILED: ${error instanceof Error ? error.message : String(error)}`);
      await log('This site may not boot. Restore it by hand: git reset --hard ' + record.previous + ', then npm install && npm start.');
    }
  }
  await save({ status: 'failed', error: message, finished_at: new Date().toISOString() });
  process.exitCode = 1;
};

try {
  await save({ status: 'running', step: 'fetching', started_at: record.started_at || new Date().toISOString() });
  await run('git', ['fetch', '--prune', '--tags', 'origin']);
  const target = await run('git', ['rev-parse', '--verify', `${record.ref}^{commit}`]).catch(() => '');
  if (!target) throw new Error(`The ref "${record.ref}" does not exist on origin, so there is nothing to update to.`);
  if (target === record.previous) {
    await log('Already on the newest commit for that ref: rebuilding anyway.');
  }
  await save({ target });
  // `--ff-only` rather than a hard reset: a branch that has diverged from origin is the administrator's
  // to reconcile, and a reset would discard commits the site is running.
  await run('git', ['merge', '--ff-only', target]);

  await save({ step: 'installing-packages' });
  await run(npm, ['install', '--no-audit', '--no-fund']);

  await save({ step: 'building' });
  await run(npm, ['run', 'build']);

  await save({ step: 'restarting' });
  if (record.restart === 'pm2' && record.app_name) {
    await run('pm2', ['restart', record.app_name, '--update-env']);
    await save({ status: 'completed', step: 'restarted', restart_required: false, finished_at: new Date().toISOString() });
    await log(`Restarted ${record.app_name} through PM2.`);
  } else {
    // No supervisor to restart the app: say so instead of killing the process that is serving the site.
    await save({ status: 'completed', step: 'restart-required', restart_required: true, finished_at: new Date().toISOString() });
    await log('Built. Restart this server (npm start, or your service manager) to run the new version.');
  }
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}

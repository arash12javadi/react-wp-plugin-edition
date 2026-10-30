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
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';

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

/**
 * The package entries a core update must never write: the user's plugins directory and local secrets.
 * Everything else the ZIP carries is the core and may be overwritten.
 */
const PRESERVED_ENTRY = /^(?:plugins(?:\/|$)|\.env(?:\.local|\.production|\.development)?$|\.git(?:\/|$)|node_modules(?:\/|$)|data(?:\/|$)|state(?:\/|$)|\.rwp-tmp(?:\/|$)|\.vercel(?:\/|$))/;

/** Resolves a ZIP entry to a path inside the site's folder, or '' when it would escape it. */
const safeJoin = (name) => {
  const root = path.resolve(process.cwd());
  const target = path.resolve(root, name);
  return (target === root || target.startsWith(root + path.sep)) ? target : '';
};

/** Copies a backed-up file back, recursively. Used to undo a failed package update. */
const restoreBackup = async (backupRoot) => {
  const root = path.resolve(backupRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const source = path.join(root, entry.name);
    const relative = path.relative(root, source);
    const target = safeJoin(relative);
    if (!target) continue;
    if (entry.isDirectory()) {
      await restoreBackup(source);
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(source));
    }
  }
};

/** Writes the failure, restores the previous version, and stops. */
const fail = async (message) => {
  await log(`FAILED: ${message}`);
  if (record.source === 'package' && record.backup) {
    await log('Restoring the files the update replaced…');
    try {
      await restoreBackup(record.backup);
      await run(npm, ['install', '--no-audit', '--no-fund']);
      await run(npm, ['run', 'build']);
      await log('Restore complete: the previous version is back and rebuilt.');
    } catch (error) {
      await log(`RESTORE FAILED: ${error instanceof Error ? error.message : String(error)}`);
      await log('This site may not boot. Restore it by hand from the backup in ' + record.backup + ', then npm install && npm start.');
    }
  } else if (record.target && record.previous) {
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
  await save({ status: 'running', step: 'starting', started_at: record.started_at || new Date().toISOString() });

  if (record.source === 'package') {
    // Managed update: download the core release package from the central server, then apply it.
    await save({ step: 'downloading' });
    await log(`Downloading ${record.to} from react-wp.com…`);
    const response = await fetch(record.package_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${record.package_token}`,
        Accept: 'application/zip',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ site: record.site, to: record.to, from: record.from }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = `React-WP.com answered HTTP ${response.status} for the update.`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // The body was not JSON; the status sentence above is the answer.
      }
      throw new Error(message);
    }

    await save({ step: 'extracting' });
    const zipBytes = new Uint8Array(await response.arrayBuffer());
    let entries;
    try {
      entries = unzipSync(zipBytes);
    } catch (error) {
      throw new Error(`The release package could not be read (${error instanceof Error ? error.message : 'bad ZIP'}).`);
    }

    // Core-only: overwrite the core files the package carries, preserving plugins/ and .env.local. Files
    // already on disk are backed up first, so a failed update can be undone.
    await save({ step: 'applying' });
    const backupRoot = path.join('.rwp-tmp', 'self-update', `${record.id}-backup`);
    await save({ backup: backupRoot });
    let applied = 0;
    let preserved = 0;
    for (const [name, bytes] of Object.entries(entries)) {
      if (PRESERVED_ENTRY.test(name)) { preserved += 1; continue; }
      const target = safeJoin(name);
      if (!target) { await log(`Skipping unsafe path ${name}.`); continue; }
      // Back up the file being replaced before writing over it.
      try {
        const existing = await readFile(target);
        const backup = path.join(backupRoot, name);
        await mkdir(path.dirname(backup), { recursive: true });
        await writeFile(backup, existing);
      } catch {
        // A new file has nothing to back up.
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      applied += 1;
    }
    await log(`Applied ${applied} core file${applied === 1 ? '' : 's'}; preserved ${preserved} entr${preserved === 1 ? 'y' : 'ies'} (plugins/, .env.local, …).`);
  } else {
    await save({ step: 'fetching' });
    await run('git', ['fetch', '--prune', '--tags', 'origin']);
    const target = await run('git', ['rev-parse', '--verify', `${record.ref}^{commit}`]).catch(() => '');
    if (!target) throw new Error(`The ref "${record.ref}" does not exist on origin, so there is nothing to update to.`);
    if (target === record.previous) {
      await log('Already on the newest commit for that ref: rebuilding anyway.');
    }
    await save({ target });
    // Core-only rule: the user's installed plugins live in `plugins/` as untracked folders, and their
    // activation state lives in the database. `git merge --ff-only` and `git reset --hard` never remove
    // untracked files, so the merge below cannot delete a plugin — but the guarantee is checked here so a
    // future change to the runner cannot silently start touching them.
    await save({ step: 'preserving-plugins' });
    const pluginsBefore = new Set(await readdir('plugins').catch(() => []));
    // `--ff-only` rather than a hard reset: a branch that has diverged from origin is the administrator's
    // to reconcile, and a reset would discard commits the site is running.
    await run('git', ['merge', '--ff-only', target]);

    const pluginsAfter = new Set(await readdir('plugins').catch(() => []));
    const lostPlugins = [...pluginsBefore].filter((name) => !pluginsAfter.has(name));
    if (lostPlugins.length > 0) {
      await log(`WARNING: the core update removed plugin folder(s) ${lostPlugins.join(', ')} — a core update must never touch plugins. Restore them before restarting.`);
    }
  }

  await save({ step: 'installing-packages' });
  await run(npm, ['install', '--no-audit', '--no-fund']);

  await save({ step: 'building' });
  await run(npm, ['run', 'build']);

  await save({ step: 'restarting' });
  if (record.restart === 'pm2' && record.app_name) {
    await run('pm2', ['restart', record.app_name, '--update-env']);
    await save({ status: 'done', step: 'restarted', restart_required: false, finished_at: new Date().toISOString() });
    await log(`Restarted ${record.app_name} through PM2.`);
  } else {
    // No supervisor to restart the app: say so instead of killing the process that is serving the site.
    await save({ status: 'done', step: 'restart-required', restart_required: true, finished_at: new Date().toISOString() });
    await log('Built. Restart this server (npm start, or your service manager) to run the new version.');
  }
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}

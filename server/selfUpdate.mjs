/**
 * One-click updates for a server that owns its checkout â€” `node server.mjs` under PM2, or a plain
 * `npm start` on a machine the administrator controls.
 *
 * The work is not done inside the request. Installing packages and rebuilding this site takes minutes,
 * the process that answers the request is the process the build replaces, and an HTTP connection is not
 * a place to find that out. So the route *starts* a run and answers with its id: a detached
 * `node scripts/selfUpdateRun.mjs` does the fetching, installing and building, writing a status record
 * after each step, and the screen polls `GET /api/admin/system/update-status?id=<run>` for it.
 *
 * Four guards, all of them before anything is touched, because this is the one admin action that can
 * leave a site unable to boot:
 *
 *   - the folder must be a git checkout (`git rev-parse` answers something);
 *   - the working tree must be clean, so the update can be rolled back to an exact commit;
 *   - the target must be a ref in this repository, not a string that happens to reach git;
 *   - the stored configuration must say `self_update: true` (see `server/updateCenter.mjs`). That row is
 *     written by an administrator on Settings â†’ Updates, so nothing here runs because a site happens to
 *     be a clone.
 *
 * A repository that keeps local edits â€” a customer's `.env.local` in particular â€” is untouched by all of
 * this: `.gitignore` already covers it, so "clean" stays clean. `scripts/selfUpdateRun.mjs` rolls back to
 * the recorded commit if the build fails, and the log it writes is what the screen shows.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where a run's status record and log live, inside the folder every deployment already ignores. */
export const SELF_UPDATE_DIR = path.join('.rwp-tmp', 'self-update');

/** The detached worker. A committed file rather than a script written at runtime: it is reviewable. */
export const SELF_UPDATE_SCRIPT = path.join('scripts', 'selfUpdateRun.mjs');

/** How many runs the status route lists when it is asked for no particular one. */
export const SELF_UPDATE_RUN_LIMIT = 10;

/** A refusal that carries the status code to answer with. */
export class SelfUpdateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SelfUpdateError';
    this.status = status;
  }
}

/** `git <args>` in `cwd`, resolving with trimmed stdout and rejecting with a readable message. */
const git = async (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      error.message = String(stderr || error.message).trim() || error.message;
      reject(error);
      return;
    }
    resolve(String(stdout).trim());
  });
});

/** The branch, commit and cleanliness of this checkout. Never throws: every answer is a state. */
export async function gitState(cwd = process.cwd()) {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const head = await git(['rev-parse', 'HEAD'], cwd);
    // `--untracked-files=no`: an untracked file cannot be lost by a pull, and a site's own scratch files
    // (a log, the backup the administrator just exported) must not be the reason an update is refused.
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'], cwd);
    return { available: true, repo: true, branch, head, dirty: dirty !== '', error: '' };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      available: !missing,
      repo: false,
      branch: '',
      head: '',
      dirty: false,
      error: missing
        ? 'git is not installed on this server, so an update cannot be fetched. Install git, or update by hand.'
        : `This folder is not a git checkout (${String(error?.message || '').split('\n')[0]}), so there is nothing to pull. A site installed from a ZIP is updated by hand.`,
    };
  }
}

/**
 * Whether this server can update itself, and why not when it cannot. The screen shows `reason` next to
 * the Update Now button, so an administrator never meets a disabled button with no explanation.
 */
export async function selfUpdateSupport() {
  const state = await gitState();
  if (!state.repo) return { ...state, supported: false, reason: state.error };
  if (state.dirty) {
    return {
      ...state,
      supported: false,
      reason: 'This checkout has uncommitted changes. Commit or stash them first: an update pulls over them, and rolling back to a known commit is the only way back.',
    };
  }
  return {
    ...state,
    supported: true,
    /** PM2 sets `pm_id` in the environment of the app it started, so the runner can restart it. */
    restart: process.env.pm_id ? 'pm2' : 'manual',
    app_name: process.env.name || '',
    reason: '',
  };
}

const runFile = (id) => path.join(SELF_UPDATE_DIR, `${id}.json`);

/** A run id that sorts by time and cannot escape the directory it names. */
const newRunId = () => `${new Date().toISOString().replace(/[:.TZ-]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Writes a run record. Exported because `scripts/selfUpdateRun.mjs` is a separate process and has to
 * write the shape this module reads â€” one writer definition, so the two cannot drift.
 */
export async function writeSelfUpdateRun(record) {
  await mkdir(SELF_UPDATE_DIR, { recursive: true });
  await writeFile(runFile(record.id), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/** One run, or `null` when the id is not one this server wrote. */
export async function readSelfUpdateRun(id) {
  if (!/^[0-9a-z-]{8,64}$/i.test(String(id || ''))) return null;
  return readJson(runFile(String(id)));
}

/** The most recent runs, newest first â€” what the screen shows when no update is in flight. */
export async function listSelfUpdateRuns(limit = SELF_UPDATE_RUN_LIMIT) {
  let names;
  try {
    names = await readdir(SELF_UPDATE_DIR);
  } catch {
    return [];
  }
  const records = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(SELF_UPDATE_DIR, name))),
  );
  return records
    .filter((record) => record && typeof record.id === 'string')
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
    .slice(0, limit);
}

/**
 * Checks a git ref this server is willing to pass to `git`. A leading dash is refused (it would be read
 * as an option), as is a range (`a..b`) and anything that is not a branch, tag or `origin/â€¦` name.
 */
export const isSafeRef = (ref) => {
  const value = String(ref || '');
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) && !value.includes('..');
};

/**
 * Starts an update run and returns its record straight away.
 *
 * `ref` defaults to the upstream of the branch being run (`origin/<branch>`), which is what "update this
 * site" means on every host that has one. The runner fetches it and refuses a ref it cannot resolve, so
 * a stale local branch is an answer with a log, not a silent no-op.
 *
 * @param {{ to: string, from: string, ref?: string }} options
 */
export async function startSelfUpdate({ to, from, ref = '' }) {
  const support = await selfUpdateSupport();
  if (!support.supported) throw new SelfUpdateError(support.reason, 409);
  const targetRef = ref ? String(ref) : `origin/${support.branch}`;
  if (!isSafeRef(targetRef)) {
    throw new SelfUpdateError(`"${targetRef}" is not a branch or tag this server can check out.`, 400);
  }
  const id = newRunId();
  const record = await writeSelfUpdateRun({
    id,
    status: 'running',
    step: 'starting',
    started_at: new Date().toISOString(),
    finished_at: '',
    from,
    to,
    ref: targetRef,
    previous: support.head,
    target: '',
    /** `pm2` restarts the app after the build; `manual` asks the administrator to. */
    restart: support.restart,
    app_name: support.app_name,
    restart_required: support.restart !== 'pm2',
    log_path: path.join(SELF_UPDATE_DIR, `${id}.log`),
    error: '',
  });
  const child = execFile(process.execPath, [SELF_UPDATE_SCRIPT, runFile(id)], {
    cwd: process.cwd(),
    // Detached with no pipes: this request is about to end, and a child that inherits its stdio would
    // hold the response open. The runner writes everything it prints to `log_path` itself.
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return record;
}

/** The log tail a screen shows under a finished run. Empty when the runner has not written one yet. */
export async function readSelfUpdateLog(id, maxLines = 60) {
  const record = await readSelfUpdateRun(id);
  if (!record?.log_path) return '';
  try {
    const text = await readFile(record.log_path, 'utf8');
    return text.trimEnd().split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}


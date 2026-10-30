/**
 * Browser half of Dashboard → Updates: the check, the apply, and the progress of a self-update.
 *
 * The four endpoints behind this file are served by both hosts — `server/updateRoutes.mjs` on
 * `node server.mjs` and `src/server/routes/updates.ts` on the universal engine — and answer the same
 * JSON, because both call `server/updateCenter.mjs`. Nothing here talks to GitHub, and nothing here
 * ever sees the update token: the configuration lives in `system_settings.updates_config`, is read
 * server-side, and comes back masked as `has_token`. That is what keeps a private repository private.
 *
 * The shapes below mirror the shared module's returns. They are declared here rather than imported
 * from a `.d.mts`, because the screen is what reads them and a change on the server must show up as a
 * type error in the component that renders it.
 *
 * Two things this file deliberately does *not* do: it never guesses whether an update exists (the
 * server compares versions, and a browser-side comparison could disagree with the plan the apply step
 * would use), and it never reports an update as installed (the run record says what happened).
 */
import { client, getSystemSetting, setSystemSetting } from './db';
import { rwp } from './rwp';
import {
  autoCheckIntervals,
  defaultUpdateSettings,
  installedAppVersion,
  isCheckDue,
  loadUpdateStatus,
  saveUpdateStatus,
  type AutoCheck,
  type UpdateSettings,
  type UpdateStatus,
} from './updates';

export { installedAppVersion };

/** `system_settings` rows this feature owns, in step with `server/updateCenter.mjs`. */
export const updateConfigKey = 'updates_config';
export const versionStateKey = 'version_state';

/** Where the central server lives when the saved configuration names no other. */
export const defaultCentralUrl = 'https://react-wp.com';

/** A release as the browser may see it: no download URL, which only an installer needs. */
export interface UpdateRelease {
  version: string;
  /** The published tag, `v2.4.1`. What the screen shows; `version` is the same release without the `v`. */
  tag: string;
  released: string;
  notes: string[];
  changelog_url: string;
  critical: boolean;
}

/** One release this site could move to, core or plugin. `latest` is repeated for convenience. */
export interface AvailableUpdate {
  id: string;
  name: string;
  kind: 'app' | 'plugin';
  installed: string;
  latest: string;
  release: UpdateRelease | null;
}

/** `updates_config` as the server describes it back — the token is `has_token`, never the value. */
export interface UpdateConfigView {
  central_url: string;
  /**
   * `owner/name` of the repository this site's releases are tagged on, as named on Settings → Updates.
   * Empty means "whichever repository the GitHub integration holds" (`github_config`), and naming one makes
   * GitHub the first source a check asks.
   */
  repository: string;
  channel: 'stable' | 'beta';
  auto_check: AutoCheck;
  notify: boolean;
  /** Opt-in: whether `POST /api/admin/system/update` may rewrite this server's checkout. */
  self_update: boolean;
  has_token: boolean;
  /** Which source a check asks first: the named repository, the central server when there is a token for it, else GitHub. */
  source: 'central' | 'github';
  /**
   * True when this viewer is an end user whose updates are managed by `react-wp.com`: the server has
   * already redacted `repository`, `central_url`, `has_token` and the GitHub source, and the screen hides
   * the "Where updates come from" section.
   */
  managed?: boolean;
}

/**
 * The GitHub repository a check may read directly — the source for a deployment that owns the repository
 * its releases are tagged on. `has_token` is the masked credential: a public repository needs none, which is
 * why `configured` is the field that decides whether this source can answer at all.
 */
export interface GithubSourceView {
  repo: string;
  has_token: boolean;
  configured: boolean;
}

/** What this host can do with an update. `reason` is written to be shown, never parsed. */
export interface UpdateSupport {
  available: boolean;
  repo: boolean;
  supported: boolean;
  reason: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
  /** How the run restarts the site afterwards, when it can. */
  restart?: 'pm2' | 'manual';
  app_name?: string;
}

/** The answer to one check: both sources converge on this shape (`checkAnswerFrom`). */
export interface UpdateCheckAnswer {
  format: 'rwp-update-center';
  version: 1;
  source: 'central' | 'github';
  checked_at: string;
  app: {
    installed: string;
    latest: string;
    /** The GitHub release tag, `v2.4.1`, when the source names one. */
    latest_tag?: string;
    update_available: boolean;
    release: UpdateRelease | null;
  };
  plugins: Record<string, UpdateRelease | null>;
  updates: AvailableUpdate[];
  update_available: boolean;
  /**
   * The central contract, repeated at the top level so a client that speaks only that can read either
   * host: the tag this site runs, the tag GitHub published, and the four pieces of the answer.
   * `updateAvailable` is about the core; `update_available` above also counts plugin releases.
   */
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  releaseNotes?: string;
  releaseUrl?: string;
  /**
   * Why the source that was *not* used did not answer. A site that names a repository reads `error` when the
   * repository refused and the platform answered instead, and the other way round; empty when the first
   * source asked answered. Written to be shown, never parsed.
   */
  error: string;
  config: UpdateConfigView;
  /** The repository this deployment reads release tags from, when it has one. */
  github: GithubSourceView;
  /** False when this deployment cannot read `system_settings` — the token is stored but invisible. */
  readable: boolean;
}

/** `GET /api/admin/updates` — what is installed and what this host can do, before any check runs. */
export interface UpdatesOverview {
  installed: string;
  config: UpdateConfigView;
  github: GithubSourceView;
  readable: boolean;
  error: string;
  support: UpdateSupport;
  /** The central plugin directory, for the Marketplace screen. */
  plugin_directory: string;
  channels: string[];
  auto_check: string[];
}

/** How an update would be applied. `up_to_date` is a `manual` plan whose reason says so. */
export interface UpdatePlan {
  mode: 'manual' | 'deploy-hook' | 'self' | 'central';
  up_to_date?: boolean;
  reason: string;
  /** The steps the screen can show while the work runs. */
  steps: string[];
}

/** One self-update run, as `server/selfUpdate.mjs` writes it. */
export interface SelfUpdateRun {
  id: string;
  status: 'running' | 'done' | 'failed' | string;
  step: string;
  started_at: string;
  finished_at: string;
  from: string;
  to: string;
  ref: string;
  previous: string;
  target: string;
  restart: 'pm2' | 'manual';
  app_name: string;
  /** True when nobody restarted the site for the administrator — the screen says what to run. */
  restart_required: boolean;
  log_path: string;
  error: string;
}

/**
 * What `applyUpdate` produced, in the four shapes the route can answer with.
 *
 * `manual` is not an error: it is the route saying "this host cannot do this", and `plan.reason` carries
 * the sentence that names what to configure. That is why the client classifies the response instead of
 * throwing on a 409.
 */
export type UpdateOutcome =
  | { kind: 'up_to_date'; plan: UpdatePlan; check: UpdateCheckAnswer }
  | { kind: 'manual'; plan: UpdatePlan; check: UpdateCheckAnswer }
  | {
    kind: 'deploy';
    queued: boolean;
    message: string;
    deploy: { configured: boolean; triggered: boolean; status?: number; error?: string };
    plan: UpdatePlan;
    check: UpdateCheckAnswer;
  }
  | { kind: 'self'; run: SelfUpdateRun; plan: UpdatePlan; check: UpdateCheckAnswer }
  | {
    /** A managed (end-user) site: the platform deployed it. `queued` mirrors the deploy-hook outcome. */
    kind: 'managed';
    queued: boolean;
    message: string;
    version: string;
    plan: UpdatePlan;
    check: UpdateCheckAnswer;
  };

/**
 * The signed-in administrator's token. Every route in this file decides what may be done from it —
 * an update installs code, so the server asks for `manage_options` and this is how it finds out who is
 * asking. A missing session is its own message: it is not a server fault.
 */
const accessToken = async (): Promise<string> => {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  return token;
};

/**
 * One request, with the status kept alongside the body.
 *
 * `applyUpdate` has to tell a 409 (a plan this host cannot carry out, with its by-hand steps) apart from
 * a 502 (a deploy hook that refused), so the status is part of the answer rather than an exception. A
 * bodyless 404 means the endpoint is not there at all — a static SPA, or a fetch that never reached the
 * API server — and that is reported as such, because it sends the administrator somewhere different.
 */
const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(`The update server could not be reached for ${path}. In development, is the API server running?`);
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 404 && !body.error) {
    throw new Error(`This host has no ${path} endpoint, so updates cannot be managed from here. It needs the API server that answers /api: npm start, npm run start:hono, or the deployed functions.`);
  }
  return { status: response.status, body };
};


/**
 * `POST /api/admin/updates/check` — asks the central server, or reads this deployment's own GitHub release
 * tags when the site has no token for it.
 *
 * The plugin list travels with the request because only the browser knows what this build activated, and
 * the central server needs it to say which of *this site's* plugins have newer releases. The `site` value
 * is the licence identifier the central server matches on, when one is configured.
 */
export const checkForUpdates = async (options: { site?: string } = {}): Promise<UpdateCheckAnswer> => {
  const { status, body } = await request<UpdateCheckAnswer & { error?: string }>('/api/admin/updates/check', {
    method: 'POST',
    body: JSON.stringify({ plugins: installedPlugins(), site: options.site || '' }),
  });
  if (status !== 200) throw new Error(body.error || `The update check failed (HTTP ${status}).`);
  return body;
};

/**
 * `POST /api/admin/system/update` — applies what the check found, however this host can.
 *
 * The route decides between a deploy hook, a self-update run and a by-hand plan; this only names the
 * answer. `ref` chooses what a self-update checks out, and is left empty in normal use so the runner
 * follows the branch the site already runs.
 */
export const applyUpdate = async (options: { site?: string; ref?: string } = {}): Promise<UpdateOutcome> => {
  const { status, body } = await request<Record<string, unknown> & { error?: string }>('/api/admin/system/update', {
    method: 'POST',
    body: JSON.stringify({ plugins: installedPlugins(), site: options.site || '', ref: options.ref || '' }),
  });
  const plan = body.plan as UpdatePlan | undefined;
  const check = body.check as UpdateCheckAnswer | undefined;
  if (!plan || !check) {
    throw new Error(body.error || `The update could not be started (HTTP ${status}).`);
  }
  if (plan.up_to_date) return { kind: 'up_to_date', plan, check };
  if (plan.mode === 'manual') {
    // 409: a refusal that carries its sentence in `plan.reason`. Anything else under `manual` is that same answer.
    return { kind: 'manual', plan, check };
  }
  if (plan.mode === 'central' || body.mode === 'central') {
    return {
      kind: 'managed',
      queued: body.queued === true,
      message: String(body.message || ''),
      version: String(body.version || ''),
      plan,
      check,
    };
  }
  if (plan.mode === 'deploy-hook' || status === 502) {
    return {
      kind: 'deploy',
      queued: body.queued === true,
      message: String(body.message || ''),
      deploy: body.deploy as { configured: boolean; triggered: boolean; status?: number; error?: string },
      plan,
      check,
    };
  }
  return { kind: 'self', run: body.run as SelfUpdateRun, plan, check };
};

/** `GET /api/admin/system/update-status?id=<run>` — one run and its log tail. */
export const fetchUpdateRun = async (id: string): Promise<{ run: SelfUpdateRun; log: string }> => {
  const query = `?id=${encodeURIComponent(id)}`;
  const { status, body } = await request<{ run: SelfUpdateRun; log: string; error?: string }>(
    `/api/admin/system/update-status${query}`,
  );
  if (status !== 200) throw new Error(body.error || `That update run could not be read (HTTP ${status}).`);
  return body;
};

/** The same route with no id: the recent runs, newest first, and what this host can do. */
export const fetchUpdateRuns = async (): Promise<{ runs: SelfUpdateRun[]; support: UpdateSupport }> => {
  const { status, body } = await request<{ runs: SelfUpdateRun[]; support: UpdateSupport; error?: string }>(
    '/api/admin/system/update-status',
  );
  if (status !== 200) throw new Error(body.error || `The update history could not be read (HTTP ${status}).`);
  return body;
};

/** True while the detached runner is still working — the screen polls until this goes false. */
export const isRunInFlight = (run: SelfUpdateRun | null): boolean =>
  Boolean(run && run.status === 'running' && !run.finished_at);

/** The plugins this build has activated, in the shape the check expects. */
export const installedPlugins = (): Array<{ id: string; name: string; version: string }> =>
  rwp.getPlugins().map((plugin) => ({ id: plugin.id, name: plugin.name, version: plugin.version }));

/** `GET /api/admin/updates` — the installed version, the configuration, and this host's capabilities. */
export const fetchUpdatesOverview = async (): Promise<UpdatesOverview> => {
  const { status, body } = await request<UpdatesOverview & { error?: string }>('/api/admin/updates');
  if (status !== 200) throw new Error(body.error || `The Updates screen could not be loaded (HTTP ${status}).`);
  return body;
};

/* -- Writing the two rows the screen owns --------------------------------------------------------- */

/**
 * Saves `system_settings.updates_config`, keeping whatever the patch does not name.
 *
 * Written from the browser because that is where the administrator is: the server reads this row with a
 * service key or a direct connection, and never needs to write it. `token` is the one field whose
 * *absence* means "leave it alone" — the screen is never sent the stored token, so an empty input must
 * not wipe it. Passing `null` deletes it, which is how a site stops using the central server.
 */
export const saveUpdateConfig = async (patch: { token?: string | null } & Partial<Omit<UpdateConfigView, 'has_token' | 'source'>>) => {
  const stored = await getSystemSetting<Record<string, unknown>>(updateConfigKey, {});
  const next: Record<string, unknown> = { ...(stored && typeof stored === 'object' ? stored : {}) };
  Object.entries(patch).forEach(([key, value]) => {
    if (key === 'token') {
      if (value === null) next.token = '';
      else if (typeof value === 'string' && value.trim()) next.token = value.trim();
      return;
    }
    next[key] = value;
  });
  if (!(await setSystemSetting(updateConfigKey, next))) {
    throw new Error('This browser is not allowed to store the update configuration. Sign in again as an administrator and retry.');
  }
  return next;
};

/** The stored `system_settings.version_state` row, unparsed — the screen writes it back with one change. */
export const readVersionState = () => getSystemSetting<Record<string, unknown>>(versionStateKey, {});

export interface VersionStateEntry {
  at: string;
  from: string;
  to: string;
  mode: 'deploy-hook' | 'self' | 'manual' | 'managed';
  status: 'started' | 'triggered' | 'completed' | 'failed';
  error?: string;
}

/**
 * Records the outcome of an update in `system_settings.version_state`.
 *
 * The server never writes this row: `system_settings` is writable only by a signed-in administrator, and
 * the same rule that lets the screen save the token lets it save what happened. A failed update leaves
 * the recorded installed version alone — that is the point of recording it — so a half-applied release
 * cannot be reported as installed.
 *
 * `previous` is the row as read; it is passed in rather than re-read so a screen that just polled a run
 * does not have to wait on the database twice.
 */
export const recordVersionState = async (
  previous: Record<string, unknown> | null,
  entry: VersionStateEntry,
): Promise<boolean> => {
  const row = previous && typeof previous === 'object' ? previous : {};
  const history = Array.isArray(row.history) ? row.history.filter((item) => item && typeof item === 'object') : [];
  const app = row.app && typeof row.app === 'object' ? (row.app as Record<string, unknown>) : {};
  const record = { ...entry };
  const next = {
    ...row,
    app: entry.status === 'failed' ? { ...app } : { installed: entry.to, installed_at: entry.at },
    last_checked_at: String(row.last_checked_at || '') || entry.at,
    last_update: record,
    history: [record, ...history].slice(0, 20),
  };
  return setSystemSetting(versionStateKey, next);
};

/** A version without its `v`, so a tag and a `package.json` value compare as the same release. */
const asPlainVersion = (value: string) => String(value || '').trim().replace(/^v/i, '');

/**
 * A server check, translated into the row the sidebar badge reads.
 *
 * Dashboard → Updates asks the server (`checkForUpdates` above) because the server is what compares release
 * tags and what knows how an update would be applied. The badge and the Overview banner are fed by the
 * `options` row `loadUpdateStatus` reads on every admin load — so the answer is written back in that shape.
 * One check, one result, both screens agree.
 *
 * `latest` carries the *newest* release, which is what `availableUpdates` compares against the running
 * build, so an answer of "up to date" clears the badge rather than leaving yesterday's count behind.
 */
export const updateStatusFrom = (answer: UpdateCheckAnswer): UpdateStatus => {
  const installed = asPlainVersion(answer.app?.installed || answer.installedVersion || installedAppVersion);
  const latest = asPlainVersion(answer.app?.latest || answer.latestVersion || '');
  const notes = (release: UpdateRelease | null | undefined) => ({
    version: asPlainVersion(release?.version || ''),
    tag: release?.tag || '',
    released: release?.released || '',
    notes: release?.notes || [],
    changelog_url: release?.changelog_url || '',
  });
  return {
    checked_at: answer.checked_at || new Date().toISOString(),
    error: answer.error || '',
    source: answer.source === 'central' ? 'central' : 'github',
    installed,
    latest: latest
      ? {
        ...notes(answer.app?.release),
        version: latest,
        tag: answer.app?.release?.tag || answer.app?.latest_tag || `v${latest}`,
      }
      : null,
    plugins: Object.fromEntries(
      Object.entries(answer.plugins || {})
        .filter(([, release]) => Boolean(release))
        .map(([id, release]) => [id, { ...notes(release), version: asPlainVersion(release!.version) }]),
    ),
  };
};

/**
 * The two scheduling settings, read from the server.
 *
 * They live in `system_settings.updates_config` — the same row the screen writes — so there is one copy of
 * "check weekly, notify" rather than a second one in `options`. `defaultUpdateSettings` is the answer when
 * the row cannot be read, which is the state of a deployment whose server cannot see `system_settings`.
 */
export const settingsFromConfig = (config?: UpdateConfigView | null): UpdateSettings => ({
  auto_check: config?.auto_check && config.auto_check in autoCheckIntervals ? config.auto_check : defaultUpdateSettings.auto_check,
  notify: typeof config?.notify === 'boolean' ? config.notify : defaultUpdateSettings.notify,
});

/** Saves the two scheduling settings, keeping the rest of the row as it is. */
export const saveUpdateSettings = (settings: UpdateSettings) =>
  saveUpdateConfig({ auto_check: settings.auto_check, notify: settings.notify });

/**
 * Runs the scheduled check when it is due — once per admin load, from `useAdminStatus`.
 *
 * The version answer is the server's (`checkForUpdates`), and it replaces the stored row, so a site that
 * has just been deployed stops reporting an update the moment the admin is opened. A failure is thrown
 * rather than stored as an empty answer: the badge must keep the last known release instead of losing it
 * because GitHub was unreachable for a minute.
 */
export const runScheduledUpdateCheck = async (): Promise<{ settings: UpdateSettings; status: UpdateStatus | null }> => {
  const stored = await loadUpdateStatus().catch(() => null);
  // Settings are a database read on the server; a screen that cannot reach them still checks on the default.
  const overview = await fetchUpdatesOverview().catch(() => null);
  const settings = settingsFromConfig(overview?.config);
  if (!isCheckDue(settings.auto_check, stored?.checked_at)) return { settings, status: stored };
  const status = updateStatusFrom(await checkForUpdates());
  await saveUpdateStatus(status).catch(() => undefined);
  return { settings, status };
};


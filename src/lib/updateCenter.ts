/**
 * Browser half of Dashboard → Updates: the check, the version picker, the apply, and the progress of a
 * self-update.
 *
 * The five endpoints behind this file are served by both hosts — `server/updateRoutes.mjs` on
 * `node server.mjs` and `src/server/routes/updates.ts` on the universal engine — and answer the same
 * JSON, because both call the same shared modules. The server reads the release list from GitHub (the
 * public release repository); nothing here talks to GitHub or react-wp.com, and nothing here ever sees a
 * token: the answers carry `has_token` at most.
 *
 * The shapes below mirror the shared modules' returns. They are declared here rather than imported from a
 * `.d.mts`, because the screen is what reads them and a change on the server must show up as a type error
 * in the component that renders it.
 *
 * Two things this file deliberately does *not* do: it never guesses whether an update exists (the server
 * compares versions, and a browser-side comparison could disagree with the plan the apply step would use),
 * and it never reports an update as installed (the run record says what happened).
 */
import { client, getSystemSetting, setSystemSetting } from './db';
import { rwp } from './rwp';
import { callLink } from './licenseLinkApi';
import { LEGACY_UPDATE_CONFIG_KEYS, nextUpdateConfigRow } from './updateConfigRow';
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

/** A release as the browser may see it: no download URL, which only an installer needs. */
export interface UpdateRelease {
  version: string;
  /** The published tag, `v2.4.1`. What the screen shows; `version` is the same release without the `v`. */
  tag: string;
  /**
   * What the release is called on GitHub (`v2.6.3 … | Fix plugin licensing`), when it was given a name.
   * Absent on a bare tag, on a release titled only with its own tag, and on rows written before the title
   * was carried — which is why nothing decides anything from it.
   */
  title?: string;
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

/**
 * `updates_config` as the server describes it back. It holds no secret. An update-server address, token or
 * channel written by an older version is not part of it: they are ignored, and removed from the row the next
 * time the settings are saved (`saveUpdateConfig`).
 */
export interface UpdateConfigView {
  /** `owner/name` of the release repository named on this screen; empty means the default. */
  repository: string;
  auto_check: AutoCheck;
  notify: boolean;
  /** Opt-in: whether `POST /api/admin/system/update` may rewrite this server's checkout. */
  self_update: boolean;
}

/**
 * The release repository a check reads, and whether a GitHub token is used to read it. The token is the
 * optional one saved under Settings → Integrations → GitHub; it only lifts GitHub's anonymous rate limit and
 * is never sent to the browser.
 */
export interface GithubSourceView {
  repo: string;
  has_token: boolean;
  configured: boolean;
  /** Where the name came from: this screen, the deployment's environment, or the built-in default. */
  origin: 'saved' | 'environment' | 'default';
}

/** What this host can do with an update. `reason` is written to be shown, never parsed. */
export interface UpdateSupport {
  available: boolean;
  /** True when this server runs from a git checkout, which is what "update its own checkout" needs. */
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

/** One of the five most recent stable releases, as the picker shows it. */
export interface RecentRelease {
  tag: string;
  version: string;
  title: string;
  released: string;
  /** The first few lines of the release notes. */
  notes: string[];
  changelog_url: string;
  critical: boolean;
  /** The newest release. */
  latest: boolean;
  /** The release this site runs. */
  installed: boolean;
  /** What choosing it means: `downgrade` needs an explicit confirmation. */
  move: 'upgrade' | 'current' | 'downgrade';
}

/** `POST /api/admin/updates/releases`: the picker's list, newest first. */
export interface RecentReleases {
  repository: string;
  checked_at: string;
  cached: boolean;
  /** True when GitHub could not be asked just now and the last list is shown (`warning` says why). */
  stale: boolean;
  warning: string;
  installed: string;
  latest_tag: string;
  releases: RecentRelease[];
}

/** The answer to one check: both sources converge on this shape (`checkAnswerFrom`). */
export interface UpdateCheckAnswer {
  format: 'rwp-update-center';
  version: 1;
  source: 'github';
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
  /** Newest commit of the update repository; sent to the platform owner only. */
  latestCommit?: { sha: string; title: string; description: string; author: string; date: string; url: string } | null;
  /** Set when GitHub could not be refreshed just now and the last release list is shown. Written to be shown. */
  error: string;
  /** The five most recent stable releases, for the version picker. */
  releases: RecentReleases;
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
  /** Whether "let this server update its own checkout" can ever apply on this host (a git checkout). */
  can_self_update: boolean;
  /** Whether this site deploys from its own GitHub repository and Vercel project: it updates through the core update. */
  git_deploy: boolean;
  /** The central plugin directory, for the Marketplace screen. */
  plugin_directory: string;
  auto_check: string[];
  /** True only for the owner on a deployment that sets `OWNER_GITHUB_REPO`: the screen shows just the latest commit and release. */
  owner_commit_view?: boolean;
}

/**
 * How an update would be applied. `up_to_date` is a `manual` plan whose reason says so.
 *
 *   - `manual` — nowhere to send it; `reason` names what to do (or that it is already current).
 *   - `self` — a server that owns its checkout runs the update itself.
 *   - `deploy-hook` — a saved hook URL rebuilds the site on its host.
 *
 * A site connected to its own GitHub repository and Vercel project does not use this: Dashboard → Updates
 * shows the core update flow for it (`git: true` marks the plan that points there).
 */
export interface UpdatePlan {
  mode: 'manual' | 'deploy-hook' | 'self';
  up_to_date?: boolean;
  git?: boolean;
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
  /** Where the runner backed up the files an update replaced. */
  backup?: string;
  restart: 'pm2' | 'manual';
  app_name: string;
  /** True when nobody restarted the site for the administrator — the screen says what to run. */
  restart_required: boolean;
  log_path: string;
  error: string;
}

/**
 * What `applyUpdate` produced.
 *
 * `manual` is not a failure of the request: it is the route saying "this host cannot do this", and
 * `plan.reason` carries the sentence. Anything the server refuses outright (a tag that is not in the list,
 * a downgrade nobody confirmed, a non-owner) throws an `UpdateRequestError` whose message is the server's
 * sentence — never a bare status.
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
  | { kind: 'self'; run: SelfUpdateRun; plan: UpdatePlan; check: UpdateCheckAnswer };

/**
 * A server refusal. `message` is always a sentence; `needsConfirmation` is set when the server asks for an
 * explicit "yes" (`downgrade`) before it will do the thing.
 */
export class UpdateRequestError extends Error {
  status: number;
  needsConfirmation: string;
  constructor(message: string, status: number, needsConfirmation = '') {
    super(message);
    this.name = 'UpdateRequestError';
    this.status = status;
    this.needsConfirmation = needsConfirmation;
  }
}

/**
 * The sentence for a refusal whose body named none. The server always names one (`refusalBody`), so this is
 * the safety net for a proxy or a platform error page in front of it — and it says what the status means
 * instead of printing it bare.
 */
export const sentenceForStatus = (status: number): string => {
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return 'Your account is not allowed to do this. Only the site owner (the Administrator account) can apply updates.';
  if (status === 404) return 'The update service did not answer. Reload the page. If it keeps happening, tell whoever looks after this site.';
  if (status === 409) return 'The update could not start because the site is not in a state that allows it. Reload the page and try again; the Updates screen shows what to do next.';
  if (status === 428) return 'The update needs your confirmation first. Review it on the Updates screen and confirm.';
  if (status === 429) return 'Too many requests just now. Wait a minute and try again.';
  if (status >= 500) return 'The site’s server hit a problem while handling the request. Nothing was changed. Try again in a minute; if it repeats, tell whoever looks after this site.';
  return 'The update request was refused. Reload the page and try again.';
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
 * `applyUpdate` has to tell a 409 (a plan this host cannot carry out) apart from a 502 (a deploy hook that
 * refused), so the status is part of the answer rather than an exception. A bodyless 404 means the endpoint
 * is not there at all — a static SPA, or a fetch that never reached the API server — and that is reported as
 * such, because it sends the administrator somewhere different.
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
    throw new Error('This site’s server could not be reached, so nothing was changed. Check your internet connection and try again.');
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 404 && !body.error) {
    throw new Error(sentenceForStatus(404));
  }
  return { status: response.status, body };
};

/** The sentence a non-200 answer carries: its `error`, else its plan's reason, else the status explained. */
const refusalOf = (status: number, body: { error?: string; plan?: { reason?: string }; needs_confirmation?: string }): UpdateRequestError =>
  new UpdateRequestError(
    String(body.error || body.plan?.reason || sentenceForStatus(status)),
    status,
    typeof body.needs_confirmation === 'string' ? body.needs_confirmation : '',
  );

/**
 * `POST /api/admin/updates/check` — reads the release repository's stable release tags from GitHub (through
 * this site's own server) and compares the newest with what is installed.
 *
 * The plugin list travels with the request because only the browser knows what this build activated.
 */
export const checkForUpdates = async (): Promise<UpdateCheckAnswer> => {
  const { status, body } = await request<UpdateCheckAnswer & { error?: string }>('/api/admin/updates/check', {
    method: 'POST',
    body: JSON.stringify({ plugins: installedPlugins() }),
  });
  if (status !== 200) throw refusalOf(status, body);
  return body;
};

/**
 * `POST /api/admin/updates/releases` — the five most recent stable releases, for the version picker. The
 * same call serves Dashboard → Updates and Settings → Integrations → GitHub & Vercel. `refresh` asks for a
 * fresh read; the server still limits how often it may go to GitHub.
 */
export const fetchRecentReleases = async (refresh = false): Promise<RecentReleases> => {
  const { status, body } = await request<RecentReleases & { error?: string }>('/api/admin/updates/releases', {
    method: 'POST',
    body: JSON.stringify(refresh ? { refresh: true } : {}),
  });
  if (status !== 200) throw refusalOf(status, body);
  return body;
};

/** One commit of the owner's repository, as the owner-only Latest commit panel shows it. */
export interface OwnerCommit {
  sha: string;
  title: string;
  description: string;
  author: string;
  date: string;
  url: string;
}

/** `POST /api/admin/updates/commits`: one page of commits. `page` is 0-based. */
export interface OwnerCommitPage {
  commits: OwnerCommit[];
  hasMore: boolean;
  page: number;
  perPage: number;
}

/** `POST /api/admin/updates/commits` — one page of the owner's commits (platform owner only). */
export const fetchOwnerCommits = async (page = 0, perPage = 10): Promise<OwnerCommitPage> => {
  const { status, body } = await request<OwnerCommitPage & { error?: string }>('/api/admin/updates/commits', {
    method: 'POST',
    body: JSON.stringify({ page, perPage }),
  });
  if (status !== 200) throw refusalOf(status, body);
  return body;
};

/**
 * `POST /api/admin/system/update` — applies one of the five listed releases, however this host can.
 *
 * `tag` is a tag from the picker (empty means the latest); the server re-reads the list and refuses anything
 * else. Choosing an older tag than the one installed needs `confirmDowngrade: true`, which only the screen's
 * explicit confirmation sets. The route decides between a deploy hook, a self-update run and a plan that says
 * what to do; every non-200 answer is turned into an `UpdateRequestError` carrying the server's sentence.
 */
export const applyUpdate = async (options: { tag?: string; confirmDowngrade?: boolean } = {}): Promise<UpdateOutcome> => {
  const { status, body } = await request<Record<string, unknown> & { error?: string; needs_confirmation?: string }>('/api/admin/system/update', {
    method: 'POST',
    body: JSON.stringify({
      plugins: installedPlugins(),
      tag: options.tag || '',
      confirmDowngrade: options.confirmDowngrade === true,
    }),
  });
  const plan = body.plan as UpdatePlan | undefined;
  const check = body.check as UpdateCheckAnswer | undefined;
  if (!plan || !check) throw refusalOf(status, body);
  if (plan.up_to_date) return { kind: 'up_to_date', plan, check };
  if (plan.mode === 'manual') return { kind: 'manual', plan, check };
  if (plan.mode === 'deploy-hook') {
    return {
      kind: 'deploy',
      queued: body.queued === true,
      message: String(body.message || body.error || ''),
      deploy: body.deploy as { configured: boolean; triggered: boolean; status?: number; error?: string },
      plan,
      check,
    };
  }
  if (status >= 400 || !body.run) throw refusalOf(status, body);
  return { kind: 'self', run: body.run as SelfUpdateRun, plan, check };
};

/** `GET /api/admin/system/update-status?id=<run>` — one run and its log tail. */
export const fetchUpdateRun = async (id: string): Promise<{ run: SelfUpdateRun; log: string }> => {
  const query = `?id=${encodeURIComponent(id)}`;
  const { status, body } = await request<{ run: SelfUpdateRun; log: string; error?: string }>(
    `/api/admin/system/update-status${query}`,
  );
  if (status !== 200) throw refusalOf(status, body);
  return body;
};

/** The same route with no id: the recent runs, newest first, and what this host can do. */
export const fetchUpdateRuns = async (): Promise<{ runs: SelfUpdateRun[]; support: UpdateSupport }> => {
  const { status, body } = await request<{ runs: SelfUpdateRun[]; support: UpdateSupport; error?: string }>(
    '/api/admin/system/update-status',
  );
  if (status !== 200) throw refusalOf(status, body);
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
  if (status !== 200) throw refusalOf(status, body);
  return body;
};

/* -- Writing the two rows the screen owns --------------------------------------------------------- */

/**
 * Row keys older versions wrote and nothing reads any more: the update server's address, its bearer token and
 * the release channel. They are removed whenever the settings are saved, so a stored token does not outlive
 * the screen that used it.
 */
export const legacyUpdateConfigKeys = LEGACY_UPDATE_CONFIG_KEYS;

/**
 * Saves `system_settings.updates_config`, keeping whatever the patch does not name and dropping the keys in
 * `legacyUpdateConfigKeys`.
 *
 * Written from the browser because that is where the administrator is: the server reads this row with a
 * service key or a direct connection, and never needs to write it.
 */
export const saveUpdateConfig = async (patch: Partial<UpdateConfigView>) => {
  const stored = await getSystemSetting<Record<string, unknown>>(updateConfigKey, {});
  const next = nextUpdateConfigRow(stored, patch);
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
  /**
   * How the release arrived. `manual` is a plan this host could not carry out, recorded so the screen can
   * say so later; `self` is a run this server performed itself; `deploy-hook` is a hook that was called, and
   * the new version arrives on a *later* deployment, so it is settled by the next check; `git` is a core
   * update committed to the site's own repository (Vercel's deployment state settles it). `platform` is
   * only ever read from rows an older version wrote.
   */
  mode: 'deploy-hook' | 'self' | 'manual' | 'git' | 'platform';
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
    title: release?.title || '',
    released: release?.released || '',
    notes: release?.notes || [],
    changelog_url: release?.changelog_url || '',
  });
  return {
    checked_at: answer.checked_at || new Date().toISOString(),
    error: answer.error || '',
    source: 'github',
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
  if (!isCheckDue(settings.auto_check, stored?.checked_at)) return { settings, status: await withSoldPluginVersions(stored) };
  const status = updateStatusFrom(await checkForUpdates());
  await saveUpdateStatus(status).catch(() => undefined);
  return { settings, status: await withSoldPluginVersions(status) };
};

/**
 * Adds the sold plugins' newest versions to the status the badge and the banner read. They are not on GitHub:
 * react-wp.com tells this site, at each account sync, which version it is licensed for, and that is kept on the
 * connection row. Only the platform owner can read it, so for anyone else (and for a site that is not
 * connected) the status is returned unchanged. It is merged for display and never stored.
 */
const withSoldPluginVersions = async (status: UpdateStatus | null): Promise<UpdateStatus | null> => {
  if (!status) return status;
  try {
    const { answer } = await callLink('', 'GET');
    const latest = answer.link?.connected ? answer.link.latestVersions || {} : {};
    const entries = Object.entries(latest).filter(([, version]) => Boolean(version));
    if (!entries.length) return status;
    return {
      ...status,
      plugins: {
        ...(status.plugins || {}),
        ...Object.fromEntries(entries.map(([id, version]) => [id, { version, tag: `${id}-v${version}`, title: '', released: '', notes: [], changelog_url: '' }])),
      },
    };
  } catch {
    return status;
  }
};


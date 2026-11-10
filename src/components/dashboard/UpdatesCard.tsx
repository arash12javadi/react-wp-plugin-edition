/**
 * The in-app update card: check, choose a version, apply, and watch it happen.
 *
 * A version is published by tagging a release on GitHub, and this site reads the releases **directly from
 * GitHub** — the public release repository (`arash12javadi/react-wp-plugin-edition` unless "Release
 * repository" below names another). No account, token or update server is involved, and react-wp.com is not
 * called. The server does the reading (cached for a few minutes, with a plain sentence when GitHub limits it
 * or the repository is private), so the version compared is the version that is running.
 *
 * How an update is applied is the server's decision, and the card shows which:
 *
 *   - **Connected to its own GitHub and Vercel** (`overview.git_deploy`): the card *is* the core-update flow
 *     (`CoreUpdatePanel` — review the plan, decide conflicts, commit, follow Vercel). There is no second
 *     "Update now" button next to it.
 *   - **A deploy hook** on Vercel/Netlify, or **a detached run** on a server that owns its checkout: one
 *     "Update now" button for the release picked in the version picker.
 *   - **Neither**: one sentence naming what to set up, instead of a button that could only fail.
 *
 * Rules this component keeps:
 *
 *   - **Never claim an update is installed.** A self-update run reports its own outcome, a deploy hook is
 *     settled by the next check, and a core update is settled by Vercel's deployment state. Only a finished
 *     run is recorded in `system_settings.version_state`, and a failed one leaves the recorded version alone.
 *   - **Errors only when something failed, and they say why.** The server answers every refusal with a
 *     sentence (`UpdateRequestError`); a plan that simply cannot be applied here is shown as information.
 *   - **Progress in order**: checking, downloading, committing (applying), deploying, ready.
 *   - **No secret ever reaches this screen.** The optional GitHub token lives on the server.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  applyUpdate, checkForUpdates, fetchUpdateRun, fetchUpdateRuns, fetchUpdatesOverview, installedAppVersion,
  isRunInFlight, readVersionState, recordVersionState, saveUpdateConfig, updateStatusFrom,
  type SelfUpdateRun, type UpdateCheckAnswer, type UpdateConfigView, type UpdatesOverview, type VersionStateEntry,
} from '../../lib/updateCenter';
import { autoCheckIntervals, compareVersions, saveUpdateStatus, type AutoCheck, type UpdateStatus } from '../../lib/updates';
import type { UserRole } from '../../lib/roles';
import CoreUpdatePanel from '../update/CoreUpdatePanel';
import ReleasePicker, { useRecentReleases } from '../update/ReleasePicker';
import UpdateStages, { type UpdateStage } from '../update/UpdateStages';
import styles from './Dashboard.module.css';

/** How long the screen waits between polls of a running self-update. */
const pollIntervalMs = 2500;

/**
 * How long a deploy hook is allowed to look like "deploying" before the screen says "building".
 *
 * There is nothing to poll: Vercel and Netlify report a build in their own dashboard, not to a webhook
 * caller. So the first stage is the request, and the second is the minute or two the platform spends
 * rebuilding — a label that tracks what is actually happening rather than one that claims a percentage
 * nobody measured.
 */
const deployStageMs = 20_000;

/**
 * How long a Vercel or Netlify build usually takes, in seconds — printed next to the countdown so the number
 * that is ticking has something to be compared against. Not a deadline: the hook reports nothing, and a build
 * that takes longer is normal.
 */
const typicalBuildSeconds = 150;

/** The countdown's upper reference, when the screen stops saying "almost there". */
const slowBuildSeconds = 240;

/** The default release repository, shown as the field's placeholder. */
const defaultRepository = 'arash12javadi/react-wp-plugin-edition';

/** A version as the release is tagged, `v2.4.1`. Used for display only; comparisons take plain versions. */
const asTag = (version: string) => {
  const value = String(version || '').trim();
  if (!value) return '';
  return /^v/i.test(value) ? value : `v${value}`;
};

const timeAgo = (iso: string) => {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  const units: Array<[number, string]> = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month']];
  const [size, unit] = [...units].reverse().find(([limit]) => seconds >= limit) || units[0];
  const amount = Math.floor(seconds / size);
  return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
};

/** What each step of a self-update means, in the words the screen shows. */
const stepLabels: Record<string, string> = {
  starting: 'Starting',
  fetching: 'Fetching the new version',
  downloading: 'Downloading the release',
  extracting: 'Reading the release package',
  applying: 'Applying the core files',
  'preserving-plugins': 'Keeping your plugins untouched',
  'installing-packages': 'Installing packages',
  building: 'Building',
  restarting: 'Restarting the site',
  done: 'Finished',
  failed: 'Failed',
};

/** Which of the five stages a self-update step belongs to. */
const stageOfStep = (step: string): UpdateStage => {
  if (step === 'starting') return 'checking';
  if (['fetching', 'downloading', 'extracting'].includes(step)) return 'downloading';
  if (['applying', 'preserving-plugins'].includes(step)) return 'committing';
  return 'deploying';
};

const message = (value: unknown, fallback: string) => (value instanceof Error && value.message ? value.message : fallback);

/** `owner/repository` from what a person pastes — a GitHub address included — or `''` when it is not one. */
const normaliseRepository = (value: string): string | null => {
  const raw = value.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!raw) return '';
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(raw) ? raw : null;
};

export default function UpdatesCard({ role, onStatus }: {
  role: UserRole;
  onStatus?: (status: UpdateStatus) => void;
  /** Kept for the dashboard shell's call; this card links nowhere that needs it. */
  navigate?: (section: string, subsection?: string) => void;
}) {
  // The one account that applies updates: the Setup Wizard's `administrator`. Any other role that can open the
  // screen sees the check and the schedule, and is told who can apply.
  const isOwner = role === 'administrator';
  const [overview, setOverview] = useState<UpdatesOverview | null>(null);
  const [check, setCheck] = useState<UpdateCheckAnswer | null>(null);
  const [run, setRun] = useState<SelfUpdateRun | null>(null);
  const [log, setLog] = useState('');
  const [recent, setRecent] = useState<SelfUpdateRun[]>([]);
  const [form, setForm] = useState<UpdateConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  /** An answer that is information rather than a failure: this host cannot apply it, and why. */
  const [notice, setNotice] = useState('');
  const [stage, setStage] = useState<UpdateStage>('idle');
  const [stageFailed, setStageFailed] = useState(false);
  /** `deploying` while the hook is being called, `building` while the platform rebuilds the site. */
  const [deployStage, setDeployStage] = useState<'' | 'deploying' | 'building'>('');
  /** When the hook answered, so the build the platform is running can be counted rather than guessed at. */
  const [deployStartedAt, setDeployStartedAt] = useState(0);
  const [buildSeconds, setBuildSeconds] = useState(0);
  // Read once per mount and written after a run: a poll must not cost a database round trip of its own.
  const versionState = useRef<Record<string, unknown> | null>(null);
  const deployTimer = useRef<number | null>(null);
  const gitDeploy = Boolean(overview?.git_deploy);
  // The picker for the hook/self-update flows. A connected site has its own inside `CoreUpdatePanel`.
  const picker = useRecentReleases(isOwner && Boolean(overview) && !gitDeploy && !overview?.owner_commit_view);

  /** Stops the deploy-stage timer, so a stage cannot survive the screen it belonged to. */
  const stopDeployTimer = useCallback(() => {
    if (deployTimer.current !== null) window.clearTimeout(deployTimer.current);
    deployTimer.current = null;
  }, []);

  useEffect(() => stopDeployTimer, [stopDeployTimer]);

  /**
   * The build countdown: one second at a time, from the moment the hook answered.
   *
   * A deploy hook is fire-and-forget — Vercel and Netlify report the build in their own dashboard — so this is
   * the only progress this screen can honestly show. It stops the moment the stage is cleared, which a check
   * that finds the new version does.
   */
  useEffect(() => {
    if (deployStage !== 'building' || !deployStartedAt) return undefined;
    const tick = () => setBuildSeconds(Math.max(0, Math.round((Date.now() - deployStartedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deployStage, deployStartedAt]);

  /**
   * Shows an answer and hands it to the screens that still read `options.rwp_update_status` — the sidebar
   * badge and the Overview banner are driven by `runScheduledUpdateCheck`, so one check keeps all three
   * in step instead of a fresh count sitting next to a stale one.
   */
  const publish = useCallback((answer: UpdateCheckAnswer | null) => {
    setCheck(answer);
    if (!answer) return;
    const status = updateStatusFrom(answer);
    onStatus?.(status);
    void saveUpdateStatus(status).catch(() => undefined);
  }, [onStatus]);

  /** Writes what happened into `system_settings.version_state`, and keeps the copy in this tab current. */
  const remember = useCallback(async (entry: Parameters<typeof recordVersionState>[1]) => {
    const accepted = await recordVersionState(versionState.current, entry);
    if (!accepted) return false;
    versionState.current = await readVersionState().catch(() => versionState.current);
    return true;
  }, []);

  /**
   * Closes the loop on an update this screen could not watch.
   *
   * A deploy hook has no log to follow: it is fire-and-forget. The only evidence that the new build is live is
   * the *next* check: it compares the newest release against the tag the running build reports. So when a
   * check finds nothing left to do while the recorded outcome still says a hook was triggered for that same
   * version, the record becomes `completed` and the screen says so once, with the tag.
   */
  const settleDeploy = useCallback(async (answer: UpdateCheckAnswer) => {
    const pending = (versionState.current as { last_update?: VersionStateEntry } | null)?.last_update;
    if (!pending || pending.mode !== 'deploy-hook' || pending.status !== 'triggered') return;
    if (answer.updateAvailable ?? answer.app.update_available) return;
    const applied = answer.app.latest || '';
    // A build that comes back *older* than the tag that was deployed is not the success this is looking
    // for: it means the platform served a cached build, and claiming otherwise would be a lie.
    if (pending.to && applied && compareVersions(applied, pending.to) < 0) return;
    stopDeployTimer();
    setDeployStage('');
    setDeployStartedAt(0);
    setBuildSeconds(0);
    setStage('ready');
    try {
      await remember({
        at: new Date().toISOString(),
        from: pending.from || answer.app.installed,
        to: applied || pending.to,
        mode: pending.mode,
        status: 'completed',
      });
    } catch {
      // The check the administrator asked for already succeeded; a failed record must not hide that.
    }
    setFeedback(`🎉 Update successful to ${asTag(applied || pending.to)}!`);
  }, [remember, stopDeployTimer]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // The overview and the history are independent, so one waits for nothing: a host that cannot list
      // runs (a serverless function with no `.rwp-tmp`) must still render the screen.
      const [next, stored, history] = await Promise.all([
        fetchUpdatesOverview(),
        readVersionState().catch(() => null),
        fetchUpdateRuns().catch(() => ({ runs: [] as SelfUpdateRun[] })),
      ]);
      setOverview(next);
      setForm(next.config);
      versionState.current = (stored || null) as Record<string, unknown> | null;
      setRecent(history.runs);
      // A run that was started before this tab was opened is picked up mid-flight.
      const inFlight = history.runs.find((entry) => isRunInFlight(entry));
      if (inFlight) setRun(inFlight);
    } catch (loadError) {
      setError(message(loadError, 'The Updates screen could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Records how a run ended. Only a finished (`done`) run moves the installed version forward. */
  const finishRun = useCallback(async (record: SelfUpdateRun) => {
    const succeeded = record.status === 'done' || record.status === 'completed';
    const restartNote = record.restart_required
      ? ` Restart the site to run it: pm2 restart ${record.app_name || '<name>'} (or npm start).`
      : '';
    if (succeeded) {
      setStage('ready');
      setStageFailed(false);
      setFeedback(`🎉 Update successful to ${asTag(record.to)}!${restartNote}`);
    } else {
      setStageFailed(true);
      setError(`The update did not finish: ${record.error || stepLabels[record.step] || record.step}. The site keeps running the version it had.`);
    }
    await remember({
      at: record.finished_at || new Date().toISOString(),
      from: record.from,
      to: record.to,
      mode: 'self',
      status: succeeded ? 'completed' : 'failed',
      ...(succeeded ? {} : { error: record.error || record.step }),
    });
    if (succeeded) await load();
  }, [load, remember]);

  // The poll: one timer at a time, re-armed by the run it is watching, so a finished run stops it.
  useEffect(() => {
    if (!isRunInFlight(run) || !run) return undefined;
    const { id } = run;
    const timer = window.setTimeout(async () => {
      try {
        const answer = await fetchUpdateRun(id);
        setRun(answer.run);
        setLog(answer.log);
        if (isRunInFlight(answer.run)) setStage(stageOfStep(answer.run.step));
        else await finishRun(answer.run);
      } catch (pollError) {
        setError(message(pollError, 'The progress of this update could not be read.'));
      }
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [run, finishRun]);

  const checkNow = async () => {
    setChecking(true);
    setError('');
    setFeedback('');
    setNotice('');
    try {
      const answer = await checkForUpdates();
      publish(answer);
      setOverview((current) => (current ? { ...current, config: answer.config, github: answer.github, readable: answer.readable } : current));
      const latest = asTag(answer.latestVersion || answer.app.latest_tag || answer.app.latest);
      setFeedback((answer.updateAvailable ?? answer.update_available)
        ? `An update is available — latest release ${latest}.`
        : `Everything is up to date: ${asTag(answer.app.installed)} is the latest release GitHub publishes.`);
      await settleDeploy(answer);
    } catch (checkError) {
      setError(message(checkError, 'The update check failed.'));
    } finally {
      setChecking(false);
    }
  };

  const updateNow = async () => {
    if (picker.blocked) {
      setError('You chose an older version. Tick the confirmation under the version list to continue.');
      return;
    }
    setApplying(true);
    setError('');
    setFeedback('');
    setNotice('');
    setStageFailed(false);
    setStage('checking');
    try {
      const outcome = await applyUpdate({ tag: picker.selected, confirmDowngrade: picker.confirmed });
      publish(outcome.check);
      if (outcome.kind === 'up_to_date') {
        setStage('idle');
        setFeedback(outcome.plan.reason);
        await settleDeploy(outcome.check);
        return;
      }
      if (outcome.kind === 'manual') {
        // Not a failure: this host cannot apply it, and the sentence says what to set up.
        setStage('idle');
        setNotice(outcome.plan.reason);
        return;
      }
      if (outcome.kind === 'deploy') {
        await remember({
          at: new Date().toISOString(),
          from: outcome.check.app.installed,
          to: outcome.check.app.latest,
          mode: 'deploy-hook',
          status: outcome.queued ? 'triggered' : 'failed',
          ...(outcome.queued ? {} : { error: outcome.deploy?.error || 'The deploy hook refused.' }),
        });
        if (!outcome.queued) {
          setStageFailed(true);
          setError(outcome.message || 'The deploy hook did not start a build. Check the hook under Settings → Integrations → Deployments.');
          return;
        }
        // Two stages, because a deploy hook answers once and then builds elsewhere: the request itself,
        // and the rebuild the platform is now doing. The check that follows the rebuild is what turns
        // this into the success message, so the button stays available instead of a spinner that lies.
        stopDeployTimer();
        setDeployStartedAt(Date.now());
        setBuildSeconds(0);
        setDeployStage('deploying');
        setStage('deploying');
        deployTimer.current = window.setTimeout(() => setDeployStage('building'), deployStageMs);
        setFeedback(`Deploying update… The deploy hook was called for ${asTag(outcome.check.app.latest)}. The platform is rebuilding this site now.`);
        return;
      }
      stopDeployTimer();
      setDeployStage('');
      setDeployStartedAt(0);
      setBuildSeconds(0);
      setRun(outcome.run);
      setLog('');
      setStage(stageOfStep(outcome.run.step));
      setRecent((current) => [outcome.run, ...current].slice(0, 10));
      setFeedback(outcome.run.restart_required
        ? 'The update is running in the background. When it finishes, restart the site with npm start (or pm2 restart).'
        : 'The update is running in the background. This page follows it until it finishes.');
      await remember({
        at: new Date().toISOString(),
        from: outcome.run.from,
        to: outcome.run.to,
        mode: 'self',
        status: 'started',
      });
    } catch (applyError) {
      // Only here — the server refused, or could not be reached — is there an error to show, and it carries
      // the server's own sentence.
      setStageFailed(true);
      setError(message(applyError, 'The update could not be started. Nothing was changed.'));
    } finally {
      setApplying(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    const repository = normaliseRepository(form.repository ?? '');
    if (isOwner && repository === null) {
      setError(`The release repository must look like owner/repository, for example ${defaultRepository}.`);
      return;
    }
    setSaving(true);
    setError('');
    setFeedback('');
    try {
      // A non-owner's patch names only the two scheduling settings, so a save can never overwrite the owner's
      // repository or self-update switch with the redacted values this screen showed them. Every save also
      // removes the keys older versions stored (an update-server address and token), so nothing stale lingers.
      await saveUpdateConfig(isOwner
        ? {
          repository: repository || '',
          auto_check: form.auto_check,
          notify: form.notify,
          self_update: overview?.can_self_update ? form.self_update : false,
        }
        : { auto_check: form.auto_check, notify: form.notify });
      setFeedback('Update settings saved.');
      await load();
    } catch (saveError) {
      setError(message(saveError, 'The update settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  // Owner view (the server sets `owner_commit_view` only for the owner on a deployment that names
  // `OWNER_GITHUB_REPO`): no Update now / source / schedule controls, just the latest dev-edition commit and
  // the latest release. One check runs on its own so both are filled without a click.
  // The server decides (platform owner, narrowed by RWP_OWNER_EMAIL), so a `super_admin` owner gets it too.
  const ownerView = Boolean(overview?.owner_commit_view);
  useEffect(() => {
    if (!ownerView || check) return;
    let cancelled = false;
    checkForUpdates()
      .then((answer) => { if (!cancelled) publish(answer); })
      .catch((checkError) => { if (!cancelled) setError(message(checkError, 'The latest release could not be read.')); });
    return () => { cancelled = true; };
  }, [ownerView, check, publish]);

  if (loading) {
    return (
      <section className={styles.panel} aria-busy="true">
        <h2>🔄 Updates</h2>
        <p className={styles.muted}>Reading this site&apos;s version…</p>
      </section>
    );
  }

  const support = overview?.support;
  const updates = check?.updates || [];
  const busy = checking || applying || isRunInFlight(run);
  // The tag is what the screen shows; `version` is the same release without the `v`, and is what the
  // comparisons used. A host that has not checked yet only knows what it runs.
  const installedTag = asTag(check?.installedVersion || overview?.installed || installedAppVersion);
  const latestTag = asTag(check?.latestVersion || check?.app?.latest_tag || check?.app?.latest || '');
  const coreUpdate = check ? (check.updateAvailable ?? check.app.update_available) : false;
  const releaseUrl = check?.releaseUrl || check?.app?.release?.changelog_url || '';
  // A host with nothing to apply an update with (no git checkout, no hook, no GitHub & Vercel connection) gets
  // the reason instead of a button whose only answer would be a refusal.
  const cannotApply = isOwner && !gitDeploy && Boolean(support) && support!.supported === false && !overview?.can_self_update;

  if (ownerView) {
    const commit = check?.latestCommit;
    return (
      <div className={styles.dashboard}>
        {error && <div className={styles.error} role="alert">{error}</div>}
        <section className={styles.panel} aria-labelledby="owner-release-heading">
          <h2 id="owner-release-heading">Latest release</h2>
          <p>
            <code>{latestTag || (check ? '—' : 'Reading…')}</code>
            {releaseUrl && (
              <> <a className={styles.versionLink} href={releaseUrl} target="_blank" rel="noreferrer">Release notes ↗</a></>
            )}
          </p>
        </section>
        <section className={styles.panel} aria-labelledby="owner-commit-heading">
          <h2 id="owner-commit-heading">Latest commit</h2>
          {commit ? (
            <>
              <p className={styles.muted}>
                {commit.sha ? <code>{commit.sha.slice(0, 7)}</code> : null}
                {commit.author ? ` · ${commit.author}` : ''}
                {commit.date ? ` · ${new Date(commit.date).toLocaleString()}` : ''}
                {commit.url && (
                  <> <a className={styles.versionLink} href={commit.url} target="_blank" rel="noreferrer">↗</a></>
                )}
              </p>
              <h3>{commit.title}</h3>
              {commit.description && (
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{commit.description}</pre>
              )}
            </>
          ) : (
            <p className={styles.muted}>
              {check ? 'GitHub did not return a commit. Check OWNER_GITHUB_REPO and OWNER_GITHUB_TOKEN_FOR_COMMIT_READING.' : 'Reading…'}
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {feedback && <div className={styles.success} role="status">{feedback}</div>}
      {notice && <div className={styles.warning} role="status">{notice}</div>}

      <section className={styles.panel} aria-labelledby="updates-card-heading">
        <div className={styles.panelHead}>
          <div>
            <h2 id="updates-card-heading">🔄 Updates</h2>
            <p className={styles.muted}>
              React-WP <code>{installedTag}</code>
              {overview?.github?.configured && overview.github.repo ? ` · releases read from ${overview.github.repo} on GitHub` : ''}
            </p>
          </div>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void checkNow()}>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {isOwner && !gitDeploy && !cannotApply && (
              <button type="button" className={styles.primaryButton} disabled={busy || picker.loading || !picker.current || picker.current.move === 'current'} onClick={() => void updateNow()}>
                {applying ? 'Starting…' : picker.current?.move === 'downgrade' ? 'Downgrade now' : 'Update now'}
              </button>
            )}
          </div>
        </div>

        {/* The tag, not a number from a `package.json`: installed on the left, the newest GitHub release on
            the right, and one badge that says which of the two questions this screen is answering. */}
        <div className={styles.versionBar}>
          <span className={styles.versionChip}>Installed <code>{installedTag}</code></span>
          <span className={styles.versionArrow} aria-hidden="true">→</span>
          <span className={styles.versionChip}>Latest release <code>{latestTag || '—'}</code></span>
          {!check ? (
            <span className={styles.badgeOk}>Not checked yet</span>
          ) : coreUpdate ? (
            <span className={styles.badgeWarn}>Update available: {latestTag || asTag(check.app.latest)}</span>
          ) : (
            <span className={styles.badgeOk}>Up to date</span>
          )}
          {releaseUrl && (
            <a className={styles.versionLink} href={releaseUrl} target="_blank" rel="noreferrer">
              Release notes ↗
            </a>
          )}
        </div>

        {isOwner && check?.latestCommit && (
          <div className={styles.panel} aria-label="Latest commit">
            <p className={styles.muted}>
              Latest commit
              {check.latestCommit.sha ? <> · <code>{check.latestCommit.sha.slice(0, 7)}</code></> : null}
              {check.latestCommit.author ? ` · ${check.latestCommit.author}` : ''}
              {check.latestCommit.date ? ` · ${new Date(check.latestCommit.date).toLocaleString()}` : ''}
              {check.latestCommit.url && (
                <>
                  {' '}
                  <a className={styles.versionLink} href={check.latestCommit.url} target="_blank" rel="noreferrer">↗</a>
                </>
              )}
            </p>
            <h3>{check.latestCommit.title}</h3>
            {check.latestCommit.description && (
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{check.latestCommit.description}</pre>
            )}
          </div>
        )}

        {overview?.error && isOwner && <div className={styles.warning} role="status">{overview.error}</div>}
        {check?.error && <div className={styles.warning} role="status">{check.error}</div>}

        {check ? (
          updates.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Component</th><th>Installed</th><th>Latest</th><th>Release notes</th></tr>
                </thead>
                <tbody>
                  {updates.map((entry) => (
                    <tr key={`${entry.kind}:${entry.id}`}>
                      <td>
                        <strong>{entry.name}</strong>{' '}
                        <span className={styles.muted}>· {entry.kind === 'app' ? 'core' : 'plugin'}</span>
                      </td>
                      <td><code>{asTag(entry.installed)}</code></td>
                      <td><code>{entry.release?.tag || asTag(entry.latest)}</code></td>
                      <td>
                        {entry.release?.critical && <span className={styles.badgeWarn}>Security release</span>}
                        {/* What the release is called on GitHub, above the notes it was published with. */}
                        {entry.release?.title && entry.release.title !== (entry.release.tag || '') && (
                          <p className={styles.help}><strong>{entry.release.title}</strong></p>
                        )}
                        {entry.release?.notes?.length ? (
                          <ul className={styles.notes}>
                            {entry.release.notes.map((note) => <li key={note}>{note}</li>)}
                          </ul>
                        ) : <span className={styles.muted}>No release notes.</span>}
                        {entry.release?.changelog_url && isOwner && (
                          <p className={styles.help}>
                            <a className={styles.inlineLink} href={entry.release.changelog_url} target="_blank" rel="noreferrer">
                              Open this release on GitHub ↗
                            </a>
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.success} role="status">
              Nothing to update — this site runs <code>{installedTag}</code>, the newest stable release GitHub publishes.
            </div>
          )
        ) : (
          <p className={styles.muted}>
            Run a check to compare this site against the latest release. The comparison happens on the server,
            so the version it reads is the version that is running.
          </p>
        )}

        {!isOwner && (
          <p className={styles.muted}>Only the site owner (the Administrator account) can apply an update. Ask them to open this screen.</p>
        )}

        {/* A site connected to its own GitHub and Vercel updates through the core-update flow, right here:
            one flow, no second button. */}
        {gitDeploy && <CoreUpdatePanel onUpdated={() => void load()} />}

        {isOwner && !gitDeploy && !cannotApply && (
          <>
            <ReleasePicker state={picker} disabled={busy} name="rwp-update-release" />
            <UpdateStages stage={stage} failed={stageFailed} committingLabel="Applying" />
          </>
        )}
        {cannotApply && <p className={styles.muted}>{support?.reason}</p>}

        {deployStage && (
          <div className={styles.progress} role="status">
            <p className={styles.muted}>
              <strong>
                {deployStage === 'deploying'
                  ? 'Deploying update…'
                  : `Building… ${Math.floor(buildSeconds / 60)}:${String(buildSeconds % 60).padStart(2, '0')}`}
              </strong>
              {latestTag ? <> — <code>{latestTag}</code> was handed to the deploy hook.</> : null}
            </p>
            <p className={styles.help}>
              {deployStage === 'deploying'
                ? 'Calling the deploy hook. The next step is the platform’s own build, which this screen counts for you.'
                : buildSeconds < typicalBuildSeconds
                  ? `A Vercel or Netlify build of this site usually takes about ${Math.round(typicalBuildSeconds / 60)} minutes; it has been ${buildSeconds}s. When the new build is live, “Check again” turns this notice into the success message.`
                  : buildSeconds < slowBuildSeconds
                    ? `Longer than the usual ${Math.round(typicalBuildSeconds / 60)} minutes, which happens on a cold cache or a busy minute on the platform. Open the deploy log in the platform’s dashboard if you want to watch it.`
                    : 'Still building, or the build failed. The platform’s dashboard has the log; when it succeeds, “Check again” compares the GitHub release against the version this build answers with.'}
            </p>
            <div className={styles.buttonRow}>
              <button type="button" className={styles.secondaryButton} disabled={checking} onClick={() => void checkNow()}>
                {checking ? 'Checking…' : 'Check again'}
              </button>
            </div>
          </div>
        )}

        {run && (
          <div className={styles.progress}>
            <p className={styles.muted}>
              <strong>{isRunInFlight(run) ? (stepLabels[run.step] || run.step) : (run.status === 'done' || run.status === 'completed' ? 'Finished' : 'Stopped')}</strong>
              {' '}— <code>{run.from}</code> → <code>{run.to}</code>
              {run.finished_at ? ` · ${timeAgo(run.finished_at)}` : ''}
            </p>
            {log ? <pre className={styles.log}>{log}</pre> : <p className={styles.muted}>Waiting for the first line of output…</p>}
            <p className={styles.help}>
              Run <code>{run.id}</code>{isOwner && <> · log at <code>{run.log_path}</code></>}
              {run.restart_required ? ' · restart the site when it finishes (npm start, or pm2 restart)' : ''}
            </p>
            {run.error && <div className={styles.error} role="alert">{run.error}</div>}
          </div>
        )}

        {recent.length > 0 && (
          <details className={styles.howTo}>
            <summary>Recent update runs</summary>
            <ul className={styles.notes}>
              {recent.map((entry) => (
                <li key={entry.id}>
                  <code>{entry.id}</code> · {entry.from} → {entry.to} · {entry.status}
                  {entry.finished_at ? ` · ${timeAgo(entry.finished_at)}` : ''}
                  {entry.error ? ` · ${entry.error}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="updates-source-heading">
        <div className={styles.panelHead}>
          <div>
            <h2 id="updates-source-heading">{isOwner ? 'Where updates come from' : 'Update schedule'}</h2>
            <p className={styles.muted}>
              {isOwner ? (
                <>
                  React-WP releases are published on GitHub, and this site reads them straight from the release
                  repository below. A public repository needs no account or token.
                  {overview?.github?.has_token ? ' The GitHub token saved under Settings → Integrations → GitHub is used to avoid GitHub’s request limit.' : ''}
                </>
              ) : (
                <>Choose how often this dashboard checks for new releases and whether they are announced here.</>
              )}
            </p>
          </div>
        </div>

        {form ? (
          <form className={styles.formFields} onSubmit={save}>
            {isOwner && (
              <label className={styles.field}>
                Release repository
                <input
                  type="text"
                  value={form.repository ?? ''}
                  placeholder={defaultRepository}
                  onChange={(event) => setForm({ ...form, repository: event.target.value })}
                />
                <span className={styles.help}>
                  Where new versions are published, written <code>owner/repository</code>. Leave it empty to use{' '}
                  <code>{defaultRepository}</code>.
                  {overview?.github?.origin === 'environment' ? ' This site’s hosting settings name a repository, which is used while this field is empty.' : ''}
                </span>
              </label>
            )}

            <label className={styles.field}>
              Check for updates
              <select
                value={form.auto_check}
                onChange={(event) => setForm({ ...form, auto_check: event.target.value as AutoCheck })}
              >
                {(overview?.auto_check?.length ? overview.auto_check : Object.keys(autoCheckIntervals)).map((value) => (
                  <option key={value} value={value}>{autoCheckIntervals[value as AutoCheck]?.label || value}</option>
                ))}
              </select>
              <span className={styles.help}>How often the dashboard looks for a new release. The sidebar badge follows this setting.</span>
            </label>

            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={form.notify}
                onChange={(event) => setForm({ ...form, notify: event.target.checked })}
              />
              Show new releases in the dashboard
            </label>

            {isOwner && overview?.can_self_update && (
              <>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={form.self_update}
                    onChange={(event) => setForm({ ...form, self_update: event.target.checked })}
                  />
                  Let this server update its own checkout
                </label>
                <p className={styles.help}>
                  When on, “Update now” downloads the chosen version, installs it and restarts this site by itself. It is
                  off by default, and an unsaved change in the site’s folder always stops it.
                </p>
              </>
            )}

            <div className={styles.buttonRow}>
              <button type="submit" className={styles.primaryButton} disabled={saving}>
                {saving ? 'Saving…' : 'Save update settings'}
              </button>
            </div>
          </form>
        ) : (
          <p className={styles.muted}>The update configuration could not be read, so it cannot be edited here.</p>
        )}
      </section>
    </div>
  );
}

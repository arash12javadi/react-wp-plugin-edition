/**
 * The in-app update card: check, apply, and watch it happen.
 *
 * `UpdatesPanel` could do one thing — print the by-hand instructions — and the version it named came from
 * a public `updates.json` feed. This card is the other half, and the feed is gone: a version is published
 * by tagging a release on GitHub, and the server is what reads it — from the repository named under
 * Release repository below, else from `react-wp.com` when this site holds a token for it, else from the
 * release tags of whichever repository the GitHub integration holds. So a private repository stays
 * private and the version compared is the version that is running.
 *
 * Applying is the server's decision too: a deploy hook on Vercel, a detached run on a server that owns its
 * checkout, or one sentence naming what to configure when neither applies. This card shows which, and
 * never guesses.
 *
 * Three rules this component keeps:
 *
 *   - **Never claim an update is installed.** A self-update run reports its own outcome, and only a
 *     finished run is recorded in `system_settings.version_state`. A failed run leaves the recorded
 *     version alone, which is what makes that record worth keeping.
 *   - **Always say why a button will not work.** `support.reason` is the server's sentence, shown before
 *     the button rather than after a click that could never have succeeded.
 *   - **Never hold the token.** The field below writes it and then shows `has_token`; there is no read
 *     path back, by design.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  applyUpdate, checkForUpdates, fetchUpdateRun, fetchUpdateRuns, fetchUpdatesOverview, installedAppVersion,
  isRunInFlight, readVersionState, recordVersionState, saveUpdateConfig, updateStatusFrom,
  type SelfUpdateRun, type UpdateCheckAnswer, type UpdateConfigView, type UpdatesOverview, type VersionStateEntry,
} from '../../lib/updateCenter';
import { autoCheckIntervals, compareVersions, saveUpdateStatus, type AutoCheck, type UpdateStatus } from '../../lib/updates';
import type { UserRole } from '../../lib/roles';
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
  'installing-packages': 'Installing packages',
  building: 'Building',
  restarting: 'Restarting the site',
  done: 'Finished',
  failed: 'Failed',
};

const message = (value: unknown, fallback: string) => (value instanceof Error ? value.message : fallback);

/**
 * The one field whose stored value is never read back.
 *
 * Kept apart from the form so the "Forget" button can live inside the field's hint without turning the
 * form into a nest of handlers — and so the emptiness rule is written down once: an empty input means
 * *leave the stored token alone*.
 */
function TokenField({ hasToken, value, disabled, onChange, onForget }: {
  hasToken: boolean;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onForget: () => void;
}) {
  return (
    <label className={styles.field}>
      Update token
      <input
        type="password"
        value={value}
        autoComplete="off"
        placeholder={hasToken ? 'A token is stored. Type a new one to replace it.' : 'Paste the token from your React-WP account'}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className={styles.help}>
        Sent as a header to the update server, never to GitHub.{' '}
        {hasToken ? 'A token is stored.' : 'Without one, checks read this deployment’s own GitHub release tags.'}
        {hasToken && (
          <>
            {' '}
            <button type="button" className={styles.linkButton} disabled={disabled} onClick={onForget}>
              Forget the stored token
            </button>
          </>
        )}
      </span>
    </label>
  );
}


export default function UpdatesCard({ role, onStatus, navigate }: {
  role: UserRole;
  onStatus?: (status: UpdateStatus) => void;
  /** Sends the administrator to the screen that configures the missing half — GitHub, or the deploy hook. */
  navigate?: (section: string, subsection?: string) => void;
}) {
  // The one account that owns the update channel: the Setup Wizard's `administrator` (me). Everyone else —
  // a provisioned `super_admin`, or a role granted `manage_options` — is an end user whose updates are
  // managed by react-wp.com, so they never see GitHub and their check is always answered centrally.
  const isOwner = role === 'administrator';
  const [overview, setOverview] = useState<UpdatesOverview | null>(null);
  const [check, setCheck] = useState<UpdateCheckAnswer | null>(null);
  const [run, setRun] = useState<SelfUpdateRun | null>(null);
  const [log, setLog] = useState('');
  const [recent, setRecent] = useState<SelfUpdateRun[]>([]);
  const [form, setForm] = useState<UpdateConfigView | null>(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  /** `deploying` while the hook is being called, `building` while the platform rebuilds the site. */
  const [deployStage, setDeployStage] = useState<'' | 'deploying' | 'building'>('');
  /** When the hook answered, so the build the platform is running can be counted rather than guessed at. */
  const [deployStartedAt, setDeployStartedAt] = useState(0);
  const [buildSeconds, setBuildSeconds] = useState(0);
  // Read once per mount and written after a run: a poll must not cost a database round trip of its own.
  const versionState = useRef<Record<string, unknown> | null>(null);
  const deployTimer = useRef<number | null>(null);

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
   * Closes the loop on a deploy hook.
   *
   * A deploy hook has no log to follow. The only evidence that the new build is live is the *next* check:
   * it compares the tag GitHub publishes against the tag the running build reports. So when a check finds
   * nothing left to do while the recorded outcome still says a deploy for that same version was triggered,
   * the record becomes `completed` — the "records the new version tag once the site reloads" half of the
   * feature — and the screen says so once, with the tag.
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
    try {
      await remember({
        at: new Date().toISOString(),
        from: pending.from || answer.app.installed,
        to: applied || pending.to,
        mode: 'deploy-hook',
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
      // runs (a serverless function with no `.rwp-tmp`) must still render the Update Now button.
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

  /** Records how a run ended. Only a `done` run moves the installed version forward. */
  const finishRun = useCallback(async (record: SelfUpdateRun) => {
    const succeeded = record.status === 'done';
    setFeedback(succeeded
      ? `🎉 Update successful to ${asTag(record.to)}!${record.restart_required ? ` Restart the site to run it: pm2 restart ${record.app_name || '<name>'} (or npm start).` : ''}`
      : `The update did not finish: ${record.error || stepLabels[record.step] || record.step}.`);
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
        if (!isRunInFlight(answer.run)) await finishRun(answer.run);
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
    try {
      const answer = await checkForUpdates();
      publish(answer);
      setOverview((current) => (current ? { ...current, config: answer.config, readable: answer.readable } : current));
      setForm(answer.config);
      const latest = asTag(answer.latestVersion || answer.app.latest_tag || answer.app.latest);
      setFeedback(answer.update_available
        ? `${answer.updates.length} update${answer.updates.length === 1 ? '' : 's'} available${answer.updateAvailable === false ? '' : ` — latest release ${latest}`}.`
        : `Everything is up to date: ${asTag(answer.app.installed)} is the latest release ${answer.source === 'central' ? 'React-WP.com publishes' : 'GitHub publishes'}.`);
      await settleDeploy(answer);
    } catch (checkError) {
      setError(message(checkError, 'The update check failed.'));
    } finally {
      setChecking(false);
    }
  };

  const updateNow = async () => {
    setApplying(true);
    setError('');
    setFeedback('');
    try {
      const outcome = await applyUpdate();
      publish(outcome.check);
      if (outcome.kind === 'up_to_date') {
        setFeedback(outcome.plan.reason);
        await settleDeploy(outcome.check);
        return;
      }
      if (outcome.kind === 'manual') {
        // Not a failure: this host cannot apply it, and the steps below are the answer.
        setFeedback(outcome.plan.reason);
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
          setFeedback(outcome.message);
          return;
        }
        // Two stages, because a deploy hook answers once and then builds elsewhere: the request itself,
        // and the rebuild the platform is now doing. The check that follows the rebuild is what turns
        // this into the success message, so the button stays available instead of a spinner that lies.
        stopDeployTimer();
        setDeployStartedAt(Date.now());
        setBuildSeconds(0);
        setDeployStage('deploying');
        deployTimer.current = window.setTimeout(() => setDeployStage('building'), deployStageMs);
        setFeedback(`Deploying update… The deploy hook was called for ${asTag(outcome.check.app.latest)}. The platform is rebuilding this site now.`);
        return;
      }
      if (outcome.kind === 'managed') {
        await remember({
          at: new Date().toISOString(),
          from: outcome.check.app.installed,
          to: outcome.check.app.latest,
          mode: 'managed',
          status: outcome.queued ? 'triggered' : 'failed',
          ...(outcome.queued ? {} : { error: outcome.message || 'React-WP.com refused the update.' }),
        });
        setFeedback(outcome.queued
          ? `Update sent to React-WP.com — it is deploying ${asTag(outcome.version || outcome.check.app.latest)} to this site now.`
          : outcome.message);
        return;
      }
      stopDeployTimer();
      setDeployStage('');
      setDeployStartedAt(0);
      setBuildSeconds(0);
      setRun(outcome.run);
      setLog('');
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
      setError(message(applyError, 'The update could not be started.'));
    } finally {
      setApplying(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError('');
    setFeedback('');
    try {
      // `token` is only sent when the administrator typed one: the stored value is never read back into
      // this form, so an empty field has to mean "leave it alone" rather than "erase it". An end user's
      // patch names only the two scheduling settings, so a save can never overwrite the owner's repository,
      // token or self-update switch with the redacted values this screen showed them.
      await saveUpdateConfig(isOwner
        ? {
          central_url: form.central_url.trim(),
          repository: (form.repository ?? '').trim(),
          channel: form.channel,
          auto_check: form.auto_check,
          notify: form.notify,
          self_update: form.self_update,
          ...(token.trim() ? { token: token.trim() } : {}),
        }
        : { auto_check: form.auto_check, notify: form.notify });
      setToken('');
      setFeedback('Update settings saved.');
      await load();
    } catch (saveError) {
      setError(message(saveError, 'The update settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  };


  /** Removes the stored token: the documented way to stop using the central server. */
  const forgetToken = useCallback(async () => {
    setSaving(true);
    setError('');
    setFeedback('');
    try {
      await saveUpdateConfig({ token: null });
      setToken('');
      setFeedback('The update token was removed. Checks now read this deployment’s own GitHub release tags.');
      await load();
    } catch (removeError) {
      setError(message(removeError, 'The stored token could not be removed.'));
    } finally {
      setSaving(false);
    }
  }, [load]);

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
  const appUpdate = updates.find((entry) => entry.kind === 'app');
  const busy = checking || applying || isRunInFlight(run);
  const source = (form || overview?.config)?.source;
  // The tag is what the screen shows; `version` is the same release without the `v`, and is what the
  // comparisons used. A host that has not checked yet only knows what it runs.
  const installedTag = asTag(check?.installedVersion || overview?.installed || installedAppVersion);
  const latestTag = asTag(check?.latestVersion || check?.app?.latest_tag || check?.app?.latest || '');
  const coreUpdate = check ? (check.updateAvailable ?? check.app.update_available) : false;
  const releaseUrl = check?.releaseUrl || check?.app?.release?.changelog_url || '';

  return (
    <div className={styles.dashboard}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {feedback && <div className={styles.success} role="status">{feedback}</div>}

      <section className={styles.panel} aria-labelledby="updates-card-heading">
        <div className={styles.panelHead}>
          <div>
            <h2 id="updates-card-heading">🔄 Updates</h2>
            <p className={styles.muted}>
              React-WP <code>{installedTag}</code>
              {source ? ` · ${source === 'central' ? 'checked through React-WP.com' : 'read from this repository’s release tags'}` : ''}
              {isOwner && form ? ` · ${form.has_token ? 'update token stored' : 'no update token'}` : ''}
            </p>
          </div>
          <div className={styles.buttonRow}>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void checkNow()}>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void updateNow()}>
              {applying ? 'Starting…' : 'Update now'}
            </button>
          </div>
        </div>

        {/* The tag, not a number from a `package.json`: installed on the left, the newest GitHub release on
            the right, and one badge that says which of the two questions this screen is answering. */}
        <div className={styles.versionBar}>
          <span className={styles.versionChip}>Installed <code>{installedTag}</code></span>
          <span className={styles.versionArrow} aria-hidden="true">→</span>
          <span className={styles.versionChip}>{isOwner ? 'GitHub release' : 'Latest release'} <code>{latestTag || '—'}</code></span>
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

        {support && !support.supported && (
          <div className={styles.warning} role="status"><strong>This host updates from its repository.</strong> {support.reason}</div>
        )}
        {overview?.error && <div className={styles.warning} role="status">{overview.error}</div>}
        {check?.error && <div className={styles.warning} role="status">{check.error}</div>}

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
                        {entry.kind === 'plugin' && (
                          <p className={styles.help}>
                            Plugin releases are installed from Plugins → Installed. This button moves the core.
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
              Nothing to update — this site runs <code>{installedTag}</code>, the newest release {source === 'central' ? 'React-WP.com publishes' : 'GitHub publishes'}.
            </div>
          )
        ) : (
          <p className={styles.muted}>
            Run a check to compare this site against the latest release. The comparison happens on the server,
            so the version it reads is the version that is running.
          </p>
        )}

        {run && (
          <div className={styles.progress}>
            <p className={styles.muted}>
              <strong>{isRunInFlight(run) ? (stepLabels[run.step] || run.step) : (run.status === 'done' ? 'Finished' : 'Stopped')}</strong>
              {' '}— <code>{run.from}</code> → <code>{run.to}</code>
              {run.finished_at ? ` · ${timeAgo(run.finished_at)}` : ''}
            </p>
            {log ? <pre className={styles.log}>{log}</pre> : <p className={styles.muted}>Waiting for the first line of output…</p>}
            <p className={styles.help}>
              Run <code>{run.id}</code> · log at <code>{run.log_path}</code>
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
                  A version is published by tagging a release on GitHub — <code>v2.4.1</code>. The release repository
                  is read first, with the GitHub credential stored under Settings → Integrations → GitHub; a site
                  that also stores a token for the update server asks it instead when no repository is named. Either
                  way the token below is written to <code>system_settings.updates_config</code> and read only by the
                  server: this screen is never sent it back (<code>has_token</code> is all it sees), so nothing in the
                  browser can leak it and a private repository stays private.
                </>
              ) : (
                <>
                  Updates for this site are provided by <strong>React-WP.com</strong>. It checks the releases and
                  deploys them for you, so there is nothing to configure here except how often the dashboard checks
                  and whether new releases appear in the sidebar.
                </>
              )}
            </p>
          </div>
        </div>

        {isOwner && (
          <div className={styles.field}>
            GitHub release tags
            <p className={styles.help}>
              {overview?.github?.configured
                ? <>
                  Reading <code>{overview.github.repo}</code>
                  {overview.github.has_token ? ' with the stored GitHub token' : ' — a public repository, so no token is needed'}.
                  {' '}A release is published by tagging it: <code>v1.2.3</code>.
                  {' '}
                  <span className={styles.muted}>
                    {form?.repository
                      ? 'Named on this screen; empty it to use the GitHub integration’s repository instead.'
                      : 'Named by the GitHub integration; set it above to check a different repository.'}
                  </span>
                  {navigate && (
                    <>
                      {' '}
                      <button type="button" className={styles.linkButton} onClick={() => navigate('settings', 'integrations')}>
                        Change the token in Settings → Integrations → GitHub
                      </button>
                    </>
                  )}
                </>
                : <>
                  No repository is configured, so nothing can be checked: name it under Release repository above
                  {navigate
                    ? <>, or in <button type="button" className={styles.linkButton} onClick={() => navigate('settings', 'integrations')}>Settings → Integrations → GitHub</button>.</>
                    : ' — or in Settings → Integrations → GitHub. A public repository needs no token.'}
                </>}
            </p>
          </div>
        )}

        {form ? (
          <form className={styles.formFields} onSubmit={save}>
            {isOwner && (
              <>
                <label className={styles.field}>
                  Release repository
                  <input
                    type="text"
                    value={form.repository ?? ''}
                    placeholder={overview?.github?.repo || 'owner/repository'}
                    onChange={(event) => setForm({ ...form, repository: event.target.value })}
                  />
                  <span className={styles.help}>
                    The repository this site&apos;s releases are tagged on, as <code>owner/repository</code>. A check
                    reads its release tags first, with the GitHub token stored under Settings → Integrations → GitHub
                    (a public repository needs none). Empty means the repository the GitHub integration names.
                  </span>
                </label>

                <label className={styles.field}>
                  Update server
                  <input
                    type="url"
                    value={form.central_url}
                    placeholder="https://react-wp.com"
                    onChange={(event) => setForm({ ...form, central_url: event.target.value })}
                  />
                  <span className={styles.help}>
                    Asked when no repository is named above. Leave empty to use react-wp.com.
                  </span>
                </label>

                <TokenField
                  hasToken={form.has_token}
                  value={token}
                  disabled={saving}
                  onChange={setToken}
                  onForget={() => void forgetToken()}
                />

                <label className={styles.field}>
                  Channel
                  <select
                    value={form.channel}
                    onChange={(event) => setForm({ ...form, channel: event.target.value === 'beta' ? 'beta' : 'stable' })}
                  >
                    {(overview?.channels?.length ? overview.channels : ['stable', 'beta']).map((name) => (
                      <option key={name} value={name}>{name === 'beta' ? 'Beta — release candidates' : 'Stable — released versions'}</option>
                    ))}
                  </select>
                  <span className={styles.help}>Beta releases are published before they are announced, and are the ones to try a fix on.</span>
                </label>
              </>
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
              <span className={styles.help}>How often the dashboard asks. The sidebar badge follows this setting.</span>
            </label>

            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={form.notify}
                onChange={(event) => setForm({ ...form, notify: event.target.checked })}
              />
              Show new releases in the dashboard
            </label>

            {isOwner && (
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
                  Off by default. When on, and this host runs from a clean git checkout, Update now fetches the
                  release, installs, builds and restarts the site on the server itself. A Vercel deployment never
                  does this — it asks its deploy hook to rebuild, because a function cannot rewrite its own
                  deployment.
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

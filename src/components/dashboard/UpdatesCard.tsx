/**
 * The in-app update card: check, apply, and watch it happen.
 *
 * `UpdatesPanel` could do one thing — ask a public JSON feed what the latest version was and print the
 * by-hand instructions. This card is the other half. The server does the check, so a private repository
 * stays private and the version compared is the version that is running; and the server applies the
 * update in whichever way this host can — a deploy hook on Vercel, a detached run on a server that owns
 * its checkout, or the by-hand steps when neither is possible.
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
  isRunInFlight, legacyUpdateStatus, readVersionState, recordVersionState, saveUpdateConfig,
  type SelfUpdateRun, type UpdateCheckAnswer, type UpdateConfigView, type UpdatesOverview,
} from '../../lib/updateCenter';
import { autoCheckIntervals, saveUpdateStatus, type AutoCheck, type UpdateStatus } from '../../lib/updates';
import styles from './Dashboard.module.css';

/** How long the screen waits between polls of a running self-update. */
const pollIntervalMs = 2500;

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
        {hasToken ? 'A token is stored.' : 'Without one, checks fall back to the public feed.'}
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


export default function UpdatesCard({ onStatus }: { onStatus?: (status: UpdateStatus) => void }) {
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
  // Read once per mount and written after a run: a poll must not cost a database round trip of its own.
  const versionState = useRef<Record<string, unknown> | null>(null);

  /**
   * Shows an answer and hands it to the screens that still read `options.rwp_update_status` — the sidebar
   * badge and the Overview banner are driven by `runScheduledUpdateCheck`, so one check keeps all three
   * in step instead of a fresh count sitting next to a stale one.
   */
  const publish = useCallback((answer: UpdateCheckAnswer | null) => {
    setCheck(answer);
    if (!answer) return;
    const status = legacyUpdateStatus(answer);
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
      ? `Updated to ${record.to}.${record.restart_required ? ` Restart the site to run it: pm2 restart ${record.app_name || '<name>'} (or npm start).` : ''}`
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
      setFeedback(answer.update_available
        ? `${answer.updates.length} update${answer.updates.length === 1 ? '' : 's'} available.`
        : `Everything is up to date: ${answer.app.installed} is the latest release this site can see.`);
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
        return;
      }
      if (outcome.kind === 'manual') {
        // Not a failure: this host cannot apply it, and the steps below are the answer.
        setFeedback(outcome.plan.reason);
        return;
      }
      if (outcome.kind === 'deploy') {
        setFeedback(outcome.message);
        await remember({
          at: new Date().toISOString(),
          from: outcome.check.app.installed,
          to: outcome.check.app.latest,
          mode: 'deploy-hook',
          status: outcome.queued ? 'triggered' : 'failed',
          ...(outcome.queued ? {} : { error: outcome.deploy?.error || 'The deploy hook refused.' }),
        });
        return;
      }
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
      // this form, so an empty field has to mean "leave it alone" rather than "erase it".
      await saveUpdateConfig({
        central_url: form.central_url.trim(),
        feed_url: form.feed_url.trim(),
        channel: form.channel,
        auto_check: form.auto_check,
        notify: form.notify,
        self_update: form.self_update,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
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
      setFeedback('The update token was removed. Checks now use the public feed.');
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

  return (
    <div className={styles.dashboard}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {feedback && <div className={styles.success} role="status">{feedback}</div>}

      <section className={styles.panel} aria-labelledby="updates-card-heading">
        <div className={styles.panelHead}>
          <div>
            <h2 id="updates-card-heading">🔄 Updates</h2>
            <p className={styles.muted}>
              React-WP <code>{overview?.installed || installedAppVersion}</code>
              {source ? ` · ${source === 'central' ? 'checked through React-WP.com' : 'checked through the public feed'}` : ''}
              {form ? ` · ${form.has_token ? 'update token stored' : 'no update token'}` : ''}
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

        {support && !support.supported && (
          <div className={styles.warning} role="status"><strong>This host updates from its repository.</strong> {support.reason}</div>
        )}
        {overview?.error && <div className={styles.warning} role="status">{overview.error}</div>}
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
                      <td><code>{entry.installed}</code></td>
                      <td><code>{entry.latest}</code></td>
                      <td>
                        {entry.release?.critical && <span className={styles.badgeWarn}>Security release</span>}
                        {entry.release?.notes?.length ? (
                          <ul className={styles.notes}>
                            {entry.release.notes.map((note) => <li key={note}>{note}</li>)}
                          </ul>
                        ) : <span className={styles.muted}>No release notes.</span>}
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
              Nothing to update — <code>{check.app.installed}</code> is the latest release this site can see.
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

        {Boolean(overview?.manual_steps?.length) && (
          <details className={styles.howTo}>
            <summary>Update by hand</summary>
            <ol>{overview!.manual_steps.map((step) => <li key={step}>{step}</li>)}</ol>
          </details>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="updates-source-heading">
        <div className={styles.panelHead}>
          <div>
            <h2 id="updates-source-heading">Where updates come from</h2>
            <p className={styles.muted}>
              The token below is written to <code>system_settings.updates_config</code> and read only by the
              server. This screen is never sent it back — <code>has_token</code> is all it sees — so nothing in
              the browser can leak it, and a private repository stays private.
            </p>
          </div>
        </div>

        {form ? (
          <form className={styles.formFields} onSubmit={save}>
            <label className={styles.field}>
              Update server
              <input
                type="url"
                value={form.central_url}
                placeholder="https://react-wp.com"
                onChange={(event) => setForm({ ...form, central_url: event.target.value })}
              />
              <span className={styles.help}>Asked first, when a token is stored. Leave empty to use react-wp.com.</span>
            </label>

            <TokenField
              hasToken={form.has_token}
              value={token}
              disabled={saving}
              onChange={setToken}
              onForget={() => void forgetToken()}
            />

            <label className={styles.field}>
              Public update feed
              <input
                type="url"
                value={form.feed_url}
                placeholder="https://react-wp.com/updates.json"
                onChange={(event) => setForm({ ...form, feed_url: event.target.value })}
              />
              <span className={styles.help}>Used when the update server cannot be reached, and always without a token.</span>
            </label>

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

/**
 * Updating React-WP core on a site that deploys from its own GitHub repository and Vercel project.
 *
 * One component, two places: Dashboard → Updates (for a connected site it *is* the update flow — there is
 * no second button) and Settings → Integrations → GitHub & Vercel → Update React-WP core. The steps are the
 * server's (`server/gitDeploy/coreUpdate.mjs`, unchanged): review a plan (nothing is written), decide any
 * conflicts, apply it as one commit, then follow Vercel's deployment of that commit.
 *
 * The version is chosen from the five most recent stable releases (`ReleasePicker`); the server accepts only
 * a tag from its own list, and asks for an explicit confirmation before it moves to an older one.
 *
 * Progress is shown in order — checking, downloading, committing, deploying, ready — and "ready" is only
 * ever set from Vercel's own answer for the commit (`isDeploymentReady`), never because a request returned.
 */
import { useEffect, useState } from 'react';
import {
  applyCoreUpdate,
  planCoreUpdate,
  type CoreUpdatePlanView,
  type DeploymentState,
} from '../../lib/gitDeployment';
import { DeploymentWatcher, isDeploymentReady } from './DeploymentWatcher';
import ReleasePicker, { DOWNGRADE_NOTICE, useRecentReleases } from './ReleasePicker';
import UpdateStages, { type UpdateStage } from './UpdateStages';
import styles from './Update.module.css';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

export default function CoreUpdatePanel({ onUpdated }: {
  /** Called once Vercel reports the new deployment ready, so the surrounding screen can re-read its version. */
  onUpdated?: () => void;
}) {
  const picker = useRecentReleases();
  const [plan, setPlan] = useState<CoreUpdatePlanView | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, 'release' | 'keep'>>({});
  const [mode, setMode] = useState<'direct' | 'pull_request'>('direct');
  const [busy, setBusy] = useState<'' | 'plan' | 'apply'>('');
  const [error, setError] = useState('');
  const [stage, setStage] = useState<UpdateStage>('idle');
  const [stageDone, setStageDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<{ text: string; sha: string; since: string; url: string } | null>(null);
  const [ready, setReady] = useState(false);

  // A plan belongs to the version it was made for: choosing another version starts over.
  useEffect(() => {
    setPlan(null);
    setError('');
  }, [picker.selected]);

  const makePlan = async () => {
    if (!picker.current) return;
    setBusy('plan');
    setError('');
    setResult(null);
    setReady(false);
    setFailed(false);
    // The release list was read (checked) when the picker loaded; the plan request is what downloads the
    // release and reads the repository, so that is the stage while it runs.
    setStage('downloading');
    setStageDone(false);
    try {
      const answer = await planCoreUpdate(picker.current.tag);
      setPlan(answer.plan);
      setResolutions({});
      setStageDone(true);
    } catch (planError) {
      setFailed(true);
      setError(messageOf(planError, 'The update could not be planned. Nothing was changed.'));
    } finally {
      setBusy('');
    }
  };

  const apply = async () => {
    if (!plan || !picker.current) return;
    setBusy('apply');
    setError('');
    setFailed(false);
    setStage('committing');
    setStageDone(false);
    try {
      const answer = await applyCoreUpdate({
        tag: picker.current.tag,
        fingerprint: plan.fingerprint,
        resolutions,
        mode,
        confirmDowngrade: picker.confirmed,
      });
      const { result: applied } = answer;
      if (applied.upToDate) {
        setResult({ text: 'Nothing to change: the repository already has this release.', sha: '', since: '', url: '' });
        setStage('idle');
      } else if (applied.pullRequest) {
        setResult({ text: `Pull request #${applied.pullRequest.number} is open. Production changes only when it is merged; Vercel deploys it then.`, sha: '', since: '', url: applied.pullRequest.url });
        setStageDone(true);
      } else if (applied.commit) {
        setResult({
          text: `Committed ${plan.toVersion} to ${plan.branch}. Vercel is deploying it now; until that deployment is Ready the current version keeps serving.`,
          sha: applied.commit.sha,
          since: new Date().toISOString(),
          url: applied.commit.url,
        });
        setStage('deploying');
      }
      setPlan(null);
    } catch (applyError) {
      setFailed(true);
      setError(messageOf(applyError, 'The update was not applied. Nothing was committed.'));
    } finally {
      setBusy('');
    }
  };

  const onDeployment = (state: DeploymentState) => {
    if (isDeploymentReady(state)) {
      setStage('ready');
      setReady(true);
      onUpdated?.();
    } else if (state.state === 'error' || state.state === 'canceled') {
      setFailed(true);
    }
  };

  const unresolved = plan ? plan.conflicts.filter((item) => !resolutions[item.path]).length : 0;
  const downgrade = picker.current?.move === 'downgrade';
  const same = picker.current?.move === 'current';

  return (
    <div className={styles.panel}>
      <p className={styles.small}>
        This site’s code lives in your own GitHub repository and Vercel deploys it, so an update is a commit there:
        you review exactly what changes first. Your plugins and your own files are kept.
      </p>
      <ReleasePicker state={picker} disabled={busy !== ''} name="rwp-core-release" />
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={() => void makePlan()}
          disabled={busy !== '' || picker.loading || !picker.current || picker.blocked || same}
        >
          {busy === 'plan' ? 'Preparing…' : downgrade ? 'Review the downgrade' : 'Review the update'}
        </button>
        {picker.blocked ? <span className={styles.hint}>Tick the confirmation above to continue.</span> : null}
      </div>

      <UpdateStages stage={stage} failed={failed} completed={stageDone} />

      {plan ? (
        <div className={styles.plan}>
          <p>
            {plan.fromVersion || 'unknown'} → <strong>{plan.toVersion}</strong> from {plan.releaseRepository}.{' '}
            {plan.upToDate ? 'Nothing to change.' : `${plan.updated.length} updated, ${plan.added.length} added, ${plan.deleted.length} deleted, ${plan.unchanged} unchanged.`} Plugins are not touched.
          </p>
          {downgrade ? <p className={styles.error}>{DOWNGRADE_NOTICE}</p> : null}
          {plan.merged.map((item) => (
            <p key={item.path} className={styles.small}>
              <code>{item.path}</code> merged{item.carried.length ? `; kept: ${item.carried.join(', ')}` : ''}{item.dropped.length ? `; dropped imports of plugins not in this repository: ${item.dropped.join(', ')}` : ''}.
            </p>
          ))}
          {plan.kept.length ? <details><summary>{plan.kept.length} file(s) you changed are kept</summary><ul>{plan.kept.map((item) => <li key={item.path}><code>{item.path}</code> — {item.reason}</li>)}</ul></details> : null}
          {plan.warnings.map((warning) => <p key={warning} className={styles.small}>{warning}</p>)}
          {plan.conflicts.length ? (
            <fieldset className={styles.picker}>
              <legend>{plan.conflicts.length} file(s) need your decision</legend>
              {plan.conflicts.map((item) => (
                <div key={item.path} className={styles.conflict}>
                  <code>{item.path}</code> <span className={styles.small}>{item.reason}</span>
                  <select
                    aria-label={`Decision for ${item.path}`}
                    value={resolutions[item.path] || ''}
                    onChange={(event) => setResolutions((current) => ({ ...current, [item.path]: event.target.value as 'release' | 'keep' }))}
                  >
                    <option value="">Choose…</option>
                    <option value="release">Use the release&apos;s version</option>
                    <option value="keep">Keep this repository&apos;s version</option>
                  </select>
                </div>
              ))}
            </fieldset>
          ) : null}
          {!plan.upToDate ? (
            <>
              <div className={styles.choices} role="radiogroup" aria-label="How to apply">
                <label className={styles.inline}><input type="radio" checked={mode === 'direct'} onChange={() => setMode('direct')} /> Apply to {plan.branch} now (Vercel deploys it)</label>
                <label className={styles.inline}><input type="radio" checked={mode === 'pull_request'} onChange={() => setMode('pull_request')} /> Open a pull request to review first</label>
              </div>
              <div className={styles.row}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonPrimary}`}
                  onClick={() => void apply()}
                  disabled={busy !== '' || unresolved > 0 || picker.blocked}
                >
                  {busy === 'apply' ? 'Committing…' : unresolved ? `Decide ${unresolved} file(s) first` : downgrade ? 'Apply the downgrade' : 'Apply the update'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {result ? (
        <div>
          <p className={styles.small}>{result.text} {result.url ? <a href={result.url} target="_blank" rel="noreferrer">View on GitHub</a> : null}</p>
          {result.sha ? <DeploymentWatcher sha={result.sha} since={result.since} onState={onDeployment} /> : null}
        </div>
      ) : null}
      {ready ? (
        <p className={styles.small} role="status">
          <strong>The new version is live.</strong>{' '}
          <button type="button" className={styles.linkButton} onClick={() => window.location.reload()}>Reload this page</button> to load it.
        </p>
      ) : null}
    </div>
  );
}

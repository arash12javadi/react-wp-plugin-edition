/**
 * Updating React-WP core on a site that deploys from its own GitHub repository and Vercel project.
 *
 * One component, two places: Dashboard → Updates (for a connected site it *is* the update flow — there is
 * no second button) and Settings → Integrations → GitHub & Vercel → Update React-WP core.
 *
 * One click does everything, in this order, with the stage shown as it happens:
 *   checking → downloading (the release is read and merged with your repository, nothing written yet) →
 *   committing (the commit lands on the branch Vercel deploys to Production — the server resolves a moved or
 *   protected branch itself) → deploying → ready.
 * The only thing that ever waits for a person is a file that was changed both in this repository and in the
 * release: each one gets two buttons, "Keep my version" and "Use the release version".
 *
 * "Ready" is set only from Vercel's own answer that the PRODUCTION deployment of the commit is live
 * (`isDeploymentReady`), never because a request returned and never from a Preview build. A failed build
 * leaves the previous version serving, and the panel shows Vercel's reason, a link to the build log and Retry.
 * Applying only ever starts from the button below: nothing in this component runs on load.
 */
import { useEffect, useState } from 'react';
import {
  applyCoreUpdate,
  planCoreUpdate,
  redeployCoreUpdate,
  DeploymentRequestError,
  type CoreUpdatePlanView,
  type DeploymentState,
} from '../../lib/gitDeployment';
import { DeploymentWatcher, isDeploymentReady } from './DeploymentWatcher';
import ReleasePicker, { DOWNGRADE_NOTICE, useRecentReleases } from './ReleasePicker';
import UpdateStages, { type UpdateStage } from './UpdateStages';
import styles from './Update.module.css';

type Choice = 'release' | 'keep';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

export default function CoreUpdatePanel({ onUpdated }: {
  /** Called once Vercel reports the new Production deployment live, so the surrounding screen can re-read its version. */
  onUpdated?: () => void;
}) {
  const picker = useRecentReleases();
  const [plan, setPlan] = useState<CoreUpdatePlanView | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<UpdateStage>('idle');
  const [stageDone, setStageDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [deploy, setDeploy] = useState<{ sha: string; since: string; url: string; round: number } | null>(null);
  const [deployState, setDeployState] = useState<DeploymentState | null>(null);
  const [ready, setReady] = useState(false);

  // A plan belongs to the version it was made for: choosing another version starts over.
  useEffect(() => {
    setPlan(null);
    setError('');
    setNote('');
  }, [picker.selected]);

  const reset = () => {
    setError('');
    setNote('');
    setFailed(false);
    setReady(false);
    setDeploy(null);
    setDeployState(null);
  };

  /** Commits the plan; a branch that moved since the plan was made is re-planned once, by itself. */
  const commit = async (reviewed: CoreUpdatePlanView, chosen: Record<string, Choice>, again = false): Promise<void> => {
    const tag = picker.current?.tag || '';
    setStage('committing');
    setStageDone(false);
    try {
      const answer = await applyCoreUpdate({ tag, fingerprint: reviewed.fingerprint, resolutions: chosen, confirmDowngrade: picker.confirmed });
      const { result } = answer;
      setPlan(null);
      if (result.upToDate || !result.commit) {
        setNote('Nothing to change: this site already has that release.');
        setStage('idle');
        return;
      }
      setDeploy({ sha: result.commit.sha, since: new Date().toISOString(), url: result.commit.url, round: 0 });
      setNote(`Committed ${reviewed.toVersion} to ${result.productionBranch || reviewed.branch}. Vercel is building it for Production; the current version keeps serving until that build is live.`);
      setStage('deploying');
    } catch (applyError) {
      const stale = applyError instanceof DeploymentRequestError && applyError.status === 409 && !('conflicts' in applyError.body);
      if (stale && !again) {
        // The repository or the release moved after the plan: read it again and, if nothing needs a decision, go on.
        const fresh = await planCoreUpdate(tag);
        if (!fresh.plan.conflicts.some((item) => !chosen[item.path])) {
          await commit(fresh.plan, chosen, true);
          return;
        }
        setPlan(fresh.plan);
        setStageDone(true);
        setNote('The repository changed while the update was being prepared. Review the files below, then continue.');
        return;
      }
      setFailed(true);
      setError(messageOf(applyError, 'The update was not applied. Nothing was changed on your site.'));
    }
  };

  const start = async () => {
    if (!picker.current) return;
    setBusy(true);
    reset();
    setStage('downloading');
    setStageDone(false);
    try {
      const answer = await planCoreUpdate(picker.current.tag);
      setResolutions({});
      if (answer.plan.upToDate) {
        setNote(`Nothing to change: this site already has ${answer.plan.toVersion}.`);
        setStage('idle');
        return;
      }
      if (answer.plan.conflicts.length) {
        setPlan(answer.plan);
        setStageDone(true);
        return;
      }
      await commit(answer.plan, {});
    } catch (planError) {
      setFailed(true);
      setError(messageOf(planError, 'The update could not be prepared. Nothing was changed on your site.'));
    } finally {
      setBusy(false);
    }
  };

  const continueWithChoices = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    setFailed(false);
    try {
      await commit(plan, resolutions);
    } finally {
      setBusy(false);
    }
  };

  const retryBuild = async () => {
    if (!deploy) return;
    setBusy(true);
    setError('');
    setFailed(false);
    try {
      await redeployCoreUpdate(deploy.sha);
      setStage('deploying');
      setDeploy({ ...deploy, since: new Date().toISOString(), round: deploy.round + 1 });
    } catch (retryError) {
      setFailed(true);
      setError(messageOf(retryError, 'Vercel could not be asked to build again.'));
    } finally {
      setBusy(false);
    }
  };

  const onDeployment = (state: DeploymentState) => {
    setDeployState(state);
    if (isDeploymentReady(state)) {
      setStage('ready');
      setReady(true);
      setFailed(false);
      onUpdated?.();
    } else if (state.state === 'error' || state.state === 'canceled') {
      setFailed(true);
    }
  };

  const unresolved = plan ? plan.conflicts.filter((item) => !resolutions[item.path]).length : 0;
  const downgrade = picker.current?.move === 'downgrade';
  const same = picker.current?.move === 'current';
  const buildFailed = Boolean(deploy) && !ready && (deployState?.state === 'error' || deployState?.state === 'canceled');

  return (
    <div className={styles.panel}>
      <p className={styles.small}>
        Your plugins and your own files are kept. One click updates this site: it is applied to your repository and Vercel builds it.
      </p>
      <ReleasePicker state={picker} disabled={busy} name="rwp-core-release" />
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={() => void start()}
          disabled={busy || picker.loading || !picker.current || picker.blocked || same || Boolean(plan)}
        >
          {busy ? 'Updating…' : downgrade ? `Install ${picker.current?.tag || 'this version'} (older)` : picker.current ? `Update to ${picker.current.tag}` : 'Update'}
        </button>
        {picker.blocked ? <span className={styles.hint}>Tick the confirmation above to continue.</span> : null}
      </div>

      <UpdateStages stage={stage} failed={failed} completed={stageDone} />
      {downgrade ? <p className={styles.small}>{DOWNGRADE_NOTICE}</p> : null}

      {plan ? (
        <div className={styles.plan}>
          <fieldset className={styles.picker}>
            <legend>{plan.conflicts.length} file(s) were changed here and in the release — choose what to do with each</legend>
            {plan.conflicts.map((item) => (
              <div key={item.path} className={styles.conflict}>
                <code>{item.path}</code> <span className={styles.small}>{item.reason}</span>
                <div className={styles.row} role="group" aria-label={`Decision for ${item.path}`}>
                  <button
                    type="button"
                    className={`${styles.button} ${resolutions[item.path] === 'keep' ? styles.buttonPrimary : ''}`}
                    aria-pressed={resolutions[item.path] === 'keep'}
                    onClick={() => setResolutions((current) => ({ ...current, [item.path]: 'keep' }))}
                  >
                    Keep my version
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${resolutions[item.path] === 'release' ? styles.buttonPrimary : ''}`}
                    aria-pressed={resolutions[item.path] === 'release'}
                    onClick={() => setResolutions((current) => ({ ...current, [item.path]: 'release' }))}
                  >
                    Use the release version
                  </button>
                </div>
              </div>
            ))}
          </fieldset>
          {plan.warnings.map((warning) => <p key={warning} className={styles.small}>{warning}</p>)}
          <div className={styles.row}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={() => void continueWithChoices()}
              disabled={busy || unresolved > 0}
            >
              {busy ? 'Updating…' : unresolved ? `Choose for ${unresolved} more file(s)` : 'Continue the update'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {note ? <p className={styles.small} role="status">{note} {deploy?.url ? <a href={deploy.url} target="_blank" rel="noreferrer">View on GitHub</a> : null}</p> : null}
      {deploy ? <DeploymentWatcher key={`${deploy.sha}-${deploy.round}`} sha={deploy.sha} since={deploy.since} onState={onDeployment} /> : null}
      {buildFailed ? (
        <div className={styles.row}>
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => void retryBuild()} disabled={busy}>
            {busy ? 'Starting…' : 'Try the build again'}
          </button>
          {deployState?.inspectorUrl ? <a href={deployState.inspectorUrl} target="_blank" rel="noreferrer">Open the build log</a> : null}
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

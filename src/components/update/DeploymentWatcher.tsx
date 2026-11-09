/**
 * Follows one commit until Vercel reports a final state for its PRODUCTION deployment. Polls every 5 s and stops
 * after 30 minutes.
 *
 * It is the only thing in the update flow allowed to say a deployment is ready: the state comes from
 * `GET /api/admin/deployment/status?sha=` (Vercel's own deployment list for the commit, else GitHub's
 * Vercel commit status), and `onState` hands every answer to the caller so the progress bar can follow it.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchDeploymentState, isTerminalDeploymentState, type DeploymentState } from '../../lib/gitDeployment';
import styles from '../settings/DeploymentCard.module.css';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

export const STATE_LABELS: Record<DeploymentState['state'], string> = {
  pending: 'Committed — waiting for Vercel',
  not_started: 'Waiting for Vercel to start',
  queued: 'Queued at Vercel',
  building: 'Building at Vercel',
  ready: 'Live in Production',
  error: 'Failed — the previous version is still serving',
  canceled: 'Canceled — the previous version is still serving',
  unknown: 'Unknown',
};

/**
 * True only when Vercel itself says the PRODUCTION deployment of the commit is built and serving — the only "ready"
 * there is. GitHub's commit status (no `serving` answer) and a Preview build never count.
 */
export const isDeploymentReady = (state: DeploymentState | null): boolean =>
  Boolean(state && state.state === 'ready' && state.serving === true);

export function DeploymentWatcher({ sha, since, onState }: {
  sha: string;
  since: string;
  onState?: (state: DeploymentState) => void;
}) {
  const [state, setState] = useState<DeploymentState | null>(null);
  const [error, setError] = useState('');
  const started = useRef(Date.now());
  const report = useRef(onState);
  report.current = onState;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const { deployment } = await fetchDeploymentState(sha, since);
        if (cancelled) return;
        setState(deployment);
        setError('');
        report.current?.(deployment);
        if (isTerminalDeploymentState(deployment.state) || Date.now() - started.current > 30 * 60_000) return;
      } catch (tickError) {
        if (!cancelled) setError(messageOf(tickError, 'The deployment state could not be read.'));
      }
      if (!cancelled) timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sha, since]);

  const unconfirmed = state?.state === 'ready' && state.serving !== true;
  const label = state ? (unconfirmed ? 'Built — confirming that it is live' : STATE_LABELS[state.state] || state.state) : 'Asking Vercel…';
  const tone = state?.state === 'ready' && !unconfirmed ? styles.ok : state && ['error', 'canceled'].includes(state.state) ? styles.bad : styles.wait;
  return (
    <div className={styles.watch} role="status" aria-live="polite">
      <p>
        Commit <code>{sha.slice(0, 7)}</code>: <strong className={tone}>{label}</strong>
        {state?.state === 'ready' && state.serving === false ? ' (built, but not promoted to production)' : ''}
      </p>
      {state?.reason ? <p className={styles.small}>{state.reason}</p> : null}
      {state?.error ? <p className={styles.small}>{state.error}</p> : null}
      {state?.inspectorUrl ? <p className={styles.small}><a href={state.inspectorUrl} target="_blank" rel="noreferrer">Open the deployment in Vercel</a></p> : null}
      {error ? <p className={styles.errorText}>{error}</p> : null}
    </div>
  );
}

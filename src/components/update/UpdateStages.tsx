/**
 * The five stages an update goes through, in order: checking, downloading, committing, deploying, ready.
 * Shared by both update flows so the order never differs between them.
 *
 * `ready` is only ever passed in by a caller that has *evidence* — Vercel reporting a READY deployment for
 * the commit, or a check that sees the new version — never because a request returned.
 */
import styles from './Update.module.css';

export type UpdateStage = 'idle' | 'checking' | 'downloading' | 'committing' | 'deploying' | 'ready';

const ORDER: UpdateStage[] = ['checking', 'downloading', 'committing', 'deploying', 'ready'];

const LABELS: Record<UpdateStage, string> = {
  idle: '',
  checking: 'Checking',
  downloading: 'Downloading',
  committing: 'Committing',
  deploying: 'Deploying',
  ready: 'Ready',
};

export default function UpdateStages({ stage, failed = false, completed = false, committingLabel }: {
  stage: UpdateStage;
  /** The stage that was running when the update failed is marked as failed. */
  failed?: boolean;
  /** The given stage has finished and the next has not started yet (for example a reviewed plan waiting to be applied). */
  completed?: boolean;
  /** A host that applies files directly (not as a commit) calls the third stage something else. */
  committingLabel?: string;
}) {
  if (stage === 'idle') return null;
  const at = ORDER.indexOf(stage);
  return (
    <ol className={styles.stages} aria-label="Update progress">
      {ORDER.map((name, index) => {
        const done = index < at || (index === at && (stage === 'ready' || completed));
        const current = index === at && stage !== 'ready' && !completed;
        const className = `${styles.stage} ${done ? styles.stageDone : ''} ${current ? (failed ? styles.stageFailed : styles.stageCurrent) : ''}`;
        const label = name === 'committing' && committingLabel ? committingLabel : LABELS[name];
        return (
          <li key={name} className={className} aria-current={current ? 'step' : undefined}>
            <span aria-hidden="true">{done ? '✓' : current ? (failed ? '✕' : '…') : '○'}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

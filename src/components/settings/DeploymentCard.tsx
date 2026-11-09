/**
 * Settings → Integrations → GitHub & Vercel.
 *
 * The one-time connection of this site to its own GitHub repository and Vercel project, then — once
 * connected — the state of each deployment and the Git-based core update. Core's card, platform owner
 * only. Everything runs through this site's own server (`src/lib/gitDeployment.ts`); the Vercel token lives
 * in this component's state while the form is open and is never written to the browser's storage.
 */
import { useCallback, useEffect, useState } from 'react';
import type { IntegrationCardProps } from '../../core/integrations';
import {
  connectDeployment,
  disconnectDeployment,
  fetchDeploymentOverview,
  inspectGithubAccount,
  inspectVercelAccount,
  type DeploymentOverview,
  type RepositoryChoice,
  type RepositoryInspection,
  type VercelProjectView,
} from '../../lib/gitDeployment';
import CoreUpdatePanel from '../update/CoreUpdatePanel';
import { DeploymentWatcher } from '../update/DeploymentWatcher';
import styles from './DeploymentCard.module.css';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

/** Kept here because other screens (Plugins → updates) import the watcher from this card. */
export { DeploymentWatcher };

function ConnectForm({ overview, onConnected }: { overview: DeploymentOverview; onConnected: (sha: string) => void }) {
  const [repositories, setRepositories] = useState<RepositoryChoice[] | null>(null);
  const [repository, setRepository] = useState(overview.github.repository || '');
  const [createRepo, setCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [branch, setBranch] = useState('main');
  const [inspection, setInspection] = useState<RepositoryInspection | null>(null);
  const [vercelToken, setVercelToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [vercelUser, setVercelUser] = useState('');
  const [projects, setProjects] = useState<VercelProjectView[] | null>(null);
  const [projectChoice, setProjectChoice] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [confirm, setConfirm] = useState({ createRepository: false, seed: false, useProject: false, createProject: false, environment: false });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [steps, setSteps] = useState<string[]>([]);

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await task();
    } catch (taskError) {
      setError(messageOf(taskError, 'That did not work.'));
      const body = (taskError as { body?: { steps?: string[] } })?.body;
      if (Array.isArray(body?.steps)) setSteps(body.steps);
    } finally {
      setBusy('');
    }
  };

  const loadRepositories = () => run('repos', async () => {
    const answer = await inspectGithubAccount();
    setRepositories(answer.github.repositories);
  });

  const checkRepository = (name: string, branchName: string) => run('repo', async () => {
    const answer = await inspectGithubAccount(name, branchName);
    setInspection(answer.repository);
  });

  const checkVercel = () => run('vercel', async () => {
    const repo = createRepo ? '' : repository;
    const answer = await inspectVercelAccount({ token: vercelToken, teamId, repository: repo });
    setVercelUser(answer.vercel.user);
    setProjects(answer.vercel.projects);
    setProjectChoice(answer.vercel.projects[0]?.id || 'create');
  });

  const needsSeed = !createRepo && inspection?.kind === 'empty';
  const creatingProject = projectChoice === 'create';
  const ready = Boolean(vercelUser && projectChoice && (createRepo ? newRepoName : repository && inspection && inspection.kind !== 'other'))
    && (!createRepo || confirm.createRepository)
    && (!needsSeed || confirm.seed)
    && (creatingProject ? Boolean(newProjectName) && confirm.createProject : confirm.useProject);

  const connect = () => run('connect', async () => {
    const answer = await connectDeployment({
      repository: createRepo ? '' : repository,
      branch,
      createRepository: createRepo ? { name: newRepoName, private: newRepoPrivate } : null,
      vercelToken,
      teamId,
      project: creatingProject ? { mode: 'create', name: newProjectName } : { mode: 'existing', id: projectChoice },
      confirm: { ...confirm, seed: createRepo ? true : confirm.seed },
    });
    setVercelToken('');
    setSteps(answer.steps);
    onConnected(answer.head);
  });

  const toggle = (key: keyof typeof confirm) => setConfirm((current) => ({ ...current, [key]: !current[key] }));

  if (!overview.github.tokenStored) {
    return <p className={styles.small}>Connect GitHub first, in the GitHub card on this screen. This step uses that token to find and update your repository.</p>;
  }
  if (!overview.connection.secretBox) {
    return (
      <p className={styles.errorText}>
        This server cannot store a Vercel token yet: <code>RWP_SECRET_BOX_KEY</code> is not set. Add 32 random bytes (base64) to this
        installation&apos;s environment and restart it. Nothing will be stored until then.
      </p>
    );
  }

  return (
    <div className={styles.form}>
      <fieldset className={styles.step}>
        <legend>1. Your GitHub repository</legend>
        <label className={styles.inline}>
          <input type="checkbox" checked={createRepo} onChange={() => setCreateRepo((value) => !value)} /> Create a new repository
        </label>
        {createRepo ? (
          <>
            <label className={styles.field}>Repository name
              <input value={newRepoName} onChange={(event) => setNewRepoName(event.target.value.trim())} placeholder="my-site" />
            </label>
            <label className={styles.inline}>
              <input type="checkbox" checked={newRepoPrivate} onChange={() => setNewRepoPrivate((value) => !value)} /> Private (recommended)
            </label>
            <label className={styles.inline}>
              <input type="checkbox" checked={confirm.createRepository} onChange={() => toggle('createRepository')} />
              Yes, create <strong>{newRepoName || '…'}</strong> on my GitHub account and fill it with React-WP {overview.installedVersion}.
            </label>
          </>
        ) : (
          <>
            <div className={styles.row}>
              <button type="button" onClick={loadRepositories} disabled={Boolean(busy)}>{busy === 'repos' ? 'Loading…' : 'List my repositories'}</button>
            </div>
            {repositories ? (
              <label className={styles.field}>Repository
                <select value={repository} onChange={(event) => {
                  const chosen = repositories.find((item) => item.fullName === event.target.value);
                  setRepository(event.target.value);
                  setBranch(chosen?.defaultBranch || 'main');
                  setInspection(null);
                }}>
                  <option value="">Choose…</option>
                  {repositories.map((item) => <option key={item.fullName} value={item.fullName}>{item.fullName}{item.private ? ' (private)' : ''}</option>)}
                </select>
              </label>
            ) : null}
            <label className={styles.field}>Production branch
              <input value={branch} onChange={(event) => { setBranch(event.target.value.trim()); setInspection(null); }} />
            </label>
            {repository ? (
              <div className={styles.row}>
                <button type="button" onClick={() => checkRepository(repository, branch)} disabled={Boolean(busy)}>{busy === 'repo' ? 'Checking…' : 'Check this repository'}</button>
              </div>
            ) : null}
            {inspection ? (
              <p className={inspection.kind === 'other' ? styles.errorText : styles.small}>
                {inspection.kind === 'react-wp' && `This repository already holds a React-WP site${inspection.plugins?.length ? ` with ${inspection.plugins.length} plugin(s)` : ''}. Nothing in it will be changed by connecting.`}
                {inspection.kind === 'empty' && 'This repository is empty. Connecting fills it with this site’s React-WP version (core files only).'}
                {inspection.kind === 'other' && 'This repository holds something that is not a React-WP site, so it cannot be used. Choose another or create a new one.'}
              </p>
            ) : null}
            {needsSeed ? (
              <label className={styles.inline}>
                <input type="checkbox" checked={confirm.seed} onChange={() => toggle('seed')} />
                Yes, commit React-WP {overview.installedVersion} to {repository}@{branch}.
              </label>
            ) : null}
          </>
        )}
      </fieldset>

      <fieldset className={styles.step}>
        <legend>2. Your Vercel project</legend>
        <label className={styles.field}>Vercel access token
          <input type="password" autoComplete="off" value={vercelToken} onChange={(event) => setVercelToken(event.target.value.trim())} />
        </label>
        <label className={styles.field}>Team (optional — a team id or slug)
          <input value={teamId} onChange={(event) => setTeamId(event.target.value.trim())} />
        </label>
        <div className={styles.row}>
          <button type="button" onClick={checkVercel} disabled={!vercelToken || Boolean(busy)}>{busy === 'vercel' ? 'Checking…' : 'Check the token'}</button>
        </div>
        {vercelUser ? <p className={styles.small}>Token belongs to <strong>{vercelUser}</strong>. It is stored only after you connect, sealed on this server.</p> : null}
        {projects ? (
          <div className={styles.choices} role="radiogroup" aria-label="Vercel project">
            {projects.map((project) => (
              <label key={project.id} className={styles.inline}>
                <input type="radio" name="rwp-project" checked={projectChoice === project.id} onChange={() => setProjectChoice(project.id)} />
                {project.name} — deploys {project.repository}{project.productionBranch ? ` (${project.productionBranch})` : ''}
              </label>
            ))}
            <label className={styles.inline}>
              <input type="radio" name="rwp-project" checked={creatingProject} onChange={() => setProjectChoice('create')} /> Create a new project connected to this repository
            </label>
            {creatingProject ? (
              <>
                <label className={styles.field}>New project name
                  <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value.trim().toLowerCase())} placeholder="my-site" />
                </label>
                <label className={styles.inline}>
                  <input type="checkbox" checked={confirm.createProject} onChange={() => toggle('createProject')} />
                  Yes, create <strong>{newProjectName || '…'}</strong> on Vercel and deploy it from {createRepo ? newRepoName || 'the new repository' : repository}.
                </label>
              </>
            ) : projectChoice ? (
              <label className={styles.inline}>
                <input type="checkbox" checked={confirm.useProject} onChange={() => toggle('useProject')} />
                Yes, this site deploys through that project from now on.
              </label>
            ) : null}
            {!projects.length ? <p className={styles.small}>No project on this account deploys that repository yet. An existing project that deploys nothing is never relinked here; connect it in Vercel (Project → Settings → Git) or create a new one.</p> : null}
          </div>
        ) : null}
      </fieldset>

      <fieldset className={styles.step}>
        <legend>3. Settings the deployed site needs</legend>
        <label className={styles.inline}>
          <input type="checkbox" checked={confirm.environment} onChange={() => toggle('environment')} />
          Copy this site&apos;s database connection, Supabase keys and RWP_SECRET_BOX_KEY to the Vercel project as encrypted variables.
        </label>
        <p className={styles.small}>Needed when the project is new. Leave it off if the project already has them. Values go only to Vercel; this screen never shows them.</p>
      </fieldset>

      {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
      {steps.length ? <ul className={styles.steps}>{steps.map((step) => <li key={step}>{step}</li>)}</ul> : null}
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={connect} disabled={!ready || Boolean(busy)}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
      </div>
    </div>
  );
}

export function DeploymentCard({ refresh }: IntegrationCardProps) {
  const [overview, setOverview] = useState<DeploymentOverview | null>(null);
  const [error, setError] = useState('');
  const [watching, setWatching] = useState<{ sha: string; since: string } | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setOverview(await fetchDeploymentOverview());
      setError('');
    } catch (loadError) {
      setError(messageOf(loadError, 'The deployment settings could not be read.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const disconnect = async () => {
    if (!window.confirm('Remove the stored Vercel token and project from this site? The project keeps deploying the repository; revoke the token in Vercel if it should stop working.')) return;
    try {
      const answer = await disconnectDeployment();
      setNotice(answer.message);
      await load();
      refresh();
    } catch (disconnectError) {
      setError(messageOf(disconnectError, 'The connection could not be removed.'));
    }
  };

  if (error && !overview) return <p className={styles.errorText} role="alert">{error}</p>;
  if (!overview) return <p className={styles.small}>Loading…</p>;
  const { connection } = overview;

  return (
    <div className={styles.card}>
      <p className={styles.small}>
        Your site&apos;s code lives in your own GitHub repository and Vercel deploys it. Plugin installs and core updates become commits there.
        Your tokens stay on this site; React-WP.com only publishes releases.
      </p>
      {notice ? <p className={styles.noticeText}>{notice}</p> : null}
      {connection.connected ? (
        <>
          <dl className={styles.facts}>
            <dt>Repository</dt><dd>{connection.repository} ({connection.branch})</dd>
            <dt>Vercel project</dt><dd>{connection.project?.name}{connection.project?.team ? ` — team ${connection.project.team}` : ''}</dd>
            <dt>Vercel token</dt><dd>{connection.tokenFingerprint} {connection.vercelUser ? `(${connection.vercelUser})` : ''}</dd>
            <dt>Connected</dt><dd>{connection.connectedAt ? new Date(connection.connectedAt).toLocaleString() : ''}</dd>
          </dl>
          {!connection.secretBox ? <p className={styles.errorText}>RWP_SECRET_BOX_KEY is not set on this server, so the stored token cannot be opened. Set the same key the token was stored with.</p> : null}
          {watching ? <DeploymentWatcher sha={watching.sha} since={watching.since} /> : null}
          <h4 className={styles.subhead}>Update React-WP core</h4>
          <CoreUpdatePanel />
          <div className={styles.row}>
            <button type="button" onClick={disconnect}>Disconnect</button>
          </div>
        </>
      ) : (
        <ConnectForm overview={overview} onConnected={(sha) => { setWatching({ sha, since: new Date().toISOString() }); void load(); refresh(); }} />
      )}
      {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
    </div>
  );
}

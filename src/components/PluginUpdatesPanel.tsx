/**
 * Plugins → Plugin updates.
 *
 * Plugins are released on their own tags (`<plugin-id>-v<version>`), apart from React-WP core, so a plugin
 * can be updated without a core update and the reverse. The server (`server/pluginUpdates.mjs`) compares
 * what the site's repository holds with those releases; applying one is a single commit under
 * `plugins/<id>/`. A commit is not an install: the deployment watcher reports Vercel's real state, and
 * the previous deployment keeps serving until it is Ready.
 *
 * Shown to the platform owner only (administrator / super_admin) — the routes refuse everyone else too.
 * Nothing runs until the owner presses "Check for updates"; a check is read-only.
 */
import { useEffect, useState } from 'react';
import { client } from '../lib/db';
import { fetchProfile } from '../lib/profiles';
import { getUserRole, isPlatformOwner, type UserRole } from '../lib/roles';
import { applyPluginUpdate, checkPluginUpdates, type PluginUpdateRow } from '../lib/gitDeployment';
import { DeploymentWatcher } from './settings/DeploymentCard';
import styles from './PluginUpdatesPanel.module.css';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

function useOwnerRole(): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const { data } = await client.auth.getSession();
        const user = data.session?.user;
        if (!user) return;
        const profile = await fetchProfile(user.id);
        const role = profile?.role ? (profile.role as UserRole) : getUserRole(user);
        if (mounted) setOwner(Boolean(role && isPlatformOwner(role)));
      } catch {
        // Not signed in, or the profile cannot be read: the panel simply stays hidden.
      }
    })();
    return () => { mounted = false; };
  }, []);
  return owner;
}

export default function PluginUpdatesPanel() {
  const owner = useOwnerRole();
  const [rows, setRows] = useState<PluginUpdateRow[] | null>(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState<{ id: string; text: string; sha: string; since: string; warnings: string[] } | null>(null);

  if (!owner) return null;

  const check = async () => {
    setBusy('check');
    setError('');
    try {
      const answer = await checkPluginUpdates();
      setRows(answer.plugins);
      setSource(answer.releaseRepository);
    } catch (failure) {
      setRows(null);
      setError(messageOf(failure, 'The plugin updates could not be checked.'));
    } finally {
      setBusy('');
    }
  };

  const update = async (row: PluginUpdateRow) => {
    setBusy(row.id);
    setError('');
    try {
      const answer = await applyPluginUpdate({ id: row.id, version: row.latest });
      const { update: done, commit, warnings, sql } = answer.result;
      setApplied({
        id: row.id,
        text: `${row.name} ${done.from} → ${done.to} was committed to your repository.`,
        sha: answer.deployment?.sha || commit.sha,
        since: new Date().toISOString(),
        warnings: [
          ...warnings,
          ...(sql.length ? [`This version ships SQL (${sql.map((file) => file.path).join(', ')}). It is not run for you: deactivate and activate the plugin, or run it in the Supabase SQL Editor, once the deployment is Ready.`] : []),
        ],
      });
      setRows((current) => (current || []).map((item) => (item.id === row.id ? { ...item, state: 'up-to-date', installed: done.to, release: null } : item)));
    } catch (failure) {
      setError(messageOf(failure, `${row.name} could not be updated.`));
    } finally {
      setBusy('');
    }
  };

  const available = (rows || []).filter((row) => row.state === 'available' || row.state === 'unavailable');

  return (
    <section className={styles.panel} aria-labelledby="plugin-updates-heading">
      <div className={styles.head}>
        <h3 id="plugin-updates-heading">Plugin updates</h3>
        <button type="button" className={styles.button} onClick={check} disabled={busy !== ''}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      <p className={styles.help}>
        Each plugin has its own releases, separate from React-WP core, so updating a plugin never changes core. An update is one commit to your repository; the plugin is only updated once Vercel&apos;s deployment is Ready, and until then the current site keeps running.
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {applied && (
        <div role="status">
          <p className={styles.ok}>{applied.text}</p>
          <DeploymentWatcher sha={applied.sha} since={applied.since} />
          {applied.warnings.map((warning) => <p key={warning} className={styles.small}>{warning}</p>)}
        </div>
      )}
      {rows && available.length === 0 && (
        <p className={styles.small} role="status">All {rows.length} installed plugin{rows.length === 1 ? ' is' : 's are'} up to date{source ? ` (releases read from ${source})` : ''}.</p>
      )}
      {available.length > 0 && (
        <ul className={styles.list}>
          {available.map((row) => (
            <li key={row.id} className={styles.item}>
              <div className={styles.itemHead}>
                <strong>{row.name} <span className={styles.small}>{row.installed} → {row.latest}</span></strong>
                {row.state === 'available' && (
                  <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => update(row)} disabled={busy !== ''}>
                    {busy === row.id ? 'Updating…' : 'Update'}
                  </button>
                )}
              </div>
              {row.state === 'unavailable' && <p className={styles.warn}>{row.reason}</p>}
              {row.release?.prerelease && <p className={styles.warn}>This is a pre-release.</p>}
              {row.release && row.release.notes.length > 0 && (
                <ul className={styles.notes}>{row.release.notes.slice(0, 6).map((note) => <li key={note}>{note}</li>)}</ul>
              )}
              {row.release?.url && <a className={styles.small} href={row.release.url} target="_blank" rel="noreferrer noopener">Release notes on GitHub</a>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

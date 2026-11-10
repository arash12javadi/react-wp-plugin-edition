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
 * The screen makes one read-only check when it opens, so a new release is visible without a click; applying
 * an update only ever happens when the owner presses "Update".
 */
import { useEffect, useRef, useState } from 'react';
import { client } from '../lib/db';
import { fetchProfile } from '../lib/profiles';
import { getUserRole, isPlatformOwner, type UserRole } from '../lib/roles';
import { applyPluginUpdate, checkPluginUpdates, type PluginUpdateRow } from '../lib/gitDeployment';
import { callLink } from '../lib/licenseLinkApi';
import { compareVersions } from '../lib/updates';
import { rwp } from '../lib/rwp';
import { DeploymentWatcher } from './settings/DeploymentCard';
import styles from './PluginUpdatesPanel.module.css';

/** A sold plugin with a newer version than the one running, from react-wp.com (not GitHub). */
interface SoldUpdate { id: string; name: string; installed: string; latest: string }

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
  const [sold, setSold] = useState<SoldUpdate[]>([]);
  const autoChecked = useRef(false);

  // The sold plugins are not on GitHub: react-wp.com says which version this site is licensed for, and the site
  // compares it with what it runs. Nothing here fetches a package; that happens only when Update is pressed.
  const readSold = async () => {
    const { answer } = await callLink('', 'GET');
    const latest = answer.link?.connected ? answer.link.latestVersions || {} : {};
    setSold(rwp.getPlugins()
      .filter((plugin) => latest[plugin.id] && compareVersions(latest[plugin.id], plugin.version) > 0)
      .map((plugin) => ({ id: plugin.id, name: plugin.name, installed: plugin.version, latest: latest[plugin.id] })));
  };

  // `quiet` is the check this screen makes on its own when it opens: a site that is not connected to GitHub
  // and Vercel simply has nothing to show, so its refusal is not displayed as an error. The button still shows it.
  const check = async (quiet = false) => {
    setBusy('check');
    setError('');
    try {
      await readSold().catch(() => setSold([]));
      const answer = await checkPluginUpdates();
      setRows(answer.plugins);
      setSource(answer.releaseRepository);
    } catch (failure) {
      setRows(null);
      if (!quiet) setError(messageOf(failure, 'The plugin updates could not be checked.'));
    } finally {
      setBusy('');
    }
  };

  const updateSold = async (row: SoldUpdate) => {
    setBusy(row.id);
    setError('');
    try {
      const { status, answer } = await callLink('/update', 'POST', { plugin: row.id, version: row.latest });
      if (status >= 400 || answer.ok === false || !answer.result) {
        throw new Error(answer.error || `${row.name} could not be updated. Try again in a moment.`);
      }
      const { update: done, commit, warnings, sql } = answer.result;
      setApplied({
        id: row.id,
        text: `${row.name} ${done.from} → ${done.to} was committed to your repository.`,
        sha: answer.deployment?.sha || commit.sha,
        since: new Date().toISOString(),
        warnings: [
          ...warnings,
          ...(sql.length ? ['This version includes database changes. They are applied automatically, and safely, as soon as the new version is live — you do not need to do anything.'] : []),
        ],
      });
      setSold((current) => current.filter((item) => item.id !== row.id));
    } catch (failure) {
      setError(messageOf(failure, `${row.name} could not be updated.`));
    } finally {
      setBusy('');
    }
  };

  // A read-only check, once, as soon as the owner is known: a new plugin release is visible without a click.
  // Applying an update is never done here; it stays a button.
  useEffect(() => {
    if (!owner || autoChecked.current) return;
    autoChecked.current = true;
    void check(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  if (!owner) return null;

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
          ...(sql.length ? ['This version includes database changes. They are applied automatically, and safely, as soon as the new version is live — you do not need to do anything.'] : []),
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
        <button type="button" className={styles.button} onClick={() => void check()} disabled={busy !== ''}>
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
      {rows && available.length === 0 && sold.length === 0 && (
        <p className={styles.small} role="status">All {rows.length} installed plugin{rows.length === 1 ? ' is' : 's are'} up to date{source ? ` (releases read from ${source})` : ''}.</p>
      )}
      {sold.length > 0 && (
        <ul className={styles.list}>
          {sold.map((row) => (
            <li key={row.id} className={styles.item}>
              <div className={styles.itemHead}>
                <strong>{row.name} <span className={styles.small}>{row.installed} → {row.latest}</span></strong>
                <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => void updateSold(row)} disabled={busy !== ''}>
                  {busy === row.id ? 'Updating…' : 'Update'}
                </button>
              </div>
              <p className={styles.small}>Licensed plugin: the new version comes from your react-wp.com account, signed for this site.</p>
            </li>
          ))}
        </ul>
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

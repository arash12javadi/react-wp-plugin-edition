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
 * `usePluginUpdates` holds the state, so the Plugins table can put each plugin's **Update** button in its
 * own row and the header can offer **Check for updates**; this panel shows what the rows cannot: the result
 * of an update, release notes, why an update cannot be applied here, when the last check ran, and
 * **Update all**, which commits every update together so Vercel deploys once.
 *
 * A plugin this site publishes itself (a product under Developers) is never updated without asking first:
 * the release can replace code that was never released. It arrives as readable source (react-wp.com never obfuscates a plugin
 * for the account that publishes it), and anything that would arrive protected is backed up automatically.
 * `PluginUpdateDialog` asks, and a copy of the current code is kept in `plugin-backups/<id>/`.
 *
 * The screen makes one read-only check when it opens, so a new release is visible without a click; applying
 * an update only ever happens when the owner presses "Update" or "Update all".
 */
import { useEffect, useRef, useState } from 'react';
import { client } from '../lib/db';
import { fetchProfile } from '../lib/profiles';
import { getUserRole, isPlatformOwner, type UserRole } from '../lib/roles';
import { applyPluginUpdate, applyPluginUpdates, checkPluginUpdates, type PluginUpdateRow } from '../lib/gitDeployment';
import { callLink } from '../lib/licenseLinkApi';
import { compareVersions } from '../lib/updates';
import { rwp } from '../lib/rwp';
import { DeploymentWatcher } from './settings/DeploymentCard';
import { isDeploymentReady } from './update/DeploymentWatcher';
import styles from './PluginUpdatesPanel.module.css';

/** A sold plugin with a newer version than the one running, from react-wp.com (not GitHub). */
interface SoldUpdate { id: string; name: string; installed: string; latest: string }

/** One plugin with a newer version, whichever source announced it. */
export interface PendingPluginUpdate {
  id: string;
  name: string;
  installed: string;
  latest: string;
  /** `release`: a free plugin's release; `licensed`: a sold plugin delivered through the react-wp.com account link. */
  kind: 'release' | 'licensed';
  /** True when **Update** can be pressed on this site. False rows carry `reason`. */
  ready: boolean;
  reason: string;
  release: PluginUpdateRow['release'];
  /** This site publishes the plugin itself (a product under Developers): updating it asks first and keeps a backup. */
  own: boolean;
}

interface AppliedUpdate { text: string; sha: string; since: string; warnings: string[] }

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

const SQL_NOTE = 'This version includes database changes. They are applied automatically, and safely, as soon as the new version is live — you do not need to do anything.';

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

/**
 * The plugins this site publishes itself: the products under Developers (`dev_products`, one row per plugin id).
 * A site without the Developers plugin has no such table, and the answer is simply "none".
 */
async function readOwnPluginIds(): Promise<string[]> {
  try {
    const { data, error } = await client.from('dev_products').select('slug');
    if (error || !Array.isArray(data)) return [];
    return data.map((row: { slug?: unknown }) => String(row.slug || '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** The update state of the Plugins screen: the check, what it found, and the ways to apply updates. */
export function usePluginUpdates() {
  const owner = useOwnerRole();
  const [rows, setRows] = useState<PluginUpdateRow[] | null>(null);
  const [sold, setSold] = useState<SoldUpdate[]>([]);
  const [ownIds, setOwnIds] = useState<string[]>([]);
  const [canApply, setCanApply] = useState(true);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [applied, setApplied] = useState<AppliedUpdate | null>(null);
  /** The updates waiting for the owner's answer in `PluginUpdateDialog`, or null. */
  const [confirming, setConfirming] = useState<PendingPluginUpdate[] | null>(null);
  const autoChecked = useRef(false);

  // The sold plugins are not on GitHub: react-wp.com says which version this site is licensed for, and the site
  // compares it with what it runs. Nothing here fetches a package; that happens only when Update is pressed.
  const readSold = async (): Promise<SoldUpdate[]> => {
    const { answer } = await callLink('', 'GET');
    const latest = answer.link?.connected ? answer.link.latestVersions || {} : {};
    return rwp.getPlugins()
      .filter((plugin) => latest[plugin.id] && compareVersions(latest[plugin.id], plugin.version) > 0)
      .map((plugin) => ({ id: plugin.id, name: plugin.name, installed: plugin.version, latest: latest[plugin.id] }));
  };

  // Every source is asked at once: none waits for another, so the answer is as quick as the slowest one.
  // `quiet` is the check this screen makes on its own when it opens: a site that is not connected to GitHub
  // and Vercel simply has nothing to show, so its refusal is not displayed as an error. The button still shows it.
  const check = async (quiet = false) => {
    setBusy('check');
    setError('');
    try {
      const running = rwp.getPlugins().map((plugin) => ({ id: plugin.id, name: plugin.name, version: plugin.version }));
      const [licensed, released, own] = await Promise.allSettled([readSold(), checkPluginUpdates(running), readOwnPluginIds()]);
      setSold(licensed.status === 'fulfilled' ? licensed.value : []);
      setOwnIds(own.status === 'fulfilled' ? own.value : []);
      if (released.status === 'fulfilled') {
        setRows(released.value.plugins);
        setCanApply(released.value.canApply !== false);
        setNotice(released.value.notice || '');
      } else {
        setRows(null);
        setNotice('');
        if (!quiet) setError(messageOf(released.reason, 'The plugin updates could not be checked.'));
      }
      setCheckedAt(new Date());
    } finally {
      setBusy('');
    }
  };

  const markUpdated = (ids: string[], to: Record<string, string>) => {
    setRows((current) => (current || []).map((item) => (ids.includes(item.id) ? { ...item, state: 'up-to-date', installed: to[item.id] || item.latest, release: null } : item)));
    setSold((current) => current.filter((item) => !ids.includes(item.id)));
  };

  const backupNote = (backup: { folder: string } | null | undefined, name: string) =>
    backup?.folder ? [`Your previous code of ${name} is kept in ${backup.folder}/ in your repository.`] : [];

  /** One plugin, by its own route. */
  const updateOne = async (item: PendingPluginUpdate, backup: boolean) => {
    setBusy(item.id);
    setError('');
    try {
      let result: { update: { from: string; to: string }; commit: { sha: string }; warnings: string[]; sql: unknown[]; backup?: { folder: string } | null };
      let deploymentSha = '';
      if (item.kind === 'licensed') {
        const { status, answer } = await callLink('/update', 'POST', { plugin: item.id, version: item.latest, backup });
        if (status >= 400 || answer.ok === false || !answer.result) {
          throw new Error(answer.error || `${item.name} could not be updated. Try again in a moment.`);
        }
        result = answer.result;
        deploymentSha = answer.deployment?.sha || '';
      } else {
        const answer = await applyPluginUpdate({ id: item.id, version: item.latest, backup });
        result = answer.result;
        deploymentSha = answer.deployment?.sha || '';
      }
      setApplied({
        text: `${item.name} ${result.update.from} → ${result.update.to} was committed to your repository.`,
        sha: deploymentSha || result.commit.sha,
        since: new Date().toISOString(),
        warnings: [...backupNote(result.backup, item.name), ...result.warnings, ...(result.sql.length ? [SQL_NOTE] : [])],
      });
      markUpdated([item.id], { [item.id]: result.update.to });
    } catch (failure) {
      setError(messageOf(failure, `${item.name} could not be updated.`));
    } finally {
      setBusy('');
    }
  };

  /** Several plugins in one request: one chain of commits, the branch moved once, one deployment. */
  const updateMany = async (items: PendingPluginUpdate[], backupOwn: boolean) => {
    setBusy('all');
    setError('');
    try {
      const answer = await applyPluginUpdates(items.map((item) => ({
        id: item.id, version: item.latest, kind: item.kind, backup: item.own && backupOwn,
      })));
      const nameOf = (id: string) => items.find((item) => item.id === id)?.name || id;
      const done = answer.results.filter((row) => row.ok);
      const failed = answer.results.filter((row) => !row.ok);
      setApplied({
        text: done.length
          ? `${done.length} plugin${done.length === 1 ? ' was' : 's were'} committed to your repository together (${done.map((row) => `${nameOf(row.id)} ${row.from} → ${row.to}`).join(', ')}). Vercel builds them in one deployment.`
          : 'No plugin was updated.',
        sha: answer.deployment?.sha || '',
        since: new Date().toISOString(),
        warnings: [
          ...failed.map((row) => `${nameOf(row.id)} was not updated: ${row.error}`),
          ...done.flatMap((row) => backupNote(row.backup, nameOf(row.id))),
          ...(done.some((row) => row.sql) ? [SQL_NOTE] : []),
        ],
      });
      markUpdated(done.map((row) => row.id), Object.fromEntries(done.map((row) => [row.id, row.to || ''])));
    } catch (failure) {
      setError(messageOf(failure, 'The plugins could not be updated.'));
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

  // A plugin for sale that this site is not connected for cannot be updated from here, but it is still news: it is listed with its reason.
  const pending: PendingPluginUpdate[] = [
    ...sold.map((row) => ({ ...row, kind: 'licensed' as const, ready: true, reason: '', release: null, own: ownIds.includes(row.id) })),
    ...(rows || [])
      .filter((row) => (row.state === 'available' || (row.state === 'unavailable' && row.release)) && !sold.some((item) => item.id === row.id))
      .map((row) => ({
        id: row.id, name: row.name, installed: row.installed, latest: row.latest,
        kind: 'release' as const, ready: row.state === 'available', reason: row.reason, release: row.release, own: ownIds.includes(row.id),
      })),
  ];
  const ready = pending.filter((item) => item.ready);

  /**
   * Asks first when it matters: several plugins at once (the list is shown before anything is committed), or a
   * plugin this site publishes itself. One ordinary plugin updates straight away, as its button always did.
   * Only ever called from a click.
   */
  const requestUpdate = (items: PendingPluginUpdate[]) => {
    const list = items.filter((item) => item.ready);
    if (!list.length || busy !== '') return;
    if (list.length > 1 || list.some((item) => item.own)) {
      setConfirming(list);
      return;
    }
    void updateOne(list[0], false);
  };

  /** The owner's answer in `PluginUpdateDialog`: which of the listed updates to apply, and whether to keep a backup of their own code. */
  const confirmUpdate = ({ includeOwn, backupOwn }: { includeOwn: boolean; backupOwn: boolean }) => {
    const list = (confirming || []).filter((item) => includeOwn || !item.own);
    setConfirming(null);
    if (!list.length) return;
    if (list.length === 1) void updateOne(list[0], list[0].own && backupOwn);
    else void updateMany(list, backupOwn);
  };

  return {
    owner,
    busy,
    checking: busy === 'check',
    error,
    applied,
    checkedAt,
    canApply,
    notice,
    pending,
    ready,
    confirming,
    pendingFor: (id: string) => pending.find((item) => item.id === id) || null,
    check: () => check(),
    updatePlugin: (item: PendingPluginUpdate) => requestUpdate([item]),
    updateAll: () => requestUpdate(ready),
    confirmUpdate,
    cancelUpdate: () => setConfirming(null),
  };
}

export type PluginUpdates = ReturnType<typeof usePluginUpdates>;

const timeOf = (date: Date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * What the table rows cannot show. `inTable` names the plugins listed in the table below: their **Update**
 * button is in their own row, so this panel only gives their notes; anything not listed there keeps a button here.
 */
export default function PluginUpdatesPanel({ updates, inTable }: { updates: PluginUpdates; inTable: string[] }) {
  const { owner, busy, error, applied, checkedAt, pending, ready, notice } = updates;
  // The page keeps running the build it was opened with until it is loaded again: once Vercel says the new one is live, say so.
  const [liveSha, setLiveSha] = useState('');
  if (!owner) return null;

  const waiting = pending.length;
  const when = checkedAt ? <span className={styles.when}>Last checked {timeOf(checkedAt)}.</span> : null;

  // Nothing to say and nothing to do: one quiet line instead of an empty box.
  if (!applied && !error && waiting === 0) {
    if (!checkedAt) return null;
    return (
      <p className={styles.quiet} role="status">
        <span aria-hidden="true">✓</span> Your plugins are up to date. {when}
        {notice && <span className={styles.small}> {notice}</span>}
      </p>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="plugin-updates-heading">
      <div className={styles.head}>
        <h3 id="plugin-updates-heading">{waiting > 0 ? `${waiting} plugin update${waiting === 1 ? '' : 's'} available` : 'Plugin updates'}</h3>
        <div className={styles.headActions}>
          {when}
          {ready.length > 1 && (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={updates.updateAll}
              disabled={busy !== ''}
              title="Commit every update together, so the site is rebuilt and deployed once"
            >
              {busy === 'all' ? 'Updating…' : `Update all (${ready.length})`}
            </button>
          )}
        </div>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.small}>{notice}</p>}
      {applied && (
        <div role="status" className={styles.applied}>
          <p className={styles.ok}>{applied.text}</p>
          {applied.sha && (
            <DeploymentWatcher
              sha={applied.sha}
              since={applied.since}
              onState={(state) => { if (isDeploymentReady(state)) setLiveSha(applied.sha); }}
            />
          )}
          {applied.sha && liveSha === applied.sha && (
            <p className={styles.ok}>
              The new version is live. This page still runs the one it was opened with.{' '}
              <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => window.location.reload()}>Reload to use it</button>
            </p>
          )}
          {applied.warnings.map((warning) => <p key={warning} className={styles.small}>{warning}</p>)}
        </div>
      )}
      {pending.length > 0 && (
        <ul className={styles.list}>
          {pending.map((row) => {
            const listed = inTable.includes(row.id);
            return (
              <li key={row.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <strong>
                    {row.name} <span className={styles.small}>{row.installed} → {row.latest}</span>
                    {row.own && <span className={styles.ownTag} title="This site publishes this plugin (Developers). Updating it asks first and keeps a copy of your code.">Yours</span>}
                  </strong>
                  {row.ready && !listed && (
                    <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => updates.updatePlugin(row)} disabled={busy !== ''}>
                      {busy === row.id ? 'Updating…' : 'Update'}
                    </button>
                  )}
                  {row.ready && listed && <span className={styles.small}>Use <strong>Update</strong> in its row below.</span>}
                </div>
                {!row.ready && row.reason && <p className={styles.warn}>{row.reason}</p>}
                {row.release?.prerelease && <p className={styles.warn}>This is a pre-release.</p>}
                {row.release && row.release.notes.length > 0 && (
                  <details className={styles.notesBox}>
                    <summary>What is new</summary>
                    <ul className={styles.notes}>{row.release.notes.slice(0, 6).map((note) => <li key={note}>{note}</li>)}</ul>
                    {row.release.url && <a className={styles.small} href={row.release.url} target="_blank" rel="noreferrer noopener">Full release notes</a>}
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The version picker: the five most recent stable releases of the release repository, newest first, with
 * the installed one marked "Installed" and the newest "Latest". One component for every screen that moves
 * this site to a version — Dashboard → Updates and Settings → Integrations → GitHub & Vercel → Update
 * React-WP core — and one server list behind it (`POST /api/admin/updates/releases`).
 *
 * Choosing an older release than the one installed is a downgrade. It is allowed, but it shows a warning
 * and needs an explicit tick ("I understand…") before `confirmed` turns true; the server independently
 * refuses a downgrade that was not confirmed (HTTP 428), so this box is a courtesy and not the control.
 * The picker holds a tag from the list, never free text — the server only accepts a tag it listed itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRecentReleases, type RecentRelease, type RecentReleases } from '../../lib/updateCenter';
import styles from './Update.module.css';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

/** The warning shown beside a downgrade — in step with `DOWNGRADE_WARNING` in `server/releaseList.mjs`. */
export const DOWNGRADE_NOTICE = 'This is an older version than the one installed. Database changes made by newer versions are not undone, so an older release may not work with your current data. Back up first.';

const formatDate = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
};

export interface RecentReleasesState {
  releases: RecentReleases | null;
  loading: boolean;
  error: string;
  /** The tag the picker has selected. Starts as the latest release. */
  selected: string;
  select: (tag: string) => void;
  /** True once the person ticked the downgrade confirmation for the selected tag. */
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
  reload: (refresh?: boolean) => Promise<void>;
  /** The selected release, or null while the list is not loaded. */
  current: RecentRelease | null;
  /** True when the selected release is older than the installed one and has not been confirmed yet. */
  blocked: boolean;
}

/** Loads the list once and tracks the selection; selecting another tag clears the downgrade confirmation. */
export function useRecentReleases(enabled = true): RecentReleasesState {
  const [releases, setReleases] = useState<RecentReleases | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const selectedRef = useRef('');
  selectedRef.current = selected;

  const reload = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const list = await fetchRecentReleases(refresh);
      setReleases(list);
      // Keep the choice when it is still listed; otherwise fall back to the latest.
      const keep = list.releases.some((release) => release.tag === selectedRef.current);
      if (!keep) {
        setSelected(list.latest_tag || list.releases[0]?.tag || '');
        setConfirmed(false);
      }
    } catch (loadError) {
      setError(messageOf(loadError, 'The list of releases could not be read.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const select = useCallback((tag: string) => {
    setSelected(tag);
    setConfirmed(false);
  }, []);

  const current = releases?.releases.find((release) => release.tag === selected) || null;
  const blocked = current?.move === 'downgrade' && !confirmed;
  return { releases, loading, error, selected, select, confirmed, setConfirmed, reload, current, blocked };
}

export default function ReleasePicker({ state, disabled = false, name = 'rwp-release' }: {
  state: RecentReleasesState;
  disabled?: boolean;
  /** The radio group's name, unique per screen. */
  name?: string;
}) {
  const { releases, loading, error, selected, select, confirmed, setConfirmed, reload, current } = state;
  return (
    <fieldset className={styles.picker} disabled={disabled}>
      <legend>Choose a version</legend>
      {loading && !releases ? <p className={styles.hint}>Reading the latest releases…</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}{' '}
          <button type="button" className={styles.linkButton} onClick={() => void reload(true)}>Try again</button>
        </p>
      ) : null}
      {releases?.stale && releases.warning ? <p className={styles.hint} role="status">Showing the last list that was read. {releases.warning}</p> : null}
      {releases?.releases.map((release) => {
        const isSelected = release.tag === selected;
        return (
          <label key={release.tag} className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}>
            <input
              type="radio"
              name={name}
              value={release.tag}
              checked={isSelected}
              onChange={() => select(release.tag)}
            />
            <span className={styles.optionBody}>
              <span className={styles.optionHead}>
                <span className={styles.tag}>{release.tag}</span>
                {release.latest ? <span className={`${styles.badge} ${styles.badgeLatest}`}>Latest</span> : null}
                {release.installed ? <span className={`${styles.badge} ${styles.badgeInstalled}`}>Installed</span> : null}
                {release.critical ? <span className={`${styles.badge} ${styles.badgeCritical}`}>Security release</span> : null}
                {release.released ? <span className={styles.date}>{formatDate(release.released)}</span> : null}
              </span>
              {release.title && release.title !== release.tag ? <span className={styles.tag}>{release.title}</span> : null}
              {release.notes.length ? (
                <ul className={styles.notes}>
                  {release.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              ) : null}
            </span>
          </label>
        );
      })}
      {releases ? (
        <p className={styles.hint}>
          The {releases.releases.length} most recent stable releases{releases.repository ? <> of <code>{releases.repository}</code></> : null}.{' '}
          <button type="button" className={styles.linkButton} disabled={loading} onClick={() => void reload(true)}>
            {loading ? 'Reading…' : 'Reload the list'}
          </button>
        </p>
      ) : null}
      {current?.move === 'downgrade' ? (
        <div className={styles.warning} role="alert">
          <p><strong>Downgrade to {current.tag}.</strong> {DOWNGRADE_NOTICE}</p>
          <label className={styles.confirm}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            I understand — install {current.tag} anyway
          </label>
        </div>
      ) : null}
      {current?.move === 'current' ? <p className={styles.hint}>This is the version already installed.</p> : null}
    </fieldset>
  );
}

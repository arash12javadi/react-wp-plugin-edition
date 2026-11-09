/**
 * Dashboard → Updates, the part that outlives a page load: the last answer and the badge.
 *
 * There is no version file to fetch here and no `updates.json` to keep publishing. A version is
 * published by *tagging a release on GitHub* (`v2.4.1`), and the answer comes from the server
 * (`src/lib/updateCenter.ts` → `server/updateCenter.mjs`): from the repository named on Settings →
 * Updates, else from `react-wp.com` when this site holds a token for it, else from the release tags of
 * whichever repository the GitHub integration holds. That is why nothing in this file performs a
 * check — it stores what the server said and compares it against the build that is running, which is the
 * one comparison a badge can make without guessing.
 *
 * Two facts worth keeping in mind:
 *
 *   - **`installedAppVersion` is the build's own version**, inlined by Vite from `package.json` at build
 *     time. A row written by an older build must never make an installed update look outstanding, so the
 *     comparison is re-done every time the row is read, never trusted from the row itself.
 *   - **One writer.** The row is written by the check that just ran (`saveUpdateStatus`), so the sidebar
 *     badge, the Overview banner and the Updates screen always show the same answer.
 */
import { version as installedAppVersion } from '../../package.json';
import { describeDbError, client, tryGetClient } from './db';
import { rwp } from './rwp';

export { installedAppVersion };

/** The `options` row holding the last answer, readable by every administrator. */
export const updateStatusOption = 'rwp_update_status';

export const autoCheckIntervals = {
  off: { label: 'Never (check by hand)', ms: 0 },
  admin: { label: 'Every time an administrator opens the admin', ms: 1 },
  daily: { label: 'Once a day', ms: 24 * 60 * 60 * 1000 },
  weekly: { label: 'Once a week', ms: 7 * 24 * 60 * 60 * 1000 },
  monthly: { label: 'Once a month', ms: 30 * 24 * 60 * 60 * 1000 },
} as const;

export type AutoCheck = keyof typeof autoCheckIntervals;

/**
 * The two settings the dashboard itself keeps. Everything else about updates — the release repository and
 * whether this host may update itself — lives in `system_settings.updates_config`, where the server reads it.
 */
export interface UpdateSettings {
  auto_check: AutoCheck;
  /** Show new releases in the sidebar badge and on the Overview. */
  notify: boolean;
}

export const defaultUpdateSettings: UpdateSettings = { auto_check: 'weekly', notify: true };

/**
 * How often "every time an administrator opens the admin" may actually hit GitHub.
 *
 * The setting means what it says, but each check is now a GitHub API call made on the server's
 * credential, and a badge does not need to be fresher than a minute: without this, a reload loop in the
 * admin would spend the rate limit on the same tag over and over.
 */
export const adminCheckThrottleMs = 60_000;

/** A release as the browser may see it: a tag, its notes, and where to read them. */
export interface UpdateReleaseInfo {
  version: string;
  /** The published tag, `v2.4.1`, when the source names one. `version` is the same release without the `v`. */
  tag?: string;
  /**
   * The name the release was given on GitHub. Optional because a bare tag has none and a row written by an
   * older build predates the field — a reader that needs a title has to fall back to the tag.
   */
  title?: string;
  released?: string;
  notes?: string[];
  changelog_url?: string;
}

/**
 * The last check, as one row.
 *
 * `latest` is the newest release the source published — not "an update exists" — so the badge compares it
 * against the running build each time instead of trusting a stored verdict. `source` says which of the two
 * sources answered, which is what the Updates screen prints.
 */
export interface UpdateStatus {
  checked_at: string;
  error: string;
  source: 'central' | 'github';
  /** The version the answer was compared against, when the server named one. */
  installed?: string;
  latest: UpdateReleaseInfo | null;
  plugins?: Record<string, UpdateReleaseInfo>;
}

export interface AvailableUpdate {
  id: string;
  name: string;
  kind: 'app' | 'plugin';
  installed: string;
  release: UpdateReleaseInfo;
}

/**
 * Compares dotted versions numerically, so 1.10.0 is newer than 1.9.0. Pre-release tags sort lower.
 *
 * Mirrors `compareVersions` in `server/versions.mjs`, which is the copy the server decides with. This one
 * exists because the badge has to re-rank a stored answer against the build that is running now, and that
 * comparison must not cost a round trip.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string) => {
    const [core, pre = ''] = value.trim().replace(/^v/i, '').split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
};

const readJsonOption = async <T>(name: string): Promise<T | null> => {
  const { data, error } = await client.from('options').select('option_value').eq('option_name', name).maybeSingle();
  if (error) throw new Error(describeDbError(error));
  if (!data?.option_value) return null;
  try {
    return JSON.parse(data.option_value) as T;
  } catch {
    return null;
  }
};

const writeJsonOption = async (name: string, value: unknown) => {
  const { data, error } = await client
    .from('options').upsert({ option_name: name, option_value: JSON.stringify(value) }).select('option_name');
  if (error) throw new Error(describeDbError(error));
  // Row level security rejects an options write by returning no rows rather than an error.
  if (!data?.length) throw new Error('The database saved nothing: only administrators (manage_options) can change update settings.');
};

export const loadUpdateStatus = () => readJsonOption<UpdateStatus>(updateStatusOption);

/**
 * The newest release the last check recorded, for a page nobody has signed in to read.
 *
 * A visitor's browser cannot answer this question on its own: the release usually lives on a **private**
 * repository, and the answer exists here at all only because the *server* asked GitHub with the token
 * Settings → Updates holds (`POST /api/admin/updates/check` → `server/updateCenter.mjs`). So the reader
 * below — `[rwp_latest_release]` in `plugins/rwp-saas-installer`, the plugin that owns this site's
 * release lifecycle — reads back that answer rather than calling `api.github.com` itself, which means it
 * prints exactly the version the Updates screen printed — same tag, same date, same notes — and works for
 * a repository that has no public releases at all.
 *
 * It is no longer the shortcode's *first* source: that card asks the plugin's own route
 * (`GET /api/plugins/rwp-saas-installer/latest-release`) for a live read, because this row is only as
 * fresh as the last check somebody ran. What is left here is the fallback for a site whose route cannot
 * answer, and it holds the only answer a client-side reader could ever have had.
 *
 * The row is readable without signing in (`options` carries the public-read policy this CMS needs for the
 * site title), and it holds nothing a visitor should not see: the release the site is *published* from.
 * `installed` and the plugin map stay in the row untouched and unread here.
 *
 * `null` covers every "nothing to print" case — no CMS configured on this page, no check has run yet, the
 * row is malformed, or the last check answered with no release. The caller decides what a visitor sees.
 */
export const loadPublishedRelease = async (): Promise<{ release: UpdateReleaseInfo; checkedAt: string } | null> => {
  const db = tryGetClient();
  if (!db) return null;
  const { data, error } = await db
    .from('options')
    .select('option_value')
    .eq('option_name', updateStatusOption)
    .maybeSingle();
  if (error || !data?.option_value) return null;
  let status: UpdateStatus;
  try {
    status = JSON.parse(data.option_value) as UpdateStatus;
  } catch {
    return null;
  }
  const release = status?.latest;
  if (!release || !(release.version || release.tag)) return null;
  return { release, checkedAt: status.checked_at || '' };
};

/**
 * Stores a check result for every administrator.
 *
 * Called by the Updates screen and by the scheduled check, so the sidebar badge and the Overview banner
 * read the answer the administrator just saw instead of one from an older page load.
 */
export const saveUpdateStatus = (status: UpdateStatus) => writeJsonOption(updateStatusOption, status);

/**
 * Whether a check is due, from the setting and the timestamp of the last answer.
 *
 * `admin` is throttled rather than literally one call per navigation: see `adminCheckThrottleMs`.
 */
export const isCheckDue = (autoCheck: AutoCheck, checkedAt: string | undefined): boolean => {
  const interval = autoCheckIntervals[autoCheck]?.ms ?? 0;
  if (interval <= 0) return false;
  const last = checkedAt ? Date.parse(checkedAt) : 0;
  if (!Number.isFinite(last) || last <= 0) return true;
  return Date.now() - last >= Math.max(interval, adminCheckThrottleMs);
};

/**
 * What the badge and the banner count: an app release newer than the build that is running, and the same
 * question for each active plugin.
 *
 * Compared against *the running build* every time, so an old row cannot claim an update that has since
 * been installed.
 */
export const availableUpdates = (status: UpdateStatus | null): AvailableUpdate[] => {
  if (!status?.latest) return [];
  const installed = String(status.installed || '').trim().replace(/^v/i, '') || installedAppVersion;
  const updates: AvailableUpdate[] = [];
  if (status.latest.version && compareVersions(status.latest.version, installed) > 0) {
    updates.push({ id: 'react-wp', name: 'React-WP', kind: 'app', installed, release: status.latest });
  }
  rwp.getPlugins().forEach((plugin) => {
    const release = status.plugins?.[plugin.id];
    if (release?.version && compareVersions(release.version, plugin.version) > 0) {
      updates.push({ id: plugin.id, name: plugin.name, kind: 'plugin', installed: plugin.version, release });
    }
  });
  return updates;
};



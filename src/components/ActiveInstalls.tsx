import { useEffect, useState } from 'react';
import { tryGetClient } from '../lib/db';
import { formatNumber } from '../lib/i18n';
import styles from './ActiveInstalls.module.css';

export interface ActiveInstallsProps {
  /**
   * How recently a site must have checked in to count as active. `0` counts every recorded site, which
   * is what "how many have we ever handed out" means.
   */
  days?: number;
  /** Show the sites themselves, not just the number. Off by default: the count is the public fact. */
  list?: boolean;
  /** The heading. Without it, one is written for the section. */
  title?: string;
  /** What to say when nothing is recorded yet. */
  empty?: string;
  /** How many sites the list prints. The count is always the whole total. */
  limit?: number;
}

/** The table `plugins/rwp-saas-installer/schema.sql` creates. */
const TABLE = 'saas_installer_installations';

/**
 * How many rows one render reads. The count is the number of rows that answer, so the ceiling is what
 * keeps a public page from pulling an unbounded table into a browser; a tracker with more sites than
 * this reports the ceiling rather than lying about the total.
 */
const MAX_ROWS = 1000;

interface Installation {
  siteUrl: string;
  version: string;
  plan: string;
  lastSeen: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A site address a visitor can click, or empty when the column does not hold one. */
const siteAddress = (value: unknown): string => {
  const raw = text(value);
  return /^https?:\/\/[^\s/]+$/i.test(raw) ? raw : '';
};

/** The site's name for a link: the host, without the protocol. */
const siteLabel = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

const dateLabel = (value: unknown): string => {
  const time = Date.parse(text(value));
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : '';
};

/**
 * [rwp_active_installs] — how many sites this installer has handed out, and how many are still running.
 *
 * The rows are written by the plugin's server (`POST provision`, and `POST installs/heartbeat` for a
 * site that keeps checking in), never by a browser: the policy on the table lets anyone *read* it and
 * only a settings manager write it. That is why this component only ever selects — a public page has no
 * business writing a claim about another site.
 *
 * Required SQL: `plugins/rwp-saas-installer/schema.sql`, installed from the Plugins screen. Without it
 * the table is missing and the answer is the muted "no installations" line rather than an error, the
 * same way an optional integration degrades.
 */
export default function ActiveInstalls({ days = 30, list = false, title, empty, limit = 20 }: ActiveInstallsProps) {
  const [state, setState] = useState<{ items: Installation[]; loading: boolean; error: string }>({
    items: [],
    loading: true,
    error: '',
  });

  useEffect(() => {
    const client = tryGetClient();
    if (!client) {
      // No CMS configured: the shortcode is silent instead of reporting this site's own misconfiguration
      // to every visitor.
      setState({ items: [], loading: false, error: '' });
      return;
    }

    let mounted = true;
    setState((current) => ({ ...current, loading: true, error: '' }));

    let query = client.from(TABLE).select('site_url,plugin_version,plan,last_seen_at');
    if (days > 0) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      query = query.gte('last_seen_at', since.toISOString());
    }

    query
      .order('last_seen_at', { ascending: false })
      .limit(MAX_ROWS)
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          // A missing table is not an error a visitor should see in red: the plugin is simply not fully
          // installed yet. Anything else is reported, because it is the site's own problem to fix.
          const missing = /does not exist|schema cache|relation|no such table/i.test(error.message);
          setState({ items: [], loading: false, error: missing ? '' : error.message });
          return;
        }
        const rows = Array.isArray(data) ? data : [];
        const items: Installation[] = rows.map((row) => {
          const record = (row ?? {}) as Record<string, unknown>;
          return {
            siteUrl: siteAddress(record.site_url),
            version: text(record.plugin_version),
            plan: text(record.plan),
            lastSeen: dateLabel(record.last_seen_at),
          };
        });
        setState({ items, loading: false, error: '' });
      });

    return () => {
      mounted = false;
    };
  }, [days]);

  const total = state.items.length;
  const heading = title ?? 'Sites running this installer';
  const period = days > 0 ? ` in the last ${days} days` : '';
  const nothing = empty ?? 'No sites are recorded yet.';

  return (
    <section className={styles.wrap} aria-label={heading || 'Active installations'}>
      {heading && <h3 className={styles.heading}>{heading}</h3>}
      {state.loading && <p className={styles.muted}>Loading…</p>}
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      {!state.loading && !state.error && total === 0 && <p className={styles.muted}>{nothing}</p>}
      {!state.loading && !state.error && total > 0 && (
        <>
          <p className={styles.count}>
            <span className={styles.number}>{formatNumber(total)}</span>
            <span className={styles.unit}>
              {total === 1 ? 'installation' : 'installations'}
              {period}
            </span>
          </p>
          {list && (
            <ul className={styles.sites}>
              {state.items.slice(0, Math.max(1, limit)).map((item, index) => (
                <li key={`${item.siteUrl}:${index}`} className={styles.site}>
                  {item.siteUrl ? (
                    <a href={item.siteUrl} target="_blank" rel="noreferrer noopener">{siteLabel(item.siteUrl)}</a>
                  ) : (
                    <span>Unnamed installation</span>
                  )}
                  <span className={styles.meta}>
                    {[item.plan, item.version ? `v${item.version}` : '', item.lastSeen].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

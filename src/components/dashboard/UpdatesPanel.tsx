import type { AdminStatus } from '../../lib/adminStatus';
import UpdatesCard from './UpdatesCard';
import styles from './Dashboard.module.css';

function HowToInstall() {
  return (
    <details className={styles.howTo}>
      <summary>How to install an update by hand</summary>
      <p>
        React-WP runs from a built bundle and a Node server, so an update is installed on the machine or host that runs
        the site — the admin cannot rewrite its own code. Back up first: <strong>Settings → Backup → Export backup</strong>.
      </p>
      <h4>If you installed with git</h4>
      <ol>
        <li>Stop the server, then run <code>git pull</code> in the project folder.</li>
        <li>Run <code>npm install</code> (new packages may have been added).</li>
        <li>If the update changed the database, run <code>supabase/schema.sql</code> again in Supabase → SQL Editor. It is safe to re-run.</li>
        <li>Start again with <code>npm start</code> (it rebuilds before starting).</li>
      </ol>
      <h4>If you installed from a ZIP</h4>
      <ol>
        <li>Download the new ZIP and extract it over the old folder, <strong>keeping</strong> <code>.env.local</code> and the <code>data/</code> folder.</li>
        <li>Run <code>npm install</code>, run <code>supabase/schema.sql</code> in Supabase if the update changed the database, then <code>npm start</code>.</li>
      </ol>
      <h4>On Vercel</h4>
      <ol>
        <li>Pull the update into the repository Vercel deploys from and push; Vercel rebuilds automatically.</li>
        <li>If the update changed the database, run <code>supabase/schema.sql</code> in Supabase again.</li>
      </ol>
    </details>
  );
}

/**
 * Dashboard → Updates.
 *
 * The work lives in two places and this panel only puts them together. `UpdatesCard` talks to the server,
 * which is what decides whether a release exists and how this host can install it; the details below are
 * the same instructions a person would follow with a terminal open, kept because they are the answer when
 * a host can do neither of the automatic things — and because they are what the reader will want on the
 * day the API server is the thing that is broken.
 *
 * `onStatus` hands each check back to the admin status the sidebar badge reads, so the number next to
 * "Updates" is the result of the check that was just run rather than one from an older page load.
 */
export default function UpdatesPanel({ status }: { status: AdminStatus }) {
  return (
    <div className={styles.dashboard}>
      <UpdatesCard onStatus={status.setUpdateStatus} />
      <section className={styles.panel}>
        <HowToInstall />
      </section>
    </div>
  );
}

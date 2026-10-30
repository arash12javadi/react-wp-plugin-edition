import type { AdminStatus } from '../../lib/adminStatus';
import type { UserRole } from '../../lib/roles';
import UpdatesCard from './UpdatesCard';

/**
 * Dashboard → Updates.
 *
 * The work lives in one place: `UpdatesCard` talks to the server, which is what decides whether a release
 * exists and how this host installs it — a deploy hook, a self-update run, or the sentence that names what
 * to configure when it can do neither. The card draws its own `styles.dashboard` column, so this panel is
 * only the wiring: the admin status the sidebar badge reads, `role` for the owner/end-user split, and
 * `navigate` for the links that leave it.
 *
 * There is no by-hand guide printed here any more: a version is published by tagging a release on GitHub, and
 * the three ways to apply one are a deploy hook, the server's own updater, and `git pull`. Repeating the
 * third beside two buttons that do the first two made the screen look like it did not trust its own answer.
 *
 * `onStatus` hands each check back to the admin status the sidebar badge reads, so the number next to
 * "Updates" is the result of the check that was just run rather than one from an older page load.
 */
export default function UpdatesPanel({ role, status, navigate }: {
  role: UserRole;
  status: AdminStatus;
  navigate: (section: string, subsection?: string) => void;
}) {
  return <UpdatesCard role={role} onStatus={status.setUpdateStatus} navigate={navigate} />;
}

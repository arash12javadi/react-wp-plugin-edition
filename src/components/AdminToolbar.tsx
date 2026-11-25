import type { UserRole } from '../lib/roles';
import type { ViewSiteTarget } from '../lib/settings';
import { canAccessAdmin } from '../lib/roles';
import { roleLabels } from '../lib/roles';
import styles from './AdminToolbar.module.css';

interface AdminToolbarProps {
  email?: string;
  role: UserRole;
  view: 'site' | 'admin';
  onViewSite?: () => void;
  onViewAdmin?: () => void;
  onProfile?: () => void;
  onLogout?: () => void;
  /**
   * Where the site links open the public site. Settings → Accounts → "View site opens", so a
   * manager can keep the admin in place while checking the front end. Defaults to the same tab.
   */
  viewSiteTarget?: ViewSiteTarget;
  /** Set on the public site when the viewer may edit the page being displayed. */
  editLink?: string;
  /** Set in the admin while a page or post is being edited. Opens in a new tab, so unsaved edits stay. */
  viewPage?: { href: string; label: string };
}

/**
 * On the public site, whether it shows at all is Settings → Accounts → Admin toolbar
 * (see PublicLayout). /profile and /dashboard show whichever pages Settings chose for them.
 */
export default function AdminToolbar({
  email,
  role,
  view,
  onViewSite,
  onViewAdmin,
  onProfile,
  onLogout,
  editLink,
  viewPage,
  viewSiteTarget = 'same-tab',
}: AdminToolbarProps) {
  // The brand and site links sit outside React Router, so the preference is applied here.
  const siteLinkProps = viewSiteTarget === 'new-tab' ? { target: '_blank', rel: 'noreferrer' } : {};
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="WordPress-style admin toolbar">
      <div className={styles.left}>
        <a className={styles.logo} href="/" aria-label="View site" {...siteLinkProps}>
          R
        </a>
        <a href="/" className={styles.siteLink} {...siteLinkProps}>React-WP</a>
        {view === 'admin' ? (
          <>
            {/* Always a real link, never a button: the browser then offers "Open link in new tab" on
                right-click and honours Ctrl/Cmd-click and middle-click. A same-tab click is a normal
                navigation to the site. With "In a new tab" the browser opens the tab itself, so a
                popup blocker never sees it and the signed-in view of the admin stays where it is. */}
            {onViewSite && <a className={styles.viewSiteLink} href="/" {...siteLinkProps}>View site</a>}
            {viewPage && <a className={styles.editLink} href={viewPage.href} target="_blank" rel="noreferrer">👁 {viewPage.label}</a>}
          </>
        ) : (
          <>
            {onViewAdmin && canAccessAdmin(role) && <button type="button" onClick={onViewAdmin}>Dashboard</button>}
            {!canAccessAdmin(role) && <a className={styles.editLink} href="/dashboard">My account</a>}
            {editLink && <a className={styles.editLink} href={editLink}>✎ Edit page</a>}
          </>
        )}
      </div>
      <div className={styles.right}>
        <span className={styles.user}>{email || 'Administrator'} · {roleLabels[role]}</span>
        {view === 'site'
          ? <a className={styles.editLink} href="/profile">Profile</a>
          : onProfile && <button type="button" onClick={onProfile}>Profile</button>}
        {onLogout && <button type="button" onClick={onLogout}>Log out</button>}
      </div>
    </div>
  );
}

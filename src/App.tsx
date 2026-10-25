import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Client, Session } from './lib/db';
import SetupWizard from './components/SetupWizard';
import AdminLayout from './components/AdminLayout';
import AdminErrorBoundary from './components/AdminErrorBoundary';
import SiteSettings from './components/SiteSettings';
import MenusScreen from './components/MenusScreen';
import CommentsManager from './components/CommentsManager';
import ProfileManager from './components/ProfileManager';
import PluginsManager from './components/PluginsManager';
import PagesList from './components/PagesList';
import PageEditor from './components/PageEditor';
import CategoriesManager from './components/CategoriesManager';
import MediaLibrary from './components/MediaLibrary';
import UsersManager from './components/UsersManager';
import PublicHome from './components/PublicHome';
import PublicContent from './components/PublicContent';
import AuthPage from './components/AuthPage';
import PublicChrome from './components/PublicChrome';
import PublicArchive, { archiveFromPath } from './components/PublicArchive';
import { preloadSiteTemplates } from './components/SiteTemplate';
import { canAccessAdmin, canManageSettings } from './lib/roles';
import { loadCapabilityGrants } from './lib/capabilityGrants';
import { installDefaultContent } from './lib/defaultContent';
import { pageViewLink } from './lib/contentBulk';
import { accountPageByPath, accountTarget, signOutAndRedirect, type AccountPageKey } from './lib/account';
import { startSessionGovernor } from './lib/session';
import { useCurrentProfile } from './lib/profiles';
import { defaultActivePluginIds } from './lib/pluginLicense';
import { describeDbError } from './lib/db';
import { bootDatabase, checkInstallOnServer, clearStoredSession, type BootFailure } from './lib/boot';
import {
  applyDocumentTitle, applySiteIcon, brandingFrom, defaultSettings, loadSettings, placeholderTitle,
  type SiteBranding, type SiteSettings as SiteSettingsValue, type ViewSiteTarget,
} from './lib/settings';
import { defaultAppSettings, injectTrackingScripts, loadAppSettings } from './lib/appSettings';
import { buildAdminNavigation, resolveAdminLocation } from './lib/adminNavigation';
import { initThemePreview, loadTheme } from './lib/theme';
import { applyThemeDocument } from './components/theme/ThemeLayoutRenderer';
import { useAdminStatus } from './lib/adminStatus';
import { rwp } from './lib/rwp';
import { HookSlot } from './core/HookSlot';
import { initI18n } from './lib/i18n';
import { initDatabaseTranslations } from './lib/translations';
import styles from './Dashboard.module.css';

// Its own chunk: the Overview, Updates and Guide are only ever needed inside the admin.
const Dashboard = lazy(() => import('./components/dashboard/Dashboard'));
// Its own chunk too: dnd-kit and the code editor never reach the public bundle.
const ThemeEditor = lazy(() => import('./components/theme/ThemeEditor'));
// The built-in profile and dashboard, for /profile and /dashboard while no page is chosen for them.
const UserProfile = lazy(() => import('./components/auth/UserAccount').then((module) => ({ default: module.UserProfile })));
const UserDashboard = lazy(() => import('./components/auth/UserAccount').then((module) => ({ default: module.UserDashboard })));

// Read at import, before the Supabase client consumes and clears the hash of a reset-password link.
const arrivedFromRecoveryLink = /type=recovery/.test(window.location.hash);

const authModes: Partial<Record<AccountPageKey, 'login' | 'register' | 'lost_password'>> = {
  login: 'login', register: 'register', lost_password: 'lost_password',
};

/** What an account path shows when no page is chosen for it, or the chosen one is gone. */
function BuiltinAccountScreen({ page }: { page: AccountPageKey }) {
  const mode = authModes[page];
  if (mode) return <AuthPage mode={mode} />;
  return (
    <PublicChrome>
      <main style={{ padding: '0 16px' }}>
        <Suspense fallback={<p role="status">Loading…</p>}>{page === 'profile' ? <UserProfile /> : <UserDashboard />}</Suspense>
      </main>
    </PublicChrome>
  );
}

const readPluginIds = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const initializePlugins = async (supabase: Client) => {
  const { data: activeRow } = await supabase
    .from('options').select('option_value').eq('option_name', 'rwp_active_plugins').maybeSingle();
  const registered = rwp.getPlugins();
  // Nothing saved yet: the free plugins run and the four sold ones stay off until somebody activates
  // them from Plugins with a key in place (`defaultActivePluginIds`). Reading a saved option as it is
  // keeps an administrator's choice exact - a site that has switched its shop on is not overruled here.
  const activeIds = activeRow
    ? readPluginIds(activeRow.option_value)
    : defaultActivePluginIds(registered.map((plugin) => plugin.id));
  registered.forEach((plugin) => {
    if (activeIds.includes(plugin.id)) rwp.activatePlugin(plugin.id);
  });
};

/**
 * Boots the database check itself. `App()` used to ask `checkDatabase()`, which answered with a
 * boolean, and every `false` — a paused project, a rejected credential, a blocked request, a 5xx —
 * rendered the Setup Wizard as if the site had never been installed. `bootDatabase()` keeps those
 * apart, retries a failed read, drops a stored session the database is rejecting, and asks the
 * server before it will call a site new. See `src/lib/boot.ts`.
 */

interface PublicRouting {
  settings: SiteSettingsValue;
  homePageId: string;
  postsPageSlug: string;
  /** A posts page designed with the Page Builder shows its own layout instead of the theme's post index. */
  postsPageHasLayout: boolean;
}

const loadPublicRouting = async (supabase: Client): Promise<PublicRouting> => {
  const settings = await loadSettings();
  applySiteIcon(settings.site_icon);
  // Screens that are not page rows (login, register, plugin routes) never set a title, so
  // without this the tab kept index.html's placeholder. Pages and the admin replace it later;
  // a title the server already wrote is left alone.
  if (document.title === placeholderTitle) applyDocumentTitle(settings.site_title);
  let postsPageSlug = '';
  let postsPageHasLayout = false;
  if (settings.home_page_id && settings.posts_page_id) {
    const { data } = await supabase.from('pages').select('*').eq('id', settings.posts_page_id).maybeSingle();
    postsPageSlug = data?.slug || '';
    postsPageHasLayout = Boolean(data && rwp.getContentRenderer(data as import('./lib/types').Page));
  }
  return { settings, homePageId: settings.home_page_id, postsPageSlug, postsPageHasLayout };
};

const emptyRouting: PublicRouting ={ settings: defaultSettings, homePageId: '', postsPageSlug: '', postsPageHasLayout: false };

function SimpleSection({ title, description }: { title: string; description: string }) {
  return (
    <section className={styles.overview} aria-labelledby="section-heading">
      <div className={styles.welcome}>
        <div>
          <h2 id="section-heading">{title}</h2>
          <p>{description}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * The admin location lives in the URL (/admin?section=settings&tab=seo), so a reload or a
 * bookmark returns to the same screen. The public site's "Edit page" link adds &edit=12.
 * Plugin pages are addressable by id too, e.g. /admin?section=rwp-page-builder.
 */
const requestedLocation = () => {
  const params = new URLSearchParams(window.location.search);
  // ?shop= is the old Shop tab parameter.
  return { section: params.get('section') || 'dashboard', subsection: params.get('tab') || params.get('shop') || '' };
};

/** Only shown when Supabase itself failed; the real error is printed, so it is not mistaken for a paused project. */
function ConnectionError({ detail, onReconfigure }: { detail: string; onReconfigure: () => void }) {
  return (
    <div className={styles.loadingScreen} role="alert">
      <div className={styles.loginCard}>
        <h1>Supabase connection failed</h1>
        <p>The admin could not load your session from Supabase. The error was:</p>
        <p><code>{detail}</code></p>
        <p>If the project was deleted, paused or moved, reconfigure it. Otherwise reload the page, or sign in again.</p>
        <button type="button" onClick={() => { window.location.href = '/login?redirect=%2Fadmin'; }}>Sign in again</button>
        <button type="button" onClick={onReconfigure}>Reconfigure Supabase</button>
      </div>
    </div>
  );
}

/**
 * The screen an unreadable database gets instead of the Setup Wizard.
 *
 * The wizard is for a site with no database. Showing it here — which is what one boolean used to do
 * — asks for credentials that already exist, on a site that is merely busy, paused or locked out,
 * and because the wizard never re-checks, the browser stayed there for good. This screen names what
 * failed, offers the three things that can help (retry, drop the browser's stored session, or open
 * the wizard deliberately) and prints the driver's own words, so the failure can be diagnosed from
 * the screen and not only from a console.
 */
function DatabaseUnreachable({ detail, problem, configured, dbType, onRetry, onResetSession, onRunWizard }: {
  detail: string;
  problem: BootFailure['problem'];
  configured: boolean;
  dbType: string;
  onRetry: () => void;
  onResetSession: () => void;
  onRunWizard: () => void;
}) {
  return (
    <div className={styles.loadingScreen} role="alert">
      <div className={styles.loginCard}>
        <h1>This site’s database could not be read</h1>
        {configured ? (
          <p>
            React-WP is set up for its <strong>{dbType}</strong> database, so this is a connection
            problem and not a fresh install: there is nothing to set up again here.
          </p>
        ) : (
          <p>
            The server reports an installed site, but this page carries no database configuration.
            It is a stale copy of the page — purge the host&rsquo;s HTML/CDN cache, or reload with the
            cache disabled.
          </p>
        )}
        <p><code>{detail}</code></p>
        <p>
          {problem === 'auth'
            ? 'The database refused the request as unauthenticated. A sign-in this browser still holds — from a project that was moved, restored or re-keyed — is the usual cause, and one was cleared automatically before this screen was drawn. Clearing the rest and reloading signs this browser out and lets it read as a plain visitor.'
            : 'A paused, deleted or unreachable database looks like this, as does a schema that is still migrating. Fix that on the host, then try again. The Setup Wizard cannot help: this site already has its configuration, and reinstalling over it would replace it.'}
        </p>
        <button type="button" onClick={onRetry}>Try the database again</button>
        <button type="button" className={styles.secondaryButton} onClick={onResetSession}>
          Clear this browser’s session and reload
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onRunWizard}>
          Open the Setup Wizard anyway
        </button>
      </div>
    </div>
  );
}

function InstalledDashboard({ supabase, onReconfigure }: { supabase: Client; onReconfigure: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [requested, setRequested] = useState(requestedLocation);
  const [editingPage, setEditingPage] = useState<import('./lib/types').Page | null>(null);
  const [branding, setBranding] = useState<SiteBranding>(() => brandingFrom(defaultSettings));
  // Settings → Accounts → "View site opens". Loaded together with the branding below.
  const [viewSiteTarget, setViewSiteTarget] = useState<ViewSiteTarget>(defaultSettings.view_site_target);
  const [authLoading, setAuthLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [, refreshRegistry] = useState(0);
  const { role, loading: roleLoading } = useCurrentProfile(session?.user);
  const ready = Boolean(session) && !authLoading && !roleLoading;
  const status = useAdminStatus(role, ready ? session?.user.id : undefined);

  // Plugins can register or remove admin pages at any time (activation, HMR).
  useEffect(() => rwp.subscribe(() => refreshRegistry((value) => value + 1)), []);

  useEffect(() => {
    rwp.actions.do('rwp_admin_loaded');
    let mounted = true;
    supabase.auth.getSession()
      .then(async ({ data, error }) => {
        if (!mounted) return;
        if (error) {
          // A stored session Supabase no longer accepts (expired or revoked refresh token) is not
          // a connection problem: clear it locally and send the person to sign in again.
          if (/refresh token|jwt|session/i.test(error.message)) {
            await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
            if (mounted) {
              setSession(null);
              setAuthLoading(false);
            }
            return;
          }
          setConnectionError(`${error.name}: ${error.message}`);
        }
        setSession(data.session);
        setAuthLoading(false);
      })
      .catch((error: unknown) => {
        if (mounted) {
          setConnectionError(describeDbError(error));
          setAuthLoading(false);
        }
      });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (mounted) setSession(nextSession);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (!editId || !session) return;
    let mounted = true;
    void supabase.from('pages').select('*').eq('id', editId).maybeSingle().then(({ data }) => {
      if (mounted && data) setEditingPage(data as import('./lib/types').Page);
      // Clear the query string so a later reload does not reopen the editor.
      window.history.replaceState({}, '', '/admin');
    });
    return () => { mounted = false; };
  }, [session, supabase]);

  useEffect(() => {
    // The database was already reached before the admin rendered, so a failure here only costs
    // the site title and logo in the sidebar; it must not lock the whole admin behind an error.
    loadSettings()
      .then((settings) => {
        setBranding(brandingFrom(settings));
        setViewSiteTarget(settings.view_site_target);
      })
      .catch((error: unknown) => console.warn(`Site settings could not be loaded for the admin sidebar: ${describeDbError(error)}`));
  }, [supabase]);

  const navigation = ready ? buildAdminNavigation(role) : [];
  const { section, subsection } = resolveAdminLocation(navigation, requested.section, requested.subsection);
  const activeItem = navigation.find((item) => item.id === section);
  const activeSubLabel = activeItem?.submenu?.find((sub) => sub.id === subsection)?.label;
  const screenTitle = editingPage ? `Edit “${editingPage.title}”` : activeSubLabel && activeItem ? `${activeSubLabel} ‹ ${activeItem.label}` : activeItem?.label;

  useEffect(() => {
    if (!ready) return;
    applyDocumentTitle(branding.site_title, screenTitle);
  }, [branding.site_title, ready, screenTitle]);

  // Once the signed-in role is known; plugins use it for one-time setup such as default pages.
  useEffect(() => {
    if (!ready || !canAccessAdmin(role)) return;
    // Home (the front page), Sample Post, the account pages…, once per site (src/lib/defaultContent.ts).
    if (canManageSettings(role)) void installDefaultContent();
    rwp.actions.do('rwp_admin_ready', role);
  }, [ready, role]);

  if (connectionError) {
    return <ConnectionError detail={connectionError} onReconfigure={onReconfigure} />;
  }

  if (authLoading || roleLoading) {
    return <div className={styles.loadingScreen} role="status">Loading dashboard…</div>;
  }

  if (!session) {
    window.location.href = '/login?redirect=%2Fadmin';
    return <div className={styles.loadingScreen} role="status">Redirecting to sign in…</div>;
  }

  if (!canAccessAdmin(role)) {
    return <PublicHome onReconfigure={onReconfigure} />;
  }

  const navigate = (nextSection: string, nextSubsection?: string) => {
    setRequested({ section: nextSection, subsection: nextSubsection || '' });
    setEditingPage(null);
    const resolved = resolveAdminLocation(navigation, nextSection, nextSubsection);
    const query = new URLSearchParams({ section: resolved.section });
    if (resolved.subsection) query.set('tab', resolved.subsection);
    window.history.replaceState({}, '', `/admin?${query.toString()}`);
    window.scrollTo(0, 0);
  };

  // Settings → Accounts decides where this goes; staying put means the sign-in screen for /admin.
  const logout = () => signOutAndRedirect();

  let content;
  const pluginPage = rwp.getAdminPages().find((page) => page.id === section);
  if (pluginPage) {
    // Visible in the navigation means the capability check has already passed.
    const PluginPage = pluginPage.component;
    content = <PluginPage subsection={subsection} navigate={navigate} />;
  } else if (section === 'dashboard') {
    content = (
      <Suspense fallback={<div className={styles.loadingScreenInline} role="status">Loading…</div>}>
        <Dashboard subsection={subsection} navigate={navigate} role={role} status={status} siteTitle={branding.site_title} />
      </Suspense>
    );
  } else if (section === 'content') {
    const backToList = () => navigate('content', 'all');
    content = editingPage ? (
      <PageEditor role={role} page={editingPage} onSaved={() => setEditingPage(null)} onCancel={() => setEditingPage(null)} />
    ) : subsection === 'new-post' || subsection === 'new-page' ? (
      // Keyed so switching between Add post and Add page starts a fresh editor.
      <PageEditor key={subsection} role={role} initialIsPost={subsection === 'new-post'} onSaved={backToList} onCancel={backToList} />
    ) : subsection === 'categories' ? (
      <CategoriesManager />
    ) : (
      <PagesList role={role} onCreate={(isPost) => navigate('content', isPost ? 'new-post' : 'new-page')} onEdit={setEditingPage} />
    );
  } else if (section === 'media') {
    content = <MediaLibrary />;
  } else if (section === 'users') {
    content = <UsersManager role={role} />;
  } else if (section === 'menus') {
    content = <MenusScreen tab={subsection} />;
  } else if (section === 'settings') {
    content = <SiteSettings tab={subsection} onBrandingChange={setBranding} />;
  } else if (section === 'appearance') {
    content = (
      <Suspense fallback={<div className={styles.loadingScreenInline} role="status">Loading…</div>}>
        <ThemeEditor />
      </Suspense>
    );
  } else if (section === 'plugins') {
    content = <PluginsManager />;
  } else if (section === 'comments') {
    content = <CommentsManager />;
  } else if (section === 'profile') {
    content = <ProfileManager role={role} />;
  } else {
    content = <SimpleSection title="Not available" description="Your role does not have access to this section." />;
  }

  return (
    <AdminLayout
      navigation={navigation}
      activeSection={section}
      activeSubsection={editingPage ? '' : subsection}
      onNavigate={navigate}
      onLogout={() => void logout()}
      userEmail={session.user.email ?? undefined}
      branding={branding}
      role={role}
      dashboardBadge={status.badge}
      onViewSite={() => { window.location.href = '/'; }}
      viewPage={editingPage ? pageViewLink(editingPage) : undefined}
      viewSiteTarget={viewSiteTarget}
    >
      {/* Plugins add banners, notices or extra tools around any admin screen. */}
      <HookSlot name="admin_before_content" args={{ section, subsection, role }} />
      {/* Keyed so switching sections gives a fresh boundary — see AdminErrorBoundary's own note on
          why a children-reference check would not do this safely. */}
      <AdminErrorBoundary key={`${section}:${subsection}`}>{content}</AdminErrorBoundary>
      <HookSlot name="admin_after_content" args={{ section, subsection, role }} />
    </AdminLayout>
  );
}

export default function App() {
  const [supabase, setSupabase] = useState<Client | null>(null);
  const [routing, setRouting] = useState<PublicRouting>(emptyRouting);
  const [checkingDatabase, setCheckingDatabase] = useState(true);
  /** Set when the site is configured but its database cannot be read — never the wizard (see boot.ts). */
  const [bootFailure, setBootFailure] = useState<{ failure: BootFailure; configured: boolean; dbType: string } | null>(null);
  /** True only when the recovery screen's "open the wizard anyway" was used. */
  const [wizardRequested, setWizardRequested] = useState(false);
  /** Bumped by the recovery screen's "try again", which re-runs the boot below. */
  const [bootAttempt, setBootAttempt] = useState(0);
  const booted = useRef(false);
  const isAdminRoute = window.location.pathname.replace(/\/+$/, '') === '/admin';

  const reconfigure = () => {
    localStorage.removeItem('supabase_url');
    localStorage.removeItem('supabase_key');
    window.location.reload();
  };

  /**
   * The answer the wizard's "already installed?" note shows: the server's, never a guess.
   *
   * A browser can be sitting on the wizard while the site is installed, because the read that
   * decides it failed rather than the database being empty. When the server confirms an install, the
   * one piece of local state that can make *every* read fail — a stored session the backend no
   * longer accepts (rotated keys, a moved or restored project) — is dropped and the page reloads
   * without it. That is the step a hard refresh cannot take.
   */
  const recheckInstalled = async (): Promise<boolean> => {
    if (await checkInstallOnServer() !== true) return false;
    const cleared = clearStoredSession();
    console.warn(cleared.length
      ? `React-WP: the server reports an installed site; cleared ${cleared.join(', ')} and reloading.`
      : 'React-WP: the server reports an installed site; reloading with no stored session to clear.');
    window.location.reload();
    return true;
  };

  /** The recovery screen's second action: drop every session credential this browser holds. */
  const resetStoredSession = () => {
    const cleared = clearStoredSession();
    console.warn(cleared.length
      ? `React-WP: cleared this browser's stored session (${cleared.join(', ')}).`
      : 'React-WP: this browser held no stored session to clear.');
    window.location.reload();
  };

  /**
   * The administrator's session policy (Settings → Security). Only a cookie that exists and has
   * run out signs anyone out: a missing cookie means this host has no server.mjs, or the person
   * signed in before the feature existed, and neither is a reason to end a valid session.
   */
  useEffect(() => startSessionGovernor(() => {
    void signOutAndRedirect();
  }), []);

  useEffect(() => {
    // Once only: `rwp_init` fires for every plugin that subscribes to it, and a retry must not
    // register those twice.
    if (!booted.current) {
      booted.current = true;
      rwp.actions.do('rwp_init');
    }
    let mounted = true;
    setCheckingDatabase(true);
    setBootFailure(null);
    void bootDatabase().then(async (result) => {
      if (!mounted) return;
      const client = result.client;
      if (!client) {
        // An empty database and an unreadable one are different answers now. Only a *fresh* one may
        // reach the wizard; anything else is reported with its reason, and logged so a browser that
        // is stuck on the wrong screen can be diagnosed from its console.
        console.warn(`React-WP: database check failed — ${result.failure?.message ?? 'no database client'}`);
        if (!result.freshInstall) {
          setBootFailure({
            failure: result.failure ?? { problem: 'connection', message: 'The database could not be read.' },
            configured: result.configured,
            dbType: result.dbType,
          });
        }
        setCheckingDatabase(false);
        return;
      }
      if (result.clearedSession.length) {
        console.warn(`React-WP: recovered by clearing this browser's stored session (${result.clearedSession.join(', ')}).`);
      }
      try {
        await initializePlugins(client);
        const appSettings = await loadAppSettings().catch(() => defaultAppSettings);
        await Promise.all([
          // Also before the first render. The locale decides dir="rtl" on <html> and the body
          // font, so resolving it later would paint an RTL site left-to-right first. Plugins are
          // already initialised above, so their dictionaries and i18n filters are in place.
          // Then the Settings → Translations strings for that locale, for the same reason: text
          // must not change from the bundled wording to the edited one after the first paint.
          initI18n(isAdminRoute ? 'admin' : 'public').catch(() => undefined)
            .then(() => initDatabaseTranslations()).catch(() => undefined),
          // Before anything renders too: capability checks depend on the grants added under
          // Settings → Roles, for the role and for the signed-in person.
          loadCapabilityGrants().catch(() => undefined),
        ]);
        const path = window.location.pathname;
        // A reset-password link whose address is missing from Supabase's Redirect URLs lands on
        // the Site URL instead; the session it carries still belongs on the new-password screen.
        if (arrivedFromRecoveryLink && path !== '/lost-password') {
          // The client has stored the session by now (getSession above waited for it), so the
          // new-password form finds it. No early return: that would flash the Setup Wizard.
          window.location.replace('/lost-password');
        }
        client.auth.onAuthStateChange((event) => {
          if (event === 'PASSWORD_RECOVERY' && window.location.pathname !== '/lost-password') window.location.href = '/lost-password';
        });
        if (!isAdminRoute && !path.startsWith('/builder/')) {
          injectTrackingScripts(appSettings.seo);
          // Loaded before the first render so the saved layout does not flash in after the default one.
          initThemePreview();
          applyThemeDocument(await loadTheme());
          // Before the first render too, so a designed header or 404 never flashes in after the default.
          await preloadSiteTemplates();
        }
        const publicRouting = await loadPublicRouting(client).catch(() => emptyRouting);
        if (mounted) {
          setRouting(publicRouting);
          setSupabase(client);
        }
      } finally {
        if (mounted) setCheckingDatabase(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [bootAttempt]);

  if (checkingDatabase) {
    return <div className={styles.loadingScreen} role="status">Checking database connection…</div>;
  }

  if (!supabase) {
    // An unreadable database is not an empty one: the wizard is only for a site that has none.
    // Opening it over a configured site is a decision the recovery screen asks for, not something a
    // failed read may do on its own.
    if (bootFailure && !wizardRequested) {
      return (
        <DatabaseUnreachable
          detail={bootFailure.failure.message}
          problem={bootFailure.failure.problem}
          configured={bootFailure.configured}
          dbType={bootFailure.dbType}
          onRetry={() => setBootAttempt((attempt) => attempt + 1)}
          onResetSession={resetStoredSession}
          onRunWizard={() => setWizardRequested(true)}
        />
      );
    }
    // The wizard resets the cached adapters, clears its scratch keys and hard-navigates to / itself.
    return <SetupWizard onAlreadyInstalled={recheckInstalled} />;
  }

  if (isAdminRoute) {
    return <InstalledDashboard supabase={supabase} onReconfigure={reconfigure} />;
  }

  const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '');

  // /login, /register, /lost-password, /profile and /dashboard show what Settings chose for them,
  // so every link on the site keeps working whichever page (or plugin screen) that is.
  const accountPage = accountPageByPath(pathname);
  if (accountPage) {
    const target = accountTarget(routing.settings, accountPage.key);
    if (target.kind === 'url') {
      // Keeps ?redirect= so the other screen can still send people back.
      const query = window.location.search;
      window.location.replace(query && !target.url.includes('?') ? `${target.url}${query}` : target.url);
      return <div className={styles.loadingScreen} role="status">Redirecting…</div>;
    }
    const builtin = <BuiltinAccountScreen page={accountPage.key} />;
    return target.kind === 'page'
      ? <PublicContent pageId={target.pageId} onReconfigure={reconfigure} fallback={builtin} />
      : builtin;
  }

  // Plugin routes are checked before page slugs, so a plugin owns its paths outright.
  const pluginRoute = pathname ? rwp.matchRoute(`/${pathname}`) : null;
  if (pluginRoute) {
    const RouteComponent = pluginRoute.route.component;
    const rendered = <RouteComponent params={pluginRoute.params} />;
    return pluginRoute.route.chrome === false ? rendered : <PublicChrome>{rendered}</PublicChrome>;
  }

  // Search forms send ?s= to the home page. When the home page is a page (not the post feed, which
  // filters itself), show the search results screen instead.
  const homeSearch = new URLSearchParams(window.location.search).get('s');
  if (!pathname && routing.homePageId && homeSearch !== null) {
    return <PublicArchive archive={{ kind: 'search', term: homeSearch }} />;
  }

  if (!pathname) {
    return routing.homePageId
      ? <PublicContent pageId={routing.homePageId} onReconfigure={reconfigure} />
      : <PublicHome onReconfigure={reconfigure} />;
  }

  // Search results and post archives (Page Builder → Templates designs them).
  const archive = archiveFromPath(`/${pathname}`, window.location.search);
  if (archive) return <PublicArchive archive={archive} />;

  const slug = pathname.replace(/^posts\//, '').replace(/^pages\//, '');
  if (routing.postsPageSlug && slug === routing.postsPageSlug && !routing.postsPageHasLayout) {
    return <PublicHome onReconfigure={reconfigure} />;
  }
  return <PublicContent slug={slug} onReconfigure={reconfigure} />;
}

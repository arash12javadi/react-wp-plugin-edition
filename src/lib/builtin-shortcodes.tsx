import { lazy, Suspense, type ReactNode } from 'react';
import ActiveInstalls from '../components/ActiveInstalls';
import LoginButton from '../components/LoginButton';
import AuthForm from '../components/auth/AuthForm';
import { registerEngagementShortcodes } from '../components/engagement/shortcodes';
import { rwp } from './rwp';

// Their own chunk: the profile form pulls in the media library, which most pages never need.
// AuthForm is not split off: /login already needs it in the main bundle.
const UserProfile = lazy(() => import('../components/auth/UserAccount').then((module) => ({ default: module.UserProfile })));
const UserDashboard = lazy(() => import('../components/auth/UserAccount').then((module) => ({ default: module.UserDashboard })));

const loading = (node: ReactNode) => <Suspense fallback={<p>Loading…</p>}>{node}</Suspense>;

/** "no", "false", "0" and "off" switch an attribute off; anything else (or nothing) leaves it on. */
const flag = (value: string | undefined) => !/^(no|false|0|off)$/i.test(value || '');

/** The opposite default: "yes", "true", "1" and "on" switch it on, and nothing leaves it off. */
const enabled = (value: string | undefined) => /^(yes|true|1|on)$/i.test(value || '');

/** A whole-number attribute, or undefined when it is missing or not a number, so the component default applies. */
const integer = (value: string | undefined): number | undefined => {
  const raw = (value ?? '').trim();
  const parsed = Number(raw);
  return raw !== '' && Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

const formAttributes = [
  { name: 'title', description: 'The heading. Leave it out for the default.' },
  { name: 'subtitle', description: 'The line under the heading.' },
  { name: 'button', description: 'The submit button text.' },
  { name: 'redirect', description: 'A path on this site to go to afterwards, e.g. /dashboard. A ?redirect= in the link still wins.' },
  { name: 'links', description: 'no hides the "Create one" / "Sign in" / "Forgot password?" links.' },
];

/** Registered once at startup so these work in any page or post. */
export const registerBuiltinShortcodes = () => {
  rwp.shortcodes.register({
    name: 'rwp_login',
    description: 'A sign-in button for visitors, or sign-out for someone already signed in.',
    example: '[rwp_login label="Sign in" style="link"]',
    attributes: [
      { name: 'label', description: 'Button text, used in both states. Without it: "Log in", or "Log out" when signed in.' },
      { name: 'style', description: 'button (default) or link.' },
    ],
    render: (attributes) => (
      <LoginButton
        label={attributes.label}
        variant={attributes.style === 'link' ? 'link' : 'button'}
      />
    ),
  });

  rwp.shortcodes.register({
    name: 'rwp_login_form',
    description: 'The sign-in form, with social buttons when they are enabled. Signed-in visitors see a Continue button.',
    example: '[rwp_login_form title="Welcome back" redirect="/dashboard"]',
    attributes: [...formAttributes, { name: 'social', description: 'no hides the Google and Facebook buttons.' }],
    render: (attributes) => loading(
      <AuthForm mode="login" title={attributes.title} subtitle={attributes.subtitle} buttonLabel={attributes.button}
        redirect={attributes.redirect} showLinks={flag(attributes.links)} showSocial={flag(attributes.social)} />,
    ),
  });

  rwp.shortcodes.register({
    name: 'rwp_register_form',
    description: 'The registration form. Shows "Registration is closed" while Settings → Accounts does not let anyone register.',
    example: '[rwp_register_form title="Join us"]',
    attributes: [...formAttributes, { name: 'social', description: 'no hides the Google and Facebook buttons.' }],
    render: (attributes) => loading(
      <AuthForm mode="register" title={attributes.title} subtitle={attributes.subtitle} buttonLabel={attributes.button}
        redirect={attributes.redirect} showLinks={flag(attributes.links)} showSocial={flag(attributes.social)} />,
    ),
  });

  rwp.shortcodes.register({
    name: 'rwp_lost_password_form',
    description: 'Sends a password reset email. The link in it opens /lost-password, where this form asks for the new password.',
    example: '[rwp_lost_password_form]',
    attributes: formAttributes.filter((attribute) => attribute.name !== 'redirect'),
    render: (attributes) => loading(
      <AuthForm mode="lost_password" title={attributes.title} subtitle={attributes.subtitle} buttonLabel={attributes.button}
        showLinks={flag(attributes.links)} />,
    ),
  });

  rwp.shortcodes.register({
    name: 'rwp_user_profile',
    description: "The signed-in person's profile form: name, avatar, bio, email, password and optional details.",
    example: '[rwp_user_profile]',
    attributes: [],
    render: () => loading(<UserProfile />),
  });

  rwp.shortcodes.register({
    name: 'rwp_user_dashboard',
    description: 'A dashboard for signed-in visitors: profile, admin (for roles that have it), plugin cards and log out.',
    example: '[rwp_user_dashboard title="My account"]',
    attributes: [{ name: 'title', description: 'The heading. Without it: "Hello, <name>".' }],
    render: (attributes) => loading(<UserDashboard title={attributes.title} />),
  });

  // [rwp_active_installs]: how many sites the RWP SaaS Installer handed out, read from the tracker
  // table that plugin's schema.sql creates. Registered here rather than by the plugin because the
  // public site renders it, and a plugin that is deactivated must not take the page down with it — the
  // component degrades to its empty line when the table is missing.
  rwp.shortcodes.register({
    name: 'rwp_active_installs',
    description: 'How many sites the RWP SaaS Installer has handed out, counted from its installations table. Needs that plugin active and its schema installed.',
    example: '[rwp_active_installs days="30" list="yes"]',
    attributes: [
      { name: 'days', description: 'How recently a site must have checked in to count. 30 by default; 0 counts every site ever recorded.' },
      { name: 'list', description: 'yes lists the sites and not just the number. Off by default: the count is the public fact.' },
      { name: 'limit', description: 'How many sites the list prints. 20 by default.' },
      { name: 'title', description: 'The heading. Leave it out for the default.' },
      { name: 'empty', description: 'What to say when nothing is recorded yet.' },
    ],
    render: (attributes) => (
      <ActiveInstalls
        days={integer(attributes.days)}
        list={enabled(attributes.list)}
        limit={integer(attributes.limit)}
        title={attributes.title}
        empty={attributes.empty}
      />
    ),
  });

  // [rwp_like], [rwp_save], [rwp_follow], [rwp_views], [rwp_engagement], [rwp_popular_content],
  // [rwp_saved_collections], [rwp_following_feed].
  registerEngagementShortcodes();
};

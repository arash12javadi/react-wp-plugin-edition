/**
 * Who the platform owner is, by verified email.
 *
 * `RWP_OWNER_EMAIL` names the one account (the super admin of react-wp.com) allowed to use the
 * development-edition tools: the installer's management routes and the AI Factory. It lives in the
 * environment, never in `options` (world-readable) and never in a `VITE_` variable (compiled into the
 * public bundle).
 *
 * Unset means "not configured": callers fall back to the role check alone, so a fresh clone still
 * works. A deployment that must be locked down (react-wp.com) has to set it.
 */

const clean = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/** The configured owner address, lower-cased, or '' when none is set. */
export const configuredOwnerEmail = (env = process.env || {}) => clean(env.RWP_OWNER_EMAIL);

/**
 * Whether a Supabase Auth user object (the answer of `/auth/v1/user`) is the owner.
 * The address must match AND be confirmed: an unconfirmed sign-up can claim any address.
 */
export function isOwnerUser(user, env = process.env || {}) {
  const owner = configuredOwnerEmail(env);
  if (!owner) return false;
  const email = clean(user?.email);
  const confirmed = Boolean(user?.email_confirmed_at || user?.confirmed_at);
  return Boolean(email) && confirmed && email === owner;
}

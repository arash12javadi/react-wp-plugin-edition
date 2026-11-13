/**
 * WordPress's sign-in lifecycle hooks, fired from the places that actually sign people in and out.
 *
 *   rwp_login(user_login, user)        WordPress's wp_login: after a successful password or OAuth sign-in
 *   rwp_logout(user_id)                WordPress's wp_logout: after the session was ended
 *   rwp_user_register(user_id, data)   WordPress's user_register: after a new account was created
 *
 * React-WP's own `rwp_user_logged_in` / `rwp_user_logged_out` keep firing from the same places with
 * their original payload. Hooks run in the browser that signed in: they shape the UI, they do not
 * grant access (Supabase Auth and row level security do that on the server).
 */
import { doAction } from '../../core/hooks';

interface AuthUser {
  id: string;
  email?: string | null;
  [key: string]: unknown;
}

/** The "login name" WordPress passes: the email, which is what React-WP people sign in with. */
const loginOf = (user: AuthUser): string => user.email || user.id;

export function fireUserLogin(user: AuthUser): void {
  doAction('rwp_login', loginOf(user), user);
}

export function fireUserLogout(userId: string | null | undefined): void {
  doAction('rwp_logout', userId ?? 0);
}

export function fireUserRegister(user: AuthUser): void {
  doAction('rwp_user_register', user.id, { user_email: user.email ?? '', ID: user.id });
}

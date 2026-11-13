/**
 * WordPress's request lifecycle, mapped onto the life of a React single-page app.
 *
 * WordPress runs these once per HTTP request, top to bottom. React-WP boots once per page load and
 * then navigates without reloading, so each hook is fired at the matching moment of that life:
 *
 *   boot (once)         rwp_plugins_loaded -> rwp_after_setup_theme -> rwp_init -> rwp_loaded
 *   admin (per load)    rwp_admin_init -> rwp_admin_menu -> rwp_admin_enqueue_scripts
 *   public (per view)   rwp_template_redirect -> rwp_enqueue_scripts -> rwp_head -> rwp_body_open
 *                       ... the page renders ... -> rwp_footer
 *   leaving the page    rwp_shutdown (on pagehide)
 *
 * `rwp_plugins_loaded` and the rest of the boot group fire after the active plugins have registered,
 * which is when a plugin's own hooks exist. `rwp_template_redirect` may call `rwp_redirect()`.
 */
import { doAction } from '../../core/hooks';

/** plugins_loaded, after_setup_theme, init. Called once per page load, after plugins registered. */
export function fireBootHooks(): void {
  doAction('rwp_plugins_loaded');
  doAction('rwp_after_setup_theme');
  doAction('rwp_init');
  // WordPress fires widgets_init from inside init, once the default widgets are registered.
  doAction('rwp_widgets_init');
}

/** wp_loaded: boot finished, the first render is next. */
export function fireLoadedHook(): void {
  doAction('rwp_loaded');
}

/** admin_init, admin_menu and admin_enqueue_scripts, when the admin app mounts. */
export function fireAdminHooks(): void {
  doAction('rwp_admin_init');
  doAction('rwp_admin_menu');
  doAction('rwp_admin_enqueue_scripts', 'dashboard');
}

/** Before a public view renders: template_redirect, enqueue_scripts, wp_head, wp_body_open. */
export function firePublicViewStart(): void {
  doAction('rwp_template_redirect');
  doAction('rwp_enqueue_scripts');
  doAction('rwp_head');
  doAction('rwp_body_open');
}

/** After a public view rendered: wp_footer. */
export function firePublicViewEnd(): void {
  doAction('rwp_footer');
}

let shutdownRegistered = false;

/** shutdown: the last thing before the page is left. Registered once. */
export function registerShutdownHook(): void {
  if (shutdownRegistered || typeof window === 'undefined') return;
  shutdownRegistered = true;
  window.addEventListener('pagehide', () => doAction('rwp_shutdown'));
}

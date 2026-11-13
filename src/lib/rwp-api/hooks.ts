/**
 * WordPress's plugin API (wp-includes/plugin.php), under the same names with the rwp_ prefix.
 *
 *   add_action( 'init', 'my_fn', 10, 2 );    ->    rwp_add_action('rwp_init', myFn, 10, 2);
 *   apply_filters( 'the_title', $title );    ->    rwp_apply_filters('rwp_the_title', title);
 *
 * Every function is a thin wrapper over src/core/hooks.ts, the one registry, so a plugin that uses
 * these names, the camelCase `addAction` family or `rwp.actions` sees exactly the same hooks.
 *
 * Three honest differences from PHP:
 *   - A callback is a function, not a string name. There is no callable-array form.
 *   - `rwp_add_action` and `rwp_add_filter` return the function that removes the callback again
 *     (WordPress returns `true`). Return it from `register()` so deactivating the plugin cleans up.
 *   - `$accepted_args` defaults to "all arguments" rather than 1.
 */
import {
  ALL_ARGS,
  DEFAULT_PRIORITY,
  addAction,
  addFilter,
  applyFilters,
  applyFiltersDeprecated,
  applyFiltersRefArray,
  currentAction,
  currentFilter,
  deprecatedFunction,
  didAction,
  didFilter,
  doAction,
  doActionDeprecated,
  doActionRefArray,
  doingAction,
  doingFilter,
  doingItWrong,
  hasAction,
  hasFilter,
  removeAction,
  removeAllActions,
  removeAllFilters,
  removeFilter,
  type ActionCallback,
  type FilterCallback,
} from '../../core/hooks';

/** Adds a callback to an action hook. Returns a function that removes it. */
export function rwp_add_action(hook_name: string, callback: ActionCallback, priority: number = DEFAULT_PRIORITY, accepted_args: number = ALL_ARGS): () => void {
  return addAction(hook_name, callback, priority, accepted_args);
}

/** Adds a callback to a filter hook. Returns a function that removes it. */
export function rwp_add_filter<T = unknown>(hook_name: string, callback: FilterCallback<T>, priority: number = DEFAULT_PRIORITY, accepted_args: number = ALL_ARGS): () => void {
  return addFilter<T>(hook_name, callback, priority, accepted_args);
}

/** Removes a callback from an action. Pass the priority to remove only that registration. */
export function rwp_remove_action(hook_name: string, callback: ActionCallback, priority?: number): boolean {
  return removeAction(hook_name, callback, priority);
}

/** Removes a callback from a filter. Pass the priority to remove only that registration. */
export function rwp_remove_filter<T = unknown>(hook_name: string, callback: FilterCallback<T>, priority?: number): boolean {
  return removeFilter<T>(hook_name, callback, priority);
}

/** Removes every callback on an action, or only those at one priority. */
export function rwp_remove_all_actions(hook_name: string, priority?: number): boolean {
  return removeAllActions(hook_name, priority);
}

/** Removes every callback on a filter, or only those at one priority. */
export function rwp_remove_all_filters(hook_name: string, priority?: number): boolean {
  return removeAllFilters(hook_name, priority);
}

/** Fires an action. */
export function rwp_do_action(hook_name: string, ...args: unknown[]): void {
  doAction(hook_name, ...args);
}

/** Runs a value through a filter and returns the result. */
export function rwp_apply_filters<T = unknown>(hook_name: string, value: T, ...args: unknown[]): T {
  return applyFilters<T>(hook_name, value, ...args);
}

/** Fires an action with its arguments in an array. Objects in the array are shared, so they can be mutated. */
export function rwp_do_action_ref_array(hook_name: string, args: unknown[]): void {
  doActionRefArray(hook_name, args);
}

/** Applies a filter with its arguments in an array; `args[0]` is the value. */
export function rwp_apply_filters_ref_array<T = unknown>(hook_name: string, args: unknown[]): T {
  return applyFiltersRefArray<T>(hook_name, args);
}

/** Fires an action that is being retired and logs once if a callback is still attached. */
export function rwp_do_action_deprecated(hook_name: string, args: unknown[], version: string, replacement = '', message = ''): void {
  doActionDeprecated(hook_name, args, version, replacement, message);
}

/** Applies a filter that is being retired and logs once if a callback is still attached. */
export function rwp_apply_filters_deprecated<T = unknown>(hook_name: string, args: unknown[], version: string, replacement = '', message = ''): T {
  return applyFiltersDeprecated<T>(hook_name, args, version, replacement, message);
}

/** Whether an action has callbacks; with a callback, its priority or false. */
export function rwp_has_action(hook_name: string): boolean;
export function rwp_has_action(hook_name: string, callback: ActionCallback): number | false;
export function rwp_has_action(hook_name: string, callback?: ActionCallback): boolean | number {
  return callback ? hasAction(hook_name, callback) : hasAction(hook_name);
}

/** Whether a filter has callbacks; with a callback, its priority or false. */
export function rwp_has_filter(hook_name: string): boolean;
export function rwp_has_filter(hook_name: string, callback: FilterCallback): number | false;
export function rwp_has_filter(hook_name: string, callback?: FilterCallback): boolean | number {
  return callback ? hasFilter(hook_name, callback) : hasFilter(hook_name);
}

/** How many times an action has fired. */
export function rwp_did_action(hook_name: string): number {
  return didAction(hook_name);
}

/** How many times a filter has been applied. */
export function rwp_did_filter(hook_name: string): number {
  return didFilter(hook_name);
}

/** Whether an action is running now. */
export function rwp_doing_action(hook_name?: string): boolean {
  return doingAction(hook_name);
}

/** Whether a filter (or, as in WordPress, any hook) is running now. */
export function rwp_doing_filter(hook_name?: string): boolean {
  return doingFilter(hook_name);
}

/** The innermost hook running now, or false. */
export function rwp_current_action(): string | false {
  return currentAction();
}

/** The innermost hook running now, or false. */
export function rwp_current_filter(): string | false {
  return currentFilter();
}

/** A developer-facing note about misuse of an API. Logged once. */
export function _rwp_doing_it_wrong(function_name: string, message: string, version = ''): void {
  doingItWrong(function_name, message, version);
}

/** Marks a function as deprecated. Logged once. */
export function _rwp_deprecated_function(function_name: string, version: string, replacement = ''): void {
  deprecatedFunction(function_name, version, replacement);
}

/**
 * The site-wide hook registry: WordPress's actions and filters, with priorities.
 *
 * This is the one registry. `rwp.actions` / `rwp.filters` in src/lib/rwp.tsx and the snake_case
 * `rwp_add_action()` / `rwp_apply_filters()` family in src/lib/rwp-api/hooks.ts are thin wrappers
 * around these functions, so a plugin written against any of the three sees the same callbacks.
 * Adding a second registry here would silently split them, and a filter added through one would
 * never run for the other.
 *
 * Actions are side effects and return nothing. Filters transform a value and MUST return it —
 * a filter that returns undefined is treated as a bug and its result is discarded, because the
 * alternative (writing undefined into the site title, a menu or a layout) is far harder to trace.
 *
 * Differences from WordPress, on purpose:
 *   - `acceptedArgs` defaults to "all arguments", not 1. A callback written for WordPress that
 *     names `$accepted_args` gets exactly that many; one that does not simply receives them all,
 *     which is harmless in JavaScript.
 *   - There is no pass-by-reference. `*_ref_array` hooks pass the same object, so mutating it works;
 *     reassigning a primitive does not. A filter's return value is the supported way to change one.
 *   - Hook names that were renamed are kept working through aliases (`registerHookAlias`).
 */

/** WordPress's default, kept so "priority 10" means the same thing here. */
export const DEFAULT_PRIORITY = 10;

/** `acceptedArgs` meaning "pass everything the hook was fired with". */
export const ALL_ARGS = Number.POSITIVE_INFINITY;

export type ActionCallback = (...args: any[]) => void;
export type FilterCallback<T = any> = (value: T, ...args: any[]) => T;

interface Registration {
  callback: (...args: any[]) => any;
  priority: number;
  /** How many arguments the callback receives (a filter counts its value). */
  acceptedArgs: number;
  /** Registration order, so equal priorities keep the order they were added in. */
  order: number;
}

type Registry = Map<string, Registration[]>;

const actionRegistry: Registry = new Map();
const filterRegistry: Registry = new Map();

/** Hooks currently running, innermost last: what `current_filter()` and `doing_action()` answer from. */
const runStack: Array<{ name: string; type: 'action' | 'filter' }> = [];
const actionCounts = new Map<string, number>();
const filterCounts = new Map<string, number>();

let counter = 0;
let version = 0;
const listeners = new Set<() => void>();

const notify = () => {
  version += 1;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('A hook subscriber threw while the registry was changing.', error);
    }
  });
};

/**
 * Bumps on every add and remove. React components read it through useSyncExternalStore so a
 * plugin that registers late (activation, HMR) re-renders whatever depends on its hooks.
 */
export const getHookVersion = () => version;

/**
 * Re-renders everything that reads hooks (useApplyFilters, <HookSlot>) without changing the
 * registry. For a filter whose output depends on data that arrived after the first render, such
 * as a translation loaded for the page on screen: without it the old result stays on the page.
 */
export const refreshFilters = () => notify();

export const subscribeHooks = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// Aliases -----------------------------------------------------------------------------------------

const aliases = new Map<string, string>(); // legacy name -> current name
const warnedNames = new Set<string>();

const isDev = (): boolean => {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
};

const warnOnce = (key: string, message: string) => {
  if (warnedNames.has(key)) return;
  warnedNames.add(key);
  console.warn(message);
};

const canonical = (name: string): string => aliases.get(name) ?? name;

/**
 * Declares that hook `legacy` is now called `current`. Callbacks added under either name run when
 * core fires `current`, so a plugin written before the rename keeps working. Registering under the
 * legacy name logs one development warning pointing at the new one.
 */
export function registerHookAlias(legacy: string, current: string): void {
  if (!legacy || !current || legacy === current) return;
  aliases.set(legacy, current);
  // A callback registered before the alias was declared moves to the new name.
  for (const registry of [actionRegistry, filterRegistry]) {
    const old = registry.get(legacy);
    if (!old) continue;
    registry.delete(legacy);
    const target = registry.get(current) || [];
    target.push(...old);
    target.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
    registry.set(current, target);
  }
}

/** Legacy -> current, for the documentation and for tools that rewrite old plugin code. */
export const listHookAliases = (): Array<{ legacy: string; current: string }> =>
  [...aliases.entries()].map(([legacy, current]) => ({ legacy, current })).sort((a, b) => a.legacy.localeCompare(b.legacy));

// Registry ----------------------------------------------------------------------------------------

function register(
  registry: Registry,
  requested: string,
  callback: (...args: any[]) => any,
  priority: number,
  acceptedArgs: number,
): () => void {
  if (typeof callback !== 'function') {
    throw new Error(`The hook "${requested}" was given a ${typeof callback} instead of a function.`);
  }
  const name = canonical(requested);
  if (name !== requested && isDev()) {
    warnOnce(`alias:${requested}`, `The hook "${requested}" was renamed to "${name}". The old name still works; please update the plugin.`);
  }
  const entry: Registration = { callback, priority, acceptedArgs, order: counter += 1 };
  const list = registry.get(name) || [];
  list.push(entry);
  // Lower priority first, then registration order — Array.prototype.sort is stable, but the
  // explicit tiebreak keeps the order right even for callbacks added at the same priority later.
  list.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
  registry.set(name, list);
  notify();

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const current = registry.get(name);
    if (!current) return;
    const index = current.indexOf(entry);
    if (index === -1) return;
    current.splice(index, 1);
    if (!current.length) registry.delete(name);
    notify();
  };
}

function unregister(registry: Registry, requested: string, callback: (...args: any[]) => any, priority?: number): boolean {
  const name = canonical(requested);
  const current = registry.get(name);
  if (!current) return false;
  const index = current.findIndex((entry) => entry.callback === callback && (priority === undefined || entry.priority === priority));
  if (index === -1) return false;
  current.splice(index, 1);
  if (!current.length) registry.delete(name);
  notify();
  return true;
}

function unregisterAll(registry: Registry, requested: string, priority?: number): boolean {
  const name = canonical(requested);
  const current = registry.get(name);
  if (!current) return false;
  if (priority === undefined) {
    registry.delete(name);
    notify();
    return true;
  }
  const kept = current.filter((entry) => entry.priority !== priority);
  if (kept.length === current.length) return false;
  if (kept.length) registry.set(name, kept); else registry.delete(name);
  notify();
  return true;
}

const sliceArgs = (acceptedArgs: number, args: unknown[], reserved: number): unknown[] =>
  Number.isFinite(acceptedArgs) ? args.slice(0, Math.max(0, acceptedArgs - reserved)) : args;

// Filters ------------------------------------------------------------------------------------

/**
 * Registers a value transformer. Returns a function that removes it again — keep it and call it
 * from a plugin's cleanup, or the callback keeps running after the plugin is deactivated.
 */
export function addFilter<T>(
  name: string,
  callback: FilterCallback<T>,
  priority = DEFAULT_PRIORITY,
  acceptedArgs: number = ALL_ARGS,
): () => void {
  return register(filterRegistry, name, callback, priority, acceptedArgs);
}

export function removeFilter<T>(name: string, callback: FilterCallback<T>, priority?: number): boolean {
  return unregister(filterRegistry, name, callback, priority);
}

/** Removes every callback on a filter, or only those at one priority. */
export const removeAllFilters = (name: string, priority?: number): boolean => unregisterAll(filterRegistry, name, priority);

/**
 * Runs `value` through every filter registered for `name`, lowest priority first. A filter that
 * throws, or returns undefined, is skipped with a console error and the previous value is kept:
 * one broken plugin must not blank out a header or a page.
 */
export function applyFilters<T>(name: string, value: T, ...args: unknown[]): T {
  const key = canonical(name);
  filterCounts.set(key, (filterCounts.get(key) || 0) + 1);
  const list = filterRegistry.get(key);
  if (!list?.length) return value;
  let result = value;
  runStack.push({ name: key, type: 'filter' });
  try {
    // A copy, because a filter is allowed to add or remove filters for the same hook.
    for (const entry of [...list]) {
      try {
        const next = entry.callback(result, ...sliceArgs(entry.acceptedArgs, args, 1)) as T;
        if (next === undefined) {
          console.error(`The filter "${key}" returned undefined. Filters must return the value; the previous one was kept.`);
        } else {
          result = next;
        }
      } catch (error) {
        console.error(`A filter on "${key}" threw. Its result was ignored.`, error);
      }
    }
  } finally {
    runStack.pop();
  }
  return result;
}

/** WordPress's apply_filters_ref_array: `args[0]` is the value, the rest are extra arguments. */
export function applyFiltersRefArray<T>(name: string, args: unknown[]): T {
  const [value, ...rest] = args;
  return applyFilters(name, value as T, ...rest);
}

// Actions ------------------------------------------------------------------------------------

export function addAction(
  name: string,
  callback: ActionCallback,
  priority = DEFAULT_PRIORITY,
  acceptedArgs: number = ALL_ARGS,
): () => void {
  return register(actionRegistry, name, callback, priority, acceptedArgs);
}

export function removeAction(name: string, callback: ActionCallback, priority?: number): boolean {
  return unregister(actionRegistry, name, callback, priority);
}

/** Removes every callback on an action, or only those at one priority. */
export const removeAllActions = (name: string, priority?: number): boolean => unregisterAll(actionRegistry, name, priority);

/** Fires every callback registered for `name`. Errors are logged, never rethrown to the caller. */
export function doAction(name: string, ...args: unknown[]): void {
  const key = canonical(name);
  actionCounts.set(key, (actionCounts.get(key) || 0) + 1);
  const list = actionRegistry.get(key);
  if (!list?.length) return;
  runStack.push({ name: key, type: 'action' });
  try {
    for (const entry of [...list]) {
      try {
        entry.callback(...sliceArgs(entry.acceptedArgs, args, 0));
      } catch (error) {
        console.error(`An action on "${key}" threw.`, error);
      }
    }
  } finally {
    runStack.pop();
  }
}

/** WordPress's do_action_ref_array: the array is spread into the callback's arguments. */
export const doActionRefArray = (name: string, args: unknown[]): void => doAction(name, ...args);

// Deprecated hooks and misuse -------------------------------------------------------------------

/** Fires an action that is being retired, and says so once if anyone is still listening. */
export function doActionDeprecated(name: string, args: unknown[], since: string, replacement = '', message = ''): void {
  if (hasAction(name)) {
    warnOnce(`deprecated-action:${name}`, `The action "${name}" is deprecated since ${since}.${replacement ? ` Use "${replacement}" instead.` : ''}${message ? ` ${message}` : ''}`);
  }
  doAction(name, ...args);
}

/** Applies a filter that is being retired, and says so once if anyone is still listening. */
export function applyFiltersDeprecated<T>(name: string, args: unknown[], since: string, replacement = '', message = ''): T {
  if (hasFilter(name)) {
    warnOnce(`deprecated-filter:${name}`, `The filter "${name}" is deprecated since ${since}.${replacement ? ` Use "${replacement}" instead.` : ''}${message ? ` ${message}` : ''}`);
  }
  return applyFiltersRefArray<T>(name, args);
}

/** WordPress's _doing_it_wrong: a developer-facing note about misuse of an API, logged once. */
export function doingItWrong(fn: string, message: string, since = ''): void {
  warnOnce(`wrong:${fn}:${message}`, `${fn} was called incorrectly. ${message}${since ? ` (since ${since})` : ''}`);
}

/** WordPress's _deprecated_function. */
export function deprecatedFunction(fn: string, since: string, replacement = ''): void {
  warnOnce(`deprecated-fn:${fn}`, `${fn} is deprecated since ${since}.${replacement ? ` Use ${replacement} instead.` : ' There is no alternative.'}`);
}

// Introspection ---------------------------------------------------------------------------------

/**
 * Without a callback: whether the hook has any. With one: its priority, or false when it is not
 * registered (WordPress's has_filter contract). Priority 0 is a valid answer, so compare to false.
 */
function has(registry: Registry, name: string, callback?: (...args: any[]) => any): boolean | number {
  const list = registry.get(canonical(name));
  if (!list?.length) return false;
  if (!callback) return true;
  const found = list.find((entry) => entry.callback === callback);
  return found ? found.priority : false;
}

export function hasFilter(name: string): boolean;
export function hasFilter(name: string, callback: (...args: any[]) => any): number | false;
export function hasFilter(name: string, callback?: (...args: any[]) => any): boolean | number {
  return has(filterRegistry, name, callback);
}

export function hasAction(name: string): boolean;
export function hasAction(name: string, callback: (...args: any[]) => any): number | false;
export function hasAction(name: string, callback?: (...args: any[]) => any): boolean | number {
  return has(actionRegistry, name, callback);
}

/** How many times an action has fired (WordPress's did_action). */
export const didAction = (name: string): number => actionCounts.get(canonical(name)) || 0;

/** How many times a filter has been applied (WordPress's did_filter). */
export const didFilter = (name: string): number => filterCounts.get(canonical(name)) || 0;

/** The innermost hook that is running now, action or filter (WordPress's current_filter). */
export const currentFilter = (): string | false => (runStack.length ? runStack[runStack.length - 1].name : false);

/** The innermost *action* that is running now (WordPress's current_action is the same as current_filter). */
export const currentAction = (): string | false => currentFilter();

/** Whether a filter — or, as in WordPress, any hook — is running. Pass a name to ask about one. */
export const doingFilter = (name?: string): boolean => {
  if (name === undefined) return runStack.length > 0;
  const key = canonical(name);
  return runStack.some((frame) => frame.name === key);
};

/** Whether an action is running. Pass a name to ask about one. */
export const doingAction = (name?: string): boolean => {
  if (name === undefined) return runStack.some((frame) => frame.type === 'action');
  const key = canonical(name);
  return runStack.some((frame) => frame.type === 'action' && frame.name === key);
};

/** Every hook name with at least one callback, for the Guide screen and for debugging. */
export const listHooks = (): { actions: Array<{ name: string; count: number }>; filters: Array<{ name: string; count: number }> } => ({
  actions: [...actionRegistry.entries()].map(([name, list]) => ({ name, count: list.length })).sort((a, b) => a.name.localeCompare(b.name)),
  filters: [...filterRegistry.entries()].map(([name, list]) => ({ name, count: list.length })).sort((a, b) => a.name.localeCompare(b.name)),
});

/** Clears a hook, or the whole registry. Meant for tests and HMR, not for plugins. */
export function removeAllHooks(name?: string): void {
  if (name) {
    const key = canonical(name);
    actionRegistry.delete(key);
    filterRegistry.delete(key);
  } else {
    actionRegistry.clear();
    filterRegistry.clear();
    actionCounts.clear();
    filterCounts.clear();
  }
  notify();
}

// Renamed hooks -----------------------------------------------------------------------------------
// Every WordPress-derived name carries the rwp_ prefix (src/lib/rwp-api, docs/wordpress-parity).
// A name that shipped without it stays working through an alias until no plugin uses it.

registerHookAlias('the_content', 'rwp_the_content');

// Well-known hook names ---------------------------------------------------------------------------
// Plugins may use any string; these are the zones core itself fires, collected so they can be
// autocompleted and listed in the admin Guide.

/** Layout zones rendered with <HookSlot name="…" />. */
export const slotNames = [
  'before_header',
  'after_header',
  'before_content',
  'after_content',
  'before_footer',
  'after_footer',
  'sidebar_widgets',
  'comment_form_before',
  'comment_form_after',
  'admin_before_content',
  'admin_after_content',
  'admin_sidebar_after_nav',
  /** Cards on the visitors' dashboard ([rwp_user_dashboard]); args are { userId, role }. */
  'user_dashboard',
  'builder_sidebar_tabs',
  'builder_topbar_actions',
] as const;

export type SlotName = (typeof slotNames)[number];

/** Filters core applies to content and translations. */
export const coreFilterNames = [
  /** The HTML of a page or post body, before it is sanitized and rendered. WordPress's `the_content`, prefixed. */
  'rwp_the_content',
  /** Extra tabs on the visitors' dashboard: an array of { id, label, render(args) }, shown after Overview. args are { userId, role }. */
  'user_dashboard_tabs',
  /** (translated, key, locale, vars) — the final string for one key, after Settings → Translations and the bundled dictionaries. */
  'i18n_translate_key',
  /** The active locale code, before it is applied to the document. */
  'i18n_locale',
  /** The locales offered in the language switcher. */
  'i18n_supported_locales',
  /** Widget types the page builder offers, as an array of definitions. */
  'builder_widgets',
  /** The admin sidebar, as AdminNavItem[]. */
  'rwp_admin_navigation',
  /** (items, group) — the default pages created on a new site (src/lib/defaultContent.ts). */
  'rwp_default_site_content',
  /** (choices, key) — addresses offered for an account page under Settings, e.g. /my-account. */
  'rwp_account_page_choices',
] as const;

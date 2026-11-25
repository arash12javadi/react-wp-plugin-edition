/**
 * Server-side hooks: WordPress's actions and filters, on the server.
 *
 * A plugin's `server.mjs` may export `register(api)`. `server/plugins.mjs` calls it once per loaded plugin with this API bound
 * to that plugin's id (`hooksFor(pluginId)`), plus `registerPaymentGateway` (server/payments/registry.mjs):
 *
 *     export function register({ addAction, addFilter }) {
 *       addAction('rwp_payment_complete', async (payment) => { ... });
 *       addFilter('rwp_rest_post_dispatch', (response, request) => response);
 *     }
 *
 * Rules that keep this safe to open to any plugin:
 *   - every callback belongs to a plugin, and only callbacks of plugins that are ACTIVE on this site run (`core` always runs);
 *   - a callback that throws is logged and skipped: an action never breaks the request, a filter keeps the value it had;
 *   - a filter returning `undefined` keeps the previous value;
 *   - hooks are fired only where core or a plugin chooses to fire them. The security line is never one of those places: login
 *     and capability checks, the licence and edition gates, webhook signatures, sealed secrets and the amounts charged (read in
 *     SQL) have no hook.
 * Names follow the client's parity rule (a WordPress hook under its rwp_ name, or one listed in
 * docs/wordpress-parity/native-hooks.json); `npm run check:hooks` checks every name fired here too.
 */

export const DEFAULT_PRIORITY = 10;
const NAME = /^[a-z][a-z0-9_]{1,80}$/;
const OWNER = /^(core|[a-z0-9][a-z0-9-]{0,63})$/;

/** `name -> [{ callback, priority, owner, order }]`, kept sorted by priority then registration order. */
const store = { action: new Map(), filter: new Map() };
let order = 0;
/** Which plugins are active right now (a Set), or null when unknown (tests, start-up): then every callback runs. */
let activeSource = () => null;

/** `server/plugins.mjs` tells the hooks which plugins are active (the same cached option its routes use). */
export function setActivePluginSource(source) {
  activeSource = typeof source === 'function' ? source : () => null;
}

/** The ids of the active plugins as last known, or null when not known yet. */
export const activePluginIds = () => {
  const value = activeSource();
  return value instanceof Set ? value : null;
};

const add = (kind, name, callback, priority, owner) => {
  if (!NAME.test(String(name || ''))) throw new TypeError(`"${name}" is not a hook name (lower-case letters, digits and _).`);
  if (typeof callback !== 'function') throw new TypeError(`The ${kind} "${name}" needs a function.`);
  if (!OWNER.test(String(owner || ''))) throw new TypeError(`"${owner}" is not a plugin id.`);
  const level = Number.isFinite(Number(priority)) ? Number(priority) : DEFAULT_PRIORITY;
  const list = store[kind].get(name) || [];
  list.push({ callback, priority: level, owner, order: (order += 1) });
  list.sort((a, b) => a.priority - b.priority || a.order - b.order);
  store[kind].set(name, list);
  return true;
};

const remove = (kind, name, callback, owner) => {
  const list = store[kind].get(name);
  if (!list) return false;
  const next = list.filter((entry) => !(entry.callback === callback && (owner === undefined || entry.owner === owner)));
  store[kind].set(name, next);
  return next.length !== list.length;
};

const runnable = (kind, name) => {
  const active = activePluginIds();
  return (store[kind].get(name) || []).filter((entry) => entry.owner === 'core' || !active || active.has(entry.owner));
};

const report = (kind, name, entry, error) => {
  console.error(`[hooks] The ${kind} "${name}" of ${entry.owner} failed: ${error instanceof Error ? error.message : String(error)}`);
};

export const addAction = (name, callback, priority = DEFAULT_PRIORITY, owner = 'core') => add('action', name, callback, priority, owner);
export const addFilter = (name, callback, priority = DEFAULT_PRIORITY, owner = 'core') => add('filter', name, callback, priority, owner);
export const removeAction = (name, callback, owner) => remove('action', name, callback, owner);
export const removeFilter = (name, callback, owner) => remove('filter', name, callback, owner);
export const hasAction = (name) => runnable('action', name).length > 0;
export const hasFilter = (name) => runnable('filter', name).length > 0;

/** Runs every active callback of an action in order, awaiting each. Never throws. */
export async function doAction(name, ...args) {
  for (const entry of runnable('action', name)) {
    try {
      await entry.callback(...args);
    } catch (error) {
      report('action', name, entry, error);
    }
  }
}

/** Passes `value` through every active callback of a filter in order. A failing callback leaves the value as it was. */
export async function applyFilters(name, value, ...args) {
  let current = value;
  for (const entry of runnable('filter', name)) {
    try {
      const next = await entry.callback(current, ...args);
      if (next !== undefined) current = next;
    } catch (error) {
      report('filter', name, entry, error);
    }
  }
  return current;
}

/** The registration half of the API, bound to one plugin: what a plugin's `register(api)` receives. */
export function hooksFor(pluginId) {
  const owner = String(pluginId || '');
  return Object.freeze({
    addAction: (name, callback, priority) => addAction(name, callback, priority, owner),
    addFilter: (name, callback, priority) => addFilter(name, callback, priority, owner),
    removeAction: (name, callback) => removeAction(name, callback, owner),
    removeFilter: (name, callback) => removeFilter(name, callback, owner),
  });
}

/** The firing half, handed to routes as `ctx.hooks`. */
export const firingApi = Object.freeze({ doAction, applyFilters, hasAction, hasFilter });

/** Forgets every hook (tests only). */
export function resetHooks() {
  store.action.clear();
  store.filter.clear();
  order = 0;
  activeSource = () => null;
}

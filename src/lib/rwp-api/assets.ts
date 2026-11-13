/**
 * WordPress's script and style queue (wp_register_script, wp_enqueue_script, wp_enqueue_style ...).
 *
 * A handle names a file and what it depends on. Enqueueing loads the dependencies first, then the
 * file, once per page load, by adding a <script> or <link rel="stylesheet"> to the document. Scripts
 * go to the footer when `inFooter` is true, otherwise to the head. Handles that are already loaded
 * are not loaded again.
 *
 * Plugins run with full access to the page, so a script a plugin enqueues has the same power as the
 * plugin. The src must be an http(s) address or an address on this site; anything else is refused.
 */
import { applyFilters } from '../../core/hooks';
import { rwp_esc_url } from './formatting';

interface Registered {
  handle: string;
  src: string;
  deps: string[];
  ver: string | null;
  inFooter: boolean;
  media: string;
  before: string[];
  after: string[];
  data: string[];
}

type Kind = 'script' | 'style';

const registry: Record<Kind, Map<string, Registered>> = { script: new Map(), style: new Map() };
const loaded: Record<Kind, Map<string, Promise<void>>> = { script: new Map(), style: new Map() };
const inlineStyles = new Map<string, string[]>();

const safeSrc = (src: string): string => {
  const clean = rwp_esc_url(src, ['http', 'https']);
  return clean.replace(/&#039;/g, "'");
};

function register(kind: Kind, handle: string, src: string, deps: string[], ver: string | null | false, extra: { inFooter?: boolean; media?: string }): boolean {
  if (!handle || registry[kind].has(handle)) return false;
  registry[kind].set(handle, {
    handle,
    src,
    deps,
    ver: ver === false ? null : ver ?? null,
    inFooter: Boolean(extra.inFooter),
    media: extra.media || 'all',
    before: [],
    after: [],
    data: [],
  });
  return true;
}

export function rwp_register_script(handle: string, src: string, deps: string[] = [], ver: string | null | false = null, args: boolean | { in_footer?: boolean } = false): boolean {
  const inFooter = typeof args === 'boolean' ? args : Boolean(args.in_footer);
  return register('script', handle, src, deps, ver, { inFooter });
}

export function rwp_register_style(handle: string, src: string, deps: string[] = [], ver: string | null | false = null, media = 'all'): boolean {
  return register('style', handle, src, deps, ver, { media });
}

export function rwp_deregister_script(handle: string): void {
  registry.script.delete(handle);
}

export function rwp_deregister_style(handle: string): void {
  registry.style.delete(handle);
}

const withVersion = (src: string, ver: string | null): string => {
  if (ver === null || /[?&]ver=/.test(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}ver=${encodeURIComponent(ver)}`;
};

function load(kind: Kind, handle: string, trail: string[] = []): Promise<void> {
  const existing = loaded[kind].get(handle);
  if (existing) return existing;
  const entry = registry[kind].get(handle);
  if (!entry) return Promise.reject(new Error(`The ${kind} "${handle}" was enqueued but never registered.`));
  if (trail.includes(handle)) return Promise.reject(new Error(`The ${kind} "${handle}" depends on itself (${[...trail, handle].join(' → ')}).`));
  const promise = Promise.all(entry.deps.map((dep) => load(kind, dep, [...trail, handle]))).then(() => new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') { resolve(); return; }
    const versioned = withVersion(entry.src, entry.ver);
    const src = safeSrc(kind === 'script' ? applyFilters<string>('rwp_script_loader_src', versioned, handle) : applyFilters<string>('rwp_style_loader_src', versioned, handle));
    if (!src) { reject(new Error(`The ${kind} "${handle}" has a source that is not allowed.`)); return; }
    entry.before.forEach((code) => {
      const inline = document.createElement('script');
      inline.textContent = code;
      document.head.appendChild(inline);
    });
    entry.data.forEach((code) => {
      const inline = document.createElement('script');
      inline.textContent = code;
      document.head.appendChild(inline);
    });
    if (kind === 'script') {
      const element = document.createElement('script');
      element.src = src;
      element.async = false;
      element.dataset.rwpHandle = handle;
      element.onload = () => { entry.after.forEach((code) => { const inline = document.createElement('script'); inline.textContent = code; document.body.appendChild(inline); }); resolve(); };
      element.onerror = () => reject(new Error(`The script "${handle}" could not be loaded from ${src}.`));
      (entry.inFooter ? document.body : document.head).appendChild(element);
    } else {
      const element = document.createElement('link');
      element.rel = 'stylesheet';
      element.href = src;
      element.media = entry.media;
      element.dataset.rwpHandle = handle;
      element.onload = () => resolve();
      element.onerror = () => reject(new Error(`The stylesheet "${handle}" could not be loaded from ${src}.`));
      document.head.appendChild(element);
      (inlineStyles.get(handle) || []).forEach((css) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      });
    }
  }));
  loaded[kind].set(handle, promise);
  return promise;
}

/**
 * Loads a script (and its dependencies) once. Give `src` to register and enqueue in one call, as
 * WordPress allows. Returns a promise that resolves when the file has loaded.
 */
export function rwp_enqueue_script(handle: string, src = '', deps: string[] = [], ver: string | null | false = null, args: boolean | { in_footer?: boolean } = false): Promise<void> {
  if (src) rwp_register_script(handle, src, deps, ver, args);
  return load('script', handle);
}

/** Loads a stylesheet (and its dependencies) once. */
export function rwp_enqueue_style(handle: string, src = '', deps: string[] = [], ver: string | null | false = null, media = 'all'): Promise<void> {
  if (src) rwp_register_style(handle, src, deps, ver, media);
  return load('style', handle);
}

/** Forgets a script that was queued but not yet loaded; one that is already on the page stays. */
export function rwp_dequeue_script(handle: string): void {
  if (!loaded.script.has(handle)) registry.script.delete(handle);
}

export function rwp_dequeue_style(handle: string): void {
  if (!loaded.style.has(handle)) registry.style.delete(handle);
}

export function rwp_script_is(handle: string, status: 'registered' | 'enqueued' | 'done' = 'enqueued'): boolean {
  return status === 'registered' ? registry.script.has(handle) : loaded.script.has(handle);
}

export function rwp_style_is(handle: string, status: 'registered' | 'enqueued' | 'done' = 'enqueued'): boolean {
  return status === 'registered' ? registry.style.has(handle) : loaded.style.has(handle);
}

/**
 * Makes a JavaScript object available to a script as `window[objectName]`, before the script runs.
 * The data is JSON-encoded; it is not escaped for HTML because it never goes through HTML.
 */
export function rwp_localize_script(handle: string, objectName: string, data: Record<string, unknown>): boolean {
  const entry = registry.script.get(handle);
  if (!entry || !/^[A-Za-z_$][\w$]*$/.test(objectName)) return false;
  entry.data.push(`window.${objectName} = ${JSON.stringify(data).replace(/</g, '\\u003c')};`);
  return true;
}

/** Adds a code block before or after a registered script. */
export function rwp_add_inline_script(handle: string, data: string, position: 'before' | 'after' = 'after'): boolean {
  const entry = registry.script.get(handle);
  if (!entry) return false;
  entry[position].push(data);
  return true;
}

/** Adds CSS that is injected with a registered stylesheet. */
export function rwp_add_inline_style(handle: string, data: string): boolean {
  if (!registry.style.has(handle)) return false;
  inlineStyles.set(handle, [...(inlineStyles.get(handle) || []), data]);
  return true;
}

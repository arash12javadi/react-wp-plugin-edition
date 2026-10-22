import type { BuilderNode, ColumnNode, ResponsiveStyle, SectionNode, WidgetNode } from './types';

/**
 * The builder's clipboard is shared by every page in this browser, which is what makes a copied
 * section portable: open another page in the builder and Paste is still there.
 *
 * The same payload is also written to the browser's own clipboard as JSON text. That is what
 * carries a section between sites: copy it in the builder on one site, switch to the builder on
 * another, and Paste reads the text back. `localStorage` keeps working as the offline fallback.
 *
 * The payload is a small, versioned envelope around the node itself. Anything read back is
 * rebuilt through `cleanNode`, so a stale payload, a hand-edited one, a subtree written by an
 * older builder version, or text that is not a builder payload at all can never put malformed
 * data into a document.
 */
export const CLIPBOARD_STORAGE_KEY = 'rwpb-builder-clipboard';
export const CLIPBOARD_VERSION = 1;

/** The deepest legal tree is section → column → section → column → widget. */
const MAX_DEPTH = 4;

/** A corrupt payload must not be able to freeze the editor while it is re-validated. */
const MAX_NODES = 4000;

/** A section holds at most six columns; the same limit addColumn and pasteLocation enforce. */
const MAX_COLUMNS = 6;

export interface ClipboardEntry {
  node: BuilderNode;
  /** The page it was copied from, for diagnostics only. */
  pageId: number | null;
  copiedAt: number;
}

interface ClipboardEnvelope {
  app: 'rwp-page-builder';
  version: number;
  copiedAt?: unknown;
  pageId?: unknown;
  node: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A detached plain-object copy; also strips functions and undefined values. */
const plainRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

function cleanStyle(value: unknown): ResponsiveStyle | null {
  if (!isRecord(value) || !isRecord(value.desktop)) return null;
  const style: ResponsiveStyle = { desktop: plainRecord(value.desktop) };
  if (isRecord(value.tablet)) style.tablet = plainRecord(value.tablet);
  if (isRecord(value.mobile)) style.mobile = plainRecord(value.mobile);
  return style;
}

function cleanChildren(
  value: unknown,
  parent: 'section' | 'column',
  depth: number,
  counter: { nodes: number },
): BuilderNode[] {
  if (!Array.isArray(value)) return [];
  const children: BuilderNode[] = [];
  for (const item of value) {
    const child = cleanNode(item, depth + 1, counter);
    if (!child) continue;
    // Sections hold columns; columns hold widgets and inner sections.
    if (parent === 'section' ? child.kind === 'column' : child.kind !== 'column') children.push(child);
  }
  return children;
}

function cleanNode(value: unknown, depth: number, counter: { nodes: number }): BuilderNode | null {
  if (!isRecord(value) || depth > MAX_DEPTH) return null;
  const kind = value.kind;
  if (kind !== 'section' && kind !== 'column' && kind !== 'widget') return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES) return null;

  const style = cleanStyle(value.style);
  if (!style) return null;
  const type = typeof value.type === 'string' && value.type.trim() ? value.type : kind;
  const base = {
    id,
    type,
    settings: plainRecord(value.settings),
    style,
    advanced: plainRecord(value.advanced),
    ...(typeof value.label === 'string' && value.label.trim() ? { label: value.label } : {}),
    ...(value.hidden === true ? { hidden: true as const } : {}),
  };

  if (kind === 'widget') return { ...base, kind: 'widget' } as WidgetNode;

  const children = cleanChildren(value.children, kind, depth, counter);
  if (kind === 'section') {
    // Nested sections go one level only: an inner section may not hold another section.
    if (depth >= 2 && children.some((column) => column.kind === 'column'
      && column.children.some((item) => item.kind === 'section'))) return null;
    return { ...base, kind: 'section', type: 'section', children: (children as ColumnNode[]).slice(0, MAX_COLUMNS) } as SectionNode;
  }
  return { ...base, kind: 'column', type: 'column', children: children as ColumnNode['children'] } as ColumnNode;
}

/**
 * Parses a stored payload (or a raw node from an older clipboard format) and returns a validated
 * entry. Returns null when the data is not a usable builder subtree.
 */
export function parseClipboardEntry(raw: string | null | undefined): ClipboardEntry | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const envelope = value as unknown as ClipboardEnvelope;
  let candidate: unknown = value;
  if (envelope.app === 'rwp-page-builder') {
    if (envelope.version !== CLIPBOARD_VERSION) return null;
    candidate = envelope.node;
  }

  const node = cleanNode(candidate, 0, { nodes: 0 });
  if (!node) return null;
  const copiedAt = typeof envelope.copiedAt === 'number' && Number.isFinite(envelope.copiedAt) ? envelope.copiedAt : Date.now();
  const pageId = typeof envelope.pageId === 'number' && Number.isFinite(envelope.pageId) ? envelope.pageId : null;
  return { node, pageId, copiedAt };
}

/** The text form of an entry: what `localStorage` and the browser clipboard both hold. */
export function serializeClipboardEntry(entry: ClipboardEntry): string {
  return JSON.stringify({ app: 'rwp-page-builder', version: CLIPBOARD_VERSION, ...entry });
}

/**
 * The Clipboard API only exists in a secure context, and a browser can still deny access. Both
 * halves of the feature check this instead of calling `navigator.clipboard` blindly.
 */
function clipboardApi(): Clipboard | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !window.isSecureContext) return null;
  return navigator.clipboard ?? null;
}

/** True when Paste may have something waiting in the browser's clipboard. */
export function canReadSystemClipboard(): boolean {
  return Boolean(clipboardApi()?.readText);
}

/**
 * Copies an entry to the browser clipboard, so the builder on another site can paste it.
 *
 * The Clipboard API is unavailable on an insecure origin and can be denied by permissions; the
 * deprecated `execCommand('copy')` path is the one that still works in that situation. Returns
 * false when neither path was allowed — the localStorage copy is then the only one.
 */
export async function writeSystemClipboard(entry: ClipboardEntry): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const text = serializeClipboardEntry(entry);
  const clipboard = clipboardApi();
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through: some browsers expose writeText but refuse it, and the legacy path can still work.
    }
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.readOnly = true;
    // Keep the temporary field out of the layout and out of view while it holds the selection.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Reads a payload another site's builder copied. Returns null when the browser clipboard holds
 * ordinary text (or cannot be read), in which case the caller falls back to `localStorage`.
 */
export async function readSystemClipboard(): Promise<ClipboardEntry | null> {
  const clipboard = clipboardApi();
  if (!clipboard?.readText) return null;
  try {
    return parseClipboardEntry(await clipboard.readText());
  } catch {
    // Permission denied, document not focused, or no API: nothing to offer beyond localStorage.
    return null;
  }
}

/** Reads the clipboard shared by every builder page. Storage can be blocked; that is not fatal. */
export function readClipboard(): ClipboardEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseClipboardEntry(window.localStorage.getItem(CLIPBOARD_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Keeps a snapshot of `node` for pasting. The snapshot is returned even when storage is
 * unavailable, so copy/paste still works within this page; only cross-page persistence is lost.
 */
export function writeClipboard(node: BuilderNode, pageId: number | null): ClipboardEntry {
  const copiedAt = Date.now();
  const snapshot = JSON.parse(JSON.stringify(node)) as BuilderNode;
  const entry: ClipboardEntry = { node: snapshot, pageId, copiedAt };
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CLIPBOARD_STORAGE_KEY, serializeClipboardEntry(entry));
    }
  } catch {
    // Full or blocked storage: drop any older snapshot so a later paste cannot prefer it over
    // the in-memory copy above. If storage is blocked entirely, reads fail and fall back too.
    try {
      window.localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
    } catch {
      // Nothing else to do: local pasting still works from the returned snapshot.
    }
  }
  return entry;
}

import { getSupabaseClient } from '../../../src/lib/db';
import { sanitizeHtml } from '../../../src/components/ContentRenderer';
import { controlStore } from '../lib/controls';
import { getWidget, type Control } from '../lib/registry';
import { findNode, locate, updateNode, walkNodes } from '../lib/tree';
import type { BuilderDocument, BuilderNode, SectionNode, WidgetNode } from '../lib/types';

/**
 * "AI Refine": sends copy to the server, which asks the provider chosen on Settings → Integrations →
 * AI for better wording, and patches the returned strings back into the document.
 *
 * The same code serves three scopes, because the work is identical and only the selection differs:
 * a whole section (the ✨ button on a section's toolbar), one widget (the ✨ button in the inspector)
 * and one text field (the ✨ button beside a control). `AiTarget` is that choice.
 *
 * Only text leaves the browser, never the layout JSON, and only text comes back. So the AI cannot
 * change ids, structure, links, media, styles, Custom HTML code or private form settings, and
 * applying a result is an ordinary, undoable edit.
 */

export type OptimizePreset = 'seo' | 'cta' | 'shorten' | 'tone';
export type OptimizeTone = 'professional' | 'casual' | 'urgent' | 'persuasive';

/**
 * What an AI Refine window is open for. `field` is one control of one widget, which is why it
 * carries the control key as well as the node id.
 */
export type AiTarget =
  | { kind: 'section'; nodeId: string }
  | { kind: 'widget'; nodeId: string }
  | { kind: 'field'; nodeId: string; key: string };

export interface CopyItem {
  /** "nodeId|key" or, for repeater items, "nodeId|key|index|field". */
  id: string;
  nodeId: string;
  key: string;
  itemIndex?: number;
  itemField?: string;
  widget: string;
  field: string;
  format: 'text' | 'html';
  text: string;
}

export interface SectionOverview {
  kind: string;
  columns: number;
  widgets: string[];
  position: string;
}

export interface CopyChange extends CopyItem {
  after: string;
}

export interface OptimizeResult {
  changes: CopyChange[];
  rejected: Array<{ id: string; field: string; reason: string }>;
  /** Rewrites that came back without naming a field of this target, or without usable text. */
  ignored: number;
  summary: string;
  model: string;
}

const COPY_CONTROL_TYPES = new Set(['text', 'textarea', 'richtext']);
// Settings that hold addresses, identifiers or code rather than copy a visitor reads.
const NON_COPY_KEY = /^(url|href|link|email|phone|tel|anchor|cssId|cssClass|embed|shortcode|slug|query|separator|format|icon|code|html_id)$|(Url|Href|Link|Email|Id|Slug|Class|Selector|Format)$/;
const NON_COPY_VALUE = /^(https?:\/\/|mailto:|tel:|\/|#|www\.)\S*$|^[^\s@]+@[^\s@]+\.[^\s@]+$|^[\d\s.,:%+-]+$/;
const ONLY_TAGS = /^\s*(\{\{[^}]*\}\}\s*)+$/;

const isCopy = (control: Control, value: unknown): value is string =>
  COPY_CONTROL_TYPES.has(control.type)
  && typeof value === 'string'
  && value.replace(/<[^>]*>/g, '').trim().length > 1
  && !control.key.startsWith('private_')
  && !NON_COPY_KEY.test(control.key)
  && !NON_COPY_VALUE.test(value.trim())
  && !ONLY_TAGS.test(value);

const itemId = (nodeId: string, key: string, index?: number, field?: string) =>
  index === undefined ? `${nodeId}|${key}` : `${nodeId}|${key}|${index}|${field}`;

/** Every copy item of one widget, in control order. */
function widgetCopy(node: WidgetNode): CopyItem[] {
  const items: CopyItem[] = [];
  const definition = getWidget(node.type);
  // Custom HTML is administrator-only code, not copy.
  if (!definition || definition.adminOnly) return items;
  const settings = node.settings || {};
  for (const control of definition.controls) {
    if (controlStore(control) !== 'settings') continue;
    if (control.condition && !control.condition(settings, node.style?.desktop || {}, node.advanced)) continue;
    const value = settings[control.key];
    if (control.type === 'repeater' && Array.isArray(value) && control.fields) {
      value.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        for (const field of control.fields!) {
          const fieldValue = (entry as Record<string, unknown>)[field.key];
          if (!isCopy(field, fieldValue)) continue;
          items.push({
            id: itemId(node.id, control.key, index, field.key), nodeId: node.id, key: control.key, itemIndex: index, itemField: field.key,
            widget: definition.label, field: `${control.label} ${index + 1}: ${field.label}`,
            format: field.type === 'richtext' ? 'html' : 'text', text: fieldValue,
          });
        }
      });
      continue;
    }
    if (!isCopy(control, value)) continue;
    items.push({
      id: itemId(node.id, control.key), nodeId: node.id, key: control.key, widget: definition.label,
      field: node.type === 'heading' ? `${String(settings.tag || 'h2').toUpperCase()} heading` : control.label,
      format: control.type === 'richtext' ? 'html' : 'text', text: value,
    });
  }
  return items;
}

/** Every piece of visible copy in the section, in reading order. */
export function extractSectionCopy(section: SectionNode): CopyItem[] {
  const items: CopyItem[] = [];
  walkNodes([section], (node) => {
    if (node.kind !== 'widget' || node.hidden) return;
    items.push(...widgetCopy(node));
  });
  return items;
}

/** Every piece of visible copy in one widget, in control order. */
export const extractWidgetCopy = (widget: WidgetNode): CopyItem[] => (widget.hidden ? [] : widgetCopy(widget));

/** Whether a widget holds text the AI may rewrite. Cheap enough to ask when its toolbar is drawn. */
export const widgetHasCopy = (widget: WidgetNode): boolean => extractWidgetCopy(widget).length > 0;

/**
 * The copy an AI Refine window works on. A `field` target keeps every repeater row of that control,
 * since they share one key.
 */
export function extractTargetCopy(doc: BuilderDocument, target: AiTarget): CopyItem[] {
  const node = findNode(doc, target.nodeId);
  if (!node) return [];
  if (target.kind === 'section') return node.kind === 'section' ? extractSectionCopy(node) : [];
  if (node.kind !== 'widget') return [];
  const items = extractWidgetCopy(node);
  return target.kind === 'field' ? items.filter((item) => item.key === target.key) : items;
}

const widgetTypes = (section: SectionNode) => {
  const types: string[] = [];
  walkNodes([section], (node) => { if (node.kind === 'widget' && !node.hidden) types.push(node.type); });
  return types;
};

/** A best guess at what the section is for, so the model writes the right kind of copy. */
export function describeSection(doc: BuilderDocument, section: SectionNode): SectionOverview {
  const types = widgetTypes(section);
  const count = (...names: string[]) => types.filter((type) => names.includes(type)).length;
  const index = doc.content.findIndex((node) => node.id === section.id);
  let headingTag = '';
  walkNodes([section], (node) => { if (!headingTag && node.kind === 'widget' && node.type === 'heading') headingTag = String(node.settings.tag || 'h2'); });

  let kind = 'Content Section';
  if (section.label) kind = section.label;
  // A top section with the page's H1 is the hero, even when it holds a sign-up form.
  else if (index === 0 && headingTag === 'h1') kind = 'Hero Section';
  else if (count('testimonial', 'testimonial-carousel', 'reviews')) kind = 'Testimonials Section';
  else if (count('price-table', 'price-list')) kind = 'Pricing Section';
  else if (count('accordion', 'toggle') && types.length <= 4) kind = 'FAQ Section';
  else if (count('form')) kind = 'Contact / Form Section';
  else if (count('cta')) kind = 'Call-to-Action Section';
  else if (count('icon-box', 'image-box', 'flip-box') >= 3) kind = `${section.children.length}-Column Feature Grid`;
  else if (count('counter', 'progress-bar') >= 2) kind = 'Stats Section';
  else if (index === 0 && (headingTag === 'h1' || count('heading')) && count('button', 'cta')) kind = 'Hero Section';
  else if (count('heading') && count('button') && types.length <= 4) kind = 'Call-to-Action Section';

  return {
    kind,
    columns: section.children.length,
    widgets: [...new Set(types.map((type) => getWidget(type)?.label || type))],
    position: index === 0 ? 'top of the page' : `section ${index + 1} of ${doc.content.length}`,
  };
}

const stripTags = (value: string) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Rich text from the model is cleaned the same way the renderer cleans it; plain text loses any tags. */
const cleanOutput = (format: CopyItem['format'], text: string) =>
  format === 'html' ? sanitizeHtml(text).innerHTML.trim() : stripTags(text);

/** The longest custom instruction the server accepts, shared with the modal's counter. */
export const PROMPT_MAX_CHARS = 4_000;

/** The section a node sits in, when the node is not one itself. */
function sectionOf(doc: BuilderDocument, nodeId: string): SectionNode | null {
  const location = locate(doc, nodeId);
  for (let index = (location?.ancestors.length || 0) - 1; index >= 0; index -= 1) {
    const ancestor = location!.ancestors[index];
    if (ancestor.kind === 'section') return ancestor;
  }
  return null;
}

/** What the model is told about the copy it is rewriting, so it writes the right kind of text. */
export function describeTarget(doc: BuilderDocument, target: AiTarget): SectionOverview {
  const node = findNode(doc, target.nodeId);
  const section = node?.kind === 'section' ? node : sectionOf(doc, target.nodeId);
  const overview = section ? describeSection(doc, section) : { kind: 'Section', columns: 1, widgets: [], position: '' };
  if (!section || target.kind === 'section' || node?.kind !== 'widget') return overview;
  const label = getWidget(node.type)?.label || 'Widget';
  // One widget is not a page section: say what it is, and keep the place it sits in.
  return { kind: `${label} widget`, columns: 1, widgets: [label], position: overview.position };
}

export async function optimizeCopy(input: {
  doc: BuilderDocument;
  target: AiTarget;
  focusKeyword: string;
  preset: OptimizePreset | null;
  tone: OptimizeTone | null;
  customPrompt: string;
  pageTitle: string;
}): Promise<OptimizeResult> {
  const node = findNode(input.doc, input.target.nodeId);
  if (!node) throw new Error('That element no longer exists. Close this window and choose it again.');
  if (node.kind === 'widget' && node.hidden) {
    throw new Error('That widget is hidden, so it has no text to refine. Show it first, then try again.');
  }
  const items = extractTargetCopy(input.doc, input.target);
  if (!items.length) {
    throw new Error(input.target.kind === 'section'
      ? 'This section has no editable text (only images, spacers or dynamic content).'
      : 'This text cannot be refined: it is empty, or the widget has no text fields (only images, icons or settings).');
  }

  const { data } = await getSupabaseClient().auth.getSession();
  let response: Response;
  try {
    response = await fetch('/api/plugins/rwp-page-builder/ai/section', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
      body: JSON.stringify({
        context: describeTarget(input.doc, input.target),
        items: items.map(({ id, widget, field, format, text }) => ({ id, widget, field, format, text })),
        focusKeyword: input.focusKeyword,
        pageTitle: input.pageTitle,
        preset: input.preset,
        tone: input.tone,
        customPrompt: input.customPrompt,
      }),
    });
  } catch {
    throw new Error('Could not reach the site server. If you are using npm run dev, npm start must also be running on port 3000.');
  }
  const payload = await response.json().catch(() => null) as { items?: Array<{ id: string; text: string }>; rejected?: Array<{ id: string; reason: string }>; ignored?: number; summary?: string; model?: string; error?: string } | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `The AI request failed (HTTP ${response.status}). If you are using npm run dev, npm start must also be running on port 3000.`);
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const changes: CopyChange[] = [];
  // The server counts answers that named no field; an id it named but that sanitises to nothing is
  // the same kind of loss and is counted here, so an empty result can always say why it is empty.
  let ignored = Number(payload.ignored) || 0;
  for (const entry of payload.items || []) {
    const item = byId.get(entry.id);
    if (!item) { ignored += 1; continue; }
    const after = cleanOutput(item.format, entry.text);
    if (after && after !== item.text.trim()) changes.push({ ...item, after });
    else if (!after) ignored += 1;
  }
  return {
    changes,
    rejected: (payload.rejected || []).map((entry) => ({ ...entry, field: byId.get(entry.id)?.field || entry.id })),
    ignored,
    summary: payload.summary || '',
    model: payload.model || '',
  };
}

/** The current value of a copy item in the document, or undefined when it no longer exists. */
function readValue(doc: BuilderDocument, change: CopyItem): string | undefined {
  const node = findNode(doc, change.nodeId) as WidgetNode | null;
  if (!node || node.kind !== 'widget') return undefined;
  const value = node.settings?.[change.key];
  if (change.itemIndex === undefined) return typeof value === 'string' ? value : undefined;
  const entry = Array.isArray(value) ? value[change.itemIndex] as Record<string, unknown> | undefined : undefined;
  const fieldValue = entry?.[change.itemField || ''];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

/**
 * Writes accepted changes into the document. Pure: returns a new document that shares every
 * untouched node, so other sections keep their identity and do not re-render. Changes whose field
 * was edited after the AI read it are skipped rather than overwriting that edit.
 */
export function applyCopyChanges(doc: BuilderDocument, changes: CopyChange[]): { doc: BuilderDocument; applied: number; stale: number } {
  let next = doc;
  let applied = 0;
  let stale = 0;
  for (const change of changes) {
    if (readValue(next, change) !== change.text) {
      stale += 1;
      continue;
    }
    next = updateNode(next, change.nodeId, (node: BuilderNode) => {
      const settings = { ...node.settings };
      if (change.itemIndex === undefined) {
        settings[change.key] = change.after;
      } else {
        const list = [...(settings[change.key] as Array<Record<string, unknown>>)];
        list[change.itemIndex] = { ...list[change.itemIndex], [change.itemField!]: change.after };
        settings[change.key] = list;
      }
      return { ...node, settings };
    });
    applied += 1;
  }
  return { doc: next, applied, stale };
}

export const previewText = (item: Pick<CopyItem, 'format' | 'text'>, value = item.text) => (item.format === 'html' ? stripTags(value) : value);

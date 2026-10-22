import { getSupabaseClient } from '../../../src/lib/db';
import { sanitizeHtml } from '../../../src/components/ContentRenderer';
import { safeMediaUrl, safeUrl } from '../lib/sanitize';
import { walkNodes } from '../lib/tree';
import type { BuilderNode, SectionNode, WidgetNode } from '../lib/types';

/**
 * "AI Page Generator": sends a brief, a text file and a handful of media references to the server,
 * which asks the configured provider for a complete page and returns a sanitized layout tree.
 *
 * The server builds the tree from a small, flat description; this module repeats the URL and HTML
 * checks on the client, because applying a generated page is still an ordinary edit of untrusted
 * data. It also keeps the UI's outline preview free of empty or malformed sections.
 */

export type PageAiTone = 'professional' | 'friendly' | 'bold' | 'premium' | 'playful';
export type PageAiStyle = 'modern' | 'minimal' | 'bold' | 'elegant' | 'editorial';

export interface PageAiMedia {
  url: string;
  title?: string;
  alt?: string;
}

export interface PageAiInput {
  prompt: string;
  fileName?: string;
  fileContent?: string;
  pageTitle?: string;
  tone: PageAiTone;
  stylePreset: PageAiStyle;
  media: PageAiMedia[];
  colors?: { primary?: string; secondary?: string; text?: string; accent?: string };
}

export interface PageAiResult {
  title: string;
  summary: string;
  model: string;
  sections: SectionNode[];
}

export interface PageAiOutline {
  label: string;
  columns: number;
  widgets: string[];
}

interface PageAiPayload {
  title?: unknown;
  summary?: unknown;
  model?: unknown;
  sections?: unknown;
  error?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const widgetName = (type: string) => type.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/** Apply the editor's own URL and HTML rules to every value a generated widget renders. */
function sanitizeSections(sections: SectionNode[]): SectionNode[] {
  walkNodes(sections, (node: BuilderNode) => {
    if (node.kind !== 'widget') return;
    const widget = node as WidgetNode;
    const settings = widget.settings || {};
    if (widget.type === 'text' && typeof settings.html === 'string') settings.html = sanitizeHtml(settings.html);
    if (widget.type === 'image') {
      settings.image = safeMediaUrl(settings.image);
      if (settings.linkTo === 'custom' && typeof settings.link === 'object' && settings.link) {
        settings.link = { ...(settings.link as Record<string, unknown>), url: safeUrl((settings.link as Record<string, unknown>).url) };
      }
    }
    if (widget.type === 'cta') {
      settings.image = safeMediaUrl(settings.image);
      if (typeof settings.link === 'object' && settings.link) {
        settings.link = { ...(settings.link as Record<string, unknown>), url: safeUrl((settings.link as Record<string, unknown>).url) };
      }
    }
    if (widget.type === 'button' && typeof settings.link === 'object' && settings.link) {
      settings.link = { ...(settings.link as Record<string, unknown>), url: safeUrl((settings.link as Record<string, unknown>).url) };
    }
    if (widget.type === 'icon' && typeof settings.link === 'object' && settings.link) {
      settings.link = { ...(settings.link as Record<string, unknown>), url: safeUrl((settings.link as Record<string, unknown>).url) };
    }
    if (widget.type === 'testimonial' && settings.image) settings.image = safeMediaUrl(settings.image);
    if (widget.type === 'video') {
      settings.url = safeUrl(settings.url);
      settings.poster = safeMediaUrl(settings.poster);
    }
  });
  // Section background images are URLs too.
  for (const section of sections) {
    const desktop = asRecord(section.style?.desktop);
    const background = asRecord(desktop.background);
    if (background.image) background.image = safeMediaUrl(background.image);
  }
  return sections;
}

/** Generate a complete page. Only the fields the server understands leave the browser. */
export async function generatePage(input: PageAiInput): Promise<PageAiResult> {
  const prompt = input.prompt.trim();
  if (!prompt && !input.fileContent?.trim()) throw new Error('Describe the page you want, or attach a source file.');

  const { data } = await getSupabaseClient().auth.getSession();
  let response: Response;
  try {
    response = await fetch('/api/plugins/rwp-page-builder/ai/page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
      body: JSON.stringify({
        prompt,
        fileName: input.fileName || '',
        fileContent: input.fileContent || '',
        pageTitle: input.pageTitle || '',
        tone: input.tone,
        stylePreset: input.stylePreset,
        media: input.media.slice(0, 12).map((item) => ({ url: item.url, title: item.title || '', alt: item.alt || '' })),
        colors: input.colors || {},
      }),
    });
  } catch {
    throw new Error('Could not reach the site server. If you are using npm run dev, npm start must also be running on port 3000.');
  }

  const payload = await response.json().catch(() => null) as PageAiPayload | null;
  if (!response.ok || !payload) {
    const message = typeof payload?.error === 'string' ? payload.error : `The AI request failed (HTTP ${response.status}). If you are using npm run dev, npm start must also be running on port 3000.`;
    throw new Error(message);
  }

  // The server already normalizes the tree; re-checking every field that carries a URL or HTML here
  // means a malformed or tampered response cannot smuggle either into the document.
  const sections = sanitizeSections(
    (Array.isArray(payload.sections) ? payload.sections : [])
      .filter((section): section is SectionNode => asRecord(section).kind === 'section' && Array.isArray(asRecord(section).children))
      .map((section) => JSON.parse(JSON.stringify(section)) as SectionNode),
  ).filter((section) => section.children.some((column) => Array.isArray(column.children) && column.children.length > 0));

  if (!sections.length) throw new Error('The AI did not return a usable layout. Try a more specific brief, then generate again.');

  return {
    title: typeof payload.title === 'string' ? payload.title : '',
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    model: typeof payload.model === 'string' ? payload.model : '',
    sections,
  };
}

/** Navigator-style outline: the shortest useful description of what is about to be inserted. */
export function pageAiOutline(sections: SectionNode[]): PageAiOutline[] {
  return sections.map((section, index) => {
    const widgets: string[] = [];
    for (const column of section.children) {
      for (const node of column.children) {
        if (node.kind === 'widget') widgets.push(node.label || widgetName(node.type));
      }
    }
    return {
      label: section.label || `Section ${index + 1}`,
      columns: section.children.length,
      widgets,
    };
  });
}

export function countPageWidgets(sections: SectionNode[]): number {
  let count = 0;
  walkNodes(sections, (node) => {
    if (node.kind === 'widget') count += 1;
  });
  return count;
}


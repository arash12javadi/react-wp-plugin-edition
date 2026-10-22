import { getSupabaseClient } from '../../../src/lib/db';
import { findNode, updateNode } from '../lib/tree';
import type { BuilderDocument, BuilderNode } from '../lib/types';

/** The four code fields a Custom HTML widget can have. React mode uses jsx + css. */
export const codeFields = ['html', 'css', 'js', 'jsx'] as const;
export type CodeField = (typeof codeFields)[number];
export type CodeFieldSet = Partial<Record<CodeField, string>>;
export type CodeMode = 'html' | 'react';

export const fieldLabels: Record<CodeField, string> = {
  html: 'HTML',
  css: 'CSS',
  js: 'JavaScript',
  jsx: 'React (JSX)',
};

/** The fields the widget actually uses in a mode; mirrors render/widgets/pro.tsx. */
export function fieldsForMode(mode: CodeMode): CodeField[] {
  return mode === 'react' ? ['jsx', 'css'] : ['html', 'css', 'js'];
}

export function modeOf(node: BuilderNode): CodeMode {
  return node.kind === 'widget' && node.settings.mode === 'react' ? 'react' : 'html';
}

/** A field's current value, treating missing and non-string values as empty code. */
export function readCodeField(node: BuilderNode, field: CodeField): string {
  const value = node.kind === 'widget' ? node.settings[field] : undefined;
  return typeof value === 'string' ? value : '';
}

export interface CodeAiResult {
  /** Only the fields the AI changed, with their complete new values. */
  fields: CodeFieldSet;
  summary: string;
  model: string;
}

/**
 * Asks the site server for a rewritten version of one Custom HTML widget.
 *
 * Only the code of the active mode leaves the browser: no layout JSON, no page content and no
 * settings. The server validates it again and needs an administrator, because this code runs in
 * every visitor's browser.
 */
export async function generateCodeEdit(input: {
  mode: CodeMode;
  fields: CodeFieldSet;
  instruction: string;
  pageTitle: string;
  signal?: AbortSignal;
}): Promise<CodeAiResult> {
  const { data } = await getSupabaseClient().auth.getSession();
  let response: Response;
  try {
    response = await fetch('/api/plugins/rwp-page-builder/ai/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
      body: JSON.stringify({
        mode: input.mode,
        fields: input.fields,
        instruction: input.instruction,
        pageTitle: input.pageTitle,
      }),
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('The AI request was cancelled.');
    throw new Error('Could not reach the site server. If you are using npm run dev, npm start must also be running on port 3000.');
  }

  const payload = await response.json().catch(() => null) as {
    fields?: Record<string, unknown>;
    summary?: string;
    model?: string;
    error?: string;
  } | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `The AI request failed (HTTP ${response.status}). If you are using npm run dev, npm start must also be running on port 3000.`);
  }

  const fields: CodeFieldSet = {};
  for (const field of fieldsForMode(input.mode)) {
    const value = payload.fields?.[field];
    // An empty string is a real change (the AI cleared the field), so do not filter it out.
    if (typeof value === 'string') fields[field] = value;
  }
  return { fields, summary: payload.summary || '', model: payload.model || '' };
}

/**
 * Applies AI replacements to the document without touching a field the editor changed while the
 * request was in flight. Returns how many fields were written and how many were left alone.
 *
 * The store wraps this in one commit, so Ctrl+Z reverts every field at once.
 */
export function applyCodeFields(
  doc: BuilderDocument,
  nodeId: string,
  nextFields: CodeFieldSet,
  originals: CodeFieldSet,
): { doc: BuilderDocument; applied: number; stale: number } {
  const node = findNode(doc, nodeId);
  if (!node || node.kind !== 'widget' || node.type !== 'html') return { doc, applied: 0, stale: 0 };

  const changes: CodeFieldSet = {};
  let stale = 0;
  for (const field of codeFields) {
    const next = nextFields[field];
    const original = originals[field];
    if (next === undefined || original === undefined) continue;
    if (readCodeField(node, field) !== original) {
      stale += 1;
      continue;
    }
    changes[field] = next;
  }

  const applied = Object.keys(changes).length;
  if (!applied) return { doc, applied, stale };
  return {
    doc: updateNode(doc, nodeId, (target) => ({ ...target, settings: { ...target.settings, ...changes } })),
    applied,
    stale,
  };
}

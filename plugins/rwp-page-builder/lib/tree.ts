import type { BuilderDocument, BuilderNode, ColumnNode, NodeKind, ParentNode, SectionNode } from './types';
import { isSet, percentWidth } from './style';

/** Short, CSS-class-safe ids. Collisions only matter within one document. */
export const newId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export const ROOT_ID = 'root';

export const childrenOf = (node: BuilderNode): BuilderNode[] =>
  node.kind === 'widget' ? [] : (node.children as BuilderNode[]);

export function findNode(doc: BuilderDocument, id: string): BuilderNode | null {
  const walk = (nodes: BuilderNode[]): BuilderNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = walk(childrenOf(node));
      if (found) return found;
    }
    return null;
  };
  return walk(doc.content);
}

export interface NodeLocation {
  parentId: string;
  index: number;
  /** Ancestors from the root down, excluding the node itself. */
  ancestors: BuilderNode[];
}

export function locate(doc: BuilderDocument, id: string): NodeLocation | null {
  const walk = (nodes: BuilderNode[], parentId: string, ancestors: BuilderNode[]): NodeLocation | null => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.id === id) return { parentId, index, ancestors };
      const found = walk(childrenOf(node), node.id, [...ancestors, node]);
      if (found) return found;
    }
    return null;
  };
  return walk(doc.content, ROOT_ID, []);
}

export const isDescendant = (node: BuilderNode, id: string): boolean =>
  childrenOf(node).some((child) => child.id === id || isDescendant(child, id));

/** Rebuilds only the path to changed nodes, so unchanged subtrees keep their identity for React.memo. */
function mapChildren(doc: BuilderDocument, parentId: string, map: (children: BuilderNode[]) => BuilderNode[]): BuilderDocument {
  if (parentId === ROOT_ID) return { ...doc, content: map(doc.content) as SectionNode[] };
  const walk = (nodes: BuilderNode[]): [BuilderNode[], boolean] => {
    let changed = false;
    const next = nodes.map((node) => {
      if (changed || node.kind === 'widget') return node;
      if (node.id === parentId) {
        changed = true;
        return { ...node, children: map(node.children as BuilderNode[]) } as BuilderNode;
      }
      const [children, childChanged] = walk(node.children as BuilderNode[]);
      if (!childChanged) return node;
      changed = true;
      return { ...node, children } as BuilderNode;
    });
    return [changed ? next : nodes, changed];
  };
  const [content] = walk(doc.content);
  return { ...doc, content: content as SectionNode[] };
}

export function updateNode(doc: BuilderDocument, id: string, update: (node: BuilderNode) => BuilderNode): BuilderDocument {
  const location = locate(doc, id);
  if (!location) return doc;
  return mapChildren(doc, location.parentId, (children) =>
    children.map((child) => (child.id === id ? update(child) : child)));
}

export function removeNode(doc: BuilderDocument, id: string): BuilderDocument {
  const location = locate(doc, id);
  if (!location) return doc;
  return mapChildren(doc, location.parentId, (children) => children.filter((child) => child.id !== id));
}

export function insertNode(doc: BuilderDocument, parentId: string, index: number, node: BuilderNode): BuilderDocument {
  return mapChildren(doc, parentId, (children) => {
    const next = [...children];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
    return next;
  });
}

/** Which kinds may sit directly inside a parent. The root is a list of sections. */
export function canContain(parentKind: NodeKind | 'root', child: BuilderNode, parentDepth: number): boolean {
  if (parentKind === 'root') return child.kind === 'section';
  if (parentKind === 'section') return child.kind === 'column';
  if (parentKind === 'column') {
    if (child.kind === 'widget') return true;
    // Inner sections nest one level only, and must not themselves contain inner sections.
    return child.kind === 'section' && parentDepth < 2
      && !child.children.some((column) => column.children.some((item) => item.kind === 'section'));
  }
  return false;
}

/** Depth of a node in sections: a top-level column is 1, a column in an inner section is 2. */
export function sectionDepth(doc: BuilderDocument, id: string): number {
  if (id === ROOT_ID) return 0;
  const location = locate(doc, id);
  if (!location) return 0;
  const self = findNode(doc, id);
  return [...location.ancestors, ...(self ? [self] : [])].filter((node) => node.kind === 'section').length;
}

export function moveNode(doc: BuilderDocument, id: string, parentId: string, index: number): BuilderDocument {
  const node = findNode(doc, id);
  const from = locate(doc, id);
  if (!node || !from) return doc;
  if (parentId === id || isDescendant(node, parentId)) return doc;
  // Removing first shifts later siblings left when moving within the same parent.
  const adjusted = from.parentId === parentId && from.index < index ? index - 1 : index;
  if (from.parentId === parentId && from.index === adjusted) return doc;
  return insertNode(removeNode(doc, id), parentId, adjusted, node);
}

export interface PasteLocation {
  parentId: string;
  index: number;
}

/**
 * Picks where a pasted node goes when `targetId` is selected.
 *
 * Preference order:
 *  1. inside the selected container (a section takes columns, a column takes widgets/sections),
 *  2. directly beside the selection,
 *  3. beside the closest ancestor that can hold it,
 *  4. at the end of the page (sections) or in the last suitable container (widgets/columns).
 *
 * Every candidate goes through `canContain`, so pasting a section into an inner column cannot
 * create a third level of nesting. Null means the document has no container for the node yet;
 * the caller wraps it in a new section, exactly as dropping it on empty canvas would.
 */
export function pasteLocation(doc: BuilderDocument, node: BuilderNode, targetId: string | null): PasteLocation | null {
  const accepts = (parentId: string): boolean => {
    const parentKind = parentKindOf(doc, parentId);
    if (!parentKind) return false;
    // A section holds at most six columns, matching addColumn.
    if (node.kind === 'column' && parentKind === 'section') {
      const section = findNode(doc, parentId);
      if (section?.kind === 'section' && section.children.length >= 6) return false;
    }
    return canContain(parentKind, node, sectionDepth(doc, parentId));
  };

  const beside = (reference: BuilderNode): PasteLocation | null => {
    const location = locate(doc, reference.id);
    return location && accepts(location.parentId) ? { parentId: location.parentId, index: location.index + 1 } : null;
  };

  const target = targetId ? findNode(doc, targetId) : null;
  if (target) {
    if (target.kind !== 'widget' && accepts(target.id)) {
      return { parentId: target.id, index: target.children.length };
    }
    // A widget pasted onto a section belongs in one of its columns.
    if (target.kind === 'section' && node.kind === 'widget' && target.children.length) {
      const column = target.children[target.children.length - 1];
      if (accepts(column.id)) return { parentId: column.id, index: column.children.length };
    }
    const next = beside(target);
    if (next) return next;
    // The selection's own parent may not accept the copy, but a container above it can.
    const location = locate(doc, target.id);
    const chain = location ? [...location.ancestors, target] : [];
    for (let index = chain.length - 2; index >= 0; index -= 1) {
      const container = chain[index];
      if (container.kind === 'widget' || !accepts(container.id)) continue;
      const child = chain[index + 1];
      const childLocation = locate(doc, child.id);
      return { parentId: container.id, index: childLocation ? childLocation.index + 1 : childrenOf(container).length };
    }
  }

  if (node.kind === 'section') return { parentId: ROOT_ID, index: doc.content.length };

  if (node.kind === 'column') {
    for (let index = doc.content.length - 1; index >= 0; index -= 1) {
      const section = doc.content[index];
      if (accepts(section.id)) return { parentId: section.id, index: section.children.length };
    }
    return null;
  }

  // Widgets: the last column of the page, so pasting with nothing selected still lands somewhere.
  for (let index = doc.content.length - 1; index >= 0; index -= 1) {
    const section = doc.content[index];
    for (let columnIndex = section.children.length - 1; columnIndex >= 0; columnIndex -= 1) {
      const column = section.children[columnIndex];
      if (accepts(column.id)) return { parentId: column.id, index: column.children.length };
    }
  }
  return null;
}

/** Deep copy with fresh ids, so a duplicate or an inserted template never shares CSS classes. */
export function cloneWithNewIds<T extends BuilderNode>(node: T): T {
  const copy = JSON.parse(JSON.stringify(node)) as BuilderNode;
  const walk = (item: BuilderNode) => {
    item.id = newId();
    // Form fields keep their ids (they name submitted values), but the form itself is new.
    childrenOf(item).forEach(walk);
  };
  walk(copy);
  return copy as T;
}

export function duplicateNode(doc: BuilderDocument, id: string): { doc: BuilderDocument; newId: string | null } {
  const node = findNode(doc, id);
  const location = locate(doc, id);
  if (!node || !location) return { doc, newId: null };
  const copy = cloneWithNewIds(node);
  return { doc: insertNode(doc, location.parentId, location.index + 1, copy), newId: copy.id };
}

/** Columns in a section always add up to 100%. Used after adding or removing a column. */
export function rebalanceColumns(section: SectionNode): SectionNode {
  const width = Math.round((100 / Math.max(1, section.children.length)) * 1000) / 1000;
  return {
    ...section,
    children: section.children.map((column: ColumnNode) => {
      const desktop = column.style.desktop || {};
      // A column with a fixed width (px, em, rem, vw) keeps it; only percentage shares are re-dealt.
      if (isSet(desktop.width) && percentWidth(desktop.width) === undefined) return column;
      return { ...column, style: { ...column.style, desktop: { ...desktop, width } } };
    }),
  };
}

export const parentKindOf = (doc: BuilderDocument, parentId: string): NodeKind | 'root' | null => {
  if (parentId === ROOT_ID) return 'root';
  const parent = findNode(doc, parentId);
  return parent ? parent.kind : null;
};

export function walkNodes(nodes: BuilderNode[], visit: (node: BuilderNode, parent: ParentNode | null) => void, parent: ParentNode | null = null) {
  nodes.forEach((node) => {
    visit(node, parent);
    if (node.kind !== 'widget') walkNodes(node.children as BuilderNode[], visit, node);
  });
}

import { getWidget } from '../lib/registry';
import { safeCustomCss } from '../lib/sanitize';
import {
  background, border, boxSides, color, effectiveBag, isSet, length, percentWidth, serializeRules, shadow, size,
  type Background, type Border, type Box, type CssRules, type Shadow, type SizeValue,
} from '../lib/style';
import { walkNodes } from '../lib/tree';
import type { BuilderDocument, BuilderNode, ColumnNode, Device, ParentNode, SectionNode, StyleBag, WidgetNode } from '../lib/types';

/** Elementor's breakpoints: tablet ≤ 1024px, mobile ≤ 767px. */
export const breakpoints = { tablet: 1024, mobile: 767 };

const merge = (target: CssRules, source: CssRules) => {
  Object.entries(source).forEach(([suffix, declarations]) => {
    target[suffix] = { ...(target[suffix] || {}), ...declarations };
  });
  return target;
};

const alignItems: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end', stretch: 'stretch' };
const justify: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end', 'space-between': 'space-between' };

function commonRules(node: BuilderNode, bag: StyleBag, device: Device, editing: boolean): CssRules {
  const bg = bag.background as Background | undefined;
  const rules: CssRules = {
    '': {
      ...boxSides('margin', bag.margin as Box | undefined),
      ...boxSides('padding', bag.padding as Box | undefined),
      ...background(bg),
      ...border(bag.border as Border | undefined),
      'box-shadow': shadow(bag.boxShadow as Shadow | undefined),
      'z-index': isSet(bag.zIndex) ? Number(bag.zIndex) : undefined,
    },
  };
  if (bg?.overlayColor) {
    rules[' > .rwpb-overlay'] = {
      'background-color': color(bg.overlayColor),
      opacity: isSet(bg.overlayOpacity) ? Number(bg.overlayOpacity) : 0.5,
    };
  }
  const { advanced = {} } = node;
  if (advanced.sticky) {
    rules[''] = { ...rules[''], position: 'sticky', top: `${Number(advanced.stickyOffset) || 0}px`, 'z-index': isSet(bag.zIndex) ? Number(bag.zIndex) : 20 };
  }
  if (advanced.hideOn?.[device]) {
    // In the editor, hidden elements stay selectable but faded, as in Elementor.
    rules[''] = editing ? { ...rules[''], opacity: 0.35, filter: 'grayscale(1)' } : { ...rules[''], display: 'none' };
  } else if (!editing && advanced.hideOn && Object.values(advanced.hideOn).some(Boolean)) {
    // Explicit, so "hidden on desktop" does not carry into the tablet media query.
    rules[''] = { ...rules[''], display: node.kind === 'widget' ? 'block' : 'flex' };
  }
  return rules;
}

const stacksAt = (section: SectionNode, device: Device) => {
  const stackOn = String(section.settings.stackOn || 'mobile');
  if (device === 'mobile') return stackOn !== 'none';
  if (device === 'tablet') return stackOn === 'tablet';
  return false;
};

function sectionRules(section: SectionNode, bag: StyleBag, device: Device): CssRules {
  const boxed = section.settings.layout !== 'full';
  const heightMode = String(bag.heightMode || 'auto');
  return {
    '': {
      'min-height': heightMode === 'screen' ? '100vh' : heightMode === 'min' ? size(bag.minHeight as SizeValue | undefined) : undefined,
      'justify-content': justify[String(bag.contentPosition || '')],
    },
    ' > .rwpb-container': {
      'max-width': boxed ? size(bag.contentWidth ?? 1140, 'px') : 'none',
      gap: length(bag.gap ?? 20, 'px'),
      'align-items': alignItems[String(bag.verticalAlign || 'stretch')],
      'flex-wrap': stacksAt(section, device) ? 'wrap' : 'nowrap',
      'flex-direction': stacksAt(section, device) && section.settings.reverseStack ? 'column-reverse' : undefined,
    },
  };
}

/** The width saved for this column at this device, or undefined to share the row evenly. */
function columnWidthValue(column: ColumnNode, section: SectionNode, device: Device): unknown {
  if (stacksAt(section, device)) {
    // Stacked columns start from full width; only widths set for a stacked device apply.
    const order: Device[] = String(section.settings.stackOn) === 'tablet' ? ['tablet', 'mobile'] : ['mobile'];
    let width: unknown;
    for (const item of order) {
      const own = column.style[item]?.width;
      if (isSet(own)) width = own;
      if (item === device) break;
    }
    return width;
  }
  return effectiveBag(column.style, device).width;
}

/** Widths add to 100%; each column gives up its share of the gaps so the row fits exactly. */
function percentColumnWidth(width: number, gap: number): string {
  return gap && width < 100 ? `calc(${width}% - ${Math.round(gap * (100 - width)) / 100}px)` : `${width}%`;
}

function columnRules(column: ColumnNode, section: SectionNode, bag: StyleBag, device: Device): CssRules {
  const gap = Number(effectiveBag(section.style, device).gap ?? 20);
  const even = stacksAt(section, device) ? 100 : 100 / Math.max(1, section.children.length);
  const saved = columnWidthValue(column, section, device);
  // A bare number (the old Width (%) control) and a "%" value share the row; a fixed unit (px, em,
  // rem, vw) is used as-is, and the other columns share what is left.
  const percent = isSet(saved) ? percentWidth(saved) : even;
  const width = percent === undefined
    ? size(saved as SizeValue | number | string)
    : percentColumnWidth(Math.max(1, Math.min(100, percent)), gap);
  return {
    '': { width: width || `${even}%` },
    ' > .rwpb-column-inner': {
      'justify-content': justify[String(bag.verticalAlign || '')],
      gap: length(bag.widgetGap ?? 16, 'px'),
    },
  };
}

function nodeRules(node: BuilderNode, parent: ParentNode | null, device: Device, editing: boolean): CssRules {
  const bag = effectiveBag(node.style, device);
  const rules = commonRules(node, bag, device, editing);
  if (node.kind === 'section') merge(rules, sectionRules(node, bag, device));
  else if (node.kind === 'column' && parent?.kind === 'section') merge(rules, columnRules(node, parent, bag, device));
  else if (node.kind === 'widget') {
    const definition = getWidget(node.type);
    if (definition?.css) merge(rules, definition.css(bag, node as WidgetNode, device));
  }
  return rules;
}

/**
 * Declarations that changed since the larger device, so media queries carry only overrides.
 * A declaration that disappears (e.g. min-height when the height mode goes back to auto) is
 * reset with "unset", or the larger device's value would leak through.
 */
function diffRules(current: CssRules, previous: CssRules): CssRules {
  const result: CssRules = {};
  const suffixes = new Set([...Object.keys(previous), ...Object.keys(current)]);
  suffixes.forEach((suffix) => {
    const now = current[suffix] || {};
    const before = previous[suffix] || {};
    const changed: Record<string, string | number> = {};
    new Set([...Object.keys(before), ...Object.keys(now)]).forEach((property) => {
      const value = now[property];
      const old = before[property];
      if (isSet(value)) {
        if (String(value) !== String(old ?? '')) changed[property] = value as string | number;
      } else if (isSet(old)) {
        changed[property] = 'unset';
      }
    });
    if (Object.keys(changed).length) result[suffix] = changed;
  });
  return result;
}

export interface CssOptions {
  /** Render one device without media queries (the editor canvas). Omit for the public site. */
  device?: Device;
  scope?: string;
}

/** The word that stands for the element the CSS was typed on. */
const KEYWORD = 'selector';

/** Characters that continue a CSS identifier, so `selector-row` and `my-selector` are other names. */
const identChar = /[\w\u00A0-\uFFFF-]/;

const startsLiteral = (css: string, index: number) => css[index] === '"' || css[index] === "'" || css.startsWith('/*', index);

/** Past the comment or quoted string that starts here, so braces and words inside it stay literal. */
function skipLiteral(css: string, index: number): number {
  if (css.startsWith('/*', index)) {
    const end = css.indexOf('*/', index + 2);
    return end === -1 ? css.length : end + 2;
  }
  const quote = css[index];
  let position = index + 1;
  while (position < css.length) {
    if (css[position] === '\\') position += 2;
    else if (css[position] === quote) return position + 1;
    else position += 1;
  }
  return css.length;
}

/**
 * One rule prelude. Bare `selector`, `.selector` and `#selector` all stand for the scoped element,
 * and the `.`/`#` is consumed with the word so nothing turns into `..rwpb-n-1`. The word only counts
 * when it stands alone, so `.selector-row`, `[data-selector]` and `my-selector` keep their own
 * meaning: rewriting those produced `.rwpb-n-1-row` and `[data-…]` instead, and a browser drops a
 * rule it cannot parse without saying a word. Comments and strings in a selector are copied as they
 * are, so `[data-x="selector"]` stays a lookup for that value.
 */
function scopePrelude(prelude: string, scope: string): string {
  let out = '';
  let index = 0;
  while (index < prelude.length) {
    if (startsLiteral(prelude, index)) {
      const end = skipLiteral(prelude, index);
      out += prelude.slice(index, end);
      index = end;
      continue;
    }
    if (!prelude.startsWith(KEYWORD, index)) {
      out += prelude[index];
      index += 1;
      continue;
    }
    const before = prelude[index - 1];
    const after = prelude[index + KEYWORD.length];
    const standsAlone = before !== '\\'
      && (before === undefined || !identChar.test(before))
      && (after === undefined || !identChar.test(after));
    if (standsAlone) {
      // The typeable prefix is part of the word: `.selector` and `selector` mean the same element.
      out = before === '.' || before === '#' ? out.slice(0, -1) : out;
      out += scope;
    } else {
      out += KEYWORD;
    }
    index += KEYWORD.length;
  }
  return out;
}

/** The `}` that closes the block opening at `open`, or the end of the text when it is never closed. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < css.length) {
    if (startsLiteral(css, index)) {
      index = skipLiteral(css, index);
      continue;
    }
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      if (!depth) return index;
      depth -= 1;
    }
    index += 1;
  }
  return css.length;
}

/**
 * Scopes every rule of one stylesheet, whatever it sits in. Declarations, comments and strings are
 * copied through untouched, so `content: "selector"` and `url(selector.png)` keep their text, and an
 * at-rule keeps its own prelude because `@supports selector(:has(a))` is valid CSS rather than a
 * selector — only the blocks it holds are scoped.
 */
function scopeRules(css: string, scope: string): string {
  let out = '';
  let index = 0;
  let start = 0;
  while (index < css.length) {
    if (startsLiteral(css, index)) {
      index = skipLiteral(css, index);
      continue;
    }
    const char = css[index];
    if (char === ';' || char === '}') {
      out += css.slice(start, index + 1);
      index += 1;
      start = index;
      continue;
    }
    if (char !== '{') {
      index += 1;
      continue;
    }
    const prelude = css.slice(start, index);
    const end = blockEnd(css, index);
    const closed = end < css.length;
    const body = css.slice(index + 1, closed ? end : css.length);
    const head = prelude.trimStart().startsWith('@') ? prelude : scopePrelude(prelude, scope);
    out += `${head}{${scopeRules(body, scope)}${closed ? '}' : ''}`;
    index = closed ? end + 1 : css.length;
    start = index;
  }
  return out + css.slice(start);
}

/**
 * Custom CSS is scoped to the element it was typed on: the word `selector` stands for that element,
 * and `.selector` / `#selector` are accepted too because that is the shape people type first.
 */
export const scopeCustomCss = (value: unknown, scope: string): string => scopeRules(safeCustomCss(value), scope);

export function generateCss(doc: BuilderDocument, { device, scope = '.rwpb-root' }: CssOptions = {}): string {
  const out = { desktop: [] as string[], tablet: [] as string[], mobile: [] as string[], custom: [] as string[] };
  const editing = Boolean(device);

  walkNodes(doc.content, (node, parent) => {
    const selector = `${scope} .rwpb-n-${node.id}`;
    if (device) {
      out.desktop.push(serializeRules(selector, nodeRules(node, parent, device, true)));
    } else {
      const desktop = nodeRules(node, parent, 'desktop', editing);
      const tablet = nodeRules(node, parent, 'tablet', editing);
      const mobile = nodeRules(node, parent, 'mobile', editing);
      out.desktop.push(serializeRules(selector, desktop));
      out.tablet.push(serializeRules(selector, diffRules(tablet, desktop)));
      out.mobile.push(serializeRules(selector, diffRules(mobile, tablet)));
    }
    if (node.advanced?.customCss) {
      out.custom.push(scopeCustomCss(node.advanced.customCss, selector));
    }
  });

  const documentRules = serializeRules(scope, { '': { background: doc.settings.background ? color(doc.settings.background) : undefined } });
  const documentCss = doc.settings.customCss ? scopeCustomCss(doc.settings.customCss, scope) : '';
  const tablet = out.tablet.join('');
  const mobile = out.mobile.join('');
  return [
    documentRules,
    out.desktop.join(''),
    tablet && `@media (max-width:${breakpoints.tablet}px){${tablet}}`,
    mobile && `@media (max-width:${breakpoints.mobile}px){${mobile}}`,
    out.custom.join('\n'),
    documentCss,
  ].filter(Boolean).join('\n');
}

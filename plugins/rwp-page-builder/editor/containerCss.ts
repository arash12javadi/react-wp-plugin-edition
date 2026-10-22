/**
 * The canvas lays the page out at the width of the device being previewed (see Canvas.tsx), but a
 * media query measures the browser window. On Desktop those are the same width, so the author's
 * breakpoints agree with the width they are answering for; in the Tablet and Mobile previews they
 * do not, and a `@media (min-width: 720px)` block lays a row of cards out inside a 375px frame.
 *
 * So the canvas wraps the page in a query container (`.canvasSite` in editor.module.css) and every
 * width query in the stylesheets it injects is rewritten to ask that container instead: the rules
 * then answer for the width they are really laying out at, and switching the preview device is
 * enough to switch them.
 *
 * Only pure width queries are rewritten. A query that also asks about height, orientation, hover,
 * a colour scheme or print describes the device or the window rather than the box the page is drawn
 * in, and a container query cannot answer it, so such a block keeps its `@media`. `not` and the `,`
 * (either/or) form are left alone for the same reason.
 */

/** The query container editor.module.css puts around the page in the canvas. */
export const canvasContainer = 'rwpb-canvas';

/** A condition that is only about the inline size: `(min-width: 720px)`, `(width >= 40rem)`. */
const widthFeature = /^(?:min-|max-)?(?:width|inline-size)\s*:|^(?:width|inline-size)\s*(?:<=|>=|<|>|=)/i;
/** Both ends at once: `(400px <= width <= 900px)`, the range form of the same question. */
const widthRange = /^\S+\s*(?:<=|>=|<|>)\s*(?:width|inline-size)\s*(?:<=|>=|<|>)\s*\S+$/i;
const bareWidth = /^(?:min-|max-)?(?:width|inline-size)$/i;

const isWidthFeature = (condition: string) => {
  const text = condition.trim();
  return bareWidth.test(text) || widthFeature.test(text) || widthRange.test(text);
};

/** A comment or a quoted string starts here, so braces and parentheses inside it are text. */
const literalStart = (css: string, index: number) => css[index] === '"' || css[index] === "'" || css.startsWith('/*', index);

/**
 * Whitespace and comments: what a prelude may carry before its selector or at-rule. Authors often
 * put a banner comment above a breakpoint block, and that comment is part of the prelude, so the
 * at-rule has to be looked for past it.
 */
const preludeLead = /^(?:\s|\/\*[\s\S]*?\*\/)*/;

/** Past the comment or quoted string that starts here, so braces inside it stay literal. */
function skipLiteral(css: string, index: number): number {
  if (css.startsWith('/*', index)) {
    const end = css.indexOf('*/', index + 2);
    return end === -1 ? css.length : end + 2;
  }
  const quote = css[index];
  for (let position = index + 1; position < css.length; position++) {
    if (css[position] === '\\') { position++; continue; }
    if (css[position] === quote) return position + 1;
  }
  return css.length;
}

/** The `}` that closes the block opening at `open`, or the end of the text when it is never closed. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length;) {
    if (literalStart(css, index)) { index = skipLiteral(css, index); continue; }
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
 * The `@container` condition for a media query prelude, or null when the block has to stay a media
 * query. Every parenthesised condition has to be a width, and nothing but `and` may join them.
 */
export function containerCondition(prelude: string): string | null {
  // `only` is a legacy hint no browser needs; `screen` and `all` are the media types a container
  // query stands for. `print`, `speech` and `not screen` have no container equivalent. Comments can
  // stand anywhere in a prelude, so they are blanked before the query is read.
  let condition = prelude.replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/^only\s+/i, '');
  const typed = /^([a-z-]+)\s*(?:and\s+)?/i.exec(condition);
  if (typed) {
    if (!/^(screen|all)$/i.test(typed[1])) return null;
    condition = condition.slice(typed[0].length);
  }
  if (!condition.trim()) return null;

  let depth = 0;
  let start = 0;
  let joiners = '';
  for (let index = 0; index < condition.length; index++) {
    const char = condition[index];
    if (char === '(') {
      if (!depth) start = index + 1;
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      // Unbalanced, or a condition that is about something other than the width.
      if (depth < 0 || (!depth && !isWidthFeature(condition.slice(start, index)))) return null;
      continue;
    }
    if (!depth) joiners += char;
  }
  if (depth) return null;
  // Between the conditions only `and` may appear: `,`, `or` and `not` cannot be expressed.
  if (joiners.replace(/\band\b/gi, '').trim()) return null;

  /*
   * In a media query `em` is the initial font size (16px); in a container query it would be the
   * container's own, which the page can change. Writing it out keeps the breakpoint where the
   * author put it. `rem` already means the root font size in both, so it is left alone.
   */
  return condition.trim().replace(/(\d*\.?\d+)em\b/g, (_, size: string) => `${Number(size) * 16}px`);
}

/**
 * Rewrites the width media queries of one stylesheet to container queries against the canvas frame.
 * Comments, strings and declarations are copied through untouched, and at-rules keep their own
 * preludes, so `@supports`, `@layer` and `@keyframes` come out as they went in.
 */
export function toContainerQueries(css: string): string {
  let out = '';
  let start = 0;
  for (let index = 0; index < css.length;) {
    if (literalStart(css, index)) { index = skipLiteral(css, index); continue; }
    const char = css[index];
    if (char === ';' || char === '}') {
      out += css.slice(start, index + 1);
      index += 1;
      start = index;
      continue;
    }
    if (char !== '{') { index += 1; continue; }
    const prelude = css.slice(start, index);
    const end = blockEnd(css, index);
    const closed = end < css.length;
    const body = css.slice(index + 1, closed ? end : css.length);
    // The comment in front of the block (if any) stays where it is, in front of the replacement.
    const lead = preludeLead.exec(prelude)![0];
    const atRule = prelude.slice(lead.length);
    const media = /^@media\b/i.exec(atRule);
    const condition = media ? containerCondition(atRule.slice(media[0].length)) : null;
    const head = condition ? `${lead}@container ${canvasContainer} ${condition}` : prelude;
    out += `${head}{${toContainerQueries(body)}${closed ? '}' : ''}`;
    index = closed ? end + 1 : css.length;
    start = index;
  }
  return out + css.slice(start);
}

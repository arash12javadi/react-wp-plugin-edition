/**
 * The site's Custom CSS (Appearance → Theme Editor), rewritten to apply inside the canvas only.
 *
 * The public site writes that CSS into <style id="rwp-theme-css"> from applyThemeDocument, and
 * App.tsx deliberately skips that bootstrap on /builder/… because the editor needs its own 13px
 * chrome. Without this the canvas previewed the site's colours, widths and padding but not what
 * the author had actually written for it.
 *
 * A style element is global wherever it sits in the tree, so this is a real rewrite, not a wrapper:
 * every rule gets the canvas element as its ancestor, and selectors that address the page root —
 * html, body, :root, .rwp-site (the div PublicLayout paints) and the .rwp-rtl/.rwp-ltr classes i18n
 * puts on <html> — address the canvas instead. At-rules a selector cannot prefix (@font-face,
 * @keyframes, @page …) stay global, exactly as they are on the live site; @import/@charset/@namespace
 * are dropped because they would load a global sheet.
 *
 * **The scoping must not change the cascade.** A plain `.canvasSite .card` prefix is one class more
 * specific than the author's `.card`, so a rule that loses to `.rwp-header.rwpt-row` or
 * `.rwpb-root img` on the site would win here and drag the canvas layout with it. Every ancestor
 * prefix is therefore `:where(...)`, which has zero specificity: the author's rules keep exactly the
 * weight they have in production. Root selectors keep the wrapper's class (a `body { font-size }`
 * has to beat the canvas baseline the way it beats the module rules on the site), and the wrapper
 * carries the direction class, so `.rwp-rtl …` still matches.
 *
 * Order matters as much as weight: production writes this stylesheet at the end of <head> and the
 * builder's generated element CSS into the body afterwards, so the generated rules win a tie. The
 * canvas renders <style data-rwpb-css="canvas-theme"> before <style data-rwpb-css="canvas"> for the
 * same reason.
 *
 * Two limits worth knowing:
 * - A width media query is rewritten to a container query on the canvas frame by toContainerQueries
 *   (containerCss.ts), which is what Canvas.tsx runs this output through, so the author's
 *   breakpoints answer for the width the page is laid out at. Queries that are not about the width
 *   (height, orientation, hover, a colour scheme, print) keep their `@media` and follow the window.
 * - A fixed-position rule stays fixed to the viewport; only its selector is scoped.
 */

/** One-based index just past the string that starts at `start`. */
function endOfString(css: string, start: number): number {
  const quote = css[start];
  for (let index = start + 1; index < css.length; index++) {
    if (css[index] === '\\') { index++; continue; }
    if (css[index] === quote) return index + 1;
  }
  return css.length;
}

/** At-rules that must not be prefixed (a selector means nothing there) but are safe to keep. */
const globalAtRules = new Set([
  'font-face', 'keyframes', '-webkit-keyframes', '-moz-keyframes', 'page', 'property',
  'counter-style', 'font-feature-values', 'font-palette-values', 'view-transition',
]);

/** At-rules that only make sense document-wide; scoping them is impossible, so they are dropped. */
const droppedAtRules = new Set(['import', 'charset', 'namespace']);

/** Index just past the `;` that ends the statement starting at `from`, or -1 if a block starts first. */
function endOfStatement(css: string, from: number): number {
  let depth = 0;
  for (let index = from; index < css.length; index++) {
    const char = css[index];
    if (char === '"' || char === "'") { index = endOfString(css, index) - 1; continue; }
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) return index + 1;
    else if (char === '{' || char === '}') return -1;
  }
  return -1;
}

/**
 * Drops `@import url(…)`, `@charset` and `@namespace`, which would load or address the whole
 * document. Removed up front because one of them before the first rule would otherwise become
 * part of that rule's prelude, and because they must not be matched inside a string.
 */
function stripDroppedAtRules(css: string): string {
  let out = '';
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === '"' || char === "'") {
      const end = endOfString(css, index);
      out += css.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === '@') {
      const name = /^@([\w-]+)/.exec(css.slice(index, index + 32))?.[1] ?? '';
      const end = droppedAtRules.has(name.toLowerCase()) ? endOfStatement(css, index) : -1;
      if (end !== -1) { index = end - 1; continue; }
    }
    out += char;
  }
  return out;
}

/** Selectors that mean "the page itself" on the live site; on the canvas the wrapper is the page. */
const rootSelectors = [':root', '.rwp-site', 'html', 'body'];

/** Classes i18n writes on <html>; the wrapper carries them too, so they are kept, not replaced. */
const rootClasses = ['.rwp-rtl', '.rwp-ltr'];

/** Comments carry braces and commas that would confuse the scanners below, and change nothing rendered. */
function stripComments(css: string): string {
  let out = '';
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === '"' || char === "'") {
      const end = endOfString(css, index);
      out += css.slice(index, end);
      index = end - 1;
    } else if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) return out;
      index = end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** Splits on `separator` outside strings, parentheses and brackets, so `:is(a, b)` stays one piece. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'") { index = endOfString(text, index) - 1; continue; }
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The next `prelude { body }` chunk from `from`, or null when only an at-rule statement or junk is left. */
function scanRule(css: string, from: number): { prelude: string; body: string; end: number } | null {
  let open = -1;
  let depth = 0;
  for (let index = from; index < css.length; index++) {
    const char = css[index];
    if (char === '"' || char === "'") { index = endOfString(css, index) - 1; continue; }
    if (char === '{') {
      if (open === -1) { open = index; depth = 1; } else depth++;
    } else if (char === '}' && open !== -1) {
      depth--;
      if (depth === 0) return { prelude: css.slice(from, open).trim(), body: css.slice(open + 1, index), end: index + 1 };
    }
  }
  return null;
}

/** `body.dark p` counts as the page root, `bodycopy` does not. */
const startsWith = (selector: string, root: string) =>
  selector.startsWith(root) && !/[\w-]/.test(selector.charAt(root.length));

/**
 * Splits a complex selector into its first compound and everything from the first combinator on:
 * `body.dark > p` becomes `{ head: 'body.dark', rest: ' > p' }`. Only the head can hold a root
 * element or a direction class, so only the head is rewritten as a whole.
 */
function splitHead(selector: string): { head: string; rest: string } {
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === '"' || char === "'") { index = endOfString(selector, index) - 1; continue; }
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~')) {
      return { head: selector.slice(0, index), rest: selector.slice(index) };
    }
  }
  return { head: selector, rest: '' };
}

function scopeSelector(selector: string, scope: string): string {
  const clean = selector.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const { head, rest } = splitHead(clean);
  const lower = head.toLowerCase();
  // A rule written for <html class="rwp-rtl"> keeps matching, and the wrapper class adds no weight:
  // `:where(.canvasSite).rwp-rtl .card` is (0,2,0) like the author's `.rwp-rtl .card`.
  if (rootClasses.some((root) => startsWith(lower, root))) return `:where(${scope})${head}${rest}`;
  // A rule for the page root addresses the wrapper itself, so it keeps the wrapper's class: it has
  // to outrank the canvas baseline (`font-size`, `background`) exactly as it outranks the module
  // rules in PublicLayout/PublicHome on the live site.
  for (const root of rootSelectors) {
    if (startsWith(lower, root)) return `${scope}${head.slice(root.length)}${rest}`;
  }
  // Every other selector gets a zero-specificity ancestor, so it wins and loses the same ties it
  // does in production (see the note at the top of the file).
  return `:where(${scope}) ${clean}`;
}

function scopeRules(css: string, scope: string): string {
  let out = '';
  let index = 0;
  while (index < css.length) {
    const rule = scanRule(css, index);
    // A trailing `@layer a, b;` or unbalanced CSS: hand it back untouched for the browser to judge.
    if (!rule) return out + css.slice(index);
    const prelude = rule.prelude;
    if (prelude.startsWith('@')) {
      const name = prelude.slice(1).split(/[\s({;]/)[0].toLowerCase();
      if (globalAtRules.has(name)) out += `${prelude}{${rule.body}}`;
      // Unknown at-rules are scoped like @media: a block holding rules is the only case that
      // matters, and leaving it global would leak the author's CSS into the editor.
      else out += `${prelude}{${scopeRules(rule.body, scope)}}`;
    } else {
      const selectors = splitTopLevel(prelude, ',').map((selector) => scopeSelector(selector, scope)).filter(Boolean);
      if (selectors.length) out += `${selectors.join(', ')}{${rule.body}}`;
    }
    out += '\n';
    index = rule.end;
  }
  return out;
}

/** Scopes a stylesheet to `scope`, a selector such as `.rwp-page-builder-editor-canvasSite`. */
export function scopeThemeCss(css: string, scope: string): string {
  return scopeRules(stripDroppedAtRules(stripComments(css)), scope).trim();
}

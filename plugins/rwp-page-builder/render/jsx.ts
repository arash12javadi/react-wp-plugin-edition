/**
 * The React mode of the Custom HTML widget: JSX in, `React.createElement(…)` out.
 *
 * Hand-written and dependency-free for the same reason src/lib/codeCompletion.ts is — the widget
 * has to work in a published page without a build step or a Babel-sized dependency, and this file
 * must stay testable outside a browser (it imports nothing and touches no DOM).
 *
 * It is deliberately not a full JSX implementation. It handles what the widget needs and the
 * field's help text says so: elements, `<>…</>` fragments, children, `{…}` expressions,
 * `{...spread}` attributes, `data-`/`aria-` attributes, `class`/`for` mapped to `className` /
 * `htmlFor`, HTML void tags left unclosed (`<br>` works), comments, and the whitespace rules JSX
 * applies to text. TypeScript-only syntax is not supported.
 */

/** A problem found in the JSX itself, with the position it was found at. */
export class JsxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'JsxError';
    this.line = line;
    this.column = column;
  }
}

/** Elements HTML says can never have children, so `<br>` may stand on its own. */
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Attributes that mean something else in React, keyed by their lowercase HTML spelling. */
const attributeAliases: Record<string, string> = {
  class: 'className', for: 'htmlFor', acceptcharset: 'acceptCharset', accesskey: 'accessKey',
  allowfullscreen: 'allowFullScreen', autocomplete: 'autoComplete', autofocus: 'autoFocus',
  autoplay: 'autoPlay', charset: 'charSet', colspan: 'colSpan', contenteditable: 'contentEditable',
  crossorigin: 'crossOrigin', datetime: 'dateTime', enctype: 'encType', formaction: 'formAction',
  formnovalidate: 'formNoValidate', frameborder: 'frameBorder', hreflang: 'hrefLang',
  'http-equiv': 'httpEquiv', inputmode: 'inputMode', maxlength: 'maxLength', minlength: 'minLength',
  novalidate: 'noValidate', ondblclick: 'onDoubleClick', playsinline: 'playsInline', readonly: 'readOnly',
  referrerpolicy: 'referrerPolicy', rowspan: 'rowSpan', spellcheck: 'spellCheck', srcset: 'srcSet',
  tabindex: 'tabIndex', usemap: 'useMap',
};

/** A lower-case event name (`onclick`) is the same prop as its camelCase spelling. */
const lowerEvent = /^on[a-z]+$/;

/** Nothing but comments, e.g. a comment in braces, which JSX allows anywhere. */
const onlyComments = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+$/;

/** After these, `<` opens an element and `/` starts a regular expression rather than dividing. */
const expressionKeywords = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void', 'instanceof', 'throw']);

/** The prop name for an attribute: aliased, camelCased for events, quoted when it is not a name. */
function propName(attribute: string) {
  const lower = attribute.toLowerCase();
  const event = lowerEvent.test(lower) ? `on${lower[2].toUpperCase()}${lower.slice(3)}` : '';
  const name = attributeAliases[lower] || event || attribute;
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * What JSX does to the text between tags: on one line the spaces stay as written, over several
 * lines the indentation goes and the lines join with a single space, so the newline before the
 * next tag does not turn into a space.
 */
function jsxText(raw: string) {
  if (!raw.includes('\n')) return raw;
  const lines = raw.split('\n').map((line) => line.trim());
  const first = lines.findIndex((line) => line !== '');
  if (first === -1) return '';
  let last = lines.length - 1;
  while (lines[last] === '') last -= 1;
  return lines.slice(first, last + 1).join(' ');
}

/** Can React put this in the tree? A plain object, a function or a promise cannot. */
export function isRenderable(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === 'boolean'
    || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.every(isRenderable);
  if (typeof value !== 'object') return false;
  const type = (value as { $$typeof?: unknown }).$$typeof;
  return typeof type === 'symbol' || typeof type === 'number';
}

function describe(error: unknown) {
  if (error instanceof JsxError) return `${error.message} (line ${error.line}, column ${error.column})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The compiler. It copies JavaScript through untouched and replaces every element it meets with a
 * `React.createElement` call, so the result is plain JavaScript that `new Function` can run.
 */
class Compiler {
  /** Set as soon as an element is compiled, which is how plain JavaScript is told from React code. */
  foundJsx = false;
  private readonly source: string;
  private readonly out: string[] = [];
  private pos = 0;
  /** The last meaningful thing copied, so `<div>` inside an expression is told from `a < b`. */
  private last = '';
  private braces = 0;

  constructor(source: string) {
    this.source = source;
  }

  compile() {
    this.code(false);
    return this.out.join('');
  }

  /** Copies JavaScript, compiling any JSX, and stops before the `}` that closes the caller's block. */
  private code(stopAtBrace: boolean) {
    const { source } = this;
    while (this.pos < source.length) {
      const char = source[this.pos];
      if (char === '}') {
        if (this.braces === 0) {
          if (stopAtBrace) return;
          this.push('}');
          continue;
        }
        this.braces -= 1;
        this.push('}');
        continue;
      }
      if (char === '{') {
        this.braces += 1;
        this.push('{');
        continue;
      }
      if (char === '"' || char === "'") {
        this.string(char);
        continue;
      }
      if (char === '`') {
        this.template();
        continue;
      }
      if (char === '/' && source[this.pos + 1] === '/') {
        this.lineComment();
        continue;
      }
      if (char === '/' && source[this.pos + 1] === '*') {
        this.blockComment();
        continue;
      }
      if (char === '<' && this.expressionPosition()) {
        this.element();
        continue;
      }
      if (char === '/' && this.expressionPosition()) {
        this.regExp();
        continue;
      }
      if (/[\w$]/.test(char)) {
        this.word();
        continue;
      }
      this.push(char);
    }
  }

  /** Can an expression start here? Decides between `<div>` and `a < b`, and `/re/` and `a / b`. */
  private expressionPosition() {
    const last = this.last;
    if (!last) return true;
    if (last === 'str' || last === 'tmpl' || last === 'regex') return false;
    if (last === ')' || last === ']' || last === '}') return false;
    if (/^[\w$]+$/.test(last)) return expressionKeywords.has(last);
    return true;
  }

  /** One element: `<tag …>…</tag>`, `<tag … />` or `<>…</>`. */
  private element() {
    const start = this.pos;
    this.foundJsx = true;
    this.pos += 1;
    this.fill('React.createElement(');
    if (this.source[this.pos] === '>') {
      this.pos += 1;
      this.fill('React.Fragment, null');
      this.children('', start);
    } else {
      const name = this.elementName(start);
      this.fill(`${this.tagReference(name)}, `);
      if (!this.attributes(name, start)) this.children(name, start);
    }
    this.fill(')');
    this.last = ')';
  }

  /** The tag name, e.g. `div`, `MyCard`, `svg:circle`, read from wherever the caret sits. */
  private elementName(start: number) {
    const match = /^[A-Za-z_$][\w$.:-]*/.exec(this.source.slice(this.pos));
    if (!match) this.fail('Expected an element name after "<"', start);
    this.pos += match[0].length;
    return match[0];
  }

  /** A name React looks up (`Foo`, `Icons.Star`) or a string tag (`div`, `my-tag`, `svg:circle`). */
  private tagReference(name: string) {
    return /^[A-Z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) ? name : JSON.stringify(name);
  }
  /**
   * The attributes, handed to `createElement` as one props object (or `null`). Returns true when
   * the element closed itself, so the caller knows there are no children to read.
   */
  private attributes(name: string, start: number) {
    const { source } = this;
    const props: string[] = [];
    let selfClosed = false;
    for (;;) {
      this.skipSpace();
      if (this.pos >= source.length) this.fail(`<${name}> is never closed`, start);
      if (source.startsWith('/>', this.pos)) {
        this.pos += 2;
        selfClosed = true;
        break;
      }
      if (source[this.pos] === '>') {
        this.pos += 1;
        // A void element cannot have children, so `<br>` and `<img src="…">` need no slash.
        selfClosed = voidTags.has(name.toLowerCase());
        break;
      }
      if (source[this.pos] === '{') {
        this.pos += 1;
        const spread = this.expression();
        if (spread && !onlyComments.test(spread)) props.push(`...(${spread})`);
        continue;
      }
      const attribute = this.attributeName();
      this.skipSpace();
      if (source[this.pos] !== '=') {
        props.push(`${propName(attribute)}: true`);
        continue;
      }
      this.pos += 1;
      this.skipSpace();
      const quote = source[this.pos];
      if (quote === '"' || quote === "'") {
        props.push(`${propName(attribute)}: ${this.attributeValue(quote)}`);
        continue;
      }
      if (quote === '{') {
        this.pos += 1;
        const text = this.expression();
        props.push(`${propName(attribute)}: ${text && !onlyComments.test(text) ? `(${text})` : 'undefined'}`);
        continue;
      }
      props.push(`${propName(attribute)}: ${JSON.stringify(this.bareValue(attribute))}`);
    }
    this.fill(props.length ? `{ ${props.join(', ')} }` : 'null');
    return selfClosed;
  }

  private attributeName() {
    const match = /^[A-Za-z_$][\w$.:-]*/.exec(this.source.slice(this.pos));
    if (!match) this.fail('Expected an attribute name inside the tag');
    this.pos += match[0].length;
    return match[0];
  }

  /** A quoted value, kept exactly as written — JSX does not read escapes in attribute strings. */
  private attributeValue(quote: string) {
    const { source } = this;
    const from = this.pos;
    this.pos += 1;
    while (this.pos < source.length && source[this.pos] !== quote) this.pos += 1;
    if (this.pos >= source.length) this.fail(`Missing the closing ${quote}`);
    const raw = source.slice(from + 1, this.pos);
    this.pos += 1;
    return JSON.stringify(raw);
  }

  /** An unquoted value, which HTML allows and JSX turns into a string. */
  private bareValue(attribute: string) {
    const { source } = this;
    const from = this.pos;
    while (this.pos < source.length && !/[\s>{}]/.test(source[this.pos])) this.pos += 1;
    if (this.pos === from) this.fail(`Missing the value of "${attribute}"`);
    return source.slice(from, this.pos);
  }
  /** Everything up to the matching close tag, as extra arguments to `createElement`. */
  private children(name: string, start: number) {
    const { source } = this;
    for (;;) {
      if (this.pos >= source.length) this.fail(`<${name}> is never closed`, start);
      if (source.startsWith('</', this.pos)) {
        const close = this.pos;
        this.pos += 2;
        const closing = source[this.pos] === '>' ? '' : this.elementName(close);
        if (source[this.pos] !== '>') this.fail('Expected ">" to close the element', close);
        this.pos += 1;
        if (closing !== name) this.fail(`</${name}> expected, but found </${closing}>`, close);
        return;
      }
      if (source[this.pos] === '<') {
        this.fill(', ');
        this.element();
        continue;
      }
      if (source[this.pos] === '{') {
        this.pos += 1;
        const text = this.expression();
        if (text && !onlyComments.test(text)) this.fill(`, (${text})`);
        continue;
      }
      const text = jsxText(this.text());
      if (text) this.fill(`, ${JSON.stringify(text)}`);
    }
  }

  /** The words between tags, up to the next tag or expression. */
  private text() {
    const { source } = this;
    const from = this.pos;
    while (this.pos < source.length && source[this.pos] !== '<' && source[this.pos] !== '{') this.pos += 1;
    return source.slice(from, this.pos);
  }

  /** Compiles the `{ … }` the caller is sitting in and returns it as text, leaving nothing behind. */
  private expression() {
    const mark = this.out.length;
    const braces = this.braces;
    this.braces = 0;
    this.code(true);
    this.braces = braces;
    if (this.source[this.pos] === '}') this.pos += 1;
    return this.out.splice(mark).join('').trim();
  }
  private string(quote: string) {
    const { source } = this;
    const start = this.pos;
    let chunk = quote;
    this.pos += 1;
    while (this.pos < source.length) {
      const char = source[this.pos];
      this.pos += 1;
      if (char === '\\') {
        chunk += char + (source[this.pos] || '');
        this.pos += 1;
        continue;
      }
      if (char === quote) {
        this.fill(chunk + quote);
        this.last = 'str';
        return;
      }
      if (char === '\n') break;
      chunk += char;
    }
    this.fail('Unterminated string', start);
  }

  private template() {
    const { source } = this;
    const start = this.pos;
    let chunk = '`';
    this.pos += 1;
    while (this.pos < source.length) {
      const char = source[this.pos];
      if (char === '\\') {
        chunk += source.slice(this.pos, this.pos + 2);
        this.pos += 2;
        continue;
      }
      if (char === '`') {
        this.pos += 1;
        this.fill(chunk + '`');
        this.last = 'tmpl';
        return;
      }
      if (char === '$' && source[this.pos + 1] === '{') {
        this.fill(`${chunk}\${`);
        chunk = '';
        this.pos += 2;
        this.fill(this.expression());
        this.fill('}');
        continue;
      }
      chunk += char;
      this.pos += 1;
    }
    this.fail('Unterminated template literal', start);
  }

  private lineComment() {
    const end = this.source.indexOf('\n', this.pos);
    const stop = end === -1 ? this.source.length : end + 1;
    this.fill(this.source.slice(this.pos, stop));
    this.pos = stop;
  }

  private blockComment() {
    const end = this.source.indexOf('*/', this.pos + 2);
    if (end === -1) this.fail('Unterminated comment');
    this.fill(this.source.slice(this.pos, end + 2));
    this.pos = end + 2;
  }

  /** A regular expression literal. When it never closes, the `/` was division after all. */
  private regExp() {
    const { source } = this;
    const start = this.pos;
    let chunk = '/';
    let inClass = false;
    this.pos += 1;
    while (this.pos < source.length) {
      const char = source[this.pos];
      if (char === '\\') {
        chunk += source.slice(this.pos, this.pos + 2);
        this.pos += 2;
        continue;
      }
      if (char === '\n') break;
      this.pos += 1;
      chunk += char;
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        while (/[a-z]/i.test(source[this.pos] || '')) {
          chunk += source[this.pos];
          this.pos += 1;
        }
        this.fill(chunk);
        this.last = 'regex';
        return;
      }
    }
    this.pos = start;
    this.push('/');
  }

  private word() {
    const { source } = this;
    let end = this.pos + 1;
    while (end < source.length && /[\w$]/.test(source[end])) end += 1;
    const word = source.slice(this.pos, end);
    this.fill(word);
    this.last = word;
    this.pos = end;
  }

  private skipSpace() {
    const { source } = this;
    while (this.pos < source.length && /\s/.test(source[this.pos])) this.pos += 1;
  }

  /** Copy one character, remembering it unless it was whitespace. */
  private push(char: string) {
    this.out.push(char);
    this.pos += 1;
    if (char.trim()) this.last = char;
  }

  /** Copy composed text, which says nothing about what may follow it. */
  private fill(text: string) {
    this.out.push(text);
  }

  private fail(message: string, index = this.pos): never {
    const before = this.source.slice(0, index);
    const line = before.split('\n').length;
    throw new JsxError(message, line, index - (before.lastIndexOf('\n') + 1) + 1);
  }
}

/**
 * Does this code contain an element? If not it is plain JavaScript, and the widget runs it the way
 * it runs the JavaScript field, with `root` set to the widget's own element.
 */
export function containsJsx(source: string) {
  const compiler = new Compiler(source);
  try {
    compiler.compile();
  } catch {
    // A broken element has still been seen, and the error is reported when the code is run.
  }
  return compiler.foundJsx;
}

/** The `React.createElement(…)` expression for this JSX. Throws JsxError on a syntax problem. */
export function compileJsx(source: string) {
  return new Compiler(source).compile();
}

/** The scope the widget gives a React field, so the code can read the settings and the node. */
export interface JsxScope {
  React: unknown;
  settings: Record<string, unknown>;
  node: unknown;
}

export interface JsxResult {
  /** What the code returned. React renders it when `isRenderable` accepts it. */
  value: unknown;
  /** What went wrong, ready to show the author. Empty when the code ran. */
  error: string;
}

type JsxFactory = (...args: unknown[]) => unknown;

const factories = new Map<string, JsxFactory>();
const maxFactories = 40;

/**
 * Runs the code with `scope` in it and hands back what it returned. The compiled form is kept by
 * source text, so re-rendering a widget does not compile it again.
 *
 * The code is tried as a single expression first — a bare `<div>…</div>` is the common case — and
 * as a body when that is not valid JavaScript, which is what an explicit `return` needs.
 */
export function evaluateJsx(source: string, scope: JsxScope): JsxResult {
  const keys = Object.keys(scope);
  const cacheKey = `${keys.join(',')}\u0000${source}`;
  const values = keys.map((key) => (scope as unknown as Record<string, unknown>)[key]);
  try {
    let factory = factories.get(cacheKey);
    if (!factory) {
      factory = createFactory(compileJsx(source), keys);
      if (factories.size >= maxFactories) factories.delete(factories.keys().next().value as string);
      factories.set(cacheKey, factory);
    }
    return { value: factory(...values), error: '' };
  } catch (error) {
    return { value: undefined, error: describe(error) };
  }
}

function createFactory(compiled: string, keys: string[]) {
  try {
    return buildFunction(keys, `"use strict";\nreturn (\n${compiled}\n);\n`);
  } catch {
    return buildFunction(keys, `"use strict";\n${compiled}\n`);
  }
}

// `new Function` is deliberate: this is administrator-authored code, and builder_guard_html refuses
// to store a change to it unless an administrator made it.
const buildFunction = (keys: string[], body: string) =>
  new Function(...keys, body) as unknown as JsxFactory;



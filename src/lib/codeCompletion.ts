/**
 * The completion engine behind the code fields: it works out what the caret is sitting in (a tag,
 * an attribute, a CSS declaration, a JSX prop …) and returns the entries worth offering there.
 *
 * Dependency-free and DOM-free on purpose, so the same code runs in the editor and in plain unit
 * tests, and so codeCompletionData.ts stays the only place the tables are edited.
 */

import {
  cssAtRules, cssCommonValues, cssMediaFeatures, cssProperties, cssPseudo, cssValues,
  htmlAttributeValues, htmlAttributes, htmlGlobalAttributes, htmlTags, htmlTemplates,
  jsGlobals, jsKeywords, jsMembers, jsSnippets, jsxProps,
  type CompletionEntry,
} from './codeCompletionData';

export type CompletionMode = 'html' | 'css' | 'js' | 'jsx';

export type CompletionKind =
  | 'tag' | 'template' | 'attribute' | 'attribute-value' | 'property' | 'value' | 'selector'
  | 'at-rule' | 'pseudo' | 'keyword' | 'global' | 'member' | 'snippet' | 'local';

export interface CompletionItem {
  label: string;
  detail: string;
  kind: CompletionKind;
  /** Replaces value.slice(from, to). */
  insert: string;
  from: number;
  to: number;
  /** Where the caret lands inside insert. */
  caret: number;
  /** How well the label matched the typed word; lower sorts first. Never shown. */
  score: number;
}

/** Terms the host adds to the tables: builder widgets, shortcodes, the document's class names. */
export interface CompletionExtras {
  /** Extra element names and skeletons. */
  html?: CompletionEntry[];
  /** Extra attributes, offered on every element. */
  attributes?: CompletionEntry[];
  /** Extra values per attribute, e.g. the classes a builder widget accepts. */
  attributeValues?: Record<string, CompletionEntry[]>;
  /** Extra properties and values. */
  css?: CompletionEntry[];
  cssValues?: Record<string, CompletionEntry[]>;
  /** Extra class and id names offered in selectors. */
  selectors?: string[];
  /** Extra globals, props or members. */
  js?: CompletionEntry[];
  jsx?: CompletionEntry[];
  /** Extra members offered after a dot on a named object, e.g. what the `rwp` registry offers. */
  members?: Record<string, CompletionEntry[]>;
  /** Values offered inside a string literal, e.g. the hook names a filter call accepts. */
  strings?: CompletionEntry[];
  /** Identifiers in scope, e.g. the props a widget hands to a script. */
  locals?: string[];
}

export interface CompletionResult {
  /** The language the entries belong to; inside <style> this is 'css' while the field is 'html'. */
  mode: CompletionMode;
  kind: CompletionKind;
  word: string;
  from: number;
  to: number;
  items: CompletionItem[];
}

const MAX_ITEMS = 120;

const identWord = /[\w$]/;
const htmlWord = /[-\w:]/;
const cssWord = /[-\w]/;
const cssValueWord = /[-\w.#%!]/;
const cssSelectorWord = /[-\w.#:[]/;
const jsxWord = /[-\w$]/;
/** A word inside a string literal: hook and layout-zone names use letters, digits, underscores and dashes. */
const stringWord = /[\w-]/;

function wordBefore(value: string, caret: number, pattern: RegExp) {
  let from = caret;
  while (from > 0 && pattern.test(value[from - 1])) from -= 1;
  return { from, to: caret, word: value.slice(from, caret) };
}

/** Past the closing quote when the suggestion ends with the same one, so it is not doubled up. */
function endOfReplacement(value: string, to: number, insert: string) {
  const quote = insert[insert.length - 1];
  return (quote === '"' || quote === "'") && value[to] === quote ? to + 1 : to;
}

/** The range an accepted item is written over. */
interface Bounds { from: number; to: number }

/** An entry paired with what it is, before it becomes an item. */
type EntryKind = [CompletionEntry, CompletionKind];

function kinded(entries: CompletionEntry[], kind: CompletionKind): EntryKind[] {
  return entries.map((entry) => [entry, kind]);
}

function toItems(entries: EntryKind[], value: string, bounds: Bounds): CompletionItem[] {
  return entries.map(([entry, kind]) => makeItem(entry, kind, value, bounds));
}

/** [label, detail, insert?] to an item, with $0 turned into a caret position. */
function makeItem(entry: CompletionEntry, kind: CompletionKind, value: string, bounds: Bounds): CompletionItem {
  const [label, detail, template] = entry;
  const source = template ?? label;
  let insert = '';
  let caret = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '$' && /\d/.test(source[index + 1] || '')) {
      if (source[index + 1] === '0' && caret === -1) caret = insert.length;
      index += 1;
      continue;
    }
    insert += source[index];
  }
  return {
    label,
    detail,
    kind,
    insert,
    from: bounds.from,
    to: endOfReplacement(value, bounds.to, insert),
    caret: caret === -1 ? insert.length : caret,
    score: 0,
  };
}

/** First letters of "justify-content" and "className" both give a useful shortcut. */
function initials(label: string) {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toLowerCase())
    .join('');
}

function scoreOf(label: string, term: string) {
  if (!term) return 1;
  const lower = label.toLowerCase();
  if (lower === term) return 0;
  if (lower.startsWith(term)) return 1;
  if (initials(label).startsWith(term)) return 2;
  if (lower.includes(term)) return 3;
  return -1;
}

/** Ranked, capped and safe to run on every keystroke: the tables are in the low thousands. */
export function rankItems(items: CompletionItem[], word: string): CompletionItem[] {
  const term = word.toLowerCase();
  const scored: CompletionItem[] = [];
  for (const item of items) {
    const score = scoreOf(item.label, term);
    if (score >= 0) scored.push({ ...item, score });
  }
  scored.sort((a, b) => (a.score - b.score) || (a.label.length - b.label.length) || a.label.localeCompare(b.label));
  return scored.length > MAX_ITEMS ? scored.slice(0, MAX_ITEMS) : scored;
}

/** The text after accepting an item, and where the caret lands in it. */
export function applyCompletion(value: string, item: CompletionItem): { value: string; caret: number } {
  return { value: `${value.slice(0, item.from)}${item.insert}${value.slice(item.to)}`, caret: item.from + item.caret };
}

/** What a language hands back before ranking: the entries and the range they replace. */
interface Resolution {
  mode: CompletionMode;
  kind: CompletionKind;
  word: string;
  from: number;
  to: number;
  items: CompletionItem[];
}

// HTML ----------------------------------------------------------------------------------------

/** Inside a tag before any attribute, including "" and "/" right after the "<". */
const tagNameOnly = /^\/?[!\w:-]*$/;

/** Is the caret between <name …> and </name …>? Used to spot <style> and <script> bodies. */
function insideElement(value: string, caret: number, name: string) {
  const open = value.lastIndexOf(`<${name}`, caret);
  if (open === -1) return -1;
  const body = value.indexOf('>', open);
  if (body === -1 || body >= caret) return -1;
  const close = value.lastIndexOf(`</${name}`, caret);
  return close > body ? -1 : body + 1;
}

/**
 * The attribute the caret is inside, if any: its name, whether it is inside quotes and where its
 * value starts. `matched` clears when a value ends, so `class="" id` is back in name position.
 */
function attributeAt(inside: string) {
  let name = '';
  let attribute = '';
  let quote: string | null = null;
  let valueStart = -1;
  let matched = false;
  for (let index = 0; index < inside.length; index += 1) {
    const char = inside[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        matched = false;
        valueStart = -1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '=') {
      attribute = name.trim().toLowerCase();
      name = '';
      matched = true;
      valueStart = index + 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (matched && valueStart !== -1 && index > valueStart) {
        matched = false;
        valueStart = -1;
      }
      name = '';
      continue;
    }
    name += char;
  }
  return matched && attribute ? { attribute, quote, open: valueStart } : null;
}

/** Attributes already written on the tag, so they are not offered twice. */
function presentAttributes(inside: string) {
  const names = new Set<string>();
  for (const match of inside.matchAll(/(?:^|\s)([-\w:@.]+)(?==|\s|$)/g)) names.add(match[1].toLowerCase());
  return names;
}

function htmlResolution(value: string, caret: number, extras: CompletionExtras): Resolution | null {
  const comment = value.lastIndexOf('<!--', caret);
  if (comment > value.lastIndexOf('-->', caret)) return null;

  const styleBody = insideElement(value, caret, 'style');
  if (styleBody !== -1) return cssResolution(value, caret, styleBody, extras);
  const scriptBody = insideElement(value, caret, 'script');
  if (scriptBody !== -1) return jsResolution(value, caret, 'js', extras);

  const open = value.lastIndexOf('<', caret);
  if (open < value.lastIndexOf('>', caret)) return null; // ordinary text, nothing to complete

  const inside = value.slice(open + 1, caret);
  if (tagNameOnly.test(inside)) {
    const bounds = wordBefore(value, caret, htmlWord);
    const entries: EntryKind[] = [...kinded(htmlTags, 'tag'), ...kinded(extras.html || [], 'tag'), ...kinded(htmlTemplates, 'template')];
    return { mode: 'html', kind: bounds.word ? 'tag' : 'template', ...bounds, items: toItems(entries, value, bounds) };
  }

  const tag = inside.match(/^\/?([\w:-]+)/)?.[1].toLowerCase() || '';
  const attribute = attributeAt(inside);
  if (attribute && attribute.open !== -1) {
    const bounds = wordBefore(value, caret, htmlWord);
    const name = attribute.attribute;
    const values = [...(htmlAttributeValues[name] || []), ...(extras.attributeValues?.[name] || [])];
    return { mode: 'html', kind: 'attribute-value', ...bounds, items: toItems(kinded(values, 'attribute-value'), value, bounds) };
  }

  const bounds = wordBefore(value, caret, htmlWord);
  const present = presentAttributes(inside);
  const names = [...(htmlAttributes[tag] || []), ...htmlGlobalAttributes, ...(extras.attributes || [])].filter((entry) => !present.has(entry[0].toLowerCase()));
  // A space before the name unless one is already there, so accepting mid-tag never joins words.
  const gap = value.slice(open + 1, bounds.from);
  const spaced = /(^|\s)$/.test(gap) || !gap ? '' : ' ';
  return {
    mode: 'html',
    kind: 'attribute',
    ...bounds,
    items: toItems(kinded(names, 'attribute'), value, bounds)
      .map((item) => (spaced ? { ...item, insert: ` ${item.insert}`, caret: item.caret + 1 } : item)),
  };
}

// CSS -----------------------------------------------------------------------------------------

/** At-rules whose body holds rules rather than declarations. */
const ruleBodyAtRule = /^@(media|supports|container|layer|scope|document|starting-style)\b/i;
/** An at-rule prelude whose opening parenthesis is still unclosed. */
const openPrelude = /^(@[-\w]+)[^(){}]*(\([^)]*)$/;
/** A declaration: a property name, a colon and the value so far. */
const declarationAt = /^\s*([-\w]+)\s*:\s*([^;{}]*)$/;
/** A bare property name, the only thing that is not a nested selector inside a rule. */
const propertyOnly = /^[-\w]*$/;

interface CssScan {
  /** The prelude of the innermost open block, or "" at the top level. */
  prelude: string;
  /** Everything between that block's "{" and the caret. */
  segment: string;
  depth: number;
}

/** Comments, strings, braces and semicolons up to the caret, in one pass. */
function scanCss(value: string, caret: number, start: number): CssScan {
  const stack: string[] = [];
  let boundary = start;
  let index = start;
  while (index < caret) {
    const char = value[index];
    if (char === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      index = end === -1 || end + 2 > caret ? caret : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      let scan = index + 1;
      while (scan < caret && value[scan] !== char) scan += value[scan] === '\\' ? 2 : 1;
      index = Math.min(scan + 1, caret);
      continue;
    }
    if (char === '{') {
      stack.push(value.slice(boundary, index).trim());
      boundary = index + 1;
    } else if (char === '}') {
      stack.pop();
      boundary = index + 1;
    } else if (char === ';') {
      boundary = index + 1;
    }
    index += 1;
  }
  return { prelude: stack[stack.length - 1] || '', segment: value.slice(boundary, caret), depth: stack.length };
}

/** Classes or ids written in the field, so selectors can be completed from the markup itself. */
function selectorNames(value: string, marker: '.' | '#') {
  const names = new Set<string>();
  for (const match of value.matchAll(/(?:^|[^\w.#-])([.#])([-\w]+)/g)) if (match[1] === marker) names.add(match[2]);
  return names;
}

function cssSelectorEntries(value: string, word: string, extras: CompletionExtras): EntryKind[] {
  const entries: EntryKind[] = [];
  if (!word.startsWith('.') && !word.startsWith('#')) entries.push(...kinded(cssAtRules, 'at-rule'));
  if (word.startsWith(':')) entries.push(...kinded(cssPseudo, 'pseudo'));
  if (!word || word.startsWith('.')) {
    for (const name of [...selectorNames(value, '.'), ...(extras.selectors || [])]) entries.push([[`.${name}`, 'a class used in this document'], 'selector']);
  }
  if (!word || word.startsWith('#')) {
    for (const name of selectorNames(value, '#')) entries.push([[`#${name}`, 'an id used in this document'], 'selector']);
  }
  if (word && !word.startsWith('.') && !word.startsWith('#') && !word.startsWith(':')) entries.push(...kinded(htmlTags, 'tag'));
  return entries;
}

function cssPropertiesFor(extras: CompletionExtras): EntryKind[] {
  return kinded([...cssProperties, ...(extras.css || [])], 'property');
}

function cssResolution(value: string, caret: number, start: number, extras: CompletionExtras): Resolution | null {
  const { prelude, segment, depth } = scanCss(value, caret, start);
  const inRuleBody = depth > 0 && !ruleBodyAtRule.test(prelude);
  const declaration = segment.match(declarationAt);
  const trimmed = segment.trim();
  const parens = (segment.startsWith('@') ? segment : ruleBodyAtRule.test(prelude) ? prelude : '').match(openPrelude);

  if (parens && /^@(media|container)/i.test(parens[1])) {
    const bounds = wordBefore(value, caret, cssWord);
    return { mode: 'css', kind: 'at-rule', ...bounds, items: toItems(kinded(cssMediaFeatures, 'at-rule'), value, bounds) };
  }

  if (parens && /^@supports/i.test(parens[1])) {
    const bounds = wordBefore(value, caret, cssWord);
    return { mode: 'css', kind: 'property', ...bounds, items: toItems(cssPropertiesFor(extras), value, bounds) };
  }

  // Inside an unclosed `var(` only a custom property name is valid, so the generic value list would
  // nest nonsense (`var(var(--x))`). The `var(--$0)` template in cssCommonValues lands here too.
  const openVar = /(?:^|[^\w-])var\(\s*[-\w]*$/.test(segment);
  if (inRuleBody && openVar) {
    const bounds = wordBefore(value, caret, cssValueWord);
    const names = new Map<string, CompletionEntry>();
    for (const entry of [...cssProperties, ...(extras.css || [])]) if (entry[0].startsWith('--')) names.set(entry[0], entry);
    return { mode: 'css', kind: 'property', ...bounds, items: toItems(kinded([...names.values()], 'property'), value, bounds) };
  }

  if (inRuleBody && declaration) {
    const bounds = wordBefore(value, caret, cssValueWord);
    const property = declaration[1];
    const entries = [...(cssValues[property] || []), ...(extras.cssValues?.[property] || []), ...cssCommonValues];
    return { mode: 'css', kind: 'value', ...bounds, items: toItems(kinded(entries, 'value'), value, bounds) };
  }

  if (inRuleBody && propertyOnly.test(trimmed)) {
    const bounds = wordBefore(value, caret, cssWord);
    return { mode: 'css', kind: 'property', ...bounds, items: toItems(cssPropertiesFor(extras), value, bounds) };
  }

  const bounds = wordBefore(value, caret, cssSelectorWord);
  return { mode: 'css', kind: 'selector', ...bounds, items: toItems(cssSelectorEntries(value, bounds.word, extras), value, bounds) };
}

// JavaScript and JSX --------------------------------------------------------------------------

/** Only the name so far: `</di` counts, `<div class` does not. */
const jsxTagName = /^\/?[A-Za-z][\w.:]*$/;
/** A tag whose name is finished, i.e. attributes are next. */
const jsxTagOpen = /^\/?[A-Za-z][\w.:]*[\s/][\s\S]*$/;

/** Where the caret sits: live code, a comment, or a quoted string. */
type QuietPart = 'code' | 'comment' | 'string';

/** Comments and quoted strings change what is offered; template literals stay live code. */
function quietAt(value: string, caret: number): QuietPart {
  let quote = '';
  let index = 0;
  while (index < caret) {
    const char = value[index];
    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '/' && value[index + 1] === '/') {
      const end = value.indexOf('\n', index);
      if (end === -1 || end >= caret) return 'comment';
      index = end + 1;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end === -1 || end + 2 > caret) return 'comment';
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    index += 1;
  }
  return quote ? 'string' : 'code';
}

/** const, let, var, function and class names, so the fields complete what the author just wrote. */
function localsOf(value: string, extras: CompletionExtras): CompletionEntry[] {
  const seen = new Set<string>();
  const entries: CompletionEntry[] = [];
  const add = (name: string, detail: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    entries.push([name, detail]);
  };
  (extras.locals || []).forEach((name) => add(name, 'in scope here'));
  for (const match of value.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(match[1], 'declared in this code');
  for (const match of value.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) add(match[1], 'declared in this code');
  for (const match of value.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:=>|\([^()]*\)\s*=>)/g)) add(match[1], 'param of a function in this code');
  return entries;
}

/** What `foo.` offers, from the name just before the dot. Extras win over the built-in tables. */
function membersOf(value: string, from: number, extras: CompletionExtras): CompletionEntry[] {
  if (value[from - 1] !== '.') return [];
  const object = value.slice(0, from - 1).match(/([\w$][\w$.]*)$/)?.[1] || '';
  const name = object.split('.').pop() || '';
  return extras.members?.[name] || jsMembers[name] || [];
}

/** Inside a quoted string: offer the values the author can name there, e.g. a hook's own name. */
function jsStringResolution(value: string, caret: number, mode: CompletionMode, extras: CompletionExtras): Resolution | null {
  if (!extras.strings?.length) return null;
  const bounds = wordBefore(value, caret, stringWord);
  return { mode, kind: 'value', ...bounds, items: toItems(kinded(extras.strings, 'value'), value, bounds) };
}

function jsResolution(value: string, caret: number, mode: CompletionMode, extras: CompletionExtras): Resolution | null {
  const quiet = quietAt(value, caret);
  if (quiet === 'comment') return null;
  if (quiet === 'string') return jsStringResolution(value, caret, mode, extras);
  const jsx = mode === 'jsx';

  const open = value.lastIndexOf('<', caret);
  if (open > value.lastIndexOf('>', caret)) {
    const inside = value.slice(open + 1, caret);
    if (jsx && jsxTagName.test(inside)) {
      const bounds = wordBefore(value, caret, jsxWord);
      const entries = [...kinded(htmlTags, 'tag'), ...kinded(extras.html || [], 'tag')];
      return { mode, kind: 'tag', ...bounds, items: toItems(entries, value, bounds) };
    }
    if (jsx && jsxTagOpen.test(inside)) {
      // Inside a quoted prop value, or inside {…}, ordinary JavaScript applies again.
      const quotes = inside.split('"').length - 1 + (inside.split("'").length - 1);
      const braces = inside.split('{').length - inside.split('}').length;
      if (!braces && quotes % 2 === 0) {
        const bounds = wordBefore(value, caret, jsxWord);
        const entries = [...kinded(jsxProps, 'attribute'), ...kinded(extras.jsx || [], 'attribute')];
        return { mode, kind: 'attribute', ...bounds, items: toItems(entries, value, bounds) };
      }
    }
  }

  const bounds = wordBefore(value, caret, identWord);
  const members = membersOf(value, bounds.from, extras);
  if (members.length) {
    return { mode, kind: 'member', ...bounds, items: toItems(kinded(members, 'member'), value, bounds) };
  }

  const entries: EntryKind[] = [
    ...kinded(localsOf(value, extras), 'local'),
    ...kinded(jsKeywords, 'keyword'),
    ...kinded(jsGlobals, 'global'),
    ...kinded(extras.js || [], 'global'),
    ...kinded(jsSnippets, 'snippet'),
  ];
  const kind: CompletionKind = bounds.word ? 'global' : 'snippet';
  return { mode, kind, ...bounds, items: toItems(entries, value, bounds) };
}

/**
 * Everything worth offering at `caret`, or null when there is nothing (plain text, a comment,
 * an empty result). `mode` is the field's language; the result says which language answered,
 * because an HTML field hands <style> and <script> bodies to CSS and JavaScript.
 */
export function complete(value: string, caret: number, mode: CompletionMode, extras: CompletionExtras = {}): CompletionResult | null {
  const resolution =
    mode === 'html' ? htmlResolution(value, caret, extras)
      : mode === 'css' ? cssResolution(value, caret, 0, extras)
        : jsResolution(value, caret, mode, extras);
  if (!resolution) return null;
  const items = rankItems(resolution.items, resolution.word);
  if (!items.length) return null;
  return { mode: resolution.mode, kind: resolution.kind, word: resolution.word, from: resolution.from, to: resolution.to, items };
}

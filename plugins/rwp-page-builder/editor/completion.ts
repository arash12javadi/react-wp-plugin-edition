/**
 * The builder's completion engine (src/lib/codeCompletion.ts) as a CodeMirror 6 source.
 *
 * Every rule about what to offer, what gets replaced and how the list is ordered lives in the
 * engine; this file only translates its items into CodeMirror's shape. CodeMirror's own filtering
 * is switched off in the result, because the engine already ranks by score and knows better than a
 * substring match (it favours the element you closed last, values that belong to the attribute,
 * and so on).
 */
import {
  insertCompletionText, type Completion, type CompletionContext, type CompletionResult, type CompletionSource,
} from '@codemirror/autocomplete';
import { complete, type CompletionExtras, type CompletionKind, type CompletionMode } from '../../../src/lib/codeCompletion';

/**
 * CodeMirror's icon names. It tints a known set and draws nothing for anything else, so these
 * follow the names its own HTML, CSS and JavaScript lists use.
 */
const iconNames: Record<CompletionKind, string> = {
  tag: 'type',
  template: 'type',
  attribute: 'property',
  'attribute-value': 'constant',
  property: 'property',
  value: 'constant',
  selector: 'class',
  'at-rule': 'keyword',
  pseudo: 'keyword',
  keyword: 'keyword',
  global: 'variable',
  member: 'method',
  snippet: 'text',
  local: 'variable',
};

/**
 * Names the field's language adds to the engine's tables.
 *
 * The React field compiles to `new Function('React', 'settings', 'node', …)` (render/jsx.ts), and
 * the plain JavaScript field to `new Function('root', …)` (the html widget's View), so those are
 * the identifiers worth offering before the user has typed them.
 */
export function languageNames(language: CompletionMode): CompletionExtras {
  if (language === 'jsx') return { locals: ['React', 'settings', 'node'] };
  if (language === 'js') return { locals: ['root'] };
  return {};
}

/** A CodeMirror completion source for one of the field's languages. */
export function codeCompletion(language: CompletionMode): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const engine = complete(context.state.doc.toString(), context.pos, language, languageNames(language));
    if (!engine || engine.items.length === 0) return null;

    const options: Completion[] = engine.items.map((item) => ({
      label: item.label,
      detail: item.detail,
      type: iconNames[item.kind],
      apply: (view, _completion, from, to) => {
        view.dispatch({
          ...insertCompletionText(view.state, item.insert, from, to),
          selection: { anchor: from + item.caret },
        });
      },
    }));

    // filter: false — the engine returns the list already ordered and trimmed, and a second,
    // substring-based pass here would drop entries it deliberately kept (e.g. a selector typed
    // with a dot in front, or a snippet whose label is not the text it inserts).
    return { from: engine.from, to: engine.to, options, filter: false };
  };
}

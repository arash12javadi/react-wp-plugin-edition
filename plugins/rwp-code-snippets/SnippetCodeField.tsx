import { useMemo } from 'react';
import { autocompletion } from '@codemirror/autocomplete';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { EditorView } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorProps } from '@uiw/react-codemirror';
import type { SnippetType } from '../../src/lib/snippets';
import { snippetCompletion } from './snippetCompletion';
import styles from './snippets.module.css';

/** Highlighting only: the completion list comes from the engine in snippetCompletion.ts, never here. */
function syntax(type: SnippetType) {
  if (type === 'css') return css();
  if (type === 'html') return html({ matchClosingTags: true, autoCloseTags: true });
  // A hook snippet is plain ES2022 — no JSX, because it is evaluated with new Function.
  return javascript();
}

/**
 * The snippet editor's code field: CodeMirror 6 wired to src/lib/codeCompletion.ts.
 *
 * CodeMirror's own completion is switched off (`basicSetup.autocompletion: false`) and replaced by
 * this plugin's source, so the list offers what is true on this screen — the app's global rwp-,
 * rwpt- and rwpb- class names in CSS, real length values rather than a Tailwind scale this project
 * does not use, the core hook names inside addAction/addFilter/addSlotContent, and the methods of the
 * `rwp` object a hook snippet is handed. The field keeps the dark well the textarea had, and `Tab`
 * still indents (`indentWithTab`) because the code being edited is indentation-sensitive.
 */
export default function SnippetCodeField({ label, type, value, onChange, placeholder, minRows = 14 }: {
  /** Shown above the field and used as the editor's accessible name — a contenteditable has no
   *  control for a <label> to point at. */
  label: string;
  type: SnippetType;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Height in lines when the code is short; the field grows to fit what is in it. */
  minRows?: number;
}) {
  const extensions = useMemo(() => [
    syntax(type),
    autocompletion({
      override: [snippetCompletion(type)],
      activateOnTyping: true,
      icons: true,
      closeOnBlur: true,
      // Short: the engine trims by context, so a long list means something is off, not that the user
      // needs to scroll.
      maxRenderedOptions: 24,
    }),
    EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
  ], [type, label]);

  // CodeMirror applies its own keymap for Enter, Tab, brackets and undo, which is why the field keeps
  // no local state: every change is reported straight to the control's value.
  const basicSetup: ReactCodeMirrorProps['basicSetup'] = {
    foldGutter: false,
    highlightActiveLineGutter: false,
    autocompletion: false,
    searchKeymap: false,
    bracketMatching: true,
    closeBrackets: true,
    indentOnInput: true,
    highlightSelectionMatches: false,
  };

  return (
    <div className={styles.codeField}>
      <span className={styles.codeLabel}>{label}</span>
      {/* The completion list may be drawn inside this element or in a portal at the end of <body>,
          so snippets.module.css styles it both ways. */}
      <div className={styles.codeShell} style={{ minHeight: `${Math.max(minRows, 4) * 1.55}em` }} data-snippet-type={type}>
        <CodeMirror
          value={value}
          theme="dark"
          height="auto"
          maxHeight="44em"
          indentWithTab
          basicSetup={basicSetup}
          extensions={extensions}
          placeholder={placeholder}
          onChange={onChange}
        />
      </div>
      <p className={styles.help}>
        Tab indents. Autocomplete offers only what exists here. Press Esc, then Tab, to leave the editor.
      </p>
    </div>
  );
}

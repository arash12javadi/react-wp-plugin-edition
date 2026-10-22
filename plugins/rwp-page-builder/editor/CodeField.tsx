import { useMemo } from 'react';
import { autocompletion } from '@codemirror/autocomplete';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { EditorView } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorProps } from '@uiw/react-codemirror';
import type { CompletionMode } from '../../../src/lib/codeCompletion';
import { codeCompletion } from './completion';
import styles from './editor.module.css';

/** Highlighting only: the completion list comes from the builder's own engine, never from these. */
function syntax(language: CompletionMode) {
  if (language === 'css') return css();
  if (language === 'jsx') return javascript({ jsx: true });
  if (language === 'js') return javascript();
  return html({ matchClosingTags: true, autoCloseTags: true });
}

/**
 * Every `type: 'code'` control: CodeMirror 6 wired to the builder's completion engine.
 *
 * CodeMirror's own completion is switched off (`basicSetup.autocompletion: false`) and replaced by
 * src/lib/codeCompletion.ts, so the list offers only things that are true here — builder widgets,
 * shortcodes and the document's class names, not the whole HTML or DOM vocabulary. The editor uses
 * CodeMirror's dark theme to keep the field's old look (a dark well inside the light inspector).
 *
 * Tab is bound to indentation (`indentWithTab`), matching the textarea this replaced.
 */
export function CodeField({ language, value, onChange, placeholder, label, rows = 8 }: {
  language: CompletionMode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The control's label, used as the editor's accessible name (the field has no <label> to point at). */
  label?: string;
  /** Height in lines when the code is empty; the field grows to fit what is in it. */
  rows?: number;
}) {
  const extensions = useMemo(() => [
    syntax(language),
    autocompletion({
      override: [codeCompletion(language)],
      activateOnTyping: true,
      icons: true,
      closeOnBlur: true,
      // Short: the engine trims by context, so a long list means something is off, not that the
      // user needs to scroll.
      maxRenderedOptions: 24,
    }),
    EditorView.contentAttributes.of({ 'aria-label': label ?? 'Code', spellcheck: 'false' }),
  ], [language, label]);

  // CodeMirror applies its own keymap for Enter, Tab, brackets and undo, which is why the field
  // keeps no local state: every change is reported straight to the control's value.
  const basicSetup: ReactCodeMirrorProps['basicSetup'] = {
    lineNumbers: false,
    foldGutter: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    autocompletion: false,
    searchKeymap: false,
    bracketMatching: true,
    closeBrackets: true,
    indentOnInput: true,
    highlightSelectionMatches: false,
  };

  return (
    <div className={styles.codeField} style={{ minHeight: `${Math.max(rows, 4) * 1.5}em` }} data-language={language}>
      <CodeMirror
        value={value}
        theme="dark"
        height="auto"
        maxHeight="24em"
        indentWithTab
        basicSetup={basicSetup}
        extensions={extensions}
        placeholder={placeholder}
        onChange={onChange}
      />
    </div>
  );
}

import { Mark } from '@tiptap/core';

/**
 * `<sub>`, `<sup>` and `<kbd>` — the three inline tags this editor can produce but StarterKit does not.
 *
 * They are here because of a contract on the other side of the app: the writing assistant is told it
 * may answer with `<sub>`, `<sup>` and `<kbd>` (`SYSTEM_PROMPT` in `server/aiAssist.mjs`), and a tag
 * the schema does not know is unwrapped as the answer is inserted — the author would pay for markup
 * that silently vanished. The route's list is the longer one; these are the tags a *sentence* can
 * carry, which is what the assistant rewrites.
 *
 * The official `@tiptap/extension-subscript` and `@tiptap/extension-superscript` do the same job, but
 * they are two more dependencies for two `renderHTML` lines each. `<kbd>` has no official extension.
 */

/** So `editor.chain().focus().toggleSubscript()` type-checks like every built-in command. */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    subscript: {
      setSubscript: () => ReturnType;
      toggleSubscript: () => ReturnType;
      unsetSubscript: () => ReturnType;
    };
    superscript: {
      setSuperscript: () => ReturnType;
      toggleSuperscript: () => ReturnType;
      unsetSuperscript: () => ReturnType;
    };
    kbd: {
      setKbd: () => ReturnType;
      toggleKbd: () => ReturnType;
      unsetKbd: () => ReturnType;
    };
    highlight: {
      setHighlight: () => ReturnType;
      toggleHighlight: () => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

/**
 * H₂O and x². The browser renders both tags itself — smaller, shifted, `line-height: 0` — so neither
 * needs a rule in a stylesheet, in the editor or on the published page.
 *
 * They exclude each other: nothing is raised and lowered at once, and a selection carrying both would
 * render as whichever the browser applied last.
 */
export const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML: () => [{ tag: 'sub' }],
  renderHTML: () => ['sub', 0],
  addCommands() {
    return {
      setSubscript: () => ({ commands }) => commands.setMark(this.name),
      toggleSubscript: () => ({ commands }) => commands.toggleMark(this.name),
      unsetSubscript: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    // Ctrl+, — half of the pair Word and Google Docs use, so the habit arrives with the author.
    return { 'Mod-,': () => this.editor.commands.toggleSubscript() };
  },
});

/** The other half of the pair: x² is Ctrl+. */
export const Superscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML: () => [{ tag: 'sup' }],
  renderHTML: () => ['sup', 0],
  addCommands() {
    return {
      setSuperscript: () => ({ commands }) => commands.setMark(this.name),
      toggleSuperscript: () => ({ commands }) => commands.toggleMark(this.name),
      unsetSuperscript: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-.': () => this.editor.commands.toggleSuperscript() };
  },
});

/**
 * `<kbd>` — a key the reader is meant to press. "Press Ctrl+K".
 *
 * A mark and not a node, so the key stays editable text and can be selected letter by letter. Nothing
 * is excluded, because `<kbd>` nests in HTML for the same reason it nests in a sentence: a bold `Ctrl`
 * plus `K` inside a step is ordinary prose. It is styled, unlike the two above, because a browser
 * gives `<kbd>` no styling of its own — see `ClassicEditor.module.css` and `PublicHome.module.css`.
 */
export const KeyboardKey = Mark.create({
  name: 'kbd',
  parseHTML: () => [{ tag: 'kbd' }],
  renderHTML: () => ['kbd', 0],
  addCommands() {
    return {
      setKbd: () => ({ commands }) => commands.setMark(this.name),
      toggleKbd: () => ({ commands }) => commands.toggleMark(this.name),
      unsetKbd: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    // Ctrl+Shift+K. The plain Ctrl keys next to it are TipTap's own (Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+E).
    return { 'Mod-Shift-k': () => this.editor.commands.toggleKbd() };
  },
});

/**
 * `<mark>` — the author's highlight, as a tag rather than as a colour.
 *
 * The toolbar's palette keeps painting text with `<span style="background-color: …">`, which is how
 * this editor has always offered a highlight; nothing here changes that. What this mark adds is the
 * *tag*: `<mark>` says "this is highlighted" and leaves the colour to the page, so an author's
 * emphasis survives a stylesheet change that a hard-coded span colour would not, and a `<mark>` that
 * arrives by paste or from an imported post is no longer unwrapped and lost on the next save.
 *
 * The writing assistant never sends one — the route's allowlist has no `<mark>` — so this is the
 * author's tool, not the assistant's.
 */
export const Highlight = Mark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', 0],
  addCommands() {
    return {
      setHighlight: () => ({ commands }) => commands.setMark(this.name),
      toggleHighlight: () => ({ commands }) => commands.toggleMark(this.name),
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    // Ctrl+Shift+H. Ctrl+H is the browser's own history panel, so the shift is not optional here.
    return { 'Mod-Shift-h': () => this.editor.commands.toggleHighlight() };
  },
});

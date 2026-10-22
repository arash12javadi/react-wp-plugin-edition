import { useCallback, useEffect, useRef, useState } from 'react';
import { createNodeFromContent, getHTMLFromFragment, isProseMirrorFragment } from '@tiptap/core';
import { Mapping } from '@tiptap/pm/transform';
import type { Fragment, Node } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { client } from '../../lib/db';
import styles from './AssistantPanel.module.css';

/**
 * The writing assistant the ✨ button opens.
 *
 * It asks `POST /api/ai/assist` to rewrite the text the cursor is in — or the selection, when there is
 * one — and puts the answer back where it was asked for. Everything the route knows is asked of the
 * route rather than restated here: the task list, the tone list, which provider is in use and whether
 * a key is saved all come from the GET, so a provider or a task added on the server appears in this
 * panel without a matching change on this side.
 *
 * The one thing this file does own is where the answer lands, because only the editor knows the
 * document: the range a request was made about is mapped through every edit that happened while it was
 * in flight, and an answer whose text has been deleted is offered to the author instead of inserted.
 */

/** The route this panel talks to — `AI_ASSIST_PATH` in `server/aiAssist.mjs`, where the tasks live. */
const AI_ASSIST_PATH = '/api/ai/assist';

/** Where the route stops reading the instruction (`MAX_INSTRUCTION_CHARS` in `server/aiAssist.mjs`). */
const INSTRUCTION_LIMIT = 500;

/** `GET /api/ai/assist`: whether the assistant can run, and on which provider's account. */
interface AssistantStatus {
  configured: boolean;
  providerName: string;
  model: string;
  /** Where the key is saved, as the Settings screen calls the place ("Settings → Integrations → AI"). */
  hint: string;
  /** False when the setting itself could not be read — a connection problem, not a missing key. */
  readable: boolean;
  tasks: string[];
  tones: string[];
}

/** `POST /api/ai/assist`: the rewrite, and whatever the server had to take out of it. */
interface AssistantAnswer {
  html: string;
  summary: string;
  removed: string[];
}

/** The range a request was made about, and every edit made while it was on its way. */
interface PendingRange {
  from: number;
  to: number;
  /** True when the range sits inside one paragraph, so a one-paragraph answer goes back inline. */
  inline: boolean;
  /** Grows with each transaction, so the range still means the same words when the answer arrives. */
  mapping: Mapping;
}

/** What `insertContentAt` takes: the two forms `createNodeFromContent` can answer with. */
type Insertable = Node | Fragment;

type Status =
  | { state: 'loading' }
  | { state: 'ready'; status: AssistantStatus }
  | { state: 'failed'; message: string };

/** The one place a caught value becomes a sentence. */
const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

/** A task or tone key from the route (`improve`, `professional`) as a label. */
const labelOf = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * The text a request would be made about: the selection, or the paragraph the cursor sits in.
 *
 * The route refuses an empty ask, and its refusal invites the author to "write a sentence and put the
 * cursor in it first" — advice that only reads as advice if the sentence, and not the empty selection,
 * is what gets sent. `null` means there is nothing to send: the cursor is not in text at all.
 */
const assistRange = (editor: Editor): { from: number; to: number } | null => {
  const { from, to, $from } = editor.state.selection;
  if (from !== to) return { from, to };
  if (!$from.parent.isTextblock) return null;
  return { from: $from.start(), to: $from.end() };
};

/** The range as HTML, which is what the route asks for: the markup is part of what it rewrites. */
const rangeHtml = (editor: Editor, range: { from: number; to: number }): string =>
  getHTMLFromFragment(editor.state.doc.slice(range.from, range.to).content, editor.schema);

/**
 * How many words a run would be given.
 *
 * A number rather than an object, because `useEditorState` compares its selector's result: a fresh
 * object per transaction would re-render the panel on every keystroke in the document.
 */
const assistWords = (editor: Editor): number => {
  const range = assistRange(editor);
  if (!range) return 0;
  const text = editor.state.doc.textBetween(range.from, range.to, ' ').trim();
  return text ? text.split(/\s+/).length : 0;
};

/**
 * The answer as content to insert.
 *
 * A one-paragraph answer to a request made inside one paragraph is unwrapped to its inline content:
 * inserting the block there would split that paragraph in two around it. Everything else — the list
 * `summarize` answers with, an outline, several paragraphs — is inserted as blocks, and ProseMirror
 * makes exactly that split when the range sits inside a paragraph.
 */
const answerContent = (editor: Editor, html: string, inline: boolean): Insertable => {
  const parsed = createNodeFromContent(html, editor.schema, {
    parseOptions: { preserveWhitespace: 'full' },
  });
  // A string always parses to a fragment — `createNodeFromContent` slices by default — but its return
  // type allows a node as well, and `insertContentAt` accepts either.
  const only = isProseMirrorFragment(parsed) && parsed.childCount === 1 ? parsed.firstChild : null;
  return inline && only?.type.name === 'paragraph' ? only.content : parsed;
};

interface AssistantPanelProps {
  editor: Editor;
  /** The title of the content being written: context for the model, never inserted. */
  title?: string;
  onClose: () => void;
}

export default function AssistantPanel({ editor, title = '', onClose }: AssistantPanelProps) {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [task, setTask] = useState('improve');
  const [tone, setTone] = useState('professional');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<{ summary: string; removed: string[] } | null>(null);
  /** An answer whose text was deleted before it arrived, waiting for somewhere to go. */
  const [orphan, setOrphan] = useState<Insertable | null>(null);
  /** The range the request in flight was about; null when nothing is in flight. */
  const pending = useRef<PendingRange | null>(null);

  const words = useEditorState({
    editor,
    selector: ({ editor: instance }) => (instance ? assistWords(instance) : 0),
  });

  const loadStatus = useCallback(async (): Promise<void> => {
    setStatus({ state: 'loading' });
    try {
      const response = await fetch(AI_ASSIST_PATH, { headers: { Accept: 'application/json' } });
      const payload = (await response.json().catch(() => null)) as AssistantStatus | null;
      if (!response.ok || !payload) {
        throw new Error(`The assistant's settings could not be read (HTTP ${response.status}).`);
      }
      setStatus({ state: 'ready', status: payload });
    } catch (statusError: unknown) {
      setStatus({ state: 'failed', message: messageOf(statusError, 'The assistant could not be reached.') });
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Every edit made while an answer is on its way is folded into the range's mapping, so the answer
  // lands under the words it was written for even if the author kept typing after pressing the button.
  useEffect(() => {
    const fold = ({ transaction }: { transaction: Transaction }): void => {
      pending.current?.mapping.appendMapping(transaction.mapping);
    };
    editor.on('transaction', fold);
    return () => { editor.off('transaction', fold); };
  }, [editor]);

  const ready = status.state === 'ready' ? status.status : null;

  /** One insertion, so the answer and an orphaned answer take the same path into the document. */
  const place = (content: Insertable, range: { from: number; to: number }): void => {
    editor.chain().focus().insertContentAt(range, content).run();
  };

  /**
   * Puts an answer where it was asked for.
   *
   * The range is mapped through every edit made while the request was in flight, so an answer that
   * arrives late lands on the words it rewrote and not on what was typed since. When those words are
   * gone — the paragraph deleted, the selection cut — nothing is inserted at all: a rewrite appearing
   * in the middle of untouched prose is worse than no rewrite, so the panel keeps the answer and
   * offers to put it at the cursor instead.
   */
  const apply = (reply: AssistantAnswer): void => {
    const wanted = pending.current;
    pending.current = null;
    setAnswer({ summary: reply.summary, removed: reply.removed });
    if (!wanted) return;

    const content = answerContent(editor, reply.html, wanted.inline);
    // `from` biased forward and `to` biased back keeps text typed at either edge of the range out of
    // the replacement, so the answer covers the words that were asked about and nothing else.
    const from = wanted.mapping.mapResult(wanted.from, 1);
    const to = wanted.mapping.mapResult(wanted.to, -1);
    if (from.deleted || to.deleted || from.pos >= to.pos) {
      setOrphan(content);
      return;
    }
    setOrphan(null);
    place(content, { from: from.pos, to: to.pos });
  };

  /** Writes the orphaned answer at the cursor, never over whatever happens to be selected. */
  const insertOrphan = (): void => {
    if (!orphan) return;
    const at = editor.state.selection.from;
    place(orphan, { from: at, to: at });
    setOrphan(null);
  };

  const run = async (): Promise<void> => {
    const range = assistRange(editor);
    if (!range) {
      setError('Put the cursor in a sentence, or select the text you want the assistant to work on.');
      return;
    }
    const $from = editor.state.doc.resolve(range.from);
    const $to = editor.state.doc.resolve(range.to);

    pending.current = {
      from: range.from,
      to: range.to,
      // One paragraph in, one paragraph out: the answer's inline content goes back inside that
      // paragraph rather than a block being spliced into it.
      inline: $from.sameParent($to) && $from.parent.isTextblock,
      mapping: new Mapping(),
    };
    setBusy(true);
    setError('');
    setAnswer(null);

    try {
      // The route spends the site's key, so the server checks the caller's own capability against the
      // token: without this header the answer is a 401 even though this browser has a session.
      const { data } = await client.auth.getSession();
      const response = await fetch(AI_ASSIST_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.session?.access_token || ''}`,
        },
        body: JSON.stringify({
          task,
          tone: task === 'tone' ? tone : '',
          instruction,
          title,
          // A whole paragraph when the cursor is only in it: the model is asked to rewrite the text it
          // is given, and a sentence with no neighbours is the harder thing to improve.
          text: rangeHtml(editor, range),
        }),
      });
      const payload = (await response.json().catch(() => null)) as (AssistantAnswer & { error?: string }) | null;
      if (!response.ok || !payload?.html) {
        throw new Error(payload?.error || `The assistant failed (HTTP ${response.status}).`);
      }
      apply(payload);
    } catch (runError: unknown) {
      pending.current = null;
      setError(messageOf(runError, 'The assistant could not be reached.'));
      // A run usually fails because a setting changed under the panel — a key removed, a quota spent —
      // so the line at the top is re-read rather than left saying "Ready".
      void loadStatus();
    } finally {
      setBusy(false);
    }
  };

  // Saying this before anything is selected is what the GET is for: the route's own refusal says the
  // same thing, but only after an author has selected a paragraph and pressed the button.
  const statusLine = (() => {
    if (status.state === 'loading') return 'Checking whether the assistant is set up…';
    if (status.state === 'failed') return status.message;
    if (!status.status.readable) {
      return `This server cannot read ${status.status.hint}, so the assistant cannot run. Check its connection to the site database and reload.`;
    }
    if (!status.status.configured) return `The assistant is not set up yet. Add an AI key in ${status.status.hint}.`;
    return `Ready on ${status.status.providerName}${status.status.model ? ` · ${status.status.model}` : ''}.`;
  })();

  const tasks = ready?.tasks || [];
  const tones = ready?.tones || [];
  const canRun = Boolean(ready?.configured) && words > 0 && !busy;

  return (
    <div className={styles.panel} aria-label="Writing assistant" aria-busy={busy}>
      <div className={styles.head}>
        <span className={styles.title}>✨ Writing assistant</span>
        <button
          type="button"
          className={styles.close}
          title="Close the assistant"
          aria-label="Close the assistant"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <p className={styles.status} role="status">{statusLine}</p>

      <div className={styles.tasks} role="group" aria-label="What the assistant should do">
        {tasks.map((name) => (
          <button
            key={name}
            type="button"
            title={`Ask the assistant to ${name} the text`}
            aria-pressed={name === task}
            className={name === task ? styles.taskActive : styles.task}
            disabled={busy}
            onClick={() => { setTask(name); setError(''); }}
          >
            {labelOf(name)}
          </button>
        ))}
      </div>

      <div className={styles.row}>
        {task === 'tone' && (
          <label className={styles.field}>
            Tone
            <select
              className={styles.select}
              value={tone}
              disabled={busy}
              onChange={(event) => setTone(event.target.value)}
            >
              {tones.map((name) => <option key={name} value={name}>{labelOf(name)}</option>)}
            </select>
          </label>
        )}
        <label className={`${styles.field} ${styles.grow}`}>
          Anything else? (optional)
          <input
            className={styles.text}
            value={instruction}
            maxLength={INSTRUCTION_LIMIT}
            disabled={busy}
            placeholder="Keep it under 60 words"
            onChange={(event) => setInstruction(event.target.value)}
            // Enter is the author's instinct in a one-line field. The panel sits inside the host's own
            // <form>, so a form of its own — and a stray submit of the post — is not an option.
            onKeyDown={(event) => { if (event.key === 'Enter' && canRun) { event.preventDefault(); void run(); } }}
          />
        </label>
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.run} disabled={!canRun} onClick={() => void run()}>
          {busy ? 'Working…' : 'Rewrite'}
        </button>
        <span className={styles.note}>
          {words > 0
            ? `The assistant will work on ${words} ${words === 1 ? 'word' : 'words'}.`
            : 'Put the cursor in a sentence, or select the text to work on.'}
        </span>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}

      {answer && (
        <div className={styles.result}>
          {answer.summary && <p className={styles.summary} role="status">{answer.summary}</p>}
          {answer.removed.length > 0 && (
            <p className={styles.warning}>
              The answer carried {answer.removed.join(', ')}, which this editor cannot store, so it was dropped.
            </p>
          )}
        </div>
      )}

      {orphan && (
        <div className={styles.result}>
          <p className={styles.warning}>
            The text this was written for is no longer in the document, so nothing was inserted.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.run} onClick={insertOrphan}>Insert at the cursor</button>
            <button type="button" className={styles.ghost} onClick={() => setOrphan(null)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}


import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { findNode } from '../../lib/tree';
import {
  codeFields, fieldLabels, fieldsForMode, generateCodeEdit, modeOf, readCodeField,
  type CodeAiResult, type CodeField, type CodeFieldSet, type CodeMode,
} from '../../services/customCodeAi';
import Modal from '../Modal';
import { useEditor, useStore } from '../store';
import editorStyles from '../editor.module.css';
import styles from './codeAi.module.css';

type LinePart = { kind: 'same' | 'added' | 'removed'; text: string };

const MAX_DIFF_CELLS = 250_000;
const MAX_DIFF_LINES = 1_500;

/**
 * Line diff for code: common lines at the start and end are skipped, then the remaining block is
 * compared with a longest-common-subsequence table. Very large rewrites fall back to "all removed,
 * all added" rather than allocating a giant table in the browser.
 */
function diffLines(before: string, after: string): LinePart[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const parts: LinePart[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES || midA.length * midB.length > MAX_DIFF_CELLS) {
    midA.forEach((text) => parts.push({ kind: 'removed', text }));
    midB.forEach((text) => parts.push({ kind: 'added', text }));
  } else {
    const table = Array.from({ length: midA.length + 1 }, () => new Uint16Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { parts.push({ kind: 'same', text: midA[i] }); i += 1; j += 1; }
      else if (table[i + 1][j] >= table[i][j + 1]) { parts.push({ kind: 'removed', text: midA[i] }); i += 1; }
      else { parts.push({ kind: 'added', text: midB[j] }); j += 1; }
    }
    while (i < midA.length) { parts.push({ kind: 'removed', text: midA[i] }); i += 1; }
    while (j < midB.length) { parts.push({ kind: 'added', text: midB[j] }); j += 1; }
  }

  a.slice(endA).forEach((text) => parts.push({ kind: 'same', text }));
  return parts;
}

/** One side of the diff: before keeps unchanged + removed lines, after keeps unchanged + added. */
function CodeColumn({ parts, side }: { parts: LinePart[]; side: 'before' | 'after' }) {
  const shown = parts.filter((part) => (side === 'before' ? part.kind !== 'added' : part.kind !== 'removed'));
  return (
    <pre className={styles.code}>
      {shown.map((part, index) => (
        <span key={index} className={part.kind === 'removed' ? styles.lineRemoved : part.kind === 'added' ? styles.lineAdded : undefined}>
          {part.kind === 'removed' ? '- ' : part.kind === 'added' ? '+ ' : '  '}{part.text}{'\n'}
        </span>
      ))}
    </pre>
  );
}

const quickPrompts: Record<CodeMode, string[]> = {
  html: [
    'Turn this into a responsive pricing section with three plans.',
    'Make it mobile-first and stack the columns under 720px.',
    'Add a subtle entrance animation and clearly visible focus styles.',
    'Redesign it as a modern SaaS hero with a call to action.',
  ],
  react: [
    'Add a monthly / yearly toggle with React state.',
    'Make it mobile-first and stack the columns under 720px.',
    'Add a subtle entrance animation and clearly visible focus styles.',
    'Redesign it as a modern SaaS hero with a call to action.',
  ],
};

export default function CustomCodeAiModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { actions, getState } = useStore();
  const node = useEditor((state) => findNode(state.doc, nodeId));
  const canUndo = useEditor((state) => state.past.length > 0);
  const canRedo = useEditor((state) => state.future.length > 0);
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; warning?: boolean } | null>(null);
  const [result, setResult] = useState<CodeAiResult | null>(null);
  const [chosen, setChosen] = useState<Set<CodeField>>(new Set());
  const [originals, setOriginals] = useState<CodeFieldSet>({});
  const [applied, setApplied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const mode: CodeMode = node ? modeOf(node) : 'html';
  const active = fieldsForMode(mode);
  const codeSize = node ? active.reduce((total, field) => total + readCodeField(node, field).length, 0) : 0;
  const ready = Boolean(node && node.kind === 'widget' && node.type === 'html');

  const previews = useMemo(() => {
    if (!result) return [];
    return codeFields
      .filter((field) => result.fields[field] !== undefined)
      .map((field) => {
        const before = originals[field] ?? '';
        const after = result.fields[field] ?? '';
        const parts = diffLines(before, after);
        return {
          field,
          before,
          after,
          parts,
          added: parts.filter((part) => part.kind === 'added').length,
          removed: parts.filter((part) => part.kind === 'removed').length,
        };
      });
  }, [result, originals]);

  const handleClose = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    onClose();
  };

  const cancel = () => {
    if (!loading) { handleClose(); return; }
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError('The AI request was cancelled. Change the instruction and try again.');
  };

  const generate = async () => {
    const current = findNode(getState().doc, nodeId);
    if (!current || current.kind !== 'widget' || current.type !== 'html') {
      setError('That widget no longer exists. Close this window and select it again.');
      return;
    }

    const requestMode = modeOf(current);
    const snapshot: CodeFieldSet = {};
    for (const field of fieldsForMode(requestMode)) snapshot[field] = readCodeField(current, field);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    setNotice(null);
    setResult(null);
    setApplied(false);
    setOriginals(snapshot);

    try {
      const next = await generateCodeEdit({
        mode: requestMode,
        fields: snapshot,
        instruction,
        pageTitle: getState().seo.seo_title || getState().title,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResult(next);
      setChosen(new Set(codeFields.filter((field) => next.fields[field] !== undefined)));
      if (!Object.keys(next.fields).length) {
        setError('The AI suggested no changes. Add a more specific instruction and try again.');
      }
    } catch (generateError) {
      // A cancelled request that a newer one replaced must not report over the newer request.
      if (abortRef.current !== controller) return;
      setError(controller.signal.aborted
        ? 'The AI request was cancelled. Change the instruction and try again.'
        : generateError instanceof Error ? generateError.message : 'The AI request failed.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  const apply = () => {
    if (!result) return;
    const selected: CodeFieldSet = {};
    for (const field of codeFields) {
      const value = result.fields[field];
      if (chosen.has(field) && value !== undefined) selected[field] = value;
    }
    if (!Object.keys(selected).length) return;

    const outcome = actions.applyCodeAi(nodeId, selected, originals);
    if (!outcome.applied) {
      setError(outcome.stale
        ? 'Nothing was applied: the code changed after the AI read it. Generate again to work from the current version.'
        : 'Nothing was applied. The widget no longer exists, or the fields were already up to date.');
      return;
    }

    setError('');
    setNotice({
      warning: outcome.stale > 0,
      text: outcome.stale
        ? `${outcome.applied} field(s) updated. ${outcome.stale} field(s) were edited after the AI read them and were left as they are.`
        : `${outcome.applied} field(s) updated as one undo step.`,
    });
    setApplied(true);
    setResult(null);
    setChosen(new Set());
  };

  const undo = () => {
    actions.undo();
    setNotice({ text: 'Undone. Redo brings the AI version back.' });
  };

  const redo = () => {
    actions.redo();
    setNotice({ text: 'Redone. The AI version is back.' });
  };

  const toggle = (field: CodeField) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(field)) next.delete(field); else next.add(field);
    return next;
  });

  if (!node || node.kind !== 'widget' || node.type !== 'html') {
    return (
      <Modal title="AI code assistant" onClose={onClose}>
        <p className={editorStyles.errorText}>This Custom HTML widget no longer exists.</p>
      </Modal>
    );
  }


  return (
    <Modal title="✨ AI code assistant" onClose={handleClose} wide>
      <div className={styles.layout}>
        <section className={styles.card} aria-label="Widget being edited">
          <div className={styles.cardHead}>
            <span className={styles.kind}>{mode === 'react' ? 'React mode' : 'HTML mode'}</span>
            <span className={styles.meta}>{active.map((field) => fieldLabels[field]).join(' · ')} · {codeSize.toLocaleString('en-US')} characters</span>
          </div>
          <p className={styles.meta}>
            The AI receives this widget&apos;s code and your instruction, nothing else. It returns complete field values; you review the diff and choose what to apply.
          </p>
        </section>

        <label className={styles.field}>
          <span>What should the AI change?</span>
          <textarea
            className={editorStyles.input}
            rows={3}
            maxLength={1200}
            autoFocus
            value={instruction}
            disabled={loading}
            placeholder='e.g. "Turn this into a responsive pricing table with three plans and a monthly / yearly toggle."'
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>

        <div className={styles.quickPrompts} aria-label="Example instructions">
          {quickPrompts[mode].map((prompt) => (
            <button key={prompt} type="button" className={styles.quickPrompt} disabled={loading} onClick={() => setInstruction(prompt)}>
              {prompt}
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <button type="button" className={editorStyles.primaryButton} disabled={loading || instruction.trim().length < 3} onClick={() => void generate()}>
            <Sparkles size={14} aria-hidden="true" /> {loading ? 'Writing code…' : result ? 'Generate again' : 'Generate code'}
          </button>
          <button type="button" className={editorStyles.secondaryButton} onClick={cancel}>
            {loading ? 'Cancel request' : 'Cancel'}
          </button>
          <span className={styles.meta}>Uses the key on Settings → Integrations → AI. The edit is undoable with Ctrl+Z.</span>
        </div>

        {error && <p className={editorStyles.errorText} role="alert">{error}</p>}
        {loading && <p className={styles.loading} role="status">Asking the AI to rewrite {active.map((field) => fieldLabels[field]).join(', ')}…</p>}

        {result && previews.length > 0 && !loading && (
          <section className={styles.results} aria-label="Suggested code">
            <div className={styles.resultsHead}>
              <div>
                <strong>{previews.length} field{previews.length === 1 ? '' : 's'} rewritten</strong>
                {result.summary && <p className={styles.meta}>{result.summary}</p>}
              </div>
              <div className={styles.selectButtons}>
                <button type="button" onClick={() => setChosen(new Set(previews.map((preview) => preview.field)))}>Select all</button>
                <button type="button" onClick={() => setChosen(new Set())}>None</button>
              </div>
            </div>

            <ul className={styles.changeList}>
              {previews.map((preview) => (
                <li key={preview.field} className={chosen.has(preview.field) ? styles.changeChosen : styles.change}>
                  <label className={styles.changeHead}>
                    <input type="checkbox" checked={chosen.has(preview.field)} onChange={() => toggle(preview.field)} />
                    <span>{fieldLabels[preview.field]}</span>
                    <small>{preview.added} added · {preview.removed} removed</small>
                  </label>
                  <div className={styles.diff}>
                    <div className={styles.diffColumn}>
                      <span className={styles.diffLabel}>Current</span>
                      {preview.before ? <CodeColumn parts={preview.parts} side="before" /> : <p className={styles.emptyCode}>(empty)</p>}
                    </div>
                    <div className={styles.diffColumn}>
                      <span className={styles.diffLabel}>AI version</span>
                      {preview.after ? <CodeColumn parts={preview.parts} side="after" /> : <p className={styles.emptyCode}>(empty)</p>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className={styles.applyBar}>
              <span className={styles.meta}>Applied as one step: Ctrl+Z undoes it. {result.model && `Model: ${result.model}.`}</span>
              <button type="button" className={editorStyles.secondaryButton} onClick={handleClose}>Cancel</button>
              <button type="button" className={editorStyles.primaryButton} disabled={!chosen.size} onClick={apply}>
                Apply to code ({chosen.size})
              </button>
            </div>
          </section>
        )}

        {applied && (
          <section className={styles.appliedBar} aria-live="polite">
            <div>
              <strong>Applied to the widget</strong>
              <p className={notice?.warning ? editorStyles.warning : styles.meta}>
                {notice?.text || 'The AI edit is one undo step. Undo and Redo use the editor history.'}
              </p>
            </div>
            <button type="button" className={editorStyles.secondaryButton} disabled={!canUndo} onClick={undo}>Undo</button>
            <button type="button" className={editorStyles.secondaryButton} disabled={!canRedo} onClick={redo}>Redo</button>
            <button type="button" className={editorStyles.primaryButton} onClick={handleClose}>Done</button>
          </section>
        )}
      </div>
    </Modal>
  );
}


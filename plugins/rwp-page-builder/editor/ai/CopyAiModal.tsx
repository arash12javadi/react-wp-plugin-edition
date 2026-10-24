import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { getWidget } from '../../lib/registry';
import { findNode } from '../../lib/tree';
import {
  PROMPT_MAX_CHARS, describeTarget, extractTargetCopy, optimizeCopy, previewText,
  type AiTarget, type CopyChange, type OptimizePreset, type OptimizeResult, type OptimizeTone,
} from '../../services/sectionAi';
import Modal from '../Modal';
import { useEditor, useStore } from '../store';
import editorStyles from '../editor.module.css';
import styles from './copyAi.module.css';

const presets: Array<{ id: OptimizePreset; icon: string; label: string; help: string }> = [
  { id: 'seo', icon: '🎯', label: 'Improve Copy & SEO', help: 'Readable copy that uses the focus keyword naturally.' },
  { id: 'cta', icon: '⚡', label: 'Strengthen CTA', help: 'Action verbs and benefit-led buttons that convert.' },
  { id: 'shorten', icon: '✂️', label: 'Shorten & Simplify', help: 'Punchy, modern, fewer words.' },
  { id: 'tone', icon: '💬', label: 'Adjust Tone', help: 'Rewrite in a different voice.' },
];

const tones: Array<{ id: OptimizeTone; label: string }> = [
  { id: 'professional', label: 'Professional' },
  { id: 'casual', label: 'Casual' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'persuasive', label: 'Persuasive' },
];

/** The wording that changes with the scope, so one window can serve all three. */
const scopes: Record<AiTarget['kind'], { noun: string; apply: string; empty: string }> = {
  section: { noun: 'section', apply: 'Section', empty: 'This section has no editable text (only images, spacers, Custom HTML or dynamic content).' },
  widget: { noun: 'widget', apply: 'Widget', empty: 'This widget has no editable text (only images, icons or settings).' },
  field: { noun: 'field', apply: 'Field', empty: 'This field is empty. Write something first, then ask the AI to improve it.' },
};

type Part = { kind: 'same' | 'added' | 'removed'; text: string };

/**
 * Why a refinement arrived with nothing to apply.
 *
 * An empty result has three unrelated causes that look identical in the preview: the model judged the
 * copy already right (its own note says so), the server refused a rewrite (it returns why), or the
 * answer named no field this target sent. Saying "no changes" to all three hides the one cause the
 * editor can act on.
 */
function noChanges(result: OptimizeResult, noun: string): string {
  const parts: string[] = [];
  if (result.summary) parts.push(/[.!?]$/.test(result.summary) ? result.summary : `${result.summary}.`);
  if (result.rejected.length) {
    const listed = result.rejected.map((entry) => `“${entry.field}” (${entry.reason})`).join(', ');
    parts.push(`The original was kept for ${result.rejected.length} suggestion${result.rejected.length === 1 ? '' : 's'}: ${listed}.`);
  }
  if (result.ignored) {
    parts.push(`${result.ignored} rewrite${result.ignored === 1 ? '' : 's'} came back without naming a field of this ${noun}, so ${result.ignored === 1 ? 'it was' : 'they were'} dropped.`);
  }
  parts.push('Nothing was changed. Try another preset or a more specific instruction.');
  return parts.join(' ');
}

/** Word-level diff (longest common subsequence). Long texts fall back to a plain before/after. */
function diffWords(before: string, after: string): { left: Part[]; right: Part[] } {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > 250_000) return { left: [{ kind: 'removed', text: before }], right: [{ kind: 'added', text: after }] };
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const left: Part[] = [];
  const right: Part[] = [];
  const push = (list: Part[], kind: Part['kind'], text: string) => {
    const last = list[list.length - 1];
    if (last && last.kind === kind) last.text += text; else list.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(left, 'same', a[i]); push(right, 'same', b[j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { push(left, 'removed', a[i]); i += 1; }
    else { push(right, 'added', b[j]); j += 1; }
  }
  while (i < a.length) { push(left, 'removed', a[i]); i += 1; }
  while (j < b.length) { push(right, 'added', b[j]); j += 1; }
  return { left, right };
}

function Diff({ change }: { change: CopyChange }) {
  const { left, right } = useMemo(() => diffWords(previewText(change), previewText(change, change.after)), [change]);
  const render = (parts: Part[]) => parts.map((part, index) => (
    <span key={index} className={part.kind === 'added' ? styles.added : part.kind === 'removed' ? styles.removed : undefined}>{part.text}</span>
  ));
  return (
    <div className={styles.diff}>
      <div><span className={styles.diffLabel}>Original</span><p>{render(left)}</p></div>
      <div><span className={styles.diffLabel}>AI optimized</span><p>{render(right)}</p></div>
    </div>
  );
}

/**
 * "AI Refine", for a section, one widget or one text field.
 *
 * The three scopes are the same job with a different selection, so they share this window and the
 * `AiTarget` given to `optimizeCopy` decides what is sent: everything in the section, one widget's
 * copy, or a single control's value. Nothing is applied until the editor ticks the changes.
 */
export default function CopyAiModal({ target, onClose }: { target: AiTarget; onClose: () => void }) {
  const { actions, getState } = useStore();
  const node = useEditor((state) => findNode(state.doc, target.nodeId));
  const focusKeyword = useEditor((state) => state.seo.focus_keyword);
  const [preset, setPreset] = useState<OptimizePreset | null>('seo');
  const [tone, setTone] = useState<OptimizeTone>('professional');
  const [customPrompt, setCustomPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const words = scopes[target.kind];
  const definition = node?.kind === 'widget' ? getWidget(node.type) : null;
  const scopeName = target.kind === 'section' ? 'Section'
    : target.kind === 'widget' ? definition?.label || 'Widget'
      : definition?.controls.find((control) => control.key === target.key)?.label || 'Text field';
  const title = target.kind === 'section' ? '✨ AI Section Refine' : `✨ AI Refine — ${scopeName}`;

  // Read from the live document, so the preview and the request always match what is on the canvas.
  const overview = useMemo(() => (node ? describeTarget(getState().doc, target) : null), [node, target, getState]);
  const copy = useMemo(() => (node ? extractTargetCopy(getState().doc, target) : []), [node, target, getState]);
  const characters = copy.reduce((total, item) => total + previewText(item).length, 0);
  const overLimit = customPrompt.length > PROMPT_MAX_CHARS;

  const generate = async () => {
    setLoading(true);
    setError('');
    try {
      const state = getState();
      const next = await optimizeCopy({
        doc: state.doc, target, focusKeyword, preset, tone: preset === 'tone' ? tone : null,
        customPrompt: customPrompt.trim(), pageTitle: state.seo.seo_title || state.title,
      });
      setResult(next);
      setChosen(new Set(next.changes.map((change) => change.id)));
      if (!next.changes.length) setError(noChanges(next, words.noun));
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : 'The AI request failed.');
    } finally {
      setLoading(false);
    }
  };

  const apply = () => {
    if (!result) return;
    const selected = result.changes.filter((change) => chosen.has(change.id));
    const { applied, stale } = actions.applyAiCopy(selected);
    if (stale && !applied) {
      setError('Nothing was applied: every selected field was edited after the AI read it. Generate again.');
      return;
    }
    if (stale) window.alert(`${applied} change(s) applied. ${stale} field(s) were edited after the AI read them and were left as they are.`);
    onClose();
  };

  if (!node || !overview) {
    return (
      <Modal title="AI Refine" onClose={onClose}>
        <p className={editorStyles.errorText}>This element no longer exists.</p>
      </Modal>
    );
  }

  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className={styles.layout}>
        <section className={styles.overview} aria-label={`Selected ${words.noun}`}>
          <div className={styles.overviewHead}>
            <span className={styles.kind}>{overview.kind}</span>
            <span className={styles.meta}>
              {target.kind === 'section'
                ? `${overview.columns} column${overview.columns === 1 ? '' : 's'} · ${overview.position}`
                : [overview.position, target.kind === 'field' ? scopeName : ''].filter(Boolean).join(' · ')}
            </span>
          </div>
          {target.kind === 'section' && <p className={styles.meta}>{overview.widgets.join(', ') || 'No widgets'}</p>}
          {copy.length ? (
            <>
              <ul className={styles.preview}>
                {copy.map((item) => (
                  <li key={item.id}><small>{item.field}</small><span>{previewText(item)}</span></li>
                ))}
              </ul>
              <p className={styles.meta}>
                {copy.length} text field{copy.length === 1 ? '' : 's'} · {characters.toLocaleString('en-US')} characters.
                All of it is sent: there is no length limit, however long the {words.noun} is.
              </p>
            </>
          ) : (
            <p className={editorStyles.warning}>{words.empty}</p>
          )}
        </section>

        <section className={styles.controls} aria-label="Optimization options">
          <div className={styles.presets} role="radiogroup" aria-label="Preset">
            {presets.map((item) => (
              <button key={item.id} type="button" role="radio" aria-checked={preset === item.id}
                className={preset === item.id ? styles.presetActive : styles.preset}
                onClick={() => setPreset(preset === item.id ? null : item.id)}>
                <span className={styles.presetIcon} aria-hidden="true">{item.icon}</span>
                <strong>{item.label}</strong>
                <small>{item.help}</small>
              </button>
            ))}
          </div>
          {preset === 'tone' && (
            <div className={styles.tones} role="radiogroup" aria-label="Tone">
              {tones.map((item) => (
                <button key={item.id} type="button" role="radio" aria-checked={tone === item.id}
                  className={tone === item.id ? styles.toneActive : styles.tone} onClick={() => setTone(item.id)}>{item.label}</button>
              ))}
            </div>
          )}
          <label className={styles.field}>
            <span>✍️ Custom instruction {preset ? '(optional)' : ''}</span>
            <textarea className={editorStyles.input} rows={3} value={customPrompt}
              placeholder='e.g. "Make this sound like an Apple product launch"'
              onChange={(event) => setCustomPrompt(event.target.value)} />
            <span className={overLimit ? `${styles.promptMeta} ${styles.promptMetaOver}` : styles.promptMeta}>
              {customPrompt.length.toLocaleString('en-US')} / {PROMPT_MAX_CHARS.toLocaleString('en-US')} characters
            </span>
          </label>
          <p className={styles.meta}>
            {focusKeyword.trim() ? <>Focus keyword: <strong>{focusKeyword}</strong> (from the SEO tab).</> : 'No focus keyword set in the SEO tab; the SEO preset will focus on readability.'}
          </p>
          <div className={styles.actions}>
            <button type="button" className={editorStyles.primaryButton} disabled={loading || !copy.length || overLimit || (!preset && !customPrompt.trim())} onClick={() => void generate()}>
              <Sparkles size={14} aria-hidden="true" /> {loading ? 'Generating…' : result ? 'Regenerate' : 'Generate suggestions'}
            </button>
            <span className={styles.meta}>Only this {words.noun}’s text is sent, to the provider chosen on Settings → Integrations → AI. Links, images, layout and settings are never changed.</span>
          </div>
        </section>

        {error && <p className={editorStyles.errorText} role="alert">{error}</p>}
        {loading && <p className={styles.loading} role="status">Asking the AI to rewrite {copy.length} text field{copy.length === 1 ? '' : 's'}…</p>}

        {result && result.changes.length > 0 && !loading && (
          <section className={styles.results} aria-label="Suggested changes">
            <div className={styles.resultsHead}>
              <div>
                <strong>{result.changes.length} suggested change{result.changes.length === 1 ? '' : 's'}</strong>
                {result.summary && <p className={styles.meta}>{result.summary}</p>}
              </div>
              <div className={styles.selectButtons}>
                <button type="button" onClick={() => setChosen(new Set(result.changes.map((change) => change.id)))}>Select all</button>
                <button type="button" onClick={() => setChosen(new Set())}>None</button>
              </div>
            </div>
            {result.rejected.length > 0 && (
              <p className={editorStyles.warning}>
                Kept the original for {result.rejected.map((entry) => `“${entry.field}” (${entry.reason})`).join(', ')}.
              </p>
            )}
            <ul className={styles.changeList}>
              {result.changes.map((change) => (
                <li key={change.id} className={chosen.has(change.id) ? styles.changeChosen : styles.change}>
                  <label className={styles.changeHead}>
                    <input type="checkbox" checked={chosen.has(change.id)} onChange={() => toggle(change.id)} />
                    <span>{change.widget}</span>
                    <small>{change.field}</small>
                  </label>
                  <Diff change={change} />
                </li>
              ))}
            </ul>
            <div className={styles.applyBar}>
              <span className={styles.meta}>Applied as one step: Ctrl+Z undoes it.{result.model ? ` Model: ${result.model}.` : ''}</span>
              <button type="button" className={editorStyles.secondaryButton} onClick={onClose}>Cancel</button>
              <button type="button" className={editorStyles.primaryButton} disabled={!chosen.size} onClick={apply}>
                Apply to {words.apply} ({chosen.size})
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}




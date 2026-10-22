import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FileText, ImagePlus, Sparkles, Upload, X } from 'lucide-react';
import MediaManager from '../../../../src/components/MediaManager';
import { useGlobalStyles } from '../../lib/globals';
import {
  countPageWidgets, generatePage, pageAiOutline,
  type PageAiMedia, type PageAiResult, type PageAiStyle, type PageAiTone,
} from '../../services/pageAi';
import Modal from '../Modal';
import { useEditor, useStore } from '../store';
import editorStyles from '../editor.module.css';
import styles from './pageAi.module.css';

const MAX_PROMPT_CHARS = 4_000;
const MAX_FILE_CHARS = 30_000;
const MAX_MEDIA = 12;
const TEXT_FILE = /\.(txt|md|markdown|csv|json|html?|xml|ya?ml|log|rtf)$/i;

const tones: Array<{ id: PageAiTone; label: string }> = [
  { id: 'professional', label: 'Professional' },
  { id: 'friendly', label: 'Friendly' },
  { id: 'bold', label: 'Bold' },
  { id: 'premium', label: 'Premium' },
  { id: 'playful', label: 'Playful' },
];

const styles_: Array<{ id: PageAiStyle; label: string }> = [
  { id: 'modern', label: 'Modern' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'bold', label: 'Bold' },
  { id: 'elegant', label: 'Elegant' },
  { id: 'editorial', label: 'Editorial' },
];

interface BriefFile {
  name: string;
  content: string;
  truncated: boolean;
}

/**
 * "AI Page Generator": a brief, an optional text file and a few media references become a complete,
 * sanitized page. The generated sections are previewed first and inserted as one undoable step, so
 * a disappointing result never overwrites the page the author already has.
 */
export default function PageAiModal({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { actions } = store;
  const pageTitle = useEditor((state) => state.title);
  const sectionCount = useEditor((state) => state.doc.content.length);
  const globals = useGlobalStyles();

  const [brief, setBrief] = useState('');
  const [title, setTitle] = useState(pageTitle);
  const [tone, setTone] = useState<PageAiTone>('professional');
  const [stylePreset, setStylePreset] = useState<PageAiStyle>('modern');
  const [file, setFile] = useState<BriefFile | null>(null);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [media, setMedia] = useState<PageAiMedia[]>([]);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PageAiResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const readFile = async (picked: File) => {
    setFileError('');
    if (!/^text\//i.test(picked.type) && !TEXT_FILE.test(picked.name)) {
      setFile(null);
      setFileError('Attach a plain text file (.txt, .md, .csv, .json, .html and similar). Word, PDF and image files cannot be read as text.');
      return;
    }
    if (picked.size > 2_000_000) {
      setFile(null);
      setFileError('That file is larger than 2 MB. Attach a smaller brief, or paste the important part into the description.');
      return;
    }
    try {
      const text = (await picked.text()).replace(/\r\n?/g, '\n').trim();
      if (!text) {
        setFile(null);
        setFileError('That file is empty.');
        return;
      }
      setFile({
        name: picked.name.slice(0, 120),
        content: text.slice(0, MAX_FILE_CHARS),
        truncated: text.length > MAX_FILE_CHARS,
      });
    } catch {
      setFile(null);
      setFileError('The browser could not read that file. Try a different file or paste its text into the description.');
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const picked = event.dataTransfer.files?.[0];
    if (picked) void readFile(picked);
  };

  const openFilePicker = () => fileInput.current?.click();
  const onDropzoneKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  };

  const addMedia = (items: Array<{ url: string; title?: string | null; alt_text?: string | null }>) => {
    setMedia((current) => {
      const seen = new Set(current.map((item) => item.url));
      const additions = items
        .filter((item) => item.url && !seen.has(item.url))
        .map((item) => ({ url: item.url, title: item.title || '', alt: item.alt_text || '' }));
      return [...current, ...additions].slice(0, MAX_MEDIA);
    });
    setPicking(false);
  };

  const canGenerate = Boolean(brief.trim() || file) && !loading;

  const generate = async () => {
    if (!canGenerate) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const next = await generatePage({
        prompt: brief,
        fileName: file?.name,
        fileContent: file?.content,
        pageTitle: title,
        tone,
        stylePreset,
        media,
        colors: globals.colors,
      });
      if (alive.current) setResult(next);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'The page generator failed. Try again.');
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  const insert = () => {
    if (!result) return;
    actions.insertSections(result.sections);
    onClose();
  };

  const outline = result ? pageAiOutline(result.sections) : [];
  const widgetCount = result ? countPageWidgets(result.sections) : 0;

  return (
    <Modal title="✨ AI Page Generator" onClose={onClose} wide>
      <div className={styles.layout}>
        <p className={styles.intro}>
          Describe the page you need, add a source file if you have one, and pick the images it may use.
          The AI plans the sections, copy and layout; nothing is inserted until you approve the outline.
        </p>

        <label className={styles.field}>
          <span>What is this page for?</span>
          <textarea
            className={editorStyles.input}
            rows={5}
            maxLength={MAX_PROMPT_CHARS}
            autoFocus
            value={brief}
            placeholder={'e.g. "A landing page for our eco-friendly coffee subscription. Target busy professionals in Lisbon. Explain how it works, list three plans, answer common questions and end with a sign-up call to action."'}
            onChange={(event) => setBrief(event.target.value)}
          />
          <small className={styles.meta}>{brief.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()} characters. Mention the audience, the goal, must-have sections and any facts that must be exact.</small>
        </label>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Page title (context only)</span>
            <input className={editorStyles.input} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Tone of voice</span>
            <select className={editorStyles.input} value={tone} onChange={(event) => setTone(event.target.value as PageAiTone)}>
              {tones.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Visual style</span>
            <select className={editorStyles.input} value={stylePreset} onChange={(event) => setStylePreset(event.target.value as PageAiStyle)}>
              {styles_.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        </div>


        <div className={styles.field}>
          <span>Source file <small className={styles.optional}>(optional)</small></span>
          <div
            className={dragging ? styles.dropzoneActive : styles.dropzone}
            role="button"
            tabIndex={0}
            aria-label="Attach a text file"
            onClick={openFilePicker}
            onKeyDown={onDropzoneKey}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Upload size={20} aria-hidden="true" />
            <span><strong>Drop a text file here</strong> or click to choose one</span>
            <small>Briefs, content outlines, product notes, HTML copy — up to {MAX_FILE_CHARS.toLocaleString()} characters are sent.</small>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.yml,.yaml,.log,.rtf,text/*"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked) void readFile(picked);
                event.target.value = '';
              }}
            />
          </div>
          {file && (
            <div className={styles.fileCard}>
              <FileText size={16} aria-hidden="true" />
              <span>
                <strong>{file.name}</strong>
                <small>{file.content.length.toLocaleString()} characters used{file.truncated ? ' (the rest was truncated)' : ''}</small>
              </span>
              <button type="button" className={editorStyles.iconButtonLight} aria-label="Remove file" onClick={() => setFile(null)}><X size={15} /></button>
            </div>
          )}
          {fileError && <p className={editorStyles.errorText} role="alert">{fileError}</p>}
        </div>

        <div className={styles.field}>
          <span>Media it may use <small className={styles.optional}>(optional)</small></span>
          {media.length > 0 && (
            <ul className={styles.mediaList}>
              {media.map((item) => (
                <li key={item.url} className={styles.mediaChip}>
                  <img src={item.url} alt="" loading="lazy" />
                  <span title={item.alt || item.title || item.url}>{item.alt || item.title || 'Untitled image'}</span>
                  <button type="button" aria-label={`Remove ${item.alt || item.title || 'image'}`} onClick={() => setMedia((current) => current.filter((entry) => entry.url !== item.url))}><X size={13} /></button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.mediaActions}>
            <button type="button" className={editorStyles.secondaryButton} disabled={media.length >= MAX_MEDIA} onClick={() => setPicking(true)}>
              <ImagePlus size={15} aria-hidden="true" /> {media.length ? 'Add more media' : 'Choose media'}
            </button>
            <span className={styles.meta}>{media.length} of {MAX_MEDIA} selected. The AI may use these images and their alt text, but cannot reference any other URL.</span>
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={editorStyles.primaryButton} disabled={!canGenerate} onClick={() => void generate()}>
            <Sparkles size={15} aria-hidden="true" /> {loading ? 'Designing the page…' : result ? 'Generate again' : 'Generate page'}
          </button>
          <span className={styles.meta}>
            The brief, file and media details go to the provider chosen on Settings → Integrations → AI.
            The result is built from a fixed widget set and sanitized before it reaches the editor.
          </span>
        </div>

        {error && <p className={editorStyles.errorText} role="alert">{error}</p>}
        {loading && (
          <p className={styles.loading} role="status">
            Planning sections, writing copy and laying out the page. This can take up to a minute…
          </p>
        )}


        {result && !loading && (
          <section className={styles.results} aria-label="Generated page outline">
            <div className={styles.resultHead}>
              <div>
                <strong>{result.title || title || 'Generated page'}</strong>
                <p className={styles.meta}>
                  {outline.length} section{outline.length === 1 ? '' : 's'} · {widgetCount} widget{widgetCount === 1 ? '' : 's'}
                  {result.model ? ` · ${result.model}` : ''}
                </p>
              </div>
              <button type="button" className={styles.outlineLink} onClick={() => void generate()} disabled={!canGenerate}>Regenerate</button>
            </div>
            {result.summary && <p className={styles.summary}>{result.summary}</p>}
            <ol className={styles.outline}>
              {outline.map((section, index) => (
                <li key={`${section.label}-${index}`}>
                  <span className={styles.outlineIndex}>{index + 1}</span>
                  <div>
                    <strong>{section.label}</strong>
                    <small>{section.columns} column{section.columns === 1 ? '' : 's'} · {section.widgets.join(' · ') || 'No widgets'}</small>
                  </div>
                </li>
              ))}
            </ol>
            <div className={styles.insertBar}>
              <span className={styles.meta}>
                {sectionCount === 0
                  ? 'The page is empty, so these sections become the whole page.'
                  : `Added after the ${sectionCount} existing section${sectionCount === 1 ? '' : 's'}; Ctrl+Z undoes it.`}
              </span>
              <button type="button" className={editorStyles.secondaryButton} onClick={onClose}>Cancel</button>
              <button type="button" className={editorStyles.primaryButton} onClick={insert}>
                Insert {outline.length} section{outline.length === 1 ? '' : 's'}
              </button>
            </div>
          </section>
        )}
      </div>

      {picking && (
        <MediaManager
          heading="Page media"
          onClose={() => setPicking(false)}
          onSelectMany={addMedia}
        />
      )}
    </Modal>
  );
}


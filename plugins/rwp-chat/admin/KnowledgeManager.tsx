import { useCallback, useEffect, useState } from 'react';
import { formatDate } from '../../../src/lib/i18n';
import { acceptLabel, extractDocument, formatBytes, maxUploadBytes, uploadAccept } from '../lib/fileText';
import {
  createKnowledgeEntry, defaultKnowledgeSettings, deleteKnowledgeEntry, fetchKnowledgeEntry,
  fetchKnowledgeStats, listKnowledge, loadKnowledgeSettings, previewKnowledge, refineKnowledge,
  saveKnowledgeSettings, sourceLabels, statusLabels, syncKnowledge, updateKnowledgeEntry,
  type KnowledgeEntry, type KnowledgePreview, type KnowledgeRow, type KnowledgeSettings,
  type KnowledgeSource, type KnowledgeStats, type KnowledgeStatus, type RefineResult, type SyncSummary,
} from '../lib/knowledge';
import styles from './chat-admin.module.css';

/**
 * Chat → Knowledge: what the assistant is allowed to say.
 *
 * The corpus in one screen. Every published row here is text the bot may quote to a visitor, and
 * the three tabs are the three ways a row arrives: scraped from the site (kept fresh by the sync),
 * written here, or extracted from a document. They are the same table and the same editor — only
 * the way a row is started differs.
 *
 * The screen never decides what a visitor may see. Retrieval runs with the anon key, so a draft is
 * invisible to the assistant however it got there; publishing is the deliberate act that puts an
 * entry in front of customers.
 */

type Tab = KnowledgeSource;

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'scraped', label: 'From the site' },
  { id: 'manual', label: 'Written here' },
  { id: 'file', label: 'Uploaded files' },
];

/** Enough of an entry to edit it. `id` is null until the first save. */
interface DraftState {
  id: number | null;
  source: KnowledgeSource;
  title: string;
  url: string;
  status: KnowledgeStatus;
  content: string;
  metadata: Record<string, unknown>;
  /** What the extractor wanted the person to know, shown until the entry is saved. */
  note?: string;
}

const statusOptions: KnowledgeStatus[] = ['published', 'draft', 'archived'];

const statusBadgeClass = (status: KnowledgeStatus): string =>
  status === 'published' ? styles.badgeOn : status === 'draft' ? styles.badgeWarn : styles.badgeOff;

const blankDraft = (source: KnowledgeSource): DraftState => ({
  id: null,
  source,
  title: '',
  url: '',
  status: source === 'manual' ? 'published' : 'draft',
  content: '',
  metadata: {},
});

const draftOf = (entry: KnowledgeEntry): DraftState => ({
  id: entry.id,
  source: entry.source_type,
  title: entry.title,
  url: entry.url || '',
  status: entry.status,
  content: entry.content,
  metadata: entry.metadata || {},
  // A note about what extraction left out stays with the entry: it is a fact about the text, not
  // about the moment it was uploaded, so it is kept in metadata and shown again next time.
  note: typeof entry.metadata?.note === 'string' ? entry.metadata.note : undefined,
});

const signature = (draft: DraftState | null): string =>
  draft ? JSON.stringify([draft.title, draft.url, draft.status, draft.content]) : '';

const fileNameOf = (row: KnowledgeRow): string => {
  const name = row.metadata?.filename;
  return typeof name === 'string' ? name : '';
};

const syncMessage = (result: SyncSummary): string => {
  const parts = [
    `${result.created} new`,
    `${result.updated} updated`,
    `${result.unchanged} unchanged`,
  ];
  if (result.archived) parts.push(`${result.archived} retired because the page is gone`);
  if (result.skipped) parts.push(`${result.skipped} skipped as too short to answer anything`);
  return `Read ${result.pages} published page${result.pages === 1 ? '' : 's'}: ${parts.join(', ')}.`;
};

interface UploadResult {
  name: string;
  ok: boolean;
  message: string;
}

export default function KnowledgeManager() {
  const [tab, setTab] = useState<Tab>('scraped');
  const [rows, setRows] = useState<KnowledgeRow[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [settings, setSettings] = useState<KnowledgeSettings>(defaultKnowledgeSettings);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<KnowledgeStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // The editor. `baseline` is the signature of the draft as it was loaded or saved, so leaving with
  // unsaved changes can ask first instead of throwing them away.
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [baseline, setBaseline] = useState('');
  const [refined, setRefined] = useState<RefineResult | null>(null);
  const [instruction, setInstruction] = useState('');

  // The preview: what the assistant would be handed for a question somebody types here.
  const [question, setQuestion] = useState('');
  const [preview, setPreview] = useState<KnowledgePreview | null>(null);

  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadResult[]>([]);

  const dirty = draft ? signature(draft) !== baseline : false;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextRows, nextStats] = await Promise.all([
        listKnowledge({ source: tab, status: statusFilter, search }),
        fetchKnowledgeStats().catch(() => null),
      ]);
      setRows(nextRows);
      if (nextStats) setStats(nextStats);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The knowledge base could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, tab]);

  // Typing in the search box should not send a query per keystroke; everything else is immediate.
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [refresh, search]);

  const runSync = useCallback(async (ifStale: boolean) => {
    setBusy('sync');
    try {
      const result = await syncKnowledge(ifStale);
      if (result.deferred) {
        // An automatic pass that found nothing to do says nothing: nobody asked, and a line about
        // it on every visit would train people to ignore the panel.
        if (result.deferred === 'fresh') setSettings((current) => ({ ...current, lastSync: result.last_sync || current.lastSync }));
        return;
      }
      setNotice(syncMessage(result));
      setSettings((current) => ({ ...current, lastSync: result.last_sync || current.lastSync }));
      await refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The site could not be synced.');
    } finally {
      setBusy('');
    }
  }, [refresh]);

  // Settings first, because the automatic sync is one of them, and it runs at most once per open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadKnowledgeSettings();
        if (cancelled) return;
        setSettings(loaded);
        if (loaded.autoSync) await runSync(true);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'The knowledge settings could not be read.');
      }
    })();
    return () => { cancelled = true; };
    // Runs once: opening the screen is what "automatic" means here, and the server checks staleness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = async (patch: Partial<Pick<KnowledgeSettings, 'enabled' | 'autoSync' | 'syncHours'>>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await saveKnowledgeSettings({ enabled: next.enabled, autoSync: next.autoSync, syncHours: next.syncHours });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The settings were not saved.');
      try {
        setSettings(await loadKnowledgeSettings());
      } catch {
        // The read failing too is already reported by the error above.
      }
    }
  };

  const confirmLeave = (): boolean => !dirty || window.confirm('This entry has changes you have not saved. Leave it and lose them?');

  const openEntry = async (row: KnowledgeRow) => {
    if (!confirmLeave()) return;
    setBusy('open');
    setRefined(null);
    setInstruction('');
    try {
      const entry = await fetchKnowledgeEntry(row.id);
      const next = draftOf(entry);
      setDraft(next);
      setBaseline(signature(next));
      setNotice('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That entry could not be opened.');
      await refresh(true);
    } finally {
      setBusy('');
    }
  };

  const openNew = () => {
    if (!confirmLeave()) return;
    const next = blankDraft('manual');
    setDraft(next);
    setBaseline(signature(next));
    setRefined(null);
    setInstruction('');
    setNotice('');
  };


  const save = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      const saved = draft.id
        ? await updateKnowledgeEntry(draft.id, {
          title: draft.title,
          url: draft.url,
          status: draft.status,
          content: draft.content,
          metadata: draft.metadata,
        })
        : await createKnowledgeEntry({
          source: draft.source === 'scraped' ? 'manual' : draft.source,
          title: draft.title,
          url: draft.url,
          status: draft.status,
          content: draft.content,
          metadata: draft.metadata,
        });
      const next = draftOf(saved);
      setDraft(next);
      setBaseline(signature(next));
      setRefined(null);
      setNotice(saved.status === 'published'
        ? `Saved. The assistant may quote “${saved.title}” from now on.`
        : `Saved as ${statusLabels[saved.status].toLowerCase()}. The assistant only quotes published entries.`);
      await refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The entry was not saved.');
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!draft?.id) {
      setDraft(null);
      setBaseline('');
      return;
    }
    if (!window.confirm(`Delete “${draft.title}” for good? Archiving it instead keeps a record and stops the assistant quoting it.`)) return;
    setBusy('delete');
    try {
      await deleteKnowledgeEntry(draft.id);
      setDraft(null);
      setBaseline('');
      setNotice('Deleted. Nothing quotes that text any more.');
      await refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The entry was not deleted.');
    } finally {
      setBusy('');
    }
  };

  const runRefine = async () => {
    if (!draft) return;
    setBusy('refine');
    try {
      const result = await refineKnowledge({
        title: draft.title,
        content: draft.content,
        instruction: instruction.trim() || undefined,
      });
      setRefined(result);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The text could not be refined.');
    } finally {
      setBusy('');
    }
  };

  const applyRefined = () => {
    if (!refined || !draft) return;
    setDraft({ ...draft, title: refined.title || draft.title, content: refined.content });
    setRefined(null);
    // Applying only changes the editor: the entry is saved by the person who has read the rewrite.
    setNotice('The rewrite is in the editor, not saved yet. Read it, then save.');
  };

  const runPreview = async () => {
    const asked = question.trim();
    if (!asked) return;
    setBusy('preview');
    try {
      setPreview(await previewKnowledge(asked));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The question could not be tried.');
    } finally {
      setBusy('');
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy('upload');
    setUploads([]);
    const results: UploadResult[] = [];
    let first: KnowledgeEntry | null = null;
    for (const file of list) {
      try {
        const extracted = await extractDocument(file);
        const created = await createKnowledgeEntry({
          source: 'file',
          title: extracted.title,
          content: extracted.text,
          status: 'draft',
          metadata: { filename: file.name, mime_type: file.type || '', bytes: file.size, note: extracted.note || undefined },
        });
        if (!first) first = created;
        results.push({
          name: file.name,
          ok: true,
          message: `${formatBytes(file.size)} → ${extracted.text.length.toLocaleString()} characters, saved as a draft.${extracted.note ? ` ${extracted.note}` : ''}`,
        });
      } catch (caught) {
        results.push({
          name: file.name,
          ok: false,
          message: caught instanceof Error ? caught.message : 'That file could not be read.',
        });
      }
      setUploads([...results]);
    }
    if (first) {
      if (confirmLeave()) {
        const next = draftOf(first);
        setDraft(next);
        setBaseline(signature(next));
        setRefined(null);
        setInstruction('');
      }
    }
    await refresh(true);
    setBusy('');
  };


  const emptyCopy = tab === 'scraped'
    ? 'Nothing from the site yet. “Sync the site now” above copies every published page and post into this list.'
    : tab === 'manual'
      ? 'Nothing written here yet. An entry is the answer to a question customers keep asking.'
      : 'No documents yet. Drop one above; it arrives as a draft for you to read first.';

  return (
    <div className={styles.screen}>
      <h1 className={styles.heading}>Chat — Knowledge</h1>
      <p className={styles.lede}>
        Everything the assistant is allowed to quote. It answers only from published entries: pages
        and posts copied from this site, text written here, and documents uploaded here. An entry
        marked draft or archived is kept for you and never shown to a visitor.
      </p>

      {settings.enabled ? null : (
        <p className={`${styles.notice} ${styles.bad}`}>
          The knowledge library is switched off, so the assistant answers from the site&apos;s own
          pages only. Nothing on this screen reaches it until you switch it back on below.
        </p>
      )}
      {error ? <p className={`${styles.notice} ${styles.bad}`} role="alert">{error}</p> : null}
      {notice ? <p className={`${styles.notice} ${styles.ok}`}>{notice}</p> : null}

      <div className={styles.panel}>
        <h2>Where answers come from</h2>
        <p className={styles.hint}>
          The site&apos;s own pages are always available to the assistant. The library below adds
          what the pages do not say, and the assistant prefers it where the two disagree.
        </p>
        <div className={styles.grid}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void updateSettings({ enabled: event.target.checked })}
            />
            <span>
              Use this library in answers
              <small>Off leaves the assistant with the site pages it already reads.</small>
            </span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.autoSync}
              onChange={(event) => void updateSettings({ autoSync: event.target.checked })}
            />
            <span>
              Refresh from the site when this screen opens
              <small>At most once per interval, so opening the tab costs nothing.</small>
            </span>
          </label>
          <label className={styles.field}>
            Refresh at most once every
            <select
              value={String(settings.syncHours)}
              disabled={!settings.autoSync}
              onChange={(event) => void updateSettings({ syncHours: Number(event.target.value) })}
            >
              <option value="1">hour</option>
              <option value="6">6 hours</option>
              <option value="12">12 hours</option>
              <option value="24">day</option>
              <option value="72">3 days</option>
              <option value="168">week</option>
            </select>
          </label>
        </div>

        <div className={styles.actions}>
          <button className={styles.primary} onClick={() => void runSync(false)} disabled={busy === 'sync'}>
            {busy === 'sync' ? 'Reading the site…' : 'Sync the site now'}
          </button>
          <span className={styles.listMeta}>
            {settings.lastSync
              ? `Last sync ${formatDate(settings.lastSync)} at ${new Date(settings.lastSync).toLocaleTimeString()}`
              : 'Never synced. Until it runs, the library holds only what you add by hand.'}
          </span>
        </div>

        {stats ? (
          <div className={styles.stats}>
            <div className={styles.stat}><strong>{stats.published.toLocaleString()}</strong><span>published</span></div>
            <div className={styles.stat}><strong>{stats.draft.toLocaleString()}</strong><span>drafts</span></div>
            <div className={styles.stat}><strong>{stats.archived.toLocaleString()}</strong><span>archived</span></div>
            <div className={styles.stat}><strong>{stats.characters.toLocaleString()}</strong><span>characters</span></div>
            <div className={styles.stat}><strong>{stats.chunks.toLocaleString()}</strong><span>passages</span></div>
          </div>
        ) : null}
      </div>


      <div className={styles.panel}>
        <h2>Try a question</h2>
        <p className={styles.hint}>
          The knowledge lookup a visitor&apos;s message runs, against what is published right now.
          The site&apos;s own pages are quoted on top of anything this finds, so an empty result here
          means only that the library has nothing to add.
        </p>
        <form
          className={styles.filters}
          onSubmit={(event) => {
            event.preventDefault();
            void runPreview();
          }}
        >
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="e.g. how long does delivery take?"
            aria-label="A question a visitor might ask"
          />
          <button type="submit" className={styles.ghost} disabled={busy === 'preview' || !question.trim()}>
            {busy === 'preview' ? 'Looking…' : 'See what it finds'}
          </button>
        </form>
        {preview ? (
          preview.passages.length ? (
            <>
              <p className={styles.listMeta}>
                Looked for {preview.terms.length ? preview.terms.join(', ') : 'the whole question'} and
                found {preview.passages.length} passage{preview.passages.length === 1 ? '' : 's'}.
              </p>
              <div className={styles.passages}>
                {preview.passages.map((hit, index) => (
                  <div key={`${hit.title}:${hit.part}:${index}`} className={styles.listItem}>
                    <span className={styles.listName}>
                      {hit.title}{hit.part > 1 ? ` · part ${hit.part}` : ''}
                    </span>
                    <span className={styles.listMeta}>{hit.url || sourceLabels[hit.source_type] || hit.source_type}</span>
                    <p className={styles.quote}>{hit.text}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className={styles.empty}>
              Nothing published mentions that. Try the words a customer would use, or add an entry
              that answers it.
            </p>
          )
        ) : null}
      </div>


      <div className={draft ? styles.split : undefined}>
        <div className={styles.panel}>
          <div className={styles.tabs} role="tablist" aria-label="Where the entry came from">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
                onClick={() => {
                  setTab(item.id);
                  setSearch('');
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'file' ? (
            <div
              className={`${styles.dropzone} ${dragging ? styles.dropzoneActive : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void addFiles(event.dataTransfer.files);
              }}
            >
              <p><strong>Drop a document here</strong> and it becomes an entry.</p>
              <p className={styles.listMeta}>
                {acceptLabel} · up to {formatBytes(maxUploadBytes)} · extracted in the browser and
                saved as a draft, because reading a document is never perfect.
              </p>
              <label className={styles.ghost}>
                {busy === 'upload' ? 'Reading…' : 'Choose files'}
                <input
                  type="file"
                  accept={uploadAccept}
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = event.target.files;
                    event.target.value = '';
                    if (files) void addFiles(files);
                  }}
                />
              </label>
              {uploads.length ? (
                <ul className={styles.uploadList}>
                  {uploads.map((item) => (
                    <li key={item.name} className={item.ok ? styles.uploadOk : styles.uploadBad}>
                      <strong>{item.name}</strong> — {item.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className={styles.filters}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search titles, addresses and openings…"
              aria-label="Search the knowledge base"
            />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as KnowledgeStatus | 'all')}
              aria-label="Status"
            >
              <option value="all">Any status</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>{statusLabels[status]}</option>
              ))}
            </select>
            {tab === 'manual' ? (
              <button type="button" className={styles.ghost} onClick={() => openNew()}>
                New entry
              </button>
            ) : null}
          </div>

          {loading ? (
            <p className={styles.empty}>Loading…</p>
          ) : rows.length ? (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button type="button" className={styles.linkButton} onClick={() => void openEntry(row)}>
                        {row.title || 'Untitled'}
                      </button>
                      <div className={styles.listMeta}>
                        {row.url || fileNameOf(row) || row.excerpt.slice(0, 120)}
                      </div>
                    </td>
                    <td>
                      <span className={`${styles.badge} ${statusBadgeClass(row.status)}`}>
                        {statusLabels[row.status]}
                      </span>
                    </td>
                    <td className={styles.listMeta}>{formatDate(row.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={styles.empty}>{emptyCopy}</p>
          )}
          {rows.length >= 200 ? (
            <p className={styles.listMeta}>
              Showing the 200 most recently updated {tab === 'scraped' ? 'pages' : 'entries'}. Search
              to reach older ones.
            </p>
          ) : null}
        </div>


        {draft ? (
          <div className={styles.panel}>
            <h2>
              {draft.id
                ? draft.title || 'Untitled'
                : draft.source === 'file' ? 'New document entry' : 'New entry'}
            </h2>
            <p className={styles.hint}>
              {draft.source === 'scraped'
                ? 'Copied from a page on this site. Editing it here is safe: the next sync leaves an edited entry alone unless the page itself changes.'
                : draft.source === 'file'
                  ? 'Read out of a document. Fix anything the extraction mangled before publishing it — the assistant quotes this text word for word.'
                  : 'The assistant quotes this text to visitors, so write it the way the site would say it.'}
            </p>
            {draft.note ? <p className={`${styles.notice} ${styles.warn}`}>{draft.note}</p> : null}

            <div className={styles.stack}>
              <label className={styles.field}>
                Title
                <input
                  type="text"
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
                <small>What the list shows, and what a citation names.</small>
              </label>
              <label className={styles.field}>
                Status
                <select
                  value={draft.status}
                  onChange={(event) => setDraft({ ...draft, status: event.target.value as KnowledgeStatus })}
                >
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>{statusLabels[status]}</option>
                  ))}
                </select>
                <small>Only published entries are quoted. Draft is for something half-written.</small>
              </label>
              <label className={styles.field}>
                Page address
                <input
                  type="text"
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  placeholder="Leave empty when this is not a page"
                />
                <small>Shown beside a quote when the entry belongs to a page on this site.</small>
              </label>
              <label className={styles.field}>
                Text
                <textarea
                  className={styles.editorText}
                  value={draft.content}
                  spellCheck
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
                <small>
                  {draft.content.length.toLocaleString()} characters. A quoted passage is cut at 700,
                  and the AI rewrite reads the first 8,000.
                </small>
              </label>
            </div>

            {refined ? (
              <div className={styles.refined}>
                <h3>AI rewrite — not saved</h3>
                <p className={styles.listMeta}>
                  {refined.model}. The wording is the model&apos;s; the facts should not be, so check
                  every number before you use it.
                </p>
                {refined.truncated ? (
                  <p className={`${styles.notice} ${styles.bad}`}>
                    The original is longer than 8,000 characters, so this rewrite is missing its end.
                  </p>
                ) : null}
                {refined.title ? <p><strong>{refined.title}</strong></p> : null}
                <div className={styles.refinedText}>{refined.content}</div>
                <div className={styles.actions}>
                  <button type="button" className={styles.primary} onClick={applyRefined}>Use this text</button>
                  <button type="button" className={styles.ghost} onClick={() => setRefined(null)}>Keep mine</button>
                </div>
              </div>
            ) : null}

            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={() => void save()} disabled={Boolean(busy)}>
                {busy === 'save' ? 'Saving…' : draft.id ? 'Save changes' : 'Save entry'}
              </button>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => {
                  if (!confirmLeave()) return;
                  setDraft(null);
                  setBaseline('');
                  setRefined(null);
                }}
              >
                Close
              </button>
              <button type="button" className={`${styles.ghost} ${styles.danger}`} onClick={() => void remove()} disabled={Boolean(busy)}>
                {draft.id ? 'Delete' : 'Discard'}
              </button>
            </div>

            <div className={styles.refineBar}>
              <label className={styles.field}>
                Rewrite with AI
                <input
                  type="text"
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Optional: what to fix, e.g. “plain English, no lists”"
                />
                <small>Keeps every fact as written and drops navigation noise. Nothing is saved until you save.</small>
              </label>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => void runRefine()}
                disabled={Boolean(busy) || draft.content.trim().length < 20}
              >
                {busy === 'refine' ? 'Rewriting…' : 'Refine'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}


import { describeDbError, getSupabaseClient } from '../../../src/lib/db';
import { callChatServer, explainChatError } from './api';

/**
 * Chat → Knowledge: the curated library the assistant answers from.
 *
 * Every row is a piece of text the bot may quote: a page or post scraped from this site, something
 * written here, or a document somebody uploaded. Rows are read and edited with ordinary PostgREST
 * queries, because the table's policies already let a manage_options user do exactly that; only the
 * three operations that need a secret or a shared cache — scraping, the AI rewrite and the vector
 * preview — go through the server, and those live behind `POST /plugins/rwp-chat/knowledge/*`.
 *
 * Drafts are invisible to the assistant. That is the point of the status column: an upload lands as
 * a draft so a person reads it before the bot starts quoting it to customers.
 */

export type KnowledgeSource = 'scraped' | 'manual' | 'file';
export type KnowledgeStatus = 'published' | 'draft' | 'archived';

export const knowledgeSources: KnowledgeSource[] = ['scraped', 'manual', 'file'];

export const sourceLabels: Record<KnowledgeSource, string> = {
  scraped: 'Site page',
  manual: 'Written here',
  file: 'Uploaded file',
};

export const statusLabels: Record<KnowledgeStatus, string> = {
  published: 'Published',
  draft: 'Draft',
  archived: 'Archived',
};

/** A list row: everything except the body, which can be a couple of hundred thousand characters. */
export interface KnowledgeRow {
  id: number;
  source_type: KnowledgeSource;
  source_key: string;
  title: string;
  url: string | null;
  excerpt: string;
  status: KnowledgeStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEntry extends KnowledgeRow {
  content: string;
}

export interface KnowledgeStats {
  total: number;
  published: number;
  draft: number;
  archived: number;
  scraped: number;
  manual: number;
  file: number;
  characters: number;
  chunks: number;
  updated_at: string | null;
}

export interface KnowledgeFilter {
  source?: KnowledgeSource | 'all';
  status?: KnowledgeStatus | 'all';
  /**
   * Matches the title, the URL or the excerpt — not the body. PostgREST would happily scan that
   * too, but on a 300-page corpus it is slow enough to feel broken.
   */
  search?: string;
  limit?: number;
}

/** What the editor sends when somebody writes an entry or uploads a document. */
export interface KnowledgeDraft {
  source: 'manual' | 'file';
  title: string;
  url?: string;
  content: string;
  status?: KnowledgeStatus;
  metadata?: Record<string, unknown>;
}

/**
 * What the editor can change on any row, scraped ones included.
 *
 * Editing a scraped page is safe because `metadata.checksum` is never rewritten here: it still
 * describes the page as it was when the row was last copied, so the next sync recognises the row
 * as current and leaves the edit alone. The edit is replaced only when the page itself changes —
 * which is the one case where the page's own words are newer than the edit.
 */
export interface KnowledgePatch {
  title?: string;
  url?: string | null;
  content?: string;
  status?: KnowledgeStatus;
  metadata?: Record<string, unknown>;
}

/** What one scrape of the site did, as the server reports it. */
export interface SyncSummary {
  /** Published pages and posts read, up to the server's ceiling of 300. */
  pages: number;
  /** How many of those became entries. */
  indexed: number;
  /** Pages left out because they hold almost no text, e.g. a placeholder. */
  skipped: number;
  created: number;
  updated: number;
  /** Left alone: the page has not changed since the last sync, or the entry was archived by hand. */
  unchanged: number;
  /** Pages that are no longer published, and were retired from the library. */
  archived: number;
  last_sync: string | null;
  /**
   * Set when an automatic pass was deferred rather than run: 'off' because the switch is off, or
   * 'fresh' because the last sync is newer than the interval. The counts are zero in that case.
   */
  deferred?: 'off' | 'fresh';
}

export interface RefineResult {
  title: string;
  content: string;
  model: string;
  /** True when the AI output did not fit and was cut; the screen warns before applying it. */
  truncated: boolean;
}

export interface KnowledgePreviewHit {
  title: string;
  url: string;
  source_type: KnowledgeSource;
  /** Which passage of the entry this is, 1-based — the same numbering the table uses. */
  part: number;
  rank: number;
  text: string;
}

export interface KnowledgePreview {
  query: string;
  /** The words the retrieval actually looked for, stop words already dropped. */
  terms: string[];
  /** Empty when nothing published mentions the question. */
  passages: KnowledgePreviewHit[];
}

// The queries ---------------------------------------------------------------------------------------

const LIST_FIELDS = 'id,source_type,source_key,title,url,excerpt,status,metadata,created_at,updated_at';

/**
 * A refusal on this table is always the capability, never the schema — so say which capability.
 * Everything else (a missing table, PostgREST's stale cache, a missing function) is already
 * explained better by the shared helper, which knows where the schema file is.
 */
const explain = (error: unknown): string => {
  if (/row-level security|violates row-level/i.test(describeDbError(error))) {
    return 'The database refused this under row level security: curating the knowledge base needs the manage_options capability, so an Administrator has to do it.';
  }
  return explainChatError(error);
};

const randomId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Source keys are what makes a sync idempotent. A hand-written entry needs one that is unique
 * before the row exists, and a random identifier is the only honest answer.
 */
export const newSourceKey = (source: 'manual' | 'file'): string => `${source}:${randomId()}`;

const searchTerm = (value?: string): string => (value || '').trim().replace(/[%,()*]/g, ' ').trim();

export const listKnowledge = async (filter: KnowledgeFilter = {}): Promise<KnowledgeRow[]> => {
  let query = getSupabaseClient()
    .from('chat_knowledge_base')
    .select(LIST_FIELDS)
    .order('updated_at', { ascending: false })
    .limit(filter.limit || 200);
  if (filter.source && filter.source !== 'all') query = query.eq('source_type', filter.source);
  if (filter.status && filter.status !== 'all') query = query.eq('status', filter.status);
  const term = searchTerm(filter.search);
  if (term) query = query.or(`title.ilike.%${term}%,url.ilike.%${term}%,excerpt.ilike.%${term}%`);
  const { data, error } = await query;
  if (error) throw new Error(explain(error));
  return (data || []) as KnowledgeRow[];
};

/** The body plus everything else, for the editor. */
export const fetchKnowledgeEntry = async (id: number): Promise<KnowledgeEntry> => {
  const { data, error } = await getSupabaseClient()
    .from('chat_knowledge_base')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(explain(error));
  if (!data) throw new Error('That entry no longer exists — somebody may have deleted it. Reloading the list shows what is left.');
  return data as KnowledgeEntry;
};


export const createKnowledgeEntry = async (draft: KnowledgeDraft): Promise<KnowledgeEntry> => {
  const title = draft.title.trim();
  const content = draft.content.trim();
  if (!title) throw new Error('An entry needs a title — it is what the list and the citations show.');
  if (!content) throw new Error('An entry needs some text. The assistant has nothing to answer from otherwise.');
  const { data, error } = await getSupabaseClient()
    .from('chat_knowledge_base')
    .insert({
      source_type: draft.source,
      source_key: newSourceKey(draft.source),
      title,
      url: draft.url?.trim() || null,
      content,
      // A new upload is a draft until somebody reads it; text written here is deliberate already.
      status: draft.status || (draft.source === 'manual' ? 'published' : 'draft'),
      metadata: draft.metadata || {},
    })
    .select('*')
    .single();
  if (error) throw new Error(explain(error));
  return data as KnowledgeEntry;
};

export const updateKnowledgeEntry = async (id: number, patch: KnowledgePatch): Promise<KnowledgeEntry> => {
  const values: Record<string, unknown> = { ...patch };
  if (typeof patch.title === 'string') {
    if (!patch.title.trim()) throw new Error('An entry needs a title — it is what the list and the citations show.');
    values.title = patch.title.trim();
  }
  if (typeof patch.content === 'string') {
    if (!patch.content.trim()) throw new Error('An entry needs some text. Archiving it is the way to retire one.');
    values.content = patch.content.trim();
  }
  if (patch.url !== undefined) values.url = patch.url?.trim() || null;
  const { data, error } = await getSupabaseClient()
    .from('chat_knowledge_base')
    .update(values)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(explain(error));
  // An UPDATE that row level security refuses returns no error and no rows.
  if (!data) throw new Error('The entry was not saved: your role may not have the manage_options capability.');
  return data as KnowledgeEntry;
};

export const deleteKnowledgeEntry = async (id: number): Promise<void> => {
  const { data, error } = await getSupabaseClient()
    .from('chat_knowledge_base')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) throw new Error(explain(error));
  if (!data?.length) throw new Error('The entry was not deleted: removing knowledge needs the manage_options capability.');
};

export const fetchKnowledgeStats = async (): Promise<KnowledgeStats> => {
  const { data, error } = await getSupabaseClient().rpc('rwp_chat_knowledge_stats');
  if (error) throw new Error(explain(error));
  const stats = (data || {}) as Partial<KnowledgeStats>;
  return {
    total: Number(stats.total) || 0,
    published: Number(stats.published) || 0,
    draft: Number(stats.draft) || 0,
    archived: Number(stats.archived) || 0,
    scraped: Number(stats.scraped) || 0,
    manual: Number(stats.manual) || 0,
    file: Number(stats.file) || 0,
    characters: Number(stats.characters) || 0,
    chunks: Number(stats.chunks) || 0,
    updated_at: stats.updated_at || null,
  };
};

// The three server routes ---------------------------------------------------------------------------

/**
 * Re-scrapes the site through the server. `ifStale` is the automatic pass the screen runs on open:
 * the server answers `deferred: 'off' | 'fresh'` instead of reading every page again, so opening
 * the tab ten times a day costs nothing.
 */
export const syncKnowledge = async (ifStale = false): Promise<SyncSummary> =>
  callChatServer<SyncSummary>('knowledge/sync', { if_stale: ifStale });

/**
 * Rewrites one entry in the site's voice. The answer is returned to the editor, never saved: an AI
 * rewrite that saves itself is a rewrite nobody read.
 */
export const refineKnowledge = async (input: { title: string; content: string; instruction?: string }): Promise<RefineResult> =>
  callChatServer<RefineResult>('knowledge/refine', input);

/** What the assistant would be handed for a question, before a visitor asks it. */
export const previewKnowledge = async (query: string): Promise<KnowledgePreview> =>
  callChatServer<KnowledgePreview>('knowledge/search', { query });


// The two switches that live on this screen ----------------------------------------------------------

export interface KnowledgeSettings {
  /** Off means the assistant answers from the site's own pages only, ignoring this library. */
  enabled: boolean;
  /** Re-scrape automatically when an administrator opens this screen, at most once per interval. */
  autoSync: boolean;
  syncHours: number;
  lastSync: string;
}

export const defaultKnowledgeSettings: KnowledgeSettings = {
  enabled: true,
  autoSync: false,
  syncHours: 24,
  lastSync: '',
};

const knowledgeOptionNames = [
  'chat_knowledge_enabled',
  'chat_knowledge_auto_sync',
  'chat_knowledge_sync_hours',
  'chat_knowledge_last_sync',
];

export const loadKnowledgeSettings = async (): Promise<KnowledgeSettings> => {
  const { data, error } = await getSupabaseClient()
    .from('options')
    .select('option_name,option_value')
    .in('option_name', knowledgeOptionNames);
  // Options are world-readable, so a failure here is a broken install rather than a permission
  // problem. The defaults keep the screen usable either way.
  if (error) throw new Error(`The knowledge settings could not be read: ${describeDbError(error)}`);
  const values = Object.fromEntries((data || []).map((row) => [row.option_name as string, row.option_value as string]));
  const hours = Number(values.chat_knowledge_sync_hours);
  return {
    enabled: values.chat_knowledge_enabled !== 'false',
    autoSync: values.chat_knowledge_auto_sync === 'true',
    syncHours: Number.isFinite(hours) && hours > 0 ? hours : 24,
    lastSync: values.chat_knowledge_last_sync || '',
  };
};

/**
 * Writes the three editable options. The timestamp is the server's to write — it is the evidence
 * that a scrape actually ran, and a browser that could set it could silence the automatic pass.
 */
export const saveKnowledgeSettings = async (
  settings: Pick<KnowledgeSettings, 'enabled' | 'autoSync' | 'syncHours'>,
): Promise<void> => {
  const rows = [
    { option_name: 'chat_knowledge_enabled', option_value: settings.enabled ? 'true' : 'false' },
    { option_name: 'chat_knowledge_auto_sync', option_value: settings.autoSync ? 'true' : 'false' },
    { option_name: 'chat_knowledge_sync_hours', option_value: String(Math.max(1, Math.round(settings.syncHours) || 24)) },
  ];
  const { data, error } = await getSupabaseClient().from('options').upsert(rows).select('option_name');
  if (error) throw new Error(`The knowledge settings were not saved: ${describeDbError(error)}`);
  if ((data?.length ?? 0) < rows.length) {
    throw new Error('The knowledge settings were not saved: changing options needs the manage_options capability, and your role does not have it.');
  }
};


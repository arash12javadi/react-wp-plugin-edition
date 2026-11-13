/**
 * WordPress's taxonomy and term functions.
 *
 * Two taxonomies exist out of the box:
 *   - 'category'  public.categories; one category per post (pages.category_id). Hierarchy is not stored.
 *   - 'post_tag'  public.rwp_terms with public.rwp_term_relationships; many tags per post.
 * rwp_register_taxonomy() adds more; their terms are rows of rwp_terms too. A taxonomy is a registry
 * entry (code, per page load, like WordPress's), so a plugin registers it in an rwp_init callback.
 *
 * Terms come back in WordPress's shape (`term_id`, `name`, `slug`, `taxonomy`, `description`,
 * `parent`, `count`) beside the stored columns. `term_taxonomy_id` equals `term_id`: React-WP has no
 * separate term-taxonomy table. Every function that reads or writes is async. Who may write is decided
 * by row level security (manage_categories for terms, edit rights on the post for assignments).
 *
 * Not provided: term meta storage is rwp_meta (see meta.ts); there is no public archive route for
 * taxonomies other than 'category', so rwp_get_term_link() for them is an address that renders nothing.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { client } from '../db';
import { RWP_Error } from './errors';
import { rwp_sanitize_title, rwp_strip_all_tags } from './formatting';

export interface RWP_Term extends Record<string, unknown> {
  term_id: string;
  term_taxonomy_id: string;
  id: string;
  name: string;
  slug: string;
  taxonomy: string;
  description: string;
  parent: string;
  count?: number;
}

export interface TaxonomyArgs {
  label?: string;
  labels?: Record<string, string>;
  public?: boolean;
  hierarchical?: boolean;
  show_ui?: boolean;
  show_in_rest?: boolean;
  rewrite?: boolean | { slug?: string };
  object_type?: string[];
}

export interface RWP_Taxonomy extends TaxonomyArgs {
  name: string;
  object_type: string[];
  label: string;
  builtin: boolean;
}

const taxonomies = new Map<string, RWP_Taxonomy>();

taxonomies.set('category', { name: 'category', label: 'Categories', object_type: ['post'], public: true, hierarchical: true, builtin: true });
taxonomies.set('post_tag', { name: 'post_tag', label: 'Tags', object_type: ['post'], public: true, hierarchical: false, builtin: true });

const invalidTaxonomy = (taxonomy: string): RWP_Error => new RWP_Error('invalid_taxonomy', `The taxonomy "${taxonomy}" is not registered.`);

/** Registers a taxonomy for one or more post types. Returns the taxonomy, or an RWP_Error for a bad name. */
export function rwp_register_taxonomy(taxonomy: string, objectType: string | string[] = [], args: TaxonomyArgs = {}): RWP_Taxonomy | RWP_Error {
  if (!/^[a-z0-9_-]{1,32}$/.test(taxonomy)) return new RWP_Error('taxonomy_length_invalid', 'Taxonomy names must be between 1 and 32 characters of lowercase letters, digits, dashes and underscores.');
  const merged = applyFilters<TaxonomyArgs>('rwp_register_taxonomy_args', { public: true, hierarchical: false, ...args }, taxonomy, Array.isArray(objectType) ? objectType : [objectType]);
  const specific = applyFilters<TaxonomyArgs>(`rwp_register_${taxonomy}_taxonomy_args`, merged, taxonomy, Array.isArray(objectType) ? objectType : [objectType]);
  const entry: RWP_Taxonomy = { ...specific, name: taxonomy, label: specific.label ?? taxonomy, object_type: Array.isArray(objectType) ? objectType : [objectType], builtin: taxonomies.get(taxonomy)?.builtin ?? false };
  taxonomies.set(taxonomy, entry);
  doAction('rwp_registered_taxonomy', taxonomy, entry.object_type, entry);
  doAction(`rwp_registered_taxonomy_${taxonomy}`, taxonomy, entry.object_type, entry);
  return entry;
}

/** Removes a taxonomy. The built-in ones cannot be removed. */
export function rwp_unregister_taxonomy(taxonomy: string): true | RWP_Error {
  const entry = taxonomies.get(taxonomy);
  if (!entry) return invalidTaxonomy(taxonomy);
  if (entry.builtin) return new RWP_Error('invalid_taxonomy', 'The built-in taxonomies cannot be unregistered.');
  taxonomies.delete(taxonomy);
  doAction('rwp_unregistered_taxonomy', taxonomy);
  return true;
}

export const rwp_taxonomy_exists = (taxonomy: string): boolean => taxonomies.has(taxonomy);

export const rwp_get_taxonomy = (taxonomy: string): RWP_Taxonomy | false => taxonomies.get(taxonomy) ?? false;

export function rwp_get_taxonomies(args: { object_type?: string[]; public?: boolean; _builtin?: boolean } = {}, output: 'names' | 'objects' = 'names'): string[] | Record<string, RWP_Taxonomy> {
  const list = [...taxonomies.values()].filter((entry) => (args.public === undefined || Boolean(entry.public) === args.public)
    && (args._builtin === undefined || entry.builtin === args._builtin)
    && (!args.object_type || args.object_type.some((type) => entry.object_type.includes(type))));
  return output === 'names' ? list.map((entry) => entry.name) : Object.fromEntries(list.map((entry) => [entry.name, entry]));
}

/** The taxonomies attached to a post type. */
export function rwp_get_object_taxonomies(objectType: string | { post_type?: string }, output: 'names' | 'objects' = 'names'): string[] | Record<string, RWP_Taxonomy> {
  const type = typeof objectType === 'string' ? objectType : objectType.post_type ?? 'post';
  return rwp_get_taxonomies({ object_type: [type] }, output);
}

// Rows ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; name?: string; slug?: string };

const fromRow = (row: Row, taxonomy: string): RWP_Term => ({
  ...row,
  term_id: row.id,
  term_taxonomy_id: row.id,
  name: String(row.name ?? ''),
  slug: String(row.slug ?? ''),
  taxonomy,
  description: String(row.description ?? ''),
  parent: String(row.parent ?? '0'),
}) as RWP_Term;

const table = (taxonomy: string): 'categories' | 'rwp_terms' => (taxonomy === 'category' ? 'categories' : 'rwp_terms');


async function counts(taxonomy: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (taxonomy === 'category') {
    const { data } = await client.from('pages').select('category_id').eq('status', 'published').not('category_id', 'is', null).limit(5000);
    for (const row of (data || []) as Array<{ category_id: string }>) map.set(row.category_id, (map.get(row.category_id) || 0) + 1);
  } else {
    const { data } = await client.from('rwp_term_relationships').select('term_id').limit(5000);
    for (const row of (data || []) as Array<{ term_id: string }>) map.set(row.term_id, (map.get(row.term_id) || 0) + 1);
  }
  return map;
}

export interface GetTermsArgs {
  taxonomy?: string;
  hide_empty?: boolean;
  number?: number;
  offset?: number;
  search?: string;
  slug?: string;
  orderby?: 'name' | 'slug' | 'count' | 'id';
  order?: 'ASC' | 'DESC';
  include?: string[];
  parent?: string | number;
  fields?: 'all' | 'ids' | 'names' | 'slugs';
}

/** The terms of a taxonomy. `count` is filled when you ask to hide empty terms or to order by count. */
export async function rwp_get_terms(args: GetTermsArgs | string = {}): Promise<RWP_Term[] | string[] | RWP_Error> {
  const raw = typeof args === 'string' ? { taxonomy: args } : args;
  const query = applyFilters<GetTermsArgs>('rwp_get_terms_args', { taxonomy: 'category', hide_empty: false, orderby: 'name', order: 'ASC', fields: 'all', ...raw }, [raw.taxonomy ?? 'category']);
  const taxonomy = query.taxonomy ?? 'category';
  if (!taxonomies.has(taxonomy)) return invalidTaxonomy(taxonomy);
  let request = client.from(table(taxonomy)).select('*');
  if (taxonomy !== 'category') request = request.eq('taxonomy', taxonomy);
  if (query.slug) request = request.eq('slug', query.slug);
  if (query.search) request = request.ilike('name', `%${query.search.replace(/[%_]/g, '')}%`);
  if (query.include?.length) request = request.in('id', query.include);
  if (taxonomy !== 'category' && query.parent !== undefined) request = String(query.parent) === '0' ? request.is('parent', null) : request.eq('parent', String(query.parent));
  const { data, error } = await request;
  if (error) return new RWP_Error('db_error', error.message);
  let terms = ((data || []) as Row[]).map((row) => fromRow(row, taxonomy));
  if (query.hide_empty || query.orderby === 'count') {
    const tally = await counts(taxonomy);
    terms = terms.map((term) => ({ ...term, count: tally.get(term.term_id) ?? 0 }));
    if (query.hide_empty) terms = terms.filter((term) => (term.count ?? 0) > 0);
  }
  const key = query.orderby === 'id' ? 'term_id' : query.orderby ?? 'name';
  const direction = String(query.order).toUpperCase() === 'DESC' ? -1 : 1;
  terms.sort((a, b) => {
    const x = a[key] as string | number; const y = b[key] as string | number;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * direction;
  });
  if (query.offset) terms = terms.slice(query.offset);
  if (query.number) terms = terms.slice(0, query.number);
  const filtered = applyFilters<RWP_Term[]>('rwp_get_terms', terms, [taxonomy], query, {});
  if (query.fields === 'ids') return filtered.map((term) => term.term_id);
  if (query.fields === 'names') return filtered.map((term) => term.name);
  if (query.fields === 'slugs') return filtered.map((term) => term.slug);
  return filtered;
}

/** One term by id, or null. */
export async function rwp_get_term(termId: string, taxonomy = 'category'): Promise<RWP_Term | null | RWP_Error> {
  if (!taxonomies.has(taxonomy)) return invalidTaxonomy(taxonomy);
  const { data } = await client.from(table(taxonomy)).select('*').eq('id', termId).maybeSingle();
  if (!data) return null;
  const term = fromRow(data as Row, taxonomy);
  return applyFilters<RWP_Term>(`rwp_get_${taxonomy}`, applyFilters<RWP_Term>('rwp_get_term', term, taxonomy), taxonomy);
}

/** One term by 'id', 'slug' or 'name', or false. */
export async function rwp_get_term_by(field: 'id' | 'slug' | 'name', value: string, taxonomy = 'category'): Promise<RWP_Term | false | RWP_Error> {
  if (!taxonomies.has(taxonomy)) return invalidTaxonomy(taxonomy);
  let request = client.from(table(taxonomy)).select('*').eq(field, value);
  if (taxonomy !== 'category') request = request.eq('taxonomy', taxonomy);
  const { data } = await request.limit(1).maybeSingle();
  return data ? fromRow(data as Row, taxonomy) : false;
}

/** { term_id, term_taxonomy_id } when the term exists (by id, slug or name), 0 when not. */
export async function rwp_term_exists(term: string | number, taxonomy = '', parent: string | null = null): Promise<{ term_id: string; term_taxonomy_id: string } | 0 | null> {
  void parent;
  const value = String(term);
  if (!value) return 0;
  for (const name of taxonomy ? [taxonomy] : [...taxonomies.keys()]) {
    for (const field of ['id', 'slug', 'name'] as const) {
      if (field === 'id' && !/^[0-9a-f-]{36}$/i.test(value)) continue;
      const found = await rwp_get_term_by(field, value, name);
      if (found && !(found instanceof RWP_Error)) return { term_id: found.term_id, term_taxonomy_id: found.term_taxonomy_id };
    }
  }
  return 0;
}

export interface TermArgs { slug?: string; description?: string; parent?: string }

/** Adds a term. Returns { term_id, term_taxonomy_id }, or an RWP_Error. */
export async function rwp_insert_term(term: string, taxonomy: string, args: TermArgs = {}): Promise<{ term_id: string; term_taxonomy_id: string } | RWP_Error> {
  if (!taxonomies.has(taxonomy)) return invalidTaxonomy(taxonomy);
  const pre = applyFilters<string | RWP_Error | null>('rwp_pre_insert_term', term, taxonomy, args);
  if (pre instanceof RWP_Error) return pre;
  const name = rwp_strip_all_tags(String(pre ?? term)).trim();
  if (!name) return new RWP_Error('empty_term_name', 'A name is required for this term.');
  const slug = rwp_sanitize_title(args.slug || name);
  if (!slug) return new RWP_Error('empty_term_name', 'The name cannot be turned into a slug.');
  if (await rwp_get_term_by('slug', slug, taxonomy)) return new RWP_Error('term_exists', 'A term with the name provided already exists in this taxonomy.');
  const row: Record<string, unknown> = applyFilters('rwp_insert_term_data', { name, slug, description: args.description ?? '', ...(taxonomy === 'category' ? {} : { taxonomy, parent: args.parent && args.parent !== '0' ? args.parent : null }) }, taxonomy, args);
  doAction('rwp_create_term', '', taxonomy, args);
  doAction(`rwp_create_${taxonomy}`, '', args);
  const { data, error } = await client.from(table(taxonomy)).insert(row).select('id');
  const id = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (error || !id) return new RWP_Error('db_insert_error', error?.message ?? 'The database did not save the term. Managing terms needs the manage_categories capability.');
  doAction('rwp_created_term', id, id, taxonomy, args);
  doAction(`rwp_created_${taxonomy}`, id, id, args);
  doAction('rwp_saved_term', id, id, false, args);
  doAction(`rwp_saved_${taxonomy}`, id, id, false, args);
  return { term_id: id, term_taxonomy_id: id };
}

/** Changes a term. Returns { term_id, term_taxonomy_id }, or an RWP_Error. */
export async function rwp_update_term(termId: string, taxonomy: string, args: TermArgs & { name?: string } = {}): Promise<{ term_id: string; term_taxonomy_id: string } | RWP_Error> {
  const existing = await rwp_get_term(termId, taxonomy);
  if (existing instanceof RWP_Error) return existing;
  if (!existing) return new RWP_Error('invalid_term', 'Empty Term.');
  const changes: Record<string, unknown> = {};
  if (args.name !== undefined) changes.name = rwp_strip_all_tags(args.name).trim() || existing.name;
  if (args.slug !== undefined) changes.slug = rwp_sanitize_title(args.slug) || existing.slug;
  if (args.description !== undefined) changes.description = args.description;
  if (taxonomy !== 'category' && args.parent !== undefined) changes.parent = args.parent && args.parent !== '0' ? args.parent : null;
  doAction('rwp_edit_term', termId, termId, taxonomy, args);
  doAction(`rwp_edit_${taxonomy}`, termId, termId, args);
  const { data, error } = await client.from(table(taxonomy)).update(changes).eq('id', termId).select('id');
  if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_update_error', error?.message ?? 'The database skipped this term. Managing terms needs the manage_categories capability.');
  doAction('rwp_edited_term', termId, termId, taxonomy, args);
  doAction(`rwp_edited_${taxonomy}`, termId, termId, args);
  doAction('rwp_saved_term', termId, termId, true, args);
  doAction(`rwp_saved_${taxonomy}`, termId, termId, true, args);
  return { term_id: termId, term_taxonomy_id: termId };
}

/** Deletes a term (and its assignments). Returns true, false when there is none, or an RWP_Error. */
export async function rwp_delete_term(termId: string, taxonomy: string, args: { default?: string } = {}): Promise<boolean | RWP_Error> {
  const existing = await rwp_get_term(termId, taxonomy);
  if (existing instanceof RWP_Error) return existing;
  if (!existing) return false;
  doAction('rwp_pre_delete_term', termId, taxonomy);
  doAction('rwp_delete_term', termId, termId, taxonomy, existing, [], args);
  doAction(`rwp_delete_${taxonomy}`, termId, termId, existing, []);
  if (taxonomy === 'category') await client.from('pages').update({ category_id: args.default ?? null }).eq('category_id', termId);
  const { data, error } = await client.from(table(taxonomy)).delete().eq('id', termId).select('id');
  if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_delete_error', error?.message ?? 'The database skipped this term. Managing terms needs the manage_categories capability.');
  return true;
}

// Terms of an object ---------------------------------------------------------------------------------

const postId = (post: number | string | { ID?: number; id?: number }): number => Number(typeof post === 'object' ? (post.ID ?? post.id) : post);

/** The terms attached to a post for one taxonomy. */
export async function rwp_get_object_terms(objectId: number | string | Array<number | string>, taxonomies_: string | string[], args: { fields?: 'all' | 'ids' | 'names' | 'slugs' } = {}): Promise<RWP_Term[] | string[] | RWP_Error> {
  const id = postId(Array.isArray(objectId) ? objectId[0] : objectId);
  const list = Array.isArray(taxonomies_) ? taxonomies_ : [taxonomies_];
  const found: RWP_Term[] = [];
  for (const taxonomy of list) {
    if (!taxonomies.has(taxonomy)) return invalidTaxonomy(taxonomy);
    if (taxonomy === 'category') {
      const { data: page } = await client.from('pages').select('category_id').eq('id', id).maybeSingle();
      const categoryId = (page as { category_id?: string | null } | null)?.category_id;
      if (categoryId) { const term = await rwp_get_term(categoryId, 'category'); if (term && !(term instanceof RWP_Error)) found.push(term); }
    } else {
      const { data: links } = await client.from('rwp_term_relationships').select('term_id,term_order').eq('object_id', id).order('term_order');
      const ids = ((links || []) as Array<{ term_id: string }>).map((link) => link.term_id);
      if (ids.length) {
        const { data } = await client.from('rwp_terms').select('*').in('id', ids).eq('taxonomy', taxonomy);
        found.push(...((data || []) as Row[]).map((row) => fromRow(row, taxonomy)));
      }
    }
  }
  const filtered = applyFilters<RWP_Term[]>('rwp_get_object_terms', found, [id], list, args);
  if (args.fields === 'ids') return filtered.map((term) => term.term_id);
  if (args.fields === 'names') return filtered.map((term) => term.name);
  if (args.fields === 'slugs') return filtered.map((term) => term.slug);
  return filtered;
}

/** WordPress's get_the_terms: the terms of a post, or false when there are none. */
export async function rwp_get_the_terms(post: number | string | { ID?: number; id?: number }, taxonomy: string): Promise<RWP_Term[] | false | RWP_Error> {
  const terms = await rwp_get_object_terms(postId(post), taxonomy);
  if (terms instanceof RWP_Error) return terms;
  const filtered = applyFilters<RWP_Term[] | false>('rwp_get_the_terms', terms as RWP_Term[], postId(post), taxonomy);
  return filtered && (filtered as RWP_Term[]).length ? filtered : false;
}

/** The terms of a post, with a taxonomy (default post_tag). */
export async function rwp_get_post_terms(post: number | string | { ID?: number; id?: number }, taxonomy = 'post_tag', args: { fields?: 'all' | 'ids' | 'names' | 'slugs' } = {}): Promise<RWP_Term[] | string[] | RWP_Error> {
  return rwp_get_object_terms(postId(post), taxonomy, args);
}

/**
 * Replaces (or, with `append`, adds to) the terms of a post. `terms` are ids, slugs or names; a name that
 * does not exist yet is created for a non-hierarchical taxonomy, as in WordPress. For 'category' the
 * first term is the post's category. Returns the term ids, or an RWP_Error.
 */
export async function rwp_set_object_terms(objectId: number | string, terms: string | Array<string | number>, taxonomy: string, append = false): Promise<string[] | RWP_Error> {
  const id = postId(objectId);
  if (!taxonomies.has(taxonomy)) return invalidTaxonomy(taxonomy);
  const wanted = (Array.isArray(terms) ? terms : String(terms).split(',')).map((term) => String(term).trim()).filter(Boolean);
  const ids: string[] = [];
  for (const term of wanted) {
    const existing = await rwp_term_exists(term, taxonomy);
    if (existing) { ids.push(existing.term_id); continue; }
    if (taxonomies.get(taxonomy)?.hierarchical) continue;
    const created = await rwp_insert_term(term, taxonomy);
    if (created instanceof RWP_Error) return created;
    ids.push(created.term_id);
  }
  const before = (await rwp_get_object_terms(id, taxonomy, { fields: 'ids' })) as string[] | RWP_Error;
  const old = before instanceof RWP_Error ? [] : before;
  if (taxonomy === 'category') {
    const next = ids[0] ?? (append ? old[0] : null) ?? null;
    const { data, error } = await client.from('pages').update({ category_id: next }).eq('id', id).select('id');
    if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_update_error', error?.message ?? 'The database skipped this post.');
  } else {
    const keep = append ? old : [];
    const final = [...new Set([...keep, ...ids])];
    const removed = old.filter((term) => !final.includes(term));
    if (removed.length) {
      doAction('rwp_delete_term_relationships', id, removed, taxonomy);
      const { error } = await client.from('rwp_term_relationships').delete().eq('object_id', id).in('term_id', removed);
      if (error) return new RWP_Error('db_delete_error', error.message);
      doAction('rwp_deleted_term_relationships', id, removed, taxonomy);
    }
    const added = final.filter((term) => !old.includes(term));
    for (const termId of added) doAction('rwp_add_term_relationship', id, termId, taxonomy);
    if (added.length) {
      const { error } = await client.from('rwp_term_relationships').insert(added.map((termId, index) => ({ object_id: id, term_id: termId, term_order: old.length + index })));
      if (error) return new RWP_Error('db_insert_error', error.message);
      for (const termId of added) doAction('rwp_added_term_relationship', id, termId, taxonomy);
    }
  }
  doAction('rwp_set_object_terms', id, wanted, ids, taxonomy, append, old);
  return ids;
}

/** Adds terms to a post without removing the others. */
export const rwp_add_object_terms = (objectId: number | string, terms: string | Array<string | number>, taxonomy: string) => rwp_set_object_terms(objectId, terms, taxonomy, true);

export const rwp_set_post_terms = (post: number | string | { ID?: number; id?: number }, terms: string | Array<string | number>, taxonomy = 'post_tag', append = false) => rwp_set_object_terms(postId(post), terms, taxonomy, append);

export const rwp_set_post_categories = (post: number | string | { ID?: number; id?: number }, categories: Array<string | number> = [], append = false) => rwp_set_object_terms(postId(post), categories, 'category', append);

export const rwp_set_post_tags = (post: number | string | { ID?: number; id?: number }, tags: string | string[] = '', append = false) => rwp_set_object_terms(postId(post), tags, 'post_tag', append);

export const rwp_get_post_categories = (post: number | string | { ID?: number; id?: number }) => rwp_get_object_terms(postId(post), 'category', { fields: 'ids' });

export const rwp_get_post_tags = (post: number | string | { ID?: number; id?: number }) => rwp_get_object_terms(postId(post), 'post_tag');

/** Whether a post has a term (or any term of the taxonomy when `term` is empty). */
export async function rwp_has_term(term: string | number = '', taxonomy = '', post: number | string | { ID?: number; id?: number } = 0): Promise<boolean> {
  const id = postId(post);
  if (!id) return false;
  const names = taxonomy ? [taxonomy] : [...taxonomies.keys()];
  for (const name of names) {
    const terms = await rwp_get_object_terms(id, name);
    if (terms instanceof RWP_Error) continue;
    if (!(terms as RWP_Term[]).length) continue;
    if (term === '' || (terms as RWP_Term[]).some((item) => item.term_id === String(term) || item.slug === String(term) || item.name === String(term))) return true;
  }
  return false;
}

export const rwp_get_categories = (args: GetTermsArgs = {}) => rwp_get_terms({ ...args, taxonomy: 'category' });

export async function rwp_get_tags(args: GetTermsArgs = {}): Promise<RWP_Term[] | string[] | RWP_Error> {
  const tags = await rwp_get_terms({ ...args, taxonomy: 'post_tag' });
  return tags instanceof RWP_Error ? tags : applyFilters<RWP_Term[] | string[]>('rwp_get_tags', tags, args);
}

export const rwp_get_category = (category: string) => rwp_get_term(category, 'category');

/** The address of a term's archive. Only 'category' has a public archive route (/category/slug). */
export function rwp_get_term_link(term: RWP_Term | { slug: string; taxonomy: string }, taxonomy = ''): string {
  const type = taxonomy || term.taxonomy;
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  const url = type === 'category' ? `${base}/category/${term.slug}` : `${base}/${type === 'post_tag' ? 'tag' : type}/${term.slug}`;
  return applyFilters<string>('rwp_term_link', url, term, type);
}

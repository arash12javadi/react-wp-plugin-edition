/**
 * More term functions: a post's categories and tags as lists and HTML, membership tests, hierarchy
 * for custom taxonomies, and the taxonomy lookups (see terms.ts for how taxonomies are stored).
 * Everything that reads the database is async.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { RWP_Error } from './errors';
import { rwp_esc_attr, rwp_esc_html, rwp_esc_url } from './formatting';
import { rwp_get_queried_object } from './query';
import {
  rwp_get_object_terms, rwp_get_taxonomy, rwp_get_term, rwp_get_term_by, rwp_get_term_link, rwp_get_terms, rwp_get_the_terms, rwp_get_object_taxonomies,
  rwp_has_term, rwp_taxonomy_exists, type RWP_Taxonomy, type RWP_Term,
} from './terms';

type PostRef = number | string | { ID?: number; id?: number };
const idOf = (post: PostRef): number => Number(typeof post === 'object' ? (post.ID ?? post.id) : post) || Number(rwp_get_queried_object().post?.ID ?? 0);
const list = (value: RWP_Term[] | string[] | RWP_Error | false): RWP_Term[] => (Array.isArray(value) ? (value as RWP_Term[]) : []);

/** The categories of a post. */
export async function rwp_get_the_category(postId: PostRef = 0): Promise<RWP_Term[]> {
  return applyFilters<RWP_Term[]>('rwp_get_the_categories', list(await rwp_get_object_terms(idOf(postId), 'category')), idOf(postId));
}

/** The tags of a post, or false. */
export async function rwp_get_the_tags(postId: PostRef = 0): Promise<RWP_Term[] | false> {
  const terms = list(await rwp_get_the_terms(idOf(postId), 'post_tag'));
  return applyFilters<RWP_Term[] | false>('rwp_get_the_tags', terms.length ? terms : false);
}

/** A list of a post's terms as links, joined by `separator`; '' when there are none. Names are escaped. */
export async function rwp_get_the_term_list(postId: PostRef, taxonomy: string, before = '', sep = '', after = ''): Promise<string | false | RWP_Error> {
  const terms = await rwp_get_the_terms(idOf(postId), taxonomy);
  if (terms instanceof RWP_Error) return terms;
  if (!terms || !terms.length) return false;
  const links = terms.map((term) => `<a href="${rwp_esc_attr(rwp_esc_url(rwp_get_term_link(term)))}" rel="tag">${rwp_esc_html(term.name)}</a>`);
  const filtered = applyFilters<string[]>(`rwp_term_links-${taxonomy}`, links, taxonomy);
  return `${before}${filtered.join(sep)}${after}`;
}

export const rwp_get_the_category_list = async (separator = '', postId: PostRef = 0): Promise<string> => String((await rwp_get_the_term_list(postId, 'category', '', separator, '')) || '');
export const rwp_get_the_tag_list = (before = '', sep = '', after = '', postId: PostRef = 0) => rwp_get_the_term_list(postId, 'post_tag', before, sep, after);

/** The categories of a post as an id. */
export const rwp_get_cat_ID = async (name: string): Promise<string | 0> => {
  const term = await rwp_get_term_by('name', name, 'category');
  return term && !(term instanceof RWP_Error) ? term.term_id : 0;
};

export const rwp_get_cat_name = async (id: string): Promise<string> => {
  const term = await rwp_get_term(id, 'category');
  return term && !(term instanceof RWP_Error) ? term.name : '';
};

export const rwp_get_category_by_slug = async (slug: string): Promise<RWP_Term | false> => {
  const term = await rwp_get_term_by('slug', slug, 'category');
  return term && !(term instanceof RWP_Error) ? term : false;
};

export async function rwp_category_description(category: string): Promise<string> {
  const term = await rwp_get_term(category, 'category');
  return term && !(term instanceof RWP_Error) ? applyFilters<string>('rwp_category_description', term.description, category) : '';
}

export async function rwp_category_exists(catName: string): Promise<string | 0> {
  const found = await rwp_get_term_by('name', catName, 'category');
  return found && !(found instanceof RWP_Error) ? found.term_id : 0;
}

/** Whether a post is in a category (id, slug or name). */
export const rwp_in_category = (category: string, post: PostRef = 0): Promise<boolean> => rwp_has_term(category, 'category', idOf(post));
export const rwp_has_category = (category = '', post: PostRef = 0): Promise<boolean> => rwp_has_term(category, 'category', idOf(post));
export const rwp_has_tag = (tag = '', post: PostRef = 0): Promise<boolean> => rwp_has_term(tag, 'post_tag', idOf(post));
export const rwp_is_object_in_term = async (objectId: number, taxonomy: string, term: string | number | null = null): Promise<boolean | RWP_Error> => (rwp_taxonomy_exists(taxonomy) ? rwp_has_term(term ?? '', taxonomy, objectId) : new RWP_Error('invalid_taxonomy', 'Invalid taxonomy.'));

/** The taxonomies attached to a post's type. */
export const rwp_get_post_taxonomies = (post: { post_type?: string } | PostRef = 0): string[] => {
  const type = typeof post === 'object' && post && 'post_type' in post ? post.post_type : String(rwp_get_queried_object().post?.post_type ?? 'post');
  return rwp_get_object_taxonomies(type ?? 'post') as string[];
};

export const rwp_get_the_taxonomies = (post: PostRef = 0): RWP_Taxonomy[] => rwp_get_post_taxonomies(post).map((name) => rwp_get_taxonomy(name)).filter((entry): entry is RWP_Taxonomy => Boolean(entry));

export const rwp_is_taxonomy_hierarchical = (taxonomy: string): boolean => Boolean(rwp_get_taxonomy(taxonomy) && (rwp_get_taxonomy(taxonomy) as RWP_Taxonomy).hierarchical);

export const rwp_get_taxonomy_labels = (taxonomy: RWP_Taxonomy): Record<string, string> => ({ name: taxonomy.label, singular_name: taxonomy.label, ...(taxonomy.labels ?? {}) });

/** The ids of the posts that have a term (ids or slugs). */
export async function rwp_get_objects_in_term(termIds: string | string[], taxonomies: string | string[] = 'post_tag'): Promise<number[] | RWP_Error> {
  const taxonomy = Array.isArray(taxonomies) ? taxonomies[0] : taxonomies;
  if (!rwp_taxonomy_exists(taxonomy)) return new RWP_Error('invalid_taxonomy', 'Invalid taxonomy.');
  const ids = Array.isArray(termIds) ? termIds : [termIds];
  if (taxonomy === 'category') {
    const { data } = await client.from('pages').select('id').in('category_id', ids);
    return ((data || []) as Array<{ id: number }>).map((row) => row.id);
  }
  const { data } = await client.from('rwp_term_relationships').select('object_id').in('term_id', ids);
  return ((data || []) as Array<{ object_id: number }>).map((row) => row.object_id);
}

/** The children of a term (custom taxonomies keep a parent; categories are flat). */
export async function rwp_get_term_children(termId: string, taxonomy: string): Promise<string[] | RWP_Error> {
  if (!rwp_taxonomy_exists(taxonomy)) return new RWP_Error('invalid_taxonomy', 'Invalid taxonomy.');
  if (taxonomy === 'category') return [];
  const { data } = await client.from('rwp_terms').select('id').eq('parent', termId).eq('taxonomy', taxonomy);
  return ((data || []) as Array<{ id: string }>).map((row) => row.id);
}

/** The ancestors of a term, nearest first (custom taxonomies only). */
export async function rwp_get_ancestors(objectId: string, objectType = '', resourceType = ''): Promise<string[]> {
  void resourceType;
  if (!objectType || objectType === 'category') return [];
  const chain: string[] = [];
  let current = objectId;
  for (let depth = 0; depth < 20; depth += 1) {
    const { data } = await client.from('rwp_terms').select('parent').eq('id', current).maybeSingle();
    const parent = (data as { parent: string | null } | null)?.parent;
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return applyFilters<string[]>('rwp_get_ancestors', chain, objectId, objectType, resourceType);
}

/** One field of a term ('name', 'slug', 'description', 'term_id'). */
export async function rwp_get_term_field(field: string, term: string | RWP_Term, taxonomy = 'category'): Promise<string | RWP_Error | null> {
  const found = typeof term === 'object' ? term : await rwp_get_term(term, taxonomy);
  if (found instanceof RWP_Error) return found;
  if (!found || !(field in found)) return null;
  return String(found[field]);
}

/** Lets a taxonomy apply to another post type. */
export function rwp_register_taxonomy_for_object_type(taxonomy: string, objectType: string): boolean {
  const entry = rwp_get_taxonomy(taxonomy);
  if (!entry) return false;
  if (!entry.object_type.includes(objectType)) entry.object_type.push(objectType);
  return true;
}


/**
 * WordPress's post type registry.
 *
 * 'post' and 'page' are built in. A plugin adds its own in an rwp_init callback:
 *
 *   rwp_register_post_type('book', { label: 'Books', public: true, supports: ['title', 'editor'] });
 *
 * A custom type is stored in public.pages with `post_type = 'book'` (and is_post = false), so it shares
 * the editor, the media, the comments and the permissions of pages, and it is served at /slug like a
 * page. What registering does NOT do: add an admin list of its own (a plugin adds a screen with
 * rwp_add_menu_page and lists its rows with rwp_get_posts({ post_type: 'book' })), or give it archive
 * or permalink structures. The registry lives in code for the life of the page, as in WordPress, so
 * register on every load.
 */
import { applyFilters, doAction } from '../../core/hooks';
import { RWP_Error } from './errors';

export interface PostTypeArgs {
  label?: string;
  labels?: Record<string, string>;
  description?: string;
  public?: boolean;
  hierarchical?: boolean;
  supports?: string[] | false;
  taxonomies?: string[];
  has_archive?: boolean | string;
  rewrite?: boolean | { slug?: string };
  show_in_rest?: boolean;
  menu_icon?: string;
}

export interface RWP_Post_Type extends PostTypeArgs {
  name: string;
  label: string;
  builtin: boolean;
  supports: string[];
  taxonomies: string[];
}

const types = new Map<string, RWP_Post_Type>();
const BUILTIN_SUPPORTS = ['title', 'editor', 'author', 'thumbnail', 'excerpt', 'comments', 'revisions', 'custom-fields'];

types.set('post', { name: 'post', label: 'Posts', builtin: true, public: true, hierarchical: false, supports: BUILTIN_SUPPORTS, taxonomies: ['category', 'post_tag'] });
types.set('page', { name: 'page', label: 'Pages', builtin: true, public: true, hierarchical: true, supports: ['title', 'editor', 'author', 'thumbnail', 'page-attributes', 'comments', 'revisions', 'custom-fields'], taxonomies: [] });

/** Registers a post type. Returns it, or an RWP_Error for a name that is not allowed. */
export function rwp_register_post_type(postType: string, args: PostTypeArgs = {}): RWP_Post_Type | RWP_Error {
  if (!/^[a-z0-9_-]{1,20}$/.test(postType)) return new RWP_Error('post_type_length_invalid', 'Post type names must be between 1 and 20 characters of lowercase letters, digits, dashes and underscores.');
  if (types.get(postType)?.builtin) return new RWP_Error('post_type_builtin', 'A built-in post type cannot be redefined.');
  const generic = applyFilters<PostTypeArgs>('rwp_register_post_type_args', { public: false, hierarchical: false, supports: ['title', 'editor'], taxonomies: [], ...args }, postType);
  const merged = applyFilters<PostTypeArgs>(`rwp_register_${postType}_post_type_args`, generic, postType);
  const entry: RWP_Post_Type = {
    ...merged,
    name: postType,
    label: merged.label ?? postType,
    builtin: false,
    supports: merged.supports === false ? [] : merged.supports ?? ['title', 'editor'],
    taxonomies: merged.taxonomies ?? [],
  };
  types.set(postType, entry);
  doAction('rwp_registered_post_type', postType, entry);
  doAction(`rwp_registered_post_type_${postType}`, postType, entry);
  return entry;
}

export function rwp_unregister_post_type(postType: string): true | RWP_Error {
  const entry = types.get(postType);
  if (!entry) return new RWP_Error('invalid_post_type', 'Invalid post type.');
  if (entry.builtin) return new RWP_Error('invalid_post_type', 'The built-in post types cannot be unregistered.');
  types.delete(postType);
  doAction('rwp_unregistered_post_type', postType);
  return true;
}

export const rwp_post_type_exists = (postType: string): boolean => types.has(postType);

export const rwp_get_post_type_object = (postType: string): RWP_Post_Type | null => types.get(postType) ?? null;

/** The type of a post object (WordPress's get_post_type). */
export function rwp_get_post_type(post: { post_type?: string } | null | undefined): string | false {
  return post?.post_type ?? false;
}

/** The registered post types: names, or objects with `output = 'objects'`. Filter by a few properties. */
export function rwp_get_post_types(args: { public?: boolean; _builtin?: boolean; hierarchical?: boolean } = {}, output: 'names' | 'objects' = 'names', operator: 'and' | 'or' = 'and'): string[] | Record<string, RWP_Post_Type> {
  const keys = Object.keys(args) as Array<keyof typeof args>;
  const list = [...types.values()].filter((entry) => {
    if (!keys.length) return true;
    const test = (key: keyof typeof args) => (key === '_builtin' ? entry.builtin : Boolean(entry[key])) === args[key];
    return operator === 'or' ? keys.some(test) : keys.every(test);
  });
  return output === 'names' ? list.map((entry) => entry.name) : Object.fromEntries(list.map((entry) => [entry.name, entry]));
}

export const rwp_post_type_supports = (postType: string, feature: string): boolean => Boolean(types.get(postType)?.supports.includes(feature));

export function rwp_add_post_type_support(postType: string, feature: string | string[]): void {
  const entry = types.get(postType);
  if (!entry) return;
  for (const name of Array.isArray(feature) ? feature : [feature]) if (!entry.supports.includes(name)) entry.supports.push(name);
}

export function rwp_remove_post_type_support(postType: string, feature: string): void {
  const entry = types.get(postType);
  if (entry) entry.supports = entry.supports.filter((name) => name !== feature);
}

export const rwp_get_all_post_type_supports = (postType: string): string[] => [...(types.get(postType)?.supports ?? [])];

export const rwp_get_post_types_by_support = (feature: string): string[] => [...types.values()].filter((entry) => entry.supports.includes(feature)).map((entry) => entry.name);

/** Whether the type has any custom (non post/page) type registered; lets queries skip the post_type column otherwise. */
export const hasCustomPostTypes = (): boolean => [...types.values()].some((entry) => !entry.builtin);

/**
 * More user functions: counts, lookups, avatars, roles (read-only) and the redirect checks.
 *
 * Roles are fixed in code (src/lib/roles.ts) with grants edited under Settings → Roles, so
 * rwp_get_role() reads them and rwp_add_role() / rwp_remove_role() do not exist. Capability answers are
 * for the interface; the database decides (see users.ts).
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { fetchProfile } from '../profiles';
import { capabilitiesFor, roleLabels, roles as roleList, type UserRole } from '../roles';
import { rwp_user_can, type RWP_User } from './users';
import { rwp_esc_attr, rwp_esc_url, rwp_is_email } from './formatting';
import { rwp_sanitize_user } from './utils';
import { rwp_is_local_url } from './runtime';

export interface RWP_Role { name: string; display_name: string; capabilities: Record<string, boolean> }

const roleObject = (name: UserRole): RWP_Role => ({ name, display_name: roleLabels[name] ?? name, capabilities: Object.fromEntries(capabilitiesFor(name).map((cap) => [cap, true])) });

/** One role with its capabilities, or null. */
export function rwp_get_role(role: string): RWP_Role | null {
  return (roleList as readonly string[]).includes(role) ? roleObject(role as UserRole) : null;
}

/** Every role: { name: { name, display_name, capabilities } }. */
export function rwp_roles(): Record<string, RWP_Role> {
  return Object.fromEntries(roleList.map((name) => [name, roleObject(name)]));
}

/** The roles the signed-in person may give out. `rwp_editable_roles` narrows the list. */
export function rwp_get_editable_roles(): Record<string, RWP_Role> {
  return applyFilters<Record<string, RWP_Role>>('rwp_editable_roles', Object.fromEntries(Object.entries(rwp_roles()).filter(([name]) => name !== 'super_admin')));
}

/** The id of the person with this email, or false. Needs a signed-in person; who may look is the database's call. */
export async function rwp_email_exists(email: string): Promise<string | false> {
  if (!rwp_is_email(email)) return false;
  const { data } = await client.from('profiles').select('id').eq('email', email).maybeSingle();
  const id = (data as { id: string } | null)?.id ?? false;
  return applyFilters<string | false>('rwp_email_exists', id, email);
}

/** React-WP people sign in with their email, so a user name is an email address. */
export const rwp_username_exists = rwp_email_exists;

/** Whether a user name is allowed. */
export function rwp_validate_username(username: string): boolean {
  const clean = rwp_sanitize_user(username, true);
  const valid = clean === username && username.trim().length > 0;
  return applyFilters<boolean>('rwp_validate_username', valid, username);
}

/** How many people have each role: { total_users, avail_roles: { role: count } }. */
export async function rwp_count_users(): Promise<{ total_users: number; avail_roles: Record<string, number> }> {
  const { data } = await client.from('profiles').select('role').limit(20000);
  const avail: Record<string, number> = {};
  for (const row of (data || []) as Array<{ role: string }>) avail[row.role] = (avail[row.role] ?? 0) + 1;
  return { total_users: Object.values(avail).reduce((a, b) => a + b, 0), avail_roles: avail };
}

/** How many published posts a person wrote. */
export async function rwp_count_user_posts(userId: string, postType: string | string[] = 'post'): Promise<number> {
  const type = Array.isArray(postType) ? postType[0] : postType;
  let request = client.from('pages').select('id', { count: 'exact', head: true }).eq('author_id', userId).eq('status', 'published');
  request = type === 'post' ? request.eq('is_post', true) : type === 'page' ? request.eq('is_post', false) : request.eq('post_type', type);
  const { count } = await request;
  return applyFilters<number>('rwp_get_usernumposts', count ?? 0, userId, postType, false);
}

/** Whether a capability is granted to a user (the same as rwp_user_can; `siteId` is ignored). */
export const rwp_user_can_for_site = (userId: string, siteId: number, capability: string): Promise<boolean> => { void siteId; return rwp_user_can(userId, capability); };
export const rwp_current_user_can_for_site = async (siteId: number, capability: string): Promise<boolean> => {
  void siteId;
  const { data } = await client.auth.getUser();
  return data.user ? rwp_user_can(data.user.id, capability) : false;
};

/** Whether a user (the author of a post) may do something to that post. */
export const rwp_author_can = (post: { post_author?: string | null }, capability: string): Promise<boolean> =>
  post.post_author ? rwp_user_can(post.post_author, capability) : Promise.resolve(false);

/** Whether the person is an administrator of this site (the only kind of "super admin" here). */
export async function rwp_is_super_admin(userId: string | null = null): Promise<boolean> {
  const id = userId ?? (await client.auth.getUser()).data.user?.id;
  if (!id) return false;
  const profile = await fetchProfile(id).catch(() => null);
  return profile?.role === 'super_admin';
}

/** The capabilities of a role mapped to the ones needed to do something to an object (WordPress's map_meta_cap). */
export function rwp_map_meta_cap(cap: string, userId: string | number, ...args: unknown[]): string[] {
  const caps = [cap];
  return applyFilters<string[]>('rwp_map_meta_cap', caps, cap, userId, args);
}

/** A cleaned value of a user field: text stripped, email validated. */
export function rwp_sanitize_user_field(field: string, value: unknown, userId = 0, context = 'display'): unknown {
  if (field === 'user_email') return rwp_is_email(String(value)) || '';
  if (field === 'user_url') return rwp_esc_url(value);
  return context === 'db'
    ? applyFilters<unknown>(`rwp_pre_user_${field}`, value, userId)
    : applyFilters<unknown>(`rwp_user_${field}`, value, userId, context);
}

// Avatars --------------------------------------------------------------------------------------------------------------

const initialAvatar = (name: string, size: number): string => {
  const letter = (name.trim()[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="100%" height="100%" fill="#d0d5dd"/><text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(size / 2)}" fill="#475467">${letter.replace(/[<>&]/g, '')}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/** The address of a person's picture: their saved one, or a letter on a grey square. `id` is a user id. */
export async function rwp_get_avatar_url(id: string | number, args: { size?: number } = {}): Promise<string | false> {
  const size = args.size ?? 96;
  const profile = typeof id === 'string' || typeof id === 'number' ? await fetchProfile(String(id)).catch(() => null) : null;
  const url = profile?.avatar_url || initialAvatar(profile?.display_name || profile?.email || '?', size);
  return applyFilters<string | false>('rwp_get_avatar_url', url, id, { size });
}

/** An <img> for a person's picture. */
export async function rwp_get_avatar(id: string | number, size = 96, defaultImage = '', alt = '', args: { class?: string } = {}): Promise<string | false> {
  void defaultImage;
  const url = await rwp_get_avatar_url(id, { size });
  if (!url) return false;
  const html = `<img alt="${rwp_esc_attr(alt)}" src="${rwp_esc_attr(url)}" class="avatar avatar-${size} photo${args.class ? ` ${rwp_esc_attr(args.class)}` : ''}" height="${size}" width="${size}" loading="lazy" decoding="async" />`;
  return applyFilters<string | false>('rwp_get_avatar', html, id, size, defaultImage, alt, args);
}

// Redirect checks -----------------------------------------------------------------------------------------------------

/** Cleans a redirect target of characters that could break out of a header or a URL. */
export function rwp_sanitize_redirect(location: string): string {
  // eslint-disable-next-line no-control-regex
  return location.replace(/[\u0000-\u001f\u007f\s]/g, '');
}

/** Returns the target when it stays on this site, otherwise the fallback. */
export function rwp_validate_redirect(location: string, fallback = ''): string {
  const clean = rwp_sanitize_redirect(location);
  const ok = rwp_is_local_url(clean);
  return ok ? clean : fallback;
}

/** A random integer from the browser's secure generator. */
export function rwp_rand(min = 0, max = 0x7fffffff): number {
  const span = max - min + 1;
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return min + (bytes[0] % span);
}

export type { RWP_User };

/**
 * WordPress's user and capability functions over Supabase Auth and public.profiles.
 *
 * SECURITY: every capability answer here is for the interface only. It tells a screen whether to show
 * a button; it does not stop anyone. The database decides, through row level security that reads the
 * role from public.profiles. `rwp_user_has_cap` and `rwp_map_meta_cap` filters therefore change what
 * the browser shows, never what the server allows, and a plugin must not rely on them for protection.
 *
 * Every function is async because the signed-in person is read from the session and the database.
 */
import { applyFilters } from '../../core/hooks';
import { client } from '../db';
import { fetchProfile } from '../profiles';
import { capabilitiesFor, hasCapability, isCapability, type UserRole } from '../roles';
import { doAction } from '../../core/hooks';
import { RWP_Error } from './errors';
import { rwp_strip_all_tags } from './formatting';

export interface RWP_User {
  ID: string;
  id: string;
  user_email: string;
  display_name: string;
  user_login: string;
  roles: string[];
  caps: Record<string, boolean>;
  allcaps: Record<string, boolean>;
}

const buildUser = (id: string, email: string, displayName: string, role: UserRole): RWP_User => {
  const caps = Object.fromEntries(capabilitiesFor(role).map((cap) => [cap, true]));
  return { ID: id, id, user_email: email, display_name: displayName, user_login: email, roles: [role], caps, allcaps: { ...caps, [role]: true } };
};

/** The signed-in person, or null. */
export async function rwp_get_current_user(): Promise<RWP_User | null> {
  const { data } = await client.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const profile = await fetchProfile(user.id).catch(() => null);
  return buildUser(user.id, user.email ?? '', profile?.display_name || user.email?.split('@')[0] || '', (profile?.role ?? 'subscriber') as UserRole);
}

/** The signed-in person's id, or 0 (WordPress's convention for "nobody"). */
export async function rwp_get_current_user_id(): Promise<string | 0> {
  const user = await rwp_get_current_user();
  return user ? user.ID : 0;
}

export async function rwp_is_user_logged_in(): Promise<boolean> {
  const { data } = await client.auth.getUser();
  return Boolean(data.user);
}

/** One person by id, or null. Only profiles the signed-in person may read come back. */
export async function rwp_get_userdata(userId: string): Promise<RWP_User | null> {
  const profile = await fetchProfile(userId).catch(() => null);
  if (!profile) return null;
  return buildUser(userId, (profile as { email?: string }).email ?? '', profile.display_name ?? '', profile.role as UserRole);
}

/** Looks a person up by 'id' or 'email'. */
export async function rwp_get_user_by(field: 'id' | 'ID' | 'email', value: string): Promise<RWP_User | null> {
  if (field === 'id' || field === 'ID') return rwp_get_userdata(value);
  const { data } = await client.from('profiles').select('id').eq('email', value).maybeSingle();
  return data ? rwp_get_userdata((data as { id: string }).id) : null;
}

const allows = (role: UserRole, capability: string): boolean => {
  const cap = capability === role ? true : isCapability(capability) && hasCapability(role, capability);
  return cap;
};

/**
 * Whether a role may do something, for the interface. `rwp_user_has_cap` runs over the answer. A
 * capability name React-WP does not define answers false.
 */
export async function rwp_user_can(userId: string, capability: string): Promise<boolean> {
  const profile = await fetchProfile(userId).catch(() => null);
  const role = (profile?.role ?? 'subscriber') as UserRole;
  // WordPress turns a meta capability into the primitive ones it needs; a plugin adds to that list.
  const required = applyFilters<string[]>('rwp_map_meta_cap', [capability], capability, userId, []);
  const allcaps = Object.fromEntries(capabilitiesFor(role).map((cap) => [cap, true]));
  const granted: Record<string, boolean> = { ...allcaps };
  for (const cap of required) if (allows(role, cap)) granted[cap] = true;
  const filtered = applyFilters<Record<string, boolean>>('rwp_user_has_cap', granted, required, [userId]);
  return required.every((cap) => Boolean(filtered[cap]));
}

/** Whether the signed-in person may do something. For the interface only; see the note at the top. */
export async function rwp_current_user_can(capability: string): Promise<boolean> {
  const { data } = await client.auth.getUser();
  return data.user ? rwp_user_can(data.user.id, capability) : false;
}

/** Signs the person out. Fires rwp_logout, rwp_clear_auth_cookie through the account flow. */
export async function rwp_logout(): Promise<void> {
  const { signOutAndRedirect } = await import('../account');
  await signOutAndRedirect();
}

export interface UsersQuery {
  role?: string;
  search?: string;
  number?: number;
  offset?: number;
  orderby?: 'display_name' | 'registered' | 'email';
  order?: 'ASC' | 'DESC';
}

/** People with a profile, newest or alphabetical. Needs a signed-in person; who may list others is decided by the database. */
export async function rwp_get_users(args: UsersQuery = {}): Promise<RWP_User[]> {
  let request = client.from('profiles').select('id,email,display_name,role,created_at');
  if (args.role) request = request.eq('role', args.role);
  if (args.search) request = request.or(`display_name.ilike.%${args.search.replace(/[%_,()]/g, '')}%,email.ilike.%${args.search.replace(/[%_,()]/g, '')}%`);
  request = request.order(args.orderby === 'registered' ? 'created_at' : args.orderby === 'email' ? 'email' : 'display_name', { ascending: String(args.order).toUpperCase() !== 'DESC' });
  if (args.number) request = request.range(args.offset ?? 0, (args.offset ?? 0) + args.number - 1);
  const { data } = await request;
  const users = ((data || []) as Array<{ id: string; email: string | null; display_name: string | null; role: UserRole }>)
    .map((profile) => buildUser(profile.id, profile.email ?? '', profile.display_name ?? '', profile.role));
  return users;
}

export interface UserData {
  ID: string;
  display_name?: string;
  description?: string;
  role?: string;
}

/**
 * Updates a profile: display_name, description (the bio) and role. The email and password belong to
 * Supabase Auth and are changed from the account screen, not here. Returns the user id, or an
 * RWP_Error; a change the database refused (role changes need promote_users) is reported, not skipped.
 * Fires rwp_profile_update(user_id, old_user_data, userdata).
 */
export async function rwp_update_user(userdata: UserData): Promise<string | RWP_Error> {
  const before = await fetchProfile(userdata.ID).catch(() => null);
  if (!before) return new RWP_Error('invalid_user_id', 'Invalid user ID.');
  const changes: Record<string, unknown> = {};
  if (userdata.display_name !== undefined) changes.display_name = rwp_strip_all_tags(userdata.display_name).trim();
  if (userdata.description !== undefined) changes.bio = rwp_strip_all_tags(userdata.description);
  if (userdata.role !== undefined) changes.role = userdata.role;
  const { data, error } = await client.from('profiles').update(changes).eq('id', userdata.ID).select('id');
  if (error || !(data as unknown[] | null)?.length) return new RWP_Error('db_update_error', error?.message ?? 'The database skipped this profile. Changing someone else\'s profile needs edit_users; a role change needs promote_users.');
  doAction('rwp_profile_update', userdata.ID, buildUser(before.id, before.email ?? '', before.display_name ?? '', before.role), userdata);
  return userdata.ID;
}

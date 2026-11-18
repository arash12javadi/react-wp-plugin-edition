/**
 * Who a marketplace listing is "by".
 *
 * The marketplace owner's own plugins (the author's profile is an administrator) always read "React-WP.com" and are
 * official. Nobody else may carry that name, whether they typed it as the publisher or chose it as their profile name.
 * This is the same rule as `rwp_marketplace_publisher` in the marketplace's schema.sql; both must change together.
 */

export const OFFICIAL_NAME = 'React-WP.com';
export const OWNER_ROLES = ['administrator', 'super_admin'];
export const FALLBACK_NAME = 'Independent author';

/** True when the text names the brand, however it is spelled: "React-WP.com", "react wp", "REACT_WP". */
export const usesBrandName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes('reactwp');

export const isOfficialRole = (role) => OWNER_ROLES.includes(String(role || ''));

/** `{ publisher, official }` for a listing. `role` is the author's profile role. */
export function publisherFor({ publisherName = '', displayName = '', role = '' } = {}) {
  if (isOfficialRole(role)) return { publisher: OFFICIAL_NAME, official: true };
  const clean = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text && !usesBrandName(text) ? text : '';
  };
  return { publisher: clean(publisherName) || clean(displayName) || FALLBACK_NAME, official: false };
}

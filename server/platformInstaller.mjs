/**
 * `POST /api/v1/updates/install` on react-wp.com — retired.
 *
 * This route used to make the platform rebuild a customer's site: it looked up the customer's Vercel
 * project, opened the customer's Vercel token that the platform had stored, built the release and uploaded
 * it to the customer's project. That made react-wp.com a holder of customer deployment credentials and a
 * deployment service for customer projects, which the platform no longer is.
 *
 * react-wp.com is now a **release source only**: it publishes core and plugin releases (`/api/v1/updates/check`
 * and the release files), and each client installation updates itself — it commits the release to its own
 * GitHub repository and its own Vercel project deploys that commit (`server/gitDeploy/*`, Settings →
 * Integrations → GitHub & Vercel). No customer token is needed or accepted here.
 *
 * The path still answers, with 410 Gone and a sentence a site can show, so an older site that asks is told
 * what to do instead of getting a 404 that reads like a misconfiguration. The request body is never read
 * for a credential and nothing is stored.
 */
export const PLATFORM_INSTALL_RETIRED_MESSAGE = 'React-WP.com no longer builds or deploys customer sites, and it does not keep hosting credentials. Update this site from its own admin: connect it to its GitHub repository and Vercel project under Settings → Integrations → GitHub & Vercel, then use Update core there.';

/**
 * Kept as a factory so both engines mount it exactly as before. The runtime options they pass (the
 * environment, the Supabase location) are accepted and ignored: nothing is looked up any more.
 *
 * @param {Record<string, unknown>} [_runtime]
 */
export function platformInstallHandler(_runtime = {}) {
  return async () => ({
    status: 410,
    body: { success: false, ok: false, code: 'platform_install_retired', error: PLATFORM_INSTALL_RETIRED_MESSAGE },
  });
}

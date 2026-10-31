/**
 * The platform half of `POST /api/v1/updates/install`: handing one provisioned site's redeploy to the
 * installer plugin.
 *
 * `server/centralUpdates.mjs` owns the route and the credential, but not the pipeline. Building a release and
 * uploading it to a Vercel project is `plugins/rwp-saas-installer`'s job — it holds the GitHub template, the
 * prebuilt bundle, the upload loop and the failure sentences — and this module is the seam between the two.
 * It exists so that neither side has to import the other's world: the route stays free of Vercel code, and the
 * plugin stays free of `/api/v1` path names.
 *
 * The import is **dynamic**, for the reason `server/plugins.mjs` gives for its own: a plugin folder removed
 * from the Plugins screen must not stop the server from starting, and it must not stop a platform from
 * answering the rest of its update routes either. No installer means a sentence on this one path, and every
 * other route behaves exactly as before.
 *
 * `supabase` is where this deployment's own PostgREST lives, needed to read the `saas_installer_installations`
 * row that maps a site's address to its Vercel project. It may be a value or an async function, because the
 * Hono host resolves its runtime config lazily; when it is null the plugin falls back to the environment
 * (`SUPABASE_URL` / `SUPABASE_SECRET_KEY`), which is how a classic `server.mjs` deployment is configured.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   supabase?: { url?: string, publishableKey?: string, secretKey?: string } | (() => Promise<{ url?: string, publishableKey?: string, secretKey?: string }>) | null,
 * }} [runtime]
 */
export function platformInstallHandler({ env, supabase = null } = {}) {
  return async ({ body = {} } = {}) => {
    let installer = null;
    try {
      installer = await import('../plugins/rwp-saas-installer/server.mjs');
    } catch (error) {
      console.error(`[updates/install] the saas installer plugin could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof installer?.platformInstall !== 'function') {
      return {
        status: 501,
        body: {
          success: false,
          ok: false,
          error: 'This platform has no installer, so it cannot redeploy a site. Activate rwp-saas-installer in Plugins, or deploy the release from its own card.',
        },
      };
    }
    const resolved = typeof supabase === 'function' ? await supabase().catch(() => null) : supabase;
    const answer = await installer.platformInstall({
      env: env || globalThis.process?.env || {},
      supabase: resolved,
      siteUrl: typeof body?.site === 'string' ? body.site : '',
      projectName: typeof body?.projectName === 'string' ? body.projectName : '',
      // The site says `to` (the version it wants, from its last check); an operator may say `version`.
      version: typeof body?.to === 'string' ? body.to : (typeof body?.version === 'string' ? body.version : ''),
    });
    return { status: Number(answer?.status) || 200, body: answer?.body ?? {} };
  };
}

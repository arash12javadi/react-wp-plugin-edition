/**
 * Which release this host runs — the one place that gathers the inputs for `resolveInstalledVersion`
 * (server/updateCenter.mjs), so the classic host, the universal engine and the deployment routes cannot answer
 * differently: the `.rwp-version` record first, then the deploy's pin (`RWP_APP_VERSION`), the SaaS installer's
 * record, and last the `package.json` the build compiled (which need not match any tag).
 */
import { resolveInstalledVersion } from './updateCenter.mjs';
import { loadVersionRecord } from './versionRecord.mjs';

/**
 * @param {{ saas?: string, fallback?: string, env?: Record<string, string | undefined> }} [input]
 * @returns {Promise<string>} a plain version (no `v`), or ''
 */
export async function installedVersionFor({ saas = '', fallback = '', env = globalThis.process?.env || {} } = {}) {
  return resolveInstalledVersion({
    recorded: await loadVersionRecord(),
    pinned: String(env.RWP_APP_VERSION || ''),
    saas,
    fallback: String(fallback || ''),
  });
}

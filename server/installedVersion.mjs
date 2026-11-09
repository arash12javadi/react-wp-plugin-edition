/**
 * Which release this host runs — the one place that gathers the inputs for `resolveInstalledVersion`
 * (server/updateCenter.mjs), so the classic host, the universal engine and the deployment routes cannot answer
 * differently: the `.rwp-version` record first, then the build's `package.json` when an update stamped it with the
 * release tag, then the owner-only pin (`RWP_APP_VERSION` — never set for a client, never asked of one), the SaaS
 * installer's one-time record, and last the unstamped `package.json` version (which names no tag).
 */
import { resolveInstalledVersion } from './updateCenter.mjs';
import { loadVersionRecord, readStamp } from './versionRecord.mjs';

/**
 * @param {{ saas?: string, fallback?: string, manifest?: object | null, env?: Record<string, string | undefined> }} [input]
 *   `manifest` is the parsed `package.json` this build carries, for its release stamp.
 * @returns {Promise<string>} a plain version (no `v`), or ''
 */
export async function installedVersionFor({ saas = '', fallback = '', manifest = null, env = globalThis.process?.env || {} } = {}) {
  return resolveInstalledVersion({
    recorded: await loadVersionRecord(),
    stamped: readStamp(manifest),
    pinned: String(env.RWP_APP_VERSION || ''),
    saas,
    fallback: String(fallback || ''),
  });
}

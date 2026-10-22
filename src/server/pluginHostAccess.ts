/**
 * What a plugin route on the universal engine needs that is not its own concern: who may run it, the
 * repository its code is committed to, and the rows both of those questions are answered from.
 *
 * `src/server/routes/plugins.ts` (upload a plugin) and `src/server/routes/pluginSchema.ts` (schema
 * status, install schema, uninstall) ask the same questions of the same tables: an upload spends the
 * stored GitHub credential and an uninstall commits the folder's removal with it, and both have to
 * read `rwp_active_plugins` and `system_settings` the way this deployment can read them. The classic
 * host's half of that same pairing is `server/adminRoutes.mjs`, which authorises from `server.mjs` and
 * then hands the work to `server/pluginUninstall.mjs`. Answering "who may touch plugins" and "which
 * credential source does this deployment have" once, here, is what keeps those surfaces from drifting
 * apart.
 */
import { createServerDbAdapter } from '../lib/db/index';
import { createServerAuthAdapter } from '../lib/auth/index';
import { hasCapability, type Capability, type UserRole } from '../lib/roles';
import type { RuntimeConfig } from '../lib/runtime';
import { detectPluginHostMode } from './pluginHostMode';
import { GITHUB_CONFIG_KEY } from '../../server/integrationConfig.mjs';
import { readIntegrationRows } from '../../server/integrationSettings.mjs';
import { authorizePluginManager } from '../../server/pluginFiles.mjs';
import { githubTargetFrom, type GithubCommitTarget } from '../../server/pluginGitPush.mjs';
import type { PluginInstallOptionStore } from '../../server/pluginGitInstaller.mjs';

/** A refusal that carries the status code to answer with, for the phase before a stream starts. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The status a shared module asked for (`InstallError` sets one), when it asked for one. */
export const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
};

/**
 * The sentence to answer with. A throw that carries nothing is described as a failed request rather
 * than as anything more specific: upload, schema work and uninstall all answer through here, and only
 * the handler that caught the error knows which of the three it was.
 */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'The plugin request failed.');

/** `process.env` where there is one, and nothing where there is not (Workers, Deno, Bun). */
export const serverEnvironment = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * Refuses anyone without `activate_plugins`, the capability the README documents for these buttons and
 * the one the classic routes demand. An upload spends the site's GitHub credential, and an uninstall
 * commits to the repository the deployment is built from, but neither can change where that credential
 * points: choosing the repository stays a `manage_options` action on Settings → Integrations, where the
 * connection is configured.
 *
 * Under Supabase the question is put to the project itself, with the caller's own token —
 * `/auth/v1/user` to prove who is asking, then `user_has_cap` to prove they may — which is exactly
 * what `server.mjs` asks (`server/adminRoutes.mjs` → `authorizePluginManager`). It is not enough, and
 * never was, to resolve the token through this engine's own auth adapter here: on a server that
 * adapter holds no session of its own, its Supabase client speaks the publishable key, and `profiles`
 * is readable by `authenticated` only — so every real administrator was answered "Your session is not
 * valid. Sign in again." Every other backend keeps the universal JWT engine, whose `rwp_users` table
 * carries the role.
 */
export async function requirePluginManager(token: string, config: RuntimeConfig): Promise<void> {
  // The no-token sentence is `authorizePluginManager`'s own (`server/pluginFiles.mjs`), reused here
  // rather than invented: it is the string `server/adminRoutes.mjs` shows on `npm start`, and a
  // signed-out caller has to read the same refusal whichever host answered. A token-bearing refusal
  // below comes from that same module, so only the capability checks are this engine's own.
  if (!token) throw new HttpError(401, 'Sign in required.');
  if (config.dbType === 'supabase') {
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      throw new HttpError(501, 'This site is not installed, so plugins cannot be managed.');
    }
    const auth = await authorizePluginManager(config.supabaseUrl, config.supabasePublishableKey, token);
    if (!auth.ok) throw new HttpError(auth.status ?? 401, auth.error ?? 'Plugins cannot be managed.');
    return;
  }
  const db = await createServerDbAdapter(config);
  try {
    const auth = await createServerAuthAdapter(config, db);
    const user = await auth.authenticate(token);
    const role = user?.role as UserRole | undefined;
    if (!role) throw new HttpError(401, 'Your session is not valid. Sign in again.');
    if (!hasCapability(role, 'activate_plugins' as Capability)
      && !hasCapability(role, 'manage_options' as Capability)) {
      throw new HttpError(403, 'Your role cannot manage plugins: it does not have the activate_plugins capability.');
    }
  } finally {
    await db.close().catch(() => undefined);
  }
}

/** How a shared module asks this host for one `system_settings` row. */
export type SystemSettingReader = (key: string) => Promise<unknown>;

/**
 * `system_settings`, read through this engine's adapter — or `undefined` under Supabase, where that
 * adapter speaks the publishable key and RLS does not let it near the table, so the shared module
 * opens a direct connection rather than reporting a setting that is stored but unreadable.
 *
 * An adapter per read, closed again — the Integrations hub's reader does the same: this is not a
 * per-request path, and a handle held open is a handle to leak.
 */
export function systemSettingReader(config: RuntimeConfig): SystemSettingReader | undefined {
  if (config.dbType === 'supabase') return undefined;
  return async (key: string) => {
    const db = await createServerDbAdapter(config);
    try {
      return await db.getSystemSetting(key);
    } finally {
      await db.close().catch(() => undefined);
    }
  };
}

/**
 * The repository to publish to, read from the stored `github_config` row.
 *
 * The row is read through `readIntegrationRows` — the same module, with the same options, that serves
 * the Integrations hub — so "which credential source does this deployment have" is answered in one
 * place: the engine's own adapter off Supabase, a direct connection or the service key on it. A row
 * that cannot be read is reported as exactly that: advising the administrator to add the token again
 * would be advice about a token that is already stored.
 */
export async function githubTarget(config: RuntimeConfig): Promise<GithubCommitTarget> {
  const rows = await readIntegrationRows([GITHUB_CONFIG_KEY], {
    // Supabase is deliberately left without an injected reader: its adapter speaks the publishable key,
    // which RLS does not let near `system_settings`, so the shared module opens a direct connection
    // rather than reporting a connection that is stored but unreadable.
    readSetting: systemSettingReader(config),
    databaseUrl: config.databaseUrl,
    dbType: config.dbType,
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabasePublishableKey,
    env: serverEnvironment(),
  });
  if (!rows.readable) {
    throw new HttpError(501, `The stored GitHub connection could not be read, so this plugin cannot be committed to the repository this site is built from. ${rows.error}`.trim());
  }
  return githubTargetFrom(rows.settings[GITHUB_CONFIG_KEY]);
}

/**
 * The `options` accessor the plugin work uses: `installPluginFromGit` pins `rwp_active_plugins` through
 * it, and an uninstall reads that same option to know which plugin may have its folder removed.
 *
 * An adapter per call, for the reason above: an install takes seconds — GitHub round-trips, then the
 * deploy hook — and a connection held open across it is one a serverless function is billed for.
 */
export function settingsStore(config: RuntimeConfig): PluginInstallOptionStore {
  return {
    async getOption(name: string) {
      const db = await createServerDbAdapter(config);
      try {
        return await db.getOption(name);
      } finally {
        await db.close().catch(() => undefined);
      }
    },
    async setOption(name: string, value: unknown) {
      const db = await createServerDbAdapter(config);
      try {
        return await db.setOption(name, value);
      } finally {
        await db.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Where a plugin's code goes — this host's own disk, or the repository it is built from — and, for the
 * repository, the connection that getting there needs. Built before a body is read, so a decision that
 * cannot be made (no GitHub connection on a host that has no disk) is a status the caller can act on.
 */
export type PluginHostPlan =
  | { mode: 'local' }
  | { mode: 'github'; target: GithubCommitTarget };

/**
 * Settles the destination, asking the one authority on it: `detectPluginHostMode`, which tests whether
 * `plugins/` and `.rwp-tmp/` can be written to and whether a serverless platform is underfoot.
 *
 * A host that can write its own disk needs no credential at all — an upload is a folder and an
 * uninstall is an `rm`, as they are under `npm start`. A host that cannot is answered by
 * `githubTarget`: the stored GitHub connection, or the `501` that says to connect one, because
 * committing is the only way in that such a host has.
 */
export async function pluginHostPlan(config: RuntimeConfig): Promise<PluginHostPlan> {
  if (await detectPluginHostMode() === 'github') {
    return { mode: 'github', target: await githubTarget(config) };
  }
  return { mode: 'local' };
}

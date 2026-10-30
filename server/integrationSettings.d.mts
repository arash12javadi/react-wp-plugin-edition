/**
 * Types for `server/integrationSettings.mjs` — how the server reads the hub's credential rows.
 *
 * See the implementation for why there is more than one way to read them, and why
 * `readable: false` is an answer rather than an error.
 */
import type { MediaStorageConfig } from '../src/lib/integrations';
import type { mediaCredentialsFrom } from './integrationConfig.mjs';

export interface IntegrationRowsResult {
  settings: Record<string, unknown>;
  readable: boolean;
  source: 'adapter' | 'database' | 'rest' | 'unavailable';
  error: string;
}

export function parseSettingValue(raw: unknown): unknown;

/** How a read reaches the credential rows — every reader here takes the same options. */
export interface IntegrationReadOptions {
  /** A reader the caller already has, e.g. the universal engine's database adapter. */
  readSetting?: (key: string) => Promise<unknown>;
  databaseUrl?: string;
  dbType?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  env?: Record<string, string | undefined>;
}

export function readIntegrationRows(
  keys: string[],
  options?: IntegrationReadOptions,
): Promise<IntegrationRowsResult>;

/**
 * The active media provider and the credentials built from it — the one call every media route
 * makes. `configuration` is what a screen shows; `credentials` is what a delete or an upload
 * signature needs.
 */
export function readMediaStorageSettings(options?: IntegrationReadOptions): Promise<{
  configuration: MediaStorageConfig;
  credentials: ReturnType<typeof mediaCredentialsFrom>;
  readable: boolean;
  error: string;
}>;

/**
 * Confirms the caller holds a capability, using their own access token and the publishable key. The
 * capability is a parameter because more than one route borrows a saved credential on a caller's
 * behalf: the integration probes want `manage_options`, the core AI assistant wants `edit_posts`.
 * `messages` overrides any sentence, so a route's refusal names that route.
 */
export function authorizeCapabilityOnSupabase(
  supabaseUrl: string,
  supabaseKey: string,
  accessToken: string,
  capability?: string,
  messages?: {
    signedOut?: string;
    notInstalled?: string;
    invalidSession?: string;
    capabilityFailure?: (capability: string) => string;
    unreachable?: (detail: string) => string;
  },
): Promise<{ ok: boolean; status?: number; error?: string }>;

export function authorizeSettingsManager(
  supabaseUrl: string,
  supabaseKey: string,
  accessToken: string,
): Promise<{ ok: boolean; status?: number; error?: string }>;

/** The caller's role from `public.current_user_role()`, or '' when it cannot be proven. */
export function currentUserRole(
  supabaseUrl: string,
  supabaseKey: string,
  accessToken: string,
): Promise<string>;

/** The roles that own the update channel — the Setup Wizard's `administrator` alone. */
export const UPDATE_OWNER_ROLES: readonly string[];

/** Whether `role` may see and change where updates come from. */
export function isUpdateOwnerRole(role: string): boolean;

/**
 * Confirms the caller is the platform owner (`super_admin`), through
 * `public.current_user_role()` — a role check, not a capability one, because `user_has_cap` answers
 * `true` for `administrator` whatever the capability name is. `role` is what the caller turned out to
 * hold (`''` when they hold none), so a route can say who it recognised.
 */
export function authorizePlatformOwner(
  supabaseUrl: string,
  supabaseKey: string,
  accessToken: string,
  messages?: {
    signedOut?: string;
    notInstalled?: string;
    invalidSession?: string;
    roleFailure?: (role: string) => string;
    unreachable?: (detail: string) => string;
  },
): Promise<{ ok: boolean; status?: number; error?: string; role?: string }>;


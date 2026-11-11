/**
 * Types for `server/pluginIntegrationAccess.mjs` — the rows a plugin route may read, and the only
 * reader it may use to read them.
 *
 * See the implementation for why the grant lives here rather than in the plugin's own route module,
 * and why a refusal answers `readable: false` instead of throwing.
 */
import type { IntegrationReadOptions, IntegrationRowsResult } from './integrationSettings.mjs';

/** The rows each plugin declared, by plugin id. A plugin that is not listed may read nothing. */
export const SHOP_EMAIL_CONFIG_KEY: string;
export const SHOP_PAYMENTS_CONFIG_KEY: string;
export const PAGE_BUILDER_EMAIL_CONFIG_KEY: string;

export const PLUGIN_INTEGRATION_KEYS: Readonly<Record<string, readonly string[]>>;

export function pluginIntegrationKeys(pluginId: string): readonly string[];

/** The requested keys this plugin did not declare — empty when the read may go ahead. */
export function undeclaredIntegrationKeys(pluginId: string, requested: readonly unknown[] | undefined): string[];

/** The sentence a refusal carries: which plugin, which row, and where the grant is declared. */
export function undeclaredKeyRefusal(pluginId: string, keys: readonly string[]): string;

/**
 * `readIntegrationRows`, with the key list checked against the plugin's declaration first. A refused
 * read answers `readable: false` with the sentence in `error`, as an unreadable row does.
 */
export function readPluginIntegrationRows(
  pluginId: string,
  requested: readonly string[],
  options?: IntegrationReadOptions,
): Promise<IntegrationRowsResult>;

/**
 * WordPress's plugin lookups (get_plugins, is_plugin_active, get_plugin_data) over React-WP's registry.
 *
 * A plugin is identified by its id (the manifest id, which is also its folder name); WordPress's
 * "folder/file.php" paths do not exist. Activation is changed from the Plugins screen, not from code.
 */
import { applyFilters } from '../../core/hooks';
import { rwp } from '../rwp';

interface PluginInfo { Name: string; Version: string; Author: string; Description: string; Active: boolean }

/** Every installed plugin: { id: { Name, Version, Author, Description, Active } }. */
export function rwp_get_plugins(): Record<string, PluginInfo> {
  const list = Object.fromEntries(rwp.getPlugins().map((plugin) => [plugin.id, {
    Name: plugin.name, Version: plugin.version, Author: plugin.author ?? '', Description: plugin.description ?? '', Active: plugin.active,
  }]));
  return applyFilters<Record<string, PluginInfo>>('rwp_all_plugins', list);
}

/** Whether a plugin is active. */
export function rwp_is_plugin_active(plugin: string): boolean {
  return Boolean(rwp.getPlugins().find((item) => item.id === plugin)?.active);
}

export const rwp_is_plugin_inactive = (plugin: string): boolean => !rwp_is_plugin_active(plugin);

/** The header data of a plugin (its manifest), or the empty shape. */
export function rwp_get_plugin_data(plugin: string): PluginInfo {
  return rwp_get_plugins()[plugin] ?? { Name: '', Version: '', Author: '', Description: '', Active: false };
}

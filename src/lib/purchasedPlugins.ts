/**
 * What this site has bought on react-wp.com, in one place, for the screens that show it (Plugins → My Purchases and the
 * Marketplace cards).
 *
 * The keys come from the account link: it fetches them into the `rwp_plugin_licenses` option, which is also what
 * decides whether a sold plugin may run. So "bought" here means "this site holds a key for it", and "installed" means
 * the plugin is registered in this build. Installing goes through the one signed path (`POST
 * /api/admin/license-link/install`): react-wp.com signs the package for this site, the site checks it, and only then
 * commits it to its own repository.
 */
import { getOption } from './db';
import { callLink } from './licenseLinkApi';
import { PLUGIN_LICENSES_OPTION, isCommercialPlugin, pluginIdForSlug, pluginLicenseParts, readPluginLicenses } from './pluginLicense.js';
import { rwp } from './rwp';

const NAMES: Record<string, string> = {
  'rwp-page-builder': 'RWP Page Builder',
  'rwp-shop': 'RWP Shop',
  'rwp-chat': 'RWP Chat & AI Assistant',
  'rwp-code-snippets': 'RWP Code Snippets & AI Developer Assistant',
};

/** Keys keep working this long after their last day (`LICENSE_EXPIRY_GRACE_DAYS` on the server). */
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface Purchase {
  id: string;
  name: string;
  /** This site holds a key for it that has not run out. */
  licensed: boolean;
  installed: boolean;
  installedVersion: string;
  /** The newest version react-wp.com says this site is licensed for, when it has said. */
  latestVersion: string;
}

export interface PurchaseOverview {
  /** This site is connected to a react-wp.com account (Plugins → Connect to react-wp.com). */
  connected: boolean;
  purchases: Purchase[];
}

export const soldPluginName = (id: string): string => NAMES[id] || id;

const stillValid = (key: string): boolean => {
  const parts = pluginLicenseParts(key);
  return Boolean(parts && Date.parse(parts.expiresAt) + GRACE_MS > Date.now());
};

/** Every sold plugin this site holds a key for, with whether it is installed, and whether the site is connected. */
export async function loadPurchases(): Promise<PurchaseOverview> {
  const [stored, link] = await Promise.all([
    getOption<Record<string, string>>(PLUGIN_LICENSES_OPTION, {}).then(readPluginLicenses).catch(() => ({} as Record<string, string>)),
    callLink('', 'GET').then(({ answer }) => answer.link || null).catch(() => null),
  ]);
  const registered = new Map(rwp.getPlugins().map((plugin) => [plugin.id, plugin.version]));
  const latest = link?.latestVersions || {};
  const purchases = Object.keys(NAMES)
    .filter((id) => Boolean(stored[id]))
    .map((id) => ({
      id,
      name: soldPluginName(id),
      licensed: stillValid(stored[id]),
      installed: registered.has(id),
      installedVersion: registered.get(id) || '',
      latestVersion: latest[id] || '',
    }));
  return { connected: Boolean(link?.connected), purchases };
}

/** The purchase behind a marketplace listing (its slug may differ from the plugin id), or null when it is not a sold plugin. */
export const purchaseFor = (overview: PurchaseOverview | null, slugOrId: string): Purchase | null => {
  const id = pluginIdForSlug(slugOrId) || slugOrId;
  if (!overview || !isCommercialPlugin(id)) return null;
  return overview.purchases.find((purchase) => purchase.id === id) || null;
};

/** Installs a purchased sold plugin; throws the real reason as a sentence, returns what to tell the owner. */
export async function installPurchased(id: string, version = ''): Promise<string> {
  const { status, answer } = await callLink('/install', 'POST', { plugin: id, version });
  if (status >= 400 || answer.ok === false || !answer.result) {
    throw new Error(answer.error || `${soldPluginName(id)} could not be installed. Try again in a moment.`);
  }
  return `${soldPluginName(id)} was added to your site. It is being built now: when that finishes, switch it on under Plugins.`;
}

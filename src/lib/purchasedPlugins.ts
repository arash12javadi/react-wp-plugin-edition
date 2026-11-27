/**
 * What this site has bought, in one place, for the screens that show it (Plugins → My Purchases and the Marketplace cards).
 *
 * Three kinds, all delivered by the account link (Plugins → Connect to react-wp.com):
 *   - `core`: the four plugins react-wp.com sells (RWP2 keys in the `rwp_plugin_licenses` option, which also decides whether
 *     the plugin may run);
 *   - `listed`: a paid plugin of another seller sold on react-wp.com (no key on the site; react-wp.com lists it under
 *     `latestVersions` because this site is licensed for it);
 *   - `developer`: a plugin bought from a developer's own shop (RWPD1), reported to the account by that shop or claimed with the
 *     key; installed and updated from that shop, with the shop's signature checked on this server.
 * "Installed" means the plugin is registered in this build. Installing goes through one signed path per kind
 * (`POST /api/admin/license-link/install`); nothing is committed before the package's signature and SHA-256 verify.
 */
import { getOption } from './db';
import { callLink, type LinkAnswer, type SiteSeat } from './licenseLinkApi';
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

export type PurchaseKind = 'core' | 'listed' | 'developer';

export interface Purchase {
  id: string;
  name: string;
  kind: PurchaseKind;
  /** This site holds a licence for it that has not run out. */
  licensed: boolean;
  installed: boolean;
  installedVersion: string;
  /** The newest version this site is licensed for, when it is known. */
  latestVersion: string;
  /** A developer plugin: the shop that sells and delivers it. */
  sellerDomain: string;
  /** A developer plugin: the first characters of its key (the whole key is on react-wp.com → My purchases). */
  keyHint: string;
  /** `YYYY-MM-DD`, or '' when the licence does not end (or is not known here). */
  expiresOn: string;
  /** The version "Roll back" would restore, or ''. */
  rollbackTo: string;
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

const notEnded = (day: string): boolean => !day || Date.parse(`${day}T23:59:59Z`) + GRACE_MS > Date.now();

/** Every plugin this site holds a licence for, with whether it is installed, and whether the site is connected. */
export async function loadPurchases(): Promise<PurchaseOverview> {
  const [stored, link] = await Promise.all([
    getOption<Record<string, string>>(PLUGIN_LICENSES_OPTION, {}).then(readPluginLicenses).catch(() => ({} as Record<string, string>)),
    callLink('', 'GET').then(({ answer }) => answer.link || null).catch(() => null),
  ]);
  const registered = new Map(rwp.getPlugins().map((plugin) => [plugin.id, plugin.version]));
  const latest = link?.latestVersions || {};
  const rollback = link?.rollbackPoints || {};
  const base = (id: string) => ({
    installed: registered.has(id),
    installedVersion: registered.get(id) || '',
    latestVersion: latest[id] || '',
    rollbackTo: rollback[id]?.version || '',
  });
  const core: Purchase[] = Object.keys(NAMES)
    .filter((id) => Boolean(stored[id]))
    .map((id) => ({
      id, name: soldPluginName(id), kind: 'core', licensed: stillValid(stored[id]), sellerDomain: '', keyHint: '',
      expiresOn: pluginLicenseParts(stored[id])?.expiresOn || '', ...base(id),
    }));
  const developer: Purchase[] = (link?.developerLicenses || []).map((entry) => ({
    id: entry.plugin, name: entry.name || entry.plugin, kind: 'developer', licensed: notEnded(entry.expiresOn),
    sellerDomain: entry.sellerDomain, keyHint: entry.keyHint, expiresOn: entry.expiresOn, ...base(entry.plugin),
  }));
  const known = new Set([...core, ...developer].map((purchase) => purchase.id));
  const listed: Purchase[] = Object.keys(latest)
    .filter((id) => !known.has(id) && !isCommercialPlugin(id))
    .map((id) => ({
      id, name: rwp.getPlugins().find((plugin) => plugin.id === id)?.name || id, kind: 'listed', licensed: true,
      sellerDomain: '', keyHint: '', expiresOn: '', ...base(id),
    }));
  return { connected: Boolean(link?.connected), purchases: [...core, ...listed, ...developer] };
}

/** The purchase behind a marketplace listing (its slug may differ from the plugin id), or null when this site did not buy it. */
export const purchaseFor = (overview: PurchaseOverview | null, slugOrId: string): Purchase | null => {
  if (!overview) return null;
  const id = pluginIdForSlug(slugOrId) || slugOrId;
  return overview.purchases.find((purchase) => purchase.id === id) || null;
};

const failure = (status: number, answer: LinkAnswer, fallback: string): string | null =>
  (status >= 400 || answer.ok === false ? answer.error || fallback : null);

/** Installs a purchased plugin; throws the real reason as a sentence, returns what to tell the owner. */
export async function installPurchased(id: string, version = ''): Promise<string> {
  const { status, answer } = await callLink('/install', 'POST', { plugin: id, version });
  const refused = failure(status, answer, `${soldPluginName(id)} could not be installed. Try again in a moment.`);
  if (refused || !answer.result) throw new Error(refused || `${soldPluginName(id)} could not be installed. Try again in a moment.`);
  return `${soldPluginName(id)} was added to your site. It is being built now: when that finishes, switch it on under Plugins.`;
}

/** Updates a purchased plugin to the newest version it is licensed for. */
export async function updatePurchased(id: string, version = ''): Promise<string> {
  const { status, answer } = await callLink('/update', 'POST', { plugin: id, version });
  const refused = failure(status, answer, `${soldPluginName(id)} could not be updated. Try again in a moment.`);
  if (refused || !answer.result) throw new Error(refused || `${soldPluginName(id)} could not be updated.`);
  const { from, to } = answer.result.update || { from: '', to: version };
  return `${soldPluginName(id)} is being updated${from ? ` from ${from}` : ''} to ${to}. The new version is live when the deployment finishes.`;
}

/** Puts a purchased plugin back to the version its last update replaced. */
export async function rollbackPurchased(id: string): Promise<string> {
  const { status, answer } = await callLink('/rollback', 'POST', { plugin: id });
  const refused = failure(status, answer, `${soldPluginName(id)} could not be rolled back.`);
  if (refused) throw new Error(refused);
  return `${soldPluginName(id)} is going back to the previous version. It is live when the deployment finishes.`;
}

/** Binds a developer's licence key (RWPD1) to the connected account, then syncs it here. Returns what to tell the owner. */
export async function claimLicenceKey(key: string): Promise<string> {
  const { status, answer } = await callLink('/claim', 'POST', { license_key: key.trim() });
  const refused = failure(status, answer, 'That key could not be claimed. Check it and try again.');
  if (refused) throw new Error(refused);
  const title = answer.claim?.title || answer.claim?.plugin || 'The plugin';
  return answer.claim?.already ? `${title} was already on your account.` : `${title} is now on your react-wp.com account and can be installed here.`;
}

/** Which of the account's react-wp.com licences use this site. */
export async function loadSeats(): Promise<SiteSeat[]> {
  const { status, answer } = await callLink('/seats', 'GET');
  if (status >= 400 || answer.ok === false) return [];
  return Array.isArray(answer.seats) ? answer.seats : [];
}

/** Uses (`activate`) or frees (`deactivate`) one of a licence's sites for this site. */
export async function setSeat(plugin: string, action: 'activate' | 'deactivate'): Promise<string> {
  const { status, answer } = await callLink('/seat', 'POST', { plugin, action });
  const refused = failure(status, answer, 'The licence could not be changed.');
  if (refused) throw new Error(refused);
  const seat = answer.seat;
  return action === 'activate'
    ? `This site now uses one of the licence's sites (${seat?.used ?? '?'} of ${seat?.seats ?? '?'}). The key arrives with the next sync.`
    : `This site no longer uses the licence (${seat?.used ?? '?'} of ${seat?.seats ?? '?'} in use). The plugin stops receiving updates here.`;
}

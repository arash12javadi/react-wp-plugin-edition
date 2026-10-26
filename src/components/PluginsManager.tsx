import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { describeDbError, client, getOption, updateOption } from '../lib/db';
import { rwp, type RwpInstalledPlugin } from '../lib/rwp';
import {
  PLUGIN_LICENSES_OPTION,
  PLUGIN_LICENSE_SHOP_URL,
  defaultActivePluginIds,
  fetchPluginLicenseReport,
  isCommercialPlugin,
  pluginActivationLocked,
  pluginLicenseAddonFor,
  pluginLicenseKeyFrom,
  pluginLicenseParts,
  readPluginLicenses,
} from '../lib/pluginLicense';
import { BulkBar, RowCheckbox, SelectAllCheckbox, useBulkSelection } from './BulkActions';
import PluginUploadModal, { readPendingInstallResult } from './PluginUploadModal';
import PluginUninstallModal from './PluginUninstallModal';
import PluginDetailsModal from './PluginDetailsModal';
import { installPluginSchema, isEndpointUnavailable } from '../lib/pluginSchema';
import styles from './PluginsManager.module.css';

const activationOption = 'rwp_active_plugins';

/**
 * Where a key is bought, named once in `src/lib/pluginLicense.js` because the server says the same
 * address in the 402 a locked plugin answers and in its "no key stored" verdict.
 */
const SHOP_URL = PLUGIN_LICENSE_SHOP_URL;

/**
 * What `GET /api/plugins/<id>/license` answers.
 *
 * `required: false` is the common case - a plugin that is not one of the four sold ones - and it is
 * the server that decides, not this screen: the commercial set is `COMMERCIAL_PLUGIN_ADDONS`
 * (`src/lib/pluginLicense.js`), and the key it is checked against is verified there with a secret a
 * browser must never hold.
 */
interface PluginLicenseReport {
  success: boolean;
  /** False for a free plugin, and for one that ships no server module (nothing to gate). */
  required: boolean;
  licensed: boolean;
  status: 'free' | 'licensed' | 'missing' | 'invalid' | 'wrong-plugin' | 'expired' | 'unknown';
  addon: string;
  pluginId: string;
  /** The stored key, masked by the server. Never the whole key. */
  key?: string;
  expiresOn?: string;
  daysLeft?: number;
  message: string;
}

interface PluginRow extends RwpInstalledPlugin {
  plugin_id: string;
  folder: string | null;
  source: string;
  installed_at: string;
  updated_at: string;
}

/** What server.mjs found in plugins/ on disk. */
interface PluginFiles {
  /** False when the listing could not be fetched; `reason` says why. Delete is disabled then. */
  available: boolean;
  reason?: string;
  onDisk: string[];
  /** Folders on disk that the running build does not contain yet. */
  notBuilt: Array<{ id: string; folder: string; name: string }>;
  problems: string[];
}

const fetchPluginFiles = async (accessToken: string | undefined): Promise<Omit<PluginFiles, 'notBuilt'> & { plugins: Array<{ id: string; folder: string; name: string }> }> => {
  const unavailable = (reason: string) => ({ available: false, reason, onDisk: [], plugins: [], problems: [] });
  if (!accessToken) return unavailable('You are not signed in.');
  let response: Response;
  try {
    response = await fetch('/api/plugin-files', { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
  } catch {
    return unavailable('The Node server (server.mjs) could not be reached.');
  }
  const body = await response.json().catch(() => ({})) as { plugins?: Array<{ id: string; folder: string; name: string }>; problems?: string[]; error?: string };
  if (!response.ok) {
    return unavailable(response.status === 404
      ? 'This host has no /api/plugin-files endpoint. Plugin files can only be managed when the site runs on server.mjs (npm start); on Vercel, remove the folder from the repository and redeploy.'
      : body.error || `GET /api/plugin-files returned HTTP ${response.status}${response.status >= 500 ? '. In development, is server.mjs running on :3000?' : '.'}`);
  }
  const plugins = body.plugins || [];
  return { available: true, onDisk: plugins.map((plugin) => plugin.id), plugins, problems: body.problems || [] };
};

const readActiveIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

const readOptionIds = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    return readActiveIds(JSON.parse(value));
  } catch {
    return [];
  }
};

/**
 * The host's verdict on one plugin's license, typed for this screen.
 *
 * `null` means "no report", which is **not** a licence: for one of the four sold plugins the row then
 * shows **Locked** and **Inactive**, because `pluginActivationLocked` treats anything but a literal
 * `true` as unverified. A free plugin is free because `isCommercialPlugin` says so, never because a
 * request failed. The fetching is `fetchPluginLicenseReport` in `src/lib/pluginLicense.js`, so `App.tsx`
 * asks the same question in the same way.
 */
const fetchPluginLicense = async (pluginId: string): Promise<PluginLicenseReport | null> =>
  await fetchPluginLicenseReport(pluginId) as PluginLicenseReport | null;

/**
 * The keys in one line for a locked plugin: what is stored (masked) and what to do about it.
 *
 * Masked, always: the server never sends a whole key back, and this string is rendered, so a screenshot
 * of the Plugins screen cannot carry a key that would unlock another site.
 */
const licenseDetail = (report: PluginLicenseReport): string => {
  if (!report.required) return report.message;
  if (report.status === 'licensed') {
    return [report.message, report.key ? `Stored key ${report.key} - clear the field and save to remove it.` : '']
      .filter(Boolean)
      .join(' ');
  }
  return report.key ? `${report.message} (stored: ${report.key})` : report.message;
};

export default function PluginsManager() {
  const [plugins, setPlugins] = useState<PluginRow[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const [, refresh] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [files, setFiles] = useState<PluginFiles>({ available: false, onDisk: [], notBuilt: [], problems: [] });
  /** The plugin whose uninstall dialog is open, or null. */
  const [uninstalling, setUninstalling] = useState<PluginRow | null>(null);
  /** The plugin whose Details dialog is open, or null. */
  const [details, setDetails] = useState<PluginRow | null>(null);
  const [pendingInstall] = useState(readPendingInstallResult);
  const [uploadOpen, setUploadOpen] = useState(pendingInstall !== null);
  /** Bumped after an upload so the disk listing (and its "restart to load" notice) is re-read. */
  const [reloadKey, setReloadKey] = useState(0);
  /** Every stored key, `{ [pluginId]: key }`, as the `rwp_plugin_licenses` option holds them. */
  const [licenseKeys, setLicenseKeys] = useState<Record<string, string>>({});
  /**
   * The host's verdict per plugin. A plugin with no entry is one the host did not report on - free,
   * unless it is one of the four sold plugins, which stay locked until an entry says otherwise.
   */
  const [licenseReports, setLicenseReports] = useState<Record<string, PluginLicenseReport>>({});
  /** The key being typed, per plugin: a draft, so a saved key is not overwritten by a re-read. */
  const [licenseDrafts, setLicenseDrafts] = useState<Record<string, string>>({});
  /** The plugin whose key field is open, or `''` when the table is compact. */
  const [licenseOpenId, setLicenseOpenId] = useState('');
  const [licenseSavingId, setLicenseSavingId] = useState('');

  /**
   * The table's truth: a sold plugin whose key does not verify is **inactive**, whatever its row says.
   *
   * `licenseReports` starts empty, so the first paint already shows one of the four as Inactive instead
   * of flipping a moment later - a row left `active` by an earlier visit can never sit beside a
   * **Locked** badge. The verdict is `pluginActivationLocked`, the same predicate `server/plugins.mjs`
   * applies through `licensedActivePluginIds`, so the table and the gate cannot disagree; "no report
   * yet" is passed through as `undefined`, and unverified is locked. `App.tsx` applies the same rule at
   * boot but tolerates a failed request, because a public page must not lose a renderer to one.
   *
   * This decides what is painted and what may be clicked, not what is stored - the write-back effect
   * below stores the correction, so a failed read cannot quietly take away a stored choice. Filter
   * counts, the Activate button and the Delete guard all read these rows, so a screen cannot show a
   * plugin as Inactive and then refuse to act on it because a hidden column says Active.
   */
  const rows = useMemo(() => plugins.map((plugin) => (
    pluginActivationLocked(plugin.plugin_id, licenseReports[plugin.plugin_id]?.licensed)
      ? { ...plugin, active: false }
      : plugin
  )), [plugins, licenseReports]);
  /** Plugin ids whose forced-inactive state is being written back, so a re-render cannot write twice. */
  const correcting = useRef(new Set<string>());

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((plugin) =>
      (statusFilter === 'all' || (statusFilter === 'active') === Boolean(plugin.active))
      && (!term || [plugin.name, plugin.plugin_id, plugin.description, plugin.author, plugin.version]
        .filter(Boolean).join(' ').toLowerCase().includes(term)));
  }, [rows, search, statusFilter]);
  const visibleIds = useMemo(() => visible.map((plugin) => plugin.plugin_id), [visible]);
  const selection = useBulkSelection(visibleIds);
  const activeCount = rows.filter((plugin) => plugin.active).length;

  useEffect(() => rwp.subscribe(() => refresh((value) => value + 1)), []);

  useEffect(() => {
    let mounted = true;
    const loadPlugins = async () => {
      const supabase = client;
      const registeredPlugins = rwp.getPlugins();
      const [{ data: sessionData }, { data: existingRows, error: existingError }, { data: activeRow, error: activeError }] = await Promise.all([
        supabase.auth.getSession(),
        supabase.from('plugins').select('plugin_id,active').eq('source', 'bundled'),
        supabase.from('options').select('option_value').eq('option_name', activationOption).maybeSingle(),
      ]);
      if (existingError) throw existingError;
      if (activeError) throw activeError;
      const diskFiles = await fetchPluginFiles(sessionData.session?.access_token);
      // Like WordPress, a plugin is installed while its folder exists. The running build can still
      // contain a folder deleted since it was built (npm start), so the disk listing decides.
      const visiblePlugins = diskFiles.available
        ? registeredPlugins.filter((plugin) => diskFiles.onDisk.includes(plugin.id))
        : registeredPlugins;
      registeredPlugins
        .filter((plugin) => plugin.active && !visiblePlugins.includes(plugin))
        .forEach((plugin) => rwp.deactivatePlugin(plugin.id));
      const registeredIds = visiblePlugins.map((plugin) => plugin.id);
      const pluginFiles: PluginFiles = {
        ...diskFiles,
        notBuilt: diskFiles.plugins.filter((plugin) => !registeredPlugins.some((registered) => registered.id === plugin.id)),
      };
      // No option yet means the free plugins are active and the four sold ones are not
      // (`defaultActivePluginIds`, which App.tsx and server/plugins.mjs apply the same way); otherwise
      // new plugins start inactive.
      const storedActiveIds = activeRow ? readOptionIds(activeRow.option_value) : null;
      const existingById = new Map((existingRows || []).map((row) => [row.plugin_id, row]));
      const metadata = visiblePlugins.map((plugin) => ({
        plugin_id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        author: plugin.author || null,
        description: plugin.description || '',
        folder: `plugins/${diskFiles.plugins.find((item) => item.id === plugin.id)?.folder || plugin.id}`,
        source: 'bundled',
      }));
      const newRows = metadata
        .filter((plugin) => !existingById.has(plugin.plugin_id))
        .map((plugin) => ({
          ...plugin,
          active: storedActiveIds === null
            ? !isCommercialPlugin(plugin.plugin_id)
            : storedActiveIds.includes(plugin.plugin_id),
        }));
      if (newRows.length > 0) {
        const { error: insertError } = await supabase.from('plugins').insert(newRows);
        if (insertError) throw insertError;
      }
      for (const plugin of metadata.filter((item) => existingById.has(item.plugin_id))) {
        const { error: updateError } = await supabase
          .from('plugins')
          .update({
            name: plugin.name,
            version: plugin.version,
            author: plugin.author,
            description: plugin.description,
            folder: plugin.folder,
            source: plugin.source,
            updated_at: new Date().toISOString(),
          })
          .eq('plugin_id', plugin.plugin_id);
        if (updateError) throw updateError;
      }
      const staleIds = (existingRows || [])
        .map((row) => row.plugin_id)
        .filter((pluginId) => !registeredIds.includes(pluginId));
      if (staleIds.length > 0) {
        const { error: deleteError } = await supabase
          .from('plugins')
          .delete()
          .eq('source', 'bundled')
          .in('plugin_id', staleIds);
        if (deleteError) throw deleteError;
      }
      const { data: rows, error: rowsError } = await supabase.from('plugins').select('*').order('name');
      if (rowsError) throw rowsError;
      const ids = storedActiveIds ?? defaultActivePluginIds(registeredIds);
      const currentIds = ids.filter((id) => registeredIds.includes(id));
      if (storedActiveIds && currentIds.length !== ids.length) await updateOption(activationOption, currentIds);
      const dbRows = ((rows || []) as PluginRow[]).filter((row) => row.source !== 'bundled' || registeredIds.includes(row.plugin_id));
      const registeredById = new Map(registeredPlugins.map((plugin) => [plugin.id, plugin]));
      const mergedRows = dbRows.map((row) => ({
        ...row,
        ...(registeredById.get(row.plugin_id) || {}),
        id: row.plugin_id,
        active: row.active,
      }));
      return { ids: currentIds, registeredPlugins: visiblePlugins, mergedRows, pluginFiles };
    };
    loadPlugins().then(({ ids, registeredPlugins, mergedRows, pluginFiles }) => {
        if (!mounted) return;
        setFiles(pluginFiles);
        setActiveIds(ids);
        setPlugins(mergedRows);
        registeredPlugins.forEach((plugin) => {
          const row = mergedRows.find((item) => item.plugin_id === plugin.id);
          // A sold plugin is never switched on from a stored row: the row can be out of date and the key
          // can have lapsed. Its license report is what decides, `rows` paints that verdict, and App.tsx
          // has already applied the same rule at boot - so this only ever switches free plugins on.
          if (row?.active && !plugin.active && !isCommercialPlugin(plugin.id)) rwp.activatePlugin(plugin.id);
          if (!row?.active && plugin.active) rwp.deactivatePlugin(plugin.id);
        });
        // The runtime flag is what actually runs, so a free plugin's row follows it. A sold plugin keeps
        // the stored value instead: what runs for it is `rows` (forced by its license report), and keeping
        // the stored truth here is what lets the write-back effect below see - and fix - a row that
        // disagrees with its verdict. Overwriting it with the runtime "off" would hide that disagreement.
        setPlugins(mergedRows.map((row) => {
          if (isCommercialPlugin(row.plugin_id)) return row;
          const runtime = rwp.getPlugins().find((plugin) => plugin.id === row.plugin_id)?.active;
          return { ...row, active: runtime ?? row.active };
        }));
      })
      .catch((loadError: unknown) => {
        if (mounted) {
          const message = loadError instanceof Error ? loadError.message : 'Unable to load plugins.';
          setError(
            message.includes('relation') && message.includes('plugins')
              ? 'The plugins table is missing. Run supabase/schema.sql in the Supabase SQL Editor, then reload this page.'
              : message,
          );
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [reloadKey]);

  const describe = (list: PluginRow[]) => (list.length === 1 ? list[0].name : `${list.length} plugins`);

  /**
   * The stored keys and the host's verdict on each one.
   *
   * Two reads rather than one: the keys come from the options row this screen may write, and the verdict
   * comes from the server, which is the only side that can check a signature. A plugin whose report
   * cannot be fetched keeps no entry, which for one of the four sold plugins means locked (`rows`) and
   * for anything else means free - the gate is in the server either way.
   */
  useEffect(() => {
    if (loading) return;
    let mounted = true;
    void (async () => {
      const stored = readPluginLicenses(await getOption<Record<string, string>>(PLUGIN_LICENSES_OPTION, {}));
      const reports: Record<string, PluginLicenseReport> = {};
      await Promise.all(plugins.map(async (plugin) => {
        const report = await fetchPluginLicense(plugin.plugin_id);
        if (report) reports[plugin.plugin_id] = report;
      }));
      if (!mounted) return;
      setLicenseKeys(stored);
      setLicenseReports(reports);
    })();
    return () => { mounted = false; };
  }, [loading, plugins]);

  /**
   * Writes the forced state back: a sold plugin whose key does not verify is stored inactive.
   *
   * `rows` already paints it that way and the server refuses its routes, so this is what stops the
   * stored state from disagreeing with both - the `plugins` row and `rwp_active_plugins` are switched
   * off, the plugin's own deactivation hooks run, and every screen and every boot from here reads one
   * answer. It runs in the browser rather than in `server/plugins.mjs` because that server holds the
   * publishable key, which may not write `options`; the administrator's own token, which got them to
   * this screen, may.
   *
   * Only a settled verdict is written. No report at all (the host did not answer) and `unknown` (the
   * license option could not be read) say nothing about the key, so the row is left exactly as the
   * administrator left it - a key store that is briefly unreadable must not switch a paying site's shop
   * off. The Activate button is disabled for the same rows, so this is a correction, not a race.
   */
  useEffect(() => {
    if (loading) return;
    const stale = plugins.filter((plugin) => {
      const report = licenseReports[plugin.plugin_id];
      return plugin.active && Boolean(report?.required) && !report?.licensed && report?.status !== 'unknown';
    });
    const ids = stale
      .map((plugin) => plugin.plugin_id)
      .filter((pluginId) => !correcting.current.has(pluginId));
    if (!ids.length) return;
    ids.forEach((pluginId) => correcting.current.add(pluginId));
    let mounted = true;
    void (async () => {
      const supabase = client;
      try {
        const { data, error: updateError } = await supabase
          .from('plugins')
          .update({ active: false, updated_at: new Date().toISOString() })
          .in('plugin_id', ids)
          .select('plugin_id');
        if (updateError) throw updateError;
        if ((data || []).length < ids.length) {
          throw new Error(`The database switched off ${(data || []).length} of ${ids.length} plugin rows: row level security skipped the rest. Managing plugins needs the activate_plugins capability.`);
        }
        const nextIds = activeIds.filter((id) => !ids.includes(id));
        if (!(await updateOption(activationOption, nextIds))) {
          throw new Error('The plugins were switched off in the table, but the activation state could not be saved.');
        }
        ids.forEach((id) => rwp.deactivatePlugin(id));
        if (!mounted) return;
        setActiveIds(nextIds);
        setPlugins((current) => current.map((item) => (ids.includes(item.plugin_id) ? { ...item, active: false } : item)));
        const names = plugins.filter((plugin) => ids.includes(plugin.plugin_id));
        setFeedback(`${describe(names)} ${names.length === 1 ? 'was' : 'were'} switched off: ${names.length === 1 ? 'its license key does not verify' : 'their license keys do not verify'}, and a sold plugin stays inactive until one does. Save a valid key in the License column to activate ${names.length === 1 ? 'it' : 'them'} again.`);
      } catch (syncError: unknown) {
        if (mounted) setError(syncError instanceof Error ? syncError.message : describeDbError(syncError));
      } finally {
        ids.forEach((pluginId) => correcting.current.delete(pluginId));
      }
    })();
    return () => { mounted = false; };
  }, [loading, plugins, licenseReports, activeIds]);

  /**
   * Stores one plugin's key, or removes it when the field is left empty.
   *
   * The whole `rwp_plugin_licenses` option is rewritten because it is one row: a per-plugin write would
   * race another administrator's and lose whichever saved first. The key is checked here for its shape
   * and for the plugin it names - an obvious typo should not need a round trip - and the *server* is
   * asked whether it verifies, since only it holds the signing secret. It does not gate anything else:
   * the plugin's own routes answer 402 until the verdict is `licensed`.
   */
  const saveLicense = async (plugin: PluginRow) => {
    const pasted = pluginLicenseKeyFrom(licenseDrafts[plugin.plugin_id] ?? '');
    setError('');
    setFeedback('');
    if (pasted) {
      const parts = pluginLicenseParts(pasted);
      if (!parts) {
        setError('That is not a license key: a key reads RWP1-ADDON-YYYYMMDD-SIGNATURE, for example RWP1-SHOP-20270630-4K7QM2XZ8B.');
        return;
      }
      const addon = pluginLicenseAddonFor(plugin.plugin_id);
      if (parts.addon !== addon) {
        setError(`That key was issued for ${parts.addon}, not for ${plugin.name} (${addon}). Paste the key this plugin was issued.`);
        return;
      }
    }
    setLicenseSavingId(plugin.plugin_id);
    try {
      const next = { ...licenseKeys };
      if (pasted) next[plugin.plugin_id] = pasted;
      else delete next[plugin.plugin_id];
      if (!(await updateOption(PLUGIN_LICENSES_OPTION, next))) {
        throw new Error('The key could not be stored. Sign in again as an administrator and retry.');
      }
      setLicenseKeys(next);
      setLicenseDrafts((current) => ({ ...current, [plugin.plugin_id]: '' }));
      const report = await fetchPluginLicense(plugin.plugin_id);
      setLicenseReports((current) => {
        const merged = { ...current };
        if (report) merged[plugin.plugin_id] = report;
        else delete merged[plugin.plugin_id];
        return merged;
      });
      setFeedback(report
        ? `${plugin.name}: ${report.message}`
        : `${plugin.name}: the key was saved, but this host reports no license verdict for it, so the plugin stays inactive until it does.`);
      if (report?.licensed) setLicenseOpenId('');
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : describeDbError(saveError));
    } finally {
      setLicenseSavingId('');
    }
  };

  /**
   * Activates or deactivates several plugins with one write to the table and one to the option.
   *
   * Activation is refused for a sold plugin whose key is not in place. The refusal is not the gate -
   * the plugin's own routes answer 402 until the key verifies, and that is checked on the server where
   * a browser cannot talk it round - but switching on a plugin that can only answer 402 leaves a site
   * with a shop on the menu and a 402 behind it, so the answer here is the key field plus where to get
   * a key, not an "Active" badge that lies.
   *
   * The test is `pluginActivationLocked`, the same one behind the row's badge, so the bulk action and the
   * disabled per-row button cannot disagree: a report that never arrived counts as no key, because a host
   * that cannot verify one cannot say the plugin is licensed either.
   */
  const setActive = async (targets: PluginRow[], nextActive: boolean) => {
    const changing = targets.filter((plugin) => plugin.active !== nextActive);
    if (!changing.length) {
      setFeedback(`${describe(targets)} ${targets.length === 1 ? 'is' : 'are'} already ${nextActive ? 'active' : 'inactive'}.`);
      return;
    }
    if (nextActive) {
      const locked = changing.filter((plugin) => (
        pluginActivationLocked(plugin.plugin_id, licenseReports[plugin.plugin_id]?.licensed)
      ));
      if (locked.length) {
        const names = locked.map((plugin) => `${plugin.name} (${pluginLicenseAddonFor(plugin.plugin_id)})`).join(', ');
        setFeedback('');
        setError(`${names} ${locked.length === 1 ? 'is' : 'are'} sold separately and no key in place checks out, so ${locked.length === 1 ? 'it' : 'they'} cannot be activated yet. Paste the key in the License column, or buy one at ${SHOP_URL}.`);
        setLicenseOpenId(locked[0].plugin_id);
        return;
      }
    }
    const ids = changing.map((plugin) => plugin.plugin_id);
    setSavingId(changing.length === 1 ? ids[0] : 'bulk');
    setError('');
    setFeedback('');
    const nextIds = nextActive
      ? [...new Set([...activeIds, ...ids])]
      : activeIds.filter((id) => !ids.includes(id));
    const notes: string[] = [];
    try {
      // Plugin tables are created on activation, not at install time, so a site that never
      // enables the shop never gets its twenty tables. schema.sql is re-runnable by contract, so
      // activating an already-provisioned plugin is a no-op rather than an error.
      if (nextActive) {
        for (const plugin of changing) {
          try {
            const result = await installPluginSchema(plugin.plugin_id);
            if (result.created?.length) {
              notes.push(`${plugin.name}: created ${result.created.join(', ')}.`);
            }
            if (result.stillMissing?.length) {
              // The SQL ran but did not produce what the manifest promised: worth saying out loud
              // rather than letting the plugin fail later with a "relation does not exist".
              notes.push(`${plugin.name}: schema.sql ran but ${result.stillMissing.join(', ')} ${result.stillMissing.length === 1 ? 'is' : 'are'} still missing.`);
            }
          } catch (schemaError: unknown) {
            if (!isEndpointUnavailable(schemaError)) throw schemaError;
            // Static host: there is no endpoint to run DDL. Activation still works, and the
            // plugin's own screens already explain which migration to run by hand.
            notes.push(`${plugin.name}: its database tables were not checked, because ${schemaError.message}`);
          }
        }
      }
      const supabase = client;
      const { data, error: updateError } = await supabase
        .from('plugins')
        .update({ active: nextActive, updated_at: new Date().toISOString() })
        .in('plugin_id', ids)
        .select('plugin_id');
      if (updateError) throw updateError;
      if ((data || []).length < ids.length) {
        throw new Error(`The database updated ${(data || []).length} of ${ids.length} plugin rows: row level security skipped the rest. Managing plugins needs the activate_plugins capability.`);
      }
      const saved = await updateOption(activationOption, nextIds);
      if (!saved) throw new Error('Plugin activation state could not be saved.');
      ids.forEach((id) => (nextActive ? rwp.activatePlugin(id) : rwp.deactivatePlugin(id)));
      setActiveIds(nextIds);
      setPlugins((current) => current.map((item) => ids.includes(item.plugin_id) ? { ...item, active: nextActive } : item));
      setFeedback([`${describe(changing)} ${nextActive ? 'activated' : 'deactivated'}.`, ...notes].join(' '));
      selection.clear();
    } catch (toggleError: unknown) {
      setError(toggleError instanceof Error ? toggleError.message : describeDbError(toggleError));
    } finally {
      setSavingId('');
    }
  };

  const deletePlugins = async (targets: PluginRow[]) => {
    if (!targets.length) return;
    setError('');
    setFeedback('');
    if (!files.available) {
      setError(`Plugin files cannot be deleted here: ${files.reason}`);
      return;
    }
    const active = targets.filter((plugin) => plugin.active);
    if (active.length) {
      setError(`Deactivate ${describe(active)} before deleting ${active.length === 1 ? 'it' : 'them'}.`);
      return;
    }
    const question = targets.length === 1
      ? `Delete "${targets[0].name}"? This permanently removes the plugins/${targets[0].plugin_id} folder from the server.`
      : `Delete ${targets.length} plugins? This permanently removes their folders from plugins/ on the server.`;
    if (!window.confirm(question)) return;
    setDeletingId(targets.length === 1 ? targets[0].plugin_id : 'bulk');
    const deletedIds: string[] = [];
    const failures: string[] = [];
    try {
      const supabase = client;
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error('Your session has expired. Sign in again.');
      for (const plugin of targets) {
        const response = await fetch('/api/plugin-files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ id: plugin.plugin_id }),
        });
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) {
          failures.push(body.error || `Deleting ${plugin.name} failed: HTTP ${response.status}.`);
          continue;
        }
        deletedIds.push(plugin.plugin_id);
      }
      if (deletedIds.length) {
        const { error: deleteError } = await supabase.from('plugins').delete().in('plugin_id', deletedIds);
        if (deleteError) failures.push(`The folders were deleted, but their rows in the plugins table were not: ${describeDbError(deleteError)}`);
        setPlugins((current) => current.filter((item) => !deletedIds.includes(item.plugin_id)));
        setFiles((current) => ({ ...current, onDisk: current.onDisk.filter((id) => !deletedIds.includes(id)) }));
        const deleted = targets.filter((plugin) => deletedIds.includes(plugin.plugin_id));
        setFeedback(`${describe(deleted)} ${deleted.length === 1 ? 'was' : 'were'} deleted.`);
        selection.clear();
      }
      if (failures.length) setError(failures.join(' '));
    } catch (deleteError: unknown) {
      setError(deleteError instanceof Error ? deleteError.message : describeDbError(deleteError));
    } finally {
      setDeletingId('');
    }
  };

  const onBulk = (action: string, ids: string[]) => {
    const targets = rows.filter((plugin) => ids.includes(plugin.plugin_id));
    if (action === 'activate') void setActive(targets, true);
    if (action === 'deactivate') void setActive(targets, false);
    if (action === 'delete') void deletePlugins(targets);
  };

  const reloadPlugins = () => {
    window.location.reload();
  };

  if (loading) return <div className={styles.status} role="status">Loading pluginsâ€¦</div>;

  return (
    <section className={styles.wrapper} aria-labelledby="plugins-heading">
      <div className={styles.heading}>
        <div>
          <h2 id="plugins-heading">Plugins</h2>
          <p>Extend React-WP with typed actions, filters, admin pages, widgets, and shortcodes.</p>
          <div className={styles.headingActions}>
            <button type="button" className={styles.upload} onClick={() => setUploadOpen(true)}>Upload Plugin</button>
            <button type="button" className={styles.refresh} onClick={reloadPlugins}>Refresh plugins</button>
          </div>
        </div>
      </div>
      {uploadOpen && (
        <PluginUploadModal
          initialResult={pendingInstall}
          onClose={() => setUploadOpen(false)}
          onInstalled={(installed) => {
            setError('');
            setFeedback(`${installed.plugin.name} ${installed.plugin.version} was uploaded. It appears in this list as inactive once the site has been rebuilt.`);
            setReloadKey((value) => value + 1);
          }}
        />
      )}
      {uninstalling && (
        <PluginUninstallModal
          plugin={uninstalling}
          onDeactivate={() => setActive([uninstalling], false)}
          onClose={() => setUninstalling(null)}
          onFinished={(summary) => {
            setUninstalling(null);
            setError('');
            setFeedback(summary);
            // The folder and possibly its tables are gone; re-read both listings rather than
            // patching state that no longer matches the server.
            setReloadKey((value) => value + 1);
          }}
        />
      )}
      {details && (
        <PluginDetailsModal plugin={details} onClose={() => setDetails(null)} />
      )}
      {error && <div className={styles.error} role="alert">{error}</div>}
      {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
      <div className={styles.notice}>
        A plugin is installed while its folder exists in <code>plugins/</code>. Activation is stored in Supabase and shared by every administrator, and it is what creates the plugin&apos;s database tables. <strong>Uninstall</strong> removes the folder and asks what should happen to those tables. Activation is free, and so is every plugin that shows <strong>Free</strong>. Four plugins are sold — Page Builder, Shop, Chat and Code Snippets — and each asks for its own key in the License column; only the routes of those four wait for one. They arrive <strong>inactive</strong> and stay that way until their key checks out, so a new site carries nothing it cannot use; if a key later stops verifying, the plugin is switched back to <strong>inactive</strong> here and on the server, and nothing of it runs. <a className={styles.shopLink} href={SHOP_URL} target="_blank" rel="noreferrer noopener">Buy a key</a> when you want one.
      </div>
      {!files.available && files.reason && (
        <div className={styles.notice} role="status">Plugin folders could not be checked, so Delete is unavailable: {files.reason}</div>
      )}
      {files.notBuilt.length > 0 && (
        <div className={styles.notice} role="status">
          Found {files.notBuilt.map((plugin) => `${plugin.name} (plugins/${plugin.folder})`).join(', ')} on disk, but the running site was built without {files.notBuilt.length === 1 ? 'it' : 'them'}. Restart the server with <code>npm start</code> (which rebuilds) and {files.notBuilt.length === 1 ? 'it' : 'they'} will appear here as inactive. Under <code>npm run dev</code>, reload this page.
        </div>
      )}
      {files.problems.length > 0 && (
        <div className={styles.error} role="alert">{files.problems.join(' ')}</div>
      )}
      {plugins.length === 0 ? (
        <div className={styles.empty}>
          <strong>No plugins registered</strong>
          <span>Built-in and bundled plugins will appear here when they register through the RWP API.</span>
        </div>
      ) : (
        <div className={styles.list}>
          <div className={styles.filters}>
            <div className={styles.filterTabs} role="tablist" aria-label="Filter plugins">
              {([['all', `All (${plugins.length})`], ['active', `Active (${activeCount})`], ['inactive', `Inactive (${plugins.length - activeCount})`]] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={statusFilter === id}
                  className={statusFilter === id ? styles.filterActive : styles.filter}
                  onClick={() => setStatusFilter(id)}>{label}</button>
              ))}
            </div>
            <input type="search" className={styles.search} value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder="Search pluginsâ€¦" aria-label="Search plugins" />
          </div>
          <BulkBar selection={selection} total={visible.length} noun="plugins"
            busy={savingId === 'bulk' || deletingId === 'bulk' ? 'working' : ''}
            actions={[
              { id: 'activate', label: 'Activate', tone: 'primary', hidden: statusFilter === 'active' },
              { id: 'deactivate', label: 'Deactivate', hidden: statusFilter === 'inactive' },
              // Folders only. Anything touching plugin data goes through the per-plugin
              // Uninstall dialog, which is where the backup and wipe choices live.
              { id: 'delete', label: 'Delete files', tone: 'danger' },
            ]}
            onAction={onBulk} />
          {visible.length === 0 && <div className={styles.empty}><strong>No plugins match</strong><span>Try another search or filter.</span></div>}
          {visible.length > 0 && <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th className={styles.checkCell}><SelectAllCheckbox selection={selection} total={visible.length} /></th><th>Plugin</th><th>Description</th><th>Version</th><th>Author</th><th>Status</th><th>License</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {visible.map((plugin) => {
                  const report = licenseReports[plugin.plugin_id];
                  const open = licenseOpenId === plugin.plugin_id;
                  // One of the four is locked until a report says its key verifies. `isCommercialPlugin`
                  // rather than `report.required`, so a host that answered nothing shows **Locked** rather
                  // than **Free** - the plugin is sold either way, and a free plugin is never locked by a
                  // missing answer.
                  const needsKey = isCommercialPlugin(plugin.plugin_id) || Boolean(report?.required);
                  const unlocked = Boolean(report?.licensed);
                  const locked = needsKey && !unlocked;
                  return (
                    <Fragment key={plugin.plugin_id}>
                      <tr className={selection.isSelected(plugin.plugin_id) ? styles.rowSelected : undefined}>
                        <td className={styles.checkCell}><RowCheckbox selection={selection} id={plugin.plugin_id} label={plugin.name} /></td>
                        <td><strong>{plugin.name}</strong><small>{plugin.plugin_id}</small></td>
                        <td>{plugin.description || 'No description provided.'}</td>
                        <td>{plugin.version}</td>
                        <td>{plugin.author || '—'}</td>
                        <td><span className={plugin.active ? styles.active : styles.inactive}>{plugin.active ? 'Active' : 'Inactive'}</span></td>
                        <td>
                          {!needsKey ? (
                            <span
                              className={styles.licenseFree}
                              title={report?.message || 'This plugin has no server routes, so there is nothing to gate.'}
                            >
                              Free
                            </span>
                          ) : (
                            <div className={styles.licenseCell}>
                              <button
                                type="button"
                                className={unlocked ? styles.licenseUnlocked : styles.licenseLocked}
                                onClick={() => setLicenseOpenId(open ? '' : plugin.plugin_id)}
                                aria-expanded={open}
                                title={report?.message || 'Sold separately: paste the key this plugin was issued.'}
                              >
                                {unlocked ? 'Unlocked' : 'Locked'}
                              </button>
                              {unlocked && report?.expiresOn
                                ? <small className={styles.licenseExpiry}>to {report.expiresOn}</small>
                                : null}
                              {!unlocked ? (
                                <a
                                  className={styles.shopLink}
                                  href={SHOP_URL}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  Buy a key
                                </a>
                              ) : null}
                            </div>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={plugin.active ? styles.deactivate : `${styles.activate}${locked ? ` ${styles.activateLocked}` : ''}`}
                            disabled={savingId === plugin.plugin_id || deletingId === plugin.plugin_id || (!plugin.active && locked)}
                            onClick={() => void setActive([plugin], !plugin.active)}
                            title={!plugin.active && locked
                              ? `Sold separately: save a key in the License column, then activate. Keys are sold at ${SHOP_URL}.`
                              : undefined}
                          >
                            {savingId === plugin.plugin_id ? 'Saving…' : plugin.active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            className={styles.delete}
                            disabled={savingId === plugin.plugin_id || deletingId === plugin.plugin_id}
                            onClick={() => { setError(''); setFeedback(''); setUninstalling(plugin); }}
                          >
                            Uninstall
                          </button>
                          <button
                            type="button"
                            className={styles.details}
                            onClick={() => setDetails(plugin)}
                            title={`What ${plugin.name} does, and what it needs before it works`}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                      {open ? (
                        <tr className={styles.licenseRow}>
                          <td colSpan={8}>
                            <form
                              className={styles.licenseForm}
                              onSubmit={(event) => { event.preventDefault(); void saveLicense(plugin); }}
                            >
                              <label htmlFor={`license-${plugin.plugin_id}`}>
                                License key for {plugin.name} ({pluginLicenseAddonFor(plugin.plugin_id)})
                              </label>
                              <div className={styles.licenseEntry}>
                                <input
                                  id={`license-${plugin.plugin_id}`}
                                  className={styles.licenseInput}
                                  value={licenseDrafts[plugin.plugin_id] ?? ''}
                                  onChange={(event) => setLicenseDrafts((current) => ({
                                    ...current,
                                    [plugin.plugin_id]: event.target.value,
                                  }))}
                                  placeholder={`RWP1-${pluginLicenseAddonFor(plugin.plugin_id)}-20270630-XXXXXXXXXX`}
                                  autoComplete="off"
                                  spellCheck={false}
                                  inputMode="text"
                                />
                                <button type="submit" className={styles.activate} disabled={licenseSavingId === plugin.plugin_id}>
                                  {licenseSavingId === plugin.plugin_id ? 'Saving…' : 'Save key'}
                                </button>
                                <button type="button" className={styles.deactivate} onClick={() => setLicenseOpenId('')}>
                                  Close
                                </button>
                              </div>
                              <p className={styles.licenseNote}>
                                {report
                                  ? licenseDetail(report)
                                  : 'This host did not report a license verdict for this plugin, so it cannot be activated until it does. The key is saved either way.'}
                              </p>
                              <p className={styles.licenseNote}>
                                Only this plugin is affected: everything else on the site, including setup, stays free.
                                Leave the field empty and save to remove the stored key.{' '}
                                <a className={styles.shopLink} href={SHOP_URL} target="_blank" rel="noreferrer noopener">
                                  Buy a license key
                                </a>{' '}
                                if you do not have one yet.
                              </p>
                            </form>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>}
        </div>
      )}
    </section>
  );
}

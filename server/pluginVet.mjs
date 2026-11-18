import { unzipSync, strFromU8 } from 'fflate';

/**
 * The automated vetting sandbox.
 *
 * It never executes the submitted code — it scans the archive's text for the patterns a malicious
 * or sloppy plugin would have to contain: outbound network calls, Node internals, dynamic code
 * evaluation, cookie/localStorage exfiltration, obfuscation markers, and a manifest that either is
 * missing or does not declare itself through the approved react-wp plugin API. The report is stored
 * verbatim on the plugin row as `vet_report`, so the owner can see exactly why a package was
 * approved or rejected.
 */

const TEXT_EXTENSIONS = new Set([
  '', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'html', 'md', 'sql', 'php', 'txt', 'env',
]);

const NETWORK_PATTERNS = [
  /\bfetch\s*\(/i, /\baxios\b/i, /\bXMLHttpRequest\b/i, /\bWebSocket\s*\(/i,
  /\bsendBeacon\s*\(/i, /https?:\/\/[^\s"'`)]+/i, /require\s*\(\s*['"]https?:\/\//i,
  /\bimport\s*\(\s*['"]https?:\/\//i, /\$\.(ajax|get|post)\s*\(/i,
];

const DANGEROUS_PATTERNS = [
  /\beval\s*\(/i, /\bnew\s+Function\b/i, /\bFunction\s*\(/i,
  /\bchild_process\b/i, /\bnode:child_process\b/i, /\bnode:fs\b/i, /\brequire\s*\(\s*['"]fs['"]\s*\)/i,
  /\bprocess\.env\b/i, /\bBuffer\.from\s*\(\s*['"][A-Za-z0-9+/=]{40,}['"]/i,
];

const EXFILTRATION_PATTERNS = [
  /\bdocument\.cookie\b/i, /\blocalStorage\b/i, /\bsessionStorage\b/i,
];

const OBFUSCATION_PATTERNS = [
  /\batob\s*\(/i, /\bString\.fromCharCode\s*\(/i, /\bunescape\s*\(/i, /\beval\s*\(/i,
];

const APPROVED_HOOKS = [
  'defineRwpPlugin', 'admin.registerPage', 'admin.registerDashboardWidget', 'admin.registerSetupCheck',
  'shortcodes.register', 'routes.register', 'header.register', 'content.registerRenderer',
  'content.registerAction', 'content.registerTemplateProvider', 'integrations.registerCard',
  'actions.add', 'filters.add', 'addSlotContent', 'addAction', 'addFilter', 'usePublicChrome',
  'getSupabaseClient', 'tryGetSupabaseClient',
];

const DISALLOWED_API = [
  /supabase\s*\.\s*auth\s*\.\s*admin/i, /\bservice_role\b/i, /\bSUPABASE_SECRET_KEY\b/i,
];

const isTextEntry = (name) => TEXT_EXTENSIONS.has((name.split('.').pop() || '').toLowerCase());

const decode = (bytes) => {
  const view = new Uint8Array(bytes);
  if (view.length > 1_000_000) return '';
  try {
    const text = strFromU8(view);
    const bad = (text.match(/\uFFFD/g) || []).length;
    return bad > text.length * 0.02 ? '' : text;
  } catch {
    return '';
  }
};

const findManifest = (entries) => {
  for (const [name] of entries) {
    const trimmed = name.replace(/^\/+/, '');
    if (/^(?:[^/]+\/)?manifest\.json$/i.test(trimmed)) return name;
  }
  return null;
};

/** The package's declared id, or null. */
export const manifestId = (text) => {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
};

/** Prose and data files: words and links in them are not code that runs. */
const DOC_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const LINK_ONLY_EXTENSIONS = new Set(['json']);
const extensionOf = (name) => (name.split('.').pop() || '').toLowerCase();

/**
 * Scans an already-unpacked archive: [[path, Uint8Array], ...].
 *
 * `docsAreInert` is for packages that come with a README: the web addresses in a README, a changelog or a
 * `homepage` field in a JSON file are links for people, not network calls, and without this every documented
 * plugin would be reported as calling out. Documentation files are left out of every pattern, and JSON files out
 * of the network pattern only. Anything executable is scanned exactly as before. Off by default, so the existing
 * submission path is unchanged.
 */
export function vetFiles(entries, { docsAreInert = false } = {}) {
  const checks = [];
  const flags = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || (ok ? 'ok' : 'failed') });

  const manifestPath = findManifest(entries);
  if (!manifestPath) {
    add('manifest.json', false, 'The package has no manifest.json (at the root or one directory deep).');
    return { pass: false, verdict: 'rejected', checks, flags: ['Missing manifest.json'], manifest: null };
  }

  const manifestEntry = entries.find(([name]) => name === manifestPath);
  let manifestText = '';
  let manifest = null;
  try {
    manifestText = strFromU8(manifestEntry[1]);
    manifest = JSON.parse(manifestText);
  } catch {
    add('manifest.json', false, 'manifest.json is not valid JSON.');
    return { pass: false, verdict: 'rejected', checks, flags: ['Invalid manifest.json'], manifest: null };
  }

  const missing = ['id', 'name', 'version', 'entry'].filter((key) => !manifest[key]);
  add('manifest fields', missing.length === 0, missing.length
    ? `Missing required manifest field(s): ${missing.join(', ')}.`
    : `Declares ${manifest.id} v${manifest.version} (entry: ${manifest.entry}).`);
  if (missing.length) flags.push(`Missing manifest fields: ${missing.join(', ')}`);

  const entryName = String(manifest.entry || '').replace(/^\.\//, '');
  const entryExists = entries.some(([name]) => {
    const trimmed = name.replace(/^\/+/, '');
    return trimmed === entryName || trimmed.endsWith(`/${entryName}`) || name === entryName;
  });
  add('entry file', Boolean(manifest.entry && entryExists), manifest.entry && entryExists
    ? `Entry ${manifest.entry} is present.`
    : `The entry file (${manifest.entry || 'unset'}) is not in the package.`);

  const textOf = (keep) => entries
    .filter(([name]) => isTextEntry(name) && keep(extensionOf(name)))
    .map(([, bytes]) => decode(bytes))
    .filter(Boolean)
    .join('\n');
  /** The first scanned file a pattern matches, so a flag tells the author where to look. */
  const fileOf = (re, keep) => {
    for (const [name, bytes] of entries) {
      if (isTextEntry(name) && keep(extensionOf(name)) && re.test(decode(bytes))) return name.replace(/^\/+/, '');
    }
    return '';
  };
  const where = (re, keep) => {
    const file = fileOf(re, keep);
    return file ? ` (in ${file})` : '';
  };
  const keepCode = (ext) => !(docsAreInert && DOC_EXTENSIONS.has(ext));
  const keepNetwork = (ext) => !(docsAreInert && (DOC_EXTENSIONS.has(ext) || LINK_ONLY_EXTENSIONS.has(ext)));
  const combined = textOf(keepCode);
  const networkText = docsAreInert ? textOf((ext) => !DOC_EXTENSIONS.has(ext) && !LINK_ONLY_EXTENSIONS.has(ext)) : combined;

  const network = NETWORK_PATTERNS.filter((re) => re.test(networkText));
  add('external network calls', network.length === 0, network.length
    ? `Found ${network.length} external network call pattern(s).`
    : 'No outbound network calls detected.');
  network.forEach((re) => flags.push(`Network call: ${re}${where(re, keepNetwork)}`));

  const dangerous = DANGEROUS_PATTERNS.filter((re) => re.test(combined));
  add('disallowed imports / dynamic code', dangerous.length === 0, dangerous.length
    ? `Found ${dangerous.length} disallowed import or dynamic-code pattern(s).`
    : 'No disallowed imports or dynamic code.');
  dangerous.forEach((re) => flags.push(`Disallowed pattern: ${re}${where(re, keepCode)}`));

  const exfil = EXFILTRATION_PATTERNS.filter((re) => re.test(combined));
  add('credential / data exfiltration', exfil.length === 0, exfil.length
    ? `Found ${exfil.length} cookie/storage access pattern(s).`
    : 'No cookie or storage exfiltration patterns.');
  exfil.forEach((re) => flags.push(`Exfiltration pattern: ${re}${where(re, keepCode)}`));

  const obfuscation = OBFUSCATION_PATTERNS.filter((re) => re.test(combined));
  add('obfuscation markers', obfuscation.length === 0, obfuscation.length
    ? `Found ${obfuscation.length} obfuscation marker(s).`
    : 'No obfuscation markers.');
  obfuscation.forEach((re) => flags.push(`Obfuscation: ${re}${where(re, keepCode)}`));

  const usesApprovedApi = APPROVED_HOOKS.some((hook) => combined.includes(hook));
  add('react-wp hooks', usesApprovedApi, usesApprovedApi
    ? 'Uses the approved react-wp plugin API.'
    : 'Never calls defineRwpPlugin or a react-wp registration hook.');
  if (!usesApprovedApi) flags.push('Does not use the react-wp plugin API');

  const disallowedApi = DISALLOWED_API.filter((re) => re.test(combined));
  add('server secret usage', disallowedApi.length === 0, disallowedApi.length
    ? `References a server-only API or secret (${disallowedApi.length}).`
    : 'No server secrets or admin APIs referenced.');
  disallowedApi.forEach((re) => flags.push(`Server secret: ${re}`));

  const critical = (!manifest.id || !manifest.name || !manifest.version || !manifest.entry)
    || dangerous.length > 0 || disallowedApi.length > 0;
  const pass = !critical && network.length === 0 && exfil.length === 0 && obfuscation.length === 0;

  return {
    pass,
    verdict: pass ? 'approved' : 'rejected',
    checks,
    flags,
    manifest: { id: manifest.id || null, name: manifest.name || '', version: manifest.version || '', entry: manifest.entry || '' },
  };
}

/** Vets an uploaded ZIP's raw bytes. */
export function vetUploadedZip(bytes) {
  let entries;
  try {
    entries = Object.entries(unzipSync(new Uint8Array(bytes)));
  } catch {
    return {
      pass: false, verdict: 'rejected',
      checks: [{ name: 'archive', ok: false, detail: 'The upload is not a readable ZIP file.' }],
      flags: ['Unreadable archive'], manifest: null,
    };
  }
  const report = vetFiles(entries);
  report.checks.unshift({ name: 'archive', ok: true, detail: `Read ${entries.length} file(s) from the ZIP.` });
  return report;
}

/** Resolves a repository URL to a ZIP the vetter can scan, or null when it must stay manual. */
export async function repositoryZip(url) {
  const trimmed = String(url || '').trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  const github = /^https:\/\/github\.com\/([^/]+)\/([^/]+)/i.exec(trimmed);
  try {
    if (github) {
      const branch = (trimmed.split('/tree/')[1] || '').split('/')[0] || 'main';
      const response = await fetch(`https://codeload.github.com/${github[1]}/${github[2]}/zip/refs/heads/${branch}`);
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    }
    if (/\.zip(\?.*)?$/i.test(trimmed)) {
      const response = await fetch(trimmed);
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    }
  } catch {
    return null;
  }
  return null;
}



// Read-only: what [rwp_latest_release] prints for the real repository, end to end and without a browser.
//
// It mirrors the shortcode's new first source — `GET /api/plugins/rwp-saas-installer/latest-release`, whose
// body is built here the same way (`fetchGithubReleases` → `latestReleaseFrom` → `publicRelease`) — and then
// draws the card from that answer, so a missing title or stale version shows up here rather than on a page.
// The token is read from .env.local and never printed.
import { existsSync, readFileSync } from 'node:fs';
import { fetchGithubReleases, latestReleaseFrom } from '../server/githubReleases.mjs';
import { publicRelease } from '../server/updateCenter.mjs';

const readEnv = (file) => {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
};

const env = { ...readEnv('.env.live.local'), ...readEnv('.env.local') };
const repo = env.RWP_RELEASE_REPO || 'arash12javadi/react-wp-plugin-edition';
const token = env.RWP_RELEASE_TOKEN || env.GITHUB_TOKEN || '';
const channel = 'stable';

// ── the route ───────────────────────────────────────────────────────────────────────────────────────
const list = await fetchGithubReleases({ repo, token });
console.log(`repository: ${list.repo} (${list.source}, ${list.releases.length} rows, authenticated: ${list.authenticated})`);
const newest = latestReleaseFrom(list.releases, { channel });
if (!newest) {
  console.log(`GET latest-release → 404: ${list.repo} has no published release yet.`);
  process.exit(0);
}

const answer = {
  success: true,
  ok: true,
  channel,
  repository: list.repo,
  source: list.source,
  authenticated: list.authenticated,
  release: publicRelease(newest),
};
console.log('\nGET /api/plugins/rwp-saas-installer/latest-release → 200');
console.log(JSON.stringify({ ...answer, release: { ...answer.release, notes: `${answer.release.notes.length} lines` } }, null, 2));

// ── the route, called in process ───────────────────────────────────────────────────────────────────
// The plugin module is imported the way the server imports it, with the *environment* the route resolves
// through (`githubUpdateSourceFrom`), so what runs here is the real handler: routing, credential resolution,
// the channel rule and the shape of the answer. A site configured on Settings → Integrations holds the same
// two values in a row instead.
process.env.RWP_RELEASE_REPO = process.env.RWP_RELEASE_REPO || repo;
process.env.RWP_RELEASE_TOKEN = process.env.RWP_RELEASE_TOKEN || token;

const { default: plugin } = await import('../plugins/rwp-saas-installer/server.mjs');
const route = plugin.routes['GET latest-release'];
const call = (query) => route({
  query,
  headers: {},
  supabase: { url: env.VITE_SUPABASE_URL || '', publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY || '' },
});

const answered = await call({ channel });
const brief = (body) => ({ ...body, release: body?.release ? { ...body.release, notes: `${(body.release.notes || []).length} lines` } : null });
console.log(`\nroute ${route ? 'found' : 'MISSING'} → GET latest-release answered ${answered.status}`);
console.log(JSON.stringify(brief(answered.body), null, 2));

const beta = await call({ channel: 'beta' });
console.log(`\nchannel=beta answered ${beta.status}: ${beta.body?.release?.tag || beta.body?.error}`);

// The installer card's own fallback: with no `RWP_RELEASE_*` in the environment, the template on
// Settings → Integrations → RWP SaaS Installer is what the route reads, through `GITHUB_ACCESS_TOKEN`.
delete process.env.RWP_RELEASE_REPO;
delete process.env.RWP_RELEASE_TOKEN;
process.env.GITHUB_TEMPLATE_REPO = repo;
process.env.GITHUB_ACCESS_TOKEN = token;
const viaInstaller = await call({ channel });
console.log(`\ninstaller fallback answered ${viaInstaller.status}: ${viaInstaller.body?.release?.tag || viaInstaller.body?.error}`);

// ── the card ────────────────────────────────────────────────────────────────────────────────────────
// `releaseFromLive` + `titleOf` in plugins/rwp-saas-installer/LatestRelease.tsx, mirrored.
const live = answer.release;
const version = live.version.replace(/^v/i, '');
const tag = live.tag || (version ? `v${version}` : '');
const title = live.title && live.title.toLowerCase() !== tag.toLowerCase() ? live.title : '';
const date = Number.isFinite(Date.parse(live.released)) ? new Date(Date.parse(live.released)).toLocaleDateString() : '';
const draw = (showVersion, showTitle, showNotes) => {
  const lines = [];
  if (showTitle && title) lines.push(`  <p class="title">${title}</p>`);
  if (showVersion) lines.push(`  <p class="version">${tag}${date ? ` · released ${date}` : ''}</p>`);
  if (showNotes && live.notes.length) lines.push(...live.notes.slice(0, 5).map((note) => `  <li>${note}</li>`));
  return lines.length ? lines.join('\n') : '  (heading only: every part was switched off)';
};

console.log('\n[rwp_latest_release]');
console.log(draw(true, true, true));
console.log('\n[rwp_latest_release version="no" notes="no"]');
console.log(draw(false, true, false));
console.log('\n[rwp_latest_release title="no" notes="no"]');
console.log(draw(true, false, false));
console.log('\n[rwp_latest_release version="no" title="no" notes="no"]');
console.log(draw(false, false, false));

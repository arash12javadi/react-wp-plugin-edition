/**
 * Read-only: can the *server* see the GitHub settings the Integrations hub saves?
 *
 * The card is drawn from `system_settings.github_config` through the signed-in administrator's own
 * session, so a card that looks configured proves nothing about the half that pushes a commit — that
 * one reads the row through `readIntegrationRows` (`server/integrationSettings.mjs`) and takes the
 * credential from `githubTokenFrom` (`server/integrationConfig.mjs`). Those are the two functions this
 * script calls, on the row as it is stored, so "the server picks the token up" is decided here rather
 * than by a release check that answers 404 for a different reason.
 *
 * `--live` adds the one outbound call the update centre makes — `fetchGithubReleases` on the *stored*
 * repository with the *stored* token — so a private repository answering 404 is told apart from a
 * release check that fails for another reason. Read-only on GitHub's side: a list request.
 *
 * `--whoami` asks GitHub who the stored token belongs to (`GET https://api.github.com/user`), which is
 * how an expired or revoked token is told apart from a repository the token cannot see: GitHub answers
 * 401 for the first and 404 for the second, and both end up as "the release check failed".
 *
 * Nothing is written and no token is printed: presence, repository and branch only.
 *
 * Usage: node state/verify-github-integration.mjs [--live] [--whoami]
 */
import { readFileSync } from 'node:fs';

// `.env.local` first, the same order `server.mjs` uses, so this reads the connection string the server
// would read. Values already in the environment win, as they do for `server/env.mjs`.
const env = { ...process.env };
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const { readIntegrationRows } = await import('../server/integrationSettings.mjs');
const { GITHUB_CONFIG_KEY, githubStatusFrom, githubTokenFrom } = await import('../server/integrationConfig.mjs');

const rows = await readIntegrationRows([GITHUB_CONFIG_KEY], { env });
console.log('readable:', rows.readable, '| source:', rows.source || '(none)', '| error:', rows.error || '(none)');

const value = rows.settings?.[GITHUB_CONFIG_KEY];
if (!value) {
  console.log(`${GITHUB_CONFIG_KEY}: no row — nothing for a commit or a release check to use.`);
  process.exit(1);
}

const token = githubTokenFrom(value);
const status = githubStatusFrom(value);
console.log('token the server would send:', token ? `yes (${token.length} characters, ${token.slice(0, 4)}…)` : 'no');
console.log('githubStatusFrom:', JSON.stringify(status));
console.log('branch:', JSON.stringify(value.branch ?? ''), '| account:', JSON.stringify(status.username));

if (process.argv.includes('--whoami') && token) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }).catch((error) => error);
  if (response instanceof Error) {
    console.log('--whoami failed:', response.message);
  } else if (response.ok) {
    const who = await response.json();
    console.log(`--whoami: the stored token belongs to ${JSON.stringify(who.login)} (HTTP ${response.status}).`);
  } else {
    const body = await response.text();
    console.log(`--whoami: GitHub refused the stored token (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }
}

if (process.argv.includes('--live')) {
  const { fetchGithubReleases, latestReleaseFrom } = await import('../server/githubReleases.mjs');
  if (!status.repository) {
    console.log('--live skipped: no repository is saved on the row.');
  } else if (!token) {
    console.log('--live skipped: the row carries no token, so a private repository would answer 404.');
  } else {
    try {
      const releases = await fetchGithubReleases({ repo: status.repository, token });
      const latest = latestReleaseFrom(releases, { channel: 'stable' });
      console.log(`--live: ${JSON.stringify(status.repository)} answered with ${releases.length} release(s)`,
        latest ? `| newest stable: ${latest.tag} (${latest.version})` : '| no release on the stable channel yet');
    } catch (error) {
      console.error('--live failed:', error instanceof Error ? `${error.message} (HTTP ${error.status ?? '?'})` : error);
      process.exit(1);
    }
  }
}

process.exit(token && status.configured ? 0 : 1);

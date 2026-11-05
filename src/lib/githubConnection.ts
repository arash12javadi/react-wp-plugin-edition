/**
 * The GitHub connection this installation publishes with: the personal access token an administrator
 * pasted, the account it belongs to, and the repository a theme or plugin is committed to.
 *
 * Core's, not a plugin's: the server commits plugin uploads and uninstalls with this row
 * (`server/pluginGitPush.mjs`, `server/pluginGitUninstall.mjs`) on every edition, so the card that
 * writes it must exist on every edition too. Its server-side spelling is `server/integrationConfig.mjs`;
 * keep the two in step. Free of imports on purpose.
 */

/**
 * The GitHub scope this project needs: `repo` is what pushing a plugin or theme back to a repository
 * takes, private repositories included.
 *
 * Nothing grants it here: the token is minted on GitHub's own "new token" page, which this list
 * pre-ticks, and pasted into the card. It is also the sentence the card shows, so it says what the
 * token is for rather than how it is obtained.
 */
export const githubScopes = ['repo'] as const;

/** GitHub's classic-token page, pre-ticked with `githubScopes` and named after this project. */
export const githubTokenPageUrl =
  `https://github.com/settings/tokens/new?description=${encodeURIComponent('react-wp')}&scopes=${githubScopes.join(',')}`;

/** GitHub's fine-grained token page, for an account that prefers per-repository permissions. */
export const githubFineGrainedTokenPageUrl = 'https://github.com/settings/personal-access-tokens/new';

/** The REST API the card validates a token against, with the version `server/pluginGitPush.mjs` pins. */
export const githubApiBase = 'https://api.github.com';
export const githubApiVersion = '2022-11-28';

/** The `system_settings` row the GitHub card reads and writes. In step with `GITHUB_CONFIG_KEY`. */
export const githubConfigKey = 'github_config';

/** One repository the token can push to, as the callback window passes it over. */
export interface GithubRepository {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  updated_at: string;
}

/**
 * `system_settings.github_config` — the token an administrator pasted, the account it belongs to, and
 * the repository this site publishes to.
 *
 * `token` is a GitHub credential, so no screen renders the value: the field is here because the browser
 * is the only client that may write this row (the server's publishable-key connection is refused by
 * RLS), not because it is meant to be displayed. Everything else in the row is what GitHub answered
 * when the card validated the token, kept so the card can render itself without asking again.
 */
export interface GithubIntegrationConfig {
  connected: boolean;
  provider: string;
  /**
   * The personal access token. A classic token carries the `repo` scope; a fine-grained one carries
   * Contents: Read and write on the repository below. It is written here, read by the server
   * (`server/pluginGitPush.mjs`) and never echoed back to a browser.
   */
  token: string;
  token_type: string;
  /** What GitHub reported in `x-oauth-scopes`. Empty for fine-grained tokens, which is not a fault. */
  scopes: string[];
  username: string;
  name: string;
  avatar_url: string;
  profile_url: string;
  repository: string;
  branch: string;
  repositories: GithubRepository[];
  connected_at: string;
}

/** A GitHub account, as `GET /user` describes it. Only the fields the card renders. */
export interface GithubAccount {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
}

/** What validating a token answers: the account it belongs to, and everything that came with it. */
export interface GithubConnection {
  account: GithubAccount;
  /** GitHub's `x-oauth-scopes` header; empty for a fine-grained token, which is not a fault. */
  scopes: string[];
  /** The repositories the token may push to, most recently pushed first. */
  repositories: GithubRepository[];
}

/** A disconnected configuration, with the same keys a saved one has — so the card never reads undefined. */
export const emptyGithubConfig = (): GithubIntegrationConfig => ({
  connected: false,
  provider: 'github',
  token: '',
  token_type: '',
  scopes: [],
  username: '',
  name: '',
  avatar_url: '',
  profile_url: '',
  repository: '',
  branch: '',
  repositories: [],
  connected_at: '',
});

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One stored repository, tolerating a row written by an older build. */
const asRepository = (value: unknown): GithubRepository | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const fullName = asString(row.full_name) || asString(row.name);
  if (!fullName) return null;
  return {
    full_name: fullName,
    name: asString(row.name) || fullName.split('/')[1] || fullName,
    // `owner` is a string in a stored row and an object in GitHub's own payload (`/user/repos`), so
    // both shapes are read here rather than in each caller.
    owner: asString(row.owner) || asString((row.owner as { login?: unknown } | null)?.login) || fullName.split('/')[0],
    private: row.private === true,
    default_branch: asString(row.default_branch) || 'main',
    html_url: asString(row.html_url) || `https://github.com/${fullName}`,
    updated_at: asString(row.updated_at),
  };
};

/**
 * Turns whatever is in `system_settings.github_config` into a full configuration. Every field is
 * defaulted, because the value arrives from a browser that may be running a slightly older build:
 * `access_token`/`scope` are the OAuth-era names, read so a site that connected through the old
 * handshake keeps showing — and keeps pushing with — the token it already had.
 */
export const githubConfigFrom = (value: unknown): GithubIntegrationConfig => {
  const base = emptyGithubConfig();
  if (!value || typeof value !== 'object') return base;
  const row = value as Record<string, unknown>;
  const repositories = Array.isArray(row.repositories)
    ? row.repositories.map(asRepository).filter((entry): entry is GithubRepository => entry !== null)
    : [];
  const username = asString(row.username);
  const token = asString(row.token) || asString(row.pat) || asString(row.access_token);
  return {
    ...base,
    connected: Boolean(token && username),
    provider: asString(row.provider) || 'github',
    token,
    token_type: asString(row.token_type),
    scopes: Array.isArray(row.scopes)
      ? row.scopes.map(asString).filter(Boolean)
      : asString(row.scope).split(/[\s,]+/).filter(Boolean),
    username,
    name: asString(row.name),
    avatar_url: asString(row.avatar_url),
    profile_url: asString(row.profile_url) || (username ? `https://github.com/${username}` : ''),
    repository: asString(row.repository),
    branch: asString(row.branch),
    repositories,
    connected_at: asString(row.connected_at),
  };
};

/** Connected means a token *and* the account it belongs to: either alone is not a usable connection. */
export const isGithubConnected = (config: GithubIntegrationConfig): boolean =>
  config.connected && Boolean(config.token) && Boolean(config.username);

// -- GitHub: validating a personal access token ---------------------------------------------------

/**
 * One GitHub REST call, made by the browser that holds the token.
 *
 * `api.github.com` answers `Access-Control-Allow-Origin: *`, so this needs no route on this project's
 * server and the token travels nowhere but to GitHub itself. The response's headers matter as much as
 * its body — `x-oauth-scopes` is where a classic token's scopes are reported — so both are returned.
 * GitHub's own error sentence is preferred over the HTTP status, because it names the problem.
 */
const githubRequest = async (
  path: string,
  token: string,
): Promise<{ data: unknown; scopes: string[] }> => {
  let response: Response;
  try {
    response = await fetch(`${githubApiBase}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': githubApiVersion,
      },
    });
  } catch {
    throw new Error('GitHub could not be reached from this browser. Check the connection, then try again.');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = asString((data as { message?: unknown } | null)?.message) || `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new Error(`GitHub rejected that token (${detail}). Check that it was copied whole, and that it has not expired.`);
    }
    throw new Error(`GitHub answered "${detail}" (HTTP ${response.status}).`);
  }
  return {
    data,
    // Reported for classic tokens, absent for fine-grained ones: an empty list is normal, not a fault.
    scopes: String(response.headers.get('x-oauth-scopes') || '')
      .split(/[\s,]+/)
      .filter(Boolean),
  };
};

/**
 * The repositories the token may push to, most recently pushed first — the list the card's picker
 * shows, and the only question the card asks GitHub about the token.
 *
 * One page of the maximum size, not a walk: `/user/repos` orders by most recent push, so the repository
 * an administrator wants is at the top, and a picker of a hundred names is already more than anyone
 * scrolls.
 */
const githubRepositories = async (token: string): Promise<GithubRepository[]> => {
  const { data } = await githubRequest(
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    token,
  );
  if (!Array.isArray(data)) return [];
  return data.map(asRepository).filter((entry): entry is GithubRepository => entry !== null);
};

/**
 * Proves a pasted token against GitHub and gathers what the card needs to render: the account it
 * belongs to, its scopes, and the repositories it can see.
 *
 * Throws with a sentence worth showing the administrator — the card puts it in its error slot
 * unedited — and nothing is stored until this resolves.
 */
export const validateGithubToken = async (token: string): Promise<GithubConnection> => {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new Error('Paste a personal access token first.');
  const { data, scopes } = await githubRequest('/user', trimmed);
  const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const login = asString(row.login);
  if (!login) {
    throw new Error('GitHub answered without an account name, so that token cannot be used here. Create a new one and paste it again.');
  }
  return {
    account: {
      login,
      name: asString(row.name),
      avatar_url: asString(row.avatar_url),
      html_url: asString(row.html_url) || `https://github.com/${login}`,
    },
    scopes,
    repositories: await githubRepositories(trimmed),
  };
};

/**
 * The `github_config` row a validated token deserves.
 *
 * `previous` is the row already stored: its repository and branch are carried over when the new token
 * can still see that repository, so renewing a token costs nothing. A token for another account cannot
 * see it, and the target is then cleared rather than left pointing at a repository this token cannot
 * push to.
 */
export const githubConfigFor = (
  connection: GithubConnection,
  options: { token: string; previous?: GithubIntegrationConfig; now?: Date },
): GithubIntegrationConfig => {
  const { token, previous, now = new Date() } = options;
  const wanted = asString(previous?.repository);
  const repository = connection.repositories.some((entry) => entry.full_name === wanted) ? wanted : '';
  const branch = repository
    ? asString(previous?.branch) ||
      connection.repositories.find((entry) => entry.full_name === repository)?.default_branch ||
      'main'
    : '';
  return {
    ...emptyGithubConfig(),
    connected: true,
    token: String(token || '').trim(),
    token_type: 'bearer',
    scopes: connection.scopes,
    username: connection.account.login,
    name: connection.account.name,
    avatar_url: connection.account.avatar_url,
    profile_url: connection.account.html_url,
    repository,
    branch,
    repositories: connection.repositories,
    connected_at: now.toISOString(),
  };
};

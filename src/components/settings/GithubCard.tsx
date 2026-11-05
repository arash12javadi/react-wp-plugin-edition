/**
 * Settings → Integrations → GitHub: the personal access token this site publishes with, the account
 * it belongs to and the repository a theme or plugin is committed to.
 *
 * Core's card, on every edition. It was `rwp-saas-installer`'s, and that plugin is development-edition
 * only, so a client's site never had a place to connect GitHub even though the server commits plugin
 * uploads and uninstalls with this row (`server/pluginGitPush.mjs`). `IntegrationsHub` registers it
 * as a `platformOwnerOnly` card; the row is read and written through the signed-in owner's own
 * session, the only client RLS lets near `system_settings`.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getSystemSetting, setSystemSetting } from '../../lib/db';
import type { IntegrationCardProps } from '../../core/integrations';
import {
  emptyGithubConfig,
  githubConfigFor,
  githubConfigFrom,
  githubConfigKey,
  githubFineGrainedTokenPageUrl,
  githubScopes,
  githubTokenPageUrl,
  isGithubConnected,
  validateGithubToken,
  type GithubIntegrationConfig,
} from '../../lib/githubConnection';
import { css } from './githubCardStyles';

const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

/** A stored timestamp in the operator's own words, or nothing at all when the value is not a date. */
const connectedSince = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

/**
 * One `system_settings` row, loaded once and written back on demand.
 *
 * The same shape the hub's built-in cards use: the reading, the "saved" copy a save button compares
 * against, and the busy/error/notice state live here once rather than in each card, so this card
 * behaves like the ones it sits beside. `normalize` turns whatever the row holds into a full
 * configuration, so a card never has to test for a missing field.
 */
function useStoredConfig<T>(key: string, normalize: (value: unknown) => T) {
  const [config, setConfig] = useState<T>(() => normalize(null));
  const [saved, setSaved] = useState<T>(() => normalize(null));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    try {
      const next = normalize(await getSystemSetting<unknown>(key));
      setConfig(next);
      setSaved(next);
    } catch (loadError: unknown) {
      setError(messageOf(loadError, 'The saved configuration could not be read. Sign in again as the site administrator and reload this screen.'));
    } finally {
      setLoading(false);
    }
  }, [key, normalize]);

  useEffect(() => { void reload(); }, [reload]);

  /** Writes the row, keeps the local state in step with it, and reports what happened. */
  const save = useCallback(async (next: T, message: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!(await setSystemSetting(key, next))) {
        throw new Error('This browser is not allowed to store the configuration. Sign in again as the site administrator and retry.');
      }
      setConfig(next);
      setSaved(next);
      setNotice(message);
      return true;
    } catch (saveError: unknown) {
      setError(messageOf(saveError, 'The configuration could not be saved.'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [key]);

  return { config, setConfig, saved, loading, busy, error, setError, notice, setNotice, save, reload };
}

/** The inline error/notice pair each card shows above its fields. */
function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error ? <p style={css.error} role="alert">{error}</p> : null}
      {notice ? <p style={css.success} role="status">{notice}</p> : null}
    </>
  );
}

/**
 * A secret field's draft: `null` until the owner types or clears it.
 *
 * A saved secret is never written back into the DOM. The card still holds the value — it has to,
 * because the browser is the only client allowed to write `system_settings` and a save rewrites the
 * whole row — but it is not rendered into an input, so a screenshot or a shared screen shows nothing.
 * Typing replaces the value, and "Remove" empties it.
 */
function useSecret(stored: string) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    /** The value the input shows: empty, so a saved secret is never on screen. */
    input: draft ?? '',
    saved: Boolean(stored),
    /** True once something different from what is stored has been typed. */
    dirty: draft !== null && draft.trim() !== stored,
    /** True when "Remove" was pressed and the row would be saved with the field empty. */
    clearing: draft === '',
    onChange: (value: string) => setDraft(value),
    clear: () => setDraft(''),
    keep: () => setDraft(null),
    /** What a save writes: the typed value, the stored one, or '' after Remove. */
    resolve: () => (draft === null ? stored : draft.trim()),
    placeholder: stored ? 'A value is saved — type here to replace it' : 'Not saved yet',
  };
}

/** One labelled field, with the small print that says where the value comes from. */
function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
      <span style={css.fieldLabel}>{label}</span>
      {children}
      {help ? <span style={css.fieldHelp}>{help}</span> : null}
    </label>
  );
}

/**
 * GitHub: the personal access token this site publishes with, the account it belongs to, and the
 * repository a theme or plugin is committed to.
 *
 * There is no OAuth app and no handshake to finish here: the token is created on GitHub and pasted in.
 * That makes this the one credential the browser proves itself — `validateGithubToken` (`./config`) asks
 * `api.github.com` for the account and the repositories the token can see, and this screen writes the
 * row, which the browser is the only client RLS lets near `system_settings`. The server only ever reads
 * it (`server/pluginGitPush.mjs`), so proving the token spends nothing of the site's and no callback URL
 * has to exist on that server.
 *
 * The change is not only about the form: a token belongs to the account that created it, so pushes stop
 * sharing one rate limit across every user of the site — which an OAuth app's token does.
 */
export function GithubCard({ status, refresh }: IntegrationCardProps) {
  const { config, setConfig, saved, loading, busy, error, setError, notice, setNotice, save } =
    useStoredConfig(githubConfigKey, githubConfigFrom);
  /** The pasted token, held apart from `config` until GitHub has accepted it. */
  const [token, setToken] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const connected = isGithubConnected(config);
  // The pill's answer is the hub's, read a moment apart from this card's own — so a token saved here
  // counts immediately and the card works without waiting for a reload.
  const configured = connected || status.configured;
  const dirty = config.repository !== saved.repository || config.branch !== saved.branch;

  /**
   * Proves the pasted token against GitHub, then stores the row that answers with it.
   *
   * Nothing is written until GitHub has answered, so a typo cannot leave a token behind that the server
   * would then try to push with. `githubConfigFor` builds the row, keeping the repository already chosen
   * when the new token can still see it — renewing a token costs only the paste.
   */
  const saveToken = async (): Promise<void> => {
    const pasted = token.trim();
    if (!pasted) {
      setError('Paste a personal access token first.');
      return;
    }
    try {
      const connection = await validateGithubToken(pasted);
      const next = githubConfigFor(connection, { token: pasted, previous: saved });
      const stored = await save(next, next.repository
        ? `GitHub connected as @${next.username}. This site still pushes to ${next.repository} on ${next.branch}.`
        : `GitHub connected as @${next.username}. Choose the repository this site should push to.`);
      if (!stored) return;
      setToken('');
      refresh();
    } catch (validateError: unknown) {
      setError(messageOf(validateError, 'The token could not be saved.'));
    }
  };

  /**
   * Forgets the token. The stored row is emptied rather than deleted, so the next read still finds a
   * configuration of the shape the card expects, and the token stops existing in one round trip.
   */
  const disconnect = async (): Promise<void> => {
    const stored = await save(
      emptyGithubConfig(),
      'GitHub disconnected. The personal access token has been removed from this site.',
    );
    if (!stored) return;
    setConfirmingDisconnect(false);
    refresh();
  };

  /**
   * Picking a repository carries its default branch with it — the one GitHub itself would use — since
   * the alternative is every owner typing `main` while the repository's default is `gh-pages`.
   */
  const chooseRepository = (fullName: string): void => {
    const chosen = config.repositories.find((repository) => repository.full_name === fullName);
    setConfig({ ...config, repository: fullName, branch: chosen?.default_branch || config.branch });
  };

  /** Saves the push target on its own, so choosing a repository does not mean re-pasting the token. */
  const saveTarget = async (): Promise<void> => {
    const next: GithubIntegrationConfig = {
      ...config,
      repository: config.repository.trim(),
      branch: config.branch.trim() || 'main',
    };
    const stored = await save(next, next.repository
      ? `Saved. This site now pushes to ${next.repository} on ${next.branch}.`
      : 'Saved without a repository. Choose one before anything is published to GitHub.');
    if (stored) refresh();
  };

  if (loading) {
    return <p style={css.targetNote} role="status">Reading the saved connection…</p>;
  }

  const repositoryOptions = config.repositories;

  return (
    <div style={css.cardBody}>
      <Feedback error={error} notice={notice} />

      <div style={css.target}>
        <h4 style={css.targetTitle}>{configured ? 'Personal access token' : 'Connect with a personal access token'}</h4>
        <p style={css.targetNote}>
          Create a token under <strong>GitHub → Settings → Developer settings → Personal access tokens</strong> and
          paste it here. A classic token needs the <code style={css.code}>{githubScopes.join(' and ')}</code> scope,
          which is what writing to a repository — private ones included — takes; a fine-grained token needs{' '}
          <strong>Contents: Read and write</strong> on the repository this site publishes to, plus the{' '}
          <strong>Metadata</strong> read access GitHub grants with it.
        </p>
        <div style={css.actions}>
          <a style={css.cardLink} href={githubTokenPageUrl} target="_blank" rel="noreferrer">
            Create a classic token
          </a>
          <a style={css.cardLink} href={githubFineGrainedTokenPageUrl} target="_blank" rel="noreferrer">
            Create a fine-grained token
          </a>
        </div>
        <div style={css.fields}>
          <Field
            label="Personal access token"
            help={token.trim()
              ? 'Saving sends it to GitHub once, to read the account it belongs to, and then stores it here. GitHub never shows the value again, so this is the last chance to copy it.'
              : 'GitHub displays the value once, when the token is created, so copy it before leaving that page.'}
          >
            <input
              type="password"
              style={css.cardInput}
              value={token}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={configured ? 'github_pat_… or ghp_… (a token is already saved)' : 'github_pat_… or ghp_…'}
              onChange={(event) => setToken(event.target.value)}
              disabled={busy}
            />
          </Field>
        </div>
        <div style={css.actions}>
          <button
            type="button"
            style={{ ...css.cardPrimary, ...(busy || !token.trim() ? css.disabled : {}) }}
            onClick={() => void saveToken()}
            disabled={busy || !token.trim()}
          >
            {busy ? 'Checking with GitHub…' : configured ? 'Replace token' : 'Save token'}
          </button>
          {configured ? (
            <span style={css.hint}>
              Saving a new token keeps the push target{config.repository ? ` (${config.repository})` : ''} unless the
              token cannot see it.
            </span>
          ) : null}
        </div>
      </div>

      {!connected ? (
        <p style={css.setupLead}>
          A token is all this needs: it is stored here, used by the server only when it commits a theme or plugin,
          and can be deleted on GitHub at any time to stop that.
        </p>
      ) : null}

      {connected ? (
        <>
          <div style={css.account}>
            {config.avatar_url ? (
              <img style={css.avatar} src={config.avatar_url} alt="" width={40} height={40} />
            ) : null}
            <div style={css.accountText}>
              <p style={css.accountName}>{config.name || `@${config.username}`}</p>
              <p style={css.accountMeta}>
                <a href={config.profile_url || `https://github.com/${config.username}`} target="_blank" rel="noreferrer">
                  @{config.username}
                </a>
                {config.connected_at ? ` · token saved ${connectedSince(config.connected_at)}` : ''}
              </p>
              {config.scopes.length > 0 ? (
                <p style={css.scopes}>
                  {config.scopes.map((scope) => <code key={scope} style={css.scopeChip}>{scope}</code>)}
                </p>
              ) : (
                <p style={css.accountMeta}>
                  GitHub reported no scopes for this token, which is normal for a fine-grained one: its permissions
                  live on the token itself rather than in scopes.
                </p>
              )}
            </div>
          </div>

          <div style={css.target}>
            <h4 style={css.targetTitle}>Push target</h4>
            <p style={css.targetNote}>
              Where this site publishes themes and plugins. Commits are made on your behalf with the personal access
              token stored here, so this screen can be closed once the target is saved.
            </p>
            <div style={css.fields}>
              <Field label="Repository">
                {repositoryOptions.length > 0 ? (
                  <select
                    style={css.select}
                    value={config.repository}
                    onChange={(event) => chooseRepository(event.target.value)}
                    disabled={busy}
                  >
                    <option value="">— none selected —</option>
                    {repositoryOptions.map((repository) => (
                      <option key={repository.full_name} value={repository.full_name}>
                        {repository.full_name}{repository.private ? ' (private)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    style={css.cardInput}
                    value={config.repository}
                    placeholder="owner/repository"
                    onChange={(event) => setConfig({ ...config, repository: event.target.value })}
                    disabled={busy}
                  />
                )}
              </Field>
              <Field label="Branch">
                <input
                  type="text"
                  style={css.cardInput}
                  value={config.branch}
                  placeholder="main"
                  onChange={(event) => setConfig({ ...config, branch: event.target.value })}
                  disabled={busy}
                />
              </Field>
            </div>
            <div style={css.actions}>
              <button
                type="button"
                style={{ ...css.cardPrimary, ...(busy || !dirty ? css.disabled : {}) }}
                onClick={() => void saveTarget()}
                disabled={busy || !dirty}
              >
                Save target
              </button>
              {dirty ? (
                <button type="button" style={css.cardSecondary} onClick={() => setConfig(saved)} disabled={busy}>
                  Undo changes
                </button>
              ) : null}
            </div>
            {repositoryOptions.length === 0 ? (
              <p style={css.setupNote}>
                This token returned no repositories{config.username ? ` for @${config.username}` : ''}. Paste a token
                that can see them, or type <code style={css.code}>owner/repository</code> by hand.
              </p>
            ) : null}
          </div>

          <div style={css.actions}>
            {confirmingDisconnect ? (
              <p style={css.confirmNote}>Disconnect GitHub and delete the stored token?</p>
            ) : null}
            <button
              type="button"
              style={confirmingDisconnect ? css.cardDanger : css.cardSecondary}
              onClick={() => {
                if (confirmingDisconnect) void disconnect();
                else setConfirmingDisconnect(true);
              }}
              disabled={busy}
            >
              {confirmingDisconnect ? 'Yes, disconnect' : 'Disconnect'}
            </button>
            {confirmingDisconnect ? (
              <button type="button" style={css.cardSecondary} onClick={() => setConfirmingDisconnect(false)} disabled={busy}>
                Cancel
              </button>
            ) : (
              <span style={css.hint}>
                Deleting the token on GitHub too is optional; this site simply stops using it.
              </span>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

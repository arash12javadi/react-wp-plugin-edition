import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { client, getSystemSetting, setSystemSetting } from '../../lib/db';
import { fetchProfile } from '../../lib/profiles';
import { getUserRole, hasCapability, isPlatformOwner, type UserRole } from '../../lib/roles';
import { useIntegrationsRegistry, type RwpIntegrationCard } from '../../core/integrations';
import {
  aiCompatibleBaseUrls,
  aiConfigFrom,
  aiConfigKey,
  aiProviderLabels,
  aiProviderModels,
  aiProviders,
  emailConfigFrom,
  emailConfigKey,
  emailProviderLabels,
  emailProviders,
  fetchIntegrationStatus,
  isAiConfigured,
  mediaStorageConfigFrom,
  mediaStorageConfigKey,
  mediaStorageProviderLabels,
  mediaStorageProviders,
  type AiProvider,
  type EmailProvider,
  type IntegrationStatus,
  type MediaStorageProvider,
} from '../../lib/integrations';
import { GithubCard } from './GithubCard';
import { DeploymentCard } from './DeploymentCard';
import { fetchDeploymentOverview } from '../../lib/gitDeployment';
import {
  githubConfigFrom,
  githubConfigKey,
  isGithubConnected,
} from '../../lib/githubConnection';
import styles from './IntegrationsHub.module.css';

export { styles as hubStyles };

/**
 * GitHub is core's card, not a plugin's: the server commits plugin uploads and uninstalls with this
 * row on every edition, and the plugin that used to register it (`rwp-saas-installer`) never ships to
 * a client's site. Built here rather than through the registry so it exists before any plugin loads.
 */
const githubCard: RwpIntegrationCard = {
  id: 'github',
  title: 'GitHub',
  icon: '🐙',
  description: 'Publishes themes and plugins to a repository, and reads that repository’s release tags as this site’s update source.',
  order: 10,
  platformOwnerOnly: true,
  describe: async () => {
    const stored = githubConfigFrom(await getSystemSetting<unknown>(githubConfigKey));
    if (!isGithubConnected(stored)) return { configured: false, label: 'Not connected' };
    return {
      configured: true,
      label: stored.repository ? `@${stored.username} → ${stored.repository}` : `@${stored.username}`,
    };
  },
  renderComponent: GithubCard,
};

/**
 * GitHub & Vercel: the one-time connection of this site to its own repository and Vercel project, and the
 * Git-based core update. Core's card, platform owner only; its state lives behind authorised routes
 * (`server/deploymentRoutes.mjs`), so the pill asks that route rather than reading a row.
 */
const deploymentCard: RwpIntegrationCard = {
  id: 'github-vercel',
  title: 'GitHub & Vercel',
  icon: '🚀',
  description: 'Connects this site to its own GitHub repository and Vercel project. Plugin installs and core updates are committed there, and Vercel deploys them.',
  order: 11,
  platformOwnerOnly: true,
  describe: async () => {
    try {
      const { connection } = await fetchDeploymentOverview();
      return connection.connected
        ? { configured: true, label: `${connection.repository} → ${connection.project?.name || 'Vercel'}` }
        : { configured: false, label: 'Not connected' };
    } catch {
      return { configured: false, label: 'Not connected' };
    }
  },
  renderComponent: DeploymentCard,
};

/** The one place a caught value becomes a sentence. */
export const messageOf = (value: unknown, fallback: string): string =>
  value instanceof Error && value.message ? value.message : fallback;

/** The state pill in a card's heading: the same three classes every card — built-in or plugin — uses. */
export function Pill({ tone = 'quiet', children }: { tone?: 'on' | 'off' | 'quiet'; children: ReactNode }) {
  const className = tone === 'on' ? styles.pillOn : tone === 'off' ? styles.pillOff : styles.pillQuiet;
  return <span className={className}>{children}</span>;
}

/** A card: heading, one-line description, a state pill, and whatever the card renders below. */
function Card({ id, title, meta, pill, children }: {
  id: string;
  title: ReactNode;
  meta: string;
  pill: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.card} aria-labelledby={id}>
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle} id={id}>{title}</h3>
          <p className={styles.cardMeta}>{meta}</p>
        </div>
        {pill}
      </div>
      {children}
    </section>
  );
}

/** One labelled field, with the small print that says where the value comes from. */
export function Field({ label, help, className, children }: {
  label: string;
  help?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={className ? `${styles.field} ${className}` : styles.field}>
      <span>{label}</span>
      {children}
      {help ? <span className={styles.fieldHelp}>{help}</span> : null}
    </label>
  );
}

/**
 * The signed-in person's role, for the plugin cards that declare a capability or ask for the platform
 * owner.
 *
 * The built-in cards are all `manage_options`, which is what the Settings screen already required, so
 * no built-in form asks who is looking. Two things here do: a plugin's card, and the sentence the hub
 * shows in place of the platform owner's cards when this viewer is not that owner — a hidden card with
 * no explanation reads as a lost setting.
 */
function useViewerRole(): UserRole | null {
  const [role, setRole] = useState<UserRole | null>(null);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const { data } = await client.auth.getSession();
        const user = data.session?.user;
        if (!user) return;
        const profile = await fetchProfile(user.id);
        // `profiles` is the authority, and `getUserRole` is the fallback `useCurrentProfile` already
        // makes (`src/lib/profiles.ts`). Without it a profile row that could not be read — a failing
        // policy, a row the trigger has not written yet — left the role null, and the hub then dropped
        // every plugin card and said nothing, which looks exactly like a lost setting.
        if (mounted) setRole(profile?.role ? profile.role as UserRole : getUserRole(user));
      } catch {
        // A viewer whose session cannot be read at all is signed out as far as this screen is concerned.
      }
    })();
    return () => { mounted = false; };
  }, []);
  return role;
}

/** Where a provider's key comes from — the one thing an administrator has to leave this screen for. */
const aiKeyHelp = (provider: AiProvider): string => {
  switch (provider) {
    case 'openai':
      return 'From platform.openai.com/api-keys. Stored in this site\'s database and read only by the server.';
    case 'anthropic':
      return 'From console.anthropic.com/settings/keys. Stored in this site\'s database and read only by the server.';
    case 'openai-compatible':
      return 'The key the service issued, sent as a Bearer token. Stored in this site\'s database and read only by the server.';
    default:
      return 'From Google AI Studio (aistudio.google.com/apikey). Stored in this site\'s database and read only by the server.';
  }
};

/**
 * AI: which provider generation runs on, with which key, and which model.
 *
 * The key is stored in `ai_config` and read by the server, never by the browser: the plugins that
 * generate text (Section Refine, the snippets assistant, the chat assistant) ask the server, and the
 * server spends the key. Test Connection is what makes a typo visible now rather than the first time
 * somebody presses Generate.
 */
function AiCard({ onChanged }: { onChanged: () => void }) {
  const { config, setConfig, loading, busy, error, setError, notice, setNotice, save } =
    useStoredConfig(aiConfigKey, aiConfigFrom);
  const [testing, setTesting] = useState(false);
  const apiKey = useSecret(config.api_key);
  const compatible = config.provider === 'openai-compatible';
  const configured = isAiConfigured(config);
  // Testing a custom provider needs its address and model as well as the key: there is nothing to
  // call by default, so the server would have to answer with a setup instruction instead.
  const canTest = Boolean(apiKey.resolve()) && (!compatible || Boolean(config.base_url && config.model));

  /** One authenticated call, with the values on screen — saved or not. */
  const test = async (): Promise<void> => {
    setTesting(true);
    setError('');
    setNotice('');
    try {
      // The route spends this site's key, so the server checks `user_has_cap('manage_options')` against
      // the caller's own access token — the same check the rest of the admin makes. Sending it is what
      // tells the server who is asking; without it the answer is the 401 "Sign in as an administrator
      // to change integrations." even though this browser has a session.
      const { data } = await client.auth.getSession();
      const response = await fetch('/api/integrations/ai/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.session?.access_token || ''}`,
        },
        body: JSON.stringify({
          provider: config.provider,
          apiKey: apiKey.resolve(),
          model: config.model,
          baseUrl: config.base_url,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || `The test failed (HTTP ${response.status}).`);
      setNotice(payload?.message || 'The provider accepted the key.');
    } catch (testError: unknown) {
      setError(messageOf(testError, 'The provider could not be reached.'));
    } finally {
      setTesting(false);
    }
  };

  const saveAll = async (): Promise<void> => {
    const next = { ...config, api_key: apiKey.resolve() };
    const where = next.provider === 'openai-compatible' && next.base_url ? ` at ${next.base_url}` : '';
    if (await save(next, `Saved. Generation now runs on ${aiProviderLabels[next.provider]}${where}${next.model ? `, model ${next.model}` : ''}.`)) {
      apiKey.keep();
      onChanged();
    }
  };

  const models = aiProviderModels[config.provider];

  return (
    <Card
      id="integration-ai"
      title="AI"
      meta="Text generation, run on the server so no key ever reaches the browser."
      pill={configured
        ? <Pill tone="on">{compatible ? 'Custom provider configured' : `${aiProviderLabels[config.provider]} key saved`}</Pill>
        : <Pill tone="off">Not configured</Pill>}
    >
      <Feedback error={error} notice={notice} />

      {loading ? <p className={styles.targetNote} role="status">Reading the saved settings…</p> : (
        <>
          <div className={styles.fields}>
            <Field label="Provider">
              <select
                value={config.provider}
                onChange={(event) => setConfig({
                  ...config,
                  provider: event.target.value as AiProvider,
                  model: '',
                })}
                disabled={busy || testing}
              >
                {aiProviders.map((provider) => (
                  <option key={provider} value={provider}>{aiProviderLabels[provider]}</option>
                ))}
              </select>
            </Field>
            {compatible ? (
              <Field
                className={styles.wide}
                label="Base URL"
                help="The API root, up to but not including /chat/completions. Any OpenAI-compatible service works — Groq, Mistral, DeepSeek, OpenRouter, Together, xAI, Perplexity, Ollama, LM Studio, a LiteLLM gateway, or Azure OpenAI's v1 endpoint."
              >
                <input
                  type="url"
                  value={config.base_url}
                  list="ai-compatible-base-urls"
                  placeholder="https://api.groq.com/openai/v1"
                  spellCheck={false}
                  onChange={(event) => setConfig({ ...config, base_url: event.target.value })}
                  disabled={busy || testing}
                />
                <datalist id="ai-compatible-base-urls">
                  {aiCompatibleBaseUrls.map((entry) => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </datalist>
              </Field>
            ) : null}
            <Field
              label="Model"
              help={compatible
                ? 'The model name the service documents. There is no default for a custom provider.'
                : 'Leave empty for the provider\'s own default.'}
            >
              <input
                type="text"
                value={config.model}
                list={`ai-models-${config.provider}`}
                placeholder={models[0] || (compatible ? 'e.g. llama-3.3-70b-versatile' : '')}
                spellCheck={false}
                onChange={(event) => setConfig({ ...config, model: event.target.value })}
                disabled={busy || testing}
              />
              <datalist id={`ai-models-${config.provider}`}>
                {models.map((model) => <option key={model} value={model} />)}
              </datalist>
            </Field>
            <Field
              label="API Key"
              help={apiKey.clearing ? 'Saving now will remove the stored key.' : aiKeyHelp(config.provider)}
            >
              <input
                type="password"
                value={apiKey.input}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={apiKey.placeholder}
                onChange={(event) => apiKey.onChange(event.target.value)}
                disabled={busy || testing}
              />
            </Field>
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void saveAll()} disabled={busy || testing}>
              {busy ? 'Saving…' : 'Save AI settings'}
            </button>
            <button type="button" className={styles.secondary} onClick={() => void test()} disabled={busy || testing || !canTest}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {apiKey.saved && !apiKey.clearing ? (
              <button type="button" className={styles.secondary} onClick={() => apiKey.clear()} disabled={busy || testing}>
                Remove saved key
              </button>
            ) : null}
          </div>
          <p className={styles.setupNote}>
            Testing uses the values on this screen, so a key can be proved before it is saved. A saved key
            is never shown again — type a new one to replace it.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * One `system_settings` row, loaded once and written back on demand.
 *
 * The cards are all the same shape — read a row, edit it, save it, offer to reload it — so the
 * reading, the "saved" copy a save button compares against, and the busy/error/notice state live here
 * once instead of in every card. `normalize` turns whatever the row holds into a full configuration, so a
 * card never has to test for a missing field.
 */
export function useStoredConfig<T>(key: string, normalize: (value: unknown) => T, options: { sealed?: boolean } = {}) {
  const sealed = options.sealed === true;
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
      setError(messageOf(loadError, 'The saved configuration could not be read. Sign in again as an administrator and reload this screen.'));
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
      if (sealed) {
        // The server seals the secret fields (the key is never in a browser) and answers with the row as it
        // is now stored, so the form keeps opaque values and never the plain text it was typed with.
        const { data } = await client.auth.getSession();
        const response = await fetch('/api/integrations/row/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
          body: JSON.stringify({ key, value: next }),
        });
        const payload = (await response.json().catch(() => null)) as { value?: unknown; error?: string } | null;
        if (!response.ok) throw new Error(payload?.error || `The configuration could not be saved (HTTP ${response.status}).`);
        next = normalize(payload?.value ?? next);
      } else if (!(await setSystemSetting(key, next))) {
        throw new Error('This browser is not allowed to store the configuration. Sign in again as an administrator and retry.');
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
  }, [key, sealed, normalize]);

  return { config, setConfig, saved, loading, busy, error, setError, notice, setNotice, save, reload };
}

/** The inline error/notice pair every card shows above its fields. */
export function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    </>
  );
}

/**
 * A secret field's draft: `null` until the administrator types or clears it.
 *
 * A saved secret is therefore never written back into the DOM. The card still holds the value — it has
 * to, because the browser is the only client allowed to write `system_settings` and a save rewrites the
 * whole row — but it is not rendered into an input, so a screenshot or a shared screen shows nothing.
 * Typing replaces the value, and "Remove" empties it.
 */
export function useSecret(stored: string) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    /** The value the input shows: empty, so a saved secret is never on screen. */
    input: draft ?? '',
    saved: Boolean(stored),
    /** True once the administrator has typed something different from what is stored. */
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

/**
 * Media & storage: where uploaded files live, and the keys that let the server touch them again.
 *
 * This is the card that fixes the Media Storage warning. Before it existed, the provider was chosen
 * in the Media section while the *keys* came from the server's environment — so a site could upload
 * happily and then never be able to delete a file, with nothing on any screen explaining why.
 * One card now holds the provider and every credential it needs.
 *
 * The form follows the selection: Cloudinary asks for a cloud name, key, secret and unsigned preset;
 * ImageKit for an endpoint, public key and private key; S3 for the fields a compatible service needs
 * plus the optional endpoint and public base URL. Every provider's values are kept when another is
 * selected, so switching to try S3 and switching back does not mean pasting anything again.
 */
function MediaCard({ status, onChanged }: { status: IntegrationStatus | null; onChanged: () => void }) {
  const { config, setConfig, loading, busy, error, setError, notice, setNotice, save } =
    useStoredConfig(mediaStorageConfigKey, mediaStorageConfigFrom);
  const cloudinarySecret = useSecret(config.cloudinary.api_secret);
  const imagekitPrivate = useSecret(config.imagekit.private_key);
  const s3Secret = useSecret(config.s3.secret_access_key);

  /** The row with the most recent typed secrets applied, which is what a save and the S3 settings both use. */
  const draftConfig = () => ({
    ...config,
    cloudinary: { ...config.cloudinary, api_secret: cloudinarySecret.resolve() },
    imagekit: { ...config.imagekit, private_key: imagekitPrivate.resolve() },
    s3: { ...config.s3, secret_access_key: s3Secret.resolve() },
  });

  /**
   * Saving S3 also sets the storage driver, because that is a different setting
   * (`system_settings.storage`) which only the server reads when it writes a file itself. The hosted
   * providers do not need it: their uploads come straight from the browser, which is why uploading to
   * Cloudinary has never needed an API secret.
   */
  const saveAll = async (): Promise<void> => {
    const next = draftConfig();
    const provider = next.provider;
    const driver = provider === 's3' ? 's3' : 'local';
    const message = provider === 's3' || provider === 'supabase'
      ? `Saved. Uploads are stored on ${driver === 's3' ? 'your object store' : 'this site\'s own storage'}.`
      : `Saved. Uploads now go to ${mediaStorageProviderLabels[provider]}.`;
    if (!(await save(next, message))) return;
    cloudinarySecret.keep();
    imagekitPrivate.keep();
    s3Secret.keep();
    if (provider === 's3') {
      // The runtime reads `storage` and `s3` to decide where a server-side upload lands.
      const accepted = (await setSystemSetting('storage', 's3'))
        && (await setSystemSetting('s3', {
          region: next.s3.region,
          endpoint: next.s3.endpoint,
          bucket: next.s3.bucket,
          accessKeyId: next.s3.access_key_id,
          secretAccessKey: next.s3.secret_access_key,
          publicBaseUrl: next.s3.public_base_url,
          forcePathStyle: next.s3.force_path_style,
        }));
      if (!accepted) {
        setNotice('');
        setError('The credentials were saved, but the server could not be told to use S3. Save again, or set the driver on the Media & storage card under Settings → Integrations.');
        return;
      }
      setNotice('Saved. The server now stores new uploads in your S3 bucket.');
    }
    onChanged();
  };

  const active = config.provider;
  const providerKey = active === 'cloudinary' ? 'cloudinaryConfigured'
    : active === 'imagekit' ? 'imagekitConfigured'
      : active === 's3' ? 's3Configured' : null;
  const configured = providerKey ? status?.media[providerKey] === true : true;

  return (
    <Card
      id="integration-media"
      title="Media & storage"
      meta="Where uploaded files live, and the keys that let the server sign an upload or delete a file again."
      pill={<Pill tone={active === 'supabase' ? 'quiet' : configured ? 'on' : 'off'}>
        {mediaStorageProviderLabels[active]}
      </Pill>}
    >
      <Feedback error={error} notice={notice} />

      {loading ? <p className={styles.targetNote} role="status">Reading the saved settings…</p> : (
        <>
          <div className={styles.fields}>
            <Field label="Active provider" help="Which service new uploads are sent to: the Media Library follows this.">
              <select
                value={active}
                onChange={(event) => setConfig({ ...config, provider: event.target.value as MediaStorageProvider })}
                disabled={busy}
              >
                {mediaStorageProviders.map((provider) => (
                  <option key={provider} value={provider}>{mediaStorageProviderLabels[provider]}</option>
                ))}
              </select>
            </Field>
          </div>

          {active === 'supabase' ? (
            <p className={styles.setupLead}>
              Files are stored by this site and served through it, with no third-party account: this is
              where a server-side upload lands (a plugin sending a file, a restore). On a host whose
              filesystem is read-only, choose AWS S3 / S3-Compatible instead. Uploads made from the Media
              Library go to Cloudinary or ImageKit when their keys are saved below or above — pick one of
              those here to make it the default.
            </p>
          ) : null}

          {active === 'cloudinary' ? (
            <div className={styles.fields}>
              <Field label="Cloud Name" help="Cloudinary dashboard → Product Environment Credentials.">
                <input
                  type="text"
                  value={config.cloudinary.cloud_name}
                  spellCheck={false}
                  onChange={(event) => setConfig({ ...config, cloudinary: { ...config.cloudinary, cloud_name: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="Unsigned Upload Preset" help="Cloudinary → Settings → Upload → Upload presets. Signing mode must be Unsigned.">
                <input
                  type="text"
                  value={config.cloudinary.upload_preset}
                  spellCheck={false}
                  onChange={(event) => setConfig({ ...config, cloudinary: { ...config.cloudinary, upload_preset: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="API Key" help="Needed to delete: Cloudinary's destroy API is signed-only.">
                <input
                  type="text"
                  value={config.cloudinary.api_key}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setConfig({ ...config, cloudinary: { ...config.cloudinary, api_key: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="API Secret" help={cloudinarySecret.clearing
                ? 'Saving now will remove the stored secret.'
                : 'Kept in this site\'s database; only the server uses it.'}>
                <input
                  type="password"
                  value={cloudinarySecret.input}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={cloudinarySecret.placeholder}
                  onChange={(event) => cloudinarySecret.onChange(event.target.value)}
                  disabled={busy}
                />
              </Field>
            </div>
          ) : null}

          {active === 'imagekit' ? (
            <div className={styles.fields}>
              <Field label="URL Endpoint" help="ImageKit → Developer options, e.g. https://ik.imagekit.io/your_id">
                <input
                  type="text"
                  value={config.imagekit.url_endpoint}
                  spellCheck={false}
                  onChange={(event) => setConfig({ ...config, imagekit: { ...config.imagekit, url_endpoint: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="Public Key">
                <input
                  type="text"
                  value={config.imagekit.public_key}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setConfig({ ...config, imagekit: { ...config.imagekit, public_key: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field
                label="Private Key"
                help={imagekitPrivate.clearing
                  ? 'Saving now will remove the stored private key.'
                  : 'ImageKit signs every upload and delete, so both need it. Only the server ever sees this value.'}
              >
                <input
                  type="password"
                  value={imagekitPrivate.input}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={imagekitPrivate.placeholder}
                  onChange={(event) => imagekitPrivate.onChange(event.target.value)}
                  disabled={busy}
                />
              </Field>
            </div>
          ) : null}

          {active === 's3' ? (
            <div className={styles.fields}>
              <Field label="Bucket Name">
                <input
                  type="text"
                  value={config.s3.bucket}
                  spellCheck={false}
                  onChange={(event) => setConfig({ ...config, s3: { ...config.s3, bucket: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="Region" help="“auto” for Cloudflare R2.">
                <input
                  type="text"
                  value={config.s3.region}
                  spellCheck={false}
                  placeholder="us-east-1"
                  onChange={(event) => setConfig({ ...config, s3: { ...config.s3, region: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="Access Key ID">
                <input
                  type="text"
                  value={config.s3.access_key_id}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setConfig({ ...config, s3: { ...config.s3, access_key_id: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="Secret Access Key" help={s3Secret.clearing ? 'Saving now will remove the stored key.' : undefined}>
                <input
                  type="password"
                  value={s3Secret.input}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={s3Secret.placeholder}
                  onChange={(event) => s3Secret.onChange(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Custom Endpoint URL (optional)" help="Cloudflare R2, MinIO and Backblaze B2 need it; AWS S3 does not.">
                <input
                  type="text"
                  value={config.s3.endpoint}
                  spellCheck={false}
                  placeholder="https://<accountid>.r2.cloudflarestorage.com"
                  onChange={(event) => setConfig({ ...config, s3: { ...config.s3, endpoint: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <Field label="Public Base URL (optional)" help="Used to build file URLs when the bucket is not public.">
                <input
                  type="text"
                  value={config.s3.public_base_url}
                  spellCheck={false}
                  placeholder="https://cdn.example.com"
                  onChange={(event) => setConfig({ ...config, s3: { ...config.s3, public_base_url: event.target.value } })}
                  disabled={busy}
                />
              </Field>
              <label className={`${styles.checkbox} ${styles.wide}`}>
                <input
                  type="checkbox"
                  checked={config.s3.force_path_style}
                  onChange={(event) => setConfig({ ...config, s3: { ...config.s3, force_path_style: event.target.checked } })}
                  disabled={busy}
                />
                Force path-style addressing (needed for R2 and MinIO)
              </label>
            </div>
          ) : null}

          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void saveAll()} disabled={busy}>
              {busy ? 'Saving…' : 'Save storage credentials'}
            </button>
            <span className={styles.hint}>
              The server reads these when it signs an upload or deletes a file, so nothing has to be
              restarted after a save.
            </span>
          </div>

          <p className={styles.setupNote}>
            Deleting a file removes the library entry and, with these credentials saved, the file at the
            provider as well. Without them the file stays in your provider account, still using its
            storage.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Email: how outgoing mail is sent, from which address, and a button that proves it.
 *
 * Password resets, invitations, order confirmations and form notifications all leave through this. A
 * provider is chosen rather than offering one SMTP form, because most sites now use an API: Resend and
 * SendGrid take a single key and no server configuration, while Custom SMTP covers a host's own mail
 * server.
 *
 * "Send test email" uses what is *saved*, not what is on screen — unlike the AI card — because the
 * message is delivered to a third party: proving a configuration works means proving the one this site
 * will really use.
 */
export function EmailConfigForm({ rowKey, testUrl, onChanged, saveLabel = 'Save email config', intro, resetLabel }: {
  rowKey: string;
  testUrl: string;
  onChanged: () => void;
  saveLabel?: string;
  /** Shown above the fields: a plugin uses it to say what happens when this form is left empty. */
  intro?: ReactNode;
  /** When set, a button that clears the row so the plugin falls back to the site's email settings. */
  resetLabel?: string;
}) {
  const { config, setConfig, loading, busy, error, setError, notice, setNotice, save } =
    useStoredConfig(rowKey, emailConfigFrom, { sealed: true });
  const [recipient, setRecipient] = useState('');
  const [sending, setSending] = useState(false);
  const apiKey = useSecret(config.api_key);
  const smtpPassword = useSecret(config.smtp.password);

  const saveAll = async (): Promise<void> => {
    const next = {
      ...config,
      api_key: apiKey.resolve(),
      smtp: { ...config.smtp, password: smtpPassword.resolve() },
    };
    if (await save(next, `Saved. Mail leaves through ${emailProviderLabels[next.provider]}.`)) {
      apiKey.keep();
      smtpPassword.keep();
      onChanged();
    }
  };

  const sendTest = async (): Promise<void> => {
    setSending(true);
    setError('');
    setNotice('');
    try {
      // Administrator-only, like the AI test: the same access token proves who is asking, so the
      // server's `manage_options` check sees a session rather than an anonymous caller.
      const { data } = await client.auth.getSession();
      const response = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.session?.access_token || ''}`,
        },
        body: JSON.stringify({ to: recipient || config.from_email }),
      });
      const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || `The test failed (HTTP ${response.status}).`);
      setNotice(payload?.message || 'The provider accepted the message.');
    } catch (testError: unknown) {
      setError(messageOf(testError, 'The mail server could not be reached.'));
    } finally {
      setSending(false);
    }
  };

  const usesSmtp = config.provider === 'smtp';

  return (
    <>
      {intro}
      <Feedback error={error} notice={notice} />

      {loading ? <p className={styles.targetNote} role="status">Reading the saved settings…</p> : (
        <>
          <div className={styles.fields}>
            <Field label="Service provider">
              <select
                value={config.provider}
                onChange={(event) => setConfig({ ...config, provider: event.target.value as EmailProvider })}
                disabled={busy || sending}
              >
                {emailProviders.map((provider) => (
                  <option key={provider} value={provider}>{emailProviderLabels[provider]}</option>
                ))}
              </select>
            </Field>
          </div>

          {usesSmtp ? (
            <div className={styles.fields}>
              <Field label="SMTP Host" help="e.g. smtp.example.com">
                <input
                  type="text"
                  value={config.smtp.host}
                  spellCheck={false}
                  onChange={(event) => setConfig({ ...config, smtp: { ...config.smtp, host: event.target.value } })}
                  disabled={busy || sending}
                />
              </Field>
              <Field label="Port" help="587 for STARTTLS, 465 for implicit TLS.">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={config.smtp.port}
                  onChange={(event) => setConfig({ ...config, smtp: { ...config.smtp, port: Number(event.target.value) || 587 } })}
                  disabled={busy || sending}
                />
              </Field>
              <Field label="Username">
                <input
                  type="text"
                  value={config.smtp.username}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setConfig({ ...config, smtp: { ...config.smtp, username: event.target.value } })}
                  disabled={busy || sending}
                />
              </Field>
              <Field label="SMTP Password" help={smtpPassword.clearing
                ? 'Saving now will remove the stored password.'
                : 'Kept in this site\'s database; the connection happens on the server.'}>
                <input
                  type="password"
                  value={smtpPassword.input}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={smtpPassword.placeholder}
                  onChange={(event) => smtpPassword.onChange(event.target.value)}
                  disabled={busy || sending}
                />
              </Field>
              <label className={`${styles.checkbox} ${styles.wide}`}>
                <input
                  type="checkbox"
                  checked={config.smtp.secure}
                  onChange={(event) => setConfig({ ...config, smtp: { ...config.smtp, secure: event.target.checked } })}
                  disabled={busy || sending}
                />
                Use implicit TLS (port 465). Leave off for STARTTLS on 587.
              </label>
            </div>
          ) : (
            <div className={styles.fields}>
              <Field
                label="API Key"
                help={apiKey.clearing
                  ? 'Saving now will remove the stored key.'
                  : config.provider === 'resend'
                    ? 'Resend → API Keys. Starts with re_.'
                    : 'SendGrid → Settings → API Keys, with the Mail Send permission.'}
              >
                <input
                  type="password"
                  value={apiKey.input}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={apiKey.placeholder}
                  onChange={(event) => apiKey.onChange(event.target.value)}
                  disabled={busy || sending}
                />
              </Field>
            </div>
          )}

          <div className={styles.fields}>
            <Field label="From Email" help="An address or domain the provider has verified, or the message is refused.">
              <input
                type="email"
                value={config.from_email}
                spellCheck={false}
                placeholder="no-reply@example.com"
                onChange={(event) => setConfig({ ...config, from_email: event.target.value })}
                disabled={busy || sending}
              />
            </Field>
            <Field label="From Name" help="What the recipient sees beside the address.">
              <input
                type="text"
                value={config.from_name}
                onChange={(event) => setConfig({ ...config, from_name: event.target.value })}
                disabled={busy || sending}
              />
            </Field>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void saveAll()}
              disabled={busy || sending}
            >
              {busy ? 'Saving…' : saveLabel}
            </button>
            {(apiKey.saved && !apiKey.clearing) || (smtpPassword.saved && !smtpPassword.clearing) ? (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => { if (usesSmtp) smtpPassword.clear(); else apiKey.clear(); }}
                disabled={busy || sending}
              >
                Remove saved {usesSmtp ? 'password' : 'key'}
              </button>
            ) : null}
            {resetLabel ? (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  void save(emailConfigFrom(null), "Removed. This plugin now sends through the site’s email settings.").then((ok) => { if (ok) { apiKey.keep(); smtpPassword.keep(); onChanged(); } });
                }}
                disabled={busy || sending}
              >
                {resetLabel}
              </button>
            ) : null}
          </div>

          <div className={styles.fields}>
            <Field label="Send a test email to" help="Uses the saved configuration, so save your changes first.">
              <input
                type="email"
                value={recipient}
                spellCheck={false}
                placeholder={config.from_email || 'you@example.com'}
                onChange={(event) => setRecipient(event.target.value)}
                disabled={busy || sending}
              />
            </Field>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void sendTest()}
              disabled={busy || sending || !config.from_email}
            >
              {sending ? 'Sending…' : 'Send test email'}
            </button>
            <span className={styles.hint}>
              The message is one short paragraph naming this site, so a real notification is never
              mistaken for it.
            </span>
          </div>
        </>
      )}
    </>
  );
}

function EmailCard({ status, onChanged }: { status: IntegrationStatus | null; onChanged: () => void }) {
  return (
    <Card
      id="integration-email"
      title="Email"
      meta="Password resets, invitations, order confirmations and form notifications sent through this site."
      pill={status?.email.configured
        ? <Pill tone="on">{emailProviderLabels[(status.email.provider as EmailProvider) || 'resend']} ready</Pill>
        : <Pill tone="off">Not configured</Pill>}
    >
      <EmailConfigForm rowKey={emailConfigKey} testUrl="/api/integrations/email/test" onChanged={onChanged} />
    </Card>
  );
}

/**
 * One card a plugin registered.
 *
 * The hub owns the placement, the heading and the state pill; the plugin owns the form and its own
 * `system_settings` row, because only the plugin knows what its values mean. A plugin that cannot say
 * whether it is configured gets no pill rather than a wrong one — `describe` is optional and every
 * card is asked on mount and after its own `refresh()`.
 */
function PluginCard({ card }: { card: RwpIntegrationCard }) {
  const [state, setState] = useState<{ configured: boolean; label: string }>({ configured: false, label: '' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!card.describe) return;
    let mounted = true;
    void card.describe()
      .then((next) => { if (mounted) setState(next); })
      .catch(() => { if (mounted) setState({ configured: false, label: 'Unknown' }); });
    return () => { mounted = false; };
    // `revision` is what makes refresh() below re-ask the plugin.
  }, [card, revision]);

  const Body = card.renderComponent;
  return (
    <Card
      id={`integration-${card.id}`}
      title={<>{card.icon ? `${card.icon} ` : ''}{card.title}</>}
      meta={card.description}
      pill={card.describe
        ? <Pill tone={state.configured ? 'on' : 'off'}>{state.label || (state.configured ? 'Configured' : 'Not configured')}</Pill>
        : null}
    >
      <Body status={state} refresh={() => setRevision((value) => value + 1)} />
    </Card>
  );
}

/**
 * Settings → Integrations.
 *
 * A hub rather than a single screen: three cards this build owns — AI, Media & storage, Email — and
 * any a plugin adds through `registerIntegrationCard`. Everything an integration needs is here,
 * because that is the promise the screen makes: no credential for a service is read from the server's
 * environment, and none has to be pasted into a file.
 *
 * The platform owner's cards are plugins too. GitHub publishing and the deploy hook used to sit here as
 * two built-ins; they are now `rwp-saas-installer`'s, registered with `platformOwnerOnly` and drawn by
 * `PluginCard` like any other plugin's. What is left here is the part every site administers — and,
 * because those six cards belong to one account, a sentence naming the ones this viewer cannot see and
 * saying whose they are.
 *
 * What this component does is small on purpose: it fetches `GET /api/integrations/status` (presence
 * only) and hands it to the cards, which each read and write their own row. Two things are worth
 * knowing about how that answer is used:
 *
 *   1. The **cards** read their rows through the signed-in administrator's own session, which is the
 *      only client RLS lets near `system_settings`. So they show what is saved even on a deployment
 *      whose server cannot read the row itself.
 *   2. The **server** reads the same rows to start a handshake, sign an upload or send a test, and
 *      `status.credentials.readable` says whether it can. When it cannot, the banner says which one
 *      variable fixes that, rather than letting every card look unconfigured.
 */
export default function IntegrationsHub() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { cards: registered } = useIntegrationsRegistry();
  const cards = [githubCard, deploymentCard, ...registered.filter((card) => card.id !== githubCard.id && card.id !== deploymentCard.id)]
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const role = useViewerRole();

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchIntegrationStatus());
      setError('');
    } catch (statusError: unknown) {
      setError(messageOf(statusError, 'This server could not describe its integrations.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * The cards this viewer may see.
   *
   * Two gates, and they are different questions. `capability` asks what a role may do, so a role granted
   * `manage_options` under Settings → Roles sees the card that capability belongs to. `platformOwnerOnly`
   * asks who owns the installation, which no grant answers: it is the cards of the roles that own this
   * site — `administrator`, or the `super_admin` a provisioned installation has (`isPlatformOwner`) — and
   * nobody else's, because the rows behind them (this site's GitHub token, the repository it commits to,
   * the hook that rebuilds it) decide what this installation *is*, not who may edit a post on it.
   */
  const pluginCards = cards.filter((card) => {
    if (card.platformOwnerOnly && !(role && isPlatformOwner(role))) return false;
    if (!card.capability) return true;
    return role ? hasCapability(role, card.capability as never) : false;
  });

  /**
   * The cards this viewer is *not* allowed to see, named rather than silently dropped.
   *
   * Before this sentence existed, an administrator's hub simply had three cards where the platform
   * owner's hub has six, and nothing on screen said why: the GitHub token, the repository this
   * installation commits to and the hook that rebuilds it were saved and working, and the screen that
   * manages them looked like it had lost them. `system_settings` refuses those rows to any role that was
   * only *granted* `manage_options`, so there is nothing to show — but there is something to say.
   */
  const ownerOnlyCards = cards.filter((card) => card.platformOwnerOnly);
  const hiddenOwnerCards = role && !isPlatformOwner(role) ? ownerOnlyCards : [];

  if (loading) return <p className={styles.loading} role="status">Checking this site&apos;s integrations…</p>;

  return (
    <div className={styles.panel}>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {status && !status.credentials.readable ? (
        <p className={styles.warning}>
          <strong>This server cannot read these settings yet.</strong> {status.credentials.error}{' '}
          The cards below still show what is saved, because they read the database through your own
          admin session — but testing a key, sending a test email and deleting media at its provider
          all happen on the server, and will keep failing until it can read them too.
        </p>
      ) : null}

      <AiCard onChanged={() => void refresh()} />
      <MediaCard status={status} onChanged={() => void refresh()} />
      <EmailCard status={status} onChanged={() => void refresh()} />

      {hiddenOwnerCards.length > 0 ? (
        <p className={styles.setupNote} role="note">
          <strong>{hiddenOwnerCards.map((card) => card.title).join(', ')}</strong>{' '}
          {hiddenOwnerCards.length === 1 ? 'belongs' : 'belong'} to the platform owner: this
          installation&apos;s own GitHub token, the repository it publishes to and the hook that rebuilds
          it are held by the role that owns this site — <code>administrator</code>, or a{' '}
          <code>super_admin</code> on a provisioned installation — and a role that was merely granted a
          capability does not become the owner. Sign in as an administrator to configure{' '}
          {hiddenOwnerCards.length === 1 ? 'it' : 'them'}.
        </p>
      ) : null}

      {pluginCards.map((card) => <PluginCard key={card.id} card={card} />)}
    </div>
  );
}

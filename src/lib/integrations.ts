/**
 * The Integrations hub's shared vocabulary (Settings → Integrations).
 *
 * Everything here is deliberately free of imports: this file is read by the settings screen and by the
 * server route that answers `/api/integrations/status`, and it holds the contract between the two — the
 * shape of the `ai_config`, `media_storage_config` and `email_config` rows, and the presence-only status
 * that route reports — so a rename cannot half-happen.
 *
 * The platform owner's rows are not here. `github_config`, `deploy_config` and `saas_installer_config`
 * belong to the rwp-saas-installer plugin, and their vocabulary lives in
 * `plugins/rwp-saas-installer/config.ts`, next to the cards that read and write them.
 */

/** Which provider the AI card is set to. Presence only: never a key. */
export interface AiIntegrationStatus {
  configured: boolean;
  provider: string;
  model: string;
}

/** What the media card is set to, and whether each provider's own fields are complete. */
export interface MediaIntegrationStatus {
  /** The storage driver the runtime resolved: `local` or `s3`. */
  storage: string;
  /** The provider chosen in the hub: `supabase`, `cloudinary`, `imagekit` or `s3`. */
  provider: string;
  cloudinaryConfigured: boolean;
  imagekitConfigured: boolean;
  s3Configured: boolean;
}

/** Which provider the email card is set to, and whether it could send anything today. */
export interface EmailIntegrationStatus {
  configured: boolean;
  provider: string;
}

/**
 * Whether the *server* could read the credential rows at all.
 *
 * Under Supabase they are RLS-protected, so a server holding only the publishable key reads nothing;
 * `readable: false` is what lets the hub say so rather than claiming every card is unconfigured.
 */
export interface IntegrationCredentialsStatus {
  readable: boolean;
  source: 'adapter' | 'database' | 'rest' | 'unavailable';
  error: string;
}

/** The body of `GET /api/integrations/status`. */
export interface IntegrationStatus {
  ai: AiIntegrationStatus;
  media: MediaIntegrationStatus;
  email: EmailIntegrationStatus;
  credentials: IntegrationCredentialsStatus;
}

/** The `system_settings` row the AI card owns. In step with `AI_CONFIG_KEY`, `server/integrationConfig.mjs`. */
export const aiConfigKey = 'ai_config';

/** The `system_settings` row the media card owns. In step with `MEDIA_STORAGE_CONFIG_KEY`. */
export const mediaStorageConfigKey = 'media_storage_config';

/** The `system_settings` row the email card owns. In step with `EMAIL_CONFIG_KEY`. */
export const emailConfigKey = 'email_config';

// -- AI ------------------------------------------------------------------------------------------

/**
 * The AI providers the hub offers, in the order they are listed.
 *
 * Three are native APIs — Google Gemini, OpenAI and Anthropic. The fourth is the escape hatch: any
 * service that speaks the OpenAI Chat Completions API, which is most of the market (Groq, Mistral,
 * DeepSeek, OpenRouter, Together, xAI, Perplexity, Fireworks, Ollama, LM Studio, a LiteLLM gateway,
 * Azure OpenAI's v1 surface, …). A provider with a genuinely different wire format can sit behind
 * such a gateway, so "any AI with an API key" does not need a new build.
 */
export const aiProviders = ['gemini', 'openai', 'anthropic', 'openai-compatible'] as const;
export type AiProvider = (typeof aiProviders)[number];

export const aiProviderLabels: Record<AiProvider, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  'openai-compatible': 'Custom (OpenAI-compatible)',
};

/**
 * Base URLs of well-known OpenAI-compatible services, offered as suggestions on the custom card.
 *
 * A suggestion, never a constraint: the field is free text because a self-hosted gateway's address
 * is on no list. The value is the API root — the part before `/chat/completions` — which is also
 * what `aiConfigFrom` stores when a full endpoint is pasted by mistake.
 */
export const aiCompatibleBaseUrls: { label: string; value: string }[] = [
  { label: 'Groq', value: 'https://api.groq.com/openai/v1' },
  { label: 'Mistral', value: 'https://api.mistral.ai/v1' },
  { label: 'DeepSeek', value: 'https://api.deepseek.com/v1' },
  { label: 'OpenRouter', value: 'https://openrouter.ai/api/v1' },
  { label: 'Together AI', value: 'https://api.together.xyz/v1' },
  { label: 'xAI (Grok)', value: 'https://api.x.ai/v1' },
  { label: 'Perplexity', value: 'https://api.perplexity.ai' },
  { label: 'Fireworks AI', value: 'https://api.fireworks.ai/inference/v1' },
  { label: 'Azure OpenAI (v1)', value: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1' },
  { label: 'Ollama (this server)', value: 'http://localhost:11434/v1' },
  { label: 'LM Studio (this server)', value: 'http://localhost:1234/v1' },
  { label: 'LiteLLM gateway', value: 'http://localhost:4000/v1' },
];

/**
 * The models offered as suggestions. Every provider retires models on its own schedule, so the
 * field stays a free text input: this list saves typing, it is not a constraint.
 */
export const aiProviderModels: Record<AiProvider, string[]> = {
  gemini: ['gemini-3.6-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-3-5-haiku-latest'],
  // No suggestions: the model names belong to whichever service was pasted in.
  'openai-compatible': [],
};

/**
 * A string field from a row that arrived from a browser that may be running an older build: anything
 * that is not a string reads as empty, so every parser below can default instead of testing.
 */
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `system_settings.ai_config`: which provider generation runs on, and with which key. */
export interface AiConfig {
  provider: AiProvider;
  api_key: string;
  model: string;
  /**
   * The API root of a custom OpenAI-compatible provider, for example
   * `https://api.groq.com/openai/v1`. Empty for the three native providers, whose addresses are
   * known. A pasted `/chat/completions` suffix is stripped when the row is read.
   */
  base_url: string;
}

export const emptyAiConfig = (): AiConfig => ({
  provider: 'gemini',
  api_key: '',
  model: '',
  base_url: '',
});

/** A base URL as it is stored: no trailing slash, no pasted endpoint. */
const asBaseUrl = (value: unknown): string =>
  asString(value).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');

/** Turns whatever is stored into a full configuration, defaulting every field. */
export const aiConfigFrom = (value: unknown): AiConfig => {
  const base = emptyAiConfig();
  if (!value || typeof value !== 'object') return base;
  const row = value as Record<string, unknown>;
  const provider = asString(row.provider).toLowerCase();
  return {
    ...base,
    provider: (aiProviders as readonly string[]).includes(provider) ? (provider as AiProvider) : base.provider,
    // Tolerated for rows written by hand or by a build that named the field differently.
    api_key: asString(row.api_key) || asString(row.apiKey),
    model: asString(row.model),
    base_url: asBaseUrl(row.base_url) || asBaseUrl(row.baseUrl),
  };
};

/**
 * True when generation could run with this configuration.
 *
 * A native provider needs its key; the custom one also needs an address and a model, because
 * neither has a sensible default.
 */
export const isAiConfigured = (config: AiConfig): boolean =>
  Boolean(config.api_key)
  && (config.provider !== 'openai-compatible' || Boolean(config.base_url && config.model));

// -- Media storage -------------------------------------------------------------------------------

/** Where uploaded files are sent. `supabase` means this site's own storage, not a host. */
export const mediaStorageProviders = ['supabase', 'cloudinary', 'imagekit', 's3'] as const;
export type MediaStorageProvider = (typeof mediaStorageProviders)[number];

export const mediaStorageProviderLabels: Record<MediaStorageProvider, string> = {
  supabase: 'Supabase Storage',
  cloudinary: 'Cloudinary',
  imagekit: 'ImageKit',
  s3: 'AWS S3 / S3-Compatible',
};

export interface CloudinaryStorageConfig {
  cloud_name: string;
  api_key: string;
  api_secret: string;
  upload_preset: string;
}

export interface ImagekitStorageConfig {
  url_endpoint: string;
  public_key: string;
  private_key: string;
}

export interface S3StorageConfig {
  access_key_id: string;
  secret_access_key: string;
  bucket: string;
  region: string;
  /** Optional: Cloudflare R2, MinIO and other compatible services need it. */
  endpoint: string;
  public_base_url: string;
  force_path_style: boolean;
}

/** `system_settings.media_storage_config`: the active provider and every provider's own fields. */
export interface MediaStorageConfig {
  provider: MediaStorageProvider;
  cloudinary: CloudinaryStorageConfig;
  imagekit: ImagekitStorageConfig;
  s3: S3StorageConfig;
}

export const emptyMediaStorageConfig = (): MediaStorageConfig => ({
  provider: 'supabase',
  cloudinary: { cloud_name: '', api_key: '', api_secret: '', upload_preset: '' },
  imagekit: { url_endpoint: '', public_key: '', private_key: '' },
  s3: {
    access_key_id: '', secret_access_key: '', bucket: '', region: '',
    endpoint: '', public_base_url: '', force_path_style: false,
  },
});

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * Every provider's block is kept, not only the active one: an administrator who switches to S3 to
 * try it, then switches back, must not have to paste the Cloudinary keys a second time.
 */
export const mediaStorageConfigFrom = (value: unknown): MediaStorageConfig => {
  const base = emptyMediaStorageConfig();
  if (!value || typeof value !== 'object') return base;
  const row = value as Record<string, unknown>;
  const provider = asString(row.provider).toLowerCase();
  const cloudinary = asObject(row.cloudinary);
  const imagekit = asObject(row.imagekit);
  const s3 = asObject(row.s3);
  return {
    provider: (mediaStorageProviders as readonly string[]).includes(provider)
      ? (provider as MediaStorageProvider)
      : base.provider,
    cloudinary: {
      cloud_name: asString(cloudinary.cloud_name),
      api_key: asString(cloudinary.api_key),
      api_secret: asString(cloudinary.api_secret),
      upload_preset: asString(cloudinary.upload_preset),
    },
    imagekit: {
      url_endpoint: asString(imagekit.url_endpoint),
      public_key: asString(imagekit.public_key),
      private_key: asString(imagekit.private_key),
    },
    s3: {
      access_key_id: asString(s3.access_key_id),
      secret_access_key: asString(s3.secret_access_key),
      bucket: asString(s3.bucket),
      region: asString(s3.region),
      endpoint: asString(s3.endpoint),
      public_base_url: asString(s3.public_base_url),
      force_path_style: s3.force_path_style === true,
    },
  };
};

/** True when the active provider has every field it cannot work without. */
export const isMediaStorageConfigured = (config: MediaStorageConfig): boolean => {
  switch (config.provider) {
    case 'cloudinary':
      return Boolean(config.cloudinary.cloud_name && config.cloudinary.upload_preset);
    case 'imagekit':
      return Boolean(config.imagekit.public_key && config.imagekit.private_key);
    case 's3':
      return Boolean(config.s3.bucket && config.s3.access_key_id && config.s3.secret_access_key);
    default:
      // This site's own storage needs no credential of its own.
      return true;
  }
};

// -- Email ---------------------------------------------------------------------------------------

/** How outgoing mail is sent. */
export const emailProviders = ['resend', 'sendgrid', 'smtp'] as const;
export type EmailProvider = (typeof emailProviders)[number];

export const emailProviderLabels: Record<EmailProvider, string> = {
  resend: 'Resend',
  sendgrid: 'SendGrid',
  smtp: 'Custom SMTP',
};

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  /** True for implicit TLS (port 465); false for STARTTLS (587) and plain relays. */
  secure: boolean;
}

/** `system_settings.email_config`: the provider, its key, and the address mail is sent from. */
export interface EmailConfig {
  provider: EmailProvider;
  api_key: string;
  from_email: string;
  from_name: string;
  smtp: SmtpConfig;
}

export const emptyEmailConfig = (): EmailConfig => ({
  provider: 'resend',
  api_key: '',
  from_email: '',
  from_name: '',
  smtp: { host: '', port: 587, username: '', password: '', secure: false },
});

export const emailConfigFrom = (value: unknown): EmailConfig => {
  const base = emptyEmailConfig();
  if (!value || typeof value !== 'object') return base;
  const row = value as Record<string, unknown>;
  const provider = asString(row.provider).toLowerCase();
  const smtp = asObject(row.smtp);
  const port = Number(smtp.port);
  return {
    provider: (emailProviders as readonly string[]).includes(provider)
      ? (provider as EmailProvider)
      : base.provider,
    api_key: asString(row.api_key) || asString(row.apiKey),
    from_email: asString(row.from_email),
    from_name: asString(row.from_name),
    smtp: {
      host: asString(smtp.host),
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? Math.floor(port) : base.smtp.port,
      username: asString(smtp.username),
      password: asString(smtp.password),
      secure: smtp.secure === true,
    },
  };
};

/** True when the active provider has what sending a message needs. */
export const isEmailConfigured = (config: EmailConfig): boolean => {
  const hasSender = Boolean(config.from_email);
  switch (config.provider) {
    case 'smtp':
      return hasSender && Boolean(config.smtp.host && config.smtp.username && config.smtp.password);
    default:
      return hasSender && Boolean(config.api_key);
  }
};

/**
 * `GET /api/integrations/status`. Throws with the server's own sentence when the route is missing — a
 * static host that only serves `index.html` answers HTML here, and `response.json()` would otherwise
 * fail as `Unexpected token '<'`.
 */
export const fetchIntegrationStatus = async (): Promise<IntegrationStatus> => {
  const response = await fetch('/api/integrations/status', { headers: { Accept: 'application/json' } });
  const payload = (await response.json().catch(() => null)) as (Partial<IntegrationStatus> & { error?: string }) | null;
  if (!response.ok || !payload?.credentials) {
    throw new Error(payload?.error || `The server could not describe its integrations (HTTP ${response.status}).`);
  }
  return payload as IntegrationStatus;
};


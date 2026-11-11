export interface MailConfig {
  provider: 'resend' | 'sendgrid' | 'smtp';
  api_key: string;
  from_email: string;
  from_name: string;
  smtp: { host: string; port: number; username: string; password: string; secure: boolean };
}

export interface MailMessage {
  to: string[] | string;
  subject: string;
  html?: string;
  text?: string;
  fromName?: string;
  replyTo?: string;
}

export function resolveMailConfig(
  pluginId: string,
  ownKey: string,
  ctx: { supabase?: { url?: string; secretKey?: string } } | undefined,
  options?: Record<string, unknown>,
): Promise<{ config: MailConfig | null; source: 'plugin' | 'site' | 'none'; reason: string }>;

export function sendMailWith(config: MailConfig, message: MailMessage): Promise<void>;

export function sendPluginMail(
  pluginId: string,
  ownKey: string,
  ctx: { supabase?: { url?: string; secretKey?: string } } | undefined,
  message: MailMessage,
): Promise<{ sent: true; source: 'plugin' | 'site' } | { sent: false; reason: string }>;

/**
 * Outgoing mail for plugins that run on a client's site (the shop, the page builder's forms).
 *
 * Each such plugin may keep email settings of its own — a shop that writes from orders@ and a page
 * builder that writes from forms@ — stored in a `system_settings` row it owns. When that row is not
 * filled in, the site's own Settings → Integrations → Email row (`email_config`) is used. No SMTP
 * variable is read from the environment: a client cannot set one, and "set it in Vercel" is not an answer
 * a client can act on.
 *
 * Plain ESM with no browser imports, like `integrationConfig.mjs`, because `plugins/<id>/server.mjs` runs
 * as it is under `npm start`. nodemailer is imported lazily for the reason `sendTestEmail` gives.
 */
import { EMAIL_CONFIG_KEY, emailConfigFrom, isEmailConfigured } from './integrationConfig.mjs';
import { readPluginIntegrationRows } from './pluginIntegrationAccess.mjs';
import { openRow } from './sealedRows.mjs';

const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** `"Name" <address>` for a configured sender, or just the address. Quotes are stripped from the name. */
const fromHeader = (config, fromName) => {
  const name = str(fromName || config.from_name).replace(/["<>\r\n]/g, '');
  return name ? `"${name}" <${config.from_email}>` : config.from_email;
};

const withTimeout = async (url, options, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new Error(controller.signal.aborted
      ? `The mail provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
      : (error instanceof Error ? error.message : 'network error'));
  } finally {
    clearTimeout(timer);
  }
};

const failureText = async (response) => {
  const text = await response.text().catch(() => '');
  try {
    const payload = JSON.parse(text);
    return payload?.message || payload?.error?.message || payload?.errors?.[0]?.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
};

/**
 * Which email configuration a plugin sends with.
 *
 * The plugin's own row wins when it is complete; otherwise the site's. `source` says which one was
 * chosen, so a screen can say "sending through the site's email settings" instead of guessing, and
 * `config` is null (with a sentence in `reason`) when neither can send.
 *
 * @param {string} pluginId   the plugin's id; it must be granted both rows in `PLUGIN_INTEGRATION_KEYS`
 * @param {string} ownKey     the plugin's own `system_settings` key, e.g. `shop_email_config`
 * @param {object} ctx        the plugin route context (`ctx.supabase.url`, `ctx.supabase.secretKey`)
 * @returns {Promise<{config: object|null, source: 'plugin'|'site'|'none', reason: string}>}
 */
export async function resolveMailConfig(pluginId, ownKey, ctx, options = {}) {
  const rows = await readPluginIntegrationRows(pluginId, [ownKey, EMAIL_CONFIG_KEY], {
    supabaseUrl: str(ctx?.supabase?.url),
    supabaseKey: str(ctx?.supabase?.secretKey),
    env: process.env || {},
    ...options,
  });
  if (!rows.readable) {
    return {
      config: null,
      source: 'none',
      reason: `The saved email settings could not be read. ${rows.error}`.trim(),
    };
  }
  // Stored sealed (`server/sealedRows.mjs`); a plain value from before sealing existed passes through.
  let own;
  let site;
  try {
    own = emailConfigFrom(openRow(ownKey, rows.settings[ownKey], options.env || process.env || {}));
    site = emailConfigFrom(openRow(EMAIL_CONFIG_KEY, rows.settings[EMAIL_CONFIG_KEY], options.env || process.env || {}));
  } catch (error) {
    return { config: null, source: 'none', reason: error instanceof Error ? error.message : 'The saved email credentials could not be opened.' };
  }
  if (isEmailConfigured(own)) return { config: own, source: 'plugin', reason: '' };
  if (isEmailConfigured(site)) return { config: site, source: 'site', reason: '' };
  return {
    config: null,
    source: 'none',
    reason: 'Email is not set up. Fill in the email settings of this plugin, or Settings → Integrations → Email for the whole site.',
  };
}

/**
 * Sends one message with a resolved configuration. Throws an Error whose message is the provider's own
 * words; callers decide whether that stops anything (an order email never does).
 *
 * @param {object} config   an `emailConfigFrom` result that `isEmailConfigured`
 * @param {{to: string[], subject: string, html?: string, text?: string, fromName?: string, replyTo?: string}} message
 */
export async function sendMailWith(config, message) {
  const to = (Array.isArray(message.to) ? message.to : [message.to]).map(str).filter(Boolean);
  if (to.length === 0) throw new Error('There is no recipient.');
  if (!isEmailConfigured(config)) throw new Error('This email configuration is incomplete.');
  const from = fromHeader(config, message.fromName);
  const text = message.text || (message.html || '')
    .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|tr|h\d|li)>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const replyTo = str(message.replyTo);

  if (config.provider === 'resend') {
    const response = await withTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to, subject: message.subject, text, ...(message.html ? { html: message.html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Resend refused the message: ${await failureText(response) || `HTTP ${response.status}`}`);
    return;
  }

  if (config.provider === 'sendgrid') {
    const response = await withTimeout('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: to.map((email) => ({ email })) }],
        from: config.from_name ? { email: config.from_email, name: str(message.fromName || config.from_name) } : { email: config.from_email },
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        subject: message.subject,
        content: [
          { type: 'text/plain', value: text || ' ' },
          ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
        ],
      }),
    });
    if (!response.ok) throw new Error(`SendGrid refused the message: ${await failureText(response) || `HTTP ${response.status}`}`);
    return;
  }

  let nodemailer;
  try {
    nodemailer = await import('nodemailer');
  } catch (error) {
    throw new Error(`This host cannot send SMTP mail (${error instanceof Error ? error.message : 'nodemailer is unavailable'}). Use Resend or SendGrid, or run the Node server.`);
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.username, pass: config.smtp.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
  try {
    await transport.sendMail({
      from, to: to.join(', '), subject: message.subject, text, ...(message.html ? { html: message.html } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
  } catch (error) {
    throw new Error(`The SMTP server refused the message: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Resolve and send in one call, for a route that sends a single message.
 * Returns `{ sent: true, source }` or `{ sent: false, reason }`; never throws for "not configured".
 */
export async function sendPluginMail(pluginId, ownKey, ctx, message) {
  const { config, source, reason } = await resolveMailConfig(pluginId, ownKey, ctx);
  if (!config) return { sent: false, reason };
  await sendMailWith(config, message);
  return { sent: true, source };
}

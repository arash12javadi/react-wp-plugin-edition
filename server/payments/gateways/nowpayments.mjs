/**
 * NOWPayments (crypto, USDT by default), the built-in gateway. Credentials: `api_key`, `ipn_secret`; options: `pay_currency`
 * (the coin, `usdttrc20` by default) and `sandbox` ('true' uses NOWPayments' sandbox host). NOWPayments has no refund API:
 * a refund is sent from the wallet by hand and recorded with a reference.
 */
import { createHmac } from 'node:crypto';
import { GatewayError, bodyText, canonicalJson, headerOf, sameHex } from '../money.mjs';

export const NOWPAYMENTS_HOSTS = { live: 'https://api.nowpayments.io/v1', sandbox: 'https://api-sandbox.nowpayments.io/v1' };
const COIN = /^[a-z0-9]{2,16}$/;

export const nowpaymentsHost = (sandbox) => (sandbox ? NOWPAYMENTS_HOSTS.sandbox : NOWPAYMENTS_HOSTS.live);
const isSandbox = (credentials) => String(credentials?.sandbox || '') === 'true';
const coinOf = (credentials) => (COIN.test(String(credentials?.pay_currency || '')) ? String(credentials.pay_currency) : 'usdttrc20');

/** NOWPayments IPN: HMAC-SHA512 of the key-sorted JSON body, over the IPN secret (`x-nowpayments-sig`). */
export function verifyNowPaymentsSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  let value;
  try { value = JSON.parse(bodyText(rawBody)); } catch { return false; }
  return sameHex(header, createHmac('sha512', secret).update(canonicalJson(value)).digest());
}

/** Opens an invoice. A refusal because the amount is under the coin's minimum is a 422 the buyer can act on. */
export async function createNowPaymentsInvoice({ apiKey, sandbox = false, body, fetchImpl = fetch }) {
  if (!String(apiKey || '').trim()) throw new GatewayError(501, 'NOWPayments is not set up: the API key is missing.', 'not_configured');
  const response = await fetchImpl(`${nowpaymentsHost(sandbox)}/invoice`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(payload.message || payload.error || '');
    if (/minimal|minimum/i.test(detail)) throw new GatewayError(422, `NOWPayments refused this invoice: ${detail} Nothing was charged.`, 'below_minimum');
    throw new GatewayError(502, `NOWPayments: ${detail || `request failed with HTTP ${response.status}`}`);
  }
  return payload;
}

/** What a verified IPN means: a `paid` event when finished, `failed` when failed or expired, nothing while it is still moving. */
export function nowPaymentsEvents(payload) {
  const orderId = String(payload?.order_id || '');
  if (!orderId) return [];
  const status = String(payload.payment_status || '');
  if (status === 'finished') {
    return [{
      type: 'paid', orderId, reference: String(payload.payment_id || ''), amount: Number(payload.price_amount),
      currency: String(payload.price_currency || '').toUpperCase(), metadata: { pay_currency: String(payload.pay_currency || '') },
    }];
  }
  if (['failed', 'expired'].includes(status)) return [{ type: 'failed', orderId, reference: String(payload.payment_id || ''), metadata: { status } }];
  return [];
}

export const nowpaymentsGateway = {
  id: 'nowpayments',
  label: 'NOWPayments',
  buyerLabel: 'USDT (crypto)',
  description: 'Crypto (USDT by default), paid on NOWPayments\' own page.',
  credentialFields: [
    { name: 'api_key', label: 'API key', type: 'secret', required: true, help: 'NOWPayments → Store settings → API keys.' },
    { name: 'ipn_secret', label: 'IPN secret', type: 'secret', required: true, help: 'NOWPayments → Store settings → Instant payment notifications.' },
    { name: 'pay_currency', label: 'Coin buyers pay in', type: 'text', required: false, help: 'For example usdttrc20 (the default) or usdterc20.' },
    { name: 'sandbox', label: 'Use the sandbox', type: 'boolean', required: false, help: 'Test payments against api-sandbox.nowpayments.io.' },
  ],
  currencies: ['*'],
  supports: { refund: false, confirmReturn: false, webhook: true },

  async createCheckout({ credentials, order, urls, fetchImpl = fetch }) {
    const invoice = await createNowPaymentsInvoice({
      apiKey: credentials.api_key,
      sandbox: isSandbox(credentials),
      fetchImpl,
      body: {
        price_amount: Number(order.amount),
        price_currency: String(order.currency || 'USD').toLowerCase(),
        pay_currency: coinOf(credentials),
        order_id: String(order.id),
        order_description: String(order.title || `Order ${order.id}`).slice(0, 250),
        ipn_callback_url: urls.webhook,
        success_url: urls.success,
        cancel_url: urls.cancel,
      },
    });
    const url = String(invoice.invoice_url || '');
    if (!/^https:\/\//i.test(url)) throw new GatewayError(502, 'NOWPayments did not return an invoice address.');
    return { url, reference: String(invoice.id || '') };
  },

  async parseWebhook({ rawBody, headers, credentials }) {
    if (!credentials.ipn_secret) return { verified: false, reason: 'The NOWPayments IPN secret is not saved.' };
    if (!verifyNowPaymentsSignature(rawBody, headerOf(headers, 'x-nowpayments-sig'), credentials.ipn_secret)) {
      return { verified: false, reason: 'Invalid NOWPayments signature.' };
    }
    const payload = JSON.parse(bodyText(rawBody));
    return { verified: true, events: nowPaymentsEvents(payload), raw: payload };
  },

  async probe({ credentials, fetchImpl = fetch }) {
    const response = await fetchImpl(`${nowpaymentsHost(isSandbox(credentials))}/status`, { headers: { 'x-api-key': credentials.api_key } });
    if (!response.ok) throw new GatewayError(502, `NOWPayments answered HTTP ${response.status}.`);
    return { ok: true, detail: 'NOWPayments answered.' };
  },
};

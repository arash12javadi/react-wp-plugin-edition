/**
 * PayPal, the built-in gateway: an order is created, the buyer approves it on PayPal, and it is captured when they come back
 * (`confirmReturn`), so no webhook is needed. Credentials: `client_id`, `client_secret`; option `sandbox` ('true' = sandbox).
 */
import { GatewayError } from '../money.mjs';

const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);
export const toPaypalValue = (amount, currency) => Number(amount).toFixed(ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 0 : 2);
const isSandbox = (credentials) => String(credentials?.sandbox ?? 'true') !== 'false';
const base = (credentials) => (isSandbox(credentials) ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com');

// Keyed by mode and credentials, so saving other credentials never reuses a token issued for the old ones.
const tokens = new Map();

async function accessToken(credentials, fetchImpl) {
  if (!credentials?.client_id || !credentials?.client_secret) {
    throw new GatewayError(501, 'PayPal is not set up: the client ID and secret are missing.', 'not_configured');
  }
  const cacheKey = `${isSandbox(credentials)}:${credentials.client_id}:${String(credentials.client_secret).slice(-6)}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;
  const response = await fetchImpl(`${base(credentials)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GatewayError(502, `PayPal rejected the API credentials (${payload.error_description || `HTTP ${response.status}`}). Check the client ID and secret, and that the sandbox switch matches them.`);
  }
  tokens.clear();
  const issued = { value: payload.access_token, expires: Date.now() + Number(payload.expires_in || 0) * 1000 };
  tokens.set(cacheKey, issued);
  return issued.value;
}

/** One PayPal REST call. `requestId` is PayPal's idempotency header: a repeated refund with the same id returns the first. */
export async function paypalRequest(credentials, method, path, body, { requestId = '', fetchImpl = fetch } = {}) {
  const token = await accessToken(credentials, fetchImpl);
  const response = await fetchImpl(`${base(credentials)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new GatewayError(502, `PayPal: ${payload.details?.[0]?.description || payload.message || `HTTP ${response.status}`}`);
  return payload;
}

/** Forgets cached tokens (tests). */
export const resetPaypalTokens = () => tokens.clear();

export const paypalGateway = {
  id: 'paypal',
  label: 'PayPal',
  buyerLabel: 'PayPal',
  description: 'PayPal balance and the cards PayPal accepts, approved on PayPal and captured when the buyer returns.',
  credentialFields: [
    { name: 'client_id', label: 'Client ID', type: 'text', required: true, help: 'PayPal Developer → Apps & Credentials.' },
    { name: 'client_secret', label: 'Secret', type: 'secret', required: true, help: 'PayPal Developer → Apps & Credentials.' },
    { name: 'sandbox', label: 'Use the sandbox', type: 'boolean', required: false, help: 'Sandbox credentials only work with the sandbox switched on.' },
  ],
  currencies: ['*'],
  supports: { refund: true, confirmReturn: true, webhook: false },

  async createCheckout({ credentials, order, urls, fetchImpl = fetch }) {
    const currency = String(order.currency || 'USD').toUpperCase();
    const created = await paypalRequest(credentials, 'POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: String(order.id),
        custom_id: String(order.id),
        description: String(order.title || `Order ${order.id}`).slice(0, 127),
        amount: { currency_code: currency, value: toPaypalValue(order.amount, currency) },
      }],
      payment_source: {
        paypal: { experience_context: { user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: urls.success, cancel_url: urls.cancel } },
      },
    }, { fetchImpl });
    const approve = (created.links || []).find((link) => link.rel === 'payer-action' || link.rel === 'approve');
    if (!approve) throw new GatewayError(502, 'PayPal did not return an approval link.');
    return { url: String(approve.href), reference: String(created.id || '') };
  },

  /** PayPal appends `token=<order id>` to the return address; the order is read (and captured) from PayPal, never trusted. */
  async confirmReturn({ credentials, query, expectedOrderId = '', fetchImpl = fetch }) {
    const paypalOrderId = String(query?.token || query?.reference || '');
    if (!/^[A-Z0-9]+$/.test(paypalOrderId)) throw new GatewayError(400, 'A valid PayPal order id is required.');
    let order = await paypalRequest(credentials, 'GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, null, { fetchImpl });
    const unit = order.purchase_units?.[0];
    if (expectedOrderId && String(unit?.custom_id) !== String(expectedOrderId)) {
      throw new GatewayError(400, 'This PayPal payment belongs to a different order.');
    }
    if (order.status === 'APPROVED') {
      order = await paypalRequest(credentials, 'POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, { fetchImpl });
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED') {
      return { events: [], pending: true, status: String(capture?.status || order.status || '') };
    }
    return {
      events: [{
        type: 'paid', orderId: String(order.purchase_units?.[0]?.custom_id || unit?.custom_id || ''), reference: String(capture.id),
        amount: Number(capture.amount?.value), currency: String(capture.amount?.currency_code || '').toUpperCase(),
        metadata: { paypal_order_id: paypalOrderId, paypal_capture_id: String(capture.id) },
      }],
      pending: false,
      status: 'COMPLETED',
    };
  },

  async refund({ credentials, reference, amount, currency, idempotencyKey = '', fetchImpl = fetch }) {
    if (!/^[A-Z0-9]+$/.test(String(reference || ''))) throw new GatewayError(409, 'This order has no PayPal capture that can be refunded from here.');
    const code = String(currency || 'USD').toUpperCase();
    const payload = await paypalRequest(credentials, 'POST', `/v2/payments/captures/${encodeURIComponent(reference)}/refund`, {
      amount: { value: toPaypalValue(amount, code), currency_code: code },
    }, { requestId: idempotencyKey, fetchImpl });
    if (['FAILED', 'CANCELLED'].includes(String(payload.status || ''))) throw new GatewayError(502, `PayPal reports the refund as ${payload.status}.`);
    return { id: String(payload.id || ''), status: String(payload.status || ''), raw: payload };
  },

  async probe({ credentials, fetchImpl = fetch }) {
    await accessToken(credentials, fetchImpl);
    return { ok: true, detail: 'PayPal issued an access token.' };
  },
};

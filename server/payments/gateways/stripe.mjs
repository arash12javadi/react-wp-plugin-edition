/**
 * Stripe (cards), the built-in gateway. One copy for every shop: the developer shop, the plugin shop and the marketplace used
 * to carry three. Credentials: `secret_key` and `webhook_secret`, from Stripe's dashboard.
 */
import { createHmac } from 'node:crypto';
import {
  GatewayError, bodyText, encodeForm, fromMinorUnits, headerOf, sameHex, toMinorUnits,
} from '../money.mjs';

const API = 'https://api.stripe.com/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One Stripe API call. `idempotencyKey` makes a repeated request (a refund) return the first answer instead of moving money twice. */
export async function stripeRequest(secretKey, method, path, params, { idempotencyKey = '', fetchImpl = fetch } = {}) {
  if (!String(secretKey || '').trim()) throw new GatewayError(501, 'Stripe is not set up: the secret key is missing.', 'not_configured');
  const response = await fetchImpl(`${API}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: params ? new URLSearchParams(encodeForm(params)).toString() : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new GatewayError(502, `Stripe: ${payload.error?.message || `request failed with HTTP ${response.status}`}`);
  return payload;
}

/** `Stripe-Signature: t=<unix>,v1=<hmac>` over `<t>.<raw body>`, within `toleranceSeconds`. */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const items = String(header).split(',').map((part) => part.split('='));
  const timestamp = Number(items.find(([key]) => key === 't')?.[1]);
  const signatures = items.filter(([key, value]) => key === 'v1' && value).map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${bodyText(rawBody)}`).digest();
  return signatures.some((signature) => sameHex(signature, expected));
}

/** The paid order a Checkout Session reports, or null (not paid yet, or not one of ours). */
export function stripePaidEvent(session) {
  if (!session || session.payment_status !== 'paid') return null;
  const orderId = String(session.client_reference_id || session.metadata?.order_id || '');
  if (!orderId) return null;
  const currency = String(session.currency || '').toUpperCase();
  const intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  return {
    type: 'paid',
    orderId,
    reference: String(intent || session.id || ''),
    amount: fromMinorUnits(session.amount_total, currency),
    currency,
    metadata: { ...(session.metadata || {}), stripe_session_id: String(session.id || '') },
  };
}

/** The refunds a Stripe event reports: refund.* (one) or charge.refunded (all of them). Failed or cancelled refunds are left out. */
export function stripeRefundEvents(event) {
  const object = event?.data?.object;
  if (!object) return [];
  const one = (refund, intent, currency) => {
    if (!refund?.id || ['failed', 'canceled'].includes(String(refund.status || ''))) return null;
    const ref = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id || intent || '';
    const code = String(refund.currency || currency || '').toUpperCase();
    const request = String(refund.metadata?.rwp_refund || '');
    return {
      type: 'refunded',
      reference: String(ref),
      refundId: String(refund.id),
      amount: fromMinorUnits(refund.amount, code),
      currency: code,
      refundRequest: UUID.test(request) ? request : null,
      metadata: { ...(refund.metadata || {}) },
    };
  };
  if (['refund.created', 'refund.updated', 'charge.refund.updated'].includes(event.type)) return [one(object)].filter(Boolean);
  if (event.type === 'charge.refunded') {
    const intent = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
    return (Array.isArray(object.refunds?.data) ? object.refunds.data : []).map((refund) => one(refund, intent, object.currency)).filter(Boolean);
  }
  return [];
}

export const stripeGateway = {
  id: 'stripe',
  label: 'Stripe',
  buyerLabel: 'Card',
  description: 'Cards (and the wallets Stripe Checkout offers), paid on Stripe\'s own page.',
  credentialFields: [
    { name: 'secret_key', label: 'Secret key', type: 'secret', required: true, help: 'Stripe → Developers → API keys (sk_live_… or sk_test_…).' },
    { name: 'webhook_secret', label: 'Webhook signing secret', type: 'secret', required: true, help: 'Stripe → Developers → Webhooks → your endpoint (whsec_…).' },
  ],
  currencies: ['*'],
  supports: { refund: true, confirmReturn: true, webhook: true },

  async createCheckout({ credentials, order, urls, idempotencyKey = '', fetchImpl = fetch }) {
    const currency = String(order.currency || 'USD').toLowerCase();
    const session = await stripeRequest(credentials.secret_key, 'POST', 'checkout/sessions', {
      mode: 'payment',
      client_reference_id: String(order.id),
      customer_email: order.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: toMinorUnits(order.amount, currency),
          product_data: { name: String(order.title || `Order ${order.id}`).slice(0, 250), ...(order.description ? { description: String(order.description).slice(0, 500) } : {}) },
        },
      }],
      metadata: { order_id: String(order.id), ...(order.metadata || {}) },
      payment_intent_data: { metadata: { order_id: String(order.id) } },
      success_url: urls.success,
      cancel_url: urls.cancel,
    }, { idempotencyKey, fetchImpl });
    if (!session.url) throw new GatewayError(502, 'Stripe did not return a checkout address.');
    return { url: String(session.url), reference: String(session.id || '') };
  },

  async parseWebhook({ rawBody, headers, credentials, now = Date.now() }) {
    if (!credentials.webhook_secret) return { verified: false, reason: 'The Stripe webhook signing secret is not saved.' };
    if (!verifyStripeSignature(rawBody, headerOf(headers, 'stripe-signature'), credentials.webhook_secret, { now })) {
      return { verified: false, reason: 'Invalid Stripe signature.' };
    }
    let event;
    try { event = JSON.parse(bodyText(rawBody)); } catch { return { verified: false, reason: 'The Stripe event is not JSON.' }; }
    const events = [];
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const paid = stripePaidEvent(event.data?.object);
      if (paid) events.push(paid);
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data?.object;
      const orderId = String(session?.client_reference_id || session?.metadata?.order_id || '');
      if (orderId) events.push({ type: 'failed', orderId, reference: String(session.id || ''), metadata: { ...(session.metadata || {}) } });
    }
    events.push(...stripeRefundEvents(event));
    return { verified: true, events, raw: event };
  },

  /** After the buyer comes back with `session_id`: the session read from Stripe, never trusted from the address. */
  async confirmReturn({ credentials, query, fetchImpl = fetch }) {
    const sessionId = String(query?.session_id || query?.reference || '');
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new GatewayError(400, 'A valid Stripe session id is required.');
    const session = await stripeRequest(credentials.secret_key, 'GET', `checkout/sessions/${sessionId}`, null, { fetchImpl });
    const paid = stripePaidEvent(session);
    return { events: paid ? [paid] : [], pending: !paid, status: String(session.payment_status || ''), raw: session };
  },

  async refund({ credentials, reference, amount, currency, idempotencyKey = '', metadata = {}, fetchImpl = fetch }) {
    if (!/^pi_[A-Za-z0-9_]+$/.test(String(reference || ''))) {
      throw new GatewayError(409, 'This order has no Stripe payment that can be refunded from here. Refund it in the Stripe dashboard (the webhook records it), or record it by hand.');
    }
    const payload = await stripeRequest(credentials.secret_key, 'POST', 'refunds', {
      payment_intent: reference, amount: toMinorUnits(amount, currency || 'USD'), reason: 'requested_by_customer', metadata,
    }, { idempotencyKey, fetchImpl });
    if (['failed', 'canceled'].includes(String(payload.status || ''))) {
      throw new GatewayError(502, `Stripe reports the refund as ${payload.status}${payload.failure_reason ? ` (${payload.failure_reason})` : ''}.`);
    }
    return { id: String(payload.id || ''), status: String(payload.status || ''), raw: payload };
  },

  async probe({ credentials, fetchImpl = fetch }) {
    await stripeRequest(credentials.secret_key, 'GET', 'balance', null, { fetchImpl });
    return { ok: true, detail: 'Stripe accepted the secret key.' };
  },
};

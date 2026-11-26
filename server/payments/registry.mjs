/**
 * The payment-gateway registry: one list of the ways a site can take money, shared by every shop on it (the plugin shop, the
 * developer shop, the marketplace).
 *
 * Built in: Stripe and NOWPayments (`./gateways/`), because licence sales (subscriptions, crypto) depend on them. Every other
 * gateway is a plugin's: PayPal, Mollie and GoCardless ship in `plugins/rwp-payments-plus`. A plugin adds one from its `server.mjs`:
 *
 *     export function register({ registerPaymentGateway }) {
 *       registerPaymentGateway({ id: 'zarinpal', label: 'Zarinpal', credentialFields: [...], createCheckout, parseWebhook | confirmReturn });
 *     }
 *
 * A plugin's gateway appears only while that plugin is active, and is OFF in every shop until the site owner switches it on
 * and saves its credentials there. A gateway only *reports* what happened (a verified webhook or a confirmed return); the shop
 * that opened the order checks in SQL that the amount and currency cover it and completes it once. A gateway never decides a
 * price: the order's amount is read by the shop from its own database and handed to `createCheckout`.
 *
 * Contract (every function also receives `fetchImpl`, so it can be tested without the network):
 *   createCheckout({ credentials, order: { id, amount, currency, title, email, description?, metadata? }, urls: { success, cancel, webhook },
 *                    idempotencyKey }) -> { url, reference }
 *   parseWebhook({ rawBody, headers, credentials }) -> { verified, reason?, events: [{ type: 'paid'|'failed'|'refunded', orderId?, reference,
 *                    amount?, currency?, refundId?, metadata? }] }                 (optional when confirmReturn exists)
 *   confirmReturn({ credentials, query, expectedOrderId }) -> { events, pending }  (optional)
 *   refund({ credentials, reference, amount, currency, idempotencyKey, metadata }) -> { id, status }   (optional: else refunds are manual)
 *   probe({ credentials }) -> { ok, detail }                                       (optional)
 */
import { applyFilters, activePluginIds, doAction } from '../hooks.mjs';
import { GatewayError } from './money.mjs';
import { stripeGateway } from './gateways/stripe.mjs';
import { nowpaymentsGateway } from './gateways/nowpayments.mjs';

export { GatewayError };

const ID = /^[a-z][a-z0-9_-]{1,30}$/;
const FIELD = /^[a-z][a-z0-9_]{1,40}$/;
const FIELD_TYPES = ['secret', 'text', 'boolean'];
/** Ids a plugin may never take: the built-ins, and the shop's own offline methods. */
export const RESERVED_GATEWAY_IDS = Object.freeze(['stripe', 'nowpayments', 'bacs', 'cheque', 'cod', 'free', 'manual', 'coingate', 'lemonsqueezy']);
/**
 * Ids that only one plugin may register. PayPal was built in until 20261126: shops hold orders, saved settings and refunds under
 * `paypal`, so another plugin taking that id would receive them. Only rwp-payments-plus, which took PayPal over, may use it.
 */
export const PLUGIN_OWNED_GATEWAY_IDS = Object.freeze({ paypal: 'rwp-payments-plus' });

const text = (value, max) => String(value ?? '').trim().slice(0, max);

/** A definition, checked and frozen. Throws a TypeError naming what is wrong. */
export function normaliseGateway(def, { pluginId = '', builtIn = false } = {}) {
  if (!def || typeof def !== 'object') throw new TypeError('A payment gateway is an object.');
  const id = String(def.id || '');
  if (!ID.test(id)) throw new TypeError(`"${id}" is not a gateway id (lower-case letters, digits, _ and -, 2 to 31 characters).`);
  if (typeof def.createCheckout !== 'function') throw new TypeError(`The gateway "${id}" needs createCheckout().`);
  if (typeof def.parseWebhook !== 'function' && typeof def.confirmReturn !== 'function') {
    throw new TypeError(`The gateway "${id}" needs parseWebhook() or confirmReturn(): something has to tell the shop that a payment happened.`);
  }
  const fields = (Array.isArray(def.credentialFields) ? def.credentialFields : []).map((field) => {
    const name = String(field?.name || '');
    if (!FIELD.test(name)) throw new TypeError(`The gateway "${id}" has a credential field named "${name}"; use lower-case letters, digits and _.`);
    const type = FIELD_TYPES.includes(field.type) ? field.type : (field.secret ? 'secret' : 'text');
    return Object.freeze({ name, label: text(field.label || name, 80), type, required: field.required !== false && type !== 'boolean', help: text(field.help, 300) });
  });
  if (new Set(fields.map((field) => field.name)).size !== fields.length) throw new TypeError(`The gateway "${id}" names a credential field twice.`);
  const optional = (name) => (typeof def[name] === 'function' ? def[name] : null);
  return Object.freeze({
    id,
    label: text(def.label || id, 60),
    buyerLabel: text(def.buyerLabel || def.label || id, 60),
    description: text(def.description, 300),
    credentialFields: Object.freeze(fields),
    currencies: Object.freeze((Array.isArray(def.currencies) && def.currencies.length ? def.currencies : ['*']).map((code) => String(code).toUpperCase())),
    scopes: Object.freeze(Array.isArray(def.scopes) ? def.scopes.map(String) : []),
    supports: Object.freeze({
      refund: typeof def.refund === 'function',
      confirmReturn: typeof def.confirmReturn === 'function',
      webhook: typeof def.parseWebhook === 'function',
      probe: typeof def.probe === 'function',
    }),
    builtIn,
    pluginId: builtIn ? '' : String(pluginId),
    createCheckout: def.createCheckout,
    parseWebhook: optional('parseWebhook'),
    confirmReturn: optional('confirmReturn'),
    refund: optional('refund'),
    probe: optional('probe'),
  });
}

const BUILT_INS = new Map([stripeGateway, nowpaymentsGateway].map((def) => [def.id, normaliseGateway(def, { builtIn: true })]));
const registered = new Map();

/** Called by `server/plugins.mjs` for a plugin's `registerPaymentGateway(def)`. A taken or reserved id is refused. */
export function registerPaymentGateway(def, { pluginId }) {
  if (!pluginId) throw new TypeError('A payment gateway is registered by a plugin.');
  const gateway = normaliseGateway(def, { pluginId });
  if (RESERVED_GATEWAY_IDS.includes(gateway.id) || BUILT_INS.has(gateway.id)) throw new TypeError(`The gateway id "${gateway.id}" is reserved.`);
  const owner = PLUGIN_OWNED_GATEWAY_IDS[gateway.id];
  if (owner && owner !== gateway.pluginId) throw new TypeError(`The gateway id "${gateway.id}" belongs to the plugin ${owner}.`);
  const existing = registered.get(gateway.id);
  if (existing && existing.pluginId !== gateway.pluginId) throw new TypeError(`The gateway id "${gateway.id}" is already registered by ${existing.pluginId}.`);
  registered.set(gateway.id, gateway);
  return gateway;
}

const usable = (gateway) => {
  if (gateway.builtIn) return true;
  const active = activePluginIds();
  return !active || active.has(gateway.pluginId);
};

/** One gateway by id: a built-in, or a plugin's while that plugin is active. Null otherwise. */
export function getGateway(id) {
  const gateway = BUILT_INS.get(String(id)) || registered.get(String(id));
  return gateway && usable(gateway) ? gateway : null;
}

/**
 * The gateways a shop may offer, in order: the built-ins it supports (`builtIns`), then every active plugin's gateway that does
 * not limit itself to other scopes. `rwp_payment_gateways` may reorder or drop entries (it receives `{ scope }`); an entry it adds
 * must be a registered gateway, since only those were validated.
 */
export async function listGateways({ scope = '', builtIns = [...BUILT_INS.keys()] } = {}) {
  const list = [
    ...builtIns.map((id) => BUILT_INS.get(id)).filter(Boolean),
    ...[...registered.values()].filter((gateway) => usable(gateway) && (!gateway.scopes.length || gateway.scopes.includes(scope))),
  ];
  const filtered = await applyFilters('rwp_payment_gateways', list, { scope });
  const seen = new Set();
  return (Array.isArray(filtered) ? filtered : list)
    .map((entry) => getGateway(entry?.id))
    .filter((gateway) => gateway && !seen.has(gateway.id) && seen.add(gateway.id));
}

/** Whether a gateway can take an order in this currency. */
export const acceptsCurrency = (gateway, currency) => gateway.currencies.includes('*') || gateway.currencies.includes(String(currency || '').toUpperCase());

/** Which required credentials are missing, given what is stored (`{ name: value }` or `{ name: true }` presence). Never a value. */
export function credentialStatus(gateway, stored = {}) {
  const present = (value) => value === true || (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value));
  const missing = gateway.credentialFields.filter((field) => field.required && !present(stored?.[field.name])).map((field) => field.name);
  return { missing, ready: missing.length === 0 };
}

/** What a browser may know about a gateway: its names, fields (never values) and abilities. */
export const publicGateway = (gateway) => ({
  id: gateway.id,
  label: gateway.label,
  buyer_label: gateway.buyerLabel,
  description: gateway.description,
  built_in: gateway.builtIn,
  plugin: gateway.pluginId,
  credential_fields: gateway.credentialFields.map((field) => ({ ...field })),
  supports: { ...gateway.supports },
});

/**
 * Applies a webhook to a gateway and returns its verified events, or throws a 401/404 GatewayError. Shops call this from
 * `webhook/:gateway`; nothing is applied unless the gateway verified the request itself.
 */
export async function verifiedWebhookEvents(gateway, { rawBody, headers, credentials, fetchImpl }) {
  if (!gateway?.parseWebhook) throw new GatewayError(404, 'This payment method has no webhook.');
  const result = await gateway.parseWebhook({ rawBody, headers, credentials, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!result?.verified) throw new GatewayError(401, result?.reason || 'The webhook could not be verified.', 'unverified');
  return Array.isArray(result.events) ? result.events : [];
}

/**
 * What a buyer reads on the gateway's page: `rwp_checkout_session_args` may change the title, the description and the metadata of
 * an order before it is handed to a gateway. The id, the amount and the currency are put back afterwards, whatever a filter did:
 * a hook can never change what is charged.
 */
export async function checkoutOrder(order, { scope, gateway }) {
  const shown = { title: order.title, description: order.description || '', metadata: { ...(order.metadata || {}) } };
  const filtered = await applyFilters('rwp_checkout_session_args', shown, { scope, gateway: gateway.id, order_id: order.id });
  const safe = filtered && typeof filtered === 'object' ? filtered : shown;
  return {
    ...order,
    title: String(safe.title ?? order.title).slice(0, 250),
    description: String(safe.description ?? '').slice(0, 500),
    metadata: safe.metadata && typeof safe.metadata === 'object' ? { ...safe.metadata } : {},
    id: order.id,
    amount: order.amount,
    currency: order.currency,
  };
}

/** Announces a payment the shop has applied (after its SQL accepted it). Never throws. */
export async function announcePayment(type, payment) {
  const frozen = Object.freeze({ ...payment });
  if (type === 'complete') await doAction('rwp_payment_complete', frozen);
  else if (type === 'failed') await doAction('rwp_payment_failed', frozen);
  else if (type === 'refund') await doAction('rwp_refund_created', frozen);
}

/** Forgets plugin gateways (tests only). */
export function resetPaymentGateways() {
  registered.clear();
}

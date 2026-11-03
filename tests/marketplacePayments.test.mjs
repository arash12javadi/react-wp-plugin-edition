/**
 * Payment settings: which environment the checkout runs in, and what that decision is allowed to do.
 *
 * Every case here is a way to take money that cannot be confirmed, so the fixtures are credentials
 * written for the test rather than a live key: a Stripe prefix that contradicts the selected
 * environment, a sandbox callback reaching a live order, a method offered at checkout while its provider
 * is switched off. `probeProvider` is handed a fake `fetch` and every other function takes an `env`
 * object, so nothing in this file reads `process.env` or reaches the network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  derivePaymentConfig, environmentMatches, environmentMismatchError, normalizeProvider, paymentChecks,
  planCheckout, probeProvider, providerCredentials, publicCheckoutOptions, publicPaymentConfig,
  savePaymentConfig, stripeCredentials, nowpaymentsCredentials, transactionEnvironment,
  validatePaymentConfigInput,
} from '../plugins/rwp-plugin-marketplace/server/paymentConfig.mjs';

/** Fixture credentials: inert strings, one set per environment, exactly as the docs describe them. */
const LIVE_NOW = { NOWPAYMENTS_API_KEY: 'live-key', NOWPAYMENTS_IPN_SECRET: 'live-ipn' };
const SANDBOX_NOW = { NOWPAYMENTS_SANDBOX_API_KEY: 'sandbox-key', NOWPAYMENTS_SANDBOX_IPN_SECRET: 'sandbox-ipn' };
const LIVE_STRIPE = { STRIPE_LIVE_SECRET_KEY: 'sk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_live_fixture' };
const SANDBOX_STRIPE = { STRIPE_SANDBOX_SECRET_KEY: 'sk_test_fixture', STRIPE_SANDBOX_WEBHOOK_SECRET: 'whsec_test_fixture' };

/** A config shaped like `derivePaymentConfig`'s answer, so `planCheckout` is asked one thing at a time. */
const config = (overrides = {}) => ({
  environment: 'live',
  providers: { nowpayments: true, stripe: false },
  methods: ['nowpayments'],
  source: 'database',
  ...overrides,
});

test('a live NOWPayments key does not satisfy the sandbox environment, or the other way round', () => {
  const liveOnly = { ...LIVE_NOW };
  assert.deepEqual(nowpaymentsCredentials('live', liveOnly).missing, []);
  // The two realistic mistakes - an unset variable, and the switch pointing at the other environment -
  // need different fixes, so the second is reported as missing rather than quietly satisfied.
  assert.deepEqual(nowpaymentsCredentials('sandbox', liveOnly).missing,
    ['NOWPAYMENTS_SANDBOX_API_KEY', 'NOWPAYMENTS_SANDBOX_IPN_SECRET']);
  assert.equal(nowpaymentsCredentials('sandbox', liveOnly).endpoint, 'https://api-sandbox.nowpayments.io/v1');

  const sandboxOnly = { ...SANDBOX_NOW };
  assert.deepEqual(nowpaymentsCredentials('sandbox', sandboxOnly).missing, []);
  assert.deepEqual(nowpaymentsCredentials('live', sandboxOnly).missing, ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET']);
  assert.equal(nowpaymentsCredentials('live', sandboxOnly).endpoint, 'https://api.nowpayments.io/v1');
});

test('a Stripe key whose prefix names the other environment is refused, not used', () => {
  const crossed = { STRIPE_SANDBOX_SECRET_KEY: 'sk_live_misplaced', STRIPE_SANDBOX_WEBHOOK_SECRET: 'whsec_test_fixture' };
  const sandbox = stripeCredentials('sandbox', crossed);
  assert.equal(sandbox.secretKey, '', 'a live key is never sent to the sandbox endpoint');
  assert.deepEqual(sandbox.missing, ['STRIPE_SANDBOX_SECRET_KEY']);
  assert.match(sandbox.note, /never sent to the sandbox endpoint/);

  const live = stripeCredentials('live', { STRIPE_LIVE_SECRET_KEY: 'sk_test_misplaced', STRIPE_WEBHOOK_SECRET: 'whsec_live_fixture' });
  assert.equal(live.secretKey, '');
  assert.deepEqual(live.missing, ['STRIPE_LIVE_SECRET_KEY']);
  assert.match(live.note, /never sent to the live endpoint/);
});

test('the unsuffixed STRIPE_SECRET_KEY joins the environment its own prefix names', () => {
  const legacy = { STRIPE_SECRET_KEY: 'sk_test_legacy', STRIPE_WEBHOOK_SECRET: 'whsec_legacy' };
  const sandbox = stripeCredentials('sandbox', legacy);
  assert.equal(sandbox.secretKey, 'sk_test_legacy');
  assert.equal(sandbox.webhookSecret, 'whsec_legacy', 'the unsuffixed webhook secret follows its key');
  assert.deepEqual(sandbox.missing, []);

  // An older deployment keeps working without the settings screen telling a lie: the key satisfies
  // sandbox and leaves live unconfigured, which is what the owner has to be told. The webhook secret is
  // present under its live name, so it is not what is missing - the key is.
  const live = stripeCredentials('live', legacy);
  assert.equal(live.secretKey, '');
  assert.deepEqual(live.missing, ['STRIPE_LIVE_SECRET_KEY']);
});

test('with nothing saved, the environment and the providers are derived from the credentials present', () => {
  const empty = derivePaymentConfig({}, {});
  assert.equal(empty.environment, 'sandbox', 'nothing configured cannot charge a card');
  assert.equal(empty.source, 'environment');
  assert.deepEqual(empty.providers, { nowpayments: true, stripe: false });
  assert.deepEqual(empty.methods, ['nowpayments']);

  const live = derivePaymentConfig({}, { ...LIVE_STRIPE });
  assert.equal(live.environment, 'live');
  assert.deepEqual(live.providers, { nowpayments: false, stripe: true });
  assert.deepEqual(live.methods, ['stripe']);
});

test('a saved preference wins, and a method of a switched-off provider is dropped', () => {
  const saved = derivePaymentConfig({
    environment: 'live',
    providers: { nowpayments: false, stripe: true },
    methods: ['nowpayments', 'stripe', 'card'],
  }, { ...LIVE_STRIPE });
  assert.equal(saved.source, 'database');
  assert.equal(saved.environment, 'live');
  assert.deepEqual(saved.methods, ['stripe']);
  assert.equal(saved.configured.stripe, true);
});

test('the saved form may not offer a provider that is switched off', () => {
  // Offering a switched-off provider is how money arrives through a channel the owner believes is
  // closed, so it is refused instead of filtered out silently.
  assert.throws(
    () => validatePaymentConfigInput({ environment: 'live', providers: { nowpayments: true, stripe: false }, methods: ['card'] }),
    (error) => error.status === 400 && /Stripe \(Card\) can only be offered at checkout while it is switched on/.test(error.message),
  );
  assert.throws(
    () => validatePaymentConfigInput({ providers: {}, methods: [] }),
    (error) => error.status === 400 && /Choose the payment environment/.test(error.message),
  );
  assert.throws(
    () => validatePaymentConfigInput({ environment: 'live', providers: { nowpayments: true }, methods: [] }),
    (error) => error.status === 400 && /at least one payment method/.test(error.message),
  );
  assert.throws(
    () => validatePaymentConfigInput({ environment: 'live', providers: { nowpayments: true }, methods: ['paypal'] }),
    (error) => error.status === 400 && /Unknown payment method "paypal"/.test(error.message),
  );
});

test('only the three switches are stored, so a pasted key cannot reach the database', () => {
  const saved = validatePaymentConfigInput({
    environment: 'production',
    providers: { nowpayments: true, stripe: true },
    methods: ['card', 'usdt', 'card'],
    secret_key: 'sk_live_pasted_by_mistake',
    apiKey: 'live-key',
  });
  assert.deepEqual(Object.keys(saved).sort(), ['environment', 'methods', 'providers']);
  assert.equal(saved.environment, 'live');
  assert.deepEqual(saved.methods, ['stripe', 'nowpayments'], 'aliases land on their provider and duplicates collapse');
  assert.ok(!JSON.stringify(saved).includes('pasted_by_mistake'));

  assert.equal(normalizeProvider('USDT'), 'nowpayments');
  assert.equal(normalizeProvider('card'), 'stripe');
  assert.equal(normalizeProvider('paypal'), '');
});

test('planCheckout refuses a checkout it could not confirm, with a status that names the fix', () => {
  const off = config({ providers: { nowpayments: false, stripe: false }, methods: [] });
  assert.throws(() => planCheckout(off, '', {}),
    (error) => error.status === 503 && /Payments are switched off/.test(error.message));

  assert.throws(() => planCheckout(config(), 'paypal', {}),
    (error) => error.status === 400 && /Unknown payment method/.test(error.message));

  assert.throws(() => planCheckout(config({ providers: { nowpayments: true, stripe: false } }), 'stripe', {}),
    (error) => error.status === 400 && /Stripe is switched off/.test(error.message));

  const notOffered = config({ providers: { nowpayments: true, stripe: true }, methods: ['stripe'] });
  assert.throws(() => planCheckout(notOffered, 'nowpayments', LIVE_NOW),
    (error) => error.status === 400 && /not offered at checkout/.test(error.message));

  // Offered and switched on, but no credentials for this environment: a deployment problem, and the
  // message has to name the variables rather than send the owner hunting.
  assert.throws(() => planCheckout(notOffered, 'stripe', {}),
    (error) => error.status === 501 && /STRIPE_LIVE_SECRET_KEY/.test(error.message));
});

test('with no method requested, the first configured offered method wins', () => {
  const both = config({ providers: { nowpayments: true, stripe: true }, methods: ['nowpayments', 'stripe'] });
  // No NOWPayments keys on this server, so the card processor is the only channel that can charge.
  const chosen = planCheckout(both, '', { ...LIVE_STRIPE });
  assert.equal(chosen.provider, 'stripe');
  assert.equal(chosen.environment, 'live');
  assert.equal(chosen.credentials.endpoint, 'https://api.stripe.com/v1');

  const sandbox = planCheckout(
    config({ environment: 'sandbox', providers: { nowpayments: true, stripe: false }, methods: ['nowpayments'] }),
    'usdt',
    { ...SANDBOX_NOW },
  );
  assert.equal(sandbox.provider, 'nowpayments');
  assert.equal(sandbox.credentials.endpoint, 'https://api-sandbox.nowpayments.io/v1');
  assert.equal(sandbox.environment, 'sandbox');
});

test('a probe tells a working key from a key that belongs to the other environment', async () => {
  const calls = [];
  const fake = (payload, status = 200) => async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: status < 400, status, json: async () => payload };
  };

  const live = await probeProvider('stripe', 'live', { ...LIVE_STRIPE }, fake({ livemode: true }));
  assert.equal(live.ok, true);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/balance');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk_live_fixture');

  // A live key answering while sandbox was selected: "the variable is set" is not "the key works".
  const crossed = await probeProvider('stripe', 'sandbox', { ...SANDBOX_STRIPE }, fake({ livemode: true }));
  assert.equal(crossed.ok, false);
  assert.match(crossed.detail, /does not belong to this environment/);

  const now = await probeProvider('nowpayments', 'sandbox', { ...SANDBOX_NOW }, fake({ message: 'OK' }));
  assert.equal(now.ok, true);
  assert.equal(calls[calls.length - 1].url, 'https://api-sandbox.nowpayments.io/v1/status');
  assert.equal(calls[calls.length - 1].options.headers.Authorization, undefined, 'GET /status needs no key');

  const missing = await probeProvider('stripe', 'live', {}, fake({}));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /Not configured: STRIPE_LIVE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/);

  const refused = await probeProvider('nowpayments', 'live', { ...LIVE_NOW }, fake({ message: 'nope' }, 401));
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /HTTP 401/);
});


test('a transaction remembers the environment it was opened in, and rows written before this feature are live', () => {
  assert.equal(transactionEnvironment(null), 'live');
  assert.equal(transactionEnvironment({}), 'live');
  assert.equal(transactionEnvironment({ marker: 'anything' }), 'live', 'legacy rows were all live orders');
  assert.equal(transactionEnvironment({ environment: 'sandbox' }), 'sandbox');
  assert.equal(transactionEnvironment({ environment: 'production' }), 'live');

  assert.equal(environmentMatches({ environment: 'sandbox' }, 'sandbox'), true);
  assert.equal(environmentMatches({ environment: 'sandbox' }, 'live'), false);
  // The dangerous direction: a sandbox-signed callback reaching a live order.
  assert.equal(environmentMatches({ gateway: 'stripe' }, 'sandbox'), false);

  const mismatch = environmentMismatchError({ environment: 'live' }, 'sandbox');
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.message, /opened in the live environment/);
  assert.match(mismatch.message, /verified with sandbox credentials/);
});

test('the settings payload names variables and never carries one', () => {
  const env = { ...LIVE_STRIPE, STRIPE_SECRET_KEY: 'sk_live_sentinel' };
  const derived = derivePaymentConfig({
    environment: 'live',
    providers: { nowpayments: true, stripe: true },
    methods: ['nowpayments', 'stripe'],
  }, env);
  const payload = publicPaymentConfig(derived, { origin: 'https://example.test', env });
  const json = JSON.stringify(payload);
  for (const secret of Object.values(env)) {
    assert.ok(!json.includes(secret), `${secret} must not reach a browser`);
  }
  assert.ok(json.includes('STRIPE_LIVE_SECRET_KEY'), 'the absent variable is still named');
  assert.equal(payload.environment_label, 'Live / production');
  assert.deepEqual(payload.available_methods, ['stripe'], 'only a configured method is advertised as payable');
  assert.deepEqual(payload.providers.nowpayments.environments.live.missing, ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET']);
  assert.equal(payload.providers.stripe.environments.sandbox.configured, false);
  assert.equal(payload.webhook_urls.stripe, 'https://example.test/api/plugins/rwp-plugin-marketplace/stripe/webhook');
  assert.equal(payload.webhook_urls.nowpayments, 'https://example.test/api/plugins/rwp-plugin-marketplace/crypto/webhook');
  assert.equal(payload.storage_error, '');
});

test('the storefront is told which methods it can be paid with, and why not', () => {
  const env = { ...LIVE_STRIPE };
  const derived = derivePaymentConfig({
    environment: 'live',
    providers: { nowpayments: true, stripe: true },
    methods: ['nowpayments', 'stripe'],
  }, env);

  const options = publicCheckoutOptions(derived, env);
  assert.equal(options.sandbox, false);
  assert.equal(options.environment_label, 'Live');
  assert.deepEqual(options.methods.map((method) => method.id), ['nowpayments', 'stripe']);
  assert.deepEqual(options.methods.map((method) => method.available), [false, true]);
  assert.match(options.methods[0].reason, /not available right now/);
  assert.equal(options.methods[1].label, 'Card');
  // A buyer gets a sentence, not a deployment checklist.
  assert.ok(!JSON.stringify(options).includes('NOWPAYMENTS'), 'no variable name is exposed to the storefront');
});

test('the checks list tells the owner what would happen on the next sale', () => {
  const env = { ...LIVE_STRIPE };
  const checks = paymentChecks(derivePaymentConfig({
    environment: 'live',
    providers: { nowpayments: true, stripe: true },
    methods: ['nowpayments', 'stripe'],
  }, env), env);

  const environment = checks.find((entry) => entry.key === 'environment');
  assert.equal(environment.ok, true);
  assert.match(environment.label, /Environment: Live \/ production/);

  const stripe = checks.find((entry) => entry.key === 'provider:stripe');
  assert.equal(stripe.ok, true);
  assert.match(stripe.detail, /Ready: https:\/\/api\.stripe\.com\/v1/);

  const coin = checks.find((entry) => entry.key === 'provider:nowpayments');
  assert.equal(coin.ok, false);
  assert.match(coin.detail, /Missing NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET/);

  const checkout = checks.find((entry) => entry.key === 'checkout');
  assert.equal(checkout.ok, true, 'one configured method is enough to sell');
  assert.match(checkout.detail, /Offers Stripe \(Card\)/);

  // Nothing switches on, nothing offered: the checkout is closed, and the sentence says so.
  const paused = paymentChecks(config({ providers: { nowpayments: false, stripe: false }, methods: [] }), {});
  assert.equal(paused.find((entry) => entry.key === 'checkout').ok, false);
  assert.match(paused.find((entry) => entry.key === 'checkout').detail, /No method is offered at checkout/);

  // An unsaved environment is derived, and the owner is told why saving matters.
  const derived = paymentChecks(derivePaymentConfig({}, env), env);
  assert.match(derived.find((entry) => entry.key === 'environment').detail, /derived from the credentials/);
});


test('a settings row that predates the column is named as a schema update, not a mystery', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = { supabase: { url: 'https://db.example.test/', secretKey: 'service-role-fixture' } };
  const body = { environment: 'live', providers: { nowpayments: true, stripe: false }, methods: ['nowpayments'] };

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://db.example.test/rest/v1/rwp_marketplace_settings?on_conflict=id');
    assert.equal(options.method, 'POST');
    // Only the three switches are sent, alongside the row's identity: no credential can ride along.
    assert.deepEqual(JSON.parse(options.body), {
      id: true, payment_config: body, updated_by: null,
    });
    return {
      ok: false,
      status: 400,
      text: async () => '{"code":"PGRST204","message":"Could not find the \'payment_config\' column of \'rwp_marketplace_settings\' in the schema cache"}',
    };
  };
  try {
    await assert.rejects(
      () => savePaymentConfig(ctx, body),
      (error) => error.status === 500 && /schema\.sql/.test(error.message) && /payment_config/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Without the service key nothing can be stored at all, and the answer says which variable is missing
  // rather than blaming the table.
  await assert.rejects(
    () => savePaymentConfig({ supabase: { url: 'https://db.example.test', secretKey: '' } }, body),
    (error) => error.status === 501 && /SUPABASE_SECRET_KEY/.test(error.message),
  );
});


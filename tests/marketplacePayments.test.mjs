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
  belowMinimumError, clearNowPaymentsMinimumCache, derivePaymentConfig, environmentMatches,
  environmentMismatchError, minimumUnverifiedError, normalizeProvider, nowPaymentsMinimum, nowPaymentsPayCurrency,
  payCurrencyLabel, paymentChecks, planCheckout, probeProvider, providerCredentials, publicCheckoutOptions,
  publicPaymentConfig, savePaymentConfig, stripeCredentials, nowpaymentsCredentials, transactionEnvironment,
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

/**
 * A NOWPayments API written for the test, answering by path.
 *
 * The minimum check is only worth having if it compares the right units, so the fixture states what the
 * provider would say and each test asserts what the checkout did with it. Nothing here reaches the
 * network: `fetchImpl` is passed in, exactly as `probeProvider` takes one.
 */
const fakeNowPayments = (answers = {}) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/v1/, '').split('?')[0];
    const answer = answers[path] ?? answers.default;
    if (!answer) return { ok: false, status: 404, json: async () => ({ message: 'no route' }) };
    const status = answer.status ?? 200;
    return { ok: status < 400, status, json: async () => answer.body ?? {} };
  };
  return { calls, fetchImpl };
};

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
  const statusCall = calls.find((call) => call.url === 'https://api-sandbox.nowpayments.io/v1/status');
  assert.ok(statusCall, 'the reachability check is a GET /status against the sandbox host');
  assert.equal(statusCall.options.headers.Authorization, undefined, 'GET /status needs no key');

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


// The coin minimum -------------------------------------------------------------
//
// The bug these cover: a $2 listing opened an invoice, NOWPayments refused it on its own page ("Crypto
// amount X is less than minimal"), and the buyer was left on an error screen with a `pending` order behind
// them. The fix is a pre-flight read, so the tests are written around the units, the environment and the
// refusal - not around any particular minimum figure, which changes with the coin and the rate.

test('the coin minimum is compared in the coin own units, and $2 is told it is below it', async () => {
  clearNowPaymentsMinimumCache();
  const api = fakeNowPayments({
    '/estimate': { body: { estimated_amount: 1.98 } },
    '/min-amount': { body: { currency_from: 'usdttrc20', currency_to: 'usdttrc20', min_amount: 10.02 } },
  });

  const read = await nowPaymentsMinimum({
    environment: 'live', payCurrency: 'usdttrc20', amount: 2, env: LIVE_NOW, fetchImpl: api.fetchImpl, cache: false,
  });

  assert.equal(read.verified, true);
  assert.equal(read.verdict, 'below');
  assert.equal(read.source, 'crypto');
  assert.equal(read.payAmount, 1.98, 'what $2 buys');
  assert.equal(read.minAmount, 10.02, 'the coin floor');
  assert.equal(read.minCurrency, 'usdttrc20', 'the floor is in coin units, which is why the estimate is read');
  assert.match(read.detail, /minimum 10\.02 USDT/);
  assert.match(read.detail, /below the minimum/);

  // What $2 buys, then the coin's own floor - never a fiat floor compared against a crypto figure.
  assert.equal(api.calls[0].url, 'https://api.nowpayments.io/v1/estimate?amount=2&currency_from=usd&currency_to=usdttrc20');
  assert.equal(api.calls[1].url, 'https://api.nowpayments.io/v1/min-amount?currency_from=usdttrc20&currency_to=usdttrc20');
  assert.equal(api.calls[0].options.headers['x-api-key'], 'live-key');
});


test('an order at or above the minimum is payable: the comparison is a floor, not a target', async () => {
  clearNowPaymentsMinimumCache();
  const exactly = fakeNowPayments({
    '/estimate': { body: { estimated_amount: 10.02 } },
    '/min-amount': { body: { min_amount: 10.02 } },
  });
  const atFloor = await nowPaymentsMinimum({
    environment: 'live', payCurrency: 'usdttrc20', amount: 10.12, env: LIVE_NOW, fetchImpl: exactly.fetchImpl, cache: false,
  });
  assert.equal(atFloor.verdict, 'ok', 'equality is payable');

  const above = fakeNowPayments({
    '/estimate': { body: { estimated_amount: 50.5 } },
    '/min-amount': { body: { min_amount: 10.02 } },
  });
  const comfortable = await nowPaymentsMinimum({
    environment: 'live', payCurrency: 'usdttrc20', amount: 51, env: LIVE_NOW, fetchImpl: above.fetchImpl, cache: false,
  });
  assert.equal(comfortable.verdict, 'ok');
  assert.equal(comfortable.verified, true);
});

test('with no crypto estimate available the minimum is compared in dollars instead', async () => {
  clearNowPaymentsMinimumCache();
  // No `/estimate` route at all: the fiat pair answers, and `min_amount` then speaks for `currency_from`.
  const api = fakeNowPayments({ '/min-amount': { body: { currency_from: 'usd', min_amount: 12.5 } } });
  const read = await nowPaymentsMinimum({
    environment: 'live', payCurrency: 'usdttrc20', amount: 2, env: LIVE_NOW, fetchImpl: api.fetchImpl, cache: false,
  });

  assert.equal(read.source, 'fiat');
  assert.equal(read.minCurrency, 'usd');
  assert.equal(read.verdict, 'below');
  assert.match(api.calls[1].url, /min-amount\?currency_from=usd&currency_to=usdttrc20&fiat_equivalent=usd$/);
  assert.match(read.detail, /minimum \$12\.50/);
});


test('a minimum that cannot be read is unverified - never "too cheap to sell"', async () => {
  clearNowPaymentsMinimumCache();
  const offline = fakeNowPayments({});
  const read = await nowPaymentsMinimum({
    environment: 'live', payCurrency: 'usdttrc20', amount: 2, env: LIVE_NOW, fetchImpl: offline.fetchImpl, cache: false,
  });

  assert.equal(read.verified, false);
  assert.equal(read.verdict, 'unverified');
  assert.equal(read.minAmount, null);
  assert.match(read.detail, /did not report a minimum/);

  // The checkout refuses rather than opening an invoice that may be rejected on the provider's page, and
  // says a retry is the way forward.
  const refusal = minimumUnverifiedError(read);
  assert.equal(refusal.status, 503);
  assert.match(refusal.message, /could not be confirmed/);
  assert.match(refusal.message, /nothing was charged/);

  // A network error is the same answer as a missing route, not an exception that reaches the buyer.
  const broken = await nowPaymentsMinimum({
    environment: 'live', payCurrency: 'usdttrc20', amount: 2, env: LIVE_NOW, cache: false,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.nowpayments.io'); },
  });
  assert.equal(broken.verdict, 'unverified');
  assert.match(broken.detail, /ENOTFOUND/);
});

test('the minimum is read from the environment host with that environment key, and never without one', async () => {
  clearNowPaymentsMinimumCache();
  const api = fakeNowPayments({
    '/estimate': { body: { estimated_amount: 400 } },
    '/min-amount': { body: { min_amount: 10 } },
  });
  const sandbox = await nowPaymentsMinimum({
    environment: 'sandbox', payCurrency: 'usdttrc20', amount: 20, env: SANDBOX_NOW, fetchImpl: api.fetchImpl, cache: false,
  });
  assert.equal(sandbox.environment, 'sandbox');
  assert.equal(sandbox.verdict, 'ok');
  assert.ok(api.calls.every((call) => call.url.startsWith('https://api-sandbox.nowpayments.io/v1/')),
    'a sandbox check cannot reach the live host');
  assert.ok(api.calls.every((call) => call.options.headers['x-api-key'] === 'sandbox-key'),
    'the sandbox key is the only one sent');

  // No key for the environment: a 501 naming the variable, and not a single request.
  const untouched = fakeNowPayments({ default: { body: {} } });
  await assert.rejects(
    () => nowPaymentsMinimum({ environment: 'sandbox', amount: 2, env: LIVE_NOW, fetchImpl: untouched.fetchImpl }),
    (error) => error.status === 501 && /NOWPAYMENTS_SANDBOX_API_KEY/.test(error.message),
  );
  assert.equal(untouched.calls.length, 0, 'nothing is sent without a key for that environment');
});


test('a repeated read inside the cache window costs the provider nothing', async () => {
  clearNowPaymentsMinimumCache();
  const api = fakeNowPayments({
    '/estimate': { body: { estimated_amount: 1.98 } },
    '/min-amount': { body: { min_amount: 10.02 } },
  });
  const args = { environment: 'live', payCurrency: 'usdttrc20', amount: 2.5, env: LIVE_NOW, fetchImpl: api.fetchImpl };
  const first = await nowPaymentsMinimum(args);
  const sent = api.calls.length;
  const second = await nowPaymentsMinimum(args);

  assert.equal(api.calls.length, sent, 'the second read is served from the cache');
  assert.deepEqual(second, first);
  clearNowPaymentsMinimumCache();
});

test('the refusal a buyer reads names the floor, the amount, and the method that can take it', () => {
  const error = belowMinimumError(
    { pay_currency: 'usdttrc20', amount: 2, minAmount: 10.02, minCurrency: 'usdttrc20', payAmount: 1.98 },
    [{ id: 'stripe', label: 'Card' }],
  );
  assert.equal(error.status, 422, 'its own status, so the buy box can offer a choice');
  assert.match(error.message, /at least 10\.02 USDT/);
  assert.match(error.message, /\$2\.00/);
  assert.match(error.message, /No order was opened and nothing was charged/);
  assert.match(error.message, /Card/);

  // With nothing else to offer, the sentence does not invent an alternative.
  const alone = belowMinimumError({ pay_currency: 'usdttrc20', amount: 2, minAmount: 10.02 }, []);
  assert.match(alone.message, /ask the owner/);
});


test('the sandbox coin is configurable, and the storefront names the coin it will invoice', () => {
  // Live always sells USDT on Tron: a sandbox override must not leak into a real sale.
  assert.equal(nowPaymentsPayCurrency('live', { NOWPAYMENTS_SANDBOX_PAY_CURRENCY: 'usdtton' }), 'usdttrc20');
  assert.equal(nowPaymentsPayCurrency('sandbox', { NOWPAYMENTS_SANDBOX_PAY_CURRENCY: 'USDTTRC20' }), 'usdttrc20');
  assert.equal(nowPaymentsPayCurrency('sandbox', { NOWPAYMENTS_SANDBOX_PAY_CURRENCY: 'usdtton' }), 'usdtton');
  assert.equal(nowPaymentsPayCurrency('sandbox', {}), 'usdttrc20', 'the default stays the documented one');
  assert.equal(payCurrencyLabel('usdtton'), 'USDT (TON)');

  // The invoice body is what NOWPayments bills in, so the environment's coin is what it carries.
  const derived = derivePaymentConfig({ environment: 'sandbox', providers: { nowpayments: true, stripe: false }, methods: ['nowpayments'] },
    { ...SANDBOX_NOW, NOWPAYMENTS_SANDBOX_PAY_CURRENCY: 'usdtton' });
  const options = publicCheckoutOptions(derived, { ...SANDBOX_NOW, NOWPAYMENTS_SANDBOX_PAY_CURRENCY: 'usdtton' });
  assert.equal(options.methods[0].pay_currency, 'usdtton');
  assert.equal(options.methods[0].label, 'USDT (TON)');
  assert.match(options.methods[0].description, /USDT \(TON\)/);
});

test('the storefront says a cheap order cannot be paid in a coin, before the buyer clicks', () => {
  const env = { ...LIVE_NOW, ...LIVE_STRIPE };
  const derived = derivePaymentConfig({
    environment: 'live', providers: { nowpayments: true, stripe: true }, methods: ['nowpayments', 'stripe'],
  }, env);
  const below = { verified: true, verdict: 'below', minAmount: 10.02, minCurrency: 'usdttrc20', payAmount: 1.98 };

  const options = publicCheckoutOptions(derived, env, { price: 2, minimums: { nowpayments: below } });
  assert.equal(options.price, 2, 'the listing price the sentence is about');
  assert.equal(options.methods[0].available, false, 'the coin cannot take this order');
  assert.match(options.methods[0].reason, /needs at least 10\.02 USDT/);
  assert.match(options.methods[0].reason, /\$2\.00/);
  assert.deepEqual(options.methods[0].minimum, { amount: 10.02, currency: 'usdttrc20', pay_amount: 1.98, known: true });
  assert.equal(options.methods[1].available, true, 'the card method can still take it');

  // An unread minimum is not evidence of anything: the method stays offered.
  const unknown = publicCheckoutOptions(derived, env, { price: 2, minimums: { nowpayments: { verified: false, verdict: 'unverified' } } });
  assert.equal(unknown.methods[0].available, true);
  assert.equal(unknown.methods[0].minimum, null);

  // Above the floor, nothing is refused.
  const ok = publicCheckoutOptions(derived, env, {
    price: 51, minimums: { nowpayments: { verified: true, verdict: 'ok', minAmount: 10.02, minCurrency: 'usdttrc20', payAmount: 50.5 } },
  });
  assert.equal(ok.methods[0].available, true);
  assert.equal(ok.methods[0].reason, '');
});

test('the credential check reports the coin minimum, because that is what a cheap listing trips over', async () => {
  clearNowPaymentsMinimumCache();
  const api = fakeNowPayments({
    '/status': { body: { message: 'OK' } },
    '/estimate': { body: { estimated_amount: 1.98 } },
    '/min-amount': { body: { min_amount: 10.02 } },
  });

  const probe = await probeProvider('nowpayments', 'sandbox', { ...SANDBOX_NOW }, api.fetchImpl);
  assert.equal(probe.ok, true);
  assert.match(probe.detail, /Answered|answered/);
  assert.match(probe.detail, /minimum 10\.02 USDT/);
  assert.match(probe.detail, /\$2\.00/);

  const keyed = api.calls.filter((call) => call.url.endsWith('/min-amount?currency_from=usdttrc20&currency_to=usdttrc20'));
  assert.equal(keyed.length, 1, 'one keyed read proves the key, not just the endpoint');
  assert.equal(keyed[0].options.headers['x-api-key'], 'sandbox-key');

  // A key that the keyed read refuses fails the check, even though /status answered.
  const rejected = await probeProvider('nowpayments', 'live', { ...LIVE_NOW }, fakeNowPayments({
    '/status': { body: {} },
    '/estimate': { status: 401, body: {} },
    '/min-amount': { status: 401, body: {} },
  }).fetchImpl);
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /does not work in the live environment/);
});


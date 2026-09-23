const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  useTempStorage,
  useAdminEmails,
  loadFresh,
  writeSettingRaw,
} = require('./helpers');

/*
 * Requiring the cardholder's bank to authenticate.
 *
 * Off by default; on, every card payment asks for 3-D Secure rather than
 * letting Stripe apply its own risk rules. What makes this worth its own file
 * is that the setting does two DIFFERENT things to the two card paths, and the
 * difference is the part that can go quietly wrong:
 *
 *   - a new card is a Checkout Session, and the option is simply added;
 *   - a KEPT card is an off-session PaymentIntent, and the option cannot be
 *     added to it. Asking for a challenge while declaring that nobody is
 *     present is a contradiction Stripe resolves by failing the intent, so
 *     `off_session` has to come OFF. That swap is the claim these tests exist
 *     to pin.
 *
 * Tested at two levels on purpose. The service tests prove the setting is read
 * and handed over; they cannot prove the request body is right, because they
 * replace the whole Stripe integration. So the body tests below stub the
 * global `fetch` instead and read what would actually have gone over the wire -
 * including the form encoding, where a misplaced bracket is a request Stripe
 * accepts and half ignores.
 */

const PRICE_CENTS = 50;

/* ------------------------------------------------- what goes over the wire */

/** Calls `stripe.ts` for real, with only the socket replaced. */
async function captureBody(run) {
  useTempStorage(`three-ds-body-${Math.random().toString(36).slice(2)}`);
  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';

  const stripe = loadFresh('../dist/integrations/stripe');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ id: 'cs_test_1', client_secret: 'cs_test_1_secret' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await run(stripe);
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

const SESSION_INPUT = {
  paymentId: 'pay_1',
  reference: 'FT-PAY-1',
  credits: 100,
  amountCents: 5_000,
  currency: 'usd',
  customerEmail: 'buyer@example.com',
  returnUrl: 'https://app.example.com/credits/return',
};

const CHARGE_INPUT = {
  paymentId: 'pay_2',
  reference: 'FT-PAY-2',
  amountCents: 5_000,
  currency: 'usd',
  customer: 'cus_1',
  paymentMethod: 'pm_1',
  returnUrl: 'https://app.example.com/credits/return',
};

/** The form-encoded key Stripe reads. A bracket out of place is silence. */
const THREE_DS_KEY = 'payment_method_options[card][request_three_d_secure]=any';

test('a new card asks for authentication when the operator requires it', async () => {
  const [call] = await captureBody((stripe) =>
    stripe.createCheckoutSession({ ...SESSION_INPUT, requireThreeDSecure: true })
  );
  const body = decodeURIComponent(call.body);
  assert.ok(body.includes(THREE_DS_KEY), body);
  /*
   * At the session level, NOT inside payment_intent_data.
   *
   * Both read like properties of the intent - `setup_future_usage` is in
   * there - and Stripe accepts the nested spelling without complaint while
   * requiring nothing, so this is the assertion that catches the plausible
   * mistake rather than the obvious one.
   */
  assert.ok(!body.includes('payment_intent_data[payment_method_options]'), body);
});

test('and does not when they have not', async () => {
  const [call] = await captureBody((stripe) => stripe.createCheckoutSession(SESSION_INPUT));
  assert.ok(!decodeURIComponent(call.body).includes('request_three_d_secure'), call.body);
});

test('a kept card gives up its off-session exemption to be authenticated', async () => {
  const [call] = await captureBody((stripe) =>
    stripe.chargeSavedCard({ ...CHARGE_INPUT, requireThreeDSecure: true })
  );
  const body = decodeURIComponent(call.body);
  assert.ok(body.includes(THREE_DS_KEY), body);
  /*
   * The half that matters. Sending both would not produce a challenge - it
   * would fail the intent with `authentication_required`, because Stripe was
   * told in the same breath to ask somebody and that nobody is there.
   */
  assert.ok(!body.includes('off_session'), body);
});

test('and keeps that exemption when authentication is not required', async () => {
  const [call] = await captureBody((stripe) => stripe.chargeSavedCard(CHARGE_INPUT));
  const body = decodeURIComponent(call.body);
  assert.ok(body.includes('off_session=true'), body);
  assert.ok(!body.includes('request_three_d_secure'), body);
});

/* ------------------------------------------ what the service asks for */

async function serve({ requireThreeDSecure = false } = {}) {
  const { dbDir } = useTempStorage(`three-ds-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';
  delete process.env.COINBASE_COMMERCE_API_KEY;
  delete process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  delete process.env.CHAIN_ASSETS;

  // Before anything reads settings: the settings module caches what it sees.
  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: PRICE_CENTS,
      creditMinCredits: 1,
      creditMaxCredits: 100_000,
      paymentLimits: [
        { target: 'card', minCents: 1, maxCents: 1_000_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
      ],
      requireThreeDSecure,
    })
  );

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  loadFresh('../dist/database/paymentRepository');
  const cards = loadFresh('../dist/database/savedCardRepository');
  loadFresh('../dist/config/aiModelConfig');

  const stripe = loadFresh('../dist/integrations/stripe');
  const calls = { sessions: [], charges: [] };
  stripe.createCheckoutSession = async (input) => {
    calls.sessions.push(input);
    return { id: 'cs_test_1', client_secret: 'cs_test_1_secret' };
  };
  stripe.chargeSavedCard = async (input) => {
    calls.charges.push(input);
    return { id: 'pi_saved_1', status: 'succeeded' };
  };
  loadFresh('../dist/integrations/coinbaseCommerce');

  loadFresh('../dist/services/payments/pricing');
  loadFresh('../dist/services/payments');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/payments');
  const admin = loadFresh('../dist/routes/admin');

  const alice = users.createUser({ email: 'alice@example.com' });
  // Named in ADMIN_EMAILS above, so this account may save settings.
  const boss = users.createUser({ email: 'boss@example.com' });
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/payments', routes.default);
  app.use('/api/admin', admin.default);
  const server = app.listen(0);
  const port = server.address().port;
  const token = users.createSession(alice.id);
  const bossToken = users.createSession(boss.id);

  const call = (path, init = {}, as = token) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}`, ...(init.headers ?? {}) },
    });

  return {
    calls,
    cards,
    alice,
    close: () => server.close(),
    call,
    bossToken,
    saveSetting: (value) =>
      call('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ requireThreeDSecure: value }) }, bossToken),
    checkout: (body) => call('/api/payments/checkout', { method: 'POST', body: JSON.stringify(body) }),
  };
}

test('the setting reaches a new-card checkout', async () => {
  const server = await serve({ requireThreeDSecure: true });
  try {
    assert.equal((await server.checkout({ method: 'card', credits: 10 })).status, 201);
    assert.equal(server.calls.sessions[0].requireThreeDSecure, true);
  } finally {
    server.close();
  }
});

test('and is absent from it when the operator has not asked', async () => {
  const server = await serve();
  try {
    assert.equal((await server.checkout({ method: 'card', credits: 10 })).status, 201);
    assert.equal(server.calls.sessions[0].requireThreeDSecure, undefined);
  } finally {
    server.close();
  }
});

test('the setting reaches a kept card too, so the two paths agree', async () => {
  const server = await serve({ requireThreeDSecure: true });
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_1',
      methodRef: 'pm_1',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    });
    const response = await server.checkout({ method: 'card', credits: 10, cardId: card.id });
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
    assert.equal(server.calls.charges[0].requireThreeDSecure, true);
  } finally {
    server.close();
  }
});

test('the buy page is told, so it can warn before the challenge', async () => {
  const server = await serve({ requireThreeDSecure: true });
  try {
    const body = await (await server.call('/api/payments/methods')).json();
    assert.equal(body.requireThreeDSecure, true);
  } finally {
    server.close();
  }
});

test('saving it through the admin page actually persists it', async () => {
  /*
   * Through the real PUT, not by writing the row.
   *
   * This is the path where a settings field goes missing: `updateAppSettings`
   * merges the patch over the current settings and then NORMALIZES, so a field
   * the normalizer does not know about is dropped on the way past. The admin
   * page reports a successful save and the toggle springs back off the next
   * time it loads, with nothing in any log to say why.
   */
  const server = await serve();
  try {
    assert.equal((await (await server.call('/api/payments/methods')).json()).requireThreeDSecure, false);

    const saved = await server.saveSetting(true);
    const body = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(body));
    // The route answers with the settings it stored, so this is the value the
    // admin page will re-render from rather than a hopeful echo of the input.
    assert.equal(body.requireThreeDSecure, true);

    // And it is what the buy page is served from then on.
    assert.equal((await (await server.call('/api/payments/methods')).json()).requireThreeDSecure, true);

    // Off again, so the switch is a switch rather than a one-way door.
    await server.saveSetting(false);
    assert.equal((await (await server.call('/api/payments/methods')).json()).requireThreeDSecure, false);
  } finally {
    server.close();
  }
});

test('an ordinary account cannot turn it on', async () => {
  const server = await serve();
  try {
    const refused = await server.call('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ requireThreeDSecure: true }),
    });
    assert.equal(refused.status, 403);
    assert.equal((await (await server.call('/api/payments/methods')).json()).requireThreeDSecure, false);
  } finally {
    server.close();
  }
});

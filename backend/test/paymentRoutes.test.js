const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * Starting a checkout, and reading a payment back.
 *
 * The claim that matters most here is about PRICE: the browser sends a count of
 * credits and never an amount, so no request can set what it will be charged.
 * The tests below send an amount anyway, in every spelling somebody might try,
 * and assert it changed nothing.
 *
 * The second claim is the usual one about ids in paths - somebody else's
 * payment answers 404, not 403, because the difference between those two
 * replies confirms it exists.
 *
 * The provider is faked at the integration boundary rather than over the
 * network: these are tests about this server's rules, not about Stripe's.
 */

const PRICE_CENTS = 50;

async function serve({ withKeys = true, settings = {} } = {}) {
  const { dbDir } = useTempStorage(`payment-routes-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  if (withKeys) {
    process.env.STRIPE_SECRET_KEY = 'sk_test_key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.COINBASE_COMMERCE_API_KEY = 'cb_key';
    process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = 'cb_secret';
  } else {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.COINBASE_COMMERCE_API_KEY;
    delete process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  }
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';

  // Before anything reads settings: the settings module caches what it sees.
  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: PRICE_CENTS,
      creditMinCredits: 10,
      creditMaxCredits: 1000,
      ...settings,
    })
  );

  const express = require('express');

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/config/aiModelConfig');

  // The provider boundary, replaced before the service that calls it is loaded.
  const stripe = loadFresh('../dist/integrations/stripe');
  const created = [];
  stripe.createCheckoutSession = async (input) => {
    created.push(input);
    return { id: `cs_test_${created.length}`, url: `https://checkout.example/${created.length}` };
  };
  const coinbase = loadFresh('../dist/integrations/coinbaseCommerce');
  coinbase.createCharge = async (input) => {
    created.push(input);
    return { id: 'ch_1', code: `CODE${created.length}`, hosted_url: 'https://commerce.example/1' };
  };

  loadFresh('../dist/services/payments/pricing');
  loadFresh('../dist/services/payments');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/payments');

  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const admin = users.createUser({ email: 'boss@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/payments', routes.default);
  app.use('/api/admin/payments', routes.adminPaymentsRouter);
  const server = app.listen(0);
  const port = server.address().port;

  const call = (token, path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  return {
    users,
    payments,
    created,
    alice,
    bob,
    aliceToken: users.createSession(alice.id),
    bobToken: users.createSession(bob.id),
    adminToken: users.createSession(admin.id),
    close: () => server.close(),
    call,
    checkout: (token, body) =>
      call(token, '/api/payments/checkout', { method: 'POST', body: JSON.stringify(body) }),
  };
}

test('the price comes from settings, and an amount in the request is ignored', async () => {
  const server = await serve();
  try {
    // Every spelling of "let me set my own price". None of them may land.
    const response = await server.checkout(server.aliceToken, {
      method: 'card',
      credits: 20,
      amount: 1,
      amountCents: 1,
      unitPriceCents: 1,
      price: 0,
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.credits, 20);
    assert.equal(body.amountCents, 20 * PRICE_CENTS, 'priced by the server, from settings');

    // And the provider was asked for that amount, not the one in the request.
    assert.equal(server.created[0].amountCents, 20 * PRICE_CENTS);

    const stored = server.payments.getPayment(body.paymentId);
    assert.equal(stored.amountCents, 20 * PRICE_CENTS);
    assert.equal(stored.unitPriceCents, PRICE_CENTS);
    assert.equal(stored.state, 'pending', 'nothing is paid until a webhook says so');
  } finally {
    server.close();
  }
});

test('a credit count that is not a whole number inside the bounds is refused', async () => {
  const server = await serve();
  try {
    const cases = [
      [0, /smallest purchase/i],
      [-5, /smallest purchase/i],
      [9, /smallest purchase/i],
      [1001, /largest purchase/i],
      [2.5, /whole number/i],
      ['lots', /whole number/i],
      [null, /whole number/i],
      [1e21, /whole number|largest/i],
    ];

    for (const [credits, expected] of cases) {
      const response = await server.checkout(server.aliceToken, { method: 'card', credits });
      assert.equal(response.status, 400, `credits=${credits}`);
      assert.match((await response.json()).error, expected, `credits=${credits}`);
    }

    assert.equal(server.payments.listPaymentsForUser(server.alice.id).length, 0, 'nothing was recorded');
  } finally {
    server.close();
  }
});

test('the stored unit price is the price at purchase, not the price today', async () => {
  const server = await serve();
  try {
    const first = await (await server.checkout(server.aliceToken, { method: 'card', credits: 10 })).json();

    const config = require('../dist/config/aiModelConfig');
    await config.updateAppSettings({ creditPriceCents: 200 });

    const second = await (await server.checkout(server.aliceToken, { method: 'card', credits: 10 })).json();

    assert.equal(server.payments.getPayment(first.paymentId).unitPriceCents, PRICE_CENTS);
    assert.equal(server.payments.getPayment(second.paymentId).unitPriceCents, 200);
    assert.equal(
      server.payments.getPayment(first.paymentId).amountCents,
      10 * PRICE_CENTS,
      'a receipt says what was actually paid'
    );
  } finally {
    server.close();
  }
});

test('a method with no keys is not offered and cannot be checked out', async () => {
  const server = await serve({ withKeys: false });
  try {
    const methods = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    assert.equal(methods.methods.every((entry) => entry.available === false), true);
    // The reason is for the operator: "no button" tells them nothing.
    assert.match(methods.methods[0].reason, /STRIPE_SECRET_KEY/);

    const response = await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not set up/i);
  } finally {
    server.close();
  }
});

test('an unknown method is refused before anything is recorded', async () => {
  const server = await serve();
  try {
    for (const method of ['bank', '', null, 'CARD']) {
      const response = await server.checkout(server.aliceToken, { method, credits: 20 });
      assert.equal(response.status, 400, `method=${method}`);
    }
    assert.equal(server.payments.listPaymentsForUser(server.alice.id).length, 0);
  } finally {
    server.close();
  }
});

test('a payment belongs to one account, and nobody else can read it', async () => {
  const server = await serve();
  try {
    const created = await (await server.checkout(server.aliceToken, { method: 'card', credits: 20 })).json();
    const path = `/api/payments/${created.paymentId}`;

    assert.equal((await server.call(null, path)).status, 401);

    const asBob = await server.call(server.bobToken, path);
    assert.equal(asBob.status, 404, 'somebody else gets 404, never 403');

    assert.equal((await server.call(server.aliceToken, path)).status, 200);

    // And the list is scoped without being asked.
    const bobsList = await (await server.call(server.bobToken, '/api/payments')).json();
    assert.deepEqual(bobsList.payments, []);
  } finally {
    server.close();
  }
});

test('the methods endpoint reports the price a checkout would charge', async () => {
  const server = await serve();
  try {
    const body = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    assert.equal(body.unitPriceCents, PRICE_CENTS);
    assert.equal(body.minCredits, 10);
    assert.equal(body.maxCredits, 1000);
    assert.equal(body.currency, 'usd');

    // The page cannot show a price the server would not charge, because it is
    // the same number from the same place.
    const created = await (await server.checkout(server.aliceToken, { method: 'card', credits: 30 })).json();
    assert.equal(created.amountCents, 30 * body.unitPriceCents);
  } finally {
    server.close();
  }
});

test('only an administrator sees every payment', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
    await server.checkout(server.bobToken, { method: 'card', credits: 30 });

    assert.equal((await server.call(server.aliceToken, '/api/admin/payments')).status, 403);
    assert.equal((await server.call(null, '/api/admin/payments')).status, 401);

    const body = await (await server.call(server.adminToken, '/api/admin/payments')).json();
    assert.equal(body.payments.length, 2);
    // The email is what an operator has in front of them when somebody writes in.
    assert.deepEqual(
      body.payments.map((payment) => payment.userEmail).sort(),
      ['alice@example.com', 'bob@example.com']
    );
  } finally {
    server.close();
  }
});

test('a checkout the provider refuses leaves no payment anybody could complete', async () => {
  const server = await serve();
  try {
    const stripe = require('../dist/integrations/stripe');
    stripe.createCheckoutSession = async () => {
      throw new stripe.StripeError('Your card provider is unavailable.');
    };

    const response = await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
    assert.equal(response.status, 502);

    // The row survives as a record that it was attempted, but closed - a
    // pending row here would look like something still completable.
    const [payment] = server.payments.listPaymentsForUser(server.alice.id);
    assert.equal(payment.state, 'failed');
    assert.match(payment.failure, /unavailable/i);
  } finally {
    server.close();
  }
});

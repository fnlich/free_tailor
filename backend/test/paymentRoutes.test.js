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
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
    process.env.COINBASE_COMMERCE_API_KEY = 'cb_key';
    process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = 'cb_secret';
  } else {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
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
  // Reloaded in dependency order: a module that keeps the previous test's
  // sqlite handle writes to the previous test's database.
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/config/aiModelConfig');

  // The provider boundary, replaced before the service that calls it is loaded.
  const stripe = loadFresh('../dist/integrations/stripe');
  const created = [];
  stripe.createCheckoutSession = async (input) => {
    created.push(input);
    return { id: `cs_test_${created.length}`, client_secret: `cs_test_${created.length}_secret` };
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
      // Stripe's own refusals quote back what they were sent, including the
      // tail of the API key. This is the shape of a real one.
      throw new stripe.StripeError('Invalid API Key provided: sk_live_****************abcd');
    };

    const response = await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
    assert.equal(response.status, 502);
    assert.doesNotMatch((await response.json()).error, /sk_live/, 'not told to the buyer either');

    // The row survives as a record that it was attempted, but closed - a
    // pending row here would look like something still completable.
    const [payment] = server.payments.listPaymentsForUser(server.alice.id);
    assert.equal(payment.state, 'failed');
    /*
     * A fixed sentence, not the provider's.
     *
     * `failure` is served to whoever clicked Buy, on their own return page. An
     * operator's misconfiguration must not turn into a customer's view of a
     * secret, so the detail goes to the log and the row gets something safe.
     */
    assert.doesNotMatch(payment.failure, /sk_live/);
    assert.match(payment.failure, /would not open a checkout page/i);
  } finally {
    server.close();
  }
});

test('a credit count with anything else in it is refused', async () => {
  const server = await serve();
  try {
    // `parseFloat` reads every one of these as a number, which would mean a
    // purchase nobody asked for at a price nobody was shown.
    for (const credits of ['20abc', '2e1', '', ' ', '0x14', 'twenty', null, {}, [20]]) {
      const response = await server.checkout(server.aliceToken, { method: 'card', credits });
      assert.equal(response.status, 400, `${JSON.stringify(credits)} was accepted`);
    }

    // The two spellings that ARE a count still work.
    assert.equal((await server.checkout(server.aliceToken, { method: 'card', credits: 20 })).status, 201);
    assert.equal(
      (await server.checkout(server.aliceToken, { method: 'card', credits: ' 20 ' })).status,
      201
    );
  } finally {
    server.close();
  }
});

test('an account cannot open unlimited checkouts', async () => {
  const server = await serve();
  try {
    /*
     * Each of these is a call to a payment provider, so a loop here is a loop
     * on somebody else's bill. Abandoning a checkout is ordinary, so the limit
     * is generous - it is here to stop a script, not a person.
     */
    let refused = null;
    for (let attempt = 0; attempt < 25 && refused === null; attempt += 1) {
      const response = await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
      if (response.status !== 201) refused = response;
    }

    assert.ok(refused, 'the endpoint never refused');
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /too many checkouts/i);

    // And it is per account, not global: the limit must not lock everybody out.
    assert.equal((await server.checkout(server.bobToken, { method: 'card', credits: 20 })).status, 201);
  } finally {
    server.close();
  }
});

test('the payment form is ours: a checkout returns a client secret, not a redirect', async () => {
  const server = await serve();
  try {
    const response = await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
    assert.equal(response.status, 201);
    const body = await response.json();

    /*
     * The whole point of the embedded form: nothing sends the customer away.
     * A client secret identifies a checkout session and authorises nothing on
     * its own - it is what the Payment Element in the browser initialises with.
     */
    assert.match(body.clientSecret, /^cs_test_\d+_secret$/);
    assert.equal(body.redirectUrl, undefined, 'nothing to redirect to');

    // And the session was asked for in elements mode, with somewhere to come
    // back to for the methods that DO leave the page (3-D Secure, stablecoins).
    const asked = server.created[0];
    assert.match(asked.returnUrl, /^https:\/\/app\.example\.com\/credits\/return\?payment=pay_/);
    assert.equal(asked.successUrl, undefined, 'the hosted-page parameters are gone');
  } finally {
    server.close();
  }
});

test('the buy page is given the publishable key it needs to mount the form', async () => {
  const server = await serve();
  try {
    const methods = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    // Served rather than baked into the frontend build: publishable keys are
    // safe to hand out, and this keeps every Stripe value in the one .env.
    assert.equal(methods.publishableKey, 'pk_test_key');
  } finally {
    server.close();
  }
});

test('without the publishable key the card method is withheld', async () => {
  const server = await serve();
  try {
    // A secret key and a webhook secret are not enough now: with no publishable
    // key the form cannot mount, so the button would lead to an empty box.
    delete process.env.STRIPE_PUBLISHABLE_KEY;

    const methods = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    const card = methods.methods.find((entry) => entry.method === 'card');
    assert.equal(card.available, false);
    assert.match(card.reason, /STRIPE_PUBLISHABLE_KEY/);
    assert.equal(methods.publishableKey, '', 'and no half-configured key is handed out');

    const response = await server.checkout(server.aliceToken, { method: 'card', credits: 20 });
    assert.equal(response.status, 503);
  } finally {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
    server.close();
  }
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * Starting a checkout, and reading a payment back.
 *
 * The claim that matters most here is about the AMOUNT: a credit is a dollar,
 * the browser sends the dollars it wants (`amountUsd`) and the server decides
 * whether that may be bought and what the provider is asked for - so no other
 * field in a request can change what it will be charged or credited. The
 * tests below send other amounts anyway, in every spelling somebody might try,
 * and assert they changed nothing.
 *
 * The second claim is the usual one about ids in paths - somebody else's
 * payment answers 404, not 403, because the difference between those two
 * replies confirms it exists.
 *
 * The provider is faked at the integration boundary rather than over the
 * network: these are tests about this server's rules, not about Stripe's.
 */

async function serve({ withKeys = true, settings = {}, returnUrl = 'https://app.example.com', appUrl = null } = {}) {
  const { dbDir } = useTempStorage(`payment-routes-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  if (withKeys) {
    process.env.STRIPE_SECRET_KEY = 'sk_test_key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
    process.env.CRYPTOMUS_MERCHANT_ID = 'merchant-uuid';
    process.env.CRYPTOMUS_PAYMENT_API_KEY = 'payment-api-key';
  } else {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.CRYPTOMUS_MERCHANT_ID;
    delete process.env.CRYPTOMUS_PAYMENT_API_KEY;
  }
  // Each rung of the return-URL chain is set explicitly, including to nothing,
  // so a test for one of them cannot be answered by another left over from the
  // process it is running in.
  if (returnUrl) process.env.PAYMENTS_RETURN_URL = returnUrl;
  else delete process.env.PAYMENTS_RETURN_URL;
  if (appUrl) process.env.APP_URL = appUrl;
  else delete process.env.APP_URL;
  delete process.env.FRONTEND_URL;

  // Before anything reads settings: the settings module caches what it sees.
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify(settings));

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
  const cryptomus = loadFresh('../dist/integrations/cryptomus');
  cryptomus.createInvoice = async (input) => {
    created.push(input);
    return {
      uuid: `inv-${created.length}`,
      order_id: input.paymentId,
      url: `https://pay.cryptomus.com/inv-${created.length}`,
    };
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
    checkout: (token, body, init = {}) =>
      call(token, '/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify(body),
        ...init,
      }),
  };
}

test('the amount asked for is what is charged and credited, and every other figure in the request is ignored', async () => {
  const server = await serve();
  try {
    // Every spelling of "let me set my own terms". None of them may land.
    const response = await server.checkout(server.aliceToken, {
      method: 'card',
      amountUsd: '10',
      amount: 1,
      amountCents: 1,
      amountMilli: 1,
      creditMilli: 1_000_000,
      unitPriceCents: 1,
      price: 0,
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.amountMilli, 10_000, '$10, as asked');
    assert.equal(body.creditMilli, 10_000, 'credited exactly the charge');

    // And the provider was asked for that amount, not any other in the request.
    assert.equal(server.created[0].amountCents, 1_000);

    const stored = server.payments.getPayment(body.paymentId);
    assert.equal(stored.amountCents, 1_000);
    assert.equal(stored.creditMilli, 10_000);
    assert.equal(stored.legacyCredits, null);
    assert.equal(stored.state, 'pending', 'nothing is paid until a webhook says so');
  } finally {
    server.close();
  }
});

test('an amount that is not dollars and cents inside the bounds is refused', async () => {
  const server = await serve();
  try {
    const cases = [
      [0, /dollars and cents/i],
      [-5, /dollars and cents/i],
      ['2.49', /smallest card purchase is \$2\.5\./i],
      ['100.01', /largest card purchase is \$100\./i],
      ['2.505', /dollars and cents/i],
      ['lots', /dollars and cents/i],
      [null, /dollars and cents/i],
      [1e21, /dollars and cents/i],
    ];

    for (const [amountUsd, expected] of cases) {
      const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd });
      assert.equal(response.status, 400, `amountUsd=${amountUsd}`);
      assert.match((await response.json()).error, expected, `amountUsd=${amountUsd}`);
    }

    assert.equal(server.payments.listPaymentsForUser(server.alice.id).length, 0, 'nothing was recorded');
  } finally {
    server.close();
  }
});

test('a payment read back carries every amount in thousandths of a dollar, and nothing in credits', async () => {
  const server = await serve();
  try {
    const created = await (await server.checkout(server.aliceToken, { method: 'card', amountUsd: '12.34' })).json();
    const { payment } = await (await server.call(server.aliceToken, `/api/payments/${created.paymentId}`)).json();
    assert.equal(payment.amountMilli, 12_340);
    assert.equal(payment.creditMilli, 12_340);
    assert.equal(payment.creditedMilli, 0, 'nothing credited until the webhook');
    assert.equal(payment.refundedMilli, 0);
    assert.equal(payment.feeMilli, 0);
    assert.equal(payment.legacyCredits, null);
    for (const retired of ['credits', 'creditsGranted', 'refundedCredits', 'unitPriceCents', 'amountCents', 'feeCents']) {
      assert.equal(retired in payment, false, `${retired} is not sent`);
    }
  } finally {
    server.close();
  }
});

test('a method with no keys is not offered and cannot be checked out', async () => {
  const server = await serve({ withKeys: false });
  try {
    const methods = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    assert.equal(methods.methods.every((entry) => entry.available === false), true);
    // The reason is for the operator: "no button" tells them nothing - and a
    // buyer can do nothing with the names of the server's variables.
    assert.equal(methods.methods[0].reason, 'Not available right now.');
    assert.doesNotMatch(JSON.stringify(methods), /STRIPE_|CRYPTOMUS_/);
    const asAdmin = await (await server.call(server.adminToken, '/api/payments/methods')).json();
    assert.match(asAdmin.methods[0].reason, /STRIPE_SECRET_KEY/);

    // A stale tab, or a call made straight to the API: the buyer is pointed at
    // the administrator, and the reason - which names the server's variables -
    // goes to the administrator and the log, under the ref.
    for (const method of ['card', 'crypto']) {
      const response = await server.checkout(server.aliceToken, { method, amountUsd: '10' });
      assert.equal(response.status, 503, method);
      const body = await response.json();
      assert.match(body.error, /payments are not available right now\. Please contact your administrator\./, method);
      assert.match(body.ref, /^ERR-[0-9A-F]{6}$/, method);
      assert.equal(body.detail, undefined, method);
      assert.doesNotMatch(JSON.stringify(body), /STRIPE_|CRYPTOMUS_/, method);
    }
    const asAdminCheckout = await (await server.checkout(server.adminToken, { method: 'card', amountUsd: '10' })).json();
    assert.match(asAdminCheckout.detail, /STRIPE_SECRET_KEY/);
    const asAdminCrypto = await (await server.checkout(server.adminToken, { method: 'crypto', amountUsd: '10' })).json();
    assert.match(asAdminCrypto.detail, /CRYPTOMUS_/);
  } finally {
    server.close();
  }
});

test('an unknown method is refused before anything is recorded', async () => {
  const server = await serve();
  try {
    for (const method of ['bank', '', null, 'CARD']) {
      const response = await server.checkout(server.aliceToken, { method, amountUsd: '10' });
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
    const created = await (await server.checkout(server.aliceToken, { method: 'card', amountUsd: '10' })).json();
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

test('the methods endpoint reports the bounds a checkout is judged by', async () => {
  const server = await serve();
  try {
    const body = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    assert.equal(body.currency, 'usd');
    const card = body.targets.find((target) => target.id === 'card');

    // The page cannot show a bound the server would not apply, because it is
    // the same number from the same place.
    const smallest = await server.checkout(server.aliceToken, { method: 'card', amountUsd: card.minAmountMilli / 1000 });
    assert.equal(smallest.status, 201);
    assert.equal((await smallest.json()).amountMilli, card.minAmountMilli);
  } finally {
    server.close();
  }
});

test('only an administrator sees every payment', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'card', amountUsd: '10' });
    await server.checkout(server.bobToken, { method: 'card', amountUsd: '15' });

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

    const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd: '10' });
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

test('an amount with anything else in it is refused', async () => {
  const server = await serve();
  try {
    // `parseFloat` reads every one of these as a number, which would mean a
    // purchase nobody asked for at an amount nobody was shown.
    for (const amountUsd of ['20abc', '2e1', '', ' ', '0x14', 'twenty', null, {}, [20], '1,000']) {
      const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd });
      assert.equal(response.status, 400, `${JSON.stringify(amountUsd)} was accepted`);
    }

    // The spellings that ARE an amount still work.
    for (const amountUsd of [20, '20', ' 20 ', '20.00', '$20']) {
      const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd });
      assert.equal(response.status, 201, JSON.stringify(amountUsd));
      assert.equal((await response.json()).amountMilli, 20_000);
    }
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
      const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd: '10' });
      if (response.status !== 201) refused = response;
    }

    assert.ok(refused, 'the endpoint never refused');
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /too many checkouts/i);

    // And it is per account, not global: the limit must not lock everybody out.
    assert.equal((await server.checkout(server.bobToken, { method: 'card', amountUsd: '10' })).status, 201);
  } finally {
    server.close();
  }
});

test('the payment form is ours: a checkout returns a client secret, not a redirect', async () => {
  const server = await serve();
  try {
    const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd: '10' });
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

test('the admin list pages past its first two hundred', async () => {
  /*
   * Refunds are driven from a ROW on the admin page, so a payment the page
   * cannot show is a payment nobody can refund. It stopped at the newest 200
   * with no control and no count, while introducing itself as "every credit
   * purchase on this installation" - which on a real install hid 66
   * refundable ones.
   */
  const server = await serve();
  try {
    const wanted = 205;
    for (let i = 0; i < wanted; i += 1) {
      server.payments.createPayment({
        userId: server.alice.id,
        method: 'card',
        provider: 'stripe',
        amountCents: 500,
        creditMilli: 5_000,
        currency: 'usd',
      });
    }

    const first = await (await server.call(server.adminToken, '/api/admin/payments')).json();
    assert.equal(first.payments.length, 200);
    assert.ok(first.total >= wanted, `total ${first.total}`);
    assert.equal(first.offset, 0);

    const second = await (
      await server.call(server.adminToken, '/api/admin/payments?offset=200')
    ).json();
    assert.ok(second.payments.length > 0, 'the second page is empty');
    assert.equal(second.offset, 200);

    // No row appears on both pages: the rowid tiebreak is what guarantees it,
    // because created_at is a second-resolution string and these were all
    // made inside the same second.
    const firstIds = new Set(first.payments.map((p) => p.id));
    const overlap = second.payments.filter((p) => firstIds.has(p.id));
    assert.equal(overlap.length, 0, `${overlap.length} row(s) on both pages`);

    // And between them they reach everything.
    assert.equal(firstIds.size + second.payments.length, Math.min(first.total, 400));
  } finally {
    server.close();
  }
});

test('a junk offset is refused into the first page rather than erroring', async () => {
  const server = await serve();
  try {
    for (const bad of ['-5', 'abc', '', '1e999']) {
      const response = await server.call(
        server.adminToken,
        `/api/admin/payments?offset=${encodeURIComponent(bad)}`
      );
      assert.equal(response.status, 200, `offset=${bad} answered ${response.status}`);
      const body = await response.json();
      assert.ok(body.offset >= 0, `offset=${bad} became ${body.offset}`);
    }
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
    assert.equal(card.reason, 'Not available right now.');
    const asAdmin = await (await server.call(server.adminToken, '/api/payments/methods')).json();
    assert.match(asAdmin.methods.find((entry) => entry.method === 'card').reason, /STRIPE_PUBLISHABLE_KEY/);
    assert.equal(methods.publishableKey, '', 'and no half-configured key is handed out');

    const response = await server.checkout(server.aliceToken, { method: 'card', amountUsd: '10' });
    assert.equal(response.status, 503);
  } finally {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
    server.close();
  }
});

/**
 * Where a buyer is sent after paying somewhere else.
 *
 * 3-D Secure and every crypto invoice leave this site, and the return URL is
 * the only thing that brings the person back. It used to fall through to
 * `http://localhost:3000` whenever neither PAYMENTS_RETURN_URL nor FRONTEND_URL
 * was set - which is exactly the shape of a proxied domain install, where
 * neither is needed for anything else. The credits still landed, because the
 * webhook grants them; the buyer just arrived at their own machine.
 *
 * Note the CORS middleware that vets `Origin` is mounted in `index.ts`, not in
 * this harness, so these tests exercise the plumbing rather than that check.
 */

test('a buyer is sent back to the origin they bought from when nothing names one', async () => {
  const server = await serve({ returnUrl: null });
  try {
    const response = await server.checkout(
      server.aliceToken,
      { method: 'card', amountUsd: '10' },
      { headers: { origin: 'https://example.org' } }
    );
    assert.equal(response.status, 201);

    const [input] = server.created;
    assert.ok(
      input.returnUrl.startsWith('https://example.org/credits/return'),
      `returnUrl was ${input.returnUrl}`
    );
    assert.doesNotMatch(input.returnUrl, /localhost/);
  } finally {
    server.close();
  }
});

test('APP_URL outranks the buyer\'s origin, and PAYMENTS_RETURN_URL outranks both', async () => {
  const viaAppUrl = await serve({ returnUrl: null, appUrl: 'https://configured.example' });
  try {
    await viaAppUrl.checkout(
      viaAppUrl.aliceToken,
      { method: 'card', amountUsd: '10' },
      { headers: { origin: 'https://somewhere-else.example' } }
    );
    assert.ok(
      viaAppUrl.created[0].returnUrl.startsWith('https://configured.example/credits/return'),
      `returnUrl was ${viaAppUrl.created[0].returnUrl}`
    );
  } finally {
    viaAppUrl.close();
  }

  const viaExplicit = await serve({
    returnUrl: 'https://app.example.com',
    appUrl: 'https://configured.example',
  });
  try {
    await viaExplicit.checkout(
      viaExplicit.aliceToken,
      { method: 'card', amountUsd: '10' },
      { headers: { origin: 'https://somewhere-else.example' } }
    );
    // The existing contract: the variable that names this exact thing wins.
    assert.ok(
      viaExplicit.created[0].returnUrl.startsWith('https://app.example.com/credits/return'),
      `returnUrl was ${viaExplicit.created[0].returnUrl}`
    );
  } finally {
    viaExplicit.close();
  }
});

test('an Origin that is not an absolute http(s) origin is ignored, not pasted in', async () => {
  const server = await serve({ returnUrl: null });
  try {
    await server.checkout(
      server.aliceToken,
      { method: 'card', amountUsd: '10' },
      // What a non-browser client, or `Origin: null` from a sandboxed frame,
      // will send. Pasting it in would build a return URL nobody can follow.
      { headers: { origin: 'null' } }
    );
    assert.match(server.created[0].returnUrl, /^http:\/\/localhost:\d+\/credits\/return/);
  } finally {
    server.close();
  }
});

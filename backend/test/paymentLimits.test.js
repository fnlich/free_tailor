const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { useTempStorage, useAdminEmails, loadFresh, writeSettingRaw } = require('./helpers');

/*
 * Each payment method is judged by its own limits, in dollars, and the server
 * decides what the provider is asked for.
 *
 * A credit is a dollar: the buyer chooses an amount of money (`amountUsd`), is
 * charged exactly that and credited exactly that. So a preset is an amount,
 * and nothing about it can be "rounded to a whole number of credits" any more
 * - what is guarded is that the bounds belong to the right method, that a coin
 * may override its own method, that the amount is the one asked for in whole
 * cents, and that nothing else in a request body can steer what is charged.
 */

async function serve({ settings = {} } = {}) {
  const { dbDir } = useTempStorage(`payment-limits-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
  process.env.CRYPTOMUS_MERCHANT_ID = 'merchant-uuid';
  process.env.CRYPTOMUS_PAYMENT_API_KEY = 'payment-api-key';
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';

  // Before anything reads settings: the settings module caches what it sees.
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify(settings));

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/database/savedCardRepository');
  loadFresh('../dist/config/aiModelConfig');

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

  const pricing = loadFresh('../dist/services/payments/pricing');
  loadFresh('../dist/services/payments');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/payments');

  const alice = users.createUser({ email: 'alice@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/payments', routes.default);
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
    pricing,
    created,
    alice,
    aliceToken: users.createSession(alice.id),
    close: () => server.close(),
    call,
    checkout: (body) =>
      call(users.createSession(alice.id), '/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    methods: async () => (await call(users.createSession(alice.id), '/api/payments/methods')).json(),
    adminMethods: async () => {
      const boss = users.getUserByEmail('boss@example.com') ?? users.createUser({ email: 'boss@example.com' });
      return (await call(users.createSession(boss.id), '/api/payments/methods')).json();
    },
  };
}

test('each method is judged by its own floor, not the other one\'s', async () => {
  const server = await serve();
  try {
    const tooSmallForCard = await server.checkout({ method: 'card', amountUsd: '2.49' });
    assert.equal(tooSmallForCard.status, 400);
    assert.match((await tooSmallForCard.json()).error, /smallest card purchase is \$2\.5\./i);

    assert.equal((await server.checkout({ method: 'card', amountUsd: '2.50' })).status, 201);

    // Crypto's floor is $50, so the amount a card accepts is refused here -
    // which is the whole point of per-method limits.
    const tooSmallForCrypto = await server.checkout({ method: 'crypto', amountUsd: '2.50' });
    assert.equal(tooSmallForCrypto.status, 400);
    assert.match((await tooSmallForCrypto.json()).error, /smallest crypto purchase is \$50\./i);

    assert.equal((await server.checkout({ method: 'crypto', amountUsd: '50' })).status, 201);
  } finally {
    server.close();
  }
});

test('each method is judged by its own ceiling', async () => {
  const server = await serve();
  try {
    const overCard = await server.checkout({ method: 'card', amountUsd: '100.01' });
    assert.equal(overCard.status, 400);
    assert.match((await overCard.json()).error, /largest card purchase is \$100\./i);

    // Crypto's ceiling is $2000, so the same amount is fine there.
    assert.equal((await server.checkout({ method: 'crypto', amountUsd: '100.01' })).status, 201);
  } finally {
    server.close();
  }
});

test('a checkout charges, records and credits exactly the amount asked for', async () => {
  const server = await serve();
  try {
    const response = await server.checkout({ method: 'card', amountUsd: '12.34' });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.amountMilli, 12_340);
    assert.equal(body.creditMilli, 12_340, 'credit = charge');
    for (const retired of ['credits', 'amountCents', 'feeCents']) assert.equal(retired in body, false, retired);

    assert.equal(server.created[0].amountCents, 1_234, 'the provider is asked for the same amount, in cents');
    assert.equal(server.created[0].creditMilli, 12_340, 'and the product names the same credit');

    const payment = server.payments.getPayment(body.paymentId);
    assert.equal(payment.amountCents, 1_234);
    assert.equal(payment.creditMilli, 12_340);
    assert.equal(payment.legacyCredits, null, 'nothing in the old unit');
  } finally {
    server.close();
  }
});

test('presets are amounts, and the server offers only those inside the bounds', async () => {
  const server = await serve({
    settings: {
      paymentLimits: [
        {
          target: 'card',
          minCents: 500,
          maxCents: 2_000,
          // The first is below the floor and the last is above the ceiling.
          presetsCents: [250, 1_000, 1_250, 10_000],
        },
      ],
    },
  });
  try {
    const presets = await server.pricing.presetsFor({ method: 'card' });
    assert.deepEqual(
      presets,
      [{ amountMilli: 10_000 }, { amountMilli: 12_500 }],
      'dropped rather than clamped: two buttons reading the same amount is worse than one'
    );

    // And a button works: posting its amount charges exactly that.
    const response = await server.checkout({ method: 'card', amountUsd: '12.50' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).amountMilli, 12_500);
  } finally {
    server.close();
  }
});

test('the methods endpoint reports each method\'s bounds and presets in thousandths of a dollar', async () => {
  const server = await serve();
  try {
    const body = await server.methods();
    assert.equal(body.currency, 'usd');
    assert.ok(Array.isArray(body.methods) && body.methods.length === 2);
    // The price of a credit is gone: a credit is a dollar.
    for (const retired of ['unitPriceCents', 'minCredits', 'maxCredits']) {
      assert.equal(retired in body, false, `${retired} is not sent`);
    }

    const card = body.targets.find((target) => target.id === 'card');
    assert.equal(card.minAmountMilli, 2_500);
    assert.equal(card.maxAmountMilli, 100_000);
    assert.equal(card.custom, 'slider');
    for (const retired of ['minCredits', 'maxCredits', 'minAmountCents', 'maxAmountCents', 'feeBps', 'feeFixedCents']) {
      assert.equal(retired in card, false, `${retired} is not sent`);
    }

    const crypto = body.targets.find((target) => target.id === 'crypto');
    assert.equal(crypto.minAmountMilli, 50_000);
    assert.equal(crypto.maxAmountMilli, 2_000_000);
    assert.equal(crypto.custom, 'stepper', 'whole dollars for a coin');

    // Every preset the page is given is inside the bounds it is given.
    for (const target of body.targets) {
      for (const preset of target.presets) {
        assert.deepEqual(Object.keys(preset), ['amountMilli']);
        assert.ok(
          preset.amountMilli >= target.minAmountMilli && preset.amountMilli <= target.maxAmountMilli,
          `preset ${preset.amountMilli} is outside ${target.id}'s own bounds`
        );
      }
    }
  } finally {
    server.close();
  }
});

test('nothing in the request body but the amount asked for decides what is charged', async () => {
  const server = await serve();
  try {
    const response = await server.checkout({
      method: 'card',
      amountUsd: '20',
      // Every spelling a request might try.
      amount: 1,
      amountCents: 1,
      amountMilli: 1,
      creditMilli: 999_999,
      cents: 1,
      feeCents: 1,
      presetCents: 1,
      unitPriceCents: 1,
      price: 1,
    });
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.amountMilli, 20_000, 'the amount asked for, judged by the server');
    assert.equal(body.creditMilli, 20_000, 'and credited exactly, whatever the body claimed');
    assert.equal(server.created[0].amountCents, 2_000, 'the provider is asked for the server\'s number');
  } finally {
    server.close();
  }
});

test('a purchase that names no amount in dollars is asked for one, and nothing is opened', async () => {
  const server = await serve();
  try {
    // A count of credits is not an amount: it is never read as dollars.
    const response = await server.checkout({ method: 'card', credits: 10 });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Choose an amount in dollars/);
    assert.equal(server.created.length, 0, 'no checkout was opened');
  } finally {
    server.close();
  }
});

/*
 * The asset is no longer something a REQUEST can carry - the buyer chooses the
 * coin on the provider's own page - but `paymentLimits` can still hold a row
 * keyed on one, and an installation may have had such a row saved before the
 * coins went away. So the pricing authority still resolves them, and these are
 * what stop that turning into a way to be judged by the wrong row.
 */

test('an asset can never be judged by a method’s row', async () => {
  /*
   * The pricing authority on its own.
   *
   * No request carries an asset any more, so `rowFor`'s own guard is the only
   * lock left rather than the second of two - and `rowFor` is what decides
   * what a purchase may be, so anything reaching it by any later route has to
   * get the same answer. Without the guard, `{ method: 'crypto', asset:
   * 'card' }` resolves the CARD row: a $2.50 floor where the operator set $50.
   */
  const server = await serve({
    settings: {
      paymentLimits: [
        { target: 'card', minCents: 250, maxCents: 10_000, presetsCents: [] },
        { target: 'crypto', minCents: 5_000, maxCents: 200_000, presetsCents: [] },
      ],
    },
  });
  try {
    const honest = await server.pricing.resolveLimits({ method: 'crypto' });
    const spoofed = await server.pricing.resolveLimits({ method: 'crypto', asset: 'card' });

    assert.deepEqual(spoofed, honest);
    assert.equal(spoofed.target, 'crypto');
  } finally {
    server.close();
  }
});

test('a row an operator wrote for one coin still overrides its method', async () => {
  // The other half of the guard above: closing the method-name hole must not
  // close the per-coin override the whole scheme is for. One serve() per
  // test, because the settings module caches and two in one test read the
  // first one's.
  const server = await serve({
    settings: {
      paymentLimits: [
        { target: 'crypto', minCents: 5_000, maxCents: 200_000, presetsCents: [] },
        { target: 'tron:USDT', minCents: 1_000, maxCents: 50_000, presetsCents: [] },
      ],
    },
  });
  try {
    const coin = await server.pricing.resolveLimits({ method: 'crypto', asset: 'tron:USDT' });
    assert.equal(coin.target, 'tron:USDT');
    assert.equal(coin.minAmountCents, 1_000);

    // And a coin with no row of its own falls back to the method's.
    const plain = await server.pricing.resolveLimits({ method: 'crypto', asset: 'bitcoin:BTC' });
    assert.equal(plain.target, 'crypto');
    assert.equal(plain.minAmountCents, 5_000);
  } finally {
    server.close();
  }
});

test('a method whose row was removed falls back to the shipped bounds, not to none', async () => {
  const server = await serve({
    settings: { paymentLimits: [{ target: 'card', minCents: 300, maxCents: 3_000, presetsCents: [] }] },
  });
  try {
    const crypto = await server.pricing.resolveLimits({ method: 'crypto' });
    assert.equal(crypto.minAmountCents, 5_000);
    assert.equal(crypto.maxAmountCents, 200_000);
    const tooMuch = await server.checkout({ method: 'crypto', amountUsd: '1000000' });
    assert.equal(tooMuch.status, 400);
  } finally {
    server.close();
  }
});

/*
 * `GET /payments/quote` says what a purchase would be and records nothing.
 *
 * The order summary prints the charge and the credit before anybody has agreed
 * to anything. Pricing that by opening a checkout meant a payment row and a
 * call to a provider for a purchase that might never happen - so the summary
 * left an abandoned `pending` row in the buyer's own history for having been
 * looked at, and spent two of the twenty checkouts an account may open in an
 * hour on one purchase.
 */

test('a quote prices a purchase without recording one', async () => {
  const server = await serve();
  try {
    const before = server.payments.listPaymentsForUser(server.alice.id).length;

    const response = await server.call(server.aliceToken, '/api/payments/quote?method=card&amountUsd=12.50');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { amountMilli: 12_500, creditMilli: 12_500, currency: 'usd' });

    assert.equal(
      server.payments.listPaymentsForUser(server.alice.id).length,
      before,
      'a quote must not create a payment'
    );
    assert.equal(server.created.length, 0, 'and must not call a provider');
  } finally {
    server.close();
  }
});

test('a quote is judged by the same limits a checkout is', async () => {
  const server = await serve();
  try {
    // $2.50: fine for a card, under the crypto floor of $50.
    assert.equal((await server.call(server.aliceToken, '/api/payments/quote?method=card&amountUsd=2.50')).status, 200);

    const refused = await server.call(server.aliceToken, '/api/payments/quote?method=crypto&amountUsd=2.50');
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /smallest crypto purchase is \$50\./i);

    /*
     * An `asset` in the query is not read at all now, so it cannot steer the
     * bounds. Sent here anyway, naming the CARD row, because that was the
     * spoof the old validation existed to stop: if it were still read, this
     * would be judged by a $2.50 floor and answer 200.
     */
    const ignored = await server.call(server.aliceToken, '/api/payments/quote?method=crypto&amountUsd=2.50&asset=card');
    assert.equal(ignored.status, 400);
    assert.match((await ignored.json()).error, /smallest crypto purchase is \$50\./i);

    // Half a cent is not an amount anything can charge.
    const halfCent = await server.call(server.aliceToken, '/api/payments/quote?method=card&amountUsd=12.505');
    assert.equal(halfCent.status, 400);
    assert.match((await halfCent.json()).error, /dollars and cents/);
  } finally {
    server.close();
  }
});

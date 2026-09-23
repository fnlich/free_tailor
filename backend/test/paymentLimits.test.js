const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { useTempStorage, useAdminEmails, loadFresh, writeSettingRaw } = require('./helpers');

/*
 * Each payment method is judged by its own limits, and the price still comes
 * from the server.
 *
 * Two claims, and the second is the one worth guarding. Per-method bounds mean
 * the buy page now shows a slider and a row of preset buttons, and a preset is
 * exactly the shape of thing that grows a price in it: somebody writes
 * `$2.50` on a button, posts 250, and the server charges what the button said.
 * So a preset here is a COUNT OF CREDITS and what it costs is worked out from
 * settings - which means that at 40c a credit the operator's $2.50 button comes
 * back reading $2.80, because 2.50 does not divide into 40c and the button is
 * rounded UP to the nearest whole credit. The page has no way to say otherwise.
 *
 * The first claim is ordinary bookkeeping: a card floor of $2.50 and a crypto
 * floor of $50 have to be applied to the right method, and a coin may override
 * its own method.
 */

const PRICE_CENTS = 50;

async function serve({ settings = {} } = {}) {
  const { dbDir } = useTempStorage(`payment-limits-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
  process.env.COINBASE_COMMERCE_API_KEY = 'cb_key';
  process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = 'cb_secret';
  // Not set, deliberately: these pin the behaviour of an installation that has
  // NOT moved to Cryptomus, which is the claim that the move changed nothing
  // for anybody who did not opt in. A developer with CRYPTOMUS_* in their root
  // .env would otherwise silently test the other path.
  delete process.env.CRYPTOMUS_MERCHANT_ID;
  delete process.env.CRYPTOMUS_PAYMENT_API_KEY;
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';

  // Before anything reads settings: the settings module caches what it sees.
  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: PRICE_CENTS,
      creditMinCredits: 1,
      creditMaxCredits: 100_000,
      ...settings,
    })
  );

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
  const coinbase = loadFresh('../dist/integrations/coinbaseCommerce');
  coinbase.createCharge = async (input) => {
    created.push(input);
    return { id: 'ch_1', code: `CODE${created.length}`, hosted_url: 'https://commerce.example/1' };
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
  };
}

test('each method is judged by its own floor, not the other one\'s', async () => {
  const server = await serve();
  try {
    // Card: $2.50 floor at 50c a credit is 5 credits.
    const tooSmallForCard = await server.checkout({ method: 'card', credits: 4 });
    assert.equal(tooSmallForCard.status, 400);
    assert.match((await tooSmallForCard.json()).error, /smallest purchase is 5 credits/i);

    assert.equal((await server.checkout({ method: 'card', credits: 5 })).status, 201);

    // Crypto: $50 floor is 100 credits, so the amount a card accepts is
    // refused here - which is the whole point of per-method limits.
    const tooSmallForCrypto = await server.checkout({ method: 'crypto', credits: 5 });
    assert.equal(tooSmallForCrypto.status, 400);
    assert.match((await tooSmallForCrypto.json()).error, /smallest purchase is 100 credits/i);

    assert.equal((await server.checkout({ method: 'crypto', credits: 100 })).status, 201);
  } finally {
    server.close();
  }
});

test('each method is judged by its own ceiling', async () => {
  const server = await serve();
  try {
    // Card: $100 ceiling is 200 credits.
    const overCard = await server.checkout({ method: 'card', credits: 201 });
    assert.equal(overCard.status, 400);
    assert.match((await overCard.json()).error, /largest purchase is 200 credits/i);

    // Crypto's ceiling is $2000, so the same amount is fine there.
    assert.equal((await server.checkout({ method: 'crypto', credits: 201 })).status, 201);
  } finally {
    server.close();
  }
});

test('a row for one coin overrides the row for its method', async () => {
  const server = await serve({
    settings: {
      paymentLimits: [
        { target: 'card', minCents: 250, maxCents: 10_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
        { target: 'crypto', minCents: 5_000, maxCents: 200_000, feeBps: 220, feeFixedCents: 0, presetsCents: [] },
        // One coin, deliberately cheaper to start with than crypto generally.
        { target: 'ethereum:USDC', minCents: 1_000, maxCents: 200_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
      ],
    },
  });
  try {
    // 20 credits is $10: under the crypto floor of $50, at the USDC floor.
    const generic = await server.checkout({ method: 'crypto', credits: 20 });
    assert.equal(generic.status, 400, 'the method row still applies to a coin with no row');

    const overridden = await server.checkout({
      method: 'crypto',
      credits: 20,
      asset: 'ethereum:USDC',
    });
    assert.equal(overridden.status, 201, 'the coin\'s own row is what applies');

    // And its fee row is used too: USDC is fee-free where crypto is not.
    const body = await overridden.json();
    assert.equal(body.feeCents, 0, 'the coin\'s own fee, not the method\'s');
  } finally {
    server.close();
  }
});

test('a coin can only be named for a crypto payment', async () => {
  const server = await serve();
  try {
    const wrong = await server.checkout({
      method: 'card',
      credits: 10,
      asset: 'ethereum:USDC',
    });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /coin can only be chosen for a crypto payment/i);
    assert.equal(server.payments.listPaymentsForUser(server.alice.id).length, 0, 'nothing recorded');
  } finally {
    server.close();
  }
});

test('presets are counts of credits, and the price decides what they cost', async () => {
  // 40c a credit, so the operator's round-dollar buttons are not round in
  // credits - which is exactly the case a preset carrying its own price gets
  // wrong.
  const server = await serve({
    settings: {
      creditPriceCents: 40,
      paymentLimits: [
        {
          target: 'card',
          minCents: 250,
          maxCents: 10_000,
          feeBps: 0,
          feeFixedCents: 0,
          presetsCents: [250, 500, 1_000],
        },
      ],
    },
  });
  try {
    const presets = await server.pricing.presetsFor({ method: 'card' });

    assert.deepEqual(
      presets,
      [
        // $2.50 is 6.25 credits. Rounded UP, because the floor is $2.50 too
        // and rounding down would put the operator's own button below their
        // own minimum, where it would then be dropped for being out of range.
        { credits: 7, amountCents: 280 },
        { credits: 13, amountCents: 520 },
        { credits: 25, amountCents: 1000 },
      ],
      'a preset names a count and a price the server would really charge'
    );

    // And the button actually works: posting the count is accepted and charged
    // at the price the preset reported.
    const response = await server.checkout({ method: 'card', credits: 7 });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).amountCents, 280);
  } finally {
    server.close();
  }
});

test('a preset outside the bounds is not offered', async () => {
  const server = await serve({
    settings: {
      paymentLimits: [
        {
          target: 'card',
          minCents: 500,
          maxCents: 2_000,
          feeBps: 0,
          feeFixedCents: 0,
          // The first is below the floor and the last is above the ceiling.
          presetsCents: [250, 1_000, 10_000],
        },
      ],
    },
  });
  try {
    const presets = await server.pricing.presetsFor({ method: 'card' });
    assert.deepEqual(
      presets,
      [{ credits: 20, amountCents: 1000 }],
      'dropped rather than clamped: two buttons reading the same price is worse than one'
    );
  } finally {
    server.close();
  }
});

test('a price that leaves no whole credit inside the amounts withholds the method', async () => {
  // $150 a credit against a $100 ceiling: there is no number of credits that
  // can be bought. That is a misconfiguration, and an operator has to see it.
  const server = await serve({ settings: { creditPriceCents: 15_000 } });
  try {
    const response = await server.checkout({ method: 'card', credits: 1 });
    assert.equal(response.status, 503, 'a misconfiguration, not the buyer\'s mistake');
    const error = (await response.json()).error;
    assert.match(error, /card/, 'names the target');
    assert.match(error, /Admin/, 'and where to fix it');

    const methods = await server.methods();
    const card = methods.targets.find((target) => target.id === 'card');
    assert.equal(card.available, false, 'withheld rather than dropped');
    assert.match(card.reason, /no whole number of credits/i);
  } finally {
    server.close();
  }
});

test('the methods endpoint still reports what it always did, alongside the targets', async () => {
  const server = await serve();
  try {
    const body = await server.methods();

    // The old shape, unchanged: a browser tab that has not been reloaded
    // across a deploy must not find its buy page blank.
    assert.equal(body.unitPriceCents, PRICE_CENTS);
    assert.equal(body.currency, 'usd');
    assert.ok(Array.isArray(body.methods) && body.methods.length === 2);

    const card = body.targets.find((target) => target.id === 'card');
    assert.equal(card.minCredits, 5, '$2.50 at 50c a credit');
    assert.equal(card.maxCredits, 200, '$100 at 50c a credit');
    assert.equal(card.custom, 'slider');
    assert.equal(card.feeBps, 0, 'no fee on a card');

    const crypto = body.targets.find((target) => target.id === 'crypto');
    assert.equal(crypto.minCredits, 100);
    assert.equal(crypto.custom, 'stepper', 'whole dollars for a coin');
    assert.equal(crypto.feeBps, 220);

    // Every preset the page is given has to be inside the bounds it is given.
    for (const target of body.targets) {
      for (const preset of target.presets) {
        assert.ok(
          preset.credits >= target.minCredits && preset.credits <= target.maxCredits,
          `preset ${preset.credits} is outside ${target.id}'s own bounds`
        );
        assert.equal(
          preset.amountCents,
          preset.credits * body.unitPriceCents,
          'a preset price is the count times the server\'s price, never a stored figure'
        );
      }
    }
  } finally {
    server.close();
  }
});

test('an amount in the request body is still ignored, whatever it is called', async () => {
  const server = await serve();
  try {
    const response = await server.checkout({
      method: 'card',
      credits: 20,
      // Every spelling the new fields might have invited.
      amount: 1,
      amountCents: 1,
      cents: 1,
      feeCents: 1,
      presetCents: 1,
      unitPriceCents: 1,
      price: 1,
    });
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.amountCents, 20 * PRICE_CENTS, 'priced by the server, from settings');
    assert.equal(body.feeCents, 0, 'and the fee is the server\'s too');
    assert.equal(
      server.created[0].amountCents,
      20 * PRICE_CENTS,
      'the provider is asked for the server\'s number'
    );
  } finally {
    server.close();
  }
});

/*
 * The asset is a string from the request, and it chooses which row prices the
 * sale. Two tests, because there are two locks and either alone would do.
 */

test('a coin this build has never heard of is refused, and records nothing', async () => {
  const server = await serve();
  try {
    for (const bogus of ['card', 'crypto', 'ethereum:DOGE', 'CARD', 'bitcoin:btc']) {
      const refused = await server.checkout({ method: 'crypto', credits: 200, asset: bogus });
      assert.equal(refused.status, 400, `asset ${bogus} was not refused`);
      assert.match((await refused.json()).error, /not one this server can take/i);
    }

    // Refused BEFORE anything is recorded: a coin that does not exist is the
    // caller's mistake, not a payment that failed at a provider.
    assert.equal(server.payments.listPaymentsForUser(server.alice.id).length, 0);
    assert.equal(server.created.length, 0);
  } finally {
    server.close();
  }
});

test('an asset can never be priced off a method’s row', async () => {
  /*
   * The pricing authority on its own, with the route's validation bypassed.
   *
   * `startCheckout` refuses an unknown asset, so a request cannot reach this -
   * but `rowFor` is what decides what a purchase costs, and anything calling
   * it later by any route has to get the same answer. Without the guard,
   * `{ method: 'crypto', asset: 'card' }` resolves the CARD row: a $2.50 floor
   * where the operator set $50, and no fee where they set one.
   */
  const server = await serve({
    settings: {
      paymentLimits: [
        { target: 'card', minCents: 250, maxCents: 10_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
        { target: 'crypto', minCents: 5_000, maxCents: 200_000, feeBps: 220, feeFixedCents: 0, presetsCents: [] },
      ],
    },
  });
  try {
    const honest = await server.pricing.resolveLimits({ method: 'crypto' });
    const spoofed = await server.pricing.resolveLimits({ method: 'crypto', asset: 'card' });

    assert.equal(spoofed.minAmountCents, honest.minAmountCents);
    assert.equal(spoofed.maxAmountCents, honest.maxAmountCents);
    assert.equal(spoofed.feeBps, honest.feeBps);
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
        { target: 'crypto', minCents: 5_000, maxCents: 200_000, feeBps: 220, feeFixedCents: 0, presetsCents: [] },
        { target: 'tron:USDT', minCents: 1_000, maxCents: 50_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
      ],
    },
  });
  try {
    const coin = await server.pricing.resolveLimits({ method: 'crypto', asset: 'tron:USDT' });
    assert.equal(coin.target, 'tron:USDT');
    assert.equal(coin.minAmountCents, 1_000);
    assert.equal(coin.feeBps, 0);

    // And a coin with no row of its own falls back to the method's.
    const plain = await server.pricing.resolveLimits({ method: 'crypto', asset: 'bitcoin:BTC' });
    assert.equal(plain.target, 'crypto');
    assert.equal(plain.feeBps, 220);
  } finally {
    server.close();
  }
});

/*
 * `GET /payments/quote` prices a purchase and records nothing.
 *
 * The order summary prints the charge, the fee and the credits the account
 * will receive before anybody has agreed to anything. Pricing that by opening
 * a checkout meant a payment row and a call to a provider for a purchase that
 * might never happen - so the summary left an abandoned `pending` row in the
 * buyer's own history for having been looked at, and spent two of the twenty
 * checkouts an account may open in an hour on one purchase.
 */

test('a quote prices a purchase without recording one', async () => {
  const server = await serve();
  try {
    const before = server.payments.listPaymentsForUser(server.alice.id).length;

    const response = await server.call(server.aliceToken, '/api/payments/quote?method=card&credits=20');
    assert.equal(response.status, 200);
    const quote = await response.json();

    assert.equal(quote.credits, 20);
    assert.equal(quote.grossCredits, 20);
    assert.equal(quote.amountCents, 20 * PRICE_CENTS);
    assert.equal(quote.unitPriceCents, PRICE_CENTS);
    assert.equal(quote.feeCents, 0);

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
    // 5 credits is $2.50: fine for a card, under the crypto floor of $50.
    assert.equal(
      (await server.call(server.aliceToken, '/api/payments/quote?method=card&credits=5')).status,
      200
    );

    const refused = await server.call(
      server.aliceToken,
      '/api/payments/quote?method=crypto&credits=5'
    );
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /smallest purchase is 100 credits/i);

    // And the same coin validation, so a quote cannot be priced off a row a
    // checkout would refuse to use.
    const bogus = await server.call(
      server.aliceToken,
      '/api/payments/quote?method=crypto&credits=200&asset=card'
    );
    assert.equal(bogus.status, 400);
    assert.match((await bogus.json()).error, /not one this server can take/i);
  } finally {
    server.close();
  }
});

test('a quote shows the fee taken out of the amount, never added to it', async () => {
  const server = await serve({
    settings: {
      paymentLimits: [
        { target: 'card', minCents: 250, maxCents: 100_000, feeBps: 500, feeFixedCents: 0, presetsCents: [] },
      ],
    },
  });
  try {
    const quote = await (
      await server.call(server.aliceToken, '/api/payments/quote?method=card&credits=100')
    ).json();

    // 100 credits at 50c is $50.00. A 5% fee is $2.50, which buys 5 credits.
    assert.equal(quote.amountCents, 5_000, 'the charge is the gross, unchanged by the fee');
    assert.equal(quote.feeCents, 250);
    assert.equal(quote.grossCredits, 100);
    assert.equal(quote.credits, 95, 'the fee comes out of the credits, not out of the charge');
  } finally {
    server.close();
  }
});

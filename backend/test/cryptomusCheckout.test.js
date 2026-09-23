const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * Which provider a NEW crypto checkout gets, and what an old one still does.
 *
 * Three ways of taking crypto exist in this codebase at once - Cryptomus, the
 * on-chain watcher, and Coinbase Commerce - and only the first is offered. The
 * other two are retired rather than removed, because an invoice quoted
 * yesterday is still out there and a row paid last month still has to read.
 *
 * So the rule is one line, and these tests are that line from both sides:
 *
 *   Cryptomus when it is configured, otherwise on-chain, otherwise Coinbase.
 *
 * The second half is the one worth writing tests for. "Nothing changed for an
 * installation that did not opt in" is the claim that makes this safe to ship
 * before the machinery it replaces is deleted, and it is a claim about code
 * that is NOT exercised by any test of the new path.
 */

const PRICE_CENTS = 50;

async function serve({ cryptomus = true, chain = false, coinbase = false } = {}) {
  const { dbDir } = useTempStorage(`cryptomus-checkout-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';

  if (cryptomus) {
    process.env.CRYPTOMUS_MERCHANT_ID = 'merchant-uuid';
    process.env.CRYPTOMUS_PAYMENT_API_KEY = 'payment-api-key';
  } else {
    delete process.env.CRYPTOMUS_MERCHANT_ID;
    delete process.env.CRYPTOMUS_PAYMENT_API_KEY;
  }
  if (coinbase) {
    process.env.COINBASE_COMMERCE_API_KEY = 'cb_key';
    process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = 'cb_secret';
  } else {
    delete process.env.COINBASE_COMMERCE_API_KEY;
    delete process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  }
  if (chain) {
    process.env.CHAIN_ASSETS = 'ethereum:USDT';
    process.env.CHAIN_EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
  } else {
    delete process.env.CHAIN_ASSETS;
    delete process.env.CHAIN_EVM_ADDRESS;
  }

  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: PRICE_CENTS,
      creditMinCredits: 1,
      creditMaxCredits: 100_000,
    })
  );

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/database/savedCardRepository');
  loadFresh('../dist/config/aiModelConfig');

  const stripe = loadFresh('../dist/integrations/stripe');
  stripe.createCheckoutSession = async () => ({ id: 'cs_1', client_secret: 'cs_1_secret' });

  /*
   * All three provider seams replaced, including the two that should never be
   * called. A test that only stubs the expected one proves nothing when the
   * precedence is wrong: the real call would just fail, and "it threw" is not
   * "it chose the other provider".
   */
  const calls = { cryptomus: [], coinbase: [] };
  const cryptomusModule = loadFresh('../dist/integrations/cryptomus');
  cryptomusModule.createInvoice = async (input) => {
    calls.cryptomus.push(input);
    return {
      uuid: `inv-${calls.cryptomus.length}`,
      order_id: input.paymentId,
      url: `https://pay.cryptomus.com/inv-${calls.cryptomus.length}`,
    };
  };
  const coinbaseModule = loadFresh('../dist/integrations/coinbaseCommerce');
  coinbaseModule.createCharge = async (input) => {
    calls.coinbase.push(input);
    return { id: 'ch_1', code: 'CODE1', hosted_url: 'https://commerce.example/1' };
  };

  loadFresh('../dist/services/payments/pricing');
  loadFresh('../dist/services/payments');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/payments');

  const alice = users.createUser({ email: 'alice@example.com' });
  const token = users.createSession(alice.id);

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/payments', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  const call = (path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

  return {
    calls,
    payments,
    close: () => server.close(),
    call,
    checkout: (body) => call('/api/payments/checkout', { method: 'POST', body: JSON.stringify(body) }),
    // One response carries both: `methods` for an older tab, `targets` for
    // the per-thing rows the buy page actually renders.
    methods: async () => (await call('/api/payments/methods')).json(),
  };
}

test('a crypto checkout opens a Cryptomus invoice and sends the buyer to it', async () => {
  const server = await serve();
  try {
    const response = await server.checkout({ method: 'crypto', credits: 100 });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));

    // The redirect shape: a URL, no client secret. Exactly what the hosted
    // branch of CryptoPanel already renders, which is why it needed no work.
    assert.equal(body.redirectUrl, 'https://pay.cryptomus.com/inv-1');
    assert.equal(body.clientSecret ?? '', '');

    assert.equal(server.calls.cryptomus.length, 1);
    assert.equal(server.calls.coinbase.length, 0);
    // $50 for 100 credits at 50c, and the invoice is priced from settings.
    assert.equal(server.calls.cryptomus[0].amountCents, 5_000);

    const payment = server.payments.getPayment(server.calls.cryptomus[0].paymentId);
    assert.equal(payment.provider, 'cryptomus');
    // The invoice uuid, because that is what the callback quotes.
    assert.equal(payment.providerRef, 'inv-1');
  } finally {
    server.close();
  }
});

test('Cryptomus wins over both of the paths it replaces', async () => {
  const server = await serve({ cryptomus: true, chain: true, coinbase: true });
  try {
    const methods = await server.methods();
    const crypto = methods.methods.find((entry) => entry.method === 'crypto');
    assert.equal(crypto.provider, 'cryptomus');
    assert.equal(crypto.available, true);

    assert.equal((await server.checkout({ method: 'crypto', credits: 100 })).status, 201);
    assert.equal(server.calls.cryptomus.length, 1);
    assert.equal(server.calls.coinbase.length, 0);
  } finally {
    server.close();
  }
});

test('a coin chosen in a stale tab is ignored rather than refused', async () => {
  /*
   * A buyer who had the dialog open across the switch still has coin buttons
   * on screen, and pressing one means "crypto" - not "fail my purchase". The
   * asset is still VALIDATED, because an unknown one would otherwise reach the
   * pricing authority; it is simply not acted on.
   */
  const server = await serve({ chain: true });
  try {
    const good = await server.checkout({ method: 'crypto', credits: 100, asset: 'ethereum:USDT' });
    assert.equal(good.status, 201);
    assert.equal(server.calls.cryptomus.length, 1);

    const invented = await server.checkout({ method: 'crypto', credits: 100, asset: 'ethereum:DOGE' });
    assert.equal(invented.status, 400);
  } finally {
    server.close();
  }
});

test('the buy page offers one crypto button, not a row per coin', async () => {
  const server = await serve({ chain: true });
  try {
    const { targets } = await server.methods();
    const crypto = targets.filter((target) => target.method === 'crypto');
    /*
     * One row, and it is the method-level one. Coin rows would offer a choice
     * Cryptomus never sees: it asks on its own page, from its own list, and a
     * buyer who picked USDT-on-TRON here would simply not be given it.
     */
    assert.equal(crypto.length, 1);
    assert.equal(crypto[0].id, 'crypto');
    assert.equal(crypto[0].mark, 'crypto');
    assert.equal(crypto[0].available, true);
  } finally {
    server.close();
  }
});

test('with nothing configured, the reason names Cryptomus first', async () => {
  const server = await serve({ cryptomus: false });
  try {
    const methods = await server.methods();
    const crypto = methods.methods.find((entry) => entry.method === 'crypto');
    assert.equal(crypto.available, false);
    // The operator reading this is setting up today, so the variables they
    // should go and set come before the two that are on their way out.
    assert.match(crypto.reason, /^Set CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY/);
    assert.match(crypto.reason, /retired/);

    const refused = await server.checkout({ method: 'crypto', credits: 100 });
    assert.equal(refused.status, 503);
  } finally {
    server.close();
  }
});

/* --------------------------------------- and nothing changed for anyone else */

test('an installation still on Coinbase keeps getting Coinbase', async () => {
  const server = await serve({ cryptomus: false, coinbase: true });
  try {
    const methods = await server.methods();
    assert.equal(methods.methods.find((entry) => entry.method === 'crypto').provider, 'coinbase');

    const response = await server.checkout({ method: 'crypto', credits: 100 });
    assert.equal(response.status, 201);
    assert.equal(server.calls.coinbase.length, 1);
    assert.equal(server.calls.cryptomus.length, 0);
    assert.equal((await response.json()).redirectUrl, 'https://commerce.example/1');
  } finally {
    server.close();
  }
});

test('an installation still on-chain keeps its coin rows and its coin question', async () => {
  const server = await serve({ cryptomus: false, chain: true });
  try {
    const methods = await server.methods();
    assert.equal(methods.methods.find((entry) => entry.method === 'crypto').provider, 'chain');

    const { targets } = await server.methods();
    const coins = targets.filter((target) => target.method === 'crypto');
    assert.equal(coins.length, 1);
    assert.equal(coins[0].id, 'ethereum:USDT', 'the per-coin row, not the method row');

    // And the coin is still compulsory there, because an on-chain payment is
    // one token at one address and there is no default worth guessing.
    const noCoin = await server.checkout({ method: 'crypto', credits: 100 });
    assert.equal(noCoin.status, 400);
    assert.match((await noCoin.json()).error, /which coin/i);
  } finally {
    server.close();
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * The one crypto path, and what became of the two it replaced.
 *
 * There were three at once for a while: Cryptomus, the on-chain watcher, and
 * Coinbase Commerce. The other two have been deleted - nothing was in flight
 * through either, so there was nothing left for them to settle - and these
 * tests are what says so out loud rather than leaving it to a reader to infer
 * from an absence.
 *
 * Two claims, and the second is the one worth writing tests for:
 *
 *  1. with Cryptomus configured, a crypto checkout opens a hosted invoice;
 *  2. with it NOT configured, crypto is refused - it does not quietly fall
 *     through to a provider that no longer exists, and `CHAIN_ASSETS` or
 *     `COINBASE_COMMERCE_*` left behind in somebody's `.env` do not bring one
 *     back. That is the shape a real installation is in the day this deploys.
 *
 * And a third, about the past rather than the present: a payment ROW that was
 * made through one of the deleted paths still reads and still refunds. Its
 * provider is still in the union, and deleting the code that created it must
 * not have made it unreadable.
 */

const PRICE_CENTS = 50;

async function serve({ cryptomus = true, legacyEnv = false } = {}) {
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
  /*
   * The variables of the two deleted paths, set or not.
   *
   * `legacyEnv` is not leftover scaffolding: it is the state of a real
   * installation's `.env` the day this ships, and the thing worth proving is
   * that these now do NOTHING. A fallback that half survived would be a Crypto
   * button with nothing behind it.
   */
  if (legacyEnv) {
    process.env.COINBASE_COMMERCE_API_KEY = 'cb_key';
    process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = 'cb_secret';
    process.env.CHAIN_ASSETS = 'ethereum:USDT';
    process.env.CHAIN_EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
  } else {
    delete process.env.COINBASE_COMMERCE_API_KEY;
    delete process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
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

  const calls = { cryptomus: [] };
  const cryptomusModule = loadFresh('../dist/integrations/cryptomus');
  cryptomusModule.createInvoice = async (input) => {
    calls.cryptomus.push(input);
    return {
      uuid: `inv-${calls.cryptomus.length}`,
      order_id: input.paymentId,
      url: `https://pay.cryptomus.com/inv-${calls.cryptomus.length}`,
    };
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
    alice,
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

    // The redirect shape: a URL, no client secret, and no deposit address -
    // the buyer pays on Cryptomus's page, not on one of ours.
    assert.equal(body.redirectUrl, 'https://pay.cryptomus.com/inv-1');
    assert.equal(body.clientSecret ?? '', '');
    assert.equal(body.invoice, undefined);

    assert.equal(server.calls.cryptomus.length, 1);
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

test('the buy page offers one crypto button, not a row per coin', async () => {
  const server = await serve({ legacyEnv: true });
  try {
    const { targets } = await server.methods();
    const crypto = targets.filter((target) => target.method === 'crypto');
    /*
     * One row, even with CHAIN_ASSETS still set.
     *
     * There was a row per coin while this application chose the token and the
     * network itself. Cryptomus asks on its own page, from its own list, so a
     * coin picked here would be a choice nothing could honour.
     */
    assert.equal(crypto.length, 1);
    assert.equal(crypto[0].id, 'crypto');
    assert.equal(crypto[0].mark, 'crypto');
    assert.equal(crypto[0].available, true);
    // And no coin fields ride along on it any more.
    assert.equal(crypto[0].asset, undefined);
    assert.equal(crypto[0].chain, undefined);
  } finally {
    server.close();
  }
});

test('a coin named by a stale tab is ignored rather than refused', async () => {
  /*
   * A buyer who had the dialog open across the switch still has coin buttons
   * on screen, and pressing one meant "crypto" - not "fail my purchase".
   * Nothing validates a coin any more because nothing could honour one, so
   * the field is simply not read: not refused, and not acted on either.
   */
  const server = await serve();
  try {
    for (const asset of ['ethereum:USDT', 'ethereum:DOGE', 'card', '../card']) {
      const response = await server.checkout({ method: 'crypto', credits: 100, asset });
      assert.equal(response.status, 201, `${asset}: ${JSON.stringify(await response.json())}`);
    }
    assert.equal(server.calls.cryptomus.length, 4);
    // Priced off the crypto row every time - an asset cannot reach the pricing
    // authority, which is what the old closed list was guarding.
    for (const call of server.calls.cryptomus) {
      assert.equal(call.amountCents, 5_000);
    }
  } finally {
    server.close();
  }
});

/* --------------------------------- with nothing configured to take crypto */

test('crypto is refused, not quietly handed to a provider that is gone', async () => {
  const server = await serve({ cryptomus: false });
  try {
    const methods = await server.methods();
    const crypto = methods.methods.find((entry) => entry.method === 'crypto');
    assert.equal(crypto.available, false);
    assert.equal(crypto.provider, 'cryptomus', 'there is no other provider to name');

    const refused = await server.checkout({ method: 'crypto', credits: 100 });
    assert.equal(refused.status, 503);
    assert.equal(server.calls.cryptomus.length, 0);
  } finally {
    server.close();
  }
});

test('and the deleted paths cannot be brought back by their old variables', async () => {
  /*
   * The state a real installation is in the day this deploys: `CHAIN_ASSETS`,
   * a wallet address and a Coinbase key pair all still sitting in `.env`.
   *
   * Every one of them is inert. Half a fallback would be worse than none - a
   * Crypto button that opens a checkout nothing can settle takes somebody's
   * money and grants nothing.
   */
  const server = await serve({ cryptomus: false, legacyEnv: true });
  try {
    const methods = await server.methods();
    const crypto = methods.methods.find((entry) => entry.method === 'crypto');
    assert.equal(crypto.available, false, 'an old variable revived a deleted path');
    assert.equal((await server.checkout({ method: 'crypto', credits: 100 })).status, 503);

    // And the operator is told which variables are dead rather than being left
    // to work out what broke the ones they had configured.
    assert.match(crypto.reason, /^Set CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY/);
    assert.match(crypto.reason, /CHAIN_\* and COINBASE_COMMERCE_\* settings no longer do anything/);

    // Cards are untouched by any of this.
    assert.equal(methods.methods.find((entry) => entry.method === 'card').available, true);
  } finally {
    server.close();
  }
});

/* ------------------------------------------- and what those paths left behind */

test('a payment made on-chain still reads back after the watcher was deleted', async () => {
  /*
   * The whole reason `chain` and `coinbase` stay in `PaymentProvider`.
   *
   * A row does not stop having been paid on-chain because the code that
   * watched the chain was deleted. Constructed directly, because there is no
   * longer any way to create one - which is exactly the point.
   */
  const server = await serve();
  try {
    for (const provider of ['chain', 'coinbase']) {
      const old = server.payments.createPayment({
        userId: server.alice.id,
        method: 'crypto',
        provider,
        credits: 60,
        amountCents: 3_000,
        currency: 'usd',
        unitPriceCents: 50,
      });

      const response = await server.call(`/api/payments/${old.id}`);
      assert.equal(response.status, 200, provider);
      const body = await response.json();
      assert.equal(body.payment.provider, provider);
      assert.equal(body.payment.credits, 60);
      // No invoice rides along any more, and its absence is not an error.
      assert.equal(body.invoice, undefined);
    }
  } finally {
    server.close();
  }
});

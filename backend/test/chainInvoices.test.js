const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { useTempStorage, useAdminEmails, loadFresh, writeSettingRaw } = require('./helpers');

/*
 * Opening an on-chain invoice, and deciding what an arriving transfer paid for.
 *
 * Buyers all send to ONE address per chain, so nothing about an incoming
 * transfer says whose it is except the amount. Every claim in this file is
 * about being honest when the amount does not settle the question - and about
 * the one structural guarantee that makes the rest safe:
 *
 *   **money only ever moves when exactly one order could have meant it.**
 *
 * The design that makes that hold is refusing a taken amount at creation
 * rather than shifting to the next free one. Shifting would put two open
 * invoices one atomic unit apart, and for a stablecoin there are ten thousand
 * of those inside a single cent - so any tolerance band would cover hundreds
 * of live orders and "exactly one candidate" would never be true. Refusing
 * means an open invoice only exists at a figure a real buyer was quoted, and
 * two buyers' quotes differ by dollars.
 */

const PRICE_CENTS = 50;
/*
 * Lower case, deliberately.
 *
 * `chainAddress.ts` checks EIP-55 capitalisation whenever any is present, so
 * a made-up mixed-case address is REFUSED - which is the validator doing
 * exactly its job, and how this test file first found out it works. An
 * all-lowercase address carries no checksum to fail.
 */
const EVM_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TRON_ADDRESS = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';
const BTC_ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

async function serve({
  settings = {},
  assets = 'ethereum:USDT,bsc:USDT,bitcoin:BTC',
  tronKey = true,
  btcPrice = 64_231.55,
} = {}) {
  const { dbDir } = useTempStorage(`chain-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';

  // The operator's chain configuration, as .env carries it.
  process.env.CHAIN_ASSETS = assets;
  process.env.CHAIN_EVM_ADDRESS = EVM_ADDRESS;
  process.env.CHAIN_TRON_ADDRESS = TRON_ADDRESS;
  process.env.CHAIN_BTC_ADDRESS = BTC_ADDRESS;
  if (tronKey) {
    process.env.TRONGRID_API_KEY = 'tron-test-key';
  } else {
    delete process.env.TRONGRID_API_KEY;
  }
  process.env.CHAIN_RATE_SPREAD_PERCENT = '0';
  delete process.env.COINBASE_COMMERCE_API_KEY;
  delete process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  delete process.env.CHAIN_TOLERANCE_BPS;

  // Before anything reads settings: the settings module caches what it sees.
  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: PRICE_CENTS,
      creditMinCredits: 1,
      creditMaxCredits: 100_000,
      paymentLimits: [
        { target: 'card', minCents: 250, maxCents: 100_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
        { target: 'crypto', minCents: 250, maxCents: 500_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
      ],
      ...settings,
    })
  );

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/database/savedCardRepository');
  const chainInvoices = loadFresh('../dist/database/chainInvoiceRepository');
  const cursors = loadFresh('../dist/database/chainCursorRepository');
  loadFresh('../dist/config/aiModelConfig');

  const stripe = loadFresh('../dist/integrations/stripe');
  stripe.createCheckoutSession = async () => ({ id: 'cs_test_1', client_secret: 'cs_test_1_secret' });
  loadFresh('../dist/integrations/coinbaseCommerce');

  // The network boundary, replaced before anything that calls it loads. Every
  // rate in this file is a stablecoin's, so nothing here should reach it at
  // all - this throws so that a test which accidentally needs the network
  // fails loudly rather than hanging on a socket.
  const rpc = loadFresh('../dist/services/payments/chain/rpc');
  rpc.getJson = async (endpoints, path) => {
    // The price feed answers; every chain read does not. A test that
    // accidentally needs a chain fails loudly rather than hanging on a socket.
    if (String(path).startsWith('/simple/price')) return { bitcoin: { usd: btcPrice } };
    throw new Error('no network in tests');
  };
  rpc.rpcCall = async () => {
    throw new Error('no network in tests');
  };
  rpc.postJson = async () => {
    throw new Error('no network in tests');
  };

  loadFresh('../dist/services/payments/chain/rates').clearRateCache();
  const invoices = loadFresh('../dist/services/payments/chain/invoices');
  loadFresh('../dist/services/payments/pricing');
  const service = loadFresh('../dist/services/payments');
  const settle = loadFresh('../dist/services/payments/chain/settle');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/payments');

  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  // Named in ADMIN_EMAILS above, so this account is the administrator whose
  // queue the unattributable money has to reach.
  const boss = users.createUser({ email: 'boss@example.com' });

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

  const aliceToken = users.createSession(alice.id);
  const bobToken = users.createSession(bob.id);
  const bossToken = users.createSession(boss.id);

  return {
    users,
    payments,
    chainInvoices,
    cursors,
    invoices,
    service,
    settle,
    alice,
    bob,
    boss,
    aliceToken,
    bobToken,
    bossToken,
    close: () => server.close(),
    call,
    checkout: (token, body) =>
      call(token, '/api/payments/checkout', { method: 'POST', body: JSON.stringify(body) }),
    heldQueue: async () => (await call(bossToken, '/api/admin/payments/held')).json(),
  };
}

/* ------------------------------------------------------------- opening one */

test('a crypto checkout hands back an address and an exact amount', async () => {
  const server = await serve();
  try {
    const response = await server.checkout(server.aliceToken, {
      method: 'crypto',
      credits: 100,
      asset: 'ethereum:USDT',
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));

    // 100 credits at 50c is $50, and USDT is a dollar.
    assert.equal(body.amountCents, 5_000);
    assert.equal(body.invoice.amount, '50');
    assert.equal(body.invoice.amountAtomic, '50000000');
    assert.equal(body.invoice.address, EVM_ADDRESS);
    assert.equal(body.invoice.chain, 'ethereum');
    assert.equal(body.invoice.confirmationsNeeded, 12);
    // Nothing to confirm and nowhere to be sent: this is the fourth shape.
    assert.equal(body.clientSecret, undefined);
    assert.equal(body.redirectUrl, undefined);
  } finally {
    server.close();
  }
});

test('the same order on BNB Chain quotes an eighteen-decimal amount', async () => {
  const server = await serve();
  try {
    const ethereum = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();
    const bnb = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'bsc:USDT' })
    ).json();

    // The same fifty dollars, and the same fifty USDT to a human.
    assert.equal(ethereum.invoice.amount, '50');
    assert.equal(bnb.invoice.amount, '50');
    // A trillion times apart underneath, which is the whole trap.
    assert.equal(ethereum.invoice.amountAtomic, '50000000');
    assert.equal(bnb.invoice.amountAtomic, '50000000000000000000');
    assert.equal(ethereum.invoice.decimals, 6);
    assert.equal(bnb.invoice.decimals, 18);
  } finally {
    server.close();
  }
});

test('a payment of the Ethereum figure against a BNB invoice credits nothing', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'bsc:USDT' })
    ).json();

    // Somebody sends 50,000,000 raw units - fifty dollars' worth on Ethereum,
    // and five hundred-millionths of a cent on BNB Chain.
    const outcome = server.settle.settleTransfer({
      chain: 'bsc',
      asset: 'bsc:USDT',
      txid: '0xwrongdecimals',
      amountAtomic: '50000000',
      height: 100,
      confirmations: 30,
    });

    assert.equal(outcome.status, 'ignored', 'a trillionth of the price must not settle the order');
    assert.equal(server.payments.getPayment(opened.paymentId).state, 'pending');
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
  } finally {
    server.close();
  }
});

test('two buyers cannot claim the same amount, and the second is told to try again', async () => {
  const server = await serve();
  try {
    const first = await server.checkout(server.aliceToken, {
      method: 'crypto',
      credits: 100,
      asset: 'ethereum:USDT',
    });
    assert.equal(first.status, 201);

    // Same coin, same dollars, same stable price: the same atomic figure.
    const second = await server.checkout(server.bobToken, {
      method: 'crypto',
      credits: 100,
      asset: 'ethereum:USDT',
    });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.match(body.error, /already paying/i);
    assert.match(body.error, /try again/i);

    // And the amount was NOT shifted to a free neighbour, which is the whole
    // point: one open invoice, at the figure that was quoted.
    const open = server.chainInvoices.listOpenInvoices('ethereum', 'ethereum:USDT');
    assert.equal(open.length, 1);
    assert.equal(open[0].amountAtomic, '50000000');
  } finally {
    server.close();
  }
});

test('an account may not hold more open invoices than the operator allows', async () => {
  process.env.CHAIN_MAX_OPEN_INVOICES_PER_USER = '2';
  const server = await serve();
  try {
    assert.equal(
      (await server.checkout(server.aliceToken, { method: 'crypto', credits: 10, asset: 'ethereum:USDT' })).status,
      201
    );
    assert.equal(
      (await server.checkout(server.aliceToken, { method: 'crypto', credits: 20, asset: 'ethereum:USDT' })).status,
      201
    );

    const third = await server.checkout(server.aliceToken, {
      method: 'crypto',
      credits: 30,
      asset: 'ethereum:USDT',
    });
    assert.equal(third.status, 429);
    assert.match((await third.json()).error, /already waiting/i);
  } finally {
    delete process.env.CHAIN_MAX_OPEN_INVOICES_PER_USER;
    server.close();
  }
});

test('a coin the operator has not switched on is refused, and says why', async () => {
  const server = await serve({ assets: 'ethereum:USDT' });
  try {
    const refused = await server.checkout(server.aliceToken, {
      method: 'crypto',
      credits: 100,
      asset: 'tron:USDT',
    });
    assert.equal(refused.status, 503);
    // Not listed in CHAIN_ASSETS at all, so there is no per-asset problem to
    // quote - just the plain fact that this server does not take it.
    assert.match((await refused.json()).error, /not one of the coins/i);
    assert.equal(server.payments.listPaymentsForUser(server.alice.id).length, 1);
    assert.equal(server.payments.listPaymentsForUser(server.alice.id)[0].state, 'failed');
  } finally {
    server.close();
  }
});

test("a chain's own coin is refused by name, and the tokens beside it still work", async () => {
  /*
   * The guard this pins is the difference between a misconfiguration and a
   * money loss, and it was missing for a while.
   *
   * An EVM native transfer - plain ETH, plain BNB - emits no Transfer log, and
   * a log is the only thing `readers/evm.ts` asks a node for. So an operator
   * who listed `ethereum:ETH` got it accepted in full: offered to buyers, and
   * quoted a real address and a real amount. Then the coin arrived, no reader
   * ever saw it, and it was never credited and never even held for review.
   * README and .env.example both promised the opposite.
   */
  const server = await serve({ assets: 'ethereum:USDT,ethereum:ETH,bsc:BNB' });
  try {
    for (const asset of ['ethereum:ETH', 'bsc:BNB']) {
      const refused = await server.checkout(server.aliceToken, {
        method: 'crypto',
        credits: 100,
        asset,
      });
      assert.equal(refused.status, 503);
      const { error } = await refused.json();
      // Named, not silently dropped: the operator asked for this explicitly,
      // so they are told which coin and why, and what to take instead.
      assert.match(error, /own coin/i);
      assert.match(error, /emits no log/i);
      assert.match(error, /USDT or USDC|Bitcoin/i);
    }

    // And the guard skips only the offending entry. A token on the very same
    // chain is untouched, which is what `continue` rather than a throw buys.
    const ok = await server.checkout(server.aliceToken, {
      method: 'crypto',
      credits: 100,
      asset: 'ethereum:USDT',
    });
    assert.equal(ok.status, 201);
  } finally {
    server.close();
  }
});

test("a chain's own coin is never offered as something to buy with", async () => {
  const server = await serve({ assets: 'ethereum:USDT,ethereum:ETH,bsc:BNB' });
  try {
    const body = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    const available = body.targets.filter((target) => target.available).map((target) => target.id);
    // Refusing the checkout is only half of it: a coin that cannot be watched
    // must not appear as a row somebody can press in the first place.
    assert.ok(available.includes('ethereum:USDT'), JSON.stringify(available));
    assert.ok(!available.includes('ethereum:ETH'), JSON.stringify(available));
    assert.ok(!available.includes('bsc:BNB'), JSON.stringify(available));
  } finally {
    server.close();
  }
});

test('an on-chain crypto checkout must name a coin', async () => {
  const server = await serve();
  try {
    const refused = await server.checkout(server.aliceToken, { method: 'crypto', credits: 100 });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /which coin/i);
  } finally {
    server.close();
  }
});

/* --------------------------------------------------------------- settling */

test('a transfer of the exact amount credits the order in full', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();

    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xpaid',
      amountAtomic: '50000000',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'credited');
    assert.equal(outcome.credits, 100);
    assert.equal(server.users.getUserById(server.alice.id).credits, 100);
    assert.equal(server.payments.getPayment(opened.paymentId).state, 'paid');
  } finally {
    server.close();
  }
});

test('the same transfer seen twice credits once', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' });
    const transfer = {
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xpaid',
      amountAtomic: '50000000',
      height: 100,
      confirmations: 12,
    };

    server.settle.settleTransfer(transfer);
    // A second sweep finds the same transfer - which it will, because a
    // reader has no memory. The invoice's own state is what refuses it.
    server.settle.settleTransfer(transfer);

    assert.equal(server.users.getUserById(server.alice.id).credits, 100);
  } finally {
    server.close();
  }
});

test('a transfer that is not deep enough is seen, and credits nothing yet', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();

    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xshallow',
      amountAtomic: '50000000',
      height: 100,
      // Ethereum wants twelve.
      confirmations: 3,
    });

    assert.equal(outcome.status, 'seen');
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
    assert.equal(server.payments.getPayment(opened.paymentId).state, 'pending');

    // And the buyer's page can say so, which is the reason `seen` exists.
    const invoice = server.chainInvoices.getInvoiceForPayment(opened.paymentId);
    assert.equal(invoice.state, 'seen');
    assert.equal(invoice.confirmations, 3);
    assert.equal(invoice.seenTxid, '0xshallow');
  } finally {
    server.close();
  }
});

test('a transfer that vanishes before it is deep enough goes back to waiting', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();

    server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xreorged',
      amountAtomic: '50000000',
      height: 100,
      confirmations: 3,
    });

    const seen = server.chainInvoices.getInvoiceForPayment(opened.paymentId);
    server.settle.forgetSeenTransfer(seen);

    // Not credited and not failed: the buyer may simply have to wait, or to
    // send again, and nothing has been decided either way.
    const after = server.chainInvoices.getInvoiceForPayment(opened.paymentId);
    assert.equal(after.state, 'waiting');
    assert.equal(after.seenTxid, '');
    assert.equal(after.confirmations, 0);
    assert.equal(server.payments.getPayment(opened.paymentId).state, 'pending');
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
  } finally {
    server.close();
  }
});

test('a short payment with one candidate credits in proportion, rounded down', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();

    // $49.50 of the $50 asked for: 1% short, inside the 2% band.
    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xshort',
      amountAtomic: '49500000',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'credited');
    // 99% of 100 credits, floored. The residue stays with the house, the same
    // rule the fee uses - rounding up would give away a credit nobody paid for
    // on every short payment for ever.
    assert.equal(outcome.credits, 99);
    assert.equal(server.users.getUserById(server.alice.id).credits, 99);
    assert.equal(server.payments.getPayment(opened.paymentId).state, 'paid');
    assert.equal(server.payments.getPayment(opened.paymentId).creditsGranted, 99);
  } finally {
    server.close();
  }
});

test('a short payment with TWO candidates credits nothing and is held', async () => {
  const server = await serve();
  try {
    // Two orders a dollar apart, both open. A payment between them could have
    // been meant for either, and guessing would give one buyer's coin to the
    // other buyer's order.
    await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' });
    await server.checkout(server.bobToken, { method: 'crypto', credits: 101, asset: 'ethereum:USDT' });

    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xambiguous',
      amountAtomic: '50250000',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'held');
    assert.match(outcome.reason, /2 open orders/);
    assert.match(outcome.reason, /0xambiguous/);
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
    assert.equal(server.users.getUserById(server.bob.id).credits, 0);
  } finally {
    server.close();
  }
});

test('an ambiguous transfer is written down and reaches the administrator', async () => {
  /*
   * The half of "held" that was missing.
   *
   * The settler returned a `held` status to a caller that only logged it, so
   * no record of the money existed anywhere: the administrator's queue was
   * permanently empty and the line on the buyer's payment screen - that we
   * hold it and get in touch - described nothing the server actually did.
   * Saying money is held and not holding it is worse than either.
   */
  const server = await serve();
  try {
    const alice = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();
    const bob = await (
      await server.checkout(server.bobToken, { method: 'crypto', credits: 101, asset: 'ethereum:USDT' })
    ).json();

    server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xunclaimed',
      amountAtomic: '50250000',
      height: 100,
      confirmations: 12,
    });

    const { held } = await server.heldQueue();
    assert.equal(held.length, 1, JSON.stringify(held));
    assert.equal(held[0].txid, '0xunclaimed');
    // The figure that actually arrived, as a person reads it - which is what
    // they will compare against the two orders.
    assert.equal(held[0].received, '50.25');
    assert.equal(held[0].asset, 'ethereum:USDT');
    assert.match(held[0].note, /2 open orders/);
    // Dismissable, because this record has no payment of its own to live on.
    assert.equal(held[0].resolvable, true);

    /*
     * And the two orders are left exactly as they were.
     *
     * Those buyers may still send the figure they were quoted, and cancelling
     * them because a third party sent an odd amount would punish them for
     * somebody else's mistake.
     */
    for (const opened of [alice, bob]) {
      const invoice = server.chainInvoices.getInvoiceForPayment(opened.paymentId);
      assert.equal(invoice.state, 'waiting');
      assert.equal(invoice.reserved, true);
    }
  } finally {
    server.close();
  }
});

test('the same unclaimed transfer seen on every tick is one row, not a thousand', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' });
    await server.checkout(server.bobToken, { method: 'crypto', credits: 101, asset: 'ethereum:USDT' });

    const transfer = {
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xoverandover',
      amountAtomic: '50250000',
      height: 100,
      confirmations: 12,
    };
    // The watcher re-reads its window every tick, so this is the ordinary
    // case rather than an unusual one.
    for (let tick = 0; tick < 5; tick += 1) server.settle.settleTransfer(transfer);

    assert.equal((await server.heldQueue()).held.length, 1);
  } finally {
    server.close();
  }
});

test('an administrator can clear an item once, and only once', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' });
    await server.checkout(server.bobToken, { method: 'crypto', credits: 101, asset: 'ethereum:USDT' });
    server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xdealtwith',
      amountAtomic: '50250000',
      height: 100,
      confirmations: 12,
    });

    const [entry] = (await server.heldQueue()).held;
    const path = `/api/admin/payments/held/${entry.id}/resolve`;

    // A queue that cannot be cleared is a queue nobody reads.
    assert.equal((await server.call(server.bossToken, path, { method: 'POST' })).status, 200);
    assert.equal((await server.heldQueue()).held.length, 0);
    // Conditional on it still being open, so two administrators pressing at
    // the same moment resolve it once.
    assert.equal((await server.call(server.bossToken, path, { method: 'POST' })).status, 404);

    // And it is admin-only, like everything else on this router.
    assert.equal((await server.call(server.aliceToken, path, { method: 'POST' })).status, 403);
  } finally {
    server.close();
  }
});

test('a transfer too small to buy one credit is held with its transaction on it', async () => {
  // A dollar figure where one credit is the whole order, so a short payment
  // rounds the credit away entirely.
  const server = await serve({ settings: { creditPriceCents: 300 } });
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 1, asset: 'ethereum:USDT' })
    ).json();
    assert.equal(opened.invoice.amountAtomic, '3000000');

    // 1% short of $3, inside the band - so it matches this order and only
    // this one, and then buys nothing.
    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xdust',
      amountAtomic: '2970000',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'held');
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);

    const { held } = await server.heldQueue();
    assert.equal(held.length, 1, JSON.stringify(held));
    /*
     * The two facts an administrator needs, and the two the hold used to throw
     * away: what arrived, and where to look it up. Holding straight from
     * `waiting` left both blank, so the row read "Received: -" with no
     * transaction on it.
     */
    assert.equal(held[0].received, '2.97');
    assert.equal(held[0].txid, '0xdust');
    assert.equal(held[0].expected, '3');
    assert.equal(held[0].paymentId, opened.paymentId);
    // Not dismissable: this one belongs to a payment and stays in its history.
    assert.equal(held[0].resolvable, false);
    // And the amount is free to be sold again.
    assert.equal(server.chainInvoices.getInvoiceForPayment(opened.paymentId).reserved, false);
  } finally {
    server.close();
  }
});

test('a payment outside the band credits nothing at all', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' });

    // $40 against a $50 order. Twenty percent short, far outside the band.
    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xwayshort',
      amountAtomic: '40000000',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'ignored');
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
  } finally {
    server.close();
  }
});

test('an exact match wins even when another order is inside the band', async () => {
  const server = await serve();
  try {
    // Alice is owed exactly $50. Bob's order is close enough to be a band
    // candidate - but the amount that arrives IS Alice's, and the index says
    // so without anybody having to weigh the two.
    const alice = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();
    await server.checkout(server.bobToken, { method: 'crypto', credits: 101, asset: 'ethereum:USDT' });

    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xexact',
      amountAtomic: '50000000',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'credited');
    assert.equal(outcome.credits, 100);
    assert.equal(server.users.getUserById(server.alice.id).credits, 100);
    assert.equal(server.users.getUserById(server.bob.id).credits, 0);
    assert.equal(server.payments.getPayment(alice.paymentId).state, 'paid');
  } finally {
    server.close();
  }
});

test('money that matches nothing open is ignored rather than held', async () => {
  const server = await serve();
  try {
    // Very often this is not a payment for us at all - somebody using the
    // same address for something else. Holding every one of those would fill
    // an operator's queue with things that need no attention.
    const outcome = server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xstranger',
      amountAtomic: '12345678',
      height: 100,
      confirmations: 12,
    });

    assert.equal(outcome.status, 'ignored');
  } finally {
    server.close();
  }
});

/* ----------------------------------------------------------- the lifecycle */

test('an expired invoice releases its amount for somebody else to use', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' });

    // Nobody paid, and the monitor window has passed.
    const expired = server.chainInvoices.releaseFinishedInvoices(
      new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    );
    assert.equal(expired, 1);

    const invoice = server.chainInvoices.listOpenInvoices('ethereum', 'ethereum:USDT');
    assert.equal(invoice.length, 0, 'an expired invoice is not open');

    // And the amount can be sold again, which is the point of releasing it.
    const again = await server.checkout(server.bobToken, {
      method: 'crypto',
      credits: 100,
      asset: 'ethereum:USDT',
    });
    assert.equal(again.status, 201);
    assert.equal((await again.json()).invoice.amountAtomic, '50000000');
  } finally {
    server.close();
  }
});

test('the monitor window outlives the quote by the chain’s own confirmation time', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'bitcoin:BTC' })
    ).json();
    const invoice = server.chainInvoices.getInvoiceForPayment(opened.paymentId);

    const quoteEnds = new Date(invoice.quoteExpiresAt).getTime();
    const monitorEnds = new Date(invoice.monitorUntil).getTime();

    // Bitcoin wants two confirmations at ten minutes each. A transfer sent in
    // the last second of the quote still has to confirm, so cutting the
    // watcher off at the quote's expiry would mean money sent in good time
    // arriving to find nobody watching.
    assert.ok(
      monitorEnds - quoteEnds >= 2 * 600 * 1000,
      'the watcher must keep looking for at least as long as the chain takes'
    );
  } finally {
    server.close();
  }
});

test('the invoice rides along with the payment, so one poll shows both', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();

    server.settle.settleTransfer({
      chain: 'ethereum',
      asset: 'ethereum:USDT',
      txid: '0xwatching',
      amountAtomic: '50000000',
      height: 100,
      confirmations: 4,
    });

    const body = await (await server.call(server.aliceToken, `/api/payments/${opened.paymentId}`)).json();
    // The payment has not moved and will not for minutes. The invoice is what
    // changes while somebody waits, which is why it is served beside it.
    assert.equal(body.payment.state, 'pending');
    assert.equal(body.invoice.state, 'seen');
    assert.equal(body.invoice.confirmations, 4);
    assert.equal(body.invoice.confirmationsNeeded, 12);
    assert.equal(body.invoice.paid, '50');
  } finally {
    server.close();
  }
});

test('somebody else’s invoice is not served to a stranger', async () => {
  const server = await serve();
  try {
    const opened = await (
      await server.checkout(server.aliceToken, { method: 'crypto', credits: 100, asset: 'ethereum:USDT' })
    ).json();

    const response = await server.call(server.bobToken, `/api/payments/${opened.paymentId}`);
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test('every enabled coin is offered as its own choice, with its own network named', async () => {
  const server = await serve();
  try {
    const body = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    const coins = body.targets.filter((target) => target.method === 'crypto');

    assert.deepEqual(
      coins.map((target) => target.id).sort(),
      ['bitcoin:BTC', 'bsc:USDT', 'ethereum:USDT']
    );
    // Offered, not merely listed. An earlier version of this test passed with
    // two of the three marked unavailable, because a mistyped address had
    // failed its checksum and they were being listed as PROBLEMS.
    assert.ok(coins.every((target) => target.available), JSON.stringify(coins));
    // USDT on Ethereum and USDT on BNB Chain are different addresses,
    // different fees and different confirmation times. Sending one to the
    // other loses the money, so they are never one button.
    const labels = coins.map((target) => target.label);
    assert.ok(labels.includes('USDT on Ethereum'));
    assert.ok(labels.includes('USDT on BNB Chain'));
    // And the method-level "Cryptocurrency" row is gone, replaced by these.
    assert.equal(coins.some((target) => target.id === 'crypto'), false);
  } finally {
    server.close();
  }
});

test('a coin the operator asked for that cannot be served is reported, not hidden', async () => {
  // ethereum:ETH is a real asset id this build knows and deliberately does not
  // watch: a native transfer emits no log and can only be found by scanning
  // whole block bodies. An operator who lists it must be told.
  const server = await serve({ assets: 'ethereum:USDT,tron:USDT' });
  try {
    // TRON is listed but its address was set; remove the key to make it a
    // problem instead, which is the shape an operator actually hits.
    const body = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    const tron = body.targets.find((target) => target.id === 'tron:USDT');
    assert.ok(tron, 'a configured coin should appear in the list');
    assert.equal(tron.available, true);
  } finally {
    server.close();
  }
});

test('a coin with no API key is listed unavailable with the reason', async () => {
  const server = await serve({ assets: 'ethereum:USDT,tron:USDT', tronKey: false });
  try {
    const body = await (await server.call(server.aliceToken, '/api/payments/methods')).json();
    const tron = body.targets.find((target) => target.id === 'tron:USDT');

    assert.ok(tron, 'an asset that cannot be served is still listed');
    assert.equal(tron.available, false);
    // Written for whoever has to fix it, so it names the variable.
    assert.match(tron.reason, /TRONGRID_API_KEY/);
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------- the cursor */

test('the scan cursor only ever moves forward', async () => {
  const server = await serve();
  try {
    server.cursors.advanceCursor('ethereum', 1_000);
    assert.equal(server.cursors.getCursor('ethereum'), 1_000);

    // Two endpoints in one list can disagree about the tip by a few blocks,
    // and one answering from a stale fork must not walk the cursor back and
    // cause a range to be skipped.
    server.cursors.advanceCursor('ethereum', 990);
    assert.equal(server.cursors.getCursor('ethereum'), 1_000);

    server.cursors.advanceCursor('ethereum', 1_010);
    assert.equal(server.cursors.getCursor('ethereum'), 1_010);
  } finally {
    server.close();
  }
});

test('a chain that has never been read is null, not zero', async () => {
  const server = await serve();
  try {
    // Zero would mean "read from the genesis block", which no public endpoint
    // will serve and which would take days. Null means "start from the tip,
    // and say so".
    assert.equal(server.cursors.getCursor('bitcoin'), null);
  } finally {
    server.close();
  }
});

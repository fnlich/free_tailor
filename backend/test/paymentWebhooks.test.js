const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The webhook is the only thing that adds credits, so this is the file that
 * decides whether the feature gives money away.
 *
 * Four claims, in the order of how badly each one fails:
 *
 *  1. A VALID event credits exactly once. Anything else is either a customer
 *     who paid and got nothing, or credits handed out for free.
 *  2. A REPLAY credits nothing. Providers guarantee at-least-once delivery and
 *     retry until they get a 2xx, so a second copy of every event is normal
 *     traffic rather than an attack.
 *  3. A TAMPERED body is refused before it is read. The signature covers the
 *     raw bytes; changing so much as the credit count must fail it.
 *  4. An OLD signature is refused. Without the timestamp check a signature is
 *     valid for ever, so anyone who ever saw one valid request could resend it.
 *
 * Everything is signed with a test secret, the way the real provider signs, so
 * these exercise the real verifier rather than a stub of it.
 */

const STRIPE_SECRET = 'whsec_test_secret';
const COINBASE_SECRET = 'coinbase_test_secret';

function signStripe(rawBody, secret = STRIPE_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function signCoinbase(rawBody, secret = COINBASE_SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function serve() {
  useTempStorage(`payment-webhooks-${Math.random().toString(36).slice(2)}`);
  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  process.env.COINBASE_COMMERCE_API_KEY = 'cb_test_key';
  process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = COINBASE_SECRET;

  const express = require('express');

  // Dependency order, and it matters: every module below caches the sqlite
  // module it was first loaded with, so one reloaded out of order keeps a
  // handle on the PREVIOUS test's database - two connections, two files, and
  // a balance that moves somewhere nobody is looking.
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  const credits = loadFresh('../dist/services/credits');
  loadFresh('../dist/config/aiModelConfig');
  loadFresh('../dist/services/payments');
  const webhooks = loadFresh('../dist/routes/paymentWebhooks');

  const buyer = users.createUser({ email: 'buyer@example.com' });

  const app = express();
  // The same mount index.ts uses: raw bytes, and no JSON parser in front of it.
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), webhooks.default);
  const server = app.listen(0);
  const port = server.address().port;

  return {
    users,
    payments,
    credits,
    buyer,
    close: () => server.close(),
    balance: () => users.getUserById(buyer.id).credits,
    post: (path, rawBody, headers) =>
      fetch(`http://127.0.0.1:${port}/api/payments/webhook${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: rawBody,
      }),
  };
}

/** A pending payment, as `startCheckout` would have left one. */
function pendingPayment(server, { providerRef = 'cs_test_123', provider = 'stripe', credits = 200 } = {}) {
  const payment = server.payments.createPayment({
    userId: server.buyer.id,
    method: provider === 'stripe' ? 'card' : 'crypto',
    provider,
    credits,
    amountCents: credits * 50,
    currency: 'usd',
    unitPriceCents: 50,
  });
  server.payments.attachProviderRef(payment.id, providerRef);
  return server.payments.getPayment(payment.id);
}

function stripeEvent(payment, { id = 'evt_1', type = 'checkout.session.completed', status = 'paid' } = {}) {
  return JSON.stringify({
    id,
    type,
    data: {
      object: {
        id: payment.providerRef,
        payment_status: status,
        metadata: { paymentId: payment.id, reference: payment.reference },
      },
    },
  });
}

test('a valid Stripe event credits the account exactly once', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    assert.equal(server.balance(), 0);

    const body = stripeEvent(payment);
    const response = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });

    assert.equal(response.status, 200);
    assert.equal(server.balance(), 200, 'the credits arrived');
    assert.equal(server.payments.getPayment(payment.id).state, 'paid');

    // And through the ledger, with the key that makes a second one impossible.
    const entries = server.credits.getLedger(server.buyer.id);
    const purchase = entries.find((entry) => entry.reason === 'purchase');
    assert.ok(purchase, 'a purchase row was written');
    assert.equal(purchase.delta, 200);
    assert.equal(purchase.balanceAfter, 200);
  } finally {
    server.close();
  }
});

test('the same event delivered again credits nothing', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    const body = stripeEvent(payment);
    const signature = signStripe(body);

    await server.post('/stripe', body, { 'stripe-signature': signature });
    assert.equal(server.balance(), 200);

    // Byte for byte what the provider sends on a retry.
    const second = await server.post('/stripe', body, { 'stripe-signature': signature });
    assert.equal(second.status, 200, 'a retry must be acknowledged, or it retries for days');
    assert.equal(server.balance(), 200, 'and must not pay twice');

    const purchases = server.credits
      .getLedger(server.buyer.id)
      .filter((entry) => entry.reason === 'purchase');
    assert.equal(purchases.length, 1);
  } finally {
    server.close();
  }
});

test('a new event id for a payment already paid still credits nothing', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    const first = stripeEvent(payment, { id: 'evt_1' });
    await server.post('/stripe', first, { 'stripe-signature': signStripe(first) });
    assert.equal(server.balance(), 200);

    // Past the event dedupe - a different id entirely - and stopped by the
    // payment's own state instead. The guards are stacked on purpose.
    const second = stripeEvent(payment, { id: 'evt_2', type: 'checkout.session.async_payment_succeeded' });
    const response = await server.post('/stripe', second, { 'stripe-signature': signStripe(second) });

    assert.equal(response.status, 200);
    assert.equal(server.balance(), 200);
  } finally {
    server.close();
  }
});

test('a tampered body fails the signature and credits nothing', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    const body = stripeEvent(payment);
    const signature = signStripe(body);

    // The signature covers the bytes, so changing the payment it points at
    // invalidates it - which is the whole reason the raw body is verified.
    const tampered = body.replace(payment.providerRef, 'cs_test_somebody_else');
    const response = await server.post('/stripe', tampered, { 'stripe-signature': signature });

    assert.equal(response.status, 400);
    assert.equal(server.balance(), 0);
    assert.equal(server.payments.getPayment(payment.id).state, 'pending');
  } finally {
    server.close();
  }
});

test('an unsigned or wrongly-signed event is refused', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    const body = stripeEvent(payment);

    assert.equal((await server.post('/stripe', body, {})).status, 400, 'no signature at all');
    assert.equal(
      (await server.post('/stripe', body, { 'stripe-signature': 'garbage' })).status,
      400,
      'a malformed header'
    );
    assert.equal(
      (await server.post('/stripe', body, { 'stripe-signature': signStripe(body, 'the-wrong-secret') }))
        .status,
      400,
      'signed with a secret this server does not hold'
    );
    assert.equal(server.balance(), 0);
  } finally {
    server.close();
  }
});

test('a signature older than the tolerance is refused', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    const body = stripeEvent(payment);
    // Correctly signed, an hour ago. Without a timestamp check a captured
    // request would stay replayable for ever.
    const stale = signStripe(body, STRIPE_SECRET, Math.floor(Date.now() / 1000) - 3600);

    const response = await server.post('/stripe', body, { 'stripe-signature': stale });
    assert.equal(response.status, 400);
    assert.equal(server.balance(), 0);
  } finally {
    server.close();
  }
});

test('an event for a payment this server never issued is acknowledged and ignored', async () => {
  const server = await serve();
  try {
    // A charge made in the provider's own dashboard, or one of their test
    // events. A 500 here would make them retry it for days and eventually
    // disable the endpoint, taking the real events with it.
    const body = JSON.stringify({
      id: 'evt_stranger',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_unknown', payment_status: 'paid', metadata: {} } },
    });
    const response = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });

    assert.equal(response.status, 200);
    assert.equal(server.balance(), 0);
  } finally {
    server.close();
  }
});

test('an unpaid or expired session closes the payment without crediting', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    const body = stripeEvent(payment, { id: 'evt_expired', type: 'checkout.session.expired' });

    const response = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });
    assert.equal(response.status, 200);
    assert.equal(server.balance(), 0);
    const closed = server.payments.getPayment(payment.id);
    assert.equal(closed.state, 'expired');
    // What the buyer reads on the return page. The provider's own event name
    // is on the payment_events row instead, where reconciliation needs it.
    assert.match(closed.failure, /expired before it was paid/i);
    assert.doesNotMatch(closed.failure, /checkout\.session/);
  } finally {
    server.close();
  }
});

test('a completed session that is not actually paid credits nothing', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server);
    // `checkout.session.completed` fires for unpaid sessions too, which is the
    // trap: the type alone is not the question, `payment_status` is.
    const body = stripeEvent(payment, { id: 'evt_unpaid', status: 'unpaid' });

    const response = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });
    assert.equal(response.status, 200);
    assert.equal(server.balance(), 0);
    assert.equal(server.payments.getPayment(payment.id).state, 'pending');
  } finally {
    server.close();
  }
});

test('a confirmed Coinbase charge credits, and a pending one does not', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server, { provider: 'coinbase', providerRef: 'CHARGE1', credits: 40 });

    const charge = (type, id) =>
      JSON.stringify({
        event: {
          id,
          type,
          data: { code: payment.providerRef, metadata: { paymentId: payment.id } },
        },
      });

    // On the chain but unconfirmed. Crediting here hands out credits for a
    // transaction that can still be reorganised away.
    const pending = charge('charge:pending', 'cb_1');
    await server.post('/coinbase', pending, { 'x-cc-webhook-signature': signCoinbase(pending) });
    assert.equal(server.balance(), 0);

    const confirmed = charge('charge:confirmed', 'cb_2');
    const response = await server.post('/coinbase', confirmed, {
      'x-cc-webhook-signature': signCoinbase(confirmed),
    });

    assert.equal(response.status, 200);
    assert.equal(server.balance(), 40);
    assert.equal(server.payments.getPayment(payment.id).state, 'paid');
  } finally {
    server.close();
  }
});

test('a Coinbase event signed with the wrong secret is refused', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server, { provider: 'coinbase', providerRef: 'CHARGE2' });
    const body = JSON.stringify({
      event: { id: 'cb_bad', type: 'charge:confirmed', data: { code: payment.providerRef } },
    });

    const response = await server.post('/coinbase', body, {
      'x-cc-webhook-signature': signCoinbase(body, 'not-the-secret'),
    });
    assert.equal(response.status, 400);
    assert.equal(server.balance(), 0);
  } finally {
    server.close();
  }
});

test("one provider's event cannot settle another provider's payment", async () => {
  const server = await serve();
  try {
    // Same reference string, two providers. The lookup is scoped by provider,
    // so a Coinbase charge code that happens to match a Stripe session id must
    // not credit the Stripe payment.
    const card = pendingPayment(server, { provider: 'stripe', providerRef: 'SHARED', credits: 100 });
    const body = JSON.stringify({
      event: { id: 'cb_cross', type: 'charge:confirmed', data: { code: 'SHARED', metadata: { paymentId: card.id } } },
    });

    const response = await server.post('/coinbase', body, {
      'x-cc-webhook-signature': signCoinbase(body),
    });

    assert.equal(response.status, 200);
    assert.equal(server.balance(), 0, 'the card payment was left alone');
    assert.equal(server.payments.getPayment(card.id).state, 'pending');
  } finally {
    server.close();
  }
});

test('a webhook that fails while crediting records nothing, so the retry lands', async () => {
  const server = await serve();
  const db = require('../dist/database/sqlite').getDb();
  try {
    const payment = pendingPayment(server, { credits: 200 });
    const body = stripeEvent(payment, { id: 'evt_retry' });

    /*
     * A failure in the middle of settling, forced rather than waited for.
     *
     * The real ones are a locked database or a full disk, which a test cannot
     * arrange; a trigger that refuses the purchase row reproduces the shape of
     * them exactly - the event has been written down, and the credit then
     * cannot be. What must NOT happen is that the provider's retry is answered
     * "already handled", because the person has paid and would never be
     * credited. So the whole settlement is one transaction: this delivery has
     * to leave the database as it found it.
     */
    db.exec(
      `CREATE TRIGGER refuse_purchase BEFORE INSERT ON credit_ledger
       WHEN NEW.reason = 'purchase'
       BEGIN SELECT RAISE(ABORT, 'simulated ledger failure'); END`
    );

    const failed = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });
    assert.equal(failed.status, 500, 'the provider is told to retry rather than told all is well');
    assert.equal(server.balance(), 0);
    assert.equal(server.payments.getPayment(payment.id).state, 'pending', 'not left marked paid');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n,
      0,
      'the event row rolled back with the credit that failed'
    );

    db.exec('DROP TRIGGER refuse_purchase');

    // The same event id again: it is a first delivery as far as the database
    // is concerned, which is the whole point of rolling the first one back.
    const retried = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });
    assert.equal(retried.status, 200);
    assert.equal(server.balance(), 200);
    assert.equal(server.payments.getPayment(payment.id).state, 'paid');
  } finally {
    server.close();
  }
});

test('an event that reports a different amount credits nothing', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server, { credits: 200 }); // 200 x 50c = $100
    const body = JSON.stringify({
      id: 'evt_short',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: payment.providerRef,
          payment_status: 'paid',
          amount_total: 100, // one dollar, for a hundred dollars of credits
          currency: 'usd',
          metadata: { paymentId: payment.id },
        },
      },
    });

    const response = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });

    // 200, because a retry would say the same thing - but nothing is credited
    // and the payment stays pending, where a person will see it.
    assert.equal(response.status, 200);
    assert.equal(server.balance(), 0);
    assert.equal(server.payments.getPayment(payment.id).state, 'pending');
  } finally {
    server.close();
  }
});

test('the matching amount and currency still credit normally', async () => {
  const server = await serve();
  try {
    const payment = pendingPayment(server, { credits: 200 });
    const body = JSON.stringify({
      id: 'evt_exact',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: payment.providerRef,
          payment_status: 'paid',
          amount_total: 10_000,
          currency: 'USD', // the provider's casing is not a mismatch
          metadata: { paymentId: payment.id },
        },
      },
    });

    await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });
    assert.equal(server.balance(), 200);
  } finally {
    server.close();
  }
});

test('the stored event keeps the payment and drops the person', async () => {
  const server = await serve();
  const db = require('../dist/database/sqlite').getDb();
  try {
    const payment = pendingPayment(server, { credits: 10 });
    const body = JSON.stringify({
      id: 'evt_pii',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: payment.providerRef,
          payment_status: 'paid',
          amount_total: 500,
          currency: 'usd',
          customer_email: 'buyer@example.com',
          customer_details: { email: 'buyer@example.com', address: { line1: '1 Test Street' } },
          metadata: { paymentId: payment.id },
        },
      },
    });

    await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });

    const stored = db.prepare('SELECT payload FROM payment_events WHERE event_id = ?').get('evt_pii');
    // What the row is FOR survives: the event id, the session, the amount.
    assert.match(stored.payload, /evt_pii/);
    assert.match(stored.payload, /amount_total/);
    // What it was never for does not.
    assert.doesNotMatch(stored.payload, /buyer@example\.com/);
    assert.doesNotMatch(stored.payload, /1 Test Street/);
    assert.equal(server.balance(), 10, 'and the credit still landed');
  } finally {
    server.close();
  }
});

test('a webhook is still judged when the publishable key is missing', async () => {
  const server = await serve();
  try {
    /*
     * The publishable key mounts a form in a browser. It has no part in
     * deciding whether Stripe sent this request, so its absence must not turn
     * the webhook into a 503 - Stripe retries a failing endpoint for days and
     * then disables it, and the events it stops delivering are the ones that
     * credit people who have already paid.
     */
    delete process.env.STRIPE_PUBLISHABLE_KEY;

    const payment = pendingPayment(server, { credits: 25 });
    const body = stripeEvent(payment, { id: 'evt_no_pk' });
    const response = await server.post('/stripe', body, { 'stripe-signature': signStripe(body) });

    assert.equal(response.status, 200);
    assert.equal(server.balance(), 25, 'the payment was still credited');
  } finally {
    server.close();
  }
});

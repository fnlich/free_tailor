const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Asking for a refund, and an administrator deciding (owner decision M3).
 *
 * The claims, in the order a reviewer would check them:
 *
 *  - the STATES move exactly as the plan's table says - Requested -> Approved;
 *    Requested or Approved -> Declined (a reason required) or Refunded; the
 *    last two final - and a second click of the same button changes nothing;
 *  - REFUNDED MOVES THE MONEY ONCE, in the same step: a resume's charge back
 *    on the balance as one `refund-request` ledger row, a card purchase's
 *    unspent part through a partial Stripe refund (and only once Stripe
 *    accepts), a crypto purchase only after the administrator says it was
 *    sent back by hand - and never more than was charged and not yet given
 *    back;
 *  - ONE OPEN REQUEST PER ITEM, by the database;
 *  - somebody else's purchase or resume is a 404;
 *  - every state change NOTIFIES THE REQUESTER and nobody else, and a new
 *    request notifies each administrator;
 *  - and afterwards the ledger still adds up to every balance.
 *
 * Stripe is replaced at the integration boundary, as the payment tests do; the
 * queue runs for real with a stub runner where a live batch is needed.
 */

const PRICE = 23;

let seq = 0;

async function serve() {
  seq += 1;
  useTempStorage(`refund-requests-${seq}-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com', 'deputy@example.com');
  process.env.GENERATION_MAX_ATTEMPTS = '1';
  process.env.AI_CLI_CONCURRENCY = '2';
  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';

  loadFresh('../dist/database/sqlite');
  // Reloaded with the rest, not left cached from an earlier test: a module
  // holding the previous sqlite instance opens a SECOND connection to this
  // database, and one opened inside a request's write transaction waits on it.
  loadFresh('../dist/database/dailySequence');
  loadFresh('../dist/database/settingsRepository');
  loadFresh('../dist/database/generationRepository');
  const users = loadFresh('../dist/database/userRepository');
  const creditsDb = loadFresh('../dist/database/creditRepository');
  const paymentsDb = loadFresh('../dist/database/paymentRepository');
  const orders = loadFresh('../dist/database/orderRepository');
  const refundDb = loadFresh('../dist/database/refundRequestRepository');
  const notificationsDb = loadFresh('../dist/database/notificationRepository');
  const credits = loadFresh('../dist/services/credits');
  loadFresh('../dist/config/aiModelConfig');

  const stripe = loadFresh('../dist/integrations/stripe');
  const stripeRefunds = [];
  stripe.getCheckoutSession = async () => ({ id: 'cs_1', payment_intent: 'pi_1' });
  stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
    stripeRefunds.push({ intent, paymentId, amountCents });
  };

  const payments = loadFresh('../dist/services/payments');
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  const taskQueue = require('../dist/services/queue/taskQueue');
  const refunds = loadFresh('../dist/services/refunds');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/refundRequests');
  const notificationRoutes = loadFresh('../dist/routes/notifications');
  const paymentRoutes = loadFresh('../dist/routes/payments');

  const alice = users.createUser({ email: 'alice@example.com', name: 'Alice' });
  const bob = users.createUser({ email: 'bob@example.com', name: 'Bob' });
  const boss = users.createUser({ email: 'boss@example.com', name: 'Boss' });
  const deputy = users.createUser({ email: 'deputy@example.com', name: 'Deputy' });
  assert.equal(boss.role, 'admin');
  assert.equal(deputy.role, 'admin');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/refund-requests', routes.default);
  app.use('/api/admin/refund-requests', routes.adminRefundRequestsRouter);
  app.use('/api/notifications', notificationRoutes.default);
  app.use('/api/admin/notifications', notificationRoutes.adminNotificationsRouter);
  app.use('/api/admin/payments', paymentRoutes.adminPaymentsRouter);
  const server = app.listen(0);
  const port = server.address().port;

  const tokens = {
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
    boss: users.createSession(boss.id),
    deputy: users.createSession(deputy.id),
  };

  const call = async (who, path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const account = (id) => users.getUserById(id);

  /** A purchase of `dollars`, through the webhook's crediting, by card or crypto. */
  const purchase = (userId, dollars, method = 'card') => {
    const payment = paymentsDb.createPayment({
      userId,
      method,
      provider: method === 'card' ? 'stripe' : 'cryptomus',
      amountCents: dollars * 100,
      creditMilli: dollars * 1000,
      currency: 'usd',
    });
    paymentsDb.attachProviderRef(payment.id, method === 'card' ? `cs_${payment.id}` : `inv_${payment.id}`);
    payments.creditPaid(payment.id);
    return paymentsDb.getPayment(payment.id);
  };

  /** Spends `milli` of a balance, as resumes would. */
  const spend = (userId, milli) =>
    creditsDb.applyAdjustment({
      userId,
      deltaMilli: -milli,
      reason: 'admin-revoke',
      idempotencyKey: `spend:${Math.random()}`,
      note: 'spent on resumes',
    });

  /** One resume built synchronously by /resume/generate: charged, then settled (delivered) or released. */
  const syncCharge = (userId, { delivered = true, cost = PRICE } = {}) => {
    const id = credits.newReservationId();
    credits.reserveCredits(account(userId), cost, {
      kind: 'request',
      id,
      label: `Jane / Acme - ${credits.describeCharge([{ modelLabel: 'Claude', costMilli: cost }])}`,
    });
    if (delivered) credits.settleRun(id);
    else credits.releaseReservation(id, 'The run did not finish.');
    return id;
  };

  /** An order of resumes, charged at PRICE each, its items left in the given states. */
  const placeOrder = (userId, states, { charge = true } = {}) => {
    const batchId = taskQueue.newBatchId();
    if (charge) credits.reserveCredits(account(userId), states.length * PRICE, { kind: 'batch', id: batchId, label: 'order' });
    const order = orders.createOrder(
      { userId, batchId, label: 'An order', retentionDays: 5 },
      states.map((_, index) => ({
        seq: index,
        profileId: `p${index}`,
        profileName: 'Jane',
        companyName: `Company ${index}`,
        role: 'Engineer',
        costMilli: PRICE,
      }))
    );
    states.forEach((state, index) => {
      if (state === 'queued') return;
      const taskId = `tsk_${batchId}_${index}`;
      if (state === 'running') orders.markItemRunning(batchId, index);
      else orders.recordItemOutcome(batchId, index, { state, taskId });
      if (state === 'failed' || state === 'cancelled') credits.refundTaskUnit(batchId, taskId, PRICE, 'did not build');
    });
    if (states.every((state) => state !== 'queued' && state !== 'running')) credits.settleRun(batchId);
    return { order, items: orders.listOrderItems(order.id), batchId };
  };

  const feed = async (who) => (await call(who, '/api/notifications')).body;
  const ask = (who, itemType, itemId, reason = 'It was for the wrong company.') =>
    call(who, '/api/refund-requests', { method: 'POST', body: { itemType, itemId, reason } });
  const decide = (who, id, action, body = {}) =>
    call(who, `/api/admin/refund-requests/${id}/${action}`, { method: 'POST', body });

  return {
    users,
    creditsDb,
    paymentsDb,
    orders,
    refundDb,
    notificationsDb,
    credits,
    payments,
    stripe,
    stripeRefunds,
    queueModule,
    taskQueue,
    refunds,
    alice,
    bob,
    boss,
    deputy,
    call,
    ask,
    decide,
    feed,
    purchase,
    spend,
    syncCharge,
    placeOrder,
    balance: (id) => account(id).balanceMilli,
    ledger: (id) => credits.getLedger(id),
    close: () => server.close(),
  };
}

function assertBalancesAddUp(s) {
  assert.deepEqual(s.credits.findInconsistentBalances(), [], 'every balance is still the sum of its ledger');
}

test('a delivered resume is credited back exactly once, however often Refunded is pressed', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const charge = s.syncCharge(s.alice.id);
    assert.equal(s.balance(s.alice.id), 977);

    const asked = await s.ask('alice', 'charge', charge, '  Wrong company on the letter.  ');
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const request = asked.body.request;
    assert.equal(request.kind, 'resume');
    assert.equal(request.itemType, 'charge');
    assert.equal(request.state, 'requested');
    assert.equal(request.amountMilli, PRICE, "that resume's own charge, in thousandths");
    assert.equal(request.reason, 'Wrong company on the letter.', 'trimmed');
    assert.equal(request.label, 'Jane / Acme', 'the resume, not the charge breakdown');
    assert.match(request.reference, /^FT-RF-\d{8}-\d{4}$/);

    const first = await s.decide('boss', request.id, 'refund');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.changed, true);
    assert.equal(first.body.request.state, 'refunded');
    assert.equal(first.body.request.refundedMilli, PRICE);
    assert.deepEqual(first.body.outcome, { refundedMilli: PRICE, reversedMilli: 0, shortfallMilli: 0 });
    assert.equal(s.balance(s.alice.id), 1_000, 'the charge is back on the balance');

    const again = await s.decide('boss', request.id, 'refund');
    const deputy = await s.decide('deputy', request.id, 'refund');
    for (const reply of [again, deputy]) {
      assert.equal(reply.status, 200);
      assert.equal(reply.body.changed, false, 'a double click changes nothing');
      assert.equal(reply.body.outcome, null);
    }
    assert.equal(s.balance(s.alice.id), 1_000, 'and moves nothing');

    const refundRows = s.ledger(s.alice.id).filter((row) => row.reason === 'refund-request');
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0].deltaMilli, PRICE);
    assert.equal(refundRows[0].actorId, s.boss.id);
    assert.equal(refundRows[0].refId, charge, 'against the charge it gives back');
    assert.ok(s.creditsDb.isLedgerKeyUsed(`refund-request:${request.id}`), 'keyed on the request');
    // The run's own cap moved with it, so nothing can give it back again.
    assert.equal(s.credits.getReservation(charge).refundedMilli, PRICE);
    assertBalancesAddUp(s);

    // Final: nothing comes after Refunded.
    assert.equal((await s.decide('boss', request.id, 'approve')).status, 409);
    const decline = await s.decide('boss', request.id, 'decline', { reason: 'Changed my mind' });
    assert.equal(decline.status, 409);
    assert.equal(decline.body.code, 'request-final');

    // And the resume cannot be asked about again.
    const second = await s.ask('alice', 'charge', charge);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'not-refundable');
    assert.equal(second.body.why, 'refunded');
  } finally {
    s.close();
  }
});

test('Approved, then Declined with the administrator\'s reason, which is final', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const charge = s.syncCharge(s.alice.id);
    const { request } = (await s.ask('alice', 'charge', charge)).body;

    const approved = await s.decide('boss', request.id, 'approve');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.changed, true);
    assert.equal(approved.body.request.state, 'approved');
    assert.equal(approved.body.request.decidedBy, s.boss.id);
    assert.equal(s.balance(s.alice.id), 977, 'approving moves no money');

    const twice = await s.decide('boss', request.id, 'approve');
    assert.equal(twice.status, 200);
    assert.equal(twice.body.changed, false);

    for (const reason of [undefined, '', '   ']) {
      const refused = await s.decide('boss', request.id, 'decline', reason === undefined ? {} : { reason });
      assert.equal(refused.status, 400, `a decline without a reason (${JSON.stringify(reason)}) is refused`);
      assert.equal(refused.body.code, 'reason-required');
    }
    const overlong = await s.decide('boss', request.id, 'decline', { reason: 'x'.repeat(1001) });
    assert.equal(overlong.status, 400);
    assert.equal(overlong.body.code, 'reason-too-long');
    assert.equal(s.refundDb.getRefundRequest(request.id).state, 'approved', 'still approved after the refusals');

    const declined = await s.decide('boss', request.id, 'decline', { reason: '  The resume was delivered as asked.  ' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.request.state, 'declined');
    assert.equal(declined.body.request.declineReason, 'The resume was delivered as asked.');

    const declinedAgain = await s.decide('boss', request.id, 'decline', { reason: 'Something else' });
    assert.equal(declinedAgain.status, 200);
    assert.equal(declinedAgain.body.changed, false);
    assert.equal(declinedAgain.body.request.declineReason, 'The resume was delivered as asked.', 'the first reason stands');

    for (const action of ['approve', 'refund']) {
      const final = await s.decide('boss', request.id, action);
      assert.equal(final.status, 409, `${action} after Declined`);
      assert.equal(final.body.code, 'request-final');
    }
    assert.equal(s.balance(s.alice.id), 977, 'nothing moved');

    // The requester heard about each change - approve, decline - once each.
    const notices = (await s.feed('alice')).notifications.filter((notice) => notice.recipientId === s.alice.id);
    assert.equal(notices.length, 2);
    assert.match(notices[1].body, /was approved/);
    assert.match(notices[0].body, /was declined: The resume was delivered as asked\./);
    assert.equal(notices[0].link, '/credits?tab=refunds');

    // A declined request does not stop the next one.
    const next = await s.ask('alice', 'charge', charge, 'Asking again with more detail.');
    assert.equal(next.status, 201);
  } finally {
    s.close();
  }
});

test('one open request per item, held by the database', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const charge = s.syncCharge(s.alice.id);
    const first = await s.ask('alice', 'charge', charge);
    assert.equal(first.status, 201);

    const second = await s.ask('alice', 'charge', charge, 'Again');
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'request-open');
    assert.equal(second.body.requestId, first.body.request.id);

    // Approved is still open.
    await s.decide('boss', first.body.request.id, 'approve');
    assert.equal((await s.ask('alice', 'charge', charge)).status, 409);

    // Not the route's check alone: the partial UNIQUE index refuses a second
    // open row however it is written.
    assert.throws(
      () =>
        s.refundDb.insertRefundRequest({
          accountId: s.alice.id,
          kind: 'resume',
          itemType: 'charge',
          itemId: charge,
          label: 'x',
          amountMilli: PRICE,
          reason: 'direct',
        }),
      (error) => error instanceof s.refundDb.OpenRefundRequestExists
    );
  } finally {
    s.close();
  }
});

test("the reason is required, trimmed and capped; somebody else's item is a 404", async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const charge = s.syncCharge(s.alice.id);
    const payment = s.purchase(s.alice.id, 5);

    for (const reason of [undefined, '', '  \n ']) {
      const refused = await s.call('alice', '/api/refund-requests', {
        method: 'POST',
        body: { itemType: 'charge', itemId: charge, ...(reason === undefined ? {} : { reason }) },
      });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, 'reason-required');
    }
    const overlong = await s.ask('alice', 'charge', charge, 'y'.repeat(1001));
    assert.equal(overlong.status, 400);
    assert.equal(overlong.body.code, 'reason-too-long');

    for (const [itemType, itemId] of [
      ['charge', charge],
      ['payment', payment.id],
    ]) {
      const stranger = await s.ask('bob', itemType, itemId);
      assert.equal(stranger.status, 404, `${itemType}: 404, never 403`);
      assert.equal(stranger.body.code, 'not-found');
    }
    assert.equal((await s.call('bob', `/api/refund-requests/options?paymentId=${payment.id}`)).status, 404);

    const unknownType = await s.ask('alice', 'nonsense', charge);
    assert.equal(unknownType.status, 400);
    assert.equal(unknownType.body.code, 'bad-item');

    // An amount in the body is not read: the server measures it.
    const withAmount = await s.call('alice', '/api/refund-requests', {
      method: 'POST',
      body: { itemType: 'charge', itemId: charge, reason: 'please', amountMilli: 999_999, amountUsd: '999' },
    });
    assert.equal(withAmount.status, 201);
    assert.equal(withAmount.body.request.amountMilli, PRICE);

    // Each account lists its own and nobody else's.
    assert.equal((await s.call('alice', '/api/refund-requests')).body.total, 1);
    const bobs = await s.call('bob', '/api/refund-requests');
    assert.equal(bobs.status, 200);
    assert.deepEqual(bobs.body.requests, []);
    assert.equal(bobs.body.total, 0);
    assert.equal((await s.call(null, '/api/refund-requests')).status, 401);
    assert.equal((await s.call('alice', '/api/refund-requests?state=bogus')).status, 400);
  } finally {
    s.close();
  }
});

test('a card purchase refunds its unspent part through a partial Stripe refund', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 50);
    s.spend(s.alice.id, 10_007);
    assert.equal(s.balance(s.alice.id), 39_993);

    // What the dialog shows: the unspent part, in whole cents.
    const options = await s.call('alice', `/api/refund-requests/options?paymentId=${payment.id}`);
    assert.equal(options.status, 200);
    assert.equal(options.body.items.length, 1);
    const option = options.body.items[0];
    assert.equal(option.kind, 'purchase');
    assert.equal(option.chargedMilli, 50_000);
    assert.equal(option.refundableMilli, 39_990, '$39.993 left, and a card returns cents: $39.990');
    assert.equal(option.available, true);
    assert.equal(option.paymentMethod, 'card');

    const asked = await s.ask('alice', 'payment', payment.id, 'Not using it any more.');
    assert.equal(asked.status, 201);
    assert.equal(asked.body.request.amountMilli, 39_990);
    assert.equal(asked.body.request.paymentMethod, 'card');

    // The admin queue sees what Refunded would move right now.
    const queue = await s.call('boss', '/api/admin/refund-requests');
    assert.equal(queue.body.requests[0].refundableNowMilli, 39_990);
    assert.equal(queue.body.requests[0].accountEmail, 'alice@example.com');
    assert.equal(queue.body.requests[0].paymentProvider, 'stripe');

    const refunded = await s.decide('boss', asked.body.request.id, 'refund');
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
    assert.deepEqual(s.stripeRefunds, [{ intent: 'pi_1', paymentId: payment.id, amountCents: 3_999 }]);
    assert.deepEqual(refunded.body.outcome, { refundedMilli: 39_990, reversedMilli: 39_990, shortfallMilli: 0 });
    assert.equal(refunded.body.request.state, 'refunded');
    assert.equal(refunded.body.request.refundedMilli, 39_990);
    assert.equal(s.balance(s.alice.id), 3, 'the sub-cent remainder stays as credit');

    const stored = s.paymentsDb.getPayment(payment.id);
    assert.equal(stored.state, 'refunded');
    assert.equal(stored.refundCents, 3_999);

    const again = await s.decide('boss', asked.body.request.id, 'refund');
    assert.equal(again.body.changed, false);
    assert.equal(s.stripeRefunds.length, 1, 'Stripe is not asked twice');

    const notices = (await s.feed('alice')).notifications.filter((notice) => notice.recipientId === s.alice.id);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /was refunded \(\$39\.990\)/);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a purchase is re-measured when refunded, never above what was asked', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 50);
    const asked = await s.ask('alice', 'payment', payment.id);
    assert.equal(asked.body.request.amountMilli, 50_000);

    // Spent after asking: only what is left can go back.
    s.spend(s.alice.id, 30_000);
    const refunded = await s.decide('boss', asked.body.request.id, 'refund');
    assert.equal(refunded.status, 200);
    assert.equal(s.stripeRefunds[0].amountCents, 2_000);
    assert.equal(refunded.body.request.refundedMilli, 20_000);
    assert.equal(s.balance(s.alice.id), 0);

    // A second purchase's request is capped at what was asked, even when the
    // balance has since grown past it.
    const second = s.purchase(s.alice.id, 10);
    s.spend(s.alice.id, 4_000);
    const asked2 = await s.ask('alice', 'payment', second.id);
    assert.equal(asked2.body.request.amountMilli, 6_000);
    s.credits.setBalance(s.alice.id, 100_000, s.boss.id);
    const refunded2 = await s.decide('boss', asked2.body.request.id, 'refund');
    assert.equal(refunded2.body.request.refundedMilli, 6_000);
    assert.equal(s.stripeRefunds[1].amountCents, 600);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a card refund takes its credit off before Stripe is asked, and puts it back when Stripe refuses', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 20);
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;

    // While Stripe is being asked, the credit is already off the balance and
    // the payment claimed - so it cannot be spent, or measured again, meanwhile.
    const seen = [];
    s.stripe.refundPaymentIntent = async () => {
      seen.push({ balance: s.balance(s.alice.id), state: s.paymentsDb.getPayment(payment.id).state });
      throw new s.stripe.StripeError('The charge is disputed.');
    };
    const failed = await s.decide('boss', request.id, 'refund');
    assert.equal(failed.status, 502);
    assert.match(failed.body.ref, /^ERR-/);
    assert.ok(failed.body.detail, 'an administrator gets the cause');
    assert.deepEqual(seen, [{ balance: 0, state: 'refunding' }]);

    const after = s.refundDb.getRefundRequest(request.id);
    assert.equal(after.state, 'requested', 'not refunded while Stripe refused');
    assert.equal(after.attemptMilli, null, 'a refusal leaves nothing outstanding');
    assert.equal(after.holdKey, null);
    assert.equal(s.balance(s.alice.id), 20_000, 'the held credit went back');
    assert.equal(s.paymentsDb.getPayment(payment.id).state, 'paid');
    const rows = s.ledger(s.alice.id).filter((entry) => entry.reason.startsWith('purchase-refund'));
    assert.deepEqual(
      rows.map((entry) => [entry.reason, entry.deltaMilli]).sort(),
      [
        ['purchase-refund', -20_000],
        ['purchase-refund-failed', 20_000],
      ]
    );

    // Spent in between: the next press measures again and sends what is left.
    s.spend(s.alice.id, 5_000);
    const sent = [];
    s.stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
      sent.push(amountCents);
    };
    const retried = await s.decide('boss', request.id, 'refund');
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual(sent, [1_500]);
    assert.deepEqual(retried.body.outcome, { refundedMilli: 15_000, reversedMilli: 15_000, shortfallMilli: 0 });
    assert.equal(s.balance(s.alice.id), 0);
    assert.equal(s.paymentsDb.getPayment(payment.id).refundCents, 1_500);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a card refund Stripe did not answer keeps its credit held, and the retry sends the same amount', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 20);
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;

    s.stripe.refundPaymentIntent = async () => {
      throw new s.stripe.StripeError('Could not reach Stripe: socket hang up', 502, true);
    };
    const lost = await s.decide('boss', request.id, 'refund');
    assert.equal(lost.status, 502);
    assert.match(lost.body.error, /Could not confirm the refund with Stripe/);
    const held = s.refundDb.getRefundRequest(request.id);
    assert.equal(held.attemptMilli, 20_000, 'what was sent is written down');
    assert.ok(held.holdKey);
    assert.equal(s.balance(s.alice.id), 0, 'and its credit stays held: the money may be on its way back');
    assert.equal(s.paymentsDb.getPayment(payment.id).state, 'paid', 'the claim itself is released');

    // Nothing can take that credit meanwhile: not a run...
    assert.throws(
      () => s.credits.reserveCredits(s.users.getUserById(s.alice.id), 9_000, { kind: 'batch', id: 'b_spend' }),
      /credit/i
    );
    // ...not a Decline, which would tell her no money moved...
    const declined = await s.decide('deputy', request.id, 'decline', { reason: 'Changed my mind.' });
    assert.equal(declined.status, 409);
    assert.equal(declined.body.code, 'refund-unconfirmed');
    // ...and not a whole refund from the payments list, which would take it twice.
    const direct = await s.call('deputy', `/api/admin/payments/${payment.id}/refund`, { method: 'POST', body: {} });
    assert.equal(direct.status, 409);
    assert.match(direct.body.error, /has not confirmed yet/);
    assert.equal(s.paymentsDb.getPayment(payment.id).state, 'paid');

    // The retry sends the SAME body under the same key, and takes nothing more.
    const sent = [];
    s.stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
      sent.push(amountCents);
    };
    const retried = await s.decide('boss', request.id, 'refund');
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual(sent, [2_000]);
    assert.deepEqual(retried.body.outcome, { refundedMilli: 20_000, reversedMilli: 20_000, shortfallMilli: 0 });
    const reversals = s.ledger(s.alice.id).filter((entry) => entry.reason === 'purchase-refund');
    assert.equal(reversals.length, 1, 'the credit came off once');
    assert.equal(s.balance(s.alice.id), 0);
    assert.equal(s.paymentsDb.getPayment(payment.id).state, 'refunded');
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a Decline while the card refund is with Stripe is refused, and the request ends Refunded', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 40);
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    s.stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
      await held;
      s.stripeRefunds.push({ amountCents });
    };

    const refunding = s.decide('boss', request.id, 'refund');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const declined = await s.decide('deputy', request.id, 'decline', { reason: 'Credit was already used.' });
    assert.equal(declined.status, 409);
    assert.equal(declined.body.code, 'refunding');
    release();
    const refunded = await refunding;
    assert.equal(refunded.status, 200);
    assert.equal(refunded.body.changed, true);
    assert.equal(s.refundDb.getRefundRequest(request.id).state, 'refunded');
    const own = (await s.feed('alice')).notifications.filter((entry) => entry.recipientId === s.alice.id);
    assert.deepEqual(own.map((entry) => entry.title), ['Refund made'], 'told the truth, and only that');

    // The same from the payments list: the decline waits, the refund closes the request.
    const second = s.purchase(s.bob.id, 10);
    const asked = (await s.ask('bob', 'payment', second.id)).body.request;
    let releaseList = () => {};
    const heldList = new Promise((resolve) => {
      releaseList = resolve;
    });
    s.stripe.refundPaymentIntent = async () => {
      await heldList;
    };
    const direct = s.call('boss', `/api/admin/payments/${second.id}/refund`, { method: 'POST', body: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const declined2 = await s.decide('deputy', asked.id, 'decline', { reason: 'No.' });
    assert.equal(declined2.status, 409);
    assert.equal(declined2.body.code, 'refunding');
    releaseList();
    assert.equal((await direct).body.closedRequests, 1);
    assert.equal(s.refundDb.getRefundRequest(asked.id).state, 'refunded');
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a Decline of a purchase refunded already closes the request as Refunded instead', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 10);
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;
    // Refunded by a path that did not close the request (an older tab, a failed close).
    await s.payments.refundPayment(payment.id, s.boss.id, 'by the service');
    const declined = await s.decide('deputy', request.id, 'decline', { reason: 'Too late.' });
    assert.equal(declined.status, 409);
    assert.equal(declined.body.code, 'request-final');
    assert.equal(declined.body.state, 'refunded');
    const closed = s.refundDb.getRefundRequest(request.id);
    assert.equal(closed.state, 'refunded');
    assert.equal(closed.refundedMilli, 10_000);
    const own = (await s.feed('alice')).notifications.filter((entry) => entry.recipientId === s.alice.id);
    assert.deepEqual(own.map((entry) => entry.title), ['Refund made']);
  } finally {
    s.close();
  }
});

test('card refunds racing the buyer, or each other, never pay out more than is unspent', async () => {
  const s = await serve();
  try {
    // Two purchases, $5 spent: $15 is unspent, and each asks for $10.
    const first = s.purchase(s.alice.id, 10);
    const second = s.purchase(s.alice.id, 10);
    s.spend(s.alice.id, 5_000);
    const a = (await s.ask('alice', 'payment', first.id)).body.request;
    const b = (await s.ask('alice', 'payment', second.id)).body.request;
    assert.deepEqual([a.amountMilli, b.amountMilli], [10_000, 10_000]);

    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const sent = [];
    s.stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
      await held;
      sent.push(amountCents);
    };
    const one = s.decide('boss', a.id, 'refund');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const two = s.decide('deputy', b.id, 'refund');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The buyer, meanwhile, cannot spend what is on its way back.
    assert.equal(s.balance(s.alice.id), 0);
    release();
    const replies = await Promise.all([one, two]);
    assert.deepEqual(replies.map((reply) => reply.status), [200, 200]);
    assert.equal(sent.reduce((sum, cents) => sum + cents, 0), 1_500, '$15 unspent, $15 back - not $20');
    for (const reply of replies) assert.equal(reply.body.outcome.shortfallMilli, 0);
    assert.equal(s.balance(s.alice.id), 0);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('two Refunded clicks at once make one Stripe refund', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 30);
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const sent = [];
    s.stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
      await held;
      sent.push(amountCents);
    };
    const first = s.decide('boss', request.id, 'refund');
    const second = s.decide('deputy', request.id, 'refund');
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies.map((reply) => reply.status), [200, 200]);
    assert.deepEqual(replies.map((reply) => reply.body.changed).sort(), [false, true]);
    assert.deepEqual(sent, [3_000]);
    assert.equal(s.balance(s.alice.id), 0);
  } finally {
    s.close();
  }
});

test('crypto is refunded only once the administrator has sent it back by hand', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 60, 'crypto');
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;
    assert.equal(request.paymentMethod, 'crypto');

    const unconfirmed = await s.decide('boss', request.id, 'refund');
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.code, 'paid-by-hand-required');
    assert.equal(unconfirmed.body.amountMilli, 60_000, 'with the amount to send back');
    assert.match(unconfirmed.body.error, /Cryptomus merchant dashboard/);
    assert.equal(s.refundDb.getRefundRequest(request.id).state, 'requested');
    assert.equal(s.balance(s.alice.id), 60_000);

    // What was sent is said, never measured again: the money has already gone.
    const unsaid = await s.decide('boss', request.id, 'refund', { paidByHand: true });
    assert.equal(unsaid.status, 400);
    assert.equal(unsaid.body.code, 'bad-amount');
    const tooMuch = await s.decide('boss', request.id, 'refund', { paidByHand: true, amountUsd: '70' });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.code, 'bad-amount');
    const subCent = await s.decide('boss', request.id, 'refund', { paidByHand: true, amountUsd: '10.005' });
    assert.equal(subCent.status, 400);

    const confirmed = await s.decide('boss', request.id, 'refund', { paidByHand: true, amountUsd: '25' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.request.state, 'refunded');
    assert.equal(confirmed.body.request.refundedMilli, 25_000);
    assert.equal(s.balance(s.alice.id), 35_000, 'the credit for what was sent back is reversed');
    assert.equal(s.stripeRefunds.length, 0, 'no provider is asked');
    assert.equal(s.paymentsDb.getPayment(payment.id).state, 'refunded');

    const notice = (await s.feed('alice')).notifications.find((entry) => entry.recipientId === s.alice.id);
    assert.match(notice.body, /refunded \(\$25\.000\)\. Your administrator has sent it back to you\./);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('crypto sent back by hand is recorded as sent, and spending since is a reported shortfall', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 10, 'crypto');
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;
    // The queue showed $10.000; she spends $3 before the administrator, who has
    // sent the $10 back, confirms it.
    s.spend(s.alice.id, 3_000);
    const confirmed = await s.decide('boss', request.id, 'refund', { paidByHand: true, amountUsd: '10.00' });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body.outcome, { refundedMilli: 10_000, reversedMilli: 7_000, shortfallMilli: 3_000 });
    assert.equal(confirmed.body.request.refundedMilli, 10_000);
    assert.equal(s.paymentsDb.getPayment(payment.id).refundCents, 1_000);
    assert.equal(s.balance(s.alice.id), 0);

    // Spent to nothing before the confirmation: still recorded, since the money went back.
    const second = s.purchase(s.bob.id, 5, 'crypto');
    const asked = (await s.ask('bob', 'payment', second.id)).body.request;
    s.spend(s.bob.id, 5_000);
    const allSpent = await s.decide('boss', asked.id, 'refund', { paidByHand: true, amountUsd: '5' });
    assert.equal(allSpent.status, 200, JSON.stringify(allSpent.body));
    assert.deepEqual(allSpent.body.outcome, { refundedMilli: 5_000, reversedMilli: 0, shortfallMilli: 5_000 });
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test("an order's resumes: a delivered one is refundable, a failed one already gave its charge back", async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const { order, items, batchId } = s.placeOrder(s.alice.id, ['done', 'failed', 'done']);
    assert.equal(s.balance(s.alice.id), 1_000 - 3 * PRICE + PRICE, 'the failed one refunded itself');

    const options = await s.call('alice', `/api/refund-requests/options?orderId=${order.id}`);
    assert.equal(options.status, 200);
    const [done, failed] = options.body.items;
    assert.equal(done.itemType, 'order-item');
    assert.equal(done.available, true);
    assert.equal(done.refundableMilli, PRICE);
    assert.equal(done.chargedMilli, PRICE);
    assert.match(done.label, /^FT-\d{8}-\d{4} - Jane \/ Company 0 \(Engineer\)$/);
    assert.equal(failed.available, false);
    assert.equal(failed.unavailableCode, 'auto-refunded');

    const refusedFailed = await s.ask('alice', 'order-item', items[1].id);
    assert.equal(refusedFailed.status, 409);
    assert.equal(refusedFailed.body.why, 'auto-refunded');

    const { request } = (await s.ask('alice', 'order-item', items[0].id)).body;
    const refunded = await s.decide('boss', request.id, 'refund');
    assert.equal(refunded.status, 200);
    assert.equal(refunded.body.request.refundedMilli, PRICE);
    assert.equal(s.balance(s.alice.id), 1_000 - PRICE, 'one delivered resume still charged');
    // Into the CLOSED run's reservation, under its cap.
    const reservation = s.credits.getReservation(batchId);
    assert.equal(reservation.state, 'closed');
    assert.equal(reservation.refundedMilli, 2 * PRICE);

    // The same order seen from its charge row in the credit history.
    const viaCharge = await s.call('alice', `/api/refund-requests/options?chargeId=${batchId}`);
    assert.equal(viaCharge.body.items.length, 3);
    assert.equal(viaCharge.body.items[0].unavailableCode, 'refunded');
    assert.equal(viaCharge.body.items[2].available, true);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a resume still being built, a free one and an administrator\'s are not refundable', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const running = s.placeOrder(s.alice.id, ['running', 'queued']);
    for (const item of running.items) {
      const refused = await s.ask('alice', 'order-item', item.id);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.why, 'in-progress');
    }

    const open = s.credits.newReservationId();
    s.credits.reserveCredits(s.users.getUserById(s.alice.id), PRICE, { kind: 'request', id: open, label: 'x' });
    assert.equal((await s.ask('alice', 'charge', open)).body.why, 'in-progress');

    const failedSync = s.syncCharge(s.alice.id, { delivered: false });
    assert.equal((await s.ask('alice', 'charge', failedSync)).body.why, 'auto-refunded');

    // No reservation: an administrator's run, or a free one.
    const exempt = s.placeOrder(s.boss.id, ['done'], { charge: false });
    const bossItem = await s.call('boss', `/api/refund-requests/options?orderId=${exempt.order.id}`);
    assert.equal(bossItem.body.items[0].unavailableCode, 'not-charged');

    // A batch charge is several resumes: one of them must be named.
    const batch = s.placeOrder(s.alice.id, ['done']);
    const whole = await s.ask('alice', 'charge', batch.batchId);
    assert.equal(whole.status, 400);
    assert.equal(whole.body.code, 'bad-item');
  } finally {
    s.close();
  }
});

test('a queued resume not placed as an order is named by its task, and stays refundable after its batch is evicted', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const kind = `refund-stub-${Math.random()}`;
    s.taskQueue.registerTaskRunner(kind, async () => 'built');
    const queue = s.queueModule.getGenerationQueue();
    const batchId = s.taskQueue.newBatchId();
    s.credits.reserveCredits(s.users.getUserById(s.alice.id), 2 * PRICE, { kind: 'batch', id: batchId, label: 'run' });
    const task = (label) => ({
      queue: 'cli',
      label: { profileId: label, profileName: 'Jane', companyName: label, role: '' },
      kind,
      payload: { costMilli: PRICE },
    });
    queue.submit([task('Acme'), task('Globex')], { id: batchId, shared: { ownerId: s.alice.id } });
    await queue.refreshCapacity();
    const deadline = Date.now() + 3000;
    while (queue.snapshot(batchId).completed < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(queue.snapshot(batchId).completed, 2);

    const options = await s.call('alice', `/api/refund-requests/options?chargeId=${batchId}`);
    assert.equal(options.body.items.length, 2);
    assert.equal(options.body.items[0].itemType, 'task');
    assert.equal(options.body.items[0].refundableMilli, PRICE);

    const taskId = queue.getBatch(batchId).tasks[0].id;
    const { request } = (await s.ask('alice', 'task', taskId)).body;
    assert.equal(request.itemType, 'task');

    // Bob cannot name it.
    assert.equal((await s.ask('bob', 'task', taskId)).status, 404);

    // The queue forgets the batch; the request still refunds against the run.
    s.queueModule.resetGenerationQueueForTests();
    const refunded = await s.decide('boss', request.id, 'refund');
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
    assert.equal(refunded.body.request.refundedMilli, PRICE);
    assert.equal(s.balance(s.alice.id), 1_000 - PRICE);

    const gone = await s.call('alice', `/api/refund-requests/options?chargeId=${batchId}`);
    assert.deepEqual(gone.body.items, []);
    assert.match(gone.body.note, /no longer listed/);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test("an order's task is always named by its order item, so one resume has one name", async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const kind = `refund-order-stub-${Math.random()}`;
    s.taskQueue.registerTaskRunner(kind, async () => 'built');
    const queue = s.queueModule.getGenerationQueue();
    const batchId = s.taskQueue.newBatchId();
    s.credits.reserveCredits(s.users.getUserById(s.alice.id), PRICE, { kind: 'batch', id: batchId, label: 'order' });
    s.orders.createOrder({ userId: s.alice.id, batchId, retentionDays: 5 }, [
      { seq: 0, profileId: 'p', profileName: 'Jane', companyName: 'Acme', role: '', costMilli: PRICE },
    ]);
    queue.submit(
      [{ queue: 'cli', label: { profileId: 'p', profileName: 'Jane', companyName: 'Acme', role: '' }, kind, payload: { costMilli: PRICE } }],
      { id: batchId, shared: { ownerId: s.alice.id, kind: 'order' } }
    );
    await queue.refreshCapacity();
    const deadline = Date.now() + 3000;
    while (queue.snapshot(batchId).completed < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const taskId = queue.getBatch(batchId).tasks[0].id;
    s.orders.recordItemOutcome(batchId, 0, { state: 'done', taskId });

    const viaTask = await s.ask('alice', 'task', taskId);
    assert.equal(viaTask.status, 201, JSON.stringify(viaTask.body));
    assert.equal(viaTask.body.request.itemType, 'order-item');
    const itemId = viaTask.body.request.itemId;
    const viaItem = await s.ask('alice', 'order-item', itemId);
    assert.equal(viaItem.status, 409);
    assert.equal(viaItem.body.code, 'request-open', 'the same resume, so the same open request');
  } finally {
    s.close();
  }
});

test('the admin queue: guarded, filtered, counted, and oldest first while open', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    s.credits.setBalance(s.bob.id, 1_000, s.boss.id);
    const a = (await s.ask('alice', 'charge', s.syncCharge(s.alice.id))).body.request;
    const b = (await s.ask('bob', 'charge', s.syncCharge(s.bob.id))).body.request;
    const c = (await s.ask('alice', 'charge', s.syncCharge(s.alice.id))).body.request;
    await s.decide('boss', b.id, 'approve');
    await s.decide('boss', c.id, 'decline', { reason: 'No.' });

    assert.equal((await s.call(null, '/api/admin/refund-requests')).status, 401);
    assert.equal((await s.call('alice', '/api/admin/refund-requests')).status, 403);
    assert.equal((await s.decide('alice', a.id, 'refund')).status, 403);
    assert.equal((await s.decide('alice', a.id, 'approve')).status, 403);
    assert.equal((await s.call('boss', '/api/admin/refund-requests?state=nope')).status, 400);

    const open = await s.call('boss', '/api/admin/refund-requests');
    assert.deepEqual(
      open.body.requests.map((request) => request.id),
      [a.id, b.id],
      'requested and approved, oldest first'
    );
    assert.equal(open.body.total, 2);
    assert.deepEqual(open.body.counts, { requested: 1, approved: 1, declined: 1, refunded: 0 });

    const declined = await s.call('boss', '/api/admin/refund-requests?state=declined');
    assert.deepEqual(declined.body.requests.map((request) => request.id), [c.id]);
    assert.equal(declined.body.requests[0].refundableNowMilli, null, 'nothing to measure on a final request');

    const all = await s.call('boss', '/api/admin/refund-requests?state=all');
    assert.equal(all.body.total, 3);
    assert.equal((await s.decide('boss', 'rfr_nothing', 'approve')).status, 404);
  } finally {
    s.close();
  }
});

test('a new request tells each administrator, and every change tells only the requester', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    // An announcement everybody reads, before and after.
    s.notificationsDb.createNotification({ title: 'Maintenance on Sunday', authorId: s.boss.id, authorName: 'Boss' });

    const { request } = (await s.ask('alice', 'charge', s.syncCharge(s.alice.id), 'Typo in my name.')).body;

    for (const admin of ['boss', 'deputy']) {
      const adminFeed = await s.feed(admin);
      const notice = adminFeed.notifications.find((entry) => entry.recipientId !== null);
      assert.ok(notice, `${admin} is told`);
      assert.match(notice.title, /^New refund request FT-RF-/);
      assert.match(notice.body, /alice@example\.com asks for \$0\.023 back/);
      assert.match(notice.body, /Typo in my name\./);
      assert.equal(notice.link, '/admin/payments?tab=refunds');
      assert.equal(adminFeed.unreadCount, 2, 'the announcement and the request');
    }
    let alice = await s.feed('alice');
    assert.equal(alice.notifications.length, 1, 'only the announcement - the request notice is the admins\'');
    assert.equal(alice.unreadCount, 1);
    assert.equal((await s.feed('bob')).notifications.length, 1);

    await s.decide('boss', request.id, 'approve');
    await s.decide('boss', request.id, 'refund');
    alice = await s.feed('alice');
    const own = alice.notifications.filter((entry) => entry.recipientId === s.alice.id);
    assert.equal(own.length, 2);
    assert.match(own[0].body, /^Your refund request for .+ was refunded \(\$0\.023\)\. It is back on your balance\.$/);
    assert.match(own[1].body, /was approved/);
    assert.equal(alice.unreadCount, 3);

    // Bob reads the announcement and nothing of Alice's.
    const bob = await s.feed('bob');
    assert.deepEqual(bob.notifications.map((entry) => entry.title), ['Maintenance on Sunday']);
    assert.equal(bob.unreadCount, 1);

    // The announcement editor lists announcements only.
    const editor = await s.call('boss', '/api/admin/notifications');
    assert.deepEqual(editor.body.notifications.map((entry) => entry.title), ['Maintenance on Sunday']);
    // And cannot reword or delete what the app told one account.
    const aliceNotice = own[0];
    const patched = await s.call('boss', `/api/admin/notifications/${aliceNotice.id}`, {
      method: 'PATCH',
      body: { title: 'Rewritten' },
    });
    assert.equal(patched.status, 404);
    assert.equal(
      (await s.call('boss', `/api/admin/notifications/${aliceNotice.id}`, { method: 'DELETE' })).status,
      404
    );
  } finally {
    s.close();
  }
});

test('a refund made from the payments list answers the open request for it', async () => {
  const s = await serve();
  try {
    const payment = s.purchase(s.alice.id, 40);
    const { request } = (await s.ask('alice', 'payment', payment.id)).body;

    const direct = await s.call('boss', `/api/admin/payments/${payment.id}/refund`, { method: 'POST', body: {} });
    assert.equal(direct.status, 200, JSON.stringify(direct.body));
    assert.equal(direct.body.closedRequests, 1);
    assert.equal(direct.body.refundAmountMilli, 40_000, 'the whole charge went back');
    assert.equal(direct.body.payment.refundAmountMilli, 40_000);

    const closed = s.refundDb.getRefundRequest(request.id);
    assert.equal(closed.state, 'refunded');
    assert.equal(closed.refundedMilli, 40_000);
    const notice = (await s.feed('alice')).notifications.find((entry) => entry.recipientId === s.alice.id);
    assert.match(notice.body, /refunded \(\$40\.000\)/);

    // Pressing Refunded on it now changes nothing and asks Stripe nothing more.
    const again = await s.decide('boss', request.id, 'refund');
    assert.equal(again.body.changed, false);
    assert.equal(s.stripeRefunds.length, 1);
    assertBalancesAddUp(s);
  } finally {
    s.close();
  }
});

test('a resume refund for an account deleted since is refused rather than credited to nobody', async () => {
  const s = await serve();
  try {
    s.credits.setBalance(s.alice.id, 1_000, s.boss.id);
    const { request } = (await s.ask('alice', 'charge', s.syncCharge(s.alice.id))).body;
    s.users.deleteUser(s.alice.id);
    const refused = await s.decide('boss', request.id, 'refund');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'account-missing');
    const declined = await s.decide('boss', request.id, 'decline', { reason: 'Account closed.' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.request.accountEmail, '');
    // Its own notices went with it.
    assert.equal(
      s.notificationsDb.listNotificationsFor(s.alice.id).filter((entry) => entry.recipientId === s.alice.id).length,
      0
    );
  } finally {
    s.close();
  }
});

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * A reporter asking to be paid out, and an administrator recording what they
 * sent (owner decisions R1, R2).
 *
 * The claims:
 *
 *  - only a REPORTER asks (a user is refused by role, an administrator by the
 *    service), for the whole balance as it stands, once at a time, never at $0;
 *    every administrator is told, and nobody else;
 *  - Approve and Decline tell the reporter alone, in payout words;
 *  - Record payout writes exactly ONE `reporter-payout` row, keyed by the
 *    request, for what the administrator says they sent - anything up to the
 *    balance at that moment - and turns the request Refunded ("Paid out") in
 *    the same step; a double press records once; anything it refuses (above
 *    the balance, no longer a reporter, the account gone) moves nothing and
 *    leaves the request open;
 *  - Admin -> Accounts' own payout closes the open request in the same step,
 *    so the queue cannot pay it a second time;
 *  - and the ledger adds up to every balance throughout.
 */

let seq = 0;

async function serve() {
  seq += 1;
  useTempStorage(`payout-requests-${seq}-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com', 'deputy@example.com');

  loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/dailySequence');
  loadFresh('../dist/database/settingsRepository');
  loadFresh('../dist/database/generationRepository');
  const users = loadFresh('../dist/database/userRepository');
  const creditsDb = loadFresh('../dist/database/creditRepository');
  loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/database/orderRepository');
  const refundDb = loadFresh('../dist/database/refundRequestRepository');
  loadFresh('../dist/database/notificationRepository');
  const credits = loadFresh('../dist/services/credits');
  loadFresh('../dist/config/aiModelConfig');
  loadFresh('../dist/services/payments');
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  const refunds = loadFresh('../dist/services/refunds');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/refundRequests');
  const notificationRoutes = loadFresh('../dist/routes/notifications');
  const accountRoutes = loadFresh('../dist/routes/accounts');
  const db = require('../dist/database/sqlite').getDb();

  const boss = users.createUser({ email: 'boss@example.com', name: 'Boss' });
  const deputy = users.createUser({ email: 'deputy@example.com', name: 'Deputy' });
  const alice = users.createUser({ email: 'alice@example.com', name: 'Alice' });
  const scout = users.createUser({ email: 'scout@example.com', name: 'Scout', role: 'reporter' });
  const ranger = users.createUser({ email: 'ranger@example.com', name: 'Ranger', role: 'reporter' });
  const idle = users.createUser({ email: 'idle@example.com', name: 'Idle', role: 'reporter' });
  assert.equal(boss.role, 'admin');
  assert.equal(scout.role, 'reporter');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/refund-requests', routes.default);
  app.use('/api/admin/refund-requests', routes.adminRefundRequestsRouter);
  app.use('/api/notifications', notificationRoutes.default);
  app.use('/api/admin/accounts', accountRoutes.default);
  const server = app.listen(0);
  const port = server.address().port;

  const ids = { boss, deputy, alice, scout, ranger, idle };
  const tokens = Object.fromEntries(Object.entries(ids).map(([who, account]) => [who, users.createSession(account.id)]));

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

  /** Earnings, as the lake pays them: credit on a reporter's balance. */
  const earn = (who, milli) => credits.grantCredits(ids[who].id, milli, boss.id, 'Job rewards');
  const ask = (who, reason) =>
    call(who, '/api/refund-requests/payout', { method: 'POST', body: reason === undefined ? {} : { reason } });
  const record = (who, requestId, body) =>
    call(who, `/api/admin/refund-requests/${requestId}/refund`, { method: 'POST', body });
  const decide = (who, requestId, action, body = {}) =>
    call(who, `/api/admin/refund-requests/${requestId}/${action}`, { method: 'POST', body });
  const feed = async (who) => (await call(who, '/api/notifications')).body.notifications ?? [];
  const balance = (who) => users.getUserById(ids[who].id)?.balanceMilli ?? 0;
  const payoutRows = (who) =>
    db
      .prepare(
        `SELECT idempotency_key AS key, delta_milli AS delta, note FROM credit_ledger
          WHERE user_id = ? AND reason = 'reporter-payout' ORDER BY created_at, rowid`
      )
      .all(ids[who].id);
  const queueRow = async (requestId) =>
    (await call('boss', '/api/admin/refund-requests?state=all')).body.requests.find((row) => row.id === requestId);
  const addsUp = () =>
    assert.deepEqual(credits.findInconsistentBalances(), [], 'every balance is still the sum of its ledger');

  return {
    users,
    creditsDb,
    refundDb,
    credits,
    refunds,
    ids,
    call,
    earn,
    ask,
    record,
    decide,
    feed,
    balance,
    payoutRows,
    queueRow,
    addsUp,
    close: () => server.close(),
  };
}

test('a reporter asks for their whole balance; every administrator is told, and nobody else', async () => {
  const s = await serve();
  try {
    s.earn('scout', 5_000);
    const before = await s.call('scout', '/api/refund-requests/payout');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, {
      balanceMilli: 5_000,
      openRequest: null,
      available: true,
      unavailableCode: null,
      unavailableReason: null,
    });

    const asked = await s.ask('scout', '  PayPal, please.  ');
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const request = asked.body.request;
    assert.equal(request.kind, 'payout');
    assert.equal(request.itemType, 'payout');
    assert.equal(request.itemId, s.ids.scout.id, 'the account itself is the item');
    assert.equal(request.amountMilli, 5_000, 'the balance as it stands');
    assert.equal(request.label, 'Payout of earnings');
    assert.equal(request.reason, 'PayPal, please.');
    assert.equal(request.state, 'requested');
    assert.match(request.reference, /^FT-RF-\d{8}-\d{4}$/);
    assert.equal(asked.body.status.unavailableCode, 'request-open');
    assert.equal(asked.body.status.openRequest.id, request.id);
    assert.equal(s.balance('scout'), 5_000, 'asking moves nothing');

    for (const admin of ['boss', 'deputy']) {
      const notices = (await s.feed(admin)).filter((notice) => notice.title === `New payout request ${request.reference}`);
      assert.equal(notices.length, 1, `${admin} is told once`);
      assert.equal(notices[0].link, '/admin/payments?tab=refunds');
      assert.match(notices[0].body, /^scout@example\.com asks to be paid out \$5 of earnings: "PayPal, please\."$/);
    }
    for (const other of ['scout', 'alice', 'ranger']) {
      assert.deepEqual(
        (await s.feed(other)).filter((notice) => /payout request/i.test(notice.title)),
        [],
        `${other} is not told`
      );
    }

    // The reporter's own list, by kind.
    const mine = await s.call('scout', '/api/refund-requests?kind=payout');
    assert.deepEqual(mine.body.requests.map((row) => row.id), [request.id]);
    assert.equal((await s.call('scout', '/api/refund-requests?kind=purchase')).body.total, 0);

    // The note is optional.
    s.earn('ranger', 1);
    const bare = await s.ask('ranger');
    assert.equal(bare.status, 201);
    assert.equal(bare.body.request.reason, '');
    assert.equal(bare.body.request.amountMilli, 1);
    const adminNotice = (await s.feed('boss')).find((notice) => notice.title === `New payout request ${bare.body.request.reference}`);
    assert.equal(adminNotice.body, 'ranger@example.com asks to be paid out $0.001 of earnings.');
    s.addsUp();
  } finally {
    s.close();
  }
});

test('one open payout request at a time, never at $0, and only a reporter asks', async () => {
  const s = await serve();
  try {
    s.earn('scout', 2_500);
    const first = await s.ask('scout', 'Bank, please');
    assert.equal(first.status, 201);

    const again = await s.ask('scout', 'And again');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'request-open');
    assert.equal(again.body.requestId, first.body.request.id);
    const status = (await s.call('scout', '/api/refund-requests/payout')).body;
    assert.equal(status.available, false);
    assert.equal(status.unavailableCode, 'request-open');
    assert.equal(status.openRequest.id, first.body.request.id);
    assert.equal(s.refundDb.countRefundRequests(), 1);

    // Two presses at once: the IMMEDIATE transaction and the index ask once.
    s.earn('ranger', 700);
    const pair = await Promise.all([s.ask('ranger', 'a'), s.ask('ranger', 'b')]);
    assert.deepEqual(pair.map((answer) => answer.status).sort(), [201, 409]);

    // Nothing earned.
    const idleStatus = (await s.call('idle', '/api/refund-requests/payout')).body;
    assert.equal(idleStatus.balanceMilli, 0);
    assert.equal(idleStatus.available, false);
    assert.equal(idleStatus.unavailableCode, 'nothing-to-pay-out');
    const zero = await s.ask('idle', 'anything?');
    assert.equal(zero.status, 409);
    assert.equal(zero.body.code, 'nothing-to-pay-out');
    assert.equal(zero.body.error, idleStatus.unavailableReason);

    // A user is refused by role; an administrator, whom the guard lets through, by the service.
    const user = await s.ask('alice', 'x');
    assert.equal(user.status, 403);
    assert.equal(user.body.code, 'role-not-allowed');
    assert.equal((await s.call('alice', '/api/refund-requests/payout')).status, 403);
    s.credits.grantCredits(s.ids.boss.id, 9_000, s.ids.boss.id, 'test');
    const admin = await s.ask('boss', 'pay me');
    assert.equal(admin.status, 409);
    assert.equal(admin.body.code, 'not-a-reporter');
    assert.equal((await s.call('boss', '/api/refund-requests/payout')).body.unavailableCode, 'not-a-reporter');
    assert.equal((await s.call(null, '/api/refund-requests/payout')).status, 401);

    // A note is capped.
    const long = await s.ask('ranger', 'y'.repeat(1001));
    assert.equal(long.status, 400);
    assert.equal(long.body.code, 'reason-too-long');
    s.addsUp();
  } finally {
    s.close();
  }
});

test('approve and decline tell the reporter alone, in payout words', async () => {
  const s = await serve();
  try {
    s.earn('scout', 1_000);
    s.earn('ranger', 1_000);
    const a = (await s.ask('scout', 'one')).body.request;
    const b = (await s.ask('ranger', 'two')).body.request;

    const approved = await s.decide('boss', a.id, 'approve');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.request.state, 'approved');
    const approvedNotice = (await s.feed('scout')).find((notice) => notice.title === 'Payout request approved');
    assert.ok(approvedNotice);
    assert.equal(approvedNotice.link, '/credits', "a reporter's own page");
    assert.match(approvedNotice.body, new RegExp(`payout request ${a.reference} was approved`));

    const declined = await s.decide('boss', b.id, 'decline', { reason: 'Earnings are paid monthly.' });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.request.state, 'declined');
    const declinedNotice = (await s.feed('ranger')).find((notice) => notice.title === 'Payout request declined');
    assert.equal(declinedNotice.body, `Your payout request ${b.reference} was declined: Earnings are paid monthly.`);
    assert.equal(declinedNotice.link, '/credits');

    // Final, in payout words, and asking again is open once it is declined.
    const late = await s.record('boss', b.id, { amountUsd: '1', note: 'x' });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'request-final');
    assert.equal((await s.ask('ranger', 'again')).status, 201);

    for (const other of ['alice', 'deputy']) {
      assert.equal((await s.feed(other)).some((notice) => /approved|declined/.test(notice.title)), false, other);
    }
    assert.equal(s.balance('scout'), 1_000);
    assert.equal(s.balance('ranger'), 1_000);
    s.addsUp();
  } finally {
    s.close();
  }
});

test('Record payout writes one row keyed by the request, and a double press records once', async () => {
  const s = await serve();
  try {
    s.earn('scout', 5_000);
    const request = (await s.ask('scout', 'Bank')).body.request;

    const row = await s.queueRow(request.id);
    assert.equal(row.kind, 'payout');
    assert.equal(row.refundableNowMilli, 5_000, "the reporter's balance now - the most a payout may record");
    assert.equal(row.refundableNowReason, null);
    assert.equal(row.accountEmail, 'scout@example.com');

    // Refused by name, nothing moved.
    for (const [body, status, code] of [
      [{ note: 'Bank transfer' }, 400, 'bad-amount'],
      [{ amountUsd: '0', note: 'Bank transfer' }, 400, 'bad-amount'],
      [{ amountUsd: '-1', note: 'Bank transfer' }, 400, 'bad-amount'],
      [{ amountUsd: '1.0005', note: 'Bank transfer' }, 400, 'bad-amount'],
      [{ amountUsd: 'five', note: 'Bank transfer' }, 400, 'bad-amount'],
      [{ amountUsd: '5' }, 400, 'note-required'],
      [{ amountUsd: '5', note: '   ' }, 400, 'note-required'],
      [{ amountUsd: '5', note: 'n'.repeat(501) }, 400, 'note-too-long'],
    ]) {
      const refused = await s.record('boss', request.id, body);
      assert.equal(refused.status, status, JSON.stringify(body));
      assert.equal(refused.body.code, code, JSON.stringify(body));
      // In Admin -> Accounts' own words, so the page's one check serves both.
      const direct = await s.call('boss', `/api/admin/accounts/${s.ids.scout.id}/payout`, { method: 'POST', body });
      assert.equal(direct.status, status, JSON.stringify(body));
      assert.equal(refused.body.error, direct.body.error, JSON.stringify(body));
    }

    // Above the balance: refused, never clamped; the request stays open.
    const over = await s.record('boss', request.id, { amountUsd: '5.001', note: 'Bank transfer' });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'insufficient-balance');
    assert.equal(over.body.balanceMilli, 5_000);
    assert.equal(
      over.body.error,
      "That is more than this reporter's balance of $5. Record what was actually paid, up to the balance."
    );
    assert.equal(s.balance('scout'), 5_000);
    assert.deepEqual(s.payoutRows('scout'), []);
    assert.equal(s.refundDb.getRefundRequest(request.id).state, 'requested');

    // Exactly the balance, pressed twice at once and once more after.
    const presses = await Promise.all([
      s.record('boss', request.id, { amountUsd: '5', note: 'Bank transfer, ref 4471.' }),
      s.record('deputy', request.id, { amountUsd: '5', note: 'Bank transfer, ref 4471.' }),
    ]);
    const again = await s.record('boss', request.id, { amountUsd: '5', note: 'Bank transfer, ref 4471.' });
    for (const answer of [...presses, again]) assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(presses.map((answer) => answer.body.changed).sort(), [false, true]);
    assert.equal(again.body.changed, false);
    assert.equal(again.body.outcome, null);
    const winner = presses.find((answer) => answer.body.changed).body;
    assert.deepEqual(winner.outcome, { refundedMilli: 5_000, reversedMilli: 5_000, shortfallMilli: 0 });
    assert.equal(winner.request.state, 'refunded');
    assert.equal(winner.request.refundedMilli, 5_000);
    assert.equal(winner.request.refundableNowMilli, null, 'final');

    const rows = s.payoutRows('scout');
    assert.equal(rows.length, 1, 'one payout recorded');
    assert.equal(rows[0].key, `payout:${s.ids.scout.id}:${request.id}`, 'keyed by the request');
    assert.equal(rows[0].delta, -5_000);
    assert.equal(rows[0].note, `Payout request ${request.reference}: Bank transfer, ref 4471.`);
    assert.equal(s.balance('scout'), 0);

    const notices = (await s.feed('scout')).filter((notice) => notice.title === 'Payout recorded: $5');
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0].body,
      'An administrator recorded a payout of $5 to you: Bank transfer, ref 4471. Your balance is now $0. ' +
        `It answers your payout request ${request.reference}.`
    );
    assert.equal(notices[0].link, '/credits');

    const mine = (await s.call('scout', '/api/refund-requests?kind=payout')).body.requests[0];
    assert.equal(mine.state, 'refunded', 'the page reads a refunded payout as Paid out');
    assert.equal(mine.refundedMilli, 5_000);
    s.addsUp();
  } finally {
    s.close();
  }
});

test('a payout may be anything up to the balance at that moment, more than was asked included', async () => {
  const s = await serve();
  try {
    s.earn('scout', 2_000);
    const request = (await s.ask('scout')).body.request;
    assert.equal(request.amountMilli, 2_000);
    s.earn('scout', 1_500);
    assert.equal((await s.queueRow(request.id)).refundableNowMilli, 3_500, 'earned since asking counts');

    const paid = await s.record('boss', request.id, { amountUsd: '3.5', note: 'Everything to date' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.request.refundedMilli, 3_500);
    assert.equal(s.balance('scout'), 0);

    // Less than asked is a payout too, and leaves the rest to ask for again.
    s.earn('ranger', 4_000);
    const partial = (await s.ask('ranger')).body.request;
    const less = await s.record('boss', partial.id, { amountUsd: 1.25, note: 'First half' });
    assert.equal(less.status, 200);
    assert.equal(less.body.request.refundedMilli, 1_250);
    assert.equal(s.balance('ranger'), 2_750);
    assert.equal((await s.call('ranger', '/api/refund-requests/payout')).body.available, true);
    s.addsUp();
  } finally {
    s.close();
  }
});

test('a reporter made a user, or deleted, since asking: nothing is recorded, and the request can be declined', async () => {
  const s = await serve();
  try {
    s.earn('scout', 3_000);
    s.earn('ranger', 3_000);
    const changed = (await s.ask('scout')).body.request;
    const gone = (await s.ask('ranger')).body.request;

    s.users.updateUser(s.ids.scout.id, { role: 'user' });
    const row = await s.queueRow(changed.id);
    assert.equal(row.refundableNowMilli, 0);
    assert.match(row.refundableNowReason, /no longer a reporter/);
    const refused = await s.record('boss', changed.id, { amountUsd: '3', note: 'Bank' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'not-a-reporter');
    assert.equal(s.balance('scout'), 3_000, 'nothing moved');
    assert.deepEqual(s.payoutRows('scout'), []);
    assert.equal(s.refundDb.getRefundRequest(changed.id).state, 'requested', 'still open, to be declined');
    assert.equal((await s.decide('boss', changed.id, 'decline', { reason: 'No longer a reporter.' })).status, 200);

    s.users.deleteUser(s.ids.ranger.id);
    const orphan = await s.queueRow(gone.id);
    assert.equal(orphan.accountEmail, '');
    assert.equal(orphan.refundableNowMilli, 0);
    assert.match(orphan.refundableNowReason, /no longer exists/);
    const missing = await s.record('boss', gone.id, { amountUsd: '3', note: 'Bank' });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, 'account-missing');
    assert.equal((await s.decide('boss', gone.id, 'decline', { reason: 'Account removed.' })).status, 200);
    s.addsUp();
  } finally {
    s.close();
  }
});

test("Admin -> Accounts' payout closes the open request in the same step, so it is never paid twice", async () => {
  const s = await serve();
  try {
    s.earn('scout', 5_000);
    const request = (await s.ask('scout', 'Bank')).body.request;

    const direct = await s.call('boss', `/api/admin/accounts/${s.ids.scout.id}/payout`, {
      method: 'POST',
      body: { amountUsd: '3', note: 'Cash, in person', requestId: 'page-req-0001' },
    });
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    assert.equal(direct.body.recorded, true);
    assert.equal(direct.body.closedRequestId, request.id);
    assert.equal(direct.body.balanceMilli, 2_000);
    const closed = s.refundDb.getRefundRequest(request.id);
    assert.equal(closed.state, 'refunded');
    assert.equal(closed.refundedMilli, 3_000);
    assert.equal(closed.refundedBy, s.ids.boss.id);

    // The queue's press on a stale row finds it final and moves nothing.
    const stale = await s.record('deputy', request.id, { amountUsd: '5', note: 'Bank' });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.changed, false);
    assert.equal(s.balance('scout'), 2_000);
    assert.equal(s.payoutRows('scout').length, 1);

    // The page's repeat records nothing and closes nothing.
    const repeat = await s.call('boss', `/api/admin/accounts/${s.ids.scout.id}/payout`, {
      method: 'POST',
      body: { amountUsd: '3', note: 'Cash, in person', requestId: 'page-req-0001' },
    });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.recorded, false);
    assert.equal(repeat.body.closedRequestId, null);

    // One notice for the one payout, naming the request it answered.
    const notices = (await s.feed('scout')).filter((notice) => notice.title === 'Payout recorded: $3');
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, new RegExp(`It answers your payout request ${request.reference}\\.$`));

    // With no request open, a payout closes nothing - and the reverse order:
    // a request paid from the queue leaves a stale Accounts page bounded by the balance.
    const plain = await s.call('boss', `/api/admin/accounts/${s.ids.scout.id}/payout`, {
      method: 'POST',
      body: { amountUsd: '0.5', note: 'Top-up' },
    });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.closedRequestId, null);
    const next = (await s.ask('scout')).body.request;
    assert.equal(next.amountMilli, 1_500);
    assert.equal((await s.record('boss', next.id, { amountUsd: '1.5', note: 'Rest' })).status, 200);
    const afterQueue = await s.call('deputy', `/api/admin/accounts/${s.ids.scout.id}/payout`, {
      method: 'POST',
      body: { amountUsd: '1.5', note: 'Rest' },
    });
    assert.equal(afterQueue.status, 409);
    assert.equal(afterQueue.body.code, 'insufficient-balance');
    assert.equal(s.balance('scout'), 0);
    assert.equal(s.payoutRows('scout').length, 3);
    s.addsUp();
  } finally {
    s.close();
  }
});

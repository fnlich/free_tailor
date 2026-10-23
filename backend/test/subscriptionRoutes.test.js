const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh, openTestDb, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Self-serve subscriptions, paid from the credit balance, over HTTP
 * (routes/subscription.ts, services/subscriptions): the view, buying and
 * moving up - charged exactly what the page showed, once, in the same
 * transaction as the tier - the switch at renewal, cancel and keep, every
 * refusal, and what an administrator's change on Admin -> Accounts does to a
 * tier somebody paid for. The renewal sweep is subscriptionRenewal.test.js's.
 */

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-19T12:00:00.000Z');

const SUBSCRIPTION_COLUMNS = [
  'subscription',
  'subscription_base',
  'subscription_period_start',
  'subscription_paid_through',
  'subscription_period_price_milli',
  'subscription_renews',
  'subscription_next',
];

async function serve(name, { prices = { premiumPriceUsd: '9.99', premiumPlusPriceUsd: '19.99' } } = {}) {
  const dirs = useTempStorage(`subscription-routes-${name}`);
  useAdminEmails('admin@example.com');
  for (const variable of ['SUBSCRIPTION_PREMIUM_PRICE_USD', 'SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD', 'SUBSCRIPTION_PREMIUM_MAX_PRICE_USD']) {
    delete process.env[variable];
  }
  loadFresh('../dist/database/sqlite');
  const creditRepository = loadFresh('../dist/database/creditRepository');
  loadFresh('../dist/database/subscriptionRepository');
  const users = loadFresh('../dist/database/userRepository');
  const notifications = loadFresh('../dist/database/notificationRepository');
  const config = loadFresh('../dist/config/aiModelConfig');
  const credits = loadFresh('../dist/services/credits');
  const subscriptions = loadFresh('../dist/services/subscriptions');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/subscription');
  const accounts = loadFresh('../dist/routes/accounts');
  const auth = loadFresh('../dist/routes/auth');

  await config.updateAppSettings(prices);
  let now = T0;
  subscriptions.setSubscriptionClockForTests(() => now);

  const admin = users.createUser({ email: 'admin@example.com', name: 'Admin' });
  const alice = users.createUser({ email: 'alice@example.com', name: 'Alice' });
  const reporter = users.createUser({ email: 'reporter@example.com', name: 'Reporter', role: 'reporter' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/subscription', routes.default);
  app.use('/api/admin/accounts', accounts.default);
  app.use('/api/auth', auth.default);
  const server = app.listen(0);
  const port = server.address().port;
  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    reporter: users.createSession(reporter.id),
  };

  const call = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    // Express's own 404, for a route nobody declares, is a page rather than JSON.
    const json = /^application\/json/.test(response.headers.get('content-type') ?? '');
    return { status: response.status, body: json ? JSON.parse(text) : text };
  };

  /** The account's subscription columns as stored. */
  const columns = (id) => {
    const db = openTestDb(dirs.dbDir);
    try {
      return db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS.join(', ')} FROM users WHERE id = ?`).get(id);
    } finally {
      db.close();
    }
  };

  return {
    ...dirs,
    users,
    config,
    credits,
    creditRepository,
    notifications,
    subscriptions,
    admin,
    alice,
    reporter,
    call,
    columns,
    setNow: (ms) => {
      now = ms;
    },
    close: () => {
      subscriptions.setSubscriptionClockForTests();
      server.close();
    },
  };
}

const subscriptionRows = (s, userId) =>
  s.creditRepository.listLedger(userId).filter((entry) => entry.reason.startsWith('subscription-'));

test("the view: the tier, where it came from, every tier's price and offer, and the balance it is paid from", async () => {
  const s = await serve('view');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    const { status, body } = await s.call('alice', 'GET', '/subscription');
    assert.equal(status, 200);
    assert.equal(body.subscription, 'default');
    assert.equal(body.source, 'default');
    assert.equal(body.base, 'default');
    assert.equal(body.paid, null);
    assert.equal(body.balanceMilli, 50_000);
    assert.equal(body.periodDays, 30);
    assert.deepEqual(
      body.tiers.map((tier) => [tier.id, tier.label, tier.priceMilli, tier.offer, tier.chargeMilli]),
      [
        ['default', 'Default', 0, 'current', null],
        ['premium', 'Premium', 9_990, 'subscribe', 9_990],
        ['premium-plus', 'Premium+', 19_990, 'subscribe', 19_990],
        ['premium-max', 'Premium Max', null, 'not-offered', null],
      ]
    );
    assert.deepEqual(body.tiers[0].features, ['1 profile', 'Any number of resumes in each', 'Everything else in the app']);
    assert.equal(body.tiers[3].profileLimit, null, 'Premium Max: unlimited');

    // An administrator reads it, and is offered nothing.
    const admin = await s.call('admin', 'GET', '/subscription');
    assert.equal(admin.status, 200);
    assert.equal(admin.body.source, 'exempt');
    assert.deepEqual(admin.body.tiers.map((tier) => tier.offer), ['current', 'none', 'none', 'none']);

    // A reporter has no subscription to look at.
    const reporter = await s.call('reporter', 'GET', '/subscription');
    assert.equal(reporter.status, 403);
    assert.equal(reporter.body.code, 'role-not-allowed');

    // The catalogue the Subscription page read before this view is gone: it is all here.
    for (const who of ['alice', 'admin']) {
      assert.equal((await s.call(who, 'GET', '/auth/subscriptions')).status, 404, who);
    }
  } finally {
    s.close();
  }
});

test('buying takes exactly the price, once, in one ledger row - and the tier, its 30 days and its base with it', async () => {
  const s = await serve('buy');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    const { status, body } = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.changed, true);
    assert.equal(body.chargedMilli, 9_990);
    assert.equal(body.subscription, 'premium');
    assert.equal(body.source, 'paid');
    assert.equal(body.base, 'default');
    assert.equal(body.balanceMilli, 40_010);
    assert.deepEqual(body.paid, {
      since: '2026-10-19T12:00:00.000Z',
      paidThrough: '2026-11-18T12:00:00.000Z',
      renews: true,
      next: null,
      due: false,
      renewalPriceMilli: 9_990,
      renewalShortMilli: 0,
    });
    assert.deepEqual(
      body.tiers.map((tier) => tier.offer),
      ['return-here', 'current', 'upgrade', 'not-offered']
    );

    const rows = subscriptionRows(s, s.alice.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'subscription-purchase');
    assert.equal(rows[0].deltaMilli, -9_990);
    assert.equal(rows[0].balanceAfterMilli, 40_010);
    assert.equal(rows[0].refKind, 'subscription');
    assert.equal(rows[0].refId, `subscription:${s.alice.id}`);
    assert.equal(rows[0].note, 'Premium for 30 days, to 2026-11-18');
    assert.equal(s.creditRepository.isLedgerKeyUsed(`subscription:${s.alice.id}:premium:2026-10-19T12:00:00.000Z`), true);

    assert.deepEqual(s.columns(s.alice.id), {
      subscription: 'premium',
      subscription_base: 'default',
      subscription_period_start: '2026-10-19T12:00:00.000Z',
      subscription_paid_through: '2026-11-18T12:00:00.000Z',
      subscription_period_price_milli: 9_990,
      subscription_renews: 1,
      subscription_next: null,
    });
    // Every gate reads the tier in effect: Premium's five profiles now.
    assert.equal(s.users.getUserById(s.alice.id).subscription, 'premium');
    // The balance is still the sum of its ledger.
    assert.deepEqual(s.creditRepository.findInconsistentBalances(), []);
  } finally {
    s.close();
  }
});

test('moving up on day two costs the new price less 29 unused days: $19.99 - $9.657 = $10.333, and the 30 days start again', async () => {
  const s = await serve('upgrade');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    assert.equal((await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' })).status, 200);

    s.setNow(T0 + DAY + 3_600_000);
    const view = await s.call('alice', 'GET', '/subscription');
    const plus = view.body.tiers.find((tier) => tier.id === 'premium-plus');
    assert.deepEqual(
      { offer: plus.offer, chargeMilli: plus.chargeMilli, creditMilli: plus.creditMilli, daysLeft: plus.daysLeft },
      { offer: 'upgrade', chargeMilli: 10_333, creditMilli: 9_657, daysLeft: 29 }
    );

    // The amount shown, as the page sends it: dollars to the thousandth (a JSON number reads the same).
    const { status, body } = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: 10.333 });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.chargedMilli, 10_333);
    assert.equal(body.subscription, 'premium-plus');
    assert.equal(body.base, 'default', 'the base is kept through every upgrade');
    assert.equal(body.balanceMilli, 50_000 - 9_990 - 10_333);
    assert.equal(body.paid.since, '2026-10-20T13:00:00.000Z');
    assert.equal(body.paid.paidThrough, '2026-11-19T13:00:00.000Z');
    const rows = subscriptionRows(s, s.alice.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].note, 'Premium+ for 30 days, to 2026-11-19: $19.99 less $9.657 for 29 unused days of Premium');
    assert.equal(rows[0].deltaMilli, -10_333);
    assert.equal(s.columns(s.alice.id).subscription_period_price_milli, 19_990, 'the full price: the next credit is worked from it');
  } finally {
    s.close();
  }
});

test('a higher tier the unused days cover costs nothing and writes no ledger row', async () => {
  const s = await serve('covered', { prices: { premiumPriceUsd: '9.99', premiumPlusPriceUsd: '5' } });
  try {
    s.credits.grantCredits(s.alice.id, 9_990, s.admin.id, 'test');
    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });
    const plus = (await s.call('alice', 'GET', '/subscription')).body.tiers.find((tier) => tier.id === 'premium-plus');
    assert.equal(plus.chargeMilli, 0);
    const { status, body } = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '0' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.chargedMilli, 0);
    assert.equal(body.subscription, 'premium-plus');
    assert.equal(body.balanceMilli, 0);
    assert.equal(subscriptionRows(s, s.alice.id).length, 1, 'no $0 row');
  } finally {
    s.close();
  }
});

test('from an administrator\'s Premium the base is Premium: the full price is paid, and ending returns there', async () => {
  const s = await serve('from-admin');
  try {
    s.users.updateUser(s.alice.id, { subscription: 'premium' });
    s.credits.grantCredits(s.alice.id, 30_000, s.admin.id, 'test');
    let view = (await s.call('alice', 'GET', '/subscription')).body;
    assert.equal(view.source, 'admin');
    assert.deepEqual(view.tiers.map((tier) => tier.offer), ['included', 'current', 'subscribe', 'not-offered']);

    const bought = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '19.99' });
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    assert.equal(bought.body.chargedMilli, 19_990, 'an administrator\'s tier is worth no credit');
    assert.equal(bought.body.base, 'premium');
    assert.deepEqual(bought.body.tiers.map((tier) => tier.offer), ['included', 'return-here', 'current', 'not-offered']);

    // Cancelled, and the 30 days up: back on the administrator's Premium.
    assert.equal((await s.call('alice', 'POST', '/subscription/cancel')).body.changed, true);
    s.setNow(T0 + 30 * DAY + 60_000);
    const report = await s.subscriptions.renewDueSubscriptions();
    assert.deepEqual(report, { renewed: 0, lapsed: 1, held: 0, skipped: 0, stopped: false });
    view = (await s.call('alice', 'GET', '/subscription')).body;
    assert.equal(view.subscription, 'premium');
    assert.equal(view.source, 'admin');
    assert.equal(view.paid, null);
  } finally {
    s.close();
  }
});

test('a balance short of the price is refused with 402 and the numbers, and nothing moves', async () => {
  const s = await serve('short');
  try {
    s.credits.grantCredits(s.alice.id, 5_000, s.admin.id, 'test');
    const { status, body } = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });
    assert.equal(status, 402);
    assert.equal(body.code, 'insufficient-credits');
    assert.equal(body.neededMilli, 9_990);
    assert.equal(body.balanceMilli, 5_000);
    assert.equal(body.error, 'Premium costs $9.99 now and your balance is $5. Buy credits, then try again.');
    assert.equal(s.users.getUserById(s.alice.id).balanceMilli, 5_000);
    assert.equal(s.users.getUserById(s.alice.id).subscription, 'default');
    assert.equal(s.columns(s.alice.id).subscription_paid_through, null);
    assert.equal(subscriptionRows(s, s.alice.id).length, 0);
  } finally {
    s.close();
  }
});

test('nobody is charged an amount they were not shown: a price changed since is 409 charge-changed, with the new figure', async () => {
  const s = await serve('charge-changed');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    await s.config.updateAppSettings({ premiumPriceUsd: '12' });
    let reply = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'charge-changed');
    assert.equal(reply.body.chargeMilli, 12_000);
    assert.equal(
      reply.body.error,
      'This change costs $12 now, not the $9.99 you were shown: the price or the days left have changed since. ' +
        'Check the new amount and confirm again.'
    );
    assert.equal(s.users.getUserById(s.alice.id).balanceMilli, 50_000, 'nothing taken');

    // The days left move too: an upgrade shown on one day and confirmed the next.
    reply = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '12' });
    assert.equal(reply.status, 200);
    s.setNow(T0 + 2 * DAY - 1);
    const shown = (await s.call('alice', 'GET', '/subscription')).body.tiers.find((tier) => tier.id === 'premium-plus');
    assert.equal(shown.daysLeft, 29);
    s.setNow(T0 + 2 * DAY + 1);
    reply = await s.call('alice', 'POST', '/subscription/subscribe', {
      subscription: 'premium-plus',
      chargeUsd: String(shown.chargeMilli / 1000),
    });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'charge-changed');
    assert.equal(reply.body.chargeMilli, 19_990 - 11_200, '28 days left of $12: $11.2');
  } finally {
    s.close();
  }
});

test('every refusal: unknown tier, Default, no or bad amount, not offered, not an upgrade, an administrator, a reporter', async () => {
  const s = await serve('refusals');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    const cases = [
      [{ subscription: 'premium-ultra', chargeUsd: '1' }, 400, 'bad-subscription', "That is not one of this installation's paid subscriptions."],
      [{ subscription: 'default', chargeUsd: '0' }, 400, 'bad-subscription', "That is not one of this installation's paid subscriptions."],
      [{ subscription: 'premium' }, 400, 'charge-required', 'Say what you agreed to pay, in dollars, as chargeUsd.'],
      [{ subscription: 'premium', chargeUsd: '' }, 400, 'charge-required', 'Say what you agreed to pay, in dollars, as chargeUsd.'],
      [{ subscription: 'premium', chargeMilli: 9_990 }, 400, 'charge-required', 'Say what you agreed to pay, in dollars, as chargeUsd.'],
      [{ subscription: 'premium', chargeUsd: '9.9999' }, 400, 'bad-charge', 'The amount you agreed to pay can have at most three decimal places: $0.001 is the smallest step.'],
      [{ subscription: 'premium', chargeUsd: 'nine' }, 400, 'bad-charge', 'The amount you agreed to pay must be an amount in dollars, like 0.023 or 12.50.'],
      [
        { subscription: 'premium-max', chargeUsd: '1' },
        409,
        'not-offered',
        'Premium Max is not offered on this installation. Ask your administrator if you need it.',
      ],
    ];
    for (const [body, status, code, error] of cases) {
      const reply = await s.call('alice', 'POST', '/subscription/subscribe', body);
      assert.equal(reply.status, status, JSON.stringify(body));
      assert.equal(reply.body.code, code, JSON.stringify(body));
      assert.equal(reply.body.error, error, JSON.stringify(body));
    }

    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '19.99' });
    let reply = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '0' });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'not-an-upgrade');
    assert.equal(reply.body.error, 'Your account is already on Premium+.');
    reply = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '0' });
    assert.equal(reply.body.code, 'not-an-upgrade');
    assert.equal(reply.body.error, 'Premium is below your Premium+ subscription. To move down, choose Switch at renewal.');

    // An administrator has every tier and buys none.
    for (const [path, body] of [
      ['/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' }],
      ['/subscription/downgrade', { subscription: 'premium' }],
      ['/subscription/cancel', {}],
      ['/subscription/resume', {}],
    ]) {
      reply = await s.call('admin', 'POST', path, body);
      assert.equal(reply.status, 409, path);
      assert.equal(reply.body.code, 'admin-exempt', path);
      assert.equal(reply.body.error, "Administrators have every subscription's features and are never charged, so there is nothing to buy.");
    }
    // A reporter's balance is earnings: not one of these routes is theirs.
    reply = await s.call('reporter', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });
    assert.equal(reply.status, 403);
    assert.equal(reply.body.code, 'role-not-allowed');
    assert.equal(s.users.getUserById(s.admin.id).balanceMilli, 0);
  } finally {
    s.close();
  }
});

test('two purchases at once: one is charged, the other told the account is on it already', async () => {
  const s = await serve('race');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    const body = { subscription: 'premium', chargeUsd: '9.99' };
    const replies = await Promise.all([
      s.call('alice', 'POST', '/subscription/subscribe', body),
      s.call('alice', 'POST', '/subscription/subscribe', body),
    ]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
    assert.equal(replies.find((reply) => reply.status === 409).body.code, 'not-an-upgrade');
    assert.equal(subscriptionRows(s, s.alice.id).length, 1);
    assert.equal(s.users.getUserById(s.alice.id).balanceMilli, 40_010);
  } finally {
    s.close();
  }
});

test('switch at renewal, cancel and keep: each once, a repeat moves nothing, and nothing is charged now', async () => {
  const s = await serve('schedule', { prices: { premiumPriceUsd: '9.99', premiumPlusPriceUsd: '19.99', premiumMaxPriceUsd: '49.99' } });
  try {
    s.credits.grantCredits(s.alice.id, 100_000, s.admin.id, 'test');
    // Nothing paid: nothing to change.
    let reply = await s.call('alice', 'POST', '/subscription/cancel');
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'not-subscribed');
    assert.equal(reply.body.error, 'You have no paid subscription to change.');

    reply = await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-max', chargeUsd: '49.99' });
    assert.equal(reply.status, 200);
    const balance = reply.body.balanceMilli;

    reply = await s.call('alice', 'POST', '/subscription/downgrade', { subscription: 'premium' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.changed, true);
    assert.equal(reply.body.subscription, 'premium-max', 'the tier paid for stays until its 30 days end');
    assert.equal(reply.body.paid.next, 'premium');
    assert.equal(reply.body.paid.renewalPriceMilli, 9_990, "the renewal takes the next tier's price");
    assert.equal(reply.body.tiers.find((tier) => tier.id === 'premium').offer, 'switching');
    assert.equal((await s.call('alice', 'POST', '/subscription/downgrade', { subscription: 'premium' })).body.changed, false);

    // Below the base, or not below the tier: not a switch.
    for (const [subscription, error] of [
      ['premium-max', 'Premium Max is not below your Premium Max subscription.'],
      ['default', "That is not one of this installation's paid subscriptions."],
    ]) {
      reply = await s.call('alice', 'POST', '/subscription/downgrade', { subscription });
      assert.equal(reply.body.error, error);
    }

    reply = await s.call('alice', 'POST', '/subscription/cancel');
    assert.equal(reply.body.changed, true);
    assert.equal(reply.body.paid.renews, false);
    assert.equal(reply.body.paid.next, null, 'cancelling drops the switch');
    assert.equal(reply.body.paid.renewalPriceMilli, null, 'it will end instead');
    assert.equal((await s.call('alice', 'POST', '/subscription/cancel')).body.changed, false);

    // A switch chosen while cancelled renews again, as that tier.
    reply = await s.call('alice', 'POST', '/subscription/downgrade', { subscription: 'premium-plus' });
    assert.equal(reply.body.paid.renews, true);
    assert.equal(reply.body.paid.next, 'premium-plus');

    reply = await s.call('alice', 'POST', '/subscription/resume');
    assert.equal(reply.body.changed, true);
    assert.equal(reply.body.paid.renews, true);
    assert.equal(reply.body.paid.next, null, 'keeping Premium Max drops the switch');
    assert.equal(reply.body.paid.renewalPriceMilli, 49_990);
    assert.equal((await s.call('alice', 'POST', '/subscription/resume')).body.changed, false);

    assert.equal(s.users.getUserById(s.alice.id).balanceMilli, balance, 'none of it charged anything');

    // A tier nobody offers any more cannot be kept, or switched to.
    await s.config.updateAppSettings({ premiumMaxPriceUsd: '', premiumPlusPriceUsd: '' });
    await s.call('alice', 'POST', '/subscription/cancel');
    reply = await s.call('alice', 'POST', '/subscription/resume');
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'not-offered');
    reply = await s.call('alice', 'POST', '/subscription/downgrade', { subscription: 'premium-plus' });
    assert.equal(reply.body.code, 'not-offered');
  } finally {
    s.close();
  }
});

test("cancelling returns to the base, so a switch to it - or below it - is Cancel's, and said so", async () => {
  const s = await serve('switch-to-base');
  try {
    s.users.updateUser(s.alice.id, { subscription: 'premium' });
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '19.99' });
    const reply = await s.call('alice', 'POST', '/subscription/downgrade', { subscription: 'premium' });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'not-a-downgrade');
    assert.equal(reply.body.error, 'Cancelling already returns you to Premium; choose Cancel subscription instead.');
  } finally {
    s.close();
  }
});

test("an administrator's tier is not paid: nothing to change here, and the sentence says who to ask", async () => {
  const s = await serve('admin-set');
  try {
    s.users.updateUser(s.alice.id, { subscription: 'premium-plus' });
    const reply = await s.call('alice', 'POST', '/subscription/cancel');
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'not-subscribed');
    assert.equal(
      reply.body.error,
      'Your subscription was set by an administrator, so it does not renew and there is nothing to change here. ' +
        'Ask your administrator to change it.'
    );
  } finally {
    s.close();
  }
});

test('an administrator setting the tier ends what was paid for at once, refunds nothing, says how much was unused, and tells the account', async () => {
  const s = await serve('override');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '19.99' });
    s.setNow(T0 + 10 * DAY + 60_000);

    // The same tier again does nothing: the paid one carries on.
    let reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { subscription: 'premium-plus' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.note, undefined);
    assert.deepEqual(reply.body.account.subscriptionBilling, {
      paidThrough: '2026-11-18T12:00:00.000Z',
      renews: true,
      next: null,
    });

    reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { subscription: 'premium' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.account.subscription, 'premium');
    assert.equal(reply.body.account.subscriptionBilling, null);
    // 20 days left of $19.99: $13.326.
    assert.equal(
      reply.body.note,
      "Ended alice@example.com's Premium+ paid from credit until 2026-11-18; nothing was refunded. " +
        'About $13.326 of it was unused - give it back with +/- beside the balance if you mean to.'
    );
    assert.equal(s.users.getUserById(s.alice.id).balanceMilli, 50_000 - 19_990, 'nothing refunded');
    assert.deepEqual(s.columns(s.alice.id), {
      subscription: 'premium',
      subscription_base: null,
      subscription_period_start: null,
      subscription_paid_through: null,
      subscription_period_price_milli: null,
      subscription_renews: null,
      subscription_next: null,
    });
    const notice = s.notifications.listNotificationsFor(s.alice.id).find((entry) => entry.recipientId === s.alice.id);
    assert.equal(notice.title, 'Your subscription was changed');
    assert.equal(
      notice.body,
      'An administrator set your subscription to Premium. Your Premium+ paid from credit has ended and will not renew; nothing was refunded.'
    );
    assert.equal(notice.link, '/settings/subscription');

    // Nothing paid now: setting the tier again says nothing more.
    reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { subscription: 'default' });
    assert.equal(reply.body.note, undefined);
    // And the sweep has nothing of hers to renew.
    s.setNow(T0 + 40 * DAY);
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), { renewed: 0, lapsed: 0, held: 0, skipped: 0, stopped: false });
  } finally {
    s.close();
  }
});

test("moving the role away from user ends a paid tier too: the account returns to its base, and the list shows who pays", async () => {
  const s = await serve('role-change');
  try {
    const bob = s.users.createUser({ email: 'bob@example.com' });
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });

    const list = (await s.call('admin', 'GET', '/admin/accounts')).body.accounts;
    const row = (email) => list.find((account) => account.email === email);
    assert.deepEqual(row('alice@example.com').subscriptionBilling, {
      paidThrough: '2026-11-18T12:00:00.000Z',
      renews: true,
      next: null,
    });
    assert.equal(row('bob@example.com').subscriptionBilling, null);
    assert.equal(bob.role, 'user');

    const reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { role: 'reporter' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.account.role, 'reporter');
    assert.equal(reply.body.account.subscription, 'default', 'back to the tier it paid from');
    assert.equal(reply.body.account.subscriptionBilling, null);
    assert.match(reply.body.note, /^Ended alice@example\.com's Premium paid from credit until 2026-11-18; nothing was refunded\. About \$9\.99 /);
    const notice = s.notifications.listNotificationsFor(s.alice.id).find((entry) => entry.recipientId === s.alice.id);
    assert.equal(notice.body, "An administrator changed your account's role. Your Premium paid from credit has ended and will not renew; nothing was refunded.");
    assert.equal(notice.link, null, 'a reporter has no Subscription page');
    assert.equal(s.columns(s.alice.id).subscription_paid_through, null);
  } finally {
    s.close();
  }
});

test('disabling an account that pays ends nothing now and says when it will end; its 30 days then end with nothing taken', async () => {
  const s = await serve('disable');
  try {
    const bob = s.users.createUser({ email: 'bob@example.com' });
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium', chargeUsd: '9.99' });
    // The account as a request let in before the disable holds it.
    const asLetIn = s.users.getUserById(s.alice.id);

    let reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { disabled: true });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.account.disabled, true);
    assert.deepEqual(reply.body.account.subscriptionBilling, {
      paidThrough: '2026-11-18T12:00:00.000Z',
      renews: true,
      next: null,
    });
    assert.equal(
      reply.body.note,
      'alice@example.com pays for Premium from credit until 2026-11-18. A disabled account does not renew: ' +
        'unless it is enabled again by then, Premium ends that day and nothing more is taken.'
    );
    // Nothing paid, nothing to say.
    reply = await s.call('admin', 'PATCH', `/admin/accounts/${bob.id}`, { disabled: true });
    assert.equal(reply.body.note, undefined);

    // A change let in before the disable is refused, and moves nothing.
    await assert.rejects(s.subscriptions.subscribe(asLetIn, { subscription: 'premium-plus', chargeUsd: '10' }), (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'account-disabled');
      assert.equal(
        error.message,
        'Your account has been disabled, so its subscription cannot be changed. Ask an administrator of this installation to re-enable it.'
      );
      return true;
    });
    await assert.rejects(s.subscriptions.cancelSubscription(asLetIn), (error) => error.code === 'account-disabled');
    assert.equal(s.columns(s.alice.id).subscription, 'premium');

    // Still disabled when the 30 days are up: ended, nothing taken.
    s.setNow(T0 + 30 * DAY + 60_000);
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), { renewed: 0, lapsed: 1, held: 0, skipped: 0, stopped: false });
    assert.equal(s.users.getUserById(s.alice.id).balanceMilli, 50_000 - 9_990);
    assert.equal(s.columns(s.alice.id).subscription, 'default');
    assert.equal(subscriptionRows(s, s.alice.id).length, 1, 'the purchase, and no renewal');

    // Enabled again: nothing to say, and she can buy again.
    reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { disabled: false });
    assert.equal(reply.body.note, undefined);
  } finally {
    s.close();
  }
});

test("an administrator's change reads the paid period in its own transaction, which no other writer can enter", async () => {
  const s = await serve('override-transaction');
  try {
    s.credits.grantCredits(s.alice.id, 50_000, s.admin.id, 'test');
    await s.call('alice', 'POST', '/subscription/subscribe', { subscription: 'premium-plus', chargeUsd: '19.99' });

    // The reads the note is worked out from, watched: inside a transaction,
    // and one that holds the database's write lock - so a renewal or a
    // purchase another server on this database makes cannot commit between
    // the read and the change, to be ended unmentioned.
    const repository = require('../dist/database/subscriptionRepository');
    const { getDb } = require('../dist/database/sqlite');
    const original = repository.getSubscriptionBilling;
    const reads = [];
    repository.getSubscriptionBilling = (id) => {
      const other = openTestDb(s.dbDir);
      let otherWriterGotIn = true;
      try {
        other.pragma('busy_timeout = 0');
        other.exec('BEGIN IMMEDIATE');
        other.exec('ROLLBACK');
      } catch {
        otherWriterGotIn = false;
      } finally {
        other.close();
      }
      reads.push({ inTransaction: getDb().inTransaction, otherWriterGotIn });
      return original(id);
    };
    let reply;
    try {
      reply = await s.call('admin', 'PATCH', `/admin/accounts/${s.alice.id}`, { subscription: 'premium' });
    } finally {
      repository.getSubscriptionBilling = original;
    }
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.match(reply.body.note, /^Ended alice@example\.com's Premium\+ paid from credit until 2026-11-18; nothing was refunded\./);
    // Before the change and after it; the row the answer describes is read after the commit.
    assert.deepEqual(reads.slice(0, 2), [
      { inTransaction: true, otherWriterGotIn: false },
      { inTransaction: true, otherWriterGotIn: false },
    ]);
  } finally {
    s.close();
  }
});

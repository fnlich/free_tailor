const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const path = require('node:path');

const { loadFresh, openTestDb, readSettingRaw, useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * The renewal sweep (services/subscriptions renewDueSubscriptions, its timer
 * in renewal.ts): a paid tier whose 30 days are up renews from the balance at
 * today's price - charged once however often the sweep runs, a restart
 * included - or ends, returning the account to its base with a notice saying
 * why: cancelled, the account disabled, not offered any more, not a user any
 * more, or not enough credit. A sweep that runs late loses nobody any time;
 * one that cannot read the prices touches nobody, and one price set and
 * unreadable holds what renews as it. The first pass waits for the boot's
 * credit reconciliation.
 */

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const END = T0 + 30 * DAY;
const iso = (ms) => new Date(ms).toISOString();

function load(name, prices = { premiumPriceUsd: '9.99', premiumPlusPriceUsd: '19.99' }) {
  const dirs = useTempStorage(`subscription-renewal-${name}`);
  useAdminEmails('admin@example.com');
  for (const variable of ['SUBSCRIPTION_PREMIUM_PRICE_USD', 'SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD', 'SUBSCRIPTION_PREMIUM_MAX_PRICE_USD']) {
    delete process.env[variable];
  }
  const modules = () => {
    loadFresh('../dist/database/sqlite');
    const creditRepository = loadFresh('../dist/database/creditRepository');
    const subscriptionRepository = loadFresh('../dist/database/subscriptionRepository');
    const users = loadFresh('../dist/database/userRepository');
    const notifications = loadFresh('../dist/database/notificationRepository');
    const config = loadFresh('../dist/config/aiModelConfig');
    const credits = loadFresh('../dist/services/credits');
    const subscriptions = loadFresh('../dist/services/subscriptions');
    return { creditRepository, subscriptionRepository, users, notifications, config, credits, subscriptions };
  };
  const m = modules();
  let now = T0;
  const clock = () => now;
  m.subscriptions.setSubscriptionClockForTests(clock);
  const s = {
    ...dirs,
    ...m,
    async setUp() {
      await m.config.updateAppSettings(prices);
      const admin = m.users.createUser({ email: 'admin@example.com' });
      return { admin };
    },
    setNow(ms) {
      now = ms;
    },
    /** A new process on the same database: every module loaded again. */
    restart() {
      Object.assign(s, modules());
      s.subscriptions.setSubscriptionClockForTests(clock);
    },
    sql(statement, ...params) {
      const db = openTestDb(dirs.dbDir);
      try {
        return /^\s*select|^\s*explain/i.test(statement) ? db.prepare(statement).all(...params) : db.prepare(statement).run(...params);
      } finally {
        db.close();
      }
    },
    renewals(userId) {
      return s.creditRepository.listLedger(userId).filter((entry) => entry.reason === 'subscription-renewal');
    },
    notices(userId) {
      return s.notifications.listNotificationsFor(userId).filter((entry) => entry.recipientId === userId);
    },
    close() {
      s.subscriptions.setSubscriptionClockForTests();
    },
  };
  return s;
}

/** A user who bought `tier` at `at` (T0) with `balanceMilli` on hand before. */
async function buyer(s, admin, email, { tier = 'premium', chargeUsd = '9.99', balanceMilli = 50_000, at = T0 } = {}) {
  const account = s.users.createUser({ email });
  s.credits.grantCredits(account.id, balanceMilli, admin.id, 'test');
  s.setNow(at);
  await s.subscriptions.subscribe(s.users.getUserById(account.id), { subscription: tier, chargeUsd });
  return account;
}

/** A pass that found nothing to do. */
const NOTHING = { renewed: 0, lapsed: 0, held: 0, skipped: 0, stopped: false };

/** Runs `action` with console.warn captured, and answers its result and what was warned. */
async function captureWarnings(action) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { result: await action(), warnings };
  } finally {
    console.warn = original;
  }
}

test('a due tier renews once at today\'s price, however often the sweep runs - and after a restart', async () => {
  const s = load('once');
  try {
    const { admin } = await s.setUp();
    const alice = await buyer(s, admin, 'alice@example.com');
    // Not due yet: nothing happens.
    s.setNow(END - 1);
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), NOTHING);

    s.setNow(END + 3_600_000);
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), { ...NOTHING, renewed: 1 });
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), NOTHING);
    s.restart();
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), NOTHING);

    const renewals = s.renewals(alice.id);
    assert.equal(renewals.length, 1);
    assert.equal(renewals[0].deltaMilli, -9_990);
    assert.equal(renewals[0].note, 'Premium for 30 days, to 2026-12-18');
    assert.equal(s.creditRepository.isLedgerKeyUsed(`subscription-renewal:${alice.id}:${iso(END)}`), true);
    assert.equal(s.users.getUserById(alice.id).balanceMilli, 50_000 - 2 * 9_990);
    const [row] = s.sql('SELECT subscription, subscription_period_start, subscription_paid_through FROM users WHERE id = ?', alice.id);
    // Late by an hour: the period still starts at the old end.
    assert.deepEqual(row, {
      subscription: 'premium',
      subscription_period_start: iso(END),
      subscription_paid_through: iso(END + 30 * DAY),
    });
    const [notice] = s.notices(alice.id);
    assert.equal(notice.title, 'Premium renewed: $9.99');
    assert.equal(
      notice.body,
      'Your Premium subscription renewed for another 30 days, until 2026-12-18. $9.99 was taken from your credit, and your balance is now $30.02.'
    );
    assert.equal(notice.link, '/settings/subscription');
  } finally {
    s.close();
  }
});

test('a server stopped for more than a whole period renews from now, once, and charges nothing for the time gone by', async () => {
  const s = load('missed');
  try {
    const { admin } = await s.setUp();
    const alice = await buyer(s, admin, 'alice@example.com');
    s.setNow(END + 45 * DAY);
    assert.equal((await s.subscriptions.renewDueSubscriptions()).renewed, 1);
    const [row] = s.sql('SELECT subscription_period_start, subscription_paid_through FROM users WHERE id = ?', alice.id);
    assert.deepEqual(row, { subscription_period_start: iso(END + 45 * DAY), subscription_paid_through: iso(END + 75 * DAY) });
    assert.equal(s.renewals(alice.id).length, 1, 'one charge, not one per period missed');
  } finally {
    s.close();
  }
});

test('a tier switched to at renewal is taken at its own price, and the notice says it switched', async () => {
  const s = load('switch', { premiumPriceUsd: '9.99', premiumPlusPriceUsd: '19.99', premiumMaxPriceUsd: '49.99' });
  try {
    const { admin } = await s.setUp();
    const alice = await buyer(s, admin, 'alice@example.com', { tier: 'premium-max', chargeUsd: '49.99', balanceMilli: 100_000 });
    await s.subscriptions.downgrade(s.users.getUserById(alice.id), { subscription: 'premium-plus' });
    s.setNow(END + 60_000);
    assert.equal((await s.subscriptions.renewDueSubscriptions()).renewed, 1);
    const [row] = s.sql('SELECT subscription, subscription_next, subscription_period_price_milli, subscription_base FROM users WHERE id = ?', alice.id);
    assert.deepEqual(row, { subscription: 'premium-plus', subscription_next: null, subscription_period_price_milli: 19_990, subscription_base: 'default' });
    assert.equal(s.renewals(alice.id)[0].deltaMilli, -19_990);
    const [notice] = s.notices(alice.id);
    assert.equal(notice.title, 'Premium Max is now Premium+: $19.99');
    assert.match(notice.body, /^As you chose, your subscription switched from Premium Max to Premium\+ for the next 30 days, until 2026-12-18\./);
  } finally {
    s.close();
  }
});

test('every way a paid tier ends at renewal: back to its base, nothing charged, and a notice saying why', async () => {
  const s = load('lapses');
  try {
    const { admin } = await s.setUp();
    const short = await buyer(s, admin, 'short@example.com', { balanceMilli: 12_000 });
    const cancelled = await buyer(s, admin, 'cancelled@example.com');
    await s.subscriptions.cancelSubscription(s.users.getUserById(cancelled.id));
    const unpriced = await buyer(s, admin, 'unpriced@example.com', { tier: 'premium-plus', chargeUsd: '19.99' });
    const reporter = await buyer(s, admin, 'reporter@example.com');
    const promoted = await buyer(s, admin, 'promoted@example.com');
    // Roles changed without Admin -> Accounts - as an ADMIN_EMAILS address is promoted at sign-in.
    s.sql("UPDATE users SET role = 'reporter' WHERE id = ?", reporter.id);
    s.sql("UPDATE users SET role = 'admin' WHERE id = ?", promoted.id);
    // Disabled by an administrator, with plenty to pay another 30 days it could not use.
    const disabled = await buyer(s, admin, 'disabled@example.com');
    s.users.updateUser(disabled.id, { disabled: true });
    // An administrator's Premium under a paid Premium+: that is where it returns.
    const based = s.users.createUser({ email: 'based@example.com' });
    s.users.updateUser(based.id, { subscription: 'premium' });
    s.credits.grantCredits(based.id, 25_000, admin.id, 'test');
    s.setNow(T0);
    await s.subscriptions.subscribe(s.users.getUserById(based.id), { subscription: 'premium-plus', chargeUsd: '19.99' });

    await s.config.updateAppSettings({ premiumPlusPriceUsd: '' });
    s.setNow(END + 60_000);
    const report = await s.subscriptions.renewDueSubscriptions();
    assert.deepEqual(report, { ...NOTHING, lapsed: 7 });

    const state = (id) => s.sql('SELECT subscription, subscription_paid_through, balance_milli FROM users WHERE id = ?', id)[0];
    assert.deepEqual(state(short.id), { subscription: 'default', subscription_paid_through: null, balance_milli: 12_000 - 9_990 });
    assert.equal(state(cancelled.id).subscription, 'default');
    assert.equal(state(unpriced.id).subscription, 'default');
    assert.equal(state(reporter.id).subscription, 'default');
    assert.equal(state(promoted.id).subscription, 'default');
    assert.deepEqual(state(based.id), { subscription: 'premium', subscription_paid_through: null, balance_milli: 25_000 - 19_990 });
    assert.deepEqual(state(disabled.id), { subscription: 'default', subscription_paid_through: null, balance_milli: 50_000 - 9_990 });
    for (const account of [short, cancelled, unpriced, reporter, promoted, based, disabled]) {
      assert.equal(s.renewals(account.id).length, 0, `${account.email}: nothing charged`);
    }

    assert.deepEqual(
      s.notices(short.id).map((notice) => [notice.title, notice.body]),
      [[
        'Premium ended: not enough credit',
        'Your Premium subscription could not renew on 2026-11-18: it costs $9.99 and your balance was $2.01. ' +
          'Your account is on Default now. Buy credits, then subscribe again from the Subscription page.',
      ]]
    );
    assert.deepEqual(s.notices(cancelled.id).map((notice) => notice.body), [
      'Your Premium subscription ended on 2026-11-18, as you cancelled it. Your account is on Default now.',
    ]);
    assert.deepEqual(s.notices(unpriced.id).map((notice) => notice.title), ['Premium+ ended: no longer offered']);
    assert.deepEqual(s.notices(based.id).map((notice) => notice.body), [
      'Your Premium+ subscription could not renew on 2026-11-18: this installation no longer offers it. Your account is on Premium now.',
    ]);
    const [reporterNotice] = s.notices(reporter.id);
    assert.equal(
      reporterNotice.body,
      'Your Premium subscription ended on 2026-11-18: your account no longer builds resumes, so it has no subscription.'
    );
    assert.equal(reporterNotice.link, null);
    assert.deepEqual(s.notices(promoted.id), [], 'an administrator is exempt: nothing to tell');
    // Read once the account is enabled again.
    assert.deepEqual(
      s.notices(disabled.id).map((notice) => [notice.title, notice.body, notice.link]),
      [[
        'Premium ended',
        'Your Premium subscription ended on 2026-11-18 without renewing, because your account was disabled then, ' +
          'and nothing was taken from your credit. Your account is on Default now.',
        '/settings/subscription',
      ]]
    );
    assert.deepEqual(s.creditRepository.findInconsistentBalances(), []);
  } finally {
    s.close();
  }
});

test('the prices cannot be read: the pass stops, and nobody is renewed or ended', async () => {
  const s = load('no-prices');
  try {
    const { admin } = await s.setUp();
    const alice = await buyer(s, admin, 'alice@example.com');
    writeSettingRaw(s.dbDir, 'app-settings', '{ not json');
    s.config.invalidateSettingsCache();
    s.setNow(END + 60_000);
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    let report;
    try {
      report = await s.subscriptions.renewDueSubscriptions();
    } finally {
      console.warn = original;
    }
    assert.deepEqual(report, { ...NOTHING, stopped: true });
    assert.ok(warnings.some((line) => line.startsWith('[subscriptions] Could not read the subscription prices')), warnings.join('\n'));
    const [row] = s.sql('SELECT subscription, subscription_paid_through FROM users WHERE id = ?', alice.id);
    assert.deepEqual(row, { subscription: 'premium', subscription_paid_through: iso(END) }, 'untouched: not ended as "not offered"');
    assert.equal(s.renewals(alice.id).length, 0);
    assert.deepEqual(s.notices(alice.id), []);
  } finally {
    s.close();
  }
});

test('a disabled account is never charged for another period - enabled again in time it renews as before - and the charge itself refuses one', async () => {
  const s = load('disabled');
  try {
    const { admin } = await s.setUp();
    const alice = await buyer(s, admin, 'alice@example.com');
    // Disabled, and enabled again before the 30 days are up: nothing changed.
    s.users.updateUser(alice.id, { disabled: true });
    s.users.updateUser(alice.id, { disabled: false });
    s.setNow(END + 60_000);
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), { ...NOTHING, renewed: 1 });
    assert.equal(s.renewals(alice.id).length, 1);

    // The one conditional debit refuses a disabled account as it refuses a
    // reporter - whatever its balance - and says which, so a short balance is
    // still told apart from it.
    s.users.updateUser(alice.id, { disabled: true });
    const balance = s.users.getUserById(alice.id).balanceMilli;
    const charge = {
      userId: alice.id,
      amountMilli: 9_990,
      reason: 'subscription-renewal',
      idempotencyKey: 'test:disabled',
      refId: `subscription:${alice.id}`,
      note: 'test',
    };
    assert.deepEqual(s.creditRepository.debitSubscriptionCharge(charge), { ok: false, reason: 'disabled', balance });
    assert.equal(s.creditRepository.isLedgerKeyUsed('test:disabled'), false, 'no row');
    s.users.updateUser(alice.id, { disabled: false });
    assert.equal(
      s.creditRepository.debitSubscriptionCharge({ ...charge, amountMilli: balance + 1, idempotencyKey: 'test:short' }).reason,
      'insufficient'
    );
    assert.equal(s.users.getUserById(alice.id).balanceMilli, balance, 'nothing taken');
  } finally {
    s.close();
  }
});

test('a price that is set and cannot be read holds what renews as it - neither renewed nor ended, and said - while the rest go on', async () => {
  const s = load('unreadable', { premiumPlusPriceUsd: '19.99' });
  try {
    const { admin } = await s.setUp();
    process.env.SUBSCRIPTION_PREMIUM_PRICE_USD = '9.99';
    const alice = await buyer(s, admin, 'alice@example.com');
    const bob = await buyer(s, admin, 'bob@example.com', { tier: 'premium-plus', chargeUsd: '19.99', balanceMilli: 100_000 });
    const carol = await buyer(s, admin, 'carol@example.com');
    await s.subscriptions.cancelSubscription(s.users.getUserById(carol.id));

    // A typo in .env. Premium is not for sale meanwhile - but nobody decided
    // to stop offering it, so the Premium paid for is not ended for it.
    process.env.SUBSCRIPTION_PREMIUM_PRICE_USD = '9,99';
    assert.deepEqual((await s.config.getSubscriptionPriceReading()).unreadable, [{ tier: 'premium', source: 'env' }]);
    s.setNow(END + 60_000);
    let { result, warnings } = await captureWarnings(() => s.subscriptions.renewDueSubscriptions());
    assert.deepEqual(result, { ...NOTHING, renewed: 1, lapsed: 1, held: 1 }, 'bob renewed, carol ended as she chose');
    const row = (id) =>
      s.sql(
        'SELECT subscription, subscription_period_start, subscription_paid_through, subscription_period_price_milli FROM users WHERE id = ?',
        id
      )[0];
    assert.deepEqual(row(alice.id), {
      subscription: 'premium',
      subscription_period_start: iso(T0),
      subscription_paid_through: iso(END),
      subscription_period_price_milli: 9_990,
    });
    assert.equal(s.renewals(alice.id).length, 0);
    assert.deepEqual(s.notices(alice.id), []);
    assert.ok(
      warnings.some((line) =>
        line.startsWith(
          '[subscriptions] 1 subscription(s) due were neither renewed nor ended, because a price cannot be read ' +
            '(Premium: SUBSCRIPTION_PREMIUM_PRICE_USD in .env).'
        )
      ),
      warnings.join('\n')
    );
    // Held again at the next pass, not ended.
    s.setNow(END + 3_600_000);
    assert.deepEqual((await captureWarnings(() => s.subscriptions.renewDueSubscriptions())).result, { ...NOTHING, held: 1 });

    // Corrected: renewed at the price, from where the 30 days ended.
    process.env.SUBSCRIPTION_PREMIUM_PRICE_USD = '12';
    s.setNow(END + 2 * 3_600_000);
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), { ...NOTHING, renewed: 1 });
    assert.deepEqual(row(alice.id), {
      subscription: 'premium',
      subscription_period_start: iso(END),
      subscription_paid_through: iso(END + 30 * DAY),
      subscription_period_price_milli: 12_000,
    });
    assert.equal(s.renewals(alice.id)[0].deltaMilli, -12_000);

    // A price hand-edited into the stored row, with no price under it, holds the same way...
    const stored = JSON.parse(readSettingRaw(s.dbDir, 'app-settings'));
    writeSettingRaw(s.dbDir, 'app-settings', JSON.stringify({ ...stored, premiumPlusPriceMilli: 'free' }));
    s.config.invalidateSettingsCache();
    s.setNow(END + 30 * DAY + 60_000);
    ({ result, warnings } = await captureWarnings(() => s.subscriptions.renewDueSubscriptions()));
    assert.deepEqual(result, { ...NOTHING, renewed: 1, held: 1 }, 'alice renewed; bob held');
    assert.ok(
      warnings.some((line) => line.includes('(Premium+: the price stored under Admin -> Settings -> General)')),
      warnings.join('\n')
    );
    assert.equal(row(bob.id).subscription_paid_through, iso(END + 30 * DAY));
    // ...and over a .env price it is that price, as the page shows it.
    process.env.SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD = '15';
    assert.deepEqual(await s.subscriptions.renewDueSubscriptions(), { ...NOTHING, renewed: 1 });
    assert.equal(s.renewals(bob.id)[0].deltaMilli, -15_000);
    assert.deepEqual(s.creditRepository.findInconsistentBalances(), []);
  } finally {
    delete process.env.SUBSCRIPTION_PREMIUM_PRICE_USD;
    delete process.env.SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD;
    s.close();
  }
});

test('subscriptions held by an unreadable price do not hide the ones due after them, however many', async () => {
  const s = load('held-pages', { premiumPlusPriceUsd: '19.99' });
  try {
    const { admin } = await s.setUp();
    // 201 Premium subscriptions - more than a page - each due a second before
    // the next, all before the Premium+ one bought at T0.
    const held = Array.from({ length: 201 }, (_, i) => s.users.createUser({ email: `held${i}@example.com` }).id);
    const db = openTestDb(s.dbDir);
    try {
      const pay = db.prepare(
        `UPDATE users SET subscription = 'premium', subscription_base = 'default', subscription_period_start = ?,
                subscription_paid_through = ?, subscription_period_price_milli = 9990, subscription_renews = 1
          WHERE id = ?`
      );
      db.transaction(() => {
        held.forEach((id, i) => pay.run(iso(T0 - (201 - i) * 1000), iso(END - (201 - i) * 1000), id));
      })();
    } finally {
      db.close();
    }
    const bob = await buyer(s, admin, 'bob@example.com', { tier: 'premium-plus', chargeUsd: '19.99' });
    process.env.SUBSCRIPTION_PREMIUM_PRICE_USD = 'TBD';
    s.setNow(END + 60_000);
    const { result } = await captureWarnings(() => s.subscriptions.renewDueSubscriptions());
    assert.deepEqual(result, { ...NOTHING, renewed: 1, held: 201 });
    assert.equal(s.renewals(bob.id).length, 1, 'renewed, behind every held one');
  } finally {
    delete process.env.SUBSCRIPTION_PREMIUM_PRICE_USD;
    s.close();
  }
});

test('a renewal decided on a period that has moved on does nothing', async () => {
  const s = load('stale');
  try {
    const { admin } = await s.setUp();
    const alice = await buyer(s, admin, 'alice@example.com');
    const prices = await s.config.getSubscriptionPrices();
    s.setNow(END + 60_000);
    assert.equal(s.subscriptions.renewOrLapse(alice.id, iso(END - DAY), prices, iso(END + 60_000)), 'skipped');
    assert.equal(s.subscriptions.renewOrLapse('nobody', iso(END), prices, iso(END + 60_000)), 'skipped');
    assert.equal(s.renewals(alice.id).length, 0);
    assert.equal(s.subscriptions.renewOrLapse(alice.id, iso(END), prices, iso(END + 60_000)), 'renewed');
    assert.equal(s.subscriptions.renewOrLapse(alice.id, iso(END), prices, iso(END + 60_000)), 'skipped', 'renewed already');
    assert.equal(s.renewals(alice.id).length, 1);
  } finally {
    s.close();
  }
});

test('the sweep finds the due accounts through idx_users_subscription_due, in the order they fell due', async () => {
  const s = load('plan');
  try {
    const { admin } = await s.setUp();
    await buyer(s, admin, 'alice@example.com');
    // The first page, and a page after one: a range of the index, in its order - nothing sorted.
    for (const after of [['', 0], [iso(END - DAY), 7]]) {
      const plan = s
        .sql(`EXPLAIN QUERY PLAN ${s.subscriptionRepository.DUE_SUBSCRIPTIONS_SQL}`, ...after, iso(END), 200)
        .map((step) => step.detail)
        .join(' | ');
      assert.match(plan, /USING INDEX idx_users_subscription_due/, plan);
      assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    }
    const [index] = s.sql("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_subscription_due'");
    assert.match(index.sql, /WHERE subscription_paid_through IS NOT NULL$/, 'partial: the paid accounts only');
  } finally {
    s.close();
  }
});

test('the six columns and the index reach a database whose users table is without them', () => {
  const dirs = useTempStorage('subscription-renewal-added-columns');
  const { getDb } = loadFresh('../dist/database/sqlite');
  const db = getDb();
  db.exec('DROP INDEX IF EXISTS idx_users_subscription_due');
  const columns = [
    'subscription_base',
    'subscription_period_start',
    'subscription_paid_through',
    'subscription_period_price_milli',
    'subscription_renews',
    'subscription_next',
  ];
  for (const column of columns) db.exec(`ALTER TABLE users DROP COLUMN ${column}`);
  db.close();
  const reopened = loadFresh('../dist/database/sqlite').getDb();
  const names = reopened.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  for (const column of columns) assert.ok(names.includes(column), column);
  assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_subscription_due'").get());
  assert.ok(dirs.dbDir);
});

test('the timer: a pass at once, then on the interval, never two at once, unref\'d, and stopped by what it answers', async () => {
  const renewal = loadFresh('../dist/services/subscriptions/renewal');
  const realSetInterval = global.setInterval;
  const captured = [];
  global.setInterval = (fn, ms, ...args) => {
    // Never fires by itself: the test ticks it.
    const timer = realSetInterval(() => {}, 1_000_000);
    captured.push({ fn, ms, timer });
    return timer;
  };
  let calls = 0;
  let release = () => {};
  const pass = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = () => resolve({ renewed: 0, lapsed: 0, skipped: 0, stopped: false });
    });
  };
  let stop;
  try {
    stop = renewal.startSubscriptionRenewal(5_000, pass);
  } finally {
    global.setInterval = realSetInterval;
  }
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'a pass at once');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].ms, 5_000);
    assert.equal(captured[0].timer.hasRef(), false, 'it never holds the process open');

    captured[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'a tick while a pass runs is skipped');

    release();
    await new Promise((resolve) => setImmediate(resolve));
    captured[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'the next tick after it finished runs');
    release();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    stop();
  }
  assert.equal(renewal.describeRenewalInterval(600_000), '10 minute(s)');
  assert.equal(renewal.describeRenewalInterval(1_000), '1 second(s)');
  // The interval is SUBSCRIPTION_RENEWAL_SWEEP_MS, read when the timer starts.
  const { subscriptionRenewalSweepMs } = require('../dist/config/operational');
  assert.equal(subscriptionRenewalSweepMs({}), 600_000);
  assert.equal(subscriptionRenewalSweepMs({ SUBSCRIPTION_RENEWAL_SWEEP_MS: '1000' }), 1_000);
});

test('the first pass waits for the credit books: nothing before they are straight, then at once - and not at all once stopped', async () => {
  const renewal = loadFresh('../dist/services/subscriptions/renewal');
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const done = { renewed: 0, lapsed: 0, held: 0, skipped: 0, stopped: false };
  for (const outcome of ['resolve', 'reject']) {
    let calls = 0;
    const pass = async () => {
      calls += 1;
      return done;
    };
    let finish;
    const ready = new Promise((resolve, reject) => {
      finish = outcome === 'resolve' ? resolve : () => reject(new Error('the restore failed'));
    });
    const stop = renewal.startSubscriptionRenewalAfter(ready, 1_000_000, pass);
    try {
      await settle();
      await settle();
      assert.equal(calls, 0, `${outcome}: no pass before the books are straight`);
      finish();
      await settle();
      await settle();
      assert.equal(calls, 1, `${outcome}: the first pass once they are, however that went`);
    } finally {
      stop();
    }
  }

  let calls = 0;
  let finish;
  const stop = renewal.startSubscriptionRenewalAfter(
    new Promise((resolve) => {
      finish = resolve;
    }),
    1_000_000,
    async () => {
      calls += 1;
      return done;
    }
  );
  stop();
  finish();
  await settle();
  await settle();
  assert.equal(calls, 0, 'stopped before it started: it never starts');

  // The server starts it on the promise its credit reconciliation is chained
  // on (index.ts), never straight from the listen callback.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const chain = /const (\w+) = restoreGenerationQueue\(\)\.then\(\(restored\) => \{\s*reconcileCredits\(/.exec(index);
  assert.ok(chain, 'the restore and the reconciliation are one promise');
  assert.match(index, new RegExp(`startSubscriptionRenewalAfter\\(${chain[1]}, `));
  assert.doesNotMatch(index, /startSubscriptionRenewal\(/, 'no pass ahead of the reconciliation');
});

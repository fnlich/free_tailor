const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { loadFresh, readSettingRaw, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Credits became dollars, and the switch that runs once on a database the
 * build before it made (database/dollarSwitch.ts).
 *
 * The owner's decision (M1) is a RESET: every balance to $0, every model's
 * price to $0.000, payments and the old history kept as read-only records.
 * What is pinned here is that it does exactly that on real data from the
 * previous build - balances, a balance from before the ledger, a run in
 * progress holding credits, a queued order, a pending checkout, priced models
 * - and that nothing in it becomes free money or a second charge:
 *
 *   - each account that held credits gets a `reset` row taking them to zero,
 *     in the old unit, and the old history still adds up on its own;
 *   - the run in progress is settled on the credits it was paid with: its
 *     reservation closes, its tasks are priced at $0.000 and a failure among
 *     them gives back nothing - never dollars for credits;
 *   - a checkout opened before and paid after credits exactly what it charged;
 *   - every model reads as $0.000 and is flagged, without the settings row
 *     being rewritten;
 *   - all of it is in the snapshot log, it runs once, and a second start is a
 *     no-op.
 */

const T0 = '2026-09-01T10:00:00.000Z';

/** The tables this switch touches, exactly as the build before it (429d08f) created them. */
const PRE_DOLLAR_SCHEMA = `
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
  CREATE TABLE generation_batches (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE generation_tasks (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE payments (
    id               TEXT PRIMARY KEY,
    reference        TEXT NOT NULL UNIQUE,
    user_id          TEXT NOT NULL,
    method           TEXT NOT NULL,
    provider         TEXT NOT NULL,
    provider_ref     TEXT,
    credits          INTEGER NOT NULL,
    amount_cents     INTEGER NOT NULL,
    currency         TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    state            TEXT NOT NULL,
    failure          TEXT NOT NULL DEFAULT '',
    credited_at      TEXT,
    refunded_at      TEXT,
    refunded_credits INTEGER NOT NULL DEFAULT 0,
    fee_cents        INTEGER NOT NULL DEFAULT 0,
    credits_granted  INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE TABLE credit_ledger (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    user_id         TEXT NOT NULL,
    delta           INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
    reason          TEXT NOT NULL,
    ref_kind        TEXT NOT NULL DEFAULT '',
    ref_id          TEXT NOT NULL DEFAULT '',
    actor_id        TEXT,
    note            TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL
  );
  CREATE TABLE credit_reservations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    units      INTEGER NOT NULL,
    refunded   INTEGER NOT NULL DEFAULT 0,
    state      TEXT NOT NULL DEFAULT 'open',
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    picture       TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user',
    subscription  TEXT NOT NULL DEFAULT 'default',
    credits       INTEGER NOT NULL DEFAULT 0,
    google_sub    TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT,
    sheet_id       TEXT,
    sheet_url      TEXT,
    sheet_tab_date TEXT,
    sheet_tab_gid  TEXT,
    sheet_shared_at TEXT,
    notifications_seen_at TEXT,
    stripe_customer_id TEXT
  );
`;

/** The settings row as that build stored it: prices in credits, a credit at 50c, a crypto fee. */
const PRE_DOLLAR_SETTINGS = {
  providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
  defaultModelId: 'claude-cli-sonnet',
  creditPriceCents: 50,
  creditMinCredits: 10,
  creditMaxCredits: 5000,
  paymentLimits: [
    { target: 'card', minCents: 250, maxCents: 10_000, feeBps: 0, feeFixedCents: 0, presetsCents: [500] },
    { target: 'crypto', minCents: 5_000, maxCents: 200_000, feeBps: 220, feeFixedCents: 0, presetsCents: [5_000] },
  ],
  aiModels: [
    {
      id: 'claude-cli-sonnet', name: 'Claude Sonnet', provider: 'claude-cli', modelName: 'sonnet', description: '',
      enabled: true, creditsPerResume: 2, createdAt: T0, updatedAt: T0,
    },
    {
      id: 'codex-cli-default', name: 'Codex', provider: 'codex-cli', modelName: 'default', description: '',
      enabled: true, creditsPerResume: 1, createdAt: T0, updatedAt: T0,
    },
  ],
};

function taskData(label, payload) {
  return JSON.stringify({
    queue: 'cli',
    label: { profileId: 'p1', profileName: 'Ada', companyName: label, role: 'SWE' },
    kind: 'resume',
    payload: {
      batchId: 'bat_open',
      profileId: 'p1',
      jobIndex: 0,
      format: 'pdf',
      includeCoverLetterDocx: false,
      choice: { provider: 'claude-cli', modelName: 'sonnet', modelId: 'claude-cli-sonnet', modelLabel: 'Claude Sonnet' },
      ...payload,
    },
  });
}

/**
 * A database as the previous build left it, mid-order:
 *
 *   - alice: 12 credits, explained by her ledger, and 3 more held by an order
 *     of three resumes at a credit each - one built, one running, one queued;
 *     and a paid card payment of 100 credits at 50c.
 *   - bob: 7 credits from before the ledger, with no rows behind them (the
 *     chain never reached 004), and a checkout he opened and has not paid.
 *   - carol: nothing.
 */
function writePreDollarDatabase(dbDir) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.exec(PRE_DOLLAR_SCHEMA);
    // The chain had finished: nothing numbered runs on this boot, so what
    // moves is the switch's alone.
    db.prepare("INSERT INTO schema_meta (key, value, updated_at) VALUES ('provider_schema_version', '8', ?)").run(T0);
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('app-settings', ?, ?)").run(
      JSON.stringify(PRE_DOLLAR_SETTINGS),
      T0
    );

    const user = db.prepare(
      `INSERT INTO users (id, email, role, credits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    user.run('u-admin', 'admin@example.com', 'admin', 0, T0, T0);
    user.run('u-alice', 'alice@example.com', 'user', 12, T0, T0);
    user.run('u-bob', 'bob@example.com', 'user', 7, T0, T0);
    user.run('u-carol', 'carol@example.com', 'user', 0, T0, T0);

    const ledger = db.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, balance_after, reason, ref_kind, ref_id, note, idempotency_key,
                                  created_at)
       VALUES (?, 'u-alice', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ledger.run('led_1', 100, 100, 'purchase', 'user', 'u-alice', 'FT-PAY-1 - 100 credits', 'purchase:pay_paid', T0);
    ledger.run('led_2', -85, 15, 'admin-revoke', 'user', 'u-alice', 'spent elsewhere', 'grant:x', T0);
    ledger.run('led_3', -3, 12, 'generation-reserve', 'batch', 'bat_open', '3 resumes', 'reserve:bat_open', T0);

    db.prepare(
      `INSERT INTO credit_reservations (id, user_id, kind, units, refunded, state, label, created_at, updated_at)
       VALUES ('bat_open', 'u-alice', 'batch', 3, 0, 'open', '3 resumes', ?, ?)`
    ).run(T0, T0);

    db.prepare(`INSERT INTO generation_batches (id, state, data, created_at, updated_at) VALUES ('bat_open', 'running', ?, ?, ?)`).run(
      JSON.stringify({
        label: 'An order queued before dollars',
        jobCount: 1,
        shared: { jobs: [{ companyName: 'Acme', role: 'SWE', jobDescription: 'x' }], ownerId: 'u-alice', kind: 'order' },
        createdAt: Date.parse(T0),
      }),
      T0,
      T0
    );
    const task = db.prepare(
      `INSERT INTO generation_tasks (id, batch_id, seq, state, data, created_at, updated_at)
       VALUES (?, 'bat_open', ?, ?, ?, ?, ?)`
    );
    task.run('tsk_done', 0, 'done', taskData('Built', { creditCost: 1 }), T0, T0);
    task.run('tsk_running', 1, 'running', taskData('Running', { creditCost: 1 }), T0, T0);
    task.run('tsk_queued', 2, 'queued', taskData('Queued', { creditCost: 1 }), T0, T0);

    const payment = db.prepare(
      `INSERT INTO payments (id, reference, user_id, method, provider, provider_ref, credits, amount_cents, currency,
                             unit_price_cents, state, credited_at, credits_granted, created_at, updated_at)
       VALUES (?, ?, ?, 'card', 'stripe', ?, ?, ?, 'usd', 50, ?, ?, ?, ?, ?)`
    );
    payment.run('pay_paid', 'FT-PAY-1', 'u-alice', 'cs_paid', 100, 5_000, 'paid', T0, 100, T0, T0);
    payment.run('pay_pending', 'FT-PAY-2', 'u-bob', 'cs_pending', 10, 500, 'pending', null, 0, T0, T0);
  } finally {
    db.close();
  }
}

/** Opens the app's connection the way a fresh process would, capturing what it logs. */
function boot() {
  const logged = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));
  try {
    const sqlite = loadFresh('../dist/database/sqlite');
    return { db: sqlite.getDb(), logged };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

const switchLines = (lines) => lines.filter((line) => line.startsWith('[credits] Credits are dollars'));

test('a database from before dollars: balances and prices reset, a run in progress settled, nothing free and nothing charged twice', async () => {
  const { dbDir } = useTempStorage('dollar-switch');
  useAdminEmails('admin@example.com');
  writePreDollarDatabase(dbDir);

  const { db, logged } = boot();
  assert.equal(switchLines(logged).length, 1, logged.join('\n'));
  assert.ok(logged.some((line) => /FREE until it is priced/.test(line)), 'the operator is told every model is free');

  // Every balance is $0, in both units.
  for (const row of db.prepare('SELECT id, credits, balance_milli FROM users').all()) {
    assert.deepEqual([row.credits, row.balance_milli], [0, 0], row.id);
  }

  // A reset row per account that held credits, in the old unit, explaining the jump.
  const resets = db.prepare("SELECT user_id, delta, balance_after, delta_milli, note FROM credit_ledger WHERE reason = 'reset' ORDER BY user_id").all();
  assert.deepEqual(
    resets.map((row) => [row.user_id, row.delta, row.balance_after, row.delta_milli]),
    [
      ['u-alice', -12, 0, 0],
      ['u-bob', -7, 0, 0],
    ]
  );
  assert.match(
    resets[0].note,
    /12 credits were reset to \$0\. 3 more credits were held by a run in progress, which finishes on them; a resume of it that fails gives nothing back\.$/
  );
  assert.match(resets[1].note, /7 credits were reset to \$0\.$/);

  // Bob's balance had no row behind it; it got 004's own opening row first,
  // so his old history adds up - and 004 has nothing left to do.
  const bobRows = db.prepare("SELECT reason, delta, idempotency_key FROM credit_ledger WHERE user_id = 'u-bob' ORDER BY seq").all();
  assert.deepEqual(bobRows.map((row) => [row.reason, row.delta]), [['opening-balance', 7], ['reset', -7]]);
  assert.equal(bobRows[0].idempotency_key, 'opening:u-bob');

  // The old history still sums to the old column - zero - for an older build
  // rolled back to, and the dollar ledger agrees with the dollar balance.
  for (const row of db.prepare('SELECT u.id, u.credits, COALESCE(SUM(l.delta), 0) AS sum FROM users u LEFT JOIN credit_ledger l ON l.user_id = u.id GROUP BY u.id').all()) {
    assert.equal(row.sum, row.credits, `${row.id}'s history in credits`);
  }
  const creditRepo = loadFresh('../dist/database/creditRepository');
  assert.deepEqual(creditRepo.findInconsistentBalances(), []);

  // The run in progress: its reservation is settled on what it was paid, and
  // holds no dollars; every task of it is priced at $0.000, its credit cost kept.
  const reservation = db.prepare("SELECT state, units, units_milli, refunded_milli FROM credit_reservations WHERE id = 'bat_open'").get();
  assert.deepEqual(reservation, { state: 'closed', units: 3, units_milli: 0, refunded_milli: 0 });
  for (const row of db.prepare('SELECT id, data FROM generation_tasks').all()) {
    const payload = JSON.parse(row.data).payload;
    assert.equal(payload.costMilli, 0, row.id);
    assert.equal(payload.creditCost, 1, `${row.id} keeps what it cost then`);
  }

  // The pending checkout will credit exactly what it charges; the paid one is history.
  const payments = db.prepare('SELECT id, credits, credit_milli, credited_milli FROM payments ORDER BY id').all();
  assert.deepEqual(payments, [
    { id: 'pay_paid', credits: 100, credit_milli: 0, credited_milli: 0 },
    { id: 'pay_pending', credits: 10, credit_milli: 5_000, credited_milli: 0 },
  ]);

  // Models read as $0.000 and are flagged - by rule, the row untouched.
  assert.equal(readSettingRaw(dbDir, 'app-settings'), JSON.stringify(PRE_DOLLAR_SETTINGS));
  const config = loadFresh('../dist/config/aiModelConfig');
  const admin = await config.getAdminAppSettings();
  assert.deepEqual(admin.aiModels.map((model) => [model.id, model.pricePerResumeMilli]), [
    ['claude-cli-sonnet', 0],
    ['codex-cli-default', 0],
  ]);
  assert.deepEqual(admin.freeEnabledModelIds, ['claude-cli-sonnet', 'codex-cli-default']);
  assert.equal(JSON.stringify(admin.paymentLimits).includes('fee'), false, 'and no fee survives');

  // Everything it changed, as it was, in one place.
  const log = JSON.parse(readSettingRaw(dbDir, 'migration-log.credits-to-dollars'));
  assert.deepEqual(log.accounts, [
    { userId: 'u-alice', email: 'alice@example.com', credits: 12, held: 3 },
    { userId: 'u-bob', email: 'bob@example.com', credits: 7, held: 0 },
  ]);
  assert.equal(log.resetRows, 2);
  assert.deepEqual(log.reservations, [{ id: 'bat_open', userId: 'u-alice', kind: 'batch', units: 3, refunded: 0 }]);
  assert.deepEqual(
    log.tasks.map((entry) => [entry.id, entry.state, entry.creditCost]),
    [
      ['tsk_running', 'running', 1],
      ['tsk_queued', 'queued', 1],
    ]
  );
  assert.equal(log.tasksPriced, 3);
  assert.deepEqual(log.pendingPayments, [{ id: 'pay_pending', reference: 'FT-PAY-2', amountCents: 500, credits: 10 }]);
  assert.deepEqual(log.models, [
    { id: 'claude-cli-sonnet', name: 'Claude Sonnet', creditsPerResume: 2 },
    { id: 'codex-cli-default', name: 'Codex', creditsPerResume: 1 },
  ]);
  assert.equal(log.pricing.creditPriceCents, 50);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key = 'credit_unit'").get().value, 'usd-milli');

  // Alice's history reads as what happened, in the unit it happened in.
  const credits = loadFresh('../dist/services/credits');
  const history = credits.getLedger('u-alice');
  assert.equal(history[0].reason, 'reset');
  assert.deepEqual(
    history.map((entry) => [entry.reason, entry.deltaMilli, entry.legacyCredits]),
    [
      ['reset', 0, { delta: -12, balanceAfter: 0 }],
      ['generation-reserve', 0, { delta: -3, balanceAfter: 12 }],
      ['admin-revoke', 0, { delta: -85, balanceAfter: 15 }],
      ['purchase', 0, { delta: 100, balanceAfter: 100 }],
    ]
  );

  // The order finishes on what it was paid. The queue comes back, the two
  // unfinished resumes fail - and give back NOTHING: no dollars for credits,
  // and no second charge either.
  process.env.GENERATION_MAX_ATTEMPTS = '1';
  try {
    const queueModule = loadFresh('../dist/services/queue/index');
    queueModule.resetGenerationQueueForTests();
    const ran = [];
    const queue = queueModule.getGenerationQueue();
    queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload) => {
      ran.push(payload.costMilli);
      throw new Error('no template here');
    });
    const restored = await queueModule.restoreGenerationQueue();
    assert.deepEqual(restored.batchIds, ['bat_open']);
    for (let i = 0; i < 300 && queue.snapshot('bat_open')?.state === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(ran, [0, 0], 'both unfinished resumes ran, priced at $0.000');
    const aliceAfter = credits.getLedger('u-alice');
    assert.equal(aliceAfter.length, history.length, 'no refund row, no charge row');
    assert.equal(loadFresh('../dist/database/userRepository').getUserById('u-alice').balanceMilli, 0);
    queueModule.resetGenerationQueueForTests();
  } finally {
    delete process.env.GENERATION_MAX_ATTEMPTS;
  }

  // Bob's checkout, paid now, credits exactly the $5 it charged.
  loadFresh('../dist/database/paymentRepository');
  const paymentsService = loadFresh('../dist/services/payments');
  assert.equal(paymentsService.creditPaid('pay_pending').credited, true);
  const bob = loadFresh('../dist/database/userRepository').getUserById('u-bob');
  assert.equal(bob.balanceMilli, 5_000);
  // Written in dollars only: an older build rolled back to still reads 0 credits.
  const bobOld = db.prepare("SELECT credits, (SELECT SUM(delta) FROM credit_ledger WHERE user_id = 'u-bob') AS sum FROM users WHERE id = 'u-bob'").get();
  assert.deepEqual(bobOld, { credits: 0, sum: 0 });
  assert.deepEqual(creditRepo.findInconsistentBalances(), []);

  // A second start is a no-op: no new rows, the log as it was.
  const rowsBefore = db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n;
  const logBefore = readSettingRaw(dbDir, 'migration-log.credits-to-dollars');
  const second = boot();
  assert.equal(switchLines(second.logged).length, 0, second.logged.join('\n'));
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n, rowsBefore);
  assert.equal(readSettingRaw(dbDir, 'migration-log.credits-to-dollars'), logBefore);
  assert.equal(second.db.prepare("SELECT balance_milli FROM users WHERE id = 'u-bob'").get().balance_milli, 5_000);
});

test('an account whose credits were all held by a run gets a reset row that moves nothing and says why', () => {
  const { dbDir } = useTempStorage('dollar-switch-held-only');
  useAdminEmails('admin@example.com');
  writePreDollarDatabase(dbDir);
  // dave: granted 9 credits and spent all of them on two runs still going -
  // a balance of 0, and 9 held. Closing those reservations is what stops his
  // runs refunding, so his history has to say so even though his balance
  // has nothing to reset.
  const pre = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    pre.prepare(
      `INSERT INTO users (id, email, role, credits, created_at, updated_at) VALUES ('u-dave', 'dave@example.com', 'user', 0, ?, ?)`
    ).run(T0, T0);
    const ledger = pre.prepare(
      `INSERT INTO credit_ledger (id, user_id, delta, balance_after, reason, ref_kind, ref_id, note, idempotency_key,
                                  created_at)
       VALUES (?, 'u-dave', ?, ?, ?, ?, ?, '', ?, ?)`
    );
    ledger.run('led_d1', 9, 9, 'admin-grant', 'user', 'u-dave', 'grant:d', T0);
    ledger.run('led_d2', -2, 7, 'generation-reserve', 'batch', 'bat_d1', 'reserve:bat_d1', T0);
    ledger.run('led_d3', -7, 0, 'generation-reserve', 'batch', 'bat_d2', 'reserve:bat_d2', T0);
    const reserve = pre.prepare(
      `INSERT INTO credit_reservations (id, user_id, kind, units, refunded, state, label, created_at, updated_at)
       VALUES (?, 'u-dave', 'batch', ?, 0, 'open', '', ?, ?)`
    );
    reserve.run('bat_d1', 2, T0, T0);
    reserve.run('bat_d2', 7, T0, T0);
  } finally {
    pre.close();
  }

  const { db } = boot();
  const daveRows = db
    .prepare("SELECT reason, delta, balance_after, delta_milli, note FROM credit_ledger WHERE user_id = 'u-dave' ORDER BY seq")
    .all();
  assert.deepEqual(
    daveRows.map((row) => [row.reason, row.delta, row.balance_after, row.delta_milli]),
    [
      ['admin-grant', 9, 9, 0],
      ['generation-reserve', -2, 7, 0],
      ['generation-reserve', -7, 0, 0],
      // No opening row - a balance of 0 has nothing to carry over - and a
      // reset that moves nothing, so the old history still sums to 0.
      ['reset', 0, 0, 0],
    ]
  );
  assert.equal(
    daveRows[3].note,
    "Credits became dollars: this account's balance was already 0 credits. 9 credits were held by a run in " +
      'progress, which finishes on them; a resume of it that fails gives nothing back.'
  );
  assert.deepEqual(
    db.prepare("SELECT id, state FROM credit_reservations WHERE user_id = 'u-dave' ORDER BY id").all(),
    [
      { id: 'bat_d1', state: 'closed' },
      { id: 'bat_d2', state: 'closed' },
    ]
  );
  assert.deepEqual(loadFresh('../dist/database/creditRepository').findInconsistentBalances(), []);

  // Served as the end of his history in credits, never as a "+$0.000" movement.
  const history = loadFresh('../dist/services/credits').getLedger('u-dave');
  assert.deepEqual(
    [history[0].reason, history[0].deltaMilli, history[0].legacyCredits],
    ['reset', 0, { delta: 0, balanceAfter: 0 }]
  );

  const log = JSON.parse(readSettingRaw(dbDir, 'migration-log.credits-to-dollars'));
  assert.deepEqual(
    log.accounts.find((entry) => entry.userId === 'u-dave'),
    { userId: 'u-dave', email: 'dave@example.com', credits: 0, held: 9 }
  );
  // alice, bob - and dave.
  assert.equal(log.resetRows, 3);
});

test('a fresh database records the unit and changes nothing else', () => {
  const { dbDir } = useTempStorage('dollar-switch-fresh');
  const { db, logged } = boot();
  assert.deepEqual(switchLines(logged), ['[credits] Credits are dollars, counted in thousandths ($0.001).']);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key = 'credit_unit'").get().value, 'usd-milli');
  const log = JSON.parse(readSettingRaw(dbDir, 'migration-log.credits-to-dollars'));
  assert.deepEqual(
    [log.accounts, log.reservations, log.tasks, log.pendingPayments, log.models, log.resetRows],
    [[], [], [], [], [], 0]
  );
  // And a new account is just an account in dollars.
  const users = loadFresh('../dist/database/userRepository');
  assert.equal(users.createUser({ email: 'new@example.com' }).balanceMilli, 0);
});

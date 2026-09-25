const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Paging an account's own two histories, and the one way it goes wrong quietly.
 *
 * Both of these lists used to answer with the newest N and say nothing about
 * the rest - a window that introduced itself as a history. The payments one
 * mattered most, because every row on the credits page links to that order's
 * own page: a payment past the cap was an order its buyer could not open.
 *
 * Three claims here, in the order of how badly each one fails:
 *
 *  1. **The order is the same order every time.** `payments.created_at` is a
 *     second-resolution string, so two payments made in the same second tie on
 *     it, and a plain `ORDER BY created_at DESC` leaves those ties for SQLite
 *     to break however its plan happens to. The `rowid` tiebreak decides them.
 *     The test for it has to write rows inside the same second AND compare
 *     against a known order: comparing a paged read to an unpaged read is not
 *     enough, because both shuffle the same way and agree with each other
 *     while both are wrong. That was measured, not assumed.
 *
 *  2. **`total` is the real count**, not the length of the page. Without it
 *     the page cannot tell a short last page from a full one, and goes back to
 *     describing whatever it was given as the whole history.
 *
 *  3. **An offset is not a way around `WHERE user_id`.** Paging is a new way
 *     to ask for these rows; this is the assertion that says the new way is
 *     scoped like the old one.
 *
 * Plus the clamps, because the offset arrives from a query string: a negative
 * one is a SQL error rather than a refusal, and a NaN silently becomes the
 * first page again - which would make a Next button fetch the rows already on
 * screen for ever.
 */

/** Two payments a second, so `created_at` genuinely ties. */
const PER_SECOND = 2;

async function serve() {
  useTempStorage(`history-paging-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.CRYPTOMUS_MERCHANT_ID;
  delete process.env.CRYPTOMUS_PAYMENT_API_KEY;

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/config/aiModelConfig');
  const credits = loadFresh('../dist/services/credits');
  loadFresh('../dist/integrations/stripe');
  loadFresh('../dist/integrations/cryptomus');
  loadFresh('../dist/services/payments/pricing');
  loadFresh('../dist/services/payments');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const paymentRoutes = loadFresh('../dist/routes/payments');
  const creditRoutes = loadFresh('../dist/routes/credits');

  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/payments', paymentRoutes.default);
  app.use('/api/credits', creditRoutes.default);
  const server = app.listen(0);
  const port = server.address().port;

  const aliceToken = users.createSession(alice.id);
  const bobToken = users.createSession(bob.id);

  const get = async (path, token = aliceToken) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    users,
    payments,
    credits,
    alice,
    bob,
    aliceToken,
    bobToken,
    close: () => server.close(),
    get,
    /**
     * `count` payments for one account, newest last, several per second.
     *
     * The timestamps are the whole point: `createPayment` takes the moment as
     * an argument, so this can force the tie that a second-resolution column
     * makes possible and that a real installation hits every time two people
     * buy at once.
     */
    seedPayments: (userId, count) => {
      const made = [];
      for (let index = 0; index < count; index += 1) {
        const at = new Date(Date.UTC(2026, 0, 1, 12, Math.floor(index / PER_SECOND)));
        made.push(
          payments.createPayment(
            {
              userId,
              method: 'card',
              provider: 'stripe',
              credits: 10,
              amountCents: 500,
              currency: 'usd',
              unitPriceCents: 50,
            },
            at
          )
        );
      }
      return made;
    },
    seedLedger: (userId, count) => {
      for (let index = 0; index < count; index += 1) {
        credits.grantCredits(userId, 1, userId, `movement ${index}`);
      }
    },
  };
}

/* ---------------------------------------------------------------- payments */

test('a page of payments is a page, and the count is the whole list', async () => {
  const server = await serve();
  try {
    server.seedPayments(server.alice.id, 12);

    const first = await server.get('/api/payments?limit=5&offset=0');
    assert.equal(first.status, 200);
    assert.equal(first.body.payments.length, 5);
    // The claim the page renders as "1-5 of 12 payments". Reporting the page
    // length here is how a list goes back to describing itself as complete.
    assert.equal(first.body.total, 12);
    assert.equal(first.body.offset, 0);

    const last = await server.get('/api/payments?limit=5&offset=10');
    assert.equal(last.body.payments.length, 2, 'the short last page');
    assert.equal(last.body.total, 12);
  } finally {
    server.close();
  }
});

test('paging through them sees every payment exactly once', async () => {
  const server = await serve();
  try {
    // No row twice and no row missing, which is the weaker of the two
    // ordering claims - the stronger one is the test below.
    const made = server.seedPayments(server.alice.id, 12);

    const seen = [];
    for (let offset = 0; offset < 12; offset += 5) {
      const page = await server.get(`/api/payments?limit=5&offset=${offset}`);
      seen.push(...page.body.payments.map((payment) => payment.id));
    }

    assert.equal(seen.length, 12, 'a row was returned twice or not at all');
    assert.equal(new Set(seen).size, 12, 'a row appeared on two pages');
    assert.deepEqual(
      [...seen].sort(),
      made.map((payment) => payment.id).sort(),
      'the pages together are not the whole list'
    );
  } finally {
    server.close();
  }
});

test('payments written in the same second come back newest first', async () => {
  const server = await serve();
  try {
    /*
     * The test the `rowid` tiebreak exists for, and it has to assert the
     * ORDER against a known answer rather than against another query.
     *
     * Two of every three of these share a `created_at` to the second, because
     * that column is a second-resolution string. An `ORDER BY created_at DESC`
     * with nothing after it leaves those ties for SQLite to break however its
     * plan happens to, and comparing one paged read to one unpaged read does
     * not catch it: both reads shuffle the same way, so they agree with each
     * other while both disagree with the truth. Measured - with the tiebreak
     * removed, that comparison still passed.
     *
     * So the expectation is the insertion order, reversed. Within a second,
     * the payment made later is the newer one and belongs first.
     */
    const made = server.seedPayments(server.alice.id, 8);
    const newestFirst = [...made].reverse().map((payment) => payment.id);

    const paged = [];
    for (const offset of [0, 3, 6]) {
      const page = await server.get(`/api/payments?limit=3&offset=${offset}`);
      paged.push(...page.body.payments.map((payment) => payment.id));
    }

    assert.deepEqual(paged, newestFirst);

    // And read in one go it is the same list, so the page size cannot change
    // what order somebody sees their own payments in.
    const all = await server.get('/api/payments?limit=8&offset=0');
    assert.deepEqual(
      all.body.payments.map((payment) => payment.id),
      newestFirst
    );
  } finally {
    server.close();
  }
});

test('an offset past the end is an empty page, not an error', async () => {
  const server = await serve();
  try {
    server.seedPayments(server.alice.id, 3);
    const beyond = await server.get('/api/payments?limit=5&offset=500');
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.body.payments, []);
    // Still the real count, so the page can put somebody back on a real page
    // rather than leaving them looking at nothing with no way to say why.
    assert.equal(beyond.body.total, 3);
  } finally {
    server.close();
  }
});

test('a nonsense offset is the first page rather than a crash or a loop', async () => {
  const server = await serve();
  try {
    const made = server.seedPayments(server.alice.id, 6);
    const newest = made[made.length - 1].id;

    for (const query of ['offset=-1', 'offset=abc', 'offset=', '']) {
      const page = await server.get(`/api/payments?limit=2${query ? `&${query}` : ''}`);
      assert.equal(page.status, 200, query);
      // A negative offset reaches SQLite as `OFFSET -1`, which is an error and
      // a 500 on a page somebody was reading.
      assert.equal(page.body.payments.length, 2, query);
      assert.equal(page.body.payments[0].id, newest, query);
      assert.equal(page.body.offset, 0, query);
    }
  } finally {
    server.close();
  }
});

test('a silly limit is capped rather than refused', async () => {
  const server = await serve();
  try {
    server.seedPayments(server.alice.id, 3);
    /*
     * A ceiling, not a 400. Somebody asking for ten thousand rows wanted a
     * list and gets one - but an unbounded limit would turn a paged endpoint
     * back into the unpaged one it replaced, and the only symptom would be a
     * slow page on the account with the longest history.
     */
    const huge = await server.get('/api/payments?limit=99999');
    assert.equal(huge.status, 200);
    assert.equal(huge.body.payments.length, 3);

    const zero = await server.get('/api/payments?limit=0');
    assert.equal(zero.body.payments.length, 3, 'a limit of zero is not a limit of zero rows');
  } finally {
    server.close();
  }
});

test('an offset is not a way around whose payments these are', async () => {
  const server = await serve();
  try {
    server.seedPayments(server.alice.id, 6);
    server.seedPayments(server.bob.id, 6);

    const mine = await server.get('/api/payments?limit=100', server.bobToken);
    assert.equal(mine.body.total, 6, "the count is this account's, not the table's");
    assert.ok(
      mine.body.payments.every((payment) => payment.userId === server.bob.id),
      'somebody else rows came back'
    );

    // And walking off the end of your own list does not walk into theirs.
    const past = await server.get('/api/payments?limit=5&offset=6', server.bobToken);
    assert.deepEqual(past.body.payments, []);
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------------ ledger */

test('the credit ledger pages the same way, and counts the same way', async () => {
  const server = await serve();
  try {
    // 1 signup row at most plus the ones seeded here; the count is read back
    // rather than assumed, because the grant policy is a setting.
    server.seedLedger(server.alice.id, 12);

    const first = await server.get('/api/credits/ledger?limit=5&offset=0');
    assert.equal(first.status, 200);
    assert.equal(first.body.entries.length, 5);
    const total = first.body.total;
    assert.ok(total >= 12, `expected at least the 12 seeded, saw ${total}`);
    // The balance rides along, because the panel above the list shows it.
    assert.equal(typeof first.body.balance, 'number');

    const seen = [];
    for (let offset = 0; offset < total; offset += 5) {
      const page = await server.get(`/api/credits/ledger?limit=5&offset=${offset}`);
      seen.push(...page.body.entries.map((entry) => entry.seq));
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'a movement appeared on two pages');
    // `seq` is monotonic, which is why this list needs no tiebreak: newest
    // first means strictly descending, with no ties to resolve.
    assert.deepEqual(seen, [...seen].sort((left, right) => right - left));
  } finally {
    server.close();
  }
});

test('one account cannot page into another account movements', async () => {
  const server = await serve();
  try {
    server.seedLedger(server.alice.id, 8);
    server.seedLedger(server.bob.id, 3);

    const bobLedger = await server.get('/api/credits/ledger?limit=100', server.bobToken);
    assert.ok(
      bobLedger.body.entries.every((entry) => entry.userId === server.bob.id),
      'somebody else movements came back'
    );
    assert.ok(bobLedger.body.total < 8 + 3, `the count spans both accounts: ${bobLedger.body.total}`);
  } finally {
    server.close();
  }
});

test('a ledger request with no paging at all still answers as it always did', async () => {
  const server = await serve();
  try {
    /*
     * The compatibility claim, and the reason both parameters are optional.
     *
     * A browser tab loaded before this shipped sends neither and reads neither
     * - it must keep getting a list rather than an error or an empty page.
     */
    server.seedLedger(server.alice.id, 4);
    const plain = await server.get('/api/credits/ledger');
    assert.equal(plain.status, 200);
    assert.ok(plain.body.entries.length >= 4);

    const plainPayments = await server.get('/api/payments');
    assert.equal(plainPayments.status, 200);
    assert.ok(Array.isArray(plainPayments.body.payments));
  } finally {
    server.close();
  }
});

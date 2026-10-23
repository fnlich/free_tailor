const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Order numbers and order counts.
 *
 * The number is the thing a person writes down and quotes back, so the one
 * property that matters is that it never means two orders. The tests below come
 * at it from both sides: the sequence must not reissue a number a live order
 * already answers to, and the UNIQUE index must refuse it even if the
 * arithmetic above it ever gets that wrong.
 *
 * The counts are the other half. "122 of 300" comes from one grouped query
 * rather than from loading the rows, because the obvious implementation is
 * three hundred rows per order per render.
 */

function setup(name) {
  useTempStorage(`order-repo-${name}-${Math.random().toString(36).slice(2)}`);
  loadFresh('../dist/database/sqlite');
  return loadFresh('../dist/database/orderRepository');
}

const ONE_ITEM = [{ seq: 0, resumeId: 'p1', resumeName: 'Ada', companyName: 'Acme', role: 'SWE' }];

function itemsFor(count) {
  return Array.from({ length: count }, (_, seq) => ({
    seq,
    resumeId: 'p1',
    resumeName: 'Ada',
    companyName: `Co${seq}`,
    role: 'SWE',
  }));
}

test('order numbers run in sequence within a day and restart on the next', () => {
  const orders = setup('numbering');
  const monday = new Date('2026-09-20T09:00:00Z');
  const tuesday = new Date('2026-09-21T09:00:00Z');

  assert.equal(orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, monday).number, 'FT-20260920-0001');
  assert.equal(orders.createOrder({ userId: 'u2', retentionDays: 5 }, ONE_ITEM, monday).number, 'FT-20260920-0002');
  assert.equal(orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, tuesday).number, 'FT-20260921-0001');
  // And back to Monday: the sequence continues where that day left off, rather
  // than reusing 0001 because it was the most recent insert.
  assert.equal(orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, monday).number, 'FT-20260920-0003');
});

test('a removed order in the middle of a day cannot have its number reissued', () => {
  const orders = setup('no-reuse');
  const day = new Date('2026-09-20T09:00:00Z');
  const first = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);
  const second = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);
  const third = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);
  assert.deepEqual([first.number, second.number, third.number], [
    'FT-20260920-0001',
    'FT-20260920-0002',
    'FT-20260920-0003',
  ]);

  const { getDb } = require('../dist/database/sqlite');
  getDb().prepare('DELETE FROM orders WHERE id = ?').run(second.id);

  // Counting the day's rows would now say two, and hand out 0003 - which the
  // third order is already answering to. Taking the highest leaves a gap
  // instead, which is the cheaper of the two mistakes.
  const fourth = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);
  assert.equal(fourth.number, 'FT-20260920-0004');
  assert.notEqual(fourth.number, third.number);
});

test('two orders can never answer to one number, whatever the sequence says', () => {
  const orders = setup('unique');
  const day = new Date('2026-09-20T09:00:00Z');
  const first = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);

  // The database is the real guarantee, not the arithmetic above it.
  const { getDb } = require('../dist/database/sqlite');
  assert.throws(
    () =>
      getDb()
        .prepare(
          `INSERT INTO orders (id, number, user_id, label, total, state, created_at, updated_at, expires_at)
           VALUES ('ord_clone', ?, 'u1', '', 1, 'running', '2026-09-20', '2026-09-20', '2026-09-25')`
        )
        .run(first.number),
    /UNIQUE constraint failed/
  );
});

test('the sequence keeps counting past the padding width', () => {
  const orders = setup('overflow');
  const day = new Date('2026-09-20T09:00:00Z');
  const first = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);

  // Straight to the edge. A STRING max over a zero-padded field sorts
  // 'FT-...-10000' below 'FT-...-9999', so it would keep answering 9999, every
  // retry would collide with the UNIQUE index, and the fifth would throw -
  // failing this order and every other order for the rest of the day.
  const { getDb } = require('../dist/database/sqlite');
  getDb()
    .prepare(`UPDATE orders SET number = 'FT-20260920-9999' WHERE id = ?`)
    .run(first.id);

  const next = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);
  assert.equal(next.number, 'FT-20260920-10000');

  const after = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, day);
  assert.equal(after.number, 'FT-20260920-10001');
});

test('the expiry is stamped at creation, not derived later', () => {
  const orders = setup('expiry');
  const at = new Date('2026-09-20T09:00:00Z');
  const order = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, at);
  assert.equal(order.expiresAt, '2026-09-25T09:00:00.000Z');

  // Changing the window afterwards must not reach back and move it, which is
  // the whole reason it is a column rather than created_at plus a setting.
  const later = orders.createOrder({ userId: 'u1', retentionDays: 1 }, ONE_ITEM, at);
  assert.equal(later.expiresAt, '2026-09-21T09:00:00.000Z');
  assert.equal(orders.getOrder(order.id).expiresAt, '2026-09-25T09:00:00.000Z');
});

test('counts come from one query and add up across every state', () => {
  const orders = setup('counts');
  const order = orders.createOrder({ userId: 'u1', batchId: 'b1', retentionDays: 5 }, itemsFor(6));

  orders.recordItemOutcome('b1', 0, { state: 'done' });
  orders.recordItemOutcome('b1', 1, { state: 'done' });
  orders.recordItemOutcome('b1', 2, { state: 'failed', error: 'x' });
  orders.recordItemOutcome('b1', 3, { state: 'cancelled' });
  orders.markItemRunning('b1', 4);

  const counts = orders.countsForOrder(order.id);
  assert.deepEqual(counts, {
    total: 6,
    queued: 1,
    running: 1,
    done: 2,
    failed: 1,
    cancelled: 1,
    settled: 4,
  });
  assert.equal(counts.queued + counts.running + counts.settled, counts.total);
});

test('counts for several orders never bleed into each other', () => {
  const orders = setup('multi-counts');
  const first = orders.createOrder({ userId: 'u1', batchId: 'b1', retentionDays: 5 }, itemsFor(3));
  const second = orders.createOrder({ userId: 'u1', batchId: 'b2', retentionDays: 5 }, itemsFor(2));
  orders.recordItemOutcome('b1', 0, { state: 'done' });
  orders.recordItemOutcome('b2', 0, { state: 'failed', error: 'x' });

  const counts = orders.countsForOrders([first.id, second.id]);
  assert.equal(counts.get(first.id).done, 1);
  assert.equal(counts.get(first.id).failed, 0);
  assert.equal(counts.get(second.id).failed, 1);
  assert.equal(counts.get(second.id).done, 0);

  // An id with no order gives empty counts rather than undefined, so a caller
  // rendering a bar never has to guard.
  assert.equal(orders.countsForOrder('ord_nothing').total, 0);
});

test('a submission that never reached the queue is closed rather than left running', () => {
  const orders = setup('fail-order');
  const order = orders.createOrder({ userId: 'u1', batchId: 'b1', retentionDays: 5 }, itemsFor(3));
  orders.recordItemOutcome('b1', 0, { state: 'done' });

  orders.failOrder(order.id, 'The order could not be queued.');

  assert.equal(orders.getOrder(order.id).state, 'failed');
  const items = orders.listOrderItems(order.id);
  assert.equal(items[0].state, 'done', 'what already finished keeps its outcome');
  assert.equal(items[1].state, 'failed');
  assert.equal(items[1].error, 'The order could not be queued.');
});

test('a files column that has gone strange does not take a read down', () => {
  const orders = setup('bad-files');
  const order = orders.createOrder({ userId: 'u1', batchId: 'b1', retentionDays: 5 }, ONE_ITEM);
  const [item] = orders.listOrderItems(order.id);

  const { getDb } = require('../dist/database/sqlite');
  const write = (value) =>
    getDb().prepare('UPDATE order_items SET files = ? WHERE id = ?').run(value, item.id);

  write('not json at all');
  assert.deepEqual(orders.listOrderItems(order.id)[0].files, []);

  write('{"kind":"resume-pdf"}');
  assert.deepEqual(orders.listOrderItems(order.id)[0].files, [], 'an object is not a list of files');

  // One good entry among the rubbish survives; the rubbish does not.
  write('[{"kind":"resume-pdf","path":"a/b.pdf"},{"kind":"virus","path":"x"},{"path":"no kind"},7]');
  assert.deepEqual(orders.listOrderItems(order.id)[0].files, [
    { kind: 'resume-pdf', path: 'a/b.pdf' },
  ]);
});

test('orders are listed newest first, and only the caller\'s own', () => {
  const orders = setup('listing');
  const first = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, new Date('2026-09-20T09:00:00Z'));
  const second = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, new Date('2026-09-21T09:00:00Z'));
  orders.createOrder({ userId: 'u2', retentionDays: 5 }, ONE_ITEM, new Date('2026-09-22T09:00:00Z'));

  assert.deepEqual(
    orders.listOrdersForUser('u1').map((order) => order.id),
    [second.id, first.id]
  );
  assert.equal(orders.listOrdersForUser('u3').length, 0);
});

test('a database that existed before the order items recorded their choice gets the three columns, and old items read null', () => {
  // Contract 2.7: resume_label, profile_label and match_json are in SCHEMA and in ADDED_COLUMNS (not the frozen
  // guard list). A fresh database has them from SCHEMA, so the test makes the old shape: it drops the three
  // columns (as upgradeGuard.test.js does for provider_id), opens the database again, and asks for them.
  const orders = setup('old-items');
  const old = orders.createOrder({ userId: 'u1', retentionDays: 5 }, ONE_ITEM, new Date('2026-09-20T09:00:00Z'));
  const sqlite = require('../dist/database/sqlite');
  const db = sqlite.getDb();
  for (const column of ['resume_label', 'profile_label', 'match_json']) {
    db.exec(`ALTER TABLE order_items DROP COLUMN ${column}`);
  }
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('order_items') WHERE name IN ('resume_label', 'profile_label', 'match_json')").all(),
    [],
    'the old shape has none of them'
  );
  db.close();

  const reopenedSqlite = loadFresh('../dist/database/sqlite');
  const reopened = loadFresh('../dist/database/orderRepository');
  const columns = reopenedSqlite
    .getDb()
    .prepare("SELECT name FROM pragma_table_info('order_items') WHERE name IN ('resume_label', 'profile_label', 'match_json') ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, ['match_json', 'profile_label', 'resume_label'], 'opening the database added them');

  const [item] = reopened.listOrderItems(old.id);
  assert.equal(item.resumeLabel, null);
  assert.equal(item.profileLabel, null);
  assert.equal(item.match, null);

  // And a new order, with its choice recorded, inserts and reads back whole.
  const match = { v: 1, mode: 'partial', reason: 'matched', candidates: 3 };
  const fresh = reopened.createOrder(
    { userId: 'u1', retentionDays: 5 },
    [{ ...ONE_ITEM[0], resumeLabel: 'Backend Engineer', profileLabel: 'Ada', match }],
    new Date('2026-09-20T10:00:00Z')
  );
  const [recorded] = reopened.listOrderItems(fresh.id);
  assert.equal(recorded.resumeLabel, 'Backend Engineer');
  assert.equal(recorded.profileLabel, 'Ada');
  assert.deepEqual(recorded.match, match);
});


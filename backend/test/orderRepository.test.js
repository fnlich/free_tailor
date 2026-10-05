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

const ONE_ITEM = [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' }];

function itemsFor(count) {
  return Array.from({ length: count }, (_, seq) => ({
    seq,
    profileId: 'p1',
    profileName: 'Ada',
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

test('a database from before run kinds keeps its orders as orders, and gains the column and the index', () => {
  // The orders and order_items tables as the build before them wrote them:
  // no `kind` (Generate Immediately runs) and no `cost_milli` (refund
  // requests). Both are ADDED columns, and the index naming `kind` has to wait
  // for it - in SCHEMA it would fail every upgraded boot while every fresh one
  // passed, so only a database made the old way can catch it moving there.
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const { dbDir } = useTempStorage(`order-repo-upgrade-${Math.random().toString(36).slice(2)}`);
  const raw = new Database(path.join(dbDir, 'free_tailor.db'));
  raw.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, batch_id TEXT,
      label TEXT NOT NULL DEFAULT '', total INTEGER NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
      expires_at TEXT NOT NULL, purged_at TEXT
    );
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, seq INTEGER NOT NULL, task_id TEXT,
      profile_id TEXT NOT NULL DEFAULT '', profile_name TEXT NOT NULL DEFAULT '',
      company_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
      source_row_number INTEGER, state TEXT NOT NULL, error TEXT,
      files TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO orders (id, number, user_id, batch_id, label, total, state, created_at, updated_at, finished_at, expires_at)
      VALUES ('ord_old', 'FT-20260901-0001', 'u1', 'bat_old', 'Sheet', 1, 'done',
              '2026-09-01T09:00:00.000Z', '2026-09-01T09:05:00.000Z', '2026-09-01T09:05:00.000Z', '2026-09-06T09:00:00.000Z');
    INSERT INTO order_items (id, order_id, seq, profile_name, company_name, state, created_at, updated_at)
      VALUES ('itm_old', 'ord_old', 0, 'Ada', 'Acme', 'done', '2026-09-01T09:00:00.000Z', '2026-09-01T09:05:00.000Z');
  `);
  raw.close();

  const { getDb } = loadFresh('../dist/database/sqlite');
  const orders = loadFresh('../dist/database/orderRepository');
  const db = getDb();

  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  assert.ok(columns('orders').includes('kind'));
  assert.ok(columns('order_items').includes('cost_milli'));
  const indexes = db.prepare('PRAGMA index_list(orders)').all().map((index) => index.name);
  assert.ok(indexes.includes('idx_orders_immediate_unpurged'), indexes.join(', '));

  // The old row is an order, listed as one; its resume's charge is unknown, not $0.
  assert.deepEqual(
    orders.listOrdersForUser('u1').map((order) => `${order.number}:${order.kind}`),
    ['FT-20260901-0001:order']
  );
  assert.equal(orders.listOrderItems('ord_old')[0].costMilli, null);

  // And both kinds can be written on it: every run writes an orders row now.
  const run = orders.createOrder({ userId: 'u1', retentionDays: 5, kind: 'immediate' }, ONE_ITEM);
  assert.match(run.number, /^FT-RUN-\d{8}-\d{4}$/);
  const placed = orders.createOrder({ userId: 'u1', retentionDays: 5 }, [{ ...ONE_ITEM[0], costMilli: 23 }]);
  assert.deepEqual(
    orders.listOrdersForUser('u1').map((order) => order.id),
    [placed.id, 'ord_old'],
    'the immediate run is hidden from the list'
  );
  assert.equal(orders.listOrderItems(placed.id)[0].costMilli, 23);
});

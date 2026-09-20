const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const { loadFresh, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * Deleting ordered resumes once their five days are up.
 *
 * Two things have to be true at once, and they pull in opposite directions: the
 * FILES must be gone, and the ORDER must not be. Somebody who ordered three
 * hundred resumes and comes back on the sixth day is owed an explanation, not
 * an empty page that looks like the order never happened.
 *
 * The third claim is about the directory pruning, and it is the one with teeth:
 * emptiness is the test, never ownership, so a folder still holding somebody
 * else's file survives. That is what makes the sweep safe when two accounts'
 * folder names collide.
 */

function setup(name) {
  const { rootDir, dbDir } = useTempStorage(`order-retention-${name}-${Math.random().toString(36).slice(2)}`);
  const outputBaseDir = path.join(rootDir, 'generated');
  fs.mkdirSync(outputBaseDir, { recursive: true });
  // Before anything reads settings: the settings module caches what it first sees.
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ outputBaseDir }));

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const orders = loadFresh('../dist/database/orderRepository');
  loadFresh('../dist/config/aiModelConfig');
  const retention = loadFresh('../dist/services/orders/retention');

  return { outputBaseDir, users, orders, retention };
}

function write(baseDir, relative, contents) {
  const absolute = path.join(baseDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  return absolute;
}

const ALICE_RESUME = 'alice@example.com/2026-09-14/ada/acme/Ada.pdf';
const ALICE_LETTER = 'alice@example.com/2026-09-14/ada/acme/Ada_cover_letter.pdf';

function seedExpiredOrder(context, { relatives = [ALICE_RESUME, ALICE_LETTER] } = {}) {
  const order = context.orders.createOrder(
    { userId: 'u1', batchId: 'bat_old', label: 'Sheets import', retentionDays: 5 },
    [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' }]
  );

  const kinds = ['resume-pdf', 'cover-letter-pdf'];
  for (const [index, relative] of relatives.entries()) {
    write(context.outputBaseDir, relative, `BYTES ${index}`);
  }
  context.orders.recordItemOutcome('bat_old', 0, {
    state: 'done',
    files: relatives.map((relative, index) => ({ kind: kinds[index], path: relative })),
  });
  context.orders.settleOrderIfFinished(order.id);
  context.orders.setOrderExpiryForTests(order.id, '2026-09-19T00:00:00.000Z');
  return order;
}

const AFTER = '2026-09-20T00:00:00.000Z';

test('an expired order loses its files and keeps its history', async () => {
  const context = setup('basic');
  const order = seedExpiredOrder(context);

  assert.ok(fs.existsSync(path.join(context.outputBaseDir, ...ALICE_RESUME.split('/'))));

  const report = await context.retention.purgeExpiredOrders(AFTER);
  assert.deepEqual(report, { orders: 1, filesRemoved: 2, filesMissing: 0 });

  assert.equal(fs.existsSync(path.join(context.outputBaseDir, ...ALICE_RESUME.split('/'))), false);
  assert.equal(fs.existsSync(path.join(context.outputBaseDir, ...ALICE_LETTER.split('/'))), false);

  // The record survives, and says what it built and that it is gone.
  const after = context.orders.getOrder(order.id);
  assert.equal(after.state, 'expired');
  assert.ok(after.purgedAt);

  const [item] = context.orders.listOrderItems(order.id);
  assert.equal(item.state, 'done', 'the resume was still built; only the bytes went');
  assert.equal(item.files.length, 2, 'what it produced is still listed');
  assert.ok(item.files.every((file) => file.removedAt));
});

test('a second sweep changes nothing', async () => {
  const context = setup('idempotent');
  seedExpiredOrder(context);

  await context.retention.purgeExpiredOrders(AFTER);
  const second = await context.retention.purgeExpiredOrders(AFTER);
  assert.deepEqual(second, { orders: 0, filesRemoved: 0, filesMissing: 0 });
});

test('an order still inside its window is left alone', async () => {
  const context = setup('unexpired');
  const order = context.orders.createOrder(
    { userId: 'u1', batchId: 'bat_new', retentionDays: 5 },
    [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' }]
  );
  write(context.outputBaseDir, ALICE_RESUME, 'STILL HERE');
  context.orders.recordItemOutcome('bat_new', 0, {
    state: 'done',
    files: [{ kind: 'resume-pdf', path: ALICE_RESUME }],
  });

  const report = await context.retention.purgeExpiredOrders(AFTER);
  assert.equal(report.orders, 0);
  assert.equal(fs.existsSync(path.join(context.outputBaseDir, ...ALICE_RESUME.split('/'))), true);
  assert.equal(context.orders.getOrder(order.id).state, 'running');
});

test('emptied directories are pruned, and the base directory never is', async () => {
  const context = setup('prune');
  seedExpiredOrder(context);

  await context.retention.purgeExpiredOrders(AFTER);

  // The whole branch goes, up to but not including the output root.
  assert.equal(fs.existsSync(path.join(context.outputBaseDir, 'alice@example.com')), false);
  assert.equal(fs.existsSync(context.outputBaseDir), true);
});

test('a directory holding somebody else\'s file survives the prune', async () => {
  const context = setup('shared-dir');
  seedExpiredOrder(context);

  // Same folder, a file this order knows nothing about - which is exactly the
  // shape of two accounts whose folder names collided.
  const stranger = write(
    context.outputBaseDir,
    'alice@example.com/2026-09-14/ada/acme/Someone_Else.pdf',
    'NOT MINE'
  );

  await context.retention.purgeExpiredOrders(AFTER);

  assert.equal(fs.existsSync(stranger), true, 'emptiness is the test, not ownership');
  assert.equal(
    fs.existsSync(path.join(context.outputBaseDir, 'alice@example.com', '2026-09-14')),
    true
  );
});

test('a file that is already gone is counted, not treated as a failure', async () => {
  const context = setup('missing');
  const order = seedExpiredOrder(context);
  fs.rmSync(path.join(context.outputBaseDir, ...ALICE_RESUME.split('/')));

  const report = await context.retention.purgeExpiredOrders(AFTER);
  assert.equal(report.orders, 1);
  assert.equal(report.filesRemoved, 1);
  assert.equal(report.filesMissing, 1);
  assert.equal(context.orders.getOrder(order.id).state, 'expired');
});

test('a backlog larger than one page is cleared by a single sweep', async () => {
  const context = setup('backlog');
  // Above the 200-order page size, so a sweep that took one page and stopped
  // would leave the rest sitting on disk until six hours later - and an install
  // that was off for a fortnight comes back with exactly this shape.
  const total = 205;
  for (let index = 0; index < total; index += 1) {
    const batchId = `bat_backlog_${index}`;
    const order = context.orders.createOrder(
      { userId: 'u1', batchId, retentionDays: 5 },
      [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: `Co${index}`, role: 'SWE' }]
    );
    const relative = `alice@example.com/2026-09-14/ada/co${index}/Ada.pdf`;
    write(context.outputBaseDir, relative, 'BYTES');
    context.orders.recordItemOutcome(batchId, 0, {
      state: 'done',
      files: [{ kind: 'resume-pdf', path: relative }],
    });
    context.orders.setOrderExpiryForTests(order.id, '2026-09-19T00:00:00.000Z');
  }

  const report = await context.retention.purgeExpiredOrders(AFTER);
  assert.equal(report.orders, total);
  assert.equal(report.filesRemoved, total);
  assert.equal(context.orders.listExpiredOrders(AFTER).length, 0, 'nothing left for the next sweep');
});

test('the retention window is read from the environment, and a bad one falls back', () => {
  const context = setup('window');
  const original = process.env.ORDER_RETENTION_DAYS;
  try {
    delete process.env.ORDER_RETENTION_DAYS;
    assert.equal(context.retention.orderRetentionDays(), 5);

    process.env.ORDER_RETENTION_DAYS = '1';
    assert.equal(context.retention.orderRetentionDays(), 1);

    // Zero is legal and means "on the next sweep", which is how the whole path
    // gets exercised without waiting five days.
    process.env.ORDER_RETENTION_DAYS = '0';
    assert.equal(context.retention.orderRetentionDays(), 0);

    process.env.ORDER_RETENTION_DAYS = 'soon';
    assert.equal(context.retention.orderRetentionDays(), 5);

    process.env.ORDER_RETENTION_DAYS = '-3';
    assert.equal(context.retention.orderRetentionDays(), 5);
  } finally {
    if (original === undefined) delete process.env.ORDER_RETENTION_DAYS;
    else process.env.ORDER_RETENTION_DAYS = original;
  }
});

test('a zero-day order expires immediately, which is what the setting promises', async () => {
  const context = setup('zero-days');
  const order = context.orders.createOrder(
    { userId: 'u1', batchId: 'bat_zero', retentionDays: 0 },
    [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' }],
    new Date('2026-09-20T00:00:00.000Z')
  );
  write(context.outputBaseDir, ALICE_RESUME, 'GOING');
  context.orders.recordItemOutcome('bat_zero', 0, {
    state: 'done',
    files: [{ kind: 'resume-pdf', path: ALICE_RESUME }],
  });

  const report = await context.retention.purgeExpiredOrders('2026-09-20T00:00:01.000Z');
  assert.equal(report.orders, 1);
  assert.equal(context.orders.getOrder(order.id).state, 'expired');
});

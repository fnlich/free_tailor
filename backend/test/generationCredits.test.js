const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Credits through the REAL queue, end to end.
 *
 * The unit tests prove the primitives. These prove the wiring: that the hook is
 * reached from both of the queue's terminal paths, that a batch which succeeds
 * keeps its credits and one which fails gives them back, and that the invariant
 * - credits spent equals resumes delivered - survives a mixture of the two.
 *
 * The runner is a stub that resolves or rejects on command, so the timing is
 * driven by hand rather than by how fast the machine is.
 */

let harnessSeq = 0;

async function harness(name) {
  useTempStorage(`generation-credits-${name}`);
  useAdminEmails('admin@example.com');

  // Real registered browsers, the way the app gets its capacity. There is no
  // test seam for this on purpose - the dispatcher reads the same settings row
  // the admin page writes, so a harness that faked it would be proving
  // something about the fake.
  const config = loadFresh('../dist/config/aiModelConfig');
  await config.updateAppSettings({
    browserChatEndpoints: [{ siteId: 'claude-web', port: 9931 }],
  });

  const users = loadFresh('../dist/database/userRepository');
  const credits = loadFresh('../dist/services/credits');
  const queueModule = loadFresh('../dist/services/queue/index');
  const { registerTaskRunner } = require('../dist/services/queue/taskQueue');

  queueModule.resetGenerationQueueForTests();

  const kind = `credit-test-${(harnessSeq += 1)}`;
  const pending = new Map();
  registerTaskRunner(kind, (payload, assignment) => {
    return new Promise((resolve, reject) => {
      pending.set(payload.label, { resolve, reject });
      assignment.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  const queue = queueModule.getGenerationQueue();

  return {
    /** Proof the stub runner was actually reached, so nothing passes by stalling. */
    started: () => pending.size,
    users,
    credits,
    queue,
    admin,
    alice,
    kind,
    balance: (id) => users.getUserById(id).credits,
    task: (label) => ({
      queue: 'browser',
      label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
      kind,
      payload: { label },
    }),
    finish: (label, value = 'ok') => {
      pending.get(label)?.resolve(value);
      pending.delete(label);
    },
    fail: (label, message = 'no') => {
      pending.get(label)?.reject(new Error(message));
      pending.delete(label);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Polls until `condition` holds, so timing never depends on machine speed. */
async function until(condition, what, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

test('a batch where every resume lands keeps every credit', async () => {
  const h = await harness('all-succeed');
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 3, { kind: 'batch', id: batchId });
  assert.equal(h.balance(h.alice.id), 7, 'charged up front');

  h.queue.submit([h.task('a'), h.task('b'), h.task('c')], { id: batchId });
  await h.queue.refreshCapacity();
  await until(() => h.started() > 0, 'the first task to reach the runner');

  for (const label of ['a', 'b', 'c']) {
    await until(() => h.started() > 0, `task ${label} to start`);
    h.finish(label);
    await settle();
  }

  const snapshot = h.queue.snapshot(batchId);
  assert.equal(snapshot.completed, 3, 'all three really ran');

  // Three resumes, three credits. The reservation closes without refunding,
  // and the balance does NOT bounce back.
  assert.equal(h.balance(h.alice.id), 7);
  assert.equal(h.credits.getReservation(batchId).state, 'closed');
  assert.equal(h.credits.getStatus(h.users.getUserById(h.alice.id)).held, 0);
});

test('a resume that fails gives its credit back', async () => {
  const h = await harness('one-fails');
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 3, { kind: 'batch', id: batchId });
  h.queue.submit([h.task('a'), h.task('b'), h.task('c')], { id: batchId });
  await h.queue.refreshCapacity();

  await until(() => h.started() > 0, 'task a to start');
  h.finish('a');
  await until(() => h.started() > 0, 'task b to start');
  h.fail('b', 'the browser was signed out');
  await until(() => h.started() > 0, 'task c to start');
  h.finish('c');
  await settle();

  const snapshot = h.queue.snapshot(batchId);
  assert.equal(snapshot.completed, 2);
  assert.equal(snapshot.failed, 1);

  // Two delivered, one did not: 10 - 3 + 1.
  assert.equal(h.balance(h.alice.id), 8);
  const refunds = h.credits.getLedger(h.alice.id).filter((e) => e.reason === 'generation-refund');
  assert.equal(refunds.length, 1);
  assert.match(refunds[0].note, /failed/);
});

test('cancelling a batch refunds every resume that had not started', async () => {
  const h = await harness('cancelled');
  h.credits.setBalance(h.alice.id, 20, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 5, { kind: 'batch', id: batchId });
  h.queue.submit(
    ['a', 'b', 'c', 'd', 'e'].map((label) => h.task(label)),
    { id: batchId }
  );
  await h.queue.refreshCapacity();
  await until(() => h.started() > 0, 'task a to start');

  h.finish('a');
  await until(() => h.started() > 0, 'task b to start');

  // One delivered, one running, three still queued. THIS is the case the
  // single-funnel change exists for: cancel() flips queued tasks inline and
  // never goes through settle(), so a hook wired only to settle() would lose
  // all three of those refunds.
  h.queue.cancel(batchId);
  await settle();

  const balance = h.balance(h.alice.id);
  assert.equal(balance, 19, 'only the delivered resume kept its credit');

  const sum = h.credits
    .getLedger(h.alice.id, 500)
    .reduce((total, entry) => total + entry.delta, 0);
  assert.equal(balance, sum, 'and the ledger still explains the balance');
});

test('an admin runs the same batch and is charged nothing', async () => {
  const h = await harness('admin-exempt');
  h.credits.setBalance(h.admin.id, 4, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  const reservation = h.credits.reserveCredits(h.users.getUserById(h.admin.id), 3, {
    kind: 'batch',
    id: batchId,
  });
  assert.equal(reservation.exempt, true);

  h.queue.submit([h.task('a'), h.task('b'), h.task('c')], { id: batchId });
  await h.queue.refreshCapacity();
  await until(() => h.started() > 0, 'task a to start');
  h.finish('a');
  await until(() => h.started() > 0, 'task b to start');
  h.fail('b');
  await settle();
  h.queue.cancel(batchId);
  await settle();

  // Neither the charge nor the refunds touched anything: there is no
  // reservation row for the hook to find.
  assert.equal(h.balance(h.admin.id), 4);
  assert.equal(h.credits.getLedger(h.admin.id).filter((e) => e.reason.startsWith('generation')).length, 0);
});

test('a repeated hook cannot refund the same resume twice', async () => {
  const h = await harness('double-hook');
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 2, { kind: 'batch', id: batchId });
  const batch = h.queue.submit([h.task('a'), h.task('b')], { id: batchId });
  await h.queue.refreshCapacity();
  await until(() => h.started() > 0, 'task a to start');

  h.fail('a');
  await settle();
  const afterFirst = h.balance(h.alice.id);

  // Exactly what a restart or a re-settle would do: the same task id refunding
  // a second time. The idempotency key makes it free.
  h.credits.refundTaskUnit(batchId, batch.tasks[0].id, 'replayed');
  assert.equal(h.balance(h.alice.id), afterFirst);
});

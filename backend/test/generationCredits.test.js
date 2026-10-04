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

async function harness(name, { attempts = 1 } = {}) {
  useTempStorage(`generation-credits-${name}`);
  /*
   * ONE attempt unless a test says otherwise.
   *
   * These tests drive failures by hand to check the credit arithmetic, so a
   * queue that silently retried would change what "h.fail('b')" means halfway
   * through each of them. The retry behaviour has its own test below, at the
   * real default, where the arithmetic under retry is the point.
   */
  process.env.GENERATION_MAX_ATTEMPTS = String(attempts);
  useAdminEmails('admin@example.com');

  // One Claude seat slot, sized the way the app sizes it: from the variable the
  // dispatcher reads on every capacity reading. There is no test seam for this
  // on purpose - a harness that faked the reading would be proving something
  // about the fake. ONE matters: several cases below count on exactly one task
  // running while the rest wait.
  process.env.AI_CLI_CONCURRENCY = '1';

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
      queue: 'cli',
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
  h.fail('b', 'the seat was signed out');
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
  h.credits.refundTaskUnit(batchId, batch.tasks[0].id, 1, 'replayed');
  assert.equal(h.balance(h.alice.id), afterFirst);
});

/**
 * The retry, and the one thing it must not do: charge twice.
 *
 * A credit is reserved per resume up front and refunded per resume that did not
 * deliver. That makes the retry's placement the whole of its correctness - it
 * happens BEFORE a task reaches a terminal state, so the refund hook never
 * fires for an attempt that is going to be tried again. These assert that from
 * the balance rather than from the code's shape.
 */

test('a resume that fails and then succeeds costs exactly one credit', async () => {
  const h = await harness('retry-succeeds', { attempts: 3 });
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 1, { kind: 'batch', id: batchId });
  h.queue.submit([h.task('a')], { id: batchId });
  await h.queue.refreshCapacity();

  await until(() => h.started() > 0, 'the first attempt');
  h.fail('a', 'the seat was signed out');
  await until(() => h.started() > 0, 'the second attempt');
  h.fail('a', 'signed out again');
  await until(() => h.started() > 0, 'the third attempt');
  h.finish('a');
  await settle();

  const snapshot = h.queue.snapshot(batchId);
  assert.equal(snapshot.completed, 1, 'it delivered in the end');
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.tasks[0].attempts, 3, 'and the snapshot says how many goes it took');

  // 10 - 1, and nothing given back: the resume was delivered.
  assert.equal(h.balance(h.alice.id), 9);
  const refunds = h.credits.getLedger(h.alice.id).filter((e) => e.reason === 'generation-refund');
  assert.equal(refunds.length, 0, 'a retried attempt is not a failed unit');
});

test('a resume that fails every attempt is refunded once, not once per attempt', async () => {
  const h = await harness('retry-exhausted', { attempts: 3 });
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 1, { kind: 'batch', id: batchId });
  h.queue.submit([h.task('a')], { id: batchId });
  await h.queue.refreshCapacity();

  for (const go of [1, 2, 3]) {
    await until(() => h.started() > 0, `attempt ${go}`);
    h.fail('a', `attempt ${go} failed`);
  }
  await settle();

  const snapshot = h.queue.snapshot(batchId);
  assert.equal(snapshot.failed, 1, 'three goes, one failed resume');

  // Back to where it started: charged once, refunded once.
  assert.equal(h.balance(h.alice.id), 10);
  const refunds = h.credits.getLedger(h.alice.id).filter((e) => e.reason === 'generation-refund');
  assert.equal(refunds.length, 1, 'three attempts must not mean three refunds');
});

test('retrying can be switched off, and then one failure is final', async () => {
  const h = await harness('retry-disabled', { attempts: 1 });
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = require('../dist/services/queue/taskQueue').newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 1, { kind: 'batch', id: batchId });
  h.queue.submit([h.task('a')], { id: batchId });
  await h.queue.refreshCapacity();

  await until(() => h.started() > 0, 'the only attempt');
  h.fail('a', 'no second chance');
  await settle();

  assert.equal(h.queue.snapshot(batchId).failed, 1);
  assert.equal(h.balance(h.alice.id), 10);
});

test('a resume whose profile was deleted fails once, in its owner\'s terms, and is refunded', async () => {
  // The owner deleted it while the task was queued. No retry can find it, and
  // "contact your administrator" would send them to someone with nothing to fix.
  const h = await harness('profile-gone', { attempts: 3 });
  const { makeResumeRunner } = require('../dist/services/queue/resumeTask');
  const { registerTaskRunner, newBatchId } = require('../dist/services/queue/taskQueue');
  const { publicStoredError } = require('../dist/middleware/publicError');
  const { captureErrorLog } = require('./helpers');
  let lookups = 0;
  const kind = `${h.kind}-profile-gone`;
  registerTaskRunner(
    kind,
    makeResumeRunner(
      () => [{ companyName: 'Acme', role: 'SWE', jobDescription: 'x' }],
      () => {
        lookups += 1;
        return null;
      }
    )
  );
  h.credits.setBalance(h.alice.id, 10, h.admin.id);

  const batchId = newBatchId();
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 2, { kind: 'batch', id: batchId });
  const { lines } = await captureErrorLog(async () => {
    h.queue.submit(
      [{ ...h.task('gone'), kind, payload: { profileId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', batchId, jobIndex: 0, creditCost: 2 } }],
      { id: batchId }
    );
    await h.queue.refreshCapacity();
    await until(() => h.queue.snapshot(batchId).failed === 1, 'the task to fail');
  });

  const task = h.queue.snapshot(batchId).tasks[0];
  assert.equal(lookups, 1, 'not retried: no later attempt would find the profile');
  assert.match(task.error, /^The profile for this resume was deleted before it could be built\. \(Ref: ERR-[0-9A-F]{6}\)$/);
  assert.doesNotMatch(task.error, /7c9e6679|administrator/);
  // Kept as written when an account holder reads it back...
  assert.equal(publicStoredError(task.error, 'This resume could not be built'), task.error);
  // ...and the id is in the log, under the same ref, for whoever looks it up.
  const ref = /ERR-[0-9A-F]{6}/.exec(task.error)[0];
  assert.ok(lines.some((line) => line.includes(ref) && line.includes('7c9e6679')), lines.join('\n'));
  assert.equal(h.balance(h.alice.id), 10, 'its price came back');
});

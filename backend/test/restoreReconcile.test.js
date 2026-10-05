const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * A restart in the middle of a long run: the queue's restore and the credit
 * reconciler, in the order index.ts runs them.
 *
 * The reconciler releases any reservation older than six hours as abandoned.
 * Age alone cannot tell an abandoned run from an order that was six hours in
 * when the process stopped - and releasing that one handed its whole charge
 * back, then built the rest of its resumes for free. The restore now says
 * which batches it brought back, and the reconciler leaves those alone.
 */

const SEVEN_HOURS = 7 * 60 * 60_000;

function setup(name) {
  useTempStorage(name);
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const credits = loadFresh('../dist/services/credits');
  const creditRepo = loadFresh('../dist/database/creditRepository');
  const store = loadFresh('../dist/database/generationRepository');
  const orders = loadFresh('../dist/database/orderRepository');
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  const { reconcileCredits } = loadFresh('../dist/services/credits/reconcile');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 20, admin.id);
  const balance = () => users.getUserById(alice.id).credits;
  return { users, credits, creditRepo, store, orders, queueModule, reconcileCredits, alice, balance };
}

function taskRow(batchId, seq, state, creditCost = 2) {
  return {
    id: `tsk_${batchId}_${seq}`,
    batchId,
    seq,
    state,
    data: {
      queue: 'cli',
      label: { profileId: 'p1', profileName: 'Ada', companyName: `Co ${seq}`, role: 'SWE' },
      kind: 'resume',
      payload: { batchId, profileId: 'p1', jobIndex: 0, creditCost, choice: { provider: 'claude-cli', modelName: 'sonnet' } },
    },
  };
}

function batchRow(id, shared = {}) {
  return {
    id,
    state: 'running',
    data: {
      label: 'An order from before the restart',
      jobCount: 1,
      shared: { jobs: [{ companyName: 'Acme', role: 'SWE', jobDescription: '' }], ownerId: 'someone', ...shared },
      createdAt: Date.now(),
    },
  };
}

async function until(check, what) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a run the restore brought back keeps its reservation; an abandoned one is still released', async () => {
  const h = setup('restore-reconcile-live');
  // Three resumes at 2 credits: one built before the stop, two still to build.
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 6, { kind: 'batch', id: 'bat_long' });
  // And a run whose batch rows are gone - genuinely abandoned.
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 3, { kind: 'batch', id: 'bat_gone' });
  assert.equal(h.balance(), 11);
  h.store.saveBatchWithTasks(batchRow('bat_long'), [
    taskRow('bat_long', 0, 'done'),
    taskRow('bat_long', 1, 'running'),
    taskRow('bat_long', 2, 'queued'),
  ]);

  // Held until the test lets go, so the reconciler runs while the run is live.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = h.queueModule.getGenerationQueue();
  h.queueModule.registerTaskRunner(h.queueModule.RESUME_TASK_KIND, async () => {
    await gate;
    return {};
  });

  const restored = await h.queueModule.restoreGenerationQueue();
  assert.deepEqual(restored.batchIds, ['bat_long']);

  // Seven hours on, as a long order's restart would be.
  const report = h.reconcileCredits(Date.now() + SEVEN_HOURS, { liveBatchIds: restored.batchIds });
  assert.equal(report.released, 1, 'only the abandoned one');
  assert.equal(report.credits, 3);
  assert.equal(h.creditRepo.getReservation('bat_long').state, 'open', 'the live run keeps what it was charged');
  assert.equal(h.balance(), 14);

  // The run finishes and closes its own reservation: all three delivered, so
  // all six credits stay spent - none of it was built free.
  release();
  await until(() => queue.snapshot('bat_long')?.state === 'done', 'the restored run to finish');
  await until(() => h.creditRepo.getReservation('bat_long').state === 'closed', 'the run to settle');
  assert.equal(h.balance(), 14);
});

test('without being told, the reconciler would have released the live run - the bug this closes', async () => {
  const h = setup('restore-reconcile-unguarded');
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 4, { kind: 'batch', id: 'bat_long' });
  h.store.saveBatchWithTasks(batchRow('bat_long'), [taskRow('bat_long', 0, 'queued'), taskRow('bat_long', 1, 'queued')]);
  h.queueModule.getGenerationQueue();
  h.queueModule.registerTaskRunner(h.queueModule.RESUME_TASK_KIND, () => new Promise(() => {}));
  await h.queueModule.restoreGenerationQueue();
  assert.equal(h.reconcileCredits(Date.now() + SEVEN_HOURS).credits, 4);
});

test('a run that had finished, but not settled, when the process stopped is settled by the restore', async () => {
  const h = setup('restore-reconcile-finished');
  h.credits.reserveCredits(h.users.getUserById(h.alice.id), 6, { kind: 'batch', id: 'bat_done' });
  h.store.saveBatchWithTasks(batchRow('bat_done'), [
    taskRow('bat_done', 0, 'done'),
    taskRow('bat_done', 1, 'done'),
    // Failed, and the process stopped before its refund was written.
    { ...taskRow('bat_done', 2, 'failed'), data: { ...taskRow('bat_done', 2, 'failed').data, error: 'x' } },
  ]);
  h.queueModule.getGenerationQueue();

  const restored = await h.queueModule.restoreGenerationQueue();
  assert.deepEqual(restored.batchIds, ['bat_done']);
  assert.equal(h.creditRepo.getReservation('bat_done').state, 'closed');
  assert.equal(h.balance(), 16, 'the failed one came back, the two built stay spent');

  // Settled, so the reconciler has nothing to hand back - with or without the list.
  assert.equal(h.reconcileCredits(Date.now() + SEVEN_HOURS).released, 0);
  assert.equal(h.balance(), 16);

  // And restoring the same rows again refunds nothing twice.
  h.queueModule.resetGenerationQueueForTests();
  h.store.saveBatchWithTasks(batchRow('bat_done'), [
    taskRow('bat_done', 0, 'done'),
    taskRow('bat_done', 1, 'done'),
    taskRow('bat_done', 2, 'failed'),
  ]);
  h.queueModule.getGenerationQueue();
  await h.queueModule.restoreGenerationQueue();
  assert.equal(h.balance(), 16);
});

test('an order queued before batches carried their kind is restored as an order', async () => {
  const h = setup('restore-order-kind');
  h.orders.createOrder({ userId: h.alice.id, batchId: 'bat_order', retentionDays: 5 }, [
    { seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Co 0', role: 'SWE' },
  ]);
  h.store.saveBatchWithTasks(batchRow('bat_order'), [taskRow('bat_order', 0, 'queued')]);
  h.store.saveBatchWithTasks(batchRow('bat_plain'), [taskRow('bat_plain', 0, 'queued')]);
  const queue = h.queueModule.getGenerationQueue();
  h.queueModule.registerTaskRunner(h.queueModule.RESUME_TASK_KIND, () => new Promise(() => {}));

  await h.queueModule.restoreGenerationQueue();
  assert.equal(queue.getBatch('bat_order').shared.kind, 'order');
  assert.equal(h.queueModule.isOrderBatch(queue.getBatch('bat_order')), true);
  assert.equal(queue.getBatch('bat_plain').shared.kind, undefined);
  assert.equal(h.queueModule.isOrderBatch(queue.getBatch('bat_plain')), false);

  // Written back, so the next restart reads it from the batch itself.
  const rows = loadFresh('../dist/database/generationRepository').loadBatchRows();
  assert.equal(rows.find((row) => row.id === 'bat_order').data.shared.kind, 'order');
});

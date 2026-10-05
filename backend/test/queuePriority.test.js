const assert = require('node:assert/strict');
const test = require('node:test');

const { TaskQueue, registerTaskRunner } = require('../dist/services/queue/taskQueue');

/**
 * On one seat, a Generate Immediately run goes before the orders waiting
 * there (owner's answer to "seat priority": immediate first).
 *
 * An order is three hundred resumes nobody is sitting in front of; an
 * immediate run is one person watching a progress bar. First come, first
 * served put that person behind the whole order, and "immediate" then meant an
 * hour. The queue knows only an `urgent` flag on the batch - the submit route
 * and the restore set it from the batch's kind - so that is what these drive.
 *
 * Driven by hand, like taskQueue.test.js: each task holds its slot until the
 * test releases it, so the order things start in is a fact, not a race.
 */

let harnessSeq = 0;

function harness({ slots = 1, maxAttempts = 1 } = {}) {
  const started = [];
  const pending = new Map();
  const kind = `priority-${(harnessSeq += 1)}`;
  const capacity = {
    cli: Array.from({ length: slots }, (_, index) => ({ id: `cli${index}`, queue: 'cli' })),
    codex: [{ id: 'codex0', queue: 'codex' }],
    gemini: [],
  };
  const queue = new TaskQueue(async () => capacity, undefined, undefined, maxAttempts);

  registerTaskRunner(kind, (payload, assignment) => {
    started.push(payload.label);
    return new Promise((resolve, reject) => {
      pending.set(payload.label, { resolve, reject });
      assignment.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });

  const tasks = (prefix, count, lane = 'cli') =>
    Array.from({ length: count }, (_, index) => ({
      queue: lane,
      label: { profileId: 'p', profileName: 'P', companyName: `${prefix}${index}`, role: '' },
      kind,
      payload: { label: `${prefix}${index}` },
    }));

  return {
    queue,
    started,
    tasks,
    finish(label) {
      pending.get(label)?.resolve({});
      pending.delete(label);
    },
    fail(label) {
      pending.get(label)?.reject(new Error('flaky'));
      pending.delete(label);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('an immediate run submitted after an order runs before the rest of the order', async () => {
  const h = harness({ slots: 1 });
  h.queue.submit(h.tasks('order', 4), { label: 'order' });
  await h.queue.refreshCapacity();
  await settle();
  assert.deepEqual(h.started, ['order0'], 'the order had the seat first');

  h.queue.submit(h.tasks('now', 2), { label: 'immediate', urgent: true });
  await settle();

  // The running order task is not interrupted - only the waiting line changes.
  for (const label of ['order0', 'now0', 'now1', 'order1', 'order2']) {
    h.finish(label);
    await settle();
  }
  assert.deepEqual(h.started, ['order0', 'now0', 'now1', 'order1', 'order2', 'order3']);
});

test('two immediate runs keep their own order between them', async () => {
  const h = harness({ slots: 1 });
  h.queue.submit(h.tasks('order', 2), {});
  await h.queue.refreshCapacity();
  await settle();
  h.queue.submit(h.tasks('a', 2), { urgent: true });
  h.queue.submit(h.tasks('b', 1), { urgent: true });
  await settle();

  for (const label of ['order0', 'a0', 'a1', 'b0']) {
    h.finish(label);
    await settle();
  }
  assert.deepEqual(h.started, ['order0', 'a0', 'a1', 'b0', 'order1'], 'first come, first served WITHIN the tier');
});

test('priority is per lane: an urgent Codex task does not jump the Claude lane', async () => {
  const h = harness({ slots: 1 });
  h.queue.submit(h.tasks('order', 2), {});
  await h.queue.refreshCapacity();
  await settle();
  h.queue.submit(h.tasks('codex', 1, 'codex'), { urgent: true });
  await settle();
  // The Codex task runs at once on its own seat; the Claude lane is untouched.
  assert.deepEqual(h.started, ['order0', 'codex0']);
  h.finish('order0');
  await settle();
  assert.deepEqual(h.started, ['order0', 'codex0', 'order1']);
});

test('a retried immediate task goes back ahead of the orders, a retried order task behind everything', async () => {
  const h = harness({ slots: 1, maxAttempts: 2 });
  h.queue.submit(h.tasks('now', 1), { urgent: true });
  await h.queue.refreshCapacity();
  await settle();
  h.queue.submit(h.tasks('order', 2), {});
  await settle();
  assert.deepEqual(h.started, ['now0']);

  // Its first attempt fails while two order tasks wait: the retry is still
  // urgent, so it goes in front of them, not to the tail of the lane.
  h.fail('now0');
  await settle();
  assert.deepEqual(h.started, ['now0', 'now0']);

  h.finish('now0');
  await settle();
  // An order task that fails goes to the very back, behind its own batch.
  h.fail('order0');
  await settle();
  h.finish('order1');
  await settle();
  h.finish('order0');
  await settle();
  assert.deepEqual(h.started, ['now0', 'now0', 'order0', 'order1', 'order0']);
});

test('a restored urgent batch waits ahead of a restored ordinary one', async () => {
  const h = harness({ slots: 1 });
  // An order restored first, then an immediate run: restore order is the
  // database's, so the tier has to come from the batch, not from arrival.
  const entries = (prefix, count) =>
    h.tasks(prefix, count).map((task, seq) => ({ ...task, id: `${prefix}-t${seq}`, seq, state: 'queued' }));
  h.queue.restore({ id: 'bat_order', label: 'o', jobCount: 2, shared: {}, createdAt: 1 }, entries('order', 2));
  h.queue.restore(
    { id: 'bat_now', label: 'n', jobCount: 1, shared: {}, createdAt: 2, urgent: true },
    entries('now', 1)
  );
  await h.queue.refreshCapacity();
  await settle();
  assert.deepEqual(h.started, ['now0']);
  h.finish('now0');
  await settle();
  assert.deepEqual(h.started, ['now0', 'order0']);
});

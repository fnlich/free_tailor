const assert = require('node:assert/strict');
const test = require('node:test');

const { TaskQueue, registerTaskRunner } = require('../dist/services/queue/taskQueue');

/**
 * The dispatcher: two queues, slots, and FIFO.
 *
 * A task is one resume. Ten tasks and three slots means three run and seven
 * wait, and the moment any slot frees it takes the next task in its lane. These
 * pin that, plus the ways it could be subtly wrong: a slot handed to two tasks,
 * one seat's lane taking the other's work, and a task on a lane nothing fills
 * sitting in the queue for ever.
 *
 * Timing is driven by hand - each task holds its slot until released - so these
 * are deterministic rather than passing on a fast machine and failing on a
 * loaded one.
 */

function cliSlots(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `cli${index}`, queue: 'cli' }));
}

function codexSlots(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `codex${index}`, queue: 'codex' }));
}

/**
 * A queue whose capacity is fixed, and a recorder for what ran where.
 *
 * Tasks name a registered RUNNER rather than carrying a closure, because a
 * closure cannot be written to a database and the queue is now persisted. The
 * harness registers one runner per harness instance, keyed on a unique kind, so
 * two tests in one process cannot resolve to each other's runner.
 */
let harnessSeq = 0;

function harness(capacity) {
  const started = [];
  const pending = new Map();
  const kind = `test-${(harnessSeq += 1)}`;
  const queue = new TaskQueue(async () => capacity);

  registerTaskRunner(kind, (payload, assignment) => {
    const label = payload.label;
    started.push({ label, on: assignment.queue });
    return new Promise((resolve, reject) => {
      pending.set(label, { resolve, reject });
      assignment.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
  });

  const task = (label, options = {}) => ({
    queue: options.queue ?? 'cli',
    label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
    kind,
    payload: { label },
  });

  return {
    queue,
    started,
    task,
    finish(label) {
      pending.get(label)?.resolve(`${label} done`);
      pending.delete(label);
    },
    get running() {
      return pending.size;
    },
  };
}

/** Lets every already-scheduled microtask and timer callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('ten tasks and three slots: three run, seven wait', async () => {
  const harnessed = harness({ cli: cliSlots(3), codex: [] });
  const tasks = Array.from({ length: 10 }, (_, index) => harnessed.task(`t${index}`));
  const batch = harnessed.queue.submit(tasks);
  await harnessed.queue.refreshCapacity();
  await settle();

  assert.equal(harnessed.started.length, 3, 'exactly one task per slot');
  assert.equal(harnessed.running, 3);
  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.running, 3);
  assert.equal(snapshot.queued, 7);
  assert.equal(snapshot.total, 10);
});

test('a slot that finishes takes the next task at once', async () => {
  // The property a chunked Promise.all does not have: freeing ONE slot starts
  // ONE task, rather than waiting for the rest of its wave.
  const harnessed = harness({ cli: cliSlots(3), codex: [] });
  harnessed.queue.submit(Array.from({ length: 10 }, (_, index) => harnessed.task(`t${index}`)));
  await harnessed.queue.refreshCapacity();
  await settle();
  assert.equal(harnessed.started.length, 3);

  harnessed.finish('t0');
  await settle();
  assert.equal(harnessed.started.length, 4, 'the fourth task started the moment a slot freed');
  assert.equal(harnessed.running, 3, 'and that slot is busy again, not idle');
});

test('every task finishes, and the queue drains to empty', async () => {
  const harnessed = harness({ cli: cliSlots(2), codex: [] });
  const batch = harnessed.queue.submit(
    Array.from({ length: 10 }, (_, index) => harnessed.task(`t${index}`))
  );
  await harnessed.queue.refreshCapacity();

  for (let done = 0; done < 10; done += 1) {
    await settle();
    harnessed.finish(`t${done}`);
  }
  await settle();

  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.completed, 10);
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.state, 'done');
  assert.equal(harnessed.started.length, 10);
});

test('dispatch order is submit order', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  harnessed.queue.submit(Array.from({ length: 5 }, (_, index) => harnessed.task(`t${index}`)));
  await harnessed.queue.refreshCapacity();

  for (let done = 0; done < 5; done += 1) {
    await settle();
    harnessed.finish(`t${done}`);
  }
  await settle();
  assert.deepEqual(
    harnessed.started.map((entry) => entry.label),
    ['t0', 't1', 't2', 't3', 't4']
  );
});

test("a second request's tasks go behind the first's", async () => {
  // "This request fills 10 tasks at the last of the queue." A batch submitted
  // while another is running waits its turn rather than interleaving.
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  harnessed.queue.submit([harnessed.task('a0'), harnessed.task('a1')]);
  await harnessed.queue.refreshCapacity();
  await settle();

  harnessed.queue.submit([harnessed.task('b0')]);
  await settle();
  assert.deepEqual(harnessed.started.map((entry) => entry.label), ['a0']);

  harnessed.finish('a0');
  await settle();
  harnessed.finish('a1');
  await settle();
  assert.deepEqual(harnessed.started.map((entry) => entry.label), ['a0', 'a1', 'b0']);
});

test('the Claude lane and the Codex lane drain independently', async () => {
  // Two seats, two queues, each at its own width. A seat with nothing free must
  // not hold up the other, and a wider seat is not throttled to the narrower.
  const harnessed = harness({ cli: cliSlots(1), codex: codexSlots(2) });
  harnessed.queue.submit([
    harnessed.task('cli-0'),
    harnessed.task('cli-1'),
    harnessed.task('codex-0', { queue: 'codex' }),
    harnessed.task('codex-1', { queue: 'codex' }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  const labels = harnessed.started.map((entry) => entry.label).sort();
  assert.deepEqual(labels, ['cli-0', 'codex-0', 'codex-1'], 'both queues started at their own width');
  const where = Object.fromEntries(harnessed.started.map((entry) => [entry.label, entry.on]));
  assert.equal(where['codex-0'], 'codex', 'and each task is told the lane it runs in');
  assert.equal(where['cli-0'], 'cli');
});

test('one failing task does not stop the batch', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  registerTaskRunner('always-fails', async () => {
    throw new Error('the model refused');
  });
  const failing = { ...harnessed.task('bad'), kind: 'always-fails' };
  const batch = harnessed.queue.submit([failing, harnessed.task('good')]);
  await harnessed.queue.refreshCapacity();
  await settle();
  harnessed.finish('good');
  await settle();

  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.state, 'done');
  assert.match(snapshot.tasks[0].error, /the model refused/);
});

test('a rejecting task raises no unhandled rejection', async () => {
  // There is no HTTP request left to absorb one, and Node's default policy is to
  // take the process down - so one failed resume would stop the server.
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const harnessed = harness({ cli: cliSlots(1), codex: [] });
    registerTaskRunner('boom', async () => {
      throw new Error('boom');
    });
    harnessed.queue.submit([{ ...harnessed.task('boom'), kind: 'boom' }]);
    await harnessed.queue.refreshCapacity();
    await settle();
    await settle();
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('cancel drops what is queued and aborts what is running', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  const batch = harnessed.queue.submit(
    Array.from({ length: 5 }, (_, index) => harnessed.task(`t${index}`))
  );
  await harnessed.queue.refreshCapacity();
  await settle();

  const outcome = harnessed.queue.cancel(batch.id);
  assert.equal(outcome.cancelled, 4, 'the queued four are dropped at once');
  assert.equal(outcome.aborted, 1, 'and the running one is asked to stop');
  await settle();

  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.state, 'cancelled');
  assert.equal(snapshot.queued, 0);
  assert.equal(harnessed.queue.cancel(batch.id), null, 'cancelling twice is a no-op, not a throw');
});

test('a cancelled batch frees its slots for the next one', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  const first = harnessed.queue.submit([harnessed.task('a0'), harnessed.task('a1')]);
  await harnessed.queue.refreshCapacity();
  await settle();

  harnessed.queue.submit([harnessed.task('b0')]);
  harnessed.queue.cancel(first.id);
  await settle();

  assert.ok(
    harnessed.started.some((entry) => entry.label === 'b0'),
    'the next batch starts as soon as the slot is back'
  );
});

test('a slot is never handed to two tasks at once', async () => {
  // The failure this class exists to prevent: a seat handed more calls than it
  // was sized for.
  const capacity = { cli: cliSlots(1), codex: [] };
  const inFlight = new Set();
  const queue = new TaskQueue(async () => capacity);
  const pending = [];
  registerTaskRunner('exclusive', async (payload) => {
    const label = payload.label;
    assert.equal(inFlight.size, 0, `${label} started while another task held the slot`);
    inFlight.add(label);
    await new Promise((resolve) => pending.push(resolve));
    inFlight.delete(label);
  });
  const make = (label) => ({
    queue: 'cli',
    label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
    kind: 'exclusive',
    payload: { label },
  });

  queue.submit([make('a'), make('b'), make('c')]);
  await queue.refreshCapacity();
  for (let index = 0; index < 3; index += 1) {
    await settle();
    pending.shift()?.();
  }
  await settle();
  assert.equal(inFlight.size, 0);
});

test('a finished batch is still readable, and listing shows only active ones', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  const batch = harnessed.queue.submit([harnessed.task('t0')]);
  await harnessed.queue.refreshCapacity();
  await settle();
  harnessed.finish('t0');
  await settle();

  assert.equal(harnessed.queue.snapshot(batch.id).state, 'done', 'readable after it ends');
  assert.deepEqual(harnessed.queue.listBatches(true), [], 'but not listed as active');
  assert.equal(harnessed.queue.listBatches(false).length, 1);
});

test('subscribers hear each task settle and then the batch finish', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  const batch = harnessed.queue.submit([harnessed.task('t0'), harnessed.task('t1')]);
  const events = [];
  harnessed.queue.subscribe(batch.id, (event) => events.push(event.type));
  await harnessed.queue.refreshCapacity();
  await settle();
  harnessed.finish('t0');
  await settle();
  harnessed.finish('t1');
  await settle();

  assert.ok(events.includes('task'));
  assert.equal(events.at(-1), 'done');
});

test('a throwing subscriber does not fail the task it was watching', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  const batch = harnessed.queue.submit([harnessed.task('t0')]);
  harnessed.queue.subscribe(batch.id, () => {
    throw new Error('a listener with a bug in it');
  });
  await harnessed.queue.refreshCapacity();
  await settle();
  harnessed.finish('t0');
  await settle();
  assert.equal(harnessed.queue.snapshot(batch.id).completed, 1);
});

/**
 * Every lane is actually DISPATCHED to, not merely sized and routed to.
 *
 * The gap this closes: adding the Codex lane gave it slots and a route, and the
 * dispatcher filled the older lanes by name - so a Codex task was accepted,
 * persisted, counted, and never started. It sat queued for ever with nothing in
 * any log saying why, which is the worst shape a queue bug can take.
 */
test('a task on a lane added later is actually started', async () => {
  const harnessed = harness({
    cli: [{ id: 'cli0', queue: 'cli' }],
    codex: [{ id: 'codex0', queue: 'codex' }],
  });

  harnessed.queue.submit([
    harnessed.task('on-codex', { queue: 'codex' }),
    harnessed.task('on-cli', { queue: 'cli' }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  assert.equal(harnessed.started.length, 2, 'both lanes were filled, not just the named ones');
  assert.deepEqual(
    harnessed.started.map((entry) => entry.label).sort(),
    ['on-cli', 'on-codex']
  );
});

test('the two CLI lanes do not take each other\'s work', async () => {
  // One Codex slot, no Claude slot: a Claude-seat task must WAIT rather than
  // being run on the Codex seat, which would answer from the wrong account.
  const harnessed = harness({
    cli: [],
    codex: [{ id: 'codex0', queue: 'codex' }],
  });

  const batch = harnessed.queue.submit([
    harnessed.task('needs-claude', { queue: 'cli' }),
    harnessed.task('needs-codex', { queue: 'codex' }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  assert.deepEqual(
    harnessed.started.map((entry) => entry.label),
    ['needs-codex'],
    'only the lane with a slot ran'
  );
  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.queued, 1, 'and the other is still waiting for its own seat');
});

/**
 * The lanes this build has, and nothing else.
 *
 * A task's lane is written to disk and read back by whatever build restarts,
 * and an earlier build had a third lane. The restore mapper translates those;
 * this is the floor under it - a lane name this build lacks is a lane no slot
 * will ever fill, so a task carrying one would be accepted, counted and never
 * run.
 */
test('the stats name exactly the lanes this build has', () => {
  const harnessed = harness({ cli: cliSlots(2), codex: codexSlots(1) });
  assert.deepEqual(Object.keys(harnessed.queue.stats()).sort(), ['cli', 'codex']);
});

test('a task naming a lane this build lacks runs on the cli lane rather than waiting for ever', async () => {
  const harnessed = harness({ cli: cliSlots(1), codex: [] });
  const batch = harnessed.queue.submit([
    harnessed.task('from-an-older-build', { queue: 'browser' }),
    harnessed.task('inherited-name', { queue: 'constructor' }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  assert.deepEqual(harnessed.started, [{ label: 'from-an-older-build', on: 'cli' }]);
  assert.deepEqual(
    batch.tasks.map((task) => task.queue),
    ['cli', 'cli'],
    'the task records the lane it actually waits in, so the stats and retries agree'
  );
  const stats = harnessed.queue.stats();
  assert.equal(stats.cli.queued, 1, 'the second waits its turn in cli');
  assert.equal(stats.cli.running, 1);
  assert.equal('browser' in stats, false);

  harnessed.finish('from-an-older-build');
  await settle();
  assert.equal(harnessed.started.length, 2, 'and is then run like any other');

  // The same floor under `restore`, which a throw here would cost the whole
  // batch rather than one task.
  const restored = harness({ cli: cliSlots(1), codex: [] });
  const batch2 = restored.queue.restore(
    { id: 'bat_restored', label: 'Restored', jobCount: 1, shared: {}, createdAt: Date.now() },
    [{ ...restored.task('restored-on-browser', { queue: 'browser' }), id: 'tsk_r', seq: 0, state: 'running' }]
  );
  await restored.queue.refreshCapacity();
  await settle();
  assert.deepEqual(restored.started, [{ label: 'restored-on-browser', on: 'cli' }]);
  assert.equal(batch2.tasks[0].queue, 'cli');
});

test('a backlog that is all Codex work still asks for a fresh capacity reading', async () => {
  // The staleness check counted the waiting tasks by naming lanes, and the lanes
  // it named left Codex out. A backlog that was ALL Codex work then never asked
  // for a new reading, so a Codex seat sized up after the last one stayed
  // unused for as long as nothing else was submitted.
  let reads = 0;
  const queue = new TaskQueue(async () => {
    reads += 1;
    // The first reading has no Codex slot; every later one has one.
    return { cli: cliSlots(1), codex: reads === 1 ? [] : codexSlots(1) };
  });
  const started = [];
  const release = new Map();
  registerTaskRunner('codex-backlog', (payload) => {
    started.push(payload.label);
    return new Promise((resolve) => release.set(payload.label, resolve));
  });
  const make = (label, lane) => ({
    queue: lane,
    label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
    kind: 'codex-backlog',
    payload: { label },
  });

  queue.submit([make('on-cli', 'cli'), make('on-codex', 'codex')]);
  await settle();
  assert.deepEqual(started, ['on-cli'], 'no Codex slot in the first reading');
  assert.equal(reads, 1);

  // The reading is now stale, and the only thing waiting is Codex work. The
  // dispatch a finishing task triggers is what notices.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    release.get('on-cli')();
    await settle();
    await settle();
  } finally {
    Date.now = realNow;
  }

  assert.equal(reads, 2, 'a Codex-only backlog counts as work waiting');
  assert.deepEqual(started, ['on-cli', 'on-codex']);
  release.get('on-codex')();
});

test('resetting for tests empties every lane, the Codex one included', () => {
  const harnessed = harness({ cli: [], codex: [] });
  harnessed.queue.submit([
    harnessed.task('waits-on-cli'),
    harnessed.task('waits-on-codex', { queue: 'codex' }),
  ]);
  assert.equal(harnessed.queue.stats().codex.queued, 1);

  harnessed.queue.resetForTests();
  const stats = harnessed.queue.stats();
  assert.equal(stats.cli.queued, 0);
  assert.equal(stats.codex.queued, 0, 'a Codex backlog must not leak into the next test');
});

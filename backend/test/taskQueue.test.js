const assert = require('node:assert/strict');
const test = require('node:test');

const { TaskQueue, registerTaskRunner } = require('../dist/services/queue/taskQueue');

/**
 * The dispatcher: two queues, slots, and FIFO.
 *
 * A task is one resume. Ten tasks and three browsers means three run and seven
 * wait, and the moment any browser finishes it takes the next task it is allowed
 * to run. These pin that, plus the three ways it could be subtly wrong: a slot
 * handed to two tasks, a pinned task taken by the wrong platform, and a task no
 * browser can serve sitting in the queue for ever.
 *
 * Timing is driven by hand - each task holds its slot until released - so these
 * are deterministic rather than passing on a fast machine and failing on a
 * loaded one.
 */

function browsers(...sites) {
  return sites.map((site, index) => ({ id: `b${index}:${site}`, queue: 'browser', site }));
}

function cliSlots(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `cli${index}`, queue: 'cli' }));
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
    started.push({ label, on: assignment.site ?? 'claude-cli' });
    return new Promise((resolve, reject) => {
      pending.set(label, { resolve, reject });
      assignment.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
  });

  const task = (label, options = {}) => ({
    queue: options.queue ?? 'browser',
    sites: options.sites,
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

test('ten tasks and three browsers: three run, seven wait', async () => {
  const harnessed = harness({ browser: browsers('claude-web', 'claude-web', 'chatgpt-web'), cli: [] });
  const tasks = Array.from({ length: 10 }, (_, index) => harnessed.task(`t${index}`));
  const batch = harnessed.queue.submit(tasks);
  await harnessed.queue.refreshCapacity();
  await settle();

  assert.equal(harnessed.started.length, 3, 'exactly one task per browser');
  assert.equal(harnessed.running, 3);
  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.running, 3);
  assert.equal(snapshot.queued, 7);
  assert.equal(snapshot.total, 10);
});

test('a browser that finishes takes the next task at once', async () => {
  // The property a chunked Promise.all does not have: freeing ONE browser starts
  // ONE task, rather than waiting for the rest of its wave.
  const harnessed = harness({ browser: browsers('claude-web', 'claude-web', 'chatgpt-web'), cli: [] });
  harnessed.queue.submit(Array.from({ length: 10 }, (_, index) => harnessed.task(`t${index}`)));
  await harnessed.queue.refreshCapacity();
  await settle();
  assert.equal(harnessed.started.length, 3);

  harnessed.finish('t0');
  await settle();
  assert.equal(harnessed.started.length, 4, 'the fourth task started the moment a browser freed');
  assert.equal(harnessed.running, 3, 'and that browser is busy again, not idle');
});

test('every task finishes, and the queue drains to empty', async () => {
  const harnessed = harness({ browser: browsers('claude-web', 'chatgpt-web'), cli: [] });
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
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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

test("a profile's platform choice is honoured, not quietly ignored", async () => {
  // One Claude browser and one ChatGPT browser. A Claude-only task must never
  // run on the ChatGPT browser, however idle it is.
  const harnessed = harness({ browser: browsers('claude-web', 'chatgpt-web'), cli: [] });
  harnessed.queue.submit([
    harnessed.task('claude-only', { sites: ['claude-web'] }),
    harnessed.task('chatgpt-only', { sites: ['chatgpt-web'] }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  const where = Object.fromEntries(harnessed.started.map((entry) => [entry.label, entry.on]));
  assert.equal(where['claude-only'], 'claude-web');
  assert.equal(where['chatgpt-only'], 'chatgpt-web');
});

test('a pinned task at the head does not block a browser it cannot use', async () => {
  // Head-of-line blocking is what makes a single queue go wrong. Two Claude-only
  // tasks queued first must not stop the idle ChatGPT browser reaching the
  // ChatGPT task behind them.
  const harnessed = harness({ browser: browsers('claude-web', 'chatgpt-web'), cli: [] });
  harnessed.queue.submit([
    harnessed.task('c0', { sites: ['claude-web'] }),
    harnessed.task('c1', { sites: ['claude-web'] }),
    harnessed.task('g0', { sites: ['chatgpt-web'] }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  const labels = harnessed.started.map((entry) => entry.label).sort();
  assert.deepEqual(labels, ['c0', 'g0'], 'the ChatGPT browser reached past the pinned pair');
});

test('a hybrid task goes to whichever browser is free', async () => {
  const harnessed = harness({ browser: browsers('chatgpt-web'), cli: [] });
  harnessed.queue.submit([
    harnessed.task('hybrid', { sites: ['claude-web', 'chatgpt-web'] }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();
  assert.equal(harnessed.started[0].on, 'chatgpt-web', 'no Claude browser, so ChatGPT took it');
});

test('the browser queue and the CLI queue drain independently', async () => {
  // Two resources, two queues. A seat with nothing free must not hold up the
  // browsers, and vice versa.
  const harnessed = harness({ browser: browsers('claude-web'), cli: cliSlots(2) });
  harnessed.queue.submit([
    harnessed.task('browser-0'),
    harnessed.task('browser-1'),
    harnessed.task('cli-0', { queue: 'cli' }),
    harnessed.task('cli-1', { queue: 'cli' }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  const labels = harnessed.started.map((entry) => entry.label).sort();
  assert.deepEqual(labels, ['browser-0', 'cli-0', 'cli-1'], 'both queues started at their own width');
});

test('one failing task does not stop the batch', async () => {
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
  registerTaskRunner('always-fails', async () => {
    throw new Error('the browser refused');
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
  assert.match(snapshot.tasks[0].error, /the browser refused/);
});

test('a rejecting task raises no unhandled rejection', async () => {
  // There is no HTTP request left to absorb one, and Node's default policy is to
  // take the process down - so one failed resume would stop the server.
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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

test('a cancelled batch frees its browsers for the next one', async () => {
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
  const first = harnessed.queue.submit([harnessed.task('a0'), harnessed.task('a1')]);
  await harnessed.queue.refreshCapacity();
  await settle();

  harnessed.queue.submit([harnessed.task('b0')]);
  harnessed.queue.cancel(first.id);
  await settle();

  assert.ok(
    harnessed.started.some((entry) => entry.label === 'b0'),
    'the next batch starts as soon as the browser is back'
  );
});

test('a task no running browser can serve fails instead of waiting for ever', async () => {
  // Otherwise it sits at the head while later tasks pass it and the batch never
  // finishes - a hang, with no error anywhere to explain it.
  const harnessed = harness({ browser: browsers('chatgpt-web'), cli: [] });
  const batch = harnessed.queue.submit([
    harnessed.task('claude-only', { sites: ['claude-web'] }),
  ]);
  await harnessed.queue.refreshCapacity();
  await settle();

  const snapshot = harnessed.queue.snapshot(batch.id);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.state, 'done');
  assert.match(snapshot.tasks[0].error, /No running browser/);
  assert.match(snapshot.tasks[0].error, /only chatgpt-web is registered/);
});

test('nothing is failed before capacity has ever been read', async () => {
  // Every task looks unservable against an empty reading, and failing a batch a
  // millisecond after it was submitted would be a spectacular own goal.
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
  const batch = harnessed.queue.submit([harnessed.task('t0', { sites: ['claude-web'] })]);
  assert.equal(harnessed.queue.snapshot(batch.id).failed, 0);
  assert.equal(harnessed.queue.snapshot(batch.id).queued, 1);
});

test('a slot is never handed to two tasks at once', async () => {
  // The failure this class exists to prevent: two turns typed into one composer.
  const capacity = { browser: browsers('claude-web'), cli: [] };
  const inFlight = new Set();
  const queue = new TaskQueue(async () => capacity);
  const pending = [];
  registerTaskRunner('exclusive', async (payload) => {
    const label = payload.label;
    assert.equal(inFlight.size, 0, `${label} started while another task held the browser`);
    inFlight.add(label);
    await new Promise((resolve) => pending.push(resolve));
    inFlight.delete(label);
  });
  const make = (label) => ({
    queue: 'browser',
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
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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
  const harnessed = harness({ browser: browsers('claude-web'), cli: [] });
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

const assert = require('node:assert/strict');
const test = require('node:test');

const { captureErrorLog, loadFresh, refAndLog, useTempStorage } = require('./helpers');

/**
 * The queue on disk, so a run survives the server restarting.
 *
 * `npm run dev` restarts on every file save, so this is not a rare event during
 * development - and a thirty-row sheet import is an hour of somebody's seat
 * time. The properties that matter are what SURVIVES and what is REDONE: work
 * already finished must come back finished, and work that was on a seat when
 * the process died must be built again, because nothing completed it.
 */

function repo(name) {
  useTempStorage(`queue-persistence-${name}`);
  return loadFresh('../dist/database/generationRepository');
}

const BATCH = {
  id: 'bat_1',
  state: 'running',
  data: { label: 'Sheets import', jobCount: 2, shared: { jobs: [{ companyName: 'Acme' }] } },
};

function taskRow(id, seq, state, extra = {}) {
  return {
    id,
    batchId: 'bat_1',
    seq,
    state,
    data: {
      queue: 'cli',
      label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
      kind: 'resume',
      payload: { batchId: 'bat_1', profileId: 'p1', jobIndex: 0 },
      ...extra,
    },
  };
}

test('a batch and its tasks come back as they were written', () => {
  const store = repo('roundtrip');
  store.saveBatchWithTasks(BATCH, [taskRow('tsk_a', 0, 'queued'), taskRow('tsk_b', 1, 'running')]);

  const [loaded] = store.loadBatchRows();
  assert.equal(loaded.id, 'bat_1');
  assert.equal(loaded.state, 'running');
  assert.equal(loaded.data.label, 'Sheets import');
  assert.deepEqual(loaded.data.shared.jobs, [{ companyName: 'Acme' }]);
  assert.equal(loaded.tasks.length, 2);
  assert.deepEqual(
    loaded.tasks.map((task) => task.seq),
    [0, 1],
    'tasks come back in submitted order'
  );
  assert.equal(loaded.tasks[0].data.kind, 'resume');
  assert.equal(loaded.tasks[0].data.payload.profileId, 'p1');
});

test('a task transition rewrites one small row, not the whole batch', () => {
  // The reason there are two tables. Thirty resumes is a hundred and twenty
  // transitions, and re-writing the batch each time would re-write every job
  // description with it.
  const store = repo('narrow-writes');
  store.saveBatchWithTasks(BATCH, [taskRow('tsk_a', 0, 'queued')]);
  store.saveTaskRow(taskRow('tsk_a', 0, 'done', { value: { pdf: 'a.pdf' } }));

  const [loaded] = store.loadBatchRows();
  assert.equal(loaded.tasks[0].state, 'done');
  assert.deepEqual(loaded.tasks[0].data.value, { pdf: 'a.pdf' });
  assert.deepEqual(loaded.data.shared.jobs, [{ companyName: 'Acme' }], 'the batch is untouched');
});

test('deleting a batch takes its tasks with it', () => {
  const store = repo('cascade');
  store.saveBatchWithTasks(BATCH, [taskRow('tsk_a', 0, 'queued')]);
  store.deleteBatchRow('bat_1');
  assert.deepEqual(store.loadBatchRows(), []);
});

test('finished batches are pruned, running ones are never touched', () => {
  const store = repo('prune');
  store.saveBatchWithTasks({ ...BATCH, id: 'bat_old', state: 'done' }, []);
  store.saveBatchWithTasks({ ...BATCH, id: 'bat_live', state: 'running' }, []);

  const pruned = store.pruneBatchRows(new Date(Date.now() + 60_000).toISOString());
  assert.equal(pruned, 1, 'only the finished one');
  const ids = store.loadBatchRows().map((row) => row.id);
  assert.deepEqual(ids, ['bat_live'], 'a running batch is never pruned, however old');
});

test('a row this build cannot parse is skipped, not fatal', () => {
  // A boot that crashes on one bad row is worse than the restart it was meant
  // to survive.
  const store = repo('bad-row');
  store.saveBatchWithTasks(BATCH, []);
  const { getDb } = loadFresh('../dist/database/sqlite');
  getDb().prepare('UPDATE generation_batches SET data = ? WHERE id = ?').run('not json', 'bat_1');

  const [loaded] = store.loadBatchRows();
  assert.deepEqual(loaded.data, {}, 'unreadable data reads as empty rather than throwing');
});

/**
 * The queue's own half: what `restore` does with the states it is handed.
 */
function queueFor(capacity) {
  const { TaskQueue, registerTaskRunner } = loadFresh('../dist/services/queue/taskQueue');
  const started = [];
  registerTaskRunner('test', async (payload) => {
    started.push(payload.name);
    return { built: payload.name };
  });
  return { queue: new TaskQueue(async () => capacity), started };
}

function entry(name, seq, state, extra = {}) {
  return {
    id: `tsk_${name}`,
    seq,
    state,
    queue: 'cli',
    label: { profileId: 'p1', profileName: 'Ada', companyName: name, role: 'SWE' },
    kind: 'test',
    payload: { name },
    ...extra,
  };
}

const meta = { id: 'bat_1', label: 'Restored', jobCount: 4, shared: {}, createdAt: Date.now() };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('work already finished comes back finished, and is not built again', () => {
  // Restoring only the remainder would shrink the batch's total and drop its
  // finished resumes out of the results - a batch of four with two built would
  // come back as a batch of two.
  const { queue, started } = queueFor({ cli: [], codex: [] });
  const batch = queue.restore(meta, [
    entry('a', 0, 'done', { value: { built: 'a' } }),
    entry('b', 1, 'failed', { error: 'the model refused' }),
    entry('c', 2, 'queued'),
    entry('d', 3, 'running'),
  ]);

  const snapshot = queue.snapshot(batch.id);
  assert.equal(snapshot.total, 4, 'the total is what was submitted, not what is left');
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.queued, 2, 'the queued one and the one that was mid-flight');
  assert.equal(snapshot.tasks[1].error, 'the model refused', 'a failure survives with its reason');
  assert.deepEqual(started, [], 'nothing ran: there is no capacity yet');
});

test('a task that was mid-flight is built again, because nothing completed it', async () => {
  const { queue, started } = queueFor({
    cli: [{ id: 'c1', queue: 'cli' }],
    codex: [],
  });
  queue.restore(meta, [entry('a', 0, 'done', { value: { built: 'a' } }), entry('b', 1, 'running')]);
  await queue.refreshCapacity();
  await settle();

  assert.deepEqual(started, ['b'], 'the interrupted one, and only it');
});

test('a batch whose every task had finished is not left running for ever', () => {
  const { queue } = queueFor({ cli: [], codex: [] });
  const batch = queue.restore(meta, [
    entry('a', 0, 'done', { value: {} }),
    entry('b', 1, 'failed', { error: 'x' }),
  ]);
  const snapshot = queue.snapshot(batch.id);
  assert.equal(snapshot.state, 'done');
  assert.deepEqual(queue.listBatches(true), [], 'and it is not listed as active');
});

test('restored tasks keep their submitted order', async () => {
  const { queue, started } = queueFor({
    cli: [{ id: 'c1', queue: 'cli' }],
    codex: [],
  });
  queue.restore(meta, [entry('c', 2, 'queued'), entry('a', 0, 'queued'), entry('b', 1, 'queued')]);
  await queue.refreshCapacity();
  for (let index = 0; index < 3; index += 1) await settle();

  assert.deepEqual(started, ['c', 'a', 'b'], 'the order they were handed over in');
});

test('a queue with no store still runs', () => {
  // The store is optional on purpose: a disk that will not take the row is a
  // reason to lose a restart, not a reason to stop building resumes.
  const { queue } = queueFor({ cli: [], codex: [] });
  assert.doesNotThrow(() =>
    queue.submit([
      {
        queue: 'cli',
        label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
        kind: 'test',
        payload: { name: 'a' },
      },
    ])
  );
});

test('a store that throws warns once and does not fail the queue', () => {
  const { TaskQueue, registerTaskRunner } = loadFresh('../dist/services/queue/taskQueue');
  registerTaskRunner('test', async () => ({}));
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const queue = new TaskQueue(async () => ({ cli: [], codex: [] }), {
      saveBatch: () => {
        throw new Error('disk is full');
      },
      saveTask: () => {
        throw new Error('disk is full');
      },
      deleteBatch: () => {
        throw new Error('disk is full');
      },
    });
    const batch = queue.submit([
      {
        queue: 'cli',
        label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
        kind: 'test',
        payload: {},
      },
    ]);
    assert.ok(queue.snapshot(batch.id), 'the batch is queued regardless');
    assert.equal(warnings.length, 1, 'said once, not once per row');
    assert.match(warnings[0], /restart will lose it/);
  } finally {
    console.warn = warn;
  }
});

test('a task whose kind nothing registers fails by name', async () => {
  // Only reachable for a task restored from a build that knew a kind this one
  // does not. Failing it by name beats it sitting queued for ever.
  const { TaskQueue } = loadFresh('../dist/services/queue/taskQueue');
  const queue = new TaskQueue(async () => ({
    cli: [{ id: 'c1', queue: 'cli' }],
    codex: [],
  }));
  const { result: batch, lines } = await captureErrorLog(async () => {
    const restored = queue.restore(meta, [
      { ...entry('a', 0, 'queued'), kind: 'from-a-later-build' },
    ]);
    await queue.refreshCapacity();
    await settle();
    return restored;
  });

  const snapshot = queue.snapshot(batch.id);
  assert.equal(snapshot.failed, 1);
  // By name in the LOG, under the ref the stored failure carries: the kind is
  // the operator's to read, and the owner's page reads the stored text.
  assert.doesNotMatch(snapshot.tasks[0].error, /runner|from-a-later-build/);
  assert.match(refAndLog(snapshot.tasks[0].error, lines).logged, /No runner is registered for "from-a-later-build"/);
});

/**
 * The attempt counter across a restart.
 *
 * Through the PRODUCTION mapper, deliberately: every test above builds its own
 * `taskRow` fixture, and that is exactly how the counter came to be missing from
 * the real one for a whole commit. `data` is a hand-picked projection, not the
 * task serialized, so a field added to `Task` does not reach the disk by being
 * there - and without it a crash-looping job came back entitled to a full fresh
 * budget every boot, which is the one case the on-disk queue exists for.
 */
test('attempts already spent survive a restart, through the real persistence path', async () => {
  useTempStorage('queue-persistence-attempts');
  process.env.GENERATION_MAX_ATTEMPTS = '3';
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();

  const queue = queueModule.getGenerationQueue();
  const batch = queue.submit(
    [
      {
        queue: 'cli',
        label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
        kind: 'restart-attempts',
        payload: { batchId: 'ignored' },
      },
    ],
    { id: 'bat_attempts', label: 'Restart', deferPersist: true }
  );

  // The state a process death leaves behind: on its third go, mid-build.
  batch.tasks[0].state = 'running';
  batch.tasks[0].attempts = 3;
  batch.tasks[0].error = 'the first two goes failed';
  queueModule.persistNewBatch(batch);

  // The restart. Restoring is asynchronous - it may resolve a model again for a
  // task first - so by the time it returns the dispatcher can already have
  // picked the task up. A runner that holds it is what lets its state be read
  // while it is being built again.
  queueModule.resetGenerationQueueForTests();
  const restored = loadFresh('../dist/services/queue/index');
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  restored.registerTaskRunner('restart-attempts', () => held.then(() => ({})));
  await restored.restoreGenerationQueue();

  const snapshot = restored.getGenerationQueue().snapshot('bat_attempts');
  assert.ok(snapshot, 'the batch comes back');
  assert.ok(
    ['queued', 'running'].includes(snapshot.tasks[0].state),
    `a task that was running is built again (${snapshot.tasks[0].state})`
  );
  assert.equal(
    snapshot.tasks[0].attempts,
    3,
    'the attempts already spent came back - without this the cap resets on every restart'
  );
  assert.equal(snapshot.maxAttempts, 3, 'the ceiling is reported so a page need not hard-code it');

  release();
  restored.resetGenerationQueueForTests();
  delete process.env.GENERATION_MAX_ATTEMPTS;
});

/**
 * The two failures that must NOT be retried, because retrying them is pure
 * delay: both are deterministic, so three goes produce the same error three
 * times while holding a slot each go.
 */
test('a kind nothing registers fails once, however many attempts are allowed', async () => {
  useTempStorage('queue-persistence-no-runner');
  process.env.GENERATION_MAX_ATTEMPTS = '3';
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();

  const queue = queueModule.getGenerationQueue();
  const batch = queue.submit(
    [
      {
        queue: 'cli',
        label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
        kind: 'a-kind-nothing-registers',
        payload: {},
      },
    ],
    { id: 'bat_no_runner', label: 'Missing runner' }
  );

  // The dispatcher runs on a timer, so wait for the task to stop rather than
  // assuming it already has.
  const { lines } = await captureErrorLog(async () => {
    for (let i = 0; i < 200 && batch.tasks[0].state === 'queued'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  const snapshot = queue.snapshot('bat_no_runner');
  assert.equal(snapshot.tasks[0].state, 'failed');
  assert.match(refAndLog(snapshot.tasks[0].error, lines).logged, /No runner is registered/);
  assert.equal(
    snapshot.tasks[0].attempts,
    undefined,
    'one go only - the snapshot omits attempts below 2, so this asserts it was never retried'
  );

  delete process.env.GENERATION_MAX_ATTEMPTS;
});

test('cancelling a task that is waiting for a RETRY does not claim it never started', async () => {
  useTempStorage('queue-persistence-cancel-retry');
  process.env.GENERATION_MAX_ATTEMPTS = '3';
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();

  const queue = queueModule.getGenerationQueue();
  const batch = queue.submit(
    [
      {
        queue: 'cli',
        label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
        kind: 'cancel-between-attempts',
        payload: {},
      },
    ],
    { id: 'bat_cancel_retry', label: 'Cancel' }
  );

  // The state between two goes: queued again, carrying why the last one failed.
  batch.tasks[0].state = 'queued';
  batch.tasks[0].attempts = 2;
  batch.tasks[0].error = 'the seat was out of messages';

  queue.cancel('bat_cancel_retry');

  const snapshot = queue.snapshot('bat_cancel_retry');
  assert.equal(snapshot.tasks[0].state, 'cancelled');
  assert.match(
    snapshot.tasks[0].error,
    /after 2 attempt/,
    '"Cancelled before it started" is false here - it HAD started, twice'
  );
  assert.match(
    snapshot.tasks[0].error,
    /out of messages/,
    'and the reason the last go failed is not thrown away'
  );

  delete process.env.GENERATION_MAX_ATTEMPTS;
});

test('an unset GENERATION_MAX_ATTEMPTS means three goes, not one', async () => {
  useTempStorage('queue-persistence-default-attempts');
  // The branch every other test skips, because they all set the variable.
  delete process.env.GENERATION_MAX_ATTEMPTS;
  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();

  const batch = queueModule.getGenerationQueue().submit(
    [
      {
        queue: 'cli',
        label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' },
        kind: 'default-attempts',
        payload: {},
      },
    ],
    { id: 'bat_default_attempts', label: 'Default' }
  );

  assert.equal(
    queueModule.getGenerationQueue().snapshot(batch.id).maxAttempts,
    3,
    'the documented default reaches the queue rather than the constructor\'s retry-off 1'
  );
});

/**
 * Rows as the store holds them, written by an earlier process.
 *
 * A restart reads them back, and a lane this process does not have - a
 * provider an administrator removed since - is not a lane anything will ever
 * dispatch: with no slot to take it, the task would sit queued for ever while
 * its credit stayed reserved. So the restore mapper puts it in its type's pool,
 * and the queue places it with a provider of that type.
 */
function storedTaskRow(batchId, id, seq, state, data) {
  return {
    id,
    batchId,
    seq,
    state,
    data: {
      label: { profileId: data.payload.profileId, profileName: 'Ada', companyName: `Co ${seq}`, role: 'SWE' },
      kind: 'resume',
      ...data,
    },
  };
}

function storedBatchRow(id, jobCount) {
  return {
    id,
    state: 'running',
    data: {
      label: 'Queued before the upgrade',
      jobCount,
      shared: { jobs: [{ companyName: 'Acme', role: 'SWE', jobDescription: '' }] },
      createdAt: Date.now(),
    },
  };
}

/** A choice as a queued task stores it. */
const SONNET_CHOICE = {
  provider: 'claude-cli',
  modelName: 'sonnet',
  modelId: 'claude-cli-sonnet',
  modelLabel: 'Claude Sonnet',
};

async function untilSettled(queue, batchId) {
  for (let i = 0; i < 300; i += 1) {
    const snapshot = queue.snapshot(batchId);
    if (snapshot && snapshot.tasks.every((task) => ['done', 'failed', 'cancelled'].includes(task.state))) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return queue.snapshot(batchId);
}

test('one batch that cannot be restored does not cost the others theirs', async () => {
  useTempStorage('queue-persistence-isolation');
  const store = loadFresh('../dist/database/generationRepository');
  for (const id of ['bat_first', 'bat_broken', 'bat_last']) {
    store.saveBatchWithTasks(storedBatchRow(id, 1), [
      storedTaskRow(id, `tsk_${id}`, 0, 'queued', {
        queue: 'claude-cli',
        payload: { batchId: id, profileId: 'p-default', jobIndex: 0, choice: SONNET_CHOICE },
      }),
    ]);
  }

  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  const queue = queueModule.getGenerationQueue();
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async () => ({}));

  // Whatever makes a batch unrestorable - a row this build cannot make sense
  // of - it surfaces as `restore` throwing for that batch.
  const restore = queue.restore.bind(queue);
  queue.restore = (meta, entries) => {
    if (meta.id === 'bat_broken') throw new Error('a row this build cannot read');
    return restore(meta, entries);
  };

  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  let report;
  try {
    report = await queueModule.restoreGenerationQueue();
  } finally {
    console.warn = warn;
  }

  assert.equal(report.batches, 2, 'the two good batches, and only them');
  assert.ok(queue.getBatch('bat_first'), 'the batch before the broken one is back');
  assert.ok(queue.getBatch('bat_last'), 'and so is the one after it');
  assert.equal(queue.getBatch('bat_broken'), undefined);
  assert.ok(
    warnings.some((line) => line.includes('bat_broken') && /other batches are unaffected/.test(line)),
    'the broken batch is named'
  );

  for (const id of ['bat_first', 'bat_last']) {
    const snapshot = await untilSettled(queue, id);
    assert.equal(snapshot.tasks[0].state, 'done', `${id} ran`);
  }
});

test('Gemini work comes back on the Gemini lane: stored there, or placed there by its provider', async () => {
  // A task's lane is the resource it waits for. Restored into the Claude
  // seat's lane, Gemini work would hold Claude slots while queueing at the
  // Gemini semaphore - the oversubscription the lane split exists to prevent.
  useTempStorage('queue-persistence-gemini-lane');
  process.env.AI_GEMINI_CONCURRENCY = '1';
  try {
    const choice = { provider: 'gemini-cli', modelName: 'auto', modelId: 'gemini-cli-auto', modelLabel: 'Gemini' };
    const store = loadFresh('../dist/database/generationRepository');
    store.saveBatchWithTasks(storedBatchRow('bat_gemini', 2), [
      // Mid-build on the Gemini seat when the process died.
      storedTaskRow('bat_gemini', 'tsk_stored', 0, 'running', {
        queue: 'gemini-cli',
        payload: { batchId: 'bat_gemini', profileId: 'p1', jobIndex: 0, choice },
      }),
      // A provider removed since: placed again in the pool of its type.
      storedTaskRow('bat_gemini', 'tsk_placed', 1, 'queued', {
        queue: 'prv-0badf00d',
        payload: { batchId: 'bat_gemini', profileId: 'p1', jobIndex: 0, choice },
      }),
    ]);

    const queueModule = loadFresh('../dist/services/queue/index');
    queueModule.resetGenerationQueueForTests();
    const queue = queueModule.getGenerationQueue();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = [];
    queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload, assignment) => {
      started.push(assignment.queue);
      await held;
      return {};
    });

    const report = await queueModule.restoreGenerationQueue();
    assert.equal(report.requeued, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stats = queue.stats();
    assert.equal(stats['gemini-cli'].running, 1, 'one at a time, as AI_GEMINI_CONCURRENCY says');
    assert.equal(stats['gemini-cli'].queued, 1, 'the other waits for the Gemini seat');
    assert.equal(stats['claude-cli'].queued + stats['claude-cli'].running, 0, 'and nothing waits in the Claude seat\'s lane');
    // The lane IS the provider: the built-in Gemini one, whose id is its type's.
    assert.deepEqual(started, ['gemini-cli']);
    const running = queue.snapshot('bat_gemini').tasks.find((task) => task.state === 'running');
    assert.equal(running.runningOn, 'gemini-cli');

    const [row] = loadFresh('../dist/database/generationRepository').loadBatchRows();
    assert.deepEqual(
      row.tasks.map((task) => task.data.queue),
      ['gemini-cli', 'gemini-cli'],
      'written back on the lane it waits in'
    );

    release();
    queueModule.resetGenerationQueueForTests();
  } finally {
    delete process.env.AI_GEMINI_CONCURRENCY;
  }
});

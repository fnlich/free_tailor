const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The queue on disk, so a run survives the server restarting.
 *
 * `npm run dev` restarts on every file save, so this is not a rare event during
 * development - and a thirty-row sheet import is an hour of somebody's browser
 * time. The properties that matter are what SURVIVES and what is REDONE: work
 * already finished must come back finished, and work that was in a browser when
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
      queue: 'browser',
      sites: ['claude-web'],
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
    queue: 'browser',
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
  const { queue, started } = queueFor({ browser: [], cli: [] });
  const batch = queue.restore(meta, [
    entry('a', 0, 'done', { value: { built: 'a' } }),
    entry('b', 1, 'failed', { error: 'the browser refused' }),
    entry('c', 2, 'queued'),
    entry('d', 3, 'running'),
  ]);

  const snapshot = queue.snapshot(batch.id);
  assert.equal(snapshot.total, 4, 'the total is what was submitted, not what is left');
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.queued, 2, 'the queued one and the one that was mid-flight');
  assert.equal(snapshot.tasks[1].error, 'the browser refused', 'a failure survives with its reason');
  assert.deepEqual(started, [], 'nothing ran: there is no capacity yet');
});

test('a task that was mid-flight is built again, because nothing completed it', async () => {
  const { queue, started } = queueFor({
    browser: [{ id: 'b1', queue: 'browser', site: 'claude-web' }],
    cli: [],
  });
  queue.restore(meta, [entry('a', 0, 'done', { value: { built: 'a' } }), entry('b', 1, 'running')]);
  await queue.refreshCapacity();
  await settle();

  assert.deepEqual(started, ['b'], 'the interrupted one, and only it');
});

test('a batch whose every task had finished is not left running for ever', () => {
  const { queue } = queueFor({ browser: [], cli: [] });
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
    browser: [{ id: 'b1', queue: 'browser', site: 'claude-web' }],
    cli: [],
  });
  queue.restore(meta, [entry('c', 2, 'queued'), entry('a', 0, 'queued'), entry('b', 1, 'queued')]);
  await queue.refreshCapacity();
  for (let index = 0; index < 3; index += 1) await settle();

  assert.deepEqual(started, ['c', 'a', 'b'], 'the order they were handed over in');
});

test('a queue with no store still runs', () => {
  // The store is optional on purpose: a disk that will not take the row is a
  // reason to lose a restart, not a reason to stop building resumes.
  const { queue } = queueFor({ browser: [], cli: [] });
  assert.doesNotThrow(() =>
    queue.submit([
      {
        queue: 'browser',
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
    const queue = new TaskQueue(async () => ({ browser: [], cli: [] }), {
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
        queue: 'browser',
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
    browser: [{ id: 'b1', queue: 'browser', site: 'claude-web' }],
    cli: [],
  }));
  const batch = queue.restore(meta, [
    { ...entry('a', 0, 'queued'), kind: 'from-a-later-build' },
  ]);
  await queue.refreshCapacity();
  await settle();

  const snapshot = queue.snapshot(batch.id);
  assert.equal(snapshot.failed, 1);
  assert.match(snapshot.tasks[0].error, /No runner is registered for "from-a-later-build"/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { TaskQueue, registerTaskRunner } = require('../dist/services/queue/taskQueue');
const { useTempStorage } = require('./helpers');

/**
 * One queue per PROVIDER, pooled by type (owner decisions P2-P4).
 *
 * Every provider is a lane of its own, as wide as its own
 * `concurrency_max_requests`; a model names a TYPE, and its work goes to the
 * lane of a provider of that type that can take it now - enabled, signed in,
 * not held - with the most free capacity. A provider that stops serving has
 * its waiting work moved to another of its type; with none serving, the work
 * waits. Through the dispatcher with hand-driven tasks, and through the real
 * queue's reading of the providers and its restore.
 */

let harnessSeq = 0;

/**
 * A dispatcher over a rich reading, every lane's readiness switchable, and a
 * recorder of which lane ran what and how many ran at once on each.
 */
function harness(lanes, options = {}) {
  const kind = `provider-queue-${(harnessSeq += 1)}`;
  const notReady = new Set();
  const reading = { lanes };
  const queue = new TaskQueue(async () => reading, undefined, undefined, options.maxAttempts ?? 1, {
    ready: (lane) => !notReady.has(lane),
    poolOf: options.poolOf,
  });
  const started = [];
  const pending = new Map();
  const running = new Map();
  const peak = new Map();
  let peakTotal = 0;
  registerTaskRunner(kind, (payload, assignment) => {
    started.push({ label: payload.label, on: assignment.queue });
    running.set(assignment.queue, (running.get(assignment.queue) ?? 0) + 1);
    peak.set(assignment.queue, Math.max(peak.get(assignment.queue) ?? 0, running.get(assignment.queue)));
    peakTotal = Math.max(peakTotal, [...running.values()].reduce((a, b) => a + b, 0));
    return new Promise((resolve, reject) => {
      pending.set(payload.label, {
        resolve: (value) => {
          running.set(assignment.queue, running.get(assignment.queue) - 1);
          resolve(value);
        },
        reject: (error) => {
          running.set(assignment.queue, running.get(assignment.queue) - 1);
          reject(error);
        },
      });
    });
  });
  const task = (label, pool = 'claude-cli') => ({
    queue: pool,
    label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
    kind,
    payload: { label },
  });
  return {
    queue,
    reading,
    started,
    peak,
    get peakTotal() {
      return peakTotal;
    },
    task,
    hold: (lane) => notReady.add(lane),
    lift: (lane) => notReady.delete(lane),
    finish(label) {
      pending.get(label)?.resolve(`${label} done`);
      pending.delete(label);
    },
    fail(label) {
      pending.get(label)?.reject(new Error('the seat is held (stub)'));
      pending.delete(label);
    },
    pendingLabels: () => [...pending.keys()],
  };
}

function lane(id, pool, width, enabled = true) {
  return {
    id,
    pool,
    enabled,
    slots: Array.from({ length: width }, (_, index) => ({ id: `${id}:${index}`, queue: id })),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('two Claude providers with limits 1 and 2: six tasks run at most three at once, each lane at its own limit', async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-aaaaaaaa', 'claude-cli', 2)]);
  await h.queue.refreshCapacity();
  const batch = h.queue.submit(Array.from({ length: 6 }, (_, index) => h.task(`t${index}`)));
  await settle();

  assert.equal(h.started.length, 3, '1 + 2, and no more');
  assert.equal(h.queue.stats()['claude-cli'].running, 1);
  assert.equal(h.queue.stats()['prv-aaaaaaaa'].running, 2);
  // Placed by free capacity - running plus waiting over width, ties to the
  // reading's order: widths 1 and 2 share six as two and four.
  assert.equal(h.queue.stats()['claude-cli'].queued + h.queue.stats()['claude-cli'].running, 2);
  assert.equal(h.queue.stats()['prv-aaaaaaaa'].queued + h.queue.stats()['prv-aaaaaaaa'].running, 4);

  // Drain it, one finish at a time, and watch neither lane go over its limit.
  while (h.pendingLabels().length > 0) {
    h.finish(h.pendingLabels()[0]);
    await settle();
  }
  assert.equal(h.queue.snapshot(batch.id).completed, 6);
  assert.equal(h.peak.get('claude-cli'), 1, 'the first provider never ran two');
  assert.equal(h.peak.get('prv-aaaaaaaa'), 2, 'the second never ran three');
  assert.equal(h.peakTotal, 3);
});

test("a held provider's waiting tasks move to the other, and a retry goes there too", async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-bbbbbbbb', 'claude-cli', 1)], { maxAttempts: 2 });
  await h.queue.refreshCapacity();
  h.queue.submit(['a', 'b', 'c', 'd'].map((label) => h.task(label)));
  await settle();
  assert.deepEqual(
    h.started.map((entry) => `${entry.label}@${entry.on}`),
    ['a@claude-cli', 'b@prv-bbbbbbbb'],
    'one each, placed alternately'
  );
  assert.equal(h.queue.stats()['claude-cli'].queued, 1);

  // The built-in seat is held (a rate limit, say): the call it was running
  // fails, and nothing more may go to it.
  h.hold('claude-cli');
  h.fail('a');
  await settle();
  const stats = h.queue.stats();
  assert.equal(stats['claude-cli'].queued, 0, 'its waiting task moved');
  assert.equal(stats['claude-cli'].running, 0, 'and nothing new started there');
  assert.equal(stats['prv-bbbbbbbb'].queued, 3, 'the other provider holds the waiting work, the retry included');

  // Every remaining task, the retried one too, runs on the provider that serves.
  while (h.pendingLabels().length > 0) {
    h.finish(h.pendingLabels()[0]);
    await settle();
  }
  const after = h.started.slice(2).map((entry) => entry.on);
  assert.ok(after.length >= 3 && after.every((on) => on === 'prv-bbbbbbbb'), JSON.stringify(h.started));
  assert.ok(h.started.some((entry) => entry.label === 'a' && entry.on === 'prv-bbbbbbbb'), 'the retry ran on the other provider');
});

test('a disabled provider gets nothing, and its waiting work moves when it is switched off', async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 2), lane('prv-cccccccc', 'claude-cli', 2, false)]);
  await h.queue.refreshCapacity();
  h.queue.submit(['a', 'b', 'c', 'd'].map((label) => h.task(label)));
  await settle();
  assert.ok(h.started.every((entry) => entry.on === 'claude-cli'), 'nothing placed on the disabled one');
  assert.equal(h.queue.stats()['prv-cccccccc'].queued + h.queue.stats()['prv-cccccccc'].running, 0);

  // Now the other way round: the built-in is switched off while work waits on it.
  h.reading.lanes = [lane('claude-cli', 'claude-cli', 2, false), lane('prv-cccccccc', 'claude-cli', 2)];
  await h.queue.refreshCapacity();
  assert.equal(h.queue.stats()['claude-cli'].queued, 0, 'its waiting work moved');
  assert.equal(h.queue.stats()['claude-cli'].running, 2, 'what was running there finishes there');
  h.finish('a');
  h.finish('b');
  await settle();
  assert.deepEqual(h.started.slice(2).map((entry) => entry.on), ['prv-cccccccc', 'prv-cccccccc']);
  assert.equal(h.queue.stats()['claude-cli'].running, 0, 'and nothing new went to the switched-off one');
});

test('with no provider of the type serving, its work waits - then runs when one comes back', async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-dddddddd', 'claude-cli', 1), lane('codex-cli', 'codex-cli', 1)]);
  h.hold('claude-cli');
  h.hold('prv-dddddddd');
  await h.queue.refreshCapacity();
  const batch = h.queue.submit([h.task('claude-work'), h.task('codex-work', 'codex-cli')]);
  await settle();
  assert.deepEqual(h.started.map((entry) => entry.label), ['codex-work'], 'only the type with a provider serving runs');
  assert.equal(h.queue.snapshot(batch.id).queued, 1, 'the Claude task waits rather than failing into the hold');

  h.lift('prv-dddddddd');
  await h.queue.refreshCapacity();
  await settle();
  assert.deepEqual(
    h.started.map((entry) => `${entry.label}@${entry.on}`),
    ['codex-work@codex-cli', 'claude-work@prv-dddddddd']
  );
  h.queue.resetForTests();
});

test('a slot never runs another type\'s work, however idle', async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 0), lane('codex-cli', 'codex-cli', 3)]);
  await h.queue.refreshCapacity();
  h.queue.submit([h.task('claude-work')]);
  await settle();
  assert.equal(h.started.length, 0, 'a Codex slot does not answer for a Claude model');
  h.queue.resetForTests();
});

test('an idle provider takes the head of a busier one of its type', async () => {
  // Placement is a guess at how long work takes; a provider that finished
  // early must not sit idle while its type's work waits elsewhere.
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-eeeeeeee', 'claude-cli', 1)]);
  await h.queue.refreshCapacity();
  h.queue.submit(['a', 'b', 'c', 'd'].map((label) => h.task(label)));
  await settle();
  // a@claude-cli, b@prv; c waits on claude-cli, d on prv.
  h.finish('b');
  await settle();
  h.finish(h.pendingLabels().find((label) => label !== 'a'));
  await settle();
  // prv has finished two while claude-cli still runs `a`: prv took `c` from claude-cli's line.
  assert.ok(
    h.started.some((entry) => entry.label === 'c' && entry.on === 'prv-eeeeeeee'),
    JSON.stringify(h.started)
  );
  h.queue.resetForTests();
});

test('urgent work keeps its place per lane when a type is pooled', async () => {
  const kind = `provider-urgent-${(harnessSeq += 1)}`;
  const started = [];
  const pending = [];
  registerTaskRunner(kind, (payload, assignment) => {
    started.push(`${payload.label}@${assignment.queue}`);
    return new Promise((resolve) => pending.push(resolve));
  });
  const reading = { lanes: [lane('claude-cli', 'claude-cli', 1), lane('prv-ffffffff', 'claude-cli', 1)] };
  const queue = new TaskQueue(async () => reading);
  await queue.refreshCapacity();
  const make = (label) => ({
    queue: 'claude-cli',
    label: { profileId: label, profileName: label, companyName: 'Acme', role: '' },
    kind,
    payload: { label },
  });
  queue.submit(['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map(make));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started.length, 2, 'an order task running on each provider');
  queue.submit(['u1', 'u2'].map(make), { urgent: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // In each lane the urgent task waits at the head, ahead of the orders.
  pending.shift()();
  pending.shift()();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const next = started.slice(2).map((entry) => entry.split('@')[0]).sort();
  assert.deepEqual(next, ['u1', 'u2'], 'both urgent tasks ran before any further order task');
  queue.resetForTests();
});

/* ---------------------------------------------------------- the real queue */

function realQueueInstall(name) {
  const storage = useTempStorage(`provider-queues-${name}`);
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), `provider-home-${name}-`));
  const config = require('../dist/config/aiModelConfig');
  config.invalidateSettingsCache();
  require('../dist/config/aiProviders').resetProviderSnapshotForTests();
  const queueModule = require('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  return { storage, home, config, queueModule };
}

test("the real queue reads one lane per provider, an added one's as wide as its own limit, resized live", async () => {
  const { home, config, queueModule } = realQueueInstall('reading');
  const created = await config.createAIProvider({
    type: 'claude-cli',
    label: 'Claude, second account',
    homeDir: home,
    concurrency_max_requests: 3,
  });
  const id = created.provider.id;
  assert.match(id, /^prv-[0-9a-f]{8}$/);

  const { lanes } = await queueModule.readCapacityForTests({ AI_CLI_CONCURRENCY: '2' });
  assert.deepEqual(
    lanes.map((entry) => [entry.id, entry.pool, entry.slots.length]),
    [
      ['claude-cli', 'claude-cli', 2],
      [id, 'claude-cli', 3],
      ['codex-cli', 'codex-cli', 4],
      ['gemini-cli', 'gemini-cli', 2],
    ],
    'the added provider is a lane of its own, in the Claude pool, first after its type\'s built-in'
  );

  await config.updateAIProvider(id, { concurrency_max_requests: 5 });
  const resized = await queueModule.readCapacityForTests({});
  assert.equal(resized.lanes.find((entry) => entry.id === id).slots.length, 5, 'the next reading has the new width');

  await config.updateAIProvider(id, { enabled: false });
  const off = await queueModule.readCapacityForTests({});
  assert.equal(off.lanes.find((entry) => entry.id === id).enabled, false, 'switched off: read, and takes nothing');
});

test('a restored task naming a removed provider moves to a provider of its type; one naming a live one stays', async () => {
  const { home, config, queueModule } = realQueueInstall('restore');
  const created = await config.createAIProvider({ type: 'codex-cli', label: 'Codex two', homeDir: home, concurrency_max_requests: 1 });
  const live = created.provider.id;

  const store = require('../dist/database/generationRepository');
  const choice = { provider: 'codex-cli', modelName: 'default', modelId: 'codex-cli-default', modelLabel: 'Codex' };
  const row = (id, seq, queue) => ({
    id,
    batchId: 'bat_providers',
    seq,
    state: 'queued',
    data: {
      queue,
      label: { profileId: 'p1', profileName: 'Ada', companyName: `Co ${seq}`, role: '' },
      kind: 'resume',
      payload: { batchId: 'bat_providers', profileId: 'p1', jobIndex: 0, choice, costMilli: 0 },
      ranOn: queue,
    },
  });
  store.saveBatchWithTasks(
    { id: 'bat_providers', state: 'running', data: { label: 'Before', jobCount: 1, shared: { jobs: [] }, createdAt: Date.now() } },
    [row('tsk_gone', 0, 'prv-0badf00d'), row('tsk_live', 1, live)]
  );

  const queue = queueModule.getGenerationQueue();
  const ran = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload, assignment) => {
    ran.push(assignment.queue);
    await held;
    return {};
  });
  // Only the built-in Codex provider and the live added one are Codex lanes;
  // the removed one's task must land on one of them, never on a Claude lane.
  await queueModule.restoreGenerationQueue();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const batch = queue.getBatch('bat_providers');
  const gone = batch.tasks.find((task) => task.id === 'tsk_gone');
  const kept = batch.tasks.find((task) => task.id === 'tsk_live');
  assert.ok(['codex-cli', live].includes(gone.queue), `the removed provider's task is in the Codex pool (${gone.queue})`);
  assert.equal(kept.ranOn, live, 'the provider it last ran on comes back with it');
  assert.ok(ran.every((laneId) => ['codex-cli', live].includes(laneId)), JSON.stringify(ran));
  assert.equal(ran.length, 2, 'both run: one on each Codex provider');
  release();
  queueModule.resetGenerationQueueForTests();
});

test('the provider a task ran on is recorded on its order item, for an administrator only', async () => {
  useTempStorage('provider-queues-ran-on');
  const orders = require('../dist/database/orderRepository');
  const order = orders.createOrder(
    { userId: 'u1', batchId: 'bat_ran', label: 'Order', retentionDays: 7 },
    [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: '' }]
  );
  orders.markItemRunning('bat_ran', 0, 'prv-12345678');
  assert.equal(orders.listOrderItems(order.id)[0].ranOn, 'prv-12345678');
  // A retry on another provider names that one: the LAST provider to build it.
  orders.markItemRunning('bat_ran', 0, 'claude-cli');
  assert.equal(orders.listOrderItems(order.id)[0].ranOn, 'claude-cli');
  orders.recordItemOutcome('bat_ran', 0, { state: 'done', taskId: 'tsk', files: [] });
  orders.markItemRunning('bat_ran', 0, 'prv-87654321');
  assert.equal(orders.listOrderItems(order.id)[0].ranOn, 'claude-cli', 'a finished item is not rewritten');
});

test('GET /api/orders/:id names the provider for an administrator, and says nothing of it to anybody else', async () => {
  useTempStorage('provider-queues-order-route');
  const { useAdminEmails } = require('./helpers');
  useAdminEmails('admin@example.com');
  require('../dist/config/aiModelConfig').invalidateSettingsCache();
  const express = require('express');
  const users = require('../dist/database/userRepository');
  const orders = require('../dist/database/orderRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const user = users.createUser({ email: 'user@example.com' });
  const tokens = { admin: users.createSession(admin.id), user: users.createSession(user.id) };
  const placed = {};
  for (const [who, account] of [['admin', admin], ['user', user]]) {
    placed[who] = orders.createOrder({ userId: account.id, batchId: `bat_${who}`, label: 'Order', retentionDays: 7 }, [
      { seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: '' },
    ]);
    orders.markItemRunning(`bat_${who}`, 0, 'claude-cli');
  }

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(attachUser);
  app.use('/api/orders', require('../dist/routes/orders').default);
  const server = app.listen(0);
  try {
    const read = async (who) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/${placed[who].id}`, {
        headers: { authorization: `Bearer ${tokens[who]}` },
      });
      assert.equal(response.status, 200);
      return (await response.json()).items[0];
    };
    assert.deepEqual((await read('admin')).ranOn, { id: 'claude-cli', label: 'Claude (Subscription)', type: 'claude-cli' });
    assert.equal('ranOn' in (await read('user')), false, 'which seat built it is not an ordinary account\'s business');
  } finally {
    server.close();
  }
});

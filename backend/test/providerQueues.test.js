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
 * A dispatcher over a rich reading, every lane's readiness switchable - on
 * the whole seat, or for one model the way a weekly Opus cap holds a Claude
 * seat - and a recorder of which lane ran what and how many ran at once on
 * each. A task's model is its payload's `model`, as the real policy reads its
 * choice's.
 */
function harness(lanes, options = {}) {
  const kind = `provider-queue-${(harnessSeq += 1)}`;
  const notReady = new Set();
  const heldModels = new Map();
  const reading = { lanes };
  const queue = new TaskQueue(async () => reading, undefined, undefined, options.maxAttempts ?? 1, {
    ready: (lane, model) => !notReady.has(lane) && !(model !== undefined && heldModels.get(lane)?.has(model)),
    modelOf: (task) => task.payload.model,
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
  const task = (label, pool = 'claude-cli', model) => ({
    queue: pool,
    label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
    kind,
    payload: model === undefined ? { label } : { label, model },
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
    holdModel: (lane, model) => heldModels.set(lane, new Set([...(heldModels.get(lane) ?? []), model])),
    liftModel: (lane, model) => heldModels.get(lane)?.delete(model),
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

test('a provider held for one model takes none of its work, and its retries and waiting work go to another of the type', async () => {
  // A weekly Opus cap holds the built-in Claude provider for Opus only. It
  // fails every Opus call in microseconds, so by load alone it was the lane
  // every placement, steal and retry chose - and resumes failed on it that
  // the other provider could have built.
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-aaaaaaa1', 'claude-cli', 2)], { maxAttempts: 3 });
  await h.queue.refreshCapacity();
  const first = h.queue.submit(Array.from({ length: 6 }, (_, index) => h.task(`o${index}`, 'claude-cli', 'opus')));
  await settle();
  assert.deepEqual(
    h.started.map((entry) => `${entry.label}@${entry.on}`),
    ['o0@claude-cli', 'o1@prv-aaaaaaa1', 'o2@prv-aaaaaaa1'],
    'before anybody knows of the cap, placement is by load'
  );

  // The first Opus call on claude-cli meets the cap: the seat holds Opus.
  h.holdModel('claude-cli', 'opus');
  h.fail('o0');
  await settle();
  const stats = h.queue.stats();
  assert.equal(stats['claude-cli'].queued, 0, 'its waiting Opus work moved');
  assert.equal(stats['claude-cli'].running, 0, 'and the held provider took none back - not by placement, steal or retry');
  assert.equal(stats['prv-aaaaaaa1'].queued, 4, 'the retry and the moved task wait on the provider that can build them');

  // The seat still serves every other model.
  h.queue.submit([h.task('s0', 'claude-cli', 'sonnet')]);
  await settle();
  assert.ok(h.started.some((entry) => entry.label === 's0' && entry.on === 'claude-cli'), JSON.stringify(h.started));

  // And twenty more Opus resumes, placed while the cap is known: none on it.
  const second = h.queue.submit(Array.from({ length: 20 }, (_, index) => h.task(`p${index}`, 'claude-cli', 'opus')));
  while (h.pendingLabels().length > 0) {
    h.finish(h.pendingLabels()[0]);
    await settle();
  }
  assert.equal(h.queue.snapshot(first.id).completed, 6, 'every one of the first six was built');
  assert.equal(h.queue.snapshot(second.id).completed, 20, 'and all twenty more');
  const opusOnHeld = h.started.filter((entry) => entry.label !== 'o0' && entry.label !== 's0' && entry.on === 'claude-cli');
  assert.deepEqual(opusOnHeld, [], 'no Opus task ran on the provider held for Opus after its first refusal');
  assert.ok(h.peak.get('prv-aaaaaaa1') <= 2, 'the other provider never went past its own limit');
  h.queue.resetForTests();
});

test('work on a model no provider can run waits without holding up the rest, then runs when the hold ends', async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 1)]);
  h.holdModel('claude-cli', 'opus');
  await h.queue.refreshCapacity();
  const batch = h.queue.submit([h.task('opus-1', 'claude-cli', 'opus'), h.task('sonnet-1', 'claude-cli', 'sonnet')]);
  await settle();
  assert.deepEqual(h.started.map((entry) => entry.label), ['sonnet-1'], 'the Sonnet task behind it runs');
  assert.equal(h.queue.snapshot(batch.id).queued, 1, 'the Opus task waits rather than failing into the hold');

  h.finish('sonnet-1');
  h.liftModel('claude-cli', 'opus');
  await h.queue.refreshCapacity();
  await settle();
  assert.deepEqual(h.started.map((entry) => entry.label), ['sonnet-1', 'opus-1']);
  h.queue.resetForTests();
});

test('a retry goes to another provider of its type, not back to the one it just failed on', async () => {
  // A provider that fails fast - at a limit its seat did not recognise - is
  // always the least loaded, so by load alone its failures came straight back
  // to it until the resume ran out of attempts.
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-aaaaaaa2', 'claude-cli', 1)], { maxAttempts: 2 });
  await h.queue.refreshCapacity();
  h.queue.submit([h.task('a'), h.task('b')]);
  await settle();
  assert.deepEqual(h.started.map((entry) => `${entry.label}@${entry.on}`), ['a@claude-cli', 'b@prv-aaaaaaa2']);

  h.fail('a');
  await settle();
  assert.equal(h.started.length, 2, 'the idle provider it failed on does not take it back');
  assert.equal(h.queue.stats()['prv-aaaaaaa2'].queued, 1, 'it waits for the other');

  // The idle one still takes other work.
  h.queue.submit([h.task('c')]);
  await settle();
  assert.deepEqual(h.started.slice(2).map((entry) => `${entry.label}@${entry.on}`), ['c@claude-cli']);

  h.finish('b');
  await settle();
  assert.deepEqual(h.started.slice(3).map((entry) => `${entry.label}@${entry.on}`), ['a@prv-aaaaaaa2']);
  h.queue.resetForTests();
});

test('an idle lane of another pool read first does not stop a later pool from stealing', async () => {
  // The Claude lane is first in the reading, serving, idle and with no Claude
  // work anywhere. That once ended the whole steal pass, so an idle Codex
  // provider sat beside Codex work waiting on the other.
  const h = harness([
    lane('claude-cli', 'claude-cli', 1),
    lane('codex-cli', 'codex-cli', 1),
    lane('prv-0000000c', 'codex-cli', 1),
  ]);
  await h.queue.refreshCapacity();
  h.queue.submit(['x0', 'x1', 'x2', 'x3'].map((label) => h.task(label, 'codex-cli')));
  await settle();
  // x0 and x2 placed on codex-cli, x1 and x3 on prv-0000000c.
  h.finish('x0');
  await settle();
  h.finish('x2');
  await settle();
  assert.ok(
    h.started.some((entry) => entry.label === 'x3' && entry.on === 'codex-cli'),
    `x3 is taken by the idle Codex provider: ${JSON.stringify(h.started)}`
  );
  h.queue.resetForTests();
});

test('a limit lowered while busy starts nothing new until the lane is under it, and raised fills only the room', async () => {
  // Slot ids are not the limit: after 3 -> 1 two tasks still run on slots the
  // reading no longer lists, and a freed slot 0 starting a third beside them
  // put it at the resized semaphore with its clock running.
  const h = harness([lane('claude-cli', 'claude-cli', 3)]);
  await h.queue.refreshCapacity();
  h.queue.submit(['t0', 't1', 't2', 't3', 't4'].map((label) => h.task(label)));
  await settle();
  assert.equal(h.started.length, 3);

  h.reading.lanes = [lane('claude-cli', 'claude-cli', 1)];
  await h.queue.refreshCapacity();
  h.finish('t0');
  await settle();
  assert.equal(h.started.length, 3, 'two still run at width 1: nothing new');
  assert.deepEqual(h.queue.stats()['claude-cli'], { queued: 2, running: 2, width: 1, pool: 'claude-cli', serving: true });
  h.finish('t1');
  await settle();
  assert.equal(h.started.length, 3, 'one still runs at width 1: nothing new');
  h.finish('t2');
  await settle();
  assert.equal(h.started.length, 4, 'under the limit again: one starts');
  assert.equal(h.queue.stats()['claude-cli'].running, 1);

  h.reading.lanes = [lane('claude-cli', 'claude-cli', 3)];
  await h.queue.refreshCapacity();
  await settle();
  assert.equal(h.started.length, 5, 'raised to three: the one waiting starts beside it');
  assert.equal(h.peak.get('claude-cli'), 3);
  h.queue.resetForTests();
});

test('a lane shrunk while busy does not steal past its new limit either', async () => {
  const h = harness([lane('claude-cli', 'claude-cli', 3), lane('prv-aaaaaaa3', 'claude-cli', 1)]);
  await h.queue.refreshCapacity();
  // Three running on claude-cli and nothing waiting there ...
  h.hold('prv-aaaaaaa3');
  h.queue.submit(['a0', 'a1', 'a2'].map((label) => h.task(label)));
  await settle();
  // ... and the other lane busy with two waiting behind it.
  h.lift('prv-aaaaaaa3');
  h.hold('claude-cli');
  h.queue.submit(['b0', 'b1', 'b2'].map((label) => h.task(label)));
  await settle();
  assert.deepEqual(h.started.map((entry) => entry.on), ['claude-cli', 'claude-cli', 'claude-cli', 'prv-aaaaaaa3']);

  h.lift('claude-cli');
  h.reading.lanes = [lane('claude-cli', 'claude-cli', 1), lane('prv-aaaaaaa3', 'claude-cli', 1)];
  await h.queue.refreshCapacity();
  h.finish('a0');
  await settle();
  assert.equal(h.started.length, 4, 'two still run on the shrunk lane: it takes nothing from the other');
  h.finish('a1');
  await settle();
  assert.equal(h.started.length, 4);
  h.finish('a2');
  await settle();
  assert.deepEqual(h.started.slice(4).map((entry) => `${entry.label}@${entry.on}`), ['b1@claude-cli'], 'one, at width 1');

  h.reading.lanes = [lane('claude-cli', 'claude-cli', 3), lane('prv-aaaaaaa3', 'claude-cli', 1)];
  await h.queue.refreshCapacity();
  await settle();
  assert.deepEqual(h.started.slice(5).map((entry) => `${entry.label}@${entry.on}`), ['b2@claude-cli'], 'raised: it takes the rest');
  h.queue.resetForTests();
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
  // Set again by the re-run itself (TaskQueue.start), so this says only that
  // it ran where it was; that a stored ranOn is READ back is the restored
  // finished task's test below.
  assert.equal(kept.ranOn, live, 'it runs again on the provider it was waiting for');
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

test("the real queue reads a provider's hold on a task's model: Opus work goes to the other Claude provider, Sonnet still runs on it", async () => {
  const savedConcurrency = process.env.AI_CLI_CONCURRENCY;
  process.env.AI_CLI_CONCURRENCY = '1';
  const { home, config, queueModule } = realQueueInstall('model-hold');
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  try {
    const { provider } = await config.createAIProvider({
      type: 'claude-cli',
      label: 'Claude B',
      homeDir: home,
      concurrency_max_requests: 2,
    });
    // The built-in seat under a weekly Opus cap, as its outage table reads
    // it: held for Opus only. Readiness asked about no model says nothing.
    const stub = (id, heldModel) => () => ({
      id: 'claude-cli',
      instanceId: id,
      capabilities: { id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 2 },
      defaultModelName: () => 'sonnet',
      health: async () => ({ ok: true, detail: 'stub', checkedAt: '' }),
      readiness: (model) => ({
        ready: true,
        held: model === heldModel ? { kind: 'rateLimited', reason: 'seven_day_opus', until: '' } : null,
      }),
      complete: async () => {
        throw new Error('not called: the task runner is stubbed');
      },
    });
    ai.registerAdapter('claude-cli', stub('claude-cli', 'opus'));
    ai.registerAdapter(provider.id, stub(provider.id, null));
    assert.equal(queueModule.taskModelName({ choice: { provider: 'claude-cli', modelName: 'opus' } }), 'opus');
    assert.equal(queueModule.taskModelName({ choice: { provider: 'claude-cli' } }), '', 'the default model');
    assert.equal(queueModule.taskModelName({}), undefined, 'no choice: the seat only');

    const queue = queueModule.getGenerationQueue();
    const ran = [];
    queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload, assignment) => {
      ran.push(`${payload.label}:${payload.choice.modelName}@${assignment.queue}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {};
    });
    const task = (label, modelName) => ({
      queue: 'claude-cli',
      label: { profileId: label, profileName: label, companyName: 'Acme', role: '' },
      kind: queueModule.RESUME_TASK_KIND,
      payload: { label, choice: { provider: 'claude-cli', modelName, modelId: `m-${modelName}`, modelLabel: modelName }, costMilli: 0 },
    });
    // Submitted cold - before the queue's first reading, so they wait in the
    // pool's lane and are moved by `rebalance` - and once more after it, so
    // `place` decides.
    const cold = queue.submit(Array.from({ length: 6 }, (_, index) => task(`c${index}`, 'opus')));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const warm = queue.submit([...Array.from({ length: 4 }, (_, index) => task(`w${index}`, 'opus')), task('s0', 'sonnet')]);
    for (let wait = 0; wait < 100 && (queue.getBatch(warm.id).state === 'running' || queue.getBatch(cold.id).state === 'running'); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(queue.snapshot(cold.id).completed, 6);
    assert.equal(queue.snapshot(warm.id).completed, 5);
    const opus = ran.filter((entry) => entry.includes(':opus@'));
    assert.equal(opus.length, 10);
    assert.ok(opus.every((entry) => entry.endsWith(`@${provider.id}`)), JSON.stringify(ran));
    assert.ok(ran.includes('s0:sonnet@claude-cli'), `the held seat still builds Sonnet: ${JSON.stringify(ran)}`);
  } finally {
    if (savedConcurrency === undefined) delete process.env.AI_CLI_CONCURRENCY;
    else process.env.AI_CLI_CONCURRENCY = savedConcurrency;
    queueModule.resetGenerationQueueForTests();
    ai.resetRegistryForTests();
  }
});

/* ------------------------------------- real provider state, the real queue */

/**
 * A stub provider whose readiness and health a test switches: `state.ready`
 * (null until a check, false = its last check found it signed out),
 * `state.held` (a seat-wide hold), and `state.healthFlipsReady` (its next
 * health check finds it signed in).
 */
function switchableSeat(id, state) {
  return () => ({
    id,
    capabilities: { id, label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'none', systemBlocks: true, maxConcurrency: 1 },
    defaultModelName: () => 'default',
    health: async () => {
      state.healthCalls = (state.healthCalls ?? 0) + 1;
      if (state.healthFlipsReady) state.ready = true;
      return { ok: state.ready !== false, detail: 'stub', checkedAt: new Date().toISOString() };
    },
    readiness: () => ({
      ready: state.ready ?? null,
      held: state.held ? { kind: 'rateLimited', reason: 'stub hold', until: '' } : null,
    }),
    complete: async () => {
      throw new Error('not called: the task runner is stubbed');
    },
  });
}

/** Hand-driven tasks on the real queue: each runs until the test resolves it. */
function heldRunner(queueModule, kind) {
  const running = new Map();
  queueModule.registerTaskRunner(kind, (payload, assignment) =>
    new Promise((resolve) => running.set(payload.label, { resolve, on: assignment.queue }))
  );
  const task = (label, pool = 'claude-cli') => ({
    queue: pool,
    label: { profileId: label, profileName: label, companyName: 'Acme', role: '' },
    kind,
    payload: { label },
  });
  return { running, task };
}

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("the real queue reads a provider's seat-wide hold off its adapter: its waiting work moves - written where it moved - and it takes nothing more", async (t) => {
  const { home, config, queueModule } = realQueueInstall('seat-hold');
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  t.after(() => {
    queueModule.resetGenerationQueueForTests();
    ai.resetRegistryForTests();
  });
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Two', homeDir: home, concurrency_max_requests: 1 });
  await config.updateAIProvider('claude-cli', { concurrency_max_requests: 1 });
  const added = {};
  ai.registerAdapter('claude-cli', switchableSeat('claude-cli', {}));
  ai.registerAdapter('codex-cli', switchableSeat('codex-cli', {}));
  ai.registerAdapter('gemini-cli', switchableSeat('gemini-cli', {}));
  ai.registerAdapter(provider.id, switchableSeat(provider.id, added));

  const queue = queueModule.getGenerationQueue();
  const { running, task } = heldRunner(queueModule, 'provider-seat-hold');
  await queue.refreshCapacity();
  queue.submit(['a', 'b', 'c', 'd'].map((label) => task(label)), { id: 'bat_seat_hold' });
  await pause();
  assert.equal(queue.stats()[provider.id].queued, 1, 'one running and one waiting on each provider');

  // What the adapter says once a usage limit holds it: the queue reads it
  // through the lane policy at the next dispatch.
  added.held = true;
  await queue.refreshCapacity();
  await pause();
  assert.equal(queue.stats()[provider.id].queued, 0, "the held provider's waiting task moved");
  assert.equal(queue.stats()['claude-cli'].queued, 2);
  const store = require('../dist/database/generationRepository');
  const rows = store.loadBatchRows().find((row) => row.id === 'bat_seat_hold').tasks;
  const waiting = rows.filter((row) => row.state === 'queued');
  assert.equal(waiting.length, 2);
  assert.ok(
    waiting.every((row) => row.data.queue === 'claude-cli'),
    `a restart finds the moved task where it moved: ${JSON.stringify(waiting.map((row) => row.data.queue))}`
  );

  const onHeld = [...running.entries()].find(([, entry]) => entry.on === provider.id);
  onHeld[1].resolve({});
  await pause();
  assert.equal(queue.stats()[provider.id].running, 0, 'its slot came free, and a held provider takes nothing');
});

test('a provider its last check found signed out is asked again by the queue\'s reading, and serves once it answers', async (t) => {
  const { home, config, queueModule } = realQueueInstall('signed-out');
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  t.after(() => {
    queueModule.resetGenerationQueueForTests();
    ai.resetRegistryForTests();
  });
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Two', homeDir: home, concurrency_max_requests: 1 });
  const added = { ready: false, healthFlipsReady: true };
  // The built-in is held, so only the added provider can take the work.
  ai.registerAdapter('claude-cli', switchableSeat('claude-cli', { held: true }));
  ai.registerAdapter('codex-cli', switchableSeat('codex-cli', {}));
  ai.registerAdapter('gemini-cli', switchableSeat('gemini-cli', {}));
  ai.registerAdapter(provider.id, switchableSeat(provider.id, added));

  const queue = queueModule.getGenerationQueue();
  const { running, task } = heldRunner(queueModule, 'provider-signed-out');
  queue.submit([task('x')]);
  await pause();
  assert.ok(added.healthCalls >= 1, 'the reading asked the signed-out provider - nothing else would until an admin looked');
  assert.equal(added.ready, true);
  await queue.refreshCapacity();
  await pause();
  assert.equal(running.get('x')?.on, provider.id, 'and it took the work once signed in');
  running.get('x').resolve({});
});

test('a type switched off under Admin -> Settings stops every lane of it serving in the real reading', async () => {
  const { home, config, queueModule } = realQueueInstall('type-off');
  const { provider } = await config.createAIProvider({ type: 'gemini-cli', label: 'Gemini two', homeDir: home, concurrency_max_requests: 1 });
  const settings = await config.getAppSettings();
  await config.updateAppSettings({ providersEnabled: { ...settings.providersEnabled, 'gemini-cli': false } });
  const { lanes } = await queueModule.readCapacityForTests({});
  const gemini = lanes.filter((entry) => entry.pool === 'gemini-cli');
  assert.deepEqual(
    gemini.map((entry) => [entry.id, entry.enabled]),
    [['gemini-cli', false], [provider.id, false]],
    'the built-in and the added one alike: the type does not run'
  );
  assert.ok(lanes.filter((entry) => entry.pool === 'claude-cli').every((entry) => entry.enabled), 'the other types still do');
});

test("a queued resume's model calls go to the provider whose lane it holds, not to whichever looks least busy", async (t) => {
  const savedConcurrency = process.env.AI_CLI_CONCURRENCY;
  process.env.AI_CLI_CONCURRENCY = '1';
  const { serveInstall, posting, untilFinished } = require('./analysisHarness');
  const h = await serveInstall('provider-pin');
  require('../dist/config/aiProviders').resetProviderSnapshotForTests();
  t.after(() => {
    if (savedConcurrency === undefined) delete process.env.AI_CLI_CONCURRENCY;
    else process.env.AI_CLI_CONCURRENCY = savedConcurrency;
    h.close();
  });
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'provider-pin-home-'));
  const { provider } = await h.config.createAIProvider({ type: 'claude-cli', label: 'Claude B', homeDir: home, concurrency_max_requests: 1 });
  const ai = require('../dist/services/ai/index');
  const inner = ai.getAdapter('claude-cli');
  const answered = [];
  const tagged = (id) => () => ({
    ...inner,
    async complete(request) {
      answered.push({ by: id, callSite: request.callSite });
      return inner.complete(request);
    },
  });
  ai.registerAdapter('claude-cli', tagged('claude-cli'));
  ai.registerAdapter(provider.id, tagged(provider.id));

  const response = await h.post('/generation/batches', {
    mode: 'order',
    format: 'pdf',
    includeCoverLetterDocx: false,
    profileIds: ['p-claude'],
    jobs: [
      { companyName: 'Acme', role: 'Engineer', jobDescription: posting(61) },
      { companyName: 'Globex', role: 'Engineer', jobDescription: posting(62) },
    ],
  });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const snapshot = await untilFinished(response.body.batchId);
  assert.equal(snapshot.completed, 2, JSON.stringify(snapshot.tasks.map((task) => task.error)));

  const lanes = h.queue.getGenerationQueue().getBatch(response.body.batchId).tasks.map((task) => task.ranOn).sort();
  assert.deepEqual(lanes, ['claude-cli', provider.id].sort(), 'one resume on each provider');
  // Unpinned, every call would pick the built-in - both look idle, and ties go
  // to list order - and the added provider's lane slot would buy nothing.
  const tailoredBy = answered.filter((call) => call.callSite === 'tailor-resume').map((call) => call.by).sort();
  assert.deepEqual(tailoredBy, lanes, 'each tailored on the provider it ran on');
});

test('work no provider can take asks again on its own after the re-check interval', async (t) => {
  // Nothing else wakes it: with every lane of the pool out and nothing
  // running, no task settles and no dispatch runs, so a hold that ends by
  // itself would leave the work queued for ever.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => {
    for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const h = harness([lane('claude-cli', 'claude-cli', 1), lane('prv-abababab', 'claude-cli', 1)]);
  h.hold('claude-cli');
  h.hold('prv-abababab');
  await h.queue.refreshCapacity();
  h.queue.submit([h.task('a')]);
  await flush();
  assert.equal(h.started.length, 0, 'every provider of the type is out');

  h.lift('prv-abababab');
  await flush();
  assert.equal(h.started.length, 0, 'nothing notices the hold ending');
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(h.started, [{ label: 'a', on: 'prv-abababab' }], 'the re-check did');
  h.queue.resetForTests();
});

test("an idle provider steals an urgent task before a busier lane's ordinary one", async () => {
  const h = harness([
    lane('claude-cli', 'claude-cli', 1),
    lane('prv-a1a1a1a1', 'claude-cli', 1),
    lane('prv-c1c1c1c1', 'claude-cli', 1),
  ]);
  // The thief is out until the end; prv-a is held for the "big" model, so
  // the big work all lines up on the built-in.
  h.hold('prv-c1c1c1c1');
  h.holdModel('prv-a1a1a1a1', 'big');
  await h.queue.refreshCapacity();
  h.queue.submit(['o1', 'o2', 'o3', 'o4'].map((label) => h.task(label, 'claude-cli', 'big')));
  await settle();
  h.queue.submit([h.task('x1', 'claude-cli', 'small')]);
  await settle();
  h.queue.submit([h.task('u1', 'claude-cli', 'small')], { urgent: true });
  await settle();
  assert.deepEqual(
    h.started.map((entry) => `${entry.label}@${entry.on}`),
    ['o1@claude-cli', 'x1@prv-a1a1a1a1'],
    'o2-o4 wait on the built-in (the busier lane), u1 behind x1 on prv-a'
  );

  h.lift('prv-c1c1c1c1');
  await h.queue.refreshCapacity();
  await settle();
  assert.deepEqual(h.started.at(-1), { label: 'u1', on: 'prv-c1c1c1c1' }, 'urgent first, wherever it waits');
  h.queue.resetForTests();
});

test('a restored FINISHED task keeps the provider it ran on, read back from its stored row', async () => {
  const { home, config, queueModule } = realQueueInstall('restore-done');
  const { provider } = await config.createAIProvider({ type: 'codex-cli', label: 'Codex two', homeDir: home, concurrency_max_requests: 1 });
  const store = require('../dist/database/generationRepository');
  const choice = { provider: 'codex-cli', modelName: 'default', modelId: 'codex-cli-default', modelLabel: 'Codex' };
  const label = (company) => ({ profileId: 'p1', profileName: 'Ada', companyName: company, role: '' });
  store.saveBatchWithTasks(
    { id: 'bat_done', state: 'running', data: { label: 'Before', jobCount: 2, shared: { jobs: [] }, createdAt: Date.now() } },
    [
      {
        id: 'tsk_done', batchId: 'bat_done', seq: 0, state: 'done',
        data: { queue: provider.id, label: label('A'), kind: 'resume', payload: { batchId: 'bat_done', choice, costMilli: 0 }, value: {}, ranOn: provider.id },
      },
      {
        id: 'tsk_waiting', batchId: 'bat_done', seq: 1, state: 'queued',
        data: { queue: 'codex-cli', label: label('B'), kind: 'resume', payload: { batchId: 'bat_done', choice, costMilli: 0 } },
      },
    ]
  );
  // Created first: it registers the real resume runner, which would replace
  // one registered before it.
  const queue = queueModule.getGenerationQueue();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async () => {
    await held;
    return {};
  });
  await queueModule.restoreGenerationQueue();
  await pause();
  const done = queue.getBatch('bat_done').tasks.find((task) => task.id === 'tsk_done');
  release();
  queueModule.resetGenerationQueueForTests();
  assert.equal(done.state, 'done');
  assert.equal(done.ranOn, provider.id, 'it never runs again, so this can only be the stored ranOn');
});

test('a task the real queue starts writes the provider to its stored row and to its order item', async () => {
  const { queueModule } = realQueueInstall('ran-on-wiring');
  const orders = require('../dist/database/orderRepository');
  const store = require('../dist/database/generationRepository');
  const order = orders.createOrder(
    { userId: 'u1', batchId: 'bat_ran_wiring', label: 'Order', retentionDays: 7 },
    [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: '' }]
  );
  const queue = queueModule.getGenerationQueue();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async () => {
    started();
    await held;
    return {};
  });
  const choice = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'claude-cli-sonnet', modelLabel: 'Sonnet' };
  queue.submit(
    [{
      queue: 'claude-cli',
      label: { profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: '' },
      kind: queueModule.RESUME_TASK_KIND,
      payload: { batchId: 'bat_ran_wiring', choice, costMilli: 0 },
    }],
    { id: 'bat_ran_wiring', shared: { kind: 'order' } }
  );
  await running;
  await pause();
  const row = store.loadBatchRows().find((batch) => batch.id === 'bat_ran_wiring').tasks[0];
  const item = orders.listOrderItems(order.id)[0];
  release();
  await pause();
  queueModule.resetGenerationQueueForTests();
  assert.equal(row.data.ranOn, 'claude-cli', "taskRow's projection names it");
  assert.equal(item.ranOn, 'claude-cli', 'and the taskStarted hook hands it to the order item');
});

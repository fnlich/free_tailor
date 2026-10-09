const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';
process.env.GENERATION_MAX_ATTEMPTS = '1';
// One slot, so "one running, the rest queued" is a fact rather than a race.
process.env.AI_CLI_CONCURRENCY = '1';

const { useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * Generate Immediately, through the routes (owner decisions B4 and M4).
 *
 * An immediate run is a queued batch of kind `immediate`:
 *   - it is tied to the tab that started it - the tab's stream holds a lease,
 *     and a tab gone longer than IMMEDIATE_TAB_GRACE_MS gets the run
 *     cancelled, with what had not started refunded; a page that knows it is
 *     leaving releases it at once;
 *   - it is filed with an `orders` row of kind `immediate`, so its files live
 *     under the order tree, are downloaded one by one through an owner-checked
 *     route, and are deleted IMMEDIATE_FILE_RETENTION_MS after the run ends,
 *     downloaded or not - and it is never listed on /orders;
 *   - its tasks go ahead of orders in their lane (queuePriority.test.js).
 *
 * The lease on its own, with every timing case, is tabLease.test.js; this is
 * who holds it and what the routes do with it. No resume is really built: a
 * stub runner stands in for the resume task, held until the test delivers it
 * (writing real files) or the batch's abort reaches it.
 */

const config = require('../dist/config/aiModelConfig');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const orders = require('../dist/database/orderRepository');
const generationStore = require('../dist/database/generationRepository');
const queueModule = require('../dist/services/queue/index');
const retention = require('../dist/services/orders/retention');
const refunds = require('../dist/services/refunds');
const refundDb = require('../dist/database/refundRequestRepository');
const sqlite = require('../dist/database/sqlite');
const { seedRefundRequest } = require('./refundSeed');
const { LEASE_READER_LIFETIME_MS } = require('../dist/services/queue/tabLease');

function profileInput(name) {
  return {
    name,
    title: 'Engineer',
    skills: ['C#'],
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 's',
    experience: [],
    strengths: [],
    education: [],
  };
}

function jobsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${index}`,
    role: 'Engineer',
    jobDescription: 'short',
  }));
}

/** Polls without setTimeout, which a test may have handed to the mock clock. */
async function until(check, what) {
  for (let i = 0; i < 5_000; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function serve(name) {
  const { rootDir, dbDir } = useTempStorage(`immediate-runs-${name}`);
  const outputBaseDir = path.join(rootDir, 'generated');
  fs.mkdirSync(outputBaseDir, { recursive: true });
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ outputBaseDir }));
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  saveProfile({ ...buildNewProfile(profileInput('Ada'), 'p-alice'), ownerId: alice.id });
  saveProfile({ ...buildNewProfile(profileInput('Bo'), 'p-bob'), ownerId: bob.id });
  // $0.010 a resume, from $1.000: every refund below is an exact figure.
  await config.updateAIModel('claude-cli-sonnet', { pricePerResumeUsd: '0.010' });
  credits.setBalance(alice.id, 1_000, admin.id);
  credits.setBalance(bob.id, 1_000, admin.id);

  // The stub resume runner: each task waits to be delivered, and gives up
  // when its batch is aborted, as the real one does.
  const pending = new Map();
  queueModule.getGenerationQueue();
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, (payload, assignment) => {
    const key = `${payload.batchId}:${payload.jobIndex}`;
    return new Promise((resolve, reject) => {
      pending.set(key, { payload, resolve });
      assignment.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const deliver = (batchId, jobIndex) => {
    const entry = pending.get(`${batchId}:${jobIndex}`);
    if (!entry) throw new Error(`task ${batchId}:${jobIndex} is not running`);
    pending.delete(`${batchId}:${jobIndex}`);
    const folder = `${entry.payload.accountFolder}/${entry.payload.orderNumber}/${jobIndex}`;
    fs.mkdirSync(path.join(outputBaseDir, folder), { recursive: true });
    fs.writeFileSync(path.join(outputBaseDir, folder, 'Ada.pdf'), `resume ${jobIndex}`);
    fs.writeFileSync(path.join(outputBaseDir, folder, 'Ada_cover_letter.pdf'), `letter ${jobIndex}`);
    entry.resolve({
      profileId: 'p-alice',
      profileName: 'Ada',
      companyName: `Company ${jobIndex}`,
      role: 'Engineer',
      pdf: `${folder}/Ada.pdf`,
      coverLetterPdf: `${folder}/Ada_cover_letter.pdf`,
      tailored: false,
      unconfirmedHardSkills: [],
      unconfirmedSoftSkills: [],
    });
  };

  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
  };
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  app.use('/api/orders', require('../dist/routes/orders').default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = (who, route, init = {}) =>
    fetch(`${base}${route}`, {
      ...init,
      headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(init.headers ?? {}) },
    });
  const post = async (who, route, body) => {
    const response = await call(who, route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  };

  const queue = () => queueModule.getGenerationQueue();
  return {
    base,
    admin,
    alice,
    bob,
    tokens,
    outputBaseDir,
    call,
    post,
    deliver,
    queue,
    leases: () => queueModule.getTabLeases(),
    balance: (account) => users.getUserById(account.id).balanceMilli,
    /** Opens the stream and reads its first line; returns the reader, to cancel. */
    async attach(who, batchId, tab) {
      const response = await call(who, `/generation/batches/${batchId}/stream${tab === undefined ? '' : `?tab=${tab}`}`);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]);
      assert.equal(first.type, 'snapshot');
      return reader;
    },
    async untilState(batchId, state) {
      await until(() => queue().getBatch(batchId)?.state === state, `${batchId} to be ${state}`);
    },
    close: () => {
      // Every connection, the progress streams included: a test that fails
      // with a stream still open would otherwise hold the process for ever.
      server.closeAllConnections();
      server.close();
      queueModule.resetGenerationQueueForTests();
    },
  };
}

test('a run is Generate Immediately unless it says it is an order, and only an order is listed', async () => {
  const server = await serve('kinds');
  try {
    const immediate = await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], tabId: 'tab-a' });
    assert.equal(immediate.status, 202, JSON.stringify(immediate.body));
    assert.equal(immediate.body.kind, 'immediate');
    assert.equal(immediate.body.orderId, undefined, 'nobody ordered it, so nothing names an order');
    assert.equal(immediate.body.orderNumber, undefined);

    const batch = server.queue().getBatch(immediate.body.batchId);
    assert.equal(batch.shared.kind, 'immediate');
    assert.equal(batch.shared.tabId, 'tab-a');
    assert.equal(batch.urgent, true, 'ahead of orders on its seat');

    // Filed with an order row of its own kind - and hidden.
    const row = orders.findOrderForBatch(immediate.body.batchId);
    assert.equal(row.kind, 'immediate');
    assert.match(row.number, /^FT-RUN-\d{8}-\d{4}$/);
    assert.deepEqual(orders.listOrdersForUser(server.alice.id), []);
    assert.deepEqual((await (await server.call('alice', '/orders')).json()).orders, []);
    assert.equal((await server.call('alice', `/orders/${row.id}`)).status, 404);
    assert.equal((await server.post('alice', `/orders/${row.id}/cancel`)).status, 404);

    // `mode: 'order'` and the older `asOrder: true` both place an order.
    for (const asked of [{ mode: 'order' }, { asOrder: true }, { mode: 'order', tabId: 'ignored' }]) {
      const ordered = await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], ...asked });
      assert.equal(ordered.status, 202);
      assert.equal(ordered.body.kind, 'order', JSON.stringify(asked));
      assert.match(ordered.body.orderNumber, /^FT-\d{8}-\d{4}$/);
      const orderBatch = server.queue().getBatch(ordered.body.batchId);
      assert.equal(orderBatch.urgent, undefined);
      assert.equal(orderBatch.shared.tabId, undefined, 'an order is not tied to a tab');
      assert.equal(server.leases().state(ordered.body.batchId), null, 'and holds no lease');
    }
    assert.equal(orders.listOrdersForUser(server.alice.id).length, 3);

    // `mode` wins over `asOrder`, and a mode nobody meant is refused, not guessed.
    const explicit = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(1),
      profileIds: ['p-alice'],
      mode: 'immediate',
      asOrder: true,
    });
    assert.equal(explicit.body.kind, 'immediate');
    const junk = await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], mode: 'later' });
    assert.equal(junk.status, 400);
    assert.match(junk.body.error, /mode must be "immediate" or "order"/);
    const badTab = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(1),
      profileIds: ['p-alice'],
      tabId: 'not a tab id!',
    });
    assert.equal(badTab.status, 400);
    assert.match(badTab.body.error, /tabId/);
  } finally {
    server.close();
  }
});

test('the lease is armed at submit, held by the run\'s own tab, and by nobody else', async () => {
  const server = await serve('holders');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(2), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    // A tab that never attaches must not leave the run building for nobody.
    assert.deepEqual(server.leases().state(id), { readers: 0, armed: true });

    // Another tab of the same account reads, and holds nothing.
    const otherTab = await server.attach('alice', id, 'tab-b');
    const noTab = await server.attach('alice', id);
    assert.deepEqual(server.leases().state(id), { readers: 0, armed: true });

    // The run's own tab holds it, and the timer stops.
    const ownTab = await server.attach('alice', id, 'tab-a');
    assert.deepEqual(server.leases().state(id), { readers: 1, armed: false });

    // An administrator may watch the run, but never keeps it alive.
    const adminTab = await server.attach('admin', id, 'tab-a');
    assert.deepEqual(server.leases().state(id), { readers: 1, armed: false });

    for (const reader of [otherTab, noTab, adminTab]) await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(server.leases().state(id), { readers: 1, armed: false }, 'their leaving changes nothing');

    // The own tab leaving starts the grace; it does not stop anything yet.
    await ownTab.cancel();
    await until(() => server.leases().state(id)?.armed === true, 'the grace to start');
    assert.equal(server.queue().getBatch(id).state, 'running');

    // A reload inside the grace reattaches, and the timer stops again.
    const reloaded = await server.attach('alice', id, 'tab-a');
    assert.deepEqual(server.leases().state(id), { readers: 1, armed: false });
    await reloaded.cancel();
  } finally {
    server.close();
  }
});

test('an order, or a run from before kinds, is never held by its stream - leaving it stops nothing', async (t) => {
  const server = await serve('order-readers');
  try {
    const ordered = await server.post('alice', '/generation/batches', { jobs: jobsFor(2), profileIds: ['p-alice'], mode: 'order' });
    const orderId = ordered.body.batchId;
    await until(() => server.queue().getBatch(orderId).tasks[0].state === 'running', 'the order to start');

    // A run queued by a build from before kinds - neither an order nor an
    // immediate run, and never armed by the restore. Made by taking the kind
    // off a fresh run (and its submit-time timer with it).
    const older = await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'] });
    const olderId = older.body.batchId;
    delete server.queue().getBatch(olderId).shared.kind;
    server.leases().forget(olderId);

    // The owner follows both - with no tab, which is what a script or an
    // older page sends and what a run submitted without a tab id matches, and
    // with one. Neither stream holds anything.
    const readers = [];
    for (const id of [orderId, olderId]) {
      readers.push(await server.attach('alice', id));
      readers.push(await server.attach('alice', id, 'tab-x'));
      assert.equal(server.leases().state(id), null, `${id} is held by nobody`);
    }

    // Every reader leaves, and the clock goes well past the lifetime and the grace.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const reader of readers) await reader.cancel();
    for (let i = 0; i < 200; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(LEASE_READER_LIFETIME_MS + 30_000 + 1);
    t.mock.timers.reset();
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));

    for (const id of [orderId, olderId]) {
      assert.equal(server.queue().getBatch(id).state, 'running', `${id} goes on with nobody watching`);
      assert.equal(server.leases().state(id), null);
    }
    assert.equal(orders.findOrderForBatch(orderId).state, 'running');
  } finally {
    server.close();
  }
});

test('a tab whose connection vanished without closing is counted out by the clock, and its run stops', async (t) => {
  const server = await serve('silent-drop');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(2), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    assert.equal(server.balance(server.alice), 980);
    await until(() => server.queue().getBatch(id).tasks[0].state === 'running', 'the first resume to start');

    // The clock is the test's from before the attach, so the hold's own timer is mocked.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // The run's own tab attaches - and then neither reads nor closes: a laptop
    // whose lid shut, a phone that left coverage. No `close` ever reaches the
    // server; only the hold's lifetime can count it out.
    const reader = await server.attach('alice', id, 'tab-a');
    assert.deepEqual(server.leases().state(id), { readers: 1, armed: false });

    t.mock.timers.tick(LEASE_READER_LIFETIME_MS - 1);
    assert.deepEqual(server.leases().state(id), { readers: 1, armed: false });
    t.mock.timers.tick(1);
    assert.deepEqual(server.leases().state(id), { readers: 0, armed: true }, 'counted out, and the grace starts');
    // The server ended the stream itself; a page that was still there would read
    // this end and attach again.
    let ended = false;
    void (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      ended = true;
    })().catch(() => undefined);
    await until(() => ended, 'the server to end the stream');

    t.mock.timers.tick(29_999);
    assert.equal(server.queue().getBatch(id).state, 'running', 'not a moment early');
    t.mock.timers.tick(1);
    t.mock.timers.reset();

    await server.untilState(id, 'cancelled');
    await until(() => server.balance(server.alice) === 1_000, 'both resumes refunded');
  } finally {
    server.close();
  }
});

test("a stream that ended on its own unsubscribing again never takes a newer reader's updates", async () => {
  const server = await serve('unsubscribe-twice');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(2), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    await until(() => server.queue().getBatch(id).tasks[0].state === 'running', 'the first resume to start');

    // What a renewed stream does: the old one unsubscribes when its hold runs
    // out, the page attaches again, and the old connection's `close` then
    // unsubscribes a second time.
    const queue = server.queue();
    const unsubscribeOld = queue.subscribe(id, () => {});
    unsubscribeOld();
    const heard = [];
    const unsubscribeNew = queue.subscribe(id, (event) => heard.push(event.type));
    unsubscribeOld();

    server.deliver(id, 0);
    await until(() => heard.length > 0, 'the new reader to hear the resume land');
    assert.equal(heard[0], 'task');
    unsubscribeNew();
  } finally {
    server.close();
  }
});

test('a tab gone past the grace stops the run, and what had not started is refunded exactly', async (t) => {
  const server = await serve('grace');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(3), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    assert.equal(server.balance(server.alice), 970, 'three resumes at $0.010 reserved');
    await until(() => server.queue().getBatch(id).tasks[0].state === 'running', 'the first resume to start');

    // One resume is delivered while the tab is there: that one stays charged.
    server.deliver(id, 0);
    await until(() => server.queue().getBatch(id).tasks[1].state === 'running', 'the second resume to start');

    const reader = await server.attach('alice', id, 'tab-a');
    // The clock is the test's from here: the next timer the lease starts is mocked.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await reader.cancel();
    await until(() => server.leases().state(id)?.armed === true, 'the grace to start');

    t.mock.timers.tick(29_999);
    assert.equal(server.queue().getBatch(id).state, 'running', 'not a moment early');
    t.mock.timers.tick(1);
    t.mock.timers.reset();

    await server.untilState(id, 'cancelled');
    const snapshot = server.queue().snapshot(id);
    assert.equal(snapshot.completed, 1);
    assert.equal(snapshot.cancelled, 2, 'the running one aborted, the queued one dropped');
    // $0.030 charged, $0.020 back: only the delivered resume is paid for.
    await until(() => server.balance(server.alice) === 990, 'the refunds');
    await until(() => orders.findOrderForBatch(id).state === 'done', 'the run\'s row to settle');
    assert.ok(orders.findOrderForBatch(id).finishedAt, 'its end is what its files are kept from');
  } finally {
    server.close();
  }
});

test('release stops the run at once - the owner\'s own tab only, with the cookie alone', async () => {
  const server = await serve('release');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(2), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    const ordered = await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], mode: 'order' });
    await until(() => server.queue().getBatch(id).tasks[0].state === 'running', 'the run to start');
    assert.equal(server.balance(server.alice), 970);

    // Somebody else's run is not there, an administrator's eyes included.
    assert.equal((await server.post('bob', `/generation/batches/${id}/release?tab=tab-a`)).status, 404);
    assert.equal((await server.post('admin', `/generation/batches/${id}/release?tab=tab-a`)).status, 404);
    // Another tab of the same account cannot stop it.
    const wrongTab = await server.post('alice', `/generation/batches/${id}/release?tab=tab-b`);
    assert.equal(wrongTab.status, 409);
    assert.equal(wrongTab.body.code, 'tab-mismatch');
    assert.equal((await server.post('alice', `/generation/batches/${id}/release`)).body.code, 'tab-mismatch');
    // An order is not tied to a tab, so it is not released - it is cancelled from Orders.
    const order = await server.post('alice', `/generation/batches/${ordered.body.batchId}/release`);
    assert.equal(order.status, 409);
    assert.equal(order.body.code, 'not-immediate');
    assert.equal(server.queue().getBatch(id).state, 'running', 'none of that stopped anything');

    // What `pagehide` sends: a keepalive POST with no body, no content type and
    // no Authorization header - the session cookie is the whole credential.
    const released = await fetch(`${server.base}/generation/batches/${id}/release?tab=tab-a`, {
      method: 'POST',
      headers: { cookie: `ft_session=${encodeURIComponent(server.tokens.alice)}` },
    });
    assert.equal(released.status, 200);
    const said = await released.json();
    assert.equal(said.released, true);
    assert.equal(said.cancelled + said.aborted, 2);
    assert.equal(server.queue().getBatch(id).state, 'cancelled');
    await until(() => server.balance(server.alice) === 990, 'both resumes refunded (the order keeps its $0.010)');

    // A second release - the page's pagehide after its own Stop - changes nothing.
    const again = await server.post('alice', `/generation/batches/${id}/release?tab=tab-a`);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { released: false, state: 'cancelled' });
  } finally {
    server.close();
  }
});

test('each finished resume is downloaded through an owner-checked route, and deleted after the run, downloaded or not', async () => {
  const server = await serve('downloads');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(2), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    await until(() => server.queue().getBatch(id).tasks[0].state === 'running', 'the first resume to start');
    server.deliver(id, 0);
    await until(() => server.queue().getBatch(id).tasks[0].state === 'done', 'the first resume to land');

    // The snapshot says which files each finished resume has - kinds, not paths.
    const snapshot = await (await server.call('alice', `/generation/batches/${id}`)).json();
    assert.equal(snapshot.kind, 'immediate');
    const [done, building] = snapshot.tasks;
    assert.deepEqual(done.files, ['resume-pdf', 'cover-letter-pdf']);
    assert.equal(building.files, undefined);

    const route = (task, kind) => `/generation/batches/${id}/tasks/${task.id}/${kind}`;
    const file = await server.call('alice', route(done, 'resume-pdf'));
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'resume 0');
    assert.match(file.headers.get('content-disposition'), /attachment; filename="Company_0_Ada\.pdf"/);
    assert.match(file.headers.get('content-type'), /application\/pdf/);

    // Nobody else's - an administrator included - and nothing that is not a file kind.
    assert.equal((await server.call('bob', route(done, 'resume-pdf'))).status, 404);
    assert.equal((await server.call('admin', route(done, 'resume-pdf'))).status, 404);
    assert.equal((await server.call('alice', route(done, 'resume-docx'))).status, 404, 'a kind this run did not make');
    assert.equal((await server.call('alice', route(done, '..%2F..%2Fsecrets'))).status, 404);
    assert.equal((await server.call('alice', `/generation/batches/${id}/tasks/tsk_nope/resume-pdf`)).status, 404);
    const notYet = await server.call('alice', route(building, 'resume-pdf'));
    assert.equal(notYet.status, 409);
    assert.equal((await notYet.json()).code, 'not-ready');

    // Never while the run is still going, however far the clock is wound.
    assert.equal((await retention.purgeFinishedImmediateRuns(Date.now() + 10 * 24 * 60 * 60 * 1000, 600_000)).orders, 0);
    assert.equal(fs.existsSync(path.join(server.outputBaseDir, orders.listOrderItems(orders.findOrderForBatch(id).id)[0].files[0].path)), true);

    server.deliver(id, 1);
    await server.untilState(id, 'done');
    await until(() => orders.findOrderForBatch(id).state === 'done', 'the run\'s row to settle');
    const row = orders.findOrderForBatch(id);
    const onDisk = orders.listOrderItems(row.id).flatMap((item) => item.files.map((entry) => path.join(server.outputBaseDir, entry.path)));
    assert.equal(onDisk.length, 4);

    // The order sweep never takes an immediate run, even past its stamped expiry...
    const far = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal((await retention.purgeExpiredOrders(far)).orders, 0);
    // ...and its own sweep waits IMMEDIATE_FILE_RETENTION_MS from the END of the run.
    assert.equal((await retention.purgeFinishedImmediateRuns(Date.now(), 600_000)).orders, 0);
    assert.ok(onDisk.every((file) => fs.existsSync(file)));

    // Then every file goes - the one downloaded above, and the three never downloaded.
    const swept = await retention.purgeFinishedImmediateRuns(Date.now() + 600_001, 600_000);
    assert.equal(swept.orders, 1);
    assert.equal(swept.filesRemoved, 4);
    assert.ok(onDisk.every((file) => !fs.existsSync(file)));
    const gone = await server.call('alice', route(done, 'resume-pdf'));
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).code, 'file-deleted');

    // The row stays, so what each resume was charged is still on record.
    assert.equal(orders.getOrder(row.id).state, 'expired');
    assert.deepEqual(orders.listOrdersForUser(server.alice.id), [], 'and it is still never listed');
  } finally {
    server.close();
  }
});

test('a delivered immediate resume is refundable by its order item', async () => {
  const server = await serve('refunds');
  try {
    const { body } = await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], tabId: 'tab-a' });
    const id = body.batchId;
    await until(() => server.queue().getBatch(id).tasks[0].state === 'running', 'the resume to start');
    server.deliver(id, 0);
    await server.untilState(id, 'done');

    // Every immediate run has an orders row, so its resume is an order item -
    // one name per resume, and one that outlives the batch.
    const found = orders.findOrderItemForBatch(id, 0);
    assert.ok(found, 'the run\'s resume is an order item');
    assert.equal(found.order.kind, 'immediate');
    const item = refunds.resolveRefundItem('order-item', found.item.id, server.alice.id);
    assert.equal(item.itemType, 'order-item');
    assert.equal(item.refundableMilli, 10);

    // And a request made for it (before asking was removed, or seeded so) is
    // keyed on that order item, so the queue can still decide it.
    const request = seedRefundRequest({ refunds, refundDb, sqlite }, users.getUserById(server.alice.id), {
      itemType: 'order-item',
      itemId: found.item.id,
      reason: 'Wrong company.',
    });
    assert.equal(request.itemType, 'order-item');
    assert.equal(request.amountMilli, 10);
  } finally {
    server.close();
  }
});

test('a reloaded tab finds its own run by tab id, never another tab\'s or an order', async () => {
  const server = await serve('active-tab');
  try {
    const a = (await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], tabId: 'tab-a' })).body.batchId;
    const b = (await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], tabId: 'tab-b' })).body.batchId;
    await server.post('alice', '/generation/batches', { jobs: jobsFor(1), profileIds: ['p-alice'], mode: 'order' });
    const ids = async (query) =>
      (await (await server.call('alice', `/generation/batches?${query}`)).json()).batches.map((batch) => batch.batchId).sort();

    assert.deepEqual(await ids('active=1&tab=tab-a'), [a]);
    assert.deepEqual(await ids('active=1&tab=tab-b'), [b]);
    assert.deepEqual(await ids('active=1&tab=tab-c'), []);
    assert.deepEqual(await ids('active=1'), [a, b].sort(), 'without a tab: every own run that is not an order');
    const listed = (await (await server.call('alice', '/generation/batches?active=1&tab=tab-a')).json()).batches[0];
    assert.equal(listed.kind, 'immediate');
    assert.equal(listed.tabId, undefined, 'a tab id is never served back');
  } finally {
    server.close();
  }
});

test('after a restart an immediate run gets the grace to be reattached; an order and an older run do not', async () => {
  useTempStorage('immediate-runs-restore');
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();

  const batch = (id, shared) => ({
    id,
    state: 'running',
    data: { label: id, jobCount: 1, shared: { jobs: [{ companyName: 'Acme', role: '', jobDescription: '' }], ownerId: 'u1', ...shared }, createdAt: Date.now() },
  });
  const task = (batchId) => ({
    id: `tsk_${batchId}`,
    batchId,
    seq: 0,
    state: 'queued',
    data: { queue: 'cli', label: { profileId: 'p', profileName: 'P', companyName: 'Acme', role: '' }, kind: 'resume', payload: { batchId, costMilli: 0 } },
  });
  generationStore.saveBatchWithTasks(batch('bat_now', { kind: 'immediate', tabId: 'tab-a' }), [task('bat_now')]);
  generationStore.saveBatchWithTasks(batch('bat_order', { kind: 'order' }), [task('bat_order')]);
  generationStore.saveBatchWithTasks(batch('bat_old', {}), [task('bat_old')]);

  // Held, so the restored runs stay running while the test looks.
  queueModule.getGenerationQueue();
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, () => new Promise(() => {}));
  try {
    await queueModule.restoreGenerationQueue();
    const queue = queueModule.getGenerationQueue();
    assert.deepEqual(queueModule.getTabLeases().state('bat_now'), { readers: 0, armed: true });
    assert.equal(queueModule.getTabLeases().state('bat_order'), null);
    assert.equal(queueModule.getTabLeases().state('bat_old'), null, 'a run from before Generate Immediately runs on');
    assert.equal(queue.getBatch('bat_now').urgent, true);
    assert.equal(queue.getBatch('bat_order').urgent, undefined);
    assert.equal(queue.getBatch('bat_old').urgent, undefined);
  } finally {
    queueModule.resetGenerationQueueForTests();
  }
});

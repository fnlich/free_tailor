const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, seedProfileWithResumes, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * A sheet import becoming an order, and the order filling itself in.
 *
 * The join between the queue and an order is two hooks and nothing else, and
 * the thing that can go quietly wrong is the key they join on. It is
 * `(batchId, seq)` rather than a task id ON PURPOSE - a restart requeues the
 * work as new tasks with new ids, so an order keyed on those would stop
 * collecting results exactly when a run needed picking back up. The test for
 * that is below, and it is the reason this file exists.
 *
 * The other claim is the one a user notices: an order outlives its batch. The
 * dispatcher evicts a finished batch after an hour and deletes its rows; "122
 * of 300" has to keep reading correctly afterwards.
 */

async function serve() {
  const { dbDir } = useTempStorage(`order-lifecycle-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('orderer@example.com');
  const express = require('express');

  const users = loadFresh('../dist/database/userRepository');
  const account = users.createUser({ email: 'orderer@example.com' });
  const token = users.createSession(account.id);

  // A run builds ONE profile (a person), named by `profileId` (F2 contract 0.1).
  const { profileId } = seedProfileWithResumes(account, 'Ada', [
    {
      id: 'p1',
      name: 'Ada',
      title: 'Engineer',
      skills: ['C#'],
      contact: { email: 'a@b.c', phone: '1', location: 'X' },
      summary: 's',
      experience: [],
      strengths: [],
      education: [],
    },
  ]);

  const orders = loadFresh('../dist/database/orderRepository');
  const queue = loadFresh('../dist/services/queue/index');
  queue.resetGenerationQueueForTests();
  const routes = loadFresh('../dist/routes/generation');
  const orderRoutes = loadFresh('../dist/routes/orders');
  const { attachUser } = loadFresh('../dist/middleware/auth');

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(attachUser);
  app.use('/api/generation', routes.default);
  app.use('/api/orders', orderRoutes.default);
  const server = app.listen(0);
  const port = server.address().port;
  const auth = { authorization: `Bearer ${token}` };

  return {
    dbDir,
    profileId,
    orders,
    queue,
    account,
    close: () => server.close(),
    get: (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: auth }),
    post: (path, body) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
      }),
  };
}

function jobsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${index}`,
    role: 'Engineer',
    jobDescription: 'A job description long enough to be analysed. '.repeat(4),
    sourceRowNumber: index + 2,
  }));
}

test('a submission with mode order comes back with an order number, and one without does not', async () => {
  const server = await serve();
  try {
    const plain = await (await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(2) })).json();
    assert.equal(plain.orderNumber, undefined, 'manual building is not an order');
    assert.equal(plain.orderId, undefined);

    const ordered = await (
      await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(3), mode: 'order' })
    ).json();
    assert.match(ordered.orderNumber, /^FT-\d{8}-\d{4}$/, ordered.orderNumber);
    assert.ok(ordered.orderId.startsWith('ord_'));
    assert.equal(ordered.total, 3);
  } finally {
    server.close();
  }
});

test('the items exist before any task can finish, one per resume, in submitted order', async () => {
  const server = await serve();
  try {
    const { orderId } = await (
      await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(4), mode: 'order' })
    ).json();

    // Read straight after submit: `submit` dispatches immediately, so an order
    // whose items were created afterwards would miss the first few results.
    const items = server.orders.listOrderItems(orderId);
    assert.equal(items.length, 4);
    assert.deepEqual(
      items.map((item) => item.companyName),
      ['Company 0', 'Company 1', 'Company 2', 'Company 3']
    );
    assert.deepEqual(items.map((item) => item.seq), [0, 1, 2, 3]);
    assert.deepEqual(items.map((item) => item.sourceRowNumber), [2, 3, 4, 5]);
    assert.equal(items[0].resumeName, 'Ada');
    // What the run chose for each job is recorded on its item (F2 contract 2.7):
    // the profile, the resume's label, and why (one enabled resume: 'only').
    assert.ok(items.every((item) => item.profileLabel === 'Ada'), 'each item names the profile it was built for');
    assert.ok(items.every((item) => typeof item.resumeLabel === 'string' && item.resumeLabel), 'and the resume it chose');
    assert.ok(items.every((item) => item.match && item.match.v === 1 && item.match.reason === 'only' && item.match.candidates === 1));
    // The order's label reads "{jobs} job(s) for {profile}, {mode}" (contract 0.4).
    assert.match(server.orders.getOrder(orderId).label, /^4 job\(s\) for Ada, (Choose Suitable Resume|Partial Tailor|Fully Tailor)$/);
  } finally {
    server.close();
  }
});

test('an order and a Generate Immediately run are both filed under their own folder, fixed and recorded when placed', async () => {
  const server = await serve();
  try {
    const path = require('node:path');
    const config = require('../dist/config/aiModelConfig');
    const { sanitizePathSegment } = require('../dist/utils/outputStorage');
    const users = require('../dist/database/userRepository');
    // The submitter's own folder path, and the administrator's prefix in effect.
    users.setOutputPathSuffix(server.account.id, '/{{date}}/{{company_name}}');
    await config.updateAppSettings({ outputPathPrefix: '/{{user_email}}/{{order_number}}' });
    const { outputBaseDir } = await config.getAdminAppSettings();

    const ordered = await (
      await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(1), mode: 'order' })
    ).json();
    const immediate = await (await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(1) })).json();

    const readPayload = (batchId) => {
      const rows = require('better-sqlite3')(`${server.dbDir}/free_tailor.db`)
        .prepare('SELECT data FROM generation_tasks WHERE batch_id = ? ORDER BY seq')
        .all(batchId);
      return JSON.parse(rows[0].data).payload;
    };

    const orderedPayload = readPayload(ordered.batchId);
    assert.deepEqual(Object.keys(orderedPayload.output).sort(), ['accountName', 'baseDir', 'date', 'orderNumber', 'prefix', 'suffix']);
    assert.equal(orderedPayload.output.baseDir, outputBaseDir);
    assert.equal(orderedPayload.output.prefix, `orderer_example_com/${sanitizePathSegment(ordered.orderNumber)}`);
    assert.equal(orderedPayload.output.suffix, '/{{date}}/{{company_name}}', "the submitter's own folder path");
    assert.match(orderedPayload.output.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(orderedPayload.output.accountName, 'orderer@example.com');
    assert.equal(orderedPayload.output.orderNumber, ordered.orderNumber);
    // The order records the folder: what every file inside it is claimed by.
    const orderRow = server.orders.getOrder(ordered.orderId);
    assert.equal(orderRow.outputRoot, path.join(outputBaseDir, 'orderer_example_com', sanitizePathSegment(ordered.orderNumber)));
    // ...which is a path on the server, so no order a builder reads names it.
    const shown = await (await server.get(`/api/orders/${ordered.orderId}`)).json();
    assert.equal(shown.number, ordered.orderNumber);
    assert.equal('outputRoot' in shown, false, "the run's folder is the server's business");
    const listed = await (await server.get('/api/orders/')).json();
    assert.ok(listed.orders.length > 0);
    assert.ok(listed.orders.every((order) => !('outputRoot' in order)));

    // A run that was not ordered - Generate Immediately, the default - is
    // filed the same way, under a number of its own.
    assert.equal(immediate.kind, 'immediate');
    assert.equal(immediate.orderNumber, undefined, 'an immediate run has no order number to show');
    const immediatePayload = readPayload(immediate.batchId);
    assert.match(immediatePayload.output.orderNumber, /^FT-RUN-\d{8}-\d{4}$/);
    assert.match(immediatePayload.output.prefix, /^orderer_example_com\/ft_run_\d{8}_\d{4}$/);
    const immediateRow = server.orders.findOrderForBatch(immediate.batchId);
    assert.equal(immediateRow.outputRoot, path.join(outputBaseDir, ...immediatePayload.output.prefix.split('/')));
    // And it does not take a number out of the orders' own sequence.
    assert.match(ordered.orderNumber, /^FT-\d{8}-0001$/);

    // A setting edited afterwards reaches the next run only.
    await config.updateAppSettings({ outputPathPrefix: '/runs/{{order_number}}' });
    users.setOutputPathSuffix(server.account.id, null);
    assert.equal(readPayload(ordered.batchId).output.prefix, orderedPayload.output.prefix);
    const later = await (await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(1), mode: 'order' })).json();
    const laterPayload = readPayload(later.batchId);
    assert.equal(laterPayload.output.prefix, `runs/${sanitizePathSegment(later.orderNumber)}`);
    assert.equal(laterPayload.output.suffix, '/{{date}}/{{profile_name}}/{{company_name}}/{{role}}', 'the default again');
  } finally {
    server.close();
  }
});

/**
 * An order with no batch behind it.
 *
 * The tests below drive the tracking directly rather than submitting,
 * because a real submission starts real work: the dispatcher picks the tasks up
 * within milliseconds and writes its own outcomes over any the test invented,
 * and what is under test here is the JOIN, not the queue. A batch id nothing
 * dispatched keeps that join the only thing moving.
 */
function syntheticOrder(server, count, batchId) {
  return server.orders.createOrder(
    { userId: server.account.id, batchId, label: 'Sheets import', retentionDays: 5 },
    Array.from({ length: count }, (_, seq) => ({
      seq,
      resumeId: 'p1',
      resumeName: 'Ada',
      companyName: `Company ${seq}`,
      role: 'Engineer',
      sourceRowNumber: seq + 2,
    }))
  );
}

test('two orders for the same job on the same day write to different paths', async () => {
  const server = await serve();
  try {
    // The same sheet imported twice in one afternoon - a partial failure, a
    // tweak, a double-clicked button. Account, date, resume and company all
    // match, so without a discriminator the second run would overwrite the
    // first: the first order would then list files holding the second's
    // contents, and its earlier expiry would delete files the second offers.
    const first = await (
      await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(1), mode: 'order' })
    ).json();
    const second = await (
      await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(1), mode: 'order' })
    ).json();

    const placeFor = (batchId) => {
      const rows = require('better-sqlite3')(`${server.dbDir}/free_tailor.db`)
        .prepare('SELECT data FROM generation_tasks WHERE batch_id = ? ORDER BY seq')
        .all(batchId);
      return JSON.parse(rows[0].data).payload.output;
    };

    assert.notEqual(first.orderNumber, second.orderNumber);
    assert.equal(placeFor(first.batchId).orderNumber, first.orderNumber);
    // The prefix must hold the order number, so the difference is in the path
    // itself - and in the folder each order records as its own.
    assert.notEqual(placeFor(first.batchId).prefix, placeFor(second.batchId).prefix);
    assert.notEqual(server.orders.getOrder(first.orderId).outputRoot, server.orders.getOrder(second.orderId).outputRoot);
  } finally {
    server.close();
  }
});

test('two accounts whose emails sanitize alike still write to different paths', () => {
  // `john.smith@acme.com` and `john-smith@acme.com` both become
  // `john_smith_acme_com`, so the email folder is NOT a unique key. The order
  // number is what actually keeps them apart: unique across the install, and
  // in every prefix, as a folder of its own.
  const { DEFAULT_OUTPUT_PATH_PREFIX, renderOutputPrefix } = require('../dist/utils/outputStorage');
  const render = (email, orderNumber) =>
    renderOutputPrefix(DEFAULT_OUTPUT_PATH_PREFIX, { user_email: email, order_number: orderNumber, date: '2026-09-20' });

  assert.equal(
    render('john.smith@acme.com', 'FT-20260920-0001').split('/')[0],
    render('john-smith@acme.com', 'FT-20260920-0002').split('/')[0],
    'the email folder really does collide'
  );
  assert.notEqual(
    render('john.smith@acme.com', 'FT-20260920-0001'),
    render('john-smith@acme.com', 'FT-20260920-0002'),
    'and the order number is what stops that becoming one file'
  );
});

test('a finished task lands on its own item, found by batch and position', async () => {
  const server = await serve();
  try {
    const batchId = 'bat_join_check';
    const order = syntheticOrder(server, 3, batchId);
    const tracking = loadFresh('../dist/services/orders/orderTracking');

    // A task id the order has never seen, which is the point: a restart
    // requeues work as new tasks with new ids, so the join cannot be on them.
    tracking.recordTaskFinished({
      id: 'tsk_restarted_with_a_new_id',
      batchId,
      seq: 1,
      state: 'done',
      value: {
        pdf: 'orderer@example.com/2026-09-20/ada/company_1/Ada.pdf',
        docx: 'orderer@example.com/2026-09-20/ada/company_1/Ada.docx',
        coverLetterPdf: 'orderer@example.com/2026-09-20/ada/company_1/Ada_cover_letter.pdf',
      },
    });

    const items = server.orders.listOrderItems(order.id);
    assert.equal(items[0].state, 'queued', 'only the reported one moved');
    assert.equal(items[1].state, 'done');
    assert.equal(items[1].companyName, 'Company 1', 'seq 1 is the second job, not the first');
    assert.equal(items[1].taskId, 'tsk_restarted_with_a_new_id');
    assert.deepEqual(
      items[1].files.map((file) => file.kind),
      ['resume-pdf', 'resume-docx', 'cover-letter-pdf'],
      'resume before cover letter, pdf before docx'
    );
    assert.equal(items[2].state, 'queued');
  } finally {
    server.close();
  }
});

test('a task being picked up shows as running before it shows as done', async () => {
  const server = await serve();
  try {
    const batchId = 'bat_running_check';
    const order = syntheticOrder(server, 2, batchId);
    const tracking = loadFresh('../dist/services/orders/orderTracking');

    tracking.recordTaskStarted({ batchId, seq: 0 });
    assert.equal(server.orders.listOrderItems(order.id)[0].state, 'running');

    tracking.recordTaskFinished({ id: 't0', batchId, seq: 0, state: 'done', value: { pdf: 'a/b.pdf' } });
    assert.equal(server.orders.listOrderItems(order.id)[0].state, 'done');

    // And a late start report cannot drag a finished item backwards.
    tracking.recordTaskStarted({ batchId, seq: 0 });
    assert.equal(server.orders.listOrderItems(order.id)[0].state, 'done');
  } finally {
    server.close();
  }
});

test('a failure keeps its reason, and a partly successful order still counts as done', async () => {
  const server = await serve();
  try {
    const batchId = 'bat_partial';
    const order = syntheticOrder(server, 2, batchId);
    const tracking = loadFresh('../dist/services/orders/orderTracking');

    tracking.recordTaskFinished({ id: 't0', batchId, seq: 0, state: 'done', value: { pdf: 'a/b/c.pdf' } });
    assert.equal(server.orders.getOrder(order.id).state, 'running', 'not finished while one is queued');

    tracking.recordTaskFinished({ id: 't1', batchId, seq: 1, state: 'failed', error: 'the model refused' });

    const settled = server.orders.getOrder(order.id);
    assert.equal(settled.state, 'done', 'one delivered file is a delivery, not a failure');
    assert.ok(settled.finishedAt);

    const items = server.orders.listOrderItems(order.id);
    assert.equal(items[1].error, 'the model refused');
    assert.equal(items[1].files.length, 0);
  } finally {
    server.close();
  }
});

test('an order that delivered nothing at all is a failure, and a cancelled one says so', async () => {
  const server = await serve();
  try {
    const tracking = loadFresh('../dist/services/orders/orderTracking');

    const failed = syntheticOrder(server, 2, 'bat_all_failed');
    tracking.recordTaskFinished({ id: 'a', batchId: 'bat_all_failed', seq: 0, state: 'failed', error: 'x' });
    tracking.recordTaskFinished({ id: 'b', batchId: 'bat_all_failed', seq: 1, state: 'failed', error: 'y' });
    assert.equal(server.orders.getOrder(failed.id).state, 'failed');

    const stopped = syntheticOrder(server, 2, 'bat_cancelled');
    tracking.recordTaskFinished({ id: 'c', batchId: 'bat_cancelled', seq: 0, state: 'cancelled' });
    tracking.recordTaskFinished({ id: 'd', batchId: 'bat_cancelled', seq: 1, state: 'cancelled' });
    assert.equal(server.orders.getOrder(stopped.id).state, 'cancelled');
  } finally {
    server.close();
  }
});

test('an order reports correctly with no batch behind it at all', async () => {
  const server = await serve();
  try {
    const batchId = 'bat_long_evicted';
    const order = syntheticOrder(server, 2, batchId);
    const tracking = loadFresh('../dist/services/orders/orderTracking');
    tracking.recordTaskFinished({ id: 't0', batchId, seq: 0, state: 'done', value: { pdf: 'a/b/c.pdf' } });

    // The state an order spends most of its life in: an hour after the batch
    // settled, `evictFinished` dropped it and deleted its rows.
    assert.equal((await server.get(`/api/generation/batches/${batchId}`)).status, 404);

    const body = await (await server.get(`/api/orders/${order.id}`)).json();
    assert.equal(body.number, order.number);
    assert.equal(body.counts.total, 2);
    assert.equal(body.counts.done, 1);
    assert.equal(body.counts.queued, 1);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].companyName, 'Company 0');
    assert.deepEqual(body.items[0].available, ['resume-pdf']);
  } finally {
    server.close();
  }
});

test('a batch that is not an order records nothing, and that is not an error', async () => {
  const server = await serve();
  try {
    const { batchId } = await (await server.post('/api/generation/batches', { profileId: server.profileId, jobs: jobsFor(1) })).json();
    const tracking = loadFresh('../dist/services/orders/orderTracking');

    // Most batches are manual builds. The hook must be a quiet no-op for them.
    assert.doesNotThrow(() =>
      tracking.recordTaskFinished({ id: 't0', batchId, seq: 0, state: 'done', value: { pdf: 'a/b.pdf' } })
    );
    assert.doesNotThrow(() => tracking.recordTaskStarted({ batchId, seq: 0 }));

    const list = await (await server.get('/api/orders/')).json();
    assert.deepEqual(list.orders, []);
  } finally {
    server.close();
  }
});

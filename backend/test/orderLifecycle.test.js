const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

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

  const { saveProfile } = loadFresh('../dist/database/profileRepository');
  const { buildNewProfile } = loadFresh('../dist/services/profileService');
  saveProfile({
    ...buildNewProfile(
      {
        name: 'Ada',
        title: 'Engineer',
        skills: ['C#'],
        contact: { email: 'a@b.c', phone: '1', location: 'X' },
        summary: 's',
        experience: [],
        strengths: [],
        education: [],
      },
      'p1'
    ),
    ownerId: account.id,
  });

  const config = loadFresh('../dist/config/aiModelConfig');
  await config.updateAppSettings({
    browserChatEndpoints: [{ siteId: 'claude-web', port: 9801 }],
  });

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

test('a submission with asOrder comes back with an order number, and one without does not', async () => {
  const server = await serve();
  try {
    const plain = await (await server.post('/api/generation/batches', { jobs: jobsFor(2) })).json();
    assert.equal(plain.orderNumber, undefined, 'manual building is not an order');
    assert.equal(plain.orderId, undefined);

    const ordered = await (
      await server.post('/api/generation/batches', { jobs: jobsFor(3), asOrder: true })
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
      await server.post('/api/generation/batches', { jobs: jobsFor(4), asOrder: true })
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
    assert.equal(items[0].profileName, 'Ada');
  } finally {
    server.close();
  }
});

test('an ordered build is filed under the account, and a manual one is not', async () => {
  const server = await serve();
  try {
    const ordered = await (
      await server.post('/api/generation/batches', { jobs: jobsFor(1), asOrder: true })
    ).json();
    const plain = await (await server.post('/api/generation/batches', { jobs: jobsFor(1) })).json();

    const readPayload = (batchId) => {
      const rows = require('better-sqlite3')(`${server.dbDir}/free_tailor.db`)
        .prepare('SELECT data FROM generation_tasks WHERE batch_id = ? ORDER BY seq')
        .all(batchId);
      return JSON.parse(rows[0].data).payload;
    };

    const orderedPayload = readPayload(ordered.batchId);
    assert.equal(orderedPayload.accountFolder, 'orderer@example.com');
    assert.equal(orderedPayload.orderNumber, ordered.orderNumber);
    assert.equal(
      orderedPayload.pathTemplate,
      '/{{account name}}/{{date}}/{{order number}}/{{profile name}}/{{company name}}',
      'an order uses the fixed tree, not the administrator\'s template'
    );

    // A manual build keeps the administrator's template - but it is still told
    // WHO it is for, because `{{account name}}` is a token that template may
    // use too, and filling it only for orders would file every queued build
    // into one shared `unknown/` tree while the synchronous routes filed
    // correctly.
    const plainPayload = readPayload(plain.batchId);
    assert.equal(plainPayload.accountFolder, 'orderer@example.com');
    assert.equal(plainPayload.orderNumber, undefined);
    assert.equal(plainPayload.pathTemplate, undefined);
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
      profileId: 'p1',
      profileName: 'Ada',
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
    // tweak, a double-clicked button. Account, date, profile and company all
    // match, so without a discriminator the second run would overwrite the
    // first: the first order would then list files holding the second's
    // contents, and its earlier expiry would delete files the second offers.
    const first = await (
      await server.post('/api/generation/batches', { jobs: jobsFor(1), asOrder: true })
    ).json();
    const second = await (
      await server.post('/api/generation/batches', { jobs: jobsFor(1), asOrder: true })
    ).json();

    const payloadFor = (batchId) => {
      const rows = require('better-sqlite3')(`${server.dbDir}/free_tailor.db`)
        .prepare('SELECT data FROM generation_tasks WHERE batch_id = ? ORDER BY seq')
        .all(batchId);
      return JSON.parse(rows[0].data).payload;
    };

    assert.notEqual(first.orderNumber, second.orderNumber);
    assert.equal(payloadFor(first.batchId).orderNumber, first.orderNumber);
    assert.equal(payloadFor(second.batchId).orderNumber, second.orderNumber);

    // And the template renders that difference into the path itself.
    const { renderOutputPathTemplate, ORDER_OUTPUT_PATH_TEMPLATE } = require('../dist/utils/outputStorage');
    const render = (orderNumber) =>
      renderOutputPathTemplate(ORDER_OUTPUT_PATH_TEMPLATE, {
        date: '2026-09-20',
        accountName: 'orderer@example.com',
        orderNumber,
        profileName: 'Ada',
        companyName: '2_company_0',
        jobTitle: 'Engineer',
      });
    assert.notEqual(render(first.orderNumber), render(second.orderNumber));
  } finally {
    server.close();
  }
});

test('two accounts whose emails sanitize alike still write to different paths', () => {
  // `john.smith@acme.com` and `john-smith@acme.com` both become
  // `john_smith_acme_com`, so the account segment is NOT a unique key and the
  // comment that once claimed it was has been corrected. The order number is
  // what actually keeps them apart, and it is unique across the install.
  const { renderOutputPathTemplate, ORDER_OUTPUT_PATH_TEMPLATE } = require('../dist/utils/outputStorage');
  const render = (accountName, orderNumber) =>
    renderOutputPathTemplate(ORDER_OUTPUT_PATH_TEMPLATE, {
      date: '2026-09-20',
      accountName,
      orderNumber,
      profileName: 'John Smith',
      companyName: '14_stripe',
      jobTitle: 'Engineer',
    });

  assert.equal(
    render('john.smith@acme.com', 'FT-20260920-0001').split('/')[0],
    render('john-smith@acme.com', 'FT-20260920-0002').split('/')[0],
    'the account segment really does collide'
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
    const { batchId } = await (await server.post('/api/generation/batches', { jobs: jobsFor(1) })).json();
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

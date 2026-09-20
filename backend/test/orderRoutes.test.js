const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const { loadFresh, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * Orders over HTTP.
 *
 * The claim worth holding here is the one the job routes learned the hard way:
 * an order id in a path is an id somebody can change, and "signed in" is not
 * the same question as "yours". So every route is asked for somebody else's
 * order, and every answer must be 404 - not 403, which would confirm the order
 * exists.
 *
 * The second claim is that the files reached through an order are exactly the
 * files that order built. The zip is opened and its entries read, rather than
 * asserting on a byte count, because "the archive is non-empty" has passed for
 * an archive holding the wrong resume.
 */

function makeFiles(baseDir, spec) {
  for (const [relative, contents] of Object.entries(spec)) {
    const absolute = path.join(baseDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
}

async function serve() {
  const { rootDir, dbDir } = useTempStorage(`order-routes-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  // Written before anything reads settings, because the settings module caches
  // the row it first sees.
  const outputBaseDir = path.join(rootDir, 'generated');
  fs.mkdirSync(outputBaseDir, { recursive: true });
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ outputBaseDir }));

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const orders = loadFresh('../dist/database/orderRepository');
  loadFresh('../dist/config/aiModelConfig');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/orders');

  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/orders', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  return {
    users,
    orders,
    outputBaseDir,
    alice,
    bob,
    aliceToken: users.createSession(alice.id),
    bobToken: users.createSession(bob.id),
    close: () => server.close(),
    request: (token, suffix, init = {}) =>
      fetch(`http://127.0.0.1:${port}/api/orders${suffix}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
  };
}

/** One order for Alice with two finished resumes and their files on disk. */
function seedOrder(server, { userId = server.alice.id, batchId = 'bat_seed' } = {}) {
  const order = server.orders.createOrder(
    { userId, batchId, label: 'Sheets import (2 jobs)', retentionDays: 5 },
    [
      { seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE', sourceRowNumber: 2 },
      { seq: 1, profileId: 'p1', profileName: 'Ada', companyName: 'Globex', role: 'SWE', sourceRowNumber: 3 },
    ]
  );

  makeFiles(server.outputBaseDir, {
    'alice@example.com/2026-09-20/ada/acme/Ada.pdf': 'ACME RESUME',
    'alice@example.com/2026-09-20/ada/acme/Ada_cover_letter.pdf': 'ACME LETTER',
    'alice@example.com/2026-09-20/ada/globex/Ada.pdf': 'GLOBEX RESUME',
  });

  server.orders.recordItemOutcome(batchId, 0, {
    state: 'done',
    taskId: 'tsk_0',
    files: [
      { kind: 'resume-pdf', path: 'alice@example.com/2026-09-20/ada/acme/Ada.pdf' },
      { kind: 'cover-letter-pdf', path: 'alice@example.com/2026-09-20/ada/acme/Ada_cover_letter.pdf' },
    ],
  });
  server.orders.recordItemOutcome(batchId, 1, {
    state: 'done',
    taskId: 'tsk_1',
    files: [{ kind: 'resume-pdf', path: 'alice@example.com/2026-09-20/ada/globex/Ada.pdf' }],
  });
  server.orders.settleOrderIfFinished(order.id);

  return order;
}

async function unzipEntries(response) {
  // Read with the zip's own central directory rather than a library, so the
  // assertion is about a real archive and not about how we happen to build one.
  const buffer = Buffer.from(await response.arrayBuffer());
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, 'the response is not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory header');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // Stored (uncompressed) entries, so the bytes follow the local header.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const size = buffer.readUInt32LE(offset + 24);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, contents: buffer.toString('utf8', start, start + size) });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('an order and its files belong to one account, and nobody else can name them', async () => {
  const server = await serve();
  try {
    const order = seedOrder(server);
    const items = server.orders.listOrderItems(order.id);

    const paths = [
      `/${order.id}`,
      `/${order.id}/zip`,
      `/${order.id}/items/${items[0].id}/resume-pdf`,
    ];

    for (const suffix of paths) {
      assert.equal((await server.request(null, suffix)).status, 401, suffix);

      const asBob = await server.request(server.bobToken, suffix);
      assert.equal(asBob.status, 404, `${suffix} must be 404 for another account, not 403`);
      assert.match((await asBob.json()).error, /not found/i);

      assert.equal((await server.request(server.aliceToken, suffix)).status, 200, suffix);
    }

    // And the list is scoped without being asked: Bob sees his own nothing.
    const bobsList = await (await server.request(server.bobToken, '/')).json();
    assert.deepEqual(bobsList.orders, []);
  } finally {
    server.close();
  }
});

test('the list carries the counts a progress bar needs, in one shape', async () => {
  const server = await serve();
  try {
    const order = server.orders.createOrder(
      { userId: server.alice.id, batchId: 'bat_counts', retentionDays: 5 },
      Array.from({ length: 5 }, (_, seq) => ({
        seq,
        profileId: 'p1',
        profileName: 'Ada',
        companyName: `Co${seq}`,
        role: 'SWE',
      }))
    );
    server.orders.recordItemOutcome('bat_counts', 0, { state: 'done' });
    server.orders.recordItemOutcome('bat_counts', 1, { state: 'done' });
    server.orders.recordItemOutcome('bat_counts', 2, { state: 'failed', error: 'nope' });

    const body = await (await server.request(server.aliceToken, '/')).json();
    assert.equal(body.orders.length, 1);
    const [listed] = body.orders;
    assert.equal(listed.id, order.id);
    assert.equal(listed.number, order.number);
    assert.equal(listed.counts.total, 5);
    assert.equal(listed.counts.done, 2);
    assert.equal(listed.counts.failed, 1);
    assert.equal(listed.counts.queued, 2);
    assert.equal(listed.counts.settled, 3, '3 of 5 is what the bar shows');
    assert.equal(listed.state, 'running');
  } finally {
    server.close();
  }
});

test('one file downloads as itself, and a kind that was never built is not found', async () => {
  const server = await serve();
  try {
    const order = seedOrder(server);
    const [first, second] = server.orders.listOrderItems(order.id);

    const resume = await server.request(server.aliceToken, `/${order.id}/items/${first.id}/resume-pdf`);
    assert.equal(resume.status, 200);
    assert.equal(resume.headers.get('content-type'), 'application/pdf');
    assert.match(resume.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(await resume.text(), 'ACME RESUME');

    const letter = await server.request(
      server.aliceToken,
      `/${order.id}/items/${first.id}/cover-letter-pdf`
    );
    assert.equal(await letter.text(), 'ACME LETTER');

    // The second item produced no cover letter, and asking for one is a 404
    // rather than the first item's letter by accident.
    const missing = await server.request(
      server.aliceToken,
      `/${order.id}/items/${second.id}/cover-letter-pdf`
    );
    assert.equal(missing.status, 404);

    // A kind outside the closed set never reaches the filesystem at all.
    const bogus = await server.request(server.aliceToken, `/${order.id}/items/${first.id}/passwd`);
    assert.equal(bogus.status, 404);
  } finally {
    server.close();
  }
});

test('a path that escapes the output directory is refused, however it got into the row', async () => {
  const server = await serve();
  try {
    const order = seedOrder(server);
    const [first] = server.orders.listOrderItems(order.id);

    // A row doctored to point outside - which is the shape the traversal guard
    // exists for, since the path is otherwise trusted because we wrote it.
    server.orders.recordItemFiles(first.id, [
      { kind: 'resume-pdf', path: '../../../../etc/passwd' },
    ]);

    const response = await server.request(
      server.aliceToken,
      `/${order.id}/items/${first.id}/resume-pdf`
    );
    assert.equal(response.status, 410);
  } finally {
    server.close();
  }
});

test('the zip holds exactly the order\'s files, named so the archive can be navigated', async () => {
  const server = await serve();
  try {
    const order = seedOrder(server);

    const response = await server.request(server.aliceToken, `/${order.id}/zip`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition') ?? '', new RegExp(`${order.number}\\.zip`));

    const entries = await unzipEntries(response);
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      ['acme/ada/Ada.pdf', 'acme/ada/Ada_cover_letter.pdf', 'globex/ada/Ada.pdf']
    );
    assert.equal(entries.find((entry) => entry.name === 'globex/ada/Ada.pdf').contents, 'GLOBEX RESUME');
  } finally {
    server.close();
  }
});

test('a selection zips only what was selected', async () => {
  const server = await serve();
  try {
    const order = seedOrder(server);
    const [, second] = server.orders.listOrderItems(order.id);

    const response = await server.request(server.aliceToken, `/${order.id}/zip?items=${second.id}`);
    assert.equal(response.status, 200);

    const entries = await unzipEntries(response);
    assert.deepEqual(entries.map((entry) => entry.name), ['globex/ada/Ada.pdf']);
  } finally {
    server.close();
  }
});

test('an order with nothing built says so rather than sending an empty archive', async () => {
  const server = await serve();
  try {
    const order = server.orders.createOrder(
      { userId: server.alice.id, batchId: 'bat_empty', retentionDays: 5 },
      [{ seq: 0, profileId: 'p1', profileName: 'Ada', companyName: 'Acme', role: 'SWE' }]
    );

    const response = await server.request(server.aliceToken, `/${order.id}/zip`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /no files/i);
  } finally {
    server.close();
  }
});

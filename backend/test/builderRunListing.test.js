const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * `GET /api/generation/batches?active=1` - the question the builder asks when
 * it loads: "is a run of mine still going?". It reattaches to the first batch
 * in the answer and locks the page while it follows it, so the answer is the
 * caller's OWN unfinished runs and never an order:
 *
 *   - an administrator's builder used to follow whichever account's run
 *     happened to be first, because an administrator may read any batch;
 *   - a placed order used to lock the builder for as long as it took.
 *
 * The unfiltered list is unchanged: an administrator still sees every run.
 */

const PROFILE = {
  name: 'Ada',
  title: 'Engineer',
  skills: ['C#'],
  contact: { email: 'a@b.c', phone: '1', location: 'X' },
  summary: 's',
  experience: [],
  strengths: [],
  education: [],
};

function jobs(count) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${index}`,
    role: 'Engineer',
    jobDescription: 'A job description long enough to be analysed. '.repeat(4),
  }));
}

test('the active list is the caller\'s own runs, never an order - administrators included', async () => {
  useTempStorage('builder-run-listing');
  useAdminEmails('admin@example.com');
  const express = require('express');
  const users = loadFresh('../dist/database/userRepository');
  const { saveProfile } = loadFresh('../dist/database/profileRepository');
  const { buildNewProfile } = loadFresh('../dist/services/profileService');
  const credits = loadFresh('../dist/services/credits');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  saveProfile({ ...buildNewProfile(PROFILE, 'p-admin'), ownerId: admin.id });
  saveProfile({ ...buildNewProfile(PROFILE, 'p-alice'), ownerId: alice.id });
  credits.setBalance(alice.id, 50, admin.id);
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

  const queueModule = loadFresh('../dist/services/queue/index');
  queueModule.resetGenerationQueueForTests();
  const routes = loadFresh('../dist/routes/generation');
  const { attachUser } = loadFresh('../dist/middleware/auth');

  // Every run stays running until the end, so "active" is a fact for the
  // whole test rather than a race against the work finishing.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  queueModule.getGenerationQueue();
  queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async () => {
    await gate;
    return {};
  });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/generation', routes.default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/generation`;
  const call = async (who, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response.json();
  };
  const ids = (listing) => listing.batches.map((batch) => batch.batchId).sort();

  try {
    const alicesRun = (await call('alice', '/batches', { jobs: jobs(1), profileIds: ['p-alice'] })).batchId;
    const alicesOrder = (await call('alice', '/batches', { jobs: jobs(1), profileIds: ['p-alice'], asOrder: true }))
      .batchId;
    const adminsRun = (await call('admin', '/batches', { jobs: jobs(1), profileIds: ['p-admin'] })).batchId;
    const adminsOrder = (await call('admin', '/batches', { jobs: jobs(1), profileIds: ['p-admin'], asOrder: true }))
      .batchId;
    assert.ok(alicesRun && alicesOrder && adminsRun && adminsOrder);

    // The builder's question.
    assert.deepEqual(ids(await call('alice', '/batches?active=1')), [alicesRun]);
    assert.deepEqual(ids(await call('admin', '/batches?active=1')), [adminsRun], 'not Alice\'s, not an order');

    // Everything else is as it was: an administrator sees every run, orders
    // included; an account sees its own.
    assert.deepEqual(ids(await call('admin', '/batches')), [adminsOrder, adminsRun, alicesOrder, alicesRun].sort());
    assert.deepEqual(ids(await call('alice', '/batches')), [alicesOrder, alicesRun].sort());

    // The order is still a batch like any other for whoever may see it.
    const order = await call('admin', `/batches/${alicesOrder}`);
    assert.equal(order.batchId, alicesOrder);

    // And it says what it is, on the batch itself, which a restart keeps.
    const queue = queueModule.getGenerationQueue();
    assert.equal(queue.getBatch(alicesOrder).shared.kind, 'order');
    assert.equal(queue.getBatch(alicesRun).shared.kind, undefined);
  } finally {
    release();
    server.close();
  }
});

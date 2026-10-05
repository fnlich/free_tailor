const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The multi-profile lock, where it is real: on the server (owner decisions
 * B1-B3).
 *
 * A Default subscription supports ONE profile. So every run that targets more
 * than one - Multiple, All profiles, Specific group, Select Group, in manual
 * and sheet mode, as Generate Immediately or as an Order - is refused with 403
 * `subscription-too-low` by the submission, the quote and the multi-profile
 * preview alike. What is NOT locked is just as much the rule: a single-profile
 * run of either kind, ordering included, on every subscription. Premium and up
 * may target several, and administrators are exempt whatever their own
 * subscription. The builder greys the choices out; these are the checks that
 * actually refuse.
 */

const config = require('../dist/config/aiModelConfig');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const orders = require('../dist/database/orderRepository');
const queueModule = require('../dist/services/queue/index');

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

const JOBS = [{ companyName: 'Acme', role: 'Engineer', jobDescription: 'short' }];

async function serve(name) {
  useTempStorage(`subscription-gates-${name}`);
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();

  const admin = users.createUser({ email: 'admin@example.com' });
  // Two profiles each: a Default account keeps any it had before a downgrade,
  // which is exactly the account the lock is for.
  const dora = users.createUser({ email: 'dora@example.com' });
  const pria = users.updateUser(users.createUser({ email: 'pria@example.com' }).id, { subscription: 'premium' });
  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  for (const [owner, prefix] of [
    [admin, 'admin'],
    [dora, 'dora'],
    [pria, 'pria'],
  ]) {
    saveProfile({ ...buildNewProfile(profileInput(`${prefix} one`), `${prefix}-1`), ownerId: owner.id });
    saveProfile({ ...buildNewProfile(profileInput(`${prefix} two`), `${prefix}-2`), ownerId: owner.id });
  }
  // Priced, so "nothing was charged" is a figure that could have moved.
  await config.updateAIModel('claude-cli-sonnet', { pricePerResumeUsd: '0.010' });
  credits.setBalance(dora.id, 1_000, admin.id);
  credits.setBalance(pria.id, 1_000, admin.id);

  const tokens = {
    admin: users.createSession(admin.id),
    dora: users.createSession(dora.id),
    pria: users.createSession(pria.id),
  };
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  app.use('/api/resume', require('../dist/routes/resume').default);
  const server = app.listen(0);
  const port = server.address().port;

  return {
    admin,
    dora,
    pria,
    balance: (account) => users.getUserById(account.id).balanceMilli,
    post: async (who, route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => {
      server.close();
      queueModule.resetGenerationQueueForTests();
    },
  };
}

function assertLocked(response, what) {
  assert.equal(response.status, 403, `${what}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.code, 'subscription-too-low', what);
  assert.equal(response.body.requiredSubscription, 'premium', what);
  assert.match(response.body.error, /more than one profile needs a Premium subscription/, what);
}

/** Every multi-profile shape a request can take: two named, and none named (= all). */
const MULTI_SHAPES = [
  ['two profiles named', (who) => ({ profileIds: [`${who}-1`, `${who}-2`] })],
  ['no profileIds (= all profiles)', () => ({})],
];

test('a Default subscription is refused every multi-profile run, as Generate Immediately and as an Order', async () => {
  const server = await serve('default-refused');
  try {
    for (const [shape, ids] of MULTI_SHAPES) {
      for (const mode of [{}, { mode: 'immediate' }, { mode: 'order' }, { asOrder: true }]) {
        const response = await server.post('dora', '/generation/batches', { jobs: JOBS, ...ids('dora'), ...mode });
        assertLocked(response, `${shape} ${JSON.stringify(mode)}`);
      }
    }
    // Refused before anything was charged, queued or filed.
    assert.equal(server.balance(server.dora), 1_000);
    assert.equal(queueModule.getGenerationQueue().listBatches(false).length, 0);
    assert.deepEqual(orders.listOrdersForUser(server.dora.id), []);
  } finally {
    server.close();
  }
});

test('the quote and the multi-profile preview refuse the same shapes', async () => {
  const server = await serve('default-quote-preview');
  try {
    for (const [shape, ids] of MULTI_SHAPES) {
      assertLocked(await server.post('dora', '/generation/quote', { jobs: JOBS, ...ids('dora') }), `quote, ${shape}`);
      assertLocked(
        await server.post('dora', '/resume/preview-all', { jobDescription: 'short', ...ids('dora') }),
        `preview-all, ${shape}`
      );
    }
    // A quote of no jobs yet is still refused when it targets several: the
    // refusal is about who the run is for, and the cost line is asked early.
    assertLocked(await server.post('dora', '/generation/quote', { jobs: [] }), 'quote with no jobs, all profiles');
  } finally {
    server.close();
  }
});

test('one profile is open to a Default subscription: immediate, order, quote and preview', async () => {
  const server = await serve('default-single');
  try {
    const single = { jobs: JOBS, profileIds: ['dora-1'] };
    const immediate = await server.post('dora', '/generation/batches', { ...single, mode: 'immediate' });
    assert.equal(immediate.status, 202, JSON.stringify(immediate.body));
    assert.equal(immediate.body.kind, 'immediate');

    // Ordering is not locked (B1, B2): a Default account orders for its one profile.
    const ordered = await server.post('dora', '/generation/batches', { ...single, mode: 'order' });
    assert.equal(ordered.status, 202, JSON.stringify(ordered.body));
    assert.equal(ordered.body.kind, 'order');
    assert.match(ordered.body.orderNumber, /^FT-\d{8}-\d{4}$/);

    const quote = await server.post('dora', '/generation/quote', single);
    assert.equal(quote.status, 200);
    assert.equal(quote.body.resumes, 1);

    const preview = await server.post('dora', '/resume/preview-all', { jobDescription: 'short', profileIds: ['dora-1'] });
    assert.notEqual(preview.status, 403);

    // "Resolves to more than one" is the rule, not "named more than one":
    // somebody else's id resolves to nothing, so this is a run for one.
    const withStranger = await server.post('dora', '/generation/batches', {
      jobs: JOBS,
      profileIds: ['dora-1', 'pria-1'],
    });
    assert.equal(withStranger.status, 202, JSON.stringify(withStranger.body));
    assert.equal(withStranger.body.profileCount, 1);
  } finally {
    server.close();
  }
});

test('Premium and up may target several profiles, all of them, or a group', async () => {
  const server = await serve('premium');
  try {
    for (const [shape, ids] of MULTI_SHAPES) {
      for (const mode of ['immediate', 'order']) {
        const response = await server.post('pria', '/generation/batches', { jobs: JOBS, ...ids('pria'), mode });
        assert.equal(response.status, 202, `${shape} ${mode}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.profileCount, 2);
      }
      assert.equal((await server.post('pria', '/generation/quote', { jobs: JOBS, ...ids('pria') })).status, 200);
      assert.notEqual(
        (await server.post('pria', '/resume/preview-all', { jobDescription: 'short', ...ids('pria') })).status,
        403
      );
    }
  } finally {
    server.close();
  }
});

test('an administrator on the Default subscription is exempt', async () => {
  const server = await serve('admin');
  try {
    assert.equal(users.getUserById(server.admin.id).subscription, 'default');
    for (const [shape, ids] of MULTI_SHAPES) {
      const response = await server.post('admin', '/generation/batches', { jobs: JOBS, ...ids('admin'), mode: 'order' });
      assert.equal(response.status, 202, `${shape}: ${JSON.stringify(response.body)}`);
      assert.equal((await server.post('admin', '/generation/quote', { jobs: JOBS, ...ids('admin') })).status, 200);
    }
  } finally {
    server.close();
  }
});

test('assertProfileScopeAllowed: the shapes, on their own', () => {
  const { assertProfileScopeAllowed } = require('../dist/middleware/auth');
  const user = { role: 'user', subscription: 'default' };
  const refused = (scope, account = user) =>
    assert.throws(() => assertProfileScopeAllowed(account, scope), (error) => error.code === 'subscription-too-low');
  const allowed = (scope, account = user) => assert.doesNotThrow(() => assertProfileScopeAllowed(account, scope));

  allowed({ profileIds: ['a'], resolvedCount: 1 });
  allowed({ profileIds: ['a', 'gone'], resolvedCount: 1 });
  allowed({ profileIds: [], resolvedCount: 0 });
  refused({ profileIds: ['a', 'b'], resolvedCount: 2 });
  refused({ profileIds: undefined, resolvedCount: 1 }, user);
  refused({ profileIds: 'a,b', resolvedCount: 1 }, user);
  allowed({ profileIds: undefined, resolvedCount: 5 }, { role: 'user', subscription: 'premium-max' });
  allowed({ profileIds: ['a', 'b'], resolvedCount: 2 }, { role: 'admin', subscription: 'default' });
});

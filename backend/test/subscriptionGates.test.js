const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { seedProfileWithResumes, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * One profile per run, on every tier (owner decision 10), where it is real: on
 * the server.
 *
 * There is no scope gate any more (`assertProfileScopeAllowed` and
 * MULTI_PROFILE_SUBSCRIPTION are gone, and so is `/resume/preview-all`). A run
 * names exactly ONE profile - a person - and the subscription decides only how
 * many profiles an account may keep. So:
 *
 *   - a Default account builds ONE profile that holds three resumes, in every
 *     mode, as Generate Immediately and as an Order, and may quote and preview
 *     it: nothing in a run is locked by the tier;
 *   - a body naming two profiles, a `profileIds` list of any size, resume ids,
 *     or no profile at all is 400 `one-profile-per-run` ("Choose one profile
 *     to build for.") for EVERY tier, administrators included - on the
 *     submission and the quote alike - before anything is charged, queued or
 *     filed;
 *   - a profile that is not the caller's is 404, an administrator's included;
 *     one with no enabled resume is 400 `no-profiles-to-build`.
 */

const config = require('../dist/config/aiModelConfig');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const orders = require('../dist/database/orderRepository');
const queueModule = require('../dist/services/queue/index');

function resumeInput(id, name, extra = {}) {
  return {
    id,
    name,
    title: 'Engineer',
    skills: ['C#'],
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 's',
    experience: [],
    strengths: [],
    education: [],
    ...extra,
  };
}

const JOBS = [{ companyName: 'Acme', role: 'Engineer', jobDescription: 'short' }];
const ONE_PROFILE = 'Choose one profile to build for.';

async function serve(name) {
  useTempStorage(`subscription-gates-${name}`);
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();

  const admin = users.createUser({ email: 'admin@example.com' });
  const dora = users.createUser({ email: 'dora@example.com' });
  const pria = users.updateUser(users.createUser({ email: 'pria@example.com' }).id, { subscription: 'premium' });

  // Every account has TWO people: `one` holds three resumes (the first is its
  // default), `two` holds one. A Default account keeps any it had before a
  // downgrade, which is exactly the account that used to be locked to one.
  const profiles = {};
  for (const [owner, prefix] of [
    [admin, 'admin'],
    [dora, 'dora'],
    [pria, 'pria'],
  ]) {
    profiles[prefix] = {
      one: seedProfileWithResumes(owner, `${prefix} one`, [
        resumeInput(`${prefix}-1`, `${prefix} first`),
        resumeInput(`${prefix}-2`, `${prefix} second`),
        resumeInput(`${prefix}-3`, `${prefix} third`),
      ]),
      two: seedProfileWithResumes(owner, `${prefix} two`, [resumeInput(`${prefix}-4`, `${prefix} fourth`)]),
    };
  }
  // A person whose only resume is switched off: nothing to build.
  profiles.dora.idle = seedProfileWithResumes(dora, 'dora idle', [resumeInput('dora-5', 'dora fifth', { disabled: true })]);

  // Priced (by mode), so "nothing was charged" is a figure that could have moved.
  await config.updateAppSettings({ suitablePriceUsd: '0.005', partialPriceUsd: '0.010', fullPriceUsd: '0.023' });
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
    profiles,
    balance: (account) => users.getUserById(account.id).balanceMilli,
    post: async (who, route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Express's own HTML 404 for a route that is gone.
      }
      return { status: response.status, body: parsed };
    },
    close: () => {
      server.close();
      queueModule.resetGenerationQueueForTests();
    },
  };
}

function assertOneProfile(response, what) {
  assert.equal(response.status, 400, `${what}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.code, 'one-profile-per-run', what);
  assert.equal(response.body.error, ONE_PROFILE, what);
}

/** Every shape that does not name exactly one profile. `ids` is the account's two people and a resume. */
function wrongShapes({ one, two }, resumeId) {
  return [
    ['two profiles named', { profileIds: [one.profileId, two.profileId] }],
    ['one profile named in a list', { profileIds: [one.profileId] }],
    ['an empty list', { profileIds: [] }],
    ['no profile at all (= every profile)', {}],
    ['a profile beside a list', { profileId: one.profileId, profileIds: [one.profileId, two.profileId] }],
    ['resume ids', { profileId: one.profileId, resumeIds: [resumeId] }],
    ['resume ids alone', { resumeIds: [resumeId] }],
    ['a blank profile id', { profileId: '  ' }],
  ];
}

test('a Default account is refused every shape that is not exactly one profile - as Generate Immediately and as an Order', async () => {
  const server = await serve('default-refused');
  try {
    for (const [shape, ids] of wrongShapes(server.profiles.dora, 'dora-1')) {
      for (const mode of [{}, { mode: 'immediate' }, { mode: 'order' }]) {
        for (const buildMode of [{}, { buildMode: 'suitable' }, { buildMode: 'partial' }, { buildMode: 'full' }]) {
          const response = await server.post('dora', '/generation/batches', { jobs: JOBS, ...ids, ...mode, ...buildMode });
          assertOneProfile(response, `${shape} ${JSON.stringify(mode)} ${JSON.stringify(buildMode)}`);
        }
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

test('the quote refuses the same shapes, a no-jobs quote included, and /resume/preview-all is gone', async () => {
  const server = await serve('default-quote-preview');
  try {
    for (const [shape, ids] of wrongShapes(server.profiles.dora, 'dora-1')) {
      assertOneProfile(await server.post('dora', '/generation/quote', { jobs: JOBS, ...ids }), `quote, ${shape}`);
    }
    // A quote of no jobs yet is still refused when it names no single profile:
    // the refusal is about who the run is for, and the cost line is asked early.
    assertOneProfile(await server.post('dora', '/generation/quote', { jobs: [] }), 'quote with no jobs, no profile');

    // The multi-profile preview no longer exists, for anybody.
    for (const who of ['dora', 'pria', 'admin']) {
      const gone = await server.post(who, '/resume/preview-all', {
        jobDescription: 'short',
        profileIds: [server.profiles[who].one.profileId],
      });
      assert.equal(gone.status, 404, who);
    }
  } finally {
    server.close();
  }
});

test('one profile that holds three resumes is open to a Default account in every mode: immediate, order, quote and preview', async () => {
  const server = await serve('default-single');
  try {
    const { profileId, resumeIds } = server.profiles.dora.one;
    for (const buildMode of ['suitable', 'partial', 'full']) {
      const single = { jobs: JOBS, profileId, buildMode };
      const immediate = await server.post('dora', '/generation/batches', { ...single, mode: 'immediate' });
      assert.equal(immediate.status, 202, `${buildMode}: ${JSON.stringify(immediate.body)}`);
      assert.equal(immediate.body.kind, 'immediate');
      assert.equal(immediate.body.buildMode, buildMode);
      assert.equal(immediate.body.total, 1, 'one job, one resume of the three');

      // Ordering is not locked either: a Default account orders for its profile.
      const ordered = await server.post('dora', '/generation/batches', { ...single, mode: 'order' });
      assert.equal(ordered.status, 202, `${buildMode}: ${JSON.stringify(ordered.body)}`);
      assert.equal(ordered.body.kind, 'order');
      assert.match(ordered.body.orderNumber, /^FT-\d{8}-\d{4}$/);
      assert.equal('profileCount' in ordered.body, false);

      // The choice is one of the profile's own resumes (Fully Tailor: its default).
      for (const accepted of [immediate, ordered]) {
        const [task] = queueModule.getGenerationQueue().getBatch(accepted.body.batchId).tasks;
        assert.ok(resumeIds.includes(task.payload.resumeId), `${buildMode}: a resume of that profile`);
        assert.equal(task.payload.buildMode, buildMode);
        if (buildMode === 'full') assert.equal(task.payload.resumeId, resumeIds[0], 'Fully Tailor builds the default');
      }

      const quote = await server.post('dora', '/generation/quote', single);
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      assert.equal(quote.body.resumes, 1);
      assert.equal(quote.body.buildMode, buildMode);

      const preview = await server.post('dora', '/resume/preview', { jobDescription: 'short', profileId, buildMode });
      assert.notEqual(preview.status, 403, buildMode);
      assert.notEqual(preview.body?.code, 'one-profile-per-run', buildMode);
    }

    // A Default account with two profiles (it kept them past a downgrade) may
    // build either, one at a time.
    const other = await server.post('dora', '/generation/batches', {
      jobs: JOBS,
      profileId: server.profiles.dora.two.profileId,
      mode: 'order',
    });
    assert.equal(other.status, 202, JSON.stringify(other.body));
  } finally {
    server.close();
  }
});

test("another account's profile is nobody's to build, and a profile with no enabled resume has nothing to build", async () => {
  const server = await serve('foreign-and-idle');
  try {
    // Pria's profile, asked for by Dora - and by an administrator, who has no
    // more right to it than the owner's own pages give.
    for (const [who, profileId] of [
      ['dora', server.profiles.pria.one.profileId],
      ['admin', server.profiles.pria.one.profileId],
      ['dora', 'not-a-profile'],
    ]) {
      for (const route of ['/generation/batches', '/generation/quote']) {
        const response = await server.post(who, route, { jobs: JOBS, profileId });
        assert.equal(response.status, 404, `${who} ${route}`);
        assert.equal(response.body.code, 'profile-not-found', `${who} ${route}`);
        assert.equal(response.body.error, 'That profile was not found. It may have been deleted; reload the page.');
      }
    }
    const idle = await server.post('dora', '/generation/batches', { jobs: JOBS, profileId: server.profiles.dora.idle.profileId });
    assert.equal(idle.status, 400);
    assert.equal(idle.body.code, 'no-profiles-to-build');
    assert.equal(idle.body.error, 'That profile has no enabled resume to build. Add or enable a resume on its page.');

    assert.equal(server.balance(server.dora), 1_000);
    assert.equal(queueModule.getGenerationQueue().listBatches(false).length, 0);
  } finally {
    server.close();
  }
});

test('Premium is no different: one profile per run, whatever the tier', async () => {
  const server = await serve('premium');
  try {
    for (const [shape, ids] of wrongShapes(server.profiles.pria, 'pria-1')) {
      assertOneProfile(await server.post('pria', '/generation/batches', { jobs: JOBS, ...ids, mode: 'order' }), shape);
      assertOneProfile(await server.post('pria', '/generation/quote', { jobs: JOBS, ...ids }), `quote, ${shape}`);
    }
    for (const mode of ['immediate', 'order']) {
      const response = await server.post('pria', '/generation/batches', {
        jobs: JOBS,
        profileId: server.profiles.pria.one.profileId,
        mode,
      });
      assert.equal(response.status, 202, `${mode}: ${JSON.stringify(response.body)}`);
      assert.equal('profileCount' in response.body, false);
    }
    assert.equal(
      (await server.post('pria', '/generation/quote', { jobs: JOBS, profileId: server.profiles.pria.two.profileId })).status,
      200
    );
  } finally {
    server.close();
  }
});

test('an administrator on the Default subscription is exempt from charges, not from the one-profile rule', async () => {
  const server = await serve('admin');
  try {
    assert.equal(users.getUserById(server.admin.id).subscription, 'default');
    for (const [shape, ids] of wrongShapes(server.profiles.admin, 'admin-1')) {
      assertOneProfile(await server.post('admin', '/generation/batches', { jobs: JOBS, ...ids, mode: 'order' }), shape);
      assertOneProfile(await server.post('admin', '/generation/quote', { jobs: JOBS, ...ids }), `quote, ${shape}`);
    }
    const profileId = server.profiles.admin.one.profileId;
    const response = await server.post('admin', '/generation/batches', { jobs: JOBS, profileId, mode: 'order' });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const quote = await server.post('admin', '/generation/quote', { jobs: JOBS, profileId });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.exempt, true);
  } finally {
    server.close();
  }
});

test('the scope gate is gone from the code: no assertProfileScopeAllowed, no Premium run lock', () => {
  const auth = require('../dist/middleware/auth');
  assert.equal(auth.assertProfileScopeAllowed, undefined);
  const accountSubscriptions = require('../dist/config/accountSubscriptions');
  assert.equal(accountSubscriptions.MULTI_PROFILE_SUBSCRIPTION, undefined);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
/** One go per resume, so a failed task refunds at once rather than after retries. */
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * What a run is charged, end to end through the routes.
 *
 * Each resume costs the price of the model it runs on, resolved at submit the
 * way the task will resolve it. A batch is charged the SUM, in one reservation
 * whose history line breaks it down by model; a 402 names that sum; each task
 * that fails gives back its own price; and the quote says exactly what the
 * submission will charge, without charging anything.
 *
 * No resume is actually built: the temp static directory holds no template, so
 * every task - and `/resume/generate` - fails at its template, after the charge
 * and before any model call. That is what lets these follow the money through a
 * real run with nothing spawned: the charge, then the refund of each failure.
 *
 * Modules are required once rather than loaded fresh, so the routes and the
 * test read and write one cache of the model settings.
 */

const GENERIC = "That model isn't available. Choose another, or contact your administrator.";

const config = require('../dist/config/aiModelConfig');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const queueModule = require('../dist/services/queue/index');

function profileInput(name, extra = {}) {
  return {
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

function jobsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${index}`,
    role: 'Engineer',
    jobDescription: 'A job description long enough to be analysed. '.repeat(4),
  }));
}

async function serve(name) {
  useTempStorage(`generation-pricing-${name}`);
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

  // Two profiles: one that picked Opus, one that inherits the default (Sonnet).
  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  saveProfile({
    ...buildNewProfile(profileInput('Ada', { profileSettings: { ai: { modelId: 'claude-cli-opus' } } }), 'p-opus'),
    ownerId: alice.id,
  });
  saveProfile({ ...buildNewProfile(profileInput('Bea'), 'p-plain'), ownerId: alice.id });
  saveProfile({ ...buildNewProfile(profileInput('Cy'), 'p-admin'), ownerId: admin.id });
  await config.updateAIModel('claude-cli-opus', { creditsPerResume: 2 });

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  app.use('/api/resume', require('../dist/routes/resume').default);
  const server = app.listen(0);
  const port = server.address().port;

  const post = async (who, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    post,
    admin,
    alice,
    balance: (account) => users.getUserById(account.id).credits,
    ledger: (account, reason) =>
      credits.getLedger(account.id, 500).filter((entry) => !reason || entry.reason === reason),
    close: () => {
      server.close();
      queueModule.resetGenerationQueueForTests();
    },
  };
}

async function untilFinished(batchId) {
  const queue = queueModule.getGenerationQueue();
  for (let i = 0; i < 300; i += 1) {
    const snapshot = queue.snapshot(batchId);
    if (snapshot && snapshot.state !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`batch ${batchId} did not finish`);
}

/* ------------------------------------------------------------- the quote */

test('the quote is what the submission charges, says nothing about models, and charges nothing', async () => {
  const server = await serve('quote');
  try {
    credits.setBalance(server.alice.id, 10, server.admin.id);
    const body = { jobs: jobsFor(2), profileIds: ['p-opus', 'p-plain'] };

    const quote = await server.post('alice', '/generation/quote', body);
    assert.equal(quote.status, 200);
    // Two jobs x (Opus at 2 + Sonnet at 1).
    assert.deepEqual(quote.body, { resumes: 4, credits: 6, balance: 10, exempt: false });
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), [], 'a quote reserves nothing');
    assert.equal(server.balance(server.alice), 10);

    const submitted = await server.post('alice', '/generation/batches', body);
    assert.equal(submitted.status, 202);
    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(-reserve.delta, quote.body.credits, 'charged exactly what was quoted');
    await untilFinished(submitted.body.batchId);
  } finally {
    server.close();
  }
});

test('the quote follows the model the request names, and an empty selection is a quote of nothing', async () => {
  const server = await serve('quote-override');
  try {
    await config.updateAIModel('gemini-cli-auto', { creditsPerResume: 5 });
    const override = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileIds: ['p-opus', 'p-plain'],
      model: 'gemini-cli-auto',
    });
    assert.deepEqual(override.body, { resumes: 2, credits: 10, balance: 0, exempt: false });

    // While the form is still being filled in: no jobs, or no profile that matches.
    for (const body of [{ profileIds: ['p-opus'] }, { jobs: jobsFor(1), profileIds: ['not-mine'] }]) {
      const empty = await server.post('alice', '/generation/quote', body);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body, { resumes: 0, credits: 0, balance: 0, exempt: false });
    }
    // A missing company name does not change the price, so it does not stop the quote.
    const unnamed = await server.post('alice', '/generation/quote', {
      jobs: [{ companyName: '', role: '' }],
      profileIds: ['p-plain'],
    });
    assert.deepEqual(unnamed.body, { resumes: 1, credits: 1, balance: 0, exempt: false });

    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const refused = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileIds: ['p-plain'],
      model: 'claude-cli-haiku',
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: GENERIC, code: 'model-unavailable' });
  } finally {
    server.close();
  }
});

test('an administrator is quoted the full amount, and told they are exempt', async () => {
  const server = await serve('quote-admin');
  try {
    const quote = await server.post('admin', '/generation/quote', { jobs: jobsFor(3), profileIds: ['p-admin'] });
    assert.deepEqual(quote.body, { resumes: 3, credits: 3, balance: 0, exempt: true });
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------- a batch */

test('a mixed-price batch is charged the sum, broken down by model, and each failure refunds its own price', async () => {
  const server = await serve('mixed-batch');
  try {
    credits.setBalance(server.alice.id, 10, server.admin.id);
    const submitted = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileIds: ['p-opus', 'p-plain'],
    });
    assert.equal(submitted.status, 202);

    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(reserve.delta, -6);
    assert.match(
      reserve.note,
      /^4 resumes: (2 x Claude Opus @ 2, 2 x Claude Sonnet @ 1|2 x Claude Sonnet @ 1, 2 x Claude Opus @ 2) = 6 credits$/
    );

    // Every task carries the price it was charged, outside its choice.
    const batch = queueModule.getGenerationQueue().getBatch(submitted.body.batchId);
    for (const task of batch.tasks) {
      const expected = task.payload.profileId === 'p-opus' ? 2 : 1;
      assert.equal(task.payload.creditCost, expected);
      assert.equal('creditCost' in task.payload.choice, false);
    }

    // No template here, so every resume fails - and gives back its own price.
    await untilFinished(submitted.body.batchId);
    const refunds = server.ledger(server.alice, 'generation-refund').map((entry) => entry.delta).sort();
    assert.deepEqual(refunds, [1, 1, 2, 2]);
    assert.equal(server.balance(server.alice), 10);
  } finally {
    server.close();
  }
});

test('a batch the balance cannot cover is a 402 naming the whole sum, and nothing is queued or taken', async () => {
  const server = await serve('batch-402');
  try {
    credits.setBalance(server.alice.id, 5, server.admin.id);
    const refused = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileIds: ['p-opus', 'p-plain'],
    });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, 'insufficient-credits');
    assert.equal(refused.body.needed, 6);
    assert.equal(refused.body.balance, 5);
    assert.match(refused.body.error, /needs 6 credits and the account has 5/);
    assert.equal(server.balance(server.alice), 5);
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    server.close();
  }
});

test('a run on a free model takes nothing, writes nothing, and runs on an empty balance', async () => {
  const server = await serve('free');
  try {
    await config.updateAIModel('gemini-cli-auto', { creditsPerResume: 0 });
    const submitted = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileIds: ['p-plain'],
      model: 'gemini-cli-auto',
    });
    assert.equal(submitted.status, 202);
    await untilFinished(submitted.body.batchId);
    assert.deepEqual(
      server.ledger(server.alice).filter((entry) => entry.reason.startsWith('generation')),
      [],
      'no reservation, no refund'
    );
  } finally {
    server.close();
  }
});

test('an administrator runs a priced batch and is charged nothing', async () => {
  const server = await serve('admin-batch');
  try {
    credits.setBalance(server.admin.id, 1, server.admin.id);
    const submitted = await server.post('admin', '/generation/batches', { jobs: jobsFor(3), profileIds: ['p-admin'] });
    assert.equal(submitted.status, 202);
    await untilFinished(submitted.body.batchId);
    assert.equal(server.balance(server.admin), 1);
    assert.deepEqual(server.ledger(server.admin).filter((entry) => entry.reason.startsWith('generation')), []);
  } finally {
    server.close();
  }
});

test('a batch naming a model it may not use is refused before anything is charged', async () => {
  const server = await serve('batch-refused');
  try {
    credits.setBalance(server.alice.id, 10, server.admin.id);
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    for (const model of ['claude-cli-haiku', 'claude-cli', 'claude-cli:sonnet']) {
      const refused = await server.post('alice', '/generation/batches', {
        jobs: jobsFor(1),
        profileIds: ['p-plain'],
        model,
      });
      assert.equal(refused.status, 400, model);
      assert.deepEqual(refused.body, { error: GENERIC, code: 'model-unavailable' });
    }
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), []);

    // An administrator may still use the provider forms.
    const admin = await server.post('admin', '/generation/batches', {
      jobs: jobsFor(1),
      profileIds: ['p-admin'],
      model: 'codex-cli',
    });
    assert.equal(admin.status, 202);
    await untilFinished(admin.body.batchId);
  } finally {
    server.close();
  }
});

/* ---------------------------------------------------- one resume, in line */

test('/resume/generate resolves the model first and charges its price', async () => {
  const server = await serve('single');
  try {
    credits.setBalance(server.alice.id, 10, server.admin.id);
    // No template in this storage: the run fails after the charge, before any
    // model call, and the charge comes back.
    const failed = await server.post('alice', '/resume/generate', { profileId: 'p-opus', companyName: 'Acme' });
    assert.equal(failed.status, 500);
    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(reserve.delta, -2, "Opus's price");
    assert.equal(reserve.note, 'Ada / Acme - 1 resume: 1 x Claude Opus @ 2 = 2 credits');
    assert.equal(server.balance(server.alice), 10, 'the run did not finish, so it was given back');

    credits.setBalance(server.alice.id, 1, server.admin.id);
    const short = await server.post('alice', '/resume/generate', { profileId: 'p-opus', companyName: 'Acme' });
    assert.equal(short.status, 402);
    assert.equal(short.body.needed, 2);
    assert.equal(short.body.balance, 1);

    // Refused before the charge: a run naming a model it may not use takes nothing.
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const before = server.ledger(server.alice).length;
    const refused = await server.post('alice', '/resume/generate', {
      profileId: 'p-plain',
      companyName: 'Acme',
      model: 'claude-cli-haiku',
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: GENERIC, code: 'model-unavailable' });
    assert.equal(server.ledger(server.alice).length, before, 'nothing reserved, nothing released');
  } finally {
    server.close();
  }
});

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
/** One go per resume, so a failed task refunds at once rather than after retries. */
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { storeJobAnalysis, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * What a run is charged, end to end through the routes.
 *
 * Each resume costs the price of the model it runs on, resolved at submit the
 * way the task will resolve it - in thousandths of a dollar: Sonnet $0.010 and
 * Opus $0.023 here, so every figure below is exact. A batch is charged the
 * SUM, in one reservation
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

/**
 * The model-unavailable body anybody but an administrator gets: the one public
 * sentence, its code, and the ref its cause was logged under - never the cause.
 */
function assertModelUnavailable(body) {
  const { ref, ...rest } = body;
  assert.deepEqual(rest, { error: GENERIC, code: 'model-unavailable' });
  assert.match(ref, /^ERR-[0-9A-F]{6}$/);
}

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

async function serve(name, { seeds = false } = {}) {
  const { staticDir } = useTempStorage(`generation-pricing-${name}`);
  if (seeds) {
    // The default template and the shipped prompts, for the tests that need a
    // preview to really be written: /preview renders HTML only, so nothing
    // here prints a PDF.
    const fs = require('node:fs');
    const path = require('node:path');
    const shipped = path.join(__dirname, '..', 'static');
    fs.mkdirSync(path.join(staticDir, 'templates'), { recursive: true });
    fs.copyFileSync(path.join(shipped, 'templates', 'default.json'), path.join(staticDir, 'templates', 'default.json'));
    fs.cpSync(path.join(shipped, 'prompts'), path.join(staticDir, 'prompts'), { recursive: true });
  }
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();

  const admin = users.createUser({ email: 'admin@example.com' });
  // Premium: these are tests about what a run costs, and most of them price
  // a run for both of Alice's profiles, which a Default subscription may not
  // build (test/subscriptionGates.test.js).
  const alice = users.updateUser(users.createUser({ email: 'alice@example.com' }).id, { subscription: 'premium' });
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
  // Every seed is free until priced; these two are priced, the rest stay free.
  await config.updateAIModel('claude-cli-opus', { pricePerResumeUsd: '0.023' });
  await config.updateAIModel('claude-cli-sonnet', { pricePerResumeUsd: '0.010' });

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
    balance: (account) => users.getUserById(account.id).balanceMilli,
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
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    const body = { jobs: jobsFor(2), profileIds: ['p-opus', 'p-plain'] };

    const quote = await server.post('alice', '/generation/quote', body);
    assert.equal(quote.status, 200);
    // Two jobs x (Opus at $0.023 + Sonnet at $0.010), and no one price per
    // resume to name, since the two differ.
    assert.deepEqual(quote.body, {
      resumes: 4,
      costMilli: 66,
      pricePerResumeMilli: null,
      balanceMilli: 1_000,
      exempt: false,
    });
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), [], 'a quote reserves nothing');
    assert.equal(server.balance(server.alice), 1_000);

    const submitted = await server.post('alice', '/generation/batches', body);
    assert.equal(submitted.status, 202);
    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(-reserve.deltaMilli, quote.body.costMilli, 'charged exactly what was quoted');
    await untilFinished(submitted.body.batchId);
  } finally {
    server.close();
  }
});

test('the quote follows the model the request names, and an empty selection is a quote of nothing', async () => {
  const server = await serve('quote-override');
  try {
    await config.updateAIModel('gemini-cli-auto', { pricePerResumeUsd: '0.050' });
    const override = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileIds: ['p-opus', 'p-plain'],
      model: 'gemini-cli-auto',
    });
    // One model for both, so one price per resume: "2 resumes x $0.050 = $0.100".
    assert.deepEqual(override.body, {
      resumes: 2,
      costMilli: 100,
      pricePerResumeMilli: 50,
      balanceMilli: 0,
      exempt: false,
    });

    // While the form is still being filled in: no jobs, or no profile that matches.
    for (const body of [{ profileIds: ['p-opus'] }, { jobs: jobsFor(1), profileIds: ['not-mine'] }]) {
      const empty = await server.post('alice', '/generation/quote', body);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body, { resumes: 0, costMilli: 0, pricePerResumeMilli: null, balanceMilli: 0, exempt: false });
    }
    // A missing company name does not change the price, so it does not stop the quote.
    const unnamed = await server.post('alice', '/generation/quote', {
      jobs: [{ companyName: '', role: '' }],
      profileIds: ['p-plain'],
    });
    assert.deepEqual(unnamed.body, { resumes: 1, costMilli: 10, pricePerResumeMilli: 10, balanceMilli: 0, exempt: false });

    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const refused = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileIds: ['p-plain'],
      model: 'claude-cli-haiku',
    });
    assert.equal(refused.status, 400);
    assertModelUnavailable(refused.body);
  } finally {
    server.close();
  }
});

test('an administrator is quoted the full amount, and told they are exempt', async () => {
  const server = await serve('quote-admin');
  try {
    const quote = await server.post('admin', '/generation/quote', { jobs: jobsFor(3), profileIds: ['p-admin'] });
    assert.deepEqual(quote.body, { resumes: 3, costMilli: 30, pricePerResumeMilli: 10, balanceMilli: 0, exempt: true });
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------- a batch */

test('a mixed-price batch is charged the sum, broken down by model, and each failure refunds its own price', async () => {
  const server = await serve('mixed-batch');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    const submitted = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileIds: ['p-opus', 'p-plain'],
    });
    assert.equal(submitted.status, 202);

    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(reserve.deltaMilli, -66);
    assert.match(
      reserve.note,
      /^4 resumes: (2 x Claude Opus @ \$0\.023, 2 x Claude Sonnet @ \$0\.01|2 x Claude Sonnet @ \$0\.01, 2 x Claude Opus @ \$0\.023) = \$0\.066$/
    );

    // Every task carries the price it was charged, outside its choice.
    const batch = queueModule.getGenerationQueue().getBatch(submitted.body.batchId);
    for (const task of batch.tasks) {
      const expected = task.payload.profileId === 'p-opus' ? 23 : 10;
      assert.equal(task.payload.costMilli, expected);
      assert.equal('costMilli' in task.payload.choice, false);
      assert.equal('creditCost' in task.payload, false, 'nothing in the old unit');
    }

    // No template here, so every resume fails - and gives back its own price.
    await untilFinished(submitted.body.batchId);
    const refunds = server
      .ledger(server.alice, 'generation-refund')
      .map((entry) => entry.deltaMilli)
      .sort((a, b) => a - b);
    assert.deepEqual(refunds, [10, 10, 23, 23]);
    assert.equal(server.balance(server.alice), 1_000);
  } finally {
    server.close();
  }
});

test("an order's resumes keep what each was charged, for a refund asked for after the batch is gone", async () => {
  const server = await serve('order-item-cost');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    const submitted = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileIds: ['p-opus', 'p-plain'],
      asOrder: true,
    });
    assert.equal(submitted.status, 202);
    const orders = require('../dist/database/orderRepository');
    const items = orders.listOrderItems(submitted.body.orderId);
    const batch = queueModule.getGenerationQueue().getBatch(submitted.body.batchId);
    // Item by item, the task's own snapshotted price - Opus $0.023, Sonnet $0.010.
    assert.deepEqual(
      items.map((item) => item.costMilli),
      batch.tasks.map((task) => task.payload.costMilli)
    );
    assert.deepEqual(items.map((item) => item.costMilli).sort(), [10, 10, 23, 23]);
    await untilFinished(submitted.body.batchId);
  } finally {
    server.close();
  }
});

test('a batch the balance cannot cover is a 402 naming the whole sum, and nothing is queued or taken', async () => {
  const server = await serve('batch-402');
  try {
    // A thousandth short: exact arithmetic is what makes this a refusal.
    credits.setBalance(server.alice.id, 65, server.admin.id);
    const refused = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileIds: ['p-opus', 'p-plain'],
    });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, 'insufficient-credits');
    assert.equal(refused.body.neededMilli, 66);
    assert.equal(refused.body.balanceMilli, 65);
    assert.match(refused.body.error, /needs \$0\.066 of credit and the account has \$0\.065/);
    assert.equal(server.balance(server.alice), 65);
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    server.close();
  }
});

test('a run on a free model takes nothing, writes nothing, and runs on an empty balance', async () => {
  const server = await serve('free');
  try {
    await config.updateAIModel('gemini-cli-auto', { pricePerResumeUsd: '0' });
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
    assert.equal(server.balance(server.admin), 1, '$0.001, untouched by a $0.030 run');
    assert.deepEqual(server.ledger(server.admin).filter((entry) => entry.reason.startsWith('generation')), []);
  } finally {
    server.close();
  }
});

test('a batch naming a model it may not use is refused before anything is charged', async () => {
  const server = await serve('batch-refused');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    for (const model of ['claude-cli-haiku', 'claude-cli', 'claude-cli:sonnet']) {
      const refused = await server.post('alice', '/generation/batches', {
        jobs: jobsFor(1),
        profileIds: ['p-plain'],
        model,
      });
      assert.equal(refused.status, 400, model);
      assertModelUnavailable(refused.body);
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
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    // No template in this storage: the run fails after the charge, before any
    // model call, and the charge comes back.
    const failed = await server.post('alice', '/resume/generate', { profileId: 'p-opus', companyName: 'Acme' });
    // The administrator's to fix, so a 503 that says whom to ask, with a ref.
    assert.equal(failed.status, 503);
    assert.match(failed.body.error, /No resume template is available right now\. Please contact your administrator\./);
    assert.match(failed.body.ref, /^ERR-[0-9A-F]{6}$/);
    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(reserve.deltaMilli, -23, "Opus's price");
    assert.equal(reserve.note, 'Ada / Acme - 1 resume: 1 x Claude Opus @ $0.023 = $0.023');
    assert.equal(server.balance(server.alice), 1_000, 'the run did not finish, so it was given back');

    credits.setBalance(server.alice.id, 22, server.admin.id);
    const short = await server.post('alice', '/resume/generate', { profileId: 'p-opus', companyName: 'Acme' });
    assert.equal(short.status, 402);
    assert.equal(short.body.neededMilli, 23);
    assert.equal(short.body.balanceMilli, 22);

    // Refused before the charge: a run naming a model it may not use takes nothing.
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const before = server.ledger(server.alice).length;
    const refused = await server.post('alice', '/resume/generate', {
      profileId: 'p-plain',
      companyName: 'Acme',
      model: 'claude-cli-haiku',
    });
    assert.equal(refused.status, 400);
    assertModelUnavailable(refused.body);
    assert.equal(server.ledger(server.alice).length, before, 'nothing reserved, nothing released');
  } finally {
    server.close();
  }
});

/* ------------------------------------- content a preview already wrote */

const ANALYSIS = {
  jobMeta: { title: 'Engineer', seniority: '', industry: '', department: '' },
  skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [],
  protocols: [],
  methodologies: [],
  architecturePatterns: [],
  responsibilities: [],
  domainKnowledge: [],
  softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
};

/** A Claude seat that answers every tailoring with a summary naming the model that wrote it. */
function claudeSeatNamingItsModel(calls) {
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      calls.push(request.modelName);
      const text = JSON.stringify({ summary: `Written by ${request.modelName}.`, hardSkills: [], softSkills: [], experience: [] });
      return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));
  return () => ai.resetRegistryForTests();
}

test('a preview hands back a token naming the model that wrote it, and a re-render of supplied content gets none', async () => {
  const server = await serve('preview-token', { seeds: true });
  const calls = [];
  const restore = claudeSeatNamingItsModel(calls);
  const { readPreviewToken } = require('../dist/services/credits/previewToken');
  // The page names the posting's stored analysis; an analysis object is not read.
  const analysisId = storeJobAnalysis(ANALYSIS);
  try {
    const single = await server.post('alice', '/resume/preview', {
      profileId: 'p-plain',
      model: 'claude-cli-opus',
      analysisId,
    });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.deepEqual(calls, ['opus']);
    assert.equal(
      readPreviewToken(single.body.previewToken, { userId: server.alice.id, profileId: 'p-plain' }),
      'claude-cli-opus'
    );
    // Issued to this account for this profile, and nobody else's.
    assert.equal(readPreviewToken(single.body.previewToken, { userId: server.admin.id, profileId: 'p-plain' }), null);
    assert.equal(readPreviewToken(single.body.previewToken, { userId: server.alice.id, profileId: 'p-opus' }), null);
    assert.equal(readPreviewToken(`${single.body.previewToken}x`, { userId: server.alice.id, profileId: 'p-plain' }), null);

    // Re-rendering content the request supplies runs no model, so it proves
    // nothing about which model wrote it.
    const rerender = await server.post('alice', '/resume/preview', {
      profileId: 'p-plain',
      model: 'claude-cli-haiku',
      analysisId,
      tailoredContent: single.body.tailoredContent,
    });
    assert.equal(rerender.status, 200);
    assert.equal(rerender.body.previewToken, undefined);
    assert.equal(calls.length, 1);

    // The multi-profile preview runs each profile on the request's model when
    // it names one - and on the profile's own when it does not - and each
    // preview's token says which.
    const jobDescription = jobsFor(1)[0].jobDescription;
    const named = await server.post('alice', '/resume/preview-all', {
      profileIds: ['p-opus', 'p-plain'],
      model: 'claude-cli-haiku',
      jobDescription,
      analysisId,
    });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    const unnamed = await server.post('alice', '/resume/preview-all', {
      profileIds: ['p-opus', 'p-plain'],
      jobDescription,
      analysisId,
    });
    const tokenModel = (body, profileId) =>
      readPreviewToken(body.previews.find((preview) => preview.profileId === profileId).previewToken, {
        userId: server.alice.id,
        profileId,
      });
    assert.equal(tokenModel(named.body, 'p-opus'), 'claude-cli-haiku');
    assert.equal(tokenModel(named.body, 'p-plain'), 'claude-cli-haiku');
    assert.equal(tokenModel(unnamed.body, 'p-opus'), 'claude-cli-opus');
    assert.equal(tokenModel(unnamed.body, 'p-plain'), 'claude-cli-sonnet');
    assert.deepEqual(server.ledger(server.alice), [], 'previews are free');
  } finally {
    restore();
    server.close();
  }
});

test("finalising a preview is charged the model that wrote it, not the one the request names", async () => {
  const server = await serve('finalize-price');
  const { issuePreviewToken } = require('../dist/services/credits/previewToken');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    await config.updateAIModel('claude-cli-haiku', { pricePerResumeUsd: '0' });
    const opusToken = issuePreviewToken({ userId: server.alice.id, profileId: 'p-plain', modelId: 'claude-cli-opus' });
    const written = { summary: 'Written by opus.', hardSkills: [], softSkills: [], experience: [] };
    const reserveNote = () => server.ledger(server.alice, 'generation-reserve').at(0)?.note ?? null;

    // Opus's work, finalised naming the free model: charged Opus. (No template
    // here, so the run stops after the charge and gives it back.)
    await server.post('alice', '/resume/generate', {
      profileId: 'p-plain',
      companyName: 'Acme',
      model: 'claude-cli-haiku',
      tailoredContent: written,
      previewToken: opusToken,
    });
    assert.equal(reserveNote(), 'Bea / Acme - 1 resume: 1 x Claude Opus @ $0.023 = $0.023');

    // A token for another profile, or a forged one, proves nothing - and
    // content of unknown origin is charged at least what the profile's own
    // model costs, never the free model the request names.
    for (const previewToken of [
      issuePreviewToken({ userId: server.alice.id, profileId: 'p-opus', modelId: 'claude-cli-haiku' }),
      `${opusToken.split('.')[0]}.forged`,
      undefined,
    ]) {
      await server.post('alice', '/resume/generate', {
        profileId: 'p-plain',
        companyName: 'Acme',
        model: 'claude-cli-haiku',
        tailoredContent: written,
        ...(previewToken ? { previewToken } : {}),
      });
      assert.equal(reserveNote(), 'Bea / Acme - 1 resume: 1 x Claude Sonnet @ $0.01 = $0.01');
    }
    // ...while naming a dearer model than the profile's is charged that.
    await server.post('alice', '/resume/generate', {
      profileId: 'p-plain',
      companyName: 'Acme',
      model: 'claude-cli-opus',
      tailoredContent: written,
    });
    assert.equal(reserveNote(), 'Bea / Acme - 1 resume: 1 x Claude Opus @ $0.023 = $0.023');

    // The queue the same way, and the quote with it: the tokens alone are
    // enough to price what finalising will charge.
    const batchBody = {
      jobs: jobsFor(1),
      profileIds: ['p-plain'],
      model: 'claude-cli-haiku',
      previewTokenByProfileId: { 'p-plain': opusToken },
    };
    const quote = await server.post('alice', '/generation/quote', batchBody);
    assert.equal(quote.body.costMilli, 23);
    const submitted = await server.post('alice', '/generation/batches', {
      ...batchBody,
      tailoredContentByProfileId: { 'p-plain': written },
    });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    assert.match(reserveNote(), /1 x Claude Opus @ \$0\.023 = \$0\.023$/);
    await untilFinished(submitted.body.batchId);

    const stripped = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(1),
      profileIds: ['p-plain'],
      model: 'claude-cli-haiku',
      tailoredContentByProfileId: { 'p-plain': written },
    });
    assert.equal(stripped.status, 202);
    assert.match(reserveNote(), /1 x Claude Sonnet @ \$0\.01 = \$0\.01$/);
    await untilFinished(stripped.body.batchId);
  } finally {
    server.close();
  }
});

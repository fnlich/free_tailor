const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
/** One go per resume, so a failed task refunds at once rather than after retries. */
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { seedProfileWithResumes, storeJobAnalysis, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * What a run is charged, end to end through the routes.
 *
 * The price is the BUILD MODE's, never the model's (owner decision 8, F2):
 * Choose Suitable Resume $0.005, Partial Tailor $0.010 and Fully Tailor $0.023
 * here, so every figure below is exact. A run builds ONE profile and costs
 * jobs x the mode's price. It is charged in one reservation whose history line
 * breaks it down by mode; a 402 names that sum; each task that fails gives
 * back its own price; and the quote says exactly what the submission will
 * charge, without charging anything.
 *
 * No resume is actually built: the temp static directory holds no template, so
 * every task fails at its template, after the charge and before any model
 * call. That is what lets these follow the money through a
 * real run with nothing spawned: the charge, then the refund of each failure.
 *
 * Modules are required once rather than loaded fresh, so the routes and the
 * test read and write one cache of the settings.
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

/** The three prices, in thousandths: distinct, so a figure names its mode. */
const PRICES = { suitable: 5, partial: 10, full: 23 };

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
  // A Default account: a run builds one profile on every tier, and these are
  // tests about what a run costs, so no subscription is needed.
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

  // Two people, one resume each: Ada's picked Opus, Bea's inherits the default
  // (Sonnet). One candidate means no choice to make: the resume is "the only".
  const ada = seedProfileWithResumes(alice, 'Ada', [
    resumeInput('p-opus', 'Ada', { resumeSettings: { ai: { modelId: 'claude-cli-opus' } } }),
  ]).profileId;
  const bea = seedProfileWithResumes(alice, 'Bea', [resumeInput('p-plain', 'Bea')]).profileId;
  const cy = seedProfileWithResumes(admin, 'Cy', [resumeInput('p-admin', 'Cy')]).profileId;

  // Every mode is free until priced (the code default is $0).
  await config.updateAppSettings({
    suitablePriceUsd: '0.005',
    partialPriceUsd: '0.010',
    fullPriceUsd: '0.023',
  });

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
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A route that does not exist answers Express's HTML 404.
    }
    return { status: response.status, body: parsed };
  };

  return {
    post,
    admin,
    alice,
    profiles: { ada, bea, cy },
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

test('the quote is jobs x the mode\'s price, names the mode, and charges nothing', async () => {
  const server = await serve('quote');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);

    // Two jobs for Ada. No buildMode: the one in effect, Partial Tailor.
    const body = { jobs: jobsFor(2), profileId: server.profiles.ada };
    const quote = await server.post('alice', '/generation/quote', body);
    assert.equal(quote.status, 200);
    assert.deepEqual(quote.body, {
      resumes: 2,
      costMilli: 20,
      pricePerResumeMilli: 10,
      balanceMilli: 1_000,
      exempt: false,
      buildMode: 'partial',
    });
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), [], 'a quote reserves nothing');
    assert.equal(server.balance(server.alice), 1_000);

    // The same run in each mode: only the mode's price changes it.
    for (const [buildMode, price] of Object.entries(PRICES)) {
      const quoted = await server.post('alice', '/generation/quote', { ...body, buildMode });
      assert.deepEqual(
        quoted.body,
        { resumes: 2, costMilli: 2 * price, pricePerResumeMilli: price, balanceMilli: 1_000, exempt: false, buildMode },
        buildMode
      );
    }

    const submitted = await server.post('alice', '/generation/batches', body);
    assert.equal(submitted.status, 202);
    assert.equal(submitted.body.buildMode, 'partial');
    assert.equal('profileCount' in submitted.body, false);
    const [reserve] = server.ledger(server.alice, 'generation-reserve');
    assert.equal(-reserve.deltaMilli, quote.body.costMilli, 'charged exactly what was quoted');
    await untilFinished(submitted.body.batchId);
  } finally {
    server.close();
  }
});

test('the model the request names changes no price, but is still refused when it cannot run', async () => {
  const server = await serve('quote-override');
  try {
    // Dearer or cheaper, the model plays no part: models carry no price.
    for (const model of [undefined, 'claude-cli-opus', 'gemini-cli-auto']) {
      const quoted = await server.post('alice', '/generation/quote', {
        jobs: jobsFor(1),
        profileId: server.profiles.ada,
        ...(model ? { model } : {}),
      });
      assert.equal(quoted.status, 200, String(model));
      assert.equal(quoted.body.costMilli, 10, String(model));
      assert.equal(quoted.body.pricePerResumeMilli, 10, String(model));
    }

    // While the form is still being filled in: no jobs is a quote of nothing.
    const empty = await server.post('alice', '/generation/quote', { profileId: server.profiles.ada });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, {
      resumes: 0,
      costMilli: 0,
      pricePerResumeMilli: null,
      balanceMilli: 0,
      exempt: false,
      buildMode: 'partial',
    });
    // A missing company name does not change the price, so it does not stop the quote.
    const unnamed = await server.post('alice', '/generation/quote', {
      jobs: [{ companyName: '', role: '' }],
      profileId: server.profiles.bea,
    });
    assert.deepEqual(unnamed.body, {
      resumes: 1,
      costMilli: 10,
      pricePerResumeMilli: 10,
      balanceMilli: 0,
      exempt: false,
      buildMode: 'partial',
    });

    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const refused = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileId: server.profiles.bea,
      model: 'claude-cli-haiku',
    });
    assert.equal(refused.status, 400);
    assertModelUnavailable(refused.body);
  } finally {
    server.close();
  }
});

test('the quote wants exactly one profile, and a junk mode is refused by name', async () => {
  const server = await serve('quote-one-profile');
  try {
    for (const extra of [
      {},
      { profileIds: [server.profiles.ada] },
      { profileIds: [server.profiles.ada, server.profiles.bea] },
      { profileId: server.profiles.ada, profileIds: [server.profiles.bea] },
      { resumeIds: ['p-opus'] },
    ]) {
      const refused = await server.post('alice', '/generation/quote', { jobs: jobsFor(1), ...extra });
      assert.equal(refused.status, 400, JSON.stringify(extra));
      assert.equal(refused.body.code, 'one-profile-per-run');
      assert.equal(refused.body.error, 'Choose one profile to build for.');
    }
    const junk = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileId: server.profiles.ada,
      buildMode: 'lazy',
    });
    assert.equal(junk.status, 400);
    assert.equal(junk.body.code, 'bad-build-mode');
    assert.equal(junk.body.error, 'buildMode must be "suitable", "partial" or "full".');
  } finally {
    server.close();
  }
});

test('an administrator is quoted the full amount, and told they are exempt', async () => {
  const server = await serve('quote-admin');
  try {
    const quote = await server.post('admin', '/generation/quote', { jobs: jobsFor(3), profileId: server.profiles.cy });
    assert.deepEqual(quote.body, {
      resumes: 3,
      costMilli: 30,
      pricePerResumeMilli: 10,
      balanceMilli: 0,
      exempt: true,
      buildMode: 'partial',
    });
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------- a batch */

test('a batch is charged jobs x the mode\'s price, broken down by mode, and each failure refunds its own price', async () => {
  const server = await serve('batch');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    const expected = {
      suitable: { total: 10, line: /^2 resumes: 2 x Choose Suitable Resume @ \$0\.005 = \$0\.01$/ },
      partial: { total: 20, line: /^2 resumes: 2 x Partial Tailor @ \$0\.01 = \$0\.02$/ },
      full: { total: 46, line: /^2 resumes: 2 x Fully Tailor @ \$0\.023 = \$0\.046$/ },
    };
    for (const [buildMode, { total, line }] of Object.entries(expected)) {
      const before = server.ledger(server.alice, 'generation-reserve').length;
      const submitted = await server.post('alice', '/generation/batches', {
        jobs: jobsFor(2),
        profileId: server.profiles.ada,
        buildMode,
      });
      assert.equal(submitted.status, 202, buildMode);
      assert.equal(submitted.body.buildMode, buildMode);

      const reserves = server.ledger(server.alice, 'generation-reserve');
      assert.equal(reserves.length, before + 1, buildMode);
      const reserve = reserves[0];
      assert.equal(reserve.deltaMilli, -total, buildMode);
      assert.match(reserve.note, line, buildMode);

      // Every task carries the price it was charged, outside its choice, and
      // the mode it was charged at.
      const batch = queueModule.getGenerationQueue().getBatch(submitted.body.batchId);
      assert.equal(batch.shared.buildMode, buildMode);
      for (const task of batch.tasks) {
        assert.equal(task.payload.costMilli, PRICES[buildMode], buildMode);
        assert.equal(task.payload.buildMode, buildMode);
        assert.equal('costMilli' in task.payload.choice, false);
        assert.equal('creditCost' in task.payload, false, 'nothing in the old unit');
      }

      // No template here, so every resume fails - and gives back its own price.
      await untilFinished(submitted.body.batchId);
      assert.equal(server.balance(server.alice), 1_000, `${buildMode}: refunded in full`);
    }
    const refunds = server
      .ledger(server.alice, 'generation-refund')
      .map((entry) => entry.deltaMilli)
      .sort((a, b) => a - b);
    assert.deepEqual(refunds, [5, 5, 10, 10, 23, 23], 'each failed resume gave back what it was charged');
  } finally {
    server.close();
  }
});

test("an order's resumes keep what each was charged and which resume was chosen, for after the batch is gone", async () => {
  const server = await serve('order-item-cost');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    const submitted = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileId: server.profiles.bea,
      buildMode: 'partial',
      mode: 'order',
    });
    assert.equal(submitted.status, 202);
    const orders = require('../dist/database/orderRepository');
    const items = orders.listOrderItems(submitted.body.orderId);
    const batch = queueModule.getGenerationQueue().getBatch(submitted.body.batchId);
    // Item by item, the task's own snapshotted price - Partial Tailor $0.010.
    assert.deepEqual(
      items.map((item) => item.costMilli),
      batch.tasks.map((task) => task.payload.costMilli)
    );
    assert.deepEqual(items.map((item) => item.costMilli), [10, 10]);
    // And what the choice was, recorded at submit.
    for (const item of items) {
      assert.equal(item.profileLabel, 'Bea');
      assert.equal(typeof item.resumeLabel, 'string');
      assert.ok(item.resumeLabel);
      assert.equal(item.match.mode, 'partial');
      assert.equal(item.match.reason, 'only');
      assert.equal(item.match.candidates, 1);
    }
    await untilFinished(submitted.body.batchId);
  } finally {
    server.close();
  }
});

test('a batch the balance cannot cover is a 402 naming the whole sum, and nothing is queued or taken', async () => {
  const server = await serve('batch-402');
  try {
    // A thousandth short: exact arithmetic is what makes this a refusal.
    credits.setBalance(server.alice.id, 19, server.admin.id);
    const refused = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileId: server.profiles.ada,
    });
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, 'insufficient-credits');
    assert.equal(refused.body.neededMilli, 20);
    assert.equal(refused.body.balanceMilli, 19);
    assert.match(refused.body.error, /needs \$0\.02 of credit and the account has \$0\.019/);
    assert.equal(server.balance(server.alice), 19);
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    server.close();
  }
});

test('a run in a free mode takes nothing, writes nothing, and runs on an empty balance', async () => {
  const server = await serve('free');
  try {
    await config.updateAppSettings({ partialPriceUsd: '0' });
    const submitted = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(2),
      profileId: server.profiles.bea,
      buildMode: 'partial',
    });
    assert.equal(submitted.status, 202);
    await untilFinished(submitted.body.batchId);
    assert.deepEqual(
      server.ledger(server.alice).filter((entry) => entry.reason.startsWith('generation')),
      [],
      'no reservation, no refund'
    );
    // The other modes are still priced.
    const priced = await server.post('alice', '/generation/quote', {
      jobs: jobsFor(1),
      profileId: server.profiles.bea,
      buildMode: 'full',
    });
    assert.equal(priced.body.costMilli, 23);
  } finally {
    server.close();
  }
});

test('an administrator runs a priced batch and is charged nothing', async () => {
  const server = await serve('admin-batch');
  try {
    credits.setBalance(server.admin.id, 1, server.admin.id);
    const submitted = await server.post('admin', '/generation/batches', { jobs: jobsFor(3), profileId: server.profiles.cy });
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
        profileId: server.profiles.bea,
        model,
      });
      assert.equal(refused.status, 400, model);
      assertModelUnavailable(refused.body);
    }
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), []);

    // An administrator may still use the provider forms.
    const admin = await server.post('admin', '/generation/batches', {
      jobs: jobsFor(1),
      profileId: server.profiles.cy,
      model: 'codex-cli',
    });
    assert.equal(admin.status, 202);
    await untilFinished(admin.body.batchId);
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

/**
 * A Claude seat that answers every tailoring with a summary naming the model
 * that wrote it. `calls` gets each TAILORING's model; `sites` every call's
 * call site, so a revise pass or any other call shows up.
 */
function claudeSeatNamingItsModel(calls, sites = []) {
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
      sites.push(request.callSite);
      if (request.callSite === 'tailor-resume') calls.push(request.modelName);
      const text = JSON.stringify({ summary: `Written by ${request.modelName}.`, hardSkills: [], softSkills: [], experience: [] });
      return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));
  return () => ai.resetRegistryForTests();
}

test('a preview hands back a token naming the mode it was written in, and a re-render of supplied content gets none', async () => {
  const server = await serve('preview-token', { seeds: true });
  const calls = [];
  const sites = [];
  const restore = claudeSeatNamingItsModel(calls, sites);
  const { readPreviewToken } = require('../dist/services/credits/previewToken');
  // The page names the posting's stored analysis; an analysis object is not read.
  const analysisId = storeJobAnalysis(ANALYSIS);
  try {
    const single = await server.post('alice', '/resume/preview', {
      profileId: server.profiles.bea,
      buildMode: 'partial',
      model: 'claude-cli-opus',
      analysisId,
    });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.deepEqual(calls, ['opus'], 'the request\'s model wrote it');
    // What the server chose, and for whom.
    assert.equal(single.body.profileId, server.profiles.bea);
    assert.equal(single.body.profileName, 'Bea');
    assert.equal(single.body.resumeId, 'p-plain');
    assert.equal(single.body.buildMode, 'partial');
    assert.equal(single.body.match.reason, 'only');
    assert.equal(typeof single.body.resumeLabel, 'string');
    // The token says the MODE (not the model), for this account and this resume.
    assert.equal(readPreviewToken(single.body.previewToken, { userId: server.alice.id, resumeId: 'p-plain' }), 'partial');
    assert.equal(readPreviewToken(single.body.previewToken, { userId: server.admin.id, resumeId: 'p-plain' }), null);
    assert.equal(readPreviewToken(single.body.previewToken, { userId: server.alice.id, resumeId: 'p-opus' }), null);
    assert.equal(readPreviewToken(`${single.body.previewToken}x`, { userId: server.alice.id, resumeId: 'p-plain' }), null);

    // Re-rendering content the request supplies runs no model, so it proves
    // nothing about how it was written.
    const rerender = await server.post('alice', '/resume/preview', {
      resumeId: 'p-plain',
      model: 'claude-cli-haiku',
      analysisId,
      tailoredContent: single.body.tailoredContent,
    });
    assert.equal(rerender.status, 200, JSON.stringify(rerender.body));
    assert.equal(rerender.body.previewToken, undefined);
    assert.equal(calls.length, 1);
    // Nor a revise pass: content a page sends back is re-read, never revised.
    assert.deepEqual(sites, ['tailor-resume']);

    // Fully Tailor: the token names that mode.
    const full = await server.post('alice', '/resume/preview', {
      profileId: server.profiles.ada,
      buildMode: 'full',
      analysisId,
    });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.equal(full.body.buildMode, 'full');
    assert.equal(full.body.resumeId, 'p-opus');
    assert.equal(readPreviewToken(full.body.previewToken, { userId: server.alice.id, resumeId: 'p-opus' }), 'full');
    assert.deepEqual(calls, ['opus', 'opus'], 'the resume\'s own model when the request names none');

    // Choose Suitable Resume renders the resume as written: no model call, no
    // content to be priced, no token.
    const before = sites.length;
    const suitable = await server.post('alice', '/resume/preview', {
      profileId: server.profiles.bea,
      buildMode: 'suitable',
      analysisId,
    });
    assert.equal(suitable.status, 200, JSON.stringify(suitable.body));
    assert.equal(suitable.body.buildMode, 'suitable');
    assert.equal(suitable.body.tailored, false);
    assert.equal(suitable.body.previewToken, undefined);
    assert.equal(suitable.body.match.mode, 'suitable');
    assert.equal(sites.length, before, 'no model was asked');

    // The multi-profile preview is gone, and a preview names a profile or content.
    const all = await server.post('alice', '/resume/preview-all', {
      profileIds: [server.profiles.ada, server.profiles.bea],
      analysisId,
    });
    assert.equal(all.status, 404);
    const neither = await server.post('alice', '/resume/preview', { analysisId });
    assert.equal(neither.status, 400);
    assert.equal(neither.body.error, 'Choose a profile to preview.');
    const noContent = await server.post('alice', '/resume/preview', { resumeId: 'p-plain', analysisId });
    assert.equal(noContent.status, 400);
    assert.equal(noContent.body.error, 'Send the previewed content to show it again, or name the profile to preview.');
    assert.deepEqual(server.ledger(server.alice), [], 'previews are free');
  } finally {
    restore();
    server.close();
  }
});

test("finalising a preview is charged the run's mode when the token proves it, and the dearest mode when nothing does", async () => {
  const server = await serve('finalize-price');
  const { issuePreviewToken } = require('../dist/services/credits/previewToken');
  try {
    credits.setBalance(server.alice.id, 1_000, server.admin.id);
    const partialToken = issuePreviewToken({ userId: server.alice.id, resumeId: 'p-plain', buildMode: 'partial' });
    const written = { summary: 'Written by the model.', hardSkills: [], softSkills: [], experience: [] };
    const reserveNote = () => server.ledger(server.alice, 'generation-reserve').at(0)?.note ?? null;

    // What finalising this content would charge, asked of the quote - the
    // submission's own pricing (priceRun), without a charge.
    const priced = async (extra) => {
      const quote = await server.post('alice', '/generation/quote', {
        jobs: jobsFor(1),
        profileId: server.profiles.bea,
        tailoredContentByResumeId: { 'p-plain': written },
        ...extra,
      });
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      return quote.body.costMilli;
    };

    // Written in Partial Tailor and finalised in it: charged that mode's price.
    assert.equal(await priced({ buildMode: 'partial', previewTokenByResumeId: { 'p-plain': partialToken } }), 10);

    // A token for another resume, another mode, or a forged one proves nothing
    // - and content of unknown origin is charged the dearest of the run mode's,
    // Partial's and Fully's prices.
    for (const previewToken of [
      issuePreviewToken({ userId: server.alice.id, resumeId: 'p-opus', buildMode: 'partial' }),
      issuePreviewToken({ userId: server.alice.id, resumeId: 'p-plain', buildMode: 'full' }),
      `${partialToken.split('.')[0]}.forged`,
      undefined,
    ]) {
      const tokens = previewToken ? { previewTokenByResumeId: { 'p-plain': previewToken } } : {};
      assert.equal(await priced({ buildMode: 'partial', ...tokens }), 23, String(previewToken));
    }
    // ...while a valid Fully token finalised as Fully is that mode's price.
    const fullToken = issuePreviewToken({ userId: server.alice.id, resumeId: 'p-plain', buildMode: 'full' });
    assert.equal(await priced({ buildMode: 'full', previewTokenByResumeId: { 'p-plain': fullToken } }), 23);
    assert.deepEqual(server.ledger(server.alice, 'generation-reserve'), [], 'a quote charges nothing');

    // The queue the same way, and the quote with it: a VALID token with the
    // content it vouches for is enough to price what finalising will charge.
    const batchBody = {
      jobs: jobsFor(1),
      profileId: server.profiles.bea,
      buildMode: 'partial',
      previewTokenByResumeId: { 'p-plain': partialToken },
    };
    // Tokens without the content they vouch for price nothing extra: the run is
    // an ordinary Partial Tailor one.
    assert.equal((await server.post('alice', '/generation/quote', batchBody)).body.costMilli, 10);
    const submitted = await server.post('alice', '/generation/batches', {
      ...batchBody,
      tailoredContentByResumeId: { 'p-plain': written },
    });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    assert.match(reserveNote(), /1 x Partial Tailor @ \$0\.01 = \$0\.01$/);
    await untilFinished(submitted.body.batchId);

    // The same content with no token: the dearest price.
    const stripped = await server.post('alice', '/generation/batches', {
      jobs: jobsFor(1),
      profileId: server.profiles.bea,
      buildMode: 'partial',
      tailoredContentByResumeId: { 'p-plain': written },
    });
    assert.equal(stripped.status, 202);
    assert.match(reserveNote(), /1 x Partial Tailor @ \$0\.023 = \$0\.023$/);
    await untilFinished(stripped.body.batchId);

    // Administrators are exempt even from the floor.
    const adminQuote = await server.post('admin', '/generation/quote', {
      jobs: jobsFor(1),
      profileId: server.profiles.cy,
      buildMode: 'partial',
      tailoredContentByResumeId: { 'p-admin': written },
    });
    assert.equal(adminQuote.status, 200);
    assert.equal(adminQuote.body.exempt, true);

    // Choose Suitable Resume builds each resume as written: it takes no content.
    for (const extra of [
      { tailoredContentByResumeId: { 'p-plain': written } },
      { previewTokenByResumeId: { 'p-plain': partialToken } },
    ]) {
      const refused = await server.post('alice', '/generation/batches', {
        jobs: jobsFor(1),
        profileId: server.profiles.bea,
        buildMode: 'suitable',
        ...extra,
      });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, 'suitable-takes-no-content');
      assert.equal(
        refused.body.error,
        'Choose Suitable Resume builds each resume as written, so it takes no previewed content.'
      );
    }
    assert.equal(server.ledger(server.alice, 'generation-reserve').length, 2, 'the refusals charged nothing');
  } finally {
    server.close();
  }
});

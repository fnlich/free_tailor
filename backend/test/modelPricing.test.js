const assert = require('node:assert/strict');
const test = require('node:test');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { loadFresh, readSettingRaw, useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * A price per resume, per model, in thousandths of a dollar.
 *
 * Each model record carries `pricePerResumeMilli` - $0.023 is 23 - and a resume
 * costs what its model costs. What is pinned here is everything that keeps that
 * number honest:
 *
 *   - the field on the record - free on every seed until an administrator
 *     prices it, read as $0.000 (in memory, never written back) where a record
 *     has none, including one priced in CREDITS before credits were dollars,
 *     clamped rather than fatal where a stored one is out of range, and junk
 *     read as free and said once;
 *   - an administrator's price typed in DOLLARS ("0.023") and parsed exactly,
 *     refused by name with more than three decimals, out of range, or missing
 *     on a create;
 *   - a partial edit - the enable switch, a rename - never resetting it;
 *   - the admin payload naming every enabled model that is free;
 *   - the credit primitives taking an AMOUNT, and the line the history shows;
 *   - the queue refunding what each task was CHARGED, snapshotted on its
 *     payload, never what its model costs by the time it fails - including a
 *     task restored from disk whose choice is resolved again, and one queued
 *     before credits were dollars, which refunds nothing.
 *
 * Modules are loaded once, not per test: the model settings are cached per
 * database path, and a second copy of the module would read a cache the first
 * never invalidated. Each test gets a database of its own instead.
 */

const APP_SETTINGS_KEY = 'app-settings';
const config = require('../dist/config/aiModelConfig');
const pricing = require('../dist/config/pricePerResume');

function fresh(name) {
  const storage = useTempStorage(`model-pricing-${name}`);
  config.invalidateSettingsCache();
  return storage;
}

function captureWarnings() {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return { warnings, restore: () => (console.warn = warn) };
}

/** A stored model record as an older release wrote it: every field but the price. */
function storedModel(id, provider, modelName, extra = {}) {
  return {
    id,
    name: id,
    provider,
    modelName,
    description: '',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/* ------------------------------------------------------------- the field */

test('every seed is free until it is priced, and the admin payload names each one', async () => {
  fresh('seeds');
  assert.equal(pricing.MIN_PRICE_PER_RESUME_MILLI, 0);
  assert.equal(pricing.MAX_PRICE_PER_RESUME_MILLI, 1_000_000);

  const admin = await config.getAdminAppSettings();
  assert.deepEqual(
    admin.aiModels.map((model) => [model.id, model.pricePerResumeMilli]),
    [
      ['claude-cli-sonnet', 0],
      ['claude-cli-opus', 0],
      ['claude-cli-haiku', 0],
      ['codex-cli-default', 0],
      ['gemini-cli-auto', 0],
    ]
  );
  // No price is a default nobody chose, so every enabled one is flagged.
  assert.deepEqual(admin.freeEnabledModelIds, admin.aiModels.map((model) => model.id));
  assert.equal('creditsPerResume' in admin.aiModels[0], false, 'the credit-unit field is gone from the payload');

  // Pricing one takes it off the list; switching one off does too.
  await config.updateAIModel('claude-cli-sonnet', { pricePerResumeUsd: '0.023' });
  const after = await config.updateAIModel('claude-cli-opus', { enabled: false });
  assert.deepEqual(after.freeEnabledModelIds, ['claude-cli-haiku', 'codex-cli-default', 'gemini-cli-auto']);
});

test('a stored record priced in credits, or with no price, reads as free, and reading writes nothing back', async () => {
  const { dbDir } = fresh('no-field');
  const row = JSON.stringify({
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
    defaultModelId: 'claude-cli-sonnet',
    aiModels: [
      // A price from before credits were dollars: two credits, at 50c each.
      // Never read as a price in dollars - it is another unit, and the owner
      // reset every price to $0.000 rather than pick a rate.
      storedModel('claude-cli-sonnet', 'claude-cli', 'sonnet', { creditsPerResume: 2 }),
      storedModel('codex-cli-default', 'codex-cli', 'default'),
    ],
  });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, row);

  const admin = await config.getAdminAppSettings();
  assert.deepEqual(admin.aiModels.map((model) => model.pricePerResumeMilli), [0, 0]);
  assert.deepEqual(admin.freeEnabledModelIds, ['claude-cli-sonnet', 'codex-cli-default']);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), row, 'no migration and no write-back on read');
});

test('an out-of-range or junk stored price clamps or reads as free instead of failing the read, and says so once', async () => {
  const { dbDir } = fresh('clamp');
  const row = JSON.stringify({
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
    defaultModelId: 'too-dear',
    aiModels: [
      storedModel('too-dear', 'claude-cli', 'sonnet', { pricePerResumeMilli: 5_000_000 }),
      storedModel('negative', 'claude-cli', 'opus', { pricePerResumeMilli: -3 }),
      // A fraction of a thousandth is not a price this app can charge; it is
      // never rounded or floored into one.
      storedModel('fraction', 'claude-cli', 'haiku', { pricePerResumeMilli: 22.6 }),
      storedModel('words', 'codex-cli', 'default', { pricePerResumeMilli: 'two' }),
      storedModel('digits', 'gemini-cli', 'auto', { pricePerResumeMilli: '23' }),
    ],
  });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, row);

  const capture = captureWarnings();
  let admin;
  try {
    admin = await config.getAdminAppSettings();
    config.invalidateSettingsCache();
    await config.getAdminAppSettings();
  } finally {
    capture.restore();
  }
  assert.deepEqual(
    Object.fromEntries(admin.aiModels.map((model) => [model.id, model.pricePerResumeMilli])),
    { 'too-dear': 1_000_000, negative: 0, fraction: 0, words: 0, digits: 23 }
  );
  const lines = capture.warnings.filter((line) => line.includes('"too-dear" has pricePerResumeMilli'));
  assert.equal(lines.length, 1, 'once, however many reads');
  assert.match(lines[0], /read as \$1,000\./);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), row, 'nothing written back');
});

test('an administrator prices a new model in dollars, exactly, and a bad or missing price is refused by name', async () => {
  fresh('create');
  const created = await config.createAIModel({
    name: 'Fable',
    provider: 'claude-cli',
    modelName: 'fable',
    pricePerResumeUsd: '0.023',
  });
  assert.equal(created.aiModels.find((model) => model.modelName === 'fable').pricePerResumeMilli, 23);

  const typed = await config.createAIModel({ name: 'Pro', provider: 'gemini-cli', modelName: 'pro', pricePerResumeUsd: 1.5 });
  assert.equal(typed.aiModels.find((model) => model.modelName === 'pro').pricePerResumeMilli, 1_500, 'a JSON number');

  const free = await config.createAIModel({ name: 'Flash', provider: 'gemini-cli', modelName: 'flash', pricePerResumeUsd: '0' });
  assert.equal(free.aiModels.find((model) => model.modelName === 'flash').pricePerResumeMilli, 0, '0 is free, on purpose');
  assert.ok(free.freeEnabledModelIds.includes(free.aiModels.find((model) => model.modelName === 'flash').id));

  const top = await config.createAIModel({ name: 'Top', provider: 'codex-cli', modelName: 'gpt-6-luna', pricePerResumeUsd: '1000' });
  assert.equal(top.aiModels.find((model) => model.modelName === 'gpt-6-luna').pricePerResumeMilli, 1_000_000);

  // No default: a new model is priced by whoever adds it.
  await assert.rejects(
    () => config.createAIModel({ name: 'Unpriced', provider: 'gemini-cli', modelName: 'flash-lite' }),
    /Price per resume is required for a new model/
  );
  for (const [bad, why] of [
    ['0.0235', /at most three decimal places/],
    [0.1 + 0.2, /at most three decimal places/],
    ['-1', /cannot be negative/],
    ['1000.001', /from \$0 to \$1,000 in steps of \$0\.001/],
    ['two', /must be an amount in dollars/],
    ['1,5', /must be an amount in dollars/],
    ['', /is required/],
    [null, /is required/],
    [true, /must be an amount in dollars/],
  ]) {
    await assert.rejects(
      () => config.createAIModel({ name: 'Bad', provider: 'gemini-cli', modelName: 'flash-lite', pricePerResumeUsd: bad }),
      why,
      `refuses ${JSON.stringify(bad)}`
    );
  }
  // A page from before credits were dollars sends a price in credits.
  await assert.rejects(
    () => config.createAIModel({ name: 'Old', provider: 'gemini-cli', modelName: 'flash-lite', creditsPerResume: 2 }),
    /older version of the app/
  );
  assert.equal(
    (await config.getAdminAppSettings()).aiModels.some((model) => model.modelName === 'flash-lite'),
    false,
    'nothing was saved by a refused create'
  );
});

test('a partial edit keeps the price, and an edit of the price alone changes only it', async () => {
  fresh('partial');
  await config.updateAIModel('claude-cli-opus', { pricePerResumeUsd: '0.004' });

  for (const edit of [{ enabled: false }, { enabled: true }, { name: 'Opus' }, { description: 'Hardest prompts.' }]) {
    const saved = await config.updateAIModel('claude-cli-opus', edit);
    assert.equal(saved.aiModels.find((model) => model.id === 'claude-cli-opus').pricePerResumeMilli, 4, JSON.stringify(edit));
  }

  const repriced = await config.updateAIModel('claude-cli-opus', { pricePerResumeUsd: '0' });
  const opus = repriced.aiModels.find((model) => model.id === 'claude-cli-opus');
  assert.deepEqual(
    { name: opus.name, description: opus.description, enabled: opus.enabled, pricePerResumeMilli: opus.pricePerResumeMilli },
    { name: 'Opus', description: 'Hardest prompts.', enabled: true, pricePerResumeMilli: 0 }
  );
  await assert.rejects(() => config.updateAIModel('claude-cli-opus', { pricePerResumeUsd: '1001' }), /Price per resume/);
  await assert.rejects(() => config.updateAIModel('claude-cli-opus', { creditsPerResume: 4 }), /older version/);
});

test('every save keeps the prices, and a model list sent to the settings save is ignored', async () => {
  const { dbDir } = fresh('settings-save');
  await config.updateAIModel('claude-cli-haiku', { pricePerResumeUsd: '0.005' });
  await config.updateAppSettings({ defaultTheme: 'dark' });
  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  const haiku = stored.aiModels.find((model) => model.id === 'claude-cli-haiku');
  assert.equal(haiku.pricePerResumeMilli, 5, 'written with the row');
  assert.equal('creditsPerResume' in haiku, false, 'and the credit-unit field is not');

  // The settings save normalizes leniently, so a list there would clamp a
  // mistyped price - or reset every price a stale client left out - where the
  // model routes refuse it. It is dropped.
  const saved = await config.updateAppSettings({
    defaultTheme: 'light',
    aiModels: [storedModel('claude-cli-haiku', 'claude-cli', 'haiku', { pricePerResumeMilli: 99_999 })],
  });
  assert.equal(saved.defaultTheme, 'light');
  assert.equal(saved.aiModels.length, 5, 'the list was not replaced');
  assert.equal(saved.aiModels.find((model) => model.id === 'claude-cli-haiku').pricePerResumeMilli, 5);
});

test('the price rules on their own: dollars in, thousandths out, and nothing rounded', () => {
  assert.equal(pricing.parsePricePerResume('0.023', undefined), 23);
  assert.equal(pricing.parsePricePerResume('$0.023', undefined), 23);
  assert.equal(pricing.parsePricePerResume(' 12.5 ', undefined), 12_500);
  assert.equal(pricing.parsePricePerResume(undefined, 41), 41, 'left out of an edit keeps the stored one');
  assert.throws(() => pricing.parsePricePerResume('0.0235', 41), /three decimal places/);
  assert.throws(() => pricing.parsePricePerResume(undefined, undefined), /required/);
  assert.equal(pricing.readPricePerResumeMilli(undefined), 0);
  assert.equal(pricing.readPricePerResumeMilli(161), 161);
});

/* ------------------------------------------------------ credit primitives */

function creditSetup(name) {
  useTempStorage(`model-pricing-credits-${name}`);
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const credits = loadFresh('../dist/services/credits');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  return { users, credits, admin, alice };
}

test('a reserve takes an amount of money, not a count of resumes to multiply', () => {
  const { users, credits, alice } = creditSetup('amount');
  credits.setBalance(alice.id, 200, 'admin-1');
  const reservation = credits.reserveCredits(users.getUserById(alice.id), 161, { kind: 'batch', id: 'bat_1' });
  assert.equal(reservation.costMilli, 161);
  assert.equal(users.getUserById(alice.id).balanceMilli, 39);
  assert.throws(
    () => credits.reserveCredits(users.getUserById(alice.id), 46, { kind: 'batch', id: 'bat_2' }),
    (error) => error.name === 'InsufficientCreditsError' && error.neededMilli === 46 && error.balanceMilli === 39
  );
});

test('a free run takes nothing, writes nothing, and runs on an empty balance', () => {
  const { users, credits, alice } = creditSetup('free');
  const reservation = credits.reserveCredits(users.getUserById(alice.id), 0, { kind: 'batch', id: 'bat_free' });
  assert.deepEqual({ costMilli: reservation.costMilli, exempt: reservation.exempt }, { costMilli: 0, exempt: false });
  assert.equal(credits.getReservation('bat_free'), null);
  assert.equal(credits.getLedger(alice.id).length, 0);
  assert.equal(credits.refundTaskUnit('bat_free', 'tsk_1', 0, 'failed'), 0);
});

test('each unit refunds its own price, and the run still cannot refund more than it took', () => {
  const { users, credits, alice } = creditSetup('mixed-refunds');
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 33, { kind: 'batch', id: 'bat_1' });

  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_dear', 23, 'failed'), 23);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_dear', 23, 'failed'), 0, 'once per task');
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_other', 23, 'failed'), 0, 'capped: only $0.010 is left');
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_cheap', 10, 'failed'), 10);
  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000);
});

test('the history line breaks a charge down by model display name', () => {
  const { describeCharge } = require('../dist/services/credits');
  assert.equal(
    describeCharge([
      { modelLabel: 'Claude Sonnet', costMilli: 23 },
      { modelLabel: 'Codex', costMilli: 1_000 },
      { modelLabel: 'Claude Sonnet', costMilli: 23 },
    ]),
    '3 resumes: 2 x Claude Sonnet @ $0.023, 1 x Codex @ $1 = $1.046'
  );
  assert.equal(describeCharge([{ modelLabel: 'Gemini', costMilli: 1 }]), '1 resume: 1 x Gemini @ $0.001 = $0.001');
  assert.equal(describeCharge([{ modelLabel: 'Gemini', costMilli: 0 }]), '1 resume: 1 x Gemini @ $0 = $0');
  // The same model at two prices - repriced between two charges - is two groups.
  assert.equal(
    describeCharge([
      { modelLabel: 'Codex', costMilli: 10 },
      { modelLabel: 'Codex', costMilli: 30 },
    ]),
    '2 resumes: 1 x Codex @ $0.01, 1 x Codex @ $0.03 = $0.04'
  );
});

/* ---------------------------------------------------- the queue's refunds */

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(condition, what, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

test('the queue refunds what each failed task was charged, read from its payload', async () => {
  const { users, credits, alice } = creditSetup('queue-snapshot');
  process.env.GENERATION_MAX_ATTEMPTS = '1';
  process.env.AI_CLI_CONCURRENCY = '1';
  try {
    const queueModule = loadFresh('../dist/services/queue/index');
    queueModule.resetGenerationQueueForTests();
    const { registerTaskRunner, newBatchId } = require('../dist/services/queue/taskQueue');
    const kind = 'pricing-stub';
    registerTaskRunner(kind, async (payload) => {
      if (payload.fail) throw new Error('no');
      return 'ok';
    });

    credits.setBalance(alice.id, 1_000, 'admin-1');
    const batchId = newBatchId();
    // 23 + 40, plus a payload from before credits were dollars: it was paid
    // for in credits the reset cleared, so it adds nothing here and refunds
    // nothing.
    credits.reserveCredits(users.getUserById(alice.id), 63, { kind: 'batch', id: batchId });
    const task = (label, payload) => ({
      queue: 'cli',
      label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
      kind,
      payload: { label, ...payload },
    });
    const queue = queueModule.getGenerationQueue();
    queue.submit(
      [
        task('dear-fails', { costMilli: 23, fail: true }),
        task('dearer-delivers', { costMilli: 40 }),
        task('pre-dollars-fails', { creditCost: 1, fail: true }),
      ],
      { id: batchId }
    );
    await queue.refreshCapacity();
    await until(() => queue.snapshot(batchId)?.state !== 'running', 'the batch to finish');
    await settle();

    // $1.000 - $0.063 + $0.023: the delivered resume's $0.040 is spent, and
    // the one from before dollars gives back nothing.
    assert.equal(users.getUserById(alice.id).balanceMilli, 960);
    const refunds = credits
      .getLedger(alice.id)
      .filter((entry) => entry.reason === 'generation-refund')
      .map((entry) => entry.deltaMilli);
    assert.deepEqual(refunds, [23]);
    assert.equal(credits.getReservation(batchId).state, 'closed');

    assert.equal(queueModule.taskCostMilli({ costMilli: 0 }), 0);
    assert.equal(queueModule.taskCostMilli({ costMilli: 23 }), 23);
    // A payload from before dollars, or none at all: nothing - never its
    // whole-credit figure read as thousandths.
    assert.equal(queueModule.taskCostMilli({}), 0);
    assert.equal(queueModule.taskCostMilli({ creditCost: 3 }), 0);
    assert.equal(queueModule.taskCostMilli({ costMilli: -2 }), 0, 'a nonsense snapshot refunds nothing');
    assert.equal(queueModule.taskCostMilli({ costMilli: 22.6 }), 0, 'never floored into a refund');
    assert.equal(queueModule.taskCostMilli(null), 0);
    queueModule.resetGenerationQueueForTests();
  } finally {
    delete process.env.GENERATION_MAX_ATTEMPTS;
    delete process.env.AI_CLI_CONCURRENCY;
  }
});

test('a restored task keeps the price it was charged, even when its choice is resolved again', async () => {
  // Queued on a retired provider, with a snapshot of $0.040; its profile now
  // runs on a model priced $0.090. The restore moves it onto the new model -
  // and must not move its price with it, or the refund would hand back money
  // never taken.
  const { users, credits, alice } = creditSetup('restore');
  process.env.GENERATION_MAX_ATTEMPTS = '1';
  try {
    const cfg = require('../dist/config/aiModelConfig');
    cfg.invalidateSettingsCache();
    await cfg.updateAIModel('claude-cli-sonnet', { pricePerResumeUsd: '0.090' });

    const { buildNewProfile } = loadFresh('../dist/services/profileService');
    loadFresh('../dist/database/profileRepository').saveProfile({
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
        'p-ada'
      ),
      ownerId: alice.id,
    });

    credits.setBalance(alice.id, 1_000, 'admin-1');
    credits.reserveCredits(users.getUserById(alice.id), 40, { kind: 'batch', id: 'bat_restore' });

    const store = loadFresh('../dist/database/generationRepository');
    const retiredChoice = { provider: 'openai', modelName: 'gpt-5.1', modelId: 'openai-gpt-5-1', modelLabel: 'GPT' };
    const row = (id, seq, payload) => ({
      id,
      batchId: 'bat_restore',
      seq,
      state: 'queued',
      data: {
        queue: 'cli',
        label: { profileId: 'p-ada', profileName: 'Ada', companyName: `Co ${seq}`, role: 'SWE' },
        kind: 'resume',
        payload: { batchId: 'bat_restore', profileId: 'p-ada', jobIndex: 0, choice: retiredChoice, ...payload },
      },
    });
    store.saveBatchWithTasks(
      {
        id: 'bat_restore',
        state: 'running',
        data: {
          label: 'Queued before the upgrade',
          jobCount: 1,
          shared: { jobs: [{ companyName: 'Acme', role: 'SWE', jobDescription: '' }], ownerId: alice.id },
          createdAt: Date.now(),
        },
      },
      [row('tsk_priced', 0, { costMilli: 40 }), row('tsk_pre_dollars', 1, { creditCost: 1 })]
    );

    const queueModule = loadFresh('../dist/services/queue/index');
    queueModule.resetGenerationQueueForTests();
    const seen = [];
    const queue = queueModule.getGenerationQueue();
    queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload) => {
      seen.push({ model: payload.choice.modelId, costMilli: payload.costMilli });
      throw new Error('the build failed');
    });

    await queueModule.restoreGenerationQueue();
    await until(() => queue.snapshot('bat_restore')?.state !== 'running', 'the restored batch to finish');
    await settle();

    assert.deepEqual(
      seen.sort((a, b) => String(a.costMilli).localeCompare(String(b.costMilli))),
      [
        { model: 'claude-cli-sonnet', costMilli: 40 },
        { model: 'claude-cli-sonnet', costMilli: undefined },
      ],
      'resolved again onto the profile model, with the snapshot carried, not re-priced'
    );
    // $1.000 - $0.040 + $0.040: what was charged comes back, not the model's
    // $0.090 - and the task from before dollars adds nothing.
    assert.equal(users.getUserById(alice.id).balanceMilli, 1_000);
    queueModule.resetGenerationQueueForTests();
  } finally {
    delete process.env.GENERATION_MAX_ATTEMPTS;
  }
});

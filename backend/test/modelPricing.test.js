const assert = require('node:assert/strict');
const test = require('node:test');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { loadFresh, readSettingRaw, useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * A price per resume, per model.
 *
 * Each model record carries `creditsPerResume`, and a resume costs what its
 * model costs. What is pinned here is everything that keeps that number honest:
 *
 *   - the field on the record - seeded, carried through every normalize, read
 *     as the default (in memory, never written back) where an older record has
 *     none, clamped rather than fatal where a stored one is out of range, and
 *     refused by name where an administrator types a bad one;
 *   - a partial edit - the enable switch, a rename - never resetting it;
 *   - the credit primitives taking an AMOUNT, and the line the history shows;
 *   - the queue refunding what each task was CHARGED, snapshotted on its
 *     payload, never what its model costs by the time it fails - including a
 *     task restored from disk whose choice is resolved again, and one queued
 *     before prices existed, which refunds the default.
 *
 * Modules are loaded once, not per test: the model settings are cached per
 * database path, and a second copy of the module would read a cache the first
 * never invalidated. Each test gets a database of its own instead.
 */

const APP_SETTINGS_KEY = 'app-settings';
const config = require('../dist/config/aiModelConfig');
const pricing = require('../dist/config/creditsPerResume');

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

test('every seed costs one credit a resume, and the credit service means the same default', async () => {
  fresh('seeds');
  assert.equal(pricing.DEFAULT_CREDITS_PER_RESUME, 1);
  assert.equal(require('../dist/services/credits').CREDITS_PER_RESUME, pricing.DEFAULT_CREDITS_PER_RESUME);

  const admin = await config.getAdminAppSettings();
  assert.deepEqual(
    admin.aiModels.map((model) => [model.id, model.creditsPerResume]),
    [
      ['claude-cli-sonnet', 1],
      ['claude-cli-opus', 1],
      ['claude-cli-haiku', 1],
      ['codex-cli-default', 1],
      ['gemini-cli-auto', 1],
    ]
  );
});

test('a stored record with no price reads as the default, and reading writes nothing back', async () => {
  const { dbDir } = fresh('no-field');
  const row = JSON.stringify({
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
    defaultModelId: 'claude-cli-sonnet',
    aiModels: [storedModel('claude-cli-sonnet', 'claude-cli', 'sonnet'), storedModel('codex-cli-default', 'codex-cli', 'default')],
  });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, row);

  const admin = await config.getAdminAppSettings();
  assert.deepEqual(admin.aiModels.map((model) => model.creditsPerResume), [1, 1]);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), row, 'no migration and no write-back on read');
});

test('an out-of-range or junk stored price clamps on read instead of failing it, and says so once', async () => {
  const { dbDir } = fresh('clamp');
  const row = JSON.stringify({
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
    defaultModelId: 'too-dear',
    aiModels: [
      storedModel('too-dear', 'claude-cli', 'sonnet', { creditsPerResume: 5000 }),
      storedModel('negative', 'claude-cli', 'opus', { creditsPerResume: -3 }),
      storedModel('fraction', 'claude-cli', 'haiku', { creditsPerResume: 2.6 }),
      storedModel('words', 'codex-cli', 'default', { creditsPerResume: 'two' }),
      storedModel('digits', 'gemini-cli', 'auto', { creditsPerResume: '7' }),
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
    Object.fromEntries(admin.aiModels.map((model) => [model.id, model.creditsPerResume])),
    { 'too-dear': 1000, negative: 0, fraction: 3, words: 1, digits: 7 }
  );
  const lines = capture.warnings.filter((line) => line.includes('"too-dear" has creditsPerResume'));
  assert.equal(lines.length, 1, 'once, however many reads');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), row, 'nothing written back');
});

test('an administrator sets a price on a create, and a bad one is refused by name', async () => {
  fresh('create');
  const created = await config.createAIModel({ name: 'Fable', provider: 'claude-cli', modelName: 'fable', creditsPerResume: 3 });
  assert.equal(created.aiModels.find((model) => model.modelName === 'fable').creditsPerResume, 3);

  const defaulted = await config.createAIModel({ name: 'Luna', provider: 'codex-cli', modelName: 'gpt-6-luna' });
  assert.equal(defaulted.aiModels.find((model) => model.modelName === 'gpt-6-luna').creditsPerResume, 1);

  const free = await config.createAIModel({ name: 'Flash', provider: 'gemini-cli', modelName: 'flash', creditsPerResume: 0 });
  assert.equal(free.aiModels.find((model) => model.modelName === 'flash').creditsPerResume, 0, '0 is free');

  const typed = await config.createAIModel({ name: 'Pro', provider: 'gemini-cli', modelName: 'pro', creditsPerResume: '12' });
  assert.equal(typed.aiModels.find((model) => model.modelName === 'pro').creditsPerResume, 12);

  for (const bad of [1.5, -1, 1001, 'two', '', null, '3.5', true]) {
    await assert.rejects(
      () => config.createAIModel({ name: 'Bad', provider: 'gemini-cli', modelName: 'flash-lite', creditsPerResume: bad }),
      /creditsPerResume\) must be a whole number of credits from 0 to 1000/,
      `refuses ${JSON.stringify(bad)}`
    );
  }
  assert.equal(
    (await config.getAdminAppSettings()).aiModels.some((model) => model.modelName === 'flash-lite'),
    false,
    'nothing was saved by a refused create'
  );
});

test('a partial edit keeps the price, and an edit of the price alone changes only it', async () => {
  fresh('partial');
  await config.updateAIModel('claude-cli-opus', { creditsPerResume: 4 });

  for (const edit of [{ enabled: false }, { enabled: true }, { name: 'Opus' }, { description: 'Hardest prompts.' }]) {
    const saved = await config.updateAIModel('claude-cli-opus', edit);
    assert.equal(saved.aiModels.find((model) => model.id === 'claude-cli-opus').creditsPerResume, 4, JSON.stringify(edit));
  }

  const repriced = await config.updateAIModel('claude-cli-opus', { creditsPerResume: 0 });
  const opus = repriced.aiModels.find((model) => model.id === 'claude-cli-opus');
  assert.deepEqual(
    { name: opus.name, description: opus.description, enabled: opus.enabled, creditsPerResume: opus.creditsPerResume },
    { name: 'Opus', description: 'Hardest prompts.', enabled: true, creditsPerResume: 0 }
  );
  await assert.rejects(() => config.updateAIModel('claude-cli-opus', { creditsPerResume: 1001 }), /creditsPerResume/);
});

test('every save keeps the prices, and a model list sent to the settings save is ignored', async () => {
  const { dbDir } = fresh('settings-save');
  await config.updateAIModel('claude-cli-haiku', { creditsPerResume: 5 });
  await config.updateAppSettings({ defaultTheme: 'dark' });
  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal(stored.aiModels.find((model) => model.id === 'claude-cli-haiku').creditsPerResume, 5, 'written with the row');

  // The settings save normalizes leniently, so a list there would clamp a
  // mistyped price - or reset every price a stale client left out - where the
  // model routes refuse it. It is dropped.
  const saved = await config.updateAppSettings({
    defaultTheme: 'light',
    aiModels: [storedModel('claude-cli-haiku', 'claude-cli', 'haiku', { creditsPerResume: 99999 })],
  });
  assert.equal(saved.defaultTheme, 'light');
  assert.equal(saved.aiModels.length, 5, 'the list was not replaced');
  assert.equal(saved.aiModels.find((model) => model.id === 'claude-cli-haiku').creditsPerResume, 5);
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

test('a reserve takes an amount of credits, not a count of resumes to multiply', () => {
  const { users, credits, alice } = creditSetup('amount');
  credits.setBalance(alice.id, 10, 'admin-1');
  const reservation = credits.reserveCredits(users.getUserById(alice.id), 7, { kind: 'batch', id: 'bat_1' });
  assert.equal(reservation.units, 7);
  assert.equal(users.getUserById(alice.id).credits, 3);
  assert.throws(
    () => credits.reserveCredits(users.getUserById(alice.id), 5, { kind: 'batch', id: 'bat_2' }),
    (error) => error.name === 'InsufficientCreditsError' && error.needed === 5 && error.balance === 3
  );
});

test('a free run takes nothing, writes nothing, and runs on an empty balance', () => {
  const { users, credits, alice } = creditSetup('free');
  const reservation = credits.reserveCredits(users.getUserById(alice.id), 0, { kind: 'batch', id: 'bat_free' });
  assert.deepEqual({ units: reservation.units, exempt: reservation.exempt }, { units: 0, exempt: false });
  assert.equal(credits.getReservation('bat_free'), null);
  assert.equal(credits.getLedger(alice.id).length, 0);
  assert.equal(credits.refundTaskUnit('bat_free', 'tsk_1', 0, 'failed'), 0);
});

test('each unit refunds its own price, and the run still cannot refund more than it took', () => {
  const { users, credits, alice } = creditSetup('mixed-refunds');
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 5, { kind: 'batch', id: 'bat_1' });

  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_dear', 3, 'failed'), 3);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_dear', 3, 'failed'), 0, 'once per task');
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_other', 3, 'failed'), 0, 'capped: only 2 are left');
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_cheap', 2, 'failed'), 2);
  assert.equal(users.getUserById(alice.id).credits, 10);
});

test('the history line breaks a charge down by model display name', () => {
  const { describeCharge } = require('../dist/services/credits');
  assert.equal(
    describeCharge([
      { modelLabel: 'Claude Sonnet', credits: 2 },
      { modelLabel: 'Codex', credits: 1 },
      { modelLabel: 'Claude Sonnet', credits: 2 },
    ]),
    '3 resumes: 2 x Claude Sonnet @ 2, 1 x Codex @ 1 = 5 credits'
  );
  assert.equal(describeCharge([{ modelLabel: 'Gemini', credits: 1 }]), '1 resume: 1 x Gemini @ 1 = 1 credit');
  assert.equal(describeCharge([{ modelLabel: 'Gemini', credits: 0 }]), '1 resume: 1 x Gemini @ 0 = 0 credits');
  // The same model at two prices - repriced between two charges - is two groups.
  assert.equal(
    describeCharge([
      { modelLabel: 'Codex', credits: 1 },
      { modelLabel: 'Codex', credits: 3 },
    ]),
    '2 resumes: 1 x Codex @ 1, 1 x Codex @ 3 = 4 credits'
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

    credits.setBalance(alice.id, 20, 'admin-1');
    const batchId = newBatchId();
    // 3 + 4 + 1 (a payload from before prices, which was charged the default).
    credits.reserveCredits(users.getUserById(alice.id), 8, { kind: 'batch', id: batchId });
    const task = (label, payload) => ({
      queue: 'cli',
      label: { profileId: label, profileName: label, companyName: 'Acme', role: 'SWE' },
      kind,
      payload: { label, ...payload },
    });
    const queue = queueModule.getGenerationQueue();
    queue.submit(
      [
        task('dear-fails', { creditCost: 3, fail: true }),
        task('dearer-delivers', { creditCost: 4 }),
        task('pre-upgrade-fails', { fail: true }),
      ],
      { id: batchId }
    );
    await queue.refreshCapacity();
    await until(() => queue.snapshot(batchId)?.state !== 'running', 'the batch to finish');
    await settle();

    // 20 - 8 + 3 + 1: the delivered resume's 4 credits are spent.
    assert.equal(users.getUserById(alice.id).credits, 16);
    const refunds = credits
      .getLedger(alice.id)
      .filter((entry) => entry.reason === 'generation-refund')
      .map((entry) => entry.delta)
      .sort();
    assert.deepEqual(refunds, [1, 3]);
    assert.equal(credits.getReservation(batchId).state, 'closed');

    assert.equal(queueModule.taskCreditCost({ creditCost: 0 }), 0);
    assert.equal(queueModule.taskCreditCost({}), 1);
    assert.equal(queueModule.taskCreditCost({ creditCost: -2 }), 1, 'a nonsense snapshot refunds the default');
    assert.equal(queueModule.taskCreditCost(null), 1);
    queueModule.resetGenerationQueueForTests();
  } finally {
    delete process.env.GENERATION_MAX_ATTEMPTS;
    delete process.env.AI_CLI_CONCURRENCY;
  }
});

test('a restored task keeps the price it was charged, even when its choice is resolved again', async () => {
  // Queued on a retired provider, with a snapshot of 4; its profile now runs on
  // a model priced 9. The restore moves it onto the new model - and must not
  // move its price with it, or the refund would hand back credits never taken.
  const { users, credits, alice } = creditSetup('restore');
  process.env.GENERATION_MAX_ATTEMPTS = '1';
  try {
    const cfg = require('../dist/config/aiModelConfig');
    cfg.invalidateSettingsCache();
    await cfg.updateAIModel('claude-cli-sonnet', { creditsPerResume: 9 });

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

    credits.setBalance(alice.id, 10, 'admin-1');
    credits.reserveCredits(users.getUserById(alice.id), 5, { kind: 'batch', id: 'bat_restore' });

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
      [row('tsk_priced', 0, { creditCost: 4 }), row('tsk_unpriced', 1, {})]
    );

    const queueModule = loadFresh('../dist/services/queue/index');
    queueModule.resetGenerationQueueForTests();
    const seen = [];
    const queue = queueModule.getGenerationQueue();
    queueModule.registerTaskRunner(queueModule.RESUME_TASK_KIND, async (payload) => {
      seen.push({ model: payload.choice.modelId, creditCost: payload.creditCost });
      throw new Error('the build failed');
    });

    await queueModule.restoreGenerationQueue();
    await until(() => queue.snapshot('bat_restore')?.state !== 'running', 'the restored batch to finish');
    await settle();

    assert.deepEqual(
      seen.sort((a, b) => String(a.creditCost).localeCompare(String(b.creditCost))),
      [
        { model: 'claude-cli-sonnet', creditCost: 4 },
        { model: 'claude-cli-sonnet', creditCost: undefined },
      ],
      'resolved again onto the profile model, with the snapshot carried, not re-priced'
    );
    // 10 - 5 + 4 + 1: what was charged comes back, not the model's 9.
    assert.equal(users.getUserById(alice.id).credits, 10);
    queueModule.resetGenerationQueueForTests();
  } finally {
    delete process.env.GENERATION_MAX_ATTEMPTS;
  }
});

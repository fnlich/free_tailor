const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const express = require('express');
const Database = require('better-sqlite3');

const { loadFresh, openTestDb, readSettingRaw, useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');
const {
  APP_SETTING_ENV_VARIABLES,
  DEFAULTED_SETTING_KEYS,
  SETTING_DEFAULT_VARIABLES,
} = require('../dist/config/settingDefaults');
const { OPERATIONAL_VARIABLES } = require('../dist/config/operational');

/**
 * Every setting an administrator may leave unset (owner decisions S1-S3): the
 * value in effect is the one an administrator STORED, else `.env`'s, else the
 * code's; the stored row holds only what an administrator set; `null` in a
 * save removes it (Reset to default); the admin payloads say where each value
 * came from (`settingSources`) and what Reset would give (`settingDefaults`),
 * and an ordinary account's payload says neither. Step 9 takes the old
 * defaults a whole-row save froze out of an upgraded install's row.
 */

const ALL_VARIABLES = [
  ...Object.values(APP_SETTING_ENV_VARIABLES).flat(),
  'OUTPUT_PATH_SUFFIX',
  'CONTACT_CHANNELS',
  'JOB_LAKE_REPORT_RATE_USD',
  'JOB_LAKE_DAILY_CAP_USD',
  'JOB_LAKE_DUPLICATE_WINDOW_DAYS',
];

/**
 * Runs `fn` with exactly `values` set among the variables above (every other
 * one unset), the seats unlocked, the once-only warnings forgotten and
 * console.warn captured; restores everything after.
 */
async function withEnv(values, fn) {
  const names = [...new Set([...ALL_VARIABLES, 'AI_LOCKED_PROVIDERS', 'AI_UNLOCKED_PROVIDERS'])];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  Object.assign(process.env, values);
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return await fn(warnings);
  } finally {
    console.warn = original;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function storedRow(dbDir) {
  const raw = readSettingRaw(dbDir, 'app-settings');
  return raw === null ? null : JSON.parse(raw);
}

const limitsOf = (rows) => rows.map((row) => [row.target, row.minMilli, row.maxMilli]);

/**
 * One case per field with a `.env` default: what `.env` sets, what an
 * administrator saves, and what each reads as. `read` projects the served
 * value, so the payment limits are compared as (target, min, max). `request`
 * is the field a save sends it under when that is not its own name: a price
 * is served in thousandths and saved in dollars.
 */
const CASES = [
  { field: 'defaultMode', env: { DEFAULT_MODE: 'generate' }, fromEnv: 'generate', save: 'preview', saved: 'preview', code: 'preview' },
  { field: 'defaultTheme', env: { DEFAULT_THEME: 'Dark' }, fromEnv: 'dark', save: 'light', saved: 'light', code: 'light' },
  { field: 'defaultResumeSelection', env: { DEFAULT_RESUME_SELECTION: 'all' }, fromEnv: 'all', save: 'group', saved: 'group', code: 'single' },
  { field: 'defaultResumeDocxEnabled', env: { DEFAULT_RESUME_DOCX: 'off' }, fromEnv: false, save: true, saved: true, code: true },
  { field: 'defaultCoverLetterDocxEnabled', env: { DEFAULT_COVER_LETTER_DOCX: 'no' }, fromEnv: false, save: true, saved: true, code: true },
  { field: 'requireThreeDSecure', env: { REQUIRE_THREE_D_SECURE: 'yes' }, fromEnv: true, save: false, saved: false, code: false },
  {
    field: 'outputBaseDir',
    env: ({ rootDir }) => ({ OUTPUT_BASE_DIR: path.join(rootDir, 'env-out') }),
    fromEnv: ({ rootDir }) => path.join(rootDir, 'env-out'),
    save: ({ rootDir }) => path.join(rootDir, 'admin-out'),
    saved: ({ rootDir }) => path.join(rootDir, 'admin-out'),
    code: () => path.resolve(__dirname, '..', '..', 'generated'),
  },
  // Read in its canonical spelling: one leading slash, none trailing, each token as {{name}}.
  {
    field: 'outputPathPrefix',
    env: { OUTPUT_PATH_PREFIX: 'runs/{{ order_number }}/' },
    fromEnv: '/runs/{{order_number}}',
    save: '/{{date}}/{{user_email}}/{{order_number}}',
    saved: '/{{date}}/{{user_email}}/{{order_number}}',
    code: '/{{user_email}}/{{order_number}}',
  },
  {
    field: 'paymentLimits',
    env: { PAYMENT_CARD_MIN_USD: '5', PAYMENT_CRYPTO_MAX_USD: '3000' },
    fromEnv: [['card', 5_000, 100_000], ['crypto', 50_000, 3_000_000]],
    save: [{ target: 'card', minUsd: '1', maxUsd: '40' }, { target: 'crypto', minUsd: '60', maxUsd: '900' }],
    saved: [['card', 1_000, 40_000], ['crypto', 60_000, 900_000]],
    code: [['card', 2_500, 100_000], ['crypto', 50_000, 2_000_000]],
    read: limitsOf,
  },
  // By display name, in any case: the id it names is what is served.
  { field: 'defaultModelId', env: { DEFAULT_MODEL: 'claude opus' }, fromEnv: 'claude-cli-opus', save: 'claude-cli-haiku', saved: 'claude-cli-haiku', code: 'claude-cli-sonnet' },
  // '' saved is the administrator's "the default model", which beats .env.
  { field: 'analysisModelId', env: { ANALYSIS_MODEL: 'claude-cli-haiku' }, fromEnv: 'claude-cli-haiku', save: '', saved: '', code: '' },
  // A paid subscription's price for 30 days: not offered (null) until somebody prices it.
  {
    field: 'premiumPriceMilli',
    request: 'premiumPriceUsd',
    env: { SUBSCRIPTION_PREMIUM_PRICE_USD: '9.99' },
    fromEnv: 9_990,
    save: '12.5',
    saved: 12_500,
    code: null,
  },
  {
    field: 'premiumPlusPriceMilli',
    request: 'premiumPlusPriceUsd',
    env: { SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: '$19.99' },
    fromEnv: 19_990,
    save: 25,
    saved: 25_000,
    code: null,
  },
  {
    field: 'premiumMaxPriceMilli',
    request: 'premiumMaxPriceUsd',
    env: { SUBSCRIPTION_PREMIUM_MAX_PRICE_USD: '49.995' },
    fromEnv: 49_995,
    save: '0.001',
    saved: 1,
    code: null,
  },
];

test('every field with a .env default has a case below, a variable and a row of the operational table', () => {
  assert.deepEqual(CASES.map((entry) => entry.field).sort(), [...DEFAULTED_SETTING_KEYS].sort());
  const table = new Set(OPERATIONAL_VARIABLES.map((variable) => variable.name));
  for (const name of ALL_VARIABLES) assert.ok(table.has(name), `${name} is in config/operational.ts's table`);
  for (const variable of SETTING_DEFAULT_VARIABLES) assert.equal(variable.readAt, 'per-call', variable.name);
});

for (const entry of CASES) {
  test(`${entry.field}: .env over the code default, an administrator's value over .env, and null puts .env's back`, async () => {
    const dirs = useTempStorage(`setting-defaults-${entry.field}`);
    const value = (spec) => (typeof spec === 'function' ? spec(dirs) : spec);
    const read = entry.read ?? ((served) => served);
    const sent = entry.request ?? entry.field;

    await withEnv({}, async (warnings) => {
      const config = loadFresh('../dist/config/aiModelConfig');
      const admin = await config.getAdminAppSettings();
      assert.deepEqual(read(admin[entry.field]), value(entry.code), 'nothing set: the code default');
      assert.equal(admin.settingSources[entry.field], 'default');
      assert.deepEqual(read(admin.settingDefaults[entry.field]), value(entry.code));
      assert.deepEqual(warnings, []);
    });

    await withEnv(value(entry.env), async (warnings) => {
      const config = loadFresh('../dist/config/aiModelConfig');
      let admin = await config.getAdminAppSettings();
      assert.deepEqual(read(admin[entry.field]), value(entry.fromEnv), '.env over the code default');
      assert.equal(admin.settingSources[entry.field], 'env');
      assert.deepEqual(read(admin.settingDefaults[entry.field]), value(entry.fromEnv));

      admin = await config.updateAppSettings({ [sent]: value(entry.save) });
      assert.deepEqual(read(admin[entry.field]), value(entry.saved), "an administrator's value over .env");
      assert.equal(admin.settingSources[entry.field], 'admin');
      assert.deepEqual(read(admin.settingDefaults[entry.field]), value(entry.fromEnv), 'what Reset would give');
      assert.ok(entry.field in storedRow(dirs.dbDir), 'what was set is stored');

      // Saving something else leaves it set.
      const other = entry.field === 'defaultMode' ? { defaultTheme: 'dark' } : { defaultMode: 'generate' };
      admin = await config.updateAppSettings(other);
      assert.equal(admin.settingSources[entry.field], 'admin');

      admin = await config.updateAppSettings({ [sent]: null });
      assert.deepEqual(read(admin[entry.field]), value(entry.fromEnv), 'Reset to default: .env again');
      assert.equal(admin.settingSources[entry.field], 'env');
      assert.equal(entry.field in storedRow(dirs.dbDir), false, 'and nothing stored for it');

      config.invalidateSettingsCache();
      admin = await config.getAdminAppSettings();
      assert.equal(admin.settingSources[entry.field], 'env', 'as read back from the row');
      assert.deepEqual(warnings, []);
    });

    // .env removed after the reset: the code default, nothing frozen in the row.
    await withEnv({}, async () => {
      const config = loadFresh('../dist/config/aiModelConfig');
      const admin = await config.getAdminAppSettings();
      assert.deepEqual(read(admin[entry.field]), value(entry.code));
      assert.equal(admin.settingSources[entry.field], 'default');
    });
  });
}

test('a save stores only the fields it names, so a value merely in effect keeps following .env', async () => {
  const { dbDir } = useTempStorage('setting-defaults-sparse');
  await withEnv({ DEFAULT_THEME: 'dark' }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    await config.updateAppSettings({ defaultMode: 'generate' });
    const row = storedRow(dbDir);
    const stored = DEFAULTED_SETTING_KEYS.filter((key) => key in row);
    assert.deepEqual(stored, ['defaultMode']);

    // A model edit, create and delete store no default either.
    const created = await config.createAIModel({
      name: 'Claude Fable',
      provider: 'claude-cli',
      modelName: 'fable',
      pricePerResumeUsd: '0',
    });
    const fable = created.aiModels.find((model) => model.modelName === 'fable');
    await config.updateAIModel('claude-cli-opus', { description: 'Hardest prompts.' });
    await config.deleteAIModel(fable.id);
    assert.deepEqual(DEFAULTED_SETTING_KEYS.filter((key) => key in storedRow(dbDir)), ['defaultMode']);
  });
  await withEnv({ DEFAULT_THEME: 'light' }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.defaultTheme, 'light', 'a .env edit reaches a value nobody set');
    assert.equal(admin.defaultMode, 'generate');
  });
});

test("deleting the administrator's default or analysis model removes the choice, so .env's is in effect again", async () => {
  const { dbDir } = useTempStorage('setting-defaults-delete-model');
  await withEnv({ DEFAULT_MODEL: 'Claude Haiku', ANALYSIS_MODEL: 'claude-cli-opus' }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const created = await config.createAIModel({
      name: 'Claude Fable',
      provider: 'claude-cli',
      modelName: 'fable',
      pricePerResumeUsd: '0.01',
    });
    const fable = created.aiModels.find((model) => model.modelName === 'fable');
    let admin = await config.updateAppSettings({ defaultModelId: fable.id, analysisModelId: fable.id });
    assert.equal(admin.defaultModelId, fable.id);
    assert.equal(admin.analysisModelId, fable.id);
    assert.equal((await config.resolveAnalysisModel()).id, fable.id);

    admin = await config.deleteAIModel(fable.id);
    assert.equal(admin.defaultModelId, 'claude-cli-haiku');
    assert.equal(admin.settingSources.defaultModelId, 'env');
    assert.equal(admin.analysisModelId, 'claude-cli-opus');
    assert.equal(admin.settingSources.analysisModelId, 'env');
    const row = storedRow(dbDir);
    assert.equal('defaultModelId' in row, false);
    assert.equal('analysisModelId' in row, false);
    assert.equal((await config.resolveAnalysisModel()).id, 'claude-cli-opus');
  });
});

test('a default model set here that stops running is served as stale, still stored, and the default again once it runs', async () => {
  const { dbDir } = useTempStorage('setting-defaults-stale-default');
  await withEnv({}, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    let admin = await config.updateAppSettings({ defaultModelId: 'claude-cli-opus' });
    assert.equal(admin.settingSources.defaultModelId, 'admin');
    assert.equal(admin.staleDefaultModelId, null);

    admin = await config.updateAIModel('claude-cli-opus', { enabled: false });
    assert.equal(admin.defaultModelId, 'claude-cli-sonnet', 'another runs in its place');
    assert.equal(admin.settingSources.defaultModelId, 'default', 'which is where THAT one came from');
    assert.equal(admin.staleDefaultModelId, 'claude-cli-opus', 'the stored one is named, so the page can say so');
    assert.equal(storedRow(dbDir).defaultModelId, 'claude-cli-opus');

    admin = await config.updateAIModel('claude-cli-opus', { enabled: true });
    assert.equal(admin.defaultModelId, 'claude-cli-opus');
    assert.equal(admin.staleDefaultModelId, null);

    // Reset forgets it, stale or not.
    await config.updateAIModel('claude-cli-opus', { enabled: false });
    admin = await config.updateAppSettings({ defaultModelId: null });
    assert.equal(admin.staleDefaultModelId, null);
    assert.equal('defaultModelId' in storedRow(dbDir), false);
  });
});

test('a model .env names that cannot run warns once, by name, and the code default is used', async () => {
  useTempStorage('setting-defaults-bad-model');
  await withEnv({ DEFAULT_MODEL: 'No Such Model', ANALYSIS_MODEL: 'Nor This' }, async (warnings) => {
    const config = loadFresh('../dist/config/aiModelConfig');
    let admin = await config.getAdminAppSettings();
    assert.equal(admin.defaultModelId, 'claude-cli-sonnet');
    assert.equal(admin.settingSources.defaultModelId, 'default');
    assert.equal(admin.analysisModelId, '');
    assert.equal(admin.settingSources.analysisModelId, 'default');
    assert.equal((await config.resolveAnalysisModel()).id, 'claude-cli-sonnet', 'postings go to the default model');

    config.invalidateSettingsCache();
    admin = await config.getAdminAppSettings();
    assert.equal(warnings.filter((line) => line.includes('DEFAULT_MODEL="No Such Model"')).length, 1, warnings.join('\n'));
    assert.equal(warnings.filter((line) => line.includes('ANALYSIS_MODEL="Nor This"')).length, 1, warnings.join('\n'));
  });

  // A model that exists but is switched off is no default either.
  await withEnv({ DEFAULT_MODEL: 'Claude Opus' }, async (warnings) => {
    const config = loadFresh('../dist/config/aiModelConfig');
    let admin = await config.updateAIModel('claude-cli-opus', { enabled: false });
    assert.equal(admin.defaultModelId, 'claude-cli-sonnet');
    assert.equal(admin.settingSources.defaultModelId, 'default');
    assert.ok(warnings.some((line) => line.startsWith('[env] DEFAULT_MODEL="Claude Opus" names no model that can run here')));
    admin = await config.updateAIModel('claude-cli-opus', { enabled: true });
    assert.equal(admin.defaultModelId, 'claude-cli-opus', 'switched back on, .env names it again');
    assert.equal(admin.settingSources.defaultModelId, 'env');
  });
});

test("an empty default model clears it; an empty analysis model is the administrator's choice of the default model", async () => {
  const { dbDir } = useTempStorage('setting-defaults-empty-ids');
  await withEnv({ DEFAULT_MODEL: 'claude-cli-opus', ANALYSIS_MODEL: 'claude-cli-haiku' }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    await config.updateAppSettings({ defaultModelId: 'claude-cli-haiku' });
    let admin = await config.updateAppSettings({ defaultModelId: '' });
    assert.equal(admin.defaultModelId, 'claude-cli-opus');
    assert.equal(admin.settingSources.defaultModelId, 'env');
    assert.equal('defaultModelId' in storedRow(dbDir), false);

    admin = await config.updateAppSettings({ analysisModelId: '' });
    assert.equal(admin.analysisModelId, '');
    assert.equal(admin.settingSources.analysisModelId, 'admin', "'' beats ANALYSIS_MODEL");
    assert.equal(storedRow(dbDir).analysisModelId, '');
    assert.equal((await config.resolveAnalysisModel()).id, 'claude-cli-opus', 'the default model reads postings');
  });
});

test("an ordinary account's payload carries no source and no default; an administrator's carries both", async () => {
  useTempStorage('setting-defaults-payloads');
  await withEnv({ DEFAULT_THEME: 'dark', CONTACT_CHANNELS: 'email:help@example.org' }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const user = await config.getUserAppSettings();
    assert.equal(user.defaultTheme, 'dark', 'the value in effect reaches everybody');
    for (const key of ['settingSources', 'settingDefaults']) assert.equal(key in user, false, key);
    assert.equal(JSON.stringify(user).includes('"env"'), false);

    const admin = await config.getAdminAppSettings();
    assert.deepEqual(Object.keys(admin.settingSources).sort(), [...DEFAULTED_SETTING_KEYS].sort());
    assert.deepEqual(Object.keys(admin.settingDefaults).sort(), [...DEFAULTED_SETTING_KEYS].sort());
  });
});

async function serveAdmin(name) {
  const dirs = useTempStorage(`setting-defaults-routes-${name}`);
  useAdminEmails('boss@example.com');
  loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/settingsRepository');
  const users = loadFresh('../dist/database/userRepository');
  const config = loadFresh('../dist/config/aiModelConfig');
  loadFresh('../dist/services/contact');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const admin = loadFresh('../dist/routes/admin');
  const contact = loadFresh('../dist/routes/contact');
  const boss = users.createUser({ email: 'boss@example.com' });
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin/contact', contact.adminContactRouter);
  app.use('/api/contact', contact.default);
  app.use('/api/admin', admin.default);
  const server = app.listen(0);
  const port = server.address().port;
  const token = users.createSession(boss.id);
  const call = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...dirs, config, call, close: () => server.close() };
}

test('PUT /api/admin/settings: null resets a field, and a value of the wrong shape is refused by name', async () => {
  await withEnv({ DEFAULT_RESUME_SELECTION: 'all' }, async () => {
    const s = await serveAdmin('put');
    try {
      let reply = await s.call('PUT', '/api/admin/settings', { defaultResumeSelection: 'group', defaultTheme: 'dark' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.settingSources.defaultResumeSelection, 'admin');
      assert.equal(reply.body.settingDefaults.defaultResumeSelection, 'all');

      reply = await s.call('PUT', '/api/admin/settings', { defaultResumeSelection: null });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.defaultResumeSelection, 'all');
      assert.equal(reply.body.settingSources.defaultResumeSelection, 'env');
      assert.equal(reply.body.defaultTheme, 'dark', 'only the field named was reset');

      reply = await s.call('PUT', '/api/admin/settings', { defaultTheme: 'blue' });
      assert.equal(reply.status, 400);
      assert.match(reply.body.error, /defaultTheme must be "light" or "dark"/);
      reply = await s.call('PUT', '/api/admin/settings', { requireThreeDSecure: 'yes' });
      assert.equal(reply.status, 400);
      assert.match(reply.body.error, /requireThreeDSecure must be a boolean/);

      reply = await s.call('GET', '/api/admin/settings');
      assert.equal(reply.body.defaultTheme, 'dark', 'a refused save changed nothing');
    } finally {
      s.close();
    }
  });
});

test('the payment limits: .env reaches the buy page, an empty list resets, and a method a saved list leaves out takes .env\'s', async () => {
  await withEnv({ PAYMENT_CARD_MIN_USD: '5', PAYMENT_CRYPTO_MIN_USD: '70' }, async () => {
    const { dbDir } = useTempStorage('setting-defaults-limits');
    const config = loadFresh('../dist/config/aiModelConfig');
    const pricing = loadFresh('../dist/services/payments/pricing');
    assert.equal((await pricing.resolveLimits({ method: 'card' })).minAmountCents, 500);
    await assert.rejects(() => pricing.quotePurchase('4.99', { method: 'card' }), /smallest card purchase is \$5/);
    // The presets below the new minimum are not offered.
    assert.deepEqual(
      (await pricing.presetsFor({ method: 'card' })).map((preset) => preset.amountMilli),
      [5_000, 10_000, 25_000, 50_000, 100_000]
    );

    await config.updateAppSettings({ paymentLimits: [{ target: 'card', minUsd: '1', maxUsd: '40' }] });
    assert.equal((await pricing.resolveLimits({ method: 'card' })).minAmountCents, 100);
    assert.equal((await pricing.resolveLimits({ method: 'crypto' })).minAmountCents, 7_000, ".env's crypto bounds");

    const admin = await config.updateAppSettings({ paymentLimits: [] });
    assert.equal(admin.settingSources.paymentLimits, 'env');
    assert.equal('paymentLimits' in storedRow(dbDir), false);
  });
});

test('each payment method resolves on its own: changing the card never freezes crypto, and one method resets alone', async () => {
  await withEnv({ PAYMENT_CARD_MIN_USD: '7', PAYMENT_CRYPTO_MIN_USD: '70' }, async () => {
    const { dbDir } = useTempStorage('setting-defaults-limits-per-method');
    const config = loadFresh('../dist/config/aiModelConfig');

    let admin = await config.getAdminAppSettings();
    assert.deepEqual(limitsOf(admin.paymentLimits), [['card', 7_000, 100_000], ['crypto', 70_000, 2_000_000]]);
    // Each method names only the variable that set it.
    assert.deepEqual(admin.paymentLimitSources, {
      card: { source: 'env', variables: ['PAYMENT_CARD_MIN_USD'] },
      crypto: { source: 'env', variables: ['PAYMENT_CRYPTO_MIN_USD'] },
    });

    // The card's minimum is changed: only the card's row is stored.
    admin = await config.updateAppSettings({ paymentLimits: [{ target: 'card', minUsd: '8', maxUsd: '100' }] });
    assert.deepEqual(limitsOf(admin.paymentLimits), [['card', 8_000, 100_000], ['crypto', 70_000, 2_000_000]]);
    assert.deepEqual(storedRow(dbDir).paymentLimits.map((row) => row.target), ['card']);
    assert.equal(admin.paymentLimitSources.card.source, 'admin');
    assert.equal(admin.paymentLimitSources.crypto.source, 'env');
    assert.equal(admin.settingSources.paymentLimits, 'admin', 'something about the limits is set here');

    // .env's crypto bound still reaches the page...
    await withEnv({ PAYMENT_CARD_MIN_USD: '7', PAYMENT_CRYPTO_MIN_USD: '60' }, async () => {
      admin = await config.getAdminAppSettings();
      assert.deepEqual(limitsOf(admin.paymentLimits), [['card', 8_000, 100_000], ['crypto', 60_000, 2_000_000]]);
    });

    // ...a save of crypto keeps the card's stored row...
    admin = await config.updateAppSettings({ paymentLimits: [{ target: 'crypto', minUsd: '75', maxUsd: '1500' }] });
    assert.deepEqual(limitsOf(admin.paymentLimits), [['card', 8_000, 100_000], ['crypto', 75_000, 1_500_000]]);
    assert.deepEqual(storedRow(dbDir).paymentLimits.map((row) => row.target), ['card', 'crypto']);

    // ...and Reset to default of one method takes only its row away.
    admin = await config.updateAppSettings({ paymentLimits: [{ target: 'card', reset: true }] });
    assert.deepEqual(limitsOf(admin.paymentLimits), [['card', 7_000, 100_000], ['crypto', 75_000, 1_500_000]]);
    assert.deepEqual(admin.paymentLimitSources.card, { source: 'env', variables: ['PAYMENT_CARD_MIN_USD'] });
    assert.deepEqual(storedRow(dbDir).paymentLimits.map((row) => row.target), ['crypto']);

    await assert.rejects(
      () => config.updateAppSettings({ paymentLimits: [{ target: 'crypto', reset: true }, { target: 'crypto', minUsd: '1', maxUsd: '2' }] }),
      /name crypto twice/
    );
    await assert.rejects(() => config.updateAppSettings({ paymentLimits: { target: 'card' } }), /must be a list/);

    // The last stored row reset: nothing is stored, and the source is .env's again.
    admin = await config.updateAppSettings({ paymentLimits: [{ target: 'crypto', reset: true }] });
    assert.equal(admin.settingSources.paymentLimits, 'env');
    assert.equal('paymentLimits' in storedRow(dbDir), false);
  });
});

test('DEFAULT_RESUME_SELECTION=group is refused from .env, which cannot name the group: the default is used, said once', async () => {
  useTempStorage('setting-defaults-group-env');
  await withEnv({ DEFAULT_RESUME_SELECTION: 'Group' }, async (warnings) => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.defaultResumeSelection, 'single');
    assert.equal(admin.settingSources.defaultResumeSelection, 'default');
    assert.equal((await config.getUserAppSettings()).defaultResumeSelection, 'single');
    assert.equal(warnings.filter((line) => line.includes('DEFAULT_RESUME_SELECTION=group names no group')).length, 1, warnings.join('\n'));
  });
});

test('Reset to default of the output folder checks the folder it puts back, as a save of one does', async () => {
  const { rootDir } = useTempStorage('setting-defaults-folder-reset');
  const blocker = path.join(rootDir, 'a-file');
  require('node:fs').writeFileSync(blocker, 'not a folder');
  await withEnv({ OUTPUT_BASE_DIR: path.join(blocker, 'sub') }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    await config.updateAppSettings({ outputBaseDir: path.join(rootDir, 'out') });
    // .env's folder cannot be made: Reset is refused rather than said to succeed.
    await assert.rejects(() => config.updateAppSettings({ outputBaseDir: null }), /ENOTDIR|not a directory|EEXIST/);
    assert.equal((await config.getAdminAppSettings()).outputBaseDir, path.join(rootDir, 'out'), 'nothing was saved');
  });
});

test('a payment bound .env cannot use warns once and keeps the default', async () => {
  useTempStorage('setting-defaults-limits-junk');
  await withEnv(
    { PAYMENT_CARD_MIN_USD: '2.505', PAYMENT_CRYPTO_MIN_USD: '3000', PAYMENT_CRYPTO_MAX_USD: '2500' },
    async (warnings) => {
      const config = loadFresh('../dist/config/aiModelConfig');
      const admin = await config.getAdminAppSettings();
      assert.deepEqual(limitsOf(admin.paymentLimits), [['card', 2_500, 100_000], ['crypto', 50_000, 2_000_000]]);
      assert.equal(admin.settingSources.paymentLimits, 'default');
      assert.ok(warnings.some((line) => line.includes('PAYMENT_CARD_MIN_USD=$2.505 is not a whole number of cents')), warnings.join('\n'));
      assert.ok(
        warnings.some((line) => line.includes('PAYMENT_CRYPTO_MIN_USD ($3,000) is above PAYMENT_CRYPTO_MAX_USD ($2,500)')),
        warnings.join('\n')
      );
    }
  );
});

test('OUTPUT_BASE_DIR must be absolute; ~ is the home folder', async () => {
  useTempStorage('setting-defaults-output');
  await withEnv({ OUTPUT_BASE_DIR: 'relative/out' }, async (warnings) => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.outputBaseDir, path.resolve(__dirname, '..', '..', 'generated'));
    assert.equal(admin.settingSources.outputBaseDir, 'default');
    assert.ok(warnings.some((line) => line.includes('OUTPUT_BASE_DIR="relative/out" is not an absolute path')));
  });
  await withEnv({ OUTPUT_BASE_DIR: '~/tailor-out' }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.outputBaseDir, path.join(os.homedir(), 'tailor-out'));
    assert.equal(admin.settingSources.outputBaseDir, 'env');
  });
});

test('CONTACT_CHANNELS: used while nothing is saved, an entry that fails dropped with one warning naming its position only', async () => {
  const channels = 'email:help@example.org|Support,bogus:secret-value,telegram:@example_help,email:not-an-address';
  await withEnv({ CONTACT_CHANNELS: channels }, async (warnings) => {
    const s = await serveAdmin('contact');
    try {
      const fromEnv = [
        { type: 'email', label: 'Support', value: 'help@example.org', href: 'mailto:help@example.org' },
        { type: 'telegram', label: 'Telegram', value: '@example_help', href: 'https://t.me/example_help' },
      ];
      let reply = await s.call('GET', '/api/contact');
      assert.deepEqual(reply.body, { channels: fromEnv }, 'the public read');
      reply = await s.call('GET', '/api/admin/contact');
      assert.deepEqual(reply.body.channels, fromEnv);
      assert.deepEqual(reply.body.settingSources, { channels: 'env' });
      assert.deepEqual(reply.body.settingDefaults, { channels: fromEnv });

      const warned = warnings.filter((line) => line.includes('CONTACT_CHANNELS'));
      assert.equal(warned.length, 1, warnings.join('\n'));
      assert.match(warned[0], /entries 2, 4 are not contact channels/);
      for (const secret of ['secret-value', 'not-an-address', 'bogus']) assert.equal(warned[0].includes(secret), false, secret);

      // None, saved here, beats .env.
      reply = await s.call('PUT', '/api/admin/contact', { channels: [] });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body.settingSources, { channels: 'admin' });
      assert.deepEqual((await s.call('GET', '/api/contact')).body, { channels: [] });

      // Reset to default: the row goes, .env's are shown again.
      reply = await s.call('PUT', '/api/admin/contact', { channels: null });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body.settingSources, { channels: 'env' });
      assert.equal(readSettingRaw(s.dbDir, 'contact'), null);
      assert.deepEqual((await s.call('GET', '/api/contact')).body, { channels: fromEnv });
    } finally {
      s.close();
    }
  });
  await withEnv({}, async () => {
    const s = await serveAdmin('contact-none');
    try {
      const reply = await s.call('GET', '/api/admin/contact');
      assert.deepEqual(reply.body.channels, []);
      assert.deepEqual(reply.body.settingSources, { channels: 'default' });
    } finally {
      s.close();
    }
  });
});

test('the startup line names the .env defaults in effect, and of CONTACT_CHANNELS only what the rules accept', async () => {
  const { describeNonDefaultOperationalSettings } = require('../dist/config/operational');
  await withEnv(
    {
      DEFAULT_THEME: 'dark',
      PAYMENT_CARD_MIN_USD: '5',
      JOB_LAKE_REPORT_RATE_USD: '0.05',
      SUBSCRIPTION_PREMIUM_PRICE_USD: '$9.990',
      CONTACT_CHANNELS: 'email:help@example.org|Support,whatsapp:not-a-number',
    },
    async (warnings) => {
      const line = describeNonDefaultOperationalSettings();
      assert.match(line, /DEFAULT_THEME=dark/);
      assert.match(line, /PAYMENT_CARD_MIN_USD=5(,|$)/);
      assert.match(line, /JOB_LAKE_REPORT_RATE_USD=0\.05/);
      // The price in effect, as .env would spell it.
      assert.match(line, /SUBSCRIPTION_PREMIUM_PRICE_USD=9\.99(,|$)/);
      assert.doesNotMatch(line, /SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD/, 'not offered is the default: not listed');
      assert.match(line, /CONTACT_CHANNELS=email:help@example\.org\|Support(,|$)/);
      assert.equal(line.includes('not-a-number'), false, 'a refused entry is not printed');
      assert.ok(warnings.some((warning) => warning.includes('CONTACT_CHANNELS: entry 2 is not a contact channel')), warnings.join('\n'));
    }
  );
});

test("the lake's rate and cap: .env under the administrator's value, each with its source, and null puts .env's back", async () => {
  await withEnv({ JOB_LAKE_REPORT_RATE_USD: '0.05', JOB_LAKE_DAILY_CAP_USD: '3' }, async () => {
    useTempStorage('setting-defaults-lake');
    loadFresh('../dist/database/sqlite');
    loadFresh('../dist/database/settingsRepository');
    const lake = loadFresh('../dist/services/jobLake/settings');

    let settings = lake.readLakeSettings();
    assert.equal(settings.reportRateMilli, 50);
    assert.equal(settings.reportRateSet, false, 'no administrator rate');
    assert.equal(settings.dailyCapMilli, 3_000);
    assert.deepEqual(settings.settingSources, { reportRateMilli: 'env', duplicateWindowDays: 'default', dailyCapMilli: 'env' });
    assert.deepEqual(settings.settingDefaults, { reportRateMilli: 50, duplicateWindowDays: 60, dailyCapMilli: 3_000 });
    assert.equal(lake.globalReportRateMilli(), 50, 'what a reporter without a rate of their own is paid');

    let saved = lake.updateLakeSettings({ reportRateUsd: '0.02', dailyCapUsd: '1' }, 'admin-1');
    assert.equal(saved.ok, true);
    settings = saved.settings;
    assert.equal(settings.reportRateMilli, 20);
    assert.equal(settings.dailyCapMilli, 1_000);
    assert.deepEqual(settings.settingSources, { reportRateMilli: 'admin', duplicateWindowDays: 'default', dailyCapMilli: 'admin' });
    assert.equal(settings.settingDefaults.reportRateMilli, 50, 'what Reset would give');

    saved = lake.updateLakeSettings({ reportRateUsd: null, dailyCapUsd: '' }, 'admin-1');
    assert.equal(saved.settings.reportRateMilli, 50);
    assert.equal(saved.settings.dailyCapMilli, 3_000);
    assert.equal(saved.settings.settingSources.reportRateMilli, 'env');

    // "No cap" is an administrator's choice of its own, and beats .env's cap...
    saved = lake.updateLakeSettings({ dailyCapUsd: 'none' }, 'admin-1');
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.dailyCapMilli, null);
    assert.equal(saved.settings.settingSources.dailyCapMilli, 'admin');
    assert.equal(saved.settings.settingDefaults.dailyCapMilli, 3_000, 'Reset gives .env\'s cap back');
    assert.equal(lake.readLakeSettings().dailyCapMilli, null);
    // ...a cap typed later replaces it, and Reset takes either away.
    saved = lake.updateLakeSettings({ dailyCapUsd: '4' }, 'admin-1');
    assert.equal(saved.settings.dailyCapMilli, 4_000);
    saved = lake.updateLakeSettings({ dailyCapUsd: 'None' }, 'admin-1');
    assert.equal(saved.settings.dailyCapMilli, null);
    saved = lake.updateLakeSettings({ dailyCapUsd: null }, 'admin-1');
    assert.equal(saved.settings.dailyCapMilli, 3_000);
    assert.equal(saved.settings.settingSources.dailyCapMilli, 'env');
  });

  await withEnv({ JOB_LAKE_DAILY_CAP_USD: 'lots' }, async (warnings) => {
    useTempStorage('setting-defaults-lake-junk');
    loadFresh('../dist/database/sqlite');
    loadFresh('../dist/database/settingsRepository');
    const lake = loadFresh('../dist/services/jobLake/settings');
    const settings = lake.readLakeSettings();
    assert.equal(settings.dailyCapMilli, null, 'junk is no cap, as unset is');
    assert.equal(settings.settingSources.dailyCapMilli, 'default');
    assert.equal(settings.reportRateMilli, 0);
    assert.ok(warnings.some((line) => line.includes('JOB_LAKE_DAILY_CAP_USD="lots" is not an amount in dollars')));
  });
});

/* ------------------------------------------------- subscription prices */

test("a subscription's price: '' or $0 saved is not offered and beats .env, null resets, and a bad one is refused by its box", async () => {
  const { dbDir } = useTempStorage('setting-defaults-subscription-prices');
  await withEnv({ SUBSCRIPTION_PREMIUM_PRICE_USD: '9.99', SUBSCRIPTION_PREMIUM_MAX_PRICE_USD: '0' }, async (warnings) => {
    const config = loadFresh('../dist/config/aiModelConfig');
    let admin = await config.getAdminAppSettings();
    assert.equal(admin.premiumPriceMilli, 9_990);
    assert.equal(admin.premiumPlusPriceMilli, null, 'unset: not offered');
    assert.equal(admin.premiumMaxPriceMilli, null, '0 in .env: not offered');
    assert.equal(admin.settingSources.premiumMaxPriceMilli, 'default', '0 is no price: nothing came from .env');
    assert.deepEqual(await config.getSubscriptionPrices(), { premium: 9_990, 'premium-plus': null, 'premium-max': null });
    // Unset and 0 are decisions - not offered - not prices that could not be read.
    assert.deepEqual(await config.getSubscriptionPriceReading(), {
      prices: { premium: 9_990, 'premium-plus': null, 'premium-max': null },
      unreadable: [],
    });

    // An emptied box - or $0 - is the administrator's "not offered", stored as 0, and beats .env.
    for (const notOffered of ['', ' ', '0', '$0', 0]) {
      admin = await config.updateAppSettings({ premiumPriceUsd: notOffered });
      assert.equal(admin.premiumPriceMilli, null, JSON.stringify(notOffered));
      assert.equal(admin.settingSources.premiumPriceMilli, 'admin');
      assert.equal(admin.settingDefaults.premiumPriceMilli, 9_990, 'what Reset would give');
      assert.equal(storedRow(dbDir).premiumPriceMilli, 0);
    }
    assert.equal((await config.getSubscriptionPrices()).premium, null);
    config.invalidateSettingsCache();
    admin = await config.getAdminAppSettings();
    assert.equal(admin.premiumPriceMilli, null, 'as read back from the row');
    assert.equal(admin.settingSources.premiumPriceMilli, 'admin');

    // Reset to default: .env's price again, nothing stored.
    admin = await config.updateAppSettings({ premiumPriceUsd: null });
    assert.equal(admin.premiumPriceMilli, 9_990);
    assert.equal(admin.settingSources.premiumPriceMilli, 'env');
    assert.equal('premiumPriceMilli' in storedRow(dbDir), false);

    // Refused by name, under the box it came from, and nothing saved.
    for (const [body, sentence, field, code] of [
      [{ premiumPriceUsd: '10000.001' }, /^The Premium price must be at most \$10,000\.$/, 'premiumPriceUsd', 'bad-price'],
      [{ premiumPlusPriceUsd: '1.2345' }, /^The Premium\+ price can have at most three decimal places/, 'premiumPlusPriceUsd', 'bad-price'],
      [{ premiumMaxPriceUsd: 'abc' }, /^The Premium Max price must be an amount in dollars/, 'premiumMaxPriceUsd', 'bad-price'],
      [{ premiumMaxPriceUsd: '-5' }, /^The Premium Max price cannot be negative\.$/, 'premiumMaxPriceUsd', 'bad-price'],
      // A price in thousandths is never read: requests carry dollars.
      [{ premiumPriceMilli: 9_990 }, /^Send the Premium price in dollars, as premiumPriceUsd\.$/, 'premiumPriceUsd', 'bad-price-field'],
      [{ premiumMaxPriceMilli: null }, /^Send the Premium Max price in dollars, as premiumMaxPriceUsd\.$/, 'premiumMaxPriceUsd', 'bad-price-field'],
    ]) {
      const refusal = await config.updateAppSettings(body).then(
        () => null,
        (error) => error
      );
      assert.ok(refusal, `refused: ${JSON.stringify(body)}`);
      assert.match(refusal.message, sentence);
      assert.equal(refusal.field, field);
      assert.equal(refusal.code, code);
    }
    admin = await config.getAdminAppSettings();
    assert.equal(admin.premiumPriceMilli, 9_990, 'a refused save changed nothing');
    assert.equal(admin.premiumPlusPriceMilli, null);

    // The largest price there is, exactly, and the smallest step.
    admin = await config.updateAppSettings({ premiumMaxPriceUsd: '10000', premiumPlusPriceUsd: 0.001 });
    assert.equal(admin.premiumMaxPriceMilli, 10_000_000);
    assert.equal(admin.premiumPlusPriceMilli, 1);
    assert.deepEqual(warnings, []);
  });
});

test("a subscription price .env cannot use: above $10,000 clamps, junk is not offered but flagged unreadable, each said once; a junk stored one is ignored", async () => {
  const { dbDir } = useTempStorage('setting-defaults-subscription-junk');
  await withEnv({ SUBSCRIPTION_PREMIUM_PRICE_USD: '20000', SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: 'cheap' }, async (warnings) => {
    const config = loadFresh('../dist/config/aiModelConfig');
    let admin = await config.getAdminAppSettings();
    assert.equal(admin.premiumPriceMilli, 10_000_000);
    assert.equal(admin.settingSources.premiumPriceMilli, 'env');
    assert.equal(admin.premiumPlusPriceMilli, null);
    assert.equal(admin.settingSources.premiumPlusPriceMilli, 'default');
    assert.ok(warnings.some((line) => line === '[env] SUBSCRIPTION_PREMIUM_PRICE_USD=20000 is above $10,000; using $10,000.'), warnings.join('\n'));
    assert.ok(warnings.some((line) => line.includes('SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD="cheap" is not an amount in dollars')), warnings.join('\n'));
    // Not for sale - but nobody decided Premium+ is not offered, and the
    // renewal sweep must not end what was paid for on it.
    assert.deepEqual((await config.getSubscriptionPriceReading()).unreadable, [{ tier: 'premium-plus', source: 'env' }]);
    const { envSubscriptionPriceMilli } = require('../dist/config/settingDefaults');
    assert.deepEqual(envSubscriptionPriceMilli('premium-plus', { SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: '9,99' }), {
      value: null,
      fromEnv: false,
      unreadable: true,
    });
    for (const decided of [{}, { SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: '0' }, { SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: '  ' }]) {
      assert.deepEqual(envSubscriptionPriceMilli('premium-plus', decided), { value: null, fromEnv: false, unreadable: false });
    }
    assert.equal(envSubscriptionPriceMilli('premium-plus', { SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: '20000' }).unreadable, false, 'clamped is read');

    // A price hand-edited into the row is not one this app writes: ignored, said once, and .env's is in effect.
    await config.updateAppSettings({ defaultMode: 'generate' });
    writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ ...storedRow(dbDir), premiumPriceMilli: 'free', premiumMaxPriceMilli: 1.5 }));
    config.invalidateSettingsCache();
    admin = await config.getAdminAppSettings();
    assert.equal(admin.premiumPriceMilli, 10_000_000);
    assert.equal(admin.settingSources.premiumPriceMilli, 'env');
    assert.equal(admin.premiumMaxPriceMilli, null);
    assert.equal(admin.settingSources.premiumMaxPriceMilli, 'default');
    assert.equal(warnings.filter((line) => line.includes('The stored premiumPriceMilli is "free"')).length, 1, warnings.join('\n'));
    assert.equal(warnings.filter((line) => line.includes('The stored premiumMaxPriceMilli is 1.5')).length, 1, warnings.join('\n'));
    // Premium is .env's price, as the page shows it; Premium Max has nothing
    // under the junk, so its "not offered" is unreadable too.
    assert.deepEqual((await config.getSubscriptionPriceReading()).unreadable, [
      { tier: 'premium-plus', source: 'env' },
      { tier: 'premium-max', source: 'admin' },
    ]);
    // The next save does not keep it.
    await config.updateAppSettings({ defaultTheme: 'dark' });
    assert.equal('premiumPriceMilli' in storedRow(dbDir), false);
    assert.deepEqual((await config.getSubscriptionPriceReading()).unreadable, [{ tier: 'premium-plus', source: 'env' }]);
  });
});

test('PUT /api/admin/settings: a subscription price is saved in dollars, and a refusal names its box', async () => {
  await withEnv({ SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD: '19.99' }, async () => {
    const s = await serveAdmin('prices');
    try {
      let reply = await s.call('PUT', '/api/admin/settings', { premiumPriceUsd: '9.99' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.premiumPriceMilli, 9_990);
      assert.equal(reply.body.premiumPlusPriceMilli, 19_990);
      assert.equal(reply.body.premiumMaxPriceMilli, null);
      assert.deepEqual(
        [reply.body.settingSources.premiumPriceMilli, reply.body.settingSources.premiumPlusPriceMilli, reply.body.settingSources.premiumMaxPriceMilli],
        ['admin', 'env', 'default']
      );
      assert.equal(reply.body.settingDefaults.premiumPlusPriceMilli, 19_990);

      reply = await s.call('PUT', '/api/admin/settings', { premiumPlusPriceUsd: '12.5.0' });
      assert.equal(reply.status, 400);
      assert.equal(reply.body.field, 'premiumPlusPriceUsd');
      assert.equal(reply.body.code, 'bad-price');
      assert.match(reply.body.error, /^The Premium\+ price must be an amount in dollars/);

      reply = await s.call('PUT', '/api/admin/settings', { premiumPriceMilli: 1 });
      assert.equal(reply.status, 400);
      assert.equal(reply.body.field, 'premiumPriceUsd');
      assert.equal(reply.body.code, 'bad-price-field');
      assert.equal((await s.call('GET', '/api/admin/settings')).body.premiumPriceMilli, 9_990, 'nothing was saved');
    } finally {
      s.close();
    }
  });
});

/* ------------------------------------------------------------- step 9 */

const { settingsDefaultsStep } = require('../dist/database/migrations/settingsDefaults');

/** A database with a settings row as a whole-row save of an older build left it. */
function withSettingsRow(document) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  if (document !== undefined) {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(
      'app-settings',
      typeof document === 'string' ? document : JSON.stringify(document)
    );
  }
  return db;
}

function rowOf(db) {
  return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
}

/** Every field with a .env default at the value an older build froze it at - fee fields, row order and all. */
function frozenDefaults(seed) {
  return {
    providersEnabled: { 'claude-cli': true, 'codex-cli': false, 'gemini-cli': true },
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: 'group-1',
    defaultProfileId: '',
    defaultModelId: seed,
    analysisModelId: '',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    outputBaseDir: path.resolve(__dirname, '..', '..', 'generated'),
    outputPathTemplate: '/{{profile name}}/{{date}}/{{company name}}/{{job title}}',
    paymentLimits: [
      { target: 'crypto', minCents: 5_000, maxCents: 200_000, presetsCents: [100_000, 5_000, 10_000, 15_000, 25_000, 50_000] },
      { target: 'card', minCents: 250, maxCents: 10_000, presetsCents: [250, 500, 1_000, 2_500, 5_000, 10_000], feeBps: 0 },
    ],
    requireThreeDSecure: false,
    aiModels: [],
  };
}

test('step 9 takes every field still at its old default out of the row, keeps the rest, and is idempotent', () => {
  const seed = require('../dist/config/aiModelConfig').defaultSeedModelId();
  const db = withSettingsRow(frozenDefaults(seed));
  const first = settingsDefaultsStep.apply(db);
  assert.equal(first.ran, true);
  assert.equal(settingsDefaultsStep.version, 9);
  assert.match(first.summary, /^10 setting\(s\) still at the old default now follow \.env/);
  const after = rowOf(db);
  assert.deepEqual(Object.keys(after).sort(), [
    'aiModels',
    'defaultGroupId',
    'defaultProfileId',
    'outputPathTemplate',
    'providersEnabled',
  ]);
  assert.deepEqual(after.providersEnabled, { 'claude-cli': true, 'codex-cli': false, 'gemini-cli': true });
  assert.equal(after.defaultGroupId, 'group-1');

  const again = settingsDefaultsStep.apply(db);
  assert.equal(again.ran, false);
  assert.deepEqual(rowOf(db), after, 'a second run changes nothing');
});

test('step 9 keeps every value an administrator changed', () => {
  const changed = {
    ...frozenDefaults('claude-cli-sonnet'),
    defaultMode: 'generate',
    defaultTheme: 'dark',
    defaultResumeSelection: 'group',
    defaultModelId: 'claude-cli-opus',
    analysisModelId: 'claude-cli-haiku',
    defaultResumeDocxEnabled: false,
    defaultCoverLetterDocxEnabled: false,
    outputBaseDir: '/srv/resumes',
    paymentLimits: [
      { target: 'card', minCents: 500, maxCents: 10_000, presetsCents: [500, 1_000] },
      { target: 'crypto', minCents: 5_000, maxCents: 200_000, presetsCents: [5_000] },
    ],
    requireThreeDSecure: true,
  };
  const db = withSettingsRow(changed);
  const outcome = settingsDefaultsStep.apply(db);
  assert.equal(outcome.ran, false);
  assert.deepEqual(rowOf(db), changed);
});

test('step 9 leaves alone a database with no settings, and a row that does not parse', () => {
  assert.equal(settingsDefaultsStep.apply(withSettingsRow()).ran, false);
  const db = withSettingsRow('{ not json');
  assert.equal(settingsDefaultsStep.apply(db).ran, false);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value, '{ not json');
  const bare = new Database(':memory:');
  assert.equal(settingsDefaultsStep.apply(bare).ran, false, 'no settings table at all');
});

test('an upgraded install runs step 9 as it opens: an unchanged value follows .env from then on, a changed one stays', async () => {
  const { dbDir } = useTempStorage('setting-defaults-upgrade');
  loadFresh('../dist/database/sqlite').getDb().close();
  const seed = require('../dist/config/aiModelConfig').defaultSeedModelId();
  const raw = openTestDb(dbDir);
  try {
    // What ac3df79 leaves: data migrations at 8, a whole-row settings save.
    raw.prepare("UPDATE schema_meta SET value = '8' WHERE key = 'provider_schema_version'").run();
    const { aiModels: _none, ...document } = frozenDefaults(seed);
    raw.prepare("INSERT INTO app_settings (key, value) VALUES ('app-settings', ?)").run(
      JSON.stringify({ ...document, providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true }, defaultTheme: 'dark' })
    );
  } finally {
    raw.close();
  }

  await withEnv({ DEFAULT_MODE: 'generate', DEFAULT_THEME: 'light' }, async () => {
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.map(String).join(' '));
    let admin;
    try {
      loadFresh('../dist/database/sqlite');
      const config = loadFresh('../dist/config/aiModelConfig');
      admin = await config.getAdminAppSettings();
    } finally {
      console.log = log;
    }
    assert.ok(lines.some((line) => line.startsWith('[db] Migration 9 (settings-defaults) applied: 9 setting(s)')), lines.join('\n'));
    assert.equal(admin.defaultMode, 'generate', 'unchanged before: .env now');
    assert.equal(admin.settingSources.defaultMode, 'env');
    assert.equal(admin.defaultTheme, 'dark', 'changed before: kept, over .env');
    assert.equal(admin.settingSources.defaultTheme, 'admin');
  });

  const check = openTestDb(dbDir);
  try {
    assert.equal(
      check.prepare("SELECT value FROM schema_meta WHERE key = 'provider_schema_version'").get().value,
      String(require('../dist/database/migrations').LATEST_SCHEMA_VERSION)
    );
  } finally {
    check.close();
  }
});

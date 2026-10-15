const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const express = require('express');
const Database = require('better-sqlite3');

const { loadFresh, openTestDb, readSettingRaw, useAdminEmails, useTempStorage } = require('./helpers');
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
 * value, so the payment limits are compared as (target, min, max).
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

      admin = await config.updateAppSettings({ [entry.field]: value(entry.save) });
      assert.deepEqual(read(admin[entry.field]), value(entry.saved), "an administrator's value over .env");
      assert.equal(admin.settingSources[entry.field], 'admin');
      assert.deepEqual(read(admin.settingDefaults[entry.field]), value(entry.fromEnv), 'what Reset would give');
      assert.ok(entry.field in storedRow(dirs.dbDir), 'what was set is stored');

      // Saving something else leaves it set.
      const other = entry.field === 'defaultMode' ? { defaultTheme: 'dark' } : { defaultMode: 'generate' };
      admin = await config.updateAppSettings(other);
      assert.equal(admin.settingSources[entry.field], 'admin');

      admin = await config.updateAppSettings({ [entry.field]: null });
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
      CONTACT_CHANNELS: 'email:help@example.org|Support,whatsapp:not-a-number',
    },
    async (warnings) => {
      const line = describeNonDefaultOperationalSettings();
      assert.match(line, /DEFAULT_THEME=dark/);
      assert.match(line, /PAYMENT_CARD_MIN_USD=5(,|$)/);
      assert.match(line, /JOB_LAKE_REPORT_RATE_USD=0\.05/);
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

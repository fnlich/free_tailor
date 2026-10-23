const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const ts = require('typescript');

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');

/**
 * The browser's half of the settings an administrator may leave unset, the
 * Models dialog and where resumes are filed (owner decisions S4, M1, M2, O5).
 *
 * The frontend has no test runner, so its pure modules are transpiled with
 * the backend's own TypeScript and run from here (the frontendJobLake
 * pattern). Two kinds of claim:
 *
 *  - COPIES held to the server: the `.env` variable tables a source line
 *    names, the dialog's field names, the token chips.
 *  - DECISIONS run against the server's own code, mostly through the real
 *    client (lib/api.ts, lib/auth.ts, lib/contact.ts) talking to the real
 *    routes: an untouched form sends nothing, a change sends only itself and
 *    becomes "Set here", Reset puts `.env` back, the dialog refuses in the
 *    server's sentences and pins the server's refusals to the box it names.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontend(relative, seen = new Map()) {
  const file = path.join(SRC, relative);
  if (seen.has(file)) return seen.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  seen.set(file, module);
  const resolve = (specifier) => {
    let base;
    if (specifier.startsWith('@/')) base = specifier.slice(2);
    else if (specifier.startsWith('./') || specifier.startsWith('../')) {
      base = path.relative(SRC, path.join(path.dirname(file), specifier));
    } else {
      throw new Error(`${relative} imports ${specifier} at runtime; it is meant to import only frontend modules`);
    }
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontend(candidate, seen);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, resolve);
  return module.exports;
}

/** Imports nothing at runtime: the plan's rule for the source-label lib. */
function importsNothing(relative) {
  const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
  return !/^import (?!type )/m.test(source);
}

const ENV_NAMES = [
  'DEFAULT_MODEL',
  'ANALYSIS_MODEL',
  'DEFAULT_MODE',
  'DEFAULT_THEME',
  'DEFAULT_TAILOR_MODE',
  'RESUME_SUITABLE_PRICE_USD',
  'RESUME_PARTIAL_PRICE_USD',
  'RESUME_FULL_PRICE_USD',
  'DEFAULT_RESUME_DOCX',
  'DEFAULT_COVER_LETTER_DOCX',
  'OUTPUT_BASE_DIR',
  'OUTPUT_PATH_PREFIX',
  'OUTPUT_PATH_SUFFIX',
  'PAYMENT_CARD_MIN_USD',
  'PAYMENT_CARD_MAX_USD',
  'PAYMENT_CRYPTO_MIN_USD',
  'PAYMENT_CRYPTO_MAX_USD',
  'REQUIRE_THREE_D_SECURE',
  'CONTACT_CHANNELS',
  'JOB_LAKE_REPORT_RATE_USD',
  'JOB_LAKE_DAILY_CAP_USD',
  'JOB_LAKE_DUPLICATE_WINDOW_DAYS',
  'SUBSCRIPTION_PREMIUM_PRICE_USD',
  'SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD',
  'SUBSCRIPTION_PREMIUM_MAX_PRICE_USD',
  'AI_LOCKED_PROVIDERS',
  'AI_UNLOCKED_PROVIDERS',
];

/** Runs `fn` with exactly `values` among the settings' variables, the seats unlocked; restores everything after. */
async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  Object.assign(process.env, values);
  resetEnvWarningsForTests();
  try {
    return await fn();
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/**
 * The routes the pages call, on a port of their own, with an administrator, a
 * user and a reporter signed in - and the repository and their ids, to change
 * one of them mid-session.
 */
async function serve(name) {
  const dirs = useTempStorage(`frontend-settings-${name}`);
  useAdminEmails('boss@example.com');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const config = loadFresh('../dist/config/aiModelConfig');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const contact = loadFresh('../dist/routes/contact');

  const boss = users.createUser({ email: 'boss@example.com' });
  const jane = users.createUser({ email: 'Jane.Doe@Example.com' });
  const reporter = users.createUser({ email: 'reporter@example.com', role: 'reporter' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/auth', loadFresh('../dist/routes/auth').default);
  app.use('/api/contact', contact.default);
  app.use('/api/admin/contact', contact.adminContactRouter);
  app.use('/api/admin', loadFresh('../dist/routes/admin').default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = {
    boss: users.createSession(boss.id),
    jane: users.createSession(jane.id),
    reporter: users.createSession(reporter.id),
  };
  const ids = { boss: boss.id, jane: jane.id, reporter: reporter.id };
  return { ...dirs, config, users, ids, base, tokens, close: () => server.close() };
}

/**
 * The frontend's own client - lib/api.ts and its callers, loaded once - with
 * its requests sent to `server` as `who`. Every page's call goes through
 * `apiFetch`, so what it sends and how it reads the answer is what is tested.
 */
async function asClient(server, who, fn) {
  const seen = new Map();
  const api = loadFrontend('lib/api.ts', seen);
  const modules = {
    api,
    auth: loadFrontend('lib/auth.ts', seen),
    contact: loadFrontend('lib/contact.ts', seen),
  };
  const realFetch = globalThis.fetch;
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
  const stored = new Map();
  Object.defineProperty(globalThis, 'window', { value: { location: { hostname: 'localhost' } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = (url, init) => realFetch(String(url).replace(/^https?:\/\/[^/]+\/api/, server.base), init);
  api.setToken(server.tokens[who]);
  try {
    return await fn(modules);
  } finally {
    globalThis.fetch = realFetch;
    for (const name of ['window', 'localStorage']) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
}

/** What a client call threw, so a refusal can be read like the page reads it. */
async function refusalOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('the server accepted it');
}

const sources = () => loadFrontend('lib/settingSources.ts');

/* ============================================================ the copies */

test("the source lib's tables are the server's, and it imports nothing at runtime", () => {
  assert.ok(importsNothing('lib/settingSources.ts'));
  assert.ok(importsNothing('lib/outputPath.ts'));
  const lib = sources();
  const server = require('../dist/config/settingDefaults');
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(lib.APP_SETTING_ENV_VARIABLES), plain(server.APP_SETTING_ENV_VARIABLES));
  assert.deepEqual([...lib.APP_SETTING_KEYS], [...server.DEFAULTED_SETTING_KEYS]);
  assert.deepEqual(plain(lib.CONTACT_SETTING_ENV_VARIABLES), plain(server.CONTACT_SETTING_ENV_VARIABLES));
  assert.deepEqual(plain(lib.LAKE_SETTING_ENV_VARIABLES), plain(server.LAKE_SETTING_ENV_VARIABLES));
  assert.deepEqual([...lib.SETTING_SOURCES], [...server.SETTING_SOURCES]);
  // Each subscription price is saved under the server's own dollar name.
  const { SUBSCRIPTION_PRICE_FIELDS } = require('../dist/config/accountSubscriptions');
  assert.deepEqual(
    plain(lib.SUBSCRIPTION_PRICE_REQUEST_FIELDS),
    Object.fromEntries(Object.values(SUBSCRIPTION_PRICE_FIELDS).map((field) => [field.setting, field.request]))
  );

  // Each build mode's price is saved under the server's own dollar name and follows the server's .env variable (owner decision D21).
  const { BUILD_MODES, BUILD_MODE_PRICE_FIELDS } = require('../dist/config/buildModes');
  assert.deepEqual(
    plain(lib.MODE_PRICE_REQUEST_FIELDS),
    Object.fromEntries(BUILD_MODES.map((mode) => [BUILD_MODE_PRICE_FIELDS[mode].setting, BUILD_MODE_PRICE_FIELDS[mode].request]))
  );
  assert.deepEqual(Object.keys(lib.MODE_PRICE_REQUEST_FIELDS), BUILD_MODES.map((mode) => BUILD_MODE_PRICE_FIELDS[mode].setting), "the server's mode order");
  for (const mode of BUILD_MODES) {
    const { setting, env } = BUILD_MODE_PRICE_FIELDS[mode];
    assert.deepEqual(lib.APP_SETTING_ENV_VARIABLES[setting], [env], `${setting} follows ${env}`);
    assert.ok(lib.APP_SETTING_KEYS.includes(setting), setting);
  }
  // The builder's starting mode is a setting with a .env default; the retired build target is not one.
  assert.deepEqual(lib.APP_SETTING_ENV_VARIABLES.defaultBuildMode, ['DEFAULT_TAILOR_MODE']);
  for (const retired of ['defaultResumeSelection', 'defaultResumeId', 'defaultTailorMode']) {
    assert.equal(retired in lib.APP_SETTING_ENV_VARIABLES, false, `${retired} is gone from the table`);
    assert.equal(lib.APP_SETTING_KEYS.includes(retired), false, `${retired} is no setting`);
  }
});

test('a source reads "Set here", "From .env (NAME)" or "Default" - the words Providers uses - and only "Set here" resets', () => {
  const lib = sources();
  assert.equal(lib.sourceLabel('admin', ['DEFAULT_MODE']), 'Set here');
  assert.equal(lib.sourceLabel('env', ['DEFAULT_MODE']), 'From .env (DEFAULT_MODE)');
  assert.equal(lib.sourceLabel('default', ['DEFAULT_MODE']), 'Default');
  assert.equal(
    lib.appSettingSourceLabel({ paymentLimits: 'env' }, 'paymentLimits'),
    'From .env (PAYMENT_CARD_MIN_USD, PAYMENT_CARD_MAX_USD, PAYMENT_CRYPTO_MIN_USD, PAYMENT_CRYPTO_MAX_USD)'
  );
  assert.equal(lib.lakeSettingSourceLabel({ dailyCapMilli: 'env' }, 'dailyCapMilli'), 'From .env (JOB_LAKE_DAILY_CAP_USD)');
  // Anything the server did not send reads as the default: nothing is offered to reset.
  for (const junk of [undefined, null, 'ADMIN', 'stored', 3]) assert.equal(lib.readSettingSource(junk), 'default');
  assert.deepEqual(lib.readSettingSources({ defaultMode: 'admin', junk: 'env' }, ['defaultMode', 'defaultTheme']), {
    defaultMode: 'admin',
    defaultTheme: 'default',
  });
  assert.deepEqual([lib.canReset('admin'), lib.canReset('env'), lib.canReset('default'), lib.canReset(undefined)], [true, false, false, false]);

  // The Providers table's words for the same three states.
  const providers = loadFrontend('lib/providerDisplay.ts');
  assert.equal(providers.sourceNote({ type: 'claude-cli', sources: { binaryPath: 'admin' } }, 'binaryPath'), lib.sourceLabel('admin', []));
  assert.equal(
    providers.sourceNote({ type: 'claude-cli', sources: { binaryPath: 'env' } }, 'binaryPath'),
    lib.sourceLabel('env', ['AI_CLI_BIN'])
  );
});

test('what changed is compared as data, and an unchanged form sends nothing', () => {
  const lib = sources();
  assert.equal(lib.sameSettingValue([{ a: 1, b: [2] }], [{ b: [2], a: 1 }]), true);
  assert.equal(lib.sameSettingValue([1, 2], [2, 1]), false);
  assert.equal(lib.sameSettingValue('', null), false);
  const current = { defaultMode: 'preview', defaultTheme: 'dark', extra: 'x' };
  assert.deepEqual(lib.changedSettings({ ...current }, current, ['defaultMode', 'defaultTheme']), {});
  assert.deepEqual(lib.changedSettings({ ...current, defaultTheme: 'light' }, current, ['defaultMode', 'defaultTheme']), {
    defaultTheme: 'light',
  });
  assert.deepEqual(lib.resetBody('defaultTheme'), { defaultTheme: null });
  assert.deepEqual(lib.lakeResetBody('reportRateMilli'), { reportRateUsd: null });
  assert.deepEqual(lib.lakeResetBody('dailyCapMilli'), { dailyCapUsd: null });
  assert.deepEqual(lib.lakeResetBody('duplicateWindowDays'), { duplicateWindowDays: null });
  // A price resets under the field it is saved by; every other app setting under its own.
  assert.deepEqual(lib.appSettingResetBody('premiumPriceMilli'), { premiumPriceUsd: null });
  assert.deepEqual(lib.appSettingResetBody('premiumPlusPriceMilli'), { premiumPlusPriceUsd: null });
  assert.deepEqual(lib.appSettingResetBody('premiumMaxPriceMilli'), { premiumMaxPriceUsd: null });
  assert.deepEqual(lib.appSettingResetBody('defaultTheme'), { defaultTheme: null });
});

/* ===================================================== General, Payments */

test('the admin payload reads whole: every source and every Reset value the server sends', async () => {
  await withEnv(
    {
      DEFAULT_THEME: 'dark',
      PAYMENT_CARD_MIN_USD: '5',
      OUTPUT_PATH_PREFIX: '/{{date}}/{{order_number}}',
      DEFAULT_TAILOR_MODE: 'full',
      RESUME_FULL_PRICE_USD: '0.05',
      RESUME_PARTIAL_PRICE_USD: 'abc',
    },
    async () => {
    const server = await serve('payload');
    try {
      await server.config.updateAppSettings({ defaultMode: 'generate' });
      const sent = JSON.parse(JSON.stringify(await server.config.getAdminAppSettings()));
      await asClient(server, 'boss', async ({ api }) => {
        const read = await api.adminApi.getSettings();
        assert.deepEqual(read.settingSources, sent.settingSources);
        assert.deepEqual(read.settingDefaults, sent.settingDefaults);
        // The builder's mode and the three prices (D21), read as the server sent them.
        assert.equal(read.defaultBuildMode, sent.defaultBuildMode);
        assert.equal(read.defaultBuildMode, 'full');
        assert.equal(read.settingSources.defaultBuildMode, 'env');
        for (const key of ['suitablePriceMilli', 'partialPriceMilli', 'fullPriceMilli']) {
          assert.equal(read[key], sent[key], key);
          assert.equal(read.settingSources[key], sent.settingSources[key], `${key} source`);
          assert.equal(read.settingDefaults[key], sent.settingDefaults[key], `${key} Reset value`);
        }
        assert.equal(read.fullPriceMilli, 50);
        assert.equal(read.settingSources.fullPriceMilli, 'env');
        assert.equal(read.partialPriceMilli, 0, 'junk in .env reads $0');
        assert.deepEqual(sent.unreadableModePrices, ['partial']);
        assert.deepEqual(read.unreadableModePrices, sent.unreadableModePrices, 'the page can name the variable that is junk');
        // Retired fields: not served by the server, so not read by the page.
        for (const retired of ['freeEnabledModelIds', 'defaultResumeSelection', 'defaultResumeId', 'defaultTailorMode']) {
          assert.equal(retired in sent, false, `the server no longer sends ${retired}`);
          assert.equal(retired in read, false, `and the page does not read ${retired}`);
        }
        for (const model of read.aiModels) assert.equal('pricePerResumeMilli' in model, false, `${model.name} carries no price`);
        assert.equal(read.settingSources.defaultMode, 'admin');
        assert.equal(read.settingSources.defaultTheme, 'env');
        assert.equal(read.settingSources.outputPathPrefix, 'env');
        assert.equal(read.outputPathPrefix, '/{{date}}/{{order_number}}');
        assert.equal('outputPathPreview' in read, false, 'the preview is the route\'s to draw');
        assert.equal('outputPathTemplate' in read, false, 'the folder template is gone');
      });
    } finally {
      server.close();
    }
    }
  );
});

test('General and Payments send only what changed: an untouched form leaves .env in charge, and Reset hands one back', async () => {
  await withEnv({ DEFAULT_THEME: 'dark', DEFAULT_MODE: 'generate', PAYMENT_CARD_MAX_USD: '250' }, async () => {
    const server = await serve('changed');
    const lib = sources();
    const limits = loadFrontend('app/admin/payments/limitDraft.ts');
    // The Builder Defaults boxes with a .env default (the page's BUILDER_SETTING_KEYS) and the profile, which is stored whole.
    const BUILDER = [
      'defaultMode',
      'defaultTheme',
      'defaultBuildMode',
      'defaultModelId',
      'defaultResumeDocxEnabled',
      'defaultCoverLetterDocxEnabled',
      'defaultProfileId',
    ];
    try {
      await asClient(server, 'boss', async ({ api }) => {
        let settings = await api.adminApi.getSettings();
        const form = Object.fromEntries(BUILDER.map((key) => [key, settings[key]]));
        assert.deepEqual(lib.changedSettings(form, settings, BUILDER), {}, 'the Builder Defaults form as it loaded');
        assert.deepEqual(
          lib.changedSettings({ outputBaseDir: settings.outputBaseDir, outputPathPrefix: settings.outputPathPrefix }, settings, [
            'outputBaseDir',
            'outputPathPrefix',
          ]),
          {}
        );
        const drafts = settings.paymentLimits.map(limits.toLimitDraft);
        assert.deepEqual(limits.limitChanges(drafts, settings.paymentLimits, settings.paymentLimitSources), [], 'the limits as they loaded');
        // Retyped to the same amounts: no change either.
        const retyped = drafts.map((draft) => ({ ...draft, min: `${draft.min}0`.replace(/^0+(?=\d)/, '') }));
        assert.deepEqual(limits.limitChanges(retyped, settings.paymentLimits, settings.paymentLimitSources), []);
        // Each method names only the variable that set it.
        assert.equal(limits.limitSourceLabel('card', settings.paymentLimitSources), 'From .env (PAYMENT_CARD_MAX_USD)');
        assert.equal(limits.limitSourceLabel('crypto', settings.paymentLimitSources), 'Default');
        assert.equal(
          limits.allLimitsSourceLabel(settings.settingSources.paymentLimits, settings.paymentLimitSources),
          'From .env (PAYMENT_CARD_MAX_USD)'
        );
        // Taking off a row that follows .env sends nothing: it would only come back.
        assert.deepEqual(limits.limitChanges(drafts.slice(1), settings.paymentLimits, settings.paymentLimitSources), []);

        // One box changed: only it is sent, and only it becomes "Set here".
        const body = lib.changedSettings({ ...form, defaultMode: 'preview' }, settings, BUILDER);
        assert.deepEqual(body, { defaultMode: 'preview' });
        settings = await api.adminApi.updateSettings(body);
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'defaultMode'), 'Set here');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'defaultTheme'), 'From .env (DEFAULT_THEME)');

        // The builder's starting mode is such a box: sent alone, "Set here", and Reset hands .env's (here the code's) back.
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'defaultBuildMode'), 'Default');
        const modeBody = lib.changedSettings({ ...form, defaultMode: 'preview', defaultBuildMode: 'full' }, settings, BUILDER);
        assert.deepEqual(modeBody, { defaultBuildMode: 'full' });
        settings = await api.adminApi.updateSettings(modeBody);
        assert.equal(settings.defaultBuildMode, 'full');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'defaultBuildMode'), 'Set here');
        settings = await api.adminApi.updateSettings(lib.resetBody('defaultBuildMode'));
        assert.equal(settings.defaultBuildMode, 'partial');
        assert.equal(settings.settingSources.defaultBuildMode, 'default');

        // A limit changed: that method's row goes alone, as typed, and the server takes it.
        const changed = settings.paymentLimits.map(limits.toLimitDraft);
        changed[0] = { ...changed[0], max: '300' };
        const sent = limits.limitChanges(changed, settings.paymentLimits, settings.paymentLimitSources);
        assert.deepEqual(sent.map((row) => row.target), ['card'], 'crypto is not sent, so it keeps following its default');
        settings = await api.adminApi.updateSettings({ paymentLimits: sent });
        assert.equal(settings.settingSources.paymentLimits, 'admin');
        assert.equal(settings.paymentLimitSources.card.source, 'admin');
        assert.equal(settings.paymentLimitSources.crypto.source, 'default');
        assert.equal(settings.paymentLimits.find((row) => row.target === 'card').maxMilli, 300_000);
        assert.equal(limits.describeLimits(settings.settingDefaults.paymentLimits), 'card $2.5 to $250, crypto $50 to $2,000');
        assert.equal(limits.describeLimitDefault('card', settings.settingDefaults.paymentLimits), '$2.5 to $250');

        // A row set here, taken off the page, saves as that method's Reset; one
        // method's Reset keeps what is typed in the others.
        const typed = settings.paymentLimits.map(limits.toLimitDraft);
        typed[1] = { ...typed[1], min: '60' };
        assert.deepEqual(limits.limitChanges([typed[1]], settings.paymentLimits, settings.paymentLimitSources), [
          limits.toLimitRow(typed[1]),
          { target: 'card', reset: true },
        ]);
        const afterReset = await api.adminApi.updateSettings({ paymentLimits: [{ target: 'card', reset: true }] });
        assert.equal(afterReset.paymentLimitSources.card.source, 'env');
        const kept = limits.replaceLimitDraft(typed, afterReset.paymentLimits, 'card');
        assert.equal(kept[0].max, limits.toLimitDraft(afterReset.paymentLimits[0]).max);
        assert.equal(kept[1].min, '60', 'the crypto box keeps what was typed');
        settings = await api.adminApi.updateSettings({ paymentLimits: sent });

        // Reset to default: .env's again, for that field alone.
        settings = await api.adminApi.updateSettings(lib.resetBody('paymentLimits'));
        assert.equal(settings.settingSources.paymentLimits, 'env');
        assert.equal(settings.paymentLimits.find((row) => row.target === 'card').maxMilli, 250_000);
        settings = await api.adminApi.updateSettings(lib.resetBody('defaultMode'));
        assert.equal(settings.defaultMode, 'generate');
        assert.equal(settings.settingSources.defaultMode, 'env');
        assert.equal(lib.canReset(settings.settingSources.defaultMode), false);
      });
    } finally {
      server.close();
    }
  });
});

test("the output prefix: the server draws the preview, and its refusal names the box the page pins it under", async () => {
  await withEnv({}, async () => {
    const server = await serve('prefix');
    try {
      await asClient(server, 'boss', async ({ api }) => {
        const preview = await api.adminApi.previewOutputPrefix('/{{date}}/{{order_number}}');
        assert.equal(preview.problems.length, 0);
        assert.match(preview.path, /ft_\d{8}_0001/);
        const refused = await api.adminApi.previewOutputPrefix('/{{user_email}}');
        assert.equal(refused.path, null);
        assert.match(refused.problems[0], /must contain \{\{order_number\}\}/);

        const error = await refusalOf(api.adminApi.updateSettings({ outputPathPrefix: '/{{user_email}}' }));
        assert.equal(error.status, 400);
        assert.equal(error.body.field, 'outputPathPrefix', 'what the General page pins under the prefix box');
        assert.equal(error.message, refused.problems.join(' '), 'the same sentences the preview showed');

        const saved = await api.adminApi.updateSettings({ outputPathPrefix: '/{{date}}/{{order_number}}' });
        assert.equal(saved.settingSources.outputPathPrefix, 'admin');
        const reset = await api.adminApi.updateSettings(sources().resetBody('outputPathPrefix'));
        assert.equal(reset.outputPathPrefix, '/{{user_email}}/{{order_number}}');
        assert.equal(reset.settingSources.outputPathPrefix, 'default');
      });
    } finally {
      server.close();
    }
  });
});

test("a subscription's price: saved in dollars as typed, read in thousandths with its source, and Reset under its dollar name", async () => {
  await withEnv({ SUBSCRIPTION_PREMIUM_PRICE_USD: '9.99' }, async () => {
    const server = await serve('prices');
    const lib = sources();
    try {
      await asClient(server, 'boss', async ({ api }) => {
        let settings = await api.adminApi.getSettings();
        assert.equal(settings.premiumPriceMilli, 9_990);
        assert.equal(settings.premiumPlusPriceMilli, null, 'not offered');
        assert.equal(settings.settingDefaults.premiumPriceMilli, 9_990);
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'premiumPriceMilli'), 'From .env (SUBSCRIPTION_PREMIUM_PRICE_USD)');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'premiumMaxPriceMilli'), 'Default');

        // Only what changed is sent: the box typed, and the box emptied - the administrator's "not offered".
        settings = await api.adminApi.updateSettings({ premiumPlusPriceUsd: '19.99', premiumPriceUsd: '' });
        assert.equal(settings.premiumPlusPriceMilli, 19_990);
        assert.equal(settings.premiumPriceMilli, null);
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'premiumPriceMilli'), 'Set here');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'premiumMaxPriceMilli'), 'Default', 'a box not sent stays as it was');
        assert.equal(lib.canReset(settings.settingSources.premiumPriceMilli), true);

        settings = await api.adminApi.updateSettings(lib.appSettingResetBody('premiumPriceMilli'));
        assert.equal(settings.premiumPriceMilli, 9_990, ".env's price again");
        assert.equal(settings.settingSources.premiumPriceMilli, 'env');

        // The served name is never a save's: refused, under the box it names.
        const refused = await refusalOf(api.adminApi.updateSettings(lib.resetBody('premiumPlusPriceMilli')));
        assert.equal(refused.status, 400);
        assert.equal(refused.body.field, 'premiumPlusPriceUsd');
        assert.equal(refused.body.code, 'bad-price-field');
        const typo = await refusalOf(api.adminApi.updateSettings({ premiumMaxPriceUsd: '9,99' }));
        assert.equal(typo.body.field, 'premiumMaxPriceUsd');
        assert.match(typo.message, /^The Premium Max price must be an amount in dollars/);
      });
    } finally {
      server.close();
    }
  });
});

test("Settings -> General's price boxes send only what changed, as typed, and refuse in the server's own words first", async () => {
  await withEnv({ SUBSCRIPTION_PREMIUM_PRICE_USD: '9.99' }, async () => {
    const server = await serve('price-boxes');
    const draft = loadFrontend('app/admin/settings/subscriptionPriceDraft.ts');
    const lib = sources();
    try {
      await asClient(server, 'boss', async ({ api }) => {
        let settings = await api.adminApi.getSettings();
        let drafts = draft.toPriceDrafts(settings);
        assert.deepEqual(drafts, { premiumPriceMilli: '9.99', premiumPlusPriceMilli: '', premiumMaxPriceMilli: '' });
        assert.deepEqual(draft.SUBSCRIPTION_PRICE_KEYS, Object.keys(lib.SUBSCRIPTION_PRICE_REQUEST_FIELDS));

        // Untouched, retyped to the same amount, or a "not offered" box left so: nothing is sent.
        assert.deepEqual(draft.priceChanges(drafts, settings), {});
        assert.deepEqual(
          draft.priceChanges({ ...drafts, premiumPriceMilli: '$9.990', premiumMaxPriceMilli: '0' }, settings),
          {}
        );

        // One changed: only it, as typed, under its dollar name - and .env's Premium stays .env's.
        const body = draft.priceChanges({ ...drafts, premiumPlusPriceMilli: ' 19.99 ' }, settings);
        assert.deepEqual(body, { premiumPlusPriceUsd: '19.99' });
        settings = await api.adminApi.updateSettings(body);
        assert.equal(settings.premiumPlusPriceMilli, 19_990);
        assert.equal(settings.settingSources.premiumPriceMilli, 'env');
        assert.equal(settings.settingSources.premiumPlusPriceMilli, 'admin');
        assert.equal(draft.toPriceDrafts(settings).premiumPlusPriceMilli, '19.99');

        // Emptying .env's price is the administrator's "not offered", which beats it.
        drafts = draft.toPriceDrafts(settings);
        settings = await api.adminApi.updateSettings(draft.priceChanges({ ...drafts, premiumPriceMilli: '' }, settings));
        assert.equal(settings.premiumPriceMilli, null);
        assert.equal(settings.settingSources.premiumPriceMilli, 'admin');
        assert.equal(draft.priceDraftOf(settings.premiumPriceMilli), '');

        // The page's refusal is the server's, word for word, pinned under the same box.
        for (const [key, typed] of [
          ['premiumMaxPriceMilli', '9,99'],
          ['premiumMaxPriceMilli', '10000.001'],
          ['premiumPriceMilli', '1.2345'],
          ['premiumPlusPriceMilli', '-5'],
        ]) {
          const local = draft.priceProblem(key, typed);
          const refused = await refusalOf(
            api.adminApi.updateSettings({ [lib.SUBSCRIPTION_PRICE_REQUEST_FIELDS[key]]: typed })
          );
          assert.equal(local, refused.message, `${key} ${typed}`);
          assert.equal(draft.priceKeyOfField(refused.body.field), key);
          assert.deepEqual(Object.keys(draft.priceProblems({ ...drafts, [key]: typed })), [key]);
        }
        assert.equal(draft.priceProblem('premiumPriceMilli', ''), null);
        assert.equal(draft.priceProblem('premiumPriceMilli', '10000'), null);
        assert.equal(draft.priceKeyOfField('outputPathPrefix'), null);
      });
    } finally {
      server.close();
    }
  });

  // The page saves through the draft - only `priceChanges` - and resets a price under its dollar name.
  const page = fs.readFileSync(path.join(SRC, 'app/admin/settings/page.tsx'), 'utf8');
  assert.match(page, /const changes = priceChanges\(priceDrafts, settings\);/);
  assert.match(page, /adminApi\.updateSettings\(appSettingResetBody\(key\)\)/);
  assert.match(page, /type="text"\s+inputMode="decimal"\s+value=\{priceDrafts\[key\]\}/);
});

test("Settings -> General's price per resume: three boxes sent as typed under the mode's dollar name, refused in the server's own words, and a refusal lands under its box", async () => {
  await withEnv({ RESUME_PARTIAL_PRICE_USD: '0.023' }, async () => {
    const server = await serve('mode-price-boxes');
    const draft = loadFrontend('app/admin/settings/modePriceDraft.ts');
    const lib = sources();
    const { BUILD_MODES, BUILD_MODE_LABELS, BUILD_MODE_PRICE_FIELDS, MAX_BUILD_MODE_PRICE_MILLI } = require('../dist/config/buildModes');
    try {
      // The draft's tables are the server's, in the server's mode order.
      const settingsInOrder = BUILD_MODES.map((mode) => BUILD_MODE_PRICE_FIELDS[mode].setting);
      assert.deepEqual([...draft.MODE_PRICE_KEYS], settingsInOrder);
      assert.deepEqual([...draft.MODE_PRICE_KEYS], Object.keys(lib.MODE_PRICE_REQUEST_FIELDS));
      for (const mode of BUILD_MODES) {
        assert.equal(draft.MODE_PRICE_LABELS[BUILD_MODE_PRICE_FIELDS[mode].setting], BUILD_MODE_LABELS[mode]);
        assert.equal(draft.modeOfPriceKey(BUILD_MODE_PRICE_FIELDS[mode].setting), mode);
        assert.equal(draft.modePriceKeyOfField(BUILD_MODE_PRICE_FIELDS[mode].request), BUILD_MODE_PRICE_FIELDS[mode].setting);
      }
      assert.equal(draft.MAX_MODE_PRICE_MILLI, MAX_BUILD_MODE_PRICE_MILLI);
      assert.equal(draft.modePriceKeyOfField('partialPriceMilli'), null, 'the served name is not a field a save is refused under');
      assert.equal(draft.modePriceKeyOfField('outputPathPrefix'), null);

      await asClient(server, 'boss', async ({ api }) => {
        // The ceiling api.ts clamps every price it reads to is the server's too, not only the draft's copy.
        assert.equal(api.MAX_MODE_PRICE_MILLI, MAX_BUILD_MODE_PRICE_MILLI);
        let settings = await api.adminApi.getSettings();
        assert.equal(settings.partialPriceMilli, 23);
        assert.equal(settings.suitablePriceMilli, 0, 'a mode nobody priced is free, on purpose');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'partialPriceMilli'), 'From .env (RESUME_PARTIAL_PRICE_USD)');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'fullPriceMilli'), 'Default');
        let drafts = draft.toModePriceDrafts(settings);
        assert.deepEqual(
          Object.fromEntries(draft.MODE_PRICE_KEYS.map((key) => [key, draft.modePriceDraftOf(settings[key])])),
          drafts
        );
        assert.equal(drafts.partialPriceMilli, '0.023');

        // Untouched, retyped to the same amount, or a free mode left free: nothing is sent.
        assert.deepEqual(draft.modePriceChanges(drafts, settings), {});
        assert.deepEqual(draft.modePriceChanges({ ...drafts, partialPriceMilli: '$0.023', suitablePriceMilli: '0' }, settings), {});
        assert.deepEqual(draft.modePriceProblems(drafts), {});

        // One changed: only it, as typed, under its dollar name - and .env's Partial stays .env's.
        const body = draft.modePriceChanges({ ...drafts, fullPriceMilli: ' 0.05 ' }, settings);
        assert.deepEqual(body, { fullPriceUsd: '0.05' });
        settings = await api.adminApi.updateSettings(body);
        assert.equal(settings.fullPriceMilli, 50);
        assert.equal(settings.settingSources.partialPriceMilli, 'env');
        assert.equal(settings.settingSources.fullPriceMilli, 'admin');
        assert.equal(draft.toModePriceDrafts(settings).fullPriceMilli, draft.modePriceDraftOf(50));
        assert.equal(lib.canReset(settings.settingSources.fullPriceMilli), true);

        // $0 is a price: it beats .env's, and it is the mode being free.
        drafts = draft.toModePriceDrafts(settings);
        settings = await api.adminApi.updateSettings(draft.modePriceChanges({ ...drafts, partialPriceMilli: '0' }, settings));
        assert.equal(settings.partialPriceMilli, 0);
        assert.equal(settings.settingSources.partialPriceMilli, 'admin');
        assert.equal(settings.settingDefaults.partialPriceMilli, 23, 'what Reset gives');

        // The page's refusal is the server's, word for word, and a refusal's field names the box it lands under.
        drafts = draft.toModePriceDrafts(settings);
        for (const [key, typed] of [
          ['partialPriceMilli', '9,99'],
          ['fullPriceMilli', '1000.001'],
          ['suitablePriceMilli', '1.2345'],
          ['partialPriceMilli', '-5'],
          ['fullPriceMilli', ''],
          ['suitablePriceMilli', '   '],
        ]) {
          const local = draft.modePriceProblem(key, typed);
          const refused = await refusalOf(api.adminApi.updateSettings({ [lib.MODE_PRICE_REQUEST_FIELDS[key]]: typed }));
          assert.equal(refused.status, 400, `${key} ${JSON.stringify(typed)}`);
          assert.equal(refused.body.code, 'bad-price');
          assert.equal(local, refused.message, `${key} ${JSON.stringify(typed)}`);
          assert.equal(draft.modePriceKeyOfField(refused.body.field), key, 'the box the page pins it under');
          assert.deepEqual(Object.keys(draft.modePriceProblems({ ...drafts, [key]: typed })), [key]);
          // And a box the server would refuse is a change the page judges first.
          assert.deepEqual(Object.keys(draft.modePriceChanges({ ...drafts, [key]: typed }, settings)), [lib.MODE_PRICE_REQUEST_FIELDS[key]]);
        }
        assert.match(draft.modePriceProblem('partialPriceMilli', ''), /^The Partial Tailor price is required/);
        assert.equal(draft.modePriceProblem('fullPriceMilli', '1000'), null);
        assert.equal(draft.modePriceProblem('fullPriceMilli', '0'), null);
        assert.equal(draft.modePriceProblem('fullPriceMilli', '0.001'), null);
        const ceiling = await api.adminApi.updateSettings({ fullPriceUsd: '1000' });
        assert.equal(ceiling.fullPriceMilli, 1_000_000);

        // The served name is never a save's: refused, under the box it names.
        const served = await refusalOf(api.adminApi.updateSettings(lib.resetBody('partialPriceMilli')));
        assert.equal(served.status, 400);
        assert.equal(served.body.code, 'bad-price-field');
        assert.equal(draft.modePriceKeyOfField(served.body.field), 'partialPriceMilli');

        // Reset sends null under the dollar name: .env's price again, and the code's for a mode with none.
        settings = await api.adminApi.updateSettings(lib.appSettingResetBody('partialPriceMilli'));
        assert.equal(settings.partialPriceMilli, 23);
        assert.equal(settings.settingSources.partialPriceMilli, 'env');
        settings = await api.adminApi.updateSettings(lib.appSettingResetBody('fullPriceMilli'));
        assert.equal(settings.fullPriceMilli, 0);
        assert.equal(settings.settingSources.fullPriceMilli, 'default');
        assert.deepEqual(lib.appSettingResetBody('suitablePriceMilli'), { suitablePriceUsd: null });
        assert.deepEqual(lib.appSettingResetBody('partialPriceMilli'), { partialPriceUsd: null });
        assert.deepEqual(lib.appSettingResetBody('fullPriceMilli'), { fullPriceUsd: null });
      });
    } finally {
      server.close();
    }
  });

  // The page saves through the draft - only `modePriceChanges` - after judging the boxes, pins a refusal under its box, and draws text boxes.
  const page = fs.readFileSync(path.join(SRC, 'app/admin/settings/page.tsx'), 'utf8');
  assert.match(page, /const problems = modePriceProblems\(modeDrafts\);/);
  assert.match(page, /const changes = modePriceChanges\(modeDrafts, settings\);/);
  assert.match(page, /modePriceKeyOfField\(err\.body\?\.field\)/);
  assert.match(page, /adminApi\.updateSettings\(appSettingResetBody\(key\)\)/);
  assert.match(page, /type="text"\s+inputMode="decimal"\s+autoComplete="off"\s+value=\{modeDrafts\[key\]\}/);
  assert.match(page, /Save Prices/);
});

test("Contact's Reset sends { channels: null }: .env's channels again, where a saved empty list is none", async () => {
  await withEnv({ CONTACT_CHANNELS: 'email:help@example.org|Support' }, async () => {
    const server = await serve('contact');
    try {
      await asClient(server, 'boss', async ({ contact }) => {
        let payload = await contact.adminContactApi.save([]);
        assert.deepEqual(payload.settingSources, { channels: 'admin' });
        assert.deepEqual(payload.channels, []);
        payload = await contact.adminContactApi.reset();
        assert.deepEqual(payload.settingSources, { channels: 'env' });
        assert.equal(payload.channels[0].value, 'help@example.org');
        assert.deepEqual(payload.channels, payload.settingDefaults.channels);
      });
    } finally {
      server.close();
    }
  });
});

/* ================================================================ lake */

test("the lake's boxes hold only what is set here; .env's values show as their source and Reset brings them back", async () => {
  await withEnv({ JOB_LAKE_REPORT_RATE_USD: '0.05', JOB_LAKE_DAILY_CAP_USD: '3' }, async () => {
    useTempStorage('frontend-settings-lake');
    loadFresh('../dist/database/sqlite');
    loadFresh('../dist/database/settingsRepository');
    const settings = loadFresh('../dist/services/jobLake/settings');
    const display = loadFrontend('lib/jobLakeDisplay.ts');
    const lib = sources();

    let current = settings.readLakeSettings();
    assert.deepEqual(display.lakeSettingsDraft(current), { rate: '', window: '', cap: '' }, '.env is not set here');
    assert.deepEqual(display.lakeSettingsChanges(display.lakeSettingsDraft(current), current), {});
    assert.equal(display.rateSource(current), 'env');
    assert.equal(display.capSource(current), 'env');
    assert.equal(display.ratePlaceholder(current), '0.05 (from .env)');
    assert.equal(display.capPlaceholder(current), '3.00 (from .env)');
    assert.match(display.describeGlobalRate(current), /^\$0\.05 per job the lake accepts, from JOB_LAKE_REPORT_RATE_USD in \.env/);
    assert.match(display.describeDailyCap(current.dailyCapMilli, display.capSource(current)), /From JOB_LAKE_DAILY_CAP_USD in \.env/);
    assert.equal(lib.lakeSettingSourceLabel(current.settingSources, 'reportRateMilli'), 'From .env (JOB_LAKE_REPORT_RATE_USD)');

    const saved = settings.updateLakeSettings(display.lakeSettingsChanges({ rate: '0.02', window: '', cap: '1' }, current), 'admin-1');
    assert.ok(saved.ok, JSON.stringify(saved));
    current = saved.settings;
    assert.deepEqual(display.lakeSettingsDraft(current), { rate: '0.02', window: '', cap: '1.00' });
    assert.deepEqual(display.lakeSettingsChanges(display.lakeSettingsDraft(current), current), {});
    assert.match(display.describeGlobalRate(current), /^\$0\.02 per job the lake accepts, for every reporter/);

    for (const key of lib.LAKE_SETTING_KEYS) {
      const answer = settings.updateLakeSettings(lib.lakeResetBody(key), 'admin-1');
      assert.ok(answer.ok, `${key}: ${JSON.stringify(answer)}`);
      assert.notEqual(answer.settings.settingSources[key], 'admin', key);
    }
    current = settings.readLakeSettings();
    assert.equal(current.reportRateMilli, 50);
    assert.equal(current.dailyCapMilli, 3_000);
  });

  await withEnv({}, async () => {
    useTempStorage('frontend-settings-lake-none');
    loadFresh('../dist/database/sqlite');
    loadFresh('../dist/database/settingsRepository');
    const settings = loadFresh('../dist/services/jobLake/settings');
    const display = loadFrontend('lib/jobLakeDisplay.ts');
    const current = settings.readLakeSettings();
    assert.match(display.describeGlobalRate(current), /^Not set: every job is accepted and nobody is paid/);
    assert.equal(display.ratePlaceholder(current), '0.000');
    assert.equal(display.capPlaceholder(current), 'No cap');
  });
});

/* =============================================================== Models */

test("the Models dialog's field names are the server's, and every refusal lands under the box the server names", async () => {
  const form = loadFrontend('app/admin/models/modelForm.ts');
  const { AI_MODEL_FIELDS } = require('../dist/config/aiModelConfig');
  assert.deepEqual([...form.MODEL_FIELDS], [...AI_MODEL_FIELDS]);

  await withEnv({}, async () => {
    const server = await serve('models');
    try {
      await asClient(server, 'boss', async ({ api }) => {
        const settings = await api.adminApi.getSettings();
        const blank = form.blankModelDraft(settings);
        const cases = [
          // [draft, the box, whether the form says it first]
          [{ ...blank, name: '' }, 'name', true],
          [{ ...blank, name: 'claude SONNET ' }, 'name', true],
          [{ ...blank, name: 'Fresh', modelName: '' }, 'modelName', true],
          // What only the server can see: a name the seat does not list, a pair another record holds.
          [{ ...blank, name: 'Fresh', provider: 'claude-cli', modelName: 'no-such-model' }, 'modelName', false],
          [{ ...blank, name: 'Fresh', provider: 'claude-cli', modelName: 'sonnet' }, 'modelName', false],
        ];
        for (const [draft, field, local] of cases) {
          const error = await refusalOf(api.adminApi.createModel(form.createModelBody(draft)));
          assert.equal(error.status, 400, JSON.stringify(draft));
          assert.equal(form.modelRefusalField(error.body), field, error.message);
          const problems = form.modelDraftProblems(draft, settings, null);
          if (local) assert.equal(problems[field], error.message, `the form says it in the server's words: ${field}`);
          else assert.deepEqual(problems, {}, error.message);
        }
        assert.equal(form.modelRefusalField({ error: 'AI model not found.' }), null);
        assert.equal(form.modelRefusalField({ field: 'homeDir' }), null, 'a box the dialog does not have');

        // Created as typed; an edit sends only what changed, and an untouched one nothing.
        const created = await api.adminApi.createModel(
          form.createModelBody({ ...blank, name: 'Fresh', provider: 'claude-cli', modelName: 'fable' })
        );
        const fresh = created.aiModels.find((model) => model.name === 'Fresh');
        assert.equal('pricePerResumeMilli' in fresh, false, 'a model carries no price: a resume costs its build mode\'s');
        assert.deepEqual(Object.keys(form.createModelBody(blank)).sort(), [...AI_MODEL_FIELDS].sort(), 'the body names exactly the boxes');
        const untouched = form.draftFromModel(fresh);
        assert.deepEqual(form.editModelBody(fresh, untouched), {});
        assert.deepEqual(form.editModelBody(fresh, { ...untouched, modelName: 'FABLE' }), {}, 'a model name in another case');
        const body = form.editModelBody(fresh, { ...untouched, name: 'Fresher', description: 'Written here' });
        assert.deepEqual(body, { name: 'Fresher', description: 'Written here' });
        const edited = await api.adminApi.updateModel(fresh.id, body);
        const fresher = edited.aiModels.find((model) => model.id === fresh.id);
        assert.equal(fresher.name, 'Fresher');
        assert.equal(fresher.description, 'Written here');
        assert.equal('pricePerResumeMilli' in fresher, false);
        assert.deepEqual(form.editModelBody(fresher, form.draftFromModel(fresher)), {}, 'nothing retyped, nothing sent');
        // Keeping its own name is no clash, in any case.
        assert.deepEqual(form.modelDraftProblems({ ...form.draftFromModel(edited.aiModels.find((m) => m.id === fresh.id)), name: 'FRESHER' }, edited, fresh.id), {});
      });
    } finally {
      server.close();
    }
  });

  // The page draws no price: not a column, not a box, not a notice about a free model - one sentence says where it is set now.
  const dir = path.join(SRC, 'app', 'admin', 'models');
  assert.equal(fs.existsSync(path.join(dir, 'modelPrice.ts')), false, 'the price helper is gone');
  const drawn = ['page.tsx', 'ModelDialog.tsx', 'modelForm.ts', 'modelDraft.ts']
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(drawn, /pricePerResume|model-price-per-resume|freeEnabledModelIds|formatPricePerResume/);
  assert.match(
    fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8'),
    /What a resume costs is set per builder mode under Settings > General > Price per resume\./
  );
});

test('Set default and Use for analysis are one settings field each; "Use the default model" is the empty choice', async () => {
  await withEnv({ ANALYSIS_MODEL: 'Claude Haiku' }, async () => {
    const server = await serve('choices');
    const lib = sources();
    try {
      await asClient(server, 'boss', async ({ api }) => {
        let settings = await api.adminApi.getSettings();
        assert.equal(settings.analysisModelId, 'claude-cli-haiku');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'analysisModelId'), 'From .env (ANALYSIS_MODEL)');

        settings = await api.adminApi.updateSettings({ analysisModelId: 'claude-cli-opus' });
        assert.equal(settings.analysisModelId, 'claude-cli-opus');
        assert.equal(settings.settingSources.analysisModelId, 'admin');
        settings = await api.adminApi.updateSettings({ analysisModelId: '' });
        assert.equal(settings.analysisModelId, '', 'the default model, chosen here');
        assert.equal(settings.settingSources.analysisModelId, 'admin', 'and it beats ANALYSIS_MODEL');
        assert.equal(settings.settingDefaults.analysisModelId, 'claude-cli-haiku', 'what Reset gives');
        settings = await api.adminApi.updateSettings(lib.resetBody('analysisModelId'));
        assert.equal(settings.analysisModelId, 'claude-cli-haiku');

        settings = await api.adminApi.updateSettings({ defaultModelId: 'claude-cli-opus' });
        assert.equal(settings.defaultModelId, 'claude-cli-opus');
        assert.equal(settings.settingSources.defaultModelId, 'admin');
        settings = await api.adminApi.updateSettings(lib.resetBody('defaultModelId'));
        assert.equal(settings.defaultModelId, settings.settingDefaults.defaultModelId);
        assert.notEqual(settings.settingSources.defaultModelId, 'admin');
      });
    } finally {
      server.close();
    }
  });
});

/* ======================================================== Resume files */

test("the token chips are the server's tokens, in its order, and insert at the caret", () => {
  const lib = loadFrontend('lib/outputPath.ts');
  const { OUTPUT_PREFIX_TOKENS, OUTPUT_SUFFIX_TOKENS, validateOutputSuffix } = require('../dist/utils/outputStorage');
  assert.deepEqual(lib.OUTPUT_PREFIX_TOKEN_CHIPS.map((chip) => chip.token), [...OUTPUT_PREFIX_TOKENS]);
  assert.deepEqual(lib.OUTPUT_SUFFIX_TOKEN_CHIPS.map((chip) => chip.token), [...OUTPUT_SUFFIX_TOKENS]);
  // Each chip inserts its token as the server spells it: alone, it is a folder path the server takes.
  for (const chip of lib.OUTPUT_SUFFIX_TOKEN_CHIPS) {
    assert.deepEqual(validateOutputSuffix(chip.text), { ok: true, value: `/${chip.text}` }, chip.text);
  }

  assert.deepEqual(lib.insertToken('/{{date}}/', 10, 10, '{{role}}'), { text: '/{{date}}/{{role}}', caret: 18 });
  assert.deepEqual(lib.insertToken('/{{date}}/', 1, 1, '{{role}}'), { text: '/{{role}}{{date}}/', caret: 9 });
  assert.deepEqual(lib.insertToken('/abc/def', 1, 4, '{{date}}'), { text: '/{{date}}/def', caret: 9 });
  // No caret known: at the end. Out of range: clamped.
  assert.deepEqual(lib.insertToken('/a', null, null, '{{role}}'), { text: '/a{{role}}', caret: 10 });
  assert.deepEqual(lib.insertToken('/a', 99, -5, '{{role}}'), { text: '/a{{role}}', caret: 10 });

  const gate = lib.createLatestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isLatest(first), false, 'a slow answer for an older text is dropped');
  assert.equal(gate.isLatest(second), true);

  assert.equal(lib.suffixSourceLabel('account'), 'Your own');
  for (const other of ['env', 'default', undefined]) assert.equal(lib.suffixSourceLabel(other), 'Default', 'never which .env line');
  assert.equal(lib.suffixSaveValue('   '), null);
  assert.equal(lib.suffixSaveValue('/{{date}}'), '/{{date}}');
});

test("Resume files: the client's preview, save and Reset are the account routes', and a reporter is refused", async () => {
  await withEnv({ OUTPUT_PATH_SUFFIX: '/{{company_name}}/{{role}}' }, async () => {
    const server = await serve('suffix');
    const lib = loadFrontend('lib/outputPath.ts');
    try {
      await asClient(server, 'jane', async ({ auth }) => {
        let { account } = await auth.authApi.account();
        assert.equal(account.outputPathSuffix, null);
        assert.equal(account.outputPathSuffixSource, 'env');
        assert.equal(account.effectiveOutputPathSuffix, '/{{company_name}}/{{role}}');
        assert.equal(lib.suffixSourceLabel(account.outputPathSuffixSource), 'Default');

        // An empty box is the default, as its save would be.
        const empty = await auth.authApi.previewOutputPath(lib.suffixSaveValue(''));
        const inEffect = await auth.authApi.previewOutputPath();
        assert.equal(empty.path, inEffect.path);
        assert.match(empty.path, /^\/jane_doe_example_com\/ft_\d{8}_0001\/acme\/software_engineer$/);

        const refused = await auth.authApi.previewOutputPath('/{{order_number}}');
        assert.equal(refused.path, null);
        const error = await refusalOf(auth.authApi.saveOutputPathSuffix('/{{order_number}}'));
        assert.equal(error.status, 400);
        assert.equal(error.body.field, 'outputPathSuffix', 'what Resume files pins under its box');
        assert.equal(error.message, refused.problems.join(' '));

        ({ account } = await auth.authApi.saveOutputPathSuffix(lib.suffixSaveValue('{{date}}{{profile_name}}/{{company_name}}')));
        assert.equal(account.outputPathSuffix, '/{{date}}{{profile_name}}/{{company_name}}');
        assert.equal(lib.suffixSourceLabel(account.outputPathSuffixSource), 'Your own');
        ({ account } = await auth.authApi.saveOutputPathSuffix(null));
        assert.equal(account.outputPathSuffix, null);
        assert.equal(account.effectiveOutputPathSuffix, '/{{company_name}}/{{role}}');
      });

      await asClient(server, 'reporter', async ({ auth }) => {
        const { account } = await auth.authApi.account();
        assert.equal('effectiveOutputPathSuffix' in account, false, "a reporter's account says nothing of it");
        const error = await refusalOf(auth.authApi.previewOutputPath());
        assert.equal(error.status, 403);
        assert.equal(error.body.code, 'role-not-allowed');
      });
    } finally {
      server.close();
    }
  });

  // The page draws the section for a builder only.
  const page = fs.readFileSync(path.join(SRC, 'app/settings/page.tsx'), 'utf8');
  assert.match(page, /\{canBuildResumes\(account\.role\) && <ResumeFilesSection \/>\}/);
});

test('Resume files: an account made a reporter mid-session goes to the session, never to a Try again that cannot succeed', async () => {
  /*
   * The page draws the section by the SESSION's role. An administrator who
   * makes a user a reporter keeps their session, and nothing on Settings ->
   * Account is refused - which is what re-reads the session elsewhere - so
   * the section's own read is where the page learns of it.
   */
  await withEnv({}, async () => {
    const server = await serve('demoted');
    const roles = loadFrontend('lib/roles.ts');
    try {
      await asClient(server, 'jane', async ({ auth }) => {
        let { account } = await auth.authApi.account();
        assert.equal(roles.canBuildResumes(account.role), true);
        assert.equal(typeof account.effectiveOutputPathSuffix, 'string', "a builder's answer has the folder path in effect");

        server.users.updateUser(server.ids.jane, { role: 'reporter' });
        ({ account } = await auth.authApi.account());
        assert.equal(account.role, 'reporter', 'answered with the new role, not refused');
        assert.equal('effectiveOutputPathSuffix' in account, false);
        assert.equal(roles.canBuildResumes(account.role), false, 'the branch that hands the answer to the session');
      });
    } finally {
      server.close();
    }
  });

  const section = fs.readFileSync(path.join(SRC, 'components/settings/ResumeFilesSection.tsx'), 'utf8');
  assert.match(section, /const \{[^}]*\badopt\b[^}]*\} = useAuth\(\);/, "the session's adopt");
  assert.match(
    section,
    /if \(!canBuildResumes\(account\.role\)\) \{\s*adopt\(account\);\s*return;\s*\}\s*const next = readOutputPath\(account\);/,
    "a non-builder's answer goes to the session before a folder path is read from it"
  );
  // A builder's answer without one still fails the read - in a sentence that
  // asks for the administrator, so the notice ends in its Contact admin link.
  const loadFailed = /const LOAD_FAILED =\s*'([^']+)'/.exec(section)?.[1];
  assert.equal(loadFrontend('lib/contactChannels.ts').asksForAdministrator(loadFailed), true, String(loadFailed));
});

test("Settings -> General's builder defaults and price boxes are wired the way the draft helpers assume (pinned in the page's source)", () => {
  const page = fs.readFileSync(path.join(SRC, 'app/admin/settings/page.tsx'), 'utf8');

  // What the Builder Defaults save sends is read from the page, not copied here: the boxes with a .env default,
  // then the profile, which is stored whole. Dropping either from the list freezes it unsaved.
  const listed = /const BUILDER_SETTING_KEYS = \[([^\]]*)\]/.exec(page)?.[1];
  assert.ok(listed, 'the page names its Builder Defaults keys');
  assert.deepEqual(
    [...listed.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]),
    ['defaultMode', 'defaultTheme', 'defaultBuildMode', 'defaultModelId', 'defaultResumeDocxEnabled', 'defaultCoverLetterDocxEnabled']
  );
  assert.match(page, /changedSettings\(form, settings, \[\.\.\.BUILDER_SETTING_KEYS, 'defaultProfileId'\]\)/);

  // The two Builder Defaults controls the end-to-end scripts find by id.
  assert.match(page, /id="default-profile"/);
  assert.match(page, /id="default-build-mode"/);
  assert.match(page, /You have no profiles yet\. Add one under Profiles before choosing a default\./);

  // Each price box: red while free, red when .env's line is junk, and its source with Reset to default.
  assert.match(page, /settings\[key\] === 0 && <Status tone="error">Free: nobody is charged for \{label\}\.<\/Status>/);
  assert.match(page, /settings\.unreadableModePrices\.includes\(modeOfPriceKey\(key\)\)/);
  assert.match(page, /sourceOf\(key, `\$\{label\} price`, formatMoney\(defaults\[key\]\)\)/);
});

test("the ordinary account's settings (GET /resume/models) are read whole: the three prices, the starting mode and the starting profile", async () => {
  await withEnv(
    { RESUME_SUITABLE_PRICE_USD: '0.005', RESUME_PARTIAL_PRICE_USD: '0.023', RESUME_FULL_PRICE_USD: '0.1', DEFAULT_TAILOR_MODE: 'full' },
    async () => {
      const server = await serve('user-settings');
      try {
        // What the route answers (getUserAppSettings, sent as JSON), then what a damaged answer reads as.
        const served = JSON.parse(JSON.stringify(await server.config.getUserAppSettings('')));
        await asClient(server, 'jane', async ({ api }) => {
          const real = globalThis.fetch;
          const answering = (body) => async () => ({ ok: true, status: 200, json: async () => body });
          try {
            globalThis.fetch = answering(served);
            const settings = await api.resumeApi.getModels();
            assert.equal(settings.suitablePriceMilli, 5);
            assert.equal(settings.partialPriceMilli, 23);
            assert.equal(settings.fullPriceMilli, 100);
            assert.equal(settings.defaultBuildMode, 'full');
            assert.equal(settings.defaultProfileId, served.defaultProfileId);

            // Junk reads as free and Partial, never as a price or a mode the server did not give.
            globalThis.fetch = answering({
              ...served,
              suitablePriceMilli: 'x',
              partialPriceMilli: -4,
              fullPriceMilli: 1.5,
              defaultBuildMode: 'everything',
            });
            const damaged = await api.resumeApi.getModels();
            assert.equal(damaged.suitablePriceMilli, 0);
            assert.equal(damaged.partialPriceMilli, 0);
            assert.equal(damaged.fullPriceMilli, 0);
            assert.equal(damaged.defaultBuildMode, 'partial');
          } finally {
            globalThis.fetch = real;
          }
        });
      } finally {
        server.close();
      }
    }
  );
});

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
  'DEFAULT_RESUME_SELECTION',
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

/** The routes the pages call, on a port of their own, with an administrator, a user and a reporter signed in. */
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
  return { ...dirs, config, base, tokens, close: () => server.close() };
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
});

/* ===================================================== General, Payments */

test('the admin payload reads whole: every source and every Reset value the server sends', async () => {
  await withEnv({ DEFAULT_THEME: 'dark', PAYMENT_CARD_MIN_USD: '5', OUTPUT_PATH_PREFIX: '/{{date}}/{{order_number}}' }, async () => {
    const server = await serve('payload');
    try {
      await server.config.updateAppSettings({ defaultMode: 'generate' });
      const sent = JSON.parse(JSON.stringify(await server.config.getAdminAppSettings()));
      await asClient(server, 'boss', async ({ api }) => {
        const read = await api.adminApi.getSettings();
        assert.deepEqual(read.settingSources, sent.settingSources);
        assert.deepEqual(read.settingDefaults, sent.settingDefaults);
        assert.equal(read.settingSources.defaultMode, 'admin');
        assert.equal(read.settingSources.defaultTheme, 'env');
        assert.equal(read.settingSources.outputPathPrefix, 'env');
        assert.equal(read.outputPathPrefix, '/{{date}}/{{order_number}}');
        assert.equal(read.outputPathPreview, sent.outputPathPreview);
        assert.equal('outputPathTemplate' in read, false, 'the folder template is gone');
      });
    } finally {
      server.close();
    }
  });
});

test('General and Payments send only what changed: an untouched form leaves .env in charge, and Reset hands one back', async () => {
  await withEnv({ DEFAULT_THEME: 'dark', DEFAULT_MODE: 'generate', PAYMENT_CARD_MAX_USD: '250' }, async () => {
    const server = await serve('changed');
    const lib = sources();
    const limits = loadFrontend('app/admin/payments/limitDraft.ts');
    const BUILDER = ['defaultMode', 'defaultTheme', 'defaultResumeSelection', 'defaultModelId', 'defaultResumeDocxEnabled', 'defaultCoverLetterDocxEnabled'];
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
        assert.equal(limits.limitsChanged(drafts, settings.paymentLimits), false, 'the limits as they loaded');
        // Retyped to the same amounts: no change either.
        const retyped = drafts.map((draft) => ({ ...draft, min: `${draft.min}0`.replace(/^0+(?=\d)/, '') }));
        assert.equal(limits.limitsChanged(retyped, settings.paymentLimits), false);

        // One box changed: only it is sent, and only it becomes "Set here".
        const body = lib.changedSettings({ ...form, defaultMode: 'preview' }, settings, BUILDER);
        assert.deepEqual(body, { defaultMode: 'preview' });
        settings = await api.adminApi.updateSettings(body);
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'defaultMode'), 'Set here');
        assert.equal(lib.appSettingSourceLabel(settings.settingSources, 'defaultTheme'), 'From .env (DEFAULT_THEME)');

        // A limit changed: the rows go, as typed, and the server takes them.
        const changed = settings.paymentLimits.map(limits.toLimitDraft);
        changed[0] = { ...changed[0], max: '300' };
        assert.equal(limits.limitsChanged(changed, settings.paymentLimits), true);
        settings = await api.adminApi.updateSettings({ paymentLimits: changed.map(limits.toLimitRow) });
        assert.equal(settings.settingSources.paymentLimits, 'admin');
        assert.equal(settings.paymentLimits.find((row) => row.target === 'card').maxMilli, 300_000);
        assert.equal(limits.describeLimits(settings.settingDefaults.paymentLimits), 'card $2.5 to $250, crypto $50 to $2,000');

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
          [{ ...blank, name: '', price: '0.01' }, 'name', true],
          [{ ...blank, name: 'claude SONNET ', price: '0.01' }, 'name', true],
          [{ ...blank, name: 'Fresh', modelName: '', price: '0.01' }, 'modelName', true],
          [{ ...blank, name: 'Fresh', price: '' }, 'pricePerResumeUsd', true],
          [{ ...blank, name: 'Fresh', price: '0.0005' }, 'pricePerResumeUsd', true],
          [{ ...blank, name: 'Fresh', price: '1001' }, 'pricePerResumeUsd', true],
          // What only the server can see: a name the seat does not list, a pair another record holds.
          [{ ...blank, name: 'Fresh', provider: 'claude-cli', modelName: 'no-such-model', price: '0.01' }, 'modelName', false],
          [{ ...blank, name: 'Fresh', provider: 'claude-cli', modelName: 'sonnet', price: '0.01' }, 'modelName', false],
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
          form.createModelBody({ ...blank, name: 'Fresh', provider: 'claude-cli', modelName: 'fable', price: '0.023' })
        );
        const fresh = created.aiModels.find((model) => model.name === 'Fresh');
        assert.equal(fresh.pricePerResumeMilli, 23);
        const untouched = form.draftFromModel(fresh);
        assert.deepEqual(form.editModelBody(fresh, untouched), {});
        assert.deepEqual(form.editModelBody(fresh, { ...untouched, modelName: 'FABLE' }), {}, 'a model name in another case');
        const body = form.editModelBody(fresh, { ...untouched, name: 'Fresher', price: '0.05' });
        assert.deepEqual(body, { name: 'Fresher', pricePerResumeUsd: '0.05' });
        const edited = await api.adminApi.updateModel(fresh.id, body);
        const fresher = edited.aiModels.find((model) => model.id === fresh.id);
        assert.equal(fresher.pricePerResumeMilli, 50);
        assert.deepEqual(form.editModelBody(fresher, { ...form.draftFromModel(fresher), price: '0.050' }), {}, 'the same amount retyped');
        // Keeping its own name is no clash, in any case.
        assert.deepEqual(form.modelDraftProblems({ ...form.draftFromModel(edited.aiModels.find((m) => m.id === fresh.id)), name: 'FRESHER' }, edited, fresh.id), {});
      });
    } finally {
      server.close();
    }
  });
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

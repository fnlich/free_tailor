const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/** Every seat is unlocked here, whatever the machine running this says. Set before any dist module loads. */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { loadFresh, useAdminEmails, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * What an ordinary account may know about models, and how its choices resolve.
 *
 *   - `GET /api/resume/models` is ids and display names, the builder defaults,
 *     and nothing else: no provider, CLI model name, price, lock or the
 *     administrator's sheets.
 *   - A profile's STORED choice that cannot run falls back to the app default
 *     with one log line; a choice named in the REQUEST is refused with one
 *     generic 400 - the cause is the `detail`, which only an administrator gets.
 *   - The bare-provider and `provider:modelName` request forms are an
 *     administrator's.
 *   - A profile save checks a CHANGED choice against the list its owner picks
 *     from, and stores a retired one as inheriting.
 *   - The job filter and the Bid Assistant run on the app default model, and the
 *     filter names it by its display name.
 *
 * Modules are required once rather than loaded fresh: the model settings are
 * cached per database path in the module, and a route holding one copy while
 * the test writes through another would read a stale cache.
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
const preferences = require('../dist/config/aiPreferences');

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

async function serve(name) {
  useTempStorage(`user-model-access-${name}`);
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();

  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
  };

  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  saveProfile({ ...buildNewProfile(profileInput('Ada'), 'p-alice'), ownerId: alice.id });

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/resume', require('../dist/routes/resume').default);
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  const server = app.listen(0);
  const port = server.address().port;

  const call = async (who, method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, text };
  };
  return { call, close: () => server.close(), admin, alice, bob };
}

function captureWarnings() {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return { warnings, restore: () => (console.warn = warn) };
}

/* ------------------------------------------------------- the user payload */

test('GET /api/resume/models is ids, display names and the builder defaults - nothing else', async () => {
  const server = await serve('payload');
  try {
    await config.updateAppSettings({
      googleSheetsSources: [
        { id: 's1', name: 'Shared applications', sheetId: 'SECRET-SHEET-ID', createdAt: 'x', updatedAt: 'x' },
      ],
    });
    await config.updateAIModel('claude-cli-opus', { creditsPerResume: 7, description: 'Hardest prompts.' });

    const { status, body, text } = await server.call('alice', 'GET', '/resume/models');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      'defaultCoverLetterDocxEnabled',
      'defaultGroupId',
      'defaultMode',
      'defaultModelId',
      'defaultProfileId',
      'defaultResumeDocxEnabled',
      'defaultResumeSelection',
      'defaultTheme',
      'models',
      'outputPathUsesJobTitle',
    ]);
    assert.deepEqual(body.models, [
      { id: 'claude-cli-sonnet', name: 'Claude Sonnet' },
      { id: 'claude-cli-opus', name: 'Claude Opus' },
      { id: 'claude-cli-haiku', name: 'Claude Haiku' },
      { id: 'codex-cli-default', name: 'Codex' },
      { id: 'gemini-cli-auto', name: 'Gemini' },
    ]);
    assert.equal(body.defaultModelId, 'claude-cli-sonnet');
    for (const leak of [
      '"provider"',
      '"modelName"',
      'creditsPerResume',
      'Hardest prompts.',
      'providerLocks',
      'providersEnabled',
      'claudeCliEnabled',
      'googleSheetsSources',
      'SECRET-SHEET-ID',
      '(Subscription)',
    ]) {
      assert.equal(text.includes(leak), false, `the user payload carries ${leak}`);
    }

    // The administrator's payload keeps all of it.
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.aiModels.find((model) => model.id === 'claude-cli-opus').creditsPerResume, 7);
    assert.equal(admin.googleSheetsSources[0].sheetId, 'SECRET-SHEET-ID');
    assert.ok(Array.isArray(admin.providerModelOptions) && admin.providerModelOptions.length === 3);
  } finally {
    server.close();
  }
});

test('a switched-off model, a switched-off seat and a locked seat are absent, not greyed out', async () => {
  const server = await serve('absent');
  try {
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    await config.updateAppSettings({ providersEnabled: { 'gemini-cli': false } });
    process.env.AI_LOCKED_PROVIDERS = 'codex-cli';
    process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,gemini-cli';
    config.invalidateSettingsCache();

    const { body } = await server.call('alice', 'GET', '/resume/models');
    assert.deepEqual(body.models.map((model) => model.id), ['claude-cli-sonnet', 'claude-cli-opus']);
    assert.equal('providerLocks' in body, false);
  } finally {
    delete process.env.AI_LOCKED_PROVIDERS;
    process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
    server.close();
  }
});

/* --------------------------------------------------------- the resolver */

test('a stored choice that cannot run falls back to the default, once in the log, and never throws', async () => {
  useTempStorage('user-model-access-stored');
  config.invalidateSettingsCache();
  await config.updateAIModel('claude-cli-haiku', { enabled: false });
  await config.updateAppSettings({ providersEnabled: { 'codex-cli': false } });

  const capture = captureWarnings();
  try {
    for (const modelId of ['claude-cli-haiku', 'codex-cli-default', 'deleted-model']) {
      for (let i = 0; i < 2; i += 1) {
        const choice = await preferences.resolveAiChoice(undefined, { profileSettings: { ai: { modelId } } });
        assert.equal(choice.modelId, 'claude-cli-sonnet', `a profile set to ${modelId} runs on the default`);
      }
    }
  } finally {
    capture.restore();
  }
  for (const modelId of ['claude-cli-haiku', 'codex-cli-default', 'deleted-model']) {
    const lines = capture.warnings.filter((line) => line.includes(`stored preference names "${modelId}"`));
    assert.equal(lines.length, 1, `${modelId}: said once, however many calls`);
  }
  assert.match(
    capture.warnings.find((line) => line.includes('"claude-cli-haiku"')),
    /is disabled.*default model instead/
  );
});

test('a requested model that cannot run is refused with one sentence, and the cause only as detail', async () => {
  useTempStorage('user-model-access-request');
  config.invalidateSettingsCache();
  await config.updateAIModel('claude-cli-haiku', { enabled: false });
  const { ModelUnavailableError } = require('../dist/config/modelErrors');

  for (const [modelId, detail] of [
    ['claude-cli-haiku', /"Claude Haiku" is disabled/],
    ['nothing-by-this-id', /was not found/],
  ]) {
    await assert.rejects(
      () => preferences.resolveAiChoice({ modelId }, { profileSettings: { ai: { modelId: 'claude-cli-opus' } } }),
      (error) =>
        error instanceof ModelUnavailableError &&
        error.message === GENERIC &&
        error.status === 400 &&
        error.code === 'model-unavailable' &&
        detail.test(error.detail)
    );
  }
});

test("the provider forms are an administrator's: refused for anyone else, resolved for them", async () => {
  useTempStorage('user-model-access-forms');
  config.invalidateSettingsCache();

  for (const modelId of ['codex-cli', 'codex-cli:default', 'gemini-cli:auto']) {
    await assert.rejects(() => preferences.resolveAiChoice({ modelId }, null), {
      message: GENERIC,
      detail: /only an administrator's request may do/,
    });
    await assert.rejects(() => preferences.resolveAiChoice({ modelId }, null, { admin: false }), { message: GENERIC });
  }
  assert.equal((await preferences.resolveAiChoice({ modelId: 'codex-cli' }, null, { admin: true })).modelId, 'codex-cli-default');
  assert.equal(
    (await preferences.resolveAiChoice({ modelId: 'gemini-cli:auto' }, null, { admin: true })).modelId,
    'gemini-cli-auto'
  );
  // A retired id from a page loaded before the upgrade still runs on the
  // default for everyone - that tolerance is about stale tabs, not about roles.
  assert.equal((await preferences.resolveAiChoice({ modelId: 'openai' }, null)).modelId, 'claude-cli-sonnet');
  // The priced form resolves the same way, with the model's own price.
  await config.updateAIModel('codex-cli-default', { creditsPerResume: 3 });
  assert.deepEqual(await preferences.resolvePricedAiChoice({ modelId: 'codex-cli-default' }, null), {
    choice: { provider: 'codex-cli', modelName: 'default', modelId: 'codex-cli-default', modelLabel: 'Codex' },
    creditCost: 3,
  });
});

test('over HTTP, a refused model is a 400 with the generic sentence; only an administrator also gets why', async () => {
  const server = await serve('http-refusal');
  try {
    await config.updateAIModel('claude-cli-haiku', { enabled: false });
    const jobDescription = 'A job description long enough to be analysed by the model. '.repeat(2);

    const user = await server.call('alice', 'POST', '/resume/analyze', { jobDescription, model: 'claude-cli-haiku' });
    assert.equal(user.status, 400);
    assertModelUnavailable(user.body);

    const form = await server.call('alice', 'POST', '/resume/analyze', { jobDescription, model: 'claude-cli' });
    assert.equal(form.status, 400);
    assert.equal(form.body.code, 'model-unavailable');
    assert.equal('detail' in form.body, false);

    const admin = await server.call('admin', 'POST', '/resume/analyze', { jobDescription, model: 'claude-cli-haiku' });
    assert.equal(admin.status, 400);
    assert.equal(admin.body.error, GENERIC);
    assert.match(admin.body.detail, /"Claude Haiku" is disabled/);
  } finally {
    server.close();
  }
});

/* -------------------------------------------------------- profile saves */

test('a profile save checks a changed model against the list, and stores a retired one as inheriting', async () => {
  const server = await serve('profile-save');
  try {
    await config.updateAIModel('claude-cli-haiku', { enabled: false });

    const refused = await server.call('bob', 'POST', '/profiles', {
      ...profileInput('Bo'),
      profileSettings: { ai: { modelId: 'claude-cli-haiku' } },
    });
    assert.equal(refused.status, 400);
    assertModelUnavailable(refused.body);

    const created = await server.call('bob', 'POST', '/profiles', {
      ...profileInput('Bo'),
      profileSettings: { ai: { modelId: 'claude-cli-opus' } },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.profileSettings.ai, { modelId: 'claude-cli-opus' });

    for (const modelId of ['claude-cli', 'claude-cli:opus', 'no-such-model']) {
      const changed = await server.call('alice', 'PUT', '/profiles/p-alice', {
        profileSettings: { ai: { modelId } },
      });
      assert.equal(changed.status, 400, modelId);
      assert.equal(changed.body.code, 'model-unavailable');
    }

    const retired = await server.call('alice', 'PUT', '/profiles/p-alice', {
      profileSettings: { ai: { modelId: 'free-hybrid' } },
    });
    assert.equal(retired.status, 200);
    assert.deepEqual(retired.body.profileSettings.ai, {}, 'a retired choice is no choice');

    // Picked while it ran, switched off since: saving the rest of the profile
    // must still work, and keeps the choice - it falls back when it is used.
    const picked = await server.call('alice', 'PUT', '/profiles/p-alice', {
      profileSettings: { ai: { modelId: 'claude-cli-opus' } },
    });
    assert.equal(picked.status, 200);
    await config.updateAIModel('claude-cli-opus', { enabled: false });
    const renamed = await server.call('alice', 'PUT', '/profiles/p-alice', {
      name: 'Ada Lovelace',
      profileSettings: { ai: { modelId: 'claude-cli-opus' } },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Ada Lovelace');
    assert.deepEqual(renamed.body.profileSettings.ai, { modelId: 'claude-cli-opus' });

    const admin = await server.call('admin', 'PUT', '/profiles/p-alice', {
      profileSettings: { ai: { modelId: 'claude-cli-haiku' } },
    });
    assert.equal(admin.status, 400);
    assert.match(admin.body.detail, /disabled/, 'an administrator is told why');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------- deleted routes */

test('the synchronous generate-all and multi-job routes are gone', async () => {
  const server = await serve('deleted-routes');
  try {
    for (const route of ['/resume/generate-all', '/resume/generate-multi-job']) {
      const response = await server.call('alice', 'POST', route, { companyName: 'Acme', jobs: [] });
      assert.equal(response.status, 404, route);
    }
  } finally {
    server.close();
  }
});

/* ------------------------------------------- job filter and bid assistant */

const stubAdapter = (id, calls, text = '{"ok":true}') => () => ({
  id,
  capabilities: {
    id, label: 'stub', temperature: false, maxOutputTokens: false,
    nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
  },
  defaultModelName: () => `${id}-own-default`,
  health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
  async complete(request) {
    calls.push({ provider: id, modelName: request.modelName });
    return { text, resolvedModel: request.modelName, providerId: id, droppedParams: [], latencyMs: 1 };
  },
});

function filterPrompt(staticDir, override = {}) {
  writeStaticJson(staticDir, 'prompts/filter-google-sheet-job.json', {
    id: 'filter-google-sheet-job',
    content: 'Judge [[jobContent]] from [[jobLink]].',
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    allowedVariables: [{ name: 'jobContent' }, { name: 'jobLink' }, { name: 'jobDescription' }],
    ...override,
  });
}

test('the job filter runs on the app default model, and is reported by its display name', async () => {
  const { staticDir } = useTempStorage('user-model-access-filter');
  config.invalidateSettingsCache();
  filterPrompt(staticDir);
  const jobFilter = require('../dist/services/jobFilter');

  assert.deepEqual(await jobFilter.resolveJobFilterModel(), {
    provider: 'claude-cli',
    modelName: 'sonnet',
    modelLabel: 'Claude Sonnet',
  });

  // An administrator's own model as the default: that is what every row runs on.
  const created = await config.createAIModel({ name: 'Luna', provider: 'codex-cli', modelName: 'gpt-6-luna' });
  const luna = created.aiModels.find((model) => model.modelName === 'gpt-6-luna');
  await config.updateAppSettings({ defaultModelId: luna.id });
  const model = await jobFilter.resolveJobFilterModel();
  assert.deepEqual(model, { provider: 'codex-cli', modelName: 'gpt-6-luna', modelLabel: 'Luna' });

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const calls = [];
  ai.registerAdapter('codex-cli', stubAdapter('codex-cli', calls, '{"job_type":"remote"}'));
  const analysis = await jobFilter.evaluateJobContentAgainstFilter({
    jobContent: 'A remote engineering role based in the United States, paying well. '.repeat(2),
    jobLink: 'https://jobs.example.com/1',
    provider: model.provider,
    modelName: model.modelName,
  });
  assert.equal(analysis.jobType, 'remote');
  assert.deepEqual(calls, [{ provider: 'codex-cli', modelName: 'gpt-6-luna' }]);
  ai.resetRegistryForTests();
});

test("a filter prompt's own override wins, and is named by its record - or, to anybody but an admin, by no model name at all", async () => {
  const { staticDir } = useTempStorage('user-model-access-filter-override');
  config.invalidateSettingsCache();
  filterPrompt(staticDir, { modelProvider: 'codex-cli', modelName: 'gpt-6-sol' });
  const jobFilter = require('../dist/services/jobFilter');

  // No record names codex-cli/gpt-6-sol, so there is no display name. The CLI
  // option's label is a model name, and goes to administrators only.
  assert.deepEqual(await jobFilter.resolveJobFilterModel(), {
    provider: 'codex-cli',
    modelName: 'gpt-6-sol',
    modelLabel: 'Chosen by your administrator',
    adminModelLabel: 'GPT-6-Sol',
  });

  await config.createAIModel({ name: 'Sol', provider: 'codex-cli', modelName: 'gpt-6-sol' });
  assert.deepEqual(await jobFilter.resolveJobFilterModel(), {
    provider: 'codex-cli',
    modelName: 'gpt-6-sol',
    modelLabel: 'Sol',
  });
});

test('the Bid Assistant answers on the app default model, not on a seat default', async () => {
  useTempStorage('user-model-access-bid');
  config.invalidateSettingsCache();
  await config.updateAppSettings({ defaultModelId: 'gemini-cli-auto' });

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const calls = [];
  ai.registerAdapter(
    'gemini-cli',
    stubAdapter('gemini-cli', calls, JSON.stringify({ answers: { p1: { q0: 'Because I like it.' } } }))
  );
  const { generateAnswers } = loadFresh('../dist/bidAssistant/aiHelper');
  const answers = await generateAnswers([{ id: 'p1', name: 'Ada' }], 'Engineer', 'Acme', 'Build things.', [
    { question: 'Why us?', charLimit: 200 },
  ]);

  assert.deepEqual(answers, { p1: { 0: 'Because I like it.' } });
  assert.deepEqual(calls, [{ provider: 'gemini-cli', modelName: 'auto' }]);
  ai.resetRegistryForTests();
});

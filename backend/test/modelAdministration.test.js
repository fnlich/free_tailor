const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/**
 * Every seat is unlocked here, whatever the machine running this says; the
 * tests that are about a lock set one for themselves. Set before any dist
 * module loads.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { loadFresh, readSettingRaw, useAdminEmails, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * Admin -> Models picks a model name from a per-seat list instead of typing one.
 *
 * Free text made every typo a record that failed at generate time - and on the
 * Claude seat not even then: the CLI provider swaps a name it would not serve
 * for its default with a log line, so the record quietly ran a model nobody
 * chose. What is pinned here:
 *
 *   - the lists themselves, and the `.env` overrides that replace them;
 *   - that the admin payload carries them, on every response the form reads;
 *   - that a create, or an edit that changes the provider or model, must name a
 *     listed model (stored in the list's spelling), while an edit that leaves
 *     both alone - the enable switch, a rename - never asks, so a model saved
 *     before the lists existed keeps running and stays editable;
 *   - that Set Default refuses a model that cannot run instead of quietly
 *     substituting another;
 *   - that a prompt's model override is checked against the same lists when it
 *     is saved, and never when it is read.
 */

const APP_SETTINGS_KEY = 'app-settings';
const OPTION_VARIABLES = ['AI_CLI_MODEL_OPTIONS', 'AI_CODEX_MODEL_OPTIONS', 'AI_GEMINI_MODEL_OPTIONS'];

const CLAUDE_VALUES = ['sonnet', 'opus', 'haiku', 'fable'];
const CODEX_VALUES = [
  'default',
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
];
const GEMINI_VALUES = [
  'auto',
  'pro',
  'flash',
  'flash-lite',
  'gemini-2.5-pro',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
];

function clearOptionOverrides() {
  for (const name of OPTION_VARIABLES) delete process.env[name];
}

function captureWarnings(fn) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

function loadOptions() {
  loadFresh('../dist/config/envValue').resetEnvWarningsForTests();
  return loadFresh('../dist/config/providerModels');
}

/* ------------------------------------------------------------------ lists */

test('each seat offers the verified model names, in order, each with a label', () => {
  const { listProviderModelOptions } = loadOptions();

  assert.deepEqual(listProviderModelOptions('claude-cli', {}), [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
  ]);
  const codex = listProviderModelOptions('codex-cli', {});
  assert.deepEqual(codex.map((option) => option.value), CODEX_VALUES);
  // The seed `codex-cli-default` names it, and the argv builder turns it into
  // "no -m": it has to be offered, and first, so a provider switch lands on it.
  assert.deepEqual(codex[0], { value: 'default', label: 'Account default' });
  assert.equal(codex.find((option) => option.value === 'gpt-6-astra').label, 'GPT-6-Astra');
  const gemini = listProviderModelOptions('gemini-cli', {});
  assert.deepEqual(gemini.map((option) => option.value), GEMINI_VALUES);
  assert.equal(gemini.find((option) => option.value === 'gemini-3.1-pro-preview').label, 'Gemini 3.1 Pro (preview)');

  // Nothing for a provider this build does not have, a retired one included.
  assert.deepEqual(listProviderModelOptions('openai', {}), []);
  assert.deepEqual(listProviderModelOptions('constructor', {}), []);
});

test('every listed name reaches its CLI as written, and is not swapped for the default', () => {
  // The Claude and Gemini adapters replace a name they would not serve with
  // their default and a log line; a list offering one would let an
  // administrator pick a model the run then silently does not use.
  const { listProviderModelOptions } = loadOptions();
  const { resolveCliModel } = loadFresh('../dist/services/ai/providers/claudeCli/argv');
  const { resolveGeminiModel } = loadFresh('../dist/services/ai/providers/geminiCli/argv');
  for (const { value } of listProviderModelOptions('claude-cli', {})) {
    assert.equal(resolveCliModel(value, 'fallback'), value, value);
  }
  for (const { value } of listProviderModelOptions('gemini-cli', {})) {
    assert.equal(resolveGeminiModel(value, 'fallback'), value, value);
  }
});

test('an override replaces a seat\'s list: known names keep their labels, the rest show as written', () => {
  const { listProviderModelOptions } = loadOptions();

  assert.deepEqual(
    listProviderModelOptions('codex-cli', { AI_CODEX_MODEL_OPTIONS: 'gpt-6-luna, default my-org-model,GPT-6-LUNA' }),
    [
      { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
      { value: 'default', label: 'Account default' },
      { value: 'my-org-model', label: 'my-org-model' },
    ],
    'order kept, and a second spelling of a name already listed dropped'
  );
  assert.deepEqual(
    listProviderModelOptions('claude-cli', { AI_CLI_MODEL_OPTIONS: 'opus,sonnet[1m],claude-opus-4-1' }),
    [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet[1m]', label: 'Sonnet (1M context)' },
      { value: 'claude-opus-4-1', label: 'claude-opus-4-1' },
    ]
  );
  assert.deepEqual(listProviderModelOptions('gemini-cli', { AI_GEMINI_MODEL_OPTIONS: 'gemini-2.5-flash,flash' }), [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'flash', label: 'Flash' },
  ]);
  // One seat's override is that seat's alone.
  assert.deepEqual(
    listProviderModelOptions('claude-cli', { AI_CODEX_MODEL_OPTIONS: 'default' }).map((option) => option.value),
    CLAUDE_VALUES
  );
});

test('a list with a name the seat\'s CLI would not run as written is ignored whole, with one warning', () => {
  const { listProviderModelOptions } = loadOptions();

  const { result, warnings } = captureWarnings(() => [
    // `gpt-5` is not a Claude name, and the Claude CLI provider would quietly
    // run its default instead. All or nothing: dropping just that entry would
    // run with a list nobody wrote.
    listProviderModelOptions('claude-cli', { AI_CLI_MODEL_OPTIONS: 'sonnet,gpt-5' }),
    listProviderModelOptions('claude-cli', { AI_CLI_MODEL_OPTIONS: 'sonnet,gpt-5' }),
    // Case matters to the CLI: `Sonnet` is not an alias it knows.
    listProviderModelOptions('claude-cli', { AI_CLI_MODEL_OPTIONS: 'Sonnet' }),
    // Gemini has no `default`.
    listProviderModelOptions('gemini-cli', { AI_GEMINI_MODEL_OPTIONS: 'auto,default' }),
    // Not a model name at all.
    listProviderModelOptions('codex-cli', { AI_CODEX_MODEL_OPTIONS: 'default;rm' }),
  ]);
  assert.deepEqual(result[0].map((option) => option.value), CLAUDE_VALUES);
  assert.deepEqual(result[2].map((option) => option.value), CLAUDE_VALUES);
  assert.deepEqual(result[3].map((option) => option.value), GEMINI_VALUES);
  assert.deepEqual(result[4].map((option) => option.value), CODEX_VALUES);

  const claudeWarnings = warnings.filter((line) => line.includes('AI_CLI_MODEL_OPTIONS'));
  assert.equal(claudeWarnings.length, 1, 'once per variable, however often it is read');
  assert.match(claudeWarnings[0], /"gpt-5", which is not a Claude CLI model name/);
  assert.ok(warnings.some((line) => /AI_GEMINI_MODEL_OPTIONS.*"default"/.test(line)));
  assert.ok(warnings.some((line) => line.includes('AI_CODEX_MODEL_OPTIONS')));

  // An empty value is unset, which is the default and nothing to warn about.
  const empty = captureWarnings(() => listProviderModelOptions('claude-cli', { AI_CLI_MODEL_OPTIONS: '  ' }));
  assert.deepEqual(empty.result.map((option) => option.value), CLAUDE_VALUES);
  assert.deepEqual(empty.warnings, []);
});

test('a model name is found case-insensitively, and given back in the list\'s spelling', () => {
  const { findProviderModelOption } = loadOptions();
  assert.deepEqual(findProviderModelOption('claude-cli', ' Opus ', {}), { value: 'opus', label: 'Opus' });
  assert.equal(findProviderModelOption('codex-cli', 'GPT-6-ASTRA', {}).value, 'gpt-6-astra');
  assert.equal(findProviderModelOption('claude-cli', 'gpt-6-astra', {}), null, 'a name from another seat');
  assert.equal(findProviderModelOption('gemini-cli', '', {}), null);
});

test('the overrides are in the operational table, read per call, defaulting to the shipped lists', () => {
  const { OPERATIONAL_VARIABLES } = loadFresh('../dist/config/operational');
  const byName = Object.fromEntries(OPERATIONAL_VARIABLES.map((variable) => [variable.name, variable]));
  assert.equal(byName.AI_CLI_MODEL_OPTIONS.defaultValue, CLAUDE_VALUES.join(','));
  assert.equal(byName.AI_CODEX_MODEL_OPTIONS.defaultValue, CODEX_VALUES.join(','));
  assert.equal(byName.AI_GEMINI_MODEL_OPTIONS.defaultValue, GEMINI_VALUES.join(','));
  for (const name of OPTION_VARIABLES) {
    assert.equal(byName[name].readAt, 'per-call', name);
    assert.equal(byName[name].current({}), byName[name].defaultValue, name);
  }
  assert.equal(byName.AI_CLI_MODEL_OPTIONS.current({ AI_CLI_MODEL_OPTIONS: 'opus,opus,haiku' }), 'opus,haiku');
});

/* ------------------------------------------------------------ admin routes */

async function serveAdmin(name) {
  useTempStorage(`model-administration-${name}`);
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(admin.id);

  const config = loadFresh('../dist/config/aiModelConfig');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/admin');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  const call = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { close: () => server.close(), call, config };
}

test('every admin settings and model response carries the option lists, every seat in catalog order', async () => {
  clearOptionOverrides();
  // A locked seat is listed too: an administrator can prepare its models
  // before the lock is lifted.
  process.env.AI_LOCKED_PROVIDERS = 'gemini-cli';
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli';
  const server = await serveAdmin('options-everywhere');
  try {
    const created = await server.call('POST', '/models', {
      name: 'Claude Fable',
      provider: 'claude-cli',
      modelName: 'fable',
      pricePerResumeUsd: '0.010',
    });
    assert.equal(created.status, 201);
    const fable = created.body.aiModels.find((model) => model.modelName === 'fable');

    const responses = {
      'GET /settings': await server.call('GET', '/settings'),
      'GET /ai-models': await server.call('GET', '/ai-models'),
      'PUT /settings': await server.call('PUT', '/settings', { defaultTheme: 'dark' }),
      'POST /models': created,
      'PUT /models/:id': await server.call('PUT', `/models/${fable.id}`, { description: 'Hardest prompts.' }),
      'DELETE /models/:id': await server.call('DELETE', `/models/${fable.id}`),
    };
    for (const [route, response] of Object.entries(responses)) {
      assert.ok(response.status < 300, `${route} answered ${response.status}`);
      const options = response.body.providerModelOptions;
      assert.deepEqual(
        options.map((entry) => [entry.provider, entry.label]),
        [
          ['claude-cli', 'Claude (Subscription)'],
          ['codex-cli', 'Codex (Subscription)'],
          ['gemini-cli', 'Gemini (Subscription)'],
        ],
        route
      );
      assert.deepEqual(options[0].models.map((model) => model.value), CLAUDE_VALUES, route);
      assert.deepEqual(options[2].models.map((model) => model.value), GEMINI_VALUES, `${route}: locked, still listed`);
    }
  } finally {
    server.close();
    delete process.env.AI_LOCKED_PROVIDERS;
    process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  }
});

test('creating a model needs a listed model name, stored in the list\'s spelling, and a display name', async () => {
  clearOptionOverrides();
  const server = await serveAdmin('create');
  try {
    const unlisted = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: 'GPT', provider: 'codex-cli', modelName: 'gpt-5-nano' });
    assert.equal(unlisted.status, 400);
    assert.equal(
      unlisted.body.error,
      `"gpt-5-nano" is not one of the Codex (Subscription) models: ${CODEX_VALUES.join(', ')}.`
    );

    // A name from another seat's list is still not this seat's.
    const crossed = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: 'X', provider: 'gemini-cli', modelName: 'opus' });
    assert.equal(crossed.status, 400);
    assert.match(crossed.body.error, /not one of the Gemini \(Subscription\) models: auto, pro/);

    const nameless = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', provider: 'codex-cli', modelName: 'gpt-6-luna' });
    assert.equal(nameless.status, 400);
    assert.equal(nameless.body.error, 'Display name is required.');
    const blank = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: '   ', provider: 'codex-cli', modelName: 'gpt-6-luna' });
    assert.equal(blank.body.error, 'Display name is required.');

    const created = await server.call('POST', '/models', {
      name: '  Luna  ',
      provider: 'codex-cli',
      modelName: 'GPT-6-Luna',
      description: '  Fast and cheap.  ',
      pricePerResumeUsd: '0.010',
    });
    assert.equal(created.status, 201);
    const luna = created.body.aiModels.find((model) => model.name === 'Luna');
    assert.ok(luna, 'the display name is trimmed');
    assert.equal(luna.modelName, 'gpt-6-luna', 'stored as the CLI spells it');
    assert.equal(luna.description, 'Fast and cheap.');
    assert.equal(luna.enabled, true);

    // The same model twice is refused by name, whatever its spelling.
    const duplicate = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: 'Luna again', provider: 'codex-cli', modelName: 'gpt-6-LUNA' });
    assert.equal(duplicate.status, 400);
    assert.equal(
      duplicate.body.error,
      'Codex (Subscription) already has a model for "gpt-6-luna" ("Luna"). Edit that one instead.'
    );

    // Not a seat.
    const retired = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: 'Metered', provider: 'openai', modelName: 'gpt-5.1' });
    assert.equal(retired.status, 400);
    assert.equal(retired.body.error, 'Model provider must be one of: claude-cli, codex-cli, gemini-cli.');
  } finally {
    server.close();
  }
});

test('an edit is checked against the list only when it changes the provider or the model', async () => {
  clearOptionOverrides();
  const server = await serveAdmin('update');
  try {
    // A model saved while the list still offered it - here, a list narrowed
    // through .env since - keeps running and can still be edited.
    await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: 'Fable', provider: 'claude-cli', modelName: 'fable', description: 'Big.' });
    process.env.AI_CLI_MODEL_OPTIONS = 'sonnet,opus,haiku';
    const fable = (await server.call('GET', '/settings')).body.aiModels.find((model) => model.modelName === 'fable');

    const off = await server.call('PUT', `/models/${fable.id}`, { enabled: false });
    assert.equal(off.status, 200, 'the enable switch never asks');
    const renamed = await server.call('PUT', `/models/${fable.id}`, { name: 'Claude Fable' });
    assert.equal(renamed.status, 200, 'nor does a rename');
    const sameModel = await server.call('PUT', `/models/${fable.id}`, { provider: 'claude-cli', modelName: 'FABLE' });
    assert.equal(sameModel.status, 200, 'nor a form that sends the same model back');
    const after = sameModel.body.aiModels.find((model) => model.id === fable.id);
    assert.deepEqual(
      { name: after.name, modelName: after.modelName, description: after.description, enabled: after.enabled },
      { name: 'Claude Fable', modelName: 'fable', description: 'Big.', enabled: false },
      'every field an edit leaves out keeps its value'
    );

    const changed = await server.call('PUT', `/models/${fable.id}`, { modelName: 'fable-2' });
    assert.equal(changed.status, 400);
    assert.equal(changed.body.error, '"fable-2" is not one of the Claude (Subscription) models: sonnet, opus, haiku.');
    const moved = await server.call('PUT', `/models/${fable.id}`, { provider: 'gemini-cli' });
    assert.equal(moved.status, 400, 'moving it to another seat checks that seat\'s list');
    assert.match(moved.body.error, /"fable" is not one of the Gemini \(Subscription\) models/);

    const repointed = await server.call('PUT', `/models/${fable.id}`, { provider: 'gemini-cli', modelName: 'Pro' });
    assert.equal(repointed.status, 200);
    const now = repointed.body.aiModels.find((model) => model.id === fable.id);
    assert.equal(now.provider, 'gemini-cli');
    assert.equal(now.modelName, 'pro');
    assert.equal(now.name, 'Claude Fable', 'and the rest of the record is kept');

    const missing = await server.call('PUT', '/models/no-such-model', { enabled: true });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    clearOptionOverrides();
  }
});

test('a display name another model already has is refused, in any case or spacing, on a create and a rename', async () => {
  // Users see the display name and nothing else, so two records sharing one are
  // two identical choices on different seats, at different prices.
  clearOptionOverrides();
  const server = await serveAdmin('display-names');
  try {
    for (const name of ['Claude Sonnet', '  claude sonnet ']) {
      const twin = await server.call('POST', '/models', { name, provider: 'gemini-cli', modelName: 'pro', pricePerResumeUsd: '0.009' });
      assert.equal(twin.status, 400, JSON.stringify(name));
      assert.equal(
        twin.body.error,
        '"Claude Sonnet" is already the name of a Claude (Subscription) model. Users see only display names, so give this one a different name.'
      );
    }

    const renamed = await server.call('PUT', '/models/claude-cli-opus', { name: 'CLAUDE SONNET' });
    assert.equal(renamed.status, 400);
    assert.match(renamed.body.error, /already the name of a Claude \(Subscription\) model/);

    // A record keeps its own name through any edit, a change of case included.
    const recased = await server.call('PUT', '/models/claude-cli-sonnet', { name: 'claude sonnet' });
    assert.equal(recased.status, 200);
    const created = await server.call('POST', '/models', { pricePerResumeUsd: '0.010', name: 'Gemini Pro', provider: 'gemini-cli', modelName: 'pro' });
    assert.equal(created.status, 201);
  } finally {
    server.close();
  }
});

test('a pair of names stored before the check can still be toggled and repriced', async () => {
  clearOptionOverrides();
  const { dbDir } = useTempStorage('model-administration-legacy-twins');
  const { writeSettingRaw } = require('./helpers');
  const stamp = '2026-01-01T00:00:00.000Z';
  const record = (id, provider, modelName) => ({
    id, name: 'Twin', provider, modelName, description: '', enabled: true, pricePerResumeMilli: 1, createdAt: stamp, updatedAt: stamp,
  });
  writeSettingRaw(
    dbDir,
    APP_SETTINGS_KEY,
    JSON.stringify({ aiModels: [record('a', 'claude-cli', 'sonnet'), record('b', 'codex-cli', 'default')], defaultModelId: 'a' })
  );
  const config = loadFresh('../dist/config/aiModelConfig');
  const toggled = await config.updateAIModel('b', { enabled: false, pricePerResumeUsd: '0.003' });
  assert.deepEqual(
    toggled.aiModels.map((entry) => [entry.id, entry.name, entry.enabled, entry.pricePerResumeMilli]),
    [['a', 'Twin', true, 1], ['b', 'Twin', false, 3]]
  );
  // Renaming one away is the fix, and is fine; renaming it back is refused.
  const apart = await config.updateAIModel('b', { name: 'Codex' });
  assert.equal(apart.aiModels.find((entry) => entry.id === 'b').name, 'Codex');
  await assert.rejects(() => config.updateAIModel('b', { name: 'twin ' }), /already the name of/);
});

test('a stored model the list does not offer still reads, and still runs', async () => {
  // The list comes from .env and can change under stored rows; a read that
  // checked it would let one .env edit take every settings read down.
  clearOptionOverrides();
  const server = await serveAdmin('read-agnostic');
  try {
    process.env.AI_CLI_MODEL_OPTIONS = 'opus';
    server.config.invalidateSettingsCache();
    const settings = (await server.call('GET', '/settings')).body;
    const sonnet = settings.aiModels.find((model) => model.id === 'claude-cli-sonnet');
    assert.equal(sonnet.enabled, true);
    assert.equal((await server.config.resolveRequestedAIModel('claude-cli-sonnet')).modelName, 'sonnet');
  } finally {
    server.close();
    clearOptionOverrides();
  }
});

test('Set Default refuses a model that cannot run, by name, instead of quietly choosing another', async () => {
  clearOptionOverrides();
  const server = await serveAdmin('set-default');
  try {
    const opus = await server.call('PUT', '/settings', { defaultModelId: 'claude-cli-opus' });
    assert.equal(opus.status, 200);
    assert.equal(opus.body.defaultModelId, 'claude-cli-opus');

    await server.call('PUT', '/models/claude-cli-haiku', { enabled: false });
    const disabled = await server.call('PUT', '/settings', { defaultModelId: 'claude-cli-haiku' });
    assert.equal(disabled.status, 400);
    assert.match(disabled.body.error, /^"Claude Haiku" is switched off\. Enable it under Admin -> Models/);

    const unknown = await server.call('PUT', '/settings', { defaultModelId: 'no-such-model' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /"no-such-model" was not found, so it cannot be the default/);

    await server.call('PUT', '/settings', { providersEnabled: { 'codex-cli': false } });
    const providerOff = await server.call('PUT', '/settings', { defaultModelId: 'codex-cli-default' });
    assert.equal(providerOff.status, 400);
    assert.match(providerOff.body.error, /Codex \(Subscription\) is switched off under Admin -> Settings/);

    process.env.AI_LOCKED_PROVIDERS = 'gemini-cli';
    process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli';
    const locked = await server.call('PUT', '/settings', { defaultModelId: 'gemini-cli-auto' });
    assert.equal(locked.status, 400);
    assert.match(locked.body.error, /Gemini \(Subscription\) is locked in this installation\. Needs the `gemini` CLI/);

    // Nothing was substituted by any of those.
    const stored = JSON.parse(readSettingRaw(process.env.DB_DIR, APP_SETTINGS_KEY));
    assert.equal(stored.defaultModelId, 'claude-cli-opus');

    // A form that re-sends the default it loaded saves, and so does a page from
    // before the upgrade naming a retired model: that falls back, as every
    // retired reference does.
    const resent = await server.call('PUT', '/settings', { defaultModelId: 'claude-cli-opus', defaultTheme: 'dark' });
    assert.equal(resent.status, 200);
    const stale = await server.call('PUT', '/settings', { defaultModelId: 'openai-gpt-5-1' });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.defaultModelId, 'claude-cli-opus', 'the default in force stays');
  } finally {
    server.close();
    delete process.env.AI_LOCKED_PROVIDERS;
    process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  }
});

/* -------------------------------------------------------- prompt overrides */

const PROMPT = {
  content: 'Tailor.\n[[profileJson]]',
  allowedVariables: [{ name: 'profileJson', description: 'Profile', sampleValue: '{}' }],
};

test('a prompt\'s model override is checked against the same lists when saved', async () => {
  clearOptionOverrides();
  useTempStorage('model-administration-prompt-create');
  const promptService = loadFresh('../dist/services/promptService');

  const saved = await promptService.createPrompt({ ...PROMPT, name: 'Pinned', modelProvider: 'claude-cli', modelName: 'Opus' });
  assert.equal(saved.modelProvider, 'claude-cli');
  assert.equal(saved.modelName, 'opus', 'stored as the CLI spells it');

  await assert.rejects(
    () => promptService.createPrompt({ ...PROMPT, name: 'Typo', modelProvider: 'codex-cli', modelName: 'gpt-5-nano' }),
    new RegExp(`^Error: "gpt-5-nano" is not one of the Codex \\(Subscription\\) models: ${CODEX_VALUES.join(', ')}\\.$`)
  );
  // No override at all is still no override.
  assert.equal((await promptService.createPrompt({ ...PROMPT, name: 'Plain' })).modelProvider, undefined);
});

test('an override saved before the list stopped offering it survives edits that leave it alone', async () => {
  clearOptionOverrides();
  const { staticDir } = useTempStorage('model-administration-prompt-update');
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze [[jobDescription]]',
    createdAt: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
  });
  const promptService = loadFresh('../dist/services/promptService');
  const custom = await promptService.createPrompt({ ...PROMPT, name: 'Custom', modelProvider: 'claude-cli', modelName: 'haiku' });
  await promptService.updatePrompt('analyze-job-description', {
    content: 'Analyze [[jobDescription]]',
    modelProvider: 'claude-cli',
    modelName: 'haiku',
  });

  try {
    process.env.AI_CLI_MODEL_OPTIONS = 'sonnet,opus';

    // Read as stored: the read path never consults the list.
    assert.equal((await promptService.getPromptById(custom.id)).modelName, 'haiku');
    assert.ok((await promptService.listPrompts()).some((prompt) => prompt.id === custom.id));

    // Edited with the override left alone - or sent back as it was.
    const edited = await promptService.updatePrompt(custom.id, { content: 'Tailor better.\n[[profileJson]]' });
    assert.equal(edited.modelName, 'haiku');
    const resent = await promptService.updatePrompt(custom.id, {
      content: 'Tailor better.\n[[profileJson]]',
      modelProvider: 'claude-cli',
      modelName: 'HAIKU',
    });
    assert.equal(resent.modelName, 'haiku');
    const builtIn = await promptService.updatePrompt('analyze-job-description', {
      content: 'Analyze deeply [[jobDescription]]',
      modelProvider: 'claude-cli',
      modelName: 'haiku',
    });
    assert.equal(builtIn.modelName, 'haiku', 'a shipped prompt\'s stored override the same way');

    // Changed to something the list does not offer: refused.
    await assert.rejects(
      () => promptService.updatePrompt(custom.id, { content: 'Tailor.\n[[profileJson]]', modelName: 'fable' }),
      /"fable" is not one of the Claude \(Subscription\) models: sonnet, opus\./
    );
    await assert.rejects(
      () =>
        promptService.updatePrompt('analyze-job-description', {
          content: 'Analyze [[jobDescription]]',
          modelProvider: 'gemini-cli',
          modelName: 'haiku',
        }),
      /not one of the Gemini \(Subscription\) models/
    );
    // Cleared: always allowed.
    const cleared = await promptService.updatePrompt(custom.id, {
      content: 'Tailor.\n[[profileJson]]',
      modelProvider: '',
      modelName: '',
    });
    assert.equal(cleared.modelProvider, undefined);
  } finally {
    clearOptionOverrides();
  }
});

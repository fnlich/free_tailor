const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  loadFresh,
  readSettingRaw,
  useTempStorage,
  writeSettingRaw,
  writeStaticJson,
} = require('./helpers');

/**
 * The provider lock, and the migration that made room for it.
 *
 * A lock says "this deployment cannot run that provider" - a different claim
 * from the admin's enable switch, and the two must not be able to stand in for
 * one another. What is pinned here is that a locked provider cannot be
 * dispatched to by ANY of the ways a model can be named, that the UI is still
 * told about it so it can show a padlock rather than silently dropping the
 * model, and that an install locked out of a provider lands on a model that
 * works and costs nothing.
 *
 * Nothing is locked in the shipped catalog any more - the subscription seat is
 * offered, and the browser entry is the free default. So the subject here is an
 * operator who locks the seat out with AI_LOCKED_PROVIDERS, which is the same
 * machinery the catalog lock used and the case that still happens for real: a
 * box with no `claude` binary signed in.
 */

const APP_SETTINGS_KEY = 'app-settings';

/** Both lock lists are read from the environment on every call; reset between tests. */
function withLock({ locked, unlocked } = {}) {
  if (locked) process.env.AI_LOCKED_PROVIDERS = locked;
  else delete process.env.AI_LOCKED_PROVIDERS;
  if (unlocked) process.env.AI_UNLOCKED_PROVIDERS = unlocked;
  else delete process.env.AI_UNLOCKED_PROVIDERS;
}

/** The case every test here is about: the seat locked out by the operator. */
function lockSeat() {
  withLock({ locked: 'claude-cli' });
}

test.beforeEach(() => withLock());
test.after(() => withLock());

test('a seat the operator locked out says so instead of disappearing', async () => {
  useTempStorage('lock-public');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getPublicAppSettings();

  // Not offered as something to run...
  assert.equal(
    settings.aiModels.some((model) => model.provider === 'claude-cli'),
    false,
    'a locked provider contributes no runnable model'
  );

  // ...but still described, with the models it would have offered, so a picker
  // can grey them out rather than leave the user wondering where they went.
  const lock = settings.providerLocks.find((entry) => entry.id === 'claude-cli');
  assert.ok(lock, 'the lock is reported');
  assert.equal(lock.label, 'Claude (subscription)');
  assert.match(lock.reason, /subscription seat/i);
  assert.ok(
    lock.models.some((model) => model.id === 'claude-cli-sonnet'),
    'the models behind the lock come with it'
  );

  // And the default is one that can actually run, at no cost: the browser
  // entry, which is what the picker offers in place of the per-site models.
  assert.equal(settings.defaultModelId, 'free-hybrid');
});

test('the picker offers one browser entry, not a model per chat site', async () => {
  useTempStorage('lock-browser-models');
  const config = loadFresh('../dist/config/aiModelConfig');
  const { aiModels } = await config.getPublicAppSettings();

  const byId = new Map(aiModels.map((model) => [model.id, model]));
  // One entry standing for both free chat sites. Which site a given resume
  // lands on is the queue's business, not a choice to put in front of a user
  // who only wants the free route.
  assert.equal(byId.get('free-hybrid')?.name, 'Default (browser)');
  assert.equal(byId.has('claude-web-chat'), false, 'Claude (free) is not offered separately');
  assert.equal(byId.has('chatgpt-web-chat'), false, 'ChatGPT (free) is not offered separately');

  // The per-site rows still exist underneath, for Admin -> Models and for
  // profiles that picked one before this change.
  const admin = await config.getAdminAppSettings();
  const adminIds = new Set(admin.aiModels.map((model) => model.id));
  assert.ok(adminIds.has('claude-web-chat') && adminIds.has('chatgpt-web-chat'));
});

test('the subscription seat is offered, and is the default, when nothing locks it', async () => {
  useTempStorage('lock-seat-offered');
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getPublicAppSettings();

  assert.deepEqual(settings.providerLocks, [], 'nothing is locked in the shipped catalog');
  assert.ok(
    settings.aiModels.some((model) => model.id === 'claude-cli-sonnet'),
    'the CLI seat is pickable'
  );
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
});

test('AI_UNLOCKED_PROVIDERS lifts the lock', async () => {
  useTempStorage('lock-unlocked');
  // Named in both lists. Unlock wins, so the escape hatch stays an escape hatch.
  withLock({ locked: 'claude-cli', unlocked: 'claude-cli' });
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getPublicAppSettings();

  assert.deepEqual(settings.providerLocks, []);
  assert.ok(settings.aiModels.some((model) => model.id === 'claude-cli-sonnet'));
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
});

test('every way of naming a locked model is refused, and says why', async () => {
  useTempStorage('lock-resolve');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');

  // By model id, by bare provider id, and by the "provider:modelName" form -
  // three separate branches in the resolver, and a lock that only closed one
  // of them would be no lock at all.
  for (const requested of ['claude-cli-sonnet', 'claude-cli', 'claude-cli:sonnet']) {
    await assert.rejects(
      () => config.resolveRequestedAIModel(requested),
      /locked in this installation/i,
      `naming the model as "${requested}" is refused`
    );
  }

  // A model that is merely provider-disabled still reports as disabled: the
  // two messages point at different fixes and must not be merged.
  await config.updateAppSettings({
    providersEnabled: {
      'claude-cli': true, claude: true, openai: false, deepseek: true,
      'claude-web': true, 'chatgpt-web': true,
    },
  });
  await assert.rejects(() => config.resolveRequestedAIModel('openai-gpt-5-1'), /disabled by admin/i);
});

test('a request that names no provider reroutes off the locked one', async () => {
  useTempStorage('lock-default-provider');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getAIModelSettings();

  assert.equal(config.isProviderEnabled('claude-cli', settings), false);
  // The admin's own choice is unchanged underneath - unlocking later restores
  // exactly what they had picked.
  assert.equal(config.isProviderAdminEnabled('claude-cli', settings), true);
  assert.equal(config.getDefaultEnabledProvider(settings), 'claude-web');
});

test('a profile that had picked the locked model keeps working', async () => {
  useTempStorage('lock-stored-preference');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const preferences = loadFresh('../dist/config/aiPreferences');

  // Stored on the profile before the lock existed. Falling back is the whole
  // point: the alternative is that locking a provider silently breaks every
  // generate for every profile that had chosen it.
  const stored = await preferences.resolveAiChoice(undefined, {
    profileSettings: { ai: { modelId: 'claude-cli-sonnet' } },
  });
  assert.equal(stored.provider, 'claude-web');
  assert.equal(stored.modelId, 'claude-web-chat');

  // Named in THIS request, it is refused instead - somebody just picked it,
  // and quietly running something else would be worse than saying no.
  await assert.rejects(
    () => preferences.resolveAiChoice({ modelId: 'claude-cli-sonnet' }, null),
    /locked in this installation/i
  );

  // A stored id for a provider that is merely disabled is still an error: it
  // is the LOCK that makes a stored preference stale, not any failure to
  // resolve, and swallowing the rest would hide real misconfiguration.
  await config.updateAppSettings({
    providersEnabled: {
      'claude-cli': true, claude: true, openai: false, deepseek: true,
      'claude-web': true, 'chatgpt-web': true,
    },
  });
  await assert.rejects(
    () =>
      preferences.resolveAiChoice(undefined, {
        profileSettings: { ai: { modelId: 'openai-gpt-5-1' } },
      }),
    /disabled by admin/i
  );
});

test('settings that would leave only locked providers enabled are refused', async () => {
  useTempStorage('lock-assert');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () =>
      config.updateAppSettings({
        providersEnabled: {
          'claude-cli': true, claude: false, openai: false, deepseek: false,
          'claude-web': false, 'chatgpt-web': false,
        },
      }),
    /unlocked AI provider/i
  );
});

test('a prompt pinned to the locked provider runs instead of failing', async () => {
  const { staticDir } = useTempStorage('lock-prompt-override');
  lockSeat();
  // Exactly what the earlier provider migration wrote onto every custom
  // prompt: an override naming the subscription seat. Honouring it under a
  // lock would make each of those prompts unusable, with nothing in the UI to
  // say why - so the stored override is ignored and the run goes ahead.
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze.\n[[jobDescription]]',
    modelProvider: 'claude-cli',
    modelName: 'sonnet',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();

  const requests = [];
  ai.registerAdapter('openai', () => ({
    id: 'openai',
    capabilities: {
      id: 'openai', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, requiresApiKey: false,
      credentialKind: 'api-key', maxConcurrency: 4,
    },
    defaultModelName: () => 'gpt-5.1',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      requests.push(request);
      return { text: '{"ok":true}', resolvedModel: request.modelName, providerId: 'openai', droppedParams: [], latencyMs: 1 };
    },
  }));

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'A job' },
    fallbackProvider: 'openai',
    fallbackModelName: 'gpt-5.1',
    useExactPromptId: true,
  });

  assert.equal(requests.length, 1, 'the call ran on the caller\'s provider');
  assert.equal(requests[0].modelName, 'gpt-5.1');
});

/** A settings row from before the browser-chat models were seeded. */
function preBrowserChatSettings(rootDir, overrides = {}) {
  const stamp = '2026-05-01T00:00:00.000Z';
  return {
    providersEnabled: {
      'claude-cli': true, claude: true, openai: true, deepseek: true,
    },
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: '',
    defaultProfileId: '',
    defaultModelId: 'claude-cli-sonnet',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    outputBaseDir: path.join(rootDir, 'generated-output'),
    outputPathTemplate: '/{{date}}/{{profile name}}/{{company name}}',
    aiModels: [
      {
        id: 'claude-cli-sonnet',
        name: 'Claude Sonnet (subscription)',
        provider: 'claude-cli',
        modelName: 'sonnet',
        description: 'Balanced default.',
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'openai-gpt-5-1',
        name: 'gpt-5.1',
        provider: 'openai',
        modelName: 'gpt-5.1',
        description: 'OpenAI direct default.',
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    googleSheetsSources: [],
    ...overrides,
  };
}

test('an install that predates the browser-chat models is given them', async () => {
  const { rootDir, dbDir } = useTempStorage('lock-migrate');
  lockSeat();
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(preBrowserChatSettings(rootDir)));

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  const byId = new Map(loaded.aiModels.map((model) => [model.id, model]));
  assert.equal(byId.get('claude-web-chat')?.provider, 'claude-web');
  assert.equal(byId.get('chatgpt-web-chat')?.provider, 'chatgpt-web');
  assert.ok(byId.has('openai-gpt-5-1'), 'the operator\'s own rows are untouched');

  // The stored default named the locked seat. It is repointed at a FREE model
  // rather than at the first runnable one - which here would have been the
  // metered OpenAI row, and an install must not start billing for a default
  // nobody chose.
  assert.equal(JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY)).defaultModelId, 'claude-web-chat');
  // Read back, that stored row surfaces as the browser entry: the picker no
  // longer offers the per-site model by name, and a default it does not show
  // would render as an empty selection.
  assert.equal(loaded.defaultModelId, 'free-hybrid');
});

test('the browser-chat migration is idempotent', async () => {
  const { rootDir, dbDir } = useTempStorage('lock-migrate-twice');
  lockSeat();
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(preBrowserChatSettings(rootDir)));

  const first = loadFresh('../dist/config/aiModelConfig');
  await first.getAdminAppSettings();
  const afterFirst = readSettingRaw(dbDir, APP_SETTINGS_KEY);

  // Run the migration itself again, as a restart with a lost version stamp
  // would, and then read through the normal path a second time.
  const Database = require('better-sqlite3');
  const { migrate002 } = require('../dist/database/migrations/002_seed_browser_chat_models');
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    const report = migrate002(db);
    assert.equal(report.seededModels, 0);
    assert.equal(report.repointedDefaultModel, false);
  } finally {
    db.close();
  }

  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), afterFirst);
});

test('an install whose only enabled provider is locked is carried by the free ones', async () => {
  const { rootDir, dbDir } = useTempStorage('lock-migrate-rescue');
  lockSeat();
  writeSettingRaw(
    dbDir,
    APP_SETTINGS_KEY,
    JSON.stringify(
      preBrowserChatSettings(rootDir, {
        providersEnabled: {
          'claude-cli': true, claude: false, openai: false, deepseek: false,
        },
      })
    )
  );

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  assert.equal(loaded.providersEnabled['claude-web'], true);
  assert.equal(loaded.providersEnabled['chatgpt-web'], true);
  assert.ok(loaded.aiModels.length > 0);
  // The whole point: something is left that a generate can actually run on.
  const runnable = await config.resolveRequestedAIModel();
  assert.equal(runnable.provider, 'claude-web');
});

test('an operator who already added their own row for a locked-out provider keeps just that one', async () => {
  const { rootDir, dbDir } = useTempStorage('lock-migrate-existing');
  lockSeat();
  const settings = preBrowserChatSettings(rootDir);
  settings.aiModels.push({
    id: 'claude-web-mine',
    name: 'My Claude tab',
    provider: 'claude-web',
    modelName: 'chat',
    description: '',
    enabled: true,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(settings));

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  const claudeWeb = loaded.aiModels.filter((model) => model.provider === 'claude-web');
  assert.deepEqual(claudeWeb.map((model) => model.id), ['claude-web-mine']);
  assert.ok(loaded.aiModels.some((model) => model.id === 'chatgpt-web-chat'), 'the other seed still lands');
});

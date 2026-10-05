const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, readSettingRaw, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * The provider lock.
 *
 * A lock says "this deployment cannot run that provider" - a different claim
 * from the admin's enable switch, and the two must not be able to stand in for
 * one another. What is pinned here is that a locked provider cannot be
 * dispatched to by ANY of the ways a model can be named, that an administrator
 * is still told about it - with the models behind it and why - while an
 * ordinary account simply does not see those models, and that an install
 * locked out of a provider lands on a model that works.
 *
 * Nothing is locked in the shipped catalog - every subscription seat is
 * offered, and the Claude seat is the default. So the subject here is an
 * operator who locks a seat out with AI_LOCKED_PROVIDERS, which is the same
 * machinery the catalog lock used and the case that still happens for real: a
 * box with no `claude` binary signed in. Every provider is a seat now, so what
 * such an install lands on is the next seat - never anything billed per token -
 * and with EVERY seat locked nothing can run at all, which the settings read
 * survives and a run is refused over.
 */

/** Both lock lists are read from the environment on every call; reset between tests. */
function withLock({ locked, unlocked } = {}) {
  if (locked) process.env.AI_LOCKED_PROVIDERS = locked;
  else delete process.env.AI_LOCKED_PROVIDERS;
  if (unlocked) process.env.AI_UNLOCKED_PROVIDERS = unlocked;
  else delete process.env.AI_UNLOCKED_PROVIDERS;
}

/** The case most tests here are about: the Claude seat - the default - locked out by the operator. */
function lockSeat() {
  withLock({ locked: 'claude-cli' });
}

/** Every seat this build has, read from the catalog so a seat added later is locked too. */
function lockEverySeat() {
  const { AI_PROVIDER_IDS } = require('../dist/config/providerCatalog');
  withLock({ locked: AI_PROVIDER_IDS.join(',') });
}

/** A stub adapter that records what it was asked to run. */
const stubAdapter = (id, calls) => () => ({
  id,
  capabilities: {
    id, label: 'stub', temperature: false, maxOutputTokens: false,
    nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
  },
  defaultModelName: () => `${id}-own-default`,
  health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
  async complete(request) {
    calls.push({ provider: id, modelName: request.modelName });
    return { text: '{"ok":true}', resolvedModel: request.modelName, providerId: id, droppedParams: [], latencyMs: 1 };
  },
});

test.beforeEach(() => withLock());
test.after(() => withLock());

test('a seat the operator locked out says so to an administrator, and is simply absent for everyone else', async () => {
  useTempStorage('lock-public');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const user = await config.getUserAppSettings();

  // Not offered as something to run, and not described either: an ordinary
  // account is shown the models it can pick and nothing about why others are
  // missing - the lock reason names CLI commands and .env variables.
  assert.deepEqual(
    user.models.map((model) => model.id),
    ['codex-cli-default', 'gemini-cli-auto'],
    'a locked provider contributes no runnable model'
  );
  assert.equal('providerLocks' in user, false);

  // The administrator is told, with the models it would have offered, so Admin
  // -> Models can say why they do not run rather than leave them looking broken.
  const admin = await config.getAdminAppSettings();
  const lock = admin.providerLocks.find((entry) => entry.id === 'claude-cli');
  assert.ok(lock, 'the lock is reported');
  assert.equal(lock.label, 'Claude (Subscription)');
  assert.match(lock.reason, /subscription seat/i);
  assert.ok(
    lock.models.some((model) => model.id === 'claude-cli-sonnet'),
    'the models behind the lock come with it'
  );

  // And the default is one that can actually run: the next seat's, not a
  // locked model that would fail every generate.
  assert.equal(user.defaultModelId, 'codex-cli-default');
  assert.equal(admin.defaultModelId, 'codex-cli-default');
});

test('the subscription seat is offered, and is the default, when nothing locks it', async () => {
  useTempStorage('lock-seat-offered');
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getUserAppSettings();

  assert.deepEqual((await config.getAdminAppSettings()).providerLocks, [], 'nothing is locked in the shipped catalog');
  assert.ok(
    settings.models.some((model) => model.id === 'claude-cli-sonnet'),
    'the CLI seat is pickable'
  );
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
});

test('AI_UNLOCKED_PROVIDERS lifts the lock', async () => {
  useTempStorage('lock-unlocked');
  // Named in both lists. Unlock wins, so the escape hatch stays an escape hatch.
  withLock({ locked: 'claude-cli', unlocked: 'claude-cli' });
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getUserAppSettings();

  assert.deepEqual((await config.getAdminAppSettings()).providerLocks, []);
  assert.ok(settings.models.some((model) => model.id === 'claude-cli-sonnet'));
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
});

test('every way of naming a locked model is refused, and says why', async () => {
  useTempStorage('lock-resolve');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');

  // By model id, by bare provider id, and by the "provider:modelName" form -
  // three separate branches in the resolver, and a lock that only closed one
  // of them would be no lock at all. The last two are an administrator's forms.
  // Everyone is told the same one sentence; the cause is the detail, which only
  // an administrator is sent.
  for (const requested of ['claude-cli-sonnet', 'claude-cli', 'claude-cli:sonnet']) {
    await assert.rejects(
      () => config.resolveRequestedAIModel(requested, { admin: true }),
      {
        name: 'ModelUnavailableError',
        message: "That model isn't available. Choose another, or contact your administrator.",
        detail: /locked in this installation/i,
      },
      `naming the model as "${requested}" is refused`
    );
  }

  // A model that is merely provider-disabled still reports as disabled: the
  // two causes point at different fixes and must not be merged.
  withLock();
  await config.updateAppSettings({ providersEnabled: { 'claude-cli': true, 'codex-cli': false } });
  await assert.rejects(() => config.resolveRequestedAIModel('codex-cli-default'), {
    name: 'ModelUnavailableError',
    detail: /disabled by admin/i,
  });
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
  // The first seat that can run, in catalog order. Every provider is a seat, so
  // nothing down the list bills per token.
  assert.equal(config.getDefaultEnabledProvider(settings), 'codex-cli');
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
  // It lands on the app default, which with the Claude seat locked is the next seat's.
  assert.equal(stored.provider, 'codex-cli');
  assert.equal(stored.modelId, 'codex-cli-default');

  // Named in THIS request, it is refused instead - somebody just picked it,
  // and quietly running something else would also quietly charge another
  // model's price.
  await assert.rejects(() => preferences.resolveAiChoice({ modelId: 'claude-cli-sonnet' }, null), {
    name: 'ModelUnavailableError',
    detail: /locked in this installation/i,
  });

  // A stored id whose provider an administrator merely switched off is stale in
  // the same way: its owner did not do it and cannot see why, since an ordinary
  // account is only ever shown the models that run. It falls back too, and the
  // log names the cause for the administrator who can fix it.
  withLock();
  await config.updateAppSettings({ providersEnabled: { 'claude-cli': true, 'codex-cli': false } });
  const offSeat = await preferences.resolveAiChoice(undefined, {
    profileSettings: { ai: { modelId: 'codex-cli-default' } },
  });
  assert.equal(offSeat.modelId, 'claude-cli-sonnet');
});

test('settings that would leave only locked providers enabled are refused', async () => {
  useTempStorage('lock-assert');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () =>
      config.updateAppSettings({ providersEnabled: { 'claude-cli': true, 'codex-cli': false, 'gemini-cli': false } }),
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
  const calls = [];
  ai.registerAdapter('codex-cli', stubAdapter('codex-cli', calls));

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'A job' },
    fallbackProvider: 'codex-cli',
    fallbackModelName: 'gpt-6-luna',
    useExactPromptId: true,
  });

  assert.deepEqual(calls, [{ provider: 'codex-cli', modelName: 'gpt-6-luna' }], "the call ran on the caller's provider");
});

test('with only the Claude seat locked, a fresh install defaults to the next seat', async () => {
  useTempStorage('lock-one-seat');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getUserAppSettings();

  assert.equal(settings.defaultModelId, 'codex-cli-default');
  assert.equal(config.getDefaultEnabledProvider(await config.getAIModelSettings()), 'codex-cli');
});

test('a call that names no provider runs on the app default MODEL, not on a seat\'s own default', async () => {
  // The bid assistant names no provider, so every call it makes is rerouted
  // off the locked seat - onto what the settings page shows as the default, so
  // the model an administrator chose is the one it runs on.
  useTempStorage('lock-raw-default');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const calls = [];
  ai.registerAdapter('codex-cli', stubAdapter('codex-cli', calls));

  await ai.createRawCompletion({ callSite: 'bid-assistant', system: 'Be brief.', user: 'Hello.' });
  assert.deepEqual(calls, [{ provider: 'codex-cli', modelName: 'default' }], "the seed default's model name");

  // An administrator's own model as the default: that is what runs. On a
  // database of its own, because the facade reads settings through its own
  // module instance, whose short cache is keyed on the database path.
  useTempStorage('lock-raw-default-own-model');
  const created = await config.createAIModel({ name: 'Luna', provider: 'codex-cli', modelName: 'gpt-6-luna', pricePerResumeUsd: '0.010' });
  const luna = created.aiModels.find((model) => model.modelName === 'gpt-6-luna');
  await config.updateAppSettings({ defaultModelId: luna.id });
  calls.length = 0;
  await ai.createRawCompletion({ callSite: 'bid-assistant', system: 'Be brief.', user: 'Hello.' });
  assert.deepEqual(calls, [{ provider: 'codex-cli', modelName: 'gpt-6-luna' }]);
});

test('with every seat locked, settings still read - no runnable model, the locks listed - and a run is refused', async () => {
  // Nothing metered is left to fall back on, so a box with no CLI signed in at
  // all is a real state. Refusing every settings READ would take down the admin
  // pages that say why; the read degrades instead, and saves keep the assert.
  const { dbDir } = useTempStorage('lock-every-seat');
  const config = loadFresh('../dist/config/aiModelConfig');
  await config.updateAppSettings({ defaultTheme: 'dark' });
  const stored = readSettingRaw(dbDir, 'app-settings');

  lockEverySeat();
  config.invalidateSettingsCache();
  const { AI_PROVIDER_IDS } = require('../dist/config/providerCatalog');

  const user = await config.getUserAppSettings();
  assert.deepEqual(user.models, [], 'nothing is offered to run');
  assert.equal(user.defaultModelId, '');
  assert.equal(user.defaultTheme, 'dark', 'the rest of the row reads as stored');

  const admin = await config.getAdminAppSettings();
  assert.deepEqual(admin.providerLocks.map((lock) => lock.id), [...AI_PROVIDER_IDS]);
  assert.ok(admin.aiModels.some((model) => model.id === 'claude-cli-sonnet'), 'the admin still sees every model');
  assert.equal(readSettingRaw(dbDir, 'app-settings'), stored, 'reading does not rewrite the row');
  assert.equal(
    JSON.parse(stored).defaultModelId,
    'claude-cli-sonnet',
    'the stored default is kept, so lifting the lock restores it'
  );

  // Everybody is told only who can fix it; the locks are the administrator's
  // detail, and the 503 says it is the installation, not the request.
  await assert.rejects(
    () => config.resolveRequestedAIModel(),
    (error) =>
      error.status === 503 &&
      error.code === 'ai-unavailable' &&
      error.message === "AI generation isn't available right now. Please contact your administrator." &&
      /every AI provider is locked/i.test(error.detail)
  );
  await assert.rejects(() => config.updateAppSettings({ defaultTheme: 'light' }), /unlocked AI provider/i);

  // A fresh install with every seat locked reads too.
  useTempStorage('lock-every-seat-fresh');
  const fresh = loadFresh('../dist/config/aiModelConfig');
  assert.deepEqual((await fresh.getUserAppSettings()).models, []);
});

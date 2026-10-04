const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * The provider lock.
 *
 * A lock says "this deployment cannot run that provider" - a different claim
 * from the admin's enable switch, and the two must not be able to stand in for
 * one another. What is pinned here is that a locked provider cannot be
 * dispatched to by ANY of the ways a model can be named, that the UI is still
 * told about it so it can show a padlock rather than silently dropping the
 * model, and that an install locked out of a provider lands on a model that
 * works.
 *
 * Nothing is locked in the shipped catalog any more - both subscription seats
 * are offered, and the Claude seat is the default. So the subject here is an
 * operator who locks the seats out with AI_LOCKED_PROVIDERS, which is the same
 * machinery the catalog lock used and the case that still happens for real: a
 * box with no `claude` or `codex` binary signed in. With both seats locked
 * nothing keyless is left, so what such an install lands on is a METERED
 * provider: it runs once a key is in .env, and it bills for what it runs.
 */

/** Both lock lists are read from the environment on every call; reset between tests. */
function withLock({ locked, unlocked } = {}) {
  if (locked) process.env.AI_LOCKED_PROVIDERS = locked;
  else delete process.env.AI_LOCKED_PROVIDERS;
  if (unlocked) process.env.AI_UNLOCKED_PROVIDERS = unlocked;
  else delete process.env.AI_UNLOCKED_PROVIDERS;
}

/**
 * The case every test here is about: the CLI seats locked out by the operator.
 *
 * BOTH of them, because there are two now - the Claude subscription and the
 * ChatGPT one - and the subject is a box with no CLI seat signed in at all.
 * Locking one alone stopped testing that: the fallback simply landed on the
 * other seat, which is correct behaviour and not what these assertions are
 * about.
 */
function lockSeat() {
  withLock({ locked: 'claude-cli,codex-cli' });
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

  // And the default is one that can actually run. With both seats locked
  // nothing free is left, so it is the first metered model in the seed list -
  // not a locked model that would fail every generate.
  assert.equal(settings.defaultModelId, 'openai-gpt-5-1');
  assert.ok(settings.aiModels.some((model) => model.id === settings.defaultModelId));
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
    providersEnabled: { 'claude-cli': true, claude: true, openai: false, deepseek: true },
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
  // Keyless first - and with both seats locked there is no keyless provider
  // left, so the fallback is the first unlocked one in catalog order: the
  // metered Anthropic API.
  assert.equal(config.getDefaultEnabledProvider(settings), 'claude');
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
  // It lands on the app default, which with both seats locked is metered.
  assert.equal(stored.provider, 'openai');
  assert.equal(stored.modelId, 'openai-gpt-5-1');

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
    providersEnabled: { 'claude-cli': true, claude: true, openai: false, deepseek: true },
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
          'claude-cli': true, 'codex-cli': true, claude: false, openai: false, deepseek: false,
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

test('with only the Claude seat locked, the default is the other seat rather than a metered model', async () => {
  // The case the keyless-first rule is for. Locking one seat must move a fresh
  // install onto the seat that is left, not onto the first model that bills.
  useTempStorage('lock-one-seat');
  withLock({ locked: 'claude-cli' });
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getPublicAppSettings();

  assert.equal(settings.defaultModelId, 'codex-cli-default');
  assert.equal(config.getDefaultEnabledProvider(await config.getAIModelSettings()), 'codex-cli');
});

test('a call that names no provider runs on the app default once no seat is left', async () => {
  // The bid assistant names no provider, so every call it makes is rerouted
  // off the locked seat. A keyless seat still wins when one is left; with both
  // locked there is none, and catalog order alone put the call on the Anthropic
  // API while the app default was an OpenAI model - billing a provider nobody
  // picked, or failing with a sign-in message for a seat that is locked. It
  // runs on what the settings page shows as the default instead.
  useTempStorage('lock-raw-default');
  lockSeat();
  const config = loadFresh('../dist/config/aiModelConfig');
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();

  const calls = [];
  const stub = (id) => () => ({
    id,
    capabilities: {
      id, label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, requiresApiKey: false,
      credentialKind: 'api-key', maxConcurrency: 4,
    },
    defaultModelName: () => `${id}-own-default`,
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      calls.push({ provider: id, modelName: request.modelName });
      return { text: '{"ok":true}', resolvedModel: request.modelName, providerId: id, droppedParams: [], latencyMs: 1 };
    },
  });
  for (const id of ['codex-cli', 'claude', 'openai', 'deepseek']) ai.registerAdapter(id, stub(id));

  const expected = await config.resolveRequestedAIModel();
  assert.equal(expected.provider, 'openai', 'the default with both seats locked');
  await ai.createRawCompletion({ callSite: 'bid-assistant', system: 'Be brief.', user: 'Hello.' });
  assert.deepEqual(calls, [{ provider: 'openai', modelName: expected.modelName }]);

  // One seat left: the free seat beats the metered default, on its own model.
  withLock({ locked: 'claude-cli' });
  calls.length = 0;
  await ai.createRawCompletion({ callSite: 'bid-assistant', system: 'Be brief.', user: 'Hello.' });
  assert.deepEqual(calls, [{ provider: 'codex-cli', modelName: 'codex-cli-own-default' }]);
});

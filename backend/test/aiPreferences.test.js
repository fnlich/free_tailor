const assert = require('node:assert/strict');
const test = require('node:test');

const {
  APP_DEFAULT_THINKING,
  appDefaultEffort,
  describeAiChoice,
  describeAiPreferenceDefaults,
  isThinkingMode,
  mergeAiPreferences,
  normalizeAiPreferences,
} = require('../dist/config/aiPreferences');
const { buildChildEnv } = require('../dist/services/ai/providers/claudeCli/env');
const {
  collectUnsupportedReasoningParams,
} = require('../dist/services/ai/reasoningParams');
const { normalizeProfileSettings } = require('../dist/services/profileService');

test('only values this build understands survive normalization', () => {
  assert.deepEqual(
    normalizeAiPreferences({ modelId: '  model-1  ', effort: 'max', thinking: 'off' }),
    { modelId: 'model-1', effort: 'max', thinking: 'off' }
  );
  // An unknown level must not reach the CLI, which would reject the call.
  assert.deepEqual(normalizeAiPreferences({ effort: 'ludicrous', thinking: 'sometimes' }), {});
  assert.deepEqual(normalizeAiPreferences({ modelId: '   ' }), {});
  assert.deepEqual(normalizeAiPreferences(null), {});
  assert.deepEqual(normalizeAiPreferences('nonsense'), {});
});

test('an absent field inherits rather than resetting the layer beneath it', () => {
  // The request names only the effort, so the profile's model has to survive.
  assert.deepEqual(
    mergeAiPreferences({ modelId: 'from-profile', effort: 'low' }, { effort: 'max' }),
    { modelId: 'from-profile', effort: 'max' }
  );
  assert.deepEqual(mergeAiPreferences({ thinking: 'off' }, {}), { thinking: 'off' });
  assert.deepEqual(mergeAiPreferences(undefined, undefined), {});
});

test('the app default effort is read from the variable the provider reads', () => {
  assert.equal(appDefaultEffort({ AI_CLI_EFFORT: 'xhigh' }), 'xhigh');
  // Junk falls back rather than being passed to the CLI.
  assert.equal(appDefaultEffort({ AI_CLI_EFFORT: 'turbo' }), 'low');
  assert.equal(appDefaultEffort({}), 'low');
});

test('the defaults sent to the UI list what may be chosen', () => {
  const defaults = describeAiPreferenceDefaults({ AI_CLI_EFFORT: 'high' });
  assert.equal(defaults.effort, 'high');
  assert.equal(defaults.thinking, APP_DEFAULT_THINKING);
  assert.deepEqual([...defaults.effortLevels], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...defaults.thinkingModes], ['default', 'off']);
  assert.ok(isThinkingMode(defaults.thinking));
});

// Thinking has no CLI flag. The budget variable is the only control, and this
// is the one place it is set, so it is worth asserting directly.
test('thinking off sets the budget to zero, and default sets nothing', () => {
  assert.equal(buildChildEnv({ PATH: '/usr/bin' }, { thinking: 'off' }).MAX_THINKING_TOKENS, '0');
  assert.equal(
    buildChildEnv({ PATH: '/usr/bin' }, { thinking: 'default' }).MAX_THINKING_TOKENS,
    undefined
  );
  assert.equal(buildChildEnv({ PATH: '/usr/bin' }).MAX_THINKING_TOKENS, undefined);
});

test("the operator's own thinking budget cannot override the chosen one", () => {
  const parent = { PATH: '/usr/bin', MAX_THINKING_TOKENS: '30000' };
  // Inherited, it would silently win over a profile that asked for thinking
  // off - and over the app's default of leaving the model alone.
  assert.equal(buildChildEnv(parent).MAX_THINKING_TOKENS, undefined);
  assert.equal(buildChildEnv(parent, { thinking: 'default' }).MAX_THINKING_TOKENS, undefined);
  assert.equal(buildChildEnv(parent, { thinking: 'off' }).MAX_THINKING_TOKENS, '0');
  // The rest of the environment is untouched.
  assert.equal(buildChildEnv(parent).PATH, '/usr/bin');
});

test('a provider that cannot honour these says so instead of ignoring them', () => {
  const capable = { id: 'claude-cli', label: 'Claude CLI', effort: true, thinking: true };
  const incapable = { id: 'openai', label: 'OpenAI', effort: false, thinking: false };

  assert.deepEqual(
    collectUnsupportedReasoningParams({ effort: 'max', thinking: 'off', callSite: 'x' }, capable),
    []
  );
  assert.deepEqual(
    collectUnsupportedReasoningParams({ effort: 'max', thinking: 'off', callSite: 'y' }, incapable),
    ['effort', 'thinking']
  );
  // `default` is the absence of a request, so there is nothing to drop.
  assert.deepEqual(
    collectUnsupportedReasoningParams({ thinking: 'default', callSite: 'z' }, incapable),
    []
  );
  assert.deepEqual(collectUnsupportedReasoningParams({ callSite: 'w' }, incapable), []);
});

test('a profile stores the preferences, and keeps them when a client omits them', () => {
  const saved = normalizeProfileSettings({ ai: { modelId: 'm-1', effort: 'high' } });
  assert.deepEqual(saved.ai, { modelId: 'm-1', effort: 'high' });

  // A client that predates these fields sends profileSettings without `ai`.
  // Blanking the profile's choice on every such save would be a data loss bug.
  const afterOlderClientSave = normalizeProfileSettings({ hardSkillOrdering: 'library' }, saved);
  assert.deepEqual(afterOlderClientSave.ai, { modelId: 'm-1', effort: 'high' });

  // Explicitly clearing still works.
  const cleared = normalizeProfileSettings({ ai: {} }, saved);
  assert.deepEqual(cleared.ai, {});
});

test('the log line names what a run actually used', () => {
  assert.equal(
    describeAiChoice({ provider: 'claude-cli', modelName: 'sonnet', effort: 'max', thinking: 'off' }),
    'claude-cli/sonnet effort=max thinking=off'
  );
  // Inherited values are absent rather than guessed at.
  assert.equal(
    describeAiChoice({ provider: 'claude-cli', modelName: 'sonnet' }),
    'claude-cli/sonnet'
  );
});

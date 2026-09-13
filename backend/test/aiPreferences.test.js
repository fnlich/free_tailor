const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appDefaultEffort,
  describeAiChoice,
  describeAiPreferenceDefaults,
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
    normalizeAiPreferences({ modelId: '  model-1  ', effort: 'max' }),
    { modelId: 'model-1', effort: 'max' }
  );
  // An unknown level must not reach the CLI, which would reject the call.
  assert.deepEqual(normalizeAiPreferences({ effort: 'ludicrous' }), {});

  // An ALLOW-LIST, which is what makes the removed `thinking` knob a non-event
  // for an existing install: a profile that still stores one is read without it
  // and saved without it, so no migration was needed.
  assert.deepEqual(
    normalizeAiPreferences({ modelId: 'm-1', effort: 'high', thinking: 'off' }),
    { modelId: 'm-1', effort: 'high' }
  );
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
  assert.deepEqual(mergeAiPreferences({ modelId: 'only-a-model' }, {}), { modelId: 'only-a-model' });
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
  assert.deepEqual([...defaults.effortLevels], ['low', 'medium', 'high', 'xhigh', 'max']);
  // Model and effort are the whole of it now.
  assert.deepEqual(Object.keys(defaults).sort(), ['effort', 'effortLevels']);
});

/**
 * Nothing sets the thinking budget any more, and the strip is what keeps it
 * that way.
 *
 * The per-profile thinking knob is gone, so the CLI is left to think
 * adaptively - its own default. An operator who happens to have exported
 * MAX_THINKING_TOKENS must not be able to make one machine answer differently
 * from another, which is the whole reason the strip outlived the setting.
 */
test('the thinking budget is never set, and an exported one is stripped', () => {
  assert.equal(buildChildEnv({ PATH: '/usr/bin' }).MAX_THINKING_TOKENS, undefined);

  const parent = { PATH: '/usr/bin', MAX_THINKING_TOKENS: '30000' };
  assert.equal(buildChildEnv(parent).MAX_THINKING_TOKENS, undefined);
  // The rest of the environment is untouched.
  assert.equal(buildChildEnv(parent).PATH, '/usr/bin');
});

test('a provider that cannot honour effort says so instead of ignoring it', () => {
  const capable = { id: 'claude-cli', label: 'Claude CLI', effort: true };
  const incapable = { id: 'openai', label: 'OpenAI', effort: false };

  assert.deepEqual(collectUnsupportedReasoningParams({ effort: 'max', callSite: 'x' }, capable), []);
  assert.deepEqual(
    collectUnsupportedReasoningParams({ effort: 'max', callSite: 'y' }, incapable),
    ['effort']
  );
  // Asking for nothing drops nothing.
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
    describeAiChoice({ provider: 'claude-cli', modelName: 'sonnet', effort: 'max' }),
    'claude-cli/sonnet effort=max'
  );
  // Inherited values are absent rather than guessed at.
  assert.equal(
    describeAiChoice({ provider: 'claude-cli', modelName: 'sonnet' }),
    'claude-cli/sonnet'
  );
});

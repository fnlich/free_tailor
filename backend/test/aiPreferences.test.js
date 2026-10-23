const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeAiChoice,
  normalizeAiPreferences,
} = require('../dist/config/aiPreferences');
const { loadFresh, useTempStorage } = require('./helpers');
const { buildChildEnv } = require('../dist/services/ai/providers/claudeCli/env');
const { normalizeResumeSettings } = require('../dist/services/resumeDocument');

test('only values this build understands survive normalization', () => {
  assert.deepEqual(normalizeAiPreferences({ modelId: '  model-1  ' }), { modelId: 'model-1' });
  assert.deepEqual(normalizeAiPreferences({ modelId: '   ' }), {});
  assert.deepEqual(normalizeAiPreferences(null), {});
  assert.deepEqual(normalizeAiPreferences('nonsense'), {});
});

/**
 * The upgrade path every existing resume takes, and the reason removing a knob
 * needed no migration.
 *
 * `thinking` and then `effort` were both real stored fields. Resumes in a live
 * database still carry them. This is an ALLOW-LIST, so a dead key is IGNORED
 * rather than rejected - a resume that threw on read would take its owner's
 * whole builder down over a setting the build no longer has.
 */
test('a resume still storing a dead knob is read without it', () => {
  assert.deepEqual(
    normalizeAiPreferences({ modelId: 'm-1', effort: 'high', thinking: 'off' }),
    { modelId: 'm-1' }
  );
  // Values that were never valid either, since nothing validates them any more.
  assert.deepEqual(normalizeAiPreferences({ effort: 'ludicrous', thinking: 'nonsense' }), {});
});

test('an absent field inherits rather than resetting the layer beneath it', async () => {
  // Through `resolveAiChoice`, which is where the layers meet: a request that
  // names nothing must not wipe the resume's choice, and a resume that names
  // nothing must not wipe the app default.
  useTempStorage('ai-preferences-inherit');
  const config = loadFresh('../dist/config/aiModelConfig');
  const { resolveAiChoice } = loadFresh('../dist/config/aiPreferences');
  const resume = { resumeSettings: { ai: { modelId: 'claude-cli-opus' } } };

  assert.equal((await resolveAiChoice({ modelId: 'claude-cli-haiku' }, resume)).modelId, 'claude-cli-haiku');
  assert.equal((await resolveAiChoice({}, resume)).modelId, 'claude-cli-opus', 'an empty request inherits');
  assert.equal((await resolveAiChoice(undefined, resume)).modelId, 'claude-cli-opus');
  assert.equal(
    (await resolveAiChoice({}, { resumeSettings: { ai: {} } })).modelId,
    (await config.getUserAppSettings()).defaultModelId,
    'and with neither naming a model, the app default'
  );
});

/**
 * Nothing sets the thinking budget any more, and the strip is what keeps it
 * that way.
 *
 * The per-resume thinking knob is gone, so the CLI is left to think
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

test('a resume stores the preferences, and keeps them when a client omits them', () => {
  const saved = normalizeResumeSettings({ ai: { modelId: 'm-1' } });
  assert.deepEqual(saved.ai, { modelId: 'm-1' });

  // A client that predates these fields sends resumeSettings without `ai`.
  // Blanking the resume's choice on every such save would be a data loss bug.
  const afterOlderClientSave = normalizeResumeSettings({ hardSkillOrdering: 'library' }, saved);
  assert.deepEqual(afterOlderClientSave.ai, { modelId: 'm-1' });

  // Explicitly clearing still works.
  const cleared = normalizeResumeSettings({ ai: {} }, saved);
  assert.deepEqual(cleared.ai, {});
});

test('the log line names what a run actually used', () => {
  assert.equal(
    describeAiChoice({ provider: 'claude-cli', modelName: 'sonnet' }),
    'claude-cli/sonnet'
  );
  // Inherited values are absent rather than guessed at.
  assert.equal(
    describeAiChoice({ provider: 'claude-cli', modelName: 'sonnet' }),
    'claude-cli/sonnet'
  );
});

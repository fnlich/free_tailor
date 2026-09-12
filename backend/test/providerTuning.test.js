const assert = require('node:assert/strict');
const test = require('node:test');

const {
  providerSupportsEffort,
  providerSupportsThinking,
  AI_PROVIDER_IDS,
} = require('../dist/config/providerCatalog');
const { listProviderTuningSupport } = require('../dist/config/aiModelConfig');

/**
 * Which tuning knobs reach which provider.
 *
 * The reason this is a fact about the provider rather than a fact about the
 * adapter: the picker needs it, and the picker cannot reach an adapter. Keeping
 * the two in step is what these check - a menu that greys a control the
 * transport would have honoured, or offers one it silently drops, is worse than
 * either behaviour on its own.
 */

test('a chat window honours neither knob', () => {
  // There is nowhere in a chat window to put an effort flag or a thinking
  // budget. Offering the selects anyway let a profile be saved asking for
  // effort=max on ChatGPT, where it changed nothing and said nothing.
  for (const site of ['claude-web', 'chatgpt-web']) {
    assert.equal(providerSupportsEffort(site), false, `${site} has no effort flag`);
    assert.equal(providerSupportsThinking(site), false, `${site} has no thinking budget`);
  }
});

test('the subscription seat honours both', () => {
  // `--effort` is a documented flag on the CLI, and thinking is what
  // MAX_THINKING_TOKENS controls.
  assert.equal(providerSupportsEffort('claude-cli'), true);
  assert.equal(providerSupportsThinking('claude-cli'), true);
});

test('the metered HTTP providers honour neither', () => {
  for (const provider of ['claude', 'openai', 'deepseek']) {
    assert.equal(providerSupportsEffort(provider), false);
    assert.equal(providerSupportsThinking(provider), false);
  }
});

test('every provider has an answer, so no picker has to guess', () => {
  const tuning = listProviderTuningSupport();
  assert.equal(tuning.length, AI_PROVIDER_IDS.length);
  for (const id of AI_PROVIDER_IDS) {
    const row = tuning.find((entry) => entry.provider === id);
    assert.ok(row, `${id} is missing from the tuning report`);
    assert.equal(typeof row.effort, 'boolean');
    assert.equal(typeof row.thinking, 'boolean');
  }
});

test('the adapters report the same answer the pickers are given', () => {
  // Two sources of truth would show up as a select greyed on one screen and
  // live on another, and only the transport would be right.
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  for (const capability of ai.listProviderCapabilities()) {
    assert.equal(
      capability.effort,
      providerSupportsEffort(capability.id),
      `${capability.id} disagrees with the catalog about effort`
    );
    assert.equal(
      capability.thinking,
      providerSupportsThinking(capability.id),
      `${capability.id} disagrees with the catalog about thinking`
    );
  }
});

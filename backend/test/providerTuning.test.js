const assert = require('node:assert/strict');
const test = require('node:test');

const { providerSupportsEffort, AI_PROVIDER_IDS } = require('../dist/config/providerCatalog');
const { listProviderTuningSupport } = require('../dist/config/aiModelConfig');
const { normalizeAiPreferences } = require('../dist/config/aiPreferences');

/**
 * Which tuning knob reaches which provider.
 *
 * The reason this is a fact about the provider rather than a fact about the
 * adapter: the picker needs it, and the picker cannot reach an adapter. Keeping
 * the two in step is what these check - a menu that greys a control the
 * transport would have honoured, or offers one it silently drops, is worse than
 * either behaviour on its own.
 */

test('a chat window honours no effort flag', () => {
  // There is nowhere in a chat window to put one. Offering the select anyway
  // let a profile be saved asking for effort=max on ChatGPT, where it changed
  // nothing and said nothing.
  for (const site of ['claude-web', 'chatgpt-web']) {
    assert.equal(providerSupportsEffort(site), false, `${site} has no effort flag`);
  }
});

test('the subscription seat is the one provider that honours effort', () => {
  assert.equal(providerSupportsEffort('claude-cli'), true);
});

test('the metered HTTP providers honour no effort flag', () => {
  for (const provider of ['claude', 'openai', 'deepseek']) {
    assert.equal(providerSupportsEffort(provider), false);
  }
});

test('every provider has an answer, so no picker has to guess', () => {
  const tuning = listProviderTuningSupport();
  assert.equal(tuning.length, AI_PROVIDER_IDS.length);
  for (const id of AI_PROVIDER_IDS) {
    const row = tuning.find((entry) => entry.provider === id);
    assert.ok(row, `${id} is missing from the tuning report`);
    assert.equal(typeof row.effort, 'boolean');
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
  }
});

/**
 * The upgrade path every existing profile takes.
 *
 * `thinking` was a real stored field until this release, so profiles in a live
 * database still carry one. It has to be IGNORED, not rejected: a profile that
 * threw on read would take its owner's whole builder down over a dead key.
 */
test('a profile still storing a thinking mode is read without it', () => {
  const stored = { modelId: 'claude-cli-sonnet', effort: 'high', thinking: 'off' };
  assert.deepEqual(normalizeAiPreferences(stored), {
    modelId: 'claude-cli-sonnet',
    effort: 'high',
  });

  // Even a value that was never valid, since nothing validates it any more.
  assert.deepEqual(normalizeAiPreferences({ thinking: 'nonsense' }), {});
});

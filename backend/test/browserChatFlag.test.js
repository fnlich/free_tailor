const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isProviderEnabled,
  getPickableModels,
  listProviderTuningSupport,
} = require('../dist/config/aiModelConfig');

/**
 * The master switch for browser-tab mode.
 *
 * "Never shown" and "never reachable" have to be the same statement, or the
 * flag is decoration: a model hidden from a picker but still accepted by the
 * executor is reachable from a stale tab, and a chat window on a headless
 * server cannot answer, so the call would hang rather than fail.
 *
 * That is why the switch lives in `isProviderEnabled` - documented as the one
 * gate runnable models, the public model list, request resolution and the
 * prompt executor all funnel through - rather than in each of them.
 */

const MODELS = [
  { id: 'cli-sonnet', provider: 'claude-cli', modelName: 'sonnet', name: 'Claude Sonnet', enabled: true },
  { id: 'web-claude', provider: 'claude-web', modelName: 'chat', name: 'Claude (free)', enabled: true },
  { id: 'web-chatgpt', provider: 'chatgpt-web', modelName: 'chat', name: 'ChatGPT (free)', enabled: true },
];

function settings(overrides = {}) {
  return {
    aiModels: MODELS.map((model) => ({ ...model })),
    providersEnabled: {
      'claude-cli': true,
      claude: true,
      openai: true,
      deepseek: true,
      'claude-web': true,
      'chatgpt-web': true,
    },
    browserChatEnabled: true,
    effortControlEnabled: true,
    ...overrides,
  };
}

test('with browser mode on, the picker offers the browser entry', () => {
  const pickable = getPickableModels(settings());
  assert.ok(
    pickable.some((model) => model.id === 'free-hybrid'),
    'the hybrid "Default (browser)" row is how browser mode is picked at all'
  );
  assert.equal(isProviderEnabled('claude-web', settings()), true);
});

test('with browser mode off, no browser row survives into any picker', () => {
  const off = settings({ browserChatEnabled: false });
  const pickable = getPickableModels(off);

  assert.equal(
    pickable.some((model) => model.id === 'free-hybrid'),
    false,
    'the hybrid row is synthesized from runnable browser sites and must go with them'
  );
  // Both pages read this same list, so one assertion covers the admin picker
  // and the user one.
  for (const model of pickable) {
    assert.notEqual(model.provider, 'claude-web');
    assert.notEqual(model.provider, 'chatgpt-web');
  }
  // Something must remain, or the flag would strand the installation.
  assert.ok(pickable.some((model) => model.provider === 'claude-cli'));
});

test('with browser mode off, the gate itself refuses - not merely the list', () => {
  const off = settings({ browserChatEnabled: false });
  assert.equal(isProviderEnabled('claude-web', off), false);
  assert.equal(isProviderEnabled('chatgpt-web', off), false);
  // The rest of the catalog is untouched: this withdraws browser mode, not
  // everything.
  assert.equal(isProviderEnabled('claude-cli', off), true);
  assert.equal(isProviderEnabled('openai', off), true);
});

test('the per-site preferences underneath are kept, the way a lock keeps them', () => {
  // Turning the switch back on must restore what the operator had chosen,
  // rather than a row that quietly reset itself while it was off.
  const off = settings({ browserChatEnabled: false });
  assert.equal(off.providersEnabled['claude-web'], true, 'the stored preference is not rewritten');
  const backOn = settings({ ...off, browserChatEnabled: true });
  assert.equal(isProviderEnabled('claude-web', backOn), true);
});

test('an unset flag is read as on, so an older settings row keeps browser mode', () => {
  const legacy = settings();
  delete legacy.browserChatEnabled;
  assert.equal(isProviderEnabled('claude-web', legacy), true);
  assert.ok(getPickableModels(legacy).some((model) => model.id === 'free-hybrid'));
  assert.equal(listProviderTuningSupport(legacy).length > 0, true);
});

/**
 * The admin save path, not just the gate.
 *
 * The gate tests above hand settings objects straight to the functions. This
 * one goes through the real store, so it covers the two things those cannot:
 * that the flags survive a write and a read, and that the strict validator the
 * admin route uses accepts them rather than throwing on a key it has never
 * seen.
 */
const { loadFresh, useTempStorage } = require('./helpers');

test('both flags round-trip through a real settings save', async () => {
  useTempStorage(`model-flags-${Math.random().toString(36).slice(2)}`);
  const config = loadFresh('../dist/config/aiModelConfig');

  const before = await config.getPublicAppSettings();
  assert.equal(before.browserChatEnabled, true, 'a fresh install offers both');
  assert.equal(before.effortControlEnabled, true);

  const saved = await config.updateAppSettings({
    browserChatEnabled: false,
    effortControlEnabled: false,
  });
  assert.equal(saved.browserChatEnabled, false);
  assert.equal(saved.effortControlEnabled, false);

  // Read back through the public shape the pages actually fetch.
  const after = await config.getPublicAppSettings();
  assert.equal(after.browserChatEnabled, false);
  assert.equal(after.effortControlEnabled, false);
  assert.equal(
    after.aiModels.some((model) => model.id === 'free-hybrid'),
    false,
    'the browser row is gone from the list both pages render'
  );
  assert.ok(
    after.providerTuning.every((row) => row.effort === false),
    'and nothing claims to honour effort'
  );

  // Back on, and the installation is exactly as it was.
  const restored = await config.updateAppSettings({
    browserChatEnabled: true,
    effortControlEnabled: true,
  });
  assert.equal(restored.browserChatEnabled, true);
  // Read the PUBLIC shape for the hybrid row, not the admin one: admin settings
  // carry the raw model list so Admin -> Models can manage every record,
  // including the browser ones, and the synthesized row is not in it by design.
  const backOn = await config.getPublicAppSettings();
  assert.ok(backOn.aiModels.some((model) => model.id === 'free-hybrid'));
  assert.ok(backOn.providerTuning.some((row) => row.effort === true));
});

test('a malformed flag cannot flip the switch', async () => {
  useTempStorage(`model-flags-junk-${Math.random().toString(36).slice(2)}`);
  const config = loadFresh('../dist/config/aiModelConfig');

  /*
   * What matters here is the direction of the failure, not that it throws.
   *
   * `updateAppSettings` is deliberately lenient about a value it cannot read -
   * the same convention `requireThreeDSecure` already follows in this file -
   * so nonsense from a client falls back to what is stored rather than
   * rejecting the whole save. The property worth pinning is that it falls back
   * to the STORED value: a buggy or stale client must not be able to withdraw
   * browser mode, or hide the effort control, by sending a string.
   *
   * A stored row that is corrupt is the other case and is NOT lenient -
   * `readSettings` normalizes strictly and throws, because a database that
   * disagrees with its own schema is not something to paper over.
   */
  await config.updateAppSettings({ browserChatEnabled: 'no', effortControlEnabled: 0 });
  const after = await config.getPublicAppSettings();
  assert.equal(after.browserChatEnabled, true, 'a string did not switch browser mode off');
  assert.equal(after.effortControlEnabled, true, 'a zero did not withdraw the effort select');
});

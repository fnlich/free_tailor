const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

/**
 * Every seat is unlocked here, whatever the machine running this says; the
 * tests that are about a lock set one for themselves. The Gemini binary points
 * nowhere, so anything that reached for it would fail loudly rather than spawn.
 * Set before any dist module loads.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
process.env.AI_GEMINI_BIN = '/nonexistent/gemini';

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The Gemini seat, wired in: the third provider in the catalog, the registry
 * and the health card, its own queue lane (queue tests cover that), its
 * settings in the operational table and a fresh-install seed. The adapter
 * itself is geminiCli.test.js's subject.
 */




async function withLocks(locked, fn) {
  const unlocked = process.env.AI_UNLOCKED_PROVIDERS;
  delete process.env.AI_UNLOCKED_PROVIDERS;
  process.env.AI_LOCKED_PROVIDERS = locked;
  try {
    return await fn();
  } finally {
    delete process.env.AI_LOCKED_PROVIDERS;
    process.env.AI_UNLOCKED_PROVIDERS = unlocked;
  }
}

/* ---------------------------------------------------------------- catalog */

test('the catalog is exactly the three subscription seats, in order', () => {
  const catalog = loadFresh('../dist/config/providerCatalog');
  assert.deepEqual([...catalog.AI_PROVIDER_IDS], ['claude-cli', 'codex-cli', 'gemini-cli']);
  assert.deepEqual(
    catalog.AI_PROVIDER_IDS.map((id) => catalog.getProviderLabel(id)),
    ['Claude (Subscription)', 'Codex (Subscription)', 'Gemini (Subscription)']
  );
  const gemini = catalog.getProviderDescriptor('gemini-cli');
  assert.equal(gemini.locked, false, 'offered, like the other two');
  assert.equal(catalog.coerceProviderId(' gemini-cli '), 'gemini-cli');
});

test('a locked Gemini seat says how to sign it in', async () => {
  await withLocks('gemini-cli', async () => {
    const catalog = loadFresh('../dist/config/providerCatalog');
    const reason = catalog.getProviderLockReason('gemini-cli');
    assert.match(reason, /npm i -g @google\/gemini-cli/);
    assert.match(reason, /NO_BROWSER=true gemini/);
    assert.match(reason, /AI_LOCKED_PROVIDERS/);
    assert.equal(catalog.getProviderLockReason('claude-cli'), '');
  });
});

test("a Gemini failure names the Gemini seat to an administrator, not the Claude one", () => {
  const { defaultAdminMessage } = loadFresh('../dist/services/ai/errors');
  for (const kind of ['auth', 'rateLimited', 'binaryMissing']) {
    const message = defaultAdminMessage('gemini-cli', kind);
    assert.match(message, /Gemini/, kind);
    assert.doesNotMatch(message, /Claude|claude auth/, kind);
  }
});

test('the registry builds the Gemini adapter, without running anything', () => {
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const capabilities = ai.listProviderCapabilities();
  const gemini = capabilities.find((entry) => entry.id === 'gemini-cli');
  assert.ok(gemini, 'registered by default');
  assert.equal(gemini.label, 'Gemini (Subscription)');
  assert.equal(typeof ai.getGeminiCliAdapter().outages, 'function');
  assert.deepEqual(ai.getGeminiCliAdapter().outages(), []);

  // An explicit stub holds the id: the typed getter steps aside rather than
  // hand the health card something without the method it reads.
  ai.registerAdapter('gemini-cli', () => ({ id: 'gemini-cli', capabilities: gemini, health: async () => ({}) }));
  assert.equal(ai.getGeminiCliAdapter(), null);
  ai.resetRegistryForTests();
});

/* ------------------------------------------------------------ health card */

test('the admin health card lists the three seats, and the Gemini seat\'s holds', async () => {
  useTempStorage('gemini-seat-health');
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(admin.id);

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const stub = (id) => () => ({
    id,
    capabilities: { id, label: `${id} stub`, temperature: false, maxOutputTokens: false, nativeJsonMode: 'none', systemBlocks: true, maxConcurrency: 1 },
    defaultModelName: () => 'default',
    health: async () => ({ ok: true, detail: `${id} ready`, checkedAt: new Date().toISOString() }),
    seatUsage: () => ({ utilization: null, resetsAt: null, observedAt: null }),
    outages: () => [],
    complete: async () => {
      throw new Error('not here');
    },
  });
  ai.registerAdapter('claude-cli', stub('claude-cli'));
  ai.registerAdapter('codex-cli', stub('codex-cli'));

  // Gemini is the real adapter, locked, so its health is answered without
  // running the binary - and its outage table is still read.
  await withLocks('gemini-cli', async () => {
    const { attachUser } = loadFresh('../dist/middleware/auth');
    const app = express();
    app.use(attachUser);
    app.use('/api/admin/ai', loadFresh('../dist/routes/aiHealth').default);
    const server = app.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/ai/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(
        body.providers.map((provider) => [provider.id, provider.label]),
        [
          ['claude-cli', 'Claude (Subscription)'],
          ['codex-cli', 'Codex (Subscription)'],
          ['gemini-cli', 'Gemini (Subscription)'],
        ]
      );
      const gemini = body.providers.find((provider) => provider.id === 'gemini-cli');
      assert.equal(gemini.ok, false);
      assert.match(gemini.detail, /^Locked in this installation\. Needs the `gemini` CLI/);
      assert.equal(gemini.capabilities.id, 'gemini-cli');
      // Keyed by PROVIDER now, every one listed: a provider that keeps no
      // holds (Codex) reads as none rather than being left out.
      assert.deepEqual(body.outagesByProvider, { 'claude-cli': [], 'codex-cli': [], 'gemini-cli': [] });
    } finally {
      server.close();
      ai.resetRegistryForTests();
    }
  });
});

test('the admin health card asks every seat for a FRESH check, which is what lets it lift a hold', async () => {
  // A seat lifts a sign-in hold only on an uncached reading, so a card that
  // took the minute-old one - the route or the registry dropping the option -
  // would leave a seat that was signed back in held, with every test green.
  useTempStorage('gemini-seat-health-fresh');
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(admin.id);

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const asked = {};
  const stub = (id) => () => ({
    id,
    capabilities: { id, label: `${id} stub`, temperature: false, maxOutputTokens: false, nativeJsonMode: 'none', systemBlocks: true, maxConcurrency: 1 },
    defaultModelName: () => 'default',
    health: async (options) => {
      asked[id] = options;
      return { ok: true, detail: `${id} ready`, checkedAt: new Date().toISOString() };
    },
    seatUsage: () => ({ utilization: null, resetsAt: null, observedAt: null }),
    outages: () => [],
    complete: async () => {
      throw new Error('not here');
    },
  });
  for (const id of ['claude-cli', 'codex-cli', 'gemini-cli']) ai.registerAdapter(id, stub(id));

  const savedLocks = process.env.AI_LOCKED_PROVIDERS;
  delete process.env.AI_LOCKED_PROVIDERS;
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const app = express();
  app.use(attachUser);
  app.use('/api/admin/ai', loadFresh('../dist/routes/aiHealth').default);
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/ai/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(asked, {
      'claude-cli': { fresh: true },
      'codex-cli': { fresh: true },
      'gemini-cli': { fresh: true },
    });
  } finally {
    server.close();
    ai.resetRegistryForTests();
    if (savedLocks === undefined) delete process.env.AI_LOCKED_PROVIDERS;
    else process.env.AI_LOCKED_PROVIDERS = savedLocks;
  }
});

/* ---------------------------------------------------------- operational */

test('every AI_GEMINI_* setting is in the operational table, and a changed one is on the startup line', () => {
  const op = loadFresh('../dist/config/operational');
  const names = op.OPERATIONAL_VARIABLES.map((variable) => variable.name).filter((name) => name.startsWith('AI_GEMINI_'));
  assert.deepEqual(names.sort(), [
    'AI_GEMINI_BIN',
    'AI_GEMINI_CONCURRENCY',
    'AI_GEMINI_FIRST_EVENT_MS',
    'AI_GEMINI_HEALTH_TIMEOUT_MS',
    'AI_GEMINI_HOME',
    'AI_GEMINI_MAX_ATTEMPTS',
    'AI_GEMINI_MAX_OUTPUT_BYTES',
    'AI_GEMINI_MODEL',
    'AI_GEMINI_MODEL_OPTIONS',
    'AI_GEMINI_QUEUE_WAIT_MS',
    'AI_GEMINI_STATE_DIR',
    'AI_GEMINI_TIMEOUT_MS',
    'AI_GEMINI_TIMEOUT_MS_TAILOR',
    'AI_GEMINI_WORKDIR',
  ]);
  assert.equal(op.describeNonDefaultOperationalSettings({}), null);
  assert.match(op.describeNonDefaultOperationalSettings({ AI_GEMINI_CONCURRENCY: '6' }), /AI_GEMINI_CONCURRENCY=6/);
});

test('the Gemini budgets are read through cliTimeoutMs, exactly as the adapter reads them', () => {
  const op = loadFresh('../dist/config/operational');
  const { geminiCliTimeoutMs, readGeminiCliConfig } = loadFresh('../dist/services/ai/providers/geminiCli/options');
  for (const value of [undefined, '240000', '99999999', '1', 'junk']) {
    const env = value === undefined ? {} : { AI_GEMINI_TIMEOUT_MS_TAILOR: value };
    assert.equal(op.cliTimeoutMs('AI_GEMINI_TIMEOUT_MS_TAILOR', env), geminiCliTimeoutMs('AI_GEMINI_TIMEOUT_MS_TAILOR', env));
    assert.equal(
      op.cliTimeoutMs('AI_GEMINI_TIMEOUT_MS_TAILOR', env),
      readGeminiCliConfig(env).timeoutMsByCallSite['tailor-resume'],
      String(value)
    );
  }
  assert.equal(op.cliTimeoutDefaultMs('AI_GEMINI_TIMEOUT_MS'), 180000);
  assert.equal(op.cliTimeoutDefaultMs('AI_GEMINI_TIMEOUT_MS_TAILOR'), 300000);
  assert.equal(op.cliTimeoutDefaultMs('AI_CLI_TIMEOUT_MS_TAILOR'), 300000, 'and the older ones as before');
});

test('a Gemini budget set above the request deadline is reported, like the other seats\'', () => {
  const op = loadFresh('../dist/config/operational');
  const warnings = op.describeAiTimeoutsAboveRequestDeadline({ AI_GEMINI_TIMEOUT_MS_TAILOR: '600000' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /AI_GEMINI_TIMEOUT_MS_TAILOR=600000 is longer than AI_REQUEST_TIMEOUT_MS=300000/);
  // Raised to match, it is silent; at its own default under a lowered deadline,
  // it is a cap nobody chose to exceed.
  assert.deepEqual(
    op.describeAiTimeoutsAboveRequestDeadline({ AI_GEMINI_TIMEOUT_MS_TAILOR: '600000', AI_REQUEST_TIMEOUT_MS: '600000' }),
    []
  );
  assert.deepEqual(
    op.describeAiTimeoutsAboveRequestDeadline({ AI_GEMINI_TIMEOUT_MS: '180000', AI_REQUEST_TIMEOUT_MS: '60000' }),
    []
  );
});

/* ----------------------------------------------------------- fresh seeds */

test('a fresh install seeds every seat, named for people rather than for billing', async () => {
  useTempStorage('gemini-seat-seeds');
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getAdminAppSettings();
  assert.deepEqual(
    settings.aiModels.map((entry) => [entry.id, entry.name, entry.provider, entry.modelName]),
    [
      ['claude-cli-sonnet', 'Claude Sonnet', 'claude-cli', 'sonnet'],
      ['claude-cli-opus', 'Claude Opus', 'claude-cli', 'opus'],
      ['claude-cli-haiku', 'Claude Haiku', 'claude-cli', 'haiku'],
      ['codex-cli-default', 'Codex', 'codex-cli', 'default'],
      ['gemini-cli-auto', 'Gemini', 'gemini-cli', 'auto'],
    ]
  );
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet', 'the default is unchanged');
  assert.ok(settings.aiModels.every((entry) => !entry.name.includes('(subscription)')));
});

test('with the other two seats locked, a fresh install defaults to the Gemini seed', async () => {
  await withLocks('claude-cli,codex-cli', async () => {
    useTempStorage('gemini-seat-seed-default');
    // The seed default is worked out when the module loads.
    const config = loadFresh('../dist/config/aiModelConfig');
    assert.equal((await config.getUserAppSettings()).defaultModelId, 'gemini-cli-auto');
    assert.equal((await config.resolveRequestedAIModel()).provider, 'gemini-cli');
  });
});

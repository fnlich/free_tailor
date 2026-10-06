const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');

/**
 * Every seat is unlocked here, whatever the machine running this says; the
 * tests that are about a lock set one for themselves. The Gemini binary points
 * nowhere, so anything that reached for it would fail loudly rather than spawn.
 * Set before any dist module loads.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
process.env.AI_GEMINI_BIN = '/nonexistent/gemini';

const { loadFresh, readSettingRaw, useAdminEmails, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * The Gemini seat, wired in: the third provider in the catalog, the registry
 * and the health card, its own queue lane (queue tests cover that), its
 * settings in the operational table, a fresh-install seed - and migration 008,
 * which gives an upgraded install the Gemini model it never got and drops
 * "(subscription)" from seed names nobody changed. The adapter itself is
 * geminiCli.test.js's subject.
 */

const APP_SETTINGS_KEY = 'app-settings';
const SEED_LOG_KEY = 'migration-log.provider-schema-8';
const STAMP = '2026-05-01T00:00:00.000Z';

function openDb(dbDir) {
  return new Database(path.join(dbDir, 'free_tailor.db'));
}

function setVersion(dbDir, version) {
  const db = openDb(dbDir);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
    db.prepare(
      `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('provider_schema_version', String(version), new Date().toISOString());
  } finally {
    db.close();
  }
}

function readVersion(dbDir) {
  const db = openDb(dbDir);
  try {
    return db.prepare("SELECT value FROM schema_meta WHERE key = 'provider_schema_version'").get()?.value;
  } finally {
    db.close();
  }
}

/** This build's tables, the chain stopped at 003 for want of an administrator. */
function freshStorage(name) {
  const storage = useTempStorage(`gemini-seat-${name}`);
  setVersion(storage.dbDir, 1);
  loadFresh('../dist/database/sqlite').getDb();
  return storage;
}

function model(id, provider, modelName, extra = {}) {
  return { id, name: id, provider, modelName, description: '', enabled: true, createdAt: STAMP, updatedAt: STAMP, ...extra };
}

/** A row as an install saved it before this release: the old seed names, no Gemini. */
function preGeminiSettings(overrides = {}) {
  return {
    providersEnabled: { 'claude-cli': true, 'codex-cli': true },
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultModelId: 'claude-cli-opus',
    aiModels: [
      model('claude-cli-sonnet', 'claude-cli', 'sonnet', { name: 'Claude Sonnet (subscription)' }),
      model('claude-cli-opus', 'claude-cli', 'opus', { name: 'Claude Opus (subscription)' }),
      model('claude-cli-haiku', 'claude-cli', 'haiku', { name: 'My fast one' }),
      model('codex-cli-default', 'codex-cli', 'default', { name: 'Codex (subscription)' }),
    ],
    googleSheetsSources: [],
    ...overrides,
  };
}

function plantSettings(dbDir, settings) {
  const raw = JSON.stringify(settings, null, 2);
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, raw);
  return raw;
}

function runMigration008(dbDir) {
  const db = openDb(dbDir);
  try {
    return loadFresh('../dist/database/migrations/008_seed_gemini_and_rename_seeds').migrate008(db);
  } finally {
    db.close();
  }
}

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
  assert.equal(gemini.legacyEnabledField, null, 'no older page can be asking about it');
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

/* ------------------------------------------------------------ migration 008 */

test('008 appends the Gemini model to a list of its own, and renames only untouched seed names', async () => {
  const { dbDir } = freshStorage('append-rename');
  plantSettings(
    dbDir,
    preGeminiSettings({
      aiModels: [
        ...preGeminiSettings().aiModels,
        // The seed name on some other model, and an edited one: neither is the seed's.
        model('uuid-1', 'codex-cli', 'gpt-6-luna', { name: 'Codex (subscription)' }),
        model('uuid-2', 'claude-cli', 'fable', { name: 'Claude Sonnet (subscription) ' }),
      ],
    })
  );

  const report = runMigration008(dbDir);
  assert.equal(report.ran, true);
  assert.equal(report.deferred, false);
  assert.deepEqual(report.appendedModelIds, ['gemini-cli-auto']);
  assert.deepEqual(report.renamedModels, [
    { id: 'claude-cli-sonnet', from: 'Claude Sonnet (subscription)', to: 'Claude Sonnet' },
    { id: 'claude-cli-opus', from: 'Claude Opus (subscription)', to: 'Claude Opus' },
    { id: 'codex-cli-default', from: 'Codex (subscription)', to: 'Codex' },
  ]);
  assert.match(report.notes[0], /npm i -g @google\/gemini-cli/);

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.deepEqual(
    stored.aiModels.map((entry) => [entry.id, entry.name]),
    [
      ['claude-cli-sonnet', 'Claude Sonnet'],
      ['claude-cli-opus', 'Claude Opus'],
      ['claude-cli-haiku', 'My fast one'],
      ['codex-cli-default', 'Codex'],
      ['uuid-1', 'Codex (subscription)'],
      ['uuid-2', 'Claude Sonnet (subscription) '],
      ['gemini-cli-auto', 'Gemini'],
    ],
    'appended last, so it changes nobody\'s fallback'
  );
  const gemini = stored.aiModels.at(-1);
  assert.equal(gemini.provider, 'gemini-cli');
  assert.equal(gemini.modelName, 'auto');
  assert.equal(gemini.enabled, true);
  assert.equal(gemini.creditsPerResume, 1);
  assert.equal(stored.defaultModelId, 'claude-cli-opus', 'the default is not touched');
  assert.deepEqual(stored.providersEnabled, { 'claude-cli': true, 'codex-cli': true }, 'nor the switches');

  const log = JSON.parse(readSettingRaw(dbDir, SEED_LOG_KEY));
  assert.deepEqual(log.appendedModelIds, ['gemini-cli-auto']);
  assert.equal(log.renamedModels.length, 3);
  assert.ok(log.at);

  // And the row reads with it, runnable, under its new names.
  const config = loadFresh('../dist/config/aiModelConfig');
  const available = await config.listAvailableAIModels();
  assert.ok(available.some((entry) => entry.id === 'gemini-cli-auto'));
  assert.equal((await config.resolveRequestedAIModel('claude-cli-sonnet')).name, 'Claude Sonnet');
});

test('008 runs again after a rollback and finds nothing, or appends to its log what came back', () => {
  const { dbDir } = freshStorage('idempotent');
  plantSettings(dbDir, preGeminiSettings());
  runMigration008(dbDir);
  const after = { settings: readSettingRaw(dbDir, APP_SETTINGS_KEY), log: readSettingRaw(dbDir, SEED_LOG_KEY) };

  const again = runMigration008(dbDir);
  assert.equal(again.ran, false, 'nothing left to change');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), after.settings);
  assert.equal(readSettingRaw(dbDir, SEED_LOG_KEY), after.log);

  // A restored backup brings the old names back: renamed again, and logged
  // beside the first run, not over it.
  plantSettings(dbDir, preGeminiSettings({ aiModels: [model('claude-cli-sonnet', 'claude-cli', 'sonnet', { name: 'Claude Sonnet (subscription)' })] }));
  const third = runMigration008(dbDir);
  assert.equal(third.ran, true);
  const log = JSON.parse(readSettingRaw(dbDir, SEED_LOG_KEY));
  assert.deepEqual(log.appendedModelIds, ['gemini-cli-auto'], 'the first run, kept');
  assert.equal(log.laterRuns.length, 1);
  assert.deepEqual(log.laterRuns[0].renamedModels, [
    { id: 'claude-cli-sonnet', from: 'Claude Sonnet (subscription)', to: 'Claude Sonnet' },
  ]);
});

test('008 adds no second Gemini model where an administrator already made one', () => {
  const { dbDir } = freshStorage('own-gemini');
  plantSettings(
    dbDir,
    preGeminiSettings({
      aiModels: [model('claude-cli-sonnet', 'claude-cli', 'sonnet', { name: 'Sonnet' }), model('uuid-g', 'gemini-cli', 'pro', { enabled: false })],
    })
  );
  const report = runMigration008(dbDir);
  assert.equal(report.ran, false);
  assert.deepEqual(report.appendedModelIds, []);
  assert.equal(readSettingRaw(dbDir, SEED_LOG_KEY), null, 'nothing changed, nothing logged');
});

test('008 leaves a row with no list of its own, and a fresh install, alone', () => {
  const { dbDir } = freshStorage('inherited');
  const { aiModels: _models, ...noList } = preGeminiSettings();
  const raw = plantSettings(dbDir, noList);
  assert.equal(runMigration008(dbDir).ran, false, 'it inherits the seeds, which have both');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), raw);

  const fresh = freshStorage('fresh');
  assert.equal(runMigration008(fresh.dbDir).ran, false);
  assert.equal(readSettingRaw(fresh.dbDir, APP_SETTINGS_KEY), null);
});

test('008 waits on a model list that does not parse, and runs on the start after it is repaired', () => {
  const { dbDir } = freshStorage('unparseable');
  const broken = JSON.stringify(preGeminiSettings()) + '#';
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, broken);
  const db = openDb(dbDir);
  try {
    useAdminEmails('admin@example.com');
    loadFresh('../dist/database/userRepository').createUser({ email: 'admin@example.com' });
    const migrations = () => loadFresh('../dist/database/migrations/index').runDataMigrations(db);

    migrations();
    assert.equal(readVersion(dbDir), '7', 'every step before it ran, and it waits');
    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), broken, 'left exactly as found');

    plantSettings(dbDir, preGeminiSettings());
    migrations();
    assert.equal(readVersion(dbDir), '8');
    assert.ok(JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY)).aiModels.some((entry) => entry.id === 'gemini-cli-auto'));
  } finally {
    db.close();
  }

  // A broken row with no list has nothing here to wait for.
  const other = freshStorage('unparseable-no-list');
  writeSettingRaw(other.dbDir, APP_SETTINGS_KEY, '{"defaultMode": "preview"#');
  assert.equal(runMigration008(other.dbDir).deferred, false);
});

/* ------------------------------------------------- the reader, after 008 */

test('the Gemini model 008 appended still counts as what the migrations left, when a lock empties the row', async () => {
  // 007 records what it left a row running on, and the reader repairs a row a
  // lock has since emptied only while it still runs on exactly that. 008 then
  // adds the Gemini model to it - without counting that, every upgraded row
  // would stop being the migrations' the moment 008 ran.
  const { dbDir } = freshStorage('reader-after-008');
  plantSettings(
    dbDir,
    preGeminiSettings({
      providersEnabled: { 'claude-cli': true, 'codex-cli': false, openai: true },
      aiModels: [
        model('claude-cli-sonnet', 'claude-cli', 'sonnet', { name: 'Claude Sonnet (subscription)' }),
        model('codex-cli-default', 'codex-cli', 'default', { name: 'Codex (subscription)' }),
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      ],
      defaultModelId: 'claude-cli-sonnet',
    })
  );
  const db = openDb(dbDir);
  try {
    loadFresh('../dist/database/migrations/007_remove_metered_providers').migrate007(db);
  } finally {
    db.close();
  }
  runMigration008(dbDir);

  // Claude and Gemini locked; Codex switched off by the row: nothing can run.
  const readsRepaired = () =>
    withLocks('claude-cli,gemini-cli', async () => {
      const config = loadFresh('../dist/config/aiModelConfig');
      const admin = await config.getAdminAppSettings();
      assert.equal(admin.providersEnabled['codex-cli'], true, 'repaired onto the seat that is left');
      assert.equal(admin.defaultModelId, 'codex-cli-default');
    });
  await readsRepaired();

  // On a real boot 008 runs straight after 007 and can log the very same
  // millisecond; it still counts.
  const sameMoment = openDb(dbDir);
  try {
    const at = JSON.parse(sameMoment.prepare('SELECT value FROM app_settings WHERE key = ?').get('migration-log.provider-schema-7').value).at;
    const seedLog = JSON.parse(sameMoment.prepare('SELECT value FROM app_settings WHERE key = ?').get(SEED_LOG_KEY).value);
    sameMoment.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...seedLog, at }), SEED_LOG_KEY);
  } finally {
    sameMoment.close();
  }
  await readsRepaired();

  // Without 008's log the row no longer matches what 007 left, and the lock
  // fails by name instead - which is what an administrator's own choice gets.
  const remove = openDb(dbDir);
  try {
    remove.prepare('DELETE FROM app_settings WHERE key = ?').run(SEED_LOG_KEY);
  } finally {
    remove.close();
  }
  await withLocks('claude-cli,gemini-cli', async () => {
    await assert.rejects(
      () => loadFresh('../dist/config/aiModelConfig').getAdminAppSettings(),
      /unlocked AI provider must remain enabled/
    );
  });
});

test("008's note says whether users can pick the Gemini model: not while the seat is locked, or switched off", async () => {
  // It used to promise "users can pick it now" on an install where the lock
  // kept it out of every picker.
  const locked = freshStorage('note-locked');
  plantSettings(locked.dbDir, preGeminiSettings());
  const lockedReport = await withLocks('gemini-cli', async () => runMigration008(locked.dbDir));
  assert.deepEqual(lockedReport.appendedModelIds, ['gemini-cli-auto'], 'still added, ready for the day the lock goes');
  assert.match(lockedReport.notes[0], /locked on this machine \(AI_LOCKED_PROVIDERS\), so users will not see it/);
  assert.doesNotMatch(lockedReport.notes[0], /users can pick it now/);

  const off = freshStorage('note-off');
  plantSettings(off.dbDir, preGeminiSettings({ providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': false } }));
  const offReport = runMigration008(off.dbDir);
  assert.match(offReport.notes[0], /switched off under Admin > Settings, so users will see it once it is switched on/);
  assert.doesNotMatch(offReport.notes[0], /users can pick it now/);
});

test('008 does not rename a seed onto a display name another model already has', () => {
  // Users see display names and nothing else, so the rename would make two
  // identical choices - here, an administrator's own "claude opus" on Codex.
  const { dbDir } = freshStorage('rename-clash');
  plantSettings(
    dbDir,
    preGeminiSettings({
      aiModels: [
        ...preGeminiSettings().aiModels,
        model('uuid-own', 'codex-cli', 'gpt-5.5', { name: ' claude opus ' }),
      ],
    })
  );
  const report = runMigration008(dbDir);
  assert.deepEqual(report.skippedRenames, [
    { id: 'claude-cli-opus', from: 'Claude Opus (subscription)', to: 'Claude Opus' },
  ]);
  assert.ok(report.renamedModels.some((entry) => entry.id === 'claude-cli-sonnet'), 'the others are still renamed');
  assert.ok(report.notes.some((note) => /Left "Claude Opus \(subscription\)" as it is: another model is already called "Claude Opus"/.test(note)));

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal(stored.aiModels.find((entry) => entry.id === 'claude-cli-opus').name, 'Claude Opus (subscription)');
  assert.equal(stored.aiModels.find((entry) => entry.id === 'uuid-own').name, ' claude opus ');
  assert.deepEqual(JSON.parse(readSettingRaw(dbDir, SEED_LOG_KEY)).skippedRenames, report.skippedRenames);

  // A clash with nothing else to do is still reported, and written nowhere but the log.
  const lone = freshStorage('rename-clash-only');
  const raw = plantSettings(
    lone.dbDir,
    preGeminiSettings({
      aiModels: [
        model('claude-cli-sonnet', 'claude-cli', 'sonnet', { name: 'Claude Sonnet (subscription)' }),
        model('uuid-g', 'gemini-cli', 'pro', { name: 'Claude Sonnet' }),
      ],
    })
  );
  const loneReport = runMigration008(lone.dbDir);
  assert.equal(loneReport.ran, true, 'so the runner says it');
  assert.equal(loneReport.skippedRenames.length, 1);
  assert.equal(readSettingRaw(lone.dbDir, APP_SETTINGS_KEY), raw, 'the row is untouched');
});

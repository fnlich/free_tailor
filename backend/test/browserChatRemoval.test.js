const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const Database = require('better-sqlite3');

/**
 * Both seats unlocked, whatever the machine running this says: these are about
 * what the browser chat providers left behind, not about the lock, which
 * providerLock.test.js covers. Set before any dist module loads.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli';

const {
  loadFresh,
  readSettingRaw,
  useAdminEmails,
  useTempStorage,
  writeSettingRaw,
  writeStaticJson,
} = require('./helpers');

/**
 * The browser chat providers are gone; what an upgraded install still holds of
 * them is not.
 *
 * `claude-web` and `chatgpt-web` drove claude.ai and chatgpt.com in a debug
 * Chrome. An install that ran them has their model records, their enable flags,
 * the browser-mode switch and the debug-browser list in its settings row, a
 * default that an earlier migration moved onto one of them, prompt overrides
 * and profile preferences naming them, and queued tasks routed to their lane.
 * Two things deal with that, and both are pinned here:
 *
 *   - Migration 006 removes it from the database, once, with a verbatim
 *     snapshot to come back to.
 *   - Every read path tolerates it without 006, permanently. 006 waits behind
 *     003 for the first administrator, and a restored backup or
 *     `npm run ai:rollback` can put the residue back after it has run - so a
 *     read that threw on it would take the settings page down with it.
 *
 * Raw rows throughout, as in the other migration suites: a test that goes
 * through the validators only proves something about rows that did not need
 * migrating. Each case ends by reading through the normal strict path, because
 * "the next boot still works" is the property that actually matters.
 */

const APP_SETTINGS_KEY = 'app-settings';
const SNAPSHOT_KEY = 'app-settings.backup.pre-browser-chat-removal';
const LOG_KEY = 'migration-log.provider-schema-6';
const PROMPTS_BACKUP_TABLE = 'prompts_backup_pre_browser_chat_removal';
const STAMP = '2026-05-01T00:00:00.000Z';
/** An administrator's own browser model: a random id no list can name. */
const OPERATOR_BROWSER_MODEL_ID = '6f1c2a90-3b7e-4d55-9a1e-0c4b8d2f7e11';

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

/**
 * A database with this build's tables and NOTHING migrated past 001.
 *
 * Stamped at 1 first, so the app's own boot skips 001, and with no
 * administrator 003 defers and the chain stops there - which is a real install's
 * state between upgrading and its first sign-in, and the state in which every
 * read must cope with the residue on its own.
 */
function freshStorage(name) {
  const storage = useTempStorage(`browser-chat-removal-${name}`);
  setVersion(storage.dbDir, 1);
  loadFresh('../dist/database/sqlite').getDb();
  return storage;
}

function model(id, provider, modelName, extra = {}) {
  return {
    id,
    name: id,
    provider,
    modelName,
    description: '',
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...extra,
  };
}

/**
 * The settings row a typical upgraded install has: what 002 left it with, plus
 * a browser model the administrator added by hand.
 */
function browserEraSettings(overrides = {}) {
  return {
    providersEnabled: {
      'claude-cli': true,
      'codex-cli': true,
      claude: false,
      openai: true,
      deepseek: false,
      'claude-web': true,
      'chatgpt-web': true,
    },
    browserChatEnabled: true,
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9351 },
      { siteId: 'chatgpt-web', port: 9352 },
    ],
    browserChatDebugPort: 9350,
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: '',
    defaultProfileId: '',
    // What 002 did to a seat default on most upgraded installs.
    defaultModelId: 'claude-web-chat',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    aiModels: [
      model('claude-cli-sonnet', 'claude-cli', 'sonnet'),
      model('codex-cli-default', 'codex-cli', 'default'),
      model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      model('claude-web-chat', 'claude-web', 'chat', { name: 'Claude (free)' }),
      model('chatgpt-web-chat', 'chatgpt-web', 'chat', { name: 'ChatGPT (free)' }),
      model(OPERATOR_BROWSER_MODEL_ID, 'chatgpt-web', 'gpt-4o', { name: 'My ChatGPT tab' }),
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

function plantPrompt(db, id, data, builtIn = false) {
  db.prepare(
    `INSERT INTO prompts (id, feature_key, is_built_in, data, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)`
  ).run(id, builtIn ? 1 : 0, JSON.stringify({ id, name: id, content: 'Prompt.', ...data }), STAMP, STAMP);
}

function plantProfile(db, id, ai) {
  const document = { id, name: id, ...(ai ? { profileSettings: { ai } } : {}) };
  db.prepare(
    `INSERT INTO profiles (id, name, disabled, data, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`
  ).run(id, id, JSON.stringify(document), STAMP, STAMP);
}

function readRow(db, table, id) {
  return JSON.parse(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id).data);
}

function migrate006() {
  return loadFresh('../dist/database/migrations/006_remove_browser_chat').migrate006;
}

/* ------------------------------------------------------------ migration 006 */

test('006 strips every browser record, flag and setting, after a verbatim snapshot', async () => {
  const { dbDir } = freshStorage('settings');
  const original = plantSettings(dbDir, browserEraSettings());

  const db = openDb(dbDir);
  let report;
  try {
    report = migrate006()(db);
  } finally {
    db.close();
  }

  assert.equal(report.ran, true);
  assert.equal(report.settingsRewritten, true);
  assert.equal(report.removedModels, 3, 'both seeds and the one the administrator added');
  assert.deepEqual(
    [...report.removedModelIds].sort(),
    [OPERATOR_BROWSER_MODEL_ID, 'chatgpt-web-chat', 'claude-web-chat'].sort()
  );
  assert.deepEqual([...report.removedProviderFlags].sort(), ['chatgpt-web', 'claude-web']);
  assert.deepEqual(
    [...report.removedSettingsKeys].sort(),
    ['browserChatDebugPort', 'browserChatEnabled', 'browserChatEndpoints']
  );

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.deepEqual(
    stored.aiModels.map((entry) => entry.id),
    ['claude-cli-sonnet', 'codex-cli-default', 'openai-gpt-5-1'],
    'every other record stays, in its order'
  );
  assert.deepEqual(Object.keys(stored.providersEnabled).sort(), ['claude', 'claude-cli', 'codex-cli', 'deepseek', 'openai']);
  assert.equal(stored.providersEnabled.openai, true, 'the flags that stay are the ones the operator set');
  assert.equal(stored.providersEnabled.claude, false);
  for (const key of ['browserChatEnabled', 'browserChatEndpoints', 'browserChatDebugPort']) {
    assert.equal(key in stored, false, `${key} is gone`);
  }
  assert.equal(stored.defaultMode, 'preview', 'nothing unrelated is touched');

  // The row as it was, byte for byte, so recovering it is a copy.
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), original);
  const log = JSON.parse(readSettingRaw(dbDir, LOG_KEY));
  assert.equal(log.removedModels, 3);
  assert.deepEqual(log.repointedDefaultModel, { from: 'claude-web-chat', to: 'claude-cli-sonnet' });
  assert.ok(log.at, 'and when');

  // The property that matters: the row reads through the strict path.
  const config = loadFresh('../dist/config/aiModelConfig');
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.defaultModelId, 'claude-cli-sonnet');
  assert.equal(admin.aiModels.some((entry) => ['claude-web', 'chatgpt-web'].includes(entry.provider)), false);
});

test('006 repoints a default that named a browser model onto one that runs', () => {
  // The common case rather than the edge one: 002 moved the seat default onto
  // claude-web-chat on most upgraded installs. Left dangling, the reader would
  // fall back to the first runnable model in list order - here a metered one.
  for (const from of ['claude-web-chat', 'chatgpt-web-chat', 'free-hybrid', OPERATOR_BROWSER_MODEL_ID]) {
    const { dbDir } = freshStorage(`default-${from}`);
    plantSettings(dbDir, browserEraSettings({ defaultModelId: from }));
    const db = openDb(dbDir);
    try {
      const report = migrate006()(db);
      assert.deepEqual(report.repointedDefaultModel, { from, to: 'claude-cli-sonnet' }, from);
    } finally {
      db.close();
    }
    assert.equal(JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY)).defaultModelId, 'claude-cli-sonnet');
  }

  // Without the seat's default model, the keyless model the install has wins
  // over the metered one listed before it: a default nobody chose must not be
  // the one that starts billing.
  const { dbDir } = freshStorage('default-keyless');
  plantSettings(
    dbDir,
    browserEraSettings({
      aiModels: [
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
        model('codex-cli-default', 'codex-cli', 'default'),
        model('claude-web-chat', 'claude-web', 'chat'),
      ],
    })
  );
  const db = openDb(dbDir);
  try {
    assert.deepEqual(migrate006()(db).repointedDefaultModel, { from: 'claude-web-chat', to: 'codex-cli-default' });
  } finally {
    db.close();
  }

  // A row that never customised its models inherits the seeds, which include
  // the seat's default.
  const implicit = freshStorage('default-implicit');
  const settings = browserEraSettings({ defaultModelId: 'free-hybrid' });
  delete settings.aiModels;
  plantSettings(implicit.dbDir, settings);
  const implicitDb = openDb(implicit.dbDir);
  try {
    assert.deepEqual(migrate006()(implicitDb).repointedDefaultModel, { from: 'free-hybrid', to: 'claude-cli-sonnet' });
  } finally {
    implicitDb.close();
  }
  assert.equal('aiModels' in JSON.parse(readSettingRaw(implicit.dbDir, APP_SETTINGS_KEY)), false, 'still inherits them');
});

test('006 gives an install that ran only on the browsers the subscription seat back', async () => {
  // Without the carry-over this row migrates to "nothing enabled, nothing to
  // run", which the settings reader refuses on every read - a settings page
  // that cannot be loaded to fix itself. The OpenRouter migration made the same
  // repair for the same reason.
  const { dbDir } = freshStorage('browser-only');
  plantSettings(
    dbDir,
    browserEraSettings({
      providersEnabled: {
        'claude-cli': false,
        'codex-cli': false,
        claude: false,
        openai: false,
        deepseek: false,
        'claude-web': true,
        'chatgpt-web': true,
      },
      aiModels: [model('claude-web-chat', 'claude-web', 'chat'), model('chatgpt-web-chat', 'chatgpt-web', 'chat')],
    })
  );

  const db = openDb(dbDir);
  let report;
  try {
    report = migrate006()(db);
  } finally {
    db.close();
  }

  assert.deepEqual(report.enabledProviders, ['claude-cli']);
  assert.equal(report.seededModels, 3, 'the seat\'s three seed models');
  assert.ok(report.notes.length > 0, 'and the operator is told');

  const config = loadFresh('../dist/config/aiModelConfig');
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.providersEnabled['claude-cli'], true);
  assert.equal(admin.defaultModelId, 'claude-cli-sonnet');
  assert.equal((await config.resolveRequestedAIModel()).provider, 'claude-cli', 'something can actually run');
});

test('006 switches a seat model back on rather than seed a duplicate of it', async () => {
  // The seat's models were there, switched off, beside browser ones that ran.
  // One under the operator's own id shares provider and model name with a seed,
  // and the strict reader refuses two records for one pair - so the seed must
  // not be added beside it, and something must still be made to run.
  const { dbDir } = freshStorage('disabled-seat');
  plantSettings(
    dbDir,
    browserEraSettings({
      aiModels: [
        model('my-sonnet', 'claude-cli', 'sonnet', { enabled: false }),
        model('claude-cli-opus', 'claude-cli', 'opus', { enabled: false }),
        model('claude-cli-haiku', 'claude-cli', 'haiku', { enabled: false }),
        model('claude-web-chat', 'claude-web', 'chat'),
      ],
    })
  );

  const db = openDb(dbDir);
  let report;
  try {
    report = migrate006()(db);
  } finally {
    db.close();
  }

  assert.equal(report.seededModels, 0, 'every seed was already there, by id or by provider and name');
  assert.deepEqual(report.reenabledModels, ['my-sonnet'], 'the default one, under whatever id it has');
  assert.deepEqual(report.repointedDefaultModel, { from: 'claude-web-chat', to: 'my-sonnet' });

  const config = loadFresh('../dist/config/aiModelConfig');
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.aiModels.filter((entry) => entry.modelName === 'sonnet').length, 1);
  assert.equal(admin.defaultModelId, 'my-sonnet');
});

test('006 clears prompt overrides naming a browser site, shipped and custom alike, and backs them up', () => {
  const { dbDir } = freshStorage('prompts');
  plantSettings(dbDir, browserEraSettings());
  const db = openDb(dbDir);
  try {
    plantPrompt(db, 'tailor-resume', { modelProvider: 'claude-web', modelName: 'chat' }, true);
    plantPrompt(db, 'custom-variant', { modelProvider: 'chatgpt-web', modelName: 'chat' });
    plantPrompt(db, 'pinned-to-openai', { modelProvider: 'openai', modelName: 'gpt-5.1' });

    const report = migrate006()(db);
    assert.equal(report.clearedPromptOverrides, 2);

    // CLEARED on both, where 001 repointed custom ones: there is no provider to
    // repoint them to, and no override is what the prompt would have done had
    // nobody set one - run on the model chosen for the run.
    for (const id of ['tailor-resume', 'custom-variant']) {
      const prompt = readRow(db, 'prompts', id);
      assert.equal('modelProvider' in prompt, false, `${id} has no provider override`);
      assert.equal('modelName' in prompt, false, `${id} has no model override`);
      assert.equal(prompt.content, 'Prompt.', 'and keeps everything else');
    }
    assert.deepEqual(
      readRow(db, 'prompts', 'pinned-to-openai'),
      { id: 'pinned-to-openai', name: 'pinned-to-openai', content: 'Prompt.', modelProvider: 'openai', modelName: 'gpt-5.1' },
      'an override on a provider that still exists is the operator\'s choice, and stays'
    );

    const backups = db.prepare(`SELECT id, data FROM ${PROMPTS_BACKUP_TABLE} ORDER BY id`).all();
    assert.deepEqual(backups.map((row) => row.id), ['custom-variant', 'tailor-resume']);
    assert.match(backups[0].data, /chatgpt-web/, 'the original row is recoverable');
  } finally {
    db.close();
  }
});

test('006 clears profile preferences for a browser model, and the log keeps what they were', () => {
  const { dbDir } = freshStorage('profiles');
  plantSettings(dbDir, browserEraSettings());
  const db = openDb(dbDir);
  try {
    plantProfile(db, 'p-hybrid', { modelId: 'free-hybrid', effort: 'max' });
    plantProfile(db, 'p-claude-web', { modelId: 'claude-web-chat' });
    // Only the row it is deleted from can name this one, which is why the
    // settings pass runs first and hands its ids on.
    plantProfile(db, 'p-operator-model', { modelId: OPERATOR_BROWSER_MODEL_ID });
    plantProfile(db, 'p-openai', { modelId: 'openai-gpt-5-1' });
    plantProfile(db, 'p-no-preference', null);

    const report = migrate006()(db);

    assert.deepEqual(
      [...report.clearedProfilePreferences].sort((a, b) => a.profileId.localeCompare(b.profileId)),
      [
        { profileId: 'p-claude-web', modelId: 'claude-web-chat' },
        { profileId: 'p-hybrid', modelId: 'free-hybrid' },
        { profileId: 'p-operator-model', modelId: OPERATOR_BROWSER_MODEL_ID },
      ]
    );
    // An absent model means INHERIT - the app default, which is how the
    // preference was already being read.
    assert.deepEqual(readRow(db, 'profiles', 'p-hybrid').profileSettings.ai, { effort: 'max' });
    assert.deepEqual(readRow(db, 'profiles', 'p-claude-web').profileSettings.ai, {});
    assert.deepEqual(readRow(db, 'profiles', 'p-operator-model').profileSettings.ai, {});
    assert.equal(readRow(db, 'profiles', 'p-openai').profileSettings.ai.modelId, 'openai-gpt-5-1');
    assert.equal('profileSettings' in readRow(db, 'profiles', 'p-no-preference'), false);

    const log = JSON.parse(readSettingRaw(dbDir, LOG_KEY));
    assert.equal(log.clearedProfilePreferences.length, 3, 'the previous values are on record');
  } finally {
    db.close();
  }
});

test('006 runs once: again, even with the version stamp gone, it changes nothing', () => {
  const { dbDir } = freshStorage('idempotent');
  const original = plantSettings(dbDir, browserEraSettings());
  const db = openDb(dbDir);
  try {
    plantPrompt(db, 'custom-variant', { modelProvider: 'claude-web', modelName: 'chat' });
    plantProfile(db, 'p-hybrid', { modelId: 'free-hybrid' });

    assert.equal(migrate006()(db).ran, true);
    const after = {
      settings: readSettingRaw(dbDir, APP_SETTINGS_KEY),
      log: readSettingRaw(dbDir, LOG_KEY),
      prompt: db.prepare('SELECT data, updated_at FROM prompts WHERE id = ?').get('custom-variant'),
      profile: db.prepare('SELECT data FROM profiles WHERE id = ?').get('p-hybrid'),
    };

    // A second run, directly...
    assert.equal(migrate006()(db).ran, false, 'nothing left to find');

    // ...and the whole chain from nothing, as after `ai:rollback` clears the
    // stamp - with an administrator, so 003 does not stop it short of 006.
    // Inspection, not the stamp, is what keeps 006 from repeating.
    useAdminEmails('admin@example.com');
    loadFresh('../dist/database/userRepository').createUser({ email: 'admin@example.com' });
    db.exec('DELETE FROM schema_meta');
    loadFresh('../dist/database/migrations/index').runDataMigrations(db);
    assert.equal(readVersion(dbDir), '6', 'every step ran');

    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), after.settings);
    assert.equal(readSettingRaw(dbDir, LOG_KEY), after.log, 'and no second log entry over the first');
    assert.deepEqual(db.prepare('SELECT data, updated_at FROM prompts WHERE id = ?').get('custom-variant'), after.prompt);
    // 003 gives the profile an owner on this pass, which is its own business;
    // the preference 006 cleared stays cleared.
    assert.deepEqual(readRow(db, 'profiles', 'p-hybrid').profileSettings, JSON.parse(after.profile.data).profileSettings);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${PROMPTS_BACKUP_TABLE}`).get().n, 1);
  } finally {
    db.close();
  }
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), original);
});

test('006 keeps the FIRST snapshot when a rollback brings the residue back', () => {
  // What `ai:rollback` does: restore a snapshot from before the migration and
  // clear the stamp. The residue is back, so 006 runs again - and must not
  // overwrite the original with a row it had already cleaned once.
  const { dbDir } = freshStorage('rollback');
  const original = plantSettings(dbDir, browserEraSettings());
  const db = openDb(dbDir);
  try {
    migrate006()(db);
    const restored = plantSettings(dbDir, browserEraSettings({ defaultMode: 'generate' }));
    assert.notEqual(restored, original);

    assert.equal(migrate006()(db).ran, true, 'the restored residue is removed again');
  } finally {
    db.close();
  }
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), original, 'the snapshot is the row as it was first found');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY).includes('claude-web'), false);
});

test('006 on a fresh install finds nothing, and writes nothing', () => {
  const { dbDir } = freshStorage('fresh');
  const db = openDb(dbDir);
  try {
    const report = migrate006()(db);
    assert.equal(report.ran, false);
    assert.equal(report.settingsRewritten, false);
  } finally {
    db.close();
  }
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), null);
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), null);
  assert.equal(readSettingRaw(dbDir, LOG_KEY), null);
});

test('006 leaves an unparseable settings row exactly as it found it', () => {
  // `getSetting` throws on invalid JSON so that corruption surfaces. Writing a
  // repaired row over it would destroy whatever it holds.
  const { dbDir } = freshStorage('invalid');
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, '{ "providersEnabled": { "claude-web": true ');
  const db = openDb(dbDir);
  try {
    migrate006()(db);
  } finally {
    db.close();
  }
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), '{ "providersEnabled": { "claude-web": true ');
});

test('006 waits behind 003 like the rest of the chain, and runs on the boot after it can', async () => {
  // The chain stops at a deferred step rather than skipping it, so on an
  // install with no administrator yet 006 has not run - which is exactly why
  // the read paths must not depend on it.
  const { dbDir } = freshStorage('chain');
  const original = plantSettings(dbDir, browserEraSettings());

  const runChain = () => {
    const db = openDb(dbDir);
    try {
      loadFresh('../dist/database/migrations/index').runDataMigrations(db);
    } finally {
      db.close();
    }
  };

  runChain();
  assert.equal(readVersion(dbDir), '1', 'stopped at 003, waiting for an administrator');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original, 'the residue is still there');

  useAdminEmails('admin@example.com');
  loadFresh('../dist/database/userRepository').createUser({ email: 'admin@example.com' });
  runChain();

  assert.equal(readVersion(dbDir), '6');
  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal(stored.aiModels.some((entry) => entry.provider === 'claude-web'), false);
  assert.equal(stored.defaultModelId, 'claude-cli-sonnet');
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), original);
});

/* --------------------------------------------- reading without the migration */

test('a row 006 has not reached reads without the browsers, and is not rewritten by reading it', async () => {
  const { dbDir } = freshStorage('read-tolerance');
  const original = plantSettings(dbDir, browserEraSettings());

  const config = loadFresh('../dist/config/aiModelConfig');
  const admin = await config.getAdminAppSettings();
  const publicSettings = await config.getPublicAppSettings();

  for (const settings of [admin, publicSettings]) {
    assert.equal(
      settings.aiModels.some((entry) => ['claude-web', 'chatgpt-web'].includes(entry.provider)),
      false,
      'no browser record is offered'
    );
    assert.equal(
      settings.aiModels.some((entry) => entry.modelName === 'chat'),
      false,
      'nor turned into a seat model called "chat" that would fail at generate time'
    );
    assert.deepEqual(Object.keys(settings.providersEnabled).sort(), ['claude', 'claude-cli', 'codex-cli', 'deepseek', 'openai']);
    assert.equal('browserChatEnabled' in settings, false);
    assert.equal('browserChatEndpoints' in settings, false);
    assert.equal(settings.defaultModelId, 'claude-cli-sonnet', 'the default lands on the seed default');
  }

  // Tolerated in memory only. 006 is the writer, and it must still find the
  // residue to snapshot it.
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original);
});

test('a row whose only switched-on providers were the browsers reads with the seat on', async () => {
  const { dbDir } = freshStorage('read-only-retired-flags');
  const original = plantSettings(
    dbDir,
    browserEraSettings({
      providersEnabled: {
        'claude-cli': false,
        'codex-cli': false,
        claude: false,
        openai: false,
        deepseek: false,
        'claude-web': true,
        'chatgpt-web': false,
      },
    })
  );

  const config = loadFresh('../dist/config/aiModelConfig');
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.providersEnabled['claude-cli'], true);
  assert.equal(admin.providersEnabled.openai, false, 'what the operator switched off stays off');
  assert.equal((await config.resolveRequestedAIModel()).id, 'claude-cli-sonnet');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original);
});

test('a row whose only models were browser ones reads with the seat\'s models', async () => {
  const { dbDir } = freshStorage('read-only-retired-models');
  const original = plantSettings(
    dbDir,
    browserEraSettings({
      aiModels: [model('claude-web-chat', 'claude-web', 'chat'), model('chatgpt-web-chat', 'chatgpt-web', 'chat')],
      defaultModelId: 'free-hybrid',
    })
  );

  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getPublicAppSettings();
  assert.deepEqual(
    settings.aiModels.map((entry) => entry.id),
    ['claude-cli-sonnet', 'claude-cli-opus', 'claude-cli-haiku']
  );
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original);
});

test('a choice that names a browser model, from anywhere, runs on the app default', async () => {
  const { dbDir } = freshStorage('read-choices');
  plantSettings(dbDir, browserEraSettings({ defaultModelId: 'openai-gpt-5-1' }));
  const config = loadFresh('../dist/config/aiModelConfig');
  const preferences = loadFresh('../dist/config/aiPreferences');

  // A profile's stored preference. The admin-created model's id is random, and
  // is recognised because the read that dropped its record remembered it.
  for (const modelId of ['claude-web-chat', 'chatgpt-web-chat', 'free-hybrid', OPERATOR_BROWSER_MODEL_ID]) {
    const choice = await preferences.resolveAiChoice(undefined, { profileSettings: { ai: { modelId } } });
    assert.equal(choice.modelId, 'openai-gpt-5-1', `a profile set to ${modelId} runs on the default`);
  }

  // A request from a page loaded before the upgrade. The browser entry was
  // labelled as the default and meant it; refusing would break the stale tab.
  for (const modelId of ['free-hybrid', 'claude-web-chat', 'claude-web', 'chatgpt-web:chat']) {
    const choice = await preferences.resolveAiChoice({ modelId }, null);
    assert.equal(choice.modelId, 'openai-gpt-5-1', `a request for ${modelId} runs on the default`);
  }
  const choice = await preferences.resolveAiChoice({ modelId: 'free-hybrid' }, null);
  assert.equal(choice.modelLabel, 'openai-gpt-5-1', 'labelled as what it runs on, with nothing appended');
  assert.equal('route' in choice, false);

  // Not a general "anything missing falls back": a model an administrator
  // deleted is still an error, because it is still a mistake somebody can fix.
  await assert.rejects(() => config.resolveRequestedAIModel('deleted-model'), /was not found/);
  await assert.rejects(
    () => preferences.resolveAiChoice(undefined, { profileSettings: { ai: { modelId: 'deleted-model' } } }),
    /was not found/
  );
});

test('a prompt pinned to a browser site runs on the model chosen for the run', async () => {
  // Read through the prompt store, which has no per-record catch: an override
  // that threw on read would take down Admin -> Prompts, and on a shipped
  // prompt every generation that uses it.
  const { staticDir } = freshStorage('read-prompt');
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze.\n[[jobDescription]]',
    modelProvider: 'claude-web',
    modelName: 'chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const promptService = loadFresh('../dist/services/promptService');
  const prompt = await promptService.getPromptById('analyze-job-description');
  assert.ok(prompt, 'the prompt still reads');
  assert.equal(prompt.modelProvider, undefined);
  assert.equal(prompt.modelName, undefined);
  assert.ok((await promptService.listPrompts()).length > 0, 'and so does the list it is in');

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
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelName, 'gpt-5.1');

  // A stale Prompts page saving one is heard the same way: no override, rather
  // than a refusal. A provider that never existed is still refused.
  const saved = await promptService.createPrompt({
    name: 'Saved from a stale tab',
    content: 'Tailor.\n[[profileJson]]',
    allowedVariables: [{ name: 'profileJson', description: 'Profile', sampleValue: '{}' }],
    modelProvider: 'chatgpt-web',
    modelName: 'chat',
  });
  assert.equal(saved.modelProvider, undefined);
  await assert.rejects(
    () =>
      promptService.createPrompt({
        name: 'Nonsense',
        content: 'Tailor.\n[[profileJson]]',
        allowedVariables: [{ name: 'profileJson', description: 'Profile', sampleValue: '{}' }],
        modelProvider: 'not-a-provider',
        modelName: 'x',
      }),
    /Prompt model provider must be one of/
  );
});

/* ------------------------------------------------------------ admin surface */

async function serveAdmin(name) {
  useTempStorage(`browser-chat-removal-${name}`);
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(admin.id);

  loadFresh('../dist/config/aiModelConfig');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/admin');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/admin', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  return {
    close: () => server.close(),
    call: (method, route, body) =>
      fetch(`http://127.0.0.1:${port}/api/admin${route}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
  };
}

test('the admin surface offers no browser provider, and refuses to make one', async () => {
  const server = await serveAdmin('admin-models');
  try {
    const settings = await (await server.call('GET', '/settings')).json();
    assert.equal('browserChatEnabled' in settings, false);
    assert.equal('browserChatEndpoints' in settings, false);
    assert.deepEqual(Object.keys(settings.providersEnabled).sort(), ['claude', 'claude-cli', 'codex-cli', 'deepseek', 'openai']);
    assert.equal(
      settings.aiModels.some((entry) => /-web$/.test(entry.provider) || entry.id === 'free-hybrid'),
      false,
      'no seed model names a removed provider'
    );

    const created = await server.call('POST', '/models', { name: 'My Claude tab', provider: 'claude-web', modelName: 'chat' });
    assert.equal(created.status, 400);
    assert.equal(
      (await created.json()).error,
      'Model provider must be one of: claude-cli, codex-cli, claude, openai, deepseek.'
    );

    const moved = await server.call('PUT', '/models/claude-cli-sonnet', { provider: 'chatgpt-web' });
    assert.equal(moved.status, 400, 'nor can an existing model be moved onto one');

    // The debug-browser probe went with the browsers.
    const probe = await server.call('GET', '/browser/debug');
    assert.equal(probe.status, 404);
  } finally {
    server.close();
  }
});

test('a Settings page from before the upgrade can still save what it can change', async () => {
  // It still sends the browser-mode switch, the debug-browser list and a flag
  // per browser provider. Refusing the save would stop it saving the settings
  // it CAN change; storing them would put the residue straight back.
  const server = await serveAdmin('admin-stale-save');
  try {
    const response = await server.call('PUT', '/settings', {
      providersEnabled: { 'claude-cli': true, openai: false, 'claude-web': true, 'chatgpt-web': true },
      browserChatEnabled: false,
      browserChatEndpoints: [{ siteId: 'claude-web', port: 9351 }],
      browserChatDebugPort: 9350,
      defaultMode: 'generate',
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.defaultMode, 'generate', 'what it can change is saved');
    assert.equal(saved.providersEnabled.openai, false);
    assert.equal('claude-web' in saved.providersEnabled, false);
    assert.equal('browserChatEnabled' in saved, false);

    const config = require('../dist/config/aiModelConfig');
    const raw = readSettingRaw(process.env.DB_DIR, APP_SETTINGS_KEY);
    assert.ok(raw, 'the save was written');
    for (const residue of ['browserChat', 'claude-web', 'chatgpt-web']) {
      assert.equal(raw.includes(residue), false, `${residue} is not persisted`);
    }
    assert.equal((await config.getAdminAppSettings()).defaultMode, 'generate');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------- the catalog */

test('the catalog has five providers, and remembers the two it retired', () => {
  const catalog = loadFresh('../dist/config/providerCatalog');
  // What the provider health report and every settings form walk.
  assert.deepEqual([...catalog.AI_PROVIDER_IDS], ['claude-cli', 'codex-cli', 'claude', 'openai', 'deepseek']);
  assert.deepEqual([...catalog.RETIRED_PROVIDER_IDS], ['claude-web', 'chatgpt-web']);
  assert.deepEqual([...catalog.RETIRED_MODEL_IDS], ['free-hybrid', 'claude-web-chat', 'chatgpt-web-chat']);
  assert.equal(catalog.isRetiredModelId(' free-hybrid '), true, 'compared trimmed, as stored values are');
  assert.equal(catalog.isRetiredModelId('claude-cli-sonnet'), false);
  assert.equal(catalog.isRetiredProviderId(undefined), false);
});

/* ------------------------------------------------------------- queued work */

test('a queued choice naming a browser provider is resolved again; any other runs as stored', async () => {
  // The restore and dispatch path is in queuePersistence.test.js; this is the
  // decision itself. A paid task must still produce its resume.
  freshStorage('queued-choice');
  const { __currentChoiceForTests } = loadFresh('../dist/services/queue/resumeTask');
  const profile = (modelId) => ({ id: 'p1', name: 'Ada', profileSettings: modelId ? { ai: { modelId } } : {} });

  const hybrid = { provider: 'claude-web', modelName: 'chat', modelId: 'free-hybrid', modelLabel: 'x', route: 'hybrid' };
  assert.equal((await __currentChoiceForTests(hybrid, profile())).modelId, 'claude-cli-sonnet');
  assert.equal(
    (await __currentChoiceForTests(hybrid, profile('openai-gpt-5-1'))).modelId,
    'openai-gpt-5-1',
    'resolved from the profile, as a new submission would be'
  );
  assert.equal(
    (await __currentChoiceForTests(hybrid, profile('claude-web-chat'))).modelId,
    'claude-cli-sonnet',
    'and a profile still naming a browser model lands on the default'
  );

  const pinned = { provider: 'codex-cli', modelName: 'default', modelId: 'codex-cli-default', modelLabel: 'Codex' };
  assert.equal(await __currentChoiceForTests(pinned, profile('openai-gpt-5-1')), pinned, 'the same object, untouched');
});

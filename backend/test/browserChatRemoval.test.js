const assert = require('node:assert/strict');
const fs = require('node:fs');
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
 *     003 for the first administrator, and a restored backup, a hand-edited row
 *     or a page left open from before the upgrade can put the residue back
 *     after it has run - so a read that threw on it would take the settings
 *     page down with it.
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
    assert.equal(readVersion(dbDir), '8', 'every step ran');

    // 007 runs after it and removes the metered residue this row also has - so
    // its snapshot is the row as 006 left it, which shows 006 did not touch it
    // a second time.
    assert.equal(readSettingRaw(dbDir, 'app-settings.backup.pre-metered-removal'), after.settings);
    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY).includes('claude-web'), false);
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

test('006 keeps the FIRST snapshot and every log entry when residue comes back', () => {
  // `ai:rollback` clears the stamp, so 006 runs again - but it restores only
  // 001's snapshot, which is older than browser chat. What brings residue back
  // is something written since: a restored backup, or a page left open from
  // before the upgrade saving a profile. The second run must not overwrite the
  // original snapshot with a row it had already cleaned once - nor the log,
  // which is the only record of the profile preferences the FIRST run cleared.
  const { dbDir } = freshStorage('rollback');
  const original = plantSettings(dbDir, browserEraSettings());
  const db = openDb(dbDir);
  try {
    plantProfile(db, 'p-first', { modelId: 'free-hybrid' });
    migrate006()(db);
    const restored = plantSettings(dbDir, browserEraSettings({ defaultMode: 'generate' }));
    assert.notEqual(restored, original);
    plantProfile(db, 'p-second', { modelId: 'claude-web-chat' });

    assert.equal(migrate006()(db).ran, true, 'the restored residue is removed again');
  } finally {
    db.close();
  }
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), original, 'the snapshot is the row as it was first found');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY).includes('claude-web'), false);

  const log = JSON.parse(readSettingRaw(dbDir, LOG_KEY));
  assert.deepEqual(log.clearedProfilePreferences, [{ profileId: 'p-first', modelId: 'free-hybrid' }], 'the first run, kept');
  assert.equal(log.laterRuns.length, 1, 'the second run, appended');
  assert.deepEqual(log.laterRuns[0].clearedProfilePreferences, [{ profileId: 'p-second', modelId: 'claude-web-chat' }]);
  assert.ok(log.laterRuns[0].at);
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

test('006 leaves an unparseable settings row as it found it, and waits for it to be repaired', () => {
  // `getSetting` throws on invalid JSON so that corruption surfaces. Writing a
  // repaired row over it would destroy whatever it holds. And running past it
  // would stamp the version without ever reading the row - so the ids of an
  // administrator's own browser models, which only that row holds, would never
  // be learned, and a profile pinned to one would fail once it was repaired.
  const { dbDir } = freshStorage('invalid');
  const broken = JSON.stringify(browserEraSettings()) + '#';
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, broken);
  const db = openDb(dbDir);
  try {
    plantProfile(db, 'p-operator-model', { modelId: OPERATOR_BROWSER_MODEL_ID });
    const report = migrate006()(db);
    assert.equal(report.deferred, true);
    assert.equal(report.ran, false);
    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), broken);

    // Through the chain, with an administrator: it stops at 6 unstamped...
    useAdminEmails('admin@example.com');
    loadFresh('../dist/database/userRepository').createUser({ email: 'admin@example.com' });
    loadFresh('../dist/database/migrations/index').runDataMigrations(db);
    assert.equal(readVersion(dbDir), '5', 'waiting, not done');
    assert.equal(readRow(db, 'profiles', 'p-operator-model').profileSettings.ai.modelId, OPERATOR_BROWSER_MODEL_ID);

    // ...and runs on the first start after the operator repairs the row.
    plantSettings(dbDir, browserEraSettings());
    loadFresh('../dist/database/migrations/index').runDataMigrations(db);
    assert.equal(readVersion(dbDir), '8', '006 and the steps after it');
    assert.deepEqual(readRow(db, 'profiles', 'p-operator-model').profileSettings.ai, {}, 'the id was learned');
  } finally {
    db.close();
  }
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

  assert.equal(readVersion(dbDir), '8');
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
  // The runnable list beside the full one: what a request may name.
  const runnable = { ...admin, aiModels: await config.listAvailableAIModels() };

  for (const settings of [admin, runnable]) {
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
    // The metered flags beside them are retired residue too, and read the same way.
    assert.deepEqual(Object.keys(settings.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
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

  // The Gemini seat is newer than this row, so the row records no choice for
  // it and it reads as switched on - which ranks it ahead of a seat the row
  // switched off (meteredRemoval.test.js pins that). Locked here, as on an
  // install that never set it up, the repair is between the two older seats.
  await withLocks('gemini-cli', async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.providersEnabled['claude-cli'], true);
    assert.equal(admin.providersEnabled['codex-cli'], false, 'what the operator switched off stays off');
    assert.equal((await config.resolveRequestedAIModel()).id, 'claude-cli-sonnet');
  });
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
  const settings = await config.getUserAppSettings();
  assert.deepEqual(
    settings.models.map((entry) => entry.id),
    ['claude-cli-sonnet', 'claude-cli-opus', 'claude-cli-haiku']
  );
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original);
});

test('a choice that names a browser model, from anywhere, runs on the app default', async () => {
  const { dbDir } = freshStorage('read-choices');
  plantSettings(dbDir, browserEraSettings({ defaultModelId: 'codex-cli-default' }));
  const config = loadFresh('../dist/config/aiModelConfig');
  const preferences = loadFresh('../dist/config/aiPreferences');

  // A profile's stored preference. The admin-created model's id is random, and
  // is recognised because the read that dropped its record remembered it.
  for (const modelId of ['claude-web-chat', 'chatgpt-web-chat', 'free-hybrid', OPERATOR_BROWSER_MODEL_ID]) {
    const choice = await preferences.resolveAiChoice(undefined, { profileSettings: { ai: { modelId } } });
    assert.equal(choice.modelId, 'codex-cli-default', `a profile set to ${modelId} runs on the default`);
  }

  // A request from a page loaded before the upgrade. The browser entry was
  // labelled as the default and meant it; refusing would break the stale tab.
  for (const modelId of ['free-hybrid', 'claude-web-chat', 'claude-web', 'chatgpt-web:chat']) {
    const choice = await preferences.resolveAiChoice({ modelId }, null);
    assert.equal(choice.modelId, 'codex-cli-default', `a request for ${modelId} runs on the default`);
  }
  const choice = await preferences.resolveAiChoice({ modelId: 'free-hybrid' }, null);
  assert.equal(choice.modelLabel, 'codex-cli-default', 'labelled as what it runs on, with nothing appended');
  assert.equal('route' in choice, false);

  // Not a general "anything missing falls back": a REQUEST naming a model an
  // administrator deleted is still refused, because somebody just picked it and
  // can pick again. A profile's stored choice of one is stale like any other
  // that cannot run, and falls back - its owner did not delete it.
  await assert.rejects(() => config.resolveRequestedAIModel('deleted-model'), {
    name: 'ModelUnavailableError',
    detail: /was not found/,
  });
  const stale = await preferences.resolveAiChoice(undefined, { profileSettings: { ai: { modelId: 'deleted-model' } } });
  assert.equal(stale.modelId, 'codex-cli-default');
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
  ai.registerAdapter('codex-cli', () => ({
    id: 'codex-cli',
    capabilities: {
      id: 'codex-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
    },
    defaultModelName: () => 'default',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      requests.push(request);
      return { text: '{"ok":true}', resolvedModel: request.modelName, providerId: 'codex-cli', droppedParams: [], latencyMs: 1 };
    },
  }));

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'A job' },
    fallbackProvider: 'codex-cli',
    fallbackModelName: 'gpt-6-luna',
    useExactPromptId: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelName, 'gpt-6-luna');

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
    assert.deepEqual(Object.keys(settings.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
    assert.equal(
      settings.aiModels.some((entry) => /-web$/.test(entry.provider) || entry.id === 'free-hybrid'),
      false,
      'no seed model names a removed provider'
    );

    const created = await server.call('POST', '/models', { name: 'My Claude tab', provider: 'claude-web', modelName: 'chat' });
    assert.equal(created.status, 400);
    assert.match((await created.json()).error, /^Model provider must be one of: claude-cli, codex-cli\b/);

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
    // A retired provider's switch - browser or metered - is dropped, not refused.
    assert.equal('openai' in saved.providersEnabled, false);
    assert.equal('claude-web' in saved.providersEnabled, false);
    assert.equal('browserChatEnabled' in saved, false);

    const config = require('../dist/config/aiModelConfig');
    const raw = readSettingRaw(process.env.DB_DIR, APP_SETTINGS_KEY);
    assert.ok(raw, 'the save was written');
    for (const residue of ['browserChat', 'claude-web', 'chatgpt-web', '"openai"']) {
      assert.equal(raw.includes(residue), false, `${residue} is not persisted`);
    }
    assert.equal((await config.getAdminAppSettings()).defaultMode, 'generate');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------- the catalog */

test('the catalog offers only seats, and remembers the browsers it retired', () => {
  const catalog = loadFresh('../dist/config/providerCatalog');
  // What the provider health report and every settings form walk.
  assert.equal(catalog.AI_PROVIDER_IDS.some((id) => !id.endsWith('-cli')), false, 'subscription seats only');
  for (const id of ['claude-web', 'chatgpt-web']) {
    assert.equal(catalog.retiredProviderFamily(id), 'browser-chat', id);
  }
  for (const id of ['free-hybrid', 'claude-web-chat', 'chatgpt-web-chat']) {
    assert.equal(catalog.retiredModelFamily(id), 'browser-chat', id);
  }
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
    (await __currentChoiceForTests(hybrid, profile('claude-cli-opus'))).modelId,
    'claude-cli-opus',
    'resolved from the profile, as a new submission would be'
  );
  assert.equal(
    (await __currentChoiceForTests(hybrid, profile('claude-web-chat'))).modelId,
    'claude-cli-sonnet',
    'and a profile still naming a browser model lands on the default'
  );

  const pinned = { provider: 'codex-cli', modelName: 'default', modelId: 'codex-cli-default', modelLabel: 'Codex' };
  assert.equal(await __currentChoiceForTests(pinned, profile('claude-cli-opus')), pinned, 'the same object, untouched');
});

/* ---------------------------------------------- with a seat locked here */

/**
 * Runs `fn` with `locked` locked on this machine, the way an operator's .env
 * would, and puts this file's both-seats-unlocked setting back afterwards.
 * The lock lists are read on every call, so nothing needs reloading for it.
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

/** Every seat this build has, read from the catalog so a seat added later is locked too. */
function everySeat() {
  return loadFresh('../dist/config/providerCatalog').AI_PROVIDER_IDS.join(',');
}

/** Captures what `fn` warns, and gives it back with the result. */
async function captureWarnings(fn) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

/** What 002 left an install whose Claude seat was locked: the seat, and the browsers. */
const SEAT_AND_BROWSERS = {
  'claude-cli': true,
  'codex-cli': false,
  claude: false,
  openai: false,
  deepseek: false,
  'claude-web': true,
  'chatgpt-web': true,
};

/**
 * A seat-locked desktop install that ran on the free browser models, with
 * every other model switched off - which the old build accepted, because the
 * browser ones were runnable. Every provider is ticked: this is the MODEL check
 * failing, not the provider one.
 */
function browserModelsOnly() {
  return browserEraSettings({
    providersEnabled: {
      'claude-cli': true, 'codex-cli': true, claude: true, openai: true, deepseek: true,
      'claude-web': true, 'chatgpt-web': true,
    },
    aiModels: [
      model('claude-cli-sonnet', 'claude-cli', 'sonnet'),
      model('codex-cli-default', 'codex-cli', 'default', { enabled: false }),
      model('openai-gpt-5-1', 'openai', 'gpt-5.1', { enabled: false }),
      model('anthropic-sonnet', 'claude', 'claude-sonnet-4-20250514', { enabled: false }),
      model('claude-web-chat', 'claude-web', 'chat'),
      model('chatgpt-web-chat', 'chatgpt-web', 'chat'),
    ],
  });
}

test('an install whose only unlocked providers were the browsers still reads, on a provider it can run', async () => {
  // The locked seat is what pushed these installs onto the browsers. Reading
  // the seat as "switched on" repaired nothing - it is locked - and every
  // settings read failed, the admin page that would fix it included.
  const { dbDir } = freshStorage('lock-provider');
  const original = plantSettings(dbDir, browserEraSettings({ providersEnabled: SEAT_AND_BROWSERS }));

  // Gemini locked too, as on an install that never set it up: the row predates
  // that seat, and unrecorded it would outrank the Codex seat the row switched off.
  await withLocks('claude-cli,gemini-cli', async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.providersEnabled['codex-cli'], true, 'the seat that is left');
    assert.equal(admin.defaultModelId, 'codex-cli-default');
    assert.equal((await config.resolveRequestedAIModel()).provider, 'codex-cli');
  });

  await withLocks(everySeat(), async () => {
    // No seat left, and nothing metered to fall back on: the read still
    // succeeds, offering nothing, and a run is refused naming the locks.
    const config = loadFresh('../dist/config/aiModelConfig');
    const userSettings = await config.getUserAppSettings();
    assert.deepEqual(userSettings.models, []);
    assert.equal(userSettings.defaultModelId, '');
    await assert.rejects(() => config.resolveRequestedAIModel(), /every AI provider is locked/);
  });

  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original, 'repaired in memory only');
});

test('an install whose only runnable models were the browsers still reads, with a seat locked', async () => {
  const { dbDir } = freshStorage('lock-models');
  const original = plantSettings(dbDir, browserModelsOnly());

  await withLocks('claude-cli', async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.aiModels.find((entry) => entry.id === 'codex-cli-default').enabled, true, 'switched back on');
    assert.equal(admin.defaultModelId, 'codex-cli-default');
    assert.deepEqual((await config.listAvailableAIModels()).map((entry) => entry.id), ['codex-cli-default']);
    // The way out through the app works too: every one of these reads first.
    await config.updateAIModel('claude-cli-sonnet', { name: 'Sonnet' });
  });

  plantSettings(dbDir, browserModelsOnly());
  await withLocks(everySeat(), async () => {
    // The metered models it had are retired with the rest: nothing is
    // switched back on that would bill, and nothing can run.
    const config = loadFresh('../dist/config/aiModelConfig');
    assert.deepEqual((await config.getUserAppSettings()).models, []);
  });
  assert.notEqual(original, null);
});

test('006 repairs onto a provider this machine can run, and repoints the default to one', async () => {
  // Lock-blind, it switched on - and stored as the default - the locked seat,
  // then stamped the version, so nothing looked at the row again.
  for (const [locked, settings, expected] of [
    ['claude-cli', browserEraSettings({ providersEnabled: SEAT_AND_BROWSERS }), 'codex-cli-default'],
    ['claude-cli', browserModelsOnly(), 'codex-cli-default'],
  ]) {
    const { dbDir } = freshStorage(`lock-006-${expected}`);
    plantSettings(dbDir, settings);
    await withLocks(locked, async () => {
      const db = openDb(dbDir);
      let report;
      try {
        report = migrate006()(db);
      } finally {
        db.close();
      }
      assert.deepEqual(report.repointedDefaultModel, { from: 'claude-web-chat', to: expected }, locked);

      const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
      assert.equal(stored.defaultModelId, expected);
      const target = stored.aiModels.find((entry) => entry.id === expected);
      assert.equal(target.enabled, true, `${expected} is stored switched on`);
      assert.equal(stored.providersEnabled[target.provider], true, `and so is ${target.provider}`);
      assert.equal(
        report.enabledProviders.includes('claude-cli') || report.reenabledModels.includes('claude-cli-sonnet'),
        false,
        'the locked seat is never what comes back'
      );

      // Stored, so the reader has nothing left to repair.
      const config = loadFresh('../dist/config/aiModelConfig');
      assert.equal((await config.getAdminAppSettings()).defaultModelId, expected);
    });
  }
});

test('a row the lock-blind 006 already cleaned and stamped still reads', async () => {
  // Such a row has no residue left to say it ran browser chat; the snapshot 006
  // kept of it does. And 006 will not run on it again.
  const { dbDir } = freshStorage('lock-after-old-006');
  // As it reads once 007 has also been through it: no metered residue either,
  // so nothing in the row itself says a removal answers for it.
  const cleaned = {
    ...browserEraSettings({
      providersEnabled: { 'claude-cli': true, 'codex-cli': false },
      defaultModelId: 'claude-cli-sonnet',
      aiModels: [model('claude-cli-sonnet', 'claude-cli', 'sonnet'), model('codex-cli-default', 'codex-cli', 'default')],
    }),
  };
  for (const key of ['browserChatEnabled', 'browserChatEndpoints', 'browserChatDebugPort']) delete cleaned[key];
  plantSettings(dbDir, cleaned);
  setVersion(dbDir, 7);

  // The Gemini seat is locked as well: the row predates it, so it reads as
  // switched on, and this is about the seats the row did choose between.
  await withLocks('claude-cli,gemini-cli', async () => {
    // Without the snapshot this is an install that never ran browser chat and
    // whose operator locked the one provider they ticked: that still fails, by
    // name, pointing at the lock they set - which is where it is undone.
    await assert.rejects(
      () => loadFresh('../dist/config/aiModelConfig').getAdminAppSettings(),
      /unlocked AI provider must remain enabled/
    );

    writeSettingRaw(dbDir, SNAPSHOT_KEY, JSON.stringify(browserEraSettings({ providersEnabled: SEAT_AND_BROWSERS })));
    const config = loadFresh('../dist/config/aiModelConfig');
    const admin = await config.getAdminAppSettings();
    assert.equal(admin.providersEnabled['codex-cli'], true);
    assert.equal(admin.defaultModelId, 'codex-cli-default');
  });
});

/* ------------------------------------------------- the rest of the upgrade */

test('an administrator promoted at boot gets the waiting migrations before any save can strip the records', async () => {
  // ADMIN_EMAILS naming an account that already exists makes it an
  // administrator at boot - after the chain has already stopped at 003 for
  // want of one. Left stopped, the first admin save normalized the browser
  // records out of the row, 006 never learned the id of the operator's own
  // browser model, and a profile pinned to it failed every generation.
  const { dbDir } = freshStorage('boot-promotion');
  plantSettings(dbDir, browserEraSettings());
  const users = loadFresh('../dist/database/userRepository');
  users.createUser({ email: 'ops@example.com' });
  const db = openDb(dbDir);
  try {
    plantProfile(db, 'p-uuid', { modelId: OPERATOR_BROWSER_MODEL_ID });
  } finally {
    db.close();
  }
  assert.equal(readVersion(dbDir), '1', 'no administrator yet');

  useAdminEmails('ops@example.com');
  const { applyConfiguredAdmins } = loadFresh('../dist/services/auth/authService');
  assert.equal(applyConfiguredAdmins(), 1);
  assert.equal(readVersion(dbDir), '8', 'the chain ran on promotion, not on the next restart');
  assert.ok(readSettingRaw(dbDir, SNAPSHOT_KEY), 'with its snapshot');

  // The administrator's first save, then a restart.
  await loadFresh('../dist/config/aiModelConfig').updateAppSettings({ defaultMode: 'generate' });
  loadFresh('../dist/config/aiModelConfig');
  const preferences = loadFresh('../dist/config/aiPreferences');
  const profile = loadFresh('../dist/database/profileRepository').getProfile('p-uuid');
  assert.equal(profile.profileSettings.ai.modelId, undefined, '006 cleared it');
  assert.equal((await preferences.resolveAiChoice(undefined, profile)).modelId, 'claude-cli-sonnet');
});

test('006 keeps no copy of an API key store the settings reader deletes', async () => {
  // On a normal boot 006 runs before the first settings read, which is what
  // deletes the store from the row - so a verbatim snapshot was the one place
  // the secrets would have survived, for good.
  const { dbDir } = freshStorage('api-keys');
  plantSettings(dbDir, browserEraSettings({ apiKeys: { openai: { entries: [{ key: 'sk-REAL-SECRET' }] } } }));
  const db = openDb(dbDir);
  let report;
  try {
    report = migrate006()(db);
  } finally {
    db.close();
  }

  const snapshot = readSettingRaw(dbDir, SNAPSHOT_KEY);
  assert.equal(snapshot.includes('sk-REAL-SECRET'), false);
  assert.equal('apiKeys' in JSON.parse(snapshot), false);
  assert.deepEqual(JSON.parse(snapshot), browserEraSettings(), 'and everything else as it was');
  assert.ok(report.notes.some((note) => /API keys/.test(note)), 'which the log says');

  await loadFresh('../dist/config/aiModelConfig').getAdminAppSettings();
  for (const key of [APP_SETTINGS_KEY, SNAPSHOT_KEY]) {
    assert.equal(readSettingRaw(dbDir, key).includes('sk-REAL-SECRET'), false, `${key} holds no key`);
  }
});

test('a stored default naming a browser model is said once, as the other retired choices are', async () => {
  const { dbDir } = freshStorage('default-warning');
  plantSettings(
    dbDir,
    browserEraSettings({
      aiModels: [model('claude-cli-sonnet', 'claude-cli', 'sonnet'), model('openai-gpt-5-1', 'openai', 'gpt-5.1')],
      defaultModelId: 'free-hybrid',
    })
  );

  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const config = loadFresh('../dist/config/aiModelConfig');
    assert.equal((await config.getUserAppSettings()).defaultModelId, 'claude-cli-sonnet');
    config.invalidateSettingsCache();
    await config.getUserAppSettings();
  } finally {
    console.warn = warn;
  }
  const lines = warnings.filter((line) => line.includes('"free-hybrid"'));
  assert.equal(lines.length, 1, 'once, however many reads');
  assert.match(lines[0], /stored default model/);
  assert.match(lines[0], /claude-cli-sonnet/, 'naming what runs instead');
});

/* ----------------------------------------- whose choice, and after a restart */

function runMigration006(dbDir) {
  const db = openDb(dbDir);
  try {
    return migrate006()(db);
  } finally {
    db.close();
  }
}

test("after 006, a lock under an administrator's own choice fails by name rather than undo it", async () => {
  // The snapshot 006 keeps never goes away, and the repair once keyed on it
  // alone. On every upgraded install, an administrator who switched the Codex
  // seat off after the upgrade had it switched back on by the next lock, with a
  // log line blaming browser chat.
  const { dbDir } = freshStorage('post-006-save');
  plantSettings(dbDir, browserEraSettings());
  runMigration006(dbDir);

  // Their own choice, saved after the upgrade: the Claude seat alone.
  await loadFresh('../dist/config/aiModelConfig').updateAppSettings({
    providersEnabled: { 'claude-cli': true, 'codex-cli': false, 'gemini-cli': false },
  });

  await withLocks('claude-cli', async () => {
    await assert.rejects(
      () => loadFresh('../dist/config/aiModelConfig').getAdminAppSettings(),
      /unlocked AI provider must remain enabled\. Locked in this installation: Claude \(Subscription\)\./
    );
  });
  await withLocks(everySeat(), async () => {
    // With every seat locked there is no choice of theirs left to undo: the
    // read degrades to nothing runnable, and a run names the locks.
    const config = loadFresh('../dist/config/aiModelConfig');
    assert.deepEqual((await config.getUserAppSettings()).models, []);
    await assert.rejects(() => config.resolveRequestedAIModel(), /every AI provider is locked/);
  });
});

test('a lock under the row 006 left, unchanged since, is still repaired - and the log names the lock', async () => {
  const { dbDir } = freshStorage('post-006-lock');
  plantSettings(dbDir, browserEraSettings({ providersEnabled: SEAT_AND_BROWSERS }));
  runMigration006(dbDir);
  // A save that leaves which providers and models are on alone is not a choice
  // about them.
  await loadFresh('../dist/config/aiModelConfig').updateAppSettings({ defaultMode: 'generate' });

  // Gemini locked as well, as on an install that never set it up: the save
  // above recorded it switched on, which would rank it ahead of Codex.
  await withLocks('claude-cli,gemini-cli', async () => {
    const { result: admin, warnings } = await captureWarnings(() =>
      loadFresh('../dist/config/aiModelConfig').getAdminAppSettings()
    );
    assert.equal(admin.providersEnabled['codex-cli'], true);
    assert.equal(admin.defaultModelId, 'codex-cli-default');
    const line = warnings.find((entry) => entry.includes('"Codex (Subscription)"'));
    assert.ok(line, 'said once');
    assert.match(
      line,
      /switch on can run on this machine \(locked here: claude-cli, gemini-cli\)/,
      'about the lock'
    );
    assert.match(line, /still what migration 006 left/);
  });
});

test("an administrator's own browser model reads as the default after 006, across a restart", async () => {
  // 006 deletes the record at boot, usually before anything has read it, so a
  // process never saw its id. A builder tab left open across the upgrade got
  // "was not found", and so - for good, as 006 does not run again - did every
  // run of a profile that a stale editor saved the old choice back into.
  const { dbDir } = freshStorage('uuid-after-006');
  plantSettings(dbDir, browserEraSettings({ defaultModelId: 'codex-cli-default' }));
  runMigration006(dbDir);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY).includes(OPERATOR_BROWSER_MODEL_ID), false);

  const { result, warnings } = await captureWarnings(async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    const preferences = loadFresh('../dist/config/aiPreferences');
    return {
      config,
      requested: await config.resolveRequestedAIModel(OPERATOR_BROWSER_MODEL_ID),
      again: await config.resolveRequestedAIModel(OPERATOR_BROWSER_MODEL_ID),
      stored: await config.resolveStoredAIModelPreference(OPERATOR_BROWSER_MODEL_ID),
      profile: await preferences.resolveAiChoice(undefined, {
        profileSettings: { ai: { modelId: OPERATOR_BROWSER_MODEL_ID } },
      }),
    };
  });
  for (const key of ['requested', 'again', 'stored']) assert.equal(result[key].id, 'codex-cli-default', key);
  assert.equal(result.profile.modelId, 'codex-cli-default');
  assert.equal(
    warnings.filter((line) => line.includes(`A request named "${OPERATOR_BROWSER_MODEL_ID}"`)).length,
    1,
    'said once'
  );
  // Still not "anything missing falls back".
  await assert.rejects(() => result.config.resolveRequestedAIModel('deleted-model'), {
    name: 'ModelUnavailableError',
    detail: /was not found/,
  });

  // Every entry of the log counts: a later run's, and one under a dated key.
  writeSettingRaw(
    dbDir,
    LOG_KEY,
    JSON.stringify({ removedModelIds: [], at: '2026-06-01', laterRuns: [{ removedModelIds: ['later-run-model'] }] })
  );
  writeSettingRaw(dbDir, `${LOG_KEY}.2026-06-03T00:00:00.000Z`, JSON.stringify({ removedModelIds: ['dated-run-model'] }));
  const config = loadFresh('../dist/config/aiModelConfig');
  for (const id of ['later-run-model', 'dated-run-model']) {
    assert.equal((await config.resolveRequestedAIModel(id)).id, 'codex-cli-default', id);
  }
});

test('the boot promotes the administrator - and so runs 006 - before the queue restore reads anything', () => {
  // Restored first, the queue read a profile 006 cleared a moment later, and
  // the log told the operator to fix a preference that was already fixed.
  // Read from the source, as batchParallelism is: index.ts starts a server.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const listen = source.slice(source.indexOf('app.listen('));
  const promote = listen.indexOf('applyConfiguredAdmins()');
  const noAdmin = listen.indexOf('warnIfNoAdmin()');
  const restore = listen.indexOf('restoreGenerationQueue()');
  assert.ok(promote > 0 && noAdmin > 0 && restore > 0, 'all three are in the listen callback');
  assert.ok(promote < restore, 'promotion first');
  assert.ok(noAdmin < restore, 'and the warning that depends on it');
});

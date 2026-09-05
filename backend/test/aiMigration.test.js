const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { loadFresh, readSettingRaw, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * The provider migration, run against raw rows.
 *
 * The migration deliberately uses raw JSON and raw SQL, so these tests do too:
 * they plant the exact bytes an older release wrote and then read the bytes it
 * leaves behind. Every case ends by loading the settings through the normal
 * strict path, because "does not throw on the next boot" is the property that
 * actually matters.
 */

const APP_SETTINGS_KEY = 'app-settings';
const BACKUP_KEY = 'app-settings.backup.pre-claude-cli';

function openDb(dbDir) {
  return new Database(path.join(dbDir, 'free_tailor.db'));
}

function legacySettings(rootDir, overrides = {}) {
  return {
    openaiEnabled: true,
    claudeEnabled: true,
    openrouterEnabled: true,
    deepseekEnabled: true,
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: '',
    defaultProfileId: '',
    defaultModelId: 'openrouter-openai-gpt-5-4-nano',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    outputBaseDir: path.join(rootDir, 'generated-output'),
    outputPathTemplate: '/{{date}}/{{profile name}}/{{company name}}',
    aiModels: [
      {
        id: 'openrouter-openai-gpt-5-4-nano',
        name: 'GPT-5.4 nano',
        provider: 'openrouter',
        modelName: 'openai/gpt-5.4-nano',
        description: 'Low-latency OpenRouter option.',
        enabled: true,
        createdAt: '2026-04-10T03:09:38.170Z',
        updatedAt: '2026-04-10T03:09:38.170Z',
      },
      {
        id: 'openai-gpt-5-1',
        name: 'gpt-5.1',
        provider: 'openai',
        modelName: 'gpt-5.1',
        description: 'OpenAI direct default.',
        enabled: true,
        createdAt: '2026-04-10T03:09:38.170Z',
        updatedAt: '2026-04-10T03:09:38.170Z',
      },
    ],
    googleSheetsSources: [],
    apiKeys: {
      openai: { activeKeyId: '', entries: [] },
      claude: { activeKeyId: '', entries: [] },
      openrouter: {
        activeKeyId: 'key-1',
        entries: [
          { id: 'key-1', name: 'OpenRouter', value: 'sk-or-secret', createdAt: '2026-04-10T00:00:00.000Z' },
        ],
      },
      deepseek: { activeKeyId: '', entries: [] },
    },
    ...overrides,
  };
}

test('a settings row written before the provider change migrates and then loads', async () => {
  const { rootDir, dbDir } = useTempStorage('migration-full');
  const original = JSON.stringify(legacySettings(rootDir), null, 2);
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, original);

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  // The flag the admin actually set for the provider this one replaces carries
  // over rather than being dropped.
  assert.equal(loaded.providersEnabled['claude-cli'], true);
  assert.equal(loaded.providersEnabled.openai, true);

  // Model rows naming OpenRouter models are removed - "openai/gpt-5.4-nano"
  // means nothing to the Claude CLI - and subscription models are seeded.
  const providers = loaded.aiModels.map((model) => model.provider);
  assert.equal(providers.includes('openrouter'), false);
  assert.ok(providers.includes('claude-cli'));
  assert.ok(loaded.aiModels.some((model) => model.id === 'openai-gpt-5-1'), 'other providers are untouched');

  // A default pointing at a model that no longer exists is repointed.
  assert.equal(loaded.defaultModelId, 'claude-cli-sonnet');

  // The keyless provider gets a key-store slot so the admin page cannot index
  // into a hole, and is reported as needing no key at all.
  assert.equal(loaded.apiKeys['claude-cli'].requiresApiKey, false);
  assert.equal(loaded.apiKeys['claude-cli'].activeSource, 'subscription');

  // The pre-migration row is preserved verbatim, so a rollback is a copy.
  assert.equal(readSettingRaw(dbDir, BACKUP_KEY), original);
});

test('migrating is idempotent: a second boot changes nothing', async () => {
  const { rootDir, dbDir } = useTempStorage('migration-idempotent');
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(legacySettings(rootDir), null, 2));

  const first = loadFresh('../dist/config/aiModelConfig');
  await first.getAdminAppSettings();
  const afterFirst = readSettingRaw(dbDir, APP_SETTINGS_KEY);

  // Re-run the migration directly against the same database, as a restart
  // with a lost version stamp would.
  const migrations = loadFresh('../dist/database/migrations/index');
  const db = openDb(dbDir);
  try {
    db.exec('DELETE FROM schema_meta');
    migrations.runDataMigrations(db);
  } finally {
    db.close();
  }

  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), afterFirst);
  assert.equal(readSettingRaw(dbDir, BACKUP_KEY), JSON.stringify(legacySettings(rootDir), null, 2));
});

test('a row whose only enabled provider was OpenRouter comes back with a working one', async () => {
  // Without the carry-over this row migrates to "no provider enabled", which
  // `assertAtLeastOneProviderEnabled` rejects on every read - a settings page
  // that cannot be loaded to fix itself.
  const { rootDir, dbDir } = useTempStorage('migration-only-openrouter');
  writeSettingRaw(
    dbDir,
    APP_SETTINGS_KEY,
    JSON.stringify(
      legacySettings(rootDir, {
        openaiEnabled: false,
        claudeEnabled: false,
        deepseekEnabled: false,
        openrouterEnabled: true,
      }),
      null,
      2
    )
  );

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  assert.equal(loaded.providersEnabled['claude-cli'], true);
  assert.equal(loaded.providersEnabled.openai, false);
});

test('a row with no models and no default still loads after migration', async () => {
  // The minimal shape the settings normalizer has always accepted.
  const { rootDir, dbDir } = useTempStorage('migration-partial');
  const partial = legacySettings(rootDir);
  delete partial.aiModels;
  delete partial.defaultModelId;
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(partial, null, 2));

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  assert.ok(loaded.aiModels.length > 0);
  assert.ok(loaded.defaultModelId);
});

test('an unparseable settings row is left exactly as it was found', async () => {
  // getSetting throws on invalid JSON on purpose, so corruption is surfaced
  // rather than silently replaced. The migration must not make it worse.
  const { dbDir } = useTempStorage('migration-invalid');
  const invalid = '{ this is not json';
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, invalid);

  const migrations = loadFresh('../dist/database/migrations/index');
  const db = openDb(dbDir);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY, name TEXT, disabled INTEGER DEFAULT 0,
        data TEXT NOT NULL, created_at TEXT, updated_at TEXT
      );
    `);
    migrations.runDataMigrations(db);
  } finally {
    db.close();
  }

  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), invalid);
  assert.equal(readSettingRaw(dbDir, BACKUP_KEY), null);
});

test('prompt records naming the removed provider are repointed and backed up', async () => {
  const { rootDir, dbDir } = useTempStorage('migration-prompts');
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(legacySettings(rootDir), null, 2));

  const now = new Date().toISOString();
  const db = openDb(dbDir);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY, name TEXT, disabled INTEGER DEFAULT 0,
        data TEXT NOT NULL, created_at TEXT, updated_at TEXT
      );
    `);
    const insert = db.prepare(
      'INSERT INTO prompts (id, name, disabled, data, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)'
    );
    insert.run(
      'custom-variant',
      'Custom Variant',
      JSON.stringify({ id: 'custom-variant', modelProvider: 'openrouter', modelName: 'openai/gpt-5.4-nano' }),
      now,
      now
    );
    insert.run(
      'tailor-resume',
      'Tailor Resume',
      JSON.stringify({ id: 'tailor-resume', modelProvider: 'openrouter', modelName: 'openai/gpt-5.4-nano' }),
      now,
      now
    );
  } finally {
    db.close();
  }

  const migrations = loadFresh('../dist/database/migrations/index');
  const db2 = openDb(dbDir);
  try {
    migrations.runDataMigrations(db2);

    const custom = JSON.parse(db2.prepare('SELECT data FROM prompts WHERE id = ?').get('custom-variant').data);
    assert.equal(custom.modelProvider, 'claude-cli');
    assert.equal(custom.modelName, 'sonnet');

    // A shipped prompt's override is CLEARED, not repointed: pinning a model
    // there silently beat the model the user picked in the UI, for the two
    // heaviest calls in the app.
    const shipped = JSON.parse(db2.prepare('SELECT data FROM prompts WHERE id = ?').get('tailor-resume').data);
    assert.equal('modelProvider' in shipped, false);
    assert.equal('modelName' in shipped, false);

    const backup = db2
      .prepare('SELECT data FROM prompts_backup_pre_claude_cli WHERE id = ?')
      .get('custom-variant');
    assert.ok(backup, 'the original prompt row must be recoverable');
    assert.match(backup.data, /openrouter/);
  } finally {
    db2.close();
  }
});

test('a row that never customised its model library keeps every provider model', async () => {
  // A row with no `aiModels` key inherits the full default catalogue at read
  // time. Writing an explicit list would freeze that into a CLI-only list and
  // permanently remove every OpenAI, Anthropic and DeepSeek model from an
  // install that had simply never touched the model library.
  const { rootDir, dbDir } = useTempStorage('migration-implicit-models');
  const partial = legacySettings(rootDir);
  delete partial.aiModels;
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(partial, null, 2));

  const config = loadFresh('../dist/config/aiModelConfig');
  const loaded = await config.getAdminAppSettings();

  const providers = new Set(loaded.aiModels.map((model) => model.provider));
  assert.ok(providers.has('claude-cli'));
  assert.ok(providers.has('openai'), 'the OpenAI models must survive');
  assert.ok(providers.has('claude'), 'the Anthropic models must survive');
  assert.ok(providers.has('deepseek'), 'the DeepSeek models must survive');
  assert.equal(providers.has('openrouter'), false);
});

test('the legacy data importer migrates the row it plants, even after boot stamped the version', async () => {
  // runDataMigrations returns immediately once the version is stamped, so the
  // importer has to call the migration itself - otherwise a legacy
  // ai-models.json planted long after boot stays un-migrated forever.
  const { rootDir, dbDir } = useTempStorage('migration-legacy-import');
  const migration = loadFresh('../dist/database/migrations/001_openrouter_to_claude_cli');
  const migrations = loadFresh('../dist/database/migrations/index');

  const db = openDb(dbDir);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY, name TEXT, disabled INTEGER DEFAULT 0,
        data TEXT NOT NULL, created_at TEXT, updated_at TEXT
      );
    `);

    // Boot: nothing to do, but the version gets stamped.
    migrations.runDataMigrations(db);
    migrations.runDataMigrations(db);

    // The importer plants a legacy row afterwards...
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      APP_SETTINGS_KEY,
      JSON.stringify(legacySettings(rootDir)),
      new Date().toISOString()
    );

    // ...and the stamped wrapper would now be a no-op, so it calls this.
    const report = migration.migrate001(db);
    assert.equal(report.ran, true, 'the planted legacy row must still be migrated');

    const after = JSON.parse(
      db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APP_SETTINGS_KEY).value
    );
    assert.equal('openrouterEnabled' in after, false);
    assert.equal(after.providersEnabled['claude-cli'], true);
  } finally {
    db.close();
  }
});

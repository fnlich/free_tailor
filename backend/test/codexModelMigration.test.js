const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  loadFresh,
  readSettingRaw,
  useAdminEmails,
  useTempStorage,
  writeSettingRaw,
} = require('./helpers');

/**
 * Migration 005: the Codex model record an upgraded install never got.
 *
 * Raw rows, like the migrations they exercise, because a test that goes through
 * the validators only proves something about rows that did not need migrating.
 *
 * WHAT THIS IS FOR, because the shipped bug was invisible from a fresh install
 * and every existing test started from one. Three things combined:
 *
 *   - the seed list is only read when there is NO stored `aiModels` array;
 *   - `normalizeProvidersEnabled` ends in `?? true`, so `codex-cli` came out
 *     ENABLED on every upgraded row;
 *   - the model picker lists models, not providers.
 *
 * So Codex showed as enabled with a green health line and could not be selected
 * anywhere. "The provider id is known" was true and told us nothing.
 */

const APP_SETTINGS_KEY = 'app-settings';

/**
 * An administrator, because the migration runner is a CHAIN.
 *
 * 003 defers while no admin exists and the runner stops there rather than
 * skipping ahead, so without this 005 never runs and the test would be measuring
 * the deferral, not the seeding. A real upgraded install always has one - that is
 * what makes it an upgraded install.
 */
function withAdmin() {
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  users.createUser({ email: 'admin@example.com' });
}

/**
 * Says the database has already run everything up to 004.
 *
 * Which ISOLATES the migration under test from the ones before it: 001-004 have
 * their own tests, and assertions about what 005 left alone must not be
 * measuring them. What comes AFTER 005 still runs, as it does on a real boot -
 * the fixture below carries the browser chat rows an install of that era had,
 * and 006 takes them out in the same pass.
 */
function alreadyMigratedTo(dbDir, version) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_meta (
         key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
       );`
    );
    db.prepare(
      `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('provider_schema_version', String(version), new Date().toISOString());
  } finally {
    db.close();
  }
}

/**
 * A boot, as far as the migrations are concerned.
 *
 * They run on the first use of the database CONNECTION, and `loadFresh` clears
 * one module rather than its dependencies - so re-loading a config module reuses
 * the connection that already ran them. Dropping the sqlite module is what makes
 * this a second start rather than a second read.
 */
function reboot() {
  loadFresh('../dist/database/sqlite');
}

/** The bytes a release before the Codex provider would have written. */
function preCodexSettings() {
  return {
    providersEnabled: {
      'claude-cli': true,
      'claude-web': true,
      'chatgpt-web': true,
      openai: true,
      claude: false,
      deepseek: false,
    },
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: '',
    defaultProfileId: '',
    defaultModelId: 'claude-cli-sonnet',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    aiModels: [
      {
        id: 'claude-cli-sonnet',
        name: 'Claude Sonnet (subscription)',
        provider: 'claude-cli',
        modelName: 'sonnet',
        description: 'Seat.',
        enabled: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'claude-web-chat',
        name: 'Claude (free)',
        provider: 'claude-web',
        modelName: 'chat',
        description: 'Browser.',
        enabled: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ],
  };
}

test('an install that predates Codex can actually select it afterwards', async () => {
  const { dbDir } = useTempStorage('codex-migration-upgrade');
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(preCodexSettings()));
  alreadyMigratedTo(dbDir, 4);

  withAdmin();

  // The migrations run on first use of the database, which is the real trigger -
  // not a hand call to migrate005.
  reboot();
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getAppSettings();

  const codexRows = settings.aiModels.filter((model) => model.provider === 'codex-cli');
  assert.equal(codexRows.length, 1, 'exactly one Codex record was added');
  assert.equal(codexRows[0].modelName, 'default', 'the sentinel that means "pass no -m"');

  // The property that was actually broken: enabled AND pickable, not one or the
  // other. An enabled provider with no model is a dead end on the page.
  assert.equal(settings.providersEnabled['codex-cli'], true);
  const pickable = config.getRunnableModels(settings);
  assert.ok(
    pickable.some((model) => model.provider === 'codex-cli'),
    'Codex is selectable - this is what showed as done and was not'
  );

  // Nothing else moved. The record is appended, so an unset default still falls
  // back to whatever stood first, and the stored default is untouched.
  assert.equal(settings.defaultModelId, 'claude-cli-sonnet');
  assert.equal(settings.aiModels[0].id, 'claude-cli-sonnet', 'appended, never prepended');

  // And the chain carried on past 005: the browser chat record and flags the
  // fixture holds are gone from the stored row, not merely hidden on read.
  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal(stored.aiModels.some((model) => model.provider === 'claude-web'), false);
  assert.equal('claude-web' in stored.providersEnabled, false);
  assert.equal('chatgpt-web' in stored.providersEnabled, false);
});

test('running twice adds one record, not two', async () => {
  const { dbDir } = useTempStorage('codex-migration-idempotent');
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(preCodexSettings()));
  alreadyMigratedTo(dbDir, 4);

  withAdmin();
  reboot();
  const first = loadFresh('../dist/config/aiModelConfig');
  await first.getAppSettings();
  const afterOne = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));

  // A second process against the same database. The version row stops the
  // migration re-running; this asserts the OUTCOME rather than the bookkeeping.
  reboot();
  const second = loadFresh('../dist/config/aiModelConfig');
  const settings = await second.getAppSettings();

  assert.equal(
    settings.aiModels.filter((model) => model.provider === 'codex-cli').length,
    1,
    'no duplicate row in the operator\'s picker'
  );
  assert.equal(
    afterOne.aiModels.filter((model) => model.provider === 'codex-cli').length,
    1
  );
});

test("an operator's own Codex row is left alone rather than joined by a seed", async () => {
  const { dbDir } = useTempStorage('codex-migration-own-row');
  const stored = preCodexSettings();
  stored.aiModels.push({
    id: 'my-codex',
    name: 'Codex, mine',
    provider: 'codex-cli',
    modelName: 'gpt-5.1-codex',
    description: 'Added by hand before upgrading.',
    enabled: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  });
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify(stored));
  alreadyMigratedTo(dbDir, 4);

  withAdmin();
  reboot();
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getAppSettings();

  const codexRows = settings.aiModels.filter((model) => model.provider === 'codex-cli');
  assert.equal(codexRows.length, 1, 'keyed on the provider, so no second row for it');
  assert.equal(codexRows[0].id, 'my-codex', "and it is the operator's, not the seed");
});

test('a fresh install needs no migration - the seed list already has it', async () => {
  useTempStorage('codex-migration-fresh');
  const config = loadFresh('../dist/config/aiModelConfig');
  const settings = await config.getAppSettings();
  assert.equal(
    settings.aiModels.filter((model) => model.provider === 'codex-cli').length,
    1
  );
});

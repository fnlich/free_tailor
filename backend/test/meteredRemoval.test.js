const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

/**
 * The seats every test here describes are unlocked, whatever the machine
 * running this says - the lock is providerLock.test.js's subject. Tests that
 * are about a lock set one for themselves. Set before any dist module loads.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const {
  loadFresh,
  readSettingRaw,
  useAdminEmails,
  useTempStorage,
  writeSettingRaw,
  writeStaticJson,
} = require('./helpers');

/**
 * The metered API providers are gone; what an upgraded install still holds of
 * them is not.
 *
 * `claude` (the Anthropic API), `openai` and `deepseek` billed every token to a
 * key in `.env`. An install that ran them has their model records, their enable
 * flags - in `providersEnabled` and, on an older row, as flat booleans - maybe a
 * stored key store, a default that named one of their seeds, prompt overrides
 * and profile preferences naming them, and queued tasks that chose one. As with
 * the browser chat removal, two things deal with that, and both are pinned here:
 *
 *   - Migration 007 removes it from the database, once, with a snapshot (minus
 *     the keys) to come back to, and puts a seat back where nothing else runs.
 *   - Every read path tolerates it without 007, permanently, and repairs a row
 *     that can run nothing by the same rule 007 uses - so an install does not
 *     change seat the moment 007 gets to run.
 *
 * Raw rows throughout: a test that goes through the validators only proves
 * something about rows that did not need migrating.
 */

const APP_SETTINGS_KEY = 'app-settings';
const SNAPSHOT_KEY = 'app-settings.backup.pre-metered-removal';
const LOG_KEY = 'migration-log.provider-schema-7';
const LEGACY_SNAPSHOT_KEY = 'app-settings.backup.pre-claude-cli';
const PROMPTS_BACKUP_TABLE = 'prompts_backup_pre_metered_removal';
const STAMP = '2026-05-01T00:00:00.000Z';
/** An administrator's own metered model: a random id no list can name. */
const OPERATOR_METERED_MODEL_ID = '0b8f3c7e-5d21-4a6b-9e0f-2c4d6e8a1b3f';
const SEEDED_METERED_IDS = [
  'openai-gpt-5-1',
  'openai-gpt-5',
  'openai-gpt-5-mini',
  'openai-gpt-5-nano',
  'claude-claude-sonnet-4-20250514',
  'deepseek-deepseek-v4-flash',
  'deepseek-deepseek-v4-pro',
];

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
 * A database with this build's tables and nothing migrated past 001: with no
 * administrator 003 defers and the chain stops there, which is the state in
 * which every read must cope with the residue on its own.
 */
function freshStorage(name) {
  const storage = useTempStorage(`metered-removal-${name}`);
  setVersion(storage.dbDir, 1);
  loadFresh('../dist/database/sqlite').getDb();
  return storage;
}

function model(id, provider, modelName, extra = {}) {
  return { id, name: id, provider, modelName, description: '', enabled: true, createdAt: STAMP, updatedAt: STAMP, ...extra };
}

/** The settings row a typical install that used the metered APIs has. */
function meteredEraSettings(overrides = {}) {
  return {
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, claude: true, openai: true, deepseek: false },
    claudeEnabled: true,
    openaiEnabled: true,
    deepseekEnabled: false,
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: '',
    defaultProfileId: '',
    defaultModelId: 'openai-gpt-5-1',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    aiModels: [
      model('claude-cli-sonnet', 'claude-cli', 'sonnet'),
      model('codex-cli-default', 'codex-cli', 'default'),
      model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      model('claude-claude-sonnet-4-20250514', 'claude', 'claude-sonnet-4-20250514'),
      model(OPERATOR_METERED_MODEL_ID, 'deepseek', 'deepseek-reasoner', { name: 'My DeepSeek' }),
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

function plantPrompt(db, id, data) {
  db.prepare(
    `INSERT INTO prompts (id, feature_key, is_built_in, data, created_at, updated_at)
     VALUES (?, NULL, 0, ?, ?, ?)`
  ).run(id, JSON.stringify({ id, name: id, content: 'Prompt.', ...data }), STAMP, STAMP);
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

function runMigration007(dbDir, prepare) {
  const db = openDb(dbDir);
  try {
    if (prepare) prepare(db);
    return loadFresh('../dist/database/migrations/007_remove_metered_providers').migrate007(db);
  } finally {
    db.close();
  }
}

/** Runs `fn` with the given variables set (undefined deletes), restoring them after. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Locks `locked` the way an operator's .env would, for the duration of `fn`. */
function withLocks(locked, fn) {
  return withEnv({ AI_LOCKED_PROVIDERS: locked, AI_UNLOCKED_PROVIDERS: undefined }, fn);
}

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

/* ------------------------------------------------------------ migration 007 */

test('007 strips every metered record, flag and key store, after a snapshot that keeps no key', async () => {
  const { dbDir } = freshStorage('settings');
  const settings = meteredEraSettings({ apiKeys: { openai: { entries: [{ value: 'sk-REAL-SECRET' }] } } });
  plantSettings(dbDir, settings);

  const report = runMigration007(dbDir);
  assert.equal(report.ran, true);
  assert.equal(report.settingsRewritten, true);
  assert.equal(report.removedModels, 3, 'both seeds and the one the administrator added');
  assert.deepEqual(
    [...report.removedModelIds].sort(),
    [OPERATOR_METERED_MODEL_ID, 'claude-claude-sonnet-4-20250514', 'openai-gpt-5-1'].sort()
  );
  assert.deepEqual([...report.removedProviderFlags].sort(), ['claude', 'deepseek', 'openai']);
  assert.deepEqual(
    [...report.removedSettingsKeys].sort(),
    ['apiKeys', 'claudeEnabled', 'deepseekEnabled', 'openaiEnabled']
  );

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.deepEqual(stored.aiModels.map((entry) => entry.id), ['claude-cli-sonnet', 'codex-cli-default']);
  assert.deepEqual(Object.keys(stored.providersEnabled).sort(), ['claude-cli', 'codex-cli']);
  for (const key of ['apiKeys', 'claudeEnabled', 'openaiEnabled', 'deepseekEnabled']) {
    assert.equal(key in stored, false, `${key} is gone`);
  }
  assert.equal(stored.defaultModelId, 'claude-cli-sonnet', 'a default on a metered seed is repointed onto the seat');
  assert.equal(stored.defaultMode, 'preview', 'nothing unrelated is touched');

  // The row as it was, minus the one thing that must not outlive it.
  const snapshot = readSettingRaw(dbDir, SNAPSHOT_KEY);
  assert.equal(snapshot.includes('sk-REAL-SECRET'), false);
  const { apiKeys: _keys, ...withoutKeys } = settings;
  assert.deepEqual(JSON.parse(snapshot), withoutKeys);

  const log = JSON.parse(readSettingRaw(dbDir, LOG_KEY));
  assert.equal(JSON.stringify(log).includes('sk-REAL-SECRET'), false, 'the log names the key store, never its contents');
  assert.deepEqual(log.repointedDefaultModel, { from: 'openai-gpt-5-1', to: 'claude-cli-sonnet' });
  assert.deepEqual(log.leftRunning, {
    providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': true },
    enabledModelIds: ['claude-cli-sonnet', 'codex-cli-default'],
  });
  assert.ok(log.at);

  // And the row reads through the strict path.
  const admin = await loadFresh('../dist/config/aiModelConfig').getAdminAppSettings();
  assert.equal(admin.defaultModelId, 'claude-cli-sonnet');
});

test('007 repoints a removed default onto the seats in catalog order, not list order', async () => {
  // With no Sonnet, the first runnable seat model in seat order - an operator's
  // list order says where they happened to add a row, not what should run.
  const { dbDir } = freshStorage('default-order');
  plantSettings(
    dbDir,
    meteredEraSettings({
      defaultModelId: OPERATOR_METERED_MODEL_ID,
      aiModels: [
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
        model('codex-cli-default', 'codex-cli', 'default'),
        model('claude-cli-opus', 'claude-cli', 'opus'),
        model(OPERATOR_METERED_MODEL_ID, 'deepseek', 'deepseek-reasoner'),
      ],
    })
  );
  assert.deepEqual(runMigration007(dbDir).repointedDefaultModel, {
    from: OPERATOR_METERED_MODEL_ID,
    to: 'claude-cli-opus',
  });

  // A row that never customised its models inherits the seeds: the first
  // usable seat's default.
  for (const [locked, expected] of [
    [undefined, 'claude-cli-sonnet'],
    ['claude-cli', 'codex-cli-default'],
  ]) {
    const implicit = freshStorage(`default-implicit-${expected}`);
    const settings = meteredEraSettings({ defaultModelId: 'deepseek-deepseek-v4-flash' });
    delete settings.aiModels;
    plantSettings(implicit.dbDir, settings);
    const report = locked
      ? await withLocks(locked, () => runMigration007(implicit.dbDir))
      : runMigration007(implicit.dbDir);
    assert.deepEqual(report.repointedDefaultModel, { from: 'deepseek-deepseek-v4-flash', to: expected }, locked);
    const stored = JSON.parse(readSettingRaw(implicit.dbDir, APP_SETTINGS_KEY));
    assert.equal('aiModels' in stored, false, 'still inherits them');
    assert.deepEqual(report.leftRunning.enabledModelIds, null);
  }
});

test('007 gives an install that ran only on the metered APIs a seat back - never a model that bills', async () => {
  // The Claude seat switched on but every one of its models off: the operator
  // ran on the APIs alone. Without a repair this row can run nothing, and the
  // settings reader would refuse it.
  const { dbDir } = freshStorage('metered-only');
  plantSettings(
    dbDir,
    meteredEraSettings({
      providersEnabled: { 'claude-cli': true, 'codex-cli': false, 'gemini-cli': false, openai: true },
      aiModels: [
        model('my-sonnet', 'claude-cli', 'sonnet', { enabled: false }),
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      ],
    })
  );

  // Read before 007 has run: repaired in memory, by the same rule.
  const before = await loadFresh('../dist/config/aiModelConfig').resolveRequestedAIModel();

  const report = runMigration007(dbDir);
  assert.deepEqual(report.enabledProviders, [], 'the seat was already switched on');
  assert.equal(report.seededModels, 2, "the seat's seeds it lacked - sonnet is there under the operator's own id");
  assert.deepEqual(report.reenabledModels, [], 'the seeds are enough to run');
  assert.ok(report.notes.some((note) => /claude-cli's models were restored/.test(note)));

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.deepEqual(stored.aiModels.map((entry) => entry.id), ['claude-cli-opus', 'claude-cli-haiku', 'my-sonnet']);
  assert.equal(stored.aiModels.every((entry) => entry.provider === 'claude-cli'), true, 'nothing metered was added');
  assert.equal(stored.aiModels[0].creditsPerResume, 1, 'seeded as a fresh install would have it');
  assert.equal(stored.defaultModelId, 'claude-cli-opus', 'the first runnable seat model');

  const after = await loadFresh('../dist/config/aiModelConfig').resolveRequestedAIModel();
  assert.equal(after.provider, 'claude-cli');
  assert.equal(before.provider, after.provider, 'the same seat before 007 and after it');
});

test('007 revives a seat model rather than seed a duplicate of it', () => {
  const { dbDir } = freshStorage('revive');
  plantSettings(
    dbDir,
    meteredEraSettings({
      providersEnabled: { 'claude-cli': true, 'codex-cli': false, 'gemini-cli': false, openai: true },
      aiModels: [
        model('my-sonnet', 'claude-cli', 'sonnet', { enabled: false }),
        model('claude-cli-opus', 'claude-cli', 'opus', { enabled: false }),
        model('claude-cli-haiku', 'claude-cli', 'haiku', { enabled: false }),
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      ],
    })
  );
  const report = runMigration007(dbDir);
  assert.equal(report.seededModels, 0, 'every seed was already there, by id or by provider and name');
  assert.deepEqual(report.reenabledModels, ['my-sonnet'], 'the default one, under whatever id it has');
  assert.deepEqual(report.repointedDefaultModel, { from: 'openai-gpt-5-1', to: 'my-sonnet' });
});

test('the repair ranks a seat the row switched on over one it records nothing for, over one it switched off', async () => {
  // Codex switched on with its model off; Claude switched off with a model on.
  // The seat the operator chose comes back, in 007 and in the reader alike -
  // and above a seat new to the install, which the row records nothing for.
  const { dbDir } = freshStorage('rank');
  plantSettings(
    dbDir,
    meteredEraSettings({
      providersEnabled: { 'claude-cli': false, 'codex-cli': true, openai: true },
      aiModels: [
        model('claude-cli-sonnet', 'claude-cli', 'sonnet'),
        model('codex-cli-default', 'codex-cli', 'default', { enabled: false }),
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      ],
    })
  );

  const { result: before, warnings } = await captureWarnings(() =>
    loadFresh('../dist/config/aiModelConfig').resolveRequestedAIModel()
  );
  assert.equal(before.id, 'codex-cli-default');
  assert.ok(warnings.some((line) => /without the metered API providers, which were removed/.test(line)));
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY).includes('openai'), true, 'repaired in memory only');

  const report = runMigration007(dbDir);
  assert.deepEqual(report.reenabledModels, ['codex-cli-default']);
  const after = await loadFresh('../dist/config/aiModelConfig').resolveRequestedAIModel();
  assert.equal(after.id, before.id, 'the same model before 007 and after it');
});

test('a seat the row records nothing for can win the repair over seats switched off - and the note says so', () => {
  // The design's accepted cost of reading an unrecorded seat as on: a seat new
  // to the install outranks the ones its operator unticked. Raw only, because
  // what it lands on is the Gemini seat.
  const { dbDir } = freshStorage('unrecorded');
  plantSettings(
    dbDir,
    meteredEraSettings({
      providersEnabled: { 'claude-cli': false, 'codex-cli': false, openai: true },
      aiModels: [
        model('claude-cli-sonnet', 'claude-cli', 'sonnet', { enabled: false }),
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
      ],
    })
  );
  const report = runMigration007(dbDir);
  assert.equal(report.seededModels, 1);
  assert.ok(report.notes.some((note) => /gemini-cli's models were restored/.test(note)));
  assert.ok(report.notes.some((note) => /recorded no choice for gemini-cli/.test(note)));
  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.deepEqual(stored.aiModels[0], {
    id: 'gemini-cli-auto',
    name: 'Gemini',
    provider: 'gemini-cli',
    modelName: 'auto',
    description: stored.aiModels[0].description,
    creditsPerResume: 1,
    enabled: true,
    createdAt: stored.aiModels[0].createdAt,
    updatedAt: stored.aiModels[0].updatedAt,
  });
  assert.equal(stored.defaultModelId, 'gemini-cli-auto');
});

test('with every seat locked, 007 strips the residue, brings nothing back, and says why', async () => {
  const { dbDir } = freshStorage('all-locked');
  plantSettings(dbDir, meteredEraSettings());
  await withLocks('claude-cli,codex-cli,gemini-cli', async () => {
    const report = runMigration007(dbDir);
    assert.equal(report.ran, true);
    assert.deepEqual(report.enabledProviders, []);
    assert.equal(report.seededModels, 0);
    assert.ok(report.notes.some((note) => /AI_LOCKED_PROVIDERS/.test(note)));
    const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
    assert.equal(stored.aiModels.some((entry) => entry.provider === 'openai'), false);
    assert.equal('defaultModelId' in stored, false, 'nothing it could name with confidence');

    // And the settings read survives it: nothing offered, the locks listed.
    const config = loadFresh('../dist/config/aiModelConfig');
    assert.deepEqual((await config.getUserAppSettings()).models, []);
    assert.ok((await config.getAdminAppSettings()).providerLocks.length > 0);
  });
});

test('007 clears prompt overrides naming a metered provider, and backs them up', () => {
  const { dbDir } = freshStorage('prompts');
  plantSettings(dbDir, meteredEraSettings());
  const db = openDb(dbDir);
  try {
    plantPrompt(db, 'pinned-openai', { modelProvider: 'openai', modelName: 'gpt-5-nano' });
    plantPrompt(db, 'pinned-claude', { modelProvider: 'claude', modelName: 'claude-sonnet-4-20250514' });
    plantPrompt(db, 'pinned-deepseek', { modelProvider: 'deepseek', modelName: 'deepseek-chat' });
    plantPrompt(db, 'pinned-seat', { modelProvider: 'claude-cli', modelName: 'opus' });
    // Prose that names a vendor is not an override.
    plantPrompt(db, 'mentions-openai', { content: 'Compare openai and claude.' });

    const report = loadFresh('../dist/database/migrations/007_remove_metered_providers').migrate007(db);
    assert.equal(report.clearedPromptOverrides, 3);
    for (const id of ['pinned-openai', 'pinned-claude', 'pinned-deepseek']) {
      const prompt = readRow(db, 'prompts', id);
      assert.equal('modelProvider' in prompt, false, `${id}: cleared, never repointed onto a seat`);
      assert.equal('modelName' in prompt, false);
      assert.equal(prompt.content, 'Prompt.');
    }
    assert.deepEqual(readRow(db, 'prompts', 'pinned-seat').modelProvider, 'claude-cli', "a seat override is the operator's");
    assert.equal(readRow(db, 'prompts', 'mentions-openai').content, 'Compare openai and claude.');
    const backups = db.prepare(`SELECT id FROM ${PROMPTS_BACKUP_TABLE} ORDER BY id`).all().map((row) => row.id);
    assert.deepEqual(backups, ['pinned-claude', 'pinned-deepseek', 'pinned-openai']);
  } finally {
    db.close();
  }
});

test('007 clears profile preferences for a metered model, and the log keeps what they were', async () => {
  const { dbDir } = freshStorage('profiles');
  plantSettings(dbDir, meteredEraSettings());
  await withEnv({ OPENAI_MODEL: 'gpt-4o' }, () => {
    const db = openDb(dbDir);
    try {
      plantProfile(db, 'p-seed', { modelId: 'openai-gpt-5-mini' });
      // Only the row it is deleted from can name this one.
      plantProfile(db, 'p-operator', { modelId: OPERATOR_METERED_MODEL_ID });
      // The seed an old OPENAI_MODEL produced - an id only this machine's .env says.
      plantProfile(db, 'p-env', { modelId: 'openai-gpt-4o' });
      plantProfile(db, 'p-seat', { modelId: 'claude-cli-opus' });
      plantProfile(db, 'p-none', null);

      const report = loadFresh('../dist/database/migrations/007_remove_metered_providers').migrate007(db);
      assert.deepEqual(
        [...report.clearedProfilePreferences].sort((a, b) => a.profileId.localeCompare(b.profileId)),
        [
          { profileId: 'p-env', modelId: 'openai-gpt-4o' },
          { profileId: 'p-operator', modelId: OPERATOR_METERED_MODEL_ID },
          { profileId: 'p-seed', modelId: 'openai-gpt-5-mini' },
        ]
      );
      assert.ok(report.removedModelIds.includes('openai-gpt-4o'), 'the derived id is logged for the reader');
      assert.deepEqual(readRow(db, 'profiles', 'p-seed').profileSettings.ai, {});
      assert.equal(readRow(db, 'profiles', 'p-seat').profileSettings.ai.modelId, 'claude-cli-opus');
      assert.equal('profileSettings' in readRow(db, 'profiles', 'p-none'), false);
    } finally {
      db.close();
    }
  });
  const log = JSON.parse(readSettingRaw(dbDir, LOG_KEY));
  assert.equal(log.clearedProfilePreferences.length, 3, 'the previous values are on record');
});

test("007 deletes the keys from 001's snapshot - the last plaintext copy - and keeps the rest", () => {
  const { dbDir } = freshStorage('legacy-snapshot');
  const legacy = { openrouterEnabled: true, defaultModelId: 'x', apiKeys: { openrouter: { entries: [{ value: 'sk-or-OLD' }] } } };
  writeSettingRaw(dbDir, LEGACY_SNAPSHOT_KEY, JSON.stringify(legacy));

  // The snapshot is the only residue here, and it is enough for 007 to run.
  const report = runMigration007(dbDir);
  assert.equal(report.ran, true);
  assert.equal(report.scrubbedLegacySnapshot, true);
  const scrubbed = readSettingRaw(dbDir, LEGACY_SNAPSHOT_KEY);
  assert.equal(scrubbed.includes('sk-or-OLD'), false);
  assert.deepEqual(JSON.parse(scrubbed), { openrouterEnabled: true, defaultModelId: 'x' });
  assert.equal(runMigration007(dbDir).ran, false, 'and once it is clean there is nothing to do');
});

test('007 runs once by inspection, keeps the FIRST snapshot, and appends to its log when residue returns', () => {
  const { dbDir } = freshStorage('rollback');
  const db = openDb(dbDir);
  try {
    plantProfile(db, 'p-first', { modelId: 'openai-gpt-5-1' });
  } finally {
    db.close();
  }
  plantSettings(dbDir, meteredEraSettings());
  const first = runMigration007(dbDir);
  assert.equal(first.ran, true);
  const snapshot = readSettingRaw(dbDir, SNAPSHOT_KEY);
  const afterFirst = readSettingRaw(dbDir, APP_SETTINGS_KEY);

  assert.equal(runMigration007(dbDir).ran, false, 'nothing left to find');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), afterFirst);

  // `ai:rollback` restores a metered-laden row and clears the stamp.
  plantSettings(dbDir, meteredEraSettings({ defaultMode: 'generate' }));
  const second = runMigration007(dbDir, (handle) => plantProfile(handle, 'p-second', { modelId: 'openai-gpt-5' }));
  assert.equal(second.ran, true, 'the restored residue is removed again');
  assert.equal(readSettingRaw(dbDir, SNAPSHOT_KEY), snapshot, 'the snapshot is the row as it was first found');

  const log = JSON.parse(readSettingRaw(dbDir, LOG_KEY));
  assert.deepEqual(log.clearedProfilePreferences, [{ profileId: 'p-first', modelId: 'openai-gpt-5-1' }]);
  assert.equal(log.laterRuns.length, 1);
  assert.deepEqual(log.laterRuns[0].clearedProfilePreferences, [{ profileId: 'p-second', modelId: 'openai-gpt-5' }]);
});

test('007 on a fresh install finds nothing, and writes nothing', () => {
  const { dbDir } = freshStorage('fresh');
  const report = runMigration007(dbDir);
  assert.equal(report.ran, false);
  for (const key of [APP_SETTINGS_KEY, SNAPSHOT_KEY, LOG_KEY]) assert.equal(readSettingRaw(dbDir, key), null);
});

test('007 waits on an unparseable row that names a metered provider, and behind 003 like the chain', () => {
  const { dbDir } = freshStorage('invalid');
  const broken = JSON.stringify(meteredEraSettings()) + '#';
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, broken);
  const db = openDb(dbDir);
  try {
    plantProfile(db, 'p-operator', { modelId: OPERATOR_METERED_MODEL_ID });
    const migrations = () => loadFresh('../dist/database/migrations/index').runDataMigrations(db);

    migrations();
    assert.equal(readVersion(dbDir), '1', 'stopped at 003, waiting for an administrator');

    useAdminEmails('admin@example.com');
    loadFresh('../dist/database/userRepository').createUser({ email: 'admin@example.com' });
    migrations();
    assert.equal(readVersion(dbDir), '6', 'waiting at 007, not done');
    assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), broken, 'left exactly as found');
    assert.equal(readRow(db, 'profiles', 'p-operator').profileSettings.ai.modelId, OPERATOR_METERED_MODEL_ID);

    plantSettings(dbDir, meteredEraSettings());
    migrations();
    assert.equal(readVersion(dbDir), '8', '007 and the step after it');
    assert.deepEqual(readRow(db, 'profiles', 'p-operator').profileSettings.ai, {}, 'the id was learned');
  } finally {
    db.close();
  }
});

/* --------------------------------------------- reading without the migration */

test('a row 007 has not reached reads without the metered providers, and is not rewritten by reading it', async () => {
  const { dbDir } = freshStorage('read-tolerance');
  const original = plantSettings(dbDir, meteredEraSettings());

  const { result: config, warnings } = await captureWarnings(async () => {
    const loaded = loadFresh('../dist/config/aiModelConfig');
    await loaded.getAdminAppSettings();
    return loaded;
  });
  // The full list and the runnable one - what a request may name.
  const admin = await config.getAdminAppSettings();
  for (const settings of [admin, { ...admin, aiModels: await config.listAvailableAIModels() }]) {
    assert.equal(
      settings.aiModels.some((entry) => ['claude', 'openai', 'deepseek'].includes(entry.provider)),
      false,
      'no metered record is offered'
    );
    assert.deepEqual(Object.keys(settings.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
    for (const flag of ['claudeEnabled', 'openaiEnabled', 'deepseekEnabled']) assert.equal(flag in settings, false);
    assert.equal(settings.defaultModelId, 'claude-cli-sonnet', 'the default lands on the seed default');
  }
  assert.ok(warnings.some((line) => /metered API providers, which were removed\. Migration 007/.test(line)));
  assert.ok(warnings.some((line) => /stored default model is "openai-gpt-5-1"/.test(line)));
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), original, 'tolerated in memory only');
});

test('a choice that names a metered model, from anywhere, runs on the app default', async () => {
  const { dbDir } = freshStorage('read-choices');
  plantSettings(dbDir, meteredEraSettings({ defaultModelId: 'codex-cli-default' }));
  const config = loadFresh('../dist/config/aiModelConfig');
  const preferences = loadFresh('../dist/config/aiPreferences');

  for (const modelId of [...SEEDED_METERED_IDS, OPERATOR_METERED_MODEL_ID]) {
    const stored = await preferences.resolveAiChoice(undefined, { profileSettings: { ai: { modelId } } });
    assert.equal(stored.modelId, 'codex-cli-default', `a profile set to ${modelId} runs on the default`);
  }
  for (const modelId of ['openai-gpt-5-1', 'openai', 'deepseek:deepseek-chat', 'claude:claude-sonnet-4-20250514']) {
    const requested = await preferences.resolveAiChoice({ modelId }, null);
    assert.equal(requested.modelId, 'codex-cli-default', `a request for ${modelId} runs on the default`);
  }
  // Not a general "anything missing falls back", and no prefix rule either.
  await assert.rejects(() => config.resolveRequestedAIModel('deleted-model'), { detail: /was not found/ });
  await assert.rejects(() => config.resolveRequestedAIModel('openai-gpt-9'), { detail: /was not found/ });
  assert.equal((await config.resolveRequestedAIModel('claude-cli-sonnet')).id, 'claude-cli-sonnet');
});

test("an administrator's own metered model, and the seed an old *_MODEL made, read as the default across a restart", async () => {
  // 007 deletes the record at boot, usually before anything has read it, and
  // the variable that named a seed is gone once the operator follows the
  // startup warning. The log is what still knows both.
  const { dbDir } = freshStorage('after-007');
  plantSettings(dbDir, meteredEraSettings({ defaultModelId: 'codex-cli-default' }));
  await withEnv({ DEEPSEEK_MODEL: 'deepseek-r2' }, () => runMigration007(dbDir));
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY).includes(OPERATOR_METERED_MODEL_ID), false);

  await withEnv({ DEEPSEEK_MODEL: undefined }, async () => {
    const config = loadFresh('../dist/config/aiModelConfig');
    for (const id of [OPERATOR_METERED_MODEL_ID, 'deepseek-deepseek-r2']) {
      assert.equal((await config.resolveRequestedAIModel(id)).id, 'codex-cli-default', id);
      assert.equal((await config.resolveStoredAIModelPreference(id)).id, 'codex-cli-default', id);
    }
    await assert.rejects(() => config.resolveRequestedAIModel('deleted-model'), { detail: /was not found/ });
  });
});

test('a leftover *_MODEL makes its seed id read as retired - but never a seat id', async () => {
  freshStorage('env-derived');
  const catalog = loadFresh('../dist/config/providerCatalog');
  await withEnv({ OPENAI_MODEL: 'gpt-4o', CLAUDE_MODEL: 'cli-sonnet', DEEPSEEK_MODEL: undefined }, () => {
    assert.deepEqual(catalog.envDerivedRetiredModelIds(), ['openai-gpt-4o']);
    assert.equal(catalog.retiredModelFamily('openai-gpt-4o'), 'metered-api');
    assert.equal(catalog.isRetiredModelId('claude-cli-sonnet'), false, 'claude- + cli-sonnet is the seat');
  });
  await withEnv({ OPENAI_MODEL: undefined }, () => {
    assert.equal(catalog.isRetiredModelId('openai-gpt-4o'), false, 'only while the variable is there');
  });
});

test('a queued choice naming a metered provider is resolved again from its profile', async () => {
  freshStorage('queued-choice');
  const { __currentChoiceForTests, namesRetiredProvider } = loadFresh('../dist/services/queue/resumeTask');
  const profile = (modelId) => ({ id: 'p1', name: 'Ada', profileSettings: modelId ? { ai: { modelId } } : {} });
  const queued = { provider: 'openai', modelName: 'gpt-5.1', modelId: 'openai-gpt-5-1', modelLabel: 'GPT' };

  assert.equal(namesRetiredProvider(queued), true);
  assert.equal((await __currentChoiceForTests(queued, profile())).modelId, 'claude-cli-sonnet');
  assert.equal((await __currentChoiceForTests(queued, profile('claude-cli-opus'))).modelId, 'claude-cli-opus');
  const { routeFor } = loadFresh('../dist/routes/generation');
  assert.equal(routeFor(queued).queue, 'cli', 'a retired provider lands on the lane of last resort');
});

test('a prompt pinned to a metered provider runs on the model chosen for the run', async () => {
  const { staticDir } = freshStorage('read-prompt');
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze.\n[[jobDescription]]',
    modelProvider: 'openai',
    modelName: 'gpt-5-nano',
    createdAt: STAMP,
    updatedAt: STAMP,
  });

  const promptService = loadFresh('../dist/services/promptService');
  const prompt = await promptService.getPromptById('analyze-job-description');
  assert.equal(prompt.modelProvider, undefined, 'read as no override');

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const calls = [];
  ai.registerAdapter('codex-cli', () => ({
    id: 'codex-cli',
    capabilities: {
      id: 'codex-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
    },
    defaultModelName: () => 'default',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      calls.push(request.modelName);
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
  assert.deepEqual(calls, ['gpt-6-luna']);

  // A stale Prompts page saving one is heard the same way: no override.
  const saved = await promptService.createPrompt({
    name: 'Saved from a stale tab',
    content: 'Tailor.\n[[profileJson]]',
    allowedVariables: [{ name: 'profileJson', description: 'Profile', sampleValue: '{}' }],
    modelProvider: 'deepseek',
    modelName: 'deepseek-chat',
  });
  assert.equal(saved.modelProvider, undefined);
});

test('a metered provider cannot be made again: no model, and no switch', async () => {
  freshStorage('admin-refuses');
  const config = loadFresh('../dist/config/aiModelConfig');
  for (const provider of ['openai', 'claude', 'deepseek']) {
    await assert.rejects(
      () => config.createAIModel({ name: 'Metered', provider, modelName: 'gpt-5.1' }),
      /Model provider must be one of: claude-cli, codex-cli/,
      provider
    );
  }
  await assert.rejects(() => config.updateAIModel('claude-cli-sonnet', { provider: 'openai' }), /must be one of/);
  const saved = await config.updateAppSettings({ providersEnabled: { openai: true, 'claude-cli': true } });
  assert.equal('openai' in saved.providersEnabled, false, 'a stale switch is dropped, not refused');
});

test('the repair follows the LATEST removal that rewrote the row: 007 when it ran after 006', async () => {
  // 006 left this row with the metered model running; 007 then took that away
  // and revived the Claude seat's model, so the row no longer matches 006's
  // record at all. A lock added since leaves it with nothing, and that is still
  // the removals' to answer for - the reader must compare against 007's record.
  const { dbDir } = freshStorage('latest-left-running');
  plantSettings(
    dbDir,
    meteredEraSettings({
      providersEnabled: { 'claude-cli': true, 'codex-cli': true, 'gemini-cli': false, openai: true, 'claude-web': true },
      defaultModelId: 'claude-web-chat',
      aiModels: [
        model('claude-cli-sonnet', 'claude-cli', 'sonnet', { enabled: false }),
        model('claude-cli-opus', 'claude-cli', 'opus', { enabled: false }),
        model('claude-cli-haiku', 'claude-cli', 'haiku', { enabled: false }),
        model('codex-cli-default', 'codex-cli', 'default', { enabled: false }),
        model('openai-gpt-5-1', 'openai', 'gpt-5.1'),
        model('claude-web-chat', 'claude-web', 'chat'),
      ],
    })
  );
  const db = openDb(dbDir);
  try {
    loadFresh('../dist/database/migrations/006_remove_browser_chat').migrate006(db);
  } finally {
    db.close();
  }
  const report = runMigration007(dbDir);
  assert.deepEqual(report.reenabledModels, ['claude-cli-sonnet']);

  await withLocks('claude-cli', async () => {
    const { result: admin, warnings } = await captureWarnings(() =>
      loadFresh('../dist/config/aiModelConfig').getAdminAppSettings()
    );
    assert.equal(admin.defaultModelId, 'codex-cli-default', 'the switched-on seat, its model revived in memory');
    const line = warnings.find((entry) => entry.includes('"Codex (Subscription)"'));
    assert.ok(line);
    assert.match(line, /still what migration 007 left when it removed the metered API providers/);
  });

  // Once an administrator saves a choice of their own, a lock under it is
  // theirs: named, not undone.
  await loadFresh('../dist/config/aiModelConfig').updateAppSettings({ providersEnabled: { 'codex-cli': false } });
  await withLocks('claude-cli', async () => {
    await assert.rejects(
      () => loadFresh('../dist/config/aiModelConfig').getAdminAppSettings(),
      /unlocked AI provider must remain enabled/
    );
  });
});

/* ---------------------------------------------------------- the environment */

test('a leftover metered variable is named at startup - never its value - and an empty one is not', () => {
  const { describeRetiredProviderVariables } = loadFresh('../dist/config/providerCatalog');
  assert.equal(describeRetiredProviderVariables({}), null);
  assert.equal(describeRetiredProviderVariables({ OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '  ' }), null);

  const line = describeRetiredProviderVariables({
    OPENAI_API_KEY: 'sk-live-secret',
    AI_CLI_ALLOW_API_KEY: '1',
    DEEPSEEK_BASE_URL: 'https://user:pw@gw.example',
    ANTHROPIC_BASE_URL: 'https://kept.example',
    PATH: '/usr/bin',
  });
  assert.match(line, /^\[ai\] OPENAI_API_KEY, DEEPSEEK_BASE_URL, AI_CLI_ALLOW_API_KEY are still set, and nothing reads them/);
  assert.match(line, /Delete them from \.env/);
  assert.doesNotMatch(line, /sk-live-secret|pw@|ANTHROPIC_BASE_URL/, 'names only, and not the claude child\'s own setting');

  assert.match(describeRetiredProviderVariables({ CLAUDE_MODEL: 'x' }), /CLAUDE_MODEL is still set, and nothing reads it/);
});

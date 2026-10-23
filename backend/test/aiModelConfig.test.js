const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, readSettingRaw, useTempStorage, writeSettingRaw } = require('./helpers');

const APP_SETTINGS_KEY = 'app-settings';

test('app settings persist in the SQLite settings table', async () => {
  const { rootDir, dbDir } = useTempStorage('settings');
  const outputDir = path.join(rootDir, 'generated-output');
  const config = loadFresh('../dist/config/aiModelConfig');

  const defaults = await config.getAdminAppSettings();
  assert.equal(defaults.providersEnabled['claude-cli'], true);
  assert.equal('claudeCliEnabled' in defaults, false, 'no flat per-seat flag on the wire');
  assert.equal(defaults.providersEnabled['codex-cli'], true);
  assert.equal(defaults.defaultMode, 'preview');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), null);

  // The saved shared sheet an older build kept ("Bid History"): in the row,
  // as that build wrote it. Nothing reads it, and the next save drops it.
  writeSettingRaw(dbDir, APP_SETTINGS_KEY, JSON.stringify({
    googleSheetsSources: [{
      id: 'sheet-1',
      name: 'Bid History',
      sheetId: 'abc123',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    }],
  }));
  config.invalidateSettingsCache();

  const updated = await config.updateAppSettings({
    providersEnabled: {
      'claude-cli': true,
      'codex-cli': false,
    },
    defaultMode: 'generate',
    defaultTheme: 'dark',
    defaultBuildMode: 'full',
    defaultProfileId: 'profile-1',
    // A stale page still sending the builder's old target: not a setting any more.
    defaultResumeSelection: 'group',
    defaultResumeId: 'resume-1',
    defaultResumeDocxEnabled: false,
    defaultCoverLetterDocxEnabled: false,
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{date}}/{{profile name}}/{{company name}}',
    // A stale page still sending its list: not taken.
    googleSheetsSources: [{
      id: 'sheet-2',
      name: 'Applications',
      sheetId: 'zzz999',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    }],
  });

  assert.equal(updated.providersEnabled['codex-cli'], false);
  assert.equal(updated.providersEnabled['claude-cli'], true);
  assert.deepEqual(Object.keys(updated.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
  for (const retired of ['claudeCliEnabled', 'claudeEnabled', 'openaiEnabled', 'deepseekEnabled']) {
    assert.equal(retired in updated, false, retired);
  }
  // There is no key to fetch for anything any more.
  assert.equal(typeof config.getProviderApiKey, 'undefined');
  assert.equal(updated.defaultMode, 'generate');
  assert.equal(updated.defaultTheme, 'dark');
  assert.equal(updated.defaultBuildMode, 'full');
  assert.equal(updated.defaultProfileId, 'profile-1');
  for (const retired of ['defaultResumeSelection', 'defaultResumeId', 'freeEnabledModelIds']) {
    assert.equal(retired in updated, false, retired);
  }
  assert.equal(updated.outputBaseDir, outputDir);
  // The saved shared sheets are gone from every payload (owner decision S1)...
  assert.equal('googleSheetsSources' in updated, false);
  assert.equal('googleSheetsSources' in (await config.getAdminAppSettings()), false);
  // Settings no longer carry keys in either direction.
  assert.equal('apiKeys' in updated, false);

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal('apiKeys' in stored, false, 'no credential may be written to the database');
  assert.equal(stored.defaultBuildMode, 'full');
  assert.equal(stored.defaultProfileId, 'profile-1');
  for (const retired of ['defaultResumeSelection', 'defaultResumeId']) {
    assert.equal(retired in stored, false, `${retired} is not written`);
  }
  // ...and from the row: the save writes the settings this build reads, field by field.
  assert.equal('googleSheetsSources' in stored, false);
});

test('reading settings does not rewrite an existing settings record', async () => {
  const { rootDir, dbDir } = useTempStorage('settings-readonly');
  // Opened first, so its data migrations have run - step 9 rewrites a row
  // whose fields still hold their old defaults, once, as the database opens.
  // What is pinned here is that READING, after that, never writes.
  loadFresh('../dist/database/sqlite').getDb();
  const originalJson = `{
  "providersEnabled": {
    "claude-cli": true,
    "claude": true,
    "openai": true,
    "deepseek": true
  },
  "defaultMode": "preview",
  "defaultTheme": "light",
  "defaultResumeSelection": "single",
  "defaultProfileId": "",
  "defaultResumeId": "",
  "defaultResumeDocxEnabled": true,
  "defaultCoverLetterDocxEnabled": true,
  "outputBaseDir": "${path.join(rootDir, 'generated-output').replace(/\\/g, '\\\\')}",
  "outputPathTemplate": "/{{date}}/{{profile name}}/{{company name}}",
  "googleSheetsSources": []
}`;

  writeSettingRaw(dbDir, APP_SETTINGS_KEY, originalJson);

  const config = loadFresh('../dist/config/aiModelConfig');

  const loaded = await config.getAdminAppSettings();
  // The folder template an older build stored is not read (the prefix took
  // its place, and its default is in effect) - and not rewritten either.
  assert.equal('outputPathTemplate' in loaded, false);
  assert.equal(loaded.outputPathPrefix, '/{{user_email}}/{{order_number}}');
  // The builder's old target (`defaultResumeSelection`, `defaultResumeId`) is read past, never an error.
  assert.equal('defaultResumeSelection' in loaded, false);
  assert.equal('defaultResumeId' in loaded, false);
  assert.equal(loaded.defaultBuildMode, 'partial');
  // Keys for anything but the catalog's seats are ignored, and a read
  // rewrites nothing.
  assert.deepEqual(Object.keys(loaded.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), originalJson);
});

test('invalid settings JSON is reported and never overwritten with defaults', async () => {
  const { dbDir } = useTempStorage('settings-invalid');
  const invalidJson = '{ invalid json';

  writeSettingRaw(dbDir, APP_SETTINGS_KEY, invalidJson);

  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () => config.getAdminAppSettings(),
    /contains invalid JSON/
  );

  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), invalidJson);
});

test('app settings preserve at least one enabled provider, and no key reaches the settings', async () => {
  useTempStorage('settings-env');
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'leftover-openai-secret';
  try {
    const config = loadFresh('../dist/config/aiModelConfig');

    await assert.rejects(
      () => config.updateAppSettings({
        providersEnabled: {
          'claude-cli': false,
          'codex-cli': false,
          'gemini-cli': false,
          // A stale page still sends the retired switches; they are ignored, and
          // cannot stand in for a seat.
          openai: true,
        },
      }),
      /At least one AI model must remain enabled/
    );

    // A key left in the environment from the metered days is read by nothing,
    // and nothing on the admin wire could carry it.
    const admin = await config.getAdminAppSettings();
    assert.equal('apiKeys' in admin, false, 'the admin payload must not carry keys');
    assert.equal(JSON.stringify(admin).includes('leftover-openai-secret'), false);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("generated path helpers file a run under its own place, and anything else under the settings in effect", async () => {
  const { rootDir } = useTempStorage('generated-path');
  const outputDir = path.join(rootDir, 'output');
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({ outputBaseDir: outputDir, outputPathPrefix: '/runs/{{order_number}}' });

  // A run's place - fixed when it was submitted - decides, whatever the
  // settings say now.
  const output = {
    baseDir: path.join(rootDir, 'then'),
    prefix: 'jane_example_com/ft_20261015_0001',
    suffix: '/{{profile_name}}/{{company_name}}/{{role}}',
    date: '2026-10-15',
    accountName: 'jane@example.com',
    orderNumber: 'FT-20261015-0001',
  };
  const placed = await generatedPath.getGeneratedOutputPath({ name: 'Jane Doe' }, 'Acme Inc', 'Senior Engineer', { output });
  assert.equal(placed.storagePathBase, 'jane_example_com/ft_20261015_0001/jane_doe/acme_inc/senior_engineer');
  assert.equal('relativeBase' in placed, false);
  assert.equal('roleSlug' in placed, false);
  assert.equal(
    placed.absoluteDir,
    path.join(rootDir, 'then', 'jane_example_com', 'ft_20261015_0001', 'jane_doe', 'acme_inc', 'senior_engineer')
  );
  assert.equal(placed.resumeSlug, 'jane_doe');

  // Without one (a script, a test): the prefix and the default folder path in
  // effect, `unknown` for the account and the order.
  const loose = await generatedPath.getGeneratedOutputPath({ name: 'Jane Doe' }, 'Acme Inc', 'Senior Engineer');
  const today = generatedPath.getCurrentDateFolder().split('-').join('_');
  assert.equal(loose.storagePathBase, `runs/unknown/${today}/jane_doe/acme_inc/senior_engineer`);
  assert.equal(loose.absoluteDir, path.join(outputDir, 'runs', 'unknown', today, 'jane_doe', 'acme_inc', 'senior_engineer'));
});

test('a folder path renders text around tokens as one folder, a row number, and no company folder template', async () => {
  const { rootDir } = useTempStorage('generated-folder-name');
  const generatedPath = loadFresh('../dist/utils/generatedPath');
  const output = {
    baseDir: path.join(rootDir, 'output'),
    prefix: 'jane_example_com/ft_20261015_0001',
    suffix: '/{{date}}{{profile_name}}/{{row_number}}_{{company_name}}/{{role}}',
    date: '2026-10-15',
    accountName: 'jane@example.com',
    orderNumber: 'FT-20261015-0001',
  };

  const result = await generatedPath.getGeneratedOutputPath(
    // A folder template an older resume stored is not read.
    { name: 'Jane Doe', resumeSettings: { companyFolderNameTemplate: '{{company name}}_row_{{row number}}' } },
    'Acme Inc',
    'Senior Engineer',
    { sourceRowNumber: 12, output }
  );
  assert.equal(result.storagePathBase, 'jane_example_com/ft_20261015_0001/2026_10_15jane_doe/12_acme_inc/senior_engineer');
  assert.equal('companyFolderName' in result, false);

  // No row, and no role: the row's text stays, and an empty folder is `unknown`.
  const bare = await generatedPath.getGeneratedOutputPath({ name: 'Jane Doe' }, 'Acme Inc', '', { output });
  assert.equal(bare.storagePathBase, 'jane_example_com/ft_20261015_0001/2026_10_15jane_doe/acme_inc/unknown');
});

test('generated path helpers apply per-resume output file name templates', async () => {
  const { rootDir } = useTempStorage('generated-file-names');
  const outputDir = path.join(rootDir, 'output');
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({ outputBaseDir: outputDir });

  const result = await generatedPath.getGeneratedOutputPath(
    {
      name: 'Jane Doe',
      resumeSettings: {
        resumeFileNameTemplate: '{{profile name}} Resume for {{company name}}',
        coverLetterFileNameTemplate: '{{profile name}} Cover Letter for {{job title}}',
      },
    },
    'Acme Inc',
    'Senior Engineer'
  );

  assert.equal(result.resumeFileStem, 'Jane_Doe_Resume_for_Acme_Inc');
  assert.equal(result.coverLetterFileStem, 'Jane_Doe_Cover_Letter_for_Senior_Engineer');
  assert.equal(generatedPath.getResumeOutputFilename(result, 'pdf'), 'Jane_Doe_Resume_for_Acme_Inc.pdf');
  assert.equal(generatedPath.getResumeOutputFilename(result, 'docx'), 'Jane_Doe_Resume_for_Acme_Inc.docx');
  assert.equal(
    generatedPath.getCoverLetterOutputFilename(result, 'pdf'),
    'Jane_Doe_Cover_Letter_for_Senior_Engineer.pdf'
  );
  assert.equal(
    generatedPath.getCoverLetterOutputFilename(result, 'docx'),
    'Jane_Doe_Cover_Letter_for_Senior_Engineer.docx'
  );
});

test('a seat is switched only through providersEnabled; a flat per-seat flag is not read', async () => {
  useTempStorage('settings-flat-flags');
  const config = loadFresh('../dist/config/aiModelConfig');

  await config.getAdminAppSettings();
  const ignored = await config.updateAppSettings({ claudeCliEnabled: false, openrouterEnabled: false });
  assert.equal(ignored.providersEnabled['claude-cli'], true);
  assert.equal('claudeCliEnabled' in ignored, false);

  const updated = await config.updateAppSettings({ providersEnabled: { 'codex-cli': false } });
  assert.equal(updated.providersEnabled['codex-cli'], false);
  assert.equal(updated.providersEnabled['claude-cli'], true, 'untouched providers keep their setting');
});

test("a stale page's metered flags are ignored without error, and never written", async () => {
  // A Settings tab loaded before the metered APIs were removed still sends
  // their flat flags. Refusing the save would stop it saving what it CAN
  // change; reading them would mean nothing, since nothing serves them.
  const { dbDir } = useTempStorage('settings-stale-metered-flags');
  const config = loadFresh('../dist/config/aiModelConfig');

  const updated = await config.updateAppSettings({
    openaiEnabled: false,
    claudeEnabled: 'junk',
    deepseekEnabled: true,
    defaultTheme: 'dark',
  });
  assert.equal(updated.defaultTheme, 'dark', 'the change it could make was saved');
  assert.equal(updated.providersEnabled['claude-cli'], true);
  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  for (const retired of ['openaiEnabled', 'claudeEnabled', 'deepseekEnabled']) {
    assert.equal(retired in stored, false, retired);
  }
  assert.deepEqual(Object.keys(stored.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
});

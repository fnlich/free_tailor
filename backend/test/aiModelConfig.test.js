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
    defaultResumeSelection: 'group',
    defaultGroupId: 'group-1',
    defaultProfileId: 'profile-1',
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
  assert.equal(updated.outputBaseDir, outputDir);
  // The saved shared sheets are gone from every payload (owner decision S1)...
  assert.equal('googleSheetsSources' in updated, false);
  assert.equal('googleSheetsSources' in (await config.getAdminAppSettings()), false);
  // Settings no longer carry keys in either direction.
  assert.equal('apiKeys' in updated, false);

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal('apiKeys' in stored, false, 'no credential may be written to the database');
  // ...and from the row: the save writes the settings this build reads, field by field.
  assert.equal('googleSheetsSources' in stored, false);
});

test('reading settings does not rewrite an existing settings record', async () => {
  const { rootDir, dbDir } = useTempStorage('settings-readonly');
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
  "defaultGroupId": "",
  "defaultProfileId": "",
  "defaultResumeDocxEnabled": true,
  "defaultCoverLetterDocxEnabled": true,
  "outputBaseDir": "${path.join(rootDir, 'generated-output').replace(/\\/g, '\\\\')}",
  "outputPathTemplate": "/{{date}}/{{profile name}}/{{company name}}",
  "googleSheetsSources": []
}`;

  writeSettingRaw(dbDir, APP_SETTINGS_KEY, originalJson);

  const config = loadFresh('../dist/config/aiModelConfig');

  const loaded = await config.getAdminAppSettings();
  assert.equal(loaded.outputPathTemplate, '/{{date}}/{{profile name}}/{{company name}}');
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

test('generated path helpers read output settings from the stored settings', async () => {
  const { rootDir } = useTempStorage('generated-path');
  const outputDir = path.join(rootDir, 'output');
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{profile name}}/{{company name}}/{{job title}}',
  });

  const result = await generatedPath.getGeneratedOutputPath(
    { name: 'Jane Doe' },
    'Acme Inc',
    'Senior Engineer'
  );

  assert.equal(result.relativeBase, 'jane_doe/acme_inc/senior_engineer');
  assert.equal(result.absoluteDir, path.join(outputDir, 'jane_doe', 'acme_inc', 'senior_engineer'));
  assert.equal(result.profileSlug, 'jane_doe');
  assert.equal(result.companyFolderName, 'acme_inc');
  assert.equal(result.roleSlug, 'senior_engineer');
});

test('generated path helpers apply per-profile company folder name templates', async () => {
  const { rootDir } = useTempStorage('generated-folder-name');
  const outputDir = path.join(rootDir, 'output');
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{profile name}}/{{company name}}/{{job title}}',
  });

  const defaultResult = await generatedPath.getGeneratedOutputPath(
    { name: 'Jane Doe' },
    'Acme Inc',
    'Senior Engineer',
    { sourceRowNumber: 12 }
  );

  assert.equal(defaultResult.relativeBase, 'jane_doe/12_acme_inc/senior_engineer');
  assert.equal(defaultResult.companyFolderName, '12_acme_inc');

  const customResult = await generatedPath.getGeneratedOutputPath(
    {
      name: 'Jane Doe',
      profileSettings: {
        companyFolderNameTemplate: '{{company name}}_row_{{row number}}',
      },
    },
    'Acme Inc',
    'Senior Engineer',
    { sourceRowNumber: 12 }
  );

  assert.equal(customResult.relativeBase, 'jane_doe/acme_inc_row_12/senior_engineer');
  assert.equal(customResult.companyFolderName, 'acme_inc_row_12');
});

test('generated path helpers apply per-profile output file name templates', async () => {
  const { rootDir } = useTempStorage('generated-file-names');
  const outputDir = path.join(rootDir, 'output');
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{profile name}}/{{company name}}',
  });

  const result = await generatedPath.getGeneratedOutputPath(
    {
      name: 'Jane Doe',
      profileSettings: {
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

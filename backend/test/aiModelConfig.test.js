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
  assert.equal(defaults.claudeCliEnabled, true);
  assert.equal(defaults.providersEnabled['codex-cli'], true);
  assert.equal(defaults.defaultMode, 'preview');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), null);

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
    googleSheetsSources: [{
      id: 'sheet-1',
      name: 'Applications',
      sheetId: 'abc123',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    }],
  });

  assert.equal(updated.providersEnabled['codex-cli'], false);
  assert.equal(updated.providersEnabled['claude-cli'], true);
  assert.deepEqual(Object.keys(updated.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
  // The Claude seat's flat boolean stays on the wire, derived, so a browser
  // tab loaded before this release keeps working. The metered APIs' went with
  // them.
  assert.equal(updated.claudeCliEnabled, true);
  for (const retired of ['claudeEnabled', 'openaiEnabled', 'deepseekEnabled']) {
    assert.equal(retired in updated, false, retired);
  }
  // There is no key to fetch for anything any more.
  assert.equal(typeof config.getProviderApiKey, 'undefined');
  assert.equal(updated.defaultMode, 'generate');
  assert.equal(updated.defaultTheme, 'dark');
  assert.equal(updated.outputBaseDir, outputDir);
  assert.equal(updated.googleSheetsSources.length, 1);
  // Settings no longer carry keys in either direction.
  assert.equal('apiKeys' in updated, false);

  const stored = JSON.parse(readSettingRaw(dbDir, APP_SETTINGS_KEY));
  assert.equal('apiKeys' in stored, false, 'no credential may be written to the database');
  assert.equal(stored.googleSheetsSources[0].sheetId, 'abc123');
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
  // The metered flags in it are residue the reader ignores - and does not
  // clean up: that is migration 007's job, after it has snapshotted the row.
  assert.deepEqual(Object.keys(loaded.providersEnabled).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), originalJson);
});

// The one exception to the rule above, and the reason it is an exception:
// leaving the row alone would leave secrets in the database that nothing can
// read, manage or remove - the app uses no API key at all any more.
test('a settings row holding API keys is rewritten once, without them', async () => {
  const { rootDir, dbDir } = useTempStorage('settings-key-purge');
  writeSettingRaw(
    dbDir,
    APP_SETTINGS_KEY,
    JSON.stringify({
      providersEnabled: { 'claude-cli': true, claude: true, openai: true, deepseek: true },
      defaultMode: 'preview',
      defaultTheme: 'light',
      outputBaseDir: path.join(rootDir, 'generated-output'),
      outputPathTemplate: '/{{date}}/{{profile name}}/{{company name}}',
      googleSheetsSources: [],
      apiKeys: {
        openai: { activeKeyId: 'k1', entries: [{ id: 'k1', name: 'Primary', value: 'sk-secret' }] },
      },
    })
  );

  const config = loadFresh('../dist/config/aiModelConfig');

  await config.getAdminAppSettings();

  const rewritten = readSettingRaw(dbDir, APP_SETTINGS_KEY);
  assert.equal('apiKeys' in JSON.parse(rewritten), false, 'the key store must be gone');
  assert.equal(rewritten.includes('sk-secret'), false, 'no key text may survive anywhere in the row');
  // Everything else survives the rewrite.
  assert.equal(JSON.parse(rewritten).outputPathTemplate, '/{{date}}/{{profile name}}/{{company name}}');

  // And it is a one-time rewrite, not a write on every read.
  config.invalidateSettingsCache();
  await config.getAdminAppSettings();
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), rewritten);
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

test("a client that still sends the Claude seat's flat boolean is heard", async () => {
  // The stored row always carries a providersEnabled record, and the record
  // wins over the flat fields - so merging an older client's payload naively
  // made its provider toggle appear to save and change nothing.
  useTempStorage('settings-legacy-flags');
  const config = loadFresh('../dist/config/aiModelConfig');

  await config.getAdminAppSettings();
  const updated = await config.updateAppSettings({ claudeCliEnabled: false });

  assert.equal(updated.providersEnabled['claude-cli'], false);
  assert.equal(updated.providersEnabled['codex-cli'], true, 'untouched providers keep their setting');
  assert.equal(updated.claudeCliEnabled, false);
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

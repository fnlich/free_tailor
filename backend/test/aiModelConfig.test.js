const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, readSettingRaw, useTempStorage, writeSettingRaw } = require('./helpers');

const APP_SETTINGS_KEY = 'app-settings';

test('app settings persist in the SQLite settings table', async () => {
  const { rootDir, dbDir } = useTempStorage('settings');
  const outputDir = path.join(rootDir, 'generated-output');
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  const defaults = await config.getAdminAppSettings();
  assert.equal(defaults.openaiEnabled, true);
  assert.equal(defaults.deepseekEnabled, true);
  assert.equal(defaults.defaultMode, 'preview');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), null);

  const updated = await config.updateAppSettings({
    providersEnabled: {
      'claude-cli': true,
      claude: true,
      openai: false,
      deepseek: true,
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

  assert.equal(updated.providersEnabled.openai, false);
  assert.equal(updated.providersEnabled.claude, true);
  assert.equal(updated.providersEnabled['claude-cli'], true);
  assert.equal(updated.providersEnabled.deepseek, true);
  // The flat booleans stay on the wire, derived, so a browser tab loaded
  // before this release keeps working.
  assert.equal(updated.openaiEnabled, false);
  assert.equal(updated.claudeEnabled, true);
  assert.equal(updated.claudeCliEnabled, true);
  assert.equal(updated.deepseekEnabled, true);
  // A subscription-seat provider has no key at all.
  assert.equal(await config.getProviderApiKey('claude-cli'), '');
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

  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  const loaded = await config.getAdminAppSettings();
  assert.equal(loaded.outputPathTemplate, '/{{date}}/{{profile name}}/{{company name}}');
  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), originalJson);
});

// The one exception to the rule above, and the reason it is an exception:
// leaving the row alone would leave secrets in the database that nothing can
// read, manage or remove now that the app keys metered providers from .env.
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

  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
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

  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () => config.getAdminAppSettings(),
    /contains invalid JSON/
  );

  assert.equal(readSettingRaw(dbDir, APP_SETTINGS_KEY), invalidJson);
});

test('app settings preserve at least one enabled provider, and keys come from the environment', async () => {
  useTempStorage('settings-env');
  process.env.OPENAI_API_KEY = 'openai-env-secret';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () => config.updateAppSettings({
      providersEnabled: {
        'claude-cli': false,
        claude: false,
        openai: false,
        deepseek: false,
        'claude-web': false,
        'chatgpt-web': false,
      },
    }),
    /At least one AI model must remain enabled/
  );

  // The environment is the only source now: there is no stored key that could
  // shadow this one, and nothing on the admin wire that could carry it.
  assert.equal(await config.getProviderApiKey('openai'), 'openai-env-secret');
  process.env.OPENAI_API_KEY = 'rotated-in-the-environment';
  assert.equal(await config.getProviderApiKey('openai'), 'rotated-in-the-environment');

  const admin = await config.getAdminAppSettings();
  assert.equal('apiKeys' in admin, false, 'the admin payload must not carry keys');
  assert.equal(JSON.stringify(admin).includes('rotated-in-the-environment'), false);
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
    12
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
    12
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

test('a client that still sends the flat provider booleans is heard', async () => {
  // The stored row always carries a providersEnabled record, and the record
  // wins over the flat fields - so merging an older client's payload naively
  // made its provider toggle appear to save and change nothing.
  useTempStorage('settings-legacy-flags');
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  await config.getAdminAppSettings();
  const updated = await config.updateAppSettings({ openaiEnabled: false, deepseekEnabled: false });

  assert.equal(updated.providersEnabled.openai, false);
  assert.equal(updated.providersEnabled.deepseek, false);
  assert.equal(updated.providersEnabled['claude-cli'], true, 'untouched providers keep their setting');
  assert.equal(updated.openaiEnabled, false);
});

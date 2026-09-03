const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir, readJson } = require('./helpers');

test('app settings persist entirely in JSON', async () => {
  const dataDir = makeTempDataDir('settings');
  const outputDir = path.join(dataDir, 'generated-output');
  process.env.TAILOR_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  const defaults = await config.getAdminAppSettings();
  assert.equal(defaults.openaiEnabled, true);
  assert.equal(defaults.deepseekEnabled, true);
  assert.equal(defaults.defaultMode, 'preview');
  assert.equal(fs.existsSync(path.join(dataDir, 'config', 'ai-models.json')), false);

  const updated = await config.updateAppSettings({
    openaiEnabled: false,
    claudeEnabled: true,
    openrouterEnabled: false,
    deepseekEnabled: true,
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
    apiKeys: {
      claude: {
        add: [{ clientId: 'new-claude', name: 'Claude Test', value: 'claude-secret' }],
        activeKeyId: 'new-claude',
      },
    },
  });

  assert.equal(updated.openaiEnabled, false);
  assert.equal(updated.claudeEnabled, true);
  assert.equal(updated.deepseekEnabled, true);
  assert.equal(updated.defaultMode, 'generate');
  assert.equal(updated.defaultTheme, 'dark');
  assert.equal(updated.outputBaseDir, outputDir);
  assert.equal(updated.googleSheetsSources.length, 1);
  assert.equal(updated.apiKeys.claude.entries.length, 1);
  assert.equal(updated.apiKeys.claude.activeSource, 'stored');
  assert.equal(updated.apiKeys.claude.activePreview, 'clau...cret');
  assert.equal(await config.getProviderApiKey('claude'), 'claude-secret');

  const stored = readJson(path.join(dataDir, 'config', 'ai-models.json'));
  assert.equal(stored.apiKeys.claude.entries[0].value, 'claude-secret');
  assert.equal(stored.googleSheetsSources[0].sheetId, 'abc123');
  assert.equal(fs.existsSync(path.join(dataDir, 'config', 'settings.sqlite')), false);
});

test('reading settings does not rewrite an existing settings file', async () => {
  const dataDir = makeTempDataDir('settings-readonly');
  const configDir = path.join(dataDir, 'config');
  const configFile = path.join(configDir, 'ai-models.json');
  const originalJson = `{
  "openaiEnabled": true,
  "claudeEnabled": true,
  "openrouterEnabled": true,
  "deepseekEnabled": true,
  "defaultMode": "preview",
  "defaultTheme": "light",
  "defaultResumeSelection": "single",
  "defaultGroupId": "",
  "defaultProfileId": "",
  "defaultResumeDocxEnabled": true,
  "defaultCoverLetterDocxEnabled": true,
  "outputBaseDir": "${path.join(dataDir, 'generated-output').replace(/\\/g, '\\\\')}",
  "outputPathTemplate": "/{{date}}/{{profile name}}/{{company name}}",
  "googleSheetsSources": [],
  "apiKeys": {
    "openai": { "activeKeyId": "", "entries": [] },
    "claude": { "activeKeyId": "", "entries": [] },
    "openrouter": { "activeKeyId": "", "entries": [] },
    "deepseek": { "activeKeyId": "", "entries": [] }
  }
}`;

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, originalJson);

  process.env.TAILOR_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  const loaded = await config.getAdminAppSettings();
  assert.equal(loaded.outputPathTemplate, '/{{date}}/{{profile name}}/{{company name}}');
  assert.equal(fs.readFileSync(configFile, 'utf8'), originalJson);
});

test('invalid settings JSON is reported and never overwritten with defaults', async () => {
  const dataDir = makeTempDataDir('settings-invalid');
  const configDir = path.join(dataDir, 'config');
  const configFile = path.join(configDir, 'ai-models.json');
  const invalidJson = '{ invalid json';

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, invalidJson);

  process.env.TAILOR_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () => config.getAdminAppSettings(),
    /contains invalid JSON/
  );

  assert.equal(fs.readFileSync(configFile, 'utf8'), invalidJson);
});

test('app settings preserve at least one enabled provider and can fall back to environment keys', async () => {
  const dataDir = makeTempDataDir('settings-env');
  process.env.TAILOR_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = 'openai-env-secret';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.DEEPSEEK_API_KEY = '';
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () => config.updateAppSettings({
      openaiEnabled: false,
      claudeEnabled: false,
      openrouterEnabled: false,
      deepseekEnabled: false,
    }),
    /At least one AI model must remain enabled/
  );

  assert.equal(await config.getProviderApiKey('openai'), 'openai-env-secret');
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.apiKeys.openai.activeSource, 'environment');
});

test('generated path helpers read output settings from the JSON config', async () => {
  const dataDir = makeTempDataDir('generated-path');
  const outputDir = path.join(dataDir, 'output');
  process.env.TAILOR_DATA_DIR = dataDir;
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
  const dataDir = makeTempDataDir('generated-folder-name');
  const outputDir = path.join(dataDir, 'output');
  process.env.TAILOR_DATA_DIR = dataDir;
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
  const dataDir = makeTempDataDir('generated-file-names');
  const outputDir = path.join(dataDir, 'output');
  process.env.TAILOR_DATA_DIR = dataDir;
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{profile name}}/{{company name}}',
  });

  const result = await generatedPath.getGeneratedOutputPath(
    {
      name: 'Kevin Shen',
      profileSettings: {
        resumeFileNameTemplate: '{{profile name}} Resume for {{company name}}',
        coverLetterFileNameTemplate: '{{profile name}} Cover Letter for {{job title}}',
      },
    },
    'Acme Inc',
    'Senior Engineer'
  );

  assert.equal(result.resumeFileStem, 'Kevin_Shen_Resume_for_Acme_Inc');
  assert.equal(result.coverLetterFileStem, 'Kevin_Shen_Cover_Letter_for_Senior_Engineer');
  assert.equal(generatedPath.getResumeOutputFilename(result, 'pdf'), 'Kevin_Shen_Resume_for_Acme_Inc.pdf');
  assert.equal(generatedPath.getResumeOutputFilename(result, 'docx'), 'Kevin_Shen_Resume_for_Acme_Inc.docx');
  assert.equal(
    generatedPath.getCoverLetterOutputFilename(result, 'pdf'),
    'Kevin_Shen_Cover_Letter_for_Senior_Engineer.pdf'
  );
  assert.equal(
    generatedPath.getCoverLetterOutputFilename(result, 'docx'),
    'Kevin_Shen_Cover_Letter_for_Senior_Engineer.docx'
  );
});

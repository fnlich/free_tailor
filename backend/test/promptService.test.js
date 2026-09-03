const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir, readJson } = require('./helpers');

function writePrompt(dataDir, id, content, extra = {}) {
  const promptsDir = path.join(dataDir, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, `${id}.json`),
    `${JSON.stringify({
      id,
      content,
      ...extra,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    }, null, 2)}\n`
  );
}

test('prompt service lists and renders built-in JSON prompts', async () => {
  const dataDir = makeTempDataDir('prompts-built-in');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'analyze-job-description', 'Analyze [[jobDescription]]');

  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, 'analyze-job-description');
  assert.equal(prompts[0].isBuiltIn, true);
  assert.deepEqual(prompts[0].validation, {
    usedVariables: ['jobDescription'],
    unknownVariables: [],
  });

  assert.equal(
    await promptService.renderPrompt('analyze-job-description', { jobDescription: 'Backend role' }),
    'Analyze Backend role'
  );
});

test('prompt service creates, previews, updates, and deletes custom JSON prompts', async () => {
  const dataDir = makeTempDataDir('prompts-custom');
  process.env.TAILOR_DATA_DIR = dataDir;
  const promptService = loadFresh('../dist/services/promptService');

  const created = await promptService.createPrompt({
    name: 'Greeting Prompt',
    description: 'Simple greeting',
    content: 'Hello [[name]]',
    responseFormat: 'text',
    modelProvider: 'openrouter',
    modelName: 'google/gemini-2.5-flash',
    allowedVariables: [{ name: 'name', description: 'Recipient name', sampleValue: 'Jane' }],
  });

  assert.equal(created.id, 'custom-greeting-prompt');
  assert.equal(created.isBuiltIn, false);
  assert.equal(created.content, 'Hello [[name]]');
  assert.equal(created.modelProvider, 'openrouter');
  assert.equal(created.modelName, 'google/gemini-2.5-flash');
  assert.deepEqual(created.validation, { usedVariables: ['name'], unknownVariables: [] });

  const promptPath = path.join(dataDir, 'prompts', `${created.id}.json`);
  assert.equal(readJson(promptPath).content, 'Hello [[name]]');
  assert.equal(readJson(promptPath).modelProvider, 'openrouter');
  assert.equal(readJson(promptPath).modelName, 'google/gemini-2.5-flash');

  const preview = await promptService.previewPrompt({
    id: created.id,
    sampleValues: { name: 'Ada' },
  });
  assert.equal(preview.renderedContent, 'Hello Ada');

  assert.equal(await promptService.renderPrompt(created.id, { name: 'Grace' }), 'Hello Grace');

  const updated = await promptService.updatePrompt(created.id, {
    name: 'Greeting Prompt Updated',
    content: 'Hi [[name]]',
    responseFormat: 'text',
    modelProvider: 'openai',
    modelName: 'gpt-5-mini',
    allowedVariables: [{ name: 'name' }],
  });

  assert.equal(updated.name, 'Greeting Prompt Updated');
  assert.equal(updated.content, 'Hi [[name]]');
  assert.equal(updated.modelProvider, 'openai');
  assert.equal(updated.modelName, 'gpt-5-mini');

  assert.equal(await promptService.deletePrompt(created.id), true);
  assert.equal(await promptService.getPromptById(created.id), null);
  assert.equal(fs.existsSync(promptPath), false);
});

test('prompt service supports multiple prompt variants per feature and active selection', async () => {
  const dataDir = makeTempDataDir('prompts-feature-variants');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'filter-google-sheet-job', 'Default filter [[jobContent]]');

  const promptService = loadFresh('../dist/services/promptService');

  const variantA = await promptService.createPrompt({
    name: 'Filter Variant A',
    featureKey: 'filter-google-sheet-job',
    content: 'Variant A [[jobContent]]',
    modelProvider: 'openrouter',
    modelName: 'deepseek/deepseek-chat',
  });
  const variantB = await promptService.createPrompt({
    name: 'Filter Variant B',
    featureKey: 'filter-google-sheet-job',
    content: 'Variant B [[jobContent]]',
    modelProvider: 'claude',
    modelName: 'claude-sonnet-4-20250514',
  });

  const prompts = await promptService.listPrompts();
  const featurePrompts = prompts.filter((prompt) => prompt.featureKey === 'filter-google-sheet-job');
  assert.equal(featurePrompts.length, 3);
  assert.equal(featurePrompts.some((prompt) => prompt.id === 'filter-google-sheet-job' && prompt.isActiveForFeature), true);

  await promptService.activatePrompt(variantB.id);

  const promptsAfterActivation = await promptService.listPrompts();
  const activePrompt = promptsAfterActivation.find((prompt) => prompt.id === variantB.id);
  assert.equal(activePrompt?.isActiveForFeature, true);

  assert.equal(
    await promptService.renderPrompt('filter-google-sheet-job', { jobContent: 'Backend role' }),
    'Variant B Backend role'
  );

  const runtimePrompt = await promptService.getRuntimePromptByFeature('filter-google-sheet-job');
  assert.equal(runtimePrompt?.id, variantB.id);
  assert.equal(runtimePrompt?.modelProvider, 'claude');
  assert.equal(runtimePrompt?.modelName, 'claude-sonnet-4-20250514');

  const storedConfig = readJson(path.join(dataDir, 'config', 'prompt-library.json'));
  assert.equal(storedConfig.activePrompts['filter-google-sheet-job'], variantB.id);

  await promptService.deletePrompt(variantB.id);
  assert.equal(
    await promptService.renderPrompt('filter-google-sheet-job', { jobContent: 'Backend role' }),
    'Default filter Backend role'
  );

  assert.equal(await promptService.getPromptById(variantA.id) !== null, true);
});

test('prompt validation rejects unknown variables', async () => {
  const dataDir = makeTempDataDir('prompts-validation');
  process.env.TAILOR_DATA_DIR = dataDir;
  const promptService = loadFresh('../dist/services/promptService');

  assert.deepEqual(promptService.extractPromptVariables('[[one]] and [[ two ]] and [[one]]'), ['one', 'two']);
  const validation = promptService.validatePromptContent('Hello [[missing]]', [{ name: 'name' }]);
  assert.deepEqual(validation, {
    usedVariables: ['missing'],
    unknownVariables: ['missing'],
  });

  await assert.rejects(
    () => promptService.createPrompt({
      name: 'Invalid Prompt',
      content: 'Hello [[missing]]',
      allowedVariables: [{ name: 'name' }],
    }),
    /Unknown prompt variables/
  );
});

test('feature-linked prompts derive variables from prompt content', async () => {
  const dataDir = makeTempDataDir('prompts-feature-variables');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'tailor-resume', 'Tailor [[profileJson]] for [[jobAnalysisJson]] with [[customNote]]');

  const promptService = loadFresh('../dist/services/promptService');
  const prompt = await promptService.getPromptById('tailor-resume');

  assert.deepEqual(
    prompt.allowedVariables.map((variable) => variable.name),
    ['profileJson', 'jobAnalysisJson', 'customNote']
  );
  assert.deepEqual(prompt.validation, {
    usedVariables: ['profileJson', 'jobAnalysisJson', 'customNote'],
    unknownVariables: [],
  });

  const variant = await promptService.createPrompt({
    name: 'Tailor Variant',
    featureKey: 'tailor-resume',
    content: 'Variant [[profileJson]] [[jobAnalysisJson]] [[customNote]]',
  });

  assert.deepEqual(
    variant.allowedVariables.map((variable) => variable.name),
    ['profileJson', 'jobAnalysisJson', 'customNote']
  );
});

test('built-in prompts persist optional model overrides alongside content', async () => {
  const dataDir = makeTempDataDir('prompts-built-in-model');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'analyze-job-description', 'Analyze [[jobDescription]]');

  const promptService = loadFresh('../dist/services/promptService');
  const updated = await promptService.updatePrompt('analyze-job-description', {
    content: 'Analyze deeply [[jobDescription]]',
    modelProvider: 'openrouter',
    modelName: 'deepseek/deepseek-chat',
  });

  assert.equal(updated.content, 'Analyze deeply [[jobDescription]]');
  assert.equal(updated.modelProvider, 'openrouter');
  assert.equal(updated.modelName, 'deepseek/deepseek-chat');

  const stored = readJson(path.join(dataDir, 'prompts', 'analyze-job-description.json'));
  assert.equal(stored.modelProvider, 'openrouter');
  assert.equal(stored.modelName, 'deepseek/deepseek-chat');
});

test('prompt service renders prompt segments in template order', async () => {
  const dataDir = makeTempDataDir('prompts-segments');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'analyze-job-description', 'Intro [[jobDescription]] outro');

  const promptService = loadFresh('../dist/services/promptService');
  const segments = await promptService.renderPromptSegments('analyze-job-description', {
    jobDescription: 'Backend role',
  });

  assert.deepEqual(segments, [
    { text: 'Intro ' },
    { text: 'Backend role', variableName: 'jobDescription' },
    { text: ' outro' },
  ]);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Database = require('better-sqlite3');

const { loadFresh, readDocument, readJson, readSettingRaw, useTempStorage, writeStaticJson } = require('./helpers');

function writeDefaultPrompt(staticDir, id, content, extra = {}) {
  return writeStaticJson(staticDir, `prompts/${id}.json`, {
    id,
    content,
    ...extra,
    createdAt: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
  });
}

test('prompt service lists and renders default prompts from static files', async () => {
  const { staticDir } = useTempStorage('prompts-built-in');
  writeDefaultPrompt(staticDir, 'analyze-job-description', 'Analyze [[jobDescription]]');

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

test('prompt service creates, previews, updates, and deletes custom prompts in the database', async () => {
  const { dbDir } = useTempStorage('prompts-custom');
  const promptService = loadFresh('../dist/services/promptService');

  const created = await promptService.createPrompt({
    name: 'Greeting Prompt',
    description: 'Simple greeting',
    content: 'Hello [[name]]',
    responseFormat: 'text',
    modelProvider: 'claude-cli',
    modelName: 'opus',
    allowedVariables: [{ name: 'name', description: 'Recipient name', sampleValue: 'Jane' }],
  });

  assert.equal(created.id, 'custom-greeting-prompt');
  assert.equal(created.isBuiltIn, false);
  assert.equal(created.content, 'Hello [[name]]');
  assert.equal(created.modelProvider, 'claude-cli');
  assert.equal(created.modelName, 'opus');
  assert.deepEqual(created.validation, { usedVariables: ['name'], unknownVariables: [] });

  const storedRecord = readDocument(dbDir, 'prompts', created.id);
  assert.equal(storedRecord.content, 'Hello [[name]]');
  assert.equal(storedRecord.modelProvider, 'claude-cli');
  assert.equal(storedRecord.modelName, 'opus');
  assert.equal(storedRecord.isBuiltIn, false);

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
    modelProvider: 'codex-cli',
    modelName: 'gpt-6-luna',
    allowedVariables: [{ name: 'name' }],
  });

  assert.equal(updated.name, 'Greeting Prompt Updated');
  assert.equal(updated.content, 'Hi [[name]]');
  assert.equal(updated.modelProvider, 'codex-cli');
  assert.equal(updated.modelName, 'gpt-6-luna');

  assert.equal(await promptService.deletePrompt(created.id), true);
  assert.equal(await promptService.getPromptById(created.id), null);
  assert.equal(readDocument(dbDir, 'prompts', created.id), null);
});

test('prompt service supports multiple prompt variants per feature and active selection', async () => {
  const { dbDir, staticDir } = useTempStorage('prompts-feature-variants');
  writeDefaultPrompt(staticDir, 'extract-profile-from-resume', 'Default extract [[resumeText]]');

  const promptService = loadFresh('../dist/services/promptService');

  const variantA = await promptService.createPrompt({
    name: 'Extract Variant A',
    featureKey: 'extract-profile-from-resume',
    content: 'Variant A [[resumeText]]',
    modelProvider: 'claude-cli',
    modelName: 'sonnet',
  });
  const variantB = await promptService.createPrompt({
    name: 'Extract Variant B',
    featureKey: 'extract-profile-from-resume',
    content: 'Variant B [[resumeText]]',
    modelProvider: 'codex-cli',
    modelName: 'default',
  });

  const prompts = await promptService.listPrompts();
  const featurePrompts = prompts.filter((prompt) => prompt.featureKey === 'extract-profile-from-resume');
  assert.equal(featurePrompts.length, 3);
  assert.equal(
    featurePrompts.some((prompt) => prompt.id === 'extract-profile-from-resume' && prompt.isActiveForFeature),
    true
  );

  await promptService.activatePrompt(variantB.id);

  const promptsAfterActivation = await promptService.listPrompts();
  const activePrompt = promptsAfterActivation.find((prompt) => prompt.id === variantB.id);
  assert.equal(activePrompt?.isActiveForFeature, true);

  assert.equal(
    await promptService.renderPrompt('extract-profile-from-resume', { resumeText: 'A resume' }),
    'Variant B A resume'
  );

  const runtimePrompt = await promptService.getRuntimePromptByFeature('extract-profile-from-resume');
  assert.equal(runtimePrompt?.id, variantB.id);
  assert.equal(runtimePrompt?.modelProvider, 'codex-cli');
  assert.equal(runtimePrompt?.modelName, 'default');

  const activePrompts = JSON.parse(readSettingRaw(dbDir, 'active-prompts'));
  assert.equal(activePrompts['extract-profile-from-resume'], variantB.id);

  await promptService.deletePrompt(variantB.id);
  assert.equal(
    await promptService.renderPrompt('extract-profile-from-resume', { resumeText: 'A resume' }),
    'Default extract A resume'
  );

  assert.equal(await promptService.getPromptById(variantA.id) !== null, true);
});

test('the job analysis has one prompt: no new variant, no activation, an old variant listed but never active', async () => {
  // One analysis per posting for every profile (owner decision J0) needs one
  // prompt to produce it - the built-in record, which an administrator edits.
  const { staticDir } = useTempStorage('prompts-analysis-single');
  writeDefaultPrompt(staticDir, 'analyze-job-description', 'Analyse [[jobFieldList]] [[jobLink]] [[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');

  await assert.rejects(
    promptService.createPrompt({
      name: 'My analysis',
      featureKey: 'analyze-job-description',
      content: 'Mine [[jobDescription]]',
    }),
    /Job analysis has one prompt/
  );

  // A variant an older build created is the administrator's text: kept and
  // listed, but it cannot be activated, and the built-in stays the active one
  // even when the stored activation still names the variant.
  const { saveStoredPrompt, writeActivePrompts } = require('../dist/database/promptRepository');
  const now = new Date().toISOString();
  saveStoredPrompt({
    id: 'custom-old-analysis',
    name: 'Old analysis variant',
    featureKey: 'analyze-job-description',
    content: 'Old [[jobDescription]]',
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  });
  writeActivePrompts({ 'analyze-job-description': 'custom-old-analysis' });
  const listed = await promptService.listPrompts();
  const analysisPrompts = listed.filter((prompt) => prompt.featureKey === 'analyze-job-description');
  assert.deepEqual(analysisPrompts.map((prompt) => prompt.id).sort(), ['analyze-job-description', 'custom-old-analysis']);
  assert.equal(listed.find((prompt) => prompt.id === 'analyze-job-description').isActiveForFeature, true);
  assert.equal(listed.find((prompt) => prompt.id === 'custom-old-analysis').isActiveForFeature, false);
  await assert.rejects(promptService.activatePrompt('custom-old-analysis'), /always runs the built-in Analyze Job Description/);

  // The retired Job Filter prompt, edited by an administrator once, is not a
  // stray "unattached" prompt now: nothing could run it.
  saveStoredPrompt({
    id: 'filter-google-sheet-job',
    name: 'Filter Google Sheet Job',
    featureKey: 'filter-google-sheet-job',
    content: 'Judge [[jobContent]]',
    isBuiltIn: true,
    createdAt: now,
    updatedAt: now,
  });
  assert.equal((await promptService.listPrompts()).some((prompt) => prompt.id === 'filter-google-sheet-job'), false);
});

test('prompt validation rejects unknown variables', async () => {
  useTempStorage('prompts-validation');
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

test('feature-linked prompts may use only the variables their code supplies', async () => {
  // This used to pin the opposite: a feature prompt's variables were whatever
  // its text named, so [[customNote]] validated clean - and then every
  // generation that used the record failed, because nothing supplies it.
  const { staticDir } = useTempStorage('prompts-feature-variables');
  writeDefaultPrompt(staticDir, 'tailor-resume', 'Tailor [[profileJson]] for [[jobAnalysisJson]] with [[customNote]]');

  const promptService = loadFresh('../dist/services/promptService');
  const prompt = await promptService.getPromptById('tailor-resume');

  // Every variable the feature's code supplies, which is what an editor needs to see.
  assert.deepEqual(
    prompt.allowedVariables.map((variable) => variable.name),
    promptService.listPromptFeatureVariableNames('tailor-resume')
  );
  assert.deepEqual(prompt.validation, {
    usedVariables: ['profileJson', 'jobAnalysisJson', 'customNote'],
    unknownVariables: ['customNote'],
  });
  // Refused before it reaches a model, naming the variable.
  await assert.rejects(
    () => promptService.renderPromptSegmentsByExactId('tailor-resume', { profileJson: '{}', jobAnalysisJson: '{}' }),
    /unknown variables: customNote/
  );

  await assert.rejects(
    () =>
      promptService.createPrompt({
        name: 'Tailor Variant',
        featureKey: 'tailor-resume',
        content: 'Variant [[profileJson]] [[jobAnalysisJson]] [[customNote]]',
      }),
    /Unknown prompt variables: customNote/
  );

  const variant = await promptService.createPrompt({
    name: 'Tailor Variant',
    featureKey: 'tailor-resume',
    content: 'Variant [[profileJson]] [[jobAnalysisJson]] [[includeStrengths]]',
  });
  assert.deepEqual(variant.validation.unknownVariables, []);
});

test('editing a built-in prompt stores the edit in the database and keeps the static default untouched', async () => {
  const { dbDir, staticDir } = useTempStorage('prompts-built-in-model');
  const defaultPath = writeDefaultPrompt(staticDir, 'analyze-job-description', 'Analyze [[jobDescription]]');

  const promptService = loadFresh('../dist/services/promptService');
  const updated = await promptService.updatePrompt('analyze-job-description', {
    content: 'Analyze deeply [[jobDescription]]',
    modelProvider: 'claude-cli',
    modelName: 'haiku',
  });

  assert.equal(updated.content, 'Analyze deeply [[jobDescription]]');
  assert.equal(updated.modelProvider, 'claude-cli');
  assert.equal(updated.modelName, 'haiku');
  assert.equal(updated.isBuiltIn, true);

  const stored = readDocument(dbDir, 'prompts', 'analyze-job-description');
  assert.equal(stored.isBuiltIn, true);
  assert.equal(stored.modelProvider, 'claude-cli');
  assert.equal(stored.modelName, 'haiku');

  assert.equal(readJson(defaultPath).content, 'Analyze [[jobDescription]]');
  assert.equal(
    await promptService.renderPrompt('analyze-job-description', { jobDescription: 'Backend role' }),
    'Analyze deeply Backend role'
  );
});

test('prompt service renders prompt segments in template order', async () => {
  const { staticDir } = useTempStorage('prompts-segments');
  writeDefaultPrompt(staticDir, 'analyze-job-description', 'Intro [[jobDescription]] outro');

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

test('a prompt record naming the removed openrouter provider still loads', async () => {
  const { dbDir, staticDir } = useTempStorage('prompts-legacy-provider');
  writeDefaultPrompt(staticDir, 'analyze-job-description', 'Analyze [[jobDescription]]');

  const promptService = loadFresh('../dist/services/promptService');
  const created = await promptService.createPrompt({
    name: 'Legacy Provider Prompt',
    content: 'Legacy [[name]]',
    modelProvider: 'claude-cli',
    modelName: 'sonnet',
    allowedVariables: [{ name: 'name', description: 'Recipient name', sampleValue: 'Jane' }],
  });

  // Rewrite the stored record by hand to the shape an older release wrote.
  // This is not a hypothetical: it is what a restored backup, a hand-edited
  // row, or the legacy JSON importer produces.
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    const row = db.prepare('SELECT data FROM prompts WHERE id = ?').get(created.id);
    const record = JSON.parse(row.data);
    record.modelProvider = 'openrouter';
    record.modelName = 'openai/gpt-5.4-nano';
    db.prepare('UPDATE prompts SET data = ? WHERE id = ?').run(JSON.stringify(record), created.id);
  } finally {
    db.close();
  }

  const reloaded = loadFresh('../dist/services/promptService');
  const listed = await reloaded.listPrompts();
  const legacy = listed.find((prompt) => prompt.id === created.id);

  assert.ok(legacy, 'the legacy prompt must still be listed rather than throwing');
  assert.equal(legacy.modelProvider, 'claude-cli');
});

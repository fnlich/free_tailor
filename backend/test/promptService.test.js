const assert = require('node:assert/strict');
const test = require('node:test');

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
  writeDefaultPrompt(staticDir, 'extract-profile-from-resume', 'Extract [[resumeText]]');

  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, 'extract-profile-from-resume');
  assert.equal(prompts[0].isBuiltIn, true);
  assert.deepEqual(prompts[0].validation, {
    usedVariables: ['resumeText'],
    unknownVariables: [],
    missingVariables: [],
  });
  assert.equal(prompts[0].needsUpdate, undefined);

  assert.equal(
    await promptService.renderPrompt('extract-profile-from-resume', { resumeText: 'Jane Doe' }),
    'Extract Jane Doe'
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
  assert.deepEqual(created.validation, { usedVariables: ['name'], unknownVariables: [], missingVariables: [] });

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

test('the analysis, the job facts, Fully tailor, the revise pass and the cover letter have one prompt each: no new variant, no activation, an old variant listed but never active', async () => {
  // One analysis per posting for every resume (owner decision J0) needs one
  // prompt per call to produce it; Fully tailor, the revise pass and a cover
  // letter run on the model the run builds with: each is its built-in
  // record, which an administrator edits, run by its exact id.
  const { staticDir } = useTempStorage('prompts-single');
  writeDefaultPrompt(staticDir, 'analyze-job-description', 'Analyse [[jobLink]] [[jobDescription]]');
  writeDefaultPrompt(staticDir, 'filter-google-sheet-job', 'Facts of [[jobDescription]]');
  writeDefaultPrompt(
    staticDir,
    'tailor-resume-full',
    'Write it all for [[profileJson]] from [[jobAnalysisJson]], soft skills under [[softSkillGroupHeading]]'
  );
  writeDefaultPrompt(staticDir, 'revise-resume-coverage', 'Revise [[draftJson]] for [[missingTermsJson]]');
  writeDefaultPrompt(staticDir, 'generate-cover-letter', 'Write for [[profileJson]] at [[companyName]]');
  writeDefaultPrompt(staticDir, 'write-entry-bullets', 'Bullets for [[entryJson]]');
  const promptService = loadFresh('../dist/services/promptService');
  // Six: the resume editor's Write Entry Bullets runs by its exact id on the
  // app default model, like the others on a model the code chooses; Fully
  // tailor is the one prompt of every Fully Tailor run, whatever prompt the
  // resume chose for Partial Tailor.
  assert.deepEqual(promptService.listSinglePromptFeatures(), [
    'analyze-job-description',
    'filter-google-sheet-job',
    'tailor-resume-full',
    'revise-resume-coverage',
    'generate-cover-letter',
    'write-entry-bullets',
  ]);

  const refusals = {
    'analyze-job-description': ['Mine [[jobDescription]]', /^Error: Job analysis has one prompt, the built-in Analyze Job Description\. Edit that prompt instead of adding another\.$/],
    'filter-google-sheet-job': ['Mine [[jobDescription]]', /^Error: The job facts have one prompt, the built-in Job Facts \(Filter\), which every analysis runs beside Analyze Job Description\./],
    'tailor-resume-full': [
      'Mine [[profileJson]] [[jobAnalysisJson]] [[softSkillGroupHeading]]',
      /^Error: Fully tailoring has one prompt, the built-in Tailor Resume \(Fully\), which every Fully Tailor run uses\. Edit that prompt instead of adding another\.$/,
    ],
    'revise-resume-coverage': ['Mine [[draftJson]] [[missingTermsJson]]', /^Error: The revise pass has one prompt, the built-in Revise Resume Coverage, which runs after a tailoring that left checklist terms out or dropped a figure the resume states\. Edit that prompt instead of adding another\.$/],
    'generate-cover-letter': ['Mine [[profileJson]]', /^Error: A cover letter has one prompt, the built-in Generate Cover Letter\./],
    'write-entry-bullets': ['Mine [[entryJson]]', /^Error: Writing an entry's bullets has one prompt, the built-in Write Entry Bullets\. Edit that prompt instead of adding another\.$/],
  };
  for (const [featureKey, [content, refusal]] of Object.entries(refusals)) {
    await assert.rejects(promptService.createPrompt({ name: `My ${featureKey}`, featureKey, content }), refusal, featureKey);
  }

  // A variant an older build created is the administrator's text: kept and
  // listed, but it cannot be activated, and the built-in stays the active one
  // even when the stored activation still names the variant.
  const { saveStoredPrompt, readActivePrompts, writeActivePrompts } = require('../dist/database/promptRepository');
  const now = new Date().toISOString();
  const variants = {
    'analyze-job-description': ['custom-old-analysis', 'Old [[jobDescription]]', /always runs the built-in Analyze Job Description/],
    'filter-google-sheet-job': ['custom-old-facts', 'Old [[jobDescription]]', /^Error: Every analysis runs the built-in Job Facts \(Filter\) prompt\. Edit that prompt instead\.$/],
    'tailor-resume-full': [
      'custom-old-fully',
      'Old [[profileJson]] [[jobAnalysisJson]] [[softSkillGroupHeading]]',
      /^Error: Every Fully tailored resume runs the built-in Tailor Resume \(Fully\) prompt\. Edit that prompt instead\.$/,
    ],
    'revise-resume-coverage': ['custom-old-revise', 'Old [[draftJson]] [[missingTermsJson]]', /^Error: Every revise pass runs the built-in Revise Resume Coverage prompt\. Edit that prompt instead\.$/],
    'generate-cover-letter': ['custom-old-letter', 'Old [[profileJson]]', /^Error: Every cover letter runs the built-in Generate Cover Letter prompt\. Edit that prompt instead\.$/],
  };
  for (const [featureKey, [id, content]] of Object.entries(variants)) {
    saveStoredPrompt({ id, name: id, featureKey, content, isBuiltIn: false, createdAt: now, updatedAt: now });
  }
  writeActivePrompts(Object.fromEntries(Object.entries(variants).map(([featureKey, [id]]) => [featureKey, id])));
  const listed = await promptService.listPrompts();
  for (const [featureKey, [id, , refusal]] of Object.entries(variants)) {
    const ofFeature = listed.filter((prompt) => prompt.featureKey === featureKey);
    assert.deepEqual(ofFeature.map((prompt) => prompt.id).sort(), [featureKey, id].sort(), featureKey);
    assert.equal(listed.find((prompt) => prompt.id === featureKey).isActiveForFeature, true, featureKey);
    assert.equal(listed.find((prompt) => prompt.id === id).isActiveForFeature, false, id);
    await assert.rejects(promptService.activatePrompt(id), refusal, id);
    // At run time by feature, the built-in - whatever the stale activation says.
    assert.equal((await promptService.resolvePromptByRuntimeId(featureKey)).id, featureKey, featureKey);
  }
  // Moving another prompt INTO one of them is refused too.
  const loose = await promptService.createPrompt({
    name: 'Loose',
    content: 'Hello [[name]]',
    allowedVariables: [{ name: 'name' }],
  });
  await assert.rejects(
    promptService.updatePrompt(loose.id, { featureKey: 'filter-google-sheet-job', content: 'Facts [[jobDescription]]' }),
    /The job facts have one prompt/
  );
  // The next write of the activations drops the stale ones.
  writeDefaultPrompt(staticDir, 'extract-profile-from-resume', 'Extract [[resumeText]]');
  await promptService.activatePrompt('extract-profile-from-resume');
  assert.deepEqual(readActivePrompts(), { 'extract-profile-from-resume': 'extract-profile-from-resume' });
});

test("an edit of the job facts prompt stored before it was retired is its feature's built-in edit again: flagged and not run, never a failed analysis", async () => {
  // Owner decision O1 brought the Job Filter's own prompt back as the
  // analysis's second call. An administrator's edit an older build stored
  // reads [[jobContent]], which nothing supplies now: it is listed as the
  // feature's edit, marked, and the shipped text runs in its place.
  const { staticDir } = useTempStorage('prompts-old-facts-edit');
  writeDefaultPrompt(staticDir, 'filter-google-sheet-job', 'Shipped facts [[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const now = new Date().toISOString();
  saveStoredPrompt({
    id: 'filter-google-sheet-job',
    name: 'Filter Google Sheet Job',
    featureKey: 'filter-google-sheet-job',
    content: 'Judge [[jobContent]]',
    isBuiltIn: true,
    createdAt: now,
    updatedAt: now,
  });
  const listed = (await promptService.listPrompts()).find((prompt) => prompt.id === 'filter-google-sheet-job');
  assert.equal(listed.content, undefined, 'a summary, not the record');
  assert.equal(listed.featureLabel, 'Job Facts (Filter)');
  assert.equal(listed.category, 'extracting');
  assert.equal(listed.needsUpdate, true);
  assert.deepEqual(listed.validation.unknownVariables, ['jobContent']);
  assert.deepEqual(listed.validation.missingVariables, ['jobDescription']);
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const segments = await promptService.renderPromptSegmentsByExactId('filter-google-sheet-job', { jobDescription: 'A posting.', jobLink: '' });
    assert.equal(segments.map((segment) => segment.text).join(''), 'Shipped facts A posting.');
  } finally {
    console.warn = realWarn;
  }
});

test('prompt validation rejects unknown variables', async () => {
  useTempStorage('prompts-validation');
  const promptService = loadFresh('../dist/services/promptService');

  assert.deepEqual(promptService.extractPromptVariables('[[one]] and [[ two ]] and [[one]]'), ['one', 'two']);
  const validation = promptService.validatePromptContent('Hello [[missing]]', [{ name: 'name' }]);
  assert.deepEqual(validation, {
    usedVariables: ['missing'],
    unknownVariables: ['missing'],
    missingVariables: [],
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
  writeDefaultPrompt(
    staticDir,
    'tailor-resume',
    'Tailor [[profileJson]] for [[jobAnalysisJson]] with [[customNote]], soft skills under [[softSkillGroupHeading]]'
  );

  const promptService = loadFresh('../dist/services/promptService');
  const prompt = await promptService.getPromptById('tailor-resume');

  // Every variable the feature's code supplies, which is what an editor needs to see.
  assert.deepEqual(
    prompt.allowedVariables.map((variable) => variable.name),
    promptService.listPromptFeatureVariableNames('tailor-resume')
  );
  assert.deepEqual(prompt.validation, {
    usedVariables: ['profileJson', 'jobAnalysisJson', 'customNote', 'softSkillGroupHeading'],
    unknownVariables: ['customNote'],
    missingVariables: [],
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
    content: 'Variant [[profileJson]] [[jobAnalysisJson]] [[topSkillsJson]] [[softSkillGroupHeading]]',
  });
  assert.deepEqual(variant.validation.unknownVariables, []);
  assert.deepEqual(variant.validation.missingVariables, []);
  // The section switches are not variables any more: how the skills block is
  // drawn is decided when the resume is rendered.
  await assert.rejects(
    () =>
      promptService.createPrompt({
        name: 'Old Variant',
        featureKey: 'tailor-resume',
        content: 'Old [[profileJson]] [[jobAnalysisJson]] [[softSkillGroupHeading]] [[includeStrengths]]',
      }),
    /Unknown prompt variables: includeStrengths/
  );
});

test('editing a built-in prompt stores the edit in the database and keeps the static default untouched', async () => {
  const { dbDir, staticDir } = useTempStorage('prompts-built-in-model');
  const defaultPath = writeDefaultPrompt(staticDir, 'extract-profile-from-resume', 'Extract [[resumeText]]');

  const promptService = loadFresh('../dist/services/promptService');
  const updated = await promptService.updatePrompt('extract-profile-from-resume', {
    content: 'Extract deeply [[resumeText]]',
    modelProvider: 'claude-cli',
    modelName: 'haiku',
  });

  assert.equal(updated.content, 'Extract deeply [[resumeText]]');
  assert.equal(updated.modelProvider, 'claude-cli');
  assert.equal(updated.modelName, 'haiku');
  assert.equal(updated.isBuiltIn, true);

  const stored = readDocument(dbDir, 'prompts', 'extract-profile-from-resume');
  assert.equal(stored.isBuiltIn, true);
  assert.equal(stored.modelProvider, 'claude-cli');
  assert.equal(stored.modelName, 'haiku');

  assert.equal(readJson(defaultPath).content, 'Extract [[resumeText]]');
  assert.equal(
    await promptService.renderPrompt('extract-profile-from-resume', { resumeText: 'Jane Doe' }),
    'Extract deeply Jane Doe'
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

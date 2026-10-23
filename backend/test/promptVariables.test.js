const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// The stub below stands in for the subscription seat. Set before any dist
// module loads: the settings defaults are computed at import.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * What a prompt may say, checked against what the code will give it.
 *
 * A feature prompt is rendered from values its feature's code builds - the
 * tailoring call's `buildTailorResumePromptValues`, the analysis's
 * `buildAnalyzeJobDescriptionPromptValues` and so on. A variable outside that set cannot
 * be filled. These pin: the declared list and the builders never drift apart;
 * a typo is refused when a prompt is saved, not discovered when a resume
 * fails; a record must use its feature's REQUIRED variables - the posting for
 * the analysis and the facts call, the resume for the cover letter, the
 * tailoring's own set - to be saved; and a stored feature record without
 * them, or naming one the code no longer supplies, is marked `needsUpdate`
 * and never run: the built-in prompt runs in its place.
 */

const shipped = path.join(__dirname, '..', 'static');

/**
 * What a tailoring record must name besides `[[profileJson]]`: the analysis,
 * and the heading the code finds the soft-skill group by.
 */
const MARKERS = '[[jobAnalysisJson]]\nHead the soft skills [[softSkillGroupHeading]].';

function seeded(name, { prompts = false } = {}) {
  const storage = useTempStorage(`prompt-variables-${name}`);
  fs.cpSync(path.join(shipped, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  if (prompts) {
    fs.cpSync(path.join(shipped, 'prompts'), path.join(storage.staticDir, 'prompts'), { recursive: true });
  }
  return storage;
}

function writePrompt(staticDir, id, content) {
  return writeStaticJson(staticDir, `prompts/${id}.json`, {
    id,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

const ANALYSIS = {
  jobMeta: { title: 'Staff Engineer', seniority: 'Staff', industry: 'SaaS', department: 'Platform' },
  skills: { technical: ['TypeScript'], required: ['TypeScript'], preferred: [], tools: ['Docker'], soft: [], technologies: [] },
  technologies: [],
  protocols: [],
  methodologies: [],
  architecturePatterns: [],
  responsibilities: ['platform reliability ownership'],
  domainKnowledge: [],
  softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  sourceJobDescription: 'Staff Engineer: TypeScript services shipped with Docker.',
};

function resumeRecord(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'Jane',
    title: 'Engineer',
    contact: {},
    summary: 'Engineer.',
    experience: [],
    strengths: [{ title: 'Own strength', description: 'Hers.' }],
    skills: ['TypeScript'],
    softSkills: ['Persistence'],
    education: [],
    resumeSettings: settings,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

/* ---------------------------------------------------------------- drift */

test('every feature declares exactly the variables its code supplies', () => {
  seeded('drift');
  const promptService = loadFresh('../dist/services/promptService');
  const resumeService = loadFresh('../dist/services/resumeService');
  const reviseCoverage = loadFresh('../dist/services/reviseCoverage');

  const supplied = {
    'analyze-job-description': resumeService.buildAnalyzeJobDescriptionPromptValues('A posting.', 'https://jobs.example.com/1'),
    'filter-google-sheet-job': resumeService.buildJobFactsPromptValues('A posting.', 'https://jobs.example.com/1'),
    'tailor-resume': resumeService.buildTailorResumePromptValues(resumeRecord(), ANALYSIS),
    // The same builder, for a Fully Tailor run (the mode is passed, not read
    // from the resume): only what `profileJson` holds differs.
    'tailor-resume-full': resumeService.buildTailorResumePromptValues(resumeRecord(), ANALYSIS, 'full'),
    'revise-resume-coverage': reviseCoverage.buildReviseResumeCoveragePromptValues(
      { summary: 'Engineer.', experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Built it.'] }] },
      ['Docker'],
      [{ company: 'Acme', title: 'Engineer', line: 'Cut deploys from 40 minutes to 6.' }]
    ),
    'generate-cover-letter': resumeService.buildCoverLetterPromptValues(resumeRecord(), 'Acme', 'Engineer'),
    'write-entry-bullets': loadFresh('../dist/services/entryBullets').buildWriteEntryBulletsPromptValues(
      {
        kind: 'experience',
        title: 'Engineer',
        organization: 'Acme',
        startDate: '2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Owns the billing services.',
        bullets: [],
        skills: ['Node.js'],
      },
      { name: 'Sam', title: 'Engineer', summary: 'Builds things.', skills: ['Node.js'] },
      'write',
      ''
    ),
    'extract-template-from-pdf': resumeService.buildExtractTemplatePromptValues('PDF text', 'Imported'),
    'extract-profile-from-resume': resumeService.buildExtractResumePromptValues('Resume text'),
  };

  for (const [feature, values] of Object.entries(supplied)) {
    assert.deepEqual(
      Object.keys(values).sort(),
      promptService.listPromptFeatureVariableNames(feature).sort(),
      `${feature}: the declared variables and the values its code builds have drifted apart`
    );
  }

  // Every feature is listed, and nothing is supplied that no feature declares.
  assert.deepEqual(Object.keys(supplied).sort(), promptService.listPromptFeatureKeys().sort());

  // No value is a code constant kept in the cached part any more: the job
  // field list travels as code-owned text on the facts call, not a variable,
  // and no analysis variable is a list.
  assert.deepEqual([...promptService.STABLE_PROMPT_VARIABLES], []);
  for (const feature of ['analyze-job-description', 'filter-google-sheet-job']) {
    assert.deepEqual(Object.keys(supplied[feature]).sort(), ['jobDescription', 'jobLink'], feature);
  }
});

/* ----------------------------------------------------------- validation */

test('a typo in a feature prompt is refused when it is saved, and named when it is validated', async () => {
  const { staticDir } = seeded('typo');
  writePrompt(staticDir, 'tailor-resume', 'Tailor.\n[[profileJson]]\n[[jobAnalysisJson]]');
  const promptService = loadFresh('../dist/services/promptService');
  const typo = 'Tailor.\n[[profileJson]]\nStrengths: [[includeSoftSkillz]]';

  assert.deepEqual(await promptService.validatePromptDraft({ id: 'tailor-resume', content: typo }), {
    usedVariables: ['profileJson', 'includeSoftSkillz'],
    unknownVariables: ['includeSoftSkillz'],
    missingVariables: ['jobAnalysisJson', 'softSkillGroupHeading'],
  });
  await assert.rejects(
    () => promptService.updatePrompt('tailor-resume', { content: typo }),
    /Unknown prompt variables: includeSoftSkillz/
  );
  await assert.rejects(
    () => promptService.createPrompt({ name: 'Mine', featureKey: 'tailor-resume', content: typo }),
    /Unknown prompt variables: includeSoftSkillz/
  );

  // A draft not saved yet says which feature it is for, and is checked
  // against that feature's list - not against nothing.
  assert.deepEqual(
    await promptService.validatePromptDraft({
      featureKey: 'tailor-resume',
      content: '[[profileJson]] [[topSkillsJson]] [[softSkillGroupHeading]]',
    }),
    {
      usedVariables: ['profileJson', 'topSkillsJson', 'softSkillGroupHeading'],
      unknownVariables: [],
      missingVariables: ['jobAnalysisJson'],
    }
  );
  // The section switches are not variables now: an edit written for them names three nothing supplies.
  assert.deepEqual(
    (await promptService.validatePromptDraft({ featureKey: 'tailor-resume', content: '[[includeStrengths]] [[technicalSkillsLayout]]' }))
      .unknownVariables,
    ['includeStrengths', 'technicalSkillsLayout']
  );
  // An unattached prompt still declares its own.
  assert.deepEqual(
    (await promptService.validatePromptDraft({ content: '[[name]]', allowedVariables: [{ name: 'name' }] })).unknownVariables,
    []
  );
  assert.deepEqual((await promptService.validatePromptDraft({ content: '[[profileJson]]' })).unknownVariables, ['profileJson']);

  // The new variables are as good as the old ones.
  const saved = await promptService.updatePrompt('tailor-resume', { content: `Tailor.\n[[profileJson]]\n${MARKERS}` });
  assert.deepEqual(saved.validation.unknownVariables, []);
  assert.deepEqual(saved.validation.missingVariables, []);
  assert.equal(saved.needsUpdate, undefined);
});

test('the shipped prompts validate clean against what their code supplies', async () => {
  seeded('shipped', { prompts: true });
  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  // Nine features: the analysis's two calls (owner decision O1), the
  // tailoring (Partial and Fully) and its revise pass, the cover letter, the
  // resume editor's Write Entry Bullets, and the two extractors.
  assert.equal(prompts.length, 9);
  for (const prompt of prompts) {
    assert.deepEqual(prompt.validation.unknownVariables, [], `${prompt.id} names a variable nothing supplies`);
  }
  const tailor = prompts.find((prompt) => prompt.id === 'tailor-resume');
  for (const variable of tailor.allowedVariables) {
    assert.ok(variable.description, `${variable.name} is documented for the editor`);
    assert.ok(variable.sampleValue, `${variable.name} has a sample for previews`);
  }
  assert.equal(tailor.needsUpdate, undefined, 'the shipped text names every marker');
  assert.deepEqual(tailor.validation.missingVariables, []);
  assert.deepEqual(
    tailor.allowedVariables.filter((entry) => entry.required).map((entry) => entry.name),
    ['profileJson', 'jobAnalysisJson', 'softSkillGroupHeading'],
    'the editor is told which are required'
  );
  // The owner's tailoring text uses every list the code builds for it; jobTitle is offered, not used.
  // Fully tailor's text is held to the same, and to the same required markers.
  const fully = prompts.find((prompt) => prompt.id === 'tailor-resume-full');
  for (const record of [tailor, fully]) {
    assert.deepEqual(
      [...record.validation.usedVariables].sort(),
      [
        'conceptKeywordsJson', 'conceptToolsJson', 'domainKnowledge', 'jobAnalysisJson', 'keyResponsibilitiesJson',
        'keywordsJson', 'profileJson', 'skillsJSON', 'softSkillGroupHeading', 'targetRoleTitle', 'topSkillsJson',
      ],
      record.id
    );
  }
  assert.equal(fully.needsUpdate, undefined);
  assert.deepEqual(fully.validation.missingVariables, []);
  assert.deepEqual(
    fully.allowedVariables.filter((entry) => entry.required).map((entry) => entry.name),
    ['profileJson', 'jobAnalysisJson', 'softSkillGroupHeading']
  );
  assert.match(
    fully.allowedVariables.find((entry) => entry.name === 'profileJson').description,
    /each role as its title, company and dates only/
  );
  // The contract markers of the other features, each used by its shipped text.
  const required = {
    'analyze-job-description': ['jobDescription'],
    'filter-google-sheet-job': ['jobDescription'],
    'revise-resume-coverage': ['draftJson', 'missingTermsJson'],
    'generate-cover-letter': ['profileJson'],
    'write-entry-bullets': ['entryJson'],
    'extract-template-from-pdf': [],
    'extract-profile-from-resume': [],
  };
  // The bullets text uses all four of its variables.
  assert.deepEqual(
    [...prompts.find((entry) => entry.id === 'write-entry-bullets').validation.usedVariables].sort(),
    ['entryJson', 'instructions', 'profileJson', 'task']
  );
  for (const [id, names] of Object.entries(required)) {
    const prompt = prompts.find((entry) => entry.id === id);
    assert.equal(prompt.needsUpdate, undefined, `${id} ships complete`);
    assert.deepEqual(prompt.validation.missingVariables, [], id);
    assert.deepEqual(prompt.allowedVariables.filter((entry) => entry.required).map((entry) => entry.name), names, id);
    for (const variable of prompt.allowedVariables) assert.ok(variable.description, `${id}: ${variable.name} is documented`);
  }
  // The owner's analysis and facts texts read the posting alone; the link is offered, not used.
  for (const id of ['analyze-job-description', 'filter-google-sheet-job']) {
    assert.deepEqual(prompts.find((entry) => entry.id === id).validation.usedVariables, ['jobDescription'], id);
  }

  assert.deepEqual(
    prompts.find((entry) => entry.id === 'revise-resume-coverage').validation.usedVariables,
    ['draftJson', 'missingTermsJson', 'figuresNote']
  );

  const preview = await promptService.previewPrompt({ id: 'tailor-resume' });
  assert.equal(preview.sampleValues.softSkillGroupHeading, 'Professional Skills');
  assert.match(preview.renderedContent, /Head it exactly Professional Skills - that heading/);
  assert.doesNotMatch(preview.renderedContent, /\[\[/);
  const revisePreview = await promptService.previewPrompt({ id: 'revise-resume-coverage' });
  assert.match(revisePreview.renderedContent, /^THE DRAFT/m);
  assert.doesNotMatch(revisePreview.renderedContent, /\[\[/);
});

test('a save that leaves out a required variable is refused, naming it and the rule', async () => {
  const { staticDir } = seeded('required');
  writePrompt(staticDir, 'tailor-resume', `Tailor.\n[[profileJson]]\n${MARKERS}`);
  writePrompt(staticDir, 'revise-resume-coverage', 'Revise.\n[[draftJson]]\n[[missingTermsJson]]');
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobDescription]]');
  writePrompt(staticDir, 'generate-cover-letter', 'Write.\n[[profileJson]]');
  const promptService = loadFresh('../dist/services/promptService');

  await assert.rejects(
    () => promptService.updatePrompt('tailor-resume', { content: 'Tailor.\n[[profileJson]]\n[[softSkillGroupHeading]]' }),
    (error) =>
      error.message ===
      'Missing required prompt variables: jobAnalysisJson. Every Tailor Resume prompt must use ' +
        '[[profileJson]], [[jobAnalysisJson]] and [[softSkillGroupHeading]].'
  );
  await assert.rejects(
    () => promptService.createPrompt({ name: 'Old Variant', featureKey: 'tailor-resume', content: 'Old.\n[[profileJson]]' }),
    /Missing required prompt variables: jobAnalysisJson, softSkillGroupHeading\./
  );
  await assert.rejects(
    () => promptService.updatePrompt('revise-resume-coverage', { content: 'Revise.\n[[draftJson]]\n[[figuresNote]]' }),
    (error) =>
      error.message ===
      'Missing required prompt variables: missingTermsJson. Every Revise Resume Coverage prompt must use ' +
        '[[draftJson]] and [[missingTermsJson]].'
  );
  await assert.rejects(
    () => promptService.updatePrompt('analyze-job-description', { content: 'Analyze the posting at [[jobLink]].' }),
    (error) =>
      error.message ===
      'Missing required prompt variables: jobDescription. Every Analyze Job Description prompt must use [[jobDescription]].'
  );
  await assert.rejects(
    () => promptService.updatePrompt('generate-cover-letter', { content: 'Write to [[companyName]] about [[role]].' }),
    /^Error: Missing required prompt variables: profileJson\. Every Generate Cover Letter prompt must use \[\[profileJson\]\]\.$/
  );
  // A variable the code no longer supplies is refused by name, before the rule.
  await assert.rejects(
    () => promptService.updatePrompt('analyze-job-description', { content: 'Analyze.\n[[jobFieldList]]\n[[jobDescription]]' }),
    /^Error: Unknown prompt variables: jobFieldList$/
  );
  // Nothing was stored by the refusals.
  const listed = new Map((await promptService.listPrompts()).map((prompt) => [prompt.id, prompt]));
  assert.match((await promptService.getPromptById('tailor-resume')).content, /Head the soft skills/);
  assert.equal((await promptService.getPromptById('analyze-job-description')).content, 'Analyze.\n[[jobDescription]]');
  assert.equal([...listed.keys()].some((id) => id.startsWith('custom-')), false);

  // A feature with no required variables saves without them, and an unattached prompt has none.
  const extract = await promptService.createPrompt({
    name: 'Extract',
    featureKey: 'extract-profile-from-resume',
    content: 'Extract [[resumeText]]',
  });
  assert.deepEqual(extract.validation.missingVariables, []);
});

test('a stored record missing a required variable, or naming one nothing supplies, is marked, with the names, and only that', async () => {
  const { staticDir } = seeded('needs-update');
  writePrompt(staticDir, 'tailor-resume', `Tailor.\n[[profileJson]]\n${MARKERS}`);
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobFieldList]]\nJob link: [[jobLink]]\n[[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const at = '2026-01-01T00:00:00.000Z';
  // A variant stored before the rule, as an older build saved it.
  saveStoredPrompt({
    id: 'custom-tailor-resume-old',
    name: 'Old Variant',
    featureKey: 'tailor-resume',
    content: 'Old.\n[[profileJson]]\nStrengths: [[includeStrengths]]',
    isBuiltIn: false,
    createdAt: at,
    updatedAt: at,
  });

  const listed = new Map((await promptService.listPrompts()).map((prompt) => [prompt.id, prompt]));
  // A variant written for the section switches: it lacks the new markers and
  // names a switch the code no longer supplies.
  assert.equal(listed.get('custom-tailor-resume-old').needsUpdate, true);
  assert.deepEqual(listed.get('custom-tailor-resume-old').validation.missingVariables, ['jobAnalysisJson', 'softSkillGroupHeading']);
  assert.deepEqual(listed.get('custom-tailor-resume-old').validation.unknownVariables, ['includeStrengths']);
  assert.equal(listed.get('tailor-resume').needsUpdate, undefined);
  // The analysis file here asks for the job field list, which no version
  // supplies now: marked too, naming it as unknown and nothing as missing.
  assert.equal(listed.get('analyze-job-description').needsUpdate, true);
  assert.deepEqual(listed.get('analyze-job-description').validation.unknownVariables, ['jobFieldList']);
  assert.deepEqual(listed.get('analyze-job-description').validation.missingVariables, []);

  // Saved without it, the mark goes.
  const saved = await promptService.updatePrompt('analyze-job-description', {
    content: 'Analyze.\nJob link: [[jobLink]]\n[[jobDescription]]',
  });
  assert.deepEqual(saved.validation.unknownVariables, []);
  assert.equal(saved.needsUpdate, undefined);
  const preview = await promptService.previewPrompt({ id: 'analyze-job-description' });
  assert.match(preview.renderedContent, /^Analyze\.\nJob link: https:\/\//, 'the preview fills the samples');
  assert.doesNotMatch(preview.renderedContent, /\[\[/);

  // An UNATTACHED prompt naming a variable it does not declare is not marked:
  // it has no built-in to give way to, and its run fails as it always did.
  saveStoredPrompt({
    id: 'custom-loose',
    name: 'Loose',
    content: 'Hello [[name]] and [[stray]]',
    allowedVariables: [{ name: 'name' }],
    isBuiltIn: false,
    createdAt: at,
    updatedAt: at,
  });
  const loose = (await promptService.listPrompts()).find((prompt) => prompt.id === 'custom-loose');
  assert.deepEqual(loose.validation.unknownVariables, ['stray']);
  assert.equal(loose.needsUpdate, undefined);
  await assert.rejects(promptService.renderPrompt('custom-loose', { name: 'x' }), /contains unknown variables: stray/);
});

test('a record that needs updating is never run: the built-in prompt runs in its place, said once', async () => {
  const { staticDir } = seeded('needs-update-runtime');
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n${MARKERS}`);
  writePrompt(staticDir, 'analyze-job-description', 'Shipped analysis.\n[[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const at = '2026-01-01T00:00:00.000Z';
  // An administrator's edit of the built-in analysis written for the older
  // contract (the job field list), and a tailoring variant that never names
  // the analysis or the soft-skill heading - both stored before the rules.
  saveStoredPrompt({ id: 'analyze-job-description', featureKey: 'analyze-job-description', content: 'Edited.\n[[jobFieldList]]\n[[jobDescription]]', isBuiltIn: true, createdAt: at, updatedAt: at });
  saveStoredPrompt({ id: 'custom-tailor-resume-mine', name: 'Mine', featureKey: 'tailor-resume', content: 'Mine.\n[[profileJson]]', isBuiltIn: false, createdAt: at, updatedAt: at });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const analysis = await promptService.resolvePromptByExactId('analyze-job-description');
    assert.match(analysis.content, /^Shipped analysis/, 'the shipped text, not the edit');
    assert.equal(analysis.needsUpdate, undefined);
    const segments = await promptService.renderPromptSegmentsByExactId('analyze-job-description', {
      jobLink: '',
      jobDescription: 'A posting.',
    });
    assert.match(segments.map((segment) => segment.text).join(''), /^Shipped analysis\.\nA posting\.$/);

    const variant = await promptService.resolvePromptByExactId('custom-tailor-resume-mine');
    assert.equal(variant.id, 'tailor-resume', 'the feature\'s built-in runs for the variant');
    assert.match(variant.content, /^Shipped tailoring/);
    await promptService.resolvePromptByExactId('custom-tailor-resume-mine');

    const said = (id) => warnings.filter((line) => line.includes(`(${id})`) && line.includes('runs instead'));
    assert.equal(said('analyze-job-description').length, 1, 'said once, however often it is asked');
    assert.match(
      said('analyze-job-description')[0],
      /\(analyze-job-description\) uses \[\[jobFieldList\]\], which this version does not supply, and dates from an older version of the Analyze Job Description prompt; the built-in/
    );
    assert.equal(said('custom-tailor-resume-mine').length, 1);
    assert.match(said('custom-tailor-resume-mine')[0], /does not use \[\[jobAnalysisJson\]\] and \[\[softSkillGroupHeading\]\], which every Tailor Resume prompt must/);
  } finally {
    console.warn = realWarn;
  }

  // Admin -> Prompts still shows - and edits - the stored record as it is.
  assert.match((await promptService.getPromptById('analyze-job-description')).content, /^Edited/);
});

/*
 * The owner's analysis and job facts texts name nothing but
 * `[[jobDescription]]` (and the optional `[[jobLink]]`) - and so did an
 * analysis edit saved before the job field lists, and an edit of the Job
 * Filter's prompt before it was retired. No reading of a record's variables
 * can tell those apart from a valid edit of today, so a stored record of a
 * feature whose contract changed is dated: saved before `contractSince`, it
 * is `needsUpdate` and `savedForOlderVersion`, and the built-in runs in its
 * place until it is saved again. The shipped file is never dated. The revise
 * pass and the cover letter are dated too since their texts were grounded in
 * the resume (an older edit could still ask for a figure the work "implies"),
 * and Write Entry Bullets, whose text never changed, is not.
 */
test('a stored edit saved before its feature\'s contract changed gives way by its date, whatever variables it uses', async () => {
  const { staticDir } = seeded('older-contract', { prompts: true });
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const before = '2026-01-02T00:00:00.000Z';
  saveStoredPrompt({ id: 'analyze-job-description', featureKey: 'analyze-job-description', content: 'OLD ADMIN ANALYSIS EDIT. Extract keywords as JSON.\n\n[[jobDescription]]', isBuiltIn: true, createdAt: before, updatedAt: before });
  saveStoredPrompt({ id: 'filter-google-sheet-job', featureKey: 'filter-google-sheet-job', content: 'OLD ADMIN FILTER EDIT.\n[[jobDescription]]', isBuiltIn: true, createdAt: before, updatedAt: before });
  saveStoredPrompt({ id: 'custom-tailor-resume-dated', name: 'Dated', featureKey: 'tailor-resume', content: `Dated variant.\n[[profileJson]]\n${MARKERS}`, isBuiltIn: false, createdAt: before, updatedAt: before });
  saveStoredPrompt({ id: 'revise-resume-coverage', featureKey: 'revise-resume-coverage', content: 'OLD REVISE EDIT.\n[[draftJson]]\n[[missingTermsJson]]\n[[figuresNote]]', isBuiltIn: true, createdAt: before, updatedAt: before });
  saveStoredPrompt({ id: 'generate-cover-letter', featureKey: 'generate-cover-letter', content: 'MY LETTER EDIT.\n[[profileJson]]', isBuiltIn: true, createdAt: before, updatedAt: before });
  // Write Entry Bullets meets the contract it was written for, which has not changed: never dated.
  saveStoredPrompt({ id: 'write-entry-bullets', featureKey: 'write-entry-bullets', content: 'MY BULLETS EDIT.\n[[entryJson]]', isBuiltIn: true, createdAt: before, updatedAt: before });

  const listed = new Map((await promptService.listPrompts()).map((prompt) => [prompt.id, prompt]));
  for (const id of ['analyze-job-description', 'filter-google-sheet-job', 'custom-tailor-resume-dated', 'revise-resume-coverage', 'generate-cover-letter']) {
    const prompt = listed.get(id);
    assert.deepEqual(prompt.validation.missingVariables, [], id);
    assert.deepEqual(prompt.validation.unknownVariables, [], id);
    assert.equal(prompt.needsUpdate, true, id);
    assert.equal(prompt.savedForOlderVersion, true, id);
  }
  assert.equal(listed.get('write-entry-bullets').needsUpdate, undefined);
  assert.equal(listed.get('write-entry-bullets').savedForOlderVersion, undefined);

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const analysis = await promptService.resolvePromptByExactId('analyze-job-description');
    assert.doesNotMatch(analysis.content, /OLD ADMIN ANALYSIS EDIT/);
    assert.equal(analysis.content, JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', 'analyze-job-description.json'), 'utf8')).content.trim());
    assert.equal(analysis.needsUpdate, undefined, 'the shipped file is never dated');
    const facts = await promptService.renderPromptSegmentsByExactId('filter-google-sheet-job', { jobDescription: 'A posting.', jobLink: '' });
    assert.doesNotMatch(facts.map((segment) => segment.text).join(''), /OLD ADMIN FILTER EDIT/);
    assert.equal((await promptService.resolvePromptByExactId('custom-tailor-resume-dated')).id, 'tailor-resume');
    for (const id of ['revise-resume-coverage', 'generate-cover-letter']) {
      assert.equal(
        (await promptService.resolvePromptByExactId(id)).content,
        JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', `${id}.json`), 'utf8')).content.trim(),
        `${id}: the shipped text runs in place of the older edit`
      );
    }
    assert.match((await promptService.resolvePromptByExactId('write-entry-bullets')).content, /^MY BULLETS EDIT/);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((line) =>
      line.includes('(analyze-job-description) dates from an older version of the Analyze Job Description prompt; the built-in Analyze Job Description prompt runs instead')
    )
  );
  assert.ok(warnings.some((line) => line.includes('(custom-tailor-resume-dated) dates from an older version of the Tailor Resume prompt;')));

  // Saved again - under this version, the same text or another - it is the
  // administrator's choice of today, and runs.
  const saved = await promptService.updatePrompt('analyze-job-description', { content: 'OLD ADMIN ANALYSIS EDIT. Extract keywords as JSON.\n\n[[jobDescription]]' });
  assert.equal(saved.needsUpdate, undefined);
  assert.equal(saved.savedForOlderVersion, undefined);
  assert.match((await promptService.resolvePromptByExactId('analyze-job-description')).content, /^OLD ADMIN ANALYSIS EDIT/);

  // A record no time can be read off is not trusted over the shipped text either.
  saveStoredPrompt({ id: 'filter-google-sheet-job', featureKey: 'filter-google-sheet-job', content: 'UNDATED.\n[[jobDescription]]', isBuiltIn: true, createdAt: 'x', updatedAt: 'sometime' });
  assert.equal((await promptService.listPrompts()).find((prompt) => prompt.id === 'filter-google-sheet-job').savedForOlderVersion, true);

  // A shipped file with an old date of its own is never dated: it IS the contract.
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n${MARKERS}`);
  const shippedTailor = (await loadFresh('../dist/services/promptService').listPrompts()).find((prompt) => prompt.id === 'tailor-resume');
  assert.equal(shippedTailor.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(shippedTailor.needsUpdate, undefined);
});

test("the features whose contract changed are dated from the shipped files' own updatedAt", () => {
  const promptService = require('../dist/services/promptService');
  // Each shipped file of a dated feature carries its contract's time exactly,
  // so the next change to a contract moves the two together. The tailoring's
  // moved on its own (two modes, an empty role written from the posting, the
  // posting's hard skills in the block), and the revise pass (each role's
  // dates, any term after a Fully draft) and the cover letter (told the
  // tailored resume) with it; the analysis and the job facts stayed.
  const contracts = {
    'analyze-job-description': promptService.OWNER_PROMPTS_CONTRACT,
    'filter-google-sheet-job': promptService.OWNER_PROMPTS_CONTRACT,
    'tailor-resume': promptService.TAILORING_PROMPTS_CONTRACT,
    'tailor-resume-full': promptService.TAILORING_PROMPTS_CONTRACT,
    'revise-resume-coverage': promptService.TAILORING_PROMPTS_CONTRACT,
    'generate-cover-letter': promptService.TAILORING_PROMPTS_CONTRACT,
  };
  for (const [featureKey, contract] of Object.entries(contracts)) {
    const file = JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', `${featureKey}.json`), 'utf8'));
    assert.equal(file.updatedAt, contract, featureKey);
  }
  assert.ok(promptService.TAILORING_PROMPTS_CONTRACT > promptService.OWNER_PROMPTS_CONTRACT);
});

/*
 * The shipped texts are the one place a model is told what it may claim, so
 * the rules that keep a resume to what the candidate did are held here - each
 * a sentence a later edit of the shipped file could drop without any other
 * test noticing - and so is the absence of the ones they replaced.
 */
test('the shipped prompts keep a resume to what its source says', () => {
  const text = (id) => JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', `${id}.json`), 'utf8')).content;
  // Partial tailor: the bullets and the summary of a role the resume
  // describes claim only what it says; the skills block leads with the
  // posting's hard skills whatever the resume lists (owner's request,
  // 2026-10-20); a role the resume leaves EMPTY is written from the posting
  // rather than printed blank - the empty Experience and Skills a resume of
  // titles and dates came out with.
  const tailor = text('tailor-resume');
  for (const rule of [
    /THE PROFILE IS THE ONLY SOURCE OF FACT FOR WHAT THE CANDIDATE DID/,
    /A ROLE THE PROFILE LEAVES EMPTY/,
    /no role is printed without bullets/,
    /EVERY HARD SKILL THE POSTING NAMES/,
    /whether or not the profile lists it/,
    /A posting technology the profile does not show is in the block, and in NO sentence about a described role/,
    /Never add a figure the profile does not state/,
    /NEVER pick a tool from these lists that the profile does not name/,
    /15 to 30 entries/,
    /SELF-CHECK BEFORE YOU RETURN/,
  ]) {
    assert.match(tailor, rule);
  }
  for (const hole of [
    /may be written even when the profile does not list it/,
    /THIRTY is the target/,
    /AT LEAST FIVE FIGURES/,
    /modest figure the work itself implies/,
    // The rule that left a bare resume's skills block empty.
    /WHAT GOES IN: THE CANDIDATE'S OWN SKILLS, AND NOTHING ELSE/,
    /A posting technology the profile does not show is NOT added/,
  ]) {
    assert.doesNotMatch(tailor, hole);
  }
  // Fully tailor: the frame is the resume's, the work is written for the
  // posting, believable for the title, company and years, with modest figures.
  const fully = text('tailor-resume-full');
  for (const rule of [
    /THE FRAME IS FIXED; THE WORK IS YOURS TO WRITE/,
    /every role appears and no role is added/,
    /Only technologies that existed, and were in ordinary use, in the role's years/,
    /FIGURES: MODEST, PLAUSIBLE, AND IN PROPORTION/,
    /never name a client, a colleague, a launch or an incident you cannot know/,
    /EVERY HARD SKILL THE POSTING NAMES/,
    /The letter tells only what the resume tells/,
    /SELF-CHECK BEFORE YOU RETURN/,
  ]) {
    assert.match(fully, rule);
  }
  assert.doesNotMatch(fully, /THE PROFILE IS THE ONLY SOURCE OF FACT/);
  const analysis = text('analyze-job-description');
  assert.match(analysis, /EXTRACT WHAT THE POSTING SAYS, IN THE POSTING'S WORDS/);
  assert.doesNotMatch(analysis, /Doubt means extract|Implied skills|Target: \d/);
  assert.match(text('revise-resume-coverage'), /A term you cannot place honestly in either way stays missing/);
  assert.doesNotMatch(text('revise-resume-coverage'), /unless you are asked above for more/);
  assert.match(text('generate-cover-letter'), /the candidate's profile below is the only source of fact/);
  assert.match(text('extract-profile-from-resume'), /Never add a skill because a title, a project or another skill implies it/);
});

/*
 * The built-in an outdated record falls back to may be outdated too: an
 * upgraded database can hold a tailoring variant AND an edit of the built-in
 * tailoring prompt, both saved before the rule. Then the SHIPPED text runs,
 * never the edit - and the same by every road a run takes: by exact id, by
 * feature or id (resolvePromptByRuntimeId), and rendered by feature.
 */
test('when the built-in edit needs updating as well, the shipped prompt runs, by every road', async () => {
  const { staticDir } = seeded('needs-update-both');
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n${MARKERS}`);
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const at = '2026-01-01T00:00:00.000Z';
  saveStoredPrompt({ id: 'tailor-resume', featureKey: 'tailor-resume', content: 'Stale edit.\n[[profileJson]]', isBuiltIn: true, createdAt: at, updatedAt: at });
  saveStoredPrompt({ id: 'custom-tailor-resume-mine', name: 'Mine', featureKey: 'tailor-resume', content: 'Mine.\n[[profileJson]]', isBuiltIn: false, createdAt: at, updatedAt: at });

  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const byExactId = await promptService.resolvePromptByExactId('custom-tailor-resume-mine');
    assert.match(byExactId.content, /^Shipped tailoring/, 'the shipped text, not the stale edit of the built-in');
    assert.match((await promptService.resolvePromptByExactId('tailor-resume')).content, /^Shipped tailoring/);

    for (const id of ['tailor-resume', 'custom-tailor-resume-mine']) {
      const byRuntimeId = await promptService.resolvePromptByRuntimeId(id);
      assert.match(byRuntimeId.content, /^Shipped tailoring/, `resolvePromptByRuntimeId('${id}')`);
      assert.equal(byRuntimeId.needsUpdate, undefined);
    }

    const values = { profileJson: 'PROFILE', jobAnalysisJson: 'ANALYSIS', softSkillGroupHeading: 'Working Style' };
    const segments = await promptService.renderPromptSegments('tailor-resume', values);
    assert.match(segments.map((segment) => segment.text).join(''), /^Shipped tailoring\.\nPROFILE\nANALYSIS\nHead the soft skills Working Style\./);
    assert.match(await promptService.renderPrompt('tailor-resume', values), /^Shipped tailoring\.\nPROFILE\n/);
  } finally {
    console.warn = realWarn;
  }
});

/* ------------------------------------------- the contract, through a seat */

/** One canned answer for the tailoring (and anything else), and no change from a revise pass. */
function stubSeat(answer) {
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const requests = [];
  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      requests.push(request);
      const text = request.callSite === 'revise-resume-coverage' ? '{}' : answer;
      return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));
  return requests;
}

const tailorings = (requests) => requests.filter((request) => request.callSite === 'tailor-resume');

const CHOICE = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'm', modelLabel: 'Stub' };

test('whichever record runs, nothing is appended to its turn, and the answer is held to the source resume', async () => {
  const { staticDir } = seeded('backstop');
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n${MARKERS}`);
  const promptService = loadFresh('../dist/services/promptService');

  // An edit stored as the built-in's row, and a per-resume custom variant -
  // both complete, and both telling the model to write strengths anyway.
  await promptService.updatePrompt('tailor-resume', {
    content: `My own tailoring prompt.\n[[profileJson]]\n${MARKERS}\nAlways write 2-4 strengths; they are the overflow bucket.`,
  });
  const custom = await promptService.createPrompt({
    name: 'Per Resume',
    featureKey: 'tailor-resume',
    content: `Per-resume prompt.\n[[profileJson]]\n${MARKERS}\nWrite strengths and soft skills.`,
  });

  // A model that does what those prompts say, not what the resume says.
  const requests = stubSeat(
    JSON.stringify({
      summary: 'Engineer building services.',
      experience: [],
      hardSkills: ['Anything'],
      softSkills: ['Model Soft'],
      skillGroups: [
        { category: 'Languages', skills: ['TypeScript'] },
        { category: 'Soft Skills', skills: ['Model Soft'] },
      ],
      strengths: [{ title: 'Model strength', description: 'Written because the prompt asked.' }],
      coverLetter: 'I build.',
    })
  );
  const resumeService = loadFresh('../dist/services/resumeService');

  const off = await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  assert.equal(tailorings(requests).length, 1);
  const [first] = tailorings(requests);
  // The edited row is what rendered, with nothing after it: the prompt is the
  // whole instruction (there is no skill override any more).
  assert.match(first.stableSystem, /My own tailoring prompt/);
  assert.doesNotMatch(first.userBody, /FINAL SKILL OVERRIDE|Strengths section|Technical skills layout/);
  assert.match(first.userBody, /Always write 2-4 strengths; they are the overflow bucket\.\s*$/, "the record's own text ends the turn");
  // And the answer is held to the source resume, whatever the model sent.
  assert.deepEqual(off.strengths, [], 'Strengths off: none');
  assert.deepEqual(off.softSkills, [], 'Soft Skills off: the soft group stays in the skills block');
  assert.deepEqual(off.skillGroups.map((group) => group.category), ['Languages', 'Soft Skills']);
  assert.deepEqual(off.hardSkills, ['TypeScript'], "the model's groups, never its hardSkills field");

  const on = await resumeService.tailorResume(
    resumeRecord({ includeStrengths: true, includeSoftSkills: true, technicalSkillsLayout: 'flat', resumePromptId: custom.id }),
    ANALYSIS,
    CHOICE,
    'partial'
  );
  assert.equal(tailorings(requests).length, 2);
  assert.match(tailorings(requests)[1].stableSystem, /Per-resume prompt/);
  assert.deepEqual(on.strengths, [{ title: 'Own strength', description: 'Hers.' }], "the resume's own, never the model's");
  assert.deepEqual(on.softSkills, ['Model Soft'], 'Soft Skills on: the soft group goes to its section');
  assert.equal(on.hardSkills.includes('Anything'), false);
  assert.equal(on.hardSkills.includes('Model Soft'), false);
});

/* -------------------------------------------------------------- the routes */

test('the prompt routes refuse a variable nothing supplies, and say which', async (t) => {
  const { staticDir } = seeded('routes');
  writePrompt(staticDir, 'tailor-resume', 'Tailor.\n[[profileJson]]\nReturn 2-4 strengths.');
  const { useAdminEmails } = require('./helpers');
  useAdminEmails('admin@example.com');

  const express = require('express');
  const users = loadFresh('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const token = users.createSession(admin.id);
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/prompts', loadFresh('../dist/routes/prompts').default);
  const server = app.listen(0);
  t.after(() => server.close());
  const call = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/prompts${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  const typo = 'Tailor.\n[[profileJson]]\n[[includeSoftSkillz]]';
  const validated = await call('POST', '/validate', { id: 'tailor-resume', content: typo });
  assert.equal(validated.status, 200);
  assert.deepEqual(validated.body.unknownVariables, ['includeSoftSkillz']);

  const draft = await call('POST', '/validate', { featureKey: 'tailor-resume', content: typo });
  assert.deepEqual(draft.body.unknownVariables, ['includeSoftSkillz'], 'an unsaved variant is checked the same way');

  const saved = await call('PUT', '/tailor-resume', { content: typo });
  assert.equal(saved.status, 400);
  assert.match(saved.body.error, /Unknown prompt variables: includeSoftSkillz/);

  const created = await call('POST', '/', { name: 'Variant', featureKey: 'tailor-resume', content: typo });
  assert.equal(created.status, 400);
  assert.match(created.body.error, /Unknown prompt variables: includeSoftSkillz/);

  // A save without a required variable is refused, naming it.
  const incomplete = await call('PUT', '/tailor-resume', { content: 'Tailor.\n[[profileJson]]\n[[softSkillGroupHeading]]' });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error, /Missing required prompt variables: jobAnalysisJson\./);

  // An administrator's list says which text needs updating, and what it lacks.
  const listed = await call('GET', '/');
  const shippedRow = listed.body.find((prompt) => prompt.id === 'tailor-resume');
  assert.equal(shippedRow.needsUpdate, true);
  assert.deepEqual(shippedRow.validation.missingVariables, ['jobAnalysisJson', 'softSkillGroupHeading']);
  const fixed = await call('PUT', '/tailor-resume', { content: `Tailor.\n[[profileJson]]\n${MARKERS}` });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.needsUpdate, undefined);
});

/* ------------------------------------------- which record a resume runs */

test("a resume naming a tailoring prompt that is gone runs the built-in, said once; a cover letter always runs the built-in", async () => {
  const { staticDir } = seeded('resume-prompt');
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n${MARKERS}`);
  writePrompt(staticDir, 'generate-cover-letter', 'Shipped letter.\n[[profileJson]]\n[[companyName]] [[role]]');
  writePrompt(staticDir, 'extract-profile-from-resume', 'Extract [[resumeText]]');
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const at = '2026-01-01T00:00:00.000Z';
  const variant = await promptService.createPrompt({
    name: 'Per Resume',
    featureKey: 'tailor-resume',
    content: `Per-resume prompt.\n[[profileJson]]\n${MARKERS}`,
  });
  // A cover-letter variant an older build saved, and a resume naming it in
  // the setting no page ever set.
  saveStoredPrompt({ id: 'custom-generate-cover-letter-mine', name: 'Mine', featureKey: 'generate-cover-letter', content: 'My letter.\n[[profileJson]]', isBuiltIn: false, createdAt: at, updatedAt: at });

  const requests = stubSeat(JSON.stringify({ summary: 'Engineer.', experience: [], coverLetter: 'I build.' }));
  const resumeService = loadFresh('../dist/services/resumeService');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    // Its own variant: run.
    await resumeService.tailorResume(resumeRecord({ resumePromptId: variant.id }), ANALYSIS, CHOICE, 'partial');
    assert.match(tailorings(requests).at(-1).stableSystem, /^Per-resume prompt/);

    // A variant deleted since: the built-in, not `Prompt "..." not found` on every build.
    await promptService.deletePrompt(variant.id);
    await resumeService.tailorResume(resumeRecord({ resumePromptId: variant.id }), ANALYSIS, CHOICE, 'partial');
    assert.match(tailorings(requests).at(-1).stableSystem, /^Shipped tailoring/);
    await resumeService.tailorResume(resumeRecord({ resumePromptId: variant.id }), ANALYSIS, CHOICE, 'partial');
    const gone = warnings.filter((line) => line.includes(`"${variant.id}"`));
    assert.equal(gone.length, 1, 'said once per resume and id');
    assert.match(gone[0], /does not exist; the built-in Tailor Resume prompt runs instead/);

    // A prompt of another feature is no tailoring prompt either.
    await resumeService.tailorResume(resumeRecord({ resumePromptId: 'extract-profile-from-resume' }), ANALYSIS, CHOICE, 'partial');
    assert.match(tailorings(requests).at(-1).stableSystem, /^Shipped tailoring/);
    assert.ok(warnings.some((line) => /"extract-profile-from-resume", which is not a Tailor Resume prompt/.test(line)));

    // The cover letter: its built-in, whatever the resume once stored.
    await resumeService.generateCoverLetter(
      resumeRecord({ coverLetterPromptId: 'custom-generate-cover-letter-mine' }),
      'Acme',
      'Engineer',
      CHOICE
    );
    assert.equal(requests.at(-1).callSite, 'generate-cover-letter');
    assert.match(requests.at(-1).stableSystem, /^Shipped letter/);
  } finally {
    console.warn = realWarn;
  }

  // And a resume save drops the setting nothing reads.
  const { normalizeResumeSettings } = require('../dist/services/resumeDocument');
  assert.equal('coverLetterPromptId' in normalizeResumeSettings({ coverLetterPromptId: 'custom-generate-cover-letter-mine' }), false);
  assert.equal('coverLetterPromptId' in normalizeResumeSettings({}, { coverLetterPromptId: 'generate-cover-letter' }), false);
});

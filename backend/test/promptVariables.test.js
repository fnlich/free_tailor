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
 * be filled, so a record naming one fails every run that uses it. These pin:
 * the declared list and the builders never drift apart; a typo is refused when
 * a prompt is saved, not discovered when a resume fails; a record must use its
 * feature's REQUIRED variables - the analysis's two lists, the tailoring's
 * three section switches - to be saved; and a stored record without them is
 * marked `needsUpdate` and never run: the built-in prompt runs in its place.
 */

const shipped = path.join(__dirname, '..', 'static');

/** The tailoring prompt's three switches, as a record must name them. */
const SWITCHES = 'Strengths: [[includeStrengths]]. Soft: [[includeSoftSkills]]. Layout: [[technicalSkillsLayout]].';

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

function profile(settings = {}, extra = {}) {
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
    profileSettings: settings,
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

  const supplied = {
    'analyze-job-description': resumeService.buildAnalyzeJobDescriptionPromptValues('A posting.', 'https://jobs.example.com/1'),
    'tailor-resume': resumeService.buildTailorResumePromptValues(profile(), ANALYSIS),
    'generate-cover-letter': resumeService.buildCoverLetterPromptValues(profile(), 'Acme', 'Engineer'),
    'extract-template-from-pdf': resumeService.buildExtractTemplatePromptValues('PDF text', 'Imported'),
    'extract-profile-from-resume': resumeService.buildExtractProfilePromptValues('Resume text'),
  };

  for (const [feature, values] of Object.entries(supplied)) {
    assert.deepEqual(
      Object.keys(values).sort(),
      promptService.listPromptFeatureVariableNames(feature).sort(),
      `${feature}: the declared variables and the values its code builds have drifted apart`
    );
  }

  // The two lists are the code's own constants: the same text for any
  // posting, kept in the cacheable stable part.
  const { renderIndustryListForPrompt } = require('../dist/config/industries');
  const analysis = supplied['analyze-job-description'];
  assert.equal(analysis.industryList, renderIndustryListForPrompt());
  assert.equal(resumeService.buildAnalyzeJobDescriptionPromptValues('Another.', '').industryList, analysis.industryList);
  assert.deepEqual([...promptService.STABLE_PROMPT_VARIABLES].sort(), ['industryList', 'jobFieldList']);
  // Every value the analysis prompt is given before [[jobLink]] is stable.
  for (const name of Object.keys(analysis)) {
    if (name === 'jobLink' || name === 'jobDescription') continue;
    assert.ok(promptService.STABLE_PROMPT_VARIABLES.has(name), `${name} is the same for every posting`);
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
    missingVariables: ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout'],
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
      content: '[[profileJson]] [[includeStrengths]] [[technicalSkillsLayout]]',
    }),
    {
      usedVariables: ['profileJson', 'includeStrengths', 'technicalSkillsLayout'],
      unknownVariables: [],
      missingVariables: ['includeSoftSkills'],
    }
  );
  // An unattached prompt still declares its own.
  assert.deepEqual(
    (await promptService.validatePromptDraft({ content: '[[name]]', allowedVariables: [{ name: 'name' }] })).unknownVariables,
    []
  );
  assert.deepEqual((await promptService.validatePromptDraft({ content: '[[profileJson]]' })).unknownVariables, ['profileJson']);

  // The new variables are as good as the old ones.
  const saved = await promptService.updatePrompt('tailor-resume', { content: `Tailor.\n[[profileJson]]\n${SWITCHES}` });
  assert.deepEqual(saved.validation.unknownVariables, []);
  assert.deepEqual(saved.validation.missingVariables, []);
  assert.equal(saved.needsUpdate, undefined);
});

test('the shipped prompts validate clean against what their code supplies', async () => {
  seeded('shipped', { prompts: true });
  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  // Five features since the Job Filter's own prompt was retired into the
  // analysis (owner decision J8).
  assert.equal(prompts.length, 5);
  for (const prompt of prompts) {
    assert.deepEqual(prompt.validation.unknownVariables, [], `${prompt.id} names a variable nothing supplies`);
  }
  const tailor = prompts.find((prompt) => prompt.id === 'tailor-resume');
  for (const name of ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout']) {
    const variable = tailor.allowedVariables.find((entry) => entry.name === name);
    assert.ok(variable?.description, `${name} is documented for the editor`);
    assert.ok(variable.sampleValue, `${name} has a sample for previews`);
  }
  assert.equal(tailor.needsUpdate, undefined, 'the shipped text knows about the switches');
  assert.deepEqual(tailor.validation.missingVariables, []);
  assert.deepEqual(
    tailor.allowedVariables.filter((entry) => entry.required).map((entry) => entry.name),
    ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout'],
    'the editor is told which are required'
  );
  const analysis = prompts.find((prompt) => prompt.id === 'analyze-job-description');
  assert.equal(analysis.needsUpdate, undefined, 'the shipped analysis asks for a job field and an industry from the lists');
  assert.deepEqual(analysis.validation.missingVariables, []);
  assert.deepEqual(
    analysis.allowedVariables.filter((entry) => entry.required).map((entry) => entry.name),
    ['jobFieldList', 'industryList']
  );
  for (const prompt of prompts.filter((entry) => !['tailor-resume', 'analyze-job-description'].includes(entry.id))) {
    assert.equal(prompt.allowedVariables.some((entry) => entry.required), false, `${prompt.id} requires nothing`);
  }
  for (const name of ['jobFieldList', 'industryList', 'jobLink', 'jobDescription']) {
    assert.ok(analysis.validation.usedVariables.includes(name), `the shipped analysis prompt uses [[${name}]]`);
    assert.ok(analysis.allowedVariables.find((entry) => entry.name === name)?.description, `${name} is documented`);
  }

  const preview = await promptService.previewPrompt({ id: 'tailor-resume' });
  assert.equal(preview.sampleValues.includeStrengths, 'yes');
  assert.equal(preview.sampleValues.includeSoftSkills, 'no');
  assert.equal(preview.sampleValues.technicalSkillsLayout, 'grouped');
  assert.match(preview.renderedContent, /Strengths section: yes/);
  assert.doesNotMatch(preview.renderedContent, /\[\[/);
});

test('a save that leaves out a required variable is refused, naming it and the rule', async () => {
  const { staticDir } = seeded('required');
  writePrompt(staticDir, 'tailor-resume', `Tailor.\n[[profileJson]]\n${SWITCHES}`);
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobFieldList]]\n[[industryList]]\n[[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');

  await assert.rejects(
    () => promptService.updatePrompt('tailor-resume', { content: 'Tailor.\n[[profileJson]]\nStrengths: [[includeStrengths]]' }),
    (error) =>
      error.message ===
      'Missing required prompt variables: includeSoftSkills, technicalSkillsLayout. Every Tailor Resume prompt must use ' +
        '[[includeStrengths]], [[includeSoftSkills]] and [[technicalSkillsLayout]].'
  );
  await assert.rejects(
    () => promptService.createPrompt({ name: 'Old Variant', featureKey: 'tailor-resume', content: 'Old.\n[[profileJson]]' }),
    /Missing required prompt variables: includeStrengths, includeSoftSkills, technicalSkillsLayout\./
  );
  await assert.rejects(
    () => promptService.updatePrompt('analyze-job-description', { content: 'Analyze.\n[[jobFieldList]]\n[[jobDescription]]' }),
    (error) =>
      error.message ===
      'Missing required prompt variables: industryList. Every Analyze Job Description prompt must use ' +
        '[[jobFieldList]] and [[industryList]].'
  );
  // Nothing was stored by the refusals.
  const listed = new Map((await promptService.listPrompts()).map((prompt) => [prompt.id, prompt]));
  assert.match((await promptService.getPromptById('tailor-resume')).content, /Layout/);
  assert.equal([...listed.keys()].some((id) => id.startsWith('custom-')), false);

  // A feature with no required variables saves without them, and an unattached prompt has none.
  const extract = await promptService.createPrompt({
    name: 'Extract',
    featureKey: 'extract-profile-from-resume',
    content: 'Extract [[resumeText]]',
  });
  assert.deepEqual(extract.validation.missingVariables, []);
});

test('a stored record missing a required variable is marked, with the names, and only that', async () => {
  const { staticDir } = seeded('needs-update');
  writePrompt(staticDir, 'tailor-resume', `Tailor.\n[[profileJson]]\n${SWITCHES}`);
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
  assert.equal(listed.get('custom-tailor-resume-old').needsUpdate, true);
  assert.deepEqual(listed.get('custom-tailor-resume-old').validation.missingVariables, ['includeSoftSkills', 'technicalSkillsLayout']);
  assert.equal(listed.get('tailor-resume').needsUpdate, undefined);
  // The shipped analysis file here predates the industry: marked too.
  assert.equal(listed.get('analyze-job-description').needsUpdate, true);
  assert.deepEqual(listed.get('analyze-job-description').validation.missingVariables, ['industryList']);

  // Saved with the list, the mark goes; [[industryList]] is a variable it may use.
  const saved = await promptService.updatePrompt('analyze-job-description', {
    content: 'Analyze.\n[[jobFieldList]]\n[[industryList]]\nJob link: [[jobLink]]\n[[jobDescription]]',
  });
  assert.deepEqual(saved.validation.unknownVariables, []);
  assert.equal(saved.needsUpdate, undefined);
  const preview = await promptService.previewPrompt({ id: 'analyze-job-description' });
  assert.match(preview.renderedContent, /- healthcare: Healthcare/, 'the preview shows the real list');
  assert.doesNotMatch(preview.renderedContent, /\[\[/);
});

test('a record that needs updating is never run: the built-in prompt runs in its place, said once', async () => {
  const { staticDir } = seeded('needs-update-runtime');
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n${SWITCHES}`);
  writePrompt(staticDir, 'analyze-job-description', 'Shipped analysis.\n[[jobFieldList]]\n[[industryList]]\n[[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const at = '2026-01-01T00:00:00.000Z';
  // An administrator's edit of the built-in analysis that never names the industries,
  // and a tailoring variant that never names the switches - both stored before the rule.
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
      jobFieldList: 'FIELDS',
      industryList: 'INDUSTRIES',
      jobLink: '',
      jobDescription: 'A posting.',
    });
    assert.match(segments.map((segment) => segment.text).join(''), /^Shipped analysis\.\nFIELDS\nINDUSTRIES\nA posting\.$/);

    const variant = await promptService.resolvePromptByExactId('custom-tailor-resume-mine');
    assert.equal(variant.id, 'tailor-resume', 'the feature\'s built-in runs for the variant');
    assert.match(variant.content, /^Shipped tailoring/);
    await promptService.resolvePromptByExactId('custom-tailor-resume-mine');

    const said = (id) => warnings.filter((line) => line.includes(`(${id})`) && line.includes('runs instead'));
    assert.equal(said('analyze-job-description').length, 1, 'said once, however often it is asked');
    assert.match(said('analyze-job-description')[0], /does not use \[\[industryList\]\]/);
    assert.equal(said('custom-tailor-resume-mine').length, 1);
    assert.match(said('custom-tailor-resume-mine')[0], /\[\[includeStrengths\]\], \[\[includeSoftSkills\]\] and \[\[technicalSkillsLayout\]\]/);
  } finally {
    console.warn = realWarn;
  }

  // Admin -> Prompts still shows - and edits - the stored record as it is.
  assert.match((await promptService.getPromptById('analyze-job-description')).content, /^Edited/);
});

/* -------------------------------------------- the backstop, through a seat */

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
      return { text: answer, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));
  return requests;
}

const CHOICE = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'm', modelLabel: 'Stub' };

test('the switches are stated on every tailoring turn, whichever record runs', async () => {
  const { staticDir } = seeded('backstop');
  writePrompt(staticDir, 'tailor-resume', `Shipped tailoring.\n[[profileJson]]\n[[jobAnalysisJson]]\n${SWITCHES}`);
  const promptService = loadFresh('../dist/services/promptService');

  // An edit stored as the built-in's row, and a per-profile custom variant -
  // both naming the switches, and both telling the model to write strengths anyway.
  await promptService.updatePrompt('tailor-resume', {
    content: `My own tailoring prompt.\n[[profileJson]]\n[[jobAnalysisJson]]\n${SWITCHES}\nAlways write 2-4 strengths; they are the overflow bucket.`,
  });
  const custom = await promptService.createPrompt({
    name: 'Per Profile',
    featureKey: 'tailor-resume',
    content: `Per-profile prompt.\n[[profileJson]]\n${SWITCHES}\nWrite strengths and soft skills.`,
  });

  // A model that does what those prompts say, not what the profile says.
  const requests = stubSeat(
    JSON.stringify({
      summary: 'Engineer building services.',
      experience: [],
      hardSkills: ['Anything'],
      softSkills: ['Model Soft'],
      strengths: [{ title: 'Model strength', description: 'Written because the prompt asked.' }],
      coverLetter: 'I build.',
    })
  );
  const resumeService = loadFresh('../dist/services/resumeService');

  const off = await resumeService.tailorResume(profile(), ANALYSIS, CHOICE);
  assert.equal(requests.length, 1);
  assert.match(requests[0].userBody, /Strengths section: no\. Return "strengths": \[\]/);
  assert.match(requests[0].userBody, /Soft skills section: no/);
  assert.match(requests[0].userBody, /Technical skills layout: grouped/);
  // The edited row is what rendered: its opening line as the cacheable
  // instruction prefix, the rest with the data.
  assert.match(requests[0].stableSystem, /My own tailoring prompt/);
  assert.match(requests[0].userBody, /Always write 2-4 strengths/);
  assert.equal(requests[0].stableSystem.includes('Strengths section'), false, 'an instruction about the data, with the data');
  assert.deepEqual(off.strengths, [], 'and enforced on the answer, whatever the model sent');
  assert.deepEqual(off.softSkills, []);
  assert.deepEqual(off.unconfirmedSoftSkills, []);

  const on = await resumeService.tailorResume(
    profile({ includeStrengths: true, includeSoftSkills: true, technicalSkillsLayout: 'flat', resumePromptId: custom.id }),
    ANALYSIS,
    CHOICE
  );
  assert.equal(requests.length, 2);
  assert.match(requests[1].stableSystem, /Per-profile prompt/);
  assert.match(requests[1].userBody, /Strengths section: yes/);
  assert.match(requests[1].userBody, /Soft skills section: yes/);
  assert.match(requests[1].userBody, /Technical skills layout: plain/);
  assert.equal(on.strengths[0].title, 'Model strength');
  assert.equal(on.softSkills[0], 'Persistence', "the profile's own soft skills lead, not the model's");
  assert.equal(on.softSkills.includes('Model Soft'), false, 'a model-invented soft skill is not confirmed');
  assert.equal(on.hardSkills.includes('Anything'), false);
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

  // A save without the required switches is refused, naming them.
  const incomplete = await call('PUT', '/tailor-resume', { content: 'Tailor.\n[[profileJson]]\nStrengths: [[includeStrengths]]' });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error, /Missing required prompt variables: includeSoftSkills, technicalSkillsLayout\./);

  // An administrator's list says which text needs updating, and what it lacks.
  const listed = await call('GET', '/');
  const shippedRow = listed.body.find((prompt) => prompt.id === 'tailor-resume');
  assert.equal(shippedRow.needsUpdate, true);
  assert.deepEqual(shippedRow.validation.missingVariables, ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout']);
  const fixed = await call('PUT', '/tailor-resume', { content: `Tailor.\n[[profileJson]]\n${SWITCHES}` });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.needsUpdate, undefined);
});

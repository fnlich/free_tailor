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
 * tailoring call's `buildTailorResumePromptValues`, the job filter's
 * `buildJobFilterPromptValues` and so on. A variable outside that set cannot
 * be filled, so a record naming one fails every run that uses it. These pin:
 * the declared list and the builders never drift apart; a typo is refused when
 * a prompt is saved, not discovered when a resume fails; and a tailor-resume
 * record written before the section switches still obeys them.
 */

const shipped = path.join(__dirname, '..', 'static');

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
  const { buildJobFilterPromptValues } = loadFresh('../dist/services/jobFilter');

  const supplied = {
    'analyze-job-description': resumeService.buildAnalyzeJobDescriptionPromptValues('A posting.'),
    'tailor-resume': resumeService.buildTailorResumePromptValues(profile(), ANALYSIS),
    'generate-cover-letter': resumeService.buildCoverLetterPromptValues(profile(), 'Acme', 'Engineer'),
    'extract-template-from-pdf': resumeService.buildExtractTemplatePromptValues('PDF text', 'Imported'),
    'extract-profile-from-resume': resumeService.buildExtractProfilePromptValues('Resume text'),
    'filter-google-sheet-job': buildJobFilterPromptValues('Job page', 'https://jobs.example.com/1'),
  };

  for (const [feature, values] of Object.entries(supplied)) {
    assert.deepEqual(
      Object.keys(values).sort(),
      promptService.listPromptFeatureVariableNames(feature).sort(),
      `${feature}: the declared variables and the values its code builds have drifted apart`
    );
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
    { usedVariables: ['profileJson', 'includeStrengths', 'technicalSkillsLayout'], unknownVariables: [] }
  );
  // An unattached prompt still declares its own.
  assert.deepEqual(
    (await promptService.validatePromptDraft({ content: '[[name]]', allowedVariables: [{ name: 'name' }] })).unknownVariables,
    []
  );
  assert.deepEqual((await promptService.validatePromptDraft({ content: '[[profileJson]]' })).unknownVariables, ['profileJson']);

  // The new variables are as good as the old ones.
  const saved = await promptService.updatePrompt('tailor-resume', {
    content: 'Tailor.\n[[profileJson]]\nStrengths: [[includeStrengths]]. Soft: [[includeSoftSkills]]. Layout: [[technicalSkillsLayout]].',
  });
  assert.deepEqual(saved.validation.unknownVariables, []);
});

test('the shipped prompts validate clean against what their code supplies', async () => {
  seeded('shipped', { prompts: true });
  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  assert.equal(prompts.length, 6);
  for (const prompt of prompts) {
    assert.deepEqual(prompt.validation.unknownVariables, [], `${prompt.id} names a variable nothing supplies`);
  }
  const tailor = prompts.find((prompt) => prompt.id === 'tailor-resume');
  for (const name of ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout']) {
    const variable = tailor.allowedVariables.find((entry) => entry.name === name);
    assert.ok(variable?.description, `${name} is documented for the editor`);
    assert.ok(variable.sampleValue, `${name} has a sample for previews`);
  }
  assert.equal(tailor.predatesSectionSwitches, undefined, 'the shipped text knows about the switches');

  const preview = await promptService.previewPrompt({ id: 'tailor-resume' });
  assert.equal(preview.sampleValues.includeStrengths, 'yes');
  assert.equal(preview.sampleValues.includeSoftSkills, 'no');
  assert.equal(preview.sampleValues.technicalSkillsLayout, 'grouped');
  assert.match(preview.renderedContent, /Strengths section: yes/);
  assert.doesNotMatch(preview.renderedContent, /\[\[/);
});

test('a tailor-resume record written before the switches is marked, and only that', async () => {
  const { staticDir } = seeded('predates');
  writePrompt(staticDir, 'tailor-resume', 'Tailor.\n[[profileJson]]\nReturn 2-4 strengths.');
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobDescription]]');
  const promptService = loadFresh('../dist/services/promptService');

  const old = await promptService.createPrompt({ name: 'Old Variant', featureKey: 'tailor-resume', content: 'Old.\n[[profileJson]]' });
  const aware = await promptService.createPrompt({
    name: 'Aware Variant',
    featureKey: 'tailor-resume',
    content: 'New.\n[[profileJson]]\nStrengths: [[includeStrengths]]',
  });

  const listed = new Map((await promptService.listPrompts()).map((prompt) => [prompt.id, prompt]));
  assert.equal(listed.get('tailor-resume').predatesSectionSwitches, true);
  assert.equal(listed.get(old.id).predatesSectionSwitches, true);
  assert.equal(listed.get(aware.id).predatesSectionSwitches, undefined);
  assert.equal(listed.get('analyze-job-description').predatesSectionSwitches, undefined);
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

test('a prompt an administrator edited before the switches still obeys them', async () => {
  const { staticDir } = seeded('backstop');
  writePrompt(staticDir, 'tailor-resume', 'Tailor.\n[[profileJson]]\n[[jobAnalysisJson]]');
  const promptService = loadFresh('../dist/services/promptService');

  // An edit stored as the built-in's row, and a per-profile custom variant -
  // both written by an administrator who had never heard of the switches.
  await promptService.updatePrompt('tailor-resume', {
    content: 'My own tailoring prompt.\n[[profileJson]]\n[[jobAnalysisJson]]\nAlways write 2-4 strengths; they are the overflow bucket.',
  });
  const custom = await promptService.createPrompt({
    name: 'Per Profile',
    featureKey: 'tailor-resume',
    content: 'Per-profile prompt.\n[[profileJson]]\nWrite strengths and soft skills.',
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

  // An administrator's list says which tailor-resume text predates the switches.
  const listed = await call('GET', '/');
  assert.equal(listed.body.find((prompt) => prompt.id === 'tailor-resume').predatesSectionSwitches, true);
  const fixed = await call('PUT', '/tailor-resume', { content: 'Tailor.\n[[profileJson]]\nStrengths: [[includeStrengths]]' });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.predatesSectionSwitches, undefined);
});

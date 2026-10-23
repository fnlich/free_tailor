const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// The stub below stands in for the subscription seat. Set before any dist
// module loads: the settings defaults are computed at import.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * Partial and Fully tailor (owner's request, 2026-10-20), as the RUN's mode.
 *
 * A resume of titles and dates only came out with an empty Experience and an
 * empty Technical Skills: the tailoring was told to claim nothing the resume
 * does not say, and the resume said nothing. Now a run tailors in one of two
 * modes - Partial (its own text rewritten) or Fully (only each role's title,
 * company and dates sent, everything written for the posting, by its own
 * prompt) - and both prompts fill the skills block from the posting. The mode
 * is PASSED to the tailoring (v4.2: builder modes, F2); no resume carries one.
 * These pin what each mode sends, which prompt runs, how the revise pass and
 * the cover letter follow the mode, that the two never share a cached answer,
 * and that a stored `tailorMode` is read past. Which mode a run starts on
 * (`defaultBuildMode`) is the settings' tests.
 */

const shipped = path.join(__dirname, '..', 'static');
const MARKERS = '[[jobAnalysisJson]]\nHead the soft skills [[softSkillGroupHeading]].';

function seeded(name) {
  const storage = useTempStorage(`tailor-modes-${name}`);
  fs.cpSync(path.join(shipped, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  const write = (id, content) =>
    writeStaticJson(storage.staticDir, `prompts/${id}.json`, {
      id,
      content,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
  write('tailor-resume', `PARTIAL PROMPT.\n[[profileJson]]\n${MARKERS}`);
  write('tailor-resume-full', `FULLY PROMPT.\n[[profileJson]]\n${MARKERS}`);
  write('revise-resume-coverage', 'REVISE.\n[[draftJson]]\nMISSING [[missingTermsJson]]\nFIGURES [[figuresNote]]');
  write('generate-cover-letter', 'LETTER.\n[[profileJson]]\n[[companyName]] [[role]]');
  return storage;
}

const ANALYSIS = {
  jobMeta: { title: 'Backend Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Platform' },
  skills: { technical: ['TypeScript'], required: ['TypeScript'], preferred: [], tools: ['Docker'], soft: [], technologies: [] },
  technologies: ['TypeScript'],
  protocols: [],
  methodologies: [],
  architecturePatterns: [],
  responsibilities: ['backend service development'],
  domainKnowledge: [],
  softSkills: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  sourceJobDescription: 'Backend Engineer: TypeScript services shipped with Docker.',
};

function resumeRecord(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'Jane',
    title: 'Software Engineer',
    totalYearsExperience: 6,
    contact: { email: 'jane@example.com', phone: '555-0100' },
    summary: 'Backend engineer who writes TypeScript services.',
    experience: [
      {
        title: 'Staff Software Engineer',
        company: 'Amplitude',
        startDate: '01/2022',
        endDate: 'Present',
        location: 'San Francisco',
        description: 'Owned the TypeScript ingestion services. Cut deploys from 40 minutes to 6.',
        achievements: ['Moved the ingestion service to TypeScript, cutting p99 from 900ms to 300ms.'],
        skills: ['TypeScript', 'Kafka'],
      },
      {
        title: 'Software Engineer',
        company: 'Chalk',
        startDate: '06/2019',
        endDate: '12/2021',
        location: 'Remote',
        description: '',
        achievements: [],
        skills: [],
      },
    ],
    strengths: [],
    skills: ['TypeScript'],
    softSkills: [],
    education: [{ degree: 'BS Computer Science', institution: 'MIT' }],
    certifications: [],
    resumeSettings: settings,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

/** A seat that answers every tailoring with `answer`, and every revise pass with no change. */
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

const CHOICE = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'm', modelLabel: 'Stub' };

/** What the model wrote for a bare resume: two roles, bullets for both, the posting's skills. */
const ANSWER = JSON.stringify({
  title: 'Software Engineer',
  summary: 'Six years of backend work in TypeScript services.',
  experience: [
    {
      title: 'Staff Software Engineer',
      company: 'Amplitude',
      startDate: '01/2022',
      endDate: 'Present',
      location: '',
      description: '',
      achievements: ['Rebuilt the event ingestion service in TypeScript for a team of 5.'],
    },
    {
      title: 'Software Engineer',
      company: 'Chalk',
      startDate: '06/2019',
      endDate: '12/2021',
      location: '',
      description: '',
      achievements: ['Wrote the feature store API in TypeScript.'],
    },
  ],
  skillGroups: [{ category: 'Languages & Tools', skills: ['TypeScript', 'Docker', 'Kafka'] }],
  coverLetter: 'I build backend services.',
});

const tailorings = (requests) => requests.filter((request) => request.callSite === 'tailor-resume');
const revisions = (requests) => requests.filter((request) => request.callSite === 'revise-resume-coverage');
const sent = (request) => `${request.stableSystem ?? ''}\n${request.userBody ?? ''}`;

/* ------------------------------------------------------- what is sent */

test('Fully tailor sends each role as its title, company and dates, and no summary; Partial sends the rest', () => {
  seeded('projection');
  const resumeService = loadFresh('../dist/services/resumeService');

  const partial = resumeService.buildTailorResumePromptValues(resumeRecord(), ANALYSIS, 'partial');
  const full = resumeService.buildTailorResumePromptValues(resumeRecord(), ANALYSIS, 'full');
  assert.deepEqual(Object.keys(full).sort(), Object.keys(partial).sort(), 'the same variables either way');
  for (const key of Object.keys(partial)) {
    if (key !== 'profileJson') assert.equal(full[key], partial[key], `${key} does not depend on the mode`);
  }

  const shownPartial = JSON.parse(partial.profileJson);
  const shownFull = JSON.parse(full.profileJson);
  assert.equal(shownPartial.summary, 'Backend engineer who writes TypeScript services.');
  assert.equal('summary' in shownFull, false, 'Fully writes the summary: the resume\'s is not sent');
  assert.deepEqual(shownFull.experience, [
    { title: 'Staff Software Engineer', company: 'Amplitude', startDate: '01/2022', endDate: 'Present' },
    { title: 'Software Engineer', company: 'Chalk', startDate: '06/2019', endDate: '12/2021' },
  ]);
  assert.deepEqual(shownPartial.experience[0].achievements, resumeRecord().experience[0].achievements);
  assert.match(shownPartial.experience[0].companyContext, /ingestion services/);
  assert.deepEqual(shownPartial.experience[0].skills, ['TypeScript', 'Kafka']);
  // Everything else is the same in both, and contact details are in neither.
  for (const key of ['name', 'title', 'totalYearsExperience', 'skills', 'education', 'certifications']) {
    assert.deepEqual(shownFull[key], shownPartial[key], key);
  }
  assert.doesNotMatch(full.profileJson, /jane@example\.com|555-0100|Cut deploys/);

  // With no mode named it is Partial, and a resume's own (old, stored)
  // `tailorMode` is not read: the mode is the run's.
  assert.equal(
    resumeService.buildTailorResumePromptValues(resumeRecord({ tailorMode: 'full' }), ANALYSIS).profileJson,
    partial.profileJson
  );
  assert.equal(resumeService.buildTailorResumePromptValues(resumeRecord(), ANALYSIS).profileJson, partial.profileJson);
});

test('a stored tailorMode is read past and dropped by the next save; no resume reader exists any more', () => {
  seeded('stored-mode');
  const resumeDocument = loadFresh('../dist/services/resumeDocument');
  assert.equal(resumeDocument.getResumeTailorMode, undefined, 'the per-resume reader is gone');
  assert.equal(resumeDocument.isTailorMode, undefined);

  // Sent or stored, a mode never survives a normalise (the next save drops it).
  assert.equal('tailorMode' in resumeDocument.normalizeResumeSettings({ tailorMode: 'full' }), false);
  assert.equal('tailorMode' in resumeDocument.normalizeResumeSettings({}, { tailorMode: 'full' }), false);
  assert.equal('tailorMode' in resumeDocument.normalizeResumeSettings({ tailorMode: null }, { tailorMode: 'partial' }), false);

  // DEFAULT_TAILOR_MODE no longer decides how a resume is tailored: only the
  // mode passed to the tailoring does.
  const saved = process.env.DEFAULT_TAILOR_MODE;
  process.env.DEFAULT_TAILOR_MODE = 'full';
  try {
    const resumeService = loadFresh('../dist/services/resumeService');
    const shown = JSON.parse(resumeService.buildTailorResumePromptValues(resumeRecord(), ANALYSIS).profileJson);
    assert.equal(shown.summary, 'Backend engineer who writes TypeScript services.', 'still Partial');
    const cover = JSON.parse(resumeService.buildCoverLetterPromptValues(resumeRecord(), 'Acme', 'Engineer').profileJson);
    assert.equal(cover.summary, 'Backend engineer who writes TypeScript services.');
  } finally {
    if (saved === undefined) delete process.env.DEFAULT_TAILOR_MODE;
    else process.env.DEFAULT_TAILOR_MODE = saved;
  }
});

/* ----------------------------------------------------- which prompt runs */

test('a Fully run uses Tailor Resume (Fully) whatever the resume\'s Building prompt; a Partial one runs its own', async () => {
  seeded('which-prompt');
  const promptService = loadFresh('../dist/services/promptService');
  const custom = await promptService.createPrompt({
    name: 'Mine',
    featureKey: 'tailor-resume',
    content: `MY VARIANT.\n[[profileJson]]\n${MARKERS}`,
  });
  const requests = stubSeat(ANSWER);
  const resumeService = loadFresh('../dist/services/resumeService');

  const quiet = console.log;
  console.log = () => {};
  try {
    await resumeService.tailorResume(resumeRecord({ resumePromptId: custom.id }), ANALYSIS, CHOICE, 'partial');
    await resumeService.tailorResume(resumeRecord({ resumePromptId: custom.id }), ANALYSIS, CHOICE, 'full');
    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  } finally {
    console.log = quiet;
  }
  const [mine, fully, builtIn] = tailorings(requests);
  assert.match(sent(mine), /MY VARIANT/);
  assert.match(sent(fully), /FULLY PROMPT/);
  assert.doesNotMatch(sent(fully), /MY VARIANT|PARTIAL PROMPT/);
  assert.doesNotMatch(sent(fully), /Cut deploys|Moved the ingestion service|Backend engineer who writes/);
  assert.match(sent(builtIn), /PARTIAL PROMPT/);
});

test('a bare resume prints what the model wrote: every role\'s bullets and the posting\'s skills', async () => {
  seeded('bare');
  stubSeat(ANSWER);
  const resumeService = loadFresh('../dist/services/resumeService');
  const bare = resumeRecord(
    {},
    {
      summary: '',
      skills: [],
      experience: resumeRecord().experience.map((role) => ({ ...role, description: '', achievements: [], skills: [] })),
    }
  );
  const quiet = console.log;
  console.log = () => {};
  let content;
  try {
    content = await resumeService.tailorResume(bare, ANALYSIS, CHOICE, 'full');
  } finally {
    console.log = quiet;
  }
  // The roles' facts are the resume's - location included, which Fully never sent.
  assert.deepEqual(
    content.experience.map((role) => [role.company, role.title, role.location, role.achievements.length]),
    [
      ['Amplitude', 'Staff Software Engineer', 'San Francisco', 1],
      ['Chalk', 'Software Engineer', 'Remote', 1],
    ]
  );
  assert.deepEqual(content.skillGroups.map((group) => group.skills), [['TypeScript', 'Docker', 'Kafka']]);
  assert.deepEqual(content.hardSkills, ['TypeScript', 'Docker', 'Kafka']);
  // The model's, with the span of years written as a numeral (the parse's backstop).
  assert.equal(content.summary, '6 years of backend work in TypeScript services.');
});

/* ------------------------------------------------------- the revise pass */

test('after a Fully tailored draft the revise pass asks for every checklist term it lacks, and for no figure', async () => {
  seeded('revise');
  // A draft that carries TypeScript but not Docker - which the resume never names.
  const draft = JSON.parse(ANSWER);
  const requests = stubSeat(JSON.stringify(draft));
  const resumeService = loadFresh('../dist/services/resumeService');
  const quiet = console.log;
  console.log = () => {};
  try {
    // Partial: Docker is not the resume's, so it is not asked for; the
    // resume's own figures the draft dropped are.
    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
    const [partialRevision] = revisions(requests);
    assert.ok(partialRevision, 'the dropped figures alone call for a revision');
    assert.doesNotMatch(sent(partialRevision), /MISSING \[[^\]]*"Docker"/);
    assert.match(sent(partialRevision), /FIGURES FIGURES THE PROFILE STATES AND THE DRAFT DROPPED/);
    assert.match(sent(partialRevision), /40 minutes to 6/);

    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'full');
    const fullRevision = revisions(requests)[1];
    assert.ok(fullRevision);
    assert.match(sent(fullRevision), /MISSING \[[^\]]*"Docker"/);
    assert.doesNotMatch(sent(fullRevision), /FIGURES THE PROFILE STATES|40 minutes to 6|900ms/);
  } finally {
    console.log = quiet;
  }
});

/* ----------------------------------------------------------- the cache */

test('Partial and Fully never share a cached tailoring, and each is reused for itself', async () => {
  seeded('cache');
  const requests = stubSeat(ANSWER);
  const resumeService = loadFresh('../dist/services/resumeService');
  const cache = { analysisId: 'analysis-1', templateId: 'default' };
  const quiet = console.log;
  console.log = () => {};
  try {
    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, cache);
    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'full', undefined, cache);
    assert.equal(tailorings(requests).length, 2, 'switching the mode is a miss');
    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, cache);
    await resumeService.tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'full', undefined, cache);
    assert.equal(tailorings(requests).length, 2, 'and switching back is a hit, for both');
  } finally {
    console.log = quiet;
  }
});

/* ------------------------------------------------------- the cover letter */

test('a cover letter written beside a tailored resume is told what that resume says', () => {
  seeded('letter');
  const resumeService = loadFresh('../dist/services/resumeService');
  const resume = {
    summary: 'Six years of backend work.',
    experience: [
      { company: 'Amplitude', title: 'Staff Software Engineer', achievements: ['Rebuilt the ingestion service.'] },
    ],
  };

  // With no tailored resume the resume printed is the source's own text, so
  // the letter is told it - whatever the mode: Fully's titles and dates alone
  // would leave it nothing to write about.
  const untailored = JSON.parse(
    resumeService.buildCoverLetterPromptValues(resumeRecord(), 'Acme', 'Engineer', undefined, 'full').profileJson
  );
  assert.equal(untailored.summary, 'Backend engineer who writes TypeScript services.');
  assert.deepEqual(untailored.experience[0].achievements, resumeRecord().experience[0].achievements);

  const told = JSON.parse(
    resumeService.buildCoverLetterPromptValues(resumeRecord(), 'Acme', 'Engineer', resume, 'full').profileJson
  );
  assert.equal(told.summary, 'Six years of backend work.');
  assert.deepEqual(told.experience.map((role) => role.achievements), [['Rebuilt the ingestion service.'], []]);

  // Partial: the resume's lines replace the source's own, and the company
  // sentence the tailoring was shown goes with them.
  const partial = JSON.parse(resumeService.buildCoverLetterPromptValues(resumeRecord(), 'Acme', 'Engineer', resume).profileJson);
  assert.deepEqual(partial.experience[0].achievements, ['Rebuilt the ingestion service.']);
  assert.equal('companyContext' in partial.experience[0], false);
  assert.equal(partial.experience[0].location, 'San Francisco');

  // Two stints at one company under one title keep their own bullets: the
  // resume's roles carry the source's own dates, and those decide.
  const twice = resumeRecord({}, {
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '01/2023', endDate: 'Present', description: '', achievements: [], skills: [] },
      { title: 'Engineer', company: 'Acme', startDate: '01/2018', endDate: '12/2019', description: '', achievements: [], skills: [] },
    ],
  });
  const stints = JSON.parse(
    resumeService.buildCoverLetterPromptValues(twice, 'Beta', 'Engineer', {
      summary: 'S.',
      experience: [
        { company: 'Acme', title: 'Engineer', startDate: '01/2018', endDate: '12/2019', achievements: ['The first stint.'] },
        { company: 'Acme', title: 'Engineer', startDate: '01/2023', endDate: 'Present', achievements: ['The second stint.'] },
      ],
    }).profileJson
  );
  assert.deepEqual(stints.experience.map((role) => role.achievements), [['The second stint.'], ['The first stint.']]);
});

test('the span of experience is worked out from the role dates when the resume states none', () => {
  seeded('years');
  const resumeService = loadFresh('../dist/services/resumeService');
  const years = (extra) =>
    JSON.parse(resumeService.buildTailorResumePromptValues(resumeRecord({}, extra), ANALYSIS).profileJson).totalYearsExperience;

  assert.equal(years({}), 6, "the resume's own figure wins");
  const dated = [
    { title: 'B', company: 'Y', startDate: '03/2018', endDate: '05/2022', description: '', achievements: [], skills: [] },
    { title: 'A', company: 'X', startDate: 'Mar 2015', endDate: 'Feb 2018', description: '', achievements: [], skills: [] },
  ];
  assert.equal(years({ totalYearsExperience: undefined, experience: dated }), 7, 'March 2015 to May 2022: 7 whole years');
  const now = new Date();
  const toNow = (now.getFullYear() * 12 + now.getMonth() - 2020 * 12 - ((now.getFullYear() * 12 + now.getMonth() - 2020 * 12) % 12)) / 12;
  assert.equal(
    years({ totalYearsExperience: undefined, experience: [{ ...dated[0], startDate: '2020', endDate: 'Present' }] }),
    toNow,
    '"Present" is today'
  );
  assert.equal(
    years({ totalYearsExperience: undefined, experience: [{ ...dated[0], startDate: '01/2025', endDate: '06/2025' }] }),
    undefined,
    'under a year says nothing'
  );
  assert.equal(years({ totalYearsExperience: undefined, experience: [{ ...dated[0], startDate: '', endDate: '' }] }), undefined);
});

test("the posting's action verbs reach the model without the openers the prompts ban", () => {
  seeded('verbs');
  const resumeService = loadFresh('../dist/services/resumeService');
  const analysis = { ...ANALYSIS, keywords: { actionVerbs: ['Architected', 'Built', 'Led', 'migrated'], buzzwords: [], mustInclude: [] } };
  const sent = JSON.parse(resumeService.buildTailorResumePromptValues(resumeRecord(), analysis).jobAnalysisJson);
  assert.deepEqual(sent.keywords.actionVerbs, ['Built', 'migrated']);
});

/* ------------------------------------------------- the queued task's mode */

/**
 * The task runs the RUN's mode (`payload.buildMode`): Choose Suitable Resume
 * never tailors, Partial and Fully call the tailoring with their own mode and
 * hand it on to the cover letter, and a task queued before v4.2 (no mode)
 * builds Partial. Everything that would print a file or ask a model is stubbed
 * at its module export, as queuedRole.test.js does.
 */
function stubTask(storage) {
  fs.mkdirSync(path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.copyFileSync(
    path.join(shipped, 'templates', 'default.json'),
    path.join(storage.staticDir, 'templates', 'default.json')
  );
  const resumeService = require('../dist/services/resumeService');
  const gate = require('../dist/services/jobAnalysis/gate');
  const generatedPath = require('../dist/utils/generatedPath');
  const coverLetters = require('../dist/generators/coverLetterGenerator');
  const pdfGenerator = require('../dist/generators/pdfGenerator');
  const docxGenerator = require('../dist/generators/docxGenerator');
  const seen = { tailorings: [], letters: [], rendered: [] };
  const originals = [];
  const swap = (module, name, fake) => {
    originals.push([module, name, module[name]]);
    module[name] = fake;
  };
  swap(gate, 'loadAnalysis', (id) => (id === 'stored-analysis' ? { id, analysis: ANALYSIS } : null));
  swap(resumeService, 'tailorResume', async (_resume, _analysis, _choice, mode) => {
    seen.tailorings.push(mode);
    return { summary: 's', experience: [], coverLetter: '' };
  });
  swap(resumeService, 'generateCoverLetter', async (_resume, _company, _role, _choice, _signal, _cache, tailored, mode) => {
    seen.letters.push({ tailored: Boolean(tailored), mode });
    return 'Dear team';
  });
  swap(generatedPath, 'getGeneratedOutputPath', async () => ({ storagePathBase: 'x', absoluteDir: storage.rootDir }));
  swap(coverLetters, 'saveCoverLetter', async () => 'x/cover.pdf');
  swap(coverLetters, 'saveCoverLetterDOCX', async () => 'x/cover.docx');
  swap(pdfGenerator, 'generateResumePDF', async (_resume, _template, content) => {
    seen.rendered.push(content === undefined ? 'as written' : 'tailored');
    return 'x/resume.pdf';
  });
  swap(docxGenerator, 'generateResumeDOCX', async () => 'x/resume.docx');
  return {
    seen,
    restore: () => {
      for (const [module, name, original] of originals.reverse()) module[name] = original;
    },
  };
}

const TASK_JOB = { companyName: 'Acme', role: 'Backend Engineer', jobDescription: 'x' };

test('Choose Suitable Resume never tailors: the resume prints as written and only the cover letter is asked for', async () => {
  const storage = seeded('task-suitable');
  const stubs = stubTask(storage);
  try {
    const { runResumeTask } = loadFresh('../dist/services/queue/resumeTask');
    const result = await runResumeTask(
      {
        resume: resumeRecord(),
        job: { ...TASK_JOB },
        format: 'pdf',
        includeCoverLetterDocx: false,
        choice: CHOICE,
        buildMode: 'suitable',
        analysisId: 'stored-analysis',
      },
      { signal: new AbortController().signal }
    );
    assert.deepEqual(stubs.seen.tailorings, [], 'no tailoring call');
    assert.deepEqual(stubs.seen.letters, [{ tailored: false, mode: 'partial' }], 'one cover letter, the untailored projection');
    assert.deepEqual(stubs.seen.rendered, ['as written']);
    assert.equal(result.tailored, false);
  } finally {
    stubs.restore();
  }
});

test('Partial and Fully call the tailoring with their own mode; a task with no mode is Partial', async () => {
  const storage = seeded('task-modes');
  const stubs = stubTask(storage);
  try {
    const { runResumeTask, makeResumeRunner } = loadFresh('../dist/services/queue/resumeTask');
    const input = (buildMode) => ({
      resume: resumeRecord(),
      job: { ...TASK_JOB },
      format: 'pdf',
      includeCoverLetterDocx: false,
      choice: CHOICE,
      analysisId: 'stored-analysis',
      ...(buildMode ? { buildMode } : {}),
    });
    const assignment = { signal: new AbortController().signal, queue: 'claude-cli' };

    const full = await runResumeTask(input('full'), assignment);
    assert.equal(full.tailored, true);
    await runResumeTask(input('partial'), assignment);
    await runResumeTask(input(undefined), assignment);
    assert.deepEqual(stubs.seen.tailorings, ['full', 'partial', 'partial']);
    // The tailoring brought no letter, so each fell to the letter call, in the run's mode.
    assert.deepEqual(stubs.seen.letters.map((letter) => letter.mode), ['full', 'partial', 'partial']);
    assert.ok(stubs.seen.letters.every((letter) => letter.tailored));
    assert.deepEqual(stubs.seen.rendered, ['tailored', 'tailored', 'tailored']);

    // The queue's runner reads the payload's mode, and a restored pre-v4.2 payload has none.
    stubs.seen.tailorings.length = 0;
    const runner = makeResumeRunner(
      () => [{ ...TASK_JOB }],
      () => resumeRecord()
    );
    const payload = { batchId: 'b', resumeId: 'p1', jobIndex: 0, format: 'pdf', includeCoverLetterDocx: false, choice: CHOICE, analysisId: 'stored-analysis' };
    await runner({ ...payload, buildMode: 'full' }, assignment);
    await runner(payload, assignment);
    assert.deepEqual(stubs.seen.tailorings, ['full', 'partial']);
  } finally {
    stubs.restore();
  }
});

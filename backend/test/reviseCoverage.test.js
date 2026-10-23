const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub. Before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { freshInstall, posting, serveInstall, untilFinished } = require('./analysisHarness');

/**
 * The revise pass (`revise-resume-coverage`): after a fresh tailoring, a
 * second call on the model the resume is charged at puts back the checklist
 * terms the draft left out that the resume's own words carry - and the
 * resume's figures the draft dropped - "changing as little as possible".
 *
 * Pinned here: when it runs and what it is told (the missing terms in
 * priority order, only those the resume names, never one carrying a banned
 * word, at most TAILOR_REVISE_MAX_TERMS; the resume's own lines whose
 * figures the draft no longer shows, and never a request for a figure of the
 * model's making), how its answer is folded in (only the summary and whole
 * roles' bullets, matched by company and title), that a failure leaves the
 * draft as the resume and an abort is passed on, and that it never runs on a
 * cached tailoring or on content a page sent back - and that the cache keeps
 * the revised resume, never a revision a fallback model wrote.
 *
 * Modules are required once and shared, as the analysis harness asks.
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const revise = require('../dist/services/reviseCoverage');
const { tailorResume } = require('../dist/services/resumeService');
const repository = require('../dist/database/tailorCacheRepository');

const CHOICE = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'claude-cli-sonnet', modelLabel: 'Sonnet' };

/** A posting whose checklist is short: Python, Kafka, Docker, microservices, Ownership, built. */
const ANALYSIS = {
  jobMeta: { title: 'Backend Engineer', seniority: 'senior', industry: 'SaaS', department: 'engineering' },
  skills: { technical: [], required: [], preferred: [], tools: ['Docker'], soft: ['Ownership'], technologies: [] },
  technologies: ['Python', 'Kafka'],
  protocols: [],
  methodologies: [],
  architecturePatterns: ['microservices'],
  responsibilities: ['backend service delivery'],
  domainKnowledge: ['payments'],
  softSkills: [],
  keywords: { actionVerbs: ['built', 'leveraged'], buzzwords: ['scalable systems'], mustInclude: [] },
  jobField: 'backend',
  salary: null,
  filter: {},
  sourceJobDescription: 'Requirements: Python and Kafka. Docker. Microservices. Ownership. Payments.',
};

/**
 * A resume whose own words carry every term of that checklist - the revise
 * pass is asked only for those - and whose bullets carry no figure, so no
 * figure of hers can be dropped unless a test gives her one.
 */
function resumeRecord(extra = {}) {
  return {
    id: 'p-revise',
    name: 'Ada',
    title: 'Backend Engineer',
    summary: 'Built Python microservices on Kafka and Docker, with ownership of the payment flows.',
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'Remote', description: '', achievements: ['Her own bullet.'], skills: [] },
      { title: 'Engineer', company: 'Beta', startDate: '2017', endDate: '2019', location: 'Berlin', description: '', achievements: ['Her older bullet.'], skills: [] },
    ],
    skills: ['Python', 'Kafka', 'Docker'],
    strengths: [],
    softSkills: [],
    education: [],
    resumeSettings: {},
    ...extra,
  };
}

const FIGURED = [
  'Built 4 Python services for 30 teams.',
  'Cut deploys from 40 minutes to 6.',
  'Moved 12 queues to Kafka.',
  'Ran 3 Docker registries.',
  'Answered 200 pages a year.',
];

/** A tailoring that carries every checklist term, and no figure of the resume's to drop: nothing for a revision to do. */
function completeDraft(extra = {}) {
  return JSON.stringify({
    title: 'Backend Engineer',
    summary: 'Ownership of microservices built in Python with Kafka and Docker.',
    experience: [
      { title: 'Engineer', company: 'Acme', achievements: FIGURED.slice(0, 3) },
      { title: 'Engineer', company: 'Beta', achievements: FIGURED.slice(3) },
    ],
    skillGroups: [{ category: 'Languages', skills: ['Python'] }],
    coverLetter: 'I build things.',
    ...extra,
  });
}

/**
 * A Claude seat answering the tailoring with `tailor()` and the revision
 * with `revision()` (either may throw, or answer a whole result); every
 * request is kept.
 */
function seat({ tailor = () => completeDraft(), revision = () => '{}' } = {}) {
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
      const answer = request.callSite === 'revise-resume-coverage' ? await revision(request) : await tailor(request);
      const result = typeof answer === 'string' ? { text: answer } : answer;
      return { resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1, ...result };
    },
  }));
  const bySite = (site) => requests.filter((request) => request.callSite === site);
  return { requests, tailorings: () => bySite('tailor-resume'), revisions: () => bySite('revise-resume-coverage') };
}

/** Every revised line prints as written. */
const printsAll = () => true;

/** The variable values a revise request rendered, read back off its user turn. */
function told(request) {
  return request.userBody;
}

function install(name) {
  freshInstall(`revise-${name}`);
  config.invalidateSettingsCache();
}

async function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function quietly(run) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return Promise.resolve(run()).finally(() => {
    console.warn = warn;
  }).then((value) => ({ value, warnings }));
}

/* ============================================================ the measures */

test('missing terms: the checklist in its priority order, word for word, never one with a banned word, at most the cap', () => {
  const draft = { summary: 'We run python services.', experience: [{ company: 'A', title: 'B', achievements: ['Moved queues to Kafka.'] }] };
  const checklist = ['Python', 'Kafka', 'Docker', 'scalable systems', 'Managed services', 'microservices', 'Ownership'];
  // Python is there in another case; "scalable" and "Managed" are banned words
  // the revise prompt may not write, so they are never asked for.
  assert.deepEqual(revise.missingTerms(draft, checklist, 30), ['Docker', 'microservices', 'Ownership']);
  assert.deepEqual(revise.missingTerms(draft, checklist, 2), ['Docker', 'microservices']);
  // A whole word: "Docker" is not in "Dockerfile".
  assert.deepEqual(revise.missingTerms({ summary: 'Wrote a Dockerfile.', experience: [] }, ['Docker'], 30), ['Docker']);
});

test('figures: a number not glued to a letter; S3, EC2, p99 and OAuth2 are names', () => {
  for (const text of ['Cut it by 37%.', 'Took 40 minutes.', 'Ingested 2B+ events.', 'From 9s to 1.4s.']) {
    assert.equal(revise.hasFigure(text), true, text);
  }
  for (const text of ['Moved files to S3.', 'Ran EC2 hosts.', 'Watched p99 latency.', 'Added OAuth2.', 'Shipped v1.2.']) {
    assert.equal(revise.hasFigure(text), false, text);
  }
  // Its figures as digits: separators dropped, decimals kept, a year left out.
  assert.deepEqual(
    revise.figureTokens('Cut deploys from 40 minutes to 6 for 1,200 users, a $5M book and 9.5s pages, in 2019.'),
    ['40', '6', '1200', '5', '9.5']
  );
  assert.deepEqual(revise.figureTokens('Ran EC2, S3 and p99 checks on v1.2.'), []);
});

test("the figures the draft dropped are the source's own lines, each under its role - never a figure it never stated", () => {
  const resume = {
    experience: [
      {
        company: 'Acme',
        title: 'Engineer',
        description: 'Owned billing. Served 2M users a day.',
        achievements: ['Cut deploys from 40 minutes to 6.', 'Wrote the runbooks.', 'Moved 12 queues to Kafka.'],
      },
      { company: 'Beta', title: 'Lead', description: '', achievements: ['Mentored 3 engineers.'] },
    ],
  };
  const draft = {
    summary: 'Engineer.',
    experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Moved 12 queues to Kafka.', 'Cut deploys to a 6-minute run.'] }],
  };
  // A line counts as dropped while ANY of its figures is gone - the 40 here.
  assert.deepEqual(revise.droppedResumeFigures(resume, draft), [
    { company: 'Acme', title: 'Engineer', line: 'Cut deploys from 40 minutes to 6.' },
    { company: 'Acme', title: 'Engineer', line: 'Served 2M users a day.' },
    { company: 'Beta', title: 'Lead', line: 'Mentored 3 engineers.' },
  ]);
  // Carried anywhere on the page, in any spelling of its digits, is carried.
  assert.deepEqual(
    revise.droppedResumeFigures(resume, { summary: '40-minute deploys cut to 6, 2M users, 3 engineers, 12 queues.', experience: [] }),
    []
  );
  assert.equal(revise.droppedResumeFigures(resume, { summary: '', experience: [] }, 2).length, 2, 'at most the cap');
  // A resume that states no figure has none to drop, whatever the draft says.
  const plain = { experience: [{ company: 'A', title: 'B', description: 'Owned it.', achievements: ['Wrote it.'] }] };
  assert.deepEqual(revise.droppedResumeFigures(plain, { summary: '', experience: [] }), []);
  assert.deepEqual(revise.droppedResumeFigures({}, { summary: '', experience: [] }), []);

  const values = revise.buildReviseResumeCoveragePromptValues(
    { summary: 'S.', experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Fixed bugs.', 'Wrote 3 tools.'], startDate: '2020' }] },
    ['Docker'],
    [{ company: 'Acme', title: 'Engineer', line: 'Cut deploys from 40 minutes to 6.' }]
  );
  assert.deepEqual(Object.keys(values).sort(), ['draftJson', 'figuresNote', 'missingTermsJson']);
  // Each role carries its dates, for the revise prompt's years rule; a date
  // the role has none of is simply absent.
  assert.deepEqual(JSON.parse(values.draftJson), {
    summary: 'S.',
    experience: [{ company: 'Acme', title: 'Engineer', startDate: '2020', achievements: ['Fixed bugs.', 'Wrote 3 tools.'] }],
  });
  assert.equal(values.missingTermsJson, '["Docker"]');
  assert.equal(
    values.figuresNote,
    "FIGURES THE PROFILE STATES AND THE DRAFT DROPPED. Each line below is the candidate's own, from the role named " +
      'before it, and carries a figure the draft no longer shows. Where a bullet of that role describes the same piece ' +
      'of work, put the figure back into it exactly as the line states it; where no bullet describes that work, add ' +
      'nothing. Never a figure these lines do not state, and never one in the summary.\n' +
      '- Acme, Engineer: Cut deploys from 40 minutes to 6.'
  );
  // The note never asks for a figure of the model's own making.
  assert.doesNotMatch(values.figuresNote, /modest|implies|at least five/);
  // A line from a role with neither company nor title is listed bare.
  assert.ok(
    revise
      .buildReviseResumeCoveragePromptValues({ summary: '', experience: [] }, [], [{ company: '', title: '', line: 'Cut it by 4.' }])
      .figuresNote.endsWith('add nothing. Never a figure these lines do not state, and never one in the summary.\n- Cut it by 4.')
  );
  assert.equal(revise.buildReviseResumeCoveragePromptValues({ summary: '', experience: [] }, [], []).figuresNote, '');
  assert.equal(revise.revisionWanted([], []), false);
  assert.equal(revise.revisionWanted(['Docker'], []), true);
  assert.equal(revise.revisionWanted([], [{ company: 'A', title: 'B', line: 'Cut it by 4.' }]), true);
});

test("only the checklist terms the source's own words carry are ever asked for - never a company's name", () => {
  const evidence = revise.resumeEvidence({
    title: 'Backend Engineer',
    summary: 'Builds payment services.',
    skills: ['Python', 'Kafka'],
    skillCategories: [{ category: 'Cloud', skills: ['AWS'] }],
    softSkills: ['Ownership'],
    strengths: [{ title: 'Incident response', description: 'Ran the pager.' }],
    experience: [
      {
        company: 'Stripe',
        title: 'Engineer',
        description: 'Moved services to microservices.',
        achievements: ['Shipped Docker images.'],
        skills: ['Terraform'],
      },
    ],
    certifications: [{ name: 'CKA', issuer: 'CNCF' }],
    projects: [{ name: 'Ledger', role: 'Go', description: '', achievements: ['Wrote it in Rust.'] }],
  });
  assert.deepEqual(
    revise.supportedTerms(
      ['Python', 'Kafka', 'AWS', 'Ownership', 'Incident response', 'microservices', 'Docker', 'Terraform', 'CKA', 'Go', 'Rust', 'Stripe', 'Kubernetes', 'GraphQL', 'go'],
      evidence
    ),
    ['Python', 'Kafka', 'AWS', 'Ownership', 'Incident response', 'microservices', 'Docker', 'Terraform', 'CKA', 'Go', 'Rust']
  );
  assert.deepEqual(revise.supportedTerms(['Python'], revise.resumeEvidence({})), []);
});

test('the merge reads the summary and whole roles, matched by company and title - nothing else', () => {
  const draft = {
    title: 'T',
    summary: 'Old summary.',
    experience: [
      { company: 'Acme', title: 'Engineer', startDate: '2022', achievements: ['A1.'] },
      { company: 'Acme', title: 'Engineer', startDate: '2018', achievements: ['B1.'] },
      { company: 'Beta', title: 'Lead', startDate: '2015', achievements: ['C1.'] },
    ],
    skillGroups: [{ category: 'Languages', skills: ['Go'] }],
    coverLetter: 'Letter.',
  };
  const merged = revise.mergeRevision(
    draft,
    JSON.stringify({
      summary: '  New summary.  ',
      experience: [
        { company: ' acme ', title: 'ENGINEER', achievements: ['A2.', 3, ''] },
        { company: 'Acme', title: 'Engineer', achievements: ['B2.'] },
        { company: 'Nowhere', title: 'Ghost', achievements: ['Z.'] },
        { company: 'Beta', title: 'Lead', achievements: [] },
      ],
      skillGroups: [{ category: 'X', skills: ['Y'] }],
      coverLetter: 'Another letter.',
      title: 'Another title',
    }),
    printsAll
  );
  assert.equal(merged.summary, 'New summary.');
  // The n-th returned (company, title) is the n-th draft role with that pair.
  assert.deepEqual(merged.experience.map((role) => role.achievements), [['A2.'], ['B2.'], ['C1.']]);
  assert.equal(merged.experience[0].startDate, '2022');
  assert.deepEqual(merged.skillGroups, draft.skillGroups);
  assert.equal(merged.coverLetter, 'Letter.');
  assert.equal(merged.title, 'T');
  assert.deepEqual(draft.experience[0].achievements, ['A1.'], 'the draft itself is not changed');

  // The prompt's own placeholder, an empty summary, `{}`, junk or a non-object change nothing.
  for (const answer of [
    JSON.stringify({ summary: 'the rewritten summary, or omit this key if you did not change it' }),
    JSON.stringify({ summary: '   ' }),
    '{}',
    'not json',
    '[]',
    JSON.stringify({ experience: [{ company: 'Acme', title: 'Engineer', achievements: 'one string' }] }),
    // Exactly what the draft already says is no change either.
    JSON.stringify({ summary: 'Old summary.', experience: [{ company: 'Beta', title: 'Lead', achievements: ['C1.'] }] }),
  ]) {
    assert.equal(revise.mergeRevision(draft, answer, printsAll), null, answer);
  }
});

test('one of two stints at a company under one title, returned alone, revises the stint whose bullets it repeats', () => {
  // The prompt lists a role "only if you changed one of its bullets", with
  // every bullet of it, and the draft it reads carries no dates: the
  // unchanged bullets are what say which stint it is.
  const draft = {
    summary: 'S.',
    experience: [
      { company: 'Acme', title: 'Engineer', startDate: '2020', achievements: ['Recent A.'] },
      { company: 'Acme', title: 'Engineer', startDate: '2016', achievements: ['Old B.', 'Old C.'] },
    ],
  };
  const older = revise.mergeRevision(
    draft,
    JSON.stringify({ experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Old B with Kafka.', 'Old C.'] }] }),
    printsAll
  );
  assert.deepEqual(
    older.experience.map((role) => [role.startDate, role.achievements]),
    [['2020', ['Recent A.']], ['2016', ['Old B with Kafka.', 'Old C.']]],
    'the older stint is revised, the recent one untouched'
  );
  const recent = revise.mergeRevision(
    draft,
    JSON.stringify({ experience: [{ company: 'acme', title: 'engineer', achievements: ['Recent  a.', 'Recent A with Kafka.'] }] }),
    printsAll
  );
  assert.deepEqual(recent.experience.map((role) => role.achievements), [['Recent  a.', 'Recent A with Kafka.'], ['Old B.', 'Old C.']]);

  // Sharing no bullet with either - or as many with both - it cannot be told
  // apart, and is ignored like a role the draft does not have.
  for (const achievements of [['Something new with Kafka.'], ['Recent A.', 'Old B.', 'New with Kafka.']]) {
    assert.equal(revise.mergeRevision(draft, JSON.stringify({ experience: [{ company: 'Acme', title: 'Engineer', achievements }] }), printsAll), null);
  }
  const summaryOnly = revise.mergeRevision(
    draft,
    JSON.stringify({ summary: 'S with Kafka.', experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Brand new.'] }] }),
    printsAll
  );
  assert.equal(summaryOnly.summary, 'S with Kafka.');
  assert.deepEqual(summaryOnly.experience, draft.experience);

  // Both returned: in order, as before - whatever they share.
  const both = revise.mergeRevision(
    draft,
    JSON.stringify({
      experience: [
        { company: 'Acme', title: 'Engineer', achievements: ['R2.'] },
        { company: 'Acme', title: 'Engineer', achievements: ['O2.'] },
      ],
    }),
    printsAll
  );
  assert.deepEqual(both.experience.map((role) => role.achievements), [['R2.'], ['O2.']]);
  // And a pair the draft has once is that role, as before, shared bullet or none.
  const once = revise.mergeRevision(
    { summary: 'S.', experience: [{ company: 'Beta', title: 'Lead', achievements: ['B1.'] }] },
    JSON.stringify({ experience: [{ company: 'Beta', title: 'Lead', achievements: ['Wholly new.'] }] }),
    printsAll
  );
  assert.deepEqual(once.experience[0].achievements, ['Wholly new.']);
});

test("a revised line that would not print whole never costs the draft its own", () => {
  // The caller's finishing drops a sentence with "we" or "our" in it (resumeService's sanitiser).
  const printsWhole = (text) => !/\b(?:we|our)\b/i.test(text);
  const draft = {
    summary: 'Backend engineer on Python services.',
    experience: [
      { company: 'Acme', title: 'Engineer', achievements: ['A1 with Kafka.', 'A2 with Python.'] },
      { company: 'Beta', title: 'Engineer', achievements: ['B1.', 'B2.'] },
      { company: 'Gamma', title: 'Engineer', achievements: ['G1.', 'G2.'] },
    ],
  };
  const merged = revise.mergeRevision(
    draft,
    JSON.stringify({
      summary: 'Backend engineer on Python microservices we ship in Docker.',
      experience: [
        // As many bullets as the draft: the one that would not print keeps the draft's place.
        { company: 'Acme', title: 'Engineer', achievements: ['A1 with Kafka and Docker.', 'Cut our build time on Python.'] },
        // A different count with a line that would not print: the role keeps the draft's bullets.
        { company: 'Beta', title: 'Engineer', achievements: ['B1 on microservices.', 'Ran our pager.', 'B3.'] },
        // A repeat is no second bullet either.
        { company: 'Gamma', title: 'Engineer', achievements: ['G1 with Docker.', 'g1 with  docker.'] },
      ],
    }),
    printsWhole
  );
  assert.equal(merged.summary, 'Backend engineer on Python services.', "the draft's summary, not one that would lose its sentence");
  assert.deepEqual(merged.experience.map((role) => role.achievements), [
    ['A1 with Kafka and Docker.', 'A2 with Python.'],
    ['B1.', 'B2.'],
    ['G1 with Docker.', 'G2.'],
  ]);

  // Every revised line would lose a sentence: nothing changed at all.
  assert.equal(
    revise.mergeRevision(
      draft,
      JSON.stringify({
        summary: 'We build Python services.',
        experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Moved our queues to Kafka.', 'Our Python services.'] }],
      }),
      printsWhole
    ),
    null
  );
});

/* ======================================================== through tailorResume */

test('a draft that carries every term the source names is not revised; one missing a term is, and is told exactly that', async () => {
  install('trigger');
  const complete = seat();
  await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  assert.equal(complete.revisions().length, 0);

  const missing = seat({ tailor: () => completeDraft({ summary: 'Ownership of services built in Python with Kafka and Docker.' }) });
  await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  assert.equal(missing.revisions().length, 1);
  const turn = told(missing.revisions()[0]);
  assert.match(turn, /TERMS THE RESUME IS MISSING[^\n]*\n\["microservices"\]/);
  assert.doesNotMatch(turn, /FIGURES THE PROFILE STATES/, 'the source states no figure the draft dropped');
  assert.match(
    turn,
    /"company":"Acme","title":"Engineer","startDate":"2020","endDate":"Present","achievements":\["Built 4 Python services for 30 teams\."/
  );
  // On the model the resume is charged at.
  assert.equal(missing.revisions()[0].modelName, 'sonnet');

  // A posting term the resume never names is left out on purpose - the
  // tailoring prompt says so - and is never asked for: no revision at all.
  const unnamed = seat({ tailor: () => completeDraft({ summary: 'Ownership of services built in Python with Kafka and Docker.' }) });
  await tailorResume(resumeRecord({ summary: 'Built Python services on Kafka and Docker, with ownership of the payment flows.' }), ANALYSIS, CHOICE, 'partial');
  assert.equal(unnamed.revisions().length, 0, 'microservices is not hers to claim');

  // Nor a term or a figure that only a sentence about the COMPANY carries:
  // the tailoring was shown the role without it (its `companyContext`).
  const roleWith = (description) =>
    resumeRecord({
      summary: 'Built Python services on Kafka and Docker, with ownership of the payment flows.',
      experience: [
        { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'Remote', description, achievements: ['Her own bullet.'], skills: [] },
        { title: 'Engineer', company: 'Beta', startDate: '2017', endDate: '2019', location: 'Berlin', description: '', achievements: ['Her older bullet.'], skills: [] },
      ],
    });
  const blurb = seat({ tailor: () => completeDraft({ summary: 'Ownership of services built in Python with Kafka and Docker.' }) });
  await tailorResume(roleWith('Acme is a platform of 75 microservices.'), ANALYSIS, CHOICE, 'partial');
  assert.equal(blurb.revisions().length, 0, "the company's own blurb is not hers");
  // The same words as her own sentence are hers: the term and the figure both.
  const own = seat({ tailor: () => completeDraft({ summary: 'Ownership of services built in Python with Kafka and Docker.' }) });
  await tailorResume(roleWith('Ran a platform of 75 microservices.'), ANALYSIS, CHOICE, 'partial');
  assert.equal(own.revisions().length, 1);
  assert.match(told(own.revisions()[0]), /TERMS THE RESUME IS MISSING[^\n]*\n\["microservices"\]/);
  assert.match(told(own.revisions()[0]), /\n- Acme, Engineer: Ran a platform of 75 microservices\./);

  // Nothing missing, but the draft dropped a figure the resume states: asked
  // to put that line's figure back, and for nothing else.
  const figures = seat({
    tailor: () => completeDraft({ experience: [{ title: 'Engineer', company: 'Acme', achievements: ['Built Docker images for Kafka.', 'Fixed bugs.'] }] }),
  });
  const measured = resumeRecord({
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'Remote', description: '', achievements: ['Cut deploys from 40 minutes to 6.'], skills: [] },
      { title: 'Engineer', company: 'Beta', startDate: '2017', endDate: '2019', location: 'Berlin', description: '', achievements: ['Her older bullet.'], skills: [] },
    ],
  });
  await tailorResume(measured, ANALYSIS, CHOICE, 'partial');
  assert.equal(figures.revisions().length, 1);
  assert.match(
    told(figures.revisions()[0]),
    /FIGURES THE PROFILE STATES AND THE DRAFT DROPPED\.[^\n]*\n- Acme, Engineer: Cut deploys from 40 minutes to 6\./
  );
  assert.match(told(figures.revisions()[0]), /TERMS THE RESUME IS MISSING[^\n]*\n\[\]/);
  // A draft with few figures but none of hers dropped is the resume as it stands.
  const few = seat({
    tailor: () => completeDraft({ experience: [{ title: 'Engineer', company: 'Acme', achievements: ['Built Docker images for Kafka.', 'Fixed bugs.'] }] }),
  });
  await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  assert.equal(few.revisions().length, 0, 'no figure is ever asked for that the source does not state');

  // Switched off, never.
  await withEnv({ TAILOR_REVISE_PASS: 'off' }, async () => {
    const off = seat({ tailor: () => completeDraft({ summary: 'Nothing here.' }) });
    await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
    assert.equal(off.revisions().length, 0);
  });
  // And never handed more terms than the cap - the posting's top five first.
  await withEnv({ TAILOR_REVISE_MAX_TERMS: '2' }, async () => {
    const capped = seat({
      tailor: () => completeDraft({ summary: 'Nothing here.', experience: [{ title: 'Engineer', company: 'Acme', achievements: ['Fixed 3 bugs.'] }] }),
    });
    await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
    assert.match(told(capped.revisions()[0]), /TERMS THE RESUME IS MISSING[^\n]*\n\["Python","Kafka"\]/);
  });
});

test('the revision is folded in and finished like the draft: dashes out, eight bullets, facts and the rest untouched', async () => {
  install('merge');
  const s = seat({
    tailor: () => completeDraft({ summary: 'Python, Kafka and microservices.' }),
    revision: () =>
      JSON.stringify({
        summary: 'Ownership of microservices built in Python with Kafka and Docker — for payments.',
        experience: [
          {
            company: 'Acme',
            title: 'Engineer',
            achievements: Array.from({ length: 10 }, (_, index) => `Bullet ${index} ${index > 6 ? 'with Docker and Kafka' : 'plain'} — done.`),
          },
        ],
        skillGroups: [{ category: 'Injected', skills: ['Nope'] }],
        coverLetter: 'A letter from the revision.',
      }),
  });
  const content = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  assert.equal(s.revisions().length, 1);
  assert.equal(content.summary, 'Ownership of microservices built in Python with Kafka and Docker, for payments.');
  const acme = content.experience.find((role) => role.company === 'Acme');
  assert.equal(acme.achievements.length, 8, 'capped');
  assert.ok(acme.achievements.includes('Bullet 9 with Docker and Kafka, done.'), 'the bullets with terms survive');
  assert.equal(acme.startDate, '2020');
  assert.deepEqual(content.experience.find((role) => role.company === 'Beta').achievements, FIGURED.slice(3), 'an unlisted role is kept');
  assert.deepEqual(content.skillGroups, [{ category: 'Languages', skills: ['Python'] }]);
  assert.equal(content.coverLetter, 'I build things.');
});

test('a revision written from the employer\'s side ("our", "we") never replaces the draft with less, and the cache keeps the draft', async () => {
  install('pronouns');
  const draftBullets = ['Built 4 Python services on Kafka for the order pipeline.', 'Tuned 12 queue consumers for checkout.'];
  const s = seat({
    tailor: () =>
      completeDraft({
        summary: 'Backend engineer on Python, Kafka and Docker.',
        experience: [
          { title: 'Engineer', company: 'Acme', achievements: draftBullets },
          { title: 'Engineer', company: 'Beta', achievements: FIGURED.slice(3) },
        ],
      }),
    revision: () =>
      JSON.stringify({
        summary: 'Backend engineer who builds microservices we ship in Docker.',
        experience: [
          {
            company: 'Acme',
            title: 'Engineer',
            achievements: ['Built 4 Python microservices on Kafka for our order pipeline.', 'Tuned 12 of our queue consumers for checkout.'],
          },
        ],
      }),
  });
  const keyed = { analysisId: 'an-pronouns', templateId: 'default' };
  const log = console.log;
  console.log = () => {};
  try {
    const content = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    assert.equal(s.revisions().length, 1, 'the draft was missing microservices');
    assert.equal(content.summary, 'Backend engineer on Python, Kafka and Docker.', "the draft's summary, never ''");
    assert.deepEqual(
      content.experience.find((role) => role.company === 'Acme').achievements,
      draftBullets,
      "the draft's bullets, never the source's raw ones"
    );
    assert.equal(repository.countTailorCacheRows(), 1);

    // What was kept is that resume: a repeat makes no call and reads the same.
    const again = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    assert.equal(s.tailorings().length, 1);
    assert.equal(s.revisions().length, 1);
    assert.deepEqual(again, content);
  } finally {
    console.log = log;
  }

  // One bullet of two says "our": the other revised bullet is taken, the draft's stands in its place.
  install('pronouns-one');
  seat({
    tailor: () =>
      completeDraft({
        summary: 'Backend engineer on Python, Kafka and Docker.',
        experience: [
          { title: 'Engineer', company: 'Acme', achievements: draftBullets },
          { title: 'Engineer', company: 'Beta', achievements: FIGURED.slice(3) },
        ],
      }),
    revision: () =>
      JSON.stringify({
        experience: [
          {
            company: 'Acme',
            title: 'Engineer',
            achievements: ['Built 4 Python microservices on Kafka for the order pipeline.', 'Tuned 12 of our queue consumers for checkout.'],
          },
        ],
      }),
  });
  const partly = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial');
  assert.deepEqual(partly.experience.find((role) => role.company === 'Acme').achievements, [
    'Built 4 Python microservices on Kafka for the order pipeline.',
    draftBullets[1],
  ]);
});

test('back at an old employer in the same job: the revised stint is the one revised, under its own dates', async () => {
  install('stints');
  const stints = resumeRecord({
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'Remote', description: '', achievements: ['Her own bullet.'], skills: [] },
      { title: 'Engineer', company: 'Acme', startDate: '2016', endDate: '2019', location: 'Berlin', description: '', achievements: ['Her older bullet.'], skills: [] },
    ],
  });
  const older = ['Ran 3 Docker registries.', 'Answered 200 pages a year.', 'Fixed 5 billing bugs.'];
  const s = seat({
    tailor: () =>
      completeDraft({
        summary: 'Ownership of microservices built in Python with Docker.',
        experience: [
          { title: 'Engineer', company: 'Acme', startDate: '2020', endDate: 'Present', achievements: FIGURED.slice(0, 2) },
          { title: 'Engineer', company: 'Acme', startDate: '2016', endDate: '2019', achievements: older },
        ],
      }),
    // Only the stint it changed, every bullet of it - and no dates, which the draft never showed it.
    revision: () =>
      JSON.stringify({
        experience: [{ company: 'Acme', title: 'Engineer', achievements: ['Ran 3 Docker registries behind Kafka.', ...older.slice(1)] }],
      }),
  });
  const content = await tailorResume(stints, ANALYSIS, CHOICE, 'partial');
  assert.equal(s.revisions().length, 1, 'the draft was missing Kafka');
  assert.deepEqual(
    content.experience.map((role) => [role.startDate, role.location, role.achievements]),
    [
      ['2020', 'Remote', FIGURED.slice(0, 2)],
      ['2016', 'Berlin', ['Ran 3 Docker registries behind Kafka.', ...older.slice(1)]],
    ]
  );
});

test('a revision that fails leaves the draft as the resume, said once and never cached; an abort is passed on', async () => {
  install('failure');
  const s = seat({
    tailor: () => completeDraft({ summary: 'Nothing here.' }),
    revision: () => {
      throw new Error('The seat is down (stub).');
    },
  });
  const keyed = { analysisId: 'an-fail', templateId: 'default' };
  const { value: content, warnings } = await quietly(async () => {
    const first = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    return first;
  });
  assert.equal(content.summary, 'Nothing here.');
  assert.equal(s.tailorings().length, 2, 'a draft whose revision failed is not kept: the next build asks again');
  assert.equal(repository.countTailorCacheRows(), 0);
  assert.equal(warnings.filter((line) => line.includes('[tailor] The revise pass failed')).length, 1, 'said once');

  // The caller going away is not a failure to paper over.
  const controller = new AbortController();
  seat({
    tailor: () => completeDraft({ summary: 'Nothing here.' }),
    revision: (request) => {
      controller.abort(new Error('the page went away'));
      throw request.signal.reason;
    },
  });
  await assert.rejects(tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', controller.signal), /the page went away/);
});

test('the cache keeps the revised resume - a repeat makes no call at all - but never a revision a fallback wrote', async () => {
  install('cache');
  const revised = JSON.stringify({ summary: 'Ownership of microservices built in Python with Kafka and Docker.' });
  let fellBack = true;
  const s = seat({
    tailor: () => completeDraft({ summary: 'Python only.' }),
    revision: (request) => {
      const result = { text: revised, ...(fellBack ? { fellBack: true, resolvedModel: 'claude-haiku-4-5' } : {}) };
      fellBack = false;
      return result;
    },
  });
  const keyed = { analysisId: 'an-cache', templateId: 'default' };
  const log = console.log;
  console.log = () => {};
  try {
    const first = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    assert.equal(first.summary, 'Ownership of microservices built in Python with Kafka and Docker.', 'used for its build');
    assert.equal(repository.countTailorCacheRows(), 0, 'but not kept: a fallback model wrote it');

    const second = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    assert.equal(s.tailorings().length, 2);
    assert.equal(s.revisions().length, 2);
    assert.equal(repository.countTailorCacheRows(), 1, 'the asked-for model\'s revision is kept');

    const third = await tailorResume(resumeRecord(), ANALYSIS, CHOICE, 'partial', undefined, keyed);
    assert.equal(s.tailorings().length, 2, 'no tailoring call');
    assert.equal(s.revisions().length, 2, 'and no revise call: the cache holds the revised resume');
    assert.deepEqual(third, second);
  } finally {
    console.log = log;
  }
});

test("an override on the revise prompt does not move it off the resume's model", async () => {
  install('override');
  const promptService = require('../dist/services/promptService');
  const record = await promptService.getPromptById('revise-resume-coverage');
  await promptService.updatePrompt('revise-resume-coverage', { content: record.content, modelProvider: 'claude-cli', modelName: 'haiku' });
  const s = seat({ tailor: () => completeDraft({ summary: 'Nothing here.' }) });
  await tailorResume(resumeRecord(), ANALYSIS, { ...CHOICE, modelName: 'opus', modelId: 'claude-cli-opus' }, 'partial');
  assert.deepEqual(s.requests.map((request) => [request.callSite, request.modelName]), [
    ['tailor-resume', 'opus'],
    ['revise-resume-coverage', 'opus'],
  ]);
});

test('content a page sends back is re-read, never revised: through the real routes', async (t) => {
  const h = await serveInstall('revise-held');
  t.after(h.close);
  // The preview chooses the resume for the profile (one candidate here), then tailors it.
  const first = await h.post('/resume/preview', {
    profileId: h.profileOf('p-claude'),
    buildMode: 'partial',
    jobDescription: posting(71),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(h.seats.tailorings().length, 1);
  assert.equal(h.seats.revisions().length, 1, 'the fresh tailoring is revised');

  const held = await h.post('/resume/preview', {
    resumeId: 'p-claude',
    analysisId: first.body.analysisId,
    tailoredContent: first.body.tailoredContent,
  });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  // Finalised through the queue, the way the builder finalises a preview.
  const queued = await h.post('/generation/batches', {
    mode: 'order',
    format: 'pdf',
    includeCoverLetterDocx: false,
    profileId: h.profileOf('p-claude'),
    buildMode: 'partial',
    previewedResumeId: first.body.resumeId,
    jobs: [{ companyName: 'Acme', role: 'Engineer', analysisId: first.body.analysisId }],
    tailoredContentByResumeId: { 'p-claude': first.body.tailoredContent },
    previewTokenByResumeId: { 'p-claude': first.body.previewToken },
  });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal((await untilFinished(queued.body.batchId)).completed, 1);
  assert.equal(h.seats.tailorings().length, 1);
  assert.equal(h.seats.revisions().length, 1, 'neither re-read asked for a revision');
});

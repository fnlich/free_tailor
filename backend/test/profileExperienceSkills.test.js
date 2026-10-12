const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTailorResumePromptValues,
  parseJobAnalysisKeywords,
  parseTailoredResumeContent,
} = require('../dist/services/resumeService');

function makeProfile() {
  return {
    id: 'profile-1',
    name: 'Jane Smith',
    title: 'Senior Software Engineer',
    contact: {
      phone: '',
      email: '',
      location: '',
    },
    summary: '',
    experience: [
      {
        title: 'Frontend Engineer',
        company: 'Acme',
        startDate: '01/2022',
        endDate: 'Present',
        location: 'Remote',
        description: 'Built React and TypeScript interfaces for customer workflows.',
        achievements: ['Improved React page performance.'],
        skills: ['React', 'Django', 'Vue.js', 'Angular', 'Secure backend logic'],
      },
      {
        title: 'Backend Engineer',
        company: 'Beta',
        startDate: '01/2020',
        endDate: '12/2021',
        location: 'Remote',
        description: 'Owned PostgreSQL services, Redis caching, and AWS deployments.',
        achievements: ['Reduced PostgreSQL query latency.'],
        skills: ['Ruby', 'MySQL', 'SQL databases (MySQL'],
      },
    ],
    strengths: [],
    skills: ['React', 'Django', 'Ruby', 'TypeScript', 'PostgreSQL', 'Redis', 'AWS'],
    education: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeJobAnalysis() {
  return {
    jobMeta: {
      title: 'Senior Full Stack Engineer',
      seniority: 'Senior',
      industry: 'Software',
      department: 'Engineering',
    },
    skills: {
      required: ['React', 'TypeScript', 'PostgreSQL'],
      preferred: ['Redis', 'AWS'],
      tools: [],
      technologies: [],
    },
    responsibilities: ['Build React interfaces and PostgreSQL services.'],
    domainKnowledge: [],
    softSkills: [],
    keywords: {
      actionVerbs: [],
      buzzwords: [],
      mustInclude: [],
    },
    sourceJobDescription: [
      'We need React and TypeScript experience for UI work.',
      'The role also owns PostgreSQL services, Redis caching, and AWS deployments.',
    ].join('\n'),
  };
}

test("parseTailoredResumeContent keeps the model's skill groups as written, and a model's hardSkills field is not the source", () => {
  // The shipped prompt has the model write the Technical Skills block, which
  // "is printed exactly as you return it. Nothing reorders it, merges it,
  // spell-checks it or fills it out". So nothing is checked against the
  // library or the posting: only the shape is made safe.
  const content = JSON.stringify({
    title: 'Senior Software Engineer',
    summary: 'Experienced engineer building reliable product systems.',
    experience: makeProfile().experience.map((item) => ({ ...item, description: '' })),
    skillGroups: [
      { category: 'Frontend', skills: ['React', '  TypeScript  ', '', 7, 'Secure backend logic'] },
      { category: 'Data', skills: ['PostgreSQL', 'AWS Textract'] },
      { category: 'Empty', skills: [] },
    ],
    hardSkills: ['Model Pick'],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, makeProfile(), makeJobAnalysis());

  assert.deepEqual(parsed.skillGroups, [
    { category: 'Frontend', skills: ['React', 'TypeScript', 'Secure backend logic'] },
    { category: 'Data', skills: ['PostgreSQL', 'AWS Textract'] },
  ]);
  assert.deepEqual(parsed.hardSkills, ['React', 'TypeScript', 'Secure backend logic', 'PostgreSQL', 'AWS Textract']);
  assert.equal(parsed.hardSkills.includes('Model Pick'), false);
  assert.deepEqual(parsed.skills, parsed.hardSkills);
  assert.deepEqual(parsed.unconfirmedHardSkills, []);
  assert.deepEqual(parsed.unconfirmedSoftSkills, []);
});

test('parseJobAnalysisKeywords removes employer-perspective job posting slogans', () => {
  const parsed = parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: {
        title: 'Senior Software Engineer',
        seniority: 'Senior',
        industry: 'Software',
        department: 'Engineering',
      },
      skills: {
        required: ['React'],
        preferred: [],
        tools: [],
        technologies: [],
      },
      responsibilities: [
        'build our next generation of workflow tools',
        'enable our customers to fund and break ground',
        'build scalable workflow tools',
        'design system maintenance',
        'incident response ownership.',
        'keyword coverage for this role',
      ],
      domainKnowledge: ['our customer funding platform', 'workflow automation'],
      softSkills: [],
      keywords: {
        actionVerbs: [],
        buzzwords: ['next generation workflow tools', 'ATS integration', 'job posting pipeline', 'releases aligned with the roadmap'],
        mustInclude: ['build our next generation of workflow tools', 'workflow automation', 'maps to the target role'],
      },
    }),
    'We need someone to build our next generation of workflow tools.'
  );

  const { sourceJobDescription, ...resumeVisibleAnalysis } = parsed;
  assert.equal(typeof sourceJobDescription, 'string');

  const serialized = JSON.stringify(resumeVisibleAnalysis).toLowerCase();
  assert.equal(serialized.includes('build our next generation'), false);
  assert.equal(serialized.includes('enable our customers'), false);
  assert.equal(serialized.includes('break ground'), false);
  // Responsibilities are the noun phrases the analysis wrote, as written -
  // never reworded around a leading verb ("design system maintenance" once
  // became "system maintenance delivery") - bar a trailing full stop; a
  // phrase about the tailoring itself is dropped.
  assert.deepEqual(parsed.responsibilities, [
    'build scalable workflow tools',
    'design system maintenance',
    'incident response ownership',
  ]);
  assert.deepEqual(parsed.domainKnowledge, ['workflow automation']);
  assert.deepEqual(parsed.keywords.mustInclude, ['workflow automation']);
  // Only real meta phrases drop a keyword: "ATS", "job posting" and
  // "aligned with" name work too.
  assert.deepEqual(parsed.keywords.buzzwords, ['ATS integration', 'job posting pipeline', 'releases aligned with the roadmap']);
});

test('parseJobAnalysisKeywords preserves v2 extraction schema and legacy aliases', () => {
  const parsed = parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: {
        title: 'Senior Platform Engineer',
        seniority: 'senior',
        industry: 'SaaS',
        department: 'platform',
      },
      skills: {
        technical: ['API design', 'database optimization'],
        tools: ['Docker'],
        soft: ['cross-functional collaboration'],
      },
      technologies: ['TypeScript', 'PostgreSQL'],
      protocols: ['REST', 'GraphQL'],
      methodologies: ['CI/CD', 'TDD'],
      architecturePatterns: ['microservices', 'event-driven systems'],
      responsibilities: ['platform reliability ownership'],
      domainKnowledge: ['developer experience'],
      keywords: {
        actionVerbs: ['optimize'],
        buzzwords: ['platform engineering'],
        mustInclude: ['TypeScript'],
      },
      // An edit written for the older prompt still asks for these: they are
      // the facts call's, and not read here.
      jobField: 'frontend',
      industry: 'Insurance',
      salary: { min: 1, max: 2 },
      filter: { jobType: 'remote' },
    }),
    'Senior Platform Engineer role using TypeScript, PostgreSQL, Docker, REST, GraphQL, CI/CD, and TDD.'
  );
  for (const key of ['jobField', 'industry', 'salary', 'filter']) assert.equal(key in parsed, false, key);

  assert.deepEqual(parsed.skills.technical, ['API design', 'database optimization']);
  assert.deepEqual(parsed.skills.required, ['API design', 'database optimization']);
  assert.deepEqual(parsed.skills.tools, ['Docker']);
  assert.deepEqual(parsed.skills.soft, ['cross-functional collaboration']);
  assert.deepEqual(parsed.softSkills, ['cross-functional collaboration']);
  assert.deepEqual(parsed.technologies, ['TypeScript', 'PostgreSQL']);
  assert.deepEqual(parsed.skills.technologies, ['TypeScript', 'PostgreSQL']);
  assert.deepEqual(parsed.protocols, ['REST', 'GraphQL']);
  assert.deepEqual(parsed.methodologies, ['CI/CD', 'TDD']);
  assert.deepEqual(parsed.architecturePatterns, ['microservices', 'event-driven systems']);
});

test("parseJobAnalysisKeywords keeps the posting's soft skills in its own order, and the seniority as it answered", () => {
  // The prompt asks for the explicit ones first, in the posting's words, and
  // both forms of a phrase; the analysis keeps that order rather than
  // re-sorting it. `unknown` is the prompt's own word for "not stated".
  const parsed = parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: { title: 'Engineer', seniority: 'unknown', industry: 'SaaS', department: 'Engineering' },
      skills: { technical: [], tools: [], soft: ['Communication skills', 'Communication', 'Teamwork', 'Ownership', 'Adaptability'] },
      keywords: { actionVerbs: ['built', 'migrated', 'led'], buzzwords: [], mustInclude: [] },
    }),
    'A posting.'
  );
  assert.deepEqual(parsed.skills.soft, ['Communication skills', 'Communication', 'Teamwork', 'Ownership', 'Adaptability']);
  assert.equal(parsed.jobMeta.seniority, 'unknown');
  assert.deepEqual(parsed.keywords.actionVerbs, ['built', 'migrated', 'led']);
});

test("buildTailorResumePromptValues sends the posting's own lists: skills, prose keywords and concepts apart", () => {
  const profile = {
    ...makeProfile(),
    experience: [
      {
        ...makeProfile().experience[0],
        company: 'Stripe',
        description: 'Stripe builds programmable financial services for millions of companies.',
      },
    ],
  };
  const jobAnalysis = parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: {
        title: 'Senior Platform Engineer',
        seniority: 'senior',
        industry: 'SaaS',
        department: 'platform',
      },
      skills: {
        technical: ['API design'],
        tools: ['Docker'],
        soft: ['cross-functional collaboration', 'written communication'],
      },
      technologies: ['TypeScript'],
      protocols: ['REST'],
      methodologies: ['CI/CD'],
      architecturePatterns: ['microservices'],
      responsibilities: ['platform reliability ownership'],
      domainKnowledge: ['developer experience'],
      keywords: {
        actionVerbs: ['optimize', 'migrated', 'designed', 'built'],
        buzzwords: ['platform engineering'],
        mustInclude: ['TypeScript', 'on-call support'],
      },
    }),
    'Senior Platform Engineer role using TypeScript, Docker, REST, and CI/CD.'
  );

  const values = buildTailorResumePromptValues(profile, jobAnalysis);
  const promptProfile = JSON.parse(values.profileJson);

  assert.equal('softSkillsJSON' in values, false);
  assert.equal('hardSkillsJson' in values, false, 'no second copy of skillsJSON');
  // Absent now, not blanked. The prompt profile is built by naming what goes
  // in, so the raw description is not carried as an empty string alongside the
  // `companyContext` that replaced it.
  assert.equal('description' in promptProfile.experience[0], false);
  assert.ok(typeof promptProfile.experience[0].companyContext === 'string');
  assert.equal(values.profileJson.includes('Stripe builds programmable financial services'), false);
  // The abilities, tools, technologies and protocols, in the posting's spelling.
  assert.deepEqual(JSON.parse(values.skillsJSON), ['API design', 'Docker', 'TypeScript', 'REST']);
  // Architecture, methods and buzzwords: the concepts.
  assert.deepEqual(JSON.parse(values.conceptKeywordsJson), ['microservices', 'CI/CD', 'platform engineering']);
  // Soft skills, the must-include terms the other two lists do not hold, and
  // past-tense verbs that are not banned: no "optimize", no "designed".
  assert.deepEqual(JSON.parse(values.keywordsJson), [
    'cross-functional collaboration',
    'written communication',
    'on-call support',
    'migrated',
    'built',
  ]);
  assert.deepEqual(JSON.parse(values.keyResponsibilitiesJson), ['platform reliability ownership']);
  // The domain knowledge alone: the employer's market and department are in
  // jobAnalysisJson, never on a list the model is told to claim.
  assert.deepEqual(JSON.parse(values.domainKnowledge), ['developer experience']);
  assert.equal(values.targetRoleTitle, 'Senior Platform Engineer');
  assert.equal(values.jobTitle, 'Senior Platform Engineer');
});

test('buildTailorResumePromptValues reads nothing from the skill library', () => {
  // The library once added "AWS Lambda" (found in the posting text) and
  // dropped "AWS" as covered by it, and put every library soft skill the text
  // mentions on the prose checklist. The prompt asks for the posting's own
  // words, character for character, and only what the analysis read.
  const jobAnalysis = parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: {
        title: 'Senior Cloud Engineer',
        seniority: 'senior',
        industry: 'SaaS',
        department: 'engineering',
      },
      skills: {
        technical: ['AWS'],
        tools: [],
        soft: [],
      },
      technologies: [],
      protocols: [],
      methodologies: [],
      architecturePatterns: [],
      responsibilities: ['serverless workflow delivery'],
      domainKnowledge: [],
      keywords: {
        actionVerbs: [],
        buzzwords: [],
        mustInclude: [],
      },
    }),
    'Build AWS Lambda services with strong Written Communication across delivery teams.'
  );

  const values = buildTailorResumePromptValues(makeProfile(), jobAnalysis);
  assert.deepEqual(JSON.parse(values.skillsJSON), ['AWS']);
  assert.deepEqual(JSON.parse(values.keywordsJson), []);
});

test('parseTailoredResumeContent adds nothing to the summary', () => {
  // A soft skill the posting names that the draft does not carry is the
  // revise pass's to work in, by the model - never a "Working style:" or
  // "Strengths include" sentence the code appends.
  const jobAnalysis = parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: {
        title: 'Senior Software Engineer',
        seniority: 'senior',
        industry: 'SaaS',
        department: 'engineering',
      },
      skills: {
        technical: ['TypeScript'],
        tools: [],
        soft: ['Adaptable'],
      },
      responsibilities: ['reliable software delivery'],
      domainKnowledge: [],
      keywords: {
        actionVerbs: [],
        buzzwords: [],
        mustInclude: [],
      },
    }),
    'The team needs an Adaptable engineer who can work through changing requirements.'
  );
  const content = JSON.stringify({
    title: 'Senior Software Engineer',
    summary: 'Experienced engineer building reliable product systems.',
    experience: makeProfile().experience.map((item) => ({ ...item, description: '' })),
    skillGroups: [{ category: 'Languages', skills: ['TypeScript'] }],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, makeProfile(), jobAnalysis);

  assert.equal(parsed.summary, 'Experienced engineer building reliable product systems.');
});

test('parseTailoredResumeContent keeps unsafe job-analysis fragments out, and a role with no bullet gets its own', () => {
  const profile = makeProfile();
  const unsafeJobAnalysis = {
    ...makeJobAnalysis(),
    responsibilities: [
      'build our next generation of workflow tools',
      'enable our customers to fund and break ground',
    ],
    keywords: {
      actionVerbs: [],
      buzzwords: [],
      mustInclude: ['build our next generation of workflow tools'],
    },
  };
  const content = JSON.stringify({
    title: 'Senior Software Engineer',
    summary: 'Experienced engineer building reliable product systems.',
    experience: profile.experience.map((item) => ({
      title: item.title,
      company: item.company,
      startDate: item.startDate,
      endDate: item.endDate,
      location: item.location,
      description: 'Built reliable systems.',
      achievements: [],
    })),
    skillGroups: [],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, profile, unsafeJobAnalysis);
  const resumeText = JSON.stringify(parsed).toLowerCase();

  assert.equal(resumeText.includes('build our next generation'), false);
  assert.equal(resumeText.includes('enable our customers'), false);
  assert.equal(resumeText.includes('break ground'), false);
  assert.equal(resumeText.includes('practical engineering execution'), false, 'no bullet invented from a responsibility');
  assert.equal(resumeText.includes('focused on reliable product delivery'), false, 'nor a description');
  // The description is discarded: the prompt says so, and the render prints none.
  assert.equal(parsed.experience[0].description, '');
  // An empty role falls back to the profile's own bullets, never invented text.
  assert.deepEqual(parsed.experience[0].achievements, ['Improved React page performance.']);
  assert.deepEqual(parsed.experience[1].achievements, ['Reduced PostgreSQL query latency.']);
});

test('parseTailoredResumeContent strips meta-tailoring summary language, and no role keeps a description', () => {
  const profile = makeProfile();
  const content = JSON.stringify({
    title: 'Senior Software Engineer',
    summary: 'Experienced engineer building reliable systems. This background maps to EAM Development and workflow configuration.',
    experience: [
      {
        title: 'Frontend Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Acme is the financial infrastructure layer for the internet.',
        achievements: ['Built reliable API systems.'],
      },
    ],
    skillGroups: [],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, profile, makeJobAnalysis());

  assert.equal(parsed.summary.includes('maps to'), false);
  assert.equal(parsed.summary, 'Experienced engineer building reliable systems.');
  assert.equal(parsed.experience[0].description, '');
  assert.equal(parsed.experience[0].startDate, '01/2022', "the profile's own dates, not the answer's");
  assert.deepEqual(parsed.experience[0].achievements, ['Built reliable API systems.']);
});

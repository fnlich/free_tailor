const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTailorResumePromptValues,
  enrichProfileExperienceSkillsForJob,
  parseJobAnalysisContent,
  parseTailoredResumeContent,
} = require('../dist/services/claude');

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

test('enrichProfileExperienceSkillsForJob keeps only JD-matched skills and assigns leftovers by experience relevance', () => {
  const enriched = enrichProfileExperienceSkillsForJob(makeProfile(), makeJobAnalysis());

  assert.deepEqual(enriched.experience[0].skills, ['React', 'TypeScript', 'Django', 'Vue.js', 'Angular']);
  assert.deepEqual(enriched.experience[1].skills, ['PostgreSQL', 'Redis', 'AWS', 'Caching', 'Ruby', 'MySQL']);
  assert.deepEqual(enriched.skills, [
    'React',
    'TypeScript',
    'Django',
    'Vue.js',
    'Angular',
    'PostgreSQL',
    'Redis',
    'AWS',
    'Caching',
    'Ruby',
    'MySQL',
  ]);
});

test('parseTailoredResumeContent ignores model-selected hard skills and uses code-decided skills', () => {
  const enriched = enrichProfileExperienceSkillsForJob(makeProfile(), makeJobAnalysis());
  const content = JSON.stringify({
    title: 'Senior Software Engineer',
    summary: 'Experienced engineer building reliable product systems.',
    experience: enriched.experience.map((item) => ({
      title: item.title,
      company: item.company,
      startDate: item.startDate,
      endDate: item.endDate,
      location: item.location,
      description: item.description,
      achievements: item.achievements,
    })),
    hardSkills: ['AWS Textract', 'Secure backend logic', 'SQL databases (MySQL', 'React,'],
    softSkills: [],
    strengths: [],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, enriched, makeJobAnalysis());

  assert.equal(parsed.hardSkills.includes('AWS Textract'), false);
  assert.equal(parsed.hardSkills.includes('React,'), false);
  assert.equal(parsed.hardSkills.includes('Secure backend logic'), false);
  assert.equal(parsed.hardSkills.includes('SQL databases (MySQL'), false);
  assert.equal(parsed.hardSkills.includes('TypeScript'), true);
  assert.equal(parsed.hardSkills.includes('React'), true);
  assert.equal(parsed.hardSkills.every((skill) => typeof skill === 'string' && skill.trim()), true);
  assert.deepEqual(parsed.skills, parsed.hardSkills);
  assert.deepEqual(parsed.unconfirmedHardSkills, []);
});

test('parseJobAnalysisContent removes employer-perspective job posting slogans', () => {
  const parsed = parseJobAnalysisContent(
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
      ],
      domainKnowledge: ['our customer funding platform', 'workflow automation'],
      softSkills: [],
      keywords: {
        actionVerbs: [],
        buzzwords: ['next generation workflow tools'],
        mustInclude: ['build our next generation of workflow tools', 'workflow automation'],
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
  assert.deepEqual(parsed.responsibilities, ['scalable workflow tools delivery']);
  assert.deepEqual(parsed.domainKnowledge, ['workflow automation']);
  assert.deepEqual(parsed.keywords.mustInclude, ['workflow automation']);
});

test('parseJobAnalysisContent preserves v2 extraction schema and legacy aliases', () => {
  const parsed = parseJobAnalysisContent(
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
    }),
    'Senior Platform Engineer role using TypeScript, PostgreSQL, Docker, REST, GraphQL, CI/CD, and TDD.'
  );

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

test('buildTailorResumePromptValues sends extracted skillsJSON and folds soft skills into keywordsJson', () => {
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
  const jobAnalysis = parseJobAnalysisContent(
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
        actionVerbs: ['optimize'],
        buzzwords: ['platform engineering'],
        mustInclude: ['TypeScript'],
      },
    }),
    'Senior Platform Engineer role using TypeScript, Docker, REST, and CI/CD.'
  );

  const values = buildTailorResumePromptValues(profile, jobAnalysis);
  const promptProfile = JSON.parse(values.profileJson);
  const skills = JSON.parse(values.skillsJSON);
  const hardSkills = JSON.parse(values.hardSkillsJson);
  const keywords = JSON.parse(values.keywordsJson);

  assert.equal('softSkillsJSON' in values, false);
  assert.equal('hardSkillsJSON' in values, false);
  assert.deepEqual(hardSkills, skills);
  assert.equal(promptProfile.experience[0].description, '');
  assert.equal(values.profileJson.includes('Stripe builds programmable financial services'), false);
  assert.equal(Array.isArray(skills), true);
  assert.equal(skills.every((skill) => typeof skill === 'string'), true);
  assert.equal(skills.includes('Docker'), true);
  assert.equal(skills.includes('TypeScript'), true);
  assert.equal(skills.includes('REST'), true);
  assert.equal(skills.includes('CI/CD'), true);
  assert.equal(keywords.includes('cross-functional collaboration'), true);
  assert.equal(keywords.includes('written communication'), true);
  assert.equal(keywords.includes('platform engineering'), true);
});

test('buildTailorResumePromptValues augments prompt lists from skill library and removes broader tech skills', () => {
  const jobAnalysis = parseJobAnalysisContent(
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
  const skills = JSON.parse(values.skillsJSON);
  const keywords = JSON.parse(values.keywordsJson);

  assert.deepEqual(JSON.parse(values.hardSkillsJson), skills);
  assert.equal(skills.every((skill) => typeof skill === 'string'), true);
  assert.equal(skills.includes('AWS Lambda'), true);
  assert.equal(keywords.includes('Written Communication'), true);
});

test('parseTailoredResumeContent inserts missing library-matched soft keyword into summary', () => {
  const jobAnalysis = parseJobAnalysisContent(
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
        soft: [],
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
    experience: makeProfile().experience.map((item) => ({
      title: item.title,
      company: item.company,
      startDate: item.startDate,
      endDate: item.endDate,
      location: item.location,
      description: item.description,
      achievements: item.achievements,
    })),
    hardSkills: ['TypeScript'],
    softSkills: [],
    strengths: [],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, makeProfile(), jobAnalysis);

  assert.match(parsed.summary, /\bAdaptable\b/);
});

test('parseTailoredResumeContent does not append unsafe job-analysis fragments to role descriptions', () => {
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
    hardSkills: [],
    softSkills: [],
    strengths: [],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, profile, unsafeJobAnalysis);
  const resumeText = JSON.stringify(parsed).toLowerCase();

  assert.equal(resumeText.includes('build our next generation'), false);
  assert.equal(resumeText.includes('enable our customers'), false);
  assert.equal(resumeText.includes('break ground'), false);
  assert.equal(resumeText.includes('contributed to dependable product delivery'), false);
  assert.equal(parsed.experience[0].description, 'Built reliable systems.');
});

test('parseTailoredResumeContent strips meta-tailoring summary language and raw company descriptions', () => {
  const profile = makeProfile();
  const content = JSON.stringify({
    title: 'Senior Software Engineer',
    summary: 'Experienced engineer building reliable systems. This background maps to EAM Development and workflow configuration.',
    experience: [
      {
        title: 'Senior Software Engineer',
        company: 'Stripe',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Stripe is the financial infrastructure layer for the internet.',
        achievements: ['Built reliable API systems.'],
      },
    ],
    hardSkills: [],
    softSkills: [],
    strengths: [],
    coverLetter: 'I enjoy building useful systems.',
  });

  const parsed = parseTailoredResumeContent(content, profile, makeJobAnalysis());

  assert.equal(parsed.summary.includes('maps to'), false);
  assert.equal(parsed.summary, 'Experienced engineer building reliable systems.');
  assert.equal(parsed.experience[0].description, 'Senior Software Engineer focused on reliable product delivery, maintainable systems, and practical engineering outcomes.');
});

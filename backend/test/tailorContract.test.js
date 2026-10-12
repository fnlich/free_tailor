const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * What the shipped tailoring prompt is promised about the code around it,
 * one promise at a time (services/tailorContract.ts, and resumeService's
 * prompt values and parse that put it together):
 *
 * - its lists are the posting's own - skills, the five it leans on, prose
 *   keywords, concepts and the tools they are built with - in its spelling;
 * - what is "drawn per resume" (the soft-skill heading, the concept tools'
 *   order, the title's shape) is seeded by the profile and the posting, so
 *   the same resume asked again is the same question;
 * - "the application ... appends the KIND of role" to the headline, in one
 *   of six shapes, and leaves it alone when the headline already says it;
 * - the roles' facts are the profile's, a role the profile lacks is dropped
 *   and one the answer left out is put back; descriptions are discarded;
 * - "anything past the eighth bullet is DISCARDED ... the eight that survive
 *   are the ones carrying the most checklist terms";
 * - spans of years are numerals, and there are no em dashes;
 * - and every step is idempotent on its own output.
 */

useTempStorage('tailor-contract');

const resumeService = require('../dist/services/resumeService');
const contract = require('../dist/services/tailorContract');
const { CONCEPT_TOOLS, conceptRowsFor } = require('../dist/config/conceptTools');
const { SOFT_SKILL_GROUP_HEADINGS } = require('../dist/services/skillGroups');
const { listPromptFeatureVariableNames } = require('../dist/services/promptService');

const POSTING = [
  'Senior Data & AI Engineer',
  'We build payment platforms used by banks.',
  '',
  'What you will do',
  '- Run Kafka pipelines on AWS with Python and Java',
  '- Own incident response for the settlement path',
  '',
  'Requirements:',
  '- 5+ years of Python and Java',
  '- Kafka, AWS and PostgreSQL in production',
  '- Experience with Go',
  '',
  'Nice to have',
  '- Docker, Terraform, Kubernetes',
].join('\n');

function analysis(overrides = {}, posting = POSTING) {
  return {
    ...resumeService.parseJobAnalysisKeywords(
      JSON.stringify({
        jobMeta: { title: 'Senior Data & AI Engineer - AWS, Java & Python', seniority: 'senior', industry: 'fintech', department: 'data' },
        skills: {
          technical: ['system design', 'code review'],
          tools: ['Docker', 'Terraform', 'Kubernetes'],
          soft: ['Communication skills', 'Ownership', 'cross-functional collaboration'],
        },
        technologies: ['Java', 'Python', 'AWS', 'Kafka', 'PostgreSQL', 'Go'],
        protocols: ['REST'],
        methodologies: ['CI/CD'],
        architecturePatterns: ['microservices', 'event-driven architecture'],
        responsibilities: ['data pipeline development', 'incident response ownership'],
        domainKnowledge: ['payments', 'ledger reconciliation'],
        keywords: {
          actionVerbs: ['built', 'designed', 'led', 'migrated', 'optimize', 'leveraged', 'ran'],
          buzzwords: ['cloud-native', 'observability'],
          mustInclude: ['PostgreSQL', 'stakeholder management'],
        },
        ...overrides,
      }),
      posting
    ),
    jobField: 'data-engineering',
    salary: null,
    filter: {},
  };
}

function profile(extra = {}) {
  return {
    id: 'p-ada',
    name: 'Ada',
    title: 'Senior Software Engineer',
    experience: [
      { title: 'Senior Engineer', company: 'Acme', startDate: '01/2022', endDate: 'Present', location: 'Remote', description: 'Acme makes ledgers.', achievements: ['Moved the ledger to PostgreSQL in 3 weeks.'], skills: [] },
      { title: 'Engineer', company: 'Beta', startDate: '01/2019', endDate: '12/2021', location: 'Berlin', description: '', achievements: ['Ran the Kafka cluster.'], skills: [] },
      { title: 'Junior Engineer', company: 'Gamma', startDate: '01/2016', endDate: '12/2018', location: 'Paris', description: '', achievements: ['Fixed billing bugs.'], skills: [] },
    ],
    skills: ['Python', 'Kafka'],
    strengths: [],
    softSkills: [],
    education: [],
    profileSettings: {},
    ...extra,
  };
}

/* ======================================================== the prompt values */

test('the values are exactly the variables the prompt declares, every one a string', () => {
  const values = resumeService.buildTailorResumePromptValues(profile(), analysis());
  assert.deepEqual(Object.keys(values).sort(), listPromptFeatureVariableNames('tailor-resume').sort());
  for (const [name, value] of Object.entries(values)) assert.equal(typeof value, 'string', name);
  assert.equal(values.targetRoleTitle, 'Senior Data & AI Engineer - AWS, Java & Python');
  assert.equal(values.jobTitle, values.targetRoleTitle);
});

test("the lists are the posting's own: skills, prose keywords and concepts each in one place", () => {
  const values = resumeService.buildTailorResumePromptValues(profile(), analysis());
  assert.deepEqual(JSON.parse(values.skillsJSON), [
    'system design', 'code review', 'Docker', 'Terraform', 'Kubernetes', 'Java', 'Python', 'AWS', 'Kafka', 'PostgreSQL', 'Go', 'REST',
  ]);
  assert.deepEqual(JSON.parse(values.conceptKeywordsJson), ['microservices', 'event-driven architecture', 'CI/CD', 'cloud-native', 'observability']);
  // Soft skills, must-include terms not already skills, past-tense verbs not banned.
  assert.deepEqual(JSON.parse(values.keywordsJson), [
    'Communication skills', 'Ownership', 'cross-functional collaboration', 'stakeholder management', 'built', 'migrated', 'ran',
  ]);
  assert.deepEqual(JSON.parse(values.keyResponsibilitiesJson), ['data pipeline development', 'incident response ownership']);
  assert.deepEqual(JSON.parse(values.domainKnowledge), ['payments', 'ledger reconciliation']);
  // The analysis as the analysis prompt shapes it: no posting text, no facts.
  const sent = JSON.parse(values.jobAnalysisJson);
  assert.deepEqual(Object.keys(sent.skills), ['technical', 'tools', 'soft']);
  for (const key of ['sourceJobDescription', 'jobField', 'salary', 'filter', 'softSkills', 'industry']) {
    assert.equal(key in sent, false, key);
  }
});

test('the five the posting leans on: named in its requirements, must-include, early and repeated', () => {
  const top = JSON.parse(resumeService.buildTailorResumePromptValues(profile(), analysis()).topSkillsJson);
  assert.equal(top.length, 5);
  // PostgreSQL is must-include and in the requirements; Python, Java, Kafka
  // and AWS are in the requirements and named early. Docker, Terraform and
  // Kubernetes are only nice to have.
  assert.deepEqual([...top].sort(), ['AWS', 'Java', 'Kafka', 'PostgreSQL', 'Python']);
  assert.equal(top[0], 'PostgreSQL', 'must-include and required leads');

  // Requirements are read under several headings, up to the next heading.
  assert.equal(contract.requirementsText('About us\nWe ship.\nREQUIREMENTS\nGo and Rust\nBENEFITS\nSnacks'), 'Go and Rust');
  assert.equal(contract.requirementsText('Minimum qualifications: Go\n- Rust\nNice to have:\n- Zig'), 'Go\n- Rust');
  assert.equal(
    contract.requirementsText("What you'll need\n- Experience with one of the following:\n- Go\n- Rust\n## Perks\n- Zig"),
    '- Experience with one of the following:\n- Go\n- Rust'
  );

  // "Go" is matched as the posting spells it: "go" in prose is not Go.
  const goPosting = 'Requirements\n- Rust\nWe go fast and go far, go go go.';
  const goTop = contract.pickTopSkills(analysis({ technologies: ['Go', 'Rust'], skills: { technical: [], tools: [], soft: [] }, protocols: [], keywords: {} }, goPosting));
  assert.deepEqual(goTop, ['Rust', 'Go']);

  // Fewer than five named products: the must-include terms, then the
  // abilities, top it up.
  const few = contract.pickTopSkills(
    analysis({ technologies: ['Rust'], skills: { technical: ['API design', 'code review'], tools: [], soft: [] }, protocols: [], keywords: { mustInclude: ['Rust', 'on-call'] } }, 'Rust, on-call, API design and code review.')
  );
  assert.deepEqual(few, ['Rust', 'on-call', 'API design', 'code review']);
});

test('an older analysis is read the same way: its duplicate lists once, its infinitive verbs left out', () => {
  // A posting is analysed once, ever: most resumes are tailored from an
  // analysis the older prompt wrote.
  const older = {
    jobMeta: { title: 'Staff Engineer', seniority: 'Staff', industry: 'Fintech', department: 'Platform' },
    skills: { technical: ['C#'], required: ['C#', 'Python'], preferred: ['Go'], tools: ['Docker'], soft: ['Communication'], technologies: ['Azure'] },
    technologies: ['Azure', 'Kafka'],
    protocols: ['gRPC'],
    methodologies: ['Scrum'],
    architecturePatterns: ['Microservices'],
    responsibilities: ['Own the platform'],
    domainKnowledge: ['Payments'],
    softSkills: ['Communication'],
    keywords: { actionVerbs: ['led', 'build'], buzzwords: ['cloud-native'], mustInclude: ['C#'] },
    sourceJobDescription: 'Staff Engineer. C#, Python, Azure, Kafka and Docker.',
  };
  const values = resumeService.buildTailorResumePromptValues(profile(), older);
  assert.deepEqual(JSON.parse(values.skillsJSON), ['C#', 'Python', 'Docker', 'Azure', 'Kafka', 'gRPC']);
  assert.deepEqual(JSON.parse(values.keywordsJson), ['Communication']);
  assert.deepEqual(JSON.parse(values.conceptKeywordsJson), ['Microservices', 'Scrum', 'cloud-native']);
});

/* ============================================================= the draws */

test('concept tools: the rows the posting names, spelled as it spells them, their tools shuffled per resume', () => {
  const rows = (id) => JSON.parse(resumeService.buildTailorResumePromptValues(profile({ id }), analysis()).conceptToolsJson);
  const ada = rows('p-ada');
  // In the order the posting's terms name them - a responsibility can name
  // one ("incident response" out of "incident response ownership").
  assert.deepEqual(
    ada.map((row) => row.concept),
    ['CI/CD', 'microservices', 'event-driven', 'observability', 'data pipeline', 'incident response']
  );
  const table = new Map(CONCEPT_TOOLS.map((row) => [row.concept, row.tools]));
  assert.deepEqual([...ada[0].tools].sort(), [...table.get('CI/CD')].sort(), 'the same tools, in a drawn order');
  assert.deepEqual(rows('p-ada'), ada, 'the same resume draws the same');
  const others = ['p-bea', 'p-cy', 'p-dee', 'p-eve', 'p-fay'].map(rows);
  assert.ok(
    others.some((other) => JSON.stringify(other) !== JSON.stringify(ada)),
    'another candidate on the same posting draws another order'
  );
  // Matched as whole words: "ci" inside a word is no CI/CD, and a short alias keeps its case.
  assert.deepEqual(conceptRowsFor(['specific services']), []);
  assert.deepEqual(conceptRowsFor(['ML']).map((row) => row.concept), ['ML']);
  assert.deepEqual(conceptRowsFor(['html email']), []);
  // "Search Engine Optimization" and "search engine marketing" are not search
  // infrastructure: an SEO posting is never sent Elasticsearch and Solr.
  assert.deepEqual(conceptRowsFor(['Search Engine Optimization', 'SEO', 'search engine marketing']), []);
  assert.deepEqual(conceptRowsFor(['full-text search']).map((row) => row.concept), ['full-text search']);
  assert.ok(conceptRowsFor(['full-text search'])[0].tools.includes('Elasticsearch'));
});

test("the soft-skill heading is one of the six, the same for the same resume, and not every candidate's", () => {
  const heading = (id) => resumeService.buildTailorResumePromptValues(profile({ id }), analysis()).softSkillGroupHeading;
  const drawn = new Set();
  for (let index = 0; index < 60; index += 1) drawn.add(heading(`p-${index}`));
  assert.deepEqual([...drawn].sort(), [...SOFT_SKILL_GROUP_HEADINGS].sort(), 'every heading is drawn for someone');
  assert.equal(heading('p-7'), heading('p-7'));
  // Seeded by the posting too: the same candidate on another posting may draw another.
  const seeds = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((letter) =>
    contract.drawSoftSkillGroupHeading(contract.tailorSeed('p-7', { sourceJobDescription: `Posting ${letter}` }))
  ));
  assert.ok(seeds.size > 1);
});

/* ============================================================= the title */

test('the title: the profile headline with the kind of role composed on, in one of six shapes', () => {
  assert.equal(contract.roleKind('Senior Data & AI Engineer - AWS, Java & Python'), 'Data & AI Engineer');
  assert.equal(contract.roleKind('Sr. Site Reliability Engineer II (Remote)'), 'Site Reliability Engineer');
  assert.equal(contract.roleKind('Staff Backend Engineer | Payments'), 'Backend Engineer');
  assert.equal(contract.roleKind('Mid-level QA Engineer: platform'), 'QA Engineer');
  // A level is a modifier at the edges, never the role noun inside the title:
  // "Tech Lead" is a kind of role, "Tech" is not.
  assert.equal(contract.roleKind('Tech Lead'), 'Tech Lead');
  assert.equal(contract.roleKind('Team Lead, Payments'), 'Team Lead');
  assert.equal(contract.roleKind('Senior Tech Lead'), 'Tech Lead');
  assert.equal(contract.roleKind('Engineering Lead'), 'Engineering Lead');
  assert.equal(contract.roleKind('Associate Product Manager'), 'Product Manager');
  assert.equal(contract.roleKind('Senior/Staff Platform Engineer'), 'Platform Engineer');
  assert.equal(contract.roleKind('Software Engineer I/II'), 'Software Engineer');
  assert.equal(contract.roleKind('Data Engineer 3'), 'Data Engineer');
  assert.equal(contract.roleKind('Staffing Coordinator'), 'Staffing Coordinator', 'a word that only starts like a level');
  assert.equal(contract.roleKind('AI Engineer'), 'AI Engineer');
  assert.equal(contract.roleKind('Senior Lead'), '', 'nothing but a level: no kind');
  for (let index = 0; index < 40; index += 1) {
    assert.match(contract.composeTailoredTitle('Senior Software Engineer', 'Tech Lead', `seed-${index}`), /\bTech Lead\)?$/);
  }

  assert.equal(contract.titleSaysKind('Senior Software Engineer', 'Software Engineer'), true);
  assert.equal(contract.titleSaysKind('Senior Software Engineer', 'Cloud Engineer'), false);
  assert.equal(contract.titleSaysKind('ML Platform Engineer', 'AI/ML Engineer'), false, 'AI is a word of the kind');

  const shapes = new Set();
  for (let index = 0; index < 80; index += 1) {
    shapes.add(contract.composeTailoredTitle('Senior Software Engineer', 'Cloud Engineer', `seed-${index}`));
  }
  assert.deepEqual([...shapes].sort(), [
    'Senior Software Engineer & Cloud Engineer',
    'Senior Software Engineer (Cloud Engineer)',
    'Senior Software Engineer, Cloud Engineer',
    'Senior Software Engineer / Cloud Engineer',
    'Senior Software Engineer | Cloud Engineer',
    'Senior Software Engineer · Cloud Engineer',
  ].sort());
  // Left alone when the headline already says it.
  assert.equal(contract.composeTailoredTitle('Senior Software Engineer', 'Senior Software Engineer II', 'x'), 'Senior Software Engineer');
  // With no headline to compose onto, none: the kind alone would be the posting's title.
  assert.equal(contract.composeTailoredTitle('', 'Senior Site Reliability Engineer', 'x'), '');
  assert.equal(contract.composeTailoredTitle('  ', 'Senior Site Reliability Engineer', 'x'), '');

  // Through the parse: the profile's headline is the base, whatever the model wrote.
  const parse = (extra = {}, answer = {}) =>
    resumeService.parseTailoredResumeContent(JSON.stringify({ title: 'Data Wizard', summary: 'S.', ...answer }), profile(extra), analysis());
  const titled = parse();
  assert.match(titled.title, /^Senior Software Engineer\W+Data & AI Engineer\)?$/);
  assert.equal(parse().title, titled.title, 'the same shape for the same resume');
  // With no headline of their own, the model's is the base.
  assert.match(parse({ title: '' }).title, /^Data Wizard\W+Data & AI Engineer\)?$/);
  // Re-parsed, nothing is appended twice.
  assert.equal(
    resumeService.parseTailoredResumeContent(JSON.stringify(parse({ title: '' })), profile({ title: '' }), analysis()).title,
    parse({ title: '' }).title
  );
  // No headline of their own and none from the model: their latest role's
  // title is the base (the render's own fallback), never the posting's kind alone.
  const untitled = parse({ title: '' }, { title: '' });
  assert.match(untitled.title, /^Senior Engineer\W+Data & AI Engineer\)?$/);
  assert.notEqual(untitled.title, 'Data & AI Engineer');
  assert.equal(
    resumeService.parseTailoredResumeContent(JSON.stringify(untitled), profile({ title: '' }), analysis()).title,
    untitled.title,
    'and a re-parse keeps it'
  );
  // Nothing at all to say who they are: no headline, and the render prints its own fallback.
  assert.equal(parse({ title: '', experience: [] }, { title: '' }).title, '');
});

/* ============================================================= the roles */

test("roles: the model's order, the profile's facts, a stranger dropped, an omitted one put back, no description", () => {
  const answer = {
    summary: 'S.',
    experience: [
      // Gamma first (the model's order is kept), its facts edited.
      { title: 'junior engineer', company: 'GAMMA', startDate: '2001', endDate: 'now', location: 'Mars', description: 'Gamma is a company.', achievements: ['Wrote the billing reports in Python.'] },
      // A company the profile never had.
      { title: 'CTO', company: 'Imaginary Corp', achievements: ['Invented it.'] },
      // Acme, matched by company alone (its title differs and it is unique).
      { title: 'Principal Engineer', company: 'Acme', achievements: ['Rebuilt the ledger on PostgreSQL.'] },
    ],
  };
  const parsed = resumeService.parseTailoredResumeContent(JSON.stringify(answer), profile(), analysis());
  assert.deepEqual(
    parsed.experience.map((role) => [role.company, role.title, role.startDate, role.location]),
    [
      ['Gamma', 'Junior Engineer', '01/2016', 'Paris'],
      ['Acme', 'Senior Engineer', '01/2022', 'Remote'],
      // Beta was left out: put back after the nearest role before it in the
      // profile (Acme), with its own bullets.
      ['Beta', 'Engineer', '01/2019', 'Berlin'],
    ]
  );
  assert.deepEqual(parsed.experience[2].achievements, ['Ran the Kafka cluster.']);
  for (const role of parsed.experience) assert.equal(role.description, '');
  assert.equal(JSON.stringify(parsed).includes('Imaginary'), false);

  // Two stints at one company under one title stay apart, in order.
  const twice = profile({
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '2022', endDate: 'Now', location: '', description: '', achievements: ['Second stint.'], skills: [] },
      { title: 'Engineer', company: 'Acme', startDate: '2018', endDate: '2020', location: '', description: '', achievements: ['First stint.'], skills: [] },
    ],
  });
  const both = resumeService.parseTailoredResumeContent(
    JSON.stringify({ experience: [{ title: 'Engineer', company: 'Acme', achievements: ['A.'] }, { title: 'Engineer', company: 'Acme', achievements: ['B.'] }] }),
    twice,
    analysis()
  );
  assert.deepEqual(both.experience.map((role) => [role.startDate, role.achievements[0]]), [['2022', 'A.'], ['2018', 'B.']]);

  // A profile typed oldest first, answered newest first as the prompt asks:
  // each stint is known by the dates the model was given, so its bullets stay
  // under its own dates - and the model's order is kept.
  const oldestFirst = profile({
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '01/2016', endDate: '12/2018', location: 'Berlin', description: '', achievements: ['Old work.'], skills: [] },
      { title: 'Engineer', company: 'Acme', startDate: '01/2020', endDate: 'Present', location: 'Remote', description: '', achievements: ['Recent work.'], skills: [] },
    ],
  });
  const stints = (answered) =>
    resumeService.parseTailoredResumeContent(JSON.stringify({ summary: 'S.', experience: answered }), oldestFirst, analysis());
  const newestFirst = stints([
    { title: 'Engineer', company: 'Acme', startDate: '01/2020', endDate: 'Present', achievements: ['Recent tailored bullet with Kafka.'] },
    { title: 'Engineer', company: 'Acme', startDate: '01/2016', endDate: '12/2018', achievements: ['Old tailored bullet.'] },
  ]);
  const shape = (parsed) => parsed.experience.map((role) => [role.startDate, role.endDate, role.location, role.achievements]);
  assert.deepEqual(shape(newestFirst), [
    ['01/2020', 'Present', 'Remote', ['Recent tailored bullet with Kafka.']],
    ['01/2016', '12/2018', 'Berlin', ['Old tailored bullet.']],
  ]);
  // The same, its own output parsed again (a cache hit, held content).
  assert.deepEqual(shape(resumeService.parseTailoredResumeContent(JSON.stringify(newestFirst), oldestFirst, analysis())), shape(newestFirst));
  // The dates spelled another way still name the stint by its years, and an
  // end date alone decides when it is all that agrees.
  for (const answered of [
    [
      { title: 'Engineer', company: 'Acme', startDate: 'Jan 2020', endDate: 'now', achievements: ['R.'] },
      { title: 'Engineer', company: 'Acme', startDate: 'Jan 2016', achievements: ['O.'] },
    ],
    [
      { title: 'Engineer', company: 'Acme', endDate: 'present', achievements: ['R.'] },
      { title: 'Engineer', company: 'Acme', achievements: ['O.'] },
    ],
  ]) {
    assert.deepEqual(shape(stints(answered)).map((role) => [role[0], role[3][0]]), [['01/2020', 'R.'], ['01/2016', 'O.']]);
  }
  // No date at all agrees: profile order, as before.
  assert.deepEqual(
    shape(stints([
      { title: 'Engineer', company: 'Acme', achievements: ['First.'] },
      { title: 'Engineer', company: 'Acme', achievements: ['Second.'] },
    ])).map((role) => [role[0], role[3][0]]),
    [['01/2016', 'First.'], ['01/2020', 'Second.']]
  );
});

/* ============================================================== the cap */

test('eight bullets a role: the eight carrying the most distinct checklist terms, in their own order', () => {
  const bullets = [
    'Wrote a status page.',                                  // 0 terms
    'Ran Kafka on AWS with Python and Java.',                // 4
    'Fixed a typo.',                                         // 0
    'Moved PostgreSQL onto AWS.',                            // 2
    'Tuned a dashboard.',                                    // 0
    'Built REST services in Go.',                            // 2
    'Wrote CI/CD for Docker images on Kubernetes.',          // 3
    'Kept the lights on.',                                   // 0
    'Reviewed Terraform plans in code review.',              // 2
    'Answered tickets.',                                     // 0
    'Mentored two people.',                                  // 0
  ];
  const checklist = ['Kafka', 'AWS', 'Python', 'Java', 'PostgreSQL', 'REST', 'Go', 'CI/CD', 'Docker', 'Kubernetes', 'Terraform', 'code review'];
  const kept = contract.capBullets(bullets, checklist);
  assert.equal(kept.length, 8);
  // The six that carry terms, then the two earliest of the rest; order kept.
  assert.deepEqual(kept, [bullets[0], bullets[1], bullets[2], bullets[3], bullets[5], bullets[6], bullets[8], bullets[4]].sort((a, b) => bullets.indexOf(a) - bullets.indexOf(b)));
  assert.deepEqual(contract.capBullets(kept, checklist), kept, 'eight or fewer is left as it is');

  // Through the parse, with the posting's own checklist.
  const parsed = resumeService.parseTailoredResumeContent(
    JSON.stringify({ experience: [{ title: 'Senior Engineer', company: 'Acme', achievements: bullets }] }),
    profile(),
    analysis()
  );
  assert.equal(parsed.experience[0].achievements.length, 8);
  assert.ok(parsed.experience[0].achievements.includes(bullets[1]));
  assert.equal(parsed.experience[0].achievements.includes(bullets[10]), false);
});

/* ============================================================= the text */

test('a spelled-out span of years is a numeral, and no em or en dash survives', () => {
  assert.equal(contract.numeralYears('Seven years of payments. Twelve-year veteran. One of two teams.'), '7 years of payments. 12-year veteran. One of two teams.');
  assert.equal(contract.numeralYears('Twenty years, seventeen years and a seven-year stint.'), '20 years, 17 years and a 7-year stint.');
  // A compound past twenty is left as written, never half a numeral ("Twenty-5").
  for (const text of [
    'Twenty-five years of payments work.',
    'twenty-two years',
    'Thirty-one years on call.',
    'forty-five-year career',
    'a twenty-five-year career',
    'Over twenty one years in payments.',
    'thirty five years',
    'Ninety\tnine years',
    'a hundred and five years',
  ]) {
    assert.equal(contract.numeralYears(text), text);
  }
  // A word that only stands before the number is no compound.
  assert.equal(contract.numeralYears('Over seven years, about twelve years, nearly twenty years.'), 'Over 7 years, about 12 years, nearly 20 years.');
  assert.equal(contract.numeralYears('A hundred teams over five years.'), 'A hundred teams over 5 years.');
  // Both ends of a range at once: never "two or 3 years".
  assert.equal(contract.numeralYears('Two or three years of Go, five to seven years of Java.'), '2 or 3 years of Go, 5 to 7 years of Java.');
  assert.equal(contract.dashBackstop('Built it — fast. 2019–2021 and 3 — 5 days.'), 'Built it, fast. 2019-2021 and 3-5 days.');
  assert.equal(contract.dashBackstop('A -- B, — C —.'), 'A, B, C.');
  assert.equal(contract.dashBackstop('First paragraph —\n\nSecond — and last.'), 'First paragraph\n\nSecond, and last.');
  assert.equal(contract.dashBackstop('x--y stays, so does a-b.'), 'x--y stays, so does a-b.');
  // A range is a range whatever stands next to its digits - a unit, a
  // currency, a quarter, a version: as a list it would say something else.
  assert.equal(contract.dashBackstop('Cut costs from $5M–$10M.'), 'Cut costs from $5M-$10M.');
  assert.equal(contract.dashBackstop('Q1–Q3 releases'), 'Q1-Q3 releases');
  assert.equal(contract.dashBackstop('Latency down 50% – 80%.'), 'Latency down 50%-80%.');
  assert.equal(contract.dashBackstop('10K—20K events, v2–v3, $5–$10M.'), '10K-20K events, v2-v3, $5-$10M.');
  // A dash with a word on either side is still no range.
  assert.equal(contract.dashBackstop('Built it — fast, in 2020 — after the merger.'), 'Built it, fast, in 2020, after the merger.');
  assert.equal(contract.dashBackstop('Ran 3 services — Kafka included.'), 'Ran 3 services, Kafka included.');
  for (const text of ['Cut costs from $5M–$10M — twice.', 'Q1 – Q3 — and Q4.']) {
    const once = contract.dashBackstop(text);
    assert.equal(contract.dashBackstop(once), once, 'idempotent');
    assert.doesNotMatch(once, /[–—]/);
  }

  const parsed = resumeService.parseTailoredResumeContent(
    JSON.stringify({
      summary: 'Seven years of data work — mostly payments.',
      experience: [{ title: 'Senior Engineer', company: 'Acme', achievements: ['Cut settlement from 9s – 1.4s — twice.'] }],
      coverLetter: 'I build ledgers — carefully.\n\nI also — rarely — rest.',
    }),
    // A role the answer left out is put back with the profile's own bullets,
    // finished the same way: a range the person typed stays a range.
    profile({
      experience: profile().experience.map((role) =>
        role.company === 'Beta' ? { ...role, achievements: ['Cut latency 50%–80% on search.'] } : role
      ),
    }),
    analysis()
  );
  assert.equal(parsed.summary, '7 years of data work, mostly payments.');
  assert.equal(parsed.experience[0].achievements[0], 'Cut settlement from 9s-1.4s, twice.');
  assert.deepEqual(parsed.experience.find((role) => role.company === 'Beta').achievements, ['Cut latency 50%-80% on search.']);
  assert.equal(parsed.coverLetter, 'I build ledgers, carefully.\n\nI also, rarely, rest.');
});

test("the cover letter written on its own has its dashes taken out too, and is kept as the model wrote it", async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { staticDir } = useTempStorage('tailor-contract-letter');
  fs.mkdirSync(path.join(staticDir, 'prompts'), { recursive: true });
  fs.writeFileSync(
    path.join(staticDir, 'prompts', 'generate-cover-letter.json'),
    JSON.stringify({ id: 'generate-cover-letter', content: 'Write.\n[[profileJson]] [[companyName]] [[role]]', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
  );
  const { loadFresh } = require('./helpers');
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: { id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4 },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      return { text: 'I build — and ship.', resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));
  const service = loadFresh('../dist/services/resumeService');
  const letter = await service.generateCoverLetter(profile(), 'Acme', 'Engineer', { provider: 'claude-cli', modelName: 'sonnet', modelId: 'm', modelLabel: 'S' });
  assert.equal(letter, 'I build, and ship.');
  ai.resetRegistryForTests();
});

/* ============================================================ the block */

test('the soft-skill group is found by its mark, the drawn heading, or a soft heading last - never a technical group', () => {
  const values = resumeService.buildTailorResumePromptValues(profile(), analysis());
  const drawn = values.softSkillGroupHeading;
  const parse = (groups, settings = {}) =>
    resumeService.parseTailoredResumeContent(JSON.stringify({ skillGroups: groups }), profile({ profileSettings: settings }), analysis());
  const ON = { includeSoftSkills: true };

  // The drawn heading, wherever it sits.
  const named = parse([{ category: drawn, skills: ['Ownership'] }, { category: 'Languages', skills: ['Go'] }], ON);
  assert.deepEqual(named.softSkills, ['Ownership']);
  assert.equal(named.skillGroups[0].soft, true);
  assert.equal(named.softSkillGroupHeading, drawn);
  // A soft heading of the list, last, when the model wrote another of them.
  const other = SOFT_SKILL_GROUP_HEADINGS.find((heading) => heading !== drawn);
  assert.deepEqual(parse([{ category: 'Languages', skills: ['Go'] }, { category: other, skills: ['Ownership'] }], ON).softSkills, ['Ownership']);
  // A technical group last is never the soft one.
  const none = parse([{ category: 'Languages', skills: ['Go'] }, { category: 'Cloud', skills: ['AWS'] }], ON);
  assert.deepEqual(none.softSkills, []);
  assert.deepEqual(none.hardSkills, ['Go', 'AWS']);
  assert.equal(none.skillGroups.some((group) => group.soft), false);
  // The mark survives the person renaming the group in the builder's JSON box.
  const renamed = { ...named, skillGroups: named.skillGroups.map((group) => (group.soft ? { ...group, category: 'People' } : group)) };
  assert.deepEqual(resumeService.parseTailoredResumeContent(JSON.stringify(renamed), profile({ profileSettings: ON }), analysis()).softSkills, ['Ownership']);
});

/* ======================================================= idempotence */

test('the parse is idempotent on its own output, for every profile shape', () => {
  const answer = JSON.stringify({
    title: 'Data Engineer',
    summary: 'Seven years — payments. This background maps to the target role.',
    experience: [
      { title: 'Senior Engineer', company: 'Acme', description: 'x', achievements: Array.from({ length: 11 }, (_, index) => `Bullet ${index} with ${index % 3 ? 'Kafka and AWS' : 'nothing'} — ok`) },
      { title: 'Nobody', company: 'Nowhere', achievements: ['x'] },
    ],
    skillGroups: [{ category: 'Languages', skills: ['Python', ' Java '] }, { category: 'Soft Skills', skills: ['Ownership'] }],
    strengths: [{ title: 'Model', description: 'Not read.' }],
    coverLetter: 'I build — things.',
  });
  for (const settings of [{}, { includeSoftSkills: true, includeStrengths: true, technicalSkillsLayout: 'flat' }]) {
    for (const extra of [{}, { title: '' }, { experience: [] }, { skillCategories: [{ category: 'Web', skills: ['React'] }] }]) {
      const who = profile({ ...extra, profileSettings: settings });
      const once = resumeService.parseTailoredResumeContent(answer, who, analysis());
      const twice = resumeService.parseTailoredResumeContent(JSON.stringify(once), who, analysis());
      assert.deepEqual(twice, once, JSON.stringify({ settings, extra }));
    }
  }
});

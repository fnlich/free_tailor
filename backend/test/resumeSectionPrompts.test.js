const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * The profile's section choices, from the prompt to the tailored content.
 *
 * Three choices decide what a tailored resume holds besides its prose:
 * whether it has a Strengths section, whether the posting's soft skills get a
 * Soft Skills section of their own, and whether its technical skills are
 * grouped or plain. None of them is a prompt variable any more. The model
 * writes the same answer either way - its Technical Skills block in groups,
 * the posting's soft skills last - and the choices decide how that answer is
 * DRAWN: the soft-skill group in its section or in the block, the profile's
 * own strengths or none. The one way a switch reaches the model is the
 * profile's strengths, sent in `profileJson` only while Strengths is on.
 *
 * Run against the shipped skill library in temp storage, to show it plays no
 * part: nothing is padded, filled or confirmed from it.
 */

const storage = useTempStorage('resume-section-prompts');
const shipped = path.join(__dirname, '..', 'static');
fs.cpSync(path.join(shipped, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });

const resumeService = require('../dist/services/resumeService');
const { buildTailorResumePromptValues, parseJobAnalysisKeywords, parseTailoredResumeContent } = resumeService;

const POSTING = [
  'We are hiring a senior engineer to ship TypeScript services packaged with Docker.',
  'You are Adaptable and bring strong Communication to a small team.',
].join('\n');

function analysis(posting = POSTING, skills = ['TypeScript', 'Docker']) {
  return parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: 'SaaS', department: 'Engineering' },
      skills: { technical: skills, tools: [], soft: ['Adaptable', 'Communication'] },
      responsibilities: ['container build pipeline delivery', 'service reliability ownership'],
      domainKnowledge: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    }),
    posting
  );
}

function profile(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'Jane Smith',
    title: 'Senior Engineer',
    contact: { email: 'jane@example.com', phone: '1', location: 'Remote' },
    summary: 'Engineer who ships.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Built product services.',
        achievements: ['Cut build time by 37%.'],
        skills: [],
      },
    ],
    strengths: [{ title: 'Own strength', description: 'In her own words.' }],
    skills: ['TypeScript', 'React', 'Kubernetes', 'Figma'],
    softSkills: ['Persistence', 'Clear written communication'],
    education: [],
    profileSettings: settings,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** What the shipped prompt answers: the block in groups, the posting's soft skills last. */
const SOFT_GROUP = { category: 'Professional Skills', skills: ['Adaptable', 'Communication'] };

/** What a model answers - with the fields an older prompt record still asks for, which are not read. */
function modelAnswer(extra = {}) {
  return JSON.stringify({
    title: 'Senior Engineer',
    summary: 'Engineer building reliable services.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: '',
        achievements: ['Cut build time by 37% by caching container layers.'],
      },
    ],
    skillGroups: [
      { category: 'Languages', skills: ['TypeScript', 'Go'] },
      { category: 'Containers', skills: ['Docker', 'Kubernetes'] },
      SOFT_GROUP,
    ],
    hardSkills: ['Model Pick'],
    softSkills: ['Model Soft'],
    strengths: [{ title: 'Model strength', description: 'Shipped container builds that stayed fast.' }],
    coverLetter: 'I build things.',
    ...extra,
  });
}

const ON = { includeStrengths: true, includeSoftSkills: true };

/* ------------------------------------------------------------ prompt values */

test('no section choice is a prompt value; the strengths travel in profileJson only while switched on', () => {
  const off = buildTailorResumePromptValues(profile(), analysis());
  const on = buildTailorResumePromptValues(profile({ ...ON, technicalSkillsLayout: 'flat' }), analysis());
  for (const name of ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout']) {
    assert.equal(name in off, false, name);
  }
  assert.equal('strengths' in JSON.parse(off.profileJson), false);
  assert.deepEqual(JSON.parse(on.profileJson).strengths, [{ title: 'Own strength', description: 'In her own words.' }]);
  // Everything else is the same question.
  assert.deepEqual({ ...on, profileJson: '' }, { ...off, profileJson: '' });
  // The person's own soft skills are never sent, switched on or not.
  assert.doesNotMatch(on.profileJson, /Persistence|Clear written communication/);
  assert.equal('profileSettings' in JSON.parse(on.profileJson), false);
});

test("the shipped prompt names the soft-skill group's heading, which is drawn per resume", () => {
  const record = JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', 'tailor-resume.json'), 'utf8'));
  const { extractPromptVariables } = require('../dist/services/promptService');
  const variables = extractPromptVariables(record.content);
  // profileJson first, so the opening rules are the cacheable prefix.
  assert.equal(variables[0], 'profileJson');
  assert.match(record.content, /THE LAST GROUP IS THE POSTING'S OWN SOFT SKILLS\. Head it exactly \[\[softSkillGroupHeading\]\]/);
  assert.match(record.content, /"skillGroups": \[/);
  assert.match(record.content, /Description: leave it EMPTY/);

  const { SOFT_SKILL_GROUP_HEADINGS } = require('../dist/services/skillGroups');
  const heading = buildTailorResumePromptValues(profile(), analysis()).softSkillGroupHeading;
  assert.ok(SOFT_SKILL_GROUP_HEADINGS.includes(heading), heading);
  assert.equal(buildTailorResumePromptValues(profile(), analysis()).softSkillGroupHeading, heading, 'the same resume draws the same');
});

/* -------------------------------------------------------- the content, by switch */

test('Strengths: the profile\'s own while switched on, none while off, whatever the model wrote', () => {
  assert.deepEqual(parseTailoredResumeContent(modelAnswer(), profile(), analysis()).strengths, []);
  assert.deepEqual(parseTailoredResumeContent(modelAnswer(), profile(ON), analysis()).strengths, [
    { title: 'Own strength', description: 'In her own words.' },
  ]);
  // Untitled ones too, verbatim; and a strength with nothing in it is not one.
  const own = [
    { title: 'Calm under pressure', description: 'Keeps incidents short and boring' },
    { title: '', description: 'A strength she only described.' },
    { title: ' ', description: '' },
  ];
  assert.deepEqual(parseTailoredResumeContent(modelAnswer(), profile(ON, { strengths: own }), analysis()).strengths, own.slice(0, 2));
});

test("Soft Skills on: the soft group is the section's; off: it stays the last group of the block", () => {
  const on = parseTailoredResumeContent(modelAnswer(), profile(ON), analysis());
  assert.deepEqual(on.softSkills, ['Adaptable', 'Communication']);
  assert.deepEqual(on.hardSkills, ['TypeScript', 'Go', 'Docker', 'Kubernetes'], 'and out of the technical list');

  const off = parseTailoredResumeContent(modelAnswer(), profile(), analysis());
  assert.deepEqual(off.softSkills, []);
  assert.deepEqual(off.hardSkills, ['TypeScript', 'Go', 'Docker', 'Kubernetes']);
  // Either way the groups are the model's, the soft one marked so the render
  // and a re-parse find the same group.
  for (const content of [on, off]) {
    assert.deepEqual(content.skillGroups, [
      { category: 'Languages', skills: ['TypeScript', 'Go'] },
      { category: 'Containers', skills: ['Docker', 'Kubernetes'] },
      { ...SOFT_GROUP, soft: true },
    ]);
    // The model's soft list and strengths are not read, nor its hardSkills.
    assert.equal(JSON.stringify(content).includes('Model Soft'), false);
    assert.equal(content.hardSkills.includes('Model Pick'), false);
  }
  // And nothing is added to the summary: no "Working style:" sentence.
  assert.equal(off.summary, 'Engineer building reliable services.');
});

test('Grouped or Plain gives the same content: the layout is decided when the resume is drawn', () => {
  const grouped = parseTailoredResumeContent(modelAnswer(), profile(ON), analysis());
  const plain = parseTailoredResumeContent(modelAnswer(), profile({ ...ON, technicalSkillsLayout: 'flat' }), analysis());
  assert.deepEqual(plain, grouped);
});

test('content tailored before a switch is finished for the profile as it is now, and a second pass changes nothing', () => {
  const before = parseTailoredResumeContent(modelAnswer(), profile(), analysis());
  assert.deepEqual(parseTailoredResumeContent(JSON.stringify(before), profile(), analysis()), before);

  // The person switches both on, then generates from the preview they hold.
  const after = parseTailoredResumeContent(JSON.stringify(before), profile(ON), analysis());
  assert.deepEqual(after.softSkills, ['Adaptable', 'Communication']);
  assert.deepEqual(after.strengths, [{ title: 'Own strength', description: 'In her own words.' }]);
  assert.deepEqual(after.skillGroups, before.skillGroups);
  assert.equal(after.title, before.title);
  assert.equal(after.summary, before.summary);
  assert.deepEqual(after.experience, before.experience);
});

test('a queued resume finishes held content the same way - with no model call - and renders it as sent if it cannot', () => {
  const { __finaliseHeldContentForTests: finalise } = require('../dist/services/queue/resumeTask');
  const held = parseTailoredResumeContent(modelAnswer(), profile(), analysis());

  const finished = finalise(held, profile(ON), analysis());
  assert.deepEqual(finished, parseTailoredResumeContent(JSON.stringify(held), profile(ON), analysis()));
  assert.deepEqual(finished.softSkills, ['Adaptable', 'Communication']);

  // Paid-for content is never failed over this step: the render gate still
  // holds the switches for it.
  const odd = 'not an object at all';
  assert.equal(finalise(odd, profile(), analysis()), odd);
});

test('an answer with no skill groups - an older prompt record - falls back to her own skills, never an empty block', () => {
  const noGroups = { skillGroups: undefined };
  const own = parseTailoredResumeContent(modelAnswer(noGroups), profile(), analysis());
  assert.deepEqual(own.skillGroups, [{ category: '', skills: ['TypeScript', 'React', 'Kubernetes', 'Figma'] }]);
  assert.deepEqual(own.hardSkills, ['TypeScript', 'React', 'Kubernetes', 'Figma']);

  // Her own grouping, as she typed it, when she has one.
  const grouped = parseTailoredResumeContent(
    modelAnswer(noGroups),
    profile({}, { skillCategories: [{ category: 'Web', skills: ['React'] }, { category: 'Ops', skills: ['Kubernetes'] }] }),
    analysis()
  );
  assert.deepEqual(grouped.skillGroups, [
    { category: 'Web', skills: ['React'] },
    { category: 'Ops', skills: ['Kubernetes'] },
  ]);
});

test('a switch the template has no section for reads as off, for the content', () => {
  const { profileForTemplate } = require('../dist/services/profileService');
  const template = (id) =>
    JSON.parse(fs.readFileSync(path.join(shipped, 'templates', `${id}.json`), 'utf8'));
  const on = profile(ON);

  // Charcoal Sidebar prints neither section: no strengths, and the soft group
  // stays in the skills block rather than going to a list that never prints.
  const charcoal = profileForTemplate(on, template('charcoal-sidebar'));
  const parsed = parseTailoredResumeContent(modelAnswer(), charcoal, analysis());
  assert.deepEqual(parsed.strengths, []);
  assert.deepEqual(parsed.softSkills, []);
  assert.equal(parsed.skillGroups.at(-1).category, 'Professional Skills');
  assert.equal(on.profileSettings.includeStrengths, true, 'the profile itself is not changed');
  // Off for the model too: her strengths are not sent for a template that cannot print them.
  assert.equal('strengths' in JSON.parse(buildTailorResumePromptValues(charcoal, analysis()).profileJson), false);

  // Ink Ledger prints Strengths but not Soft Skills.
  const ink = parseTailoredResumeContent(modelAnswer(), profileForTemplate(on, template('ink-ledger')), analysis());
  assert.deepEqual(ink.strengths, [{ title: 'Own strength', description: 'In her own words.' }]);
  assert.deepEqual(ink.softSkills, []);

  // A template with both sections, or no template at all, changes nothing.
  assert.equal(profileForTemplate(on, template('default')), on);
  assert.equal(profileForTemplate(on, null), on);
});

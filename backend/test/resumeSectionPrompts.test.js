const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * The profile's section choices, from the prompt to the tailored content.
 *
 * Three facts decide what a tailored resume holds besides its prose: whether
 * it has a Strengths section, whether it has a Soft Skills section, and
 * whether its technical skills are grouped or plain. They reach the model
 * twice - as `[[includeStrengths]]`, `[[includeSoftSkills]]` and
 * `[[technicalSkillsLayout]]` for the shipped prompt, and in the override
 * appended to EVERY tailoring turn, for a prompt an administrator wrote before
 * the switches existed - and the code enforces them a third time when it reads
 * the answer, whatever the model did.
 *
 * Run against the shipped skill library in temp storage: what counts as
 * "library padding" or a "related" skill is the library's to say.
 */

const storage = useTempStorage('resume-section-prompts');
const shipped = path.join(__dirname, '..', 'static');
fs.cpSync(path.join(shipped, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });

const resumeService = require('../dist/services/resumeService');
const {
  buildFinalSkillOverride,
  buildResumeSectionPromptValues,
  buildTailorResumePromptValues,
  parseJobAnalysisContent,
  parseTailoredResumeContent,
} = resumeService;
const { supplimentSoftSkills } = require('../dist/services/utils/config');

const POSTING = [
  'We are hiring a senior engineer to ship TypeScript services packaged with Docker.',
  'You are Adaptable and bring strong Communication to a small team.',
].join('\n');

function analysis(posting = POSTING, skills = ['TypeScript', 'Docker']) {
  return parseJobAnalysisContent(
    JSON.stringify({
      jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: 'SaaS', department: 'Engineering' },
      skills: { technical: skills, tools: [], soft: [] },
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

/** What a model answers, strengths and all - an old prompt record still asks for them. */
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
        description: 'Built product services.',
        achievements: ['Cut build time by 37% by caching container layers.'],
      },
    ],
    hardSkills: ['Model Pick'],
    softSkills: ['Model Soft'],
    strengths: [
      { title: 'Model strength', description: 'Shipped container builds that stayed fast.' },
      { title: '', description: 'A strength with no name.' },
    ],
    coverLetter: 'I build things.',
    ...extra,
  });
}

const ON = { includeStrengths: true, includeSoftSkills: true };

/* ------------------------------------------------------------ prompt values */

test('the three section values travel as words, and never inside profileJson', () => {
  assert.deepEqual(buildResumeSectionPromptValues(profile()), {
    includeStrengths: 'no',
    includeSoftSkills: 'no',
    technicalSkillsLayout: 'grouped',
  });
  assert.deepEqual(buildResumeSectionPromptValues(profile({ ...ON, technicalSkillsLayout: 'flat' })), {
    includeStrengths: 'yes',
    includeSoftSkills: 'yes',
    technicalSkillsLayout: 'plain',
  });
  // Only a stored `true` is on: what every profile rendered before the switches.
  assert.equal(buildResumeSectionPromptValues(profile({ includeStrengths: 'yes' })).includeStrengths, 'no');
  assert.equal(buildResumeSectionPromptValues(undefined).technicalSkillsLayout, 'grouped');

  const values = buildTailorResumePromptValues(profile({ ...ON, technicalSkillsLayout: 'flat' }), analysis());
  assert.equal(values.includeStrengths, 'yes');
  assert.equal(values.includeSoftSkills, 'yes');
  assert.equal(values.technicalSkillsLayout, 'plain');
  const sent = JSON.parse(values.profileJson);
  assert.equal('profileSettings' in sent, false);
  assert.doesNotMatch(values.profileJson, /includeStrengths|includeSoftSkills|technicalSkillsLayout/);
});

test('switched-off Strengths are not given to the model at all, in tailoring or the cover letter', () => {
  const { buildCoverLetterPromptValues } = resumeService;

  // Off - the default, and what the person chose by unticking the box: the
  // strengths stay with the profile and reach no prompt.
  const off = buildTailorResumePromptValues(profile(), analysis());
  assert.equal('strengths' in JSON.parse(off.profileJson), false);
  assert.doesNotMatch(off.profileJson, /Own strength|In her own words/);
  const offLetter = buildCoverLetterPromptValues(profile(), 'Acme', 'Engineer');
  assert.doesNotMatch(offLetter.profileJson, /Own strength/);

  // On, they are context, as they always were.
  const on = buildTailorResumePromptValues(profile(ON), analysis());
  assert.deepEqual(JSON.parse(on.profileJson).strengths, [{ title: 'Own strength', description: 'In her own words.' }]);
  assert.match(buildCoverLetterPromptValues(profile(ON), 'Acme', 'Engineer').profileJson, /Own strength/);

  // Soft skills are never in the profile JSON either way: the code lists
  // them from the profile after the model has answered.
  for (const values of [off, on]) {
    assert.equal('softSkills' in JSON.parse(values.profileJson), false);
    assert.doesNotMatch(values.profileJson, /Persistence/);
  }

  // Everything else the model reads is the same bytes whichever way the
  // switch is set: only the strengths key comes and goes.
  const { strengths: _dropped, ...rest } = JSON.parse(on.profileJson);
  assert.deepEqual(JSON.parse(off.profileJson), rest);
});

test('the shipped tailor-resume prompt asks for the sections it is told about, and no longer for skills', () => {
  const text = JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', 'tailor-resume.json'), 'utf8')).content;
  const variables = [...text.matchAll(/\[\[\s*(\w+)\s*\]\]/g)].map((match) => match[1]);

  for (const name of ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout']) {
    assert.ok(variables.includes(name), `the prompt must reference [[${name}]]`);
  }
  // The literal text in front of the first variable is the cacheable
  // instruction prefix; the switches go after [[profileJson]] so it stays the
  // same bytes for every profile.
  assert.equal(variables[0], 'profileJson');
  const prefix = text.slice(0, text.indexOf('[[profileJson]]'));
  assert.doesNotMatch(prefix, /Strengths section|Soft skills section|layout/i);

  // The lines that contradicted the code-owned override are gone: the model is
  // never asked for a skills list the code then throws away.
  assert.doesNotMatch(text, /softSkills contains exactly/);
  assert.doesNotMatch(text, /hardSkills is chosen from/);
  assert.doesNotMatch(text, /"hardSkills": string\[\]/);
  assert.doesNotMatch(text, /"softSkills": string\[\]/);
  assert.doesNotMatch(text, /draw hardSkills/);

  // Strengths, and the overflow bucket, only when the section is on.
  assert.match(text, /When the Strengths section is no, return "strengths": \[\]/);
  assert.match(text, /When the Strengths section is yes, put it in STRENGTHS/);
  assert.match(text, /STRENGTHS \(only when the Strengths section is yes/);
});

/* ---------------------------------------------------------------- backstop */

test('the appended override says what the switches say, for any prompt record', () => {
  const off = buildFinalSkillOverride(profile());
  assert.match(off, /^FINAL SKILL OVERRIDE:/);
  assert.match(off, /Omit the fields "skills", "hardSkills", "softSkills"/);
  assert.match(off, /Strengths section: no\. Return "strengths": \[\]/);
  assert.match(off, /Strengths are not an overflow bucket/);
  assert.match(off, /Soft skills section: no\./);
  assert.match(off, /Technical skills layout: grouped\./);

  const on = buildFinalSkillOverride(profile({ ...ON, technicalSkillsLayout: 'flat' }));
  assert.match(on, /Strengths section: yes\. Return 2-4 "strengths" items/);
  assert.doesNotMatch(on, /Return "strengths": \[\]/);
  assert.match(on, /Soft skills section: yes\./);
  assert.match(on, /Technical skills layout: plain\./);

  // A profile with no settings and no strengths - an old row, a test fixture -
  // is the defaults, not an error.
  assert.match(buildFinalSkillOverride({ id: 'p', name: 'J', experience: [], skills: [], education: [] }), /Strengths section: no/);
});

/* --------------------------------------------------------------- strengths */

test('switched off, strengths are empty whatever the model returns, and nothing is invented', () => {
  const answered = parseTailoredResumeContent(modelAnswer(), profile(), analysis());
  assert.deepEqual(answered.strengths, []);

  // The analysis has responsibilities, which is what the old fallback turned
  // into "Core Strength 1: Demonstrated impact in ...".
  const silent = parseTailoredResumeContent(modelAnswer({ strengths: [] }), profile(), analysis());
  assert.deepEqual(silent.strengths, []);
  assert.doesNotMatch(JSON.stringify(silent), /Core Strength|Demonstrated impact/);
});

test("switched on, the model's strengths are kept, and the profile's own fill in when it wrote none", () => {
  const on = profile(ON);
  const answered = parseTailoredResumeContent(modelAnswer(), on, analysis());
  assert.equal(answered.strengths.length, 1, 'a strength with no name is dropped, not called "Core Strength 2"');
  assert.equal(answered.strengths[0].title, 'Model strength');
  assert.match(answered.strengths[0].description, /^Shipped container builds that stayed fast/);

  const silent = parseTailoredResumeContent(modelAnswer({ strengths: [] }), on, analysis());
  assert.deepEqual(silent.strengths, [{ title: 'Own strength', description: 'In her own words.' }]);

  const nothing = parseTailoredResumeContent(modelAnswer({ strengths: [] }), profile(ON, { strengths: [] }), analysis());
  assert.deepEqual(nothing.strengths, []);
  assert.doesNotMatch(JSON.stringify(nothing), /Core Strength|Demonstrated impact/);
});

test("a strength sentence written from the employer's side is dropped, not the whole strength", () => {
  const parsed = parseTailoredResumeContent(
    modelAnswer({
      strengths: [{ title: 'Delivery', description: 'Ships reliable services. You will join our platform team.' }],
    }),
    profile(ON),
    analysis()
  );
  assert.equal(parsed.strengths.length, 1);
  assert.match(parsed.strengths[0].description, /^Ships reliable services/);
  assert.doesNotMatch(parsed.strengths[0].description, /You will|our platform/);
});

/* ------------------------------------------------------------- soft skills */

test("switched off, no soft skills and nothing to confirm; the posting's go into the summary, not as Strengths", () => {
  const parsed = parseTailoredResumeContent(modelAnswer(), profile(), analysis());
  assert.deepEqual(parsed.softSkills, []);
  assert.deepEqual(parsed.unconfirmedSoftSkills, [], 'no confirm prompts for a section the resume does not show');
  assert.match(parsed.summary, /Working style: [^.]*\bAdaptable\b/);
  assert.doesNotMatch(parsed.summary, /Strengths include/);
});

test("switched on, the profile's own soft skills come first, and the stock list only fills an empty one", () => {
  const parsed = parseTailoredResumeContent(modelAnswer(), profile(ON), analysis());
  assert.deepEqual(parsed.softSkills.slice(0, 2), ['Persistence', 'Clear written communication']);
  assert.ok(parsed.softSkills.includes('Adaptable'), "the posting's library-confirmed soft skill follows");
  assert.equal(
    parsed.softSkills.includes('Communication'),
    false,
    'already said by her own "Clear written communication"'
  );
  const stock = supplimentSoftSkills.filter((skill) => !/adapt|communicat/i.test(skill));
  assert.deepEqual(parsed.softSkills.filter((skill) => stock.includes(skill)), [], 'no stock top-up over her own list');
  assert.doesNotMatch(parsed.summary, /Working style|Strengths include/, 'listed in the section, not stuffed in the summary');

  const none = parseTailoredResumeContent(modelAnswer(), profile(ON, { softSkills: [] }), analysis());
  assert.ok(none.softSkills.length >= 5, 'somebody who entered none still gets a section worth showing');

  const many = Array.from({ length: 12 }, (_, index) => `Own skill ${index + 1}`);
  const capped = parseTailoredResumeContent(modelAnswer(), profile(ON, { softSkills: many }), analysis());
  assert.deepEqual(capped.softSkills, many.slice(0, 10));
});

/* ------------------------------------------------------------ the layouts */

test('a plain list holds what the posting names and her related skills, never library padding', () => {
  const plain = parseTailoredResumeContent(modelAnswer(), profile({ technicalSkillsLayout: 'flat' }), analysis());
  const claimed = new Set(profile().skills.map((skill) => skill.toLowerCase()));
  const named = (skill) => new RegExp(`(?<![A-Za-z0-9])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(POSTING);

  for (const skill of plain.hardSkills) {
    assert.ok(named(skill) || claimed.has(skill.toLowerCase()), `${skill} is neither asked for nor claimed`);
  }
  assert.ok(plain.hardSkills.includes('TypeScript'));
  assert.ok(plain.hardSkills.includes('Docker'));
  assert.ok(plain.hardSkills.includes('Kubernetes'), 'claimed, and in the same area as Docker');
  assert.equal(plain.hardSkills.includes('Figma'), false, 'claimed, but nothing the posting is about');
  for (const padding of ['Java', 'Ruby on Rails', 'AWS Macie', 'Model Pick']) {
    assert.equal(plain.hardSkills.includes(padding), false, `${padding} must not appear`);
  }
  assert.deepEqual(plain.skills, plain.hardSkills);

  // Grouped is what it always was: the posting's skills plus the library's
  // headings filled out - which is exactly what plain must not do.
  const grouped = parseTailoredResumeContent(modelAnswer(), profile(), analysis());
  assert.ok(grouped.hardSkills.length > plain.hardSkills.length);
  assert.ok(grouped.hardSkills.some((skill) => !named(skill) && !claimed.has(skill.toLowerCase())));
});

test('the job-priority ordering keeps every skill, spelled as the library spells it', () => {
  const posting = 'We need Node.js, Next.js and React for our web platform.';
  const jobAnalysis = analysis(posting, ['Node.js', 'Next.js', 'React']);
  const owner = (settings) => profile(settings, { skills: ['Node.js', 'Vue.js'] });
  const sorted = (list) => [...list].sort();

  for (const layout of ['flat', 'categorized']) {
    const byLibrary = parseTailoredResumeContent(modelAnswer(), owner({ technicalSkillsLayout: layout }), jobAnalysis);
    const byJob = parseTailoredResumeContent(
      modelAnswer(),
      owner({ technicalSkillsLayout: layout, hardSkillOrdering: 'job-priority' }),
      jobAnalysis
    );
    assert.deepEqual(sorted(byJob.hardSkills), sorted(byLibrary.hardSkills), `${layout}: the ordering only orders`);
    for (const skill of ['Node.js', 'Next.js', 'React']) {
      assert.ok(byJob.hardSkills.includes(skill), `${layout}: ${skill} survives job-priority ordering`);
    }
    assert.equal(byJob.hardSkills.includes('React.js'), false);
  }
});

/* ------------------------------------------------- content held across a switch */

test('content tailored before a switch is finished for the profile as it is now', () => {
  const before = parseTailoredResumeContent(modelAnswer(), profile(), analysis());
  assert.equal((before.summary.match(/Working style/g) ?? []).length, 1);

  // Finishing the same content again changes nothing: the summary sentence is
  // added once, not once per pass.
  const again = parseTailoredResumeContent(JSON.stringify(before), profile(), analysis());
  assert.equal(again.summary, before.summary);
  assert.deepEqual(again.hardSkills, before.hardSkills);

  // The person flips everything, then generates from the preview they hold.
  const after = parseTailoredResumeContent(
    JSON.stringify(before),
    profile({ ...ON, technicalSkillsLayout: 'flat' }),
    analysis()
  );
  assert.ok(after.hardSkills.length < before.hardSkills.length, 'the grouped padding is gone');
  assert.deepEqual(after.softSkills.slice(0, 2), ['Persistence', 'Clear written communication']);
  assert.doesNotMatch(after.summary, /Working style/, 'the section carries them now');
  assert.deepEqual(after.strengths, [{ title: 'Own strength', description: 'In her own words.' }]);

  // A summary finished by the release before this one carries the old wording.
  const legacy = parseTailoredResumeContent(
    modelAnswer({ summary: 'Engineer building reliable services. Strengths include Adaptable across changing engineering contexts.' }),
    profile(),
    analysis()
  );
  assert.doesNotMatch(legacy.summary, /Strengths include/);
  assert.equal((legacy.summary.match(/Working style/g) ?? []).length, 1);
});

test('a queued resume finishes held content the same way, and renders it as sent if it cannot', () => {
  const { __finaliseHeldContentForTests: finalise } = require('../dist/services/queue/resumeTask');
  const held = parseTailoredResumeContent(modelAnswer(), profile(), analysis());

  const finished = finalise(held, profile({ ...ON, technicalSkillsLayout: 'flat' }), analysis());
  assert.deepEqual(
    finished,
    parseTailoredResumeContent(JSON.stringify(held), profile({ ...ON, technicalSkillsLayout: 'flat' }), analysis())
  );
  assert.deepEqual(finished.softSkills.slice(0, 1), ['Persistence']);

  // Paid-for content is never failed over this step: the render gate still
  // holds the switches for it.
  const odd = { ...held, experience: 'not a list' };
  assert.equal(finalise(odd, profile(), analysis()), odd);
});

test("the profile's own strengths survive a second pass exactly as typed, untitled ones too", () => {
  const { __finaliseHeldContentForTests: finalise } = require('../dist/services/queue/resumeTask');
  // A description naming no checklist keyword - the case the keyword
  // sentence was appended to - and one strength with no title.
  const own = [
    { title: 'Calm under pressure', description: 'Keeps incidents short and boring' },
    { title: '', description: 'A strength she only described.' },
  ];
  const on = profile(ON, { strengths: own });
  const first = parseTailoredResumeContent(modelAnswer({ strengths: [] }), on, analysis());
  assert.deepEqual(first.strengths, own, 'the fallback is her own, verbatim');

  // What /resume/generate, /resume/preview and the queue do with a preview
  // the page sends back: the resume must be the preview she approved.
  const second = parseTailoredResumeContent(JSON.stringify(first), on, analysis());
  assert.deepEqual(second.strengths, first.strengths);
  assert.deepEqual(finalise(first, on, analysis()).strengths, first.strengths);

  // The model's own strengths are still made safe and keyworded, and stay so.
  const written = parseTailoredResumeContent(modelAnswer(), on, analysis());
  assert.deepEqual(parseTailoredResumeContent(JSON.stringify(written), on, analysis()).strengths, written.strengths);
});

test('a plain list for a posting that names no known skill is her own skills, never an empty section', () => {
  const posting = 'Head of Operations for a family bakery. You will lead the morning shift and the supplier rota.';
  const bakery = analysis(posting, []);
  const plain = parseTailoredResumeContent(
    modelAnswer(),
    profile({ technicalSkillsLayout: 'flat' }, { skills: ['TypeScript', 'React', 'PostgreSQL', 'Not A Library Skill'] }),
    bakery
  );
  assert.deepEqual([...plain.hardSkills].sort(), ['PostgreSQL', 'React', 'TypeScript']);
  assert.deepEqual(plain.skills, plain.hardSkills);
});

test('a switch the template has no section for reads as off, for the prompt and the content', () => {
  const { profileForTemplate } = require('../dist/services/profileService');
  const template = (id) =>
    JSON.parse(fs.readFileSync(path.join(shipped, 'templates', `${id}.json`), 'utf8'));
  const on = profile(ON);

  const charcoal = profileForTemplate(on, template('charcoal-sidebar'));
  assert.deepEqual(buildResumeSectionPromptValues(charcoal), {
    includeStrengths: 'no',
    includeSoftSkills: 'no',
    technicalSkillsLayout: 'grouped',
  });
  assert.match(buildFinalSkillOverride(charcoal), /Strengths section: no\. Return "strengths": \[\]/);
  const parsed = parseTailoredResumeContent(modelAnswer(), charcoal, analysis());
  assert.deepEqual(parsed.strengths, []);
  assert.deepEqual(parsed.softSkills, []);
  assert.match(parsed.summary, /Working style: [^.]*\bAdaptable\b/, 'the keywords stay on the page');
  assert.equal(on.profileSettings.includeStrengths, true, 'the profile itself is not changed');

  // Ink Ledger prints Strengths but not Soft Skills.
  const ink = profileForTemplate(on, template('ink-ledger'));
  assert.equal(buildResumeSectionPromptValues(ink).includeStrengths, 'yes');
  assert.equal(buildResumeSectionPromptValues(ink).includeSoftSkills, 'no');

  // A template with both sections, or no template at all, changes nothing.
  assert.equal(profileForTemplate(on, template('default')), on);
  assert.equal(profileForTemplate(on, null), on);
});

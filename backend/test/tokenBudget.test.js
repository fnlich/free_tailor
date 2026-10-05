const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTailorResumePromptValues } = require('../dist/services/resumeService');

/**
 * What actually gets sent to the model.
 *
 * Two reasons to pin this rather than leave it to review. On a metered provider
 * every character is billed, and on a subscription seat every character counts
 * against the seat's usage allowance and lengthens the turn. And a `Profile`
 * grows fields over time - the projection is built by naming what goes in
 * precisely so a field added later is not sent to a model by default, and this
 * is what notices when that stops being true.
 */

function profileFixture(extra = {}) {
  const role = (index) => ({
    title: `Senior Engineer ${index}`,
    company: `Company ${index}`,
    startDate: '2020-01',
    endDate: '2023-01',
    location: 'Remote',
    description: 'A paragraph describing the role in some detail. '.repeat(6),
    achievements: ['Cut latency by 40%', 'Led a team of six', 'Shipped the billing rewrite'],
    skills: ['C#', 'Python', 'Azure'],
  });
  return {
    id: 'profile-1',
    name: 'A Person',
    title: 'Staff Engineer',
    totalYearsExperience: 12,
    contact: {
      email: 'a.person@example.com',
      phone: '+1 555 0100',
      location: 'Remote',
      linkedin: 'https://linkedin.com/in/aperson',
      github: 'https://github.com/aperson',
      portfolio: '',
    },
    summary: 'A professional summary. '.repeat(12),
    experience: [role(1), role(2), role(3), role(4), role(5)],
    strengths: [{ title: 'Ownership', description: 'Takes things end to end.' }],
    skills: Array.from({ length: 40 }, (_, index) => `Skill${index}`),
    education: [{ degree: 'BSc', institution: 'Uni', startDate: '2008', endDate: '2012', location: 'X' }],
    certifications: [{ name: 'AZ-204', issuer: 'Microsoft', date: '2021' }],
    profileSettings: {
      resumePromptId: 'tailor-resume',
      analyzeJobPromptId: 'analyze-job-description',
      coverLetterPromptId: 'generate-cover-letter',
      resumeFileNameTemplate: '{{profile name}}',
      coverLetterFileNameTemplate: '{{profile name}}_cover_letter',
      companyFolderNameTemplate: '{{row number}}_{{company name}}',
      hardSkillOrdering: 'library',
      technicalSkillsLayout: 'categorized',
      ai: { modelId: 'claude-cli-opus', // A dead key a live database still holds - see aiPreferences: it must be
      // read through and ignored, never rejected.
      effort: 'max' },
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T00:00:00.000Z',
    ...extra,
  };
}

const ANALYSIS = {
  jobMeta: { title: 'Staff Engineer', seniority: 'Staff', industry: 'Fintech', department: 'Platform' },
  skills: {
    technical: ['C#', 'Python'],
    required: ['C#'],
    preferred: ['Go'],
    tools: ['Docker'],
    soft: ['Communication'],
    technologies: ['Azure'],
  },
  technologies: ['Azure', 'Kafka'],
  protocols: ['gRPC'],
  methodologies: ['Scrum'],
  architecturePatterns: ['Microservices'],
  responsibilities: ['Own the platform', 'Mentor engineers'],
  domainKnowledge: ['Payments'],
  softSkills: ['Communication'],
  keywords: { actionVerbs: ['led'], buzzwords: ['cloud-native'], mustInclude: ['C#'] },
  sourceJobDescription: 'The original posting text. '.repeat(200),
};

test("the operator's own configuration never reaches the model", () => {
  // `profileSettings` holds which prompt records to use, the output file-name
  // templates, and which AI model they pay for. Sending it put the operator's
  // tooling choices into a third party's model input, for a call that rewrites
  // a summary.
  const values = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  const sent = JSON.parse(values.profileJson);
  assert.equal('profileSettings' in sent, false);
  assert.doesNotMatch(values.profileJson, /claude-cli-opus/, 'the model preference must not travel');
  assert.doesNotMatch(values.profileJson, /coverLetterFileNameTemplate/);
});

test('contact details never reach the model', () => {
  // This call rewrites the summary, the experience and the skills. It is never
  // asked for contact details, no prompt in this app mentions them, and the
  // rendered resume takes them straight from the profile.
  const values = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  assert.doesNotMatch(values.profileJson, /a\.person@example\.com/);
  assert.doesNotMatch(values.profileJson, /555 0100/);
  assert.doesNotMatch(values.profileJson, /linkedin\.com/);
  assert.doesNotMatch(values.profileJson, /github\.com/);
});

test("this database's bookkeeping never reaches the model", () => {
  const sent = JSON.parse(buildTailorResumePromptValues(profileFixture(), ANALYSIS).profileJson);
  for (const field of ['id', 'createdAt', 'updatedAt']) {
    assert.equal(field in sent, false, `${field} means nothing to a model rewriting a summary`);
  }
});

test('everything the model is asked to work from is still there', () => {
  // The other half. A projection that dropped something the prompt reasons over
  // would show up as a worse resume, not as an error.
  const sent = JSON.parse(buildTailorResumePromptValues(profileFixture(), ANALYSIS).profileJson);
  for (const field of [
    'name',
    'title',
    'totalYearsExperience',
    'summary',
    'experience',
    'skills',
    'education',
    'certifications',
  ]) {
    assert.ok(field in sent, `${field} is what the prompt tailors`);
  }
  // Strengths only while the profile's Strengths switch is on: off, the
  // person has said they are not for this resume, and they are not sent.
  assert.equal('strengths' in sent, false);
  const withStrengths = JSON.parse(
    buildTailorResumePromptValues(profileFixture({ profileSettings: { includeStrengths: true } }), ANALYSIS).profileJson
  );
  assert.ok('strengths' in withStrengths, 'strengths is what the prompt tailors, once switched on');
  assert.equal(sent.experience.length, 5);
  assert.equal(sent.experience[0].achievements.length, 3);
  assert.ok(sent.experience[0].companyContext, 'the role context still travels');
  assert.equal('description' in sent.experience[0], false, 'but not the raw description twice');
});

test("a profile's own skill grouping travels, when it has one", () => {
  // The model is asked to SELECT skills, and the author's grouping is a fact
  // about them it should not contradict.
  const grouped = buildTailorResumePromptValues(
    profileFixture({ skillCategories: [{ category: 'Languages', skills: ['C#'] }] }),
    ANALYSIS
  );
  assert.match(grouped.profileJson, /skillCategories/);

  const plain = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  assert.doesNotMatch(plain.profileJson, /skillCategories/, 'and an empty one is not sent as noise');
});

test('the payload is compact JSON, not pretty-printed', () => {
  // Two-space indentation is for a person reading a file. Nothing reads this
  // but a model, which parses both identically - and the indentation is a
  // sixth of the payload on a record this nested, paid on every call.
  const values = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  assert.doesNotMatch(values.profileJson, /\n {2}"/, 'profileJson is indented');
  assert.doesNotMatch(values.jobAnalysisJson, /\n {2}"/, 'jobAnalysisJson is indented');
});

test('the analysed posting is not echoed back inside the tailoring prompt', () => {
  // It is already in the analysis this call was given. Sending it again would
  // double the largest single field for nothing.
  const values = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  assert.doesNotMatch(values.jobAnalysisJson, /sourceJobDescription/);
});

test("what a posting pays and how the filter judges it never reach the tailoring prompt", () => {
  // The analysis carries its job field, salary and filter facts for the
  // sheet, the lake and the Job Filter. Tailoring a resume needs none of
  // them, and a model told what the job pays has one more thing to echo.
  const { parseJobAnalysisContent } = require('../dist/services/resumeService');
  const analysis = parseJobAnalysisContent(
    JSON.stringify({
      ...ANALYSIS,
      sourceJobDescription: undefined,
      jobField: 'backend',
      salary: { min: 150000, max: 190000, currency: 'USD', period: 'annual', raw: '$150k-$190k' },
      filter: { jobType: 'remote', onsiteInterview: 'no', companyCategory: 'saas', clearanceRequired: 'none', region: 'us', usState: null },
    }),
    'The original posting text.'
  );
  assert.equal(analysis.jobField, 'backend', 'the parsed analysis does carry them');
  assert.equal(analysis.salary.min, 150000);
  assert.equal(analysis.filter.jobType, 'remote');

  const values = buildTailorResumePromptValues(profileFixture(), analysis);
  assert.doesNotMatch(values.jobAnalysisJson, /"jobField"|"salary"|"filter"/);
  assert.doesNotMatch(values.jobAnalysisJson, /150000|150k|"remote"|clearance/);
});

test('the whole tailoring payload stays under budget', () => {
  // A ceiling rather than an exact figure, so ordinary edits do not fail this -
  // but a change that puts the whole profile record back would sail past it.
  // Measured at 6,942 characters for this fixture shape, down from 9,365.
  // Every value counts, the section switches' included.
  for (const sections of [{}, { includeStrengths: true, includeSoftSkills: true, technicalSkillsLayout: 'flat' }]) {
    const fixture = profileFixture();
    const values = buildTailorResumePromptValues(
      { ...fixture, profileSettings: { ...fixture.profileSettings, ...sections } },
      ANALYSIS
    );
    const total = Object.values(values).reduce((sum, value) => sum + value.length, 0);
    assert.ok(total < 8_000, `the tailoring payload has grown to ${total} characters`);
  }
});

test('the section switches travel as their own words, never as profile settings', () => {
  // They are how the operator wants the resume drawn, which is exactly the
  // kind of thing `profileSettings` holds and the model is not sent - so they
  // go as three short variables instead, after [[profileJson]], and the
  // profile projection stays what it was.
  const fixture = profileFixture({ softSkills: ['Persistence'] });
  const values = buildTailorResumePromptValues(
    { ...fixture, profileSettings: { ...fixture.profileSettings, includeStrengths: true, includeSoftSkills: true } },
    ANALYSIS
  );
  assert.equal(values.includeStrengths, 'yes');
  assert.equal(values.includeSoftSkills, 'yes');
  assert.equal(values.technicalSkillsLayout, 'grouped');
  assert.doesNotMatch(values.profileJson, /includeStrengths|includeSoftSkills|technicalSkillsLayout/);
  // The list itself is decided by code, so it does not travel either.
  assert.doesNotMatch(values.profileJson, /Persistence/);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTailorResumePromptValues } = require('../dist/services/resumeService');

/**
 * What actually gets sent to the model.
 *
 * Two reasons to pin this rather than leave it to review. On a metered provider
 * every character is billed; on a free chat provider every character has to be
 * TYPED into a composer, which is the slowest step of the turn by a wide margin
 * and the one that used to hit the protocol timeout. And a `Profile` grows
 * fields over time - the projection is built by naming what goes in precisely
 * so a field added later is not sent to a chat window by default, and this is
 * what notices when that stops being true.
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
      ai: { modelId: 'free-hybrid', effort: 'max' },
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
  // templates, and which AI model they pay for. Sending it typed the operator's
  // tooling choices into somebody else's chat history, for a call that rewrites
  // a summary.
  const values = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  const sent = JSON.parse(values.profileJson);
  assert.equal('profileSettings' in sent, false);
  assert.doesNotMatch(values.profileJson, /free-hybrid/, 'the model preference must not travel');
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
    'strengths',
    'skills',
    'education',
    'certifications',
  ]) {
    assert.ok(field in sent, `${field} is what the prompt tailors`);
  }
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

test('the whole tailoring payload stays under budget', () => {
  // A ceiling rather than an exact figure, so ordinary edits do not fail this -
  // but a change that puts the whole profile record back would sail past it.
  // Measured at 6,942 characters for this fixture shape, down from 9,365.
  const values = buildTailorResumePromptValues(profileFixture(), ANALYSIS);
  const total = Object.values(values).reduce((sum, value) => sum + value.length, 0);
  assert.ok(total < 8_000, `the tailoring payload has grown to ${total} characters`);
});

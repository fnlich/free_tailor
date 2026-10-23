const assert = require('node:assert/strict');
const test = require('node:test');

const { buildTailorResumePromptValues } = require('../dist/services/resumeService');

/**
 * What actually gets sent to the model.
 *
 * Two reasons to pin this rather than leave it to review. On a metered provider
 * every character is billed, and on a subscription seat every character counts
 * against the seat's usage allowance and lengthens the turn. And a `Resume`
 * grows fields over time - the projection is built by naming what goes in
 * precisely so a field added later is not sent to a model by default, and this
 * is what notices when that stops being true.
 */

function resumeFixture(extra = {}) {
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
    id: 'resume-1',
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
    resumeSettings: {
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
  // `resumeSettings` holds which prompt records to use, the output file-name
  // templates, and which AI model they pay for. Sending it put the operator's
  // tooling choices into a third party's model input, for a call that rewrites
  // a summary.
  const values = buildTailorResumePromptValues(resumeFixture(), ANALYSIS);
  const sent = JSON.parse(values.profileJson);
  assert.equal('resumeSettings' in sent, false);
  assert.doesNotMatch(values.profileJson, /claude-cli-opus/, 'the model preference must not travel');
  assert.doesNotMatch(values.profileJson, /coverLetterFileNameTemplate/);
});

test("a resume's keywords (as GET /api/resumes serves them) never reach the model", () => {
  // Keywords are derived for the matcher that chooses among a profile's
  // resumes (services/resumeKeywords.ts). They are computed, never stored, and
  // the prompt's projection names what goes in, so a resume that carries them
  // (one read from the GET) sends no word of them in either mode.
  const withKeywords = resumeFixture({
    matchKeywords: {
      version: 1,
      vocabulary: 'abc',
      basedOn: 'def',
      headline: ['Staff Engineer'],
      roleTitles: ['Senior Engineer'],
      terms: ['ZZSENTINELTERM', 'C#'],
    },
  });
  for (const mode of ['partial', 'full']) {
    const values = buildTailorResumePromptValues(withKeywords, ANALYSIS, mode);
    const sent = JSON.stringify(values);
    assert.doesNotMatch(sent, /ZZSENTINELTERM/, `${mode}: the terms`);
    assert.doesNotMatch(sent, /matchKeywords|basedOn|roleTitles/, `${mode}: the field and its parts`);
    const plain = buildTailorResumePromptValues(resumeFixture(), ANALYSIS, mode);
    assert.deepEqual(values, plain, `${mode}: a resume with keywords asks the model exactly what one without asks`);
  }
});

test('contact details never reach the model', () => {
  // This call rewrites the summary, the experience and the skills. It is never
  // asked for contact details, no prompt in this app mentions them, and the
  // rendered resume takes them straight from its source.
  const values = buildTailorResumePromptValues(resumeFixture(), ANALYSIS);
  assert.doesNotMatch(values.profileJson, /a\.person@example\.com/);
  assert.doesNotMatch(values.profileJson, /555 0100/);
  assert.doesNotMatch(values.profileJson, /linkedin\.com/);
  assert.doesNotMatch(values.profileJson, /github\.com/);
});

test("this database's bookkeeping never reaches the model", () => {
  const sent = JSON.parse(buildTailorResumePromptValues(resumeFixture(), ANALYSIS).profileJson);
  for (const field of ['id', 'createdAt', 'updatedAt']) {
    assert.equal(field in sent, false, `${field} means nothing to a model rewriting a summary`);
  }
});

test('everything the model is asked to work from is still there', () => {
  // The other half. A projection that dropped something the prompt reasons over
  // would show up as a worse resume, not as an error.
  const sent = JSON.parse(buildTailorResumePromptValues(resumeFixture(), ANALYSIS).profileJson);
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
  // Strengths only while the resume's Strengths switch is on: off, the
  // person has said they are not for this resume, and they are not sent.
  assert.equal('strengths' in sent, false);
  const withStrengths = JSON.parse(
    buildTailorResumePromptValues(resumeFixture({ resumeSettings: { includeStrengths: true } }), ANALYSIS).profileJson
  );
  assert.ok('strengths' in withStrengths, 'strengths is what the prompt tailors, once switched on');
  assert.equal(sent.experience.length, 5);
  assert.equal(sent.experience[0].achievements.length, 3);
  assert.ok(sent.experience[0].companyContext, 'the role context still travels');
  assert.equal('description' in sent.experience[0], false, 'but not the raw description twice');
});

test("a resume's own skill grouping travels, when it has one", () => {
  // The model is asked to SELECT skills, and the author's grouping is a fact
  // about them it should not contradict.
  const grouped = buildTailorResumePromptValues(
    resumeFixture({ skillCategories: [{ category: 'Languages', skills: ['C#'] }] }),
    ANALYSIS
  );
  assert.match(grouped.profileJson, /skillCategories/);

  const plain = buildTailorResumePromptValues(resumeFixture(), ANALYSIS);
  assert.doesNotMatch(plain.profileJson, /skillCategories/, 'and an empty one is not sent as noise');
});

test('the payload is compact JSON, not pretty-printed', () => {
  // Two-space indentation is for a person reading a file. Nothing reads this
  // but a model, which parses both identically - and the indentation is a
  // sixth of the payload on a record this nested, paid on every call.
  const values = buildTailorResumePromptValues(resumeFixture(), ANALYSIS);
  assert.doesNotMatch(values.profileJson, /\n {2}"/, 'profileJson is indented');
  assert.doesNotMatch(values.jobAnalysisJson, /\n {2}"/, 'jobAnalysisJson is indented');
});

test('the analysed posting is not echoed back inside the tailoring prompt', () => {
  // It is already in the analysis this call was given. Sending it again would
  // double the largest single field for nothing.
  const values = buildTailorResumePromptValues(resumeFixture(), ANALYSIS);
  assert.doesNotMatch(values.jobAnalysisJson, /sourceJobDescription/);
});

test("what a posting pays and how the filter judges it never reach the tailoring prompt", () => {
  // The analysis carries its job field, salary and filter facts - its
  // second call's answer - for the sheet, the lake and the Job Filter.
  // Tailoring a resume needs none of them, and a model told what the job
  // pays has one more thing to echo.
  const { parseJobAnalysisKeywords, parseJobFacts, composeJobAnalysis } = require('../dist/services/resumeService');
  const analysis = composeJobAnalysis(
    parseJobAnalysisKeywords(JSON.stringify({ ...ANALYSIS, sourceJobDescription: undefined }), 'The original posting text.'),
    parseJobFacts(
      JSON.stringify({
        job_field: 'backend',
        salary: { min: 150000, max: 190000, period: 'annual', raw: '$150k-$190k' },
        job_type: 'remote',
        onsite_interview: 'no',
        company_category: 'saas',
        seniority: 'principal',
        clearance_required: 'none',
        region: 'us',
        us_state: null,
      })
    )
  );
  assert.equal(analysis.jobField, 'backend', 'the composed analysis does carry them');
  assert.equal(analysis.salary.min, 150000);
  assert.equal(analysis.filter.jobType, 'remote');
  assert.equal(analysis.filter.seniority, 'principal');

  const values = buildTailorResumePromptValues(resumeFixture(), analysis);
  assert.doesNotMatch(values.jobAnalysisJson, /"jobField"|"salary"|"filter"/);
  assert.doesNotMatch(values.jobAnalysisJson, /150000|150k|"remote"|clearance|principal/);
});

test('the industry an older analysis was filed under never reaches the tailoring prompt, nor changes a tailoring cache key', () => {
  // v6 stored an `industry` on the analysis, for the lake and the sheet; a
  // new analysis carries none (it is derived). Either way the tailoring input
  // is byte for byte the same: the same values, so the same prompt and the
  // same cache key for every resume and posting the cache already holds.
  const { tailorCacheKey } = require('../dist/services/tailorCache');
  const without = {
    ...ANALYSIS,
    sourceJobDescription: 'The original posting text.',
    jobField: 'backend',
    salary: null,
    filter: { jobType: 'hybrid', onsiteInterview: 'no', companyCategory: 'fintech', clearanceRequired: 'secret', region: 'us', usState: 'NY' },
  };
  const withIndustry = { ...without, industry: 'insurance' };

  const before = buildTailorResumePromptValues(resumeFixture(), without);
  const after = buildTailorResumePromptValues(resumeFixture(), withIndustry);
  assert.deepEqual(after, before, 'the same values, to the byte');
  assert.equal(JSON.parse(after.jobAnalysisJson).industry, undefined);
  assert.doesNotMatch(after.jobAnalysisJson, /insurance/i);
  // The posting's own free-text industry word is part of it, as it always was.
  assert.match(after.jobAnalysisJson, /"industry":"Fintech"/);

  const key = (values) =>
    tailorCacheKey({
      kind: 'resume',
      resume: resumeFixture(),
      context: { analysisId: 'analysis-1', templateId: 'default' },
      choice: { provider: 'claude-cli', modelId: 'm', modelName: 'sonnet' },
      promptId: 'tailor-resume',
      promptText: 'Tailor.',
      promptValues: values,
    });
  assert.equal(key(after), key(before));
});

test('the whole tailoring payload stays under budget', () => {
  // A ceiling rather than an exact figure, so ordinary edits do not fail this -
  // but a change that puts the whole resume record back would sail past it.
  // Measured at 4,484 characters for this fixture (4,561 with strengths), down
  // from 6,942 when the skill library's matches went too, twice over (as
  // `skillsJSON` and its alias `hardSkillsJson`). Every value counts.
  for (const settings of [{}, { includeStrengths: true, includeSoftSkills: true, technicalSkillsLayout: 'flat' }]) {
    const fixture = resumeFixture();
    const values = buildTailorResumePromptValues(
      { ...fixture, resumeSettings: { ...fixture.resumeSettings, ...settings } },
      ANALYSIS
    );
    const total = Object.values(values).reduce((sum, value) => sum + value.length, 0);
    assert.ok(total < 6_000, `the tailoring payload has grown to ${total} characters`);
  }
});

test('the layout and the Soft Skills switch are not sent at all, and the Strengths switch only as the strengths', () => {
  // How the model's skills block is DRAWN - grouped or plain, the soft-skill
  // group in its own section or not - is decided when the resume is rendered,
  // so the model is asked the same question either way, and the tailoring
  // cache answers both from one answer. The Strengths switch decides whether
  // the resume's own strengths are context in profileJson, and nothing else.
  const fixture = resumeFixture({ softSkills: ['Persistence'] });
  const values = (settings) =>
    buildTailorResumePromptValues({ ...fixture, resumeSettings: { ...fixture.resumeSettings, ...settings } }, ANALYSIS);
  const plain = values({});
  for (const name of ['includeStrengths', 'includeSoftSkills', 'technicalSkillsLayout', 'hardSkillsJson']) {
    assert.equal(name in plain, false, `${name} is no prompt value now`);
  }
  assert.deepEqual(values({ technicalSkillsLayout: 'flat', includeSoftSkills: true }), plain);
  const withStrengths = values({ includeStrengths: true });
  assert.notEqual(withStrengths.profileJson, plain.profileJson);
  assert.deepEqual({ ...withStrengths, profileJson: '' }, { ...plain, profileJson: '' });
  assert.doesNotMatch(plain.profileJson, /includeStrengths|includeSoftSkills|technicalSkillsLayout/);
  // The person's own soft skills never travel: a tailored resume prints the
  // posting's, the last group of the model's block.
  assert.doesNotMatch(withStrengths.profileJson, /Persistence/);
});

test('an older analysis is sent in the current schema: its duplicate lists once, and nothing it no longer has', () => {
  // This fixture is an analysis stored before the current analysis prompt:
  // `skills.required` beside `skills.technical`, `skills.technologies` beside
  // `technologies`, a top-level `softSkills` and `skills.preferred`. A posting
  // is analysed once, ever, so such analyses are what most resumes are still
  // tailored from - read the same way, and each term sent once.
  const sent = JSON.parse(buildTailorResumePromptValues(resumeFixture(), ANALYSIS).jobAnalysisJson);
  assert.deepEqual(Object.keys(sent), [
    'jobMeta', 'skills', 'technologies', 'protocols', 'methodologies', 'architecturePatterns',
    'responsibilities', 'domainKnowledge', 'keywords',
  ]);
  assert.deepEqual(Object.keys(sent.skills), ['technical', 'tools', 'soft']);
  assert.deepEqual(sent.skills.technical, ['C#', 'Python']);
  assert.deepEqual(sent.technologies, ['Azure', 'Kafka']);
  assert.deepEqual(sent.skills.soft, ['Communication']);
  assert.equal('softSkills' in sent, false);
});

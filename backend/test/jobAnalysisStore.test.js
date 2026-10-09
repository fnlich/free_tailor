const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * The `job_analyses` table: what identifies a posting, and that every lookup
 * the gate makes is ONE index seek whatever the table's size - pinned through
 * EXPLAIN QUERY PLAN, so a later schema edit cannot quietly turn the gate's
 * lookups into scans of every posting ever analysed.
 */

const sqlite = require('../dist/database/sqlite');
const repository = require('../dist/database/jobAnalysisRepository');
const identity = require('../dist/services/jobAnalysis/identity');
const jobFields = require('../dist/config/jobFields');

function analysis(extra = {}) {
  return {
    jobMeta: { title: 'Engineer', seniority: 'senior', industry: '', department: '' },
    skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
    technologies: [],
    protocols: [],
    methodologies: [],
    architecturePatterns: [],
    responsibilities: [],
    domainKnowledge: [],
    softSkills: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    jobField: 'backend',
    salary: null,
    filter: {
      jobType: 'remote',
      onsiteInterview: 'no',
      companyCategory: 'saas',
      clearanceRequired: 'none',
      region: 'us',
      usState: '',
    },
    sourceJobDescription: 'A posting.',
    ...extra,
  };
}

function insert(jd, link, extra = {}) {
  return repository.insertJobAnalysisIfAbsent({
    contentHash: identity.contentHash(jd),
    linkKey: identity.linkKey(link),
    jobLink: link ?? '',
    analysis: analysis({ sourceJobDescription: jd, ...extra }),
    modelId: 'claude-cli-sonnet',
    promptHash: 'h',
    source: 'ai',
    createdBy: null,
  });
}

function plan(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join(' | ');
}

test("every gate lookup is one seek on its own index, and the lake's two reads have theirs", () => {
  useTempStorage('job-analyses-plans');
  const db = sqlite.getDb();
  // Enough rows that a scan would be a real choice for the planner.
  for (let n = 0; n < 50; n += 1) {
    insert(`Posting number ${n} for the plan.`, n % 2 ? `https://jobs.example.com/${n}` : undefined, {
      jobField: jobFields.JOB_FIELDS[n % 25].id,
    });
  }
  db.exec('ANALYZE');

  assert.match(plan(db, repository.FIND_BY_LINK_KEY_SQL, 'https://jobs.example.com/1'), /USING INDEX idx_job_analyses_link_key \(link_key=\?\)/);
  assert.match(plan(db, repository.FIND_BY_CONTENT_HASH_SQL, 'x'), /USING INDEX idx_job_analyses_content_hash \(content_hash=\?\)/);
  // The merge tab's "analysed, not merged" list, oldest first (Phase 7).
  assert.match(
    plan(db, 'SELECT id FROM job_analyses WHERE merged_at IS NULL ORDER BY created_at LIMIT 50'),
    /USING (COVERING )?INDEX idx_job_analyses_merge/
  );
  // The lake page's field filter.
  assert.match(plan(db, 'SELECT id FROM job_analyses WHERE job_field_id = ?', 'backend'), /USING (COVERING )?INDEX idx_job_analyses_job_field/);
  for (const sql of [repository.FIND_BY_LINK_KEY_SQL, repository.FIND_BY_CONTENT_HASH_SQL]) {
    assert.doesNotMatch(plan(db, sql, 'x'), /SCAN/, sql);
  }
});

test('the two identities are UNIQUE - the link one partial - with the merge and job field indexes', () => {
  useTempStorage('job-analyses-indexes');
  const db = sqlite.getDb();
  const indexes = new Map(
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job_analyses'")
      .all()
      .map((row) => [row.name, row.sql])
  );
  assert.match(indexes.get('idx_job_analyses_content_hash'), /CREATE UNIQUE INDEX .* ON job_analyses \(content_hash\)/);
  assert.match(indexes.get('idx_job_analyses_link_key'), /CREATE UNIQUE INDEX .* ON job_analyses \(link_key\) WHERE link_key IS NOT NULL/);
  assert.match(indexes.get('idx_job_analyses_merge'), /ON job_analyses \(merged_at, created_at\)/);
  assert.match(indexes.get('idx_job_analyses_job_field'), /ON job_analyses \(job_field_id\)/);
  const columns = db.prepare('PRAGMA table_info(job_analyses)').all().map((column) => column.name);
  for (const name of ['id', 'content_hash', 'link_key', 'analysis_json', 'job_field_id', 'salary_min', 'salary_max',
    'salary_currency', 'salary_period', 'salary_raw', 'model_id', 'prompt_hash', 'source', 'created_by', 'created_at', 'merged_at']) {
    assert.ok(columns.includes(name), `job_analyses.${name}`);
  }
});

test('a posting is stored once: a second insert by text or by link keeps the first row and answers it', () => {
  useTempStorage('job-analyses-once');
  const first = insert('The same posting text.', 'https://jobs.example.com/a');
  assert.equal(first.inserted, true);

  const byText = insert('The   same posting\ttext.  ', undefined, { jobField: 'frontend' });
  assert.equal(byText.inserted, false);
  assert.equal(byText.row.id, first.row.id);
  assert.equal(byText.row.jobFieldId, 'backend', 'never overwritten');

  const byLink = insert('Entirely different words.', 'https://jobs.example.com/a/?utm_campaign=x#top');
  assert.equal(byLink.inserted, false);
  assert.equal(byLink.row.id, first.row.id);

  // Many postings with no link at all: NULL is not a key.
  assert.equal(insert('No link one.').inserted, true);
  assert.equal(insert('No link two.').inserted, true);
  assert.equal(repository.countJobAnalyses(), 3);

  // The salary and the field land in their own columns.
  const salaried = insert('A salaried posting.', undefined, {
    jobField: 'devops',
    salary: { min: 100, max: 120, currency: 'USD', period: 'hourly', raw: '$100-$120/h' },
  });
  const row = sqlite.getDb().prepare('SELECT * FROM job_analyses WHERE id = ?').get(salaried.row.id);
  assert.deepEqual(
    [row.job_field_id, row.salary_min, row.salary_max, row.salary_currency, row.salary_period, row.salary_raw, row.merged_at],
    ['devops', 100, 120, 'USD', 'hourly', '$100-$120/h', null]
  );
  assert.equal(JSON.parse(row.analysis_json).sourceJobDescription, undefined, 'the text is its own column');
  assert.equal(salaried.row.analysis.sourceJobDescription, 'A salaried posting.');

  // A link is recorded on a row that had none, never moved off another.
  repository.attachLinkKey(salaried.row.id, 'https://jobs.example.com/s', 'https://jobs.example.com/s');
  assert.equal(repository.getJobAnalysisById(salaried.row.id).linkKey, 'https://jobs.example.com/s');
  repository.attachLinkKey(salaried.row.id, 'https://jobs.example.com/other', 'x');
  assert.equal(repository.getJobAnalysisById(salaried.row.id).linkKey, 'https://jobs.example.com/s');
});

test('a link is the posting it names: host case, fragment, tracking and a trailing slash do not matter', () => {
  const key = identity.linkKey;
  const base = 'https://jobs.example.com/openings/42';
  for (const variant of [
    'https://JOBS.Example.com/openings/42',
    'https://jobs.example.com/openings/42/',
    'https://jobs.example.com/openings/42#apply',
    'http://jobs.example.com/openings/42',
    'https://jobs.example.com:443/openings/42',
    'https://jobs.example.com/openings/42?utm_source=linkedin&utm_medium=social',
    'https://jobs.example.com/openings/42?gclid=1&fbclid=2&ref=board&trk=x&gh_src=y',
  ]) {
    assert.equal(key(variant), base, variant);
  }
  // A board's own job key is the posting, and is kept - in a stable order.
  assert.equal(key('https://boards.example.com/jobs?gh_jid=7&b=2&utm_x=1'), 'https://boards.example.com/jobs?b=2&gh_jid=7');
  assert.equal(key('https://boards.example.com/jobs?b=2&gh_jid=7'), 'https://boards.example.com/jobs?b=2&gh_jid=7');
  // The path keeps its case: plenty of boards put a case-sensitive id there.
  assert.notEqual(key('https://x.example.com/Job/AbC'), key('https://x.example.com/job/abc'));
  for (const junk of ['', '   ', 'not a url', 'mailto:jobs@example.com', 'javascript:alert(1)', null, 42]) {
    assert.equal(key(junk), null, String(junk));
  }

  assert.equal(identity.contentHash('A  posting\n\twith   space. '), identity.contentHash('A posting with space.'));
  assert.notEqual(identity.contentHash('A posting.'), identity.contentHash('a posting.'), 'case is the words');
  assert.match(identity.contentHash('x'), /^[0-9a-f]{64}$/);
});

test("the job fields are the owner's list at bullet level: stable ids, area 9 left out, anything else unclassified", () => {
  const { JOB_FIELDS, JOB_FIELD_AREAS } = jobFields;
  assert.equal(JOB_FIELDS.length, 103, '17 + 10 + 12 + 7 + 11 + 11 + 9 + 8 + 12 + 6');
  assert.deepEqual(JOB_FIELD_AREAS.map((area) => area.number), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
  assert.equal(JOB_FIELDS.some((field) => field.area === 9), false, 'the CS foundations are not offered');
  assert.equal(new Set(JOB_FIELDS.map((field) => field.id)).size, JOB_FIELDS.length, 'ids are unique');
  for (const field of JOB_FIELDS) assert.match(field.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, field.id);

  assert.equal(jobFields.normalizeJobFieldId('backend'), 'backend');
  assert.equal(jobFields.normalizeJobFieldId('  ML-Engineering '), 'ml-engineering');
  assert.equal(jobFields.normalizeJobFieldId('Site reliability engineering (SRE)'), 'site-reliability-engineering', 'a label is read as its id');
  assert.equal(jobFields.normalizeJobFieldId('Data structures and algorithms'), 'unclassified', 'area 9');
  assert.equal(jobFields.normalizeJobFieldId('backend-ish'), 'unclassified');
  assert.equal(jobFields.normalizeJobFieldId(undefined), 'unclassified');
  assert.equal(jobFields.jobFieldLabel('devops'), 'DevOps');
  assert.equal(jobFields.jobFieldLabel('unclassified'), 'Unclassified');

  const list = jobFields.renderJobFieldListForPrompt();
  assert.equal(list, jobFields.renderJobFieldListForPrompt(), 'the same text every time');
  for (const field of JOB_FIELDS) assert.ok(list.includes(`- ${field.id}: ${field.label}`), field.id);
  assert.match(list, /- unclassified: none of the above fits$/);

  const forClient = jobFields.listJobFieldsForClient();
  assert.equal(forClient.fields.length, 103);
  assert.deepEqual(forClient.unclassified, { id: 'unclassified', label: 'Unclassified' });
});

test('a row whose analysis cannot be read is filled in once by the next analysis of its posting, and kept after that', () => {
  useTempStorage('job-analyses-unreadable');
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    for (const damage of ['{"jobMeta":{"tit', 'null', '42', '[1,2]']) {
      const jd = `A posting damaged as ${damage}.`;
      const first = insert(jd, undefined);
      sqlite.getDb().prepare('UPDATE job_analyses SET analysis_json = ? WHERE id = ?').run(damage, first.row.id);
      assert.equal(repository.getJobAnalysisById(first.row.id), null, `${damage} reads as absent, and throws nothing`);
      assert.equal(repository.findJobAnalysisByContentHash(identity.contentHash(jd)), null);

      const repaired = insert(jd, undefined, { jobField: 'devops' });
      assert.deepEqual([repaired.row.id, repaired.inserted, repaired.row.jobFieldId], [first.row.id, true, 'devops'], damage);
      const kept = insert(jd, undefined, { jobField: 'frontend' });
      assert.deepEqual([kept.row.id, kept.inserted, kept.row.jobFieldId], [first.row.id, false, 'devops'], 'never overwritten after');
    }
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
});

/* --------------------------------------------- industry, job type, clearance -- */

const industries = require('../dist/config/industries');
const facts = require('../dist/services/jobAnalysis/facts');

test("the industries are the owner's closed list with stable ids; an unknown word is Other, nothing is not specified", () => {
  assert.deepEqual(
    industries.INDUSTRIES.map((entry) => entry.label),
    [
      'Healthcare', 'Finance', 'Insurance', 'Military', 'Government', 'Education', 'Retail & E-commerce',
      'Technology', 'Consulting', 'Media & Entertainment', 'Logistics & Transportation', 'Energy & Utilities',
      'Manufacturing', 'Telecommunications', 'Legal', 'Real Estate', 'Hospitality & Travel', 'Nonprofit', 'Other',
    ]
  );
  assert.equal(new Set(industries.INDUSTRIES.map((entry) => entry.id)).size, industries.INDUSTRIES.length, 'ids are unique');
  for (const entry of industries.INDUSTRIES) assert.match(entry.id, /^[a-z]+(_[a-z]+)*$/, entry.id);
  assert.equal(industries.isIndustryId('not_specified'), true);
  assert.equal(industries.isIndustryId('fintech'), false);
  assert.equal(industries.industryLabel('not_specified'), '', 'not specified shows as a blank cell');
  assert.equal(industries.industryLabel('retail_ecommerce'), 'Retail & E-commerce');
  assert.equal(industries.industryLabel('made-up'), '');

  for (const [answer, expected] of [
    ['healthcare', 'healthcare'],
    ['  Real Estate ', 'real_estate'],
    ['Retail & E-commerce', 'retail_ecommerce'],
    ['retail and e-commerce', 'retail_ecommerce'],
    ['MEDIA_ENTERTAINMENT', 'media_entertainment'],
    ['fintech', 'finance'],
    ['SaaS', 'technology'],
    ['defense_military', 'military'],
    ['Investment banking', 'finance'],
    ['Space mining', 'other'],
    ['Other', 'other'],
    ['not_specified', 'not_specified'],
    ['Unknown', 'not_specified'],
    ['', 'not_specified'],
    [null, 'not_specified'],
    [42, 'not_specified'],
  ]) {
    assert.equal(facts.normalizeIndustry(answer), expected, String(answer));
  }

  const list = industries.renderIndustryListForPrompt();
  assert.equal(list, industries.renderIndustryListForPrompt(), 'the same text every time');
  for (const entry of industries.INDUSTRIES) assert.ok(list.includes(`- ${entry.id}: ${entry.label}`), entry.id);
  assert.match(list, /- not_specified: [^\n]+$/);
  assert.deepEqual(industries.listIndustriesForClient().at(-1), { id: 'not_specified', label: 'Not specified' });
});

test('an analysis has an industry only when its answer had one: an older analysis or row stays without', () => {
  useTempStorage('job-analyses-industry');
  const { normalizeJobAnalysisResponse } = require('../dist/services/resumeService');
  const answer = analysis();
  delete answer.sourceJobDescription;

  const older = normalizeJobAnalysisResponse(answer, 'A posting.');
  assert.equal('industry' in older, false, 'no key, not a default');
  assert.equal(normalizeJobAnalysisResponse({ ...answer, industry: 'Insurance' }, 'A posting.').industry, 'insurance');
  assert.equal(normalizeJobAnalysisResponse({ ...answer, industry: null }, 'A posting.').industry, 'not_specified');
  assert.equal(normalizeJobAnalysisResponse({ ...answer, industry: 'Asteroid farming' }, 'A posting.').industry, 'other');

  // Stored and read back, each as it was.
  const without = insert('A posting stored before industries.', undefined);
  assert.equal('industry' in repository.getJobAnalysisById(without.row.id).analysis, false);
  const withIt = insert('A posting stored after industries.', undefined, { industry: 'education' });
  assert.equal(repository.getJobAnalysisById(withIt.row.id).analysis.industry, 'education');
  // Its industry derived when it is read - from its company category here - and nothing written back.
  const before = sqlite.getDb().prepare('SELECT analysis_json FROM job_analyses WHERE id = ?').get(without.row.id).analysis_json;
  assert.equal(facts.industryOf(repository.getJobAnalysisById(without.row.id).analysis), 'technology');
  assert.equal(sqlite.getDb().prepare('SELECT analysis_json FROM job_analyses WHERE id = ?').get(without.row.id).analysis_json, before);
});

test("an older analysis's industry comes from its company category, else its free-text industry, else not specified", () => {
  const older = (companyCategory, industry, extra = {}) => ({
    jobMeta: { title: 'Engineer', seniority: 'senior', industry, department: '' },
    filter: { jobType: 'not_specified', onsiteInterview: 'not_specified', companyCategory, clearanceRequired: 'none', region: 'us', usState: '' },
    ...extra,
  });
  const cases = [
    // Its own key wins, whatever it says, even "not specified".
    [older('healthcare', 'Banking', { industry: 'finance' }), 'finance'],
    [older('healthcare', 'Banking', { industry: 'not_specified' }), 'not_specified'],
    [older('healthcare', 'Banking', { industry: 'Basket weaving' }), 'other'],
    // Then the company category.
    [older('fintech', 'Healthcare'), 'finance'],
    [older('defense_military', ''), 'military'],
    [older('consulting', ''), 'consulting'],
    [older('enterprise_software', ''), 'technology'],
    // "other" says no category fit: the free text is read.
    [older('other', 'SaaS'), 'technology'],
    [older('other', 'Healthcare IT'), 'healthcare'],
    [older('other', 'Insurtech'), 'insurance'],
    [older('other', 'e-commerce'), 'retail_ecommerce'],
    [older('other', 'Defense contractor'), 'military'],
    [older('other', 'devtools'), 'technology'],
    [older('other', 'Logistics'), 'logistics_transportation'],
    [older('other', 'Non-profit'), 'nonprofit'],
    [older('other', 'Widgets'), 'not_specified'],
    [older('other', ''), 'not_specified'],
    // An analysis from before the filter facts: the free text alone.
    [{ jobMeta: { title: '', seniority: '', industry: 'fintech', department: '' } }, 'finance'],
    [{}, 'not_specified'],
    [null, 'not_specified'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(facts.industryOf(input), expected, JSON.stringify(input));
  }
  // Every company category but "other" names an industry of the list.
  for (const category of facts.FILTER_FACT_VALUES.companyCategory) {
    if (category === 'other') continue;
    assert.ok(industries.isIndustryId(facts.COMPANY_CATEGORY_INDUSTRY[category]), category);
  }
});

test('job type is Remote, Hybrid or Onsite or blank; a clearance is required unless the analysis says none or does not say', () => {
  const withFilter = (filter) => ({ filter: { jobType: 'not_specified', clearanceRequired: 'none', ...filter } });
  for (const [jobType, expected] of [
    ['remote', 'remote'],
    ['hybrid', 'hybrid'],
    ['on_site', 'on_site'],
    ['Onsite', 'on_site'],
    ['not_specified', ''],
    ['flexible', ''],
  ]) {
    assert.equal(facts.jobTypeOf(withFilter({ jobType })), expected, jobType);
  }
  assert.equal(facts.jobTypeOf({}), '');
  assert.equal(facts.jobTypeOf(null), '');
  assert.deepEqual(
    ['remote', 'hybrid', 'on_site', '', 'nonsense'].map(facts.jobTypeLabel),
    ['Remote', 'Hybrid', 'Onsite', '', '']
  );
  assert.deepEqual(facts.listJobTypesForClient().map((option) => option.id), ['remote', 'hybrid', 'on_site', 'not_specified']);

  for (const [clearanceRequired, expected] of [
    ['none', false],
    ['not_specified', false],
    ['', false],
    [null, false],
    ['public_trust', true],
    ['secret', true],
    ['TS/SCI', true],
    // Fails closed, as the Job Filter does: a clearance word the list lacks is still a clearance.
    ['DoD Secret', true],
    [true, true],
  ]) {
    assert.equal(facts.clearanceRequiredOf(withFilter({ clearanceRequired })), expected, String(clearanceRequired));
  }
  assert.equal(facts.clearanceRequiredOf({}), false, 'no filter facts at all: nothing said');
  assert.deepEqual(facts.analysisFactsOf(withFilter({ jobType: 'remote', clearanceRequired: 'secret', companyCategory: 'govtech' })), {
    jobType: 'remote',
    clearance: true,
    industry: 'government',
  });
});

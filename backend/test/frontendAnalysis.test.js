const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

// Nothing here opens the database, but the server modules below are loaded
// whole; give them a directory of their own rather than the default.
process.env.DB_DIR = process.env.DB_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-frontend-analysis-'));

/**
 * How the frontend holds and shows a posting's ONE job analysis
 * (frontend/src/lib/jobAnalysis.ts), and how the builder's sheet panel reads
 * the account sheet's analysis columns (lib/sheetRows.ts) - each run against
 * the server's own code wherever the page keeps a copy of a server rule: the
 * salary line the sheet's Salary column holds, the Analysis cell's states, the
 * whitespace a posting's identity ignores, and the columns the six protected
 * cells sit in. A copy that drifted would mark a row "Skips analysis" that the
 * server then analyses, or show a salary the sheet spells differently. And
 * the required variables Admin -> Prompts holds a prompt to as it is typed
 * (lib/promptRequirements.ts), held to the server's rule and its refusal.
 *
 * Loaded the way frontendHelpers.test.js loads its modules: transpiled with
 * the backend's TypeScript, importing nothing at runtime.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontendModule(relative) {
  const file = path.join(SRC, relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, refuse);
  return module.exports;
}

const held = loadFrontendModule('lib/jobAnalysis.ts');
const rows = loadFrontendModule('lib/sheetRows.ts');
const facts = require('../dist/services/jobAnalysis/facts');
const identity = require('../dist/services/jobAnalysis/identity');
const cells = require('../dist/services/sheets/analysisColumns');
const { ANALYSIS_FIRST_COLUMN, ANALYSIS_LAST_COLUMN, JOB_SHEET_COLUMNS } = require('../dist/integrations/googleSheets');

const POSTING = 'Senior backend engineer to build TypeScript services on Postgres for a payments team.';

/** A stored analysis as the repository hands it out - enough of one for the cell writers. */
function stored(overrides = {}) {
  return {
    id: '0f6c1a2e-6b3d-4c55-9a0e-3c1d2b4a5e6f',
    contentHash: identity.contentHash(POSTING),
    linkKey: null,
    jobLink: '',
    analysis: {
      jobMeta: { title: 'Senior Backend Engineer', seniority: 'senior', industry: 'Fintech', department: 'Payments' },
      skills: { technical: ['TypeScript'], required: [], preferred: [], tools: [], soft: [], technologies: [] },
      technologies: [],
      protocols: [],
      methodologies: [],
      architecturePatterns: [],
      responsibilities: ['build services'],
      domainKnowledge: [],
      softSkills: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
      jobField: 'backend',
      salary: { min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null },
      filter: {
        jobType: 'remote',
        onsiteInterview: 'not_specified',
        companyCategory: 'fintech',
        clearanceRequired: 'none',
        region: 'us',
        usState: '',
      },
      sourceJobDescription: POSTING,
    },
    jobFieldId: 'backend',
    modelId: 'm1',
    promptHash: 'p1',
    source: 'ai',
    createdBy: null,
    createdAt: '2026-10-05T12:00:00.000Z',
    mergedAt: null,
    ...overrides,
  };
}

// -- the salary line ---------------------------------------------------------- //

test("the page writes a salary exactly as the server writes it into the sheet's Salary column", () => {
  // Raw answers as a model might give them, normalised by the server first -
  // the page only ever sees normalised salaries.
  const answers = [
    null,
    undefined,
    {},
    { min: 120000, max: 140000, currency: 'usd', period: 'Annual' },
    { min: '120k', max: '$140,000', currency: 'USD', period: 'per year' },
    { min: 60, currency: 'EUR', period: 'hourly' },
    { max: 95000.5, currency: 'GBP' },
    { min: 50000 },
    { min: 140000, max: 120000, currency: 'USD', period: 'annual' },
    { raw: '  Competitive,\n  DOE  ' },
    { min: 1, max: 2, raw: 'USD 1-2 per hour, as stated' },
    { min: 'lots', max: null, currency: 'dollars' },
    { min: 0, max: 0, currency: 'JPY', period: 'monthly' },
  ];
  for (const answer of answers) {
    const salary = facts.normalizeSalary(answer);
    assert.equal(held.formatSalary(salary), facts.formatSalary(salary), JSON.stringify(answer));
  }
  assert.equal(
    held.formatSalary({ min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null }),
    'USD 120,000 - 140,000 / annual'
  );
  assert.equal(held.formatSalary(null), '');
  assert.equal(held.formatSalary({ min: null, max: null, currency: 'USD', period: 'annual', raw: null }), '');
});

// -- the posting a held analysis is for --------------------------------------- //

test("the page's posting text is the server's: whitespace runs are one space, the ends trimmed", () => {
  const texts = [POSTING, `  ${POSTING}  `, POSTING.replace(/ /g, '\n\t '), 'a b', '\r\n', '', 'x  y\n\nz'];
  for (const text of texts) {
    assert.equal(held.normalizePostingText(text), identity.normalizeJobDescriptionText(text), JSON.stringify(text));
  }
});

test('a held analysis serves the same posting, whitespace and all, and nothing else', () => {
  const analysis = { analysisId: 'a-1', jobMeta: { title: 'Engineer' }, jobFieldLabel: 'Backend', salary: null };
  const holding = held.holdAnalysis(analysis, POSTING);
  assert.equal(holding.analysisId, 'a-1');
  assert.equal(holding.analysis, analysis);

  // The same posting re-pasted with different spacing is the same posting -
  // the server would say so too, so asking again would only be a lookup.
  assert.equal(held.heldAnalysisFor(holding, `\n${POSTING.replace(/ /g, '  ')}\n`), holding);
  // Edited text is another posting.
  assert.equal(held.heldAnalysisFor(holding, `${POSTING} Remote.`), null);
  // So is the same text under another link.
  assert.equal(held.heldAnalysisFor(holding, POSTING, 'https://jobs.example/1'), null);
  const linked = held.holdAnalysis(analysis, POSTING, 'https://jobs.example/1');
  assert.equal(held.heldAnalysisFor(linked, POSTING, ' https://jobs.example/1 '), linked);

  assert.equal(held.heldAnalysisFor(null, POSTING), null);
  assert.equal(held.heldAnalysisFor(undefined, POSTING), null);
  assert.equal(held.heldAnalysisFor({ ...holding, analysisId: '' }, POSTING), null);
});

test('only a 400 makes the page let go of the analysis it holds', () => {
  // A 400 is what an analysisId the server has no row for gets; letting go
  // costs the next press one lookup by text, never a model call.
  assert.equal(held.dropsHeldAnalysis({ status: 400, message: 'That job analysis was not found.' }), true);
  for (const error of [{ status: 402 }, { status: 403 }, { status: 409 }, { status: 500 }, new Error('x'), null, undefined, 'x']) {
    assert.equal(held.dropsHeldAnalysis(error), false, JSON.stringify(error));
  }
});

const NO_FACTS = { title: '', jobField: '', salary: '', jobType: '', seniority: '', clearance: '' };

test('an analysis shows its title, job field, job type, seniority, clearance and salary - each only when it has one', () => {
  assert.deepEqual(
    held.analysisFacts({
      jobMeta: { title: '  Senior Backend Engineer ', seniority: 'unknown' },
      jobFieldLabel: 'Backend',
      salary: { min: 120000, max: 140000, currency: null, period: 'annual', raw: null },
      filter: { ...stored().analysis.filter, seniority: 'senior' },
    }),
    {
      title: 'Senior Backend Engineer',
      jobField: 'Backend',
      salary: '120,000 - 140,000 / annual',
      jobType: 'Remote',
      seniority: 'Senior',
      clearance: 'No clearance',
    }
  );
  // A posting that fits no field says so; one that states no salary shows none.
  assert.deepEqual(held.analysisFacts({ jobMeta: { title: '' }, jobFieldLabel: 'Unclassified', salary: null }), {
    ...NO_FACTS,
    jobField: 'Unclassified',
  });
  // An analysis without facts shows none of them - not a made-up "No clearance".
  assert.deepEqual(held.analysisFacts({ jobMeta: { title: 'Engineer' } }), { ...NO_FACTS, title: 'Engineer' });
  assert.deepEqual(held.analysisFacts(null), NO_FACTS);
  // An analysis made before the facts call read a seniority shows its own.
  assert.equal(held.analysisFacts({ jobMeta: { seniority: 'staff' }, filter: stored().analysis.filter }).seniority, 'Staff');
  // Words that say nothing show nothing.
  for (const word of ['not_specified', 'unknown', '', 'Not Specified']) {
    assert.equal(held.seniorityLabel(word), '', word);
  }
  assert.equal(held.seniorityLabel('vp'), 'VP');
  assert.equal(held.analysisFacts({ filter: { jobType: 'not_specified', clearanceRequired: 'ts_sci' } }).clearance, 'Clearance required');
});

test("the page's job type, seniority and clearance are the server's, for every word the facts call may answer", () => {
  const { jobFilterAnalysisOf } = require('../dist/services/jobFilter');
  // The server's labels, word for word.
  for (const id of ['remote', 'hybrid', 'on_site', 'not_specified', '', 'Remote']) {
    assert.equal(held.JOB_TYPE_LABELS[id] ?? '', facts.jobTypeLabel(id), id);
  }
  const answers = [
    {},
    { job_type: 'remote', clearance_required: 'none', seniority: 'senior' },
    { job_type: 'Hybrid', clearance_required: 'secret', seniority: 'Staff' },
    { job_type: 'on-site', clearance_required: 'not_specified', seniority: 'intern' },
    { job_type: 'office', clearance_required: 'Q clearance', seniority: 'wizard' },
    { job_type: 'not_specified', clearance_required: 'TS/SCI', seniority: 'vp' },
  ];
  for (const answer of answers) {
    const read = facts.normalizeJobFacts(answer);
    for (const jobMeta of [{ seniority: 'lead' }, { seniority: 'unknown' }, {}]) {
      // A new analysis, as the gate composes it.
      const analysis = { jobMeta, filter: read.filter, salary: read.salary };
      const shown = held.analysisFacts(analysis);
      assert.equal(shown.jobType, facts.jobTypeLabel(facts.jobTypeOf(analysis)), JSON.stringify(answer));
      assert.equal(held.clearanceRequiredOf(analysis), facts.clearanceRequiredOf(analysis), JSON.stringify(answer));
      assert.equal(held.seniorityOf(analysis), jobFilterAnalysisOf(analysis).seniority, JSON.stringify(answer));
      // An older analysis, whose facts never had a seniority: the filter judges jobMeta's.
      const { seniority: _new, ...olderFilter } = read.filter;
      const older = { jobMeta, filter: olderFilter };
      assert.equal(held.seniorityOf(older), jobFilterAnalysisOf(older).seniority, JSON.stringify(jobMeta));
    }
  }
});

// -- the Prompt Test page's marks -------------------------------------------- //

test("Prompt Test marks the posting's keywords, never the facts the analysis read about it", () => {
  const marks = loadFrontendModule('lib/analysisHighlights.ts');
  const read = facts.normalizeJobFacts({
    job_type: 'remote',
    onsite_interview: 'no',
    company_category: 'saas',
    seniority: 'senior',
    clearance_required: 'none',
    salary: { min: 120000, max: 140000, period: 'annual', raw: '$120k - $140k' },
    region: 'us',
    us_state: null,
    job_field: 'backend',
  });
  // What /resume/analyze-prompt-test answers, less the id and label beside it.
  const analysis = {
    jobMeta: { title: 'Senior Backend Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
    skills: { technical: ['API design'], tools: ['Docker'], soft: ['Ownership'] },
    technologies: ['TypeScript'],
    protocols: ['REST'],
    methodologies: [],
    architecturePatterns: ['microservices'],
    responsibilities: ['backend service ownership'],
    domainKnowledge: ['payments'],
    keywords: { actionVerbs: ['built'], buzzwords: [], mustInclude: ['TypeScript'] },
    jobField: read.jobField,
    salary: read.salary,
    filter: read.filter,
    // An older analysis's industry is a fact too.
    industry: 'technology',
  };
  const terms = marks.collectHighlightTerms(analysis);
  const values = terms.map((term) => term.value);
  for (const fact of ['us', 'remote', 'saas', 'none', 'no', 'backend', 'technology', '$120k - $140k', 'annual', 'not_specified']) {
    assert.equal(values.includes(fact), false, `${fact} is a fact, not a term`);
  }
  for (const term of ['API design', 'Docker', 'Ownership', 'TypeScript', 'REST', 'microservices', 'payments', 'built', 'SaaS']) {
    assert.ok(values.includes(term), term);
  }
  assert.equal(terms.find((term) => term.value === 'API design').kind, 'required');
  assert.equal(terms.find((term) => term.value === 'Ownership').kind, 'soft');
  assert.equal(terms.find((term) => term.value === 'payments').kind, 'domain');
  // Longest first, so a longer term wins an overlap.
  assert.deepEqual(values, [...values].sort((a, b) => b.length - a.length));
  assert.deepEqual([...marks.ANALYSIS_FACT_KEYS], ['jobField', 'industry', 'salary', 'filter']);
  // An older analysis's own lists are still read.
  const older = marks.collectHighlightTerms({ skills: { required: ['Go'], preferred: ['Rust'], technologies: ['Kafka'] }, softSkills: ['Grit'] });
  assert.deepEqual(
    Object.fromEntries(older.map((term) => [term.value, term.kind])),
    { Kafka: 'keyword', Rust: 'preferred', Grit: 'soft', Go: 'required' }
  );
  assert.deepEqual(marks.collectHighlightTerms(null), []);
});

// -- the sheet's analysis columns ----------------------------------------------- //

/** A column letter as a 1-based number (A = 1, Z = 26). */
function columnNumber(letters) {
  return [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

test("the panel reads the account sheet's columns where the server writes them", () => {
  const own = rows.OWN_SHEET_LAYOUT;
  assert.equal(columnNumber(own.company), JOB_SHEET_COLUMNS.company);
  assert.equal(columnNumber(own.jobTitle), JOB_SHEET_COLUMNS.jobTitle);
  assert.equal(columnNumber(own.jobLink), JOB_SHEET_COLUMNS.jobLink);
  assert.equal(columnNumber(own.jobDescription), JOB_SHEET_COLUMNS.jobDescription);
  // The protected three: the Analysis cell is what the server reads to skip a
  // row's analysis, so the panel's "Skips analysis" must be about that cell.
  assert.equal(columnNumber(own.jobField), JOB_SHEET_COLUMNS.jobField);
  assert.equal(columnNumber(own.salary), JOB_SHEET_COLUMNS.salary);
  assert.equal(columnNumber(own.analysis), JOB_SHEET_COLUMNS.analysis);
  // Read in one second range, G:L - the protected block, Job Field first and
  // Analysis last - so they must be one block in that order.
  assert.ok(JOB_SHEET_COLUMNS.jobField < JOB_SHEET_COLUMNS.salary && JOB_SHEET_COLUMNS.salary < JOB_SHEET_COLUMNS.analysis);
  assert.equal(columnNumber(own.jobField), ANALYSIS_FIRST_COLUMN);
  assert.equal(columnNumber(own.analysis), ANALYSIS_LAST_COLUMN);
  // The rows read are the job's own four, C:F - never A and B, which the
  // export writes and the build has no use for.
  assert.equal(columnNumber(own.fromCol), JOB_SHEET_COLUMNS.company);
  assert.equal(columnNumber(own.toCol), JOB_SHEET_COLUMNS.jobDescription);
});

test("an Analysis cell's state is the server's, for every kind of cell", () => {
  assert.equal(rows.ANALYSIS_TRUNCATED_MARKER, cells.ANALYSIS_TRUNCATED_MARKER);

  const written = cells.analysisCellText(stored());
  const huge = stored({
    analysis: { ...stored().analysis, responsibilities: Array.from({ length: 4000 }, (_, i) => `responsibility number ${i}`) },
  });
  const cut = cells.analysisCellText(huge);
  assert.ok(cut.length <= cells.ANALYSIS_CELL_LIMIT && cut.endsWith(cells.ANALYSIS_TRUNCATED_MARKER));

  const samples = [
    '',
    '   ',
    written,
    `  ${written}\n`,
    cut,
    // A cut cell that happens to parse is still a cut cell.
    `{"v":1,"analysis":{}}${cells.ANALYSIS_TRUNCATED_MARKER.trim()}`,
    '{"v":1,"id":"x","analysis":{"jobMeta":{}}}',
    '{"v":1,"id":"x"}',
    '{"v":1,"analysis":"text"}',
    '{"v":1,"analysis":null}',
    '{"v":1,"analysis":[]}',
    'null',
    '42',
    '"text"',
    'Backend',
    '{not json',
    '=HYPERLINK("https://x.example")',
  ];
  for (const sample of samples) {
    assert.equal(rows.sheetAnalysisState(sample), cells.parseAnalysisCell(sample).state, JSON.stringify(sample.slice(0, 60)));
  }
  assert.equal(rows.sheetAnalysisState(written), 'ok');
  assert.equal(rows.sheetAnalysisState(cut), 'truncated');
  assert.equal(rows.sheetAnalysisState(undefined), 'empty');
});

test('a loaded row says whether its build skips analysis, with the Job Field and Salary the sheet holds', () => {
  const analysed = stored();
  // G:L as the server writes them (analysisColumnValues): Job Field, Salary,
  // Job Type, Clearance, Industry, Analysis - read back FORMATTED, so the
  // Clearance boolean is the text Google shows.
  const written = cells.analysisColumnValues(analysed).map((value) =>
    typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value ?? ''
  );
  // C:F as the panel loads them, then G:L from the second read.
  const jobColumns = [
    ['Acme', 'Backend Engineer', 'https://acme.example/jobs/1', POSTING],
    ['Beta', '', '', `${POSTING} Beta.`],
    ['Gamma', 'Analyst', '', `${POSTING} Gamma.`],
    ['Delta', '', '', `${POSTING} Delta.`],
  ];
  const analysisColumns = [
    written,
    [],
    ['', '', '', '', '', '{"v":1,"id":"x"'],
    ['Backend', 'USD 1', '', '', '', cells.analysisCellText(stored({ analysis: { ...analysed.analysis, responsibilities: Array(5000).fill('long responsibility text') } }))],
  ];
  const width = 4;
  const merged = rows.appendColumns(jobColumns, width, analysisColumns);
  assert.equal(merged[0].length, width + 6);
  // A short row is padded, so the second read's columns land where they belong.
  assert.deepEqual(rows.appendColumns([['only']], 3, [['K', 'L']]), [['only', '', '', 'K', 'L']]);
  assert.deepEqual(rows.appendColumns([['a'], ['b']], 1, [['K']]), [['a', 'K'], ['b']]);

  const { jobs } = rows.buildSheetJobs(merged, 2, {
    companyName: 0,
    jobTitle: 1,
    jobLink: 2,
    jobDescription: 3,
    jobField: width,
    salary: width + 1,
    analysis: width + 5,
  });
  assert.deepEqual(
    jobs.map((job) => [job.sourceRowNumber, job.analysis, job.jobField, job.salary]),
    [
      [2, 'ok', 'Backend', 'USD 120,000 - 140,000 / annual'],
      [3, 'empty', '', ''],
      [4, 'unparseable', '', ''],
      [5, 'truncated', 'Backend', 'USD 1'],
    ]
  );

  const notes = jobs.map((job) => rows.describeRowAnalysis(job.analysis));
  assert.deepEqual(
    notes.map((note) => [note.label, note.tone, note.skipsAnalysis]),
    [
      ['Skips analysis', 'green', true],
      ['When built', 'grey', false],
      ['Cell unreadable', 'amber', false],
      ['Cell unreadable', 'amber', false],
    ]
  );
  // A sheet whose analysis cells were not read says nothing it cannot know.
  assert.equal(rows.describeRowAnalysis(null).skipsAnalysis, false);
  assert.equal(rows.describeRowAnalysis(null).label, 'When built');
  assert.equal(rows.countSkippingAnalysis(jobs), 1);
  assert.equal(rows.countSkippingAnalysis([]), 0);

  // Not mapped at all: no state, no facts.
  const plain = rows.buildSheetJobs(jobColumns, 2, {
    companyName: 0,
    jobTitle: 1,
    jobLink: 2,
    jobDescription: 3,
    jobField: null,
    salary: null,
    analysis: null,
  });
  assert.deepEqual(plain.jobs.map((job) => [job.analysis, job.jobField, job.salary]), [
    [null, '', ''],
    [null, '', ''],
    [null, '', ''],
    [null, '', ''],
  ]);
});

// -- Admin -> Prompts: the variables a prompt must use ---------------------- //

test('the server flags a saved prompt missing a required variable or naming one it does not supply, and marks the required ones', async () => {
  // What Admin -> Prompts reads to draw its pill and note: `needsUpdate` on
  // the saved record, `validation.missingVariables` in the feature's own
  // order and `validation.unknownVariables`, and `required: true` on the
  // required variables in `allowedVariables`.
  const promptService = require('../dist/services/promptService');
  assert.deepEqual(promptService.listRequiredPromptVariables('analyze-job-description'), ['jobDescription']);
  assert.deepEqual(promptService.listRequiredPromptVariables('filter-google-sheet-job'), ['jobDescription']);
  assert.deepEqual(promptService.listRequiredPromptVariables('generate-cover-letter'), ['profileJson']);
  assert.deepEqual(promptService.listRequiredPromptVariables('tailor-resume'), [
    'profileJson',
    'jobAnalysisJson',
    'softSkillGroupHeading',
  ]);
  assert.deepEqual(promptService.listRequiredPromptVariables('revise-resume-coverage'), ['draftJson', 'missingTermsJson']);
  assert.deepEqual(promptService.listRequiredPromptVariables('extract-profile-from-resume'), []);

  const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');
  const storage = useTempStorage('frontend-prompt-notes');
  const shipped = path.join(__dirname, '..', 'static');
  fs.cpSync(path.join(shipped, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  const write = (id, content) =>
    writeStaticJson(storage.staticDir, `prompts/${id}.json`, {
      id,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  const cases = [
    // [text, missing, unknown]
    ['Analyze the posting at [[jobLink]].', ['jobDescription'], []],
    ['Analyze.\n[[jobDescription]]', [], []],
    ['Analyze.\n[[ jobDescription ]]\nJob link: [[jobLink]]', [], []],
    // Named in prose, never as a variable: not a use.
    ['Analyze the jobDescription.\n[[jobLink]]', ['jobDescription'], []],
    // An edit written for the older prompt: its lists are supplied no more.
    ['Analyze.\n[[jobFieldList]]\n[[industryList]]\n[[jobDescription]]', [], ['jobFieldList', 'industryList']],
  ];
  for (const [content, missing, unknown] of cases) {
    write('analyze-job-description', content);
    write('tailor-resume', 'New.\n[[profileJson]]\nStrengths: [[ includeStrengths ]]');
    write('revise-resume-coverage', 'Revise.\n[[draftJson]]');
    const listed = new Map((await loadFresh('../dist/services/promptService').listPrompts()).map((prompt) => [prompt.id, prompt]));
    const analysis = listed.get('analyze-job-description');
    assert.deepEqual(analysis.validation.missingVariables, missing, content);
    assert.deepEqual(analysis.validation.unknownVariables, unknown, content);
    assert.equal(analysis.needsUpdate === true, missing.length + unknown.length > 0, content);
    assert.deepEqual(
      analysis.allowedVariables.filter((variable) => variable.required).map((variable) => variable.name),
      ['jobDescription']
    );
    const tailor = listed.get('tailor-resume');
    // An edit written for the switches: missing the new markers, and naming
    // one nothing supplies any more.
    assert.deepEqual(tailor.validation.missingVariables, ['jobAnalysisJson', 'softSkillGroupHeading']);
    assert.deepEqual(tailor.validation.unknownVariables, ['includeStrengths']);
    assert.equal(tailor.needsUpdate, true);
    const revise = listed.get('revise-resume-coverage');
    assert.deepEqual(revise.validation.missingVariables, ['missingTermsJson']);
    assert.equal(revise.needsUpdate, true);
    for (const flag of ['predatesJobField', 'predatesIndustry', 'predatesSectionSwitches']) {
      assert.equal(flag in analysis || flag in tailor, false, `${flag} is gone`);
    }
  }
});

test("the editor reads the text as typed exactly as the server does, and refuses a save in the server's own words", async () => {
  const notes = loadFrontendModule('lib/promptRequirements.ts');
  const { loadFresh, useTempStorage } = require('./helpers');
  const storage = useTempStorage('frontend-prompt-requirements');
  const shipped = path.join(__dirname, '..', 'static');
  for (const dir of ['skills', 'prompts']) {
    fs.cpSync(path.join(shipped, dir), path.join(storage.staticDir, dir), { recursive: true });
  }
  const promptService = loadFresh('../dist/services/promptService');
  const listed = new Map((await promptService.listPrompts()).map((prompt) => [prompt.featureKey, prompt]));
  // The features the page offers no variant, activation or override for are the server's.
  assert.deepEqual([...notes.SINGLE_PROMPT_FEATURES], promptService.listSinglePromptFeatures());
  for (const featureKey of promptService.listPromptFeatureKeys()) {
    assert.equal(notes.isSinglePromptFeature(featureKey), promptService.listSinglePromptFeatures().includes(featureKey), featureKey);
  }
  // The one set replaced the analysis's own constant (the page's copy named only the analysis).
  assert.equal('ANALYSIS_PROMPT_FEATURE' in notes, false);

  // The page reads the required ones off the record the server lists, in the feature's order.
  for (const [featureKey, prompt] of listed) {
    assert.deepEqual(notes.requiredVariables(prompt.allowedVariables), promptService.listRequiredPromptVariables(featureKey), featureKey);
  }

  const analysis = listed.get('analyze-job-description');
  const facts = listed.get('filter-google-sheet-job');
  const letter = listed.get('generate-cover-letter');
  const tailor = listed.get('tailor-resume');
  const revise = listed.get('revise-resume-coverage');
  const texts = [
    'Analyze.\n[[jobDescription]]',
    'Analyze the posting at [[jobLink]].',
    'Analyze.\n[[ jobDescription ]]\n[[jobLink]]',
    'Analyze the jobDescription.\n[[jobLink]]',
    'Analyze.\n[jobDescription]\n[[jobLink]]',
    'Write for [[profileJson]] at [[companyName]].',
    'Write to [[companyName]] about [[role]].',
    'Tailor.\n[[profileJson]]\n[[jobAnalysisJson]]',
    'Tailor.\n[[profileJson]]\nStrengths: [[ includeStrengths ]] [[technicalSkillsLayout]]',
    'Tailor.\n[[profileJson]]\n[[ jobAnalysisJson ]] [[softSkillGroupHeading]]',
    'Revise.\n[[draftJson]]\n[[missingTermsJson]] [[figuresNote]]',
    'Revise.\n[[draftJson]]',
  ];
  for (const prompt of [analysis, facts, letter, tailor, revise]) {
    for (const content of texts) {
      // The same names missing, in the same order, as the server's own validation.
      const server = promptService.validatePromptContent(content, prompt.allowedVariables).missingVariables;
      assert.deepEqual(notes.missingRequiredVariables(content, prompt.allowedVariables), server, `${prompt.featureKey}: ${content}`);
    }
  }
  // An unattached prompt has none to miss.
  assert.deepEqual(notes.missingRequiredVariables('Anything [[x]]', [{ name: 'x' }]), []);

  // What Save says without sending is the server's refusal of that save, word for word.
  for (const [prompt, content] of [
    [analysis, 'Analyze the posting at [[jobLink]].'],
    [facts, 'Facts of the posting at [[jobLink]].'],
    [letter, 'Write to [[companyName]] about [[role]].'],
    [tailor, 'Tailor.\n[[profileJson]]\n[[softSkillGroupHeading]]'],
    [revise, 'Revise.\n[[draftJson]]\n[[figuresNote]]'],
  ]) {
    const missing = notes.missingRequiredVariables(content, prompt.allowedVariables);
    assert.ok(missing.length > 0, content);
    const refused = await promptService.updatePrompt(prompt.id, { content }).then(
      () => assert.fail(`the server saved ${JSON.stringify(content)}`),
      (error) => error.message
    );
    assert.equal(notes.missingVariablesSentence(prompt.featureLabel, missing, notes.requiredVariables(prompt.allowedVariables)), refused);
  }

  // Every single-prompt feature has its own sentences on the page, the analysis's still opening as it did.
  assert.deepEqual(Object.keys(notes.SINGLE_PROMPT_NOTES), promptService.listSinglePromptFeatures());
  for (const [featureKey, note] of Object.entries(notes.SINGLE_PROMPT_NOTES)) {
    assert.ok(note.about && note.model, featureKey);
  }
  assert.match(notes.SINGLE_PROMPT_NOTES['analyze-job-description'].about, /^Job analysis has one prompt/);
  // The notes follow the builder modes (owner decision D19): Fully names the profile's default resume, the cover
  // letter names the Choose Suitable Resume builds, and none says a model sets what a resume costs.
  assert.match(notes.SINGLE_PROMPT_NOTES['tailor-resume-full'].about, /^Fully tailoring has one prompt/);
  assert.match(notes.SINGLE_PROMPT_NOTES['tailor-resume-full'].about, /Fully Tailor run uses it for the profile's default resume/);
  assert.match(notes.SINGLE_PROMPT_NOTES['generate-cover-letter'].about, /Choose Suitable Resume/);
  for (const [featureKey, note] of Object.entries(notes.SINGLE_PROMPT_NOTES)) {
    assert.doesNotMatch(`${note.about} ${note.model}`, /model's price|price of (the|a) model|\bplan\b|Premium/i, featureKey);
  }

  // A variable the prompt is not given is read off the text as the server reads it...
  const named = [
    'Analyze.\n[[jobDescription]]',
    'Analyze.\n[[jobDescription]]\n[[jobFieldList]] [[ industryList ]] [[jobFieldList]]',
    'Facts of [[jobContent]].',
    'Tailor.\n[[profileJson]] [[jobAnalysisJson]] [[softSkillGroupHeading]] [[includeStrengths]] [[hardSkillsJson]]',
    'Revise [[draftJson]] [[missingTermsJson]] [[figuresNote]] [[profileJson]]',
  ];
  for (const prompt of [analysis, facts, letter, tailor, revise]) {
    for (const content of named) {
      assert.deepEqual(
        notes.unknownVariables(content, prompt.allowedVariables),
        promptService.validatePromptContent(content, prompt.allowedVariables).unknownVariables,
        `${prompt.featureKey}: ${content}`
      );
    }
  }
  // ...and Save refuses it first, as the server does, in the server's words.
  for (const [prompt, content] of [
    [analysis, 'Analyze.\n[[jobDescription]]\n[[jobFieldList]] [[industryList]]'],
    [facts, 'Facts of [[jobContent]].'],
    [tailor, 'Tailor.\n[[profileJson]] [[includeSoftSkills]]'],
    [revise, 'Revise [[draftJson]]'],
    [letter, 'Write to [[companyName]].'],
  ]) {
    const refusal = notes.saveRefusal(content, prompt.allowedVariables, prompt.featureLabel);
    assert.ok(refusal, content);
    const refused = await promptService.updatePrompt(prompt.id, { content }).then(
      () => assert.fail(`the server saved ${JSON.stringify(content)}`),
      (error) => error.message
    );
    assert.equal(refusal, refused, content);
  }
  assert.equal(notes.saveRefusal('Analyze.\n[[jobDescription]] [[jobLink]]', analysis.allowedVariables, analysis.featureLabel), '');

  // The list's line says why a flagged prompt is not run, whichever it is.
  assert.equal(notes.notRunLine({ missingVariables: ['jobDescription'] }), 'Not run: it does not use [[jobDescription]].');
  assert.equal(
    notes.notRunLine({ missingVariables: [], unknownVariables: ['jobFieldList', 'industryList'] }),
    'Not run: it uses [[jobFieldList]] and [[industryList]], which this version does not supply.'
  );
  assert.equal(
    notes.notRunLine({ missingVariables: ['softSkillGroupHeading'], unknownVariables: ['includeStrengths'] }),
    'Not run: it does not use [[softSkillGroupHeading]], and uses [[includeStrengths]], which this version does not supply.'
  );
  assert.equal(notes.notRunLine({ missingVariables: [], unknownVariables: [] }), 'Not run: it cannot run as it is.');
  // A record the server dates from before its feature's contract changed - its variables all fine.
  assert.equal(notes.notRunLine({ missingVariables: [], unknownVariables: [] }, true), 'Not run: it dates from an older version of this prompt.');
  assert.equal(
    notes.notRunLine({ missingVariables: [], unknownVariables: ['jobFieldList'] }, true),
    'Not run: it uses [[jobFieldList]], which this version does not supply, and dates from an older version of this prompt.'
  );

  assert.equal(notes.variableList(['a']), '[[a]]');
  assert.equal(notes.variableList(['a', 'b']), '[[a]] and [[b]]');
  assert.equal(notes.variableList(['a', 'b', 'c']), '[[a]], [[b]] and [[c]]');

  // The note on a saved prompt the server will not run says why, and what runs instead.
  assert.equal(
    notes.needsUpdateNote({ featureLabel: 'Analyze Job Description', isBuiltIn: true, missing: ['jobDescription'] }),
    'The saved prompt does not use [[jobDescription]], which every Analyze Job Description prompt must use, so the ' +
      'shipped Analyze Job Description prompt runs in its place until it is saved with it.'
  );
  assert.equal(
    notes.needsUpdateNote({ featureLabel: 'Analyze Job Description', isBuiltIn: true, missing: [], unknown: ['jobFieldList', 'industryList'] }),
    'The saved prompt uses [[jobFieldList]] and [[industryList]], which this version does not supply, so the ' +
      'shipped Analyze Job Description prompt runs in its place until it is saved without them.'
  );
  assert.equal(
    notes.needsUpdateNote({ featureLabel: 'Job Facts (Filter)', isBuiltIn: true, missing: ['jobDescription'], unknown: ['jobContent'] }),
    'The saved prompt does not use [[jobDescription]], which every Job Facts (Filter) prompt must use, and uses ' +
      '[[jobContent]], which this version does not supply, so the shipped Job Facts (Filter) prompt runs in its ' +
      'place until it is saved with [[jobDescription]] and without [[jobContent]].'
  );
  assert.equal(
    notes.needsUpdateNote({ featureLabel: 'Job Facts (Filter)', isBuiltIn: false, missing: [] }),
    'The saved prompt cannot run as it is, so the built-in Job Facts (Filter) prompt runs in its place until it is updated.'
  );
  assert.match(
    notes.needsUpdateNote({ featureLabel: 'Tailor Resume', isBuiltIn: false, missing: ['jobAnalysisJson', 'softSkillGroupHeading'] }),
    /\[\[jobAnalysisJson\]\] and \[\[softSkillGroupHeading\]\], .* so the built-in Tailor Resume prompt runs in its place until it is saved with them\.$/
  );
  assert.equal(
    notes.needsUpdateNote({ featureLabel: 'Analyze Job Description', isBuiltIn: true, missing: [], unknown: [], savedForOlderVersion: true }),
    'The saved prompt dates from an older version of the Analyze Job Description prompt, so the shipped Analyze Job ' +
      'Description prompt runs in its place until it is saved again.'
  );
  assert.equal(
    notes.needsUpdateNote({ featureLabel: 'Job Facts (Filter)', isBuiltIn: true, missing: ['jobDescription'], unknown: ['jobContent'], savedForOlderVersion: true }),
    'The saved prompt does not use [[jobDescription]], which every Job Facts (Filter) prompt must use, and uses ' +
      '[[jobContent]], which this version does not supply, and dates from an older version of the Job Facts (Filter) ' +
      'prompt, so the shipped Job Facts (Filter) prompt runs in its place until it is saved with [[jobDescription]] and ' +
      'without [[jobContent]].'
  );

  // The flag is the server's, by the record's date: an edit saved before the
  // owner's texts that names only [[jobDescription]] is listed with it, and
  // the notes say why from what the list sends - and a save clears it.
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  saveStoredPrompt({
    id: 'analyze-job-description',
    featureKey: 'analyze-job-description',
    content: 'OLD ADMIN ANALYSIS EDIT.\n[[jobDescription]]',
    isBuiltIn: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  const dated = (await promptService.listPrompts()).find((prompt) => prompt.id === 'analyze-job-description');
  assert.equal(dated.needsUpdate, true);
  assert.equal(dated.savedForOlderVersion, true);
  assert.equal(notes.notRunLine(dated.validation, dated.savedForOlderVersion), 'Not run: it dates from an older version of this prompt.');
  assert.match(
    notes.needsUpdateNote({
      featureLabel: dated.featureLabel,
      isBuiltIn: dated.isBuiltIn,
      missing: dated.validation.missingVariables,
      unknown: dated.validation.unknownVariables,
      savedForOlderVersion: dated.savedForOlderVersion,
    }),
    /dates from an older version of the Analyze Job Description prompt, so the shipped .* until it is saved again\.$/
  );
  await promptService.updatePrompt('analyze-job-description', { content: 'OLD ADMIN ANALYSIS EDIT.\n[[jobDescription]]' });
  assert.equal((await promptService.listPrompts()).find((prompt) => prompt.id === 'analyze-job-description').savedForOlderVersion, undefined);

  // And the page draws the server's flag, never a rule of its own about prompt history.
  const page = fs.readFileSync(path.join(SRC, 'app', 'admin', 'prompts', 'page.tsx'), 'utf8');
  assert.match(page, /prompt\.needsUpdate && <Pill tone="amber">Needs update<\/Pill>/);
  assert.match(page, /missingVariablesSentence\(/);
  assert.match(page, /notRunLine\(prompt\.validation, prompt\.savedForOlderVersion\)/);
  assert.match(page, /unknown: savedSummary\.validation\.unknownVariables/);
  assert.match(page, /savedForOlderVersion: savedSummary\.savedForOlderVersion/);
  // The page's feature order is the server's.
  const orderBlock = page.slice(page.indexOf('const FEATURE_ORDER'), page.indexOf('];', page.indexOf('const FEATURE_ORDER')));
  assert.deepEqual([...orderBlock.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]), promptService.listPromptFeatureKeys());
  assert.doesNotMatch(page, /predates|promptNotes|getAIModels/);
  assert.equal(fs.existsSync(path.join(SRC, 'lib', 'promptNotes.ts')), false);
});

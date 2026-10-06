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
 * the notes Admin -> Prompts puts on an analysis prompt written before job
 * fields or industries (lib/promptNotes.ts), held to the server's flags.
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
const { JOB_SHEET_COLUMNS } = require('../dist/integrations/googleSheets');

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

test('an analysis shows its title, its job field label and its salary - each only when it has one', () => {
  assert.deepEqual(
    held.analysisFacts({
      jobMeta: { title: '  Senior Backend Engineer ' },
      jobFieldLabel: 'Backend',
      salary: { min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null },
    }),
    { title: 'Senior Backend Engineer', jobField: 'Backend', salary: 'USD 120,000 - 140,000 / annual' }
  );
  // A posting that fits no field says so; one that states no salary shows none.
  assert.deepEqual(held.analysisFacts({ jobMeta: { title: '' }, jobFieldLabel: 'Unclassified', salary: null }), {
    title: '',
    jobField: 'Unclassified',
    salary: '',
  });
  // An analysis from a server before job fields has neither.
  assert.deepEqual(held.analysisFacts({ jobMeta: { title: 'Engineer' } }), { title: 'Engineer', jobField: '', salary: '' });
  assert.deepEqual(held.analysisFacts(null), { title: '', jobField: '', salary: '' });
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
  // Read in one second range, so they must be one block in that order.
  assert.ok(JOB_SHEET_COLUMNS.jobField < JOB_SHEET_COLUMNS.salary && JOB_SHEET_COLUMNS.salary < JOB_SHEET_COLUMNS.analysis);

  // Another spreadsheet has none: the server never reads or writes analyses in a sheet it does not own.
  assert.equal(rows.SAVED_SOURCE_LAYOUT.analysis, '');
  assert.equal(rows.SAVED_SOURCE_LAYOUT.jobField, '');
  assert.equal(rows.SAVED_SOURCE_LAYOUT.salary, '');
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
  // K:P as the server writes them (analysisColumnValues): Job Field, Salary,
  // Job Hash, Analyzed At, Lake Status, Analysis - nulls left empty.
  const written = cells.analysisColumnValues(analysed).map((value) => value ?? '');
  // B:E as the panel loads them, then K:P from the second read.
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

// -- Admin -> Prompts: the notes on an analysis prompt written before ----- //

test('the editor notes a prompt that predates job fields, industries or the section switches exactly when the server flags it', async () => {
  const notes = loadFrontendModule('lib/promptNotes.ts');
  const gate = require('../dist/services/jobAnalysis/gate');
  const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

  const analysisTexts = [
    'Analyze.\n[[jobDescription]]',
    'Analyze.\n[[jobFieldList]]\nJob link: [[jobLink]]\n[[jobDescription]]',
    'Analyze.\n[[ jobFieldList ]]\n[[industryList]]\nJob link: [[jobLink]]\n[[jobDescription]]',
    'Analyze.\n[[jobFieldList]]\n[[ industryList ]]\n[[jobDescription]]',
    // Named in prose, never as a variable: not a use.
    'Analyze. Use the jobFieldList and the industryList.\n[[jobDescription]]',
    'Analyze.\n[[industryList]]\n[[jobDescription]]',
    'Analyze.\n[jobFieldList]\n[[jobDescription]]',
  ];
  const tailorTexts = ['Old.\n[[profileJson]]', 'New.\n[[profileJson]]\nStrengths: [[ includeStrengths ]]', 'includeStrengths\n[[profileJson]]'];

  // What the gate appends to an analysis turn: everything since job fields,
  // the industry alone, or nothing - the page's two notes, in that order.
  for (const content of analysisTexts) {
    const override = gate.analysisOverrideFor(content);
    assert.equal(notes.lacksJobFieldList('analyze-job-description', content), override === gate.buildAnalysisFactsOverride(), content);
    assert.equal(notes.lacksIndustryList('analyze-job-description', content), override === gate.buildIndustryOverride(), content);
    assert.equal(notes.lacksJobFieldList('tailor-resume', content), false);
    assert.equal(notes.lacksIndustryList('tailor-resume', content), false);
  }

  // And the flags the server serves on the saved record, the pills beside its name.
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
  for (const [index, content] of analysisTexts.entries()) {
    write('analyze-job-description', content);
    write('tailor-resume', tailorTexts[index % tailorTexts.length]);
    const listed = new Map((await loadFresh('../dist/services/promptService').listPrompts()).map((prompt) => [prompt.id, prompt]));
    const analysis = listed.get('analyze-job-description');
    assert.equal(notes.lacksJobFieldList(analysis.featureKey, content), analysis.predatesJobField === true, content);
    assert.equal(notes.lacksIndustryList(analysis.featureKey, content), analysis.predatesIndustry === true, content);
    const tailor = listed.get('tailor-resume');
    const tailorText = tailorTexts[index % tailorTexts.length];
    assert.equal(notes.lacksSectionSwitches(tailor.featureKey, tailorText), tailor.predatesSectionSwitches === true, tailorText);
    assert.equal(notes.lacksSectionSwitches(analysis.featureKey, content), false);
  }
  // Never both notes on one prompt: the job-field instructions ask for the industry too.
  for (const content of analysisTexts) {
    assert.ok(!(notes.lacksJobFieldList('analyze-job-description', content) && notes.lacksIndustryList('analyze-job-description', content)));
  }
  // The shipped prompt carries neither.
  const shippedText = JSON.parse(fs.readFileSync(path.join(shipped, 'prompts', 'analyze-job-description.json'), 'utf8')).content;
  assert.equal(notes.lacksJobFieldList('analyze-job-description', shippedText), false);
  assert.equal(notes.lacksIndustryList('analyze-job-description', shippedText), false);
  assert.equal(notes.ANALYSIS_PROMPT_FEATURE, 'analyze-job-description');
});

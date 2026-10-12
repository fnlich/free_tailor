const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { countingSeats, freshInstall, posting } = require('./analysisHarness');
const { writeStaticJson } = require('./helpers');

/**
 * The gate is the ONLY way to a job analysis - its two calls, the analysis
 * prompt and the Job Facts (Filter) prompt - and each keeps everything that
 * does not change before the posting.
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const gate = require('../dist/services/jobAnalysis/gate');
const resumeService = require('../dist/services/resumeService');
const { assemblePrompt } = require('../dist/services/ai/promptAssembly');
const { JOB_FIELDS } = require('../dist/config/jobFields');
const { INDUSTRIES } = require('../dist/config/industries');
const { JOB_FIELD_PREAMBLE, JOB_FIELD_REMINDER } = require('../dist/services/jobAnalysis/jobFieldLine');

const SRC = path.join(__dirname, '..', 'src');

function sources(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Where the analysis's two prompts may be NAMED, and why. Anything else that
 * names one - or reaches for the halves of their completions - is a second
 * way to analyse a posting, which is exactly what the one-analysis rule
 * forbids (the Job Filter included: its facts prompt runs inside the gate).
 */
const MAY_NAME_THE_PROMPT = new Map([
  ['services/jobAnalysis/gate.ts', 'the gate: the one caller'],
  ['services/promptService.ts', "declares the features and their variables; runs nothing"],
  ['config/promptCategories.ts', 'files the features under Extracting'],
  ['types/prompt.ts', 'the feature key type'],
]);

const MAY_BUILD_THE_COMPLETION = new Map([
  ['services/jobAnalysis/gate.ts', 'the gate'],
  ['services/resumeService.ts', 'defines the values builders and the parsers'],
]);

test('nothing but the gate names the analysis prompts or builds their completions', () => {
  const offenders = [];
  for (const file of sources()) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    if (/['"`]analyze-job-description['"`]|\bANALYSIS_PROMPT_ID\b/.test(text) && !MAY_NAME_THE_PROMPT.has(relative)) {
      offenders.push(`${relative} names the analysis prompt`);
    }
    if (/['"`]filter-google-sheet-job['"`]|\bJOB_FACTS_PROMPT_ID\b/.test(text) && !MAY_NAME_THE_PROMPT.has(relative)) {
      offenders.push(`${relative} names the job facts prompt`);
    }
    if (
      /\b(buildAnalyzeJobDescriptionPromptValues|buildJobFactsPromptValues|parseJobAnalysisKeywords|parseJobFacts|composeJobAnalysis|parseJobAnalysisContent)\b/.test(text) &&
      !MAY_BUILD_THE_COMPLETION.has(relative)
    ) {
      offenders.push(`${relative} builds or parses an analysis completion`);
    }
    if (
      /\bJOB_FIELD_(PREAMBLE|REMINDER)\b/.test(text) &&
      !['services/jobAnalysis/gate.ts', 'services/jobAnalysis/jobFieldLine.ts'].includes(relative)
    ) {
      offenders.push(`${relative} sends the job field line`);
    }
    if (/\banalyzeJobDescription\s*\(|\banalysisCache\b|\binFlightAnalyses\b/.test(text)) {
      offenders.push(`${relative} has an analysis path of its own`);
    }
  }
  assert.deepEqual(offenders, [], 'a posting must reach a model through services/jobAnalysis/gate.ts alone');

  // Every exemption names a file that is there: one that outlived its file
  // would quietly let a new file at that path name the prompt.
  const stale = [...MAY_NAME_THE_PROMPT.keys(), ...MAY_BUILD_THE_COMPLETION.keys()].filter(
    (relative) => !fs.existsSync(path.join(SRC, ...relative.split('/')))
  );
  assert.deepEqual(stale, [], 'an exemption for a file that no longer exists');

  // And the gate does what this says it does: both calls are in it.
  const gateSource = fs.readFileSync(path.join(SRC, 'services', 'jobAnalysis', 'gate.ts'), 'utf8');
  assert.match(gateSource, /createPromptCompletion\(\{\s*promptId: ANALYSIS_PROMPT_ID/);
  assert.match(gateSource, /createPromptCompletion\(\{\s*promptId: JOB_FACTS_PROMPT_ID/);
  assert.match(gateSource, /export const JOB_FACTS_PROMPT_ID = 'filter-google-sheet-job'/);
  assert.equal(fs.existsSync(path.join(SRC, 'services', 'ai', 'analysisCache.ts')), false, 'the in-memory cache is gone');
});

test('each analysis call keeps every unchanging line before the posting, byte for byte - the job field list on the facts call', async () => {
  freshInstall('prefix');
  // The analysis prompt: the whole instruction is literal, the posting last.
  const ref = { id: 'analyze-job-description', mode: 'exact' };
  const one = await assemblePrompt(ref, resumeService.buildAnalyzeJobDescriptionPromptValues(posting(1), 'https://a.example.com/1'));
  const two = await assemblePrompt(
    ref,
    resumeService.buildAnalyzeJobDescriptionPromptValues(`${posting(2)} Something else entirely.`, '')
  );
  assert.equal(one.stableSystem, two.stableSystem, 'the cached part is identical whatever the posting');
  assert.ok(one.stableSystem.endsWith('Job Description:\n"""\n'), 'and it stops where the posting starts');
  assert.match(one.stableSystem, /"jobMeta": \{/, 'the output schema is in the cached part');
  assert.match(one.stableSystem, /"keywords": \{/);
  assert.doesNotMatch(one.stableSystem, /"jobField"|JOB FIELDS|INDUSTRIES/, 'no job field, industry or list: the facts call has those');
  assert.ok(!one.stableSystem.includes('Posting 1'), 'no posting in the cached part');
  assert.ok(one.userBody.startsWith(posting(1)));

  // The facts prompt: its instructions before the posting's START marker.
  const facts = { id: 'filter-google-sheet-job', mode: 'exact' };
  const three = await assemblePrompt(facts, resumeService.buildJobFactsPromptValues(posting(3), 'https://a.example.com/3'));
  const four = await assemblePrompt(facts, resumeService.buildJobFactsPromptValues(posting(4), ''));
  assert.equal(three.stableSystem, four.stableSystem);
  assert.ok(three.stableSystem.endsWith('---JOB DESCRIPTION START---\n'));
  assert.ok(three.userBody.startsWith(posting(3)));

  // Through a seat: each call's system part is the same turn to turn, and
  // the facts call's starts with the code's job field list.
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  const seats = countingSeats(ai);
  await gate.getOrCreateAnalysis({ jd: posting(5) });
  await gate.getOrCreateAnalysis({ jd: posting(6), link: 'https://b.example.com/6' });
  const [first, second] = seats.analyses();
  assert.equal(first.stableSystem, second.stableSystem);
  assert.notEqual(first.userBody, second.userBody);
  assert.doesNotMatch(first.userBody, /job_field/, 'the analysis turn carries no addendum');

  const [firstFacts, secondFacts] = seats.facts();
  assert.equal(firstFacts.stableSystem, secondFacts.stableSystem, 'cached whole, the job field list included');
  assert.ok(firstFacts.stableSystem.startsWith(`${JOB_FIELD_PREAMBLE}\n\n`), "the code's text before the prompt's");
  assert.ok(firstFacts.stableSystem.endsWith('---JOB DESCRIPTION START---\n'));
  for (const field of JOB_FIELDS) assert.ok(firstFacts.stableSystem.includes(`- ${field.id}: ${field.label}`), field.id);
  assert.ok(firstFacts.stableSystem.includes('- unclassified: none of the above fits'));
  // The industries reach no model: an analysis's industry is derived from its company category.
  for (const industry of INDUSTRIES) assert.ok(!firstFacts.stableSystem.includes(`- ${industry.id}: ${industry.label}`), industry.id);
  assert.ok(firstFacts.userBody.includes(posting(5)));
  assert.ok(firstFacts.userBody.endsWith(`---JOB DESCRIPTION END---\n\n${JOB_FIELD_REMINDER}`), 'the reminder is the last thing read');
});

test("an administrator's prompt edits: an analysis edit runs as written, an outdated one does not - and no edit drops the job field", async () => {
  freshInstall('edits');
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const at = '2026-01-01T00:00:00.000Z';
  const turnOf = async (n) => {
    config.invalidateSettingsCache();
    gate.resetAnalysisGateForTests();
    const seats = countingSeats(ai);
    const row = await gate.getOrCreateAnalysis({ jd: posting(n) });
    return { row, analysis: seats.analyses()[0], facts: seats.facts()[0] };
  };

  // An edit saved before the owner's texts that names nothing but the
  // posting - as the analysis did before the job field lists, and the Job
  // Filter's prompt before it was retired - reads exactly like a valid one of
  // today. Its date gives it away: it gives way to the shipped prompt.
  saveStoredPrompt({
    id: 'analyze-job-description',
    featureKey: 'analyze-job-description',
    content: 'OLD ADMIN ANALYSIS EDIT. Extract keywords as JSON, bare infinitive verbs.\n\n[[jobDescription]]',
    isBuiltIn: true,
    createdAt: at,
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  saveStoredPrompt({
    id: 'filter-google-sheet-job',
    featureKey: 'filter-google-sheet-job',
    content: 'OLD ADMIN FILTER EDIT. Judge this job.\n[[jobDescription]]',
    isBuiltIn: true,
    createdAt: at,
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  const datedWarnings = [];
  const warn = console.warn;
  console.warn = (...args) => datedWarnings.push(args.map(String).join(' '));
  let dated;
  try {
    dated = await turnOf(4);
  } finally {
    console.warn = warn;
  }
  assert.doesNotMatch(dated.analysis.stableSystem, /OLD ADMIN ANALYSIS EDIT/, 'the older edit is not what runs');
  assert.ok(dated.analysis.stableSystem.endsWith('Job Description:\n"""\n'), 'the shipped analysis is');
  assert.doesNotMatch(dated.facts.stableSystem, /OLD ADMIN FILTER EDIT/);
  assert.match(dated.facts.stableSystem, /FIELD EXTRACTION RULES/, 'the shipped facts prompt runs');
  assert.ok(
    datedWarnings.some((line) =>
      /\(analyze-job-description\) dates from an older version of the Analyze Job Description prompt; the built-in Analyze Job Description prompt runs instead/.test(line)
    )
  );
  assert.ok(datedWarnings.some((line) => /\(filter-google-sheet-job\) dates from an older version of the Job Facts \(Filter\) prompt;/.test(line)));

  // The same kind of edit saved since is a valid analysis prompt, and runs -
  // and the posting is still filed under its job field: that is the facts call's.
  saveStoredPrompt({
    id: 'analyze-job-description',
    featureKey: 'analyze-job-description',
    content: 'My own analysis.\nJob Description:\n[[jobDescription]]',
    isBuiltIn: true,
    createdAt: at,
    updatedAt: '2026-10-13T00:00:00.000Z',
  });
  const mine = await turnOf(5);
  assert.match(mine.analysis.stableSystem, /^My own analysis/);
  assert.match(mine.facts.stableSystem, /FIELD EXTRACTION RULES/, 'the older facts edit still gives way');
  assert.equal(mine.row.jobFieldId, 'backend');

  // An edit an older build saved, asking for the lists this version no longer
  // supplies, gives way to the shipped prompt - never a failed analysis.
  saveStoredPrompt({
    id: 'analyze-job-description',
    featureKey: 'analyze-job-description',
    content: 'My old analysis.\nJOB FIELDS:\n[[jobFieldList]]\n[[industryList]]\nJob link: [[jobLink]]\nJob Description:\n[[jobDescription]]',
    isBuiltIn: true,
    createdAt: at,
    updatedAt: '2026-01-07T00:00:00.000Z',
  });
  // And an edit of the facts prompt from before it was retired, reading
  // [[jobContent]], gives way the same.
  saveStoredPrompt({
    id: 'filter-google-sheet-job',
    featureKey: 'filter-google-sheet-job',
    content: 'Judge [[jobContent]]',
    isBuiltIn: true,
    createdAt: at,
    updatedAt: '2026-01-07T00:00:00.000Z',
  });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let old;
  try {
    old = await turnOf(7);
  } finally {
    console.warn = realWarn;
  }
  assert.doesNotMatch(old.analysis.stableSystem, /My old analysis/, 'the outdated edit is not what runs');
  assert.ok(old.analysis.stableSystem.endsWith('Job Description:\n"""\n'), 'the shipped analysis is');
  assert.doesNotMatch(old.facts.stableSystem, /Judge/);
  assert.match(old.facts.stableSystem, /FIELD EXTRACTION RULES/, 'the shipped facts prompt runs');
  assert.equal(old.row.jobFieldId, 'backend');
  assert.ok(warnings.some((line) => /\(analyze-job-description\) uses \[\[jobFieldList\]\] and \[\[industryList\]\], which this version does not supply/.test(line)));
  assert.ok(
    warnings.some((line) =>
      /\(filter-google-sheet-job\) does not use \[\[jobDescription\]\], which every Job Facts \(Filter\) prompt must, and uses \[\[jobContent\]\], which this version does not supply, and dates from an older version of the Job Facts \(Filter\) prompt; the built-in Job Facts \(Filter\) prompt runs instead/.test(line)
    )
  );

  // An edit leaving out every fact still asks for the job field: the code's line, not the record's.
  saveStoredPrompt({
    id: 'filter-google-sheet-job',
    featureKey: 'filter-google-sheet-job',
    content: 'Only say whether it is remote.\n[[jobDescription]]',
    isBuiltIn: true,
    createdAt: at,
    updatedAt: '2026-10-15T00:00:00.000Z',
  });
  const bare = await turnOf(9);
  assert.match(bare.facts.stableSystem, /Only say whether it is remote/);
  assert.ok(bare.facts.stableSystem.startsWith(JOB_FIELD_PREAMBLE), 'the job field list is still there');
  assert.ok(bare.facts.userBody.endsWith(JOB_FIELD_REMINDER));
  assert.equal(bare.row.jobFieldId, 'backend');
});

test("a sheet row's cell is worth only the stored analysis it names, for this posting - and nothing in a sheet is ever stored", async () => {
  freshInstall('sheet-row');
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  const seats = countingSeats(ai);
  const { storeJobAnalysis } = require('./helpers');
  const { getDb } = require('../dist/database/sqlite');
  const link = (n) => `https://jobs.example.com/${n}`;
  const one = storeJobAnalysis({ jobField: 'devops' }, { jobDescription: posting(1), jobLink: link(1) });
  const two = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: posting(2), jobLink: link(2) });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    // Its own stored analysis: answered from the store, no call.
    assert.equal((await gate.getOrCreateAnalysis({ jd: posting(1), link: link(1), sheetRow: { analysisId: one, row: 2 }, storedOnly: true })).id, one);
    // Another posting's: not used - the store answers for this one.
    assert.equal((await gate.getOrCreateAnalysis({ jd: posting(1), link: link(1), sheetRow: { analysisId: two, row: 3 }, storedOnly: true })).id, one);
    // An id the store never held, for a posting it has none of: nothing - not
    // registered, whatever the cell said - and then ONE analysis, through the gate.
    const forged = '11111111-2222-4333-8444-555555555555';
    assert.equal(await gate.getOrCreateAnalysis({ jd: posting(3), link: link(3), sheetRow: { analysisId: forged, row: 4 }, storedOnly: true }), null);
    assert.equal(seats.analyses().length, 0);
    const made = await gate.getOrCreateAnalysis({ jd: posting(3), link: link(3), sheetRow: { analysisId: forged, row: 4 } });
    assert.notEqual(made.id, forged);
    assert.equal(seats.analyses().length, 1, 'analysed once');
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((line) => /sheet row 3 holds the analysis of another posting/.test(line)));
  assert.ok(warnings.some((line) => /sheet row 4's Analysis cell names an analysis this store does not have \(11111111-/.test(line)));
  assert.deepEqual(getDb().prepare('SELECT source, COUNT(*) AS n FROM job_analyses GROUP BY source').all(), [{ source: 'ai', n: 3 }]);

  // And nothing in the code writes a row from a sheet any more.
  const writers = sources().filter((file) => /source:\s*'sheet'/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(writers.map((file) => path.relative(SRC, file)), [], "no analysis is stored with source 'sheet'");
});

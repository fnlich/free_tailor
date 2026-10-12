const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { countingSeats, freshInstall, posting, until } = require('./analysisHarness');

/**
 * A posting's facts: the second call of its one analysis (owner decision O1).
 *
 * The analysis prompt reads the posting's keywords; the Job Facts (Filter)
 * prompt - the owner's text, the Job Filter's own before it was retired -
 * reads its job type, onsite interview, company category, seniority,
 * clearance, salary, region and state, and the CODE asks the same call for
 * the job field (services/jobAnalysis/jobFieldLine.ts). The gate makes the two
 * calls side by side and stores ONE row: both answers, or nothing.
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const gate = require('../dist/services/jobAnalysis/gate');
const repository = require('../dist/database/jobAnalysisRepository');
const facts = require('../dist/services/jobAnalysis/facts');
const resumeService = require('../dist/services/resumeService');
const jobFilter = require('../dist/services/jobFilter');

function setUp(name, options) {
  freshInstall(`facts-${name}`);
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  return countingSeats(ai, options);
}

/** A facts answer as the prompt writes it, top-level snake_case, plus the code's job_field. */
function factsAnswer(overrides = {}) {
  return JSON.stringify({
    job_type: 'remote',
    onsite_interview: 'no',
    company_category: 'saas',
    seniority: 'senior',
    clearance_required: 'none',
    salary: { min: null, max: null, period: null, raw: null },
    region: 'us',
    us_state: null,
    job_field: 'backend',
    ...overrides,
  });
}

/** A settle, so a call racing another would have landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/* ------------------------------------------------------------- the parser */

test('the facts parser reads the prompt\'s snake_case answer, its seniority and the job field, and nothing it does not offer', () => {
  const read = (overrides) => facts.normalizeJobFacts(JSON.parse(factsAnswer(overrides)));

  assert.deepEqual(read({}), {
    jobField: 'backend',
    salary: null,
    filter: {
      jobType: 'remote',
      onsiteInterview: 'no',
      companyCategory: 'saas',
      clearanceRequired: 'none',
      region: 'us',
      usState: '',
      seniority: 'senior',
    },
  });

  // Confidence companions, wherever the model puts them, are ignored.
  const withConfidence = read({
    _confidence: 'low',
    job_type_confidence: 'low',
    salary: { min: 120000, max: 140000, period: 'annual', raw: null, _confidence: 'low' },
  });
  assert.equal(JSON.stringify(withConfidence).includes('confidence'), false);

  // Seniority: the facts prompt's eleven words (case, spaces and hyphens
  // forgiven); anything else is not specified - a closed list, because the
  // filter judges it.
  for (const [word, expected] of [
    ['intern', 'intern'],
    ['Director', 'director'],
    ['VP', 'vp'],
    ['principal', 'principal'],
    ['not_specified', 'not_specified'],
    ['Not specified', 'not_specified'],
    ['unknown', 'not_specified'],
    ['Chief Wizard', 'not_specified'],
    [null, 'not_specified'],
    [undefined, 'not_specified'],
  ]) {
    assert.equal(read({ seniority: word }).filter.seniority, expected, String(word));
  }

  // The salary is what the posting states, as numbers - with no currency:
  // the prompt asks for none, and one is never inferred.
  assert.deepEqual(read({ salary: { min: '230k', max: null, period: 'annual', raw: '230k' } }).salary, {
    min: 230000,
    max: null,
    currency: null,
    period: 'annual',
    raw: '230k',
  });
  assert.deepEqual(read({ salary: { min: 65, max: 80, period: 'hourly', raw: '$65 - $80/hour' } }).salary.period, 'hourly');
  assert.equal(read({ salary: { min: null, max: null, period: null, raw: null } }).salary, null);

  // A remote job has no state, whatever office it mentions; an on-site one keeps its code.
  assert.equal(read({ job_type: 'remote', us_state: 'CA' }).filter.usState, '');
  assert.equal(read({ job_type: 'on_site', us_state: 'ca' }).filter.usState, 'CA');
  // A clearance fails closed: an off-list word is kept, which the filter fails.
  assert.equal(read({ clearance_required: 'Top Secret/SCI' }).filter.clearanceRequired, 'ts_sci');
  assert.equal(read({ clearance_required: 'DoD Secret' }).filter.clearanceRequired, 'dod_secret');
  assert.equal(read({ clearance_required: undefined }).filter.clearanceRequired, 'none', 'no mention at all is none');

  // The job field: an id, or the label echoed; anything else unclassified -
  // and NO job field at all is null, which the gate asks again about.
  assert.equal(read({ job_field: 'Backend' }).jobField, 'backend');
  assert.equal(read({ job_field: 'data-structures-and-algorithms' }).jobField, 'unclassified', 'area 9 is not offered');
  assert.equal(read({ job_field: 'unclassified' }).jobField, 'unclassified');
  for (const missing of [undefined, null, '', '   ']) {
    assert.equal(read({ job_field: missing }).jobField, null, String(missing));
  }
  assert.equal(facts.normalizeJobFacts({ jobField: 'frontend' }).jobField, 'frontend', 'either spelling of the key');

  // A whole answer that is not an object reads as empty facts; one that is not JSON is refused.
  assert.equal(facts.normalizeJobFacts(null).jobField, null);
  assert.throws(() => resumeService.parseJobFacts('Remote, I think.'), /Failed to parse job facts response/);
  assert.throws(() => resumeService.parseJobFacts('[1, 2]'), /Failed to parse job facts response/);
});

test('a composed analysis carries the facts call\'s facts and never an industry: that is derived from the company category', () => {
  const keywords = resumeService.parseJobAnalysisKeywords(
    JSON.stringify({
      jobMeta: { title: 'Engineer', seniority: 'unknown', industry: 'devtools', department: 'Platform' },
      skills: { technical: ['API design'], tools: [], soft: [] },
      // An edit written for the older analysis prompt may still answer these.
      jobField: 'frontend',
      industry: 'Insurance',
      filter: { jobType: 'hybrid' },
    }),
    'A posting.'
  );
  const analysis = resumeService.composeJobAnalysis(keywords, facts.normalizeJobFacts(JSON.parse(factsAnswer({ company_category: 'fintech', seniority: 'lead' }))));
  assert.equal(analysis.jobField, 'backend', "the facts call's job field, not the keyword answer's");
  assert.equal('industry' in analysis, false);
  assert.equal(facts.industryOf(analysis), 'finance', 'fintech is Finance');
  assert.equal(analysis.filter.jobType, 'remote');
  assert.equal(analysis.jobMeta.seniority, 'unknown', "the keyword analysis's own word is kept as it answered");
  assert.equal(jobFilter.jobFilterAnalysisOf(analysis).seniority, 'lead', 'the filter reads the facts call\'s');
  assert.equal(analysis.sourceJobDescription, 'A posting.');

  // "other" says only that no category fits: the free-text industry is read instead.
  const other = resumeService.composeJobAnalysis(keywords, facts.normalizeJobFacts(JSON.parse(factsAnswer({ company_category: 'other' }))));
  assert.equal(facts.industryOf(other), 'technology', '"devtools" in jobMeta.industry');
  // A facts answer that named no job field is unclassified when composed.
  const none = resumeService.composeJobAnalysis(keywords, facts.normalizeJobFacts(JSON.parse(factsAnswer({ job_field: undefined }))));
  assert.equal(none.jobField, 'unclassified');
});

/* --------------------------------------------------------------- the gate */

test('a new posting makes one analysis call and one facts call, side by side, and stores one row', async () => {
  const seats = setUp('once', { factsAnswer: () => factsAnswer({ company_category: 'healthcare', seniority: 'intern', salary: { min: 90000, max: 110000, period: 'annual', raw: '$90k-$110k' } }) });
  seats.hold();
  seats.holdFacts();
  const pending = gate.getOrCreateAnalysis({ jd: posting(1) });
  await until(() => seats.analyses().length === 1 && seats.facts().length === 1, 'both calls out at once');
  assert.equal(gate.analysesInFlight(), 1, 'one analysis in flight, not two');
  seats.releaseFacts();
  await settle();
  assert.equal(repository.countJobAnalyses(), 0, 'nothing stored on one answer');
  seats.release();
  const row = await pending;

  assert.equal(repository.countJobAnalyses(), 1);
  assert.equal(row.jobFieldId, 'backend');
  assert.equal(row.analysis.jobMeta.title, 'Senior Backend Engineer', 'the keywords are the analysis call\'s');
  assert.deepEqual(row.analysis.salary, { min: 90000, max: 110000, currency: null, period: 'annual', raw: '$90k-$110k' });
  assert.equal(row.analysis.filter.companyCategory, 'healthcare');
  assert.equal(row.analysis.filter.seniority, 'intern');
  assert.equal('industry' in row.analysis, false);
  assert.equal(facts.industryOf(row.analysis), 'healthcare');
  assert.equal(jobFilter.evaluateJobFilterAnalysis(jobFilter.jobFilterAnalysisOf(row.analysis)).result, 'Fail');

  // Read back from the store as it was written: the seniority is on its facts.
  assert.equal(repository.getJobAnalysisById(row.id).analysis.filter.seniority, 'intern');

  // And never again.
  await gate.getOrCreateAnalysis({ jd: posting(1) });
  assert.equal(seats.analyses().length, 1);
  assert.equal(seats.facts().length, 1);
});

test('a facts answer that names no job field is asked once more, then stored unclassified with a warning naming the posting', async () => {
  // Answered once without, then with: the second answer is the one stored.
  let asked = 0;
  const seats = setUp('retry', {
    factsAnswer: () => {
      asked += 1;
      return factsAnswer({ job_field: asked === 1 ? undefined : 'devops' });
    },
  });
  const row = await gate.getOrCreateAnalysis({ jd: posting(2) });
  assert.equal(seats.facts().length, 2);
  assert.equal(seats.analyses().length, 1, 'the analysis call is not repeated for it');
  assert.equal(row.jobFieldId, 'devops');

  // Never answered: asked twice, then unclassified - said, with the posting's hash.
  const never = setUp('retry-never', { factsAnswer: () => factsAnswer({ job_field: undefined }) });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  let unclassified;
  try {
    unclassified = await gate.getOrCreateAnalysis({ jd: posting(3) });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(never.facts().length, 2);
  assert.equal(unclassified.jobFieldId, 'unclassified');
  const said = warnings.filter((line) => line.startsWith('[analysis]') && line.includes('named no job field'));
  assert.equal(said.length, 1);
  assert.ok(said[0].includes(unclassified.contentHash), 'naming the posting by its hash');

  // "unclassified" is an answer, not a missing one: asked once.
  const answered = setUp('retry-answered', { factsAnswer: () => factsAnswer({ job_field: 'unclassified' }) });
  assert.equal((await gate.getOrCreateAnalysis({ jd: posting(4) })).jobFieldId, 'unclassified');
  assert.equal(answered.facts().length, 1);
});

test('either call failing stops the other and stores nothing; the next request makes both again', async () => {
  // The analysis fails while the facts call is still out: the facts call is aborted.
  const seats = setUp('cross-abort');
  seats.hold();
  seats.holdFacts();
  seats.failAnalyses = 1;
  const first = gate.getOrCreateAnalysis({ jd: posting(5) });
  await until(() => seats.analyses().length === 1 && seats.facts().length === 1, 'both calls out');
  seats.release();
  await assert.rejects(first, /The seat is down/);
  assert.equal(seats.facts()[0].signal.aborted, true, 'the facts call was stopped');
  assert.equal(repository.countJobAnalyses(), 0, 'nothing stored');
  assert.equal(gate.analysesInFlight(), 0, 'and nothing left in flight to join');
  seats.releaseFacts();

  // And the other way round.
  seats.hold();
  seats.holdFacts();
  seats.failFacts = 1;
  const second = gate.getOrCreateAnalysis({ jd: posting(5) });
  await until(() => seats.analyses().length === 2 && seats.facts().length === 2, 'both calls out again');
  seats.releaseFacts();
  await assert.rejects(second, /The seat is down/);
  assert.equal(seats.analyses()[1].signal.aborted, true, 'the analysis call was stopped');
  assert.equal(repository.countJobAnalyses(), 0);
  seats.release();

  // A facts answer that cannot be read is a failure like any other.
  const garbled = setUp('garbled', { factsAnswer: () => 'Remote, I think.' });
  const realError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(gate.getOrCreateAnalysis({ jd: posting(6) }), /Failed to parse job facts response/);
  } finally {
    console.error = realError;
  }
  assert.equal(repository.countJobAnalyses(), 0);
  garbled.factsAnswer = () => factsAnswer();
  const row = await gate.getOrCreateAnalysis({ jd: posting(6) });
  assert.ok(row.id);
  assert.equal(garbled.analyses().length, 2, 'both calls made again: one analysis is both answers or none');
  assert.equal(garbled.facts().length, 2);
});

test('the last caller leaving stops both calls; a caller leaving while another waits stops neither', async () => {
  const seats = setUp('leave');
  seats.hold();
  seats.holdFacts();
  const leaving = new AbortController();
  const staying = new AbortController();
  const gone = gate.getOrCreateAnalysis({ jd: posting(7), signal: leaving.signal });
  const kept = gate.getOrCreateAnalysis({ jd: posting(7), signal: staying.signal });
  await until(() => seats.analyses().length === 1 && seats.facts().length === 1, 'both calls');
  leaving.abort();
  await assert.rejects(gone);
  assert.equal(seats.analyses()[0].signal.aborted, false, 'still wanted by the other caller');
  assert.equal(seats.facts()[0].signal.aborted, false);

  staying.abort();
  await assert.rejects(kept);
  await until(() => seats.analyses()[0].signal.aborted && seats.facts()[0].signal.aborted, 'both calls stopped');
  assert.equal(repository.countJobAnalyses(), 0);
  seats.release();
  seats.releaseFacts();
  await until(() => gate.analysesInFlight() === 0, 'the analysis out of the map');
});

test('the facts call carries the job field list before the prompt and the reminder after the posting, on the analysis model', async () => {
  const { JOB_FIELD_PREAMBLE, JOB_FIELD_REMINDER } = require('../dist/services/jobAnalysis/jobFieldLine');
  const { renderJobFieldListForPrompt } = require('../dist/config/jobFields');
  assert.ok(JOB_FIELD_PREAMBLE.startsWith('ONE MORE FIELD.'));
  assert.ok(JOB_FIELD_PREAMBLE.endsWith(renderJobFieldListForPrompt()), 'the closed list, as the code renders it');
  assert.match(JOB_FIELD_REMINDER, /"job_field"/);

  const seats = setUp('turn');
  await config.updateAppSettings({ analysisModelId: 'gemini-cli-auto' });
  await gate.getOrCreateAnalysis({ jd: posting(8), link: 'https://jobs.example.com/8' });
  const [turn] = seats.facts();
  assert.equal(turn.callSite, 'filter-google-sheet-job');
  assert.deepEqual([turn.provider, turn.modelName], ['gemini-cli', 'auto']);
  assert.equal(turn.responseFormat, 'json');
  assert.equal(turn.sampling.temperature, 0);
  assert.equal(turn.sampling.maxOutputTokens, 1000);
  assert.ok(turn.stableSystem.startsWith(`${JOB_FIELD_PREAMBLE}\n\n`));
  assert.ok(turn.userBody.includes(posting(8)));
  assert.ok(turn.userBody.endsWith(JOB_FIELD_REMINDER));
  // The analysis call is the analysis prompt alone: no job field, no addendum.
  const [analysis] = seats.analyses();
  assert.doesNotMatch(`${analysis.stableSystem}${analysis.userBody}`, /job_field|JOB FIELDS/);
});

test('a provider with no system channel gets the job field list in the same place of its one turn', async () => {
  const seats = setUp('fold');
  // Codex has no system blocks: the facade folds everything into the turn.
  const stub = ai.getAdapter('codex-cli');
  ai.registerAdapter('codex-cli', () => ({ ...stub, capabilities: { ...stub.capabilities, systemBlocks: false } }));
  await config.updateAppSettings({ analysisModelId: 'codex-cli-default' });
  const { JOB_FIELD_PREAMBLE, JOB_FIELD_REMINDER } = require('../dist/services/jobAnalysis/jobFieldLine');
  await gate.getOrCreateAnalysis({ jd: posting(9) });
  const [turn] = seats.facts();
  assert.equal(turn.stableSystem, '');
  const preamble = turn.userBody.indexOf(JOB_FIELD_PREAMBLE);
  assert.ok(preamble > 0, 'after the JSON instruction');
  assert.equal(turn.userBody.split(JOB_FIELD_PREAMBLE).length, 2, 'exactly once');
  assert.ok(turn.userBody.indexOf('FIELD EXTRACTION RULES') > preamble, "before the prompt's own text");
  assert.ok(turn.userBody.indexOf(posting(9)) > turn.userBody.indexOf('FIELD EXTRACTION RULES'));
  assert.ok(turn.userBody.endsWith(JOB_FIELD_REMINDER));
});

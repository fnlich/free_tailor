const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { analysisAnswer, countingSeats, freshInstall, posting } = require('./analysisHarness');

/**
 * A posting is analysed once, EVER - not once per window of a cache.
 *
 * What this replaced was an in-memory cache: six hours, a hundred entries,
 * keyed on the model, the prompt's text and the posting, gone on restart. So
 * the same posting was analysed again after six hours, after a hundred other
 * postings, after a restart, after any prompt edit and on any other model.
 * Now the analysis is a row in `job_analyses`, keyed on the posting alone,
 * with no expiry, no cap and no overwrite (PLAN check 1, rows 1, 3 and 5).
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const gate = require('../dist/services/jobAnalysis/gate');
const promptService = require('../dist/services/promptService');
const repository = require('../dist/database/jobAnalysisRepository');

function setUp(name, options) {
  const storage = freshInstall(`stored-${name}`);
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  return { ...storage, seats: countingSeats(ai, options) };
}

test('the same posting is analysed once, after "six hours" and after a hundred other postings (row 1)', async () => {
  const { seats } = setUp('window');
  const first = await gate.getOrCreateAnalysis({ jd: posting(0) });

  // A hundred and one other postings: what the old cache held was a hundred.
  for (let n = 1; n <= 101; n += 1) await gate.getOrCreateAnalysis({ jd: posting(n) });
  assert.equal(seats.analyses().length, 102);

  // And the clock moved on seven hours - the old cache kept six.
  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 60 * 60_000;
  try {
    const again = await gate.getOrCreateAnalysis({ jd: posting(0) });
    assert.equal(again.id, first.id);
  } finally {
    Date.now = realNow;
  }
  assert.equal(seats.analyses().length, 102, 'the first posting was not analysed a second time');
});

test('whitespace does not make a new posting, and each caller gets its own object', async () => {
  const { seats } = setUp('whitespace');
  const first = await gate.getOrCreateAnalysis({ jd: posting(1) });
  const spaced = await gate.getOrCreateAnalysis({ jd: `  ${posting(1).replace(/ /g, '   ')}\n\n` });
  assert.equal(spaced.id, first.id);
  assert.equal(seats.analyses().length, 1);

  // Read from the store each time: a caller editing its copy edits nobody else's.
  assert.notEqual(spaced.analysis, first.analysis);
  first.analysis.jobMeta.title = 'Mutated';
  assert.equal(gate.loadAnalysis(first.id).analysis.jobMeta.title, 'Senior Backend Engineer');
});

test('a restart forgets nothing: the stored analysis answers, not a model (row 3)', async () => {
  const { seats } = setUp('restart');
  const first = await gate.getOrCreateAnalysis({ jd: posting(2) });
  // Everything a process keeps in memory, gone.
  gate.resetAnalysisGateForTests();
  config.invalidateSettingsCache();
  const after = await gate.getOrCreateAnalysis({ jd: posting(2) });
  assert.equal(after.id, first.id);
  assert.equal(seats.analyses().length, 1);
});

test('an edited analysis prompt reaches only postings never analysed before (row 5)', async () => {
  const { seats } = setUp('prompt-edit');
  const before = await gate.getOrCreateAnalysis({ jd: posting(3) });

  const shipped = await promptService.getPromptById('analyze-job-description');
  await promptService.updatePrompt('analyze-job-description', { content: `An edited prompt.\n${shipped.content}` });

  const again = await gate.getOrCreateAnalysis({ jd: posting(3) });
  assert.equal(again.id, before.id, 'the stored analysis is kept and reused');
  assert.equal(seats.analyses().length, 1);

  await gate.getOrCreateAnalysis({ jd: posting(4) });
  assert.equal(seats.analyses().length, 2);
  assert.match(seats.analyses()[1].stableSystem, /^An edited prompt\./, 'a new posting is read with the edited prompt');
});

test('the analysis model decides - not the prompt record, not the model a resume is charged at', async () => {
  const { seats } = setUp('model');
  // An override on the analysis prompt is not the analysis model.
  const shipped = await promptService.getPromptById('analyze-job-description');
  await promptService.updatePrompt('analyze-job-description', {
    content: shipped.content,
    modelProvider: 'gemini-cli',
    modelName: 'auto',
  });
  // Unset: the app default model.
  await gate.getOrCreateAnalysis({ jd: posting(5) });
  assert.deepEqual([seats.analyses()[0].provider, seats.analyses()[0].modelName], ['claude-cli', 'sonnet']);

  // Set: that model, recorded on the row.
  await config.updateAppSettings({ analysisModelId: 'codex-cli-default' });
  const row = await gate.getOrCreateAnalysis({ jd: posting(6) });
  assert.deepEqual([seats.analyses()[1].provider, seats.analyses()[1].modelName], ['codex-cli', 'default']);
  assert.equal(row.modelId, 'codex-cli-default');
  assert.match(row.promptHash, /^[0-9a-f]{64}$/);

  // A chosen model that stops running falls back to the default rather than
  // failing every analysis.
  await config.updateAIModel('codex-cli-default', { enabled: false });
  await gate.getOrCreateAnalysis({ jd: posting(7) });
  assert.equal(seats.analyses()[2].provider, 'claude-cli');

  // A full-form save re-sending the stored id is not refused for it...
  await config.updateAppSettings({ analysisModelId: 'codex-cli-default', defaultModelId: 'claude-cli-sonnet' });
  // ...but a save CHANGING it to a model that cannot run is, by name.
  await config.updateAppSettings({ analysisModelId: '' });
  await assert.rejects(config.updateAppSettings({ analysisModelId: 'claude-cli-haiku-nope' }), /was not found/);
  await assert.rejects(config.updateAppSettings({ analysisModelId: 'codex-cli-default' }), /cannot analyse job postings/);
});

test('the analysis model is the administrator\'s: in the admin payload, never in an ordinary account\'s', async () => {
  setUp('payload');
  await config.updateAppSettings({ analysisModelId: 'gemini-cli-auto' });
  assert.equal((await config.getAdminAppSettings()).analysisModelId, 'gemini-cli-auto');
  assert.equal('analysisModelId' in (await config.getUserAppSettings()), false);
  await config.updateAppSettings({ analysisModelId: '' });
  assert.equal((await config.getAdminAppSettings()).analysisModelId, '', 'empty clears it: the app default');

  // A deleted analysis model is no choice: back to the default, not a warning for ever.
  await config.updateAppSettings({ analysisModelId: 'codex-cli-default' });
  await config.deleteAIModel('codex-cli-default');
  assert.equal((await config.getAdminAppSettings()).analysisModelId, '');
});

test('a model answer outside the closed list is unclassified; a salary is only what it states', async () => {
  const { seats } = setUp('normalised', {
    answer: () =>
      analysisAnswer({
        jobField: 'data-structures-and-algorithms',
        salary: { min: '140,000', max: 120000, currency: 'usd', period: 'yearly', raw: null },
        filter: { jobType: 'Remote', clearanceRequired: 'maybe', region: 'US', usState: 'CA' },
      }),
  });
  const row = await gate.getOrCreateAnalysis({ jd: posting(8) });
  assert.equal(seats.analyses().length, 1);
  assert.equal(row.jobFieldId, 'unclassified', 'area 9 is not offered, so it is not a field');
  assert.deepEqual(row.analysis.salary, { min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null });
  assert.deepEqual(row.analysis.filter, {
    jobType: 'remote',
    onsiteInterview: 'not_specified',
    companyCategory: 'other',
    // A clearance word off the list is kept as itself, which the filter
    // fails - never folded into not_specified, which it passes.
    clearanceRequired: 'maybe',
    region: 'us',
    usState: '',
  });
  const stored = repository.getJobAnalysisById(row.id);
  assert.equal(stored.jobFieldId, 'unclassified');
});

const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { countingSeats, freshInstall, posting, until } = require('./analysisHarness');

/**
 * A posting analysed by several callers AT ONCE is analysed once.
 *
 * The store stops the second call for a posting only after the first has
 * returned; ten tasks of one job starting together, or a page pressing
 * Generate twice, would all miss it and all call. The gate's in-flight map is
 * process-wide and keyed on the POSTING - its link and its text - so the
 * second caller waits for the first one's call (PLAN check 1, row 8). It used
 * to live inside the queue only, keyed on the model too, so two profiles on
 * two models analysed one posting twice; both are gone.
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const gate = require('../dist/services/jobAnalysis/gate');
const repository = require('../dist/database/jobAnalysisRepository');

function setUp(name) {
  freshInstall(`inflight-${name}`);
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  return countingSeats(ai);
}

/** A settle, so a second call racing the first would have landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('ten callers on one posting make one analysis call, and all get its stored row', async () => {
  const seats = setUp('ten');
  seats.hold();
  const all = Promise.all(Array.from({ length: 10 }, () => gate.getOrCreateAnalysis({ jd: posting(1) })));
  await until(() => seats.analyses().length > 0, 'the first analysis to go out');
  await settle();
  assert.equal(seats.analyses().length, 1, 'nine of the ten waited on the first call');
  assert.equal(gate.analysesInFlight(), 1);

  seats.release();
  const rows = await all;
  assert.equal(new Set(rows.map((row) => row.id)).size, 1, 'one stored analysis for all of them');
  assert.equal(rows[0].analysis.jobMeta.title, 'Senior Backend Engineer');
  assert.equal(repository.countJobAnalyses(), 1);
  assert.equal(gate.analysesInFlight(), 0, 'out of the map once settled');
});

test('the same posting by its link, reworded, joins the call already in flight', async () => {
  // The posting is the link OR the text: a second request with the same link
  // and other words is the same posting.
  const seats = setUp('link');
  seats.hold();
  const link = 'https://jobs.example.com/openings/42?utm_source=board';
  const first = gate.getOrCreateAnalysis({ jd: posting(2), link });
  await until(() => seats.analyses().length > 0, 'the first analysis');
  const second = gate.getOrCreateAnalysis({ jd: `${posting(2)} Reworded on another board.`, link: 'https://JOBS.example.com/openings/42/#apply' });
  await settle();
  assert.equal(seats.analyses().length, 1);
  seats.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
});

test('three profiles on three models share one call, made on the analysis model', async () => {
  // The model is no part of a posting's identity (PLAN check 1, row 2), and
  // one administrator-chosen model reads every posting (J1).
  const seats = setUp('models');
  await config.updateAppSettings({ analysisModelId: 'codex-cli-default' });
  seats.hold();
  const all = Promise.all([1, 2, 3].map(() => gate.getOrCreateAnalysis({ jd: posting(3) })));
  await until(() => seats.analyses().length > 0, 'the analysis');
  await settle();
  seats.release();
  await all;
  assert.equal(seats.analyses().length, 1);
  assert.equal(seats.analyses()[0].provider, 'codex-cli', 'on the analysis model');
  assert.equal(seats.analyses()[0].modelName, 'default');
});

test('a caller that goes away does not fail the others waiting on the same call', async () => {
  // The call is shared, so no one caller's signal may stop it: only when the
  // last waiter has gone is the call itself aborted.
  const seats = setUp('abort');
  seats.hold();
  const leaving = new AbortController();
  const gone = gate.getOrCreateAnalysis({ jd: posting(4), signal: leaving.signal });
  const staying = gate.getOrCreateAnalysis({ jd: posting(4) });
  await until(() => seats.analyses().length > 0, 'the analysis');
  leaving.abort();
  await assert.rejects(gone);
  seats.release();
  const row = await staying;
  assert.ok(row.id, 'the caller still waiting got the analysis');
  assert.equal(seats.analyses().length, 1);
});

test('a failed call stores nothing, and the next request is the first real analysis', async () => {
  // The one way a posting reaches a model twice: there was no analysis yet.
  const seats = setUp('failed');
  seats.failAnalyses = 1;
  await assert.rejects(gate.getOrCreateAnalysis({ jd: posting(5) }));
  assert.equal(repository.countJobAnalyses(), 0, 'nothing stored');
  assert.equal(gate.analysesInFlight(), 0, 'and nothing left in flight to join');

  const row = await gate.getOrCreateAnalysis({ jd: posting(5) });
  assert.ok(row.id);
  await gate.getOrCreateAnalysis({ jd: posting(5) });
  assert.equal(seats.analyses().length, 2, 'the failure, then the one analysis - and nothing after it');
});

test('a posting too short to analyse is not sent, and a stored one is found by its link whatever its text', async () => {
  const seats = setUp('short');
  assert.equal(await gate.getOrCreateAnalysis({ jd: 'too short' }), null);
  assert.equal(seats.analyses().length, 0);

  const link = 'https://jobs.example.com/7';
  const stored = await gate.getOrCreateAnalysis({ jd: posting(6), link });
  // The Job Filter asks by link alone, before it fetches anything.
  assert.equal((await gate.getOrCreateAnalysis({ link })).id, stored.id);
  assert.equal(gate.findStoredAnalysis({ link: `${link}?gclid=abc` }).id, stored.id);
  assert.equal(seats.analyses().length, 1);
});

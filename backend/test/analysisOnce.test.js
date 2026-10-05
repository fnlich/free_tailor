const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub here, and a failed resume is retried: a retry is one of
// the cases. Both before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
process.env.GENERATION_MAX_ATTEMPTS = '3';

const { posting, serveInstall, until, untilFinished } = require('./analysisHarness');

/**
 * PLAN check 1: "Can job analysis run twice?" - the ten ways it did, each
 * closed, each through the real routes and the real queue against a COUNTING
 * stub seat that must see exactly one analysis call.
 *
 * | # | It used to re-run when...                    | Now...                                        |
 * |---|-----------------------------------------------|-----------------------------------------------|
 * | 1 | the 6 h / 100-entry cache missed              | the store has no window and no cap            |
 * | 2 | profiles in one batch used different models   | one analysis per job, resolved before fan-out |
 * | 3 | the server restarted                          | analysisId is on each persisted task          |
 * | 4 | an order had > 100 postings                   | each posting once, a second order none        |
 * | 5 | an admin edited the analysis prompt           | the prompt is no part of the key              |
 * | 6 | a profile had its own analysis prompt         | per-profile analysis prompts are gone         |
 * | 7 | Generate was pressed again                    | analysisId, or the store by text/link         |
 * | 8 | two requests arrived at once                  | the process-wide in-flight join               |
 * | 9 | a task retried                                | the retry skips the analysis step             |
 * |10 | the Job Filter read the posting itself        | the filter judges the one analysis            |
 */

const LINK = 'https://jobs.example.com/openings/42';

function jobs(count, from = 0) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${from + index}`,
    role: 'Engineer',
    jobDescription: posting(from + index),
  }));
}

async function submit(h, body) {
  const response = await h.post('/generation/batches', { mode: 'order', format: 'pdf', includeCoverLetterDocx: false, ...body });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return response.body;
}

function payloads(batchId) {
  const { getGenerationQueue } = require('../dist/services/queue/index');
  return getGenerationQueue().getBatch(batchId).tasks.map((task) => task.payload);
}

test('row 1: the same posting is not analysed again after "six hours" or a hundred other postings', async (t) => {
  const h = await serveInstall('row1');
  t.after(h.close);
  const first = await h.post('/resume/analyze', { jobDescription: posting(0) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  for (let n = 1; n <= 101; n += 1) await h.post('/resume/analyze', { jobDescription: posting(n) });

  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 60 * 60_000;
  try {
    const again = await h.post('/resume/analyze', { jobDescription: posting(0) });
    assert.equal(again.body.analysisId, first.body.analysisId);
  } finally {
    Date.now = realNow;
  }
  const forPosting0 = h.seats.analyses().filter((call) => call.userBody.includes(posting(0)));
  assert.equal(forPosting0.length, 1, 'exactly one analysis call for the first posting');
});

test('row 2: three profiles on three models - one analysis, the same analysisId on every task', async (t) => {
  const h = await serveInstall('row2');
  t.after(h.close);
  const { batchId } = await submit(h, { jobs: jobs(1), profileIds: ['p-claude', 'p-codex', 'p-gemini'] });
  const snapshot = await untilFinished(batchId);
  assert.equal(snapshot.completed, 3, JSON.stringify(snapshot.tasks.map((task) => task.error)));

  assert.equal(h.seats.analyses().length, 1, 'one analysis for the job, not one per model');
  const ids = new Set(payloads(batchId).map((payload) => payload.analysisId));
  assert.equal(ids.size, 1);
  assert.ok([...ids][0]);
  // Each resume is still tailored on its own profile's model.
  assert.deepEqual(h.seats.tailorings().map((call) => call.provider).sort(), ['claude-cli', 'codex-cli', 'gemini-cli']);
});

test('row 3: a restart mid-order - store and queue reopened from disk - and the restored tasks skip analysis', async (t) => {
  const h = await serveInstall('row3');
  t.after(h.close);
  // The process "dies" with both resumes mid-tailoring, after the analysis.
  h.seats.holdTailoring = true;
  const { batchId } = await submit(h, { jobs: jobs(1), profileIds: ['p-claude', 'p-codex'] });
  await until(() => h.seats.tailorings().length === 2, 'both tasks to be tailoring');
  assert.equal(h.seats.analyses().length, 1);

  // Everything in memory goes: the queue, the in-flight analyses, the settings cache.
  h.queue.resetGenerationQueueForTests();
  h.gate.resetAnalysisGateForTests();
  h.config.invalidateSettingsCache();
  const { loadBatchRows } = require('../dist/database/generationRepository');
  const onDisk = loadBatchRows().find((row) => row.id === batchId);
  const stamped = onDisk.tasks.map((task) => task.data.payload.analysisId);
  assert.equal(new Set(stamped).size, 1, 'every task row on disk names the one analysis');
  assert.ok(stamped[0]);

  h.seats.holdTailoring = false;
  const report = await h.queue.restoreGenerationQueue();
  assert.deepEqual(report.batchIds, [batchId]);
  const snapshot = await untilFinished(batchId);
  assert.equal(snapshot.completed, 2);
  assert.equal(h.seats.analyses().length, 1, 'the restored tasks did not analyse again');
});

test('row 4: a 150-row order analyses each posting once, and a second order on the same rows not at all', async (t) => {
  const h = await serveInstall('row4');
  t.after(h.close);
  const first = await submit(h, { jobs: jobs(150), profileIds: ['p-claude'] });
  const snapshot = await untilFinished(first.batchId, 4000);
  assert.equal(snapshot.completed, 150);
  assert.equal(h.seats.analyses().length, 150);
  const perPosting = new Map();
  for (const call of h.seats.analyses()) {
    const key = /Posting (\d+):/.exec(call.userBody)[1];
    perPosting.set(key, (perPosting.get(key) ?? 0) + 1);
  }
  assert.equal(perPosting.size, 150);
  assert.ok([...perPosting.values()].every((count) => count === 1), 'no posting analysed twice');

  // Placed again: every job starts with its analysis, so no task asks.
  const second = await submit(h, { jobs: jobs(150), profileIds: ['p-claude'] });
  assert.ok(payloads(second.batchId).every((payload) => payload.analysisId), 'resolved at submission');
  await untilFinished(second.batchId, 4000);
  assert.equal(h.seats.analyses().length, 150, 'the second order made no analysis call');
});

test('row 5: an analysis prompt edited between two builds does not analyse the posting again', async (t) => {
  const h = await serveInstall('row5');
  t.after(h.close);
  const before = await h.post('/resume/preview', { profileId: 'p-claude', jobDescription: posting(5) });
  assert.equal(before.status, 200, JSON.stringify(before.body));

  const promptService = require('../dist/services/promptService');
  const shipped = await promptService.getPromptById('analyze-job-description');
  await promptService.updatePrompt('analyze-job-description', { content: `Edited.\n${shipped.content}` });

  const after = await h.post('/resume/preview', { profileId: 'p-claude', jobDescription: posting(5) });
  assert.equal(after.body.analysisId, before.body.analysisId);
  assert.equal(h.seats.analyses().length, 1);
});

test('row 6: a profile that had its own analysis prompt shares the one analysis, on the one prompt', async (t) => {
  const promptRepository = require('../dist/database/promptRepository');
  const h = await serveInstall('row6', {
    profiles: [
      ['p-claude', 'Ada', 'claude-cli-sonnet'],
      ['p-own', 'Bea', 'codex-cli-default', { analyzeJobPromptId: 'custom-own-analysis' }],
    ],
  });
  t.after(h.close);
  const now = new Date().toISOString();
  promptRepository.saveStoredPrompt({
    id: 'custom-own-analysis',
    name: 'Her own analysis',
    featureKey: 'analyze-job-description',
    content: 'HER OWN ANALYSIS PROMPT.\n[[jobDescription]]',
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  });
  // Premium is not needed: the owner is an administrator.
  const response = await h.post('/resume/preview-all', { profileIds: ['p-claude', 'p-own'], jobDescription: posting(6) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(h.seats.analyses().length, 1);
  assert.doesNotMatch(h.seats.analyses()[0].stableSystem, /HER OWN ANALYSIS PROMPT/, 'the per-profile variant is not run');
  assert.equal(h.seats.tailorings().length, 2);
});

test('row 7: Generate pressed again - with the analysisId, and without it - analyses nothing more', async (t) => {
  const h = await serveInstall('row7');
  t.after(h.close);
  const body = { profileId: 'p-claude', companyName: 'Acme', role: 'Engineer', format: 'pdf', includeCoverLetterDocx: false };
  const first = await h.post('/resume/generate', { ...body, jobDescription: posting(7), jobLink: LINK });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.analysisId);

  const withId = await h.post('/resume/generate', { ...body, analysisId: first.body.analysisId });
  assert.equal(withId.status, 200);
  // Without it: found by its text...
  await h.post('/resume/generate', { ...body, jobDescription: posting(7) });
  // ...and by its link, reworded.
  await h.post('/resume/generate', { ...body, jobDescription: `${posting(7)} Reposted elsewhere.`, jobLink: `${LINK}/?utm_source=x` });
  // A batch, the same.
  const { batchId } = await submit(h, { jobs: [{ companyName: 'Acme', role: 'Engineer', jobDescription: posting(7) }], profileIds: ['p-claude'] });
  await untilFinished(batchId);
  assert.equal(h.seats.analyses().length, 1);

  // An analysis OBJECT a page sends is not read; an id nobody stored is refused.
  const forged = await h.post('/resume/generate', {
    ...body,
    jobAnalysis: { jobMeta: { title: 'Forged' }, jobField: 'blockchain-web3' },
    analysisId: 'no-such-analysis',
  });
  assert.equal(forged.status, 400);
  assert.match(forged.body.error, /That job analysis was not found/);
});

test('row 8: two requests at once make one analysis call', async (t) => {
  const h = await serveInstall('row8');
  t.after(h.close);
  h.seats.hold();
  const both = Promise.all([
    h.post('/resume/analyze', { jobDescription: posting(8) }),
    h.post('/resume/analyze', { jobDescription: posting(8) }),
  ]);
  await until(() => h.seats.analyses().length > 0, 'the analysis');
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.seats.release();
  const [a, b] = await both;
  assert.equal(a.body.analysisId, b.body.analysisId);
  assert.equal(h.seats.analyses().length, 1);
});

test('row 9: a task retried after its tailoring failed does not analyse again', async (t) => {
  const h = await serveInstall('row9');
  t.after(h.close);
  h.seats.failTailorings = 1;
  const { batchId } = await submit(h, { jobs: jobs(1, 9), profileIds: ['p-claude'] });
  const snapshot = await untilFinished(batchId);
  assert.equal(snapshot.completed, 1, JSON.stringify(snapshot.tasks));
  assert.equal(h.seats.tailorings().length, 2, 'the tailoring was retried');
  assert.equal(h.seats.analyses().length, 1, 'the analysis was not');
});

test('row 10: the Job Filter, then a build of the same posting - one analysis, whichever comes first', async (t) => {
  const h = await serveInstall('row10');
  t.after(h.close);
  // The filter's own sheet reads and writes, and the page fetch, are swapped
  // at their module exports; the analysis is the real gate.
  const swaps = [];
  const swap = (module, name, fake) => {
    swaps.push([module, name, module[name]]);
    module[name] = fake;
  };
  t.after(() => {
    for (const [module, name, original] of swaps.reverse()) module[name] = original;
  });
  const googleSheets = require('../dist/integrations/googleSheets');
  const written = [];
  let fetched = 0;
  swap(require('../dist/services/sheets/jobSheetTarget'), 'resolveJobSheetTarget', async () => ({
    spreadsheetId: 'shared-source',
    tabName: '10/05/2026',
  }));
  swap(googleSheets, 'fetchGoogleSheetsRange', async () => ({
    spreadsheetId: 'shared-source',
    spreadsheetTitle: 'Jobs',
    values: [[LINK, '', ''], ['https://jobs.example.com/other', '', '']],
  }));
  swap(googleSheets, 'updateGoogleSheetsRow', async (input) => {
    written.push(input);
    return {};
  });
  swap(require('../dist/services/jobPageContent'), 'extractJobPageContent', async (link) => {
    fetched += 1;
    return link === LINK ? posting(10) : posting(11);
  });

  const filtered = await h.post('/jobs/filter-google-sheet', { startRow: 2, endRow: 3 });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  assert.equal(filtered.body.processedRows, 2);
  assert.equal(filtered.body.modelLabel, 'Claude Sonnet', 'the analysis model, by its display name');
  assert.equal(h.seats.analyses().length, 2, 'one analysis per posting');
  assert.deepEqual(written[0].updates.map((update) => update.value), ['Pass', ''], 'judged on the analysis: remote, US, senior');

  // The build of the first posting: the sheet's own text for it, its link.
  const built = await h.post('/resume/preview', { profileId: 'p-claude', jobDescription: `${posting(10)} As the sheet has it.`, jobLink: LINK });
  assert.equal(built.status, 200);
  assert.equal(h.seats.analyses().length, 2, 'the build found the filter\'s analysis');

  // And the other way round: a filter after a build reads no page and asks no model.
  const again = await h.post('/jobs/filter-google-sheet', { startRow: 2, endRow: 3 });
  assert.equal(again.body.reusedAnalyses, 2);
  assert.equal(fetched, 2, 'no page fetched for a posting already analysed');
  assert.equal(h.seats.analyses().length, 2);
});

test('a stored analysis damaged outside the program is analysed once more and repaired in place - not once per request', async (t) => {
  const h = await serveInstall('unreadable');
  t.after(h.close);
  const { getDb } = require('../dist/database/sqlite');
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  t.after(() => {
    console.error = realError;
    console.warn = realWarn;
  });

  // Cut short, as a hand edit or a backup restored part way would leave it.
  const first = await h.post('/resume/analyze', { jobDescription: posting(60), jobLink: LINK });
  assert.equal(first.status, 200);
  getDb().prepare('UPDATE job_analyses SET analysis_json = substr(analysis_json, 1, 40) WHERE id = ?').run(first.body.analysisId);

  for (const body of [
    { jobDescription: posting(60), jobLink: LINK },
    { jobDescription: posting(60) },
    { jobDescription: posting(60, 'reworded'), jobLink: `${LINK}?utm_source=x` },
  ]) {
    const again = await h.post('/resume/analyze', body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.analysisId, first.body.analysisId, 'the same row, readable again');
  }
  assert.equal(h.seats.analyses().length, 2, 'one call more, for the damaged row - not one per request');
  const { batchId } = await submit(h, { jobs: [{ companyName: 'Acme', role: 'Engineer', jobDescription: posting(60) }], profileIds: ['p-claude'] });
  assert.equal((await untilFinished(batchId)).completed, 1);
  assert.equal(h.seats.analyses().length, 2, 'and none for a build');

  // JSON that is not an object - `null` - is as unreadable, and fails nothing.
  const other = await h.post('/resume/analyze', { jobDescription: posting(61) });
  getDb().prepare("UPDATE job_analyses SET analysis_json = 'null' WHERE id = ?").run(other.body.analysisId);
  for (let n = 0; n < 3; n += 1) {
    const again = await h.post('/resume/analyze', { jobDescription: posting(61) });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.analysisId, other.body.analysisId);
  }
  assert.equal(h.seats.analyses().length, 4);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM job_analyses').get().n, 2, 'never a second row');
});

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * Ten profiles on one posting must analyse it ONCE.
 *
 * `analysisCache` alone does not give this. It stops the second call only after
 * the first has RETURNED - so ten tasks starting together all miss, all call,
 * and nine turns are wasted. On a free account a turn is a browser typing thirty
 * thousand characters and waiting out the answer, and one posting across several
 * profiles is the commonest shape this app runs.
 */

function setUp(name) {
  const { staticDir } = useTempStorage(name);
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze this.\n[[jobDescription]]',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.resetAnalysisCacheForTests();

  const calls = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      effort: false, thinking: false, nativeJsonMode: 'json-schema', systemBlocks: true,
      requiresApiKey: false, credentialKind: 'subscription-seat', maxConcurrency: 8,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      calls.push(request);
      await held;
      return {
        text: JSON.stringify({
          jobMeta: { title: 'Staff Engineer', seniority: 'Staff', industry: 'Fintech', department: 'Platform' },
        }),
        resolvedModel: request.modelName,
        providerId: 'claude-cli',
        droppedParams: [],
        latencyMs: 1,
      };
    },
  }));

  // Loaded in DEPENDENCY ORDER, and that is the whole of why this works.
  // `loadFresh` busts one module; everything that module requires comes from the
  // cache. Re-loading `resumeTask` alone leaves it holding a cached
  // `resumeService` that closed over the PREVIOUS ai registry - so the stub
  // registered above is invisible, the real CLI adapter is called instead, and
  // the test sees zero calls and no error to explain them.
  loadFresh('../dist/services/resumeService');
  const resumeTask = loadFresh('../dist/services/queue/resumeTask');
  resumeTask.resetResumeTaskStateForTests();
  return { calls, release, resumeTask };
}

/**
 * Waits for a condition rather than for a duration.
 *
 * `analyzeJobDescription` resolves a prompt record and reads settings before it
 * reaches the adapter, so "sleep 5ms then assert" reports zero calls and looks
 * like broken coalescing. Polling makes the test say what it means - "once the
 * first call has gone out, how many went out?" - and stops it depending on how
 * loaded the machine is.
 */
async function until(condition, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const POSTING = 'A long job posting. '.repeat(500);
const CHOICE = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'm', modelLabel: 'Stub' };

test('ten tasks on one posting make one analysis call, not ten', async () => {
  const { calls, release, resumeTask } = setUp('inflight-coalesce');
  const job = { companyName: 'Acme', role: 'SWE', jobDescription: POSTING };

  // Reached through the module's own internals rather than a whole task, so the
  // test is about coalescing and not about templates, profiles and PDF renders.
  const analyse = resumeTask.__analyseOnceForTests;
  assert.ok(analyse, 'the analysis step must be reachable for this to be testable');

  const signal = new AbortController().signal;
  const all = Promise.all(Array.from({ length: 10 }, () => analyse(job, CHOICE, signal)));
  await until(() => calls.length > 0, 'the first analysis to go out');
  // Settled once more, so a second call racing the first would have landed.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 1, 'nine of the ten waited on the first call');
  release();
  const answers = await all;
  assert.equal(answers.length, 10);
  for (const answer of answers) {
    assert.equal(answer.jobMeta.title, 'Staff Engineer', 'every one of them got the answer');
  }
});

test('two models on one posting are analysed separately', async () => {
  // Two profiles set to different models must not share one analysis produced by
  // whichever got there first. A per-batch memo keyed only on the text did
  // exactly that.
  const { calls, release, resumeTask } = setUp('inflight-by-model');
  const analyse = resumeTask.__analyseOnceForTests;
  const job = { companyName: 'Acme', role: 'SWE', jobDescription: POSTING };
  const signal = new AbortController().signal;

  const all = Promise.all([
    analyse(job, CHOICE, signal),
    analyse(job, { ...CHOICE, modelName: 'haiku' }, signal),
  ]);
  await until(() => calls.length >= 2, 'both analyses to go out');
  assert.equal(calls.length, 2);
  release();
  await all;
});

test('a job that already carries an analysis calls nothing', async () => {
  const { calls, resumeTask } = setUp('inflight-precomputed');
  const analyse = resumeTask.__analyseOnceForTests;
  const analysis = { jobMeta: { title: 'Given' } };
  const answer = await analyse(
    { companyName: 'Acme', role: 'SWE', jobDescription: POSTING, jobAnalysis: analysis },
    CHOICE,
    new AbortController().signal
  );
  assert.equal(answer, analysis);
  assert.equal(calls.length, 0);
});

test('a posting too short to analyse is skipped, not sent', async () => {
  const { calls, resumeTask } = setUp('inflight-tooshort');
  const analyse = resumeTask.__analyseOnceForTests;
  const answer = await analyse(
    { companyName: 'Acme', role: 'SWE', jobDescription: 'too short' },
    CHOICE,
    new AbortController().signal
  );
  assert.equal(answer, undefined);
  assert.equal(calls.length, 0);
});

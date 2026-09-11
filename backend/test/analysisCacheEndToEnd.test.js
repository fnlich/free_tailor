const assert = require('node:assert/strict');
const test = require('node:test');

// The stub stands in for the subscription seat, so these describe an install
// where that seat is present. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

function setUp(name, promptText = 'Analyze this.\n[[jobDescription]]') {
  const { staticDir } = useTempStorage(name);
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: promptText,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.resetAnalysisCacheForTests();

  const calls = [];
  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli',
      label: 'stub',
      temperature: false,
      maxOutputTokens: false,
      effort: false,
      thinking: false,
      nativeJsonMode: 'json-schema',
      systemBlocks: true,
      requiresApiKey: false,
      credentialKind: 'subscription-seat',
      maxConcurrency: 4,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      calls.push(request);
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

  const { analyzeJobDescription } = loadFresh('../dist/services/resumeService');
  return { ai, calls, analyzeJobDescription };
}

const CHOICE = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'm', modelLabel: 'Stub' };
const POSTING = 'A long job posting. '.repeat(500);

test('the same posting is analysed once, not once per generation', async () => {
  // The saving that matters. A preview followed by the generate that writes the
  // file, or a sheet re-run after fixing one row, used to be two full calls
  // over identical text - and on a free chat provider a call is a whole turn.
  const { calls, analyzeJobDescription } = setUp('cache-e2e-hit');

  const first = await analyzeJobDescription(POSTING, CHOICE);
  const second = await analyzeJobDescription(POSTING, CHOICE);
  await analyzeJobDescription(`${POSTING} but different`, CHOICE);

  assert.equal(calls.length, 2, 'two distinct postings, two calls');
  assert.equal(first.jobMeta.title, second.jobMeta.title);
});

test('each caller gets its own object', async () => {
  // Callers annotate the analysis - `resumeBuildTiming` keys a WeakMap on it -
  // and a batch running several generations at once would otherwise have them
  // overwrite each other, with any later mutation leaking into the cache.
  const { analyzeJobDescription } = setUp('cache-e2e-copy');
  const first = await analyzeJobDescription(POSTING, CHOICE);
  const second = await analyzeJobDescription(POSTING, CHOICE);
  assert.notEqual(first, second);
  first.jobMeta.title = 'Mutated';
  const third = await analyzeJobDescription(POSTING, CHOICE);
  assert.equal(third.jobMeta.title, 'Staff Engineer', 'the cached answer was not edited in place');
});

test('editing the prompt gets a fresh analysis, not the old answer', async () => {
  // An admin who edits a prompt and sees nothing change has no way to tell a
  // cache from a prompt that does not work.
  const first = setUp('cache-e2e-prompt-a');
  await first.analyzeJobDescription(POSTING, CHOICE);
  assert.equal(first.calls.length, 1);

  const second = setUp('cache-e2e-prompt-b', 'Analyze this, but differently.\n[[jobDescription]]');
  await second.analyzeJobDescription(POSTING, CHOICE);
  assert.equal(second.calls.length, 1, 'the edited prompt must reach the model');
});

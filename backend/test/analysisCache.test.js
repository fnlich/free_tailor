const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analysisCacheKey,
  readAnalysisCache,
  writeAnalysisCache,
  analysisCacheStats,
  resetAnalysisCacheForTests,
} = require('../dist/services/ai/analysisCache');

/**
 * The cheapest token is the one never sent.
 *
 * This app re-analyses the same posting constantly - a sheet import re-run
 * after fixing one row, a batch regenerated against a different template, a
 * preview followed by the generate that writes the file. On a free chat
 * provider each of those is a whole turn: thirty thousand characters typed into
 * a composer and the answer waited out.
 */

test.beforeEach(() => resetAnalysisCacheForTests());

const KEY = { jobDescription: 'A posting.', promptText: 'Analyze this.', model: 'claude-web/chat' };

test('the same three inputs are the same key', () => {
  assert.equal(analysisCacheKey(KEY), analysisCacheKey({ ...KEY }));
});

test('a different model does not share an answer', () => {
  // Two models do not analyse a posting identically, and serving one's answer
  // for the other would be a wrong result rather than a slow one.
  assert.notEqual(analysisCacheKey(KEY), analysisCacheKey({ ...KEY, model: 'claude-cli/sonnet' }));
});

test('an edited prompt does not serve the old answer', () => {
  // The prompt's TEXT is in the key, not just its id. An admin who edits a
  // prompt and sees nothing change has no way to tell a cache from a prompt
  // that does not work - which is the worst kind of bug this could introduce.
  assert.notEqual(
    analysisCacheKey(KEY),
    analysisCacheKey({ ...KEY, promptText: 'Analyze this, but differently.' })
  );
});

test('a key cannot be confused by where the boundaries fall', () => {
  // Concatenating three fields without a separator lets "ab" + "c" collide with
  // "a" + "bc", and here that means one posting served as another's analysis.
  assert.notEqual(
    analysisCacheKey({ jobDescription: 'x', promptText: 'yz', model: 'm' }),
    analysisCacheKey({ jobDescription: 'xy', promptText: 'z', model: 'm' })
  );
});

test('a stored answer comes back, and a miss says so', () => {
  const key = analysisCacheKey(KEY);
  assert.equal(readAnalysisCache(key), null);
  writeAnalysisCache(key, { jobMeta: { title: 'Staff Engineer' } });
  assert.deepEqual(readAnalysisCache(key), { jobMeta: { title: 'Staff Engineer' } });

  const stats = analysisCacheStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('an answer stops being served once it is stale', () => {
  const key = analysisCacheKey(KEY);
  let now = 0;
  writeAnalysisCache(key, { ok: true }, () => now);
  assert.ok(readAnalysisCache(key, () => now));

  now = 7 * 60 * 60_000;
  assert.equal(readAnalysisCache(key, () => now), null, 'six hours is the budget');
  assert.equal(analysisCacheStats().entries, 0, 'and the stale entry is dropped, not just skipped');
});

test('the cache is bounded, so a long-running server does not hold every posting', () => {
  for (let index = 0; index < 150; index += 1) {
    writeAnalysisCache(analysisCacheKey({ ...KEY, jobDescription: `posting ${index}` }), index);
  }
  assert.ok(analysisCacheStats().entries <= 100, 'it must stop growing');
  // The most recent survive: a batch running now matters more than one from
  // this morning.
  assert.equal(readAnalysisCache(analysisCacheKey({ ...KEY, jobDescription: 'posting 149' })), 149);
  assert.equal(readAnalysisCache(analysisCacheKey({ ...KEY, jobDescription: 'posting 0' })), null);
});

test('reading an entry keeps it alive against eviction', () => {
  // Otherwise the posting a batch is actively re-analysing is the one evicted,
  // which is the opposite of what a cache is for.
  const hot = analysisCacheKey({ ...KEY, jobDescription: 'the hot one' });
  writeAnalysisCache(hot, 'kept');
  for (let index = 0; index < 120; index += 1) {
    writeAnalysisCache(analysisCacheKey({ ...KEY, jobDescription: `filler ${index}` }), index);
    readAnalysisCache(hot);
  }
  assert.equal(readAnalysisCache(hot), 'kept');
});

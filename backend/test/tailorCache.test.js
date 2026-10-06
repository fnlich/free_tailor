const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub, and one go per resume. Both before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
process.env.GENERATION_MAX_ATTEMPTS = '1';

const express = require('express');
const { countingSeats, freshInstall, posting, stubOutputs, untilFinished } = require('./analysisHarness');
const { useAdminEmails } = require('./helpers');

/**
 * The tailoring cache (owner decision P6): generating again for the same
 * unchanged profile, posting, model and prompt reuses the stored tailoring -
 * no model call - and is CHARGED AS USUAL; any of those changing, by a single
 * character, is a miss. Through the real routes, the real queue and a
 * counting stub seat, plus the key, the table's one-seek lookup and the prune.
 *
 * Modules are required once and shared, as the analysis harness asks.
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const queue = require('../dist/services/queue/index');
const gate = require('../dist/services/jobAnalysis/gate');
const profiles = require('../dist/database/profileRepository');
const { buildNewProfile } = require('../dist/services/profileService');
const cache = require('../dist/services/tailorCache');
const repository = require('../dist/database/tailorCacheRepository');
const sqlite = require('../dist/database/sqlite');

function profileInput(name, extra = {}) {
  return {
    name,
    title: 'Engineer',
    skills: ['TypeScript'],
    contact: { email: `${name.toLowerCase()}@example.com`, phone: '1', location: 'Remote' },
    summary: 'Engineer who ships.',
    experience: [],
    strengths: [],
    education: [],
    ...extra,
  };
}

/** An install with Alice - not an administrator, so she is charged - and a priced Sonnet. */
async function serve(name) {
  const storage = freshInstall(`tailor-cache-${name}`);
  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  queue.resetGenerationQueueForTests();
  const seats = countingSeats(ai);

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const token = users.createSession(alice.id);
  profiles.saveProfile({
    ...buildNewProfile(profileInput('Ada', { profileSettings: { ai: { modelId: 'claude-cli-sonnet' } } }), 'p-ada'),
    ownerId: alice.id,
  });
  await config.updateAIModel('claude-cli-sonnet', { pricePerResumeUsd: '0.010' });
  await config.updateAIModel('claude-cli-opus', { pricePerResumeUsd: '0.023' });
  credits.setBalance(alice.id, 1_000, admin.id);

  const restoreOutputs = stubOutputs(storage.rootDir);
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  const server = app.listen(0);
  const port = server.address().port;

  const build = async (extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/generation/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        mode: 'order',
        format: 'pdf',
        includeCoverLetterDocx: false,
        profileIds: ['p-ada'],
        jobs: [{ companyName: 'Acme', role: 'Engineer', jobDescription: posting(7) }],
        ...extra,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    const snapshot = await untilFinished(body.batchId);
    assert.equal(snapshot.completed, 1, JSON.stringify(snapshot.tasks.map((task) => task.error)));
    return snapshot;
  };

  return {
    seats,
    alice,
    build,
    balance: () => users.getUserById(alice.id).balanceMilli,
    charges: () => credits.getLedger(alice.id, 100).filter((entry) => entry.reason === 'generation-reserve'),
    close: () => {
      server.close();
      restoreOutputs();
      queue.resetGenerationQueueForTests();
      ai.resetRegistryForTests();
    },
  };
}

test('the same resume generated again reuses its tailoring - no model call - and is charged again', async (t) => {
  const h = await serve('hit');
  t.after(h.close);

  await h.build();
  assert.equal(h.seats.tailorings().length, 1, 'the first build asks the model');
  assert.equal(h.balance(), 990);

  await h.build();
  assert.equal(h.seats.tailorings().length, 1, 'the second asks it nothing: the tailoring comes from the cache');
  assert.equal(h.seats.analyses().length, 1, 'and the posting was analysed once, as always');
  // Charged as usual: a resume costs its model's price whether or not a
  // model call happened.
  assert.deepEqual(h.charges().map((entry) => entry.deltaMilli), [-10, -10]);
  assert.equal(h.balance(), 980);
  assert.equal(repository.countTailorCacheRows(), 1, 'one stored tailoring, under one key');
});

test('a one-character change to the profile is a miss, and asks the model once', async (t) => {
  const h = await serve('profile-change');
  t.after(h.close);

  await h.build();
  const stored = profiles.getProfile('p-ada');
  profiles.saveProfile({ ...stored, summary: `${stored.summary}!` });
  await h.build();
  assert.equal(h.seats.tailorings().length, 2, 'the changed profile is tailored afresh');

  // And the change is what made the difference: saving it again unchanged -
  // which moves only its timestamp - is a hit.
  profiles.saveProfile({ ...profiles.getProfile('p-ada'), updatedAt: new Date(Date.now() + 60_000).toISOString() });
  await h.build();
  assert.equal(h.seats.tailorings().length, 2, 'a save that changes nothing is still the same profile');
});

test('another model, or an edited tailoring prompt, is a miss', async (t) => {
  const h = await serve('model-prompt');
  t.after(h.close);

  await h.build();
  await h.build({ model: 'claude-cli-opus' });
  assert.equal(h.seats.tailorings().length, 2, 'Opus is asked: the model is part of the key');
  assert.equal(h.seats.tailorings()[1].modelName, 'opus');

  const promptService = require('../dist/services/promptService');
  const record = await promptService.getPromptById('tailor-resume');
  await promptService.updatePrompt('tailor-resume', { content: `${record.content}\nBe brief.` });
  await h.build();
  assert.equal(h.seats.tailorings().length, 3, 'the edited prompt is asked again');
  // Charged for every one of them, at its own model's price.
  assert.deepEqual(h.charges().map((entry) => entry.deltaMilli), [-10, -23, -10]);
});

test('the key covers everything the answer was made from, and nothing a save moves without changing it', () => {
  const base = {
    kind: 'resume',
    profile: { id: 'p1', name: 'Ada', summary: 'Ships.', profileSettings: { includeStrengths: true }, createdAt: 'a', updatedAt: 'b' },
    context: { analysisId: 'an-1', templateId: 'default' },
    choice: { provider: 'claude-cli', modelId: 'claude-cli-sonnet', modelName: 'sonnet' },
    promptId: 'tailor-resume',
    promptText: 'Tailor [[profileJson]]',
  };
  const key = cache.tailorCacheKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(cache.tailorCacheKey({ ...base, profile: { ...base.profile, updatedAt: 'later', createdAt: 'z' } }), key);
  assert.equal(
    cache.tailorCacheKey({ ...base, profile: { summary: 'Ships.', name: 'Ada', id: 'p1', profileSettings: { includeStrengths: true } } }),
    key,
    'key order inside the profile does not matter'
  );

  const variants = {
    'one character of the profile': { profile: { ...base.profile, summary: 'Ships!' } },
    'a section switch': { profile: { ...base.profile, profileSettings: { includeStrengths: false } } },
    'the template': { context: { ...base.context, templateId: 'navy-rule' } },
    'the posting': { context: { ...base.context, analysisId: 'an-2' } },
    'the model record': { choice: { ...base.choice, modelId: 'claude-cli-opus' } },
    'the model name': { choice: { ...base.choice, modelName: 'opus' } },
    'the provider type': { choice: { ...base.choice, provider: 'codex-cli' } },
    'the prompt text': { promptText: 'Tailor [[profileJson]] briefly' },
    'the kind': { kind: 'cover-letter' },
    'a cover letter\'s role': { extra: { role: 'Lead' } },
  };
  for (const [what, change] of Object.entries(variants)) {
    assert.notEqual(cache.tailorCacheKey({ ...base, ...change }), key, `${what} is another key`);
  }
});

test('a cover letter is cached under its own key: company and role included', async () => {
  freshInstall('tailor-cache-cover');
  config.invalidateSettingsCache();
  const seats = countingSeats(ai);
  const { generateCoverLetter } = require('../dist/services/resumeService');
  try {
    const profile = buildNewProfile(profileInput('Ada'), 'p-cover');
    const choice = { provider: 'claude-cli', modelName: 'sonnet', modelId: 'claude-cli-sonnet', modelLabel: 'Sonnet' };
    const context = { analysisId: null, templateId: 'default' };
    const first = await generateCoverLetter(profile, 'Acme', 'Engineer', choice, undefined, context);
    const again = await generateCoverLetter(profile, 'Acme', 'Engineer', choice, undefined, context);
    assert.equal(again, first);
    const letters = () => seats.calls.filter((call) => call.callSite === 'generate-cover-letter');
    assert.equal(letters().length, 1, 'the same letter is not written twice');

    await generateCoverLetter(profile, 'Acme', 'Lead', choice, undefined, context);
    await generateCoverLetter(profile, 'Globex', 'Engineer', choice, undefined, context);
    assert.equal(letters().length, 3, 'another role or company is another letter');

    // Without a context - a caller that does not key one - nothing is cached.
    await generateCoverLetter(profile, 'Acme', 'Engineer', choice);
    assert.equal(letters().length, 4);
  } finally {
    ai.resetRegistryForTests();
  }
});

test('a stored answer that no longer parses is a miss, and the model is asked again', async (t) => {
  const h = await serve('unreadable');
  t.after(h.close);

  await h.build();
  sqlite.getDb().prepare("UPDATE tailor_cache SET content = 'not json at all'").run();
  await h.build();
  assert.equal(h.seats.tailorings().length, 2, 'a damaged row is never handed on as a tailoring');
});

test('the lookup is one seek on the unique key index', () => {
  freshInstall('tailor-cache-plan');
  const db = sqlite.getDb();
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tailor_cache'").all();
  const keyIndex = indexes.find((entry) => entry.name === 'idx_tailor_cache_key');
  assert.ok(keyIndex, 'the key has its index');
  assert.match(keyIndex.sql, /CREATE UNIQUE INDEX/);

  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${repository.FIND_TAILOR_CACHE_SQL}`)
    .all('0'.repeat(64))
    .map((row) => row.detail)
    .join(' | ');
  assert.match(plan, /SEARCH tailor_cache USING INDEX idx_tailor_cache_key \(cache_key=\?\)/);
  assert.doesNotMatch(plan, /SCAN/);

  const prunePlan = db
    .prepare(`EXPLAIN QUERY PLAN ${repository.PRUNE_TAILOR_CACHE_SQL}`)
    .all(new Date().toISOString())
    .map((row) => row.detail)
    .join(' | ');
  assert.match(prunePlan, /idx_tailor_cache_created/, 'the prune is a range on created_at, not a scan');

  // Two answers for one key keep the first.
  repository.storeTailorCache({ cacheKey: 'k', kind: 'resume', content: 'first', modelId: 'm', analysisId: null, profileId: null });
  repository.storeTailorCache({ cacheKey: 'k', kind: 'resume', content: 'second', modelId: 'm', analysisId: null, profileId: null });
  assert.equal(repository.findTailorCache('k'), 'first');
});

test('rows older than TAILOR_CACHE_DAYS are pruned; newer ones stay', () => {
  freshInstall('tailor-cache-prune');
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const at = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  for (const [key, daysAgo] of [['old', 31], ['edge', 29], ['new', 1]]) {
    repository.storeTailorCache({ cacheKey: key, kind: 'resume', content: key, modelId: 'm', analysisId: null, profileId: null, createdAt: at(daysAgo) });
  }

  assert.equal(cache.pruneTailorCacheNow(now, {}), 1, 'thirty days by default');
  assert.equal(repository.findTailorCache('old'), null);
  assert.equal(repository.findTailorCache('edge'), 'edge');

  assert.equal(cache.pruneTailorCacheNow(now, { TAILOR_CACHE_DAYS: '7' }), 1, 'and as many as .env says');
  assert.equal(repository.findTailorCache('edge'), null);
  assert.equal(repository.findTailorCache('new'), 'new');

  const { tailorCacheDays } = require('../dist/config/operational');
  assert.equal(tailorCacheDays({}), 30);
  assert.equal(tailorCacheDays({ TAILOR_CACHE_DAYS: '0' }), 1, 'clamped, never zero');
  assert.equal(tailorCacheDays({ TAILOR_CACHE_DAYS: 'soon' }), 30, 'junk is the default');
});

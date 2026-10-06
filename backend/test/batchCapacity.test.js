const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * How wide a batch runs, and why it is not one number.
 *
 * Each subscription seat spawns a process per call behind its own semaphore,
 * sized by its own variable - `AI_CLI_CONCURRENCY` for Claude,
 * `AI_CODEX_CONCURRENCY` for Codex, `AI_GEMINI_CONCURRENCY` for Gemini. A
 * fan-out above a seat's ceiling is not
 * throughput, it is a queue with a longer wait at the end; one below it leaves
 * the seat partly idle for the whole run. Neither is visible from the page; both
 * look like the app being slow. A provider id with no seat - a retired one on a
 * choice stored before the upgrade - gets the number this app has always used.
 */

function loadCapacity() {
  useTempStorage('batch-capacity');
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  return require('../dist/services/ai/batchCapacity');
}

test('an operator override wins over everything worked out', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  for (const provider of ['claude-cli', 'codex-cli', 'gemini-cli']) {
    const capacity = await resolveBatchCapacity(
      { provider },
      { AI_BATCH_CONCURRENCY: '3', AI_CLI_CONCURRENCY: '8', AI_CODEX_CONCURRENCY: '8', AI_GEMINI_CONCURRENCY: '8' }
    );
    assert.equal(capacity.limit, 3, `${provider} takes the override`);
    assert.match(capacity.reason, /AI_BATCH_CONCURRENCY=3/);
  }
});

test('the subscription seat runs at its own process limit', async () => {
  const { resolveBatchCapacity, cliConcurrency } = loadCapacity();
  const capacity = await resolveBatchCapacity({ provider: 'claude-cli' }, { AI_CLI_CONCURRENCY: '6' });
  assert.equal(capacity.limit, 6);
  assert.match(capacity.reason, /Claude CLI slot/);

  // The same variable and the same default the provider's own semaphore uses.
  // Two readers disagreeing would show up as a batch that queues against a
  // limit nobody configured.
  assert.equal(cliConcurrency({}), 4, 'the default both sides fall back to');
  assert.equal(cliConcurrency({ AI_CLI_CONCURRENCY: '0' }), 1, 'clamped, as the provider clamps it');
  assert.equal(cliConcurrency({ AI_CLI_CONCURRENCY: '99' }), 32);
  assert.equal(cliConcurrency({ AI_CLI_CONCURRENCY: 'lots' }), 4);
});

test('no width depends on the settings database', async () => {
  // Every number above comes from the environment. A database that cannot be
  // opened - a path under a regular FILE, so creating it fails at once with
  // ENOTDIR rather than on a permission check that varies by platform - must
  // not slow a batch, let alone fail one.
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  process.env.DB_DIR = '/etc/hosts/not-a-directory';
  const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
  const env = { AI_CLI_CONCURRENCY: '6', AI_CODEX_CONCURRENCY: '5', AI_GEMINI_CONCURRENCY: '3' };

  assert.equal((await resolveBatchCapacity({ provider: 'claude-cli' }, env)).limit, 6);
  assert.equal((await resolveBatchCapacity({ provider: 'codex-cli' }, env)).limit, 5);
  assert.equal((await resolveBatchCapacity({ provider: 'gemini-cli' }, env)).limit, 3);
  assert.equal((await resolveBatchCapacity({ provider: 'openai' }, env)).limit, 4, 'a retired id too');
});

test('a choice naming a removed provider is sized like any other, not refused', async () => {
  // A task resolved before the browser chat providers or the metered APIs were
  // removed can still carry one of their ids. The runner resolves it again
  // before any call, so all this has to do is not throw.
  const { resolveBatchCapacity } = loadCapacity();
  for (const provider of ['claude-web', 'claude', 'openai', 'deepseek']) {
    const capacity = await resolveBatchCapacity({ provider }, {});
    assert.equal(capacity.limit, 4, provider);
  }
});

/**
 * The Codex seat, which is a SEPARATE number from the Claude one.
 *
 * It used to fall past every branch into the catch-all default, and that was
 * right only by the coincidence that both defaults are 4. The two cases below
 * are the ones the coincidence hid.
 */
test('the Codex seat runs at its own process limit, not the Claude seat\'s', async () => {
  const { resolveBatchCapacity, codexConcurrency } = loadCapacity();

  const wide = await resolveBatchCapacity(
    { provider: 'codex-cli' },
    { AI_CODEX_CONCURRENCY: '12', AI_CLI_CONCURRENCY: '4' }
  );
  assert.equal(wide.limit, 12, 'a tuned-up Codex seat is actually offered its slots');
  assert.match(wide.reason, /Codex/);

  const narrow = await resolveBatchCapacity(
    { provider: 'codex-cli' },
    { AI_CODEX_CONCURRENCY: '1', AI_CLI_CONCURRENCY: '16' }
  );
  assert.equal(narrow.limit, 1, 'and a narrowed one is not flooded from an invisible queue');

  // The same pin the Claude case carries: this module and the provider's own
  // semaphore must agree, or the batch offers work into a pool of another size.
  assert.equal(codexConcurrency({ AI_CODEX_CONCURRENCY: '12' }), 12);
  assert.equal(codexConcurrency({}), 4, 'the same default the provider reads');
  assert.equal(codexConcurrency({ AI_CODEX_CONCURRENCY: '999' }), 32, 'same upper bound too');
});

test('each CLI seat is sized from its own variable, and they do not share a lane', async () => {
  useTempStorage('batch-capacity-lanes');
  delete require.cache[require.resolve('../dist/services/queue/index')];
  const queueModule = require('../dist/services/queue/index');

  // Deliberately different numbers: a shared lane would have to pick one.
  const { lanes } = await queueModule.readCapacityForTests({
    AI_CLI_CONCURRENCY: '3',
    AI_CODEX_CONCURRENCY: '7',
    AI_GEMINI_CONCURRENCY: '5',
  });
  const byId = Object.fromEntries(lanes.map((lane) => [lane.id, lane]));

  // One lane per PROVIDER; on an install with none added, that is one per
  // seat, each the built-in provider with its type's id and its type's pool.
  assert.deepEqual(lanes.map((lane) => lane.id), ['claude-cli', 'codex-cli', 'gemini-cli'], 'one lane per seat, and no other');
  assert.deepEqual(lanes.map((lane) => lane.pool), ['claude-cli', 'codex-cli', 'gemini-cli']);
  assert.equal(byId['claude-cli'].slots.length, 3, 'the Claude seat, from AI_CLI_CONCURRENCY');
  assert.equal(byId['codex-cli'].slots.length, 7, 'the Codex seat, from AI_CODEX_CONCURRENCY');
  assert.equal(byId['gemini-cli'].slots.length, 5, 'the Gemini seat, from AI_GEMINI_CONCURRENCY');
  assert.ok(
    lanes.every((lane) => lane.slots.every((slot) => slot.queue === lane.id)),
    'and the slots say which lane they belong to, which is what keeps the pools apart'
  );
  // Unset, the Gemini lane is its seat's default width, which is narrower than
  // the other two: a Google-account seat hits its per-minute limit sooner.
  const unset = await queueModule.readCapacityForTests({});
  assert.equal(unset.lanes.find((lane) => lane.id === 'gemini-cli').slots.length, 2);
});

test('the Gemini seat runs at its own process limit, read by the one reader its adapter uses', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  const { geminiCliConcurrency, readGeminiCliConfig } = require('../dist/services/ai/providers/geminiCli/options');

  const capacity = await resolveBatchCapacity(
    { provider: 'gemini-cli' },
    { AI_GEMINI_CONCURRENCY: '6', AI_CLI_CONCURRENCY: '4', AI_CODEX_CONCURRENCY: '4' }
  );
  assert.equal(capacity.limit, 6);
  assert.match(capacity.reason, /Gemini CLI slot/);

  // The batch width, the lane and the adapter's semaphore are one number: the
  // adapter is built from readGeminiCliConfig, which reads the same getter.
  for (const value of ['1', '6', '999', 'lots', '']) {
    const env = { AI_GEMINI_CONCURRENCY: value };
    const width = (await resolveBatchCapacity({ provider: 'gemini-cli' }, env)).limit;
    assert.equal(width, geminiCliConcurrency(env), value);
    assert.equal(width, readGeminiCliConfig(env).concurrency, value);
  }
  assert.equal(geminiCliConcurrency({}), 2, 'its own default, not the other seats\' 4');
});

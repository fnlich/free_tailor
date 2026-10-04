const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * How wide a batch runs, and why it is not one number.
 *
 * Each subscription seat spawns a process per call behind its own semaphore,
 * sized by its own variable - `AI_CLI_CONCURRENCY` for Claude,
 * `AI_CODEX_CONCURRENCY` for Codex. A fan-out above a seat's ceiling is not
 * throughput, it is a queue with a longer wait at the end; one below it leaves
 * the seat partly idle for the whole run. Neither is visible from the page; both
 * look like the app being slow. The metered providers have no local resource to
 * count, and keep the number this app has always used for them.
 */

function loadCapacity() {
  useTempStorage('batch-capacity');
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  return require('../dist/services/ai/batchCapacity');
}

test('an operator override wins over everything worked out', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  for (const provider of ['claude-cli', 'codex-cli', 'openai']) {
    const capacity = await resolveBatchCapacity(
      { provider },
      { AI_BATCH_CONCURRENCY: '3', AI_CLI_CONCURRENCY: '8', AI_CODEX_CONCURRENCY: '8' }
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

test('a metered provider keeps the number this app has always used', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  for (const provider of ['claude', 'openai', 'deepseek']) {
    const capacity = await resolveBatchCapacity({ provider }, {});
    assert.equal(capacity.limit, 4, `${provider} has no local resource to count`);
  }
});

test('no width depends on the settings database', async () => {
  // Every number above comes from the environment. A database that cannot be
  // opened - a path under a regular FILE, so creating it fails at once with
  // ENOTDIR rather than on a permission check that varies by platform - must
  // not slow a batch, let alone fail one.
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  process.env.DB_DIR = '/etc/hosts/not-a-directory';
  const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
  const env = { AI_CLI_CONCURRENCY: '6', AI_CODEX_CONCURRENCY: '5' };

  assert.equal((await resolveBatchCapacity({ provider: 'claude-cli' }, env)).limit, 6);
  assert.equal((await resolveBatchCapacity({ provider: 'codex-cli' }, env)).limit, 5);
  for (const provider of ['claude', 'openai', 'deepseek']) {
    assert.equal((await resolveBatchCapacity({ provider }, env)).limit, 4, provider);
  }
});

test('a choice naming a removed provider is sized like any other, not refused', async () => {
  // A task resolved before the browser chat providers were removed can still
  // carry one of their ids. The runner resolves it again before any call, so
  // all this has to do is not throw.
  const { resolveBatchCapacity } = loadCapacity();
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {});
  assert.equal(capacity.limit, 4);
});

/**
 * The Codex seat, which is a SEPARATE number from the Claude one.
 *
 * It used to fall past every branch into the metered-HTTP default, and that was
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
  const capacity = await queueModule.readCapacityForTests({
    AI_CLI_CONCURRENCY: '3',
    AI_CODEX_CONCURRENCY: '7',
  });

  assert.deepEqual(Object.keys(capacity).sort(), ['cli', 'codex'], 'one lane per seat, and no other');
  assert.equal(capacity.cli.length, 3, 'the Claude seat and the metered providers');
  assert.equal(capacity.codex.length, 7, 'the Codex seat, from AI_CODEX_CONCURRENCY');
  assert.ok(
    capacity.cli.every((slot) => slot.queue === 'cli') &&
      capacity.codex.every((slot) => slot.queue === 'codex'),
    'and the slots say which lane they belong to, which is what keeps the pools apart'
  );
});

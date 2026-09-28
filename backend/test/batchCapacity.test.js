const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * How wide a batch runs, and why it is not one number.
 *
 * The free chat providers hold one conversation per browser window: two prompts
 * typed into one composer do not queue, they interleave, and both answers are
 * lost. So the ceiling is exactly how many debug browsers the operator started
 * - and a fan-out above it is not throughput, it is a queue with a longer wait
 * at the end. The subscription seat spawns a process per call and has an
 * entirely different ceiling.
 *
 * Fixed at four, a batch on one browser queued three calls behind every answer
 * while a batch on six left four idle for the whole run. Neither is visible
 * from the page; both look like the app being slow.
 */

function loadCapacity() {
  useTempStorage('batch-capacity');
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  return require('../dist/services/ai/batchCapacity');
}

test('an operator override wins over everything worked out', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  const capacity = await resolveBatchCapacity(
    { provider: 'claude-web' },
    { AI_BATCH_CONCURRENCY: '3' }
  );
  assert.equal(capacity.limit, 3);
  assert.match(capacity.reason, /AI_BATCH_CONCURRENCY=3/);
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

test('a free provider runs at exactly its browser count', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9222 },
      { siteId: 'claude-web', port: 9223 },
      { siteId: 'chatgpt-web', port: 9224 },
    ],
  });

  const claude = await resolveBatchCapacity({ provider: 'claude-web' }, {});
  assert.equal(claude.limit, 2, 'two browsers, two calls at a time');

  const chatgpt = await resolveBatchCapacity({ provider: 'chatgpt-web' }, {});
  assert.equal(chatgpt.limit, 1, 'one browser, one call at a time');
});

test('a hybrid run gets both accounts added together', async () => {
  // The three-queue arrangement: Claude's browsers and ChatGPT's each pull from
  // their own line as they free up, so the batch has to offer enough work to
  // keep both fed. Offering only one site's worth would leave the other idle.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9222 },
      { siteId: 'claude-web', port: 9223 },
      { siteId: 'chatgpt-web', port: 9224 },
    ],
  });

  const hybrid = await resolveBatchCapacity({ provider: 'claude-web', route: 'hybrid' }, {});
  assert.equal(hybrid.limit, 3);
  assert.match(hybrid.reason, /claude-web/);
  assert.match(hybrid.reason, /chatgpt-web/);
});

test('no browsers registered still runs, one at a time', async () => {
  // A batch that refused over capacity would report a capacity problem where
  // the real one is "there is no browser running" - which the first call says
  // far better, and says once rather than once per item.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({ browserChatEndpoints: [] });
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {});
  assert.equal(capacity.limit, 1);
});

test('the fan-out is capped however many browsers are registered', async () => {
  // Each in-flight item is a model call and, later, a Chrome tab rendering a
  // PDF. Twenty browsers should not mean twenty simultaneous renders.
  const { resolveBatchCapacity } = loadCapacity();
  const { updateAppSettings } = require('../dist/config/aiModelConfig');
  await updateAppSettings({
    browserChatEndpoints: Array.from({ length: 16 }, (_, index) => ({
      siteId: index % 2 === 0 ? 'claude-web' : 'chatgpt-web',
      port: 9300 + index,
    })),
  });
  const capacity = await resolveBatchCapacity({ provider: 'claude-web', route: 'hybrid' }, {});
  assert.ok(capacity.limit <= 16, `${capacity.limit} is above the ceiling`);
});

test('a metered provider keeps the number this app has always used', async () => {
  const { resolveBatchCapacity } = loadCapacity();
  for (const provider of ['claude', 'openai', 'deepseek']) {
    const capacity = await resolveBatchCapacity({ provider }, {});
    assert.equal(capacity.limit, 4, `${provider} has no local resource to count`);
  }
});

test('an unreadable settings row slows the batch rather than failing it', async () => {
  // The capacity is only needed in order to go faster. A batch must not fail
  // over it.
  delete require.cache[require.resolve('../dist/services/ai/batchCapacity')];
  // A path under a regular FILE, so the directory creation fails immediately
  // with ENOTDIR rather than on a permission check that varies by platform.
  process.env.DB_DIR = '/etc/hosts/not-a-directory';
  const { resolveBatchCapacity } = require('../dist/services/ai/batchCapacity');
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {});
  assert.equal(capacity.limit, 1);
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

  assert.equal(capacity.cli.length, 3, 'the Claude seat and the metered providers');
  assert.equal(capacity.codex.length, 7, 'the Codex seat, from AI_CODEX_CONCURRENCY');
  assert.ok(
    capacity.cli.every((slot) => slot.queue === 'cli') &&
      capacity.codex.every((slot) => slot.queue === 'codex'),
    'and the slots say which lane they belong to, which is what keeps the pools apart'
  );
});

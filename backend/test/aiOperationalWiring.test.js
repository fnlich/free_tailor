const assert = require('node:assert/strict');
const test = require('node:test');
const childProcess = require('child_process');

const { loadFresh, makeFakeCliRunner, readCliFixture, useTempStorage } = require('./helpers');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');

/**
 * That the AI layer's operational settings reach the thing they change.
 *
 * `operational.test.js` pins what the getters return; this file pins that the
 * AI layer USES them - the deadline a provider is handed and the timeout the
 * CLI health probes run under.
 *
 * Nothing here reaches a network or spawns a process. child_process.execFile
 * is replaced for the duration of each test and restored after it; the CLI
 * provider runs on the recorded-stream runner.
 *
 * The subscription seat is unlocked before any dist module loads, as in
 * aiFacade.test.js: the facade tests here describe an install where that seat
 * exists, and the lock is not what they are about.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

/** Sets env vars for the duration of `run`, restoring whatever was there before. */
async function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Runs `run` with console.warn captured and the once-per-name memory cleared. */
async function captureWarnings(run) {
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const value = await run();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

/** Only the `[env]` lines - the adapters' own `[ai]` retry lines are not the subject. */
const envWarnings = (warnings) => warnings.filter((line) => line.startsWith('[env]'));

/* ================================================== AI_REQUEST_TIMEOUT_MS */

function stubSeat() {
  const requests = [];
  const adapter = {
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli',
      label: 'stub',
      temperature: false,
      maxOutputTokens: false,
      nativeJsonMode: 'json-schema',
      systemBlocks: true,
      maxConcurrency: 4,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      requests.push(request);
      return { text: '{"ok":true}', resolvedModel: 'sonnet', providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  };
  return { adapter, requests };
}

function loadFacadeWith(adapter) {
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.registerAdapter('claude-cli', () => adapter);
  return ai;
}

const rawCall = (ai, extra = {}) =>
  ai.createRawCompletion({ callSite: 'probe', system: 'Be terse.', user: 'hi', provider: 'claude-cli', ...extra });

test('AI_REQUEST_TIMEOUT_MS is the deadline every provider is handed, read on each call', async () => {
  useTempStorage('ai-deadline');
  const { adapter, requests } = stubSeat();
  const ai = loadFacadeWith(adapter);

  await withEnv({ AI_REQUEST_TIMEOUT_MS: '450000' }, () => rawCall(ai));
  await withEnv({ AI_REQUEST_TIMEOUT_MS: '60000' }, () => rawCall(ai));

  // Same loaded module, two values: it is read per call, not frozen at import.
  assert.deepEqual(requests.map((request) => request.deadline.totalMs), [450_000, 60_000]);
});

test('unset or empty, the deadline is the five minutes it always was', async () => {
  useTempStorage('ai-deadline-default');
  const { adapter, requests } = stubSeat();
  const ai = loadFacadeWith(adapter);

  const { warnings } = await captureWarnings(async () => {
    await withEnv({ AI_REQUEST_TIMEOUT_MS: undefined }, () => rawCall(ai));
    // A bare `AI_REQUEST_TIMEOUT_MS=` copied from .env.example arrives as ''.
    await withEnv({ AI_REQUEST_TIMEOUT_MS: '   ' }, () => rawCall(ai));
  });

  assert.deepEqual(requests.map((request) => request.deadline.totalMs), [300_000, 300_000]);
  assert.deepEqual(envWarnings(warnings), []);
});

test('a junk deadline warns once and uses five minutes; an out-of-range one is clamped', async () => {
  useTempStorage('ai-deadline-junk');
  const { adapter, requests } = stubSeat();
  const ai = loadFacadeWith(adapter);

  const junk = await captureWarnings(() =>
    withEnv({ AI_REQUEST_TIMEOUT_MS: '5m' }, async () => {
      await rawCall(ai);
      await rawCall(ai);
    })
  );
  assert.equal(requests[0].deadline.totalMs, 300_000);
  assert.equal(requests[1].deadline.totalMs, 300_000);
  assert.equal(envWarnings(junk.warnings).length, 1, 'once per name, not once per call');
  assert.match(envWarnings(junk.warnings)[0], /AI_REQUEST_TIMEOUT_MS="5m" is not a whole number/);

  const low = await captureWarnings(() => withEnv({ AI_REQUEST_TIMEOUT_MS: '1000' }, () => rawCall(ai)));
  assert.equal(requests[2].deadline.totalMs, 5_000);
  assert.match(envWarnings(low.warnings)[0], /AI_REQUEST_TIMEOUT_MS=1000 is outside 5000\.\.3600000/);

  const high = await captureWarnings(() => withEnv({ AI_REQUEST_TIMEOUT_MS: '99999999' }, () => rawCall(ai)));
  assert.equal(requests[3].deadline.totalMs, 3_600_000);
  assert.equal(envWarnings(high.warnings).length, 1);
});

test('a caller that names its own timeout still wins over the setting', async () => {
  useTempStorage('ai-deadline-caller');
  const { adapter, requests } = stubSeat();
  const ai = loadFacadeWith(adapter);

  await withEnv({ AI_REQUEST_TIMEOUT_MS: '450000' }, () => rawCall(ai, { timeoutMs: 12_000 }));
  assert.equal(requests[0].deadline.totalMs, 12_000);
});

for (const budget of ['600000', '600000ms']) {
  test(`the request deadline caps a CLI budget set above it (${budget}) - the case the startup warning is about`, async () => {
    // AI_CLI_TIMEOUT_MS_TAILOR=600000 is read by the provider and then never
    // reached: the child is given the smaller of the two. operational.ts's
    // describeAiTimeoutsAboveRequestDeadline says so at startup; this pins that
    // what it says is true of the real adapter.
    useTempStorage('ai-deadline-cli');
    const { createClaudeCliAdapter } = require('../dist/services/ai/providers/claudeCli/index');
    const { describeAiTimeoutsAboveRequestDeadline } = require('../dist/config/operational');
    const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });

    await withEnv({ AI_REQUEST_TIMEOUT_MS: '60000', AI_CLI_TIMEOUT_MS_TAILOR: budget }, async () => {
      // The provider reads `600000ms` as 600000 too, so the warning must as well.
      const { readClaudeCliConfig, resolveTimeoutMs } = require('../dist/services/ai/providers/claudeCli/options');
      assert.equal(resolveTimeoutMs(readClaudeCliConfig(), 'tailor-resume'), 600_000);
      const seat = createClaudeCliAdapter({
        runner,
        config: { binary: '/nonexistent/claude', workdir: process.env.TMPDIR || '/tmp', firstEventMs: 1_000 },
      });
      const ai = loadFacadeWith(seat);
      await ai.createRawCompletion({
        callSite: 'tailor-resume',
        system: 'Be terse.',
        user: 'hi',
        provider: 'claude-cli',
        responseFormat: 'text',
      });

      const [warning, ...rest] = describeAiTimeoutsAboveRequestDeadline();
      assert.deepEqual(rest, []);
      assert.match(warning, /AI_CLI_TIMEOUT_MS_TAILOR=600000 is longer than AI_REQUEST_TIMEOUT_MS=60000/);
    });

    assert.equal(runner.calls.length, 1);
    assert.ok(runner.calls[0].deadlineMs <= 60_000, `child budget ${runner.calls[0].deadlineMs}ms`);
    assert.ok(runner.calls[0].deadlineMs > 55_000, `child budget ${runner.calls[0].deadlineMs}ms`);
  });
}

/* ================================================== the CLI health probes */

/** Replaces execFile for one test, so a health probe records its timeout and spawns nothing. */
async function withExecFile(answer, run) {
  const calls = [];
  const real = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    calls.push({ command, args, timeout: options.timeout });
    const { stdout = '', stderr = '' } = answer(args) ?? {};
    process.nextTick(() => callback(null, stdout, stderr));
    return { pid: 0 };
  };
  try {
    await run();
  } finally {
    childProcess.execFile = real;
  }
  return calls;
}

// What a current CLI signed in with `claude auth login` prints (account fields left out).
const claudeAnswers = (args) =>
  args[0] === '--version'
    ? { stdout: '2.1.292 (Claude Code)\n' }
    : { stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' };

async function claudeProbeTimeouts(vars, options = {}) {
  const { checkClaudeCliHealth } = require('../dist/services/ai/providers/claudeCli/health');
  let health = null;
  const calls = await withEnv(vars, () =>
    withExecFile(claudeAnswers, async () => {
      health = await checkClaudeCliHealth({ binary: 'claude', env: {}, ...options });
    })
  );
  assert.equal(health.ok, true, health.detail);
  assert.equal(health.warning, undefined, 'the subscription draws no warning');
  assert.deepEqual(
    calls.map((call) => call.args.join(' ')),
    ['--version', 'auth status']
  );
  return calls.map((call) => call.timeout);
}

test('AI_CLI_HEALTH_TIMEOUT_MS bounds both commands of the claude probe; unset it is 20s', async () => {
  assert.deepEqual(await claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: undefined }), [20_000, 20_000]);
  assert.deepEqual(await claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: '' }), [20_000, 20_000]);
  assert.deepEqual(await claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: '45000' }), [45_000, 45_000]);
  // An explicit timeout from the caller still wins.
  assert.deepEqual(
    await claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: '45000' }, { timeoutMs: 3_000 }),
    [3_000, 3_000]
  );
});

test('a junk AI_CLI_HEALTH_TIMEOUT_MS warns once and uses 20s; out of range is clamped', async () => {
  const junk = await captureWarnings(() => claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: '20s' }));
  assert.deepEqual(junk.value, [20_000, 20_000]);
  assert.equal(envWarnings(junk.warnings).length, 1, 'two commands, one warning');

  const low = await captureWarnings(() => claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: '10' }));
  assert.deepEqual(low.value, [1_000, 1_000]);
  assert.match(envWarnings(low.warnings)[0], /AI_CLI_HEALTH_TIMEOUT_MS=10 is outside 1000\.\.120000/);

  const high = await captureWarnings(() => claudeProbeTimeouts({ AI_CLI_HEALTH_TIMEOUT_MS: '600000' }));
  assert.deepEqual(high.value, [120_000, 120_000]);
});

test("the claude-cli adapter's own health check - the preflight and the admin card - uses it too", async () => {
  // The adapter passes no timeout, so this is the path the startup readiness
  // line and the admin health endpoint actually take.
  const { createClaudeCliAdapter } = require('../dist/services/ai/providers/claudeCli/index');
  const calls = await withEnv({ AI_CLI_HEALTH_TIMEOUT_MS: '33000' }, () =>
    withExecFile(claudeAnswers, async () => {
      const seat = createClaudeCliAdapter({
        runner: makeFakeCliRunner({ lines: [] }),
        config: { binary: 'claude' },
      });
      const health = await seat.health();
      assert.equal(health.ok, true, health.detail);
    })
  );
  assert.deepEqual(calls.map((call) => call.timeout), [33_000, 33_000]);
});

async function codexProbeTimeout(vars, options = {}) {
  const { checkCodexCliHealth } = require('../dist/services/ai/providers/codexCli/health');
  let health = null;
  const calls = await withEnv(vars, () =>
    withExecFile(
      () => ({ stdout: 'Logged in using ChatGPT\n' }),
      async () => {
        health = await checkCodexCliHealth({ binary: 'codex', env: {}, ...options });
      }
    )
  );
  assert.equal(health.ok, true, health.detail);
  assert.deepEqual(calls.map((call) => call.args.join(' ')), ['login status']);
  return calls[0].timeout;
}

test('AI_CODEX_HEALTH_TIMEOUT_MS bounds `codex login status`; unset it is 15s', async () => {
  assert.equal(await codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: undefined }), 15_000);
  assert.equal(await codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: ' ' }), 15_000);
  assert.equal(await codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: '40000' }), 40_000);
  assert.equal(await codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: '40000' }, { timeoutMs: 2_000 }), 2_000);
});

test('a junk AI_CODEX_HEALTH_TIMEOUT_MS warns once and uses 15s; out of range is clamped', async () => {
  const junk = await captureWarnings(() => codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: 'slow' }));
  assert.equal(junk.value, 15_000);
  assert.equal(envWarnings(junk.warnings).length, 1);
  assert.match(envWarnings(junk.warnings)[0], /AI_CODEX_HEALTH_TIMEOUT_MS="slow"/);

  const low = await captureWarnings(() => codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: '0' }));
  assert.equal(low.value, 1_000);
  assert.equal(envWarnings(low.warnings).length, 1);

  const high = await captureWarnings(() => codexProbeTimeout({ AI_CODEX_HEALTH_TIMEOUT_MS: '999999' }));
  assert.equal(high.value, 120_000);
});

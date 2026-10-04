const assert = require('node:assert/strict');
const test = require('node:test');
const childProcess = require('child_process');

const { loadFresh, makeFakeCliRunner, readCliFixture, useTempStorage } = require('./helpers');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');

/**
 * That the AI layer's operational settings reach the thing they change.
 *
 * `operational.test.js` pins what the getters return; this file pins that the
 * AI layer USES them - the deadline a provider is handed, the URL the metered
 * adapters post to, how many times the `claude` adapter tries, the headers the
 * DeepSeek client sends, and the timeout the CLI health probes run under.
 *
 * Nothing here reaches a network or spawns a process. fetch and
 * child_process.execFile are replaced for the duration of each test and
 * restored after it; the CLI provider runs on the recorded-stream runner.
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

/** Replaces global fetch for one test. `respond(url, init, index)` returns a Response. */
async function withFetch(respond, run) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: new Headers(init.headers ?? {}), body: init.body });
    return respond(url, init, calls.length - 1);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

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
      requiresApiKey: false,
      credentialKind: 'subscription-seat',
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

test('the request deadline caps a CLI budget set above it - the case the startup warning is about', async () => {
  // AI_CLI_TIMEOUT_MS_TAILOR=600000 is read by the provider and then never
  // reached: the child is given the smaller of the two. operational.ts's
  // describeAiTimeoutsAboveRequestDeadline says so at startup; this pins that
  // what it says is true of the real adapter.
  useTempStorage('ai-deadline-cli');
  const { createClaudeCliAdapter } = require('../dist/services/ai/providers/claudeCli/index');
  const { describeAiTimeoutsAboveRequestDeadline } = require('../dist/config/operational');
  const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });

  await withEnv({ AI_REQUEST_TIMEOUT_MS: '60000', AI_CLI_TIMEOUT_MS_TAILOR: '600000' }, async () => {
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

/* ==================================================== the `claude` HTTP API */

const anthropicOk = () =>
  new Response(
    JSON.stringify({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

/** Overloaded every time, with a Retry-After of a millisecond so the retries cost nothing. */
const anthropicOverloaded = () =>
  new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
    status: 529,
    headers: { 'retry-after': '0.001' },
  });

function httpRequest() {
  const { createDeadline } = require('../dist/services/ai/types');
  return {
    modelName: 'claude-test',
    stableSystem: '',
    volatileSystem: '',
    userBody: 'hi',
    responseFormat: 'text',
    sampling: {},
    deadline: createDeadline(60_000),
    callSite: 'probe',
  };
}

function anthropicAdapter() {
  const { createAnthropicHttpAdapter } = require('../dist/services/ai/providers/anthropicHttp');
  return createAnthropicHttpAdapter({ defaultModel: 'claude-test' });
}

async function anthropicUrl(vars) {
  const calls = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', ...vars }, () =>
    withFetch(anthropicOk, async () => {
      await anthropicAdapter().complete(httpRequest());
    })
  );
  return calls.map((call) => call.url);
}

test('CLAUDE_BASE_URL moves the `claude` provider; unset it is api.anthropic.com as always', async () => {
  assert.deepEqual(await anthropicUrl({ CLAUDE_BASE_URL: undefined }), ['https://api.anthropic.com/v1/messages']);
  assert.deepEqual(await anthropicUrl({ CLAUDE_BASE_URL: '' }), ['https://api.anthropic.com/v1/messages']);
  assert.deepEqual(await anthropicUrl({ CLAUDE_BASE_URL: 'https://gateway.example/anthropic/' }), [
    'https://gateway.example/anthropic/v1/messages',
  ]);
  // Loopback may be plain http: a local gateway never puts the key on a wire.
  assert.deepEqual(await anthropicUrl({ CLAUDE_BASE_URL: 'http://127.0.0.1:4000' }), [
    'http://127.0.0.1:4000/v1/messages',
  ]);
});

test('a CLAUDE_BASE_URL over plain http to another host is used as set, with one warning', async () => {
  const { value, warnings } = await captureWarnings(() =>
    anthropicUrl({ CLAUDE_BASE_URL: 'http://gateway.example' })
  );
  assert.deepEqual(value, ['http://gateway.example/v1/messages']);
  assert.equal(envWarnings(warnings).length, 1);
  assert.match(envWarnings(warnings)[0], /CLAUDE_BASE_URL=.*travels unencrypted/);
});

test('ANTHROPIC_BASE_URL does not move the metered provider - it belongs to the claude CLI child', async () => {
  // claudeCli/env.ts passes ANTHROPIC_BASE_URL through to the `claude` child on
  // purpose, and strips every CLAUDE_* name (but CLAUDE_CONFIG_DIR). So the
  // two settings each reach exactly one provider.
  assert.deepEqual(await anthropicUrl({ CLAUDE_BASE_URL: undefined, ANTHROPIC_BASE_URL: 'https://elsewhere.example' }), [
    'https://api.anthropic.com/v1/messages',
  ]);
  const { buildChildEnv } = require('../dist/services/ai/providers/claudeCli/env');
  const child = buildChildEnv({ CLAUDE_BASE_URL: 'https://gw.example', ANTHROPIC_BASE_URL: 'https://cli.example' });
  assert.equal('CLAUDE_BASE_URL' in child, false);
  assert.equal(child.ANTHROPIC_BASE_URL, 'https://cli.example');
});

async function anthropicAttempts(vars) {
  let failure = null;
  // The adapter's retry sleep unrefs its timer (a pending retry must not keep a
  // stopping server alive). With fetch stubbed nothing else holds the event
  // loop open, so node:test would see it drain mid-retry; this does instead.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const { value: calls, warnings } = await captureWarnings(() =>
      withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_BASE_URL: undefined, ...vars }, () =>
        withFetch(anthropicOverloaded, async () => {
          failure = await anthropicAdapter()
            .complete(httpRequest())
            .then(
              () => assert.fail('an overloaded API answered'),
              (error) => error
            );
        })
      )
    );
    assert.equal(failure.kind, 'unavailable', 'the last 529 is reported, not swallowed');
    return { attempts: calls.length, warnings };
  } finally {
    clearInterval(keepAlive);
  }
}

test('CLAUDE_MAX_ATTEMPTS is how many times the `claude` provider tries, counting the first', async () => {
  const two = await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: '2' });
  assert.equal(two.attempts, 2);
  // The retry line's "n/N" is the N the loop actually uses.
  assert.ok(two.warnings.some((line) => /\(attempt 1\/2\)/.test(line)), two.warnings.join('\n'));

  assert.equal((await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: '1' })).attempts, 1, '1 means never retry');
});

test('unset, the `claude` provider tries four times, as it always did', async () => {
  const unset = await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: undefined });
  assert.equal(unset.attempts, 4);
  assert.deepEqual(envWarnings(unset.warnings), []);
  assert.equal((await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: '' })).attempts, 4);
});

test('a junk CLAUDE_MAX_ATTEMPTS warns and uses four; out of range is clamped to 1..10', async () => {
  const junk = await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: 'three' });
  assert.equal(junk.attempts, 4);
  assert.equal(envWarnings(junk.warnings).length, 1);
  assert.match(envWarnings(junk.warnings)[0], /CLAUDE_MAX_ATTEMPTS="three" is not a whole number/);

  const zero = await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: '0' });
  assert.equal(zero.attempts, 1, '0 is not "no attempts at all"');
  assert.equal(envWarnings(zero.warnings).length, 1);

  const many = await anthropicAttempts({ CLAUDE_MAX_ATTEMPTS: '50' });
  assert.equal(many.attempts, 10);
  assert.match(envWarnings(many.warnings)[0], /CLAUDE_MAX_ATTEMPTS=50 is outside 1\.\.10/);
});

/* ======================================== the OpenAI-compatible providers */

const chatOk = () =>
  new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

function compatibleAdapter(id) {
  const { createOpenAICompatibleAdapter } = require('../dist/services/ai/providers/openaiCompatible');
  return createOpenAICompatibleAdapter({
    id,
    defaultModel: 'test-model',
    tokenLimitField: id === 'openai' ? 'max_completion_tokens' : 'max_tokens',
  });
}

const CLEAN_OPENAI_ENV = {
  OPENAI_API_KEY: 'sk-openai-test',
  DEEPSEEK_API_KEY: 'sk-deepseek-test',
  OPENAI_BASE_URL: undefined,
  DEEPSEEK_BASE_URL: undefined,
  OPENAI_ORG_ID: undefined,
  OPENAI_PROJECT_ID: undefined,
};

async function compatibleCalls(id, vars) {
  return withEnv({ ...CLEAN_OPENAI_ENV, ...vars }, () =>
    withFetch(chatOk, async () => {
      await compatibleAdapter(id).complete(httpRequest());
    })
  );
}

test('unset, openai and deepseek post to the vendor endpoints they always did', async () => {
  const [openai] = await compatibleCalls('openai', {});
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
  const [deepseek] = await compatibleCalls('deepseek', {});
  assert.equal(deepseek.url, 'https://api.deepseek.com/chat/completions');
});

test('OPENAI_BASE_URL and DEEPSEEK_BASE_URL each move their own provider, and only it', async () => {
  const [openai] = await compatibleCalls('openai', { OPENAI_BASE_URL: 'https://llm.example/v1/' });
  assert.equal(openai.url, 'https://llm.example/v1/chat/completions');

  const [deepseek] = await compatibleCalls('deepseek', { DEEPSEEK_BASE_URL: 'https://ds.example/' });
  assert.equal(deepseek.url, 'https://ds.example/chat/completions');

  // The SDK reads OPENAI_BASE_URL by itself; an explicit baseURL is what keeps
  // that read from ever sending a DeepSeek key to an OpenAI gateway.
  const [crossed] = await compatibleCalls('deepseek', { OPENAI_BASE_URL: 'https://llm.example/v1' });
  assert.equal(crossed.url, 'https://api.deepseek.com/chat/completions');
});

test('an OPENAI_BASE_URL at a LAN box over plain http still goes there - never to api.openai.com', async () => {
  // The SDK always honoured any URL here, and an Ollama or LM Studio box on the
  // LAN is exactly what people point it at. Falling back to the vendor would
  // send their resumes to OpenAI without anybody having asked for that.
  const { value, warnings } = await captureWarnings(() =>
    compatibleCalls('openai', { OPENAI_BASE_URL: 'http://192.168.1.10:11434/v1' })
  );
  assert.equal(value[0].url, 'http://192.168.1.10:11434/v1/chat/completions');
  assert.equal(envWarnings(warnings).length, 1);
  assert.match(envWarnings(warnings)[0], /OPENAI_BASE_URL=.*travels unencrypted/);

  const [local] = await compatibleCalls('openai', { OPENAI_BASE_URL: 'http://localhost:11434/v1' });
  assert.equal(local.url, 'http://localhost:11434/v1/chat/completions');
});

test('OPENAI_ORG_ID and OPENAI_PROJECT_ID reach OpenAI and never DeepSeek', async () => {
  const ids = { OPENAI_ORG_ID: 'org-operator', OPENAI_PROJECT_ID: 'proj_operator' };

  const [openai] = await compatibleCalls('openai', ids);
  assert.equal(openai.headers.get('openai-organization'), 'org-operator');
  assert.equal(openai.headers.get('openai-project'), 'proj_operator');
  assert.equal(openai.headers.get('authorization'), 'Bearer sk-openai-test');

  const [deepseek] = await compatibleCalls('deepseek', ids);
  assert.equal(deepseek.headers.get('openai-organization'), null);
  assert.equal(deepseek.headers.get('openai-project'), null);
  assert.equal(deepseek.headers.get('authorization'), 'Bearer sk-deepseek-test');
});

test('the base URL is read per call: a changed value takes effect on the same adapter', async () => {
  const adapter = compatibleAdapter('deepseek');
  const calls = await withEnv({ ...CLEAN_OPENAI_ENV }, () =>
    withFetch(chatOk, async () => {
      await adapter.complete(httpRequest());
      await withEnv({ DEEPSEEK_BASE_URL: 'https://ds.example' }, () => adapter.complete(httpRequest()));
      await withEnv({ DEEPSEEK_BASE_URL: 'https://ds.example' }, () => adapter.complete(httpRequest()));
    })
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.deepseek.com/chat/completions',
      'https://ds.example/chat/completions',
      'https://ds.example/chat/completions',
    ]
  );
});

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

const claudeAnswers = (args) =>
  args[0] === '--version'
    ? { stdout: '2.0.0 (Claude Code)\n' }
    : { stdout: '{"loggedIn":true,"authMethod":"oauth_token"}' };

async function claudeProbeTimeouts(vars, options = {}) {
  const { checkClaudeCliHealth } = require('../dist/services/ai/providers/claudeCli/health');
  let health = null;
  const calls = await withEnv(vars, () =>
    withExecFile(claudeAnswers, async () => {
      health = await checkClaudeCliHealth({ binary: 'claude', env: {}, ...options });
    })
  );
  assert.equal(health.ok, true, health.detail);
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

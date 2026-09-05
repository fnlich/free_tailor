const assert = require('node:assert/strict');
const test = require('node:test');

const { makeFakeCliRunner, readCliFixture, useTempStorage } = require('./helpers');

/**
 * The Claude CLI provider, tested with no `claude` binary, no network and no
 * subprocess. Everything runs against a fake `CliRunner` replaying streams
 * recorded from the real CLI (v2.1.261) under test/fixtures/cli.
 *
 * AI_CLI_BIN points at a path that does not exist, so any code path that
 * accidentally reached a real spawn would fail loudly rather than pass by
 * accident on a machine that happens to have Claude Code installed.
 */
process.env.AI_CLI_BIN = '/nonexistent/claude';

function load(modulePath) {
  return require(modulePath);
}

const argv = load('../dist/services/ai/providers/claudeCli/argv');
const env = load('../dist/services/ai/providers/claudeCli/env');
const events = load('../dist/services/ai/providers/claudeCli/events');
const classify = load('../dist/services/ai/providers/claudeCli/classify');
const limits = load('../dist/services/ai/providers/claudeCli/limits');
const { createClaudeCliAdapter } = load('../dist/services/ai/providers/claudeCli/index');
const { createDeadline } = load('../dist/services/ai/types');
const { AsyncSemaphore, mapWithConcurrency } = load('../dist/services/ai/concurrency');

function makeRequest(overrides = {}) {
  return {
    modelName: 'sonnet',
    stableSystem: 'You are a resume assistant.',
    volatileSystem: 'Return valid JSON only.',
    userBody: 'What is the capital of France?',
    responseFormat: 'json',
    sampling: {},
    deadline: createDeadline(60_000),
    callSite: 'test-call',
    ...overrides,
  };
}

function makeAdapter(runner, config = {}) {
  return createClaudeCliAdapter({
    runner,
    config: {
      binary: '/nonexistent/claude',
      model: 'sonnet',
      workdir: process.env.TMPDIR || '/tmp',
      concurrency: 4,
      firstEventMs: 1_000,
      queueWaitMs: 1_000,
      ...config,
    },
    healthCheck: async () => ({
      ok: true,
      loggedIn: true,
      binary: '/nonexistent/claude',
      version: 'test',
      authMethod: 'oauth_token',
      checkedAt: new Date().toISOString(),
      detail: 'stub',
    }),
  });
}

// -- argv ------------------------------------------------------------------ //

test('claude argv carries the flags the provider depends on and never --bare', () => {
  const { argv: flags, systemPromptOverflow } = argv.buildClaudeArgv({
    model: 'sonnet',
    effort: 'low',
    systemPrompt: 'Be terse.',
  });

  assert.equal(systemPromptOverflow, '');
  for (const flag of [
    '-p',
    '--output-format',
    '--include-partial-messages',
    '--verbose',
    '--model',
    '--effort',
    '--tools',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--permission-prompts',
    '--no-session-persistence',
    '--system-prompt',
  ]) {
    assert.ok(flags.includes(flag), `expected ${flag} in argv`);
  }
  assert.equal(flags[flags.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(flags[flags.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(flags[flags.indexOf('--system-prompt') + 1], 'Be terse.');

  // --bare forces ANTHROPIC_API_KEY auth and never reads OAuth, which would
  // silently move every request onto metered billing. It must never appear.
  assert.equal(flags.includes('--bare'), false);
  assert.deepEqual(argv.FORBIDDEN_FLAGS, ['--bare']);
});

test('a JSON schema is passed only when one is supplied', () => {
  const without = argv.buildClaudeArgv({ model: 'sonnet', effort: 'low', systemPrompt: 'x' });
  assert.equal(without.argv.includes('--json-schema'), false);

  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const with_ = argv.buildClaudeArgv({ model: 'sonnet', effort: 'low', systemPrompt: 'x', jsonSchema: schema });
  assert.equal(with_.argv[with_.argv.indexOf('--json-schema') + 1], JSON.stringify(schema));
});

test('an oversized system prompt moves to stdin instead of blowing the exec argument limit', () => {
  // Measured: a 150 KB --system-prompt fails the exec outright with
  // "Argument list too long", because Linux caps one argv entry at 128 KiB
  // regardless of the much larger ARG_MAX total.
  const huge = 'x'.repeat(200_000);
  const built = argv.buildClaudeArgv({ model: 'sonnet', effort: 'low', systemPrompt: huge });

  assert.equal(built.systemPromptOverflow, huge);
  assert.equal(built.argv[built.argv.indexOf('--system-prompt') + 1], argv.CLI_BASE_SYSTEM_PROMPT);
  assert.ok(
    built.argv.every((entry) => Buffer.byteLength(entry, 'utf8') < 100_000),
    'no argv entry may approach the per-argument exec limit'
  );
});

test('stale model names degrade to the default instead of reaching the CLI', () => {
  // Every model name a database written before this change carries is in this
  // class, and the CLI answers each with a hard 404.
  assert.equal(argv.resolveCliModel('openai/gpt-5.4-nano', 'sonnet'), 'sonnet');
  assert.equal(argv.resolveCliModel('google/gemini-2.5-flash', 'sonnet'), 'sonnet');
  assert.equal(argv.resolveCliModel('deepseek/deepseek-chat', 'sonnet'), 'sonnet');
  assert.equal(argv.resolveCliModel(undefined, 'sonnet'), 'sonnet');
  assert.equal(argv.resolveCliModel('   ', 'sonnet'), 'sonnet');

  // Aliases and full model names pass through untouched.
  assert.equal(argv.resolveCliModel('opus', 'sonnet'), 'opus');
  assert.equal(argv.resolveCliModel('haiku', 'sonnet'), 'haiku');
  assert.equal(argv.resolveCliModel('claude-sonnet-5', 'sonnet'), 'claude-sonnet-5');
  assert.equal(argv.resolveCliModel('claude-sonnet-4-20250514', 'sonnet'), 'claude-sonnet-4-20250514');
});

// -- child environment ----------------------------------------------------- //

test('the child environment drops the API key and the parent session, and keeps the sign-in', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/app',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    HTTPS_PROXY: 'http://proxy:3128',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-reach-the-child',
    ANTHROPIC_AUTH_TOKEN: 'token-should-not-reach-the-child',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CONFIG_DIR: '/home/app/.claude',
  };

  const child = env.buildChildEnv(parent);

  // An API key WINS over the subscription in the CLI's credential order, so
  // leaving it in place would bill every request at identical latency with
  // nothing to say so.
  assert.equal('ANTHROPIC_API_KEY' in child, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in child, false);

  // With these left in place the child rejoins the PARENT session, which is
  // exactly what happens when the server is run from inside Claude Code.
  assert.equal('CLAUDECODE' in child, false);
  assert.equal('CLAUDE_CODE_SESSION_ID' in child, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in child, false);

  // The one CLAUDE_* that must survive: it is where the sign-in lives.
  assert.equal(child.CLAUDE_CONFIG_DIR, '/home/app/.claude');

  // The operator's own configuration is not this module's business.
  assert.equal(child.PATH, '/usr/bin');
  assert.equal(child.HOME, '/home/app');
  assert.equal(child.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(child.HTTPS_PROXY, 'http://proxy:3128');

  const opted = env.buildChildEnv(parent, { allowApiKey: true });
  assert.equal(opted.ANTHROPIC_API_KEY, 'sk-ant-should-not-reach-the-child');
});

// -- event reduction ------------------------------------------------------- //

function reduce(lines) {
  const state = events.createTurnState();
  const push = events.createEventReducer(state);
  lines.forEach((line, index) => push(line, index));
  return state;
}

test('a healthy stream reduces to the answer, the model, and the usage counters', () => {
  const state = reduce(readCliFixture('success-text'));

  assert.equal(events.readTurnText(state), '{"capital": "Paris"}');
  assert.equal(state.model, 'claude-sonnet-5');
  assert.equal(state.isError, false);
  assert.equal(state.stopReason, 'end_turn');
  assert.equal(state.usage.inputTokens, 294);
  assert.equal(state.usage.outputTokens, 14);
  assert.equal(state.costUsd, 0.000728);
  assert.equal(state.apiKeySource, 'none');
});

test('unparseable lines, arrays and unknown event types are skipped rather than thrown on', () => {
  // v2.1.261 already emits event types this app has no use for; a parser that
  // rejects what it does not recognise breaks on the next CLI release.
  const state = reduce(readCliFixture('unknown-events'));
  assert.equal(events.readTurnText(state), '{"capital": "Paris"}');
});

test('a retry drops the text that arrived before it', () => {
  // A retry restarts the message, so anything already streamed is no longer
  // the beginning of the answer.
  const state = reduce(readCliFixture('api-retry'));
  assert.equal(state.retries, 1);
  assert.equal(state.lastRetryStatus, 529);
  assert.equal(state.deltaText, '{"capital": "Paris"}');
  assert.equal(events.readTurnText(state), '{"capital": "Paris"}');
});

test('the answer is read from the result event, not the delta buffer', () => {
  const lines = readCliFixture('success-text');
  const state = events.createTurnState();
  const push = events.createEventReducer(state);
  // Drop every delta: the result event alone must still carry the answer.
  lines.filter((line) => !line.includes('text_delta')).forEach((line, i) => push(line, i));
  assert.equal(events.readTurnText(state), '{"capital": "Paris"}');
});

// -- failure classification ------------------------------------------------ //

test('classification keys on is_error and api_error_status, never on subtype', () => {
  // Verified against the real CLI: a hard model 404 arrives as
  // subtype "success" with is_error true.
  assert.equal(
    classify.classifyCliFailure({
      apiErrorStatus: 404,
      isError: true,
      exitCode: 0,
      stderrTail: '',
      resultText: "There's an issue with the selected model",
    }),
    'modelUnavailable'
  );

  assert.equal(
    classify.classifyCliFailure({ apiErrorStatus: 401, isError: true, exitCode: 1, stderrTail: '', resultText: '' }),
    'auth'
  );
  assert.equal(
    classify.classifyCliFailure({ apiErrorStatus: 429, isError: true, exitCode: 1, stderrTail: '', resultText: '' }),
    'rateLimited'
  );
  assert.equal(
    classify.classifyCliFailure({ apiErrorStatus: 529, isError: true, exitCode: 1, stderrTail: '', resultText: '' }),
    'unavailable'
  );
});

test('classification works with no api_error_status at all', () => {
  // The status field is not guaranteed on every CLI version, so the
  // marks-based path has to stand on its own.
  const cases = [
    ['not logged in, please run /login', 'auth'],
    ['usage limit reached for this account', 'rateLimited'],
    ["There's an issue with the selected model (x)", 'modelUnavailable'],
    ['upstream connect error: fetch failed', 'unavailable'],
    ['API Error: 529 Overloaded', 'unavailable'],
    ['HTTP 403 forbidden', 'auth'],
  ];

  for (const [text, expected] of cases) {
    assert.equal(
      classify.classifyCliFailure({
        apiErrorStatus: null,
        isError: true,
        exitCode: 1,
        stderrTail: text,
        resultText: '',
      }),
      expected,
      `"${text}" should classify as ${expected}`
    );
  }
});

test('a bare three-digit number is not a status code', () => {
  // A bare \\d{3} matches a stack-frame column, a duration and a port - each of
  // which would park a healthy model or seat for ten minutes.
  const falsePositives = ['at cli.js:512:98765', 'took 503 ms', 'listening on 8503'];

  for (const text of falsePositives) {
    assert.equal(
      classify.classifyCliFailure({
        apiErrorStatus: null,
        isError: false,
        exitCode: 0,
        stderrTail: text,
        resultText: '',
      }),
      null,
      `"${text}" must not be read as a failure`
    );
  }
});

// -- rate limits and outages ----------------------------------------------- //

test('a spent window is a limit even while the status still reads allowed', () => {
  const verdict = limits.interpretRateLimitEvent(
    {
      status: 'allowed',
      resetsAt: 1788627600,
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1788627600 } },
    },
    { allowOverage: false }
  );

  assert.equal(verdict.limited, true);
  assert.equal(verdict.utilization, 1);
});

test('paid overage is refused by default and allowed only on request', () => {
  const info = {
    status: 'allowed',
    isUsingOverage: true,
    unifiedWindows: { five_hour: { utilization: 0.4 } },
  };

  // Overage is metered billing, and this provider exists to avoid that.
  assert.equal(limits.interpretRateLimitEvent(info, { allowOverage: false }).limited, true);
  assert.equal(limits.interpretRateLimitEvent(info, { allowOverage: true }).limited, false);
});

test('a weekly limit on one model does not park the other', () => {
  const opus = limits.interpretRateLimitEvent(
    { status: 'rejected', rateLimitType: 'seven_day_opus' },
    { allowOverage: false }
  );
  assert.equal(opus.scope, 'opus');

  const seat = limits.interpretRateLimitEvent(
    { status: 'rejected', rateLimitType: 'five_hour' },
    { allowOverage: false }
  );
  assert.equal(seat.scope, '*');
});

test('the outage table holds, expires, and reports why', () => {
  let now = 1_000_000;
  const table = new limits.OutageTable(() => now, 10 * 60_000);

  assert.equal(table.check('sonnet').waitMs, 0);

  table.noteUnavailable('sonnet', 'overloaded');
  assert.ok(table.check('sonnet').waitMs > 0);
  assert.equal(table.check('sonnet').reason, 'overloaded');
  // A model-scoped outage must not park a different model.
  assert.equal(table.check('opus').waitMs, 0);

  now += 11 * 60_000;
  assert.equal(table.check('sonnet').waitMs, 0);

  // A reported reset far in the future is clamped, so a lifted limit or a
  // wrong clock costs at most one probe within half an hour.
  table.noteLimit('*', now / 1000 + 86_400, 'weekly limit');
  assert.ok(table.check('opus').waitMs <= 30 * 60_000 + 1);
});

// -- the adapter end to end ------------------------------------------------ //

test('a healthy call returns the answer, the usage and the resolved model', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });
  const result = await makeAdapter(runner).complete(makeRequest());

  assert.equal(result.text, '{"capital": "Paris"}');
  assert.equal(result.providerId, 'claude-cli');
  assert.equal(result.resolvedModel, 'claude-sonnet-5');
  assert.equal(result.usage.inputTokens, 294);
  assert.equal(result.costUsd, 0.000728);
});

test('the prompt is written to stdin and never placed in argv', async () => {
  // A rendered tailor-resume prompt is tens of kilobytes; argv is the wrong
  // channel for it, and leaving stdin unwritten makes the CLI wait for input.
  const body = 'A'.repeat(100_000);
  const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });
  await makeAdapter(runner).complete(makeRequest({ userBody: body }));

  assert.equal(runner.calls[0].stdin, body);
  assert.ok(
    runner.calls[0].argv.every((entry) => !entry.includes('AAAA')),
    'the prompt body must not appear in any argv entry'
  );
});

test('line splitting survives arbitrary chunk boundaries, including mid-character', async () => {
  const text = readCliFixture('success-text').join('\n') + '\n';
  const bytes = Buffer.from(text.replaceAll('Paris', 'Paris éè'), 'utf8');
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) {
    chunks.push(bytes.subarray(i, i + 7));
  }

  const runner = makeFakeCliRunner({ chunks });
  const result = await makeAdapter(runner).complete(makeRequest());
  assert.equal(result.text, '{"capital": "Paris éè"}');
});

test('a model the service will not serve is reported as such, not as a generic failure', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('model-not-found') });
  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'modelUnavailable' && error.httpStatus === 503
  );
});

test('a spent usage window is a 429 with a retry hint, and parks the seat', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('rate-limited') });
  const adapter = makeAdapter(runner);

  await assert.rejects(
    () => adapter.complete(makeRequest()),
    (error) => error.kind === 'rateLimited' && error.httpStatus === 429
  );

  // The next call is turned away instantly rather than spending its whole
  // budget rediscovering the same fact.
  await assert.rejects(() => adapter.complete(makeRequest()), (error) => error.kind === 'rateLimited');
  assert.equal(runner.calls.length, 1, 'the second call must not reach the runner');
  assert.ok(adapter.outages().length > 0);
});

test('a window at 100% is a limit even when the CLI still says allowed', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('window-spent-allowed') });
  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'rateLimited'
  );
});

test('paid overage is refused unless the operator opted in', async () => {
  const refuse = makeFakeCliRunner({ lines: readCliFixture('overage-in-use') });
  await assert.rejects(
    () => makeAdapter(refuse).complete(makeRequest()),
    (error) => error.kind === 'rateLimited'
  );

  const allow = makeFakeCliRunner({ lines: readCliFixture('overage-in-use') });
  const result = await makeAdapter(allow, { allowOverage: true }).complete(makeRequest());
  assert.equal(result.text, '{"capital": "Paris"}');
});

test('a signed-out seat is reported as an auth problem with an admin action', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('auth-failure') });
  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'auth'
  );
});

test('an API key reaching the child aborts the call rather than billing silently', async () => {
  // Identical answers at identical latency, and a bill. The only way this is
  // ever noticed is by asserting it.
  const runner = makeFakeCliRunner({ lines: readCliFixture('api-key-billing') });
  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'auth' && /billed per token/.test(error.message)
  );

  const allowed = makeFakeCliRunner({ lines: readCliFixture('api-key-billing') });
  const result = await makeAdapter(allowed, { allowApiKey: true }).complete(makeRequest());
  assert.equal(result.text, '{"capital": "Paris"}');
});

test('a response cut off by the model output limit fails instead of returning a fragment', async () => {
  // extractJSON will happily find a balanced sub-object inside a truncated
  // document, so a fragment does not fail here - it fails later, in a parser,
  // looking like a prompt bug.
  const runner = makeFakeCliRunner({ lines: readCliFixture('truncated-max-tokens') });
  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'truncated'
  );
});

test('a turn cut off by the clock returns no body at all', async () => {
  const runner = makeFakeCliRunner({
    lines: readCliFixture('success-text').filter((line) => !line.includes('"type":"result"')),
    timedOut: true,
  });

  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'timeout'
  );
});

test('a turn that produces no output at all is treated as a spent window, not a slow model', async () => {
  // Measured at the subscription's usage limit: the CLI blocks silently and
  // forever rather than failing.
  const runner = makeFakeCliRunner({ stalled: true });
  const adapter = makeAdapter(runner);

  await assert.rejects(
    () => adapter.complete(makeRequest()),
    (error) => error.kind === 'stalled'
  );
  assert.ok(adapter.outages().length > 0, 'a stall must park the seat briefly');
});

test('a missing binary names the fix instead of failing generically', async () => {
  const enoent = Object.assign(new Error('spawn /nonexistent/claude ENOENT'), { code: 'ENOENT' });
  const runner = makeFakeCliRunner({ spawnError: enoent });

  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'binaryMissing' && /claude auth login/.test(error.adminAction)
  );
});

test('sampling parameters the CLI cannot honour are reported rather than dropped in silence', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });
  const result = await makeAdapter(runner).complete(
    makeRequest({ sampling: { temperature: 0.7, maxOutputTokens: 11000 } })
  );

  assert.deepEqual([...result.droppedParams].sort(), ['maxOutputTokens', 'temperature']);
});

test('the child is launched with a scrubbed environment and the configured working directory', async () => {
  const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });
  const { rootDir } = useTempStorage('cli-workdir');

  await makeAdapter(runner, { workdir: rootDir }).complete(makeRequest());

  assert.equal(runner.calls[0].cwd, rootDir);
  assert.equal('ANTHROPIC_API_KEY' in runner.calls[0].env, false);
  assert.equal('CLAUDECODE' in runner.calls[0].env, false);
  assert.equal(runner.calls[0].argv.includes('--bare'), false);
});

// -- concurrency ----------------------------------------------------------- //

test('the semaphore never lets more than its limit run at once', async () => {
  const semaphore = new AsyncSemaphore(3);
  let live = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 20 }, async () => {
      const release = await semaphore.acquire();
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      release();
    })
  );

  assert.equal(peak, 3);
  assert.equal(semaphore.inFlight, 0);
  assert.equal(semaphore.queued, 0);
});

test('a slot wait is bounded, and a slot is released even when the work throws', async () => {
  const semaphore = new AsyncSemaphore(1);
  const held = await semaphore.acquire();

  await assert.rejects(
    () => semaphore.acquire({ timeoutMs: 20 }),
    (error) => error.name === 'SemaphoreTimeoutError'
  );

  held();
  const next = await semaphore.acquire({ timeoutMs: 20 });
  next();
  assert.equal(semaphore.inFlight, 0);
});

test('mapWithConcurrency preserves input order and collects per-item failures', async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, (6 - value) * 2));
    if (value === 3) throw new Error('item three failed');
    return value * 10;
  });

  assert.equal(results.length, 5);
  assert.deepEqual(
    results.map((entry) => (entry.ok ? entry.value : 'FAILED')),
    [10, 20, 'FAILED', 40, 50]
  );
  assert.match(results[2].error.message, /item three failed/);
});

test('the concurrency limit is shared across simultaneous requests, not per request', async () => {
  let live = 0;
  let peak = 0;
  const runner = makeFakeCliRunner(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
    return { lines: readCliFixture('success-text') };
  });

  // Two adapters, ONE process-wide semaphore. Two batches each politely
  // limiting themselves to two would otherwise put four `claude` processes on
  // one subscription seat; a per-request limiter cannot prevent that.
  const first = makeAdapter(runner, { concurrency: 2 });
  const second = makeAdapter(runner, { concurrency: 2 });

  const results = await Promise.all([
    ...Array.from({ length: 3 }, () => first.complete(makeRequest())),
    ...Array.from({ length: 3 }, () => second.complete(makeRequest())),
  ]);

  assert.equal(results.length, 6);
  assert.ok(results.every((result) => result.text === '{"capital": "Paris"}'));
  assert.ok(peak <= 2, `at most 2 calls may be in flight at once, saw ${peak}`);
});

// -- regressions ----------------------------------------------------------- //
// Each of these pins a defect found by an adversarial review of this change.

test('overage is refused even when the CLI also reports the window rejected', async () => {
  // The overage check used to sit AFTER the status check, and the CLI reports
  // isUsingOverage alongside status "rejected" - so the status branch returned
  // first and the refusal was unreachable. A turn that produced an answer
  // while being billed as extra usage was accepted silently.
  const runner = makeFakeCliRunner({ lines: readCliFixture('overage-rejected') });
  await assert.rejects(
    () => makeAdapter(runner).complete(makeRequest()),
    (error) => error.kind === 'rateLimited' && /extra usage/.test(error.message)
  );

  const allowed = makeFakeCliRunner({ lines: readCliFixture('overage-rejected') });
  const result = await makeAdapter(allowed, { allowOverage: true }).complete(makeRequest());
  assert.equal(result.text, '{"capital": "Paris"}');
});

test('a limit recorded on an answered turn is not erased by that turn succeeding', async () => {
  // noteSuccess clears the model entry AND the seat-wide one, so calling it at
  // the end of a limited-but-answered turn deleted the hold the same call had
  // just recorded - and every following request rediscovered the limit.
  const runner = makeFakeCliRunner({ lines: readCliFixture('limited-but-answered') });
  const adapter = makeAdapter(runner);

  const result = await adapter.complete(makeRequest());
  assert.equal(result.text, '{"capital": "Paris"}', 'the answer is kept: the limit is about the NEXT call');
  assert.ok(adapter.outages().length > 0, 'the hold must survive the turn that recorded it');

  await assert.rejects(() => adapter.complete(makeRequest()), (error) => error.kind === 'rateLimited');
  assert.equal(runner.calls.length, 1, 'the next call is refused without reaching the runner');
});

test('a successful turn is not failed by a benign warning on stderr', async () => {
  // Classification used to run on every turn and read stderr unconditionally,
  // so a warning containing a word the classifier looks for threw away a
  // perfectly good answer.
  const runner = makeFakeCliRunner({
    lines: readCliFixture('noisy-stderr-success'),
    stderr: '(node:1) Warning: the connection pool timed out while warming up',
  });

  const result = await makeAdapter(runner).complete(makeRequest());
  assert.equal(result.text, '{"capital": "Paris"}');
});

test('the model reported is the one that answered, not the one that was asked for', async () => {
  // --fallback-model is passed on every call, so `system/init` names the
  // primary while a different model may actually answer. Reporting the primary
  // makes the usage figures quietly wrong.
  const runner = makeFakeCliRunner({ lines: readCliFixture('fallback-model') });
  const result = await makeAdapter(runner).complete(makeRequest({ modelName: 'opus' }));
  assert.equal(result.resolvedModel, 'claude-haiku-4-5-20251001');
});

test('a queued call waits for the caller deadline, not a short fixed cap', async () => {
  // The queue wait defaulted to 30s while a tailor call is allowed 300s, so a
  // batch wider than the concurrency limit failed its queued items even though
  // a slot would have freed long before the caller gave up.
  const { readClaudeCliConfig } = load('../dist/services/ai/providers/claudeCli/options');
  const config = readClaudeCliConfig();
  assert.ok(
    config.queueWaitMs >= config.defaultTimeoutMs,
    `the queue cap (${config.queueWaitMs}ms) must not bite before the call deadline (${config.defaultTimeoutMs}ms)`
  );
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The Codex CLI provider.
 *
 * No binary, no subprocess and no network anywhere: the adapter takes a
 * `CliRunner`, so every turn here is a recorded NDJSON stream replayed through
 * an injected fake, exactly as the Claude provider's tests work.
 *
 * ABOUT THE FIXTURES, because it matters which is which.
 * `recorded-network-failure.ndjson` is a REAL capture, taken from
 * `@openai/codex` 0.157.1 run against a proxy that refuses
 * wss://api.openai.com. `constructed-success.ndjson` is NOT a recording - this
 * machine has no ChatGPT credential, so a successful turn could not be
 * captured, and it is built from the envelope the real one shows. The file
 * names say so rather than a comment, because a fixture that LOOKS recorded is
 * how a test ends up agreeing with an assumption.
 *
 * That gap is affordable for one reason: the answer a caller receives does not
 * come from the stream at all. `codex exec --output-last-message FILE` writes
 * the final message, and the adapter reads it from there - so the constructed
 * fixture exercises metadata, and the thing that would actually break a user is
 * covered by reading a file.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'codex');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
}

/** A runner that replays lines and reports a clean exit unless told otherwise. */
function replay(lines, outcome = {}) {
  const seen = { spec: null };
  return {
    seen,
    runner: {
      run: async (spec) => {
        seen.spec = spec;
        for (const line of lines) spec.onLine(line);
        return {
          exitCode: 0,
          signal: null,
          stderrTail: '',
          timedOut: false,
          stalled: false,
          aborted: false,
          spawnError: null,
          bytesRead: 0,
          ...outcome,
        };
      },
    },
  };
}

function makeAdapter(t, { lines = [], answer = '', outcome = {}, config = {} } = {}) {
  useTempStorage(`codex-${Math.random().toString(36).slice(2)}`);
  const { createCodexCliAdapter } = loadFresh('../dist/services/ai/providers/codexCli/index');
  const { runner, seen } = replay(lines, outcome);
  const adapter = createCodexCliAdapter({
    runner,
    readAnswerFile: () => answer,
    config: { binary: 'codex', ...config },
  });
  return { adapter, seen };
}

function request(overrides = {}) {
  return {
    modelName: 'default',
    stableSystem: '',
    volatileSystem: '',
    userBody: 'write something',
    responseFormat: 'text',
    sampling: {},
    deadline: { remainingMs: () => 60_000 },
    callSite: 'probe',
    ...overrides,
  };
}

test('a turn answers from the output file, not from the event stream', async () => {
  const { adapter, seen } = makeAdapter(null, {
    lines: fixture('constructed-success.ndjson'),
    answer: 'the tailored resume\n',
  });

  const result = await adapter.complete(request());
  assert.equal(result.text, 'the tailored resume');
  assert.equal(result.providerId, 'codex-cli');
  // Read off the turn.completed event, so the metadata half is wired too.
  assert.equal(result.usage.inputTokens, 294);
  assert.equal(result.usage.outputTokens, 14);

  // The prompt goes on stdin and NEVER in argv: argv is re-parsed by shells and
  // re-quoted by Windows, and this text is admin-editable.
  assert.equal(seen.spec.stdin, 'write something');
  assert.equal(
    seen.spec.argv.some((arg) => arg.includes('write something')),
    false
  );
  assert.equal(seen.spec.argv[seen.spec.argv.length - 1], '-', 'stdin is named as the prompt');
});

/**
 * The single most valuable thing the real capture taught, and the one a
 * from-memory implementation gets wrong.
 *
 * Two tests, because they pin different halves. This one is end to end: a real
 * stream carrying five `{"type":"error"}` events still delivers an answer. The
 * one below is the discriminating half - it asks the reducer directly what it
 * made of those events, which is where a future change would actually break it.
 */
test('a stream full of reconnection notices still delivers its answer', async () => {
  const { adapter } = makeAdapter(null, {
    lines: fixture('recorded-network-failure.ndjson'),
    answer: 'it answered in the end',
  });

  const result = await adapter.complete(request());
  assert.equal(result.text, 'it answered in the end');
});

test('a reconnection notice is never mistaken for the reason a turn failed', () => {
  const events = loadFresh('../dist/services/ai/providers/codexCli/events');

  // Notices only. The honest reading is that it never got there - not that
  // "Reconnecting... 2/5" was the problem.
  const notices = events.createCodexTurnState();
  const reduceNotices = events.createCodexEventReducer(notices);
  for (const line of fixture('recorded-network-failure.ndjson')) reduceNotices(line);
  assert.equal(notices.fatal, null, 'an error event must not be recorded as the outcome');
  assert.match(events.describeCodexFailure(notices), /never reached the API/i);

  // A substantive error among the notices outranks them, whatever its position.
  const mixed = events.createCodexTurnState();
  const reduceMixed = events.createCodexEventReducer(mixed);
  reduceMixed('{"type":"error","message":"Reconnecting... 2/5 (stream disconnected)"}');
  reduceMixed('{"type":"error","message":"Your ChatGPT plan has no Codex quota left"}');
  reduceMixed('{"type":"error","message":"Reconnecting... 3/5 (stream disconnected)"}');
  assert.match(events.describeCodexFailure(mixed), /no Codex quota left/);

  // And an event that DOES end the turn wins over everything.
  const failed = events.createCodexTurnState();
  const reduceFailed = events.createCodexEventReducer(failed);
  reduceFailed('{"type":"error","message":"Reconnecting... 2/5"}');
  reduceFailed('{"type":"turn.failed","message":"the model refused"}');
  assert.equal(events.describeCodexFailure(failed), 'the model refused');
});

test('a turn that truly produced nothing fails, and says what the CLI said', async () => {
  const { adapter } = makeAdapter(null, {
    lines: fixture('recorded-network-failure.ndjson'),
    answer: '',
  });

  await assert.rejects(
    () => adapter.complete(request()),
    (error) => {
      // The reconnection notices are all there is here, so "it never reached
      // the API" is exactly the right reading - and the text is the CLI's own.
      assert.match(error.detail, /never reached the API|Proxy connection failed/i);
      return true;
    }
  );
});

test('being signed out is reported as an auth problem, with what to run', async () => {
  const { adapter } = makeAdapter(null, {
    lines: ['{"type":"turn.failed","message":"Not logged in. Run codex login."}'],
    answer: '',
  });

  await assert.rejects(
    () => adapter.complete(request()),
    (error) => {
      assert.equal(error.kind, 'auth', 'an operator fixes this rather than retrying it');
      assert.match(error.adminAction, /device-auth/);
      return true;
    }
  );
});

test('what a person is told about a missing or signed-out Codex CLI names Codex, not the Claude seat', async () => {
  // The shared sentences were written when the Claude seat was the only
  // provider. A Codex failure told the person to install the Claude CLI, or to
  // run `claude auth login` - on an install where that seat may be locked.
  const missing = makeAdapter(null, {
    outcome: { spawnError: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) },
  });
  const signedOut = makeAdapter(null, {
    lines: ['{"type":"turn.failed","message":"Not logged in. Run codex login."}'],
  });
  const { describeAiError } = require('../dist/middleware/aiErrors');

  for (const [adapter, kind, said] of [
    [missing.adapter, 'binaryMissing', /The Codex CLI is not installed/],
    [signedOut.adapter, 'auth', /Codex subscription is not signed in.*codex login --device-auth/],
  ]) {
    const error = await adapter.complete(request()).then(
      () => assert.fail('expected a failure'),
      (failure) => failure
    );
    const described = describeAiError(error);
    assert.equal(described.body.code, kind);
    assert.equal(described.body.provider, 'codex-cli');
    assert.match(described.body.error, said);
    assert.doesNotMatch(described.body.error, /Claude|claude auth/);
  }
});

test('the default model passes no -m at all, and a named one does', async () => {
  const { buildCodexArgv } = loadFresh('../dist/services/ai/providers/codexCli/argv');

  // `default` is the seeded sentinel: Codex resolves its catalog from the
  // signed-in account, so "whatever that account uses" is the only model name
  // true on every plan.
  const fallback = buildCodexArgv({ model: 'default', lastMessageFile: '/tmp/a', cwd: '/tmp' });
  assert.equal(fallback.includes('--model'), false);

  const named = buildCodexArgv({ model: 'gpt-5.1-codex', lastMessageFile: '/tmp/a', cwd: '/tmp' });
  assert.equal(named[named.indexOf('--model') + 1], 'gpt-5.1-codex');

  // Read off the real `codex exec --help`, not recalled.
  for (const flag of ['exec', '--json', '--output-last-message', '--sandbox', '--skip-git-repo-check']) {
    assert.ok(fallback.includes(flag), `${flag} must be passed`);
  }
});

/**
 * The line that decides whether this provider does what it exists for.
 *
 * An API key OUTRANKS the subscription in the CLI's own resolution order, so a
 * child that inherits one produces identical answers at identical latency and
 * bills every single one. This repository documents OPENAI_API_KEY and its
 * separate `openai` provider reads it, so on most installs it IS set.
 */
test('OPENAI_API_KEY never reaches the child unless it is allowed on purpose', () => {
  const { buildCodexChildEnv } = loadFresh('../dist/services/ai/providers/codexCli/env');

  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/app',
    CODEX_HOME: '/home/app/.codex',
    OPENAI_API_KEY: 'sk-live-should-not-be-here',
    OPENAI_BASE_URL: 'https://example.invalid/v1',
    CODEX_API_KEY: 'also-no',
    CODEX_ACCESS_TOKEN: 'also-no',
  };

  const child = buildCodexChildEnv(parent);
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(child.OPENAI_BASE_URL, undefined, 'a base URL is the other half of a redirection');
  assert.equal(child.CODEX_API_KEY, undefined);
  assert.equal(child.CODEX_ACCESS_TOKEN, undefined);

  // Kept, and this is the exact analogue of CLAUDE_CONFIG_DIR: it is where the
  // operator's `codex login` lives, so dropping it signs the child out.
  assert.equal(child.CODEX_HOME, '/home/app/.codex');
  assert.equal(child.PATH, '/usr/bin');

  // The escape hatch, off by default, for an operator who means it.
  const allowed = buildCodexChildEnv(parent, { allowApiKey: true });
  assert.equal(allowed.OPENAI_API_KEY, 'sk-live-should-not-be-here');
});

test('sampling hints the CLI has no flag for are reported, not silently dropped', async () => {
  const { adapter } = makeAdapter(null, {
    lines: fixture('constructed-success.ndjson'),
    answer: 'fine',
  });

  const result = await adapter.complete(
    request({ sampling: { temperature: 0.7, maxOutputTokens: 1500 } })
  );
  assert.deepEqual([...result.droppedParams].sort(), ['maxOutputTokens', 'temperature']);
});

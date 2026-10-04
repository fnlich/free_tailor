const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { makeFakeCliRunner, useTempStorage } = require('./helpers');

/**
 * The Gemini CLI provider, tested with no `gemini` binary, no network and no
 * subprocess: the adapter takes a `CliRunner`, and every turn here is a stream
 * replayed through an injected fake, exactly as the Claude and Codex suites do.
 * AI_GEMINI_BIN points at a path that does not exist, so a code path that
 * reached a real spawn would fail loudly rather than pass by accident on a
 * machine that has the CLI installed.
 *
 * ABOUT THE FIXTURES (test/fixtures/gemini), because it matters which is which:
 *
 *   constructed-*.ndjson  The REAL 0.62.0 binary's stream-json envelopes, but
 *                         over FAKE model responses (the CLI's hidden
 *                         --fake-responses hook): there was no Google sign-in
 *                         to record a real answer with. The event shapes, the
 *                         exit codes and the retries are the CLI's own; the
 *                         answer text is not a model's.
 *   recorded-*.stderr.txt Real stderr from real runs: signed out, no auth
 *                         method at all, and the workspace's enforced auth
 *                         type refusing an API key.
 *   verified-*            The workspace settings and deny-all policy that were
 *                         run against the real binary, pinned here so the
 *                         files the adapter writes cannot drift from them.
 *
 * Paths inside the captures were shortened to /opt/gemini-capture; nothing
 * below reads them. What was NOT captured - the text of a real 429 or 404 from
 * Google's backend - is written inline in the tests that need it, from the
 * CLI's source, and those lines say so.
 */
process.env.AI_GEMINI_BIN = '/nonexistent/gemini';

const argv = require('../dist/services/ai/providers/geminiCli/argv');
const env = require('../dist/services/ai/providers/geminiCli/env');
const events = require('../dist/services/ai/providers/geminiCli/events');
const classify = require('../dist/services/ai/providers/geminiCli/classify');
const options = require('../dist/services/ai/providers/geminiCli/options');
const workspace = require('../dist/services/ai/providers/geminiCli/workspace');
const { checkGeminiCliHealth } = require('../dist/services/ai/providers/geminiCli/health');
const { createGeminiCliAdapter } = require('../dist/services/ai/providers/geminiCli/index');
const { createDeadline } = require('../dist/services/ai/types');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');

const FIXTURES = path.join(__dirname, 'fixtures', 'gemini');

function fixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function lines(name) {
  return fixtureText(name).split('\n').filter(Boolean);
}

/** What the real runner hands over: the last non-empty line of stderr. */
function stderrTail(name) {
  const all = fixtureText(name).split('\n').map((line) => line.trim()).filter(Boolean);
  return all[all.length - 1];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeRequest(overrides = {}) {
  return {
    modelName: 'auto',
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

function makeAdapter(runner, config = {}, extra = {}) {
  const { rootDir } = useTempStorage(`gemini-${Math.random().toString(36).slice(2)}`);
  const dirs = {
    workdir: path.join(rootDir, 'work'),
    stateDir: path.join(rootDir, 'state'),
    home: path.join(rootDir, 'home'),
  };
  const adapter = createGeminiCliAdapter({
    runner,
    config: {
      binary: '/nonexistent/gemini',
      model: 'auto',
      concurrency: 2,
      firstEventMs: 1_000,
      queueWaitMs: 1_000,
      ...dirs,
      ...config,
    },
    healthCheck: async () => ({
      ok: true,
      loggedIn: true,
      binary: '/nonexistent/gemini',
      version: 'test',
      checkedAt: new Date().toISOString(),
      detail: 'stub',
    }),
    ...extra,
  });
  return { adapter, rootDir, ...dirs, ...config };
}

/** A result event carrying an API error, as the CLI's error handler writes one. */
function apiErrorResult(message) {
  return JSON.stringify({
    type: 'result',
    timestamp: '2026-10-04T12:00:00.000Z',
    status: 'error',
    error: { type: 'unknown', message },
    stats: { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached: 0, input: 0, duration_ms: 0, tool_calls: 0, models: {} },
  });
}

/** The init and the prompt echo every real stream opens with. */
const OPENING = lines('constructed-api-error.ndjson').slice(0, 2);

async function failureOf(promise) {
  return promise.then(
    () => assert.fail('expected the turn to fail'),
    (error) => error
  );
}

// -- argv ------------------------------------------------------------------ //

test('argv asks for stream-json, an explicit model, the deny-all policy and a session id - nothing else', () => {
  const flags = argv.buildGeminiArgv({
    model: 'flash',
    policyDir: '/state/policy',
    sessionId: 'b9b4e623-5fc0-49bc-8f1e-950adada3732',
  });

  assert.deepEqual(flags, [
    '--output-format',
    'stream-json',
    '--model',
    'flash',
    '--policy',
    '/state/policy',
    '--skip-trust',
    '--session-id',
    'b9b4e623-5fc0-49bc-8f1e-950adada3732',
    // No settings file can turn MCP servers or extensions off (0.62.0 ignores
    // `admin.*` in every file, and an empty allowlist means no limit), so the
    // flags do: an allowlist naming no real server, and no extensions.
    '--allowed-mcp-server-names',
    '__tailor_none__',
    '--extensions',
    'none',
  ]);
  assert.equal(argv.GEMINI_NO_MCP_SERVER, '__tailor_none__');

  for (const flag of argv.FORBIDDEN_FLAGS) {
    assert.equal(flags.includes(flag), false, `${flag} must never be passed`);
  }
  // The list itself, so trimming FORBIDDEN_FLAGS cannot quietly drop one: each
  // of these approves tools, sandboxes, moves the prompt into argv, disables
  // output sanitising, resumes another conversation or opens a debugger.
  for (const flag of [
    '--yolo', '-y', '--approval-mode', '--sandbox', '-s', '-p', '--prompt', '-i',
    '--raw-output', '--accept-raw-output-risk', '--resume', '--acp', '--debug',
    '--include-directories', '--allowed-tools',
  ]) {
    assert.ok(argv.FORBIDDEN_FLAGS.includes(flag), `${flag} belongs in FORBIDDEN_FLAGS`);
  }

  // The CLI's own alphabet for a session id; anything else is a usage error
  // that would surface as a failed generation.
  assert.throws(() => argv.buildGeminiArgv({ model: 'auto', policyDir: '/p', sessionId: 'not a uuid' }));
});

test('a model name from another provider degrades to the default instead of reaching the CLI', () => {
  // The CLI forwards any --model string, and the backend answers each with a 404.
  for (const stale of ['openai/gpt-5.4-nano', 'sonnet', 'default', 'gpt-6-sol', 'auto-gemini-3', '--yolo']) {
    assert.equal(argv.resolveGeminiModel(stale, 'auto'), 'auto', stale);
  }
  assert.equal(argv.resolveGeminiModel(undefined, 'auto'), 'auto');
  assert.equal(argv.resolveGeminiModel('   ', 'flash'), 'flash');

  for (const name of [
    'auto', 'pro', 'flash', 'flash-lite', 'gemini-2.5-pro', 'gemini-3.5-flash',
    'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemma-4-31b-it',
  ]) {
    assert.equal(argv.resolveGeminiModel(name, 'auto'), name);
  }
});

// -- the prompt on stdin ---------------------------------------------------- //

test('a prompt that starts with / is not run as a slash command', () => {
  assert.equal(argv.guardGeminiPrompt('/help me write this'), '\n/help me write this');
  assert.equal(argv.guardGeminiPrompt('Write about /usr paths'), 'Write about /usr paths');
});

test('every @ reference is escaped, an email included, so none can attach a file', () => {
  // The CLI attaches the file an @name names, resolved against the workspace
  // AND every context.includeDirectories in the operator's own settings, which
  // the workspace settings cannot clear - so a bare `@config.json` can reach an
  // operator file, and a path can reach other turns' transcripts. A job
  // description is user-supplied text.
  const cases = [
    ['see @../../home/app/.gemini/tmp/work/chats now', 'see \\@../../home/app/.gemini/tmp/work/chats now'],
    ['@/etc/passwd', '\\@/etc/passwd'],
    ['@~/.gemini/GEMINI.md', '\\@~/.gemini/GEMINI.md'],
    ['@C:secrets', '\\@C:secrets'],
    ['@"/root/notes"', '\\@"/root/notes"'],
    ['@..\\..\\Users', '\\@..\\..\\Users'],
    // Bare names resolve inside an operator's includeDirectories.
    ['we use @config.json and @.env', 'we use \\@config.json and \\@.env'],
    ['Email jane.doe@example.com or ping @jane.', 'Email jane.doe\\@example.com or ping \\@jane.'],
    // Escaping the first @ exposes the second as a token of its own.
    ['@a@/etc/passwd', '\\@a\\@/etc/passwd'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(argv.escapeAtReferences(input), expected, input);
  }

  // Not a reference to the CLI, so left exactly as written.
  for (const untouched of ['Meet @ 3pm', 'already escaped \\@/etc/passwd', 'no at sign at all']) {
    assert.equal(argv.escapeAtReferences(untouched), untouched, untouched);
  }
});

test('the backslash the escape adds is taken back out of the answer, and a real one is kept', () => {
  // `\@` is not a JSON escape, so an answer that copied it would not parse.
  assert.equal(argv.restoreEscapedAt('{"email": "jane\\@example.com"}'), '{"email": "jane@example.com"}');
  assert.equal(JSON.parse(argv.restoreEscapedAt('{"email": "jane\\@example.com"}')).email, 'jane@example.com');
  // A JSON `\\@` is a literal backslash before an @, and stays one.
  assert.equal(argv.restoreEscapedAt('{"path": "C:\\\\@x"}'), '{"path": "C:\\\\@x"}');
  assert.equal(argv.restoreEscapedAt('plain @ text'), 'plain @ text');
});

test('an answer that echoes an escaped email is returned as the user wrote it', async () => {
  const echo = [
    ...OPENING,
    JSON.stringify({ type: 'message', role: 'assistant', content: '{"email": "jane\\@example.com"}', delta: true }),
    lines('constructed-success.ndjson').at(-1),
  ];
  const runner = makeFakeCliRunner({ lines: echo });
  const { adapter } = makeAdapter(runner);

  const result = await adapter.complete(makeRequest({ userBody: 'Contact: jane@example.com' }));
  assert.equal(runner.calls[0].stdin, 'Contact: jane\\@example.com');
  assert.equal(result.text, '{"email": "jane@example.com"}');
});

// -- child environment ------------------------------------------------------ //

test('the child environment pins every key, Vertex and gateway variable empty, and cannot be talked out of it', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/app',
    HTTPS_PROXY: 'http://proxy:3128',
    GEMINI_API_KEY: 'AIza-should-not-reach-the-child',
    GOOGLE_API_KEY: 'AIza-nor-this',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
    GOOGLE_GENAI_USE_GCA: 'true',
    GOOGLE_GEMINI_BASE_URL: 'https://gateway.example',
    GOOGLE_VERTEX_BASE_URL: 'https://vertex.example',
    GOOGLE_APPLICATION_CREDENTIALS: '/keys/service-account.json',
    GOOGLE_CLOUD_ACCESS_TOKEN: 'ya29.token',
    GEMINI_CLI_USE_COMPUTE_ADC: 'true',
    CLOUD_SHELL: 'true',
    GEMINI_CLI_CUSTOM_HEADERS: 'X-Leak: 1',
    GEMINI_API_KEY_AUTH_MECHANISM: 'bearer',
    GEMINI_MODEL: 'gemini-2.5-pro',
    GEMINI_WRITE_SYSTEM_MD: 'true',
    CODE_ASSIST_API_VERSION: 'v9',
    CODE_ASSIST_ENDPOINT: 'https://collects-bearer-tokens.example',
    GEMINI_CLI_IDE_AUTH_TOKEN: 'ide-token',
    GEMINI_CLI_IDE_SERVER_PORT: '4000',
    SANDBOX: 'docker',
    SANDBOX_FLAGS: '--privileged',
    SEATBELT_PROFILE: 'permissive',
    DEBUG: '1',
    DEBUG_MODE: '1',
    GEMINI_DEBUG_LOG_FILE: '/tmp/gemini.log',
    GEMINI_CLI_ACTIVITY_LOG_TARGET: '/tmp/activity',
    GEMINI_CLI_INTEGRATION_TEST: 'true',
    GEMINI_PROMPT_CORE: '0',
    FORCE_COLOR: '3',
    GEMINI_CLI_HOME: '/srv/gemini-home',
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
    GOOGLE_CLOUD_PROJECT: 'workspace-project',
    GOOGLE_CLOUD_PROJECT_ID: 'workspace-project',
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/etc/gemini-cli/settings.json',
    GEMINI_CLI_TRUSTED_FOLDERS_PATH: '/etc/gemini-cli/trusted.json',
  };
  const before = { ...parent };

  const child = env.buildGeminiChildEnv(parent, {
    systemPromptFile: '/state/turns/t1/system.md',
    tmpDir: '/state/turns/t1/tmp',
  });

  // Present AND empty: the CLI's .env loader only fills in what is unset, and
  // its auth code reads "" as unset.
  for (const name of env.GEMINI_PINNED_EMPTY) {
    assert.ok(Object.prototype.hasOwnProperty.call(child, name), `${name} must be present`);
    assert.equal(child[name], '', `${name} must be pinned empty`);
  }
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.ok(env.GEMINI_PINNED_EMPTY.includes(name), `${name} belongs in the pinned list`);
  }
  // Read with ??, so "" would BE the endpoint; and it receives the bearer token.
  assert.equal(child.CODE_ASSIST_ENDPOINT, 'https://cloudcode-pa.googleapis.com');

  for (const name of [
    'GEMINI_CLI_IDE_AUTH_TOKEN', 'GEMINI_CLI_IDE_SERVER_PORT', 'SANDBOX', 'SANDBOX_FLAGS', 'SEATBELT_PROFILE',
    'DEBUG', 'DEBUG_MODE', 'GEMINI_DEBUG_LOG_FILE', 'GEMINI_CLI_ACTIVITY_LOG_TARGET',
    'GEMINI_CLI_INTEGRATION_TEST', 'GEMINI_PROMPT_CORE', 'FORCE_COLOR',
  ]) {
    assert.equal(name in child, false, `${name} must be dropped`);
  }

  // Without NO_BROWSER a headless run asks [Y/n] on stdout and opens a browser;
  // without NO_RELAUNCH the outer process ignores the deadline's SIGTERM.
  assert.equal(child.NO_BROWSER, 'true');
  assert.equal(child.GEMINI_CLI_NO_RELAUNCH, 'true');
  assert.equal(child.NO_COLOR, '1');
  assert.equal(child.GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.equal(child.GEMINI_SANDBOX, 'false');
  assert.equal(child.GEMINI_SYSTEM_MD, '/state/turns/t1/system.md');
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(child[name], '/state/turns/t1/tmp');

  // Where the sign-in lives, and the machine's own configuration.
  assert.equal(child.GEMINI_CLI_HOME, '/srv/gemini-home');
  assert.equal(child.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE, 'true');
  assert.equal(child.GOOGLE_CLOUD_PROJECT, 'workspace-project');
  assert.equal(child.GOOGLE_CLOUD_PROJECT_ID, 'workspace-project');
  assert.equal(child.GOOGLE_CLOUD_LOCATION, 'us-central1');
  assert.equal(child.GEMINI_CLI_SYSTEM_SETTINGS_PATH, '/etc/gemini-cli/settings.json');
  assert.equal(child.GEMINI_CLI_TRUSTED_FOLDERS_PATH, '/etc/gemini-cli/trusted.json');
  assert.equal(child.PATH, '/usr/bin');
  assert.equal(child.HOME, '/home/app');
  assert.equal(child.HTTPS_PROXY, 'http://proxy:3128');

  // There is no escape hatch: an option asking for the key changes nothing.
  assert.equal(env.buildGeminiChildEnv(parent, { allowApiKey: true }).GEMINI_API_KEY, '');
  // AI_GEMINI_HOME, resolved, becomes the child's GEMINI_CLI_HOME.
  assert.equal(env.buildGeminiChildEnv(parent, { home: '/srv/tailor-gemini' }).GEMINI_CLI_HOME, '/srv/tailor-gemini');
  // And the server's own environment is not touched.
  assert.deepEqual(parent, before);
});

test('the home the transcript and the sign-in live in is the one the child computes', () => {
  assert.equal(env.resolveGeminiHome({ GEMINI_CLI_HOME: '/srv/g', HOME: '/home/app' }, 'linux'), '/srv/g');
  assert.equal(env.resolveGeminiHome({ HOME: '/home/app' }, 'linux'), '/home/app');
  assert.equal(env.resolveGeminiHome({ USERPROFILE: 'C:\\Users\\app', HOME: '/ignored' }, 'win32'), 'C:\\Users\\app');
  assert.equal(env.resolveGeminiHome({}, 'linux', () => '/fallback'), '/fallback');
});

// -- workspace -------------------------------------------------------------- //

test('the workspace holds an empty .env and the verified settings, and nothing else', () => {
  const { rootDir } = useTempStorage('gemini-workspace');
  const workdir = path.join(rootDir, 'work');
  const stateDir = path.join(rootDir, 'state');
  // A key someone left where the CLI would load it.
  fs.mkdirSync(path.join(workdir, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(workdir, '.gemini', '.env'), 'GEMINI_API_KEY=AIza-left-behind\n');

  const prepared = workspace.prepareGeminiWorkspace({ workdir, stateDir, maxAttempts: 3 });

  // EMPTY: it stops the CLI's walk up to the repository's or the operator's .env.
  assert.equal(fs.readFileSync(path.join(workdir, '.gemini', '.env'), 'utf8'), '');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(workdir, '.gemini', 'settings.json'), 'utf8')),
    JSON.parse(fixtureText('verified-workspace-settings.json'))
  );
  assert.equal(
    fs.readFileSync(path.join(prepared.policyDir, 'deny-all.toml'), 'utf8').trim(),
    fixtureText('verified-deny-all.toml').trim()
  );
  assert.deepEqual(fs.readdirSync(workdir), ['.gemini']);
  assert.deepEqual(fs.readdirSync(path.join(workdir, '.gemini')).sort(), ['.env', 'settings.json']);
  // The policy and the turns live outside the workspace.
  assert.ok(path.relative(workdir, prepared.policyDir).startsWith('..'));
  assert.ok(path.relative(workdir, prepared.turnsDir).startsWith('..'));

  // AI_GEMINI_MAX_ATTEMPTS is what bounds the CLI's own retry loop.
  workspace.prepareGeminiWorkspace({ workdir, stateDir, maxAttempts: 7 });
  const settings = JSON.parse(fs.readFileSync(path.join(workdir, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(settings.general.maxAttempts, 7);
  assert.equal(settings.security.auth.enforcedType, 'oauth-personal');
  assert.equal(settings.billing.overageStrategy, 'never');
  assert.deepEqual(settings.tools.core, []);
});

test('a state directory inside the workspace is refused, at prep and by the adapter', async () => {
  const { rootDir } = useTempStorage('gemini-nested-state');
  const workdir = path.join(rootDir, 'work');
  assert.throws(
    () => workspace.prepareGeminiWorkspace({ workdir, stateDir: path.join(workdir, 'state'), maxAttempts: 3 }),
    /AI_GEMINI_STATE_DIR .* is inside AI_GEMINI_WORKDIR/
  );

  const runner = makeFakeCliRunner({ lines: lines('constructed-success.ndjson') });
  const { adapter } = makeAdapter(runner, { workdir, stateDir: path.join(workdir, 'state') });
  const error = await failureOf(adapter.complete(makeRequest()));
  assert.equal(error.kind, 'misconfigured');
  assert.match(error.adminAction, /separate directories/);
  assert.equal(runner.calls.length, 0, 'nothing is spawned into a workspace that would expose the turn files');
});

test('turn directories a dead process left behind are swept, and live ones are not', () => {
  const { rootDir } = useTempStorage('gemini-sweep');
  const stateDir = path.join(rootDir, 'state');
  const turns = path.join(stateDir, 'turns');
  fs.mkdirSync(path.join(turns, 'old', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(turns, 'old', 'tmp', 'gemini-client-error.json'), '{"the":"whole conversation"}');
  fs.mkdirSync(path.join(turns, 'fresh'), { recursive: true });
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(path.join(turns, 'old'), threeHoursAgo, threeHoursAgo);

  workspace.prepareGeminiWorkspace({ workdir: path.join(rootDir, 'work'), stateDir, maxAttempts: 3 });
  assert.deepEqual(fs.readdirSync(turns), ['fresh']);
});

// -- events ----------------------------------------------------------------- //

test('the answer is the assistant deltas, only on success, and never the echoed prompt', () => {
  const state = events.createGeminiTurnState();
  const reduce = events.createGeminiEventReducer(state);
  for (const line of lines('constructed-success.ndjson')) reduce(line);
  // Noise a future release might add.
  reduce('not json at all');
  reduce('[1,2,3]');
  reduce('{"type":"brand_new_event","content":"ignored"}');

  assert.equal(events.readGeminiTurnText(state), '{"capital": "Paris"}');
  assert.equal(state.sessionId, 'b9b4e623-5fc0-49bc-8f1e-950adada3732');
  assert.equal(state.requestedModel, 'gemini-2.5-flash');
  assert.equal(state.resolvedModel, 'gemini-2.5-flash');
  assert.deepEqual(state.usage, { inputTokens: 294, outputTokens: 14, cacheReadTokens: 0 });

  // The same deltas under a failed result are not an answer.
  const failed = events.createGeminiTurnState();
  const reduceFailed = events.createGeminiEventReducer(failed);
  for (const line of lines('constructed-success.ndjson').slice(0, 4)) reduceFailed(line);
  reduceFailed(apiErrorResult('[API Error: stream broke]'));
  assert.equal(events.readGeminiTurnText(failed), '');
  assert.equal(events.describeGeminiFailure(failed), '[API Error: stream broke]');

  // And with no result at all, neither.
  const cut = events.createGeminiTurnState();
  const reduceCut = events.createGeminiEventReducer(cut);
  for (const line of lines('constructed-success.ndjson').slice(0, 4)) reduceCut(line);
  assert.equal(events.readGeminiTurnText(cut), '');
});

test('with auto, the model reported is the one that answered, not the classifier', () => {
  const state = events.createGeminiTurnState();
  events.createGeminiEventReducer(state)(
    JSON.stringify({
      type: 'result',
      status: 'success',
      stats: {
        input_tokens: 500,
        output_tokens: 120,
        cached: 40,
        models: {
          'gemini-3.1-flash-lite': { output_tokens: 5 },
          'gemini-2.5-pro': { output_tokens: 115 },
        },
      },
    })
  );
  assert.equal(state.resolvedModel, 'gemini-2.5-pro');
  assert.deepEqual(state.usage, { inputTokens: 500, outputTokens: 120, cacheReadTokens: 40 });
});

test('a failure is described in the CLI\'s own words, error events before warnings', () => {
  const state = events.createGeminiTurnState();
  const reduce = events.createGeminiEventReducer(state);
  for (const line of lines('constructed-safety-blocked.ndjson')) reduce(line);
  assert.equal(events.describeGeminiFailure(state), 'The model response was blocked due to safety settings.');

  const warned = events.createGeminiTurnState();
  const reduceWarned = events.createGeminiEventReducer(warned);
  reduceWarned('{"type":"error","severity":"error","message":"the real problem"}');
  reduceWarned('{"type":"error","severity":"warning","message":"Loop detected, stopping execution"}');
  assert.equal(events.describeGeminiFailure(warned), 'the real problem');
});

// -- whole turns ------------------------------------------------------------ //

test('a healthy turn answers from the deltas, with its system prompt in a file outside the workspace', async () => {
  let during = null;
  const runner = makeFakeCliRunner((spec) => {
    during = {
      systemPromptFile: spec.env.GEMINI_SYSTEM_MD,
      systemPrompt: fs.readFileSync(spec.env.GEMINI_SYSTEM_MD, 'utf8'),
      tmpDirExists: fs.existsSync(spec.env.TMPDIR),
      envWritten: fs.readFileSync(path.join(spec.cwd, '.gemini', '.env'), 'utf8'),
    };
    return { lines: lines('constructed-success.ndjson') };
  });
  const { adapter, workdir, stateDir } = makeAdapter(runner);

  const result = await adapter.complete(makeRequest());

  assert.equal(result.text, '{"capital": "Paris"}');
  assert.equal(result.providerId, 'gemini-cli');
  assert.equal(result.resolvedModel, 'gemini-2.5-flash');
  assert.deepEqual(result.usage, { inputTokens: 294, outputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0 });

  // The instructions travel as the system prompt, volatile part first.
  assert.equal(during.systemPrompt, 'Return valid JSON only.\n\nYou are a resume assistant.');
  assert.ok(during.tmpDirExists, 'the turn has a temp dir of its own for the CLI\'s error dumps');
  assert.equal(during.envWritten, '');
  assert.ok(path.relative(workdir, during.systemPromptFile).startsWith('..'), 'never inside the workspace');

  // And both are gone once the turn is.
  assert.equal(fs.existsSync(path.dirname(during.systemPromptFile)), false);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'turns')), []);

  // The prompt goes on stdin, and argv carries flags only.
  const call = runner.calls[0];
  assert.equal(call.stdin, 'What is the capital of France?');
  assert.equal(call.argv.some((arg) => arg.includes('capital')), false);
  assert.equal(call.cwd, workdir);
  assert.equal(call.binary, '/nonexistent/gemini');
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'auto');
  assert.match(call.argv[call.argv.indexOf('--session-id') + 1], UUID);
  for (const flag of argv.FORBIDDEN_FLAGS) {
    assert.equal(call.argv.includes(flag), false, `${flag} reached a real turn`);
  }
  assert.equal(call.env.GEMINI_API_KEY, '');
  assert.equal(call.env.NO_BROWSER, 'true');
  assert.equal(call.env.GEMINI_CLI_NO_RELAUNCH, 'true');
});

test('a prompt with no instructions still gets a system prompt, and a stale model name runs as the default', async () => {
  let systemPrompt = null;
  const runner = makeFakeCliRunner((spec) => {
    systemPrompt = fs.readFileSync(spec.env.GEMINI_SYSTEM_MD, 'utf8');
    return { lines: lines('constructed-success.ndjson') };
  });
  const { adapter } = makeAdapter(runner, { model: 'flash' });

  await adapter.complete(makeRequest({ stableSystem: '', volatileSystem: '  ', modelName: 'claude-sonnet-4-6' }));

  assert.equal(systemPrompt, argv.GEMINI_BASE_SYSTEM_PROMPT);
  const call = runner.calls[0];
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'flash');
});

test('the stdin guards apply to a real turn', async () => {
  const runner = makeFakeCliRunner({ lines: lines('constructed-success.ndjson') });
  const { adapter } = makeAdapter(runner);
  await adapter.complete(makeRequest({ userBody: '/clear and then @../../etc/passwd' }));
  assert.equal(runner.calls[0].stdin, '\n/clear and then \\@../../etc/passwd');
});

test('a prompt over the 8 MiB the CLI reads is refused, not truncated', async () => {
  const runner = makeFakeCliRunner({ lines: lines('constructed-success.ndjson') });
  const { adapter } = makeAdapter(runner);
  const error = await failureOf(adapter.complete(makeRequest({ userBody: 'x'.repeat(argv.MAX_GEMINI_STDIN_BYTES + 1) })));
  assert.equal(error.kind, 'failed');
  assert.match(error.detail, /reads from stdin/);
  assert.equal(runner.calls.length, 0);
});

test('exit 0 is not success: a safety block and an empty response fail with the CLI\'s reason', async () => {
  // Both captured: retried inside the CLI for ~7s, then an error event, a result
  // with status "error" and NO error field - and exit code 0.
  for (const [name, said] of [
    ['constructed-safety-blocked.ndjson', /blocked due to safety settings/],
    ['constructed-empty-response.ndjson', /empty response with no text or thoughts/],
  ]) {
    const runner = makeFakeCliRunner({ lines: lines(name), exitCode: 0 });
    const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
    assert.equal(error.kind, 'failed', name);
    assert.match(error.detail, said, name);
  }
});

test('exit 0 with no result - the run was stopped - is a failure, and the partial text is not returned', async () => {
  const partial = lines('constructed-success.ndjson').slice(0, 3);
  const runner = makeFakeCliRunner({ lines: partial, exitCode: 0 });
  const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
  assert.equal(error.kind, 'failed');
  assert.match(error.detail, /exited 0 without a result/);
});

test('an API error fails the turn with the CLI\'s message', async () => {
  const runner = makeFakeCliRunner({ lines: lines('constructed-api-error.ndjson'), exitCode: 1 });
  const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
  assert.equal(error.kind, 'failed');
  assert.match(error.detail, /^\[API Error:/);
});

test('a response cut off by the output limit is NOT detectable by the envelope, and is returned as the CLI reports it', async () => {
  // Captured: MAX_TOKENS comes back as status "success" with the fragment, and
  // nothing in the envelope says so. Pinned so that the day the CLI starts
  // reporting it, this test fails and the adapter learns to refuse it. With no
  // sentinel in it there is nothing else to go on; a JSON answer that opened
  // its sentinels is caught by them (below).
  const runner = makeFakeCliRunner({ lines: lines('constructed-max-tokens-truncated.ndjson') });
  const result = await makeAdapter(runner).adapter.complete(makeRequest());
  assert.equal(result.text, '{"capital": "Par');
});

/**
 * A successful turn whose answer is `chunks`, as assistant deltas: the real
 * envelope from constructed-success.ndjson around the given text.
 */
function answeredWith(...chunks) {
  const [init, echo, , , result] = lines('constructed-success.ndjson');
  const deltas = chunks.map((content, index) =>
    JSON.stringify({
      type: 'message',
      timestamp: `2026-10-04T12:54:16.3${30 + index}Z`,
      role: 'assistant',
      content,
      delta: true,
    })
  );
  return { lines: [init, echo, ...deltas, result] };
}

test('a JSON answer that opens the sentinel and never closes it is refused as truncated, and the seat is not held', async () => {
  // What a structured answer cut off at the output limit looks like through
  // this CLI: status "success", and the document stops mid-object. Returned,
  // the extractor's balanced scan took the first complete INNER object -
  // {"company": "Acme"} - as the whole answer.
  const runner = makeFakeCliRunner(
    answeredWith('@@BEGIN_JSON@@\n{"summary": "x", "experience": [{"company": "Acme"}, ', '{"comp')
  );
  const { adapter } = makeAdapter(runner);
  const error = await failureOf(adapter.complete(makeRequest({ responseFormat: 'json' })));
  assert.equal(error.kind, 'truncated');
  assert.equal(error.retryable, true, 'built again, as a cut-off Claude answer is');
  assert.equal(error.publicFailure, 'retry');
  assert.match(error.detail, /never closed it/);
  assert.deepEqual(adapter.outages(), [], 'a long answer is not a reason to hold the seat');
});

test('a complete sentinel answer passes, and so does one that quotes the opening marker first', async () => {
  const whole = makeFakeCliRunner(answeredWith('@@BEGIN_JSON@@\n{"capital": "Paris"}\n', '@@END_JSON@@'));
  const result = await makeAdapter(whole).adapter.complete(makeRequest({ responseFormat: 'json' }));
  assert.equal(result.text, '@@BEGIN_JSON@@\n{"capital": "Paris"}\n@@END_JSON@@');

  // Judged by the LAST opening marker, as the extractor reads it.
  const quoted = makeFakeCliRunner(
    answeredWith('I will wrap it in @@BEGIN_JSON@@ as asked.\n@@BEGIN_JSON@@\n{"capital": "Paris"}\n@@END_JSON@@')
  );
  await makeAdapter(quoted).adapter.complete(makeRequest({ responseFormat: 'json' }));

  // And the reverse: an end marker from the quoted instruction does not
  // vouch for a real answer opened after it.
  const reopened = makeFakeCliRunner(
    answeredWith('Between @@BEGIN_JSON@@ and @@END_JSON@@, then:\n@@BEGIN_JSON@@\n{"capital": "Pa')
  );
  const error = await failureOf(makeAdapter(reopened).adapter.complete(makeRequest({ responseFormat: 'json' })));
  assert.equal(error.kind, 'truncated');
});

test('a text request is not judged by sentinels', async () => {
  const runner = makeFakeCliRunner(answeredWith('Use @@BEGIN_JSON@@ to open the block, and then'));
  const result = await makeAdapter(runner).adapter.complete(makeRequest({ responseFormat: 'text' }));
  assert.equal(result.text, 'Use @@BEGIN_JSON@@ to open the block, and then');
});

test('the truncation the CLI DOES report is classified as truncated', async () => {
  // MAX_TOKENS_EXCEEDED arrives as an error event when no text was produced at
  // all; the wording is the CLI's constant.
  const runner = makeFakeCliRunner({
    lines: [
      ...OPENING,
      '{"type":"error","severity":"error","message":"Model response was truncated because it exceeded the token limit. Try using /compress to free up context space."}',
      '{"type":"result","status":"error","stats":{"input_tokens":10,"output_tokens":0,"models":{}}}',
    ],
  });
  const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
  assert.equal(error.kind, 'truncated');
});

test('a signed-out seat is an auth failure with the sign-in steps, and the seat is held', async () => {
  // Recorded: exit 41, nothing on stdout, the diagnosis as the last stderr
  // line - in colour, because NO_COLOR was not set for that capture.
  const runner = makeFakeCliRunner({ lines: [], exitCode: 41, stderr: stderrTail('recorded-signed-out.stderr.txt') });
  const { adapter } = makeAdapter(runner);

  const error = await failureOf(adapter.complete(makeRequest()));
  assert.equal(error.kind, 'auth');
  assert.match(error.adminAction, /NO_BROWSER=true gemini/);
  assert.match(error.detail, /^Manual authorization is required/);
  assert.doesNotMatch(error.detail, /\u001b/, 'colour codes are stripped');

  // Held: the next call is turned away without spawning anything.
  const again = await failureOf(adapter.complete(makeRequest()));
  assert.equal(again.kind, 'auth');
  assert.ok(again.retryAfterSeconds > 0);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(adapter.outages().map((hold) => hold.scope), ['*']);
});

/** A Google sign-in on disk, as the health check reads it. */
function writeSignIn(home) {
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gemini', 'oauth_creds.json'),
    JSON.stringify({ access_token: 'ya29.x', refresh_token: '1//refresh', expiry_date: 4102444800000 })
  );
}

test('exit 41 with a sign-in on disk is held briefly, and only a repeat makes it a sign-in problem', async () => {
  // The CLI checks its token with Google on every start, and a refused
  // connection there ends in exactly the signed-out exit and words. One blip
  // must not take the seat out for half an hour as "sign in again".
  let clock = Date.parse('2026-10-04T12:00:00Z');
  let calls = 0;
  const runner = makeFakeCliRunner(() => {
    calls += 1;
    return calls === 2
      ? { lines: lines('constructed-success.ndjson') }
      : { lines: [], exitCode: 41, stderr: stderrTail('recorded-signed-out.stderr.txt') };
  });
  const { adapter, home } = makeAdapter(runner, {}, { now: () => clock });
  writeSignIn(home);

  const first = await failureOf(adapter.complete(makeRequest()));
  assert.equal(first.kind, 'unavailable');
  assert.match(first.detail, /could not validate its Google sign-in/);
  assert.match(first.adminAction, /oauth2\.googleapis\.com/);
  // Held seat-wide, but for minutes, and turned away as what it is.
  const held = await failureOf(adapter.complete(makeRequest()));
  assert.equal(held.kind, 'unavailable');
  assert.ok(held.retryAfterSeconds > 0 && held.retryAfterSeconds <= 120, `${held.retryAfterSeconds}s`);
  assert.equal(runner.calls.length, 1);

  // A success clears the hold and the count.
  clock += 3 * 60_000;
  assert.equal((await adapter.complete(makeRequest())).text, '{"capital": "Paris"}');

  // Three in a row with nothing working between: a revoked token, most likely,
  // so it ends at the sign-in action and the long hold after all.
  const kinds = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    clock += 3 * 60_000;
    const error = await failureOf(adapter.complete(makeRequest()));
    kinds.push(error.kind);
    if (attempt === 2) assert.match(error.adminAction, /NO_BROWSER=true gemini/);
  }
  assert.deepEqual(kinds, ['unavailable', 'unavailable', 'auth']);
  const after = await failureOf(adapter.complete(makeRequest()));
  assert.equal(after.kind, 'auth');
  assert.ok(after.retryAfterSeconds > 20 * 60, `${after.retryAfterSeconds}s`);
});

/**
 * A seat whose health check reads the sign-in in its own home, as the real one
 * does, and names the file it read.
 */
function makeSignInSeat(runner, clock) {
  let home = null;
  const made = makeAdapter(runner, {}, {
    now: () => clock.now,
    healthCheck: async () => ({
      ok: true,
      loggedIn: fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json')),
      binary: '/nonexistent/gemini',
      version: 'test',
      authMethod: 'oauth-personal',
      checkedAt: new Date().toISOString(),
      detail: 'Signed in with Google.',
      meta: { home, credentialsFile: path.join(home, '.gemini', 'oauth_creds.json') },
    }),
  });
  home = made.home;
  return made;
}

/** Sets the sign-in file's modification time, which is what signing in again does. */
function touchSignIn(home, at) {
  const file = path.join(home, '.gemini', 'oauth_creds.json');
  fs.utimesSync(file, new Date(at), new Date(at));
}

const SIGNED_OUT = () => ({ lines: [], exitCode: 41, stderr: stderrTail('recorded-signed-out.stderr.txt') });

test('a sign-in written after the hold lifts it, at the next seat check', async () => {
  // A sign-in hold turned away the one success that would clear it, so a seat
  // signed back in stayed refused for half an hour.
  const clock = { now: Date.now() };
  let signedIn = false;
  const runner = makeFakeCliRunner(() => (signedIn ? { lines: lines('constructed-success.ndjson') } : SIGNED_OUT()));
  const { adapter, home } = makeSignInSeat(runner, clock);

  const error = await failureOf(adapter.complete(makeRequest()));
  assert.equal(error.kind, 'auth');
  assert.equal(adapter.outages().length, 1);

  // `NO_BROWSER=true gemini`, signed in: the file is written after the hold.
  clock.now += 60_000;
  writeSignIn(home);
  touchSignIn(home, clock.now);
  signedIn = true;
  clock.now += 1_000;

  await adapter.health();
  assert.deepEqual(adapter.outages(), []);
  assert.equal((await adapter.complete(makeRequest())).text, '{"capital": "Paris"}');
  assert.equal(runner.calls.length, 2);
});

test('a cached seat check lifts nothing; only a fresh one, as the admin Settings page asks for, does', async () => {
  // The hold is lifted on the uncached branch alone, so a reading from the
  // last minute - the startup check, an earlier page load - must not stand in
  // for the fresh one the page asks for after the operator signs back in.
  const clock = { now: Date.now() };
  let signedIn = false;
  const runner = makeFakeCliRunner(() => (signedIn ? { lines: lines('constructed-success.ndjson') } : SIGNED_OUT()));
  const { adapter, home } = makeSignInSeat(runner, clock);

  await adapter.health();
  const error = await failureOf(adapter.complete(makeRequest()));
  assert.equal(error.kind, 'auth');
  assert.equal(adapter.outages().length, 1);

  clock.now += 10_000;
  writeSignIn(home);
  touchSignIn(home, clock.now);
  signedIn = true;
  clock.now += 10_000;

  await adapter.health();
  assert.equal(adapter.outages().length, 1, 'a reading from within the minute lifts nothing');
  assert.equal((await failureOf(adapter.complete(makeRequest()))).kind, 'auth');

  await adapter.health({ fresh: true });
  assert.deepEqual(adapter.outages(), []);
  assert.equal((await adapter.complete(makeRequest())).text, '{"capital": "Paris"}');
  assert.equal(runner.calls.length, 2);
});

test('the escalated hold for a revoked token stays while the sign-in file is unchanged', async () => {
  // The check only READS the file, so it says "signed in" for a token Google
  // has revoked - which is exactly what three unvalidated sign-ins in a row
  // are taken to be. Only a sign-in written after that hold may lift it.
  const clock = { now: Date.now() };
  const runner = makeFakeCliRunner(SIGNED_OUT);
  const { adapter, home } = makeSignInSeat(runner, clock);
  writeSignIn(home);
  touchSignIn(home, clock.now - 24 * 60 * 60_000);

  const kinds = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    clock.now += 3 * 60_000;
    kinds.push((await failureOf(adapter.complete(makeRequest()))).kind);
  }
  assert.deepEqual(kinds, ['unavailable', 'unavailable', 'auth']);

  clock.now += 60_000;
  const health = await adapter.health({ fresh: true });
  assert.equal(health.loggedIn, true, 'the file still reads as a sign-in');
  assert.equal(adapter.outages().length, 1, 'and the hold stays');
  assert.equal((await failureOf(adapter.complete(makeRequest()))).kind, 'auth');
  assert.equal(runner.calls.length, 3);

  // Signed in again: the file is rewritten, and the next check lifts the hold.
  clock.now += 60_000;
  touchSignIn(home, clock.now);
  clock.now += 1_000;
  await adapter.health({ fresh: true });
  assert.deepEqual(adapter.outages(), []);
});

test('a quota hold is untouched by a fresh sign-in', async () => {
  const clock = { now: Date.now() };
  const runner = makeFakeCliRunner({
    lines: [...OPENING, apiErrorResult('[API Error: You have exhausted your capacity on this model. Please retry in 600s.]')],
    exitCode: 173,
  });
  const { adapter, home } = makeSignInSeat(runner, clock);

  assert.equal((await failureOf(adapter.complete(makeRequest()))).kind, 'rateLimited');
  clock.now += 1_000;
  writeSignIn(home);
  touchSignIn(home, clock.now);
  clock.now += 1_000;
  await adapter.health({ fresh: true });
  assert.equal(adapter.outages().length, 1, 'signing in does not refill a quota');
  assert.equal((await failureOf(adapter.complete(makeRequest()))).kind, 'rateLimited');
});

test('the outage table: a sign-in after the hold lifts it, one before it does not, and other kinds stay', () => {
  let now = 1_000_000;
  const table = new classify.GeminiOutageTable(() => now);

  table.noteAuth('signed out');
  assert.equal(table.clearAuth(now - 1), false, 'a sign-in older than the hold');
  assert.equal(table.clearAuth(now), false, 'one at the same moment is not after it');
  assert.equal(table.clearAuth(Number.NaN), false);
  assert.equal(table.check('auto').kind, 'auth');
  assert.equal(table.clearAuth(now + 1), true);
  assert.equal(table.check('auto').waitMs, 0);

  // A refusal while the hold is LIVE renews it, and moves its time on: a
  // sign-in written between the first refusal and the second is not news
  // about the second, and must not lift it.
  table.noteAuth('signed out');
  const signedInAt = now + 1_000;
  now += 2_000;
  table.noteAuth('signed out');
  assert.equal(table.clearAuth(signedInAt), false, 'a sign-in from before the renewal');
  assert.equal(table.check('auto').kind, 'auth');
  assert.equal(table.clearAuth(now + 1), true, 'one after it still does');

  table.noteLimit(60, 'quota');
  table.noteModelUnavailable('pro', 'not for this account');
  assert.equal(table.clearAuth(now + 10_000), false);
  assert.equal(table.check('auto').kind, 'rateLimited');
  assert.equal(table.check('pro').waitMs > 0, true);

  // Two unvalidated sign-ins, then a sign-in written after them: the count
  // starts again, so the next blip is a short hold, not the 30-minute one.
  const fresh = new classify.GeminiOutageTable(() => now);
  assert.equal(fresh.noteSignInUnverified('blip'), false);
  now += 1_000;
  assert.equal(fresh.noteSignInUnverified('blip'), false);
  fresh.clearAuth(now + 1);
  now += 1_000;
  assert.equal(fresh.noteSignInUnverified('blip'), false, 'the count started again');
  // But a sign-in from before them forgets nothing.
  now += 1_000;
  fresh.clearAuth(now - 60_000);
  assert.equal(fresh.noteSignInUnverified('blip'), false);
  assert.equal(fresh.noteSignInUnverified('blip'), true, 'the third in a row since that sign-in');
  assert.equal(fresh.check('auto').kind, 'auth');
});

test('no auth method, or a refused type, is auth at once even with a sign-in on disk', async () => {
  for (const name of ['recorded-no-auth-method.stderr.txt', 'recorded-enforced-type-refusal.stderr.txt']) {
    const runner = makeFakeCliRunner({ lines: [], exitCode: 41, stderr: stderrTail(name) });
    const { adapter, home } = makeAdapter(runner);
    writeSignIn(home);
    const error = await failureOf(adapter.complete(makeRequest()));
    assert.equal(error.kind, 'auth', name);
  }

  const signedOut = stderrTail('recorded-signed-out.stderr.txt');
  const classifyWith = (credentialsPresent) =>
    classify.classifyGeminiFailure({ exitCode: 41, stderrTail: signedOut, sawResult: false, status: null, message: '', credentialsPresent });
  assert.equal(classifyWith(false).kind, 'auth');
  assert.equal(classifyWith(true).kind, 'unavailable');
  assert.equal(classifyWith(true).signInUnverified, true);

  // Encrypted storage cannot be read, and "cannot tell" is not "signed out".
  const { hasStoredGeminiSignIn } = require('../dist/services/ai/providers/geminiCli/health');
  assert.equal(hasStoredGeminiSignIn({ HOME: '/nonexistent', GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' }), true);
  assert.equal(hasStoredGeminiSignIn({ HOME: '/nonexistent' }), false);
});

test('no auth method, or a refused one, is auth too - by the exit code or by the words', async () => {
  for (const [name, exitCode] of [
    ['recorded-no-auth-method.stderr.txt', 41],
    ['recorded-enforced-type-refusal.stderr.txt', 41],
    // The words alone are enough, should an exit code ever be lost on the way.
    ['recorded-enforced-type-refusal.stderr.txt', 1],
  ]) {
    const runner = makeFakeCliRunner({ lines: [], exitCode, stderr: stderrTail(name) });
    const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
    assert.equal(error.kind, 'auth', `${name} / exit ${exitCode}`);
  }
});

test('a spent quota is rate-limited with the delay the error asks for, and holds the whole seat', async () => {
  // NOT captured - no real account. Worded as the CLI's quota classifier and
  // error formatter write it, with the exit code its handler would leave
  // (429 & 0xFF = 173).
  const runner = makeFakeCliRunner({
    lines: [
      ...OPENING,
      apiErrorResult(
        '[API Error: You have exhausted your capacity on this model. Please retry in 34.5s.]\n' +
          'Possible quota limitations in place or slow response times detected. Switching to the gemini-2.5-flash model for the rest of this session.'
      ),
    ],
    exitCode: 173,
  });
  const { adapter } = makeAdapter(runner);

  const error = await failureOf(adapter.complete(makeRequest()));
  assert.equal(error.kind, 'rateLimited');
  assert.equal(error.retryAfterSeconds, 35);

  // Account-wide: another model is turned away as well.
  const again = await failureOf(adapter.complete(makeRequest({ modelName: 'gemini-2.5-pro' })));
  assert.equal(again.kind, 'rateLimited');
  assert.equal(runner.calls.length, 1);
});

test('a model the account cannot use is modelUnavailable, held for that model only', async () => {
  let call = 0;
  const runner = makeFakeCliRunner(() => {
    call += 1;
    return call === 1
      ? { lines: [...OPENING, apiErrorResult('[API Error: Requested entity was not found.]')], exitCode: 148 }
      : { lines: lines('constructed-success.ndjson') };
  });
  const { adapter } = makeAdapter(runner);

  const error = await failureOf(adapter.complete(makeRequest({ modelName: 'gemini-3.1-pro-preview' })));
  assert.equal(error.kind, 'modelUnavailable');
  assert.match(error.adminAction, /gemini-3\.1-pro-preview/);

  // The same model is turned away without a spawn...
  const held = await failureOf(adapter.complete(makeRequest({ modelName: 'gemini-3.1-pro-preview' })));
  assert.equal(held.kind, 'modelUnavailable');
  assert.equal(runner.calls.length, 1);

  // ...and another model still runs.
  const result = await adapter.complete(makeRequest({ modelName: 'flash' }));
  assert.equal(result.text, '{"capital": "Paris"}');
  assert.deepEqual(adapter.outages().map((hold) => hold.scope), ['gemini-3.1-pro-preview']);
});

test('classification: words first, the exit code as a tiebreak, and never a bare three-digit number', () => {
  const failed = (message, exitCode = 1) =>
    classify.classifyGeminiFailure({ exitCode, stderrTail: '', sawResult: true, status: 'error', message }).kind;

  assert.equal(failed('[API Error: got status: 503 Service Unavailable]'), 'unavailable');
  assert.equal(failed('[API Error: The model is overloaded. Please try again later.]'), 'unavailable');
  assert.equal(failed('[API Error: PERMISSION_DENIED: caller does not have permission]'), 'auth');
  assert.equal(failed('[API Error: Request failed with status code 401]'), 'auth');
  assert.equal(failed('[API Error: RESOURCE_EXHAUSTED]'), 'rateLimited');
  assert.equal(failed('You have exhausted your daily quota on this model.'), 'rateLimited');
  assert.equal(failed('[API Error: Model not found: gemini-9]'), 'modelUnavailable');
  // A duration and a token count, not statuses.
  assert.equal(failed('the stream stalled after 503 ms and 404 tokens'), 'failed');
  // Nothing in the words: the exit code (HTTP status & 0xFF) decides.
  assert.equal(failed('[API Error: something unexpected]', 173), 'rateLimited');
  assert.equal(failed('[API Error: something unexpected]', 148), 'modelUnavailable');

  assert.equal(classify.parseRetryAfterSeconds('Please retry in 1500ms'), 2);
  assert.equal(classify.parseRetryAfterSeconds('quota\nSuggested retry after 60s.'), 60);
  assert.equal(classify.parseRetryAfterSeconds('no delay here'), null);

  const noResult = (exitCode, stderrTail = '') =>
    classify.classifyGeminiFailure({ exitCode, stderrTail, sawResult: false, status: null, message: '' });
  assert.equal(noResult(41).kind, 'auth');
  assert.match(noResult(42, 'No input provided via stdin.').detail, /refused its input/);
  assert.match(noResult(55).detail, /does not trust its workspace/);
  assert.equal(noResult(0).kind, 'failed');
});

test('an answer billed to paid AI Credits is refused, and the seat is held', async () => {
  const runner = makeFakeCliRunner({
    lines: lines('constructed-success.ndjson'),
    stderr: '[INFO] Using AI Credits for this request.',
  });
  const { adapter } = makeAdapter(runner);

  const error = await failureOf(adapter.complete(makeRequest()));
  assert.equal(error.kind, 'rateLimited');
  assert.match(error.detail, /paid AI Credits/);
  assert.match(error.adminAction, /overageStrategy/);
  assert.deepEqual(adapter.outages().map((hold) => hold.scope), ['*']);
});

test('a tool call means the lockdown did not hold, and the turn is not trusted', async () => {
  const runner = makeFakeCliRunner({
    lines: [
      ...OPENING,
      '{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{"path":"/etc/passwd"}}',
      ...lines('constructed-success.ndjson').slice(2),
    ],
  });
  const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
  assert.equal(error.kind, 'failed');
  assert.match(error.detail, /1 tool/);
});

test('a missing binary names the install and the sign-in', async () => {
  const enoent = Object.assign(new Error('spawn /nonexistent/gemini ENOENT'), { code: 'ENOENT' });
  const runner = makeFakeCliRunner({ spawnError: enoent });
  const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
  assert.equal(error.kind, 'binaryMissing');
  assert.match(error.adminAction, /npm i -g @google\/gemini-cli/);
  assert.match(error.adminAction, /NO_BROWSER=true gemini/);
});

test('the clock, a cancel and a silent start each end the turn with no body, and none of them holds the seat', async () => {
  for (const [step, kind] of [
    [{ lines: lines('constructed-success.ndjson').slice(0, 3), timedOut: true }, 'timeout'],
    [{ lines: [], aborted: true }, 'timeout'],
    [{ lines: [], stalled: true }, 'stalled'],
  ]) {
    const runner = makeFakeCliRunner(step);
    const { adapter } = makeAdapter(runner);
    const error = await failureOf(adapter.complete(makeRequest()));
    assert.equal(error.kind, kind);
    // A first-byte stall is the sign-in or the network hanging before the
    // model was asked anything - not a spent window, so nothing is held.
    assert.deepEqual(adapter.outages(), []);
  }
});

test('an output overflow names this provider\'s setting, not the shared runner\'s wording', async () => {
  const overflow = new Error('Claude CLI produced more than 1000000 bytes of output; aborting to protect memory');
  const runner = makeFakeCliRunner({ spawnError: overflow });
  const error = await failureOf(makeAdapter(runner).adapter.complete(makeRequest()));
  assert.equal(error.kind, 'failed');
  assert.match(error.detail, /AI_GEMINI_MAX_OUTPUT_BYTES/);
  assert.doesNotMatch(error.detail, /Claude/);
});

test('sampling hints the CLI has no flag for are reported, not silently dropped', async () => {
  const runner = makeFakeCliRunner({ lines: lines('constructed-success.ndjson') });
  const result = await makeAdapter(runner).adapter.complete(
    makeRequest({ sampling: { temperature: 0.7, maxOutputTokens: 1500 } })
  );
  assert.deepEqual([...result.droppedParams].sort(), ['maxOutputTokens', 'temperature']);
});

test('capabilities: no sampling, no JSON mode, its own system channel', () => {
  const { adapter } = makeAdapter(makeFakeCliRunner({ lines: [] }), { concurrency: 3 });
  assert.equal(adapter.id, 'gemini-cli');
  assert.equal(adapter.capabilities.temperature, false);
  assert.equal(adapter.capabilities.maxOutputTokens, false);
  assert.equal(adapter.capabilities.nativeJsonMode, 'none');
  assert.equal(adapter.capabilities.systemBlocks, true);
  assert.equal(adapter.capabilities.maxConcurrency, 3);
  assert.notEqual(adapter.capabilities.requiresApiKey, true);
  assert.equal(adapter.defaultModelName(), 'auto');
});

test('the concurrency limit holds across simultaneous turns', async () => {
  let live = 0;
  let peak = 0;
  const runner = makeFakeCliRunner(async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
    return { lines: lines('constructed-success.ndjson') };
  });
  const { adapter } = makeAdapter(runner, { concurrency: 1, queueWaitMs: 5_000 });

  const results = await Promise.all(Array.from({ length: 4 }, () => adapter.complete(makeRequest())));
  assert.equal(results.length, 4);
  assert.equal(peak, 1);
});

// -- the transcript the CLI leaves behind ------------------------------------ //

/** Writes a transcript where the CLI writes one, with the header it carries. */
function writeTranscript(home, project, sessionId) {
  const chats = path.join(home, '.gemini', 'tmp', project, 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, `session-2026-10-04T12-54-${sessionId.slice(0, 8)}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ sessionId, projectHash: 'x', kind: 'main' })}\n` +
      '{"type":"user","content":[{"text":"a whole resume and job description"}]}\n'
  );
  return file;
}

function sessionIdOf(spec) {
  return spec.argv[spec.argv.indexOf('--session-id') + 1];
}

test('the transcript of the conversation is deleted with the turn, and no one else\'s is', async () => {
  const written = {};
  const runner = makeFakeCliRunner((spec) => {
    const sessionId = sessionIdOf(spec);
    const home = spec.env.GEMINI_CLI_HOME;
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gemini', 'projects.json'),
      JSON.stringify({ projects: { [path.resolve(spec.cwd)]: 'tailor-work' } })
    );
    written.ours = writeTranscript(home, 'tailor-work', sessionId);
    fs.mkdirSync(path.join(home, '.gemini', 'tmp', 'tailor-work', 'logs'), { recursive: true });
    written.log = path.join(home, '.gemini', 'tmp', 'tailor-work', 'logs', `session-${sessionId}.jsonl`);
    fs.writeFileSync(written.log, '{}\n');
    // The operator's own session in another project, sharing the 8-character
    // prefix the file NAME carries - only the header tells them apart.
    written.theirs = writeTranscript(home, 'operator-project', `${sessionId.slice(0, 8)}-0000-4000-8000-000000000000`);
    return { lines: lines('constructed-success.ndjson') };
  });
  const { adapter } = makeAdapter(runner);

  await adapter.complete(makeRequest());

  assert.equal(fs.existsSync(written.ours), false, 'the transcript holds the prompt and the answer');
  assert.equal(fs.existsSync(written.log), false);
  assert.equal(fs.existsSync(written.theirs), true, 'another session sharing the short id is not ours');
});

test('without a projects.json entry the transcript is still found, and a failed turn cleans up too', async () => {
  let ours = null;
  const runner = makeFakeCliRunner((spec) => {
    ours = writeTranscript(spec.env.GEMINI_CLI_HOME, 'work-2', sessionIdOf(spec));
    return { lines: lines('constructed-api-error.ndjson'), exitCode: 1 };
  });
  const { adapter, stateDir } = makeAdapter(runner);

  await failureOf(adapter.complete(makeRequest()));
  assert.equal(fs.existsSync(ours), false);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, 'turns')), []);
});

test('with no AI_GEMINI_HOME, the transcript is looked for in the home the child inherits', async () => {
  const { rootDir } = useTempStorage('gemini-inherited-home');
  const inheritedHome = path.join(rootDir, 'operator-home');
  const saved = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = inheritedHome;
  try {
    let ours = null;
    const runner = makeFakeCliRunner((spec) => {
      assert.equal(spec.env.GEMINI_CLI_HOME, inheritedHome);
      ours = writeTranscript(inheritedHome, 'work', sessionIdOf(spec));
      return { lines: lines('constructed-success.ndjson') };
    });
    const { adapter } = makeAdapter(runner, { home: null });
    await adapter.complete(makeRequest());
    assert.equal(fs.existsSync(ours), false);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = saved;
  }
});

// -- health ----------------------------------------------------------------- //

async function withExecFile(answer, run) {
  const calls = [];
  const real = childProcess.execFile;
  childProcess.execFile = (command, args, execOptions, callback) => {
    calls.push({ command, args, timeout: execOptions.timeout, env: execOptions.env });
    const { stdout = '', stderr = '', error = null } = answer(args) ?? {};
    process.nextTick(() => callback(error, stdout, stderr));
    return { pid: 0 };
  };
  try {
    await run();
  } finally {
    childProcess.execFile = real;
  }
  return calls;
}

function makeHome(name, files = {}) {
  const { rootDir } = useTempStorage(name);
  const home = path.join(rootDir, 'home');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(home, '.gemini', file), content);
  }
  return home;
}

const versionOk = () => ({ stdout: '0.62.0\n' });

test('health runs `gemini --version` and nothing else - no prompt is ever sent - and reads the sign-in from files', async () => {
  const home = makeHome('gemini-health-ok', {
    'oauth_creds.json': JSON.stringify({ access_token: 'ya29.x', refresh_token: '1//refresh', expiry_date: 0 }),
    'google_accounts.json': JSON.stringify({ active: 'seat@example.com', old: [] }),
    'settings.json': '{\n  // the operator\'s own\n  "security": { "auth": { "selectedType": "oauth-personal" } } /* tail */\n}\n',
  });
  let health = null;
  const calls = await withExecFile(versionOk, async () => {
    health = await checkGeminiCliHealth({ binary: 'gemini', env: { GEMINI_CLI_HOME: home }, timeoutMs: 2_000 });
  });

  assert.deepEqual(calls.map((call) => call.args), [['--version']]);
  assert.equal(calls[0].timeout, 2_000);
  assert.equal(health.ok, true, health.detail);
  assert.equal(health.loggedIn, true);
  assert.equal(health.version, '0.62.0');
  assert.equal(health.authMethod, 'oauth-personal');
  assert.match(health.detail, /seat@example\.com/);
  assert.equal(health.meta.selectedAuthType, 'oauth-personal');
  assert.equal(health.warning, undefined);
});

test('health: no sign-in, a sign-in with no refresh token, and encrypted storage each say what they are', async () => {
  const signedOut = makeHome('gemini-health-out');
  const noRefresh = makeHome('gemini-health-norefresh', {
    'oauth_creds.json': JSON.stringify({ access_token: 'ya29.x' }),
  });
  const encrypted = makeHome('gemini-health-encrypted');

  const results = {};
  await withExecFile(versionOk, async () => {
    results.signedOut = await checkGeminiCliHealth({ binary: 'gemini', env: { GEMINI_CLI_HOME: signedOut }, timeoutMs: 1_000 });
    results.noRefresh = await checkGeminiCliHealth({ binary: 'gemini', env: { GEMINI_CLI_HOME: noRefresh }, timeoutMs: 1_000 });
    results.encrypted = await checkGeminiCliHealth({
      binary: 'gemini',
      env: { GEMINI_CLI_HOME: encrypted, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' },
      timeoutMs: 1_000,
    });
  });

  assert.equal(results.signedOut.ok, false);
  assert.equal(results.signedOut.loggedIn, false);
  assert.match(results.signedOut.detail, /Not signed in/);
  assert.match(results.signedOut.warning, /NO_BROWSER=true gemini/);

  assert.equal(results.noRefresh.ok, false);
  assert.match(results.noRefresh.detail, /no refresh token/);

  // Cannot be read without a model call, so it is neither a pass nor a fail.
  assert.equal(results.encrypted.ok, true);
  assert.equal(results.encrypted.loggedIn, null);
  assert.match(results.encrypted.detail, /encrypted storage/);
});

test('health warns about a GEMINI.md that would join every prompt', async () => {
  const home = makeHome('gemini-health-memory', {
    'oauth_creds.json': JSON.stringify({ refresh_token: '1//refresh' }),
    'GEMINI.md': 'Always answer like a pirate.\n',
  });
  let health = null;
  await withExecFile(versionOk, async () => {
    health = await checkGeminiCliHealth({ binary: 'gemini', env: { GEMINI_CLI_HOME: home }, timeoutMs: 1_000 });
  });
  assert.equal(health.ok, true);
  assert.match(health.warning, /GEMINI\.md is not empty/);
  assert.match(health.warning, /AI_GEMINI_HOME/);
});

test('health reports a missing binary with the install steps', async () => {
  let health = null;
  await withExecFile(
    () => ({ error: Object.assign(new Error('spawn gemini ENOENT'), { code: 'ENOENT' }) }),
    async () => {
      health = await checkGeminiCliHealth({ binary: 'gemini', env: {}, timeoutMs: 1_000 });
    }
  );
  assert.equal(health.ok, false);
  assert.equal(health.binary, null);
  assert.match(health.warning, /npm i -g @google\/gemini-cli/);
});

test('AI_GEMINI_HEALTH_TIMEOUT_MS bounds `gemini --version`; unset it is 15s', async () => {
  const home = makeHome('gemini-health-timeout', { 'oauth_creds.json': '{"refresh_token":"r"}' });
  const probe = async (value) => {
    const saved = process.env.AI_GEMINI_HEALTH_TIMEOUT_MS;
    if (value === undefined) delete process.env.AI_GEMINI_HEALTH_TIMEOUT_MS;
    else process.env.AI_GEMINI_HEALTH_TIMEOUT_MS = value;
    try {
      const calls = await withExecFile(versionOk, () =>
        checkGeminiCliHealth({ binary: 'gemini', env: { GEMINI_CLI_HOME: home } })
      );
      return calls[0].timeout;
    } finally {
      if (saved === undefined) delete process.env.AI_GEMINI_HEALTH_TIMEOUT_MS;
      else process.env.AI_GEMINI_HEALTH_TIMEOUT_MS = saved;
    }
  };
  assert.equal(await probe(undefined), 15_000);
  assert.equal(await probe('40000'), 40_000);
});

test('the adapter caches health for a minute and checks it with the scrubbed environment', async () => {
  let clock = 1_000_000;
  const seen = [];
  const { adapter } = makeAdapter(makeFakeCliRunner({ lines: [] }), {}, {
    now: () => clock,
    healthCheck: async (check) => {
      seen.push(check);
      return { ok: true, loggedIn: true, binary: check.binary, version: 'test', checkedAt: '', detail: 'stub' };
    },
  });

  await adapter.health();
  clock += 59_000;
  await adapter.health();
  assert.equal(seen.length, 1, 'within a minute the cached answer is reused');
  clock += 2_000;
  await adapter.health();
  assert.equal(seen.length, 2);

  assert.equal(seen[0].binary, '/nonexistent/gemini');
  assert.equal(seen[0].env.GEMINI_API_KEY, '');
  assert.equal(seen[0].env.NO_BROWSER, 'true');
});

// -- settings ---------------------------------------------------------------- //

/** Runs `read` with console.warn captured and the once-per-name memory cleared. */
function withWarnings(read) {
  resetEnvWarningsForTests();
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { value: read(), warnings };
  } finally {
    console.warn = original;
  }
}

test('the settings default to the design\'s values, and a bad one warns once and falls back or clamps', () => {
  const defaults = options.readGeminiCliConfig({});
  assert.deepEqual(
    {
      binary: defaults.binary,
      model: defaults.model,
      concurrency: defaults.concurrency,
      queueWaitMs: defaults.queueWaitMs,
      firstEventMs: defaults.firstEventMs,
      defaultTimeoutMs: defaults.defaultTimeoutMs,
      timeoutMsByCallSite: defaults.timeoutMsByCallSite,
      maxAttempts: defaults.maxAttempts,
      maxOutputBytes: defaults.maxOutputBytes,
      home: defaults.home,
    },
    {
      binary: 'gemini',
      model: 'auto',
      concurrency: 2,
      queueWaitMs: 600_000,
      firstEventMs: 60_000,
      defaultTimeoutMs: 180_000,
      timeoutMsByCallSite: { 'tailor-resume': 300_000, 'filter-google-sheet-job': 60_000 },
      maxAttempts: 3,
      maxOutputBytes: 25_000_000,
      home: null,
    }
  );
  assert.equal(defaults.workdir, path.join(process.cwd(), '.gemini-cli-work'));
  assert.equal(defaults.stateDir, path.join(process.cwd(), '.gemini-cli-state'));

  const inDb = options.readGeminiCliConfig({ DB_DIR: '/data/db', AI_GEMINI_HOME: '/srv/tailor-gemini' });
  assert.equal(inDb.workdir, path.join('/data/db', 'gemini-cli-work'));
  assert.equal(inDb.stateDir, path.join('/data/db', 'gemini-cli-state'));
  assert.equal(inDb.home, path.resolve('/srv/tailor-gemini'));

  const junk = withWarnings(() => options.geminiCliConcurrency({ AI_GEMINI_CONCURRENCY: 'lots' }));
  assert.equal(junk.value, 2);
  assert.equal(junk.warnings.length, 1);
  assert.equal(options.geminiCliConcurrency({ AI_GEMINI_CONCURRENCY: '99' }), 32);
  assert.equal(options.geminiCliConcurrency({ AI_GEMINI_CONCURRENCY: '0' }), 1);

  const badModel = withWarnings(() => options.geminiCliModel({ AI_GEMINI_MODEL: 'gpt-6-sol' }));
  assert.equal(badModel.value, 'auto');
  assert.match(badModel.warnings[0], /AI_GEMINI_MODEL/);
  assert.equal(options.geminiCliModel({ AI_GEMINI_MODEL: 'gemini-2.5-pro' }), 'gemini-2.5-pro');

  assert.equal(options.geminiCliTimeoutMs('AI_GEMINI_TIMEOUT_MS_TAILOR', { AI_GEMINI_TIMEOUT_MS_TAILOR: '1' }), 5_000);
  assert.equal(
    withWarnings(() => options.readGeminiCliConfig({ AI_GEMINI_MAX_ATTEMPTS: '50' })).value.maxAttempts,
    10,
    'the CLI itself caps maxAttempts at 10'
  );
});

test('every AI_GEMINI_ setting is in the table the operational list takes, and an empty environment is at every default', () => {
  const names = options.GEMINI_CLI_SETTINGS.map((setting) => setting.name);
  assert.deepEqual(names, [
    'AI_GEMINI_BIN',
    'AI_GEMINI_MODEL',
    'AI_GEMINI_CONCURRENCY',
    'AI_GEMINI_QUEUE_WAIT_MS',
    'AI_GEMINI_FIRST_EVENT_MS',
    'AI_GEMINI_TIMEOUT_MS',
    'AI_GEMINI_TIMEOUT_MS_TAILOR',
    'AI_GEMINI_TIMEOUT_MS_FILTER',
    'AI_GEMINI_HEALTH_TIMEOUT_MS',
    'AI_GEMINI_MAX_ATTEMPTS',
    'AI_GEMINI_MAX_OUTPUT_BYTES',
    'AI_GEMINI_WORKDIR',
    'AI_GEMINI_STATE_DIR',
    'AI_GEMINI_HOME',
  ]);
  // No switch lets a key through: the provider exists to run on the sign-in.
  assert.equal(names.some((name) => /API_KEY/.test(name)), false);

  const { value: readings, warnings } = withWarnings(() =>
    options.GEMINI_CLI_SETTINGS.map((setting) => [setting.name, setting.current({}), setting.defaultValue])
  );
  for (const [name, current, defaultValue] of readings) {
    assert.equal(current, defaultValue, name);
  }
  assert.deepEqual(warnings, []);

  for (const setting of options.GEMINI_CLI_SETTINGS) {
    assert.equal(setting.side, 'backend');
    const isInt = setting.name in options.GEMINI_CLI_INT_SETTINGS;
    assert.equal(Boolean(setting.bounds), isInt, `${setting.name} bounds`);
    if (isInt) {
      const spec = options.GEMINI_CLI_INT_SETTINGS[setting.name];
      assert.deepEqual(setting.bounds, { min: spec.min, max: spec.max });
      assert.equal(setting.defaultValue, String(spec.fallback));
    }
    // Each health check reads its timeout; everything else is read once, when
    // the adapter is built.
    assert.equal(setting.readAt, setting.name === 'AI_GEMINI_HEALTH_TIMEOUT_MS' ? 'per-call' : 'startup', setting.name);
  }
  assert.equal(
    options.GEMINI_CLI_SETTINGS.find((setting) => setting.name === 'AI_GEMINI_CONCURRENCY').current({ AI_GEMINI_CONCURRENCY: '6' }),
    '6'
  );
});

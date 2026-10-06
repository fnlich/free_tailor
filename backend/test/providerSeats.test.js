const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { makeFakeCliRunner, readCliFixture, useTempStorage } = require('./helpers');

/**
 * Every seat, per PROVIDER (owner decisions P1, P2, P4): each provider's
 * adapter is built with its own sign-in folder, binary and limit; its child
 * names that folder AFTER the usual key strip, which still takes every key;
 * its holds, health and the minute's status cache are its own, so one signed
 * out says nothing about another of its type; and a type's calls go to the
 * provider that can take them. No process is spawned: every runner and health
 * check here is a stand-in.
 */

const { createClaudeCliAdapter } = require('../dist/services/ai/providers/claudeCli/index');
const { createCodexCliAdapter } = require('../dist/services/ai/providers/codexCli/index');
const { createGeminiCliAdapter } = require('../dist/services/ai/providers/geminiCli/index');
const { createDeadline } = require('../dist/services/ai/types');
const { AsyncSemaphore, getProviderSemaphore } = require('../dist/services/ai/concurrency');

function instance(id, home, binary, extra = {}) {
  return { id, label: `Provider ${id}`, builtIn: false, homeDir: home, binaryPath: binary, concurrency: 2, ...extra };
}

function request(overrides = {}) {
  return {
    modelName: 'sonnet',
    stableSystem: 'You are a resume assistant.',
    volatileSystem: '',
    userBody: 'Say hello.',
    responseFormat: 'text',
    sampling: {},
    deadline: createDeadline(60_000),
    callSite: 'provider-seat-test',
    ...overrides,
  };
}

/** A parent environment full of the things a child must never see. */
const PARENT = {
  PATH: '/usr/bin',
  HOME: '/home/service',
  ANTHROPIC_API_KEY: 'sk-ant-should-never-reach-the-child',
  ANTHROPIC_AUTH_TOKEN: 'token',
  CLAUDE_CODE_SESSION: 'parent-session',
  CLAUDE_CONFIG_DIR: '/home/service/.claude-of-the-server',
  OPENAI_API_KEY: 'sk-openai',
  OPENAI_BASE_URL: 'https://example.invalid',
  CODEX_API_KEY: 'codex-key',
  CODEX_HOME: '/home/service/.codex-of-the-server',
  GEMINI_API_KEY: 'gemini-key',
  GOOGLE_API_KEY: 'google-key',
  GEMINI_CLI_HOME: '/home/service/gemini-of-the-server',
};

function withParentEnv(action) {
  const saved = {};
  for (const name of Object.keys(PARENT)) {
    saved[name] = process.env[name];
    process.env[name] = PARENT[name];
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  return Promise.resolve().then(action).finally(restore);
}

test('a Claude provider\'s child signs in at its own folder and runs its own binary - and still gets no key', async () => {
  const { rootDir } = useTempStorage('provider-seat-claude');
  await withParentEnv(async () => {
    const runA = makeFakeCliRunner({ lines: readCliFixture('success-text') });
    const runB = makeFakeCliRunner({ lines: readCliFixture('success-text') });
    const healthEnvs = [];
    const healthCheck = async ({ binary, env }) => {
      healthEnvs.push({ binary, home: env.CLAUDE_CONFIG_DIR });
      return { ok: true, loggedIn: true, binary, version: 't', authMethod: 'oauth_token', checkedAt: new Date().toISOString(), detail: 'ok' };
    };
    const a = createClaudeCliAdapter({
      runner: runA,
      instance: instance('prv-aaaa0001', '/srv/claude-a', '/opt/claude-a/claude'),
      config: { workdir: path.join(rootDir, 'claude-work'), firstEventMs: 1_000, queueWaitMs: 1_000 },
      healthCheck,
    });
    const b = createClaudeCliAdapter({
      runner: runB,
      instance: instance('prv-aaaa0002', '/srv/claude-b', '/opt/claude-b/claude'),
      config: { workdir: path.join(rootDir, 'claude-work'), firstEventMs: 1_000, queueWaitMs: 1_000 },
      healthCheck,
    });
    await a.complete(request());
    await b.complete(request());

    const [callA] = runA.calls;
    const [callB] = runB.calls;
    assert.equal(callA.binary, '/opt/claude-a/claude');
    assert.equal(callB.binary, '/opt/claude-b/claude');
    assert.equal(callA.env.CLAUDE_CONFIG_DIR, '/srv/claude-a', 'its own folder wins over the server\'s');
    assert.equal(callB.env.CLAUDE_CONFIG_DIR, '/srv/claude-b');
    for (const env of [callA.env, callB.env]) {
      assert.equal(env.ANTHROPIC_API_KEY, undefined, 'the key strip still runs');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.CLAUDE_CODE_SESSION, undefined);
      assert.equal(env.PATH, '/usr/bin');
    }

    await a.health({ fresh: true });
    await b.health({ fresh: true });
    assert.deepEqual(healthEnvs, [
      { binary: '/opt/claude-a/claude', home: '/srv/claude-a' },
      { binary: '/opt/claude-b/claude', home: '/srv/claude-b' },
    ], '`claude auth status` asks each provider\'s own folder');
    assert.equal(a.instanceId, 'prv-aaaa0001');
    assert.equal(a.id, 'claude-cli', 'the type is still the type');
  });
});

test("the built-in Claude provider with nothing set keeps the server's own CLAUDE_CONFIG_DIR, as it always did", async () => {
  useTempStorage('provider-seat-claude-built-in');
  await withParentEnv(async () => {
    const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });
    const adapter = createClaudeCliAdapter({
      runner,
      instance: { id: 'claude-cli', label: 'Claude', builtIn: true, homeDir: null, binaryPath: 'claude', concurrency: 4 },
      config: { workdir: process.env.TMPDIR || os.tmpdir(), firstEventMs: 1_000, queueWaitMs: 1_000 },
      healthCheck: async () => ({ ok: true, loggedIn: true, authMethod: 'oauth_token', checkedAt: '', detail: '' }),
    });
    await adapter.complete(request());
    assert.equal(runner.calls[0].env.CLAUDE_CONFIG_DIR, PARENT.CLAUDE_CONFIG_DIR);
    assert.equal(runner.calls[0].env.ANTHROPIC_API_KEY, undefined);
  });
});

test('a Codex provider\'s child gets its own CODEX_HOME and binary, without a key; its login status is cached for it alone', async () => {
  const { rootDir } = useTempStorage('provider-seat-codex');
  const savedWorkdir = process.env.AI_CODEX_WORKDIR;
  process.env.AI_CODEX_WORKDIR = path.join(rootDir, 'codex-work');
  await withParentEnv(async () => {
    const seen = [];
    const runner = {
      run: async (spec) => {
        seen.push(spec);
        return { exitCode: 0, signal: null, stderrTail: '', timedOut: false, stalled: false, aborted: false, spawnError: null, bytesRead: 0 };
      },
    };
    const checks = { a: 0, b: 0 };
    const make = (key, id, home) =>
      createCodexCliAdapter({
        runner,
        readAnswerFile: () => 'hello',
        instance: instance(id, home, `/opt/${key}/codex`),
        healthCheck: async ({ env }) => {
          checks[key] += 1;
          assert.equal(env.CODEX_HOME, home, 'login status reads this provider\'s CODEX_HOME');
          return { ok: true, loggedIn: true, binary: 'codex', detail: 'Logged in using ChatGPT', checkedAt: '' };
        },
      });
    const a = make('a', 'prv-cccc0001', '/srv/codex-a');
    const b = make('b', 'prv-cccc0002', '/srv/codex-b');
    await a.complete(request({ modelName: 'default' }));
    await a.complete(request({ modelName: 'default' }));
    await b.complete(request({ modelName: 'default' }));

    assert.deepEqual(checks, { a: 1, b: 1 }, 'one login status per provider, cached a minute each');
    assert.deepEqual(seen.map((spec) => [spec.binary, spec.env.CODEX_HOME]), [
      ['/opt/a/codex', '/srv/codex-a'],
      ['/opt/a/codex', '/srv/codex-a'],
      ['/opt/b/codex', '/srv/codex-b'],
    ]);
    for (const spec of seen) {
      assert.equal(spec.env.OPENAI_API_KEY, undefined);
      assert.equal(spec.env.OPENAI_BASE_URL, undefined);
      assert.equal(spec.env.CODEX_API_KEY, undefined);
    }
    assert.equal(seen[0].cwd, path.join(rootDir, 'codex-work-prv-cccc0001'), 'a working directory of its own');
    assert.equal(seen[2].cwd, path.join(rootDir, 'codex-work-prv-cccc0002'));
  }).finally(() => {
    if (savedWorkdir === undefined) delete process.env.AI_CODEX_WORKDIR;
    else process.env.AI_CODEX_WORKDIR = savedWorkdir;
  });
});

test("a Gemini provider's child gets its own GEMINI_CLI_HOME, workspace and state dir, with every key pinned empty", async () => {
  const { rootDir } = useTempStorage('provider-seat-gemini');
  const base = { work: path.join(rootDir, 'gemini-work'), state: path.join(rootDir, 'gemini-state') };
  const saved = { work: process.env.AI_GEMINI_WORKDIR, state: process.env.AI_GEMINI_STATE_DIR };
  process.env.AI_GEMINI_WORKDIR = base.work;
  process.env.AI_GEMINI_STATE_DIR = base.state;
  try {
    await withParentEnv(async () => {
      const fixture = fs
        .readFileSync(path.join(__dirname, 'fixtures', 'gemini', 'constructed-success.ndjson'), 'utf8')
        .split('\n')
        .filter(Boolean);
      const runner = makeFakeCliRunner({ lines: fixture });
      const healthEnvs = [];
      const adapter = createGeminiCliAdapter({
        runner,
        instance: instance('prv-eeee0001', path.join(rootDir, 'gemini-home-a'), '/opt/gemini-a/gemini'),
        config: { firstEventMs: 1_000, queueWaitMs: 1_000 },
        healthCheck: async ({ binary, env }) => {
          healthEnvs.push([binary, env.GEMINI_CLI_HOME]);
          return { ok: true, loggedIn: true, binary, version: 't', checkedAt: '', detail: 'ok', meta: {} };
        },
      });
      await adapter.complete(request({ modelName: 'auto' }));
      const [call] = runner.calls;
      assert.equal(call.binary, '/opt/gemini-a/gemini');
      assert.equal(call.env.GEMINI_CLI_HOME, path.join(rootDir, 'gemini-home-a'));
      assert.equal(call.env.GEMINI_API_KEY, '', 'pinned empty, as for every Gemini child');
      assert.equal(call.env.GOOGLE_API_KEY, '');
      assert.equal(call.cwd, `${base.work}-prv-eeee0001`, 'a workspace of its own');
      assert.ok(fs.existsSync(path.join(`${base.work}-prv-eeee0001`, '.gemini', 'settings.json')), 'with its own settings file');
      assert.ok(fs.existsSync(`${base.state}-prv-eeee0001`), 'and its own state directory');
      assert.equal(fs.existsSync(base.work), false, 'the built-in provider\'s workspace is not touched');

      await adapter.health({ fresh: true });
      assert.deepEqual(healthEnvs, [['/opt/gemini-a/gemini', path.join(rootDir, 'gemini-home-a')]]);
    });
  } finally {
    for (const [name, value] of [['AI_GEMINI_WORKDIR', saved.work], ['AI_GEMINI_STATE_DIR', saved.state]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('holds are per provider: one signed out, the other serving', async () => {
  const { rootDir } = useTempStorage('provider-seat-holds');
  const signedIn = async () => ({ ok: true, loggedIn: true, authMethod: 'oauth_token', checkedAt: '', detail: 'ok' });
  const config = { workdir: path.join(rootDir, 'work'), firstEventMs: 1_000, queueWaitMs: 1_000 };
  const out = createClaudeCliAdapter({
    runner: makeFakeCliRunner({ lines: readCliFixture('auth-failure') }),
    instance: instance('prv-dddd0001', '/srv/out', '/opt/claude'),
    config,
    healthCheck: signedIn,
  });
  const serving = createClaudeCliAdapter({
    runner: makeFakeCliRunner({ lines: readCliFixture('success-text') }),
    instance: instance('prv-dddd0002', '/srv/in', '/opt/claude'),
    config,
    healthCheck: signedIn,
  });

  await assert.rejects(() => out.complete(request()), (error) => {
    assert.equal(error.kind, 'auth');
    assert.match(error.detail, /provider "Provider prv-dddd0001" \(prv-dddd0001\)/, 'the detail says which provider');
    return true;
  });
  // The next call is turned away by that provider's hold, naming how to sign THAT one in.
  await assert.rejects(() => out.complete(request()), (error) => {
    assert.equal(error.kind, 'auth');
    assert.match(error.adminAction, /CLAUDE_CONFIG_DIR=\/srv\/out claude auth login/);
    return true;
  });
  assert.equal(out.readiness().held.kind, 'auth');
  assert.equal(serving.readiness().held, null, 'the other Claude provider is not held by it');
  const answer = await serving.complete(request());
  assert.ok(answer.text.length > 0);
  assert.equal(answer.providerInstanceId, 'prv-dddd0002');

  // Health is per provider too: a check that finds one signed out benches that one only.
  const signedOut = createClaudeCliAdapter({
    runner: makeFakeCliRunner({ lines: [] }),
    instance: instance('prv-dddd0003', '/srv/never', '/opt/claude'),
    config,
    healthCheck: async () => ({ ok: false, loggedIn: false, checkedAt: '', detail: 'not signed in' }),
  });
  assert.equal(signedOut.readiness().ready, null, 'unchecked is not held against it');
  await signedOut.health({ fresh: true });
  assert.equal(signedOut.readiness().ready, false);
  await serving.health({ fresh: true });
  assert.equal(serving.readiness().ready, true);
});

test('a semaphore resized live keeps counting what is running', async () => {
  const semaphore = new AsyncSemaphore(2);
  const one = await semaphore.acquire();
  const two = await semaphore.acquire();
  semaphore.resize(1);
  let third = null;
  const waiting = semaphore.acquire().then((release) => {
    third = release;
  });
  one();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(third, null, 'shrunk to one with one still running: nobody new');
  two();
  await waiting;
  assert.equal(semaphore.inFlight, 1);
  semaphore.resize(3);
  const four = await semaphore.acquire();
  const five = await semaphore.acquire();
  assert.equal(semaphore.inFlight, 3, 'grown to three at once');
  third();
  four();
  five();

  // The registry's getter resizes the same semaphore instead of replacing it.
  const shared = getProviderSemaphore('prv-resize-test', 2);
  assert.equal(getProviderSemaphore('prv-resize-test', 5), shared);
  assert.equal(shared.size, 5);
});

test("the registry builds each provider's own adapter from the settings, and a type's stub stands in for its others", async () => {
  useTempStorage('provider-seat-registry');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();

  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-home-a-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-home-b-'));
  const { provider } = await config.createAIProvider({ type: 'codex-cli', label: 'Codex two', homeDir: homeA, concurrency_max_requests: 3 });

  const adapter = ai.getAdapter(provider.id);
  assert.equal(adapter.id, 'codex-cli');
  assert.equal(adapter.instanceId, provider.id);
  assert.equal(adapter.capabilities.maxConcurrency, 3);
  assert.equal(ai.getAdapter(provider.id), adapter, 'cached');

  // A new limit resizes its semaphore in place; a new folder is a new seat.
  await config.updateAIProvider(provider.id, { concurrency_max_requests: 6 });
  assert.equal(ai.getAdapter(provider.id), adapter);
  assert.equal(require('../dist/services/ai/concurrency').getSemaphoreStats()[provider.id].limit, 6);
  await config.updateAIProvider(provider.id, { homeDir: homeB });
  assert.notEqual(ai.getAdapter(provider.id), adapter, 'another sign-in folder is another adapter, holds and all');

  // A suite that stubs the type is never handed a real CLI for another provider of it.
  ai.registerAdapter('codex-cli', () => ({ id: 'codex-cli', stub: true, capabilities: { maxConcurrency: 1 } }));
  assert.equal(ai.getAdapter(provider.id).stub, true);
  ai.resetRegistryForTests();
});

test('a type\'s calls go to a ready provider with the most room, and a queued task\'s go where it was placed', async () => {
  useTempStorage('provider-seat-pool');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-home-'));
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Claude two', homeDir: home, concurrency_max_requests: 4 });
  const ready = new Map([['claude-cli', true], [provider.id, true]]);
  const answered = [];
  const stub = (id) => () => ({
    id: 'claude-cli',
    instanceId: id,
    capabilities: { id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4 },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: '' }),
    readiness: () => ({ ready: ready.get(id), held: ready.get(id) ? null : { kind: 'rateLimited', reason: 'spent', until: '' } }),
    complete: async (req) => {
      answered.push(id);
      return { text: 'ok', resolvedModel: req.modelName, providerId: 'claude-cli', providerInstanceId: id, droppedParams: [], latencyMs: 1 };
    },
  });
  ai.registerAdapter('claude-cli', stub('claude-cli'));
  ai.registerAdapter(provider.id, stub(provider.id));

  // Both ready and idle: the tie goes to list order, the built-in.
  assert.equal(ai.pickProvider('claude-cli').id, 'claude-cli');
  // The built-in busier relative to its limit: the other.
  const busy = getProviderSemaphore('claude-cli', 4);
  const held = [await busy.acquire(), await busy.acquire()];
  assert.equal(ai.pickProvider('claude-cli').id, provider.id);
  held.forEach((release) => release());
  // The built-in held: never picked while another is ready.
  ready.set('claude-cli', false);
  assert.equal(ai.pickProvider('claude-cli').id, provider.id);
  // Both held: the first, which fails with its hold's own error - a direct
  // call does not wait.
  ready.set(provider.id, false);
  assert.equal(ai.pickProvider('claude-cli').id, 'claude-cli');
  ready.set('claude-cli', true);
  ready.set(provider.id, true);

  // A queued resume pinned to a provider: every call of that type goes there,
  // even when another has more room.
  await ai.runPinnedToProvider(provider.id, async () => {
    assert.equal(ai.pickProvider('claude-cli').id, provider.id);
    assert.equal(ai.pickProvider('codex-cli').id, 'codex-cli', 'a pin is per type');
  });

  // And a real completion lands where it was picked.
  await ai.runPinnedToProvider(provider.id, () =>
    ai.createRawCompletion({ callSite: 'pool', system: 's', user: 'u', provider: 'claude-cli', modelName: 'sonnet', responseFormat: 'text' })
  );
  assert.deepEqual(answered, [provider.id]);
  ai.resetRegistryForTests();
});

test('the analysis model pools the same way: its calls are spread over its type', async () => {
  // The gate's call is a direct one - it names the analysis model's type, and
  // the pool picks the provider. Held built-in, ready second: the second.
  useTempStorage('provider-seat-analysis');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-home-'));
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Claude two', homeDir: home });
  const answered = [];
  const stub = (id, held) => () => ({
    id: 'claude-cli',
    capabilities: { id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4 },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: '' }),
    readiness: () => ({ ready: true, held: held ? { kind: 'rateLimited', reason: 'spent', until: '' } : null }),
    complete: async (req) => {
      answered.push(id);
      return { text: '{}', resolvedModel: req.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  });
  ai.registerAdapter('claude-cli', stub('claude-cli', true));
  ai.registerAdapter(provider.id, stub(provider.id, false));
  await ai.createRawCompletion({ callSite: 'analyze-job-description', system: 's', user: 'u', provider: 'claude-cli', modelName: 'sonnet' });
  assert.deepEqual(answered, [provider.id]);
  ai.resetRegistryForTests();
});

test("a Claude provider under a weekly Opus cap reads as held for Opus, and only for Opus", async () => {
  const { rootDir } = useTempStorage('provider-seat-opus-cap');
  // The recorded rejection, as the weekly Opus window rather than the
  // five-hour one: the hold is the model's, not the seat's.
  const lines = readCliFixture('rate-limited').map((line) =>
    line.includes('rate_limit_event')
      ? line
          .replace('"rateLimitType":"five_hour"', '"rateLimitType":"seven_day_opus"')
          .replace('"five_hour":{"utilization":1.0', '"five_hour":{"utilization":0.4')
      : line
  );
  const runner = makeFakeCliRunner({ lines });
  const capped = createClaudeCliAdapter({
    runner,
    instance: instance('prv-dddd0004', '/srv/capped', '/opt/claude'),
    config: { workdir: path.join(rootDir, 'work'), firstEventMs: 1_000, queueWaitMs: 1_000, model: 'sonnet' },
    healthCheck: async () => ({ ok: true, loggedIn: true, authMethod: 'oauth_token', checkedAt: '', detail: 'ok' }),
  });
  await assert.rejects(() => capped.complete(request({ modelName: 'opus' })), (error) => error.kind === 'rateLimited');

  assert.equal(capped.readiness('opus').held.kind, 'rateLimited', 'asked about Opus: held');
  assert.ok(Date.parse(capped.readiness('opus').held.until) > Date.now());
  assert.equal(capped.readiness('sonnet').held, null, 'Sonnet still runs here');
  assert.equal(capped.readiness('').held, null, 'and so does the default model, which is Sonnet');
  assert.equal(capped.readiness().held, null, 'the seat itself is not held - the admin card says so');

  // The queue and the pool now agree with what a call would meet.
  await assert.rejects(() => capped.complete(request({ modelName: 'opus' })), (error) => error.kind === 'rateLimited');
  assert.equal(runner.calls.length, 1, 'the second Opus call was turned away without spawning');
});

test('a call on a model one provider is held for goes to another of its type, and an unheld model is placed as usual', async () => {
  useTempStorage('provider-seat-model-pick');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-home-'));
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Claude two', homeDir: home, concurrency_max_requests: 2 });
  const answered = [];
  const stub = (id, heldModel) => () => ({
    id: 'claude-cli',
    instanceId: id,
    capabilities: { id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 2 },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: '' }),
    readiness: (model) => ({ ready: true, held: model === heldModel ? { kind: 'rateLimited', reason: 'weekly cap', until: '' } : null }),
    complete: async (req) => {
      answered.push(`${req.modelName}@${id}`);
      return { text: 'ok', resolvedModel: req.modelName, providerId: 'claude-cli', providerInstanceId: id, droppedParams: [], latencyMs: 1 };
    },
  });
  ai.registerAdapter('claude-cli', stub('claude-cli', 'opus'));
  ai.registerAdapter(provider.id, stub(provider.id, null));

  assert.equal(ai.pickProvider('claude-cli', 'opus').id, provider.id, 'the provider held for Opus is passed over for Opus');
  assert.equal(ai.pickProvider('claude-cli', 'sonnet').id, 'claude-cli', 'and is still first for Sonnet');
  assert.equal(ai.pickProvider('claude-cli').id, 'claude-cli', 'asked about no model: the seat is not held');

  // An unpinned call - a preview, an analysis - lands where it was picked.
  for (const modelName of ['opus', 'sonnet']) {
    await ai.createRawCompletion({ callSite: 'pool', system: 's', user: 'u', provider: 'claude-cli', modelName, responseFormat: 'text' });
  }
  assert.deepEqual(answered, [`opus@${provider.id}`, 'sonnet@claude-cli']);
  ai.resetRegistryForTests();
});

test('a task pinned to a provider switched off mid-task finishes its calls there', async () => {
  // "Running ones finish or fail as today": its lane slot is still the
  // switched-off provider's, so its next call going to another provider
  // landed on a semaphore its lane never counted, and the order named a
  // provider that had not built it.
  useTempStorage('provider-seat-pin-off');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-off-home-'));
  const { provider } = await config.createAIProvider({ type: 'claude-cli', label: 'Claude B', homeDir: home, concurrency_max_requests: 2 });
  const answered = [];
  const stub = (id) => () => ({
    id: 'claude-cli',
    instanceId: id,
    capabilities: { id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 2 },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: '' }),
    readiness: () => ({ ready: true, held: null }),
    complete: async (req) => {
      answered.push(id);
      return { text: 'ok', resolvedModel: req.modelName, providerId: 'claude-cli', providerInstanceId: id, droppedParams: [], latencyMs: 1 };
    },
  });
  ai.registerAdapter('claude-cli', stub('claude-cli'));
  ai.registerAdapter(provider.id, stub(provider.id));

  const call = () =>
    ai.createRawCompletion({ callSite: 'pin', system: 's', user: 'u', provider: 'claude-cli', modelName: 'sonnet', responseFormat: 'text' });
  await ai.runPinnedToProvider(provider.id, async () => {
    await call();
    await config.updateAIProvider(provider.id, { enabled: false });
    assert.equal(ai.pickProvider('claude-cli').id, provider.id, 'the pin holds though the provider is switched off');
    await call();
  });
  assert.deepEqual(answered, [provider.id, provider.id]);

  // Nothing unpinned goes to it once it is off.
  answered.length = 0;
  await call();
  assert.deepEqual(answered, ['claude-cli']);
  ai.resetRegistryForTests();
});

/* ------------------------------------------- per provider, seat by seat */

test('two Claude providers, and two Gemini ones, keep two semaphores, each at its own limit', () => {
  // Owner decision P2: two CLIs of a type have two separate limits - for a
  // direct call (a preview, the Bid Assistant) as well as for the queue's lanes.
  const { rootDir } = useTempStorage('provider-seat-semaphores');
  const { getSemaphoreStats } = require('../dist/services/ai/concurrency');
  const quiet = () => makeFakeCliRunner({ lines: [] });
  createClaudeCliAdapter({ runner: quiet(), instance: instance('prv-5e5e0001', '/srv/a', '/opt/a', { concurrency: 1 }), config: { workdir: path.join(rootDir, 'claude') } });
  createClaudeCliAdapter({ runner: quiet(), instance: instance('prv-5e5e0002', '/srv/b', '/opt/b', { concurrency: 3 }), config: { workdir: path.join(rootDir, 'claude') } });
  const gemini = (id, concurrency) =>
    createGeminiCliAdapter({
      runner: quiet(),
      instance: instance(id, path.join(rootDir, `${id}-home`), '/opt/gemini', { concurrency }),
      config: { workdir: path.join(rootDir, `${id}-work`), stateDir: path.join(rootDir, `${id}-state`) },
    });
  gemini('prv-5e5e0003', 1);
  gemini('prv-5e5e0004', 3);
  const stats = getSemaphoreStats();
  assert.deepEqual(
    ['prv-5e5e0001', 'prv-5e5e0002', 'prv-5e5e0003', 'prv-5e5e0004'].map((id) => stats[id]?.limit),
    [1, 3, 1, 3],
    'keyed by the provider, never by the type - one shared semaphore would be sized by whichever was built first'
  );
});

test('an added Claude provider runs in a working directory of its own beside the seat\'s', async () => {
  const { rootDir } = useTempStorage('provider-seat-claude-workdir');
  const saved = process.env.AI_CLI_WORKDIR;
  process.env.AI_CLI_WORKDIR = path.join(rootDir, 'claude-work');
  try {
    const runner = makeFakeCliRunner({ lines: readCliFixture('success-text') });
    const adapter = createClaudeCliAdapter({
      runner,
      instance: instance('prv-5e5e0005', '/srv/c', '/opt/c'),
      config: { firstEventMs: 1_000, queueWaitMs: 1_000 },
    });
    await adapter.complete(request());
    assert.equal(runner.calls[0].cwd, path.join(rootDir, 'claude-work-prv-5e5e0005'));
  } finally {
    if (saved === undefined) delete process.env.AI_CLI_WORKDIR;
    else process.env.AI_CLI_WORKDIR = saved;
  }
});

test("a Codex provider's readiness: a status that said nothing benches nothing, a sign-in with an API key benches it", async () => {
  useTempStorage('provider-seat-codex-readiness');
  let answer = { ok: false, loggedIn: false, binary: 'codex', detail: 'said nothing', unknown: true, checkedAt: '' };
  const adapter = createCodexCliAdapter({
    runner: { run: async () => { throw new Error('not spawned'); } },
    readAnswerFile: () => '',
    instance: instance('prv-5e5e0006', '/srv/codex', '/opt/codex'),
    healthCheck: async () => answer,
  });
  assert.equal(adapter.readiness().ready, null, 'not checked yet');
  await adapter.health({ fresh: true });
  assert.equal(adapter.readiness().ready, null, 'unknown is not signed out: the queue keeps sending it work');
  answer = { ok: true, loggedIn: true, binary: 'codex', detail: 'Logged in using an API key', apiKey: true, checkedAt: '' };
  await adapter.health({ fresh: true });
  assert.equal(adapter.readiness().ready, false, 'every turn would be refused: no work goes to it');
  answer = { ok: true, loggedIn: true, binary: 'codex', detail: 'Logged in using ChatGPT', checkedAt: '' };
  await adapter.health({ fresh: true });
  assert.equal(adapter.readiness().ready, true);
});

test("a Gemini provider's seat-wide hold is in its readiness, which is what the queue and the pool read", async () => {
  const { rootDir } = useTempStorage('provider-seat-gemini-held');
  const signedOut = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'gemini', 'recorded-signed-out.stderr.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const adapter = createGeminiCliAdapter({
    runner: makeFakeCliRunner({ lines: [], exitCode: 41, stderr: signedOut }),
    instance: instance('prv-5e5e0007', path.join(rootDir, 'home'), '/opt/gemini'),
    config: { model: 'auto', workdir: path.join(rootDir, 'work'), stateDir: path.join(rootDir, 'state'), firstEventMs: 1_000, queueWaitMs: 1_000 },
  });
  assert.equal(adapter.readiness().held, null);
  await adapter.complete(request({ modelName: 'auto', responseFormat: 'json' })).catch(() => undefined);
  assert.equal(adapter.readiness().held?.kind, 'auth', 'held as signed out - not only refused at its next call');
});

test('another binary for a provider is another adapter; the registry rebuilds it', async () => {
  useTempStorage('provider-seat-rebuild');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-home-'));
    const binary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-bin-')), 'codex');
    fs.writeFileSync(binary, '#!/bin/sh\n');
    fs.chmodSync(binary, 0o755);
    const { provider } = await config.createAIProvider({ type: 'codex-cli', label: 'Codex two', homeDir: home, concurrency_max_requests: 3 });
    const adapter = ai.getAdapter(provider.id);
    await config.updateAIProvider(provider.id, { binaryPath: binary });
    assert.notEqual(ai.getAdapter(provider.id), adapter, 'the old adapter would keep spawning the old binary');
  } finally {
    ai.resetRegistryForTests();
  }
});

test('a removed provider\'s id still names its type, and every enabled provider is in the startup check', async (t) => {
  useTempStorage('provider-seat-removed-type');
  process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
  const config = require('../dist/config/aiModelConfig');
  const providers = require('../dist/config/aiProviders');
  config.invalidateSettingsCache();
  providers.resetProviderSnapshotForTests();
  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  t.after(() => ai.resetRegistryForTests());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-type-home-'));
  const { provider } = await config.createAIProvider({ type: 'gemini-cli', label: 'Gemini two', homeDir: home, concurrency_max_requests: 1 });

  // The boot check names the added provider, by id and label.
  for (const type of ['claude-cli', 'codex-cli', 'gemini-cli']) {
    ai.registerAdapter(type, () => ({
      id: type,
      capabilities: { id: type, label: 'stub', maxConcurrency: 1 },
      health: async () => ({ ok: true, detail: 'stub ready', checkedAt: '' }),
    }));
  }
  const lines = [];
  const log = t.mock.method(console, 'log', (line) => lines.push(String(line)));
  const reports = await ai.preflightAllProviders();
  log.mock.restore();
  assert.ok(reports.some((report) => report.providerId === provider.id), JSON.stringify(reports));
  assert.ok(lines.some((line) => line.includes(provider.id) && line.includes('Gemini two')), JSON.stringify(lines));

  // Removed, its waiting work still has to find its type's pool.
  await config.deleteAIProvider(provider.id);
  await config.getAdminAppSettings();
  assert.equal(providers.providerTypeOf(provider.id), 'gemini-cli');
});

test("a signed-out added provider's card says how to sign in at ITS folder; the built-in's says the bare command", async () => {
  // The bare `claude auth login` signs in the server's default folder - the
  // built-in provider's - so an operator following the card for an added one
  // signed in the wrong account and the card stayed red.
  const { rootDir } = useTempStorage('provider-seat-sign-in-advice');
  const childProcess = require('node:child_process');
  const real = childProcess.execFile;
  childProcess.execFile = (_command, args, _options, callback) => {
    const said =
      args[0] === '--version' ? '2.0.0\n' : args.join(' ') === 'auth status' ? '{"loggedIn":false}' : 'Not logged in\n';
    process.nextTick(() => callback(null, said, ''));
    return { pid: 0 };
  };
  try {
    const advice = (health) => `${health.detail} ${health.warning ?? ''}`;
    const claudeB = createClaudeCliAdapter({ runner: makeFakeCliRunner({ lines: [] }), instance: instance('prv-5e5e0008', '/srv/claude-b', 'claude') });
    assert.match(advice(await claudeB.health({ fresh: true })), /`CLAUDE_CONFIG_DIR=\/srv\/claude-b claude auth login`/);
    const claude = createClaudeCliAdapter({ runner: makeFakeCliRunner({ lines: [] }), config: { binary: 'claude' } });
    const bare = advice(await claude.health({ fresh: true }));
    assert.match(bare, /`claude auth login`/);
    assert.doesNotMatch(bare, /CLAUDE_CONFIG_DIR=/);

    const codexB = createCodexCliAdapter({
      runner: { run: async () => { throw new Error('not spawned'); } },
      readAnswerFile: () => '',
      instance: instance('prv-5e5e0009', '/srv/codex-b', 'codex'),
    });
    assert.match(advice(await codexB.health({ fresh: true })), /`CODEX_HOME=\/srv\/codex-b codex login --device-auth`/);

    const geminiHome = path.join(rootDir, 'gemini-b');
    fs.mkdirSync(geminiHome);
    const geminiB = createGeminiCliAdapter({
      runner: makeFakeCliRunner({ lines: [] }),
      instance: instance('prv-5e5e000a', geminiHome, 'gemini'),
      config: { workdir: path.join(rootDir, 'gemini-work'), stateDir: path.join(rootDir, 'gemini-state') },
    });
    assert.ok(
      advice(await geminiB.health({ fresh: true })).includes(`\`GEMINI_CLI_HOME=${geminiHome} NO_BROWSER=true gemini\``),
      'the Gemini card names the folder too'
    );
  } finally {
    childProcess.execFile = real;
  }
});

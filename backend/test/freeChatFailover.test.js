const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * The hybrid route as the executor actually runs it.
 *
 * freeChatRouting.test.js pins the ORDER; this pins what happens when the
 * account at the front of that order turns the call away - which is the half
 * that matters, because a hybrid route that cannot move to the other account is
 * just a slower way to pick one.
 */

function writePrompt(staticDir, id, content) {
  return writeStaticJson(staticDir, `prompts/${id}.json`, {
    id,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** A chat adapter that answers, or refuses in a named way. */
function chatAdapter(id, behaviour) {
  const calls = [];
  return {
    calls,
    adapter: {
      id,
      capabilities: {
        id,
        label: id,
        temperature: false,
        maxOutputTokens: false,
        nativeJsonMode: 'none',
        systemBlocks: false,
        requiresApiKey: false,
        credentialKind: 'browser-session',
        maxConcurrency: 1,
      },
      defaultModelName: () => 'chat',
      health: async () => ({ ok: true, detail: id, checkedAt: new Date().toISOString() }),
      async complete(request) {
        calls.push(request);
        const outcome = behaviour(calls.length);
        if (outcome) throw outcome;
        return {
          text: `{"from":"${id}"}`,
          resolvedModel: request.modelName,
          providerId: id,
          droppedParams: [],
          latencyMs: 1,
        };
      },
    },
  };
}

function setUp(name) {
  const { staticDir } = useTempStorage(name);
  writePrompt(staticDir, 'analyze-job-description', 'Analyze this.\n[[jobDescription]]');
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.resetFreeChatRoutingForTests();
  const { AIProviderError } = ai;
  return { ai, AIProviderError };
}

function ask(ai, route) {
  return ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'a posting' },
    fallbackProvider: 'claude-web',
    responseFormat: 'text',
    useExactPromptId: true,
    route,
  });
}

test('an account out of messages hands the call to the other one', async () => {
  const { ai, AIProviderError } = setUp('failover-wall');
  const claude = chatAdapter(
    'claude-web',
    () =>
      new AIProviderError({
        provider: 'claude-web',
        kind: 'rateLimited',
        detail: 'Message limit reached',
      })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  assert.equal(await ask(ai, 'hybrid'), '{"from":"chatgpt-web"}');
  assert.equal(claude.calls.length, 1, 'the first account is still tried');
  assert.equal(chatgpt.calls.length, 1, 'and the answer comes from the second');
});

test('the second account is asked with ITS OWN model name', async () => {
  // A failover is to a different adapter. Carrying the first one's model name
  // across would ask ChatGPT for a model only Claude has ever heard of.
  const { ai, AIProviderError } = setUp('failover-modelname');
  const claude = chatAdapter(
    'claude-web',
    () => new AIProviderError({ provider: 'claude-web', kind: 'auth', detail: 'signed out' })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  chatgpt.adapter.defaultModelName = () => 'gpt-chat';
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'a posting' },
    fallbackProvider: 'claude-web',
    fallbackModelName: 'claude-chat',
    responseFormat: 'text',
    useExactPromptId: true,
    route: 'hybrid',
  });

  assert.equal(claude.calls[0].modelName, 'claude-chat');
  assert.equal(chatgpt.calls[0].modelName, 'gpt-chat');
});

test('a single-account route fails rather than spending the other allowance', async () => {
  // Picking one account is a statement about which allowance to spend. Reaching
  // for the other would empty one the person deliberately kept back.
  const { ai, AIProviderError } = setUp('failover-single');
  const claude = chatAdapter(
    'claude-web',
    () => new AIProviderError({ provider: 'claude-web', kind: 'rateLimited', detail: 'out' })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  await assert.rejects(ask(ai, 'claude-only'), /out/);
  assert.equal(chatgpt.calls.length, 0, 'the other account must not be touched');
});

test('a bad answer is not retried on the other account', async () => {
  // It would fail the same way twice, and the second attempt would spend
  // whatever time the first one left.
  const { ai, AIProviderError } = setUp('failover-truncated');
  const claude = chatAdapter(
    'claude-web',
    () => new AIProviderError({ provider: 'claude-web', kind: 'truncated', detail: 'cut off' })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  await assert.rejects(ask(ai, 'hybrid'), /cut off/);
  assert.equal(chatgpt.calls.length, 0);
});

test('both attempts share one budget, so a hybrid call cannot take twice as long', async () => {
  // The obvious reading of "try the other account" is a second full budget, and
  // it is wrong: the caller that set the timeout, and the operator watching a
  // page that has not come back, have no idea it could run to double.
  const { ai, AIProviderError } = setUp('failover-deadline');
  const claude = chatAdapter(
    'claude-web',
    () => new AIProviderError({ provider: 'claude-web', kind: 'unavailable', detail: 'no browser' })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'a posting' },
    fallbackProvider: 'claude-web',
    responseFormat: 'text',
    useExactPromptId: true,
    route: 'hybrid',
    timeoutMs: 60_000,
  });

  assert.equal(
    claude.calls[0].deadline,
    chatgpt.calls[0].deadline,
    'the second attempt must inherit the first one\'s clock, not start a new one'
  );
});

test('a prompt pinned to one account by an admin is not rerouted', async () => {
  // A route is a default about the profile; a provider on a prompt record is a
  // choice about that prompt. The narrower statement wins, or an admin who
  // pinned one prompt would find it silently running somewhere else.
  const { staticDir } = useTempStorage('failover-pinned');
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze this.\n[[jobDescription]]',
    modelProvider: 'claude-web',
    modelName: 'chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  ai.resetFreeChatRoutingForTests();

  const claude = chatAdapter(
    'claude-web',
    () =>
      new ai.AIProviderError({ provider: 'claude-web', kind: 'rateLimited', detail: 'pinned out' })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  await assert.rejects(
    ai.createPromptCompletion({
      promptId: 'analyze-job-description',
      promptValues: { jobDescription: 'a posting' },
      fallbackProvider: 'chatgpt-web',
      responseFormat: 'text',
      useExactPromptId: true,
      route: 'hybrid',
    }),
    /pinned out/
  );
  assert.equal(chatgpt.calls.length, 0);
});

test('the account that failed is passed over by the NEXT call', async () => {
  // Otherwise every call of a batch rediscovers the same wall, paying a failed
  // round trip each time to learn what the last one already found out.
  const { ai, AIProviderError } = setUp('failover-cooldown');
  const claude = chatAdapter(
    'claude-web',
    () => new AIProviderError({ provider: 'claude-web', kind: 'rateLimited', detail: 'out' })
  );
  const chatgpt = chatAdapter('chatgpt-web', () => null);
  ai.registerAdapter('claude-web', () => claude.adapter);
  ai.registerAdapter('chatgpt-web', () => chatgpt.adapter);

  await ask(ai, 'hybrid');
  await ask(ai, 'hybrid');

  assert.equal(claude.calls.length, 1, 'the walled account is asked once, not once per call');
  assert.equal(chatgpt.calls.length, 2);
});

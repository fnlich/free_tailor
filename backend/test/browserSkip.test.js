const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * One browser being unusable must not fail the request.
 *
 * This is the reason to run more than one in the first place. A site's browsers
 * are separate windows with separate sessions, so an operator can sign a
 * different account into each - which means a usage wall on one is NOT a wall
 * on the site. Until this, only a browser that failed to answer its debug port
 * was passed over; a browser that answered and then said "out of messages"
 * failed the whole call with a second, working browser sitting idle beside it.
 */

async function setUp(name, ports) {
  const { staticDir } = useTempStorage(name);
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze this.\n[[jobDescription]]',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  // Registered the way an operator registers them, so the pool sees the same
  // shape it sees in production rather than a per-test shortcut.
  const config = loadFresh('../dist/config/aiModelConfig');
  await config.updateAppSettings({
    browserChatEndpoints: ports.map((port) => ({ siteId: 'claude-web', port })),
  });

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const { createBrowserChatAdapter } = loadFresh('../dist/services/ai/providers/browserChat');
  // Plain require, NOT loadFresh. The adapter above closed over whichever copy
  // of these modules was in the cache; re-requiring them fresh would hand the
  // test a different class object, and every `instanceof` inside the adapter
  // would quietly answer false - so the skip logic would look broken while
  // being correct.
  const { ChatTurnError } = require('../dist/services/ai/providers/browserChat/tab');
  const { BrowserSessionError } = require('../dist/services/ai/providers/browserChat/session');

  return { ai, createBrowserChatAdapter, ChatTurnError, BrowserSessionError };
}

/** A session for one browser: it answers, or it fails in a named way. */
function browser(behaviour) {
  const asked = [];
  return {
    asked,
    session: {
      tabFor: async () => ({
        ask: async (body) => {
          asked.push(body);
          const failure = behaviour(asked.length);
          if (failure) throw failure;
          return 'the answer';
        },
      }),
      probe: async () => ({ ok: true, detail: 'stub' }),
      dispose: async () => {},
    },
  };
}

/**
 * `retryable` is what separates the two refusals a real site produces: a usage
 * wall clears on its own clock (429, worth retrying later), a signed-out tab
 * needs a person (503). The adapter reads it, so a fixture that left it off
 * would exercise the wrong branch.
 */
function turnError(ChatTurnError, kind, message, sent, retryable = false) {
  const error = new ChatTurnError(kind, message, retryable);
  error.sent = sent;
  return error;
}

async function ask(adapter) {
  return adapter.complete({
    modelName: 'chat',
    stableSystem: '',
    volatileSystem: '',
    userBody: 'a prompt',
    responseFormat: 'text',
    sampling: {},
    deadline: { totalMs: 60_000, remainingMs: () => 60_000, expired: () => false },
    callSite: 'analyze-job-description',
  });
}

test('a browser out of messages is skipped for one that is not', async () => {
  // The case that matters. Two windows, two accounts, one of them walled.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('skip-wall', [9401, 9402]);
  const walled = browser(() =>
    turnError(
      ChatTurnError,
      'refused',
      'Claude (free) did not answer because the message limit was reached.',
      false,
      true
    )
  );
  const working = browser(() => null);

  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9401') ? walled.session : working.session),
  });

  const result = await adapter.complete({
    modelName: 'chat',
    stableSystem: '',
    volatileSystem: '',
    userBody: 'a prompt',
    responseFormat: 'text',
    sampling: {},
    deadline: { totalMs: 60_000, remainingMs: () => 60_000, expired: () => false },
    callSite: 'analyze-job-description',
  });

  assert.equal(result.text, 'the answer');
  assert.equal(walled.asked.length, 1, 'the walled browser is tried once');
  assert.equal(working.asked.length, 1, 'and the other one answers');
});

test('the walled browser is skipped by the NEXT call too', async () => {
  // Otherwise every call of a batch spends a tab lease and a page load
  // rediscovering what the last one already found out.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('skip-cooldown', [9411, 9412]);
  const walled = browser(() =>
    turnError(ChatTurnError, 'refused', 'out of messages until 3 PM', false, true)
  );
  const working = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9411') ? walled.session : working.session),
  });

  await ask(adapter);
  await ask(adapter);
  await ask(adapter);

  assert.equal(walled.asked.length, 1, 'asked once, then left alone');
  assert.equal(working.asked.length, 3);
});

test('a signed-out browser is skipped, not fatal', async () => {
  // No composer on the page is what a signed-out tab looks like, and nothing
  // was typed - so another browser costs that account nothing.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('skip-signedout', [9421, 9422]);
  const signedOut = browser(() =>
    turnError(ChatTurnError, 'page', 'no composer found on Claude (free).', false)
  );
  const working = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9421') ? signedOut.session : working.session),
  });

  assert.equal((await ask(adapter)).text, 'the answer');
  assert.equal(working.asked.length, 1);
});

test('a wedged browser is skipped, not fatal', async () => {
  // "The previous turn is still driving its tab and has not let go" - a browser
  // this app cannot use right now, with nothing wrong with the request.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('skip-wedged', [9431, 9432]);
  const wedged = browser(() =>
    turnError(ChatTurnError, 'page', 'the previous turn is still driving its tab', false)
  );
  const working = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9431') ? wedged.session : working.session),
  });

  assert.equal((await ask(adapter)).text, 'the answer');
});

test('a prompt that WAS sent is not asked of a second browser', async () => {
  // The line this rule turns on. Re-asking after a prompt has landed puts the
  // same question - somebody's resume and salary history - into two accounts.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('no-double-ask', [9441, 9442]);
  const first = browser(() =>
    turnError(ChatTurnError, 'empty', 'Claude (free) showed no reply', true)
  );
  const second = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9441') ? first.session : second.session),
  });

  await assert.rejects(ask(adapter), /showed no reply/);
  assert.equal(second.asked.length, 0, 'the second browser must not be asked the same question');
});

test('a caller that went away is not retried elsewhere', async () => {
  // The whole point of noticing was to stop.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('no-retry-cancel', [9451, 9452]);
  const first = browser(() => turnError(ChatTurnError, 'cancelled', 'the request was cancelled', false));
  const second = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9451') ? first.session : second.session),
  });

  await assert.rejects(ask(adapter));
  assert.equal(second.asked.length, 0);
});

test('a spent budget is not spent again on another browser', async () => {
  // Another browser needs a whole turn and there is nothing left to give it.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('no-retry-timeout', [9461, 9462]);
  const first = browser(() => turnError(ChatTurnError, 'timeout', 'did not answer in time', false));
  const second = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9461') ? first.session : second.session),
  });

  await assert.rejects(ask(adapter), /did not answer in time/);
  assert.equal(second.asked.length, 0);
});

test('when every browser refuses, the error names each one and why', async () => {
  // "No browser could be reached" is wrong when two were reached and both were
  // out of messages, and it sends the operator to check the wrong thing.
  const { createBrowserChatAdapter, ChatTurnError } = await setUp('all-refuse', [9471, 9472]);
  const walled = browser(() =>
    turnError(ChatTurnError, 'refused', 'the message limit was reached', false, true)
  );
  const adapter = createBrowserChatAdapter('claude-web', { sessionFor: () => walled.session });

  await assert.rejects(ask(adapter), (error) => {
    // The LAST browser's own failure, not a generic "unavailable". The kind
    // carries meaning downstream - a usage wall is a 429 worth retrying later,
    // and the hybrid router reads it to decide whether the other account is
    // worth asking - so flattening every refusal into one kind would throw that
    // away along with the sentence written in this provider's voice.
    assert.equal(error.kind, 'rateLimited');
    assert.match(error.detail, /All 2 .* browsers were tried/);
    assert.match(error.detail, /9471/);
    assert.match(error.detail, /9472/);
    assert.match(error.detail, /message limit/);
    assert.doesNotMatch(error.detail, /could not be reached/, 'they were reached; they refused');
    return true;
  });
  assert.equal(walled.asked.length, 2, 'each browser is tried exactly once');
});

test('an unreachable browser still moves to another, as it always did', async () => {
  const { createBrowserChatAdapter, BrowserSessionError } = await setUp('skip-unreachable', [9481, 9482]);
  const dead = browser(() => new BrowserSessionError('Could not reach a debug browser', 'start it'));
  const working = browser(() => null);
  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) => (endpoint.includes('9481') ? dead.session : working.session),
  });

  assert.equal((await ask(adapter)).text, 'the answer');
});

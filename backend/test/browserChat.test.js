const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INITIAL_POLL_STATE,
  composePrompt,
  composerHolds,
  fingerprint,
  isEcho,
  pickReply,
  poll,
  usableBusySelectors,
} = require('../dist/services/ai/providers/browserChat/conversation');
const { readChatSite, isChatSiteId } = require('../dist/services/ai/providers/browserChat/sites');
const { debugEndpoint } = require('../dist/services/ai/providers/browserChat/session');

// These rules are the ones that cannot be checked by looking at the page: each
// is a real failure mode of driving a chat UI, and each produces a wrong answer
// rather than an error when it is got wrong.

test('the reply is the first message that was not there before', () => {
  const before = fingerprint([{ id: 'a', text: 'earlier answer' }]);
  const now = [
    { id: 'a', text: 'earlier answer' },
    { id: 'b', text: 'this one' },
  ];
  assert.equal(pickReply(before, now, null).reply.text, 'this one');
});

test('a second streamed branch cannot steal the turn', () => {
  // ChatGPT sometimes streams two candidate answers at once. Reading "the last
  // message" means reading whichever branch is last at that instant, and while
  // both are growing that flips - so the text never repeats and the turn spends
  // its whole budget without ever deciding.
  const before = fingerprint([]);
  const first = pickReply(before, [{ id: 'x', text: 'a' }], null);
  assert.equal(first.id, 'x');

  const withBranch = [
    { id: 'x', text: 'answer one' },
    { id: 'y', text: 'answer two' },
  ];
  assert.equal(pickReply(before, withBranch, first.id).reply.text, 'answer one');
  // Even reordered, the latch holds.
  assert.equal(pickReply(before, withBranch.slice().reverse(), first.id).reply.text, 'answer one');
});

test('a latch whose id vanished falls back rather than abandoning the turn', () => {
  // A streaming message can be re-rendered with a new id. Giving up there would
  // fail a turn whose answer is on screen.
  const before = fingerprint([]);
  const recovered = pickReply(before, [{ id: 'new-id', text: 'still here' }], 'old-id');
  assert.equal(recovered.reply.text, 'still here');
  assert.equal(recovered.id, 'new-id');
});

test('nothing new yet is not a reply', () => {
  const before = fingerprint([{ id: 'a', text: 'x' }]);
  assert.equal(pickReply(before, [{ id: 'a', text: 'x' }], null), null);
  assert.equal(pickReply(fingerprint([]), [], null), null);
});

test('a reply is finished only when it is idle, non-empty and repeated', () => {
  let state = INITIAL_POLL_STATE;

  // Still streaming: the stop control is up.
  let out = poll(state, 'partial', true);
  assert.equal(out.done, null);
  state = out.state;

  // Idle, but this text has only been seen once. Both sites drop the stop
  // button a beat before the last chunk paints, so taking it here truncates.
  out = poll(state, 'the whole answer', false);
  assert.equal(out.done, null);
  state = out.state;

  out = poll(state, 'the whole answer', false);
  assert.equal(out.done, 'the whole answer');
});

test('an empty reply node never counts as a finished answer', () => {
  // The node appears before any text arrives. Two identical empty reads would
  // otherwise "finish" the turn with nothing in it.
  let state = INITIAL_POLL_STATE;
  for (let i = 0; i < 5; i += 1) {
    const out = poll(state, '   ', false);
    assert.equal(out.done, null);
    state = out.state;
  }
  const out = poll(state, 'real text', false);
  assert.equal(out.done, null, 'new text restarts the stability count');
  assert.equal(poll(out.state, 'real text', false).done, 'real text');
});

test('text that changes between polls restarts the count', () => {
  let state = INITIAL_POLL_STATE;
  state = poll(state, 'one', false).state;
  state = poll(state, 'one', false).state;
  const grew = poll(state, 'one two', false);
  assert.equal(grew.done, null, 'a reply that resumed is not finished');
  assert.equal(poll(grew.state, 'one two', false).done, 'one two');
});

test('the prompt coming back is recognised as an echo, not an answer', () => {
  // The total failure this guards: an assistant selector that also matches the
  // user's turn hands the instructions back, and a resume gets tailored to the
  // prompt instead of the job. No error, no empty reply.
  const sent = 'Tailor this resume for the following job description. Return JSON only.';
  assert.equal(isEcho(sent, `${sent}\n\nand then some`), true);
  // Whitespace and wrapping differences must not defeat it.
  assert.equal(isEcho(sent, sent.replace(/ /g, '\n  ')), true);
  assert.equal(isEcho(sent, 'Here is the tailored resume: {"summary": "..."}'), false);
  assert.equal(isEcho('', 'anything'), false);
});

test('the composer check tolerates rich-text rewriting but not lost words', () => {
  const typed = 'Use "smart" quotes - and a dash.';
  assert.equal(composerHolds(typed, 'Use “smart” quotes – and a dash.'), true);
  assert.equal(composerHolds(typed, typed.replace(/\s+/g, '  ')), true);
  // A composer holding somebody else's sentence must not pass.
  assert.equal(composerHolds(typed, 'Use "smart" quotes'), false);
  assert.equal(composerHolds(typed, ''), false);
});

test('a busy selector that matches an idle page is dropped', () => {
  // Left in, every reply looks unfinished forever: each call burns its whole
  // deadline and then fails, for every call rather than some.
  const candidates = ['button[aria-label="Stop response"]', 'div[data-is-streaming]'];
  assert.deepEqual(usableBusySelectors(candidates, ['div[data-is-streaming]']), [
    'button[aria-label="Stop response"]',
  ]);
  assert.deepEqual(usableBusySelectors(candidates, []), candidates);
});

test('the nudge is appended, and an empty one adds nothing', () => {
  assert.equal(composePrompt(' body ', ' keep it inline '), 'body\n\nkeep it inline');
  assert.equal(composePrompt('body', '   '), 'body');
});

test('both sites are configured, and the assistant role has no generic fallback', () => {
  for (const id of ['claude-web', 'chatgpt-web']) {
    assert.ok(isChatSiteId(id));
    const site = readChatSite(id, {});
    assert.ok(site.composer.length && site.send.length && site.busy.length);
    assert.ok(site.assistant.length, `${id} needs an assistant selector`);
    // A candidate this broad would match the user's own turn on both sites.
    for (const candidate of site.assistant) {
      assert.ok(
        !['div', '*', 'p', 'article'].includes(candidate.trim()),
        `${id}: "${candidate}" could match the user's message`
      );
    }
    assert.ok(site.url.startsWith('https://'));
  }
});

test('every selector role can be overridden from the environment', () => {
  const site = readChatSite('claude-web', {
    AI_WEB_CLAUDE_ASSISTANT: 'div.mine | .other',
    AI_WEB_CLAUDE_COMPOSER: '#box',
    AI_WEB_CLAUDE_URL: 'https://example.test/chat',
    AI_WEB_CLAUDE_NUDGE: '',
  });
  assert.deepEqual(site.assistant, ['div.mine', '.other']);
  assert.deepEqual(site.composer, ['#box']);
  assert.equal(site.url, 'https://example.test/chat');
  // An explicitly empty nudge is a choice, not a missing value.
  assert.equal(site.nudge, '');
  // Untouched roles keep their defaults.
  assert.ok(site.send.length > 0);
});

test('the debug endpoint defaults to loopback and is overridable', () => {
  assert.equal(debugEndpoint({}), 'http://127.0.0.1:9222');
  assert.equal(debugEndpoint({ AI_WEB_CDP_PORT: '9333' }), 'http://127.0.0.1:9333');
  assert.equal(debugEndpoint({ AI_WEB_CDP_URL: 'http://box.local:9222' }), 'http://box.local:9222');
  // Junk falls back rather than building a nonsense URL.
  assert.equal(debugEndpoint({ AI_WEB_CDP_PORT: 'no' }), 'http://127.0.0.1:9222');
});

// ---------------------------------------------------------------------------
// The adapter against the facade that calls it.
// ---------------------------------------------------------------------------

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/** A session whose tab records the prompt instead of driving a browser. */
function recordingSession(reply = 'the answer') {
  const prompts = [];
  return {
    prompts,
    session: {
      tabFor: async () => ({
        ask: async (body) => {
          prompts.push(body);
          return reply;
        },
      }),
      probe: async () => ({ ok: true, detail: 'stub' }),
      dispose: async () => {},
    },
  };
}

test('the system text reaches the chat exactly once, not twice and not never', async () => {
  // The trap this pins: the facade folds system text into the user body for a
  // provider with no system channel, AND the adapter joins the three parts. Get
  // it wrong one way and the instructions arrive twice; the other way and the
  // JSON-only instruction never arrives at all, which is silent - the reply is
  // simply prose that fails to parse somewhere else, later.
  const { staticDir } = useTempStorage('browser-chat-facade');
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'SYSTEM-PREAMBLE-MARKER\nMore rules.\n[[jobDescription]]',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const { createBrowserChatAdapter } = loadFresh('../dist/services/ai/providers/browserChat');
  const recorder = recordingSession('{"ok": true}');
  ai.registerAdapter('claude-web', () =>
    createBrowserChatAdapter('claude-web', { session: recorder.session })
  );

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    callSite: 'analyze-job-description',
    promptValues: { jobDescription: 'USER-BODY-MARKER' },
    fallbackProvider: 'claude-web',
    responseFormat: 'json',
    useExactPromptId: true,
  });

  assert.equal(recorder.prompts.length, 1);
  const sent = recorder.prompts[0];
  const occurrences = (needle) => sent.split(needle).length - 1;

  assert.equal(occurrences('SYSTEM-PREAMBLE-MARKER'), 1, 'the preamble must arrive exactly once');
  assert.equal(occurrences('USER-BODY-MARKER'), 1, 'the rendered variables must arrive once');
  // A chat window has no JSON mode, so the only thing making the reply
  // parseable is this instruction actually being in the message.
  assert.match(sent, /JSON/i, 'the JSON-only instruction must reach a provider with no JSON mode');
});

test('a chat window reports the knobs it cannot honour rather than ignoring them', async () => {
  useTempStorage('browser-chat-dropped');
  const { createBrowserChatAdapter } = loadFresh('../dist/services/ai/providers/browserChat');
  const { createDeadline } = loadFresh('../dist/services/ai/types');
  const recorder = recordingSession('prose, as a chat window gives');
  const adapter = createBrowserChatAdapter('chatgpt-web', { session: recorder.session });

  const result = await adapter.complete({
    modelName: 'chat',
    stableSystem: '',
    volatileSystem: '',
    userBody: 'hello',
    responseFormat: 'text',
    sampling: { temperature: 0.7, maxOutputTokens: 1500 },
    effort: 'max',
    thinking: 'off',
    deadline: createDeadline(5_000),
    callSite: 'probe',
  });

  assert.equal(result.text, 'prose, as a chat window gives');
  assert.equal(result.providerId, 'chatgpt-web');
  // All four: a select box that does nothing must say so somewhere.
  for (const dropped of ['temperature', 'maxOutputTokens', 'effort', 'thinking']) {
    assert.ok(result.droppedParams.includes(dropped), `${dropped} should be reported as dropped`);
  }
  // Nothing is metered, so counting tokens would be inventing them.
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test('overriding the URL also moves the tab lookup to that host', () => {
  // Fixed, the host would still say claude.ai while the URL said otherwise, so
  // the driver would never recognise the tab the operator actually signed in to
  // and would open a fresh one on every call.
  const site = readChatSite('claude-web', { AI_WEB_CLAUDE_URL: 'https://chat.internal.example/app' });
  assert.equal(site.host, 'chat.internal.example');
  // A URL that does not parse falls back rather than leaving the host empty,
  // which would match every tab.
  assert.equal(readChatSite('claude-web', { AI_WEB_CLAUDE_URL: 'not a url' }).host, 'claude.ai');
  assert.equal(readChatSite('chatgpt-web', {}).host, 'chatgpt.com');
});

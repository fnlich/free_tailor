const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INITIAL_POLL_STATE,
  STABLE_READS_WITHOUT_BUSY_SIGNAL,
  STABLE_READS_WITH_BUSY_SIGNAL,
  composePrompt,
  composerHolds,
  fingerprint,
  hostOf,
  isEcho,
  matchesHost,
  pickReply,
  poll,
  refusalReason,
  usableBusySelectors,
} = require('../dist/services/ai/providers/browserChat/conversation');
const { ChatTab } = require('../dist/services/ai/providers/browserChat/tab');
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

// --- The rules the adversarial review found missing -------------------------
//
// Each of these was a way for the driver to return a WRONG answer, or to spend
// a whole deadline and then blame the wrong thing. None of them needs a browser
// to reproduce, which is the point of keeping the turn logic pure.

test('with no busy signal, a pause between tokens does not end the turn', () => {
  // The failure this prevents: nothing on the page ever reports "generating" -
  // the site renamed its stop button, or every candidate was screened out as
  // always-true - so `!busy` is permanently true. One repeated read then ends
  // the turn at the first pause, and the answer is returned truncated. It is
  // still valid JSON, so nothing downstream notices.
  const streamed = 'the first half of the answer';
  let state = INITIAL_POLL_STATE;
  let reads = 0;

  // The model pauses. The text repeats, again and again, and it must NOT count
  // as finished while there is no busy signal to corroborate it.
  for (let i = 0; i < STABLE_READS_WITHOUT_BUSY_SIGNAL; i += 1) {
    const outcome = poll(state, streamed, false, STABLE_READS_WITHOUT_BUSY_SIGNAL);
    state = outcome.state;
    reads += 1;
    assert.equal(outcome.done, null, `read ${reads} must not be taken as the finished answer`);
  }

  // The rest of the answer arrives, which is what the pause was hiding.
  const whole = `${streamed}, and the second half`;
  state = poll(state, whole, false, STABLE_READS_WITHOUT_BUSY_SIGNAL).state;
  for (let i = 0; i < STABLE_READS_WITHOUT_BUSY_SIGNAL - 1; i += 1) {
    state = poll(state, whole, false, STABLE_READS_WITHOUT_BUSY_SIGNAL).state;
  }
  assert.equal(
    poll(state, whole, false, STABLE_READS_WITHOUT_BUSY_SIGNAL).done,
    whole,
    'once it really has stopped changing, the WHOLE answer is returned'
  );
});

test('a trusted busy signal still ends the turn on one repeat', () => {
  // The corollary: raising the bar must not slow down the ordinary case. Once
  // the stop control has actually been seen, its absence is evidence and one
  // repeat is enough.
  let state = poll(INITIAL_POLL_STATE, 'done', true, STABLE_READS_WITH_BUSY_SIGNAL).state;
  state = poll(state, 'done', false, STABLE_READS_WITH_BUSY_SIGNAL).state;
  assert.equal(poll(state, 'done', false, STABLE_READS_WITH_BUSY_SIGNAL).done, 'done');
  assert.ok(
    STABLE_READS_WITHOUT_BUSY_SIGNAL > STABLE_READS_WITH_BUSY_SIGNAL,
    'the blind rule must be the stricter one'
  );
});

test('an echo is recognised after the editor has curled its punctuation', () => {
  // `composerHolds` already folds punctuation; `isEcho` did not, so a page
  // handing the prompt straight back failed to match its own first 80
  // characters and the echo was returned as the answer.
  const sent = 'Rewrite this resume - keep the "impact" bullets - and return JSON...';
  const asRendered = 'Rewrite this resume – keep the “impact” bullets – and return JSON…';
  assert.equal(isEcho(sent, asRendered), true);
  assert.equal(isEcho(sent, 'Here is the tailored resume you asked for.'), false);
});

test('a usage wall is told apart from a slow answer, and from a signed-out tab', () => {
  const wall = refusalReason("You've reached your usage limit. It resets at 3:00 PM.");
  assert.ok(wall, 'a usage wall must be recognised');
  assert.equal(wall.retryable, true, 'a limit resets on its own, so the call is worth retrying');

  const signedOut = refusalReason('Log in to continue your conversation.');
  assert.ok(signedOut);
  assert.equal(signedOut.retryable, false, 'a signed-out tab needs a person, not a retry');

  const captcha = refusalReason('Verify you are human to continue.');
  assert.ok(captcha);
  assert.equal(captcha.retryable, false);

  // And it must not fire on an answer that happens to discuss the subject,
  // which is exactly what a resume-tailoring prompt might.
  assert.equal(
    refusalReason('The candidate raised the rate limit on the payments API by 40%.'),
    null
  );
});

test('a lookalike host is not adopted as the site tab', () => {
  // What gets typed into the tab this picks is a resume and a job description.
  assert.equal(matchesHost('claude.ai', 'claude.ai'), true);
  assert.equal(matchesHost('www.claude.ai', 'claude.ai'), true);
  assert.equal(matchesHost('notclaude.ai', 'claude.ai'), false);
  assert.equal(matchesHost('claude.ai.example.com', 'claude.ai'), false);
  assert.equal(matchesHost('', 'claude.ai'), false);
  assert.equal(hostOf('file:///tmp/x.html'), '', 'a file URL has no host to compare');
});

// A ChatPage that answers from a script, so the tab's own decisions can be
// driven without a browser.
//
// The clock ticks on every read the tab makes, not on a timer: the turn's own
// pace is what advances it, so these tests are deterministic and take no real
// time at all - and a turn that stops making progress runs out of budget
// instead of hanging the suite.
function fakePage(script) {
  const state = {
    url: script.url ?? 'https://claude.ai/new',
    typed: '',
    reads: 0,
    now: 0,
  };
  const tick = () => {
    state.reads += 1;
    state.now += script.msPerRead ?? 500;
    if (script.onRead) script.onRead(state);
  };
  return {
    state,
    now: () => state.now,
    currentUrl: () => state.url,
    activate: async () => {},
    goto: async (url) => {
      state.url = url;
    },
    count: async (selector) => {
      tick();
      return script.present(selector, state) ? 1 : 0;
    },
    click: async () => {},
    focus: async () => {},
    clearFocused: async () => {
      state.typed = '';
    },
    insertText: async (text) => {
      state.typed += text;
    },
    pressEnter: async () => {},
    readText: async () => state.typed,
    visibleText: async () => (script.visibleText ? script.visibleText(state) : ''),
    messages: async (selector) => {
      tick();
      return script.messages(selector, state);
    },
  };
}

const FAKE_SITE = {
  id: 'claude-web',
  label: 'Claude (browser)',
  url: 'https://claude.ai/new',
  host: 'claude.ai',
  composer: ['#composer'],
  send: ['#send'],
  // Ordered specific-first, exactly as the real site's list is - which is what
  // makes the winning candidate able to change in the middle of a turn.
  assistant: ['div[data-is-streaming]', 'div.font-claude-message'],
  busy: ['#stop'],
  newChat: [],
  messageIdAttr: null,
  nudge: '',
};

function tabFor(page, options = {}) {
  return new ChatTab(page, FAKE_SITE, {
    pollMs: 1,
    actionMs: 50,
    sleep: () => Promise.resolve(),
    now: page.now,
    log: () => {},
    ...options,
  });
}

test('the assistant selector is fixed for the turn, not re-resolved each poll', async () => {
  // A site mid-redesign, which is the situation the candidate lists exist for:
  // the two greeting messages already on screen are rendered by the OLD
  // component and match only the broad candidate, while the reply arrives from
  // the NEW one and matches both.
  //
  // The opening read therefore counts 2 against the broad candidate. Re-resolve
  // per poll and the specific candidate - which is first in the list and now
  // matches the reply - wins every later look and reports ONE node. One is
  // never more than two, so the answer sitting on screen is never picked up and
  // the turn spends its whole budget. The count and the list have to come from
  // the same selector.
  const SPECIFIC = 'div[data-is-streaming]';
  const BROAD = 'div.font-claude-message';
  const greeting = [
    { id: null, text: 'How can I help you today?' },
    { id: null, text: 'Tell me what you are working on.' },
  ];
  const reply = { id: null, text: 'the real answer' };

  const page = fakePage({
    present: (selector, state) => {
      if (selector === '#composer' || selector === '#send') return true;
      // The reply has begun to render.
      const replying = state.reads > 6;
      if (selector === '#stop') return replying && state.reads < 14;
      // The old greetings do not carry the streaming attribute at all, so this
      // candidate matches nothing until the new-style reply appears.
      if (selector === SPECIFIC) return replying;
      return true;
    },
    messages: (selector, state) => {
      const replying = state.reads > 6;
      if (selector === SPECIFIC) return replying ? [reply] : [];
      return replying ? [...greeting, reply] : [...greeting];
    },
  });

  assert.equal(
    await tabFor(page).ask('tailor this resume', 600_000),
    'the real answer',
    'a candidate winning the lookup mid-turn must not change which list is counted'
  );
});

test('a tab navigated away mid-answer fails at once rather than at the deadline', async () => {
  const page = fakePage({
    present: (selector) => selector === '#composer' || selector === '#send',
    // The operator clicks a link in the tab while it is answering.
    onRead: (state) => {
      if (state.reads > 6) state.url = 'https://mail.example.com/inbox';
    },
    messages: () => [],
  });

  await assert.rejects(tabFor(page).ask('tailor this resume', 600_000), (error) => {
    assert.equal(error.kind, 'page', 'a tab that left is not a slow answer');
    assert.match(error.message, /navigated to https:\/\/mail\.example\.com/);
    assert.ok(page.state.now < 60_000, 'it must not sit there for the whole deadline');
    return true;
  });
});

test('a usage wall is reported as a refusal, not as a broken selector', async () => {
  const page = fakePage({
    present: (selector) => selector === '#composer' || selector === '#send',
    messages: () => [],
    visibleText: () => "You've reached your usage limit. It resets at 3:00 PM.",
  });

  await assert.rejects(tabFor(page).ask('tailor this resume', 600_000), (error) => {
    assert.equal(error.kind, 'refused');
    assert.equal(error.retryable, true, 'a limit resets on its own; the call is worth retrying');
    assert.match(error.message, /usage limit/);
    return true;
  });
});

test('a deadline with no assistant node ever seen says so, and names the selectors', async () => {
  // The three timeout cases want three different things done about them, and
  // one message for all of them sent every one to go and check the selectors.
  const page = fakePage({
    present: (selector) => selector === '#composer' || selector === '#send',
    messages: () => [],
  });

  await assert.rejects(tabFor(page).ask('x', 8_000), (error) => {
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /none of its assistant selectors/);
    assert.match(error.message, /data-is-streaming/, 'the operator needs to see what was tried');
    return true;
  });
});

test('a deadline with the selector matching blames the send, not the selector', async () => {
  const page = fakePage({
    present: () => true,
    // The node is there and always has been: nothing NEW ever arrives, which is
    // what a send that did not land looks like.
    messages: () => [{ id: null, text: 'How can I help you today?' }],
  });

  await assert.rejects(tabFor(page).ask('x', 8_000), (error) => {
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /rendered no new message/);
    assert.match(error.message, /may not have been sent/);
    return true;
  });
});

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FREE_CHAT_ROUTES,
  HYBRID_MODEL_ID,
  isFreeChatRoute,
  isFailoverKind,
  noteFreeChatAttempt,
  noteFreeChatFailure,
  noteFreeChatSuccess,
  planRoute,
  describeFreeChatRouting,
  resetFreeChatRoutingForTests,
} = require('../dist/services/ai/freeChatRouting');

test.beforeEach(() => resetFreeChatRoutingForTests());

test('the three routes are the ones a profile can be set to', () => {
  assert.deepEqual([...FREE_CHAT_ROUTES], ['claude-only', 'chatgpt-only', 'hybrid']);
  assert.ok(isFreeChatRoute('hybrid'));
  assert.ok(!isFreeChatRoute('both'), 'an unknown value must not be honoured as a route');
});

test('a single-account route names exactly that account', () => {
  // Picking one is a statement about which account to spend. Quietly reaching
  // for the other would empty an allowance the person deliberately kept back.
  assert.deepEqual(planRoute('claude-only'), ['claude-web']);
  assert.deepEqual(planRoute('chatgpt-only'), ['chatgpt-web']);
});

test('hybrid alternates, so two allowances last twice as long', () => {
  // The whole point. One tailoring run is three calls and a batch of ten
  // profiles is thirty; sending them all to whichever account answered first
  // hits the same usage wall as a single-account route, just as fast.
  const clock = () => 1_000;
  const first = planRoute('hybrid', clock)[0];
  noteFreeChatAttempt(first, clock);
  const second = planRoute('hybrid', clock)[0];
  assert.notEqual(second, first, 'the next call must go to the other account');

  noteFreeChatAttempt(second, clock);
  assert.equal(planRoute('hybrid', clock)[0], first, 'and then back again');
});

test('an account that ran out of messages is passed over, not dropped', () => {
  let now = 0;
  const clock = () => now;

  noteFreeChatAttempt('chatgpt-web', clock);
  noteFreeChatFailure('claude-web', 'rateLimited', 'Message limit reached', clock);

  // Least-recently-used would have picked Claude here; the wall outranks that.
  assert.equal(planRoute('hybrid', clock)[0], 'chatgpt-web');
  assert.deepEqual(
    planRoute('hybrid', clock),
    ['chatgpt-web', 'claude-web'],
    'the walled account stays in the plan as the last resort'
  );

  now = 60 * 60_000;
  assert.equal(planRoute('hybrid', clock)[0], 'claude-web', 'the wall lifts on its own');
});

test('both accounts cold still produces a plan rather than a refusal', () => {
  // The ordinary state of an account that ran out an hour ago and a browser
  // that is not open yet. The cooldowns are guesses; the site is the only thing
  // that actually knows, so the call goes out.
  const clock = () => 0;
  noteFreeChatFailure('claude-web', 'rateLimited', 'out of messages', clock);
  noteFreeChatFailure('chatgpt-web', 'unavailable', 'no browser', clock);
  assert.equal(planRoute('hybrid', clock).length, 2);
});

test('an answer clears the account cooldown', () => {
  const clock = () => 0;
  noteFreeChatFailure('claude-web', 'auth', 'signed out', clock);
  assert.equal(planRoute('hybrid', clock)[0], 'chatgpt-web');
  noteFreeChatSuccess('claude-web');
  noteFreeChatAttempt('chatgpt-web', clock);
  assert.equal(planRoute('hybrid', clock)[0], 'claude-web');
});

test('only a failure of the ACCOUNT moves the call to the other one', () => {
  // A prompt that came back unparseable, a caller that cancelled, or a budget
  // already spent would fail identically on the second account - and the retry
  // would consume whatever time the first attempt left.
  for (const kind of ['rateLimited', 'auth', 'unavailable', 'locked', 'disabled']) {
    assert.ok(isFailoverKind(kind), `${kind} is the other account's problem to solve`);
  }
  for (const kind of ['timeout', 'truncated', 'stalled', 'failed', 'invalidRequest']) {
    assert.ok(!isFailoverKind(kind), `${kind} would fail the same way twice`);
  }
});

test('a failure that says nothing about the account sets no cooldown', () => {
  const clock = () => 0;
  noteFreeChatAttempt('claude-web', clock);
  noteFreeChatFailure('claude-web', 'truncated', 'the answer was cut off', clock);
  assert.equal(
    describeFreeChatRouting(clock).find((entry) => entry.site === 'claude-web').cooldownUntil,
    null,
    'a bad answer is not a reason to stop using an account'
  );
});

test('the routing report says which account is being passed over and why', () => {
  const clock = () => 0;
  noteFreeChatFailure('chatgpt-web', 'rateLimited', "You've reached our limit of messages", clock);
  const report = describeFreeChatRouting(clock);
  const chatgpt = report.find((entry) => entry.site === 'chatgpt-web');
  assert.equal(chatgpt.label, 'ChatGPT (free)');
  assert.ok(chatgpt.cooldownUntil, 'an operator has to be able to see why calls stopped going there');
  assert.match(chatgpt.cooldownReason, /limit of messages/);
});

test('the hybrid id is reserved and is not a provider id', () => {
  // It must never be mistaken for a model row: an admin editing or deleting
  // such a row would leave every profile that picked it pointing at nothing.
  assert.equal(HYBRID_MODEL_ID, 'free-hybrid');
});

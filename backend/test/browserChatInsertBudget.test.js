const assert = require('node:assert/strict');
const test = require('node:test');

const {
  insertBudgetMs,
  wrapPuppeteerPage,
} = require('../dist/services/ai/providers/browserChat/page');

// The connection is opened with `protocolTimeout: 30_000`, and that cap applies
// per COMMAND to every command alike - a number sized for a DOM read, which is
// milliseconds. Typing a prompt is not a DOM read: `Input.insertText` returns
// only once the page has finished reacting to it, and both chat sites react a
// great deal (a beforeinput handler, a rich-text model rebuilt from the new
// value, a React render, a token estimate over the whole composer).
//
// That is exactly what the field report described: the first call of a session
// worked and the second did not. The job-analysis prompt is only the job
// description; the tailoring prompt is the profile, the analysis and the keyword
// lists together, and the site's per-input work on it crosses 30 seconds.

test('the insert budget is far above the connection-wide protocol cap', () => {
  const CONNECTION_CAP_MS = 30_000;
  // Measured: `Input.insertText` of 64KB into a plain textarea takes 32ms, so
  // the size is never the cost - the page's handlers are. The budget is
  // therefore mostly a floor, and the floor alone has to clear the cap.
  assert.ok(
    insertBudgetMs(0) > CONNECTION_CAP_MS,
    'even an empty insert must not be judged by a number meant for a DOM read'
  );
  const realPrompt = insertBudgetMs(27_000);
  assert.ok(realPrompt > insertBudgetMs(2_000), 'a bigger prompt gets a bigger budget');
  assert.ok(realPrompt > 2 * CONNECTION_CAP_MS, 'and a real tailoring prompt gets a lot more');
});

test('the budget is capped, so a wedged page still fails rather than hanging', () => {
  // Unbounded, a pathological prompt would buy a wedged tab an unbounded hold on
  // the operator's browser - and the tab lease with it, which queues every later
  // request behind it.
  const huge = insertBudgetMs(100_000_000);
  assert.ok(huge <= 240_000, 'the budget must stop growing somewhere');
  assert.equal(huge, insertBudgetMs(200_000_000), 'and stay there');
});

// A puppeteer Page stands in for the real one: what is under test is the two
// arguments this wrapper passes to CDP, which no fake at the ChatPage level can
// see - that interface has no timeout in it at all.
function fakePuppeteerPage(onSend) {
  return {
    url: () => 'https://chatgpt.com/',
    createCDPSession: async () => ({
      send: async (method, params, options) => onSend(method, params, options),
      detach: async () => {},
    }),
    keyboard: { press: async () => {} },
  };
}

test('the insert carries its own timeout rather than inheriting the connection cap', async () => {
  const calls = [];
  const page = wrapPuppeteerPage(
    fakePuppeteerPage((method, params, options) => {
      calls.push({ method, options });
    })
  );

  const prompt = 'x'.repeat(27_000);
  await page.insertText(prompt);

  assert.deepEqual(calls.map((c) => c.method), ['Input.insertText']);
  assert.equal(
    calls[0].options?.timeout,
    insertBudgetMs(prompt.length),
    'without this third argument the command is cancelled at 30s mid-type'
  );
});

test('clearing the composer carries a timeout too', async () => {
  // Same rebuild running backwards, and on the same path: the driver clears
  // before it types, so a clear cut off at the cap fails the turn just as surely.
  const calls = [];
  const page = wrapPuppeteerPage(
    fakePuppeteerPage((method, params, options) => {
      calls.push({ method, options });
    })
  );

  await page.clearFocused();

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(
      (call.options?.timeout ?? 0) > 30_000,
      `${call.method} must not inherit the connection cap either`
    );
  }
});

test('a timeout is reported in terms of the page, not of puppeteer', async () => {
  // Puppeteer's own message ends "Increase the 'protocolTimeout' setting in
  // launch/connect calls", which is advice for whoever wrote this file and is
  // useless to the operator reading a failed generation. By the time this budget
  // is gone the page really is not keeping up, and what they can do about it is
  // on the page.
  const page = wrapPuppeteerPage(
    fakePuppeteerPage(() => {
      throw new Error(
        "Input.insertText timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed."
      );
    })
  );

  await assert.rejects(page.insertText('a prompt'), (error) => {
    assert.doesNotMatch(error.message, /protocolTimeout/, 'that is not theirs to change');
    assert.match(error.message, /did not finish accepting the prompt/);
    assert.match(error.message, /reload/i, 'it must say what to do about it');
    return true;
  });
});

test('a failure that is not a timeout is passed through untouched', async () => {
  // Rewriting every error as "the page is too busy" would bury the real one.
  const original = new Error('Session closed. Most likely the page has been closed.');
  const page = wrapPuppeteerPage(
    fakePuppeteerPage(() => {
      throw original;
    })
  );

  await assert.rejects(page.insertText('a prompt'), (error) => error === original);
});

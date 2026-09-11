const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const puppeteer = require('puppeteer');
const { launchBrowser } = require('../dist/config/browser');
const { wrapPuppeteerPage } = require('../dist/services/ai/providers/browserChat/page');
const { ChatTab } = require('../dist/services/ai/providers/browserChat/tab');
const { readChatSite } = require('../dist/services/ai/providers/browserChat/sites');
const {
  BrowserChatSession,
} = require('../dist/services/ai/providers/browserChat/session');

/**
 * The driver against a real browser.
 *
 * The pure rules are covered in browserChat.test.js; what is left is everything
 * that only fails against an actual page - CDP text insertion, reading a
 * contenteditable back, clicking through a shadowed candidate list, and a reply
 * that arrives a chunk at a time. None of that can be checked against the real
 * sites in a test, so a fixture page with claude.ai's shape stands in. It is a
 * stand-in for the MARKUP only: every line of driver code runs for real.
 */

const FIXTURE = `file://${path.join(__dirname, 'fixtures', 'fakeChat.html')}`;
const SITE = readChatSite('claude-web', {});

function fixture(query = '') {
  return query ? `${FIXTURE}?${query}` : FIXTURE;
}

function words(value) {
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * What the page should report seeing.
 *
 * The prompt plus the site's nudge, because every send appends one - that is
 * what keeps a long answer out of the canvas or artifacts panel, where this
 * driver could not read it. Asserting the sum rather than a constant checks
 * both halves arrived.
 */
function expectedWords(prompt) {
  return words(prompt) + words(SITE.nudge);
}

/** The site, pointed at the fixture instead of claude.ai. */
function siteAt(query = '') {
  return { ...SITE, url: fixture(query) };
}

async function withPage(query, run) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(fixture(query), { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

test('a full turn: type, send, wait out the stream, read the whole answer', async () => {
  await withPage('chunks=5&delay=40', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('chunks=5&delay=40'), { pollMs: 50 });
    const prompt = 'How many words is this prompt?';
    const answer = await tab.ask(prompt, 20_000);

    // The fixture's reply is bounded by markers, so a truncated read - the
    // failure the two-stable-reads rule exists to prevent - is visible rather
    // than merely shorter.
    assert.match(answer, /^ANSWER-START/, 'the answer must start at the beginning');
    assert.match(answer, /ANSWER-END$/, 'a reply taken mid-stream would end early');
    assert.match(
      answer,
      new RegExp(`You sent ${expectedWords(prompt)} words\\.`),
      'the prompt and the appended nudge must both reach the page intact'
    );
  });
});

test('a multi-line prompt goes in whole, and no newline submits it early', async () => {
  // Typing this would send the first line on its own. That is why insertText
  // exists, and it is worth a test of its own: every prompt this app sends is
  // many lines long.
  const prompt = ['First line.', '', 'Third line with a "quote" - and a dash.', 'Last line.'].join('\n');
  await withPage('chunks=2&delay=30', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('chunks=2&delay=30'), { pollMs: 50 });
    const answer = await tab.ask(prompt, 20_000);
    assert.match(answer, /ANSWER-END$/);

    // One user turn, not four.
    const userTurns = await page.$$eval('.user-message', (nodes) => nodes.length);
    assert.equal(userTurns, 1, 'a newline must not have submitted the prompt early');
  });
});

test('a large prompt survives insertion', async () => {
  // A resume plus a job description is tens of KB. CDP insertText has no
  // documented cap, but "no documented cap" is not the same as tested.
  const big = `Tailor this resume.\n\n${'x'.repeat(60_000)}`;
  await withPage('chunks=2&delay=30', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('chunks=2&delay=30'), { pollMs: 50 });
    const answer = await tab.ask(big, 30_000);
    assert.match(answer, /ANSWER-END$/);
  });
});

test('a reply node that renders before any text does not finish the turn early', async () => {
  await withPage('empty=1&chunks=3&delay=40', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('empty=1&chunks=3&delay=40'), {
      pollMs: 30,
    });
    const answer = await tab.ask('hello', 20_000);
    assert.match(answer, /ANSWER-START.*ANSWER-END/s, 'an empty node must not read as a finished answer');
  });
});

test('a stop control that lingers past the last chunk still yields the whole answer', async () => {
  await withPage('chunks=3&delay=30&linger=400', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('chunks=3&delay=30&linger=400'), {
      pollMs: 40,
    });
    const answer = await tab.ask('hello there', 20_000);
    assert.match(answer, /ANSWER-END$/);
  });
});

test('a page whose assistant selector matches the user turn is refused, not answered', async () => {
  // The total failure: without this the app tailors a resume to its own
  // instructions and reports success.
  await withPage('echo=1&chunks=2&delay=30', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('echo=1&chunks=2&delay=30'), {
      pollMs: 40,
      log: () => {},
    });
    await assert.rejects(
      () => tab.ask('Tailor this resume for the job description below.', 15_000),
      (error) => error.kind === 'echo'
    );
  });
});

test('a page that never answers fails on the deadline instead of hanging', async () => {
  await withPage('silent=1', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('silent=1'), { pollMs: 50 });
    const startedAt = process.hrtime.bigint();
    await assert.rejects(
      () => tab.ask('anything', 1_500),
      (error) => error.kind === 'timeout' && /no reply/i.test(error.message)
    );
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(elapsedMs < 8_000, `the deadline must bound the turn, took ${Math.round(elapsedMs)}ms`);
  });
});

test('a busy selector that matches an idle page is screened out', async () => {
  await withPage('', async (page) => {
    const site = {
      ...siteAt(''),
      // `#transcript` is always present: exactly the always-true candidate that
      // would otherwise make every reply look unfinished forever.
      busy: ['#transcript', 'button[aria-label="Stop response"]'],
    };
    const messages = [];
    const tab = new ChatTab(wrapPuppeteerPage(page), site, {
      pollMs: 40,
      log: (message) => messages.push(message),
    });
    const usable = await tab.screenBusySelectors();
    assert.deepEqual(usable, ['button[aria-label="Stop response"]']);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /#transcript/);

    // And with it screened, a turn still completes.
    assert.match(await tab.ask('hello', 20_000), /ANSWER-END$/);
  });
});

test('a second turn starts a fresh conversation rather than reading the first answer', async () => {
  await withPage('chunks=2&delay=30', async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt('chunks=2&delay=30'), { pollMs: 40 });
    const firstPrompt = 'one two three';
    const secondPrompt = 'one two three four five';

    const first = await tab.ask(firstPrompt, 20_000);
    assert.match(first, new RegExp(`You sent ${expectedWords(firstPrompt)} words\\.`));

    const second = await tab.ask(secondPrompt, 20_000);
    assert.match(
      second,
      new RegExp(`You sent ${expectedWords(secondPrompt)} words\\.`),
      'the second turn returned the first turn\'s answer'
    );

    const turns = await page.$$eval('.user-message', (nodes) => nodes.length);
    assert.equal(turns, 1, 'each turn must start from an empty transcript');
  });
});

test('the session attaches to a browser started with a debug port, and leaves it open', async () => {
  // The whole premise of the provider: it never launches a browser, it attaches
  // to one the operator started and signed in to.
  const owned = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--remote-debugging-port=0'],
  });
  try {
    const endpoint = owned.wsEndpoint();
    // puppeteer.connect takes the ws endpoint directly; the session takes a
    // browserURL, so drive it through the same path the provider uses by
    // handing it the http origin the browser is listening on.
    const httpEndpoint = `http://${new URL(endpoint).host}`;
    const page = await owned.newPage();
    await page.goto(fixture('chunks=2&delay=30'), { waitUntil: 'load' });

    const session = new BrowserChatSession(httpEndpoint, { pollMs: 40 });
    try {
      const site = siteAt('chunks=2&delay=30');
      const probe = await session.probe(site);
      assert.equal(probe.ok, true, `probe should find the composer: ${probe.detail}`);

      const tab = await session.tabFor(site);
      assert.match(await tab.ask('probe prompt here', 20_000), /ANSWER-END$/);
    } finally {
      await session.dispose();
    }

    // dispose() must DISCONNECT, never close: the browser belongs to the
    // operator and is probably still in use.
    assert.equal(owned.connected, true, 'the operator browser must still be running');
    assert.ok((await owned.pages()).length > 0);
  } finally {
    await owned.close();
  }
});

test('an unreachable debug browser reports how to start one', async () => {
  // Port 1 is reserved and never listening.
  const session = new BrowserChatSession('http://127.0.0.1:1', {});
  const probe = await session.probe(siteAt(''));
  assert.equal(probe.ok, false);
  // The launcher first, because it is now the only thing that starts these -
  // the app never does - and an operator reading this hint should be told the
  // command rather than left to assemble the flags themselves.
  assert.match(probe.hint || '', /npm run browser:debug/);
  // The raw flags stay underneath it, for a browser on a different machine.
  assert.match(probe.hint || '', /--remote-debugging-port/);
  assert.match(probe.hint || '', /user-data-dir/);
});

test('a chat tab in the background is brought forward, not waited on forever', async () => {
  // The bug this pins, found end to end rather than by reading: Chrome FREEZES
  // background tabs, and a frozen renderer never answers a DevTools evaluate.
  // The first DOM read then blocks - not slowly, indefinitely - so a turn that
  // takes 1.7s in a foreground tab had not returned after 45s once a second tab
  // was opened in front of it. And this app opens exactly that second tab: it
  // preflights the OTHER browser provider at startup.
  const browser = await launchBrowser();
  try {
    const chat = await browser.newPage();
    await chat.goto(fixture('chunks=3&delay=40'), { waitUntil: 'load' });

    // Push the chat tab into the background, as the second provider does.
    const other = await browser.newPage();
    await other.goto('about:blank', { waitUntil: 'load' });

    const tab = new ChatTab(wrapPuppeteerPage(chat), siteAt('chunks=3&delay=40'), { pollMs: 50 });
    const startedAt = process.hrtime.bigint();
    const answer = await tab.ask('still reachable?', 30_000);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.match(answer, /ANSWER-END$/);
    assert.ok(elapsedMs < 15_000, `a backgrounded tab must not stall the turn, took ${Math.round(elapsedMs)}ms`);
  } finally {
    await browser.close();
  }
});

test('a turn cannot outlive its deadline even if the page stops answering', async () => {
  // The loop stops at the deadline, but a single CDP call can block past it.
  // The contract is that a completion never outlives its budget, so the turn is
  // raced against the deadline as a whole.
  const stalled = {
    currentUrl: () => 'about:blank',
    activate: () => new Promise(() => {}), // never settles, as a frozen tab does
    goto: async () => {},
    count: async () => 0,
    click: async () => {},
    focus: async () => {},
    clearFocused: async () => {},
    insertText: async () => {},
    pressEnter: async () => {},
    readText: async () => '',
    messages: async () => [],
  };
  const tab = new ChatTab(stalled, siteAt(''), { pollMs: 50 });
  const startedAt = process.hrtime.bigint();
  await assert.rejects(
    () => tab.ask('anything', 1_200),
    (error) => error.kind === 'timeout' && /stopped responding/i.test(error.message)
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  // Deadline plus the guard's grace, and nothing like the 180s a blocked
  // DevTools call would otherwise take.
  assert.ok(elapsedMs < 12_000, `the guard must fire, took ${Math.round(elapsedMs)}ms`);
});

test('with no stop button on the page, a pause mid-answer does not truncate the reply', async () => {
  // The whole completion rule rests on the site telling us when it is
  // generating. Here nothing does - `?nostop=1` stands in for a site that
  // renamed its stop control, which is the case the candidate lists exist to
  // survive - so `!busy` is permanently true and the only remaining evidence is
  // that the text stopped changing.
  //
  // `?pause` then stalls before the final chunk, which is what a model thinking
  // mid-answer looks like from outside. Because this app's replies are JSON,
  // an answer taken during that pause still parses, so nothing downstream would
  // have caught it.
  //
  // The pause has to land in a window, and the arithmetic is worth writing down
  // because a change to any of these constants silently stops the test testing
  // anything. With no busy signal the turn first spends BUSY_WATCH_MS (1500ms)
  // looking for one, so polling starts at ~1500ms and the pause must still be
  // running then. After that, at a 200ms poll:
  //
  //   the OLD one-repeat rule would finish at ~1500 + 2*200 = 1900ms
  //   the rule under test finishes at    ~1500 + 9*200 = 3300ms
  //
  // The last chunk must therefore arrive between those: after 1900ms so the old
  // rule truncates, before 3300ms so this one does not. The three 30ms chunks
  // put the pause's start at ~90ms, so a 2500ms pause lands the tail at
  // ~2590ms - about 700ms clear of each bound.
  const query = 'nostop=1&chunks=4&delay=30&pause=2500';
  await withPage(query, async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt(query), { pollMs: 200 });
    const prompt = 'How many words is this prompt?';
    const answer = await tab.ask(prompt, 30_000);

    assert.match(answer, /ANSWER-START/, 'the answer must start where the fixture says it does');
    assert.match(
      answer,
      /ANSWER-END$/,
      'the tail after the pause is the part a one-repeat rule loses'
    );
    assert.match(answer, new RegExp(`You sent ${expectedWords(prompt)} words`));
  });
});

test('a usage wall is reported as a refusal rather than polled until the deadline', async () => {
  const query = 'wall=1';
  await withPage(query, async (page) => {
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt(query), {
      pollMs: 50,
      // The refusal check waits out a settling period before it reads the page,
      // so the clock is driven rather than waited on. Real browser, real DOM,
      // scripted time.
      now: (() => {
        let value = 0;
        return () => (value += 400);
      })(),
    });

    await assert.rejects(tab.ask('tailor this resume', 600_000), (error) => {
      assert.equal(error.kind, 'refused');
      assert.equal(error.retryable, true);
      assert.match(error.message, /usage limit/);
      return true;
    });
  });
});

test('the page text is read from the END, where a banner sits below the prompt', async () => {
  // This one has to run against a real browser, because the thing being tested
  // lives in the puppeteer wrapper: every fake ChatPage does its own slicing,
  // so a fake can never catch the wrapper reading from the wrong end.
  //
  // And reading from the wrong end is not a near miss. A real tailoring prompt
  // measures about 27,000 characters of resume and job description, so a window
  // taken from the front closes some 21,000 characters before the prompt even
  // ends - it holds nothing but this app's own text, which is then filtered out
  // as already known. The refusal check could not fire at all.
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const prompt = 'Tailor this resume. ' + 'Delivered payments infrastructure at scale. '.repeat(600);
    const banner = "You've reached your usage limit. It resets at 3:00 PM.";
    await page.setContent(`<body><div>${prompt}</div><div>${banner}</div></body>`);

    const chat = wrapPuppeteerPage(page);
    const WINDOW = 6_000;
    const tail = await chat.visibleTailText(WINDOW);

    assert.ok(prompt.length > 20_000, 'the point of the test is that a real prompt is long');
    assert.ok(tail.length <= WINDOW, 'the window must still be capped');
    assert.match(tail.trim(), /usage limit\. It resets at 3:00 PM\.$/, 'the banner must be in it');
    assert.doesNotMatch(tail.slice(0, 40), /^Tailor this resume/, 'and not the head of the page');
  } finally {
    await browser.close();
  }
});

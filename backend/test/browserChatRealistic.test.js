const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { launchBrowser } = require('../dist/config/browser');
const { wrapPuppeteerPage } = require('../dist/services/ai/providers/browserChat/page');
const { ChatTab } = require('../dist/services/ai/providers/browserChat/tab');
const { readChatSite } = require('../dist/services/ai/providers/browserChat/sites');

/**
 * The driver against a page that behaves like the REAL chat sites.
 *
 * browserChatLive.test.js drives a plain contenteditable with an always-enabled
 * button, and every one of its cases passed while the feature did not work at
 * all against claude.ai and chatgpt.com. The difference is not the markup, it is
 * the BEHAVIOUR: both sites keep the send button disabled until their framework
 * notices the composer has content, and both composers are rich editors that
 * own their content and re-render it.
 *
 * The failure that hid behind that gap was total and silent. A click on a
 * disabled button is not an error - Chrome dispatches no event and puppeteer
 * returns happily - so the driver typed the prompt, sent nothing, and then
 * polled for a reply that could never arrive, ending on the deadline with
 * "showed no reply, and none of its assistant selectors matched": a message
 * that sends the operator to fix selectors which were never the problem.
 */

const FIXTURE = `file://${path.join(__dirname, 'fixtures', 'realisticChat.html')}`;
const SITE = readChatSite('claude-web', {});

function siteAt(query) {
  return { ...SITE, url: `${FIXTURE}?${query}` };
}

async function withTab(query, run) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`${FIXTURE}?${query}`, { waitUntil: 'load' });
    const logs = [];
    const tab = new ChatTab(wrapPuppeteerPage(page), siteAt(query), {
      pollMs: 50,
      log: (message) => logs.push(message),
    });
    await run({ tab, page, logs });
  } finally {
    await browser.close();
  }
}

/** What the fixture records about what actually happened to it. */
function trace(page) {
  return page.evaluate(() => window.__trace);
}

test('a send button that enables a moment late still sends', async () => {
  // The real case, and the one that was broken: React re-enables the button
  // after the input event, and the driver used to click during that gap. 1.2s
  // is ordinary for a page under load.
  await withTab('chunks=3&delay=30&disabled=1&enablems=1200', async ({ tab, page }) => {
    const answer = await tab.ask('How many words is this prompt?', 25_000);
    assert.match(answer, /ANSWER-END$/);
    const seen = await trace(page);
    assert.equal(seen.sends, 1, 'exactly one send, and it happened');
    assert.equal(seen.clicksWhileDisabled, 0);
  });
});

test('a send button that never enables falls back to Enter', async () => {
  // The button is the broken part; Enter still submits. Pressing it costs
  // nothing when a site ignores it and rescues the turn when it does not.
  await withTab(
    'chunks=3&delay=30&disabled=1&enablems=99000&enteralways=1',
    async ({ tab, page }) => {
      const answer = await tab.ask('How many words is this prompt?', 25_000);
      assert.match(answer, /ANSWER-END$/);
      const seen = await trace(page);
      assert.equal(seen.sends, 1);
      assert.ok(seen.enters >= 1, 'the fallback was used');
    }
  );
});

test('no send control at all is not fatal', async () => {
  await withTab('chunks=3&delay=30&nobutton=1', async ({ tab }) => {
    const answer = await tab.ask('How many words is this prompt?', 25_000);
    assert.match(answer, /ANSWER-END$/);
  });
});

test('a prompt that cannot be sent says so, instead of blaming the reply selectors', async () => {
  // The whole point. Before, this ended on the deadline with "showed no reply,
  // and none of its assistant selectors matched" - true, useless, and pointing
  // at the wrong file. The failure is that nothing sent the prompt.
  await withTab(
    'chunks=3&delay=30&disabled=1&enablems=99000&enterguard=1',
    async ({ tab, page }) => {
      await assert.rejects(
        () => tab.ask('How many words is this prompt?', 20_000),
        (error) => {
          assert.match(error.message, /nothing sent it/i, 'names the step that failed');
          assert.match(error.message, /send control/i, 'and the control that failed');
          assert.match(error.message, /browser:doctor/, 'and how to diagnose it');
          assert.doesNotMatch(
            error.message,
            /assistant selector/i,
            'must not blame the reply selectors for a send that never happened'
          );
          return true;
        }
      );
      assert.equal((await trace(page)).sends, 0, 'nothing was sent, which is what it reported');
    }
  );
});

test('a rich editor that drops the first insert is recovered, not failed', async () => {
  // A composer that owns its content re-renders on input, and a re-render
  // leaves Blink's editing context stale - so the NEXT `Input.insertText`
  // silently does nothing at all. Measured: no `beforeinput` is fired and the
  // box stays empty. Re-focusing re-establishes it, which is exactly what the
  // retype attempt does, so the turn survives an editor this hostile.
  const prompt = ['First line.', '', 'Third line with a "quote" - and a dash.', 'Last.'].join('\n');
  await withTab('chunks=3&delay=30&rich=1', async ({ tab, page }) => {
    const answer = await tab.ask(prompt, 25_000);
    assert.match(answer, /ANSWER-END$/);
    // One turn, not one per line: the newlines must not have submitted early.
    const turns = await page.$$eval('.user-message', (nodes) => nodes.length);
    assert.equal(turns, 1);
  });
});

test('a rich editor and a late send button together still complete a turn', async () => {
  await withTab('chunks=3&delay=30&rich=1&disabled=1&enablems=800', async ({ tab, page }) => {
    const answer = await tab.ask('How many words is this prompt?', 25_000);
    assert.match(answer, /ANSWER-END$/);
    assert.equal((await trace(page)).sends, 1);
  });
});

test('a composer that never takes the prompt reports what it actually contains', async () => {
  // Two failed attempts used to end at "does not hold the prompt as typed,
  // twice over" - which leaves the operator with nowhere to go. Saying what is
  // in the box names the problem: empty means the text never arrived.
  await withTab('chunks=3&delay=30&frozen=1', async ({ tab }) => {
    await assert.rejects(
      () => tab.ask('How many words is this prompt?', 20_000),
      (error) => {
        assert.match(error.message, /did not hold the prompt/i);
        assert.match(error.message, /empty|contains/i, 'says what the box actually held');
        return true;
      }
    );
  });
});

/**
 * The five defects an adversarial diagnosis found after the send fix landed.
 *
 * Two of them return a WRONG ANSWER rather than failing, which is the worst
 * shape a bug in this driver can take: nothing downstream can tell a tailored
 * resume from a resume tailored to the instructions.
 */

const { isEcho, pickReply } = require('../dist/services/ai/providers/browserChat/conversation');

test('a hidden duplicate of the send control does not make the real one look dead', async () => {
  // Both sites ship a mobile and a desktop copy of the composer controls, one
  // hidden. Judging only the FIRST match called the candidate unusable and the
  // driver then waited out its whole 10s enable budget on a button that was
  // ready from the start - or failed naming the send role, which was fine.
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<button aria-label="Send message" style="display:none"></button>' +
        '<button aria-label="Send message">Send</button>'
    );
    const chat = wrapPuppeteerPage(page);
    assert.equal(await chat.count('button[aria-label="Send message"]'), 2);
    assert.equal(
      await chat.isActionable('button[aria-label="Send message"]'),
      true,
      'a clickable match behind a hidden one still makes the candidate usable'
    );

    // And the click has to land on the one that was judged, not on the first.
    await page.evaluate(() => {
      window.hits = 0;
      document.querySelectorAll('button')[1].addEventListener('click', () => (window.hits += 1));
    });
    await chat.click('button[aria-label="Send message"]', 5_000);
    assert.equal(await page.evaluate(() => window.hits), 1, 'the visible button was clicked');
  } finally {
    await browser.close();
  }
});

test('the echo guard survives a label above the prompt', () => {
  // A prefix test is defeated by anything the site puts above the user's text
  // inside a turn group - an author label, a timestamp, an Edit control - and
  // both sites put something there. What that costs is not a missed warning:
  // the guard passes and the PROMPT is returned as the answer.
  const prompt = 'Tailor this resume for a Senior Backend Engineer role at Fixture Co.';
  for (const chrome of ['', 'You\n', '2:14 PM\n', 'You\nEdit\n']) {
    assert.equal(isEcho(prompt, `${chrome}${prompt} ...and then an answer`), true, `chrome: ${JSON.stringify(chrome)}`);
  }
  // And a real answer is still not an echo.
  assert.equal(isEcho(prompt, 'Here is the tailored resume you asked for.'), false);
});

test('the reply latch holds when the site inserts a node above the answer', async () => {
  // claude.ai publishes no per-message id, so every id came back null and the
  // latch was dead code for it: pickReply re-picked BY POSITION every poll, and
  // a reasoning panel appearing above the answer became the completion. The
  // driver now tags the nodes itself.
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id=t><div class=m>the prompt</div><div class=m>ANSWER one</div></div>');
    const chat = wrapPuppeteerPage(page);

    const first = await chat.messages('.m', null);
    assert.ok(first.every((message) => message.id), 'a site with no id attribute still gets identity');
    const picked = pickReply({ count: 1, lastId: null }, first, null);
    assert.equal(picked.reply.text, 'ANSWER one');

    await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.className = 'm';
      panel.textContent = 'Thought for 4 seconds';
      const list = document.getElementById('t');
      list.insertBefore(panel, list.children[1]);
    });

    const second = await chat.messages('.m', null);
    const again = pickReply({ count: 1, lastId: null }, second, picked.id);
    assert.equal(again.reply.text, 'ANSWER one', 'the latch, not the position, decides');
  } finally {
    await browser.close();
  }
});

test('a click in a tab the browser is not showing is bounded, not left hanging', async () => {
  // handle.click() takes no timeout of its own, so it was capped only by the
  // connection-wide protocol timeout - and in a tab that is not visible it does
  // not return at all. Measured: every read came back in milliseconds and the
  // click threw after 30s. startFreshConversation clicks first thing in a turn,
  // so unbounded it eats the whole budget before anything else is tried.
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="go">Go</button>');
    const hidden = await browser.newPage();
    await hidden.bringToFront();

    const chat = wrapPuppeteerPage(page);
    const started = Date.now();
    try {
      await chat.click('#go', 2_000);
    } catch {
      // Either outcome is acceptable; what matters is that it RETURNED.
    }
    const took = Date.now() - started;
    assert.ok(took < 10_000, `a click must not outlive its budget - took ${took}ms`);
  } finally {
    await browser.close();
  }
});

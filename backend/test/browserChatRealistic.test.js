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

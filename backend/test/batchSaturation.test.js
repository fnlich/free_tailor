const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * Ten resumes, five browsers: five run, five queue, and no browser sits idle.
 *
 * The arrangement the whole batch path exists for, and the one that is easy to
 * get almost right. Three things have to hold together and each fails silently
 * on its own:
 *
 *   - the batch offers five at once, not one and not fifty;
 *   - the pool never hands the same browser to two calls;
 *   - a browser that finishes takes the next queued task immediately, rather
 *     than waiting for the rest of its wave.
 *
 * The last one is what a naive implementation gets wrong - `Promise.all` over
 * chunks of five looks identical until one task in a chunk is slow, and then
 * four browsers idle until it finishes. Nothing about that is visible from the
 * page; the batch just takes twice as long.
 */

const BROWSERS = 5;
const TASKS = 10;

async function setUp(name) {
  const { staticDir } = useTempStorage(name);
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'Analyze this.\n[[jobDescription]]',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const config = loadFresh('../dist/config/aiModelConfig');
  await config.updateAppSettings({
    browserChatEndpoints: Array.from({ length: BROWSERS }, (_, index) => ({
      siteId: 'claude-web',
      port: 9600 + index,
    })),
  });

  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  const { createBrowserChatAdapter } = loadFresh('../dist/services/ai/providers/browserChat');
  return { ai, config, createBrowserChatAdapter };
}

/**
 * Watches which browsers are in use and for how long.
 *
 * Each task holds its browser until released by hand, so the test drives the
 * timing rather than racing it - a sleep-based version of this passes on a fast
 * machine and fails on a loaded one.
 */
function tracker() {
  const busy = new Set();
  const order = [];
  let peak = 0;
  const pending = new Map();

  return {
    order,
    get peak() {
      return peak;
    },
    get inFlight() {
      return busy.size;
    },
    sessionFor(endpoint) {
      return {
        tabFor: async () => ({
          ask: async () => {
            assert.ok(!busy.has(endpoint), `${endpoint} was handed to two calls at once`);
            busy.add(endpoint);
            peak = Math.max(peak, busy.size);
            order.push(endpoint);
            await new Promise((resolve) => pending.set(endpoint, resolve));
            busy.delete(endpoint);
            return 'the answer';
          },
        }),
        probe: async () => ({ ok: true, detail: 'stub' }),
        dispose: async () => {},
      };
    },
    /** Lets one in-flight task finish. */
    finishOne() {
      const [endpoint, resolve] = [...pending.entries()][0] ?? [];
      if (!endpoint) return null;
      pending.delete(endpoint);
      resolve();
      return endpoint;
    },
    get started() {
      return order.length;
    },
  };
}

function askOn(adapter) {
  return adapter.complete({
    modelName: 'chat',
    stableSystem: '',
    volatileSystem: '',
    userBody: 'a prompt',
    responseFormat: 'text',
    sampling: {},
    deadline: { totalMs: 600_000, remainingMs: () => 600_000, expired: () => false },
    callSite: 'analyze-job-description',
  });
}

/** Lets every already-scheduled microtask and timer callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('five browsers take five tasks at once, and no more', async () => {
  const { createBrowserChatAdapter } = await setUp('saturate-width');
  const watch = tracker();
  const adapter = createBrowserChatAdapter('claude-web', { sessionFor: watch.sessionFor });

  const running = Array.from({ length: TASKS }, () => askOn(adapter));
  await settle();

  assert.equal(watch.inFlight, BROWSERS, 'every browser must be working');
  assert.equal(watch.started, BROWSERS, 'and nothing beyond them may start');
  assert.equal(new Set(watch.order).size, BROWSERS, 'each task got a browser of its own');

  // Drain, letting one finish at a time.
  for (let done = 0; done < TASKS; done += 1) {
    watch.finishOne();
    await settle();
  }
  const results = await Promise.all(running);
  assert.equal(results.length, TASKS);
  assert.equal(watch.peak, BROWSERS, 'never more than five at once');
});

test('a browser that finishes takes the next queued task at once', async () => {
  // The property a chunked `Promise.all` does not have. With ten tasks and five
  // browsers, freeing ONE browser must start ONE task - not wait for the other
  // four to finish their wave first.
  const { createBrowserChatAdapter } = await setUp('saturate-handoff');
  const watch = tracker();
  const adapter = createBrowserChatAdapter('claude-web', { sessionFor: watch.sessionFor });

  const running = Array.from({ length: TASKS }, () => askOn(adapter));
  await settle();
  assert.equal(watch.started, BROWSERS);

  const freed = watch.finishOne();
  await settle();

  assert.equal(watch.started, BROWSERS + 1, 'the sixth task started the moment a browser freed');
  assert.equal(watch.inFlight, BROWSERS, 'and the freed browser is busy again, not idle');
  assert.equal(watch.order[BROWSERS], freed, 'on the very browser that freed up');

  for (let done = 0; done < TASKS; done += 1) {
    watch.finishOne();
    await settle();
  }
  await Promise.all(running);
});

test('all ten finish, and every browser did a share of the work', async () => {
  // Ten tasks over five browsers is two apiece. An implementation that queued
  // everything behind one browser would still return ten answers - it would
  // just take five times as long, which no assertion on the RESULTS can see.
  const { createBrowserChatAdapter } = await setUp('saturate-share');
  const watch = tracker();
  const adapter = createBrowserChatAdapter('claude-web', { sessionFor: watch.sessionFor });

  const running = Array.from({ length: TASKS }, () => askOn(adapter));
  for (let done = 0; done < TASKS; done += 1) {
    await settle();
    watch.finishOne();
  }
  await settle();
  const results = await Promise.all(running);

  assert.equal(results.length, TASKS);
  assert.ok(
    results.every((result) => result.text === 'the answer'),
    'every task has to succeed'
  );
  assert.equal(new Set(watch.order).size, BROWSERS, 'all five browsers were used');
  for (const endpoint of new Set(watch.order)) {
    const share = watch.order.filter((entry) => entry === endpoint).length;
    assert.equal(share, TASKS / BROWSERS, `${endpoint} ran ${share} of the ${TASKS} tasks`);
  }
});

test('the batch asks for exactly five, because that is what five browsers can take', async () => {
  // The other half of the arrangement: the fan-out the route chooses. Offering
  // one would leave four browsers idle; offering fifty would pile forty-five
  // calls into a queue nobody can see, each waiting out its own budget.
  const { config } = await setUp('saturate-capacity');
  const { resolveBatchCapacity } = loadFresh('../dist/services/ai/batchCapacity');
  const capacity = await resolveBatchCapacity({ provider: 'claude-web' }, {});
  assert.equal(capacity.limit, BROWSERS);
  assert.match(capacity.reason, /5 claude-web/);
  assert.ok(config, 'settings were written');
});

test('a walled browser does not cost the batch a worker', async () => {
  // The two behaviours together, which is where a batch really lands: ten tasks,
  // five browsers, one of them out of messages. The walled one is passed over
  // and left out, the other four keep pulling from the queue, and all ten
  // finish - rather than one in five failing for a reason that has nothing to
  // do with that resume.
  const { createBrowserChatAdapter } = await setUp('saturate-with-a-wall');
  const { ChatTurnError } = require('../dist/services/ai/providers/browserChat/tab');
  const watch = tracker();
  const WALLED = 'http://127.0.0.1:9602';

  const adapter = createBrowserChatAdapter('claude-web', {
    sessionFor: (endpoint) =>
      endpoint === WALLED
        ? {
            tabFor: async () => ({
              ask: async () => {
                const error = new ChatTurnError('refused', 'the message limit was reached', true);
                error.sent = false;
                throw error;
              },
            }),
            probe: async () => ({ ok: true, detail: 'stub' }),
            dispose: async () => {},
          }
        : watch.sessionFor(endpoint),
  });

  const running = Array.from({ length: TASKS }, () => askOn(adapter));
  for (let done = 0; done < TASKS + 2; done += 1) {
    await settle();
    watch.finishOne();
  }
  await settle();

  const results = await Promise.all(running);
  assert.equal(results.length, TASKS, 'all ten resumes are generated');
  assert.ok(results.every((result) => result.text === 'the answer'));
  assert.equal(
    watch.order.includes(WALLED),
    false,
    'the walled browser never does work; the other four carry it'
  );
  assert.ok(watch.peak <= BROWSERS - 1, 'four workers, since one browser is out');
});

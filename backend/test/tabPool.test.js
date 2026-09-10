const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TabPool,
  NoTabsConfiguredError,
  TabWaitAbortedError,
  TabWaitTimeoutError,
  getTabPool,
  resetTabPoolsForTests,
} = require('../dist/services/ai/providers/browserChat/pool');

/**
 * The line for a free provider's chat tabs.
 *
 * Three things have to hold, and each of them is a way the free providers would
 * otherwise be wrong: one call per tab, because two prompts in one composer
 * interleave and both answers are lost; strictly first-come-first-served, so a
 * batch cannot starve a single request behind it; and no length limit at all -
 * a call is refused for running out of its own time, never for being late in
 * the queue.
 */

const A = 'http://127.0.0.1:9222';
const B = 'http://127.0.0.1:9223';

function poolOf(...endpoints) {
  const pool = new TabPool('Claude (free)');
  pool.setEndpoints(endpoints);
  return pool;
}

test('a tab is handed to one call at a time', async () => {
  const pool = poolOf(A);
  const first = await pool.acquire();
  assert.equal(first.endpoint, A);
  assert.equal(pool.inUse, 1);

  let secondGotIt = false;
  const second = pool.acquire().then((lease) => {
    secondGotIt = true;
    return lease;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondGotIt, false, 'the second call must wait, not share the tab');
  assert.equal(pool.queued, 1);

  first.release();
  const lease = await second;
  assert.equal(lease.endpoint, A, 'and it gets the tab that freed');
  lease.release();
});

test('two browsers run two calls at once - that is what a second one buys', async () => {
  const pool = poolOf(A, B);
  const first = await pool.acquire();
  const second = await pool.acquire();
  assert.notEqual(first.endpoint, second.endpoint, 'each call gets a tab of its own');
  assert.equal(pool.inUse, 2);
  assert.equal(pool.queued, 0);
  first.release();
  second.release();
});

test('the queue is first-come-first-served, and the freed tab goes to its head', async () => {
  const pool = poolOf(A);
  const held = await pool.acquire();

  const order = [];
  const waiters = ['first', 'second', 'third'].map((name) =>
    pool.acquire().then((lease) => {
      order.push(name);
      return lease;
    })
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.queued, 3);

  // Release one at a time so each hand-off is observed rather than raced.
  let current = held;
  for (let i = 0; i < waiters.length; i += 1) {
    current.release();
    current = await waiters[i];
  }
  current.release();

  assert.deepEqual(order, ['first', 'second', 'third'], 'the longest wait is served first');
});

test('the queue has no length limit', async () => {
  // The point of the design: a 200-profile batch queues 200 calls and every one
  // of them is served in turn. Nothing is refused for being late in the line.
  const pool = poolOf(A);
  const held = await pool.acquire();
  const waiting = Array.from({ length: 200 }, () => pool.acquire());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.queued, 200);

  held.release();
  let served = 0;
  for (const pending of waiting) {
    const lease = await pending;
    served += 1;
    lease.release();
  }
  assert.equal(served, 200);
});

test('a call gives up on its own clock, not on the queue length', async () => {
  const pool = poolOf(A);
  const held = await pool.acquire();
  await assert.rejects(pool.acquire({ timeoutMs: 20 }), (error) => {
    assert.ok(error instanceof TabWaitTimeoutError);
    assert.match(error.message, /No Claude \(free\) tab became free/);
    return true;
  });
  assert.equal(pool.queued, 0, 'and it leaves the line when it goes');
  held.release();
});

test('a cancelled call leaves the line without disturbing it', async () => {
  const pool = poolOf(A);
  const held = await pool.acquire();
  const controller = new AbortController();
  const cancelled = pool.acquire({ signal: controller.signal });
  const after = pool.acquire();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.queued, 2);
  controller.abort();
  await assert.rejects(cancelled, (error) => error instanceof TabWaitAbortedError);
  assert.equal(pool.queued, 1, 'the call behind it keeps its place');

  held.release();
  (await after).release();
});

test('a provider with no browser says so rather than waiting for one', async () => {
  const pool = new TabPool('ChatGPT (free)');
  pool.setEndpoints([]);
  await assert.rejects(pool.acquire({ timeoutMs: 5_000 }), (error) => {
    assert.ok(error instanceof NoTabsConfiguredError);
    assert.match(error.message, /No browser is configured for ChatGPT \(free\)/);
    return true;
  });
});

test('a browser added while calls are waiting starts serving them at once', async () => {
  const pool = poolOf(A);
  const held = await pool.acquire();
  const waiting = pool.acquire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.queued, 1);

  // The whole reason to add one is that the calls already in the line get
  // served sooner - it must not take a release to notice.
  pool.setEndpoints([A, B]);
  const lease = await waiting;
  assert.equal(lease.endpoint, B);
  lease.release();
  held.release();
});

test('a browser removed while in use is not handed out again', async () => {
  const pool = poolOf(A, B);
  const onB = await pool.acquire();
  const onA = await pool.acquire();
  const inUse = onB.endpoint === B ? onB : onA;
  const other = inUse === onB ? onA : onB;

  // Dropping it from the configuration must not hand it to somebody else while
  // the call still holds it - that is the one thing this pool exists to prevent.
  pool.setEndpoints([A].filter((endpoint) => endpoint !== inUse.endpoint));
  const next = pool.acquire();
  inUse.release();
  other.release();

  const lease = await next;
  assert.notEqual(lease.endpoint, inUse.endpoint, 'a removed browser is never handed out');
  lease.release();
});

test('each site has its own pool, so they never wait for one another', () => {
  resetTabPoolsForTests();
  const claude = getTabPool('claude-web', 'Claude (free)');
  const chatgpt = getTabPool('chatgpt-web', 'ChatGPT (free)');
  assert.notEqual(claude, chatgpt);
  assert.equal(getTabPool('claude-web', 'Claude (free)'), claude, 'and the pool persists');
  resetTabPoolsForTests();
});

test('a browser known to be down is not handed out while a healthy one is merely busy', async () => {
  // The bug this pins, found by running it rather than by reading it: the
  // fallback "if no reachable browser is FREE, hand out a down one anyway"
  // fires when the healthy browsers are simply in use. A caller retrying past
  // a dead browser is then handed the same dead browser again, every time, and
  // the retry cannot work. Four of six requests failed that way.
  const pool = poolOf(A, B);
  pool.markUnreachable(B, 60_000);

  // A is healthy and taken; B is down. The next call must WAIT for A, not be
  // given B.
  const onA = await pool.acquire();
  assert.equal(onA.endpoint, A);

  let handed = null;
  const next = pool.acquire().then((lease) => {
    handed = lease.endpoint;
    return lease;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handed, null, 'it must queue rather than take the browser known to be down');
  assert.equal(pool.queued, 1);

  onA.release();
  const lease = await next;
  assert.equal(lease.endpoint, A, 'and it gets the healthy one when it frees');
  lease.release();
});

test('when every browser is down, one is tried anyway rather than waiting forever', async () => {
  // The other half of the same decision. "Down" is an observation from a moment
  // ago; if there is nothing else to try, trying it and reporting what went
  // wrong beats hanging on a stale note.
  const pool = poolOf(A, B);
  pool.markUnreachable(A, 60_000);
  pool.markUnreachable(B, 60_000);

  const lease = await pool.acquire({ timeoutMs: 200 });
  assert.ok([A, B].includes(lease.endpoint));
  lease.release();
});

test('a browser marked down is tried again once its rest is over', async () => {
  let now = 1_000;
  const pool = new TabPool('Claude (free)', () => now);
  pool.setEndpoints([A, B]);
  pool.markUnreachable(B, 30_000);

  const first = await pool.acquire();
  assert.equal(first.endpoint, A, 'the healthy one while B is resting');
  first.release();

  now += 30_001;
  const held = await pool.acquire();
  assert.equal(held.endpoint, A);
  const second = await pool.acquire();
  assert.equal(second.endpoint, B, 'B is back in rotation once its rest has passed');
  held.release();
  second.release();
});

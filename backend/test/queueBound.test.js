const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AsyncSemaphore,
  SemaphoreQueueFullError,
  getProviderSemaphore,
  resetSemaphoresForTests,
} = require('../dist/services/ai/concurrency');

/**
 * The length of the line, as distinct from how many may run.
 *
 * Only the second was ever bounded. A provider that runs one call at a time
 * still has to decide what happens to the fortieth, and "wait, for as long as
 * your own deadline allows" means forty HTTP requests held open for minutes
 * each, every one of them finally failing on a clock rather than on anything
 * the caller could have acted on.
 */

test('a full queue is refused at once, not after waiting out a deadline', async () => {
  const semaphore = new AsyncSemaphore(1, 2);
  const release = await semaphore.acquire();

  // Two may wait.
  const first = semaphore.acquire();
  const second = semaphore.acquire();
  assert.equal(semaphore.queued, 2);

  // The third is told now.
  await assert.rejects(semaphore.acquire(), (error) => {
    assert.ok(error instanceof SemaphoreQueueFullError);
    assert.equal(error.maxQueued, 2);
    assert.match(error.message, /queue for this provider is full/);
    return true;
  });

  // And refusing it must not have disturbed the line.
  assert.equal(semaphore.queued, 2, 'a refused arrival must not evict anyone');

  release();
  (await first)();
  (await second)();
});

test('an unbounded lane still queues everything, as it did before', async () => {
  // The CLI provider spawns processes and its own limit already bounds the
  // work; this bound is for the lane with one tab behind it.
  const semaphore = new AsyncSemaphore(1);
  const release = await semaphore.acquire();
  const waiting = Array.from({ length: 50 }, () => semaphore.acquire());
  assert.equal(semaphore.queued, 50);
  release();
  for (const pending of waiting) (await pending)();
});

test('the bound can be changed on a lane that is already in use', async () => {
  // It is an admin setting, and the lane is created at first call and lives for
  // the process. Replacing the object on a change would strand every caller
  // already holding or waiting on the old one.
  resetSemaphoresForTests();
  const first = getProviderSemaphore('browser-chat:test', 1, 2);
  const release = await first.acquire();
  const queued = first.acquire();
  assert.equal(first.queueLimit, 2);

  const again = getProviderSemaphore('browser-chat:test', 1, 5);
  assert.equal(again, first, 'the same lane object must be handed back');
  assert.equal(again.queueLimit, 5, 'and it must carry the new bound');

  // Lowering it never evicts somebody already in line.
  getProviderSemaphore('browser-chat:test', 1, 1);
  assert.equal(first.queued, 1, 'the waiter already in line keeps its place');

  release();
  (await queued)();
  resetSemaphoresForTests();
});

test('a rejected arrival reports as rate limited, with what to do about it', async () => {
  const { acquireSlot } = require('../dist/services/ai/concurrency');
  const semaphore = new AsyncSemaphore(1, 1);
  const release = await semaphore.acquire();
  const queued = semaphore.acquire();

  const deadline = { remainingMs: () => 60_000, expired: () => false };
  await assert.rejects(acquireSlot(semaphore, 'claude-web', deadline, 60_000), (error) => {
    // Not 'unavailable'. The server is fine; this caller is behind too many
    // others, which is a different thing and has a different remedy.
    assert.equal(error.kind, 'rateLimited');
    assert.match(error.userMessage, /Claude \(browser\)/, 'it must name the provider');
    assert.match(error.userMessage, /queue limit/, 'and point at the setting that changes it');
    return true;
  });

  release();
  (await queued)();
});

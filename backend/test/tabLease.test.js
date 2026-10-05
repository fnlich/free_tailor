const assert = require('node:assert/strict');
const test = require('node:test');

const { LEASE_READER_LIFETIME_MS, TabLeases } = require('../dist/services/queue/tabLease');

/**
 * The tab lease on its own, with the clock in the test's hands.
 *
 * Generate Immediately stops when its tab is gone (owner decision B4) - but
 * "gone" has to survive a reload, a dropped connection and a phone that slept,
 * so a closed stream starts a grace rather than stopping anything. These pin
 * that a run is cancelled exactly when nobody came back inside the grace, and
 * never otherwise: a lease that cancelled too eagerly would throw away paid-for
 * work on every reload, and one that never cancelled would build for an empty
 * room. A reader counts by renewal: its hold lasts LEASE_READER_LIFETIME_MS,
 * and a page that is still there attaches again; so the readers below that
 * stay "attached" for longer than that renew, the way the page does. The
 * routes' half - who counts as a reader - is in immediateRuns.test.js.
 */

function harness({ graceMs = 30_000 } = {}) {
  const running = new Set();
  const cancelled = [];
  const logged = [];
  let grace = graceMs;
  const leases = new TabLeases({
    cancel: (batchId) => {
      cancelled.push(batchId);
      running.delete(batchId);
      return { cancelled: 1, aborted: 0 };
    },
    isRunning: (batchId) => running.has(batchId),
    graceMs: () => grace,
    log: (message) => logged.push(message),
  });
  return {
    leases,
    cancelled,
    logged,
    start: (batchId) => running.add(batchId),
    finish: (batchId) => running.delete(batchId),
    setGrace: (ms) => {
      grace = ms;
    },
  };
}

test('the last reader leaving starts the grace, and the run stops when it runs out', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  const letGo = h.leases.hold('bat_1');
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false });

  letGo();
  assert.deepEqual(h.leases.state('bat_1'), { readers: 0, armed: true });

  t.mock.timers.tick(29_999);
  assert.deepEqual(h.cancelled, [], 'not a moment early');
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancelled, ['bat_1']);
  assert.equal(h.leases.state('bat_1'), null, 'and the lease is gone with it');
  assert.match(h.logged[0], /bat_1 stopped/);
  assert.match(h.logged[0], /IMMEDIATE_TAB_GRACE_MS/);
});

test('a reader that comes back inside the grace keeps the run going', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  // A dropped connection: the old stream closes, the same tab's next opens.
  h.leases.hold('bat_1')();
  t.mock.timers.tick(20_000);
  const again = h.leases.hold('bat_1');
  t.mock.timers.tick(LEASE_READER_LIFETIME_MS - 1);
  assert.deepEqual(h.cancelled, [], 'the timer was stopped, not merely outlived');
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false });

  // And the grace starts again, in full, when that one goes too.
  again();
  t.mock.timers.tick(29_999);
  assert.deepEqual(h.cancelled, []);
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancelled, ['bat_1']);
});

test('only the LAST reader leaving counts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  // The page's reattach loop can overlap an old stream with a new one.
  const first = h.leases.hold('bat_1');
  const second = h.leases.hold('bat_1');
  first();
  t.mock.timers.tick(LEASE_READER_LIFETIME_MS - 1);
  assert.deepEqual(h.cancelled, []);
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false });

  second();
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.cancelled, ['bat_1']);
});

test('a reader is counted out once, however often its close fires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  const first = h.leases.hold('bat_1');
  h.leases.hold('bat_1');
  // An `end` followed by a `close` both reach the release.
  first();
  first();
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false }, 'the second reader still holds it');
  t.mock.timers.tick(LEASE_READER_LIFETIME_MS - 1);
  assert.deepEqual(h.cancelled, []);
});

test('armed with no reader at all, as at submit and after a restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_never');
  h.start('bat_late');

  // A tab that got its id and never attached.
  h.leases.arm('bat_never');
  // A tab that attaches inside the grace.
  h.leases.arm('bat_late');
  t.mock.timers.tick(15_000);
  h.leases.hold('bat_late');

  t.mock.timers.tick(15_000);
  assert.deepEqual(h.cancelled, ['bat_never']);
  assert.deepEqual(h.leases.state('bat_late'), { readers: 1, armed: false });
});

test('arming twice does not start a second timer, nor restart the first', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');
  h.leases.arm('bat_1');
  t.mock.timers.tick(20_000);
  h.leases.arm('bat_1');
  t.mock.timers.tick(10_000);
  assert.deepEqual(h.cancelled, ['bat_1'], 'thirty seconds from the FIRST arm');
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cancelled, ['bat_1'], 'and once');
});

test('a reader that never closes is counted out when its hold runs out, and the run stops after the grace', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  // A tab whose network vanished without a FIN or a reset: its connection
  // never closes, so its release is never called. Only the clock counts it out.
  let expired = 0;
  const letGo = h.leases.hold('bat_1', () => {
    expired += 1;
  });
  t.mock.timers.tick(LEASE_READER_LIFETIME_MS - 1);
  assert.equal(expired, 0);
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false });

  t.mock.timers.tick(1);
  assert.equal(expired, 1, 'the route is told to end the stream');
  assert.deepEqual(h.leases.state('bat_1'), { readers: 0, armed: true }, 'and the grace starts');

  // The connection's close, should it ever arrive, counts nobody out again.
  letGo();
  assert.deepEqual(h.leases.state('bat_1'), { readers: 0, armed: true });

  t.mock.timers.tick(29_999);
  assert.deepEqual(h.cancelled, []);
  t.mock.timers.tick(1);
  assert.deepEqual(h.cancelled, ['bat_1'], 'stopped within the lifetime plus the grace');
  assert.equal(expired, 1);
});

test('a page that keeps attaching again keeps its run for as long as it likes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  // What the page does: its stream is ended when the hold runs out, and it
  // attaches again a second later (lib/batchFollow REATTACH_MS).
  let following = true;
  let attaches = 0;
  const attach = () => {
    attaches += 1;
    h.leases.hold('bat_1', () => {
      if (following) setTimeout(attach, 1_000);
    });
  };
  // A second at a time: the mocked clock runs a timer set inside another
  // timer's callback only on a later tick.
  const seconds = (count) => {
    for (let i = 0; i < count; i += 1) t.mock.timers.tick(1_000);
  };
  attach();
  seconds(10 * 60);
  assert.deepEqual(h.cancelled, [], 'ten minutes of renewals stop nothing');
  assert.ok(attaches >= 25, `renewed every lifetime (${attaches} attaches)`);

  // Then the page goes without a word: the last hold runs out, then the grace.
  following = false;
  seconds((1_000 + LEASE_READER_LIFETIME_MS + 30_000) / 1_000);
  assert.deepEqual(h.cancelled, ['bat_1']);
});

test("an expired reader's late release never counts another reader out", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');

  const old = h.leases.hold('bat_1');
  t.mock.timers.tick(10_000);
  h.leases.hold('bat_1');
  // The first hold runs out; the second, ten seconds younger, still holds.
  t.mock.timers.tick(LEASE_READER_LIFETIME_MS - 10_000);
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false });
  // Its connection's close arrives late: nothing changes.
  old();
  assert.deepEqual(h.leases.state('bat_1'), { readers: 1, armed: false });
  assert.deepEqual(h.cancelled, []);
});

test('release stops the run at once, and nothing fires later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');
  h.leases.hold('bat_1')();

  assert.deepEqual(h.leases.release('bat_1'), { cancelled: 1, aborted: 0 });
  assert.deepEqual(h.cancelled, ['bat_1']);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cancelled, ['bat_1'], 'the grace timer was cleared, not left to fire on a dead run');

  // A run that already finished has nothing to release.
  h.start('bat_2');
  h.finish('bat_2');
  assert.equal(h.leases.release('bat_2'), null);
  assert.deepEqual(h.cancelled, ['bat_1']);
});

test('a run that finished is never cancelled by its lease', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');
  h.leases.hold('bat_1')();
  // It finished during the grace: the queue's batchFinished hook forgets it.
  h.finish('bat_1');
  h.leases.forget('bat_1');
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cancelled, []);

  // And one that finished without being forgotten is re-checked at expiry.
  h.start('bat_2');
  h.leases.arm('bat_2');
  h.finish('bat_2');
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.cancelled, []);

  // Arming a finished run forgets it rather than timing anything.
  h.leases.arm('bat_2');
  assert.equal(h.leases.state('bat_2'), null);
});

test('the grace is read when the timer starts, so a changed setting applies to the next one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ graceMs: 30_000 });
  h.start('bat_1');
  h.setGrace(5_000);
  h.leases.arm('bat_1');
  t.mock.timers.tick(5_000);
  assert.deepEqual(h.cancelled, ['bat_1']);
});

test('reset clears every timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.start('bat_1');
  h.leases.arm('bat_1');
  h.leases.reset();
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.cancelled, []);
  assert.equal(h.leases.state('bat_1'), null);
});

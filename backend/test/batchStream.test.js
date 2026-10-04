const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  BATCH_STREAM_HEARTBEAT_MS,
  openBatchStream,
} = require('../dist/routes/batchStream');

/**
 * The batch progress stream's keep-alive.
 *
 * Nothing is written between task events, and one resume can take minutes, so
 * a proxy that closes idle connections (60 s for nginx and AWS load balancers
 * by default) cut a healthy stream every time - and the page ran out of
 * reattaches and reported a running batch as finished. The stream now writes a
 * bare newline every 25 s, which the page's reader skips as a blank line.
 */

/** Just enough of an Express response for the stream: headers, writes, end and close. */
function fakeResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.writes = [];
  res.writableEnded = false;
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.flushHeaders = () => undefined;
  res.write = (chunk) => {
    assert.equal(res.writableEnded, false, 'nothing may be written after the response ended');
    res.writes.push(String(chunk));
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit('close');
  };
  return res;
}

test('a quiet stream writes a bare newline every heartbeat, and stops when it ends', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeResponse();
  const stream = openBatchStream(res, { heartbeatMs: 1_000 });

  assert.deepEqual(res.writes, [], 'nothing before the first beat');
  t.mock.timers.tick(1_000);
  assert.deepEqual(res.writes, ['\n']);
  t.mock.timers.tick(2_000);
  assert.deepEqual(res.writes, ['\n', '\n', '\n']);

  // A real line is a line of JSON, and the beat goes on around it.
  stream.send({ type: 'task', done: 1 });
  assert.equal(res.writes.at(-1), '{"type":"task","done":1}\n');

  stream.end();
  assert.equal(res.writableEnded, true);
  const written = res.writes.length;
  t.mock.timers.tick(10_000);
  assert.equal(res.writes.length, written, 'no beat after end()');
  // And a send after the end is a no-op, as it always was.
  stream.send({ type: 'task' });
  assert.equal(res.writes.length, written);
});

test('a reader that goes away stops the beat, without ending anything else', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeResponse();
  openBatchStream(res, { heartbeatMs: 1_000 });

  t.mock.timers.tick(1_000);
  assert.equal(res.writes.length, 1);

  // The browser closed the tab: the socket closes, the response never ended.
  res.emit('close');
  t.mock.timers.tick(5_000);
  assert.equal(res.writes.length, 1, 'no beat after the connection closed');
});

test('a response ended behind the stream\'s back is never written to', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeResponse();
  openBatchStream(res, { heartbeatMs: 1_000 });

  // Ended without a close event reaching the stream first.
  res.writableEnded = true;
  t.mock.timers.tick(3_000);
  assert.deepEqual(res.writes, []);
});

test('the default beat sits under the 60-second idle limit proxies ship with', () => {
  assert.equal(BATCH_STREAM_HEARTBEAT_MS, 25_000);
  assert.ok(BATCH_STREAM_HEARTBEAT_MS < 60_000);
});

test('the stream still declares itself NDJSON and unbuffered', () => {
  const res = fakeResponse();
  const stream = openBatchStream(res);
  assert.match(res.headers['content-type'], /^application\/x-ndjson/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.match(res.headers['cache-control'], /no-transform/);
  stream.end();
});

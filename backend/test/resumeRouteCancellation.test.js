const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE = path.join(__dirname, '..', 'src', 'routes', 'resume.ts');

/**
 * Every AI call in the route, with the arguments it was given.
 *
 * Read from the SOURCE rather than exercised through the route, because what
 * has to hold is a property of every call site including ones not yet written -
 * and the failure being guarded against is precisely somebody adding a seventh
 * call site and not thinking about cancellation. Driving the route would prove
 * it for whichever paths the test happened to take.
 */
function callsTo(source, name) {
  const calls = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`${name}(`, from);
    if (at === -1) return calls;
    from = at + name.length;
    // Skip the import and the declaration - only invocations carry arguments.
    const open = at + name.length;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push({
      line: source.slice(0, at).split('\n').length,
      args: source.slice(open + 1, end),
    });
    from = end;
  }
}

test('every AI call in the resume route can be cancelled by the caller going away', () => {
  // A reload of the builder page mid-generation closes the response, and
  // `requestSignal` aborts on that. A call that is not given the signal does not
  // stop: it keeps driving the operator's chat tab for the rest of its deadline,
  // holding the tab lease, so the request they make after reloading queues behind
  // an answer that can never be delivered.
  //
  // This was wrong in exactly the way that is easy to miss. Every short
  // `analyzeJobDescription` call was cancellable while five of the six long
  // `tailorResume` calls - minutes each, and the ones actually driving the
  // browser - were not.
  const source = fs.readFileSync(ROUTE, 'utf8');

  for (const name of ['tailorResume', 'generateCoverLetter', 'analyzeJobDescription']) {
    const calls = callsTo(source, name).filter((call) => call.args.trim().length > 0);
    assert.ok(calls.length > 0, `${name} should be called by this route`);
    for (const call of calls) {
      assert.match(
        call.args,
        /requestSignal\(req, res\)|\bsignal\b/,
        `${ROUTE}:${call.line} calls ${name} with no abort signal, so a reload cannot stop it`
      );
    }
  }
});

test('the signal is one controller per response, not one per call', () => {
  // Several of these call sites sit in a loop over profiles. A helper that made
  // a fresh controller each time would attach a listener per iteration and trip
  // Node's max-listeners warning, and - worse - only the last one would ever be
  // aborted.
  const source = fs.readFileSync(ROUTE, 'utf8');
  assert.match(source, /WeakMap<Response, AbortController>/);
  assert.match(source, /requestControllers\.get\(res\)/);
});

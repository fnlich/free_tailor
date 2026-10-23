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
  // stop: it keeps its seat process running for the rest of its deadline,
  // holding a concurrency slot, so the request they make after reloading queues
  // behind an answer that can never be delivered.
  //
  // This was wrong in exactly the way that is easy to miss. Every short
  // `analyzeJobDescription` call (the analysis, now `getOrCreateAnalysis` through
  // the gate) was cancellable while five of the six long
  // `tailorResume` calls - minutes each, and the ones actually holding a slot -
  // were not.
  const source = fs.readFileSync(ROUTE, 'utf8');

  // The cover letter is written by the queue's tasks now (the synchronous
  // /resume/generate is gone), but a call added here later must carry it too.
  const calledHere = ['tailorResume', 'getOrCreateAnalysis'];
  for (const name of ['tailorResume', 'generateCoverLetter', 'getOrCreateAnalysis']) {
    const calls = callsTo(source, name).filter((call) => call.args.trim().length > 0);
    if (calledHere.includes(name)) assert.ok(calls.length > 0, `${name} should be called by this route`);
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
  // Several of these call sites sit in a loop over resumes. A helper that made
  // a fresh controller each time would attach a listener per iteration and trip
  // Node's max-listeners warning, and - worse - only the last one would ever be
  // aborted. The helper lives in middleware/requestSignal.ts, shared with the
  // resume editor's Write with AI route (routes/resumes.ts), and this route
  // (routes/resume.ts) imports it.
  const route = fs.readFileSync(ROUTE, 'utf8');
  assert.match(route, /import \{ requestSignal \} from '\.\.\/middleware\/requestSignal'/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'requestSignal.ts'), 'utf8');
  assert.match(source, /WeakMap<Response, AbortController>/);
  assert.match(source, /requestControllers\.get\(res\)/);
});

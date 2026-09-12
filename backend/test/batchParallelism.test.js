const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE = path.join(__dirname, '..', 'src', 'routes', 'resume.ts');

/**
 * Every batch endpoint runs its items in parallel.
 *
 * Read from the SOURCE, like `resumeRouteCancellation`, because the property
 * has to hold for endpoints not yet written and the failure being guarded
 * against is somebody adding a seventh batch path as a `for ... await` loop -
 * which is exactly how the multi-job endpoint was written, and it is invisible
 * in the response: the results are identical, they just take ten times longer
 * and leave every browser but one idle for the whole run.
 */

function routeSource() {
  return fs.readFileSync(ROUTE, 'utf8');
}

test('no batch endpoint awaits an AI call inside a for-loop', () => {
  const source = routeSource();
  const lines = source.split('\n');

  // A `for` over the collections a batch iterates. One over a small fixed list
  // is fine; these three are the batch dimensions.
  const batchLoops = /for\s*\(\s*const\s+\w+\s+of\s+(profiles|normalizedJobs|validJobs|units)\b/;
  const offenders = [];

  lines.forEach((line, index) => {
    if (!batchLoops.test(line)) return;
    // How far the loop body runs: to the matching close of its own block.
    let depth = 0;
    let started = false;
    const body = [];
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const character of lines[cursor]) {
        if (character === '{') {
          depth += 1;
          started = true;
        } else if (character === '}') depth -= 1;
      }
      body.push(lines[cursor]);
      if (started && depth === 0) break;
    }
    const text = body.join('\n');
    for (const call of ['tailorResume(', 'generateCoverLetter(', 'analyzeJobDescription(']) {
      if (text.includes(`await ${call}`)) {
        offenders.push(`${ROUTE}:${index + 1} runs ${call} one at a time`);
      }
    }
  });

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('every batch endpoint takes its width from the chosen provider', () => {
  // Not from a constant. A fixed four queued three calls behind every answer on
  // a one-browser install and left four browsers idle on a six-browser one -
  // and neither is visible from the page.
  const source = routeSource();
  const fanOuts = [...source.matchAll(/mapWithConcurrency\(\s*[\w.]+\s*,\s*([^,]+),/g)].map(
    (match) => match[1].trim()
  );
  assert.ok(fanOuts.length >= 4, `expected every batch path to fan out, found ${fanOuts.length}`);
  for (const width of fanOuts) {
    assert.match(
      width,
      /[cC]apacity\.limit$/,
      `a batch runs ${width} wide instead of asking the provider what it can take`
    );
  }
});

test('nothing is left reading the removed fixed constant', () => {
  assert.doesNotMatch(
    routeSource(),
    /BATCH_AI_CONCURRENCY/,
    'the flat fan-out was replaced; a straggler reading it would be dead code'
  );
});

test('results are collected by input index, not completion order', () => {
  // `mapWithConcurrency` preserves the index and the page lists what comes
  // back. Pushing in completion order would reshuffle the list by how fast each
  // model call happened to be, so the same batch would read differently twice.
  const source = routeSource();
  const collectors = [...source.matchAll(/outcomes\.forEach\(\(outcome, index\)/g)];
  assert.ok(collectors.length >= 2, 'both generate paths must collect by index');
  assert.doesNotMatch(
    source,
    /outcomes\.forEach\(\(outcome\)\s*=>/,
    'a collector that ignores the index cannot restore input order'
  );
});

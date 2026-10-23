const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ROUTE = path.join(SRC, 'routes', 'resume.ts');

/**
 * Every batch endpoint runs its items in parallel.
 *
 * Read from the SOURCE, like `resumeRouteCancellation`, because the property
 * has to hold for endpoints not yet written and the failure being guarded
 * against is somebody adding another batch path as a `for ... await` loop -
 * which is exactly how the multi-posting analysis (removed since) was first
 * written, and it is invisible in the response: the results are identical,
 * they just take ten times longer and leave every slot on the seat but one
 * idle for the whole run.
 *
 * Since F2 (one profile per run) there is no per-resume fan-out in a route:
 * `/resume/preview-all` is gone, `/resume/preview` makes one call, and a run is
 * planned by `services/resumeChoice.ts` `planRun` (no model call) and then
 * handed to the queue, whose lanes are as wide as the provider's
 * `concurrency_max_requests`. So the guard reads every file a batch passes
 * through, not the one route, and it asserts the fan-outs it still knows.
 */

/** Every file a batch (a run, a sheet run, a report run, a preview) passes through, under src/. */
const BATCH_SOURCES = [
  'routes/resume.ts',
  'routes/generation.ts',
  'routes/jobs.ts',
  'services/resumeChoice.ts',
  'services/jobAnalysis/submit.ts',
  'services/jobLake/reportRun.ts',
  'services/queue/index.ts',
  'services/queue/resumeTask.ts',
];

function sourceOf(relative) {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function routeSource() {
  return fs.readFileSync(ROUTE, 'utf8');
}

/** Every .ts file under src/, as `[relative path, text]`. */
function allSources(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSources(full, found);
    else if (entry.name.endsWith('.ts')) found.push([path.relative(SRC, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]);
  }
  return found;
}

/**
 * Every `for ... of` loop (any variable, destructured or not, `for await` too)
 * whose body awaits an AI call, as `file:line runs call(` messages.
 *
 * ANY loop, whatever it iterates: the check used to name the collections a
 * batch iterates, and when the main one changed its name - with the route
 * holding no such loop to match either way - it went on passing, finding
 * nothing to look at. A loop over a small fixed list that awaits no model
 * call is not a finding, so naming the collection bought nothing.
 */
function loopsAwaitingAiCalls(source, label) {
  const lines = source.split('\n');
  const forOf = /for\s*(?:await\s*)?\(\s*(?:const|let|var)\s[^)]*?\bof\b/;
  const offenders = [];

  lines.forEach((line, index) => {
    if (!forOf.test(line)) return;
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
    for (const call of ['tailorResume(', 'generateCoverLetter(']) {
      if (text.includes(`await ${call}`)) {
        offenders.push(`${label}:${index + 1} runs ${call} one at a time`);
      }
    }
    // Any analyze* function (analyzeJobDescription and whatever replaces it).
    for (const match of text.matchAll(/await\s+(analy[sz]e\w*)\(/g)) {
      offenders.push(`${label}:${index + 1} runs ${match[1]}( one at a time`);
    }
    // The gate's call is an AI call unless it is `storedOnly` (a store lookup).
    if (/await\s+getOrCreateAnalysis\(/.test(text) && !/storedOnly:\s*true/.test(text)) {
      offenders.push(`${label}:${index + 1} runs getOrCreateAnalysis( one at a time`);
    }
  });
  return offenders;
}

/** The `file:line` of every for-of loop in a source: what the check above looked at. */
function forOfLoopLines(source) {
  const forOf = /for\s*(?:await\s*)?\(\s*(?:const|let|var)\s[^)]*?\bof\b/;
  return source
    .split('\n')
    .map((line, index) => (forOf.test(line) ? index + 1 : 0))
    .filter(Boolean);
}

test('no batch endpoint awaits an AI call inside a for-loop', () => {
  // The things the loop check is about are really there. A regex naming a word
  // the file no longer holds passes for ever (it did, after a rename, and again
  // when /resume/preview-all went), so each fan-out the code still has is
  // asserted by name before the loops are judged.
  const generation = sourceOf('routes/generation.ts');
  const choice = sourceOf('services/resumeChoice.ts');
  const queueIndex = sourceOf('services/queue/index.ts');
  const resumeTask = sourceOf('services/queue/resumeTask.ts');

  // (1) A run is planned for every job at once (no model call), then each
  // planned resume is a queued task - the queue is the fan-out, not a loop.
  assert.match(generation, /await planRun\(/, 'the run route plans every job through planRun');
  assert.match(generation, /descriptors\.push\(/, 'and turns each planned resume into a task for the queue');
  assert.doesNotMatch(generation, /await (tailorResume|generateCoverLetter)\(/, 'the route runs no model call of its own');
  assert.match(queueIndex, /concurrency_max_requests/, "each lane is as wide as its provider's limit");
  // (2) The model calls live in the task, which the queue runs in its lanes.
  assert.match(resumeTask, /await tailorResume\(/, 'the task tailors one resume');
  assert.match(resumeTask, /await generateCoverLetter\(/, 'and writes its cover letter');
  // (3) /resume/preview-all, the old per-resume fan-out, is gone for good.
  assert.doesNotMatch(routeSource(), /preview-all/, 'no route fans a preview out over resumes any more');
  assert.doesNotMatch(routeSource(), /mapWithConcurrency\(\s*resumes\b/);

  // The planning loop is the one loop a batch still has over its jobs. It must
  // be SEEN by the check below (a guard that sees no loop at all passes
  // silently) and must await nothing but the yield to the event loop.
  const loopLines = forOfLoopLines(choice);
  assert.ok(loopLines.length >= 1, 'the guard finds the planning loop in resumeChoice.ts');
  assert.match(choice, /for \(const \[jobIndex, job\] of jobs\.entries\(\)\)/, 'planRun walks the jobs in order');
  const planLoop = choice.slice(choice.indexOf('for (const [jobIndex, job] of jobs.entries())'), choice.indexOf('return plan;'));
  assert.deepEqual(
    [...planLoop.matchAll(/await\s+(\w+)/g)].map((match) => match[1]),
    ['yieldToEventLoop'],
    'planRun awaits only its yield: no model call, one at a time or otherwise'
  );

  const offenders = [];
  let loopsSeen = 0;
  for (const relative of BATCH_SOURCES) {
    const source = sourceOf(relative);
    loopsSeen += forOfLoopLines(source).length;
    offenders.push(...loopsAwaitingAiCalls(source, relative));
  }
  assert.ok(loopsSeen >= 3, `the guard looked at the batch paths' loops, found ${loopsSeen}`);
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the loop check finds an awaited AI call whatever the loop iterates, and nothing else', () => {
  // Pinned on its own, as a guard that misses a shape passes silently.
  const serial = [
    'for (const resume of resumes) {',
    '  const out = await tailorResume(resume, analysis);',
    '}',
    'for (const [index, job] of jobs.entries()) {',
    '  await generateCoverLetter(job);',
    '}',
    'for await (const item of stream) {',
    '  await analyzeJobDescription(item);',
    '}',
  ].join('\n');
  assert.equal(loopsAwaitingAiCalls(serial, 'x').length, 3);

  // Whatever the loop variable is called, and whichever analysis function.
  const renamed = [
    'for (const candidate of everyone) {',
    '  results.push(await tailorResume(candidate, analysis));',
    '}',
    'for (const row of rows) {',
    '  await analyzeJobPosting(row);',
    '}',
    'for (const row of rows) {',
    '  await getOrCreateAnalysis({ jd: row.text });',
    '}',
  ].join('\n');
  assert.equal(loopsAwaitingAiCalls(renamed, 'x').length, 3);
  // A gate call that only looks in the store is not an AI call.
  const stored = ['for (const job of jobs) {', '  await getOrCreateAnalysis({ jd: job.text, storedOnly: true });', '}'].join('\n');
  assert.deepEqual(loopsAwaitingAiCalls(stored, 'x'), []);
  assert.deepEqual(forOfLoopLines(serial), [1, 4, 7]);

  const fine = [
    'const outcomes = await mapWithConcurrency(resumes, capacity.limit, async (resume) => tailorResume(resume));',
    'for (const [index, outcome] of outcomes.entries()) {',
    '  previews.push(outcome);',
    '}',
    'for (const call of calls) { await save(call); }',
  ].join('\n');
  assert.deepEqual(loopsAwaitingAiCalls(fine, 'x'), []);
});

test('every batch endpoint takes its width from the chosen provider', () => {
  // Not from a constant. A fixed four queued three calls behind every answer on
  // a seat sized for one, and left eight slots idle on a seat sized for twelve -
  // and neither is visible from the page.
  //
  // F2 left no `mapWithConcurrency` in any route (preview-all, its only user,
  // is gone): generation goes through the queue, which sizes each lane from its
  // provider, and a posting is analysed through the gate. So the known fan-out
  // is asserted, and any `mapWithConcurrency` that is ever added anywhere in
  // src/ must still take its width from a provider's capacity.
  const queueIndex = sourceOf('services/queue/index.ts');
  assert.match(
    queueIndex,
    /slots:\s*Array\.from\(\{\s*length:\s*provider\.concurrency_max_requests\s*\}/,
    "a lane's slots are its provider's concurrency_max_requests, not a constant"
  );
  assert.match(sourceOf('routes/generation.ts'), /routeFor\(choice\)\.queue/, 'a task is queued on the lane of its chosen provider');

  const fanOuts = [];
  for (const [relative, source] of allSources()) {
    if (relative === 'services/ai/concurrency.ts') continue; // the helper itself
    for (const match of source.matchAll(/mapWithConcurrency\(\s*[\w.]+\s*,\s*([^,]+),/g)) {
      fanOuts.push([relative, match[1].trim()]);
    }
  }
  for (const [relative, width] of fanOuts) {
    assert.match(
      width,
      /[cC]apacity\.limit$/,
      `${relative}: a batch runs ${width} wide instead of asking the provider what it can take`
    );
  }
  // The pattern is not blind: it reads the shape the old routes used.
  const sample = 'await mapWithConcurrency(resumes, capacity.limit, async (resume) => tailor(resume));';
  assert.equal([...sample.matchAll(/mapWithConcurrency\(\s*[\w.]+\s*,\s*([^,]+),/g)][0][1].trim(), 'capacity.limit');
});

test('nothing is left reading the removed fixed constant', () => {
  for (const [relative, source] of allSources()) {
    assert.doesNotMatch(
      source,
      /BATCH_AI_CONCURRENCY/,
      `${relative}: the flat fan-out was replaced; a straggler reading it would be dead code`
    );
  }
});

test('results are collected by input index, not completion order', () => {
  // `mapWithConcurrency` preserves the index and the page lists what comes
  // back. Pushing in completion order would reshuffle the list by how fast each
  // model call happened to be, so the same batch would read differently twice.
  //
  // After F2 the batch paths that remain collect by index like this: the plan
  // (one item per job, `jobIndex` set from `jobs.entries()`), the tasks built
  // from it in plan order, and the report run's analyses (`jobs.map`, which
  // `Promise.all` keeps in input order).
  const choice = sourceOf('services/resumeChoice.ts');
  assert.match(choice, /for \(const \[jobIndex, job\] of jobs\.entries\(\)\)/, 'the plan is built in job order');
  assert.match(choice, /plan\.push\(\{\s*jobIndex,/, 'and every planned item carries its job index');

  const generation = sourceOf('routes/generation.ts');
  assert.match(generation, /for \(const \[index, planned\] of plan\.entries\(\)\)/, 'tasks are built from the plan, in plan order');
  assert.match(generation, /const job = jobs\[jobIndex\]/, 'each task reads its own job by the index the plan carries');

  const report = sourceOf('services/jobLake/reportRun.ts');
  assert.match(report, /return jobs\.map\(async \(job\)/, "the report run's analyses are mapped in row order");

  for (const relative of BATCH_SOURCES) {
    assert.doesNotMatch(
      sourceOf(relative),
      /[oO]utcomes\.forEach\(\(outcome\)\s*=>/,
      `${relative}: a collector that ignores the index cannot restore input order`
    );
  }
});

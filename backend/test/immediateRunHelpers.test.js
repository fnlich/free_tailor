const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

/**
 * The builder's Generate Immediately bookkeeping (frontend/src/lib/immediateRun.ts):
 * which id a tab goes by, which finished resumes still have to be downloaded,
 * the request that stops a run as the page goes, when leaving asks first, and
 * the "Don't show again" on the confirm. Loaded the way frontendHelpers.test.js
 * loads its modules: transpiled with the backend's TypeScript, importing
 * nothing at runtime.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontendModule(relative) {
  const file = path.join(SRC, relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, refuse);
  return module.exports;
}

const run = loadFrontendModule('lib/immediateRun.ts');

/** A Map-backed Storage, so each test sees exactly what was written. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Storage that throws on every call, as a blocked or private window's does. */
const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

function minter(...ids) {
  let next = 0;
  return () => ids[next++] ?? `minted-${next}`;
}

// -- the tab's id ------------------------------------------------------------- //

test('a tab keeps its id across a reload and a duplicated tab gets its own', () => {
  const tab = memoryStorage();
  const first = run.claimTabId(tab, minter('tab-a'));
  assert.equal(first, 'tab-a');
  assert.equal(tab.getItem(run.TAB_ID_KEY), 'tab-a');
  assert.equal(tab.getItem(run.TAB_CLAIM_KEY), '1');

  // A reload: pagehide let go of the claim, so the next page of the same tab
  // takes the same id back - and with it, the run it started.
  run.releaseTabClaim(tab);
  assert.equal(run.claimTabId(tab, minter('never-used')), 'tab-a');

  // A duplicated tab copies sessionStorage while the original still holds the
  // claim: it must not follow - or download - the original's run.
  const duplicate = memoryStorage(Object.fromEntries(tab.map));
  const copied = run.claimTabId(duplicate, minter('tab-b'));
  assert.equal(copied, 'tab-b');
  assert.equal(duplicate.getItem(run.TAB_ID_KEY), 'tab-b');
  assert.equal(tab.getItem(run.TAB_ID_KEY), 'tab-a', "the original's own storage is untouched");
});

test('a tab id is always one the server accepts, and storage that throws is survived', () => {
  // Junk in storage (an older build, a hand edit) is replaced, not sent.
  const junk = memoryStorage({ [run.TAB_ID_KEY]: 'has spaces/and slashes' });
  assert.equal(run.claimTabId(junk, minter('tab-ok')), 'tab-ok');
  // A minted id the server would refuse falls back to one it accepts.
  const fallback = run.claimTabId(memoryStorage(), () => 'not a valid id!');
  assert.match(fallback, /^[A-Za-z0-9_-]{1,100}$/);
  assert.equal(run.isTabId('x'.repeat(101)), false);
  assert.equal(run.isTabId('3f2b9c1e-0d4a-4b8e-9a51-2f7c0e6d1a90'), true);

  // No storage, or storage that throws: an id for this page alone, no throw.
  assert.equal(run.claimTabId(null, minter('page-only')), 'page-only');
  assert.equal(run.claimTabId(throwingStorage, minter('page-only-2')), 'page-only-2');
  assert.doesNotThrow(() => run.releaseTabClaim(throwingStorage));
});

// -- the remembered run and its downloads --------------------------------------- //

test("a remembered run is read back only by the tab that started it", () => {
  const tab = memoryStorage();
  run.rememberRun(tab, { batchId: 'b-1', tabId: 'tab-a', downloaded: ['t-1'] });
  assert.deepEqual(run.readRememberedRun(tab, 'tab-a'), { batchId: 'b-1', tabId: 'tab-a', downloaded: ['t-1'] });
  // Copied into a duplicated tab, it is the original's, not this one's.
  assert.equal(run.readRememberedRun(tab, 'tab-b'), null);

  run.forgetRun(tab);
  assert.equal(run.readRememberedRun(tab, 'tab-a'), null);

  // Whatever is in there that is not a run reads as none.
  for (const raw of ['not json', 'null', '[]', '{"batchId":""}', '{"batchId":7,"tabId":"tab-a"}']) {
    assert.equal(run.readRememberedRun(memoryStorage({ [run.IMMEDIATE_RUN_KEY]: raw }), 'tab-a'), null, raw);
  }
  // Junk entries in the downloaded list are dropped, not trusted.
  const mixed = memoryStorage({
    [run.IMMEDIATE_RUN_KEY]: JSON.stringify({ batchId: 'b', tabId: 'tab-a', downloaded: ['t-1', 4, '', null] }),
  });
  assert.deepEqual(run.readRememberedRun(mixed, 'tab-a').downloaded, ['t-1']);

  assert.equal(run.readRememberedRun(throwingStorage, 'tab-a'), null);
  assert.doesNotThrow(() => run.rememberRun(throwingStorage, { batchId: 'b', tabId: 't', downloaded: [] }));
  assert.doesNotThrow(() => run.forgetRun(throwingStorage));
});

test('each finished resume is downloaded exactly once, whatever the stream repeats', () => {
  const tasks = [
    { id: 't-1', state: 'done', profileName: 'Ada', companyName: 'Acme', files: ['cover-letter-pdf', 'resume-pdf'] },
    { id: 't-2', state: 'running', profileName: 'Ada', companyName: 'Beta' },
    { id: 't-3', state: 'done', profileName: 'Bob', companyName: 'Acme', files: ['resume-docx', 'resume-pdf', 'mystery'] },
    { id: 't-4', state: 'failed', profileName: 'Bob', companyName: 'Beta', error: 'x' },
    // Done with nothing kept: there is nothing to fetch.
    { id: 't-5', state: 'done', profileName: 'Cy', companyName: 'Gamma', files: [] },
  ];

  const first = run.pendingDownloads(tasks, new Set());
  assert.deepEqual(
    first.map((item) => [item.taskId, item.kinds]),
    [
      // Resume before cover letter, PDF before DOCX; a kind the page does not know is skipped.
      ['t-1', ['resume-pdf', 'cover-letter-pdf']],
      ['t-3', ['resume-pdf', 'resume-docx']],
    ]
  );
  assert.equal(first[0].companyName, 'Acme');
  assert.equal(first[0].profileName, 'Ada');

  // The next line of the stream repeats both, plus a newly finished one: only
  // the new one is due. `done` includes what is already in flight on the page.
  const later = tasks.map((task) => (task.id === 't-2' ? { ...task, state: 'done', files: ['resume-pdf'] } : task));
  assert.deepEqual(
    run.pendingDownloads(later, new Set(['t-1', 't-3'])).map((item) => item.taskId),
    ['t-2']
  );

  // A reload: the remembered set says what was downloaded, so nothing repeats.
  let remembered = { batchId: 'b', tabId: 'tab-a', downloaded: [] };
  remembered = run.withDownloaded(remembered, ['t-1', 't-3']);
  remembered = run.withDownloaded(remembered, ['t-3', 't-2']);
  assert.deepEqual(remembered.downloaded, ['t-1', 't-3', 't-2']);
  assert.deepEqual(run.pendingDownloads(later, new Set(remembered.downloaded)), []);
});

test('a page that went away part way through a resume saves only the files it had not', () => {
  const task = {
    id: 't-1',
    state: 'done',
    profileName: 'Ada',
    companyName: 'Acme',
    files: ['resume-pdf', 'resume-docx', 'cover-letter-pdf', 'cover-letter-docx'],
  };
  // The first file was handed over, and remembered at once; then the page went.
  const tab = memoryStorage();
  let remembered = { batchId: 'b', tabId: 'tab-a', downloaded: [] };
  remembered = run.withDownloaded(remembered, [run.downloadKey('t-1', 'resume-pdf')]);
  run.rememberRun(tab, remembered);
  assert.deepEqual(remembered.downloaded, ['t-1:resume-pdf']);

  // The next page of the tab reads it back and saves the other three - not four.
  const back = run.readRememberedRun(tab, 'tab-a');
  assert.deepEqual(
    run.pendingDownloads([task], new Set(back.downloaded)).map((item) => item.kinds),
    [['resume-docx', 'cover-letter-pdf', 'cover-letter-docx']]
  );

  // Every file saved: nothing left of that resume, and each saved once.
  for (const kind of ['resume-docx', 'cover-letter-pdf', 'cover-letter-docx', 'resume-pdf']) {
    remembered = run.withDownloaded(remembered, [run.downloadKey('t-1', kind)]);
  }
  assert.equal(remembered.downloaded.length, 4);
  assert.deepEqual(run.pendingDownloads([task], new Set(remembered.downloaded)), []);
  // A task id on its own - a resume in flight on this page - holds back all of it.
  assert.deepEqual(run.pendingDownloads([task], new Set(['t-1'])), []);

  // The run's files that reached this browser, before a reload and after: a
  // bare task id is not a count of anything.
  assert.equal(run.savedFileCount(remembered.downloaded), 4);
  assert.equal(run.savedFileCount(['t-1', 't-2:resume-pdf']), 1);
  assert.equal(run.savedFileCount([]), 0);
});

test("a downloaded file is named by the server when it can be read, else from the snapshot", () => {
  assert.equal(run.contentDispositionName('attachment; filename="Acme_Ada.pdf"'), 'Acme_Ada.pdf');
  assert.equal(
    run.contentDispositionName(`attachment; filename="Caf_.pdf"; filename*=UTF-8''Caf%C3%A9_Ada.pdf`),
    'Café_Ada.pdf'
  );
  assert.equal(run.contentDispositionName('attachment; filename=plain.docx'), 'plain.docx');
  // Unreadable (another origin) or unsafe: the page names it instead.
  assert.equal(run.contentDispositionName(null), null);
  assert.equal(run.contentDispositionName('attachment; filename="../../etc/passwd"'), null);
  assert.equal(run.contentDispositionName('attachment'), null);

  assert.equal(run.downloadName('Acme', 'Ada Lovelace', 'resume-pdf'), 'Acme - Ada Lovelace - Resume.pdf');
  assert.equal(run.downloadName('Acme', 'Ada', 'cover-letter-docx'), 'Acme - Ada - Cover letter.docx');
  assert.equal(run.downloadName('A/B: "C"', 'Ada', 'resume-docx'), 'A B C - Ada - Resume.docx');
  assert.equal(run.downloadName('', '', 'resume-pdf'), 'Resume.pdf');
  assert.ok(run.downloadName('x'.repeat(500), 'Ada', 'resume-pdf').length <= 124);
});

test('how a run ended is said from its last snapshot: built, stopped and refunded, still going, or lost', () => {
  const snap = (state, total, completed, cancelled) => ({ state, total, completed, cancelled });
  assert.equal(run.describeRunEnd(snap('done', 3, 3, 0), 3), 'Built 3 of 3 resumes. 3 files downloaded to this browser.');
  assert.equal(run.describeRunEnd(snap('done', 1, 1, 0), 0), 'Built 1 of 1 resume.');
  // Stopped: what was not built is named as refunded.
  assert.equal(
    run.describeRunEnd(snap('cancelled', 5, 2, 3), 2),
    'Stopped after building 2 of 5 resumes; the 3 not built were refunded. 2 files downloaded to this browser.'
  );
  assert.equal(
    run.describeRunEnd(snap('done', 4, 3, 1), 1),
    'Stopped after building 3 of 4 resumes; the 1 not built was refunded. 1 file downloaded to this browser.'
  );
  // Never "Built 2 of 5" for a run the server is still building.
  assert.equal(run.describeRunEnd(snap('running', 5, 2, 0), 0), 'Still building: 2 of 5 resumes done so far.');
  assert.match(run.describeRunEnd(null, 0), /^Lost track of the run/);
  assert.match(run.describeRunEnd(null, 2), /2 files downloaded/);
});

test("what Cancel on an order says it did agrees with what it asked, about the money too", () => {
  const { cancelOrderQuestion, describeCancelOutcome } = loadFrontendModule('lib/orderCancel.ts');

  // A small order: every resume already running. Each of them is refunded
  // unless it finishes first - so never "0 refunded" to somebody who just had
  // all of it back.
  const allRunning = describeCancelOutcome({ cancelled: 0, aborted: 3 });
  assert.equal(allRunning, '3 resumes being built were stopped and refunded, unless they finished first.');
  assert.doesNotMatch(allRunning, /\b0 resume/);

  assert.equal(
    describeCancelOutcome({ cancelled: 8, aborted: 4 }),
    '8 resumes not started were refunded, and 4 resumes being built were stopped and refunded, unless they finished first.'
  );
  assert.equal(
    describeCancelOutcome({ cancelled: 1, aborted: 1 }),
    '1 resume not started was refunded, and 1 resume being built was stopped and refunded, unless it finished first.'
  );
  assert.equal(describeCancelOutcome({ cancelled: 2, aborted: 0 }), '2 resumes not started were refunded.');
  assert.equal(describeCancelOutcome({ cancelled: 0, aborted: 0 }), 'nothing was left to stop.');

  // The question promises the same thing the note reports.
  const question = cancelOrderQuestion('FT-20261005-0001');
  assert.match(question, /FT-20261005-0001/);
  assert.match(question, /stopped and refunded, unless it finishes first/);
});

// -- stopping the run as the page goes ----------------------------------------- //

test('the release is a keepalive simple request, with the bearer only on the same origin', () => {
  const across = run.releaseRequest('http://localhost:3001/api', 'b/1', 'tab-a', 'http://localhost:3000', 'tok');
  assert.equal(across.url, 'http://localhost:3001/api/generation/batches/b%2F1/release?tab=tab-a');
  assert.equal(across.init.method, 'POST');
  assert.equal(across.init.keepalive, true);
  assert.equal(across.init.credentials, 'include');
  // Across origins an Authorization header would need a preflight, which a
  // page that is unloading can lose: the session cookie carries it instead.
  assert.equal(across.init.headers, undefined);
  assert.equal(across.init.body, undefined, 'no body, so no Content-Type either');

  const same = run.releaseRequest('/api', 'b-1', 'tab-a', 'https://tailor.example', 'tok');
  assert.equal(same.url, '/api/generation/batches/b-1/release?tab=tab-a');
  assert.deepEqual(same.init.headers, { Authorization: 'Bearer tok' });
  const sameNoToken = run.releaseRequest('https://tailor.example/api', 'b-1', 'tab-a', 'https://tailor.example', null);
  assert.equal(sameNoToken.init.headers, undefined);
});

test('leaving Build Resumes asks first only for a plain click to another page of the app', () => {
  const here = { origin: 'http://localhost:3000', pathname: '/' };
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  assert.equal(run.leavesBuilder({ href: 'http://localhost:3000/orders' }, plain, here), true);
  assert.equal(run.leavesBuilder({ href: '/credits', target: '_self' }, plain, here), true);
  // Opened somewhere else: this page, and its run, stay.
  assert.equal(run.leavesBuilder({ href: '/orders', target: '_blank' }, plain, here), false);
  assert.equal(run.leavesBuilder({ href: '/orders' }, { ...plain, ctrlKey: true }, here), false);
  assert.equal(run.leavesBuilder({ href: '/orders' }, { ...plain, metaKey: true }, here), false);
  assert.equal(run.leavesBuilder({ href: '/orders' }, { ...plain, button: 1 }, here), false);
  assert.equal(run.leavesBuilder({ href: 'blob:x', download: true }, plain, here), false);
  // The same page, or another site (whose leave prompt is the browser's own).
  assert.equal(run.leavesBuilder({ href: '/#top' }, plain, here), false);
  assert.equal(run.leavesBuilder({ href: 'https://docs.google.com/x' }, plain, here), false);
});

test("the Generate Immediately confirm shows until Don't show again, per browser", () => {
  const browser = memoryStorage();
  assert.equal(run.confirmsImmediate(browser), true);
  run.skipImmediateConfirm(browser);
  assert.equal(run.confirmsImmediate(browser), false);
  // Storage that cannot be read keeps asking rather than skipping silently.
  assert.equal(run.confirmsImmediate(null), true);
  assert.equal(run.confirmsImmediate(throwingStorage), true);
  assert.doesNotThrow(() => run.skipImmediateConfirm(throwingStorage));
});

// -- the sheet panel's rows ----------------------------------------------------- //

test("the sheet panel builds a job per row with a company and a description, and skips the rest", () => {
  const { buildSheetJobs, safeJobLink } = loadFrontendModule('lib/sheetRows.ts');
  // The own sheet's B:E, loaded from row 2: Company, Job Title, Job Link, Job Description.
  const values = [
    ['Acme', 'Engineer', 'https://acme.example/jobs/1', 'Build things. '.repeat(5)],
    ['', 'No company', '', 'A description'],
    ['Beta', '', 'javascript:alert(1)', 'Ship things. '.repeat(5)],
    ['Gamma', 'Analyst', 'ftp://x', ''],
    [],
  ];
  const columns = { companyName: 0, jobTitle: 1, jobLink: 2, jobDescription: 3, analysis: null, jobField: null, salary: null };
  const { jobs, skippedRows } = buildSheetJobs(values, 2, columns);
  assert.equal(skippedRows, 3);
  assert.deepEqual(
    jobs.map((job) => [job.sourceRowNumber, job.companyName, job.jobTitle, job.jobLink, job.analysis]),
    [
      [2, 'Acme', 'Engineer', 'https://acme.example/jobs/1', null],
      // No title is sent as none: the server names the role from the analysis.
      // A link cell that is not a web address is never made a link.
      [4, 'Beta', '', '', null],
    ]
  );

  // With the analysis column read, each row says what its cell holds - the
  // server's reading of it, checked against the server in frontendAnalysis.test.js.
  const analysed = buildSheetJobs(
    [
      ['Acme', 'x', '', 'JD', '{"v":1,"id":"a","analysis":{"jobField":"backend"}}'],
      ['Beta', '', '', 'JD', ''],
      ['Gamma', '', '', 'JD', '{"jobField":"backend"}'],
    ],
    7,
    { ...columns, analysis: 4 }
  );
  assert.deepEqual(analysed.jobs.map((job) => [job.sourceRowNumber, job.analysis]), [
    [7, 'ok'],
    [8, 'empty'],
    // Filled, but not this program's cell: nothing to build on.
    [9, 'unparseable'],
  ]);

  assert.throws(() => buildSheetJobs(values, 2, { ...columns, companyName: null }), /company name/);
  assert.throws(() => buildSheetJobs(values, 2, { ...columns, jobDescription: null }), /job description/);
  assert.throws(() => buildSheetJobs([['', '', '', '']], 2, columns), /No jobs were found/);

  assert.equal(safeJobLink(' https://x.example/a?b=1 '), 'https://x.example/a?b=1');
  assert.equal(safeJobLink('HTTP://x.example'), 'http://x.example/');
  assert.equal(safeJobLink('javascript:alert(1)'), '');
  assert.equal(safeJobLink('www.example.com'), '');
});

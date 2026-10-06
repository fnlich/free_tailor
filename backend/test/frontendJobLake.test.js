const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const ts = require('typescript');

const { analysisAnswer, countingSeats, freshInstall, posting } = require('./analysisHarness');
const { storeJobAnalysis, useAdminEmails } = require('./helpers');

/**
 * The browser's half of the Job Data Lake: Report Jobs (/report) and Admin ->
 * Job Lake (/admin/job-lake).
 *
 * The frontend has no test runner, so lib/jobLakeDisplay.ts is transpiled with
 * the backend's own TypeScript and run from here (the frontendMoney pattern -
 * it may import other pure frontend modules, nothing else). Two kinds of
 * claim:
 *
 *  - MIRRORS of a server rule, run against the server's compiled code over
 *    the same inputs: the rows a run may be asked for, the settings a save
 *    may send, the filters the lake route accepts, the tab a run refuses, the
 *    statuses a row and a merge can come to - and the owner's summary line,
 *    drawn from a real run's summary. A box that accepts what the server
 *    refuses is a form that cannot be sent and does not say why.
 *  - DECISIONS with no React in them: when "Add to job lake" may be pressed,
 *    which rows are red, what a preview row says, which settings a save
 *    sends, and that a link typed into a sheet only reaches an anchor as a
 *    web address.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const cache = new Map();

function resolveFrontend(fromFile, specifier) {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  cache.set(file, module);
  const requireFrontend = (specifier) => {
    const target = resolveFrontend(file, specifier);
    if (!target) {
      throw new Error(`${path.relative(SRC, file)} imports ${specifier}; these helpers import only other pure frontend modules`);
    }
    return loadFile(target);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, requireFrontend);
  return module.exports;
}

const display = () => loadFile(path.join(SRC, 'lib', 'jobLakeDisplay.ts'));

/** The thrown sentence, or null when it did not throw. */
function refusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error.message;
  }
}

/** The members of a string-literal union type, read from a backend source file. */
function unionMembers(relative, typeName) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', relative), 'utf8');
  const match = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source);
  assert.ok(match, `${typeName} is found in ${relative}`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([^']+)'/g)].map((found) => found[1]);
}

// -- the rows a run is asked for ------------------------------------------ //

test('the range a run is asked for is refused by the page exactly when, and in the words, the server refuses it', () => {
  freshInstall('frontend-lake-range');
  const reportRun = require('../dist/services/jobLake/reportRun');
  const lake = display();
  assert.equal(lake.DEFAULT_MAX_RUN_ROWS, reportRun.MAX_REPORT_RUN_ROWS);
  assert.equal(lake.REPORT_FIRST_ROW, 2);

  const max = reportRun.MAX_REPORT_RUN_ROWS;
  const inputs = [
    { tabName: '10/05/2026', fromRow: '2', toRow: '51' },
    { tabName: '  10/05/2026  ', fromRow: ' 2 ', toRow: ' 9 ' },
    { tabName: '10/05/2026', fromRow: 2, toRow: 2 },
    { tabName: '', fromRow: '2', toRow: '9' },
    { tabName: '   ', fromRow: '2', toRow: '9' },
    { tabName: 'x'.repeat(101), fromRow: '2', toRow: '9' },
    { tabName: 'x'.repeat(100), fromRow: '2', toRow: '9' },
    { tabName: 7, fromRow: '2', toRow: '9' },
    { tabName: 'Tab', fromRow: '1', toRow: '9' },
    { tabName: 'Tab', fromRow: '0', toRow: '9' },
    { tabName: 'Tab', fromRow: '9', toRow: '8' },
    { tabName: 'Tab', fromRow: '2.5', toRow: '9' },
    { tabName: 'Tab', fromRow: '-2', toRow: '9' },
    { tabName: 'Tab', fromRow: '', toRow: '9' },
    { tabName: 'Tab', fromRow: '2', toRow: 'ten' },
    { tabName: 'Tab', fromRow: '1e2', toRow: '200' },
    { tabName: 'Tab', fromRow: 2, toRow: 2 + max - 1 },
    { tabName: 'Tab', fromRow: 2, toRow: 2 + max },
    { tabName: 'Tab', fromRow: '2', toRow: String(2 + max) },
    { tabName: 'Tab', fromRow: '99999999999999999999', toRow: '99999999999999999999' },
  ];
  for (const input of inputs) {
    const page = lake.readReportRange(input, max);
    const server = refusal(() => reportRun.readRunRange(input));
    assert.equal(page.ok ? null : page.error, server, JSON.stringify(input));
    if (page.ok) assert.deepEqual(page.range, reportRun.readRunRange(input), JSON.stringify(input));
  }
});

// -- statuses and the owner's line ---------------------------------------- //

test("every status a row or a merge can come to has the page's words, and only a duplicate - now, or the first time - is red", () => {
  const lake = display();
  const rowStatuses = unionMembers('services/jobLake/reportRun.ts', 'ReportRowStatus');
  assert.deepEqual(Object.keys(lake.REPORT_STATUS_LABELS).sort(), [...rowStatuses].sort());
  assert.deepEqual(Object.keys(lake.REPORT_STATUS_TONES).sort(), [...rowStatuses].sort());
  for (const status of rowStatuses) {
    assert.equal(lake.isRedOutcome({ status, priorOutcome: null }), status === 'duplicate', status);
    assert.equal(lake.reportStatusTone(status) === 'red', status === 'duplicate', status);
    assert.equal(lake.reportRowTone({ status, priorOutcome: null }) === 'red', status === 'duplicate', status);
  }

  // What became of a posting the first time: the server's words, every one.
  const { JOB_REPORT_OUTCOME_LABELS } = require('../dist/database/jobLakeRepository');
  const outcomes = unionMembers('database/jobLakeRepository.ts', 'JobReportOutcome');
  assert.deepEqual(Object.keys(lake.JOB_REPORT_OUTCOME_LABELS).sort(), [...outcomes].sort());
  assert.deepEqual({ ...lake.JOB_REPORT_OUTCOME_LABELS }, { ...JOB_REPORT_OUTCOME_LABELS });
  for (const outcome of outcomes) {
    assert.equal(lake.describePriorOutcome(outcome), `Reported before (${JOB_REPORT_OUTCOME_LABELS[outcome]})`);
    const row = { status: 'already-reported', priorOutcome: outcome, reason: 'x' };
    assert.equal(lake.reportRowLabel(row), `Reported before (${JOB_REPORT_OUTCOME_LABELS[outcome]})`);
    // A row whose posting was a duplicate the first time is painted red again - and only that one.
    assert.equal(lake.isRedOutcome(row), outcome === 'duplicate', outcome);
    assert.equal(lake.reportRowTone(row) === 'red', outcome === 'duplicate', outcome);
    assert.match(lake.describeRowNote(row), /^You reported this posting before/);
  }
  assert.equal(lake.describePriorOutcome(null), 'Reported before');
  assert.equal(lake.reportRowLabel({ status: 'duplicate', priorOutcome: null }), 'Duplicate');
  assert.equal(lake.describeRowNote({ status: 'skipped', reason: 'No company.' }), 'No company.');
  assert.equal(lake.describeRowNote({ status: 'added', reason: null }), '');

  const mergeStatuses = [
    ...unionMembers('database/jobLakeRepository.ts', 'MergeStatus'),
    'not-found',
    'merged-before',
    'not-offered',
  ];
  assert.deepEqual(Object.keys(lake.MERGE_STATUS_LABELS).sort(), [...new Set(mergeStatuses)].sort());
});

test("the summary line is the owner's sentence, to the thousandth", () => {
  const lake = display();
  assert.equal(
    lake.describeRunSummary({ added: 32, total: 70, balanceMilli: 4000 }),
    '32 out of 70 was added, your current credit is $4'
  );
  assert.equal(
    lake.describeRunSummary({ added: 0, total: 0, balanceMilli: 23 }),
    '0 out of 0 was added, your current credit is $0.023'
  );
  const summary = {
    added: 3,
    total: 6,
    duplicates: 2,
    unclassified: 0,
    replaced: 1,
    skipped: 1,
    failed: 0,
    alreadyReported: 0,
    earnedMilli: 210,
    balanceMilli: 4210,
    sheetUpdated: true,
  };
  assert.equal(
    lake.describeRunBreakdown(summary, true),
    'This run earned $0.21. 1 of the added replaced an older version of the same job, 2 duplicates (red), 1 skipped.'
  );
  assert.match(lake.describeRunBreakdown(summary, false), /^Administrators are not paid/);
  assert.equal(lake.describeRowReward({ rewardMilli: 70 }, true), '$0.07');
  assert.equal(lake.describeRowReward({ rewardMilli: 70 }, false), '-');
  assert.equal(lake.describeRowReward({ rewardMilli: 0 }, true), '-');
});

// -- what a preview says, and when a run may start ------------------------ //

test('the preview says which rows a run skips, and Add to job lake waits for a preview of the same rows', () => {
  const lake = display();
  const rows = [
    { row: 2, company: 'Acme', title: 'A', link: '', descriptionLength: 400, jobHash: null, reported: false, priorOutcome: null },
    { row: 3, company: 'Beta', title: 'B', link: '', descriptionLength: 400, jobHash: 'h', reported: true, priorOutcome: 'duplicate' },
    { row: 4, company: 'Gamma', title: 'C', link: '', descriptionLength: 400, jobHash: 'g', reported: true, priorOutcome: 'added' },
    { row: 5, company: '', title: 'D', link: '', descriptionLength: 400, jobHash: null, reported: false, priorOutcome: null },
    { row: 6, company: 'Delta', title: 'E', link: 'https://x.example/1', descriptionLength: 0, jobHash: null, reported: false, priorOutcome: null },
  ];
  assert.deepEqual(lake.countReportPreview(rows), { jobs: 5, toReport: 3, reported: 2 });
  assert.equal(
    lake.describeReportPreview(rows),
    '5 rows hold a job: 3 will be taken to the job lake, and 2 were reported before and will be skipped.'
  );
  assert.deepEqual(
    rows.map((row) => lake.describePreviewRow(row).skipped),
    [false, true, true, false, false]
  );
  // What became of the posting the first time - the server's record, never the row's Lake Status.
  assert.equal(lake.describePreviewRow(rows[1]).label, 'Reported before (Duplicate) - skipped');
  assert.equal(lake.describePreviewRow(rows[2]).label, 'Reported before (Added) - skipped');
  assert.equal(lake.describePreviewRow(rows[0]).label, 'To add');
  assert.equal(lake.describePreviewRow(rows[3]).label, 'No company - it will be Skipped');
  assert.match(lake.describePreviewRow(rows[4]).label, /^No job description/);
  assert.equal(lake.describeReportPreview([]), 'No row in that range holds a job.');
  assert.match(lake.describeReportPreview([rows[1]]), /reported before, so a run would skip it/);

  const range = lake.readReportRange({ tabName: 'Today', fromRow: '2', toRow: '6' });
  const preview = { tabName: 'Today', fromRow: 2, toRow: 6, jobTab: true, rows };
  const blocker = (changes) => lake.startBlocker({ sheetReady: true, run: null, range, preview, ...changes });

  assert.equal(blocker({}), '');
  assert.match(blocker({ sheetReady: false }), /not available/);
  assert.equal(blocker({ run: { state: 'running' } }), 'A run is going. Wait for it to finish first.');
  assert.equal(blocker({ run: { state: 'finished' } }), '');
  assert.equal(blocker({ preview: null }), 'Preview these rows first, to see what will be added.');
  // A preview of OTHER rows is not a preview of these.
  assert.equal(blocker({ preview: { ...preview, toRow: 7 } }), 'Preview these rows first, to see what will be added.');
  assert.equal(
    blocker({ range: lake.readReportRange({ tabName: 'Today', fromRow: '1', toRow: '6' }) }),
    'Give the rows to report as From and To row numbers, from row 2 (row 1 is the header).'
  );
  assert.equal(blocker({ preview: { ...preview, jobTab: false, rows: [] } }), lake.notJobTabMessage('Today'));
  assert.equal(blocker({ preview: { ...preview, rows: [] } }), 'No row in that range holds a job.');
  assert.match(blocker({ preview: { ...preview, rows: [rows[1], rows[2]] } }), /^Every row in that range was reported before/);
});

test('a link typed into a sheet reaches an anchor only as a web address', () => {
  const lake = display();
  assert.equal(lake.safeWebLink('https://jobs.example.com/1?x=2'), 'https://jobs.example.com/1?x=2');
  assert.equal(lake.safeWebLink(' http://jobs.example.com/a '), 'http://jobs.example.com/a');
  for (const bad of [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,<b>x</b>',
    'vbscript:x',
    'mailto:a@b.c',
    'not a link',
    '//jobs.example.com/1',
    '/relative',
    'https://user:pass@jobs.example.com/',
    'https://jobs.example.com/a b',
    'https://jobs.example.com/\u0000',
    '',
    null,
    42,
  ]) {
    assert.equal(lake.safeWebLink(bad), null, JSON.stringify(bad));
  }
  assert.equal(lake.linkHost('https://www.jobs.example.com/1'), 'jobs.example.com');
});

// -- the settings ---------------------------------------------------------- //

test('a settings box is refused by the page exactly when, and in the words, the server refuses it', () => {
  freshInstall('frontend-lake-settings');
  const settings = require('../dist/services/jobLake/settings');
  const { OPERATIONAL_INT_BOUNDS } = require('../dist/config/operational');
  const lake = display();
  assert.equal(lake.DUPLICATE_WINDOW_MIN_DAYS, OPERATIONAL_INT_BOUNDS.JOB_LAKE_DUPLICATE_WINDOW_DAYS.min);
  assert.equal(lake.DUPLICATE_WINDOW_MAX_DAYS, OPERATIONAL_INT_BOUNDS.JOB_LAKE_DUPLICATE_WINDOW_DAYS.max);
  assert.equal(lake.MAX_DAILY_CAP_MILLI, settings.MAX_DAILY_CAP_MILLI);

  const boxes = [
    ['rate', 'reportRateUsd', ['', '  ', '0', '0.05', '0.023', '$0.07', '0.0235', '1000', '1000.001', '-1', 'abc', '1e3', '0,05', '.5']],
    ['window', 'duplicateWindowDays', ['', '1', '60', '3650', '0', '3651', '2.5', '-3', 'sixty', ' 30 ', '1e2']],
    ['cap', 'dailyCapUsd', ['', '0', '5', '5.125', '5.1255', '1000000', '1000000.001', 'lots', '-5']],
  ];
  for (const [box, field, values] of boxes) {
    for (const value of values) {
      const draft = { rate: '', window: '', cap: '', [box]: value };
      const page = lake.lakeSettingsProblems(draft)[box] ?? null;
      const answer = settings.updateLakeSettings({ [field]: value }, 'admin-test');
      assert.equal(page, answer.ok ? null : answer.error, `${field} = ${JSON.stringify(value)}`);
      if (!answer.ok) assert.equal(lake.settingsFieldForCode(answer.code), box, answer.code);
    }
  }
});

test('a save sends only what changed, as typed, and a saved form sends nothing', () => {
  freshInstall('frontend-lake-save');
  const settings = require('../dist/services/jobLake/settings');
  const lake = display();

  const stored = settings.readLakeSettings({});
  assert.deepEqual(lake.lakeSettingsDraft(stored), { rate: '', window: '', cap: '' });
  assert.deepEqual(lake.lakeSettingsChanges({ rate: '', window: '', cap: '' }, stored), {});

  const draft = { rate: '0.07', window: '45', cap: '' };
  const changes = lake.lakeSettingsChanges(draft, stored);
  assert.deepEqual(changes, { reportRateUsd: '0.07', duplicateWindowDays: '45' });
  const saved = settings.updateLakeSettings(changes, 'admin-test');
  assert.ok(saved.ok, JSON.stringify(saved));

  const after = settings.readLakeSettings({});
  assert.equal(after.reportRateMilli, 70);
  assert.equal(after.duplicateWindow.days, 45);
  // The form refilled from what was stored sends nothing; "0.070" for $0.07 is no change either.
  assert.deepEqual(lake.lakeSettingsChanges(lake.lakeSettingsDraft(after), after), {});
  assert.deepEqual(lake.lakeSettingsChanges({ rate: '0.070', window: '45', cap: '' }, after), {});
  // Emptying a box clears it: '' is sent, which the server reads as "unset".
  const cleared = lake.lakeSettingsChanges({ rate: '', window: '', cap: '' }, after);
  assert.deepEqual(cleared, { reportRateUsd: '', duplicateWindowDays: '' });
  assert.ok(settings.updateLakeSettings(cleared, 'admin-test').ok);
  assert.equal(settings.readLakeSettings({}).reportRateSet, false);
  // A box the server would refuse sends nothing at all.
  assert.equal(lake.lakeSettingsChanges({ rate: '0.0001', window: '', cap: '' }, after), null);
});

test('the duplicate window says what is in effect and where it comes from, as the server resolves it', () => {
  freshInstall('frontend-lake-window');
  const settings = require('../dist/services/jobLake/settings');
  const lake = display();

  const unset = settings.resolveDuplicateWindow({}, {});
  assert.equal(unset.source, 'default');
  assert.match(lake.describeDuplicateWindow(unset), /^In effect: 60 days, the built-in default - JOB_LAKE_DUPLICATE_WINDOW_DAYS is not set in \.env/);
  assert.equal(lake.windowPlaceholder(unset), '60 (the default)');

  const env = settings.resolveDuplicateWindow({ JOB_LAKE_DUPLICATE_WINDOW_DAYS: '30' }, {});
  assert.equal(env.source, 'env');
  assert.equal(lake.describeDuplicateWindow(env), 'In effect: 30 days, from JOB_LAKE_DUPLICATE_WINDOW_DAYS in .env. A value set here wins over it.');
  assert.equal(lake.windowPlaceholder(env), '30 (from .env)');

  const admin = settings.resolveDuplicateWindow({ JOB_LAKE_DUPLICATE_WINDOW_DAYS: '30' }, { duplicateWindowDays: 1 });
  assert.equal(admin.source, 'admin');
  assert.equal(
    lake.describeDuplicateWindow(admin),
    'In effect: 1 day, set here. Without it: JOB_LAKE_DUPLICATE_WINDOW_DAYS in .env says 30 days.'
  );

  const junk = settings.resolveDuplicateWindow({ JOB_LAKE_DUPLICATE_WINDOW_DAYS: 'two months' }, {});
  assert.equal(junk.source, 'default');
  assert.match(lake.describeDuplicateWindow(junk), /is not a whole number, so it is ignored and the default of 60 days applies/);
  assert.equal(lake.windowPlaceholder(junk), '60 (the default)');
});

// -- the rest of the admin page's words ----------------------------------- //

test('rewards, revokes, the sync and a merge read the way the admin page says them', () => {
  const lake = display();
  assert.equal(lake.describeReward({ milli: 0, rateMilli: null, revokedMilli: 0, revokedAt: null }), 'Not paid');
  assert.equal(lake.describeReward({ milli: 70, rateMilli: 70, revokedMilli: 0, revokedAt: null }), '$0.07 at $0.07 per job');
  assert.equal(
    lake.describeReward({ milli: 70, rateMilli: 70, revokedMilli: 20, revokedAt: '2026-10-05T00:00:00Z' }),
    '$0.07 at $0.07 per job - $0.02 taken back'
  );
  const paid = { reward: { milli: 70, rateMilli: 70, revokedMilli: 0, revokedAt: null }, requestedBy: 'u1' };
  assert.equal(lake.canRevoke(paid), true);
  assert.equal(lake.canRevoke({ ...paid, requestedBy: null }), false);
  assert.equal(lake.canRevoke({ ...paid, reward: { ...paid.reward, revokedAt: '2026-10-05T00:00:00Z' } }), false);
  assert.equal(lake.canRevoke({ ...paid, reward: { ...paid.reward, milli: 0 } }), false);
  assert.match(
    lake.describeRevoke({ revoked: true, takenMilli: 20, rewardMilli: 70, userId: 'u1', balanceMilli: 0 }, 'rita@example.com'),
    /^Took back \$0\.02 of the \$0\.07 reward - all rita@example\.com had left/
  );
  assert.equal(
    lake.describeRevoke({ revoked: true, takenMilli: 70, rewardMilli: 70, userId: 'u1', balanceMilli: 130 }, 'rita@example.com'),
    'Took back the $0.07 reward from rita@example.com. Their balance is now $0.13.'
  );
  assert.match(lake.describeRevoke({ revoked: false, takenMilli: 0, rewardMilli: 0, userId: null, balanceMilli: null }, 'x'), /no reward to take back/);

  const entry = { company: 'Acme', jobFieldLabel: 'Backend', ...paid };
  assert.match(lake.describeDeleteConfirm(entry, true), /\$0\.07 reward is taken back/);
  assert.match(lake.describeDeleteConfirm(entry, false), /keeps its \$0\.07 reward/);
  assert.doesNotMatch(lake.describeDeleteConfirm({ ...entry, requestedBy: null }, true), /reward/);

  const sync = { unsynced: 0, running: false, lastAttemptAt: null, lastSuccessAt: null, lastAppended: 0, lastError: null };
  assert.equal(lake.describeSyncState(null, sync).tone, 'info');
  assert.equal(lake.describeSyncState({ spreadsheetId: 's' }, sync).tone, 'success');
  assert.equal(lake.describeSyncState({ spreadsheetId: 's' }, { ...sync, unsynced: 3, lastError: 'Quota' }).tone, 'warn');
  assert.equal(lake.describeSyncState({ spreadsheetId: 's' }, { ...sync, unsynced: 3, running: true }).tone, 'info');
  assert.equal(lake.describeSyncReport({ appended: 2, failed: false }).text, 'Added 2 jobs to the admin sheet.');
  assert.equal(lake.describeSyncReport({ appended: 0, failed: true }).tone, 'warn');

  const report = {
    merged: 3,
    added: 2,
    replaced: 1,
    duplicates: 1,
    skipped: 1,
    remaining: 0,
    results: [
      { analysisId: 'a', status: 'added', lakeId: 1, jobHash: 'h1' },
      { analysisId: 'b', status: 'not-found', lakeId: null, jobHash: null },
      { analysisId: 'c', status: 'replaced', lakeId: 2, jobHash: 'h2' },
      { analysisId: 'd', status: 'duplicate', lakeId: 1, jobHash: 'h1' },
    ],
  };
  assert.equal(
    lake.describeMergeReport(report),
    'Merged 3: 2 added (1 replacing an older version), 1 duplicate, 1 skipped. Nothing is left to merge. Nobody is paid for a merge.'
  );
  // Duplicates first - the report the owner asked for - then what was skipped.
  assert.deepEqual(lake.mergeResultsNotAdded(report).map((result) => result.analysisId), ['d', 'b']);
  assert.deepEqual(lake.mergeDuplicates(report).map((result) => result.analysisId), ['d']);
});

// -- the lake's filters, over HTTP ---------------------------------------- //

/** A served install with the report and lake routes, a reporter, and every Google seam in memory. */
async function serve(name) {
  const storage = freshInstall(name);
  useAdminEmails('owner@example.com');
  const ai = require('../dist/services/ai/index');
  const config = require('../dist/config/aiModelConfig');
  const gate = require('../dist/services/jobAnalysis/gate');
  const columns = require('../dist/services/sheets/analysisColumns');
  const accountSheet = require('../dist/services/sheets/accountSheet');
  const reportSheet = require('../dist/services/jobLake/reportSheet');
  const reportRun = require('../dist/services/jobLake/reportRun');
  const adminSheet = require('../dist/services/jobLake/adminSheet');
  const settings = require('../dist/services/jobLake/settings');
  const users = require('../dist/database/userRepository');
  const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');

  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  columns.resetAnalysisWriteBacksForTests();
  reportRun.resetReportRunsForTests();
  adminSheet.resetAdminLakeSheetForTests();
  const seats = countingSeats(ai, { answer: () => analysisAnswer() });

  // Rows by tab: `rows[tab][row][letter]`. "My notes" is the reporter's own tab, not a job tab.
  const rows = new Map();
  const tabRows = (tab) => {
    if (!rows.has(tab)) rows.set(tab, {});
    return rows.get(tab);
  };
  const letter = (n) => String.fromCharCode(64 + n);
  const parse = (range) => {
    const match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    assert.ok(match, `a range the fake understands: ${range}`);
    return {
      tab: match[1].replace(/''/g, "'"),
      fromCol: match[2].charCodeAt(0) - 64,
      fromRow: Number(match[3]),
      toCol: match[4].charCodeAt(0) - 64,
      toRow: Number(match[5]),
    };
  };
  const header = (tab) => (tab === 'My notes' ? ['Ideas', 'Links'] : [...JOB_SHEET_HEADERS]);
  const google = {
    async inspectTab(_id, tab) {
      return { gid: 7, title: tab, columnCount: 12, rowCount: 1000, headerRow: header(tab), protectedRanges: [] };
    },
    async verifyTab(_id, tab) {
      return { gid: 7, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: tab !== 'My notes' };
    },
    async readRanges(_id, ranges) {
      return ranges.map((range) => {
        const { tab, fromCol, fromRow, toCol, toRow } = parse(range);
        const grid = [];
        for (let row = fromRow; row <= toRow; row += 1) {
          const values = [];
          for (let col = fromCol; col <= toCol; col += 1) values.push(tabRows(tab)[row]?.[letter(col)] ?? '');
          grid.push(values);
        }
        return grid;
      });
    },
    async writeRaw(_id, data) {
      for (const { range, values } of data) {
        const { tab, fromCol, fromRow } = parse(range);
        values.forEach((cells, offset) => {
          const row = (tabRows(tab)[fromRow + offset] ??= {});
          cells.forEach((value, col) => {
            if (value !== null) row[letter(fromCol + col)] = value;
          });
        });
      }
    },
    async batchUpdate(_id, requests) {
      // The rows a run paints: one repeatCell per row, its background only.
      for (const request of requests) {
        const cell = request.repeatCell;
        if (cell && cell.fields === 'userEnteredFormat.backgroundColor') paints.push(cell.range.startRowIndex + 1);
      }
    },
  };
  const paints = [];
  columns.setAnalysisSheetsClientForTests(google);
  reportSheet.setReportSheetsClientForTests(google);
  accountSheet.setSheetsClientForTests({
    async isConfigured() {
      return true;
    },
    async checkCredential() {},
    async createSpreadsheet() {
      return { spreadsheetId: 'sheet-1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit', firstTabGid: 7 };
    },
    async formatJobSheetTab() {},
    async addSheetTabWithHeaders() {
      return { gid: 7, created: false };
    },
    async shareSpreadsheetWithEmail() {},
    async hasPersonalGrant() {
      return true;
    },
    async getSpreadsheetVisibility() {
      return 'private';
    },
    async setSpreadsheetVisibility(_id, next) {
      return next;
    },
    async listSheetTabs() {
      return [{ title: 'Today', gid: 7 }, { title: 'My notes', gid: 8 }];
    },
    async readRanges(_id, ranges) {
      return ranges.map((range) => [header(/^'(.*)'!1:1$/.exec(range)[1])]);
    },
  });
  adminSheet.setAdminLakeSheetClientForTests({
    async isConfigured() {
      return true;
    },
    async createSpreadsheet() {
      return { spreadsheetId: 'admin-lake', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/admin-lake/edit', firstTabGid: 0 };
    },
    async writeRaw() {},
    async appendRows() {},
    async shareWithEmail() {},
  });

  const owner = users.createUser({ email: 'owner@example.com' });
  const reporter = users.createUser({ email: 'rita@example.com', name: 'Rita', role: 'reporter' });
  const tokens = { owner: users.createSession(owner.id), reporter: users.createSession(reporter.id) };
  assert.ok(settings.updateLakeSettings({ reportRateUsd: '0.05' }, owner.id).ok);

  const express = require('express');
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/report', require('../dist/routes/report').default);
  app.use('/api/admin/job-lake', require('../dist/routes/jobLake').default);
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (who, method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    ...storage,
    seats,
    tabRows,
    paints,
    call,
    reportRun,
    reporter,
    owner,
    close() {
      server.close();
      columns.setAnalysisSheetsClientForTests();
      columns.resetAnalysisWriteBacksForTests();
      reportSheet.setReportSheetsClientForTests();
      adminSheet.resetAdminLakeSheetForTests();
      reportRun.resetReportRunsForTests();
      ai.resetRegistryForTests();
    },
  };
}

test("the lake's filters are refused by the page exactly when, and in the words, the route refuses them", async (t) => {
  const h = await serve('frontend-lake-filters');
  t.after(() => h.close());
  const lake = display();

  const cases = [
    {},
    { q: 'platform engineer' },
    { company: 'OpenAI, Inc.' },
    { field: 'backend' },
    { salaryMin: '100000' },
    { salaryMin: '100000.50', salaryMax: '200000' },
    { salaryMin: 'lots' },
    { salaryMax: '-5' },
    { salaryMax: '1e5' },
    { salaryMin: ' 120000 ' },
    { updatedFrom: '2026-10-01' },
    { updatedFrom: '2026-10-01', updatedTo: '2026-10-05' },
    { updatedFrom: 'yesterday' },
    { updatedTo: '2026-13-45' },
    { updatedTo: '2026-10-05T12:00:00Z' },
    { requestedBy: 'nobody' },
    // The three facts: an id from the server's own lists, or true/false.
    { jobType: 'remote' },
    { jobType: 'on_site' },
    { jobType: 'not_specified' },
    { jobType: 'onsite' },
    { jobType: 'Remote' },
    { clearance: 'true' },
    { clearance: ' false ' },
    { clearance: 'TRUE' },
    { clearance: 'yes' },
    { industry: 'healthcare' },
    { industry: 'retail_ecommerce' },
    { industry: 'not_specified' },
    { industry: 'Healthcare' },
    { industry: 'unclassified' },
    { jobType: 'hybrid', clearance: 'false', industry: 'other' },
  ];
  // What the job type and industry boxes may choose from: the route's own lists.
  const { options } = (await h.call('owner', 'GET', '/admin/job-lake')).body;
  const { listIndustriesForClient } = require('../dist/config/industries');
  const { listJobTypesForClient } = require('../dist/services/jobAnalysis/facts');
  assert.deepEqual(options, { jobTypes: listJobTypesForClient(), industries: listIndustriesForClient() });
  for (const filters of cases) {
    const form = { ...lake.EMPTY_LAKE_FILTERS, ...filters };
    const problem = lake.lakeFilterProblem(form, options);
    const answer = await h.call('owner', 'GET', `/admin/job-lake?${lake.lakeQueryString(form, 0, 25)}`);
    if (problem) {
      assert.equal(answer.status, 400, JSON.stringify(filters));
      assert.equal(answer.body.error, problem, JSON.stringify(filters));
    } else {
      assert.equal(answer.status, 200, `${JSON.stringify(filters)}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.limit, 25);
    }
  }

  // The query string: what was typed, trimmed, in the form's order, then the page.
  assert.equal(lake.lakeQueryString({ ...lake.EMPTY_LAKE_FILTERS, company: '  Acme ', field: 'backend' }, 50, 25), 'field=backend&company=Acme&limit=25&offset=50');
  assert.equal(
    lake.lakeQueryString({
      q: 'rust',
      company: 'Acme',
      field: 'backend',
      salaryMin: '100000',
      salaryMax: '200000',
      requestedBy: 'acct-1',
      updatedFrom: '2026-10-01',
      updatedTo: '2026-10-05',
      jobType: 'remote',
      clearance: 'false',
      industry: 'finance',
    }),
    'updatedFrom=2026-10-01&updatedTo=2026-10-05&requestedBy=acct-1&field=backend&jobType=remote&clearance=false&' +
      'industry=finance&company=Acme&salaryMin=100000&salaryMax=200000&q=rust'
  );
  assert.equal(lake.lakeQueryString(lake.EMPTY_LAKE_FILTERS), '');
  assert.equal(lake.hasLakeFilters(lake.EMPTY_LAKE_FILTERS), false);
  assert.equal(lake.hasLakeFilters({ ...lake.EMPTY_LAKE_FILTERS, q: ' x ' }), true);
  assert.equal(lake.hasLakeFilters({ ...lake.EMPTY_LAKE_FILTERS, clearance: 'false' }), true);
  // Without the lists the page leaves a job type or an industry to the server's answer.
  assert.equal(lake.lakeFilterProblem({ ...lake.EMPTY_LAKE_FILTERS, jobType: 'onsite', industry: 'Healthcare' }), '');
  assert.equal(lake.lakeFilterProblem({ ...lake.EMPTY_LAKE_FILTERS, clearance: 'yes' }), 'Clearance must be true or false.');
});

test("the filter form's boxes come in the owner's order, and its job type and clearance boxes offer the server's own choices", () => {
  const lake = display();
  // The owner's order: when and who, what kind of job, which company and its pay, then the words.
  assert.deepEqual(
    lake.LAKE_FILTER_ORDER.map((key) => lake.LAKE_FILTER_LABELS[key]),
    ['Updated from', 'Updated to', 'Requested by', 'Job field', 'Job type', 'Clearance', 'Industry', 'Company', 'Salary from', 'Salary to', 'Full text']
  );
  assert.deepEqual([...lake.LAKE_FILTER_ORDER].sort(), Object.keys(lake.EMPTY_LAKE_FILTERS).sort(), 'every filter has its box, once');

  // The page draws its boxes FROM that order and those labels - none typed in a second place - with an input for each.
  const source = fs.readFileSync(path.join(SRC, 'app', 'admin', 'job-lake', 'LakeTab.tsx'), 'utf8');
  assert.match(source, /\{LAKE_FILTER_ORDER\.map\(\(key\) => \(/);
  assert.match(source, /\{LAKE_FILTER_LABELS\[key\]\}/);
  const ids = /const FILTER_INPUT_IDS: [^=]+= \{([\s\S]*?)\};/.exec(source);
  assert.ok(ids, 'LakeTab.tsx names an input id per filter');
  assert.deepEqual([...ids[1].matchAll(/^\s*(\w+):/gm)].map((found) => found[1]), [...lake.LAKE_FILTER_ORDER]);

  // Job type: the server's own ids and words, less the "not specified" the owner's box does not offer.
  const { listJobTypesForClient } = require('../dist/services/jobAnalysis/facts');
  assert.deepEqual(
    lake.LAKE_JOB_TYPE_CHOICES,
    listJobTypesForClient().filter((option) => option.id !== 'not_specified')
  );
  assert.deepEqual(lake.LAKE_JOB_TYPE_CHOICES.map((choice) => choice.label), ['Remote', 'Hybrid', 'Onsite']);
  // Clearance: the route's true and false, in the words the table's column shows them in.
  const cell = (clearance) => lake.lakeFactCells({ jobTypeLabel: '', clearance, industryLabel: '' }).clearance;
  assert.deepEqual(lake.LAKE_CLEARANCE_CHOICES, [
    { id: 'true', label: cell(true) },
    { id: 'false', label: cell(false) },
  ]);
  assert.deepEqual(lake.LAKE_CLEARANCE_CHOICES.map((choice) => choice.label), ['Required', 'Not required']);

  // A push body is the query string's parameters, no more: never a sheet, a tab or a page.
  const form = { ...lake.EMPTY_LAKE_FILTERS, company: ' Acme ', clearance: 'true', q: '  ', industry: 'finance' };
  assert.deepEqual(lake.lakeFilterBody(form), { clearance: 'true', industry: 'finance', company: 'Acme' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(lake.lakeQueryString(form, 50, 25))), {
    ...lake.lakeFilterBody(form),
    limit: '25',
    offset: '50',
  });
  assert.deepEqual(Object.keys(lake.lakeFilterBody(form)), ['clearance', 'industry', 'company'], 'in the form order');
  assert.equal(lake.sameLakeFilters(form, { ...form, company: 'Acme', q: '' }), true);
  assert.equal(lake.sameLakeFilters(form, { ...form, company: 'Acme Corp' }), false);
});

test('Push to Google Sheet asks first, naming how many go and that it replaces Temp For AI, and waits for the search it pushes', () => {
  const lake = display();
  assert.equal(lake.PUSH_TAB, require('../dist/services/sheets/accountSheet').TEMP_TAB);

  const one = lake.describePushConfirm({ matched: 1, maxRows: 1000 });
  assert.match(one, /^Push the 1 job these filters match into the Temp For AI tab of your own job sheet, newest first\? /);
  assert.match(one, /It replaces what that tab holds: every row under its header is emptied, columns A to L/);
  assert.match(one, /Your other tabs, and any column past L, are left as they are\./);
  assert.match(lake.describePushConfirm({ matched: 12, maxRows: null }), /^Push the 12 jobs these filters match into/);
  assert.match(
    lake.describePushConfirm({ matched: 1234, maxRows: 1000 }),
    /^Push the newest 1,000 of the 1,234 jobs these filters match - a push takes at most 1,000 \(JOB_LAKE_PUSH_MAX_ROWS\) - into the Temp For AI tab of your own job sheet/
  );
  // Exactly at the cap nothing is left out, so nothing is said about it.
  assert.doesNotMatch(lake.describePushConfirm({ matched: 1000, maxRows: 1000 }), /JOB_LAKE_PUSH_MAX_ROWS/);
  assert.equal(
    lake.describePushConfirm({ matched: 0, maxRows: 1000 }),
    'No job matches these filters, so a push empties the Temp For AI tab of your own job sheet: every row under its ' +
      'header, columns A to L. Your other tabs, and any column past L, are left as they are.'
  );

  assert.equal(lake.pushBlocker({ loaded: true, failed: false, pushing: false }), '');
  assert.equal(lake.pushBlocker({ loaded: false, failed: false, pushing: false }), 'Wait for the search to finish first.');
  assert.match(lake.pushBlocker({ loaded: true, failed: true, pushing: false }), /could not be read/);
  assert.match(lake.pushBlocker({ loaded: true, failed: false, pushing: true }), /^A push is going/);
});

test('a push sends the filters Search applied: the same jobs in the same order, refused in the same words, and its answer read back to the page', async (t) => {
  const h = await serve('frontend-lake-push');
  const push = require('../dist/services/jobLake/push');
  const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');
  // The administrator's own sheet, its Temp For AI a job tab; the rows each push writes, in order.
  const written = [];
  push.resetLakePushForTests();
  push.setLakePushSheetsClientForTests({
    async inspectTab(_id, tab) {
      return { gid: 9, title: tab, columnCount: 12, rowCount: 1000, headerRow: [...JOB_SHEET_HEADERS], protectedRanges: [] };
    },
    async verifyTab() {
      return { gid: 9, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: true };
    },
    async batchUpdate() {},
    async writeRaw(_id, data) {
      for (const { values } of data) written.push(...values);
    },
  });
  t.after(() => {
    delete process.env.JOB_LAKE_PUSH_MAX_ROWS;
    push.setLakePushSheetsClientForTests();
    push.resetLakePushForTests();
    h.close();
  });
  const lake = display();
  const lakeService = require('../dist/services/jobLake/index');
  const { getJobAnalysisById } = require('../dist/database/jobAnalysisRepository');

  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const filter = (changes) => ({
    jobType: 'not_specified',
    onsiteInterview: 'not_specified',
    companyCategory: 'other',
    clearanceRequired: 'none',
    region: 'not_specified',
    usState: '',
    ...changes,
  });
  const merge = (company, daysAgo, analysis) => {
    const id = storeJobAnalysis({ jobField: 'backend', ...analysis });
    const merged = lakeService.mergeIntoLake(lakeService.lakeJobFromAnalysis(getJobAnalysisById(id), 'merge', { company }), null, {
      reward: false,
      now: now - daysAgo * DAY,
    });
    assert.equal(merged.status, 'added', company);
  };
  merge('Alpha Co', 4, {
    industry: 'technology',
    salary: { min: 100000, max: 120000, currency: 'USD', period: 'annual', raw: null },
    filter: filter({ jobType: 'remote' }),
  });
  merge('Beta LLC', 3, { jobField: 'devops', industry: 'finance', filter: filter({ jobType: 'hybrid', clearanceRequired: 'secret' }) });
  merge('Gamma Inc', 2, { filter: filter({ jobType: 'on_site', companyCategory: 'healthcare' }) });
  merge('Delta Ltd', 1, { industry: 'not_specified', filter: filter({}) });

  const pushAs = async (form) => {
    written.length = 0;
    return h.call('owner', 'POST', '/admin/job-lake/push', lake.lakeFilterBody(form));
  };
  const { options } = (await h.call('owner', 'GET', '/admin/job-lake')).body;
  const since = new Date(now - 2.5 * DAY).toISOString().slice(0, 10);
  const cases = [
    {},
    { jobType: 'remote' },
    { jobType: 'on_site' },
    { jobType: 'not_specified' },
    { clearance: 'true' },
    { clearance: 'false' },
    { industry: 'finance' },
    { industry: 'healthcare' },
    { field: 'backend' },
    { field: 'devops', clearance: 'true' },
    { company: 'alpha co.' },
    { salaryMin: '110000' },
    { updatedFrom: since },
    { requestedBy: 'nobody' },
    { q: 'nothing-matches-this' },
    // Refused, before anything is written - in Search's words.
    { jobType: 'onsite' },
    { clearance: 'yes' },
    { industry: 'Healthcare' },
    { salaryMin: 'lots' },
    { updatedTo: '2026-13-45' },
  ];
  for (const filters of cases) {
    const form = { ...lake.EMPTY_LAKE_FILTERS, ...filters };
    const label = JSON.stringify(filters);
    const problem = lake.lakeFilterProblem(form, options);
    const pushed = await pushAs(form);
    if (problem) {
      assert.equal(pushed.status, 400, label);
      assert.equal(pushed.body.error, problem, label);
      assert.equal(written.length, 0, `${label}: nothing written`);
      continue;
    }
    assert.equal(pushed.status, 200, `${label}: ${JSON.stringify(pushed.body)}`);
    const searched = (await h.call('owner', 'GET', `/admin/job-lake?${lake.lakeQueryString(form, 0, 200)}`)).body;
    assert.equal(pushed.body.matched, searched.total, `${label}: the push matched what Search found`);
    assert.deepEqual(
      written.map((row) => row[2]),
      searched.rows.map((row) => row.company),
      `${label}: the same jobs, in the table's order - newest first`
    );
  }

  // What the page says it did, from the push's own answer - and the tab it links to.
  const all = await pushAs(lake.EMPTY_LAKE_FILTERS);
  assert.deepEqual(written.map((row) => row[2]), ['Delta Ltd', 'Gamma Inc', 'Beta LLC', 'Alpha Co']);
  assert.equal(all.body.tabName, lake.PUSH_TAB);
  assert.equal(lake.describePushResult(all.body), 'Pushed 4 jobs into Temp For AI, newest first, replacing what it held.');
  assert.equal(lake.safeWebLink(all.body.tabUrl), all.body.tabUrl, 'the link to the tab reaches an anchor');
  assert.match(all.body.tabUrl, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/edit#gid=9$/);
  const none = await pushAs({ ...lake.EMPTY_LAKE_FILTERS, company: 'Nobody Here' });
  assert.equal(none.body.pushed, 0);
  assert.equal(lake.describePushResult(none.body), 'No job matched these filters, so Temp For AI is now empty under its header.');

  // Past the cap: the confirm says only the newest go, and the result how many were left out and why.
  process.env.JOB_LAKE_PUSH_MAX_ROWS = '3';
  const page = (await h.call('owner', 'GET', '/admin/job-lake')).body;
  assert.equal(page.pushMaxRows, 3);
  assert.match(
    lake.describePushConfirm({ matched: page.total, maxRows: page.pushMaxRows }),
    /^Push the newest 3 of the 4 jobs these filters match - a push takes at most 3 \(JOB_LAKE_PUSH_MAX_ROWS\) - into the Temp For AI tab/
  );
  const capped = await pushAs(lake.EMPTY_LAKE_FILTERS);
  assert.deepEqual({ pushed: capped.body.pushed, matched: capped.body.matched, capped: capped.body.capped }, { pushed: 3, matched: 4, capped: true });
  assert.deepEqual(written.map((row) => row[2]), ['Delta Ltd', 'Gamma Inc', 'Beta LLC']);
  assert.equal(
    lake.describePushResult(capped.body),
    'Pushed the newest 3 of the 4 jobs these filters match into Temp For AI, replacing what it held. A push writes at ' +
      'most 3 (JOB_LAKE_PUSH_MAX_ROWS), so the oldest was left out: narrow the filters - by date, for one - to choose which go.'
  );
  assert.match(
    lake.describePushResult({ pushed: 1000, matched: 1234, capped: true, maxRows: 1000, tabName: 'Temp For AI' }),
    /^Pushed the newest 1,000 of the 1,234 jobs .* so the older 234 were left out:/
  );
});

test("a lake job's type, clearance and industry read in the server's words, and a row not filled in yet says so", async (t) => {
  const h = await serve('frontend-lake-facts');
  t.after(() => h.close());
  const lake = display();
  const lakeService = require('../dist/services/jobLake/index');
  const { getJobAnalysisById } = require('../dist/database/jobAnalysisRepository');
  const { getDb } = require('../dist/database/sqlite');

  const merge = (company, analysis) => {
    const id = storeJobAnalysis({ jobField: 'backend', ...analysis });
    return lakeService.mergeIntoLake(lakeService.lakeJobFromAnalysis(getJobAnalysisById(id), 'merge', { company }), null, {
      reward: false,
    });
  };
  const filter = (changes) => ({
    jobType: 'not_specified',
    onsiteInterview: 'not_specified',
    companyCategory: 'other',
    clearanceRequired: 'not_specified',
    region: 'not_specified',
    usState: '',
    ...changes,
  });
  // Its own industry, a remote posting needing a clearance word nobody listed.
  const stated = merge('Stated Co', { industry: 'retail_ecommerce', filter: filter({ jobType: 'remote', clearanceRequired: 'top_secret_plus' }) });
  // An analysis from before industries: the company category stands in for it.
  const older = merge('Older Co', { filter: filter({ jobType: 'on_site', companyCategory: 'healthcare', clearanceRequired: 'none' }) });
  // A posting that says none of the three.
  const silent = merge('Silent Co', { industry: 'not_specified', filter: filter({}) });
  // A row an older build wrote, not filled in yet.
  const unfilled = merge('Unfilled Co', { industry: 'finance', filter: filter({ jobType: 'hybrid' }) });
  getDb().prepare('UPDATE job_lake SET job_type = NULL, clearance = NULL, industry = NULL WHERE id = ?').run(unfilled.lakeId);

  const { rows } = (await h.call('owner', 'GET', '/admin/job-lake')).body;
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(lake.lakeFactCells(byId.get(stated.lakeId)), { jobType: 'Remote', clearance: 'Required', industry: 'Retail & E-commerce' });
  assert.deepEqual(lake.lakeFactCells(byId.get(older.lakeId)), { jobType: 'Onsite', clearance: 'Not required', industry: 'Healthcare' });
  assert.deepEqual(lake.lakeFactCells(byId.get(silent.lakeId)), { jobType: '', clearance: 'Not required', industry: '' });
  assert.deepEqual(lake.lakeFactCells(byId.get(unfilled.lakeId)), { jobType: '', clearance: '', industry: '' });

  // The details say a blank out loud: not stated, or not filled in yet.
  assert.deepEqual(lake.describeLakeFacts(byId.get(silent.lakeId)), {
    jobType: 'Not stated',
    clearance: 'Not required',
    industry: 'Not stated',
  });
  assert.deepEqual(lake.describeLakeFacts(byId.get(unfilled.lakeId)), {
    jobType: lake.FACT_NOT_FILLED,
    clearance: lake.FACT_NOT_FILLED,
    industry: lake.FACT_NOT_FILLED,
  });
  const detail = (await h.call('owner', 'GET', `/admin/job-lake/${stated.lakeId}`)).body.entry;
  assert.deepEqual(lake.describeLakeFacts(detail), { jobType: 'Remote', clearance: 'Required', industry: 'Retail & E-commerce' });
  assert.equal(lake.describeFactsLine(detail), 'Remote · Clearance required · Retail & E-commerce');
  assert.equal(lake.describeFactsLine(byId.get(silent.lakeId)), '');

  // Each value the table shows filters to the rows that show it.
  const only = async (filters) =>
    (await h.call('owner', 'GET', `/admin/job-lake?${lake.lakeQueryString({ ...lake.EMPTY_LAKE_FILTERS, ...filters })}`)).body.rows
      .map((row) => row.company)
      .sort();
  assert.deepEqual(await only({ jobType: 'on_site' }), ['Older Co']);
  assert.deepEqual(await only({ jobType: 'not_specified' }), ['Silent Co']);
  assert.deepEqual(await only({ clearance: 'true' }), ['Stated Co']);
  assert.deepEqual(await only({ industry: 'healthcare' }), ['Older Co']);
  assert.deepEqual(await only({ industry: 'not_specified' }), ['Silent Co']);
});

test("a run draws the owner's line from the server's own summary, its red rows are the ones it paints, and a notes tab is refused in the page's words", async (t) => {
  const h = await serve('frontend-lake-run');
  t.after(() => h.close());
  const lake = display();

  // Two postings of one company in one field - the second a duplicate of the
  // first, "ACME, Inc." being "Acme Corp" once normalised - two postings this
  // reporter reported before, as the database records it (the first added,
  // the second a duplicate of it then), and the first posting again lower
  // down: a duplicate of the row above in this very run.
  const lakeService = require('../dist/services/jobLake/index');
  const { getJobAnalysisById } = require('../dist/database/jobAnalysisRepository');
  const reportedBefore = (n) => {
    const id = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: posting(n), jobLink: `https://jobs.example.com/${n}` });
    return lakeService.mergeIntoLake(lakeService.lakeJobFromAnalysis(getJobAnalysisById(id), 'report', { company: 'Old Co' }), h.reporter.id, {
      reward: false,
    });
  };
  assert.equal(reportedBefore(3).status, 'added');
  assert.equal(reportedBefore(4).status, 'duplicate');
  Object.assign(h.tabRows('Today'), {
    2: { C: 'Acme Corp', D: 'Engineer', E: 'https://jobs.example.com/1', F: posting(1) },
    3: { C: 'ACME, Inc.', D: 'Engineer II', E: 'https://jobs.example.com/2', F: posting(2) },
    4: { C: 'Old Co', D: 'Engineer', E: 'https://jobs.example.com/3', F: posting(3) },
    5: { C: 'Old Co', D: 'Engineer III', E: 'https://jobs.example.com/4', F: posting(4) },
    6: { C: 'Acme Corp', D: 'Engineer', E: 'https://jobs.example.com/1', F: posting(1) },
  });

  const preview = await h.call('reporter', 'GET', `/report/rows?tab=Today&from=2&to=10`);
  assert.equal(preview.status, 200);
  assert.deepEqual(
    preview.body.rows.map((row) => [row.row, lake.describePreviewRow(row).label]),
    [
      [2, 'To add'],
      [3, 'To add'],
      [4, 'Reported before (Added) - skipped'],
      [5, 'Reported before (Duplicate) - skipped'],
      [6, 'To add'],
    ]
  );
  const range = lake.readReportRange({ tabName: 'Today', fromRow: '2', toRow: '10' });
  assert.equal(lake.startBlocker({ sheetReady: true, run: null, range, preview: preview.body }), '');
  assert.equal(
    lake.describeReportPreview(preview.body.rows),
    '5 rows hold a job: 3 will be taken to the job lake, and 2 were reported before and will be skipped.'
  );

  const started = await h.call('reporter', 'POST', '/report/runs', range.range);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(lake.isRunLive(started.body.run), true);
  await h.reportRun.waitForReportRun(started.body.run.id);
  const { run } = (await h.call('reporter', 'GET', `/report/runs/${started.body.run.id}`)).body;
  assert.equal(lake.isRunLive(run), false);

  assert.equal(lake.describeRunSummary(run.summary), '1 out of 3 was added, your current credit is $0.05');
  assert.deepEqual(
    run.rows.map((row) => [row.row, lake.reportRowLabel(row), lake.isRedOutcome(row)]),
    [
      [2, 'Added', false],
      [3, 'Duplicate', true],
      [4, 'Reported before (Added)', false],
      [5, 'Reported before (Duplicate)', true],
      [6, 'Duplicate', true],
    ]
  );
  // The pill says what the server's own reason says.
  for (const row of run.rows.filter((entry) => entry.status === 'already-reported')) {
    assert.equal(row.reason, `${lake.describePriorOutcome(row.priorOutcome)}.`);
  }
  // Red on the page is red in the sheet: exactly the rows the run painted.
  assert.deepEqual([...h.paints].sort((a, b) => a - b), run.rows.filter(lake.isRedOutcome).map((row) => row.row));
  assert.equal(lake.describeRunProgress(run), 'Done: 3 rows taken to the job lake.');
  assert.equal(lake.runFraction(run), 1);

  // The same rows previewed again: every posting reported - the second row of
  // the first posting is not (a run makes it a duplicate of the one above) -
  // and over the rows above it, the button says why it waits.
  const again = await h.call('reporter', 'GET', `/report/rows?tab=Today&from=2&to=10`);
  assert.deepEqual(
    again.body.rows.map((row) => [row.row, row.reported, row.priorOutcome]),
    [
      [2, true, 'added'],
      [3, true, 'duplicate'],
      [4, true, 'added'],
      [5, true, 'duplicate'],
      [6, false, null],
    ]
  );
  const upper = lake.readReportRange({ tabName: 'Today', fromRow: '2', toRow: '5' });
  const upperPreview = await h.call('reporter', 'GET', `/report/rows?tab=Today&from=2&to=5`);
  assert.match(lake.startBlocker({ sheetReady: true, run, range: upper, preview: upperPreview.body }), /^Every row in that range was reported before/);

  // A tab of the reporter's own: the preview and the run refuse it in one sentence.
  const notes = await h.call('reporter', 'GET', `/report/rows?tab=${encodeURIComponent('My notes')}&from=2&to=10`);
  assert.equal(notes.body.jobTab, false);
  const notesRange = lake.readReportRange({ tabName: 'My notes', fromRow: '2', toRow: '10' });
  assert.equal(lake.startBlocker({ sheetReady: true, run, range: notesRange, preview: notes.body }), lake.notJobTabMessage('My notes'));
  const refused = await h.call('reporter', 'POST', '/report/runs', notesRange.range);
  assert.equal(refused.status, 202);
  const failed = await h.reportRun.waitForReportRun(refused.body.run.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, lake.notJobTabMessage('My notes'));
});

const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { analysisAnswer, countingSeats, freshInstall, posting, serveInstall, until, untilFinished } = require('./analysisHarness');
const { storeJobAnalysis, useAdminEmails } = require('./helpers');

/**
 * Report Jobs and the administrators' lake, over HTTP (Phase 7): a reporter's
 * run over their own sheet against a sheet held in memory and counting seats -
 * what is analysed (once, and not at all when it was already), what is added,
 * replaced, a duplicate, unclassified or skipped, what is paid and at which
 * rate, what is written into the sheet and painted red, and that running the
 * same rows again pays and analyses nothing. Then the admin merge of build
 * analyses (nobody paid, `requested_by` the build's account) and the admin
 * lake API: query, history, revoke and delete, settings, and the sync.
 */

const TAB = '10/05/2026';
const DAY = 24 * 60 * 60 * 1000;

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const gate = require('../dist/services/jobAnalysis/gate');
const columns = require('../dist/services/sheets/analysisColumns');
const accountSheet = require('../dist/services/sheets/accountSheet');
const reportSheet = require('../dist/services/jobLake/reportSheet');
const reportRun = require('../dist/services/jobLake/reportRun');
const adminSheet = require('../dist/services/jobLake/adminSheet');
const service = require('../dist/services/jobLake/index');
const settings = require('../dist/services/jobLake/settings');
const lake = require('../dist/database/jobLakeRepository');
const analyses = require('../dist/database/jobAnalysisRepository');
const credits = require('../dist/database/creditRepository');
const users = require('../dist/database/userRepository');
const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');

const letter = (n) => String.fromCharCode(64 + n);
const number = (l) => l.charCodeAt(0) - 64;

/**
 * Every account's spreadsheet in memory, behind every Google seam the lake
 * and the analysis columns use. `books[spreadsheetId][tab][row][letter]`.
 */
function fakeGoogle() {
  const books = new Map();
  const calls = { verify: 0, inspect: 0, reads: [], writes: [], updates: [] };
  // failWrites: the next Lake Status (M:O) write fails; failAnalysisWrites: the next analysis (K:P) write.
  const state = { failWrites: 0, failAnalysisWrites: 0 };
  const book = (id) => {
    if (!books.has(id)) books.set(id, new Map());
    return books.get(id);
  };
  const tab = (id, name) => {
    const tabs = book(id);
    if (!tabs.has(name)) tabs.set(name, { header: [...JOB_SHEET_HEADERS], rows: {} });
    return tabs.get(name);
  };
  const parse = (range) => {
    const match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    assert.ok(match, `a range the fake understands: ${range}`);
    return { tab: match[1].replace(/''/g, "'"), fromCol: number(match[2]), fromRow: Number(match[3]), toCol: number(match[4]), toRow: Number(match[5]) };
  };
  const isJobTab = (id, name) => tab(id, name).header[0] === JOB_SHEET_HEADERS[0];
  const client = {
    async verifyTab(id, name) {
      calls.verify += 1;
      return { gid: 7, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: isJobTab(id, name) };
    },
    async inspectTab(id, name) {
      calls.inspect += 1;
      return { gid: 7, title: name, columnCount: 16, rowCount: 1000, headerRow: tab(id, name).header, protectedRanges: [] };
    },
    async readRanges(id, ranges) {
      calls.reads.push(ranges);
      return ranges.map((range) => {
        const { tab: name, fromCol, fromRow, toCol, toRow } = parse(range);
        const rows = tab(id, name).rows;
        const grid = [];
        for (let row = fromRow; row <= toRow; row += 1) {
          const values = [];
          for (let col = fromCol; col <= toCol; col += 1) values.push(rows[row]?.[letter(col)] ?? '');
          grid.push(values);
        }
        return grid;
      });
    },
    async writeRaw(id, data) {
      if (state.failWrites > 0 && data.some((entry) => /!M\d+:O\d+$/.test(entry.range))) {
        state.failWrites -= 1;
        throw new Error('Google Sheets is busy (stub).');
      }
      if (state.failAnalysisWrites > 0 && data.some((entry) => /!K\d+:P\d+$/.test(entry.range))) {
        state.failAnalysisWrites -= 1;
        throw new Error('Google Sheets is busy (stub).');
      }
      calls.writes.push({ id, data });
      for (const { range, values } of data) {
        const { tab: name, fromCol, fromRow } = parse(range);
        const rows = tab(id, name).rows;
        values[0].forEach((value, offset) => {
          if (value === null) return;
          rows[fromRow] = rows[fromRow] ?? {};
          rows[fromRow][letter(fromCol + offset)] = value;
        });
      }
    },
    async batchUpdate(id, requests) {
      calls.updates.push({ id, requests });
    },
  };
  return { books, calls, state, client, tab };
}

/** Allocates each account its own spreadsheet, `sheet-<n>`, with one dated tab. */
function accountSheetClient() {
  let made = 0;
  return {
    async isConfigured() {
      return true;
    },
    async checkCredential() {},
    async createSpreadsheet() {
      made += 1;
      return { spreadsheetId: `sheet-${made}`, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/sheet-${made}/edit`, firstTabGid: 7 };
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
      return [{ title: TAB, gid: 7 }, { title: 'My notes', gid: 8 }];
    },
  };
}

function adminSheetFake() {
  const appended = [];
  return {
    appended,
    client: {
      async isConfigured() {
        return true;
      },
      async createSpreadsheet() {
        return { spreadsheetId: 'admin-lake', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/admin-lake/edit', firstTabGid: 0 };
      },
      async writeRaw() {},
      async appendRows(_id, _range, rows) {
        appended.push(...rows);
      },
      async shareWithEmail() {},
    },
  };
}

/** The field each posting is classified into: 7 fits none. */
function answerByPosting(request) {
  const n = Number(/Posting (\d+):/.exec(request.userBody)?.[1] ?? -1);
  return analysisAnswer({ jobField: n === 7 ? 'unclassified' : 'backend' });
}

async function serve(name) {
  const storage = freshInstall(`lake-${name}`);
  useAdminEmails('owner@example.com');
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  columns.resetAnalysisWriteBacksForTests();
  reportRun.resetReportRunsForTests();
  adminSheet.resetAdminLakeSheetForTests();
  service.setLakeClockForTests();
  const seats = countingSeats(ai, { answer: answerByPosting });

  const google = fakeGoogle();
  columns.setAnalysisSheetsClientForTests(google.client);
  reportSheet.setReportSheetsClientForTests(google.client);
  accountSheet.setSheetsClientForTests(accountSheetClient());
  const adminFake = adminSheetFake();
  adminSheet.setAdminLakeSheetClientForTests(adminFake.client);

  const owner = users.createUser({ email: 'owner@example.com' });
  const reporter = users.createUser({ email: 'reporter@example.com', name: 'Rita', role: 'reporter' });
  const otherReporter = users.createUser({ email: 'other@example.com', name: 'Otto', role: 'reporter' });
  const user = users.createUser({ email: 'user@example.com', name: 'Ursula' });
  const tokens = Object.fromEntries(
    [
      ['owner', owner],
      ['reporter', reporter],
      ['other', otherReporter],
      ['user', user],
    ].map(([key, account]) => [key, users.createSession(account.id)])
  );
  const sheets = {};
  for (const [key, account] of [['reporter', reporter], ['other', otherReporter], ['owner', owner]]) {
    sheets[key] = (await accountSheet.ensureAccountSheet(users.getUserById(account.id))).spreadsheetId;
  }

  const express = require('express');
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/report', require('../dist/routes/report').default);
  app.use('/api/admin/job-lake', require('../dist/routes/jobLake').default);
  app.use('/api/credits', require('../dist/routes/credits').default);
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
    google,
    adminFake,
    owner,
    reporter,
    otherReporter,
    user,
    sheets,
    call,
    async runToEnd(who, body) {
      const started = await call(who, 'POST', '/report/runs', body);
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const finished = await reportRun.waitForReportRun(started.body.run.id);
      return { started: started.body.run, run: (await call(who, 'GET', `/report/runs/${started.body.run.id}`)).body.run, finished };
    },
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

/** A sheet row: B company, C title, D link, E description. */
function sheetRow(company, n, extra = {}) {
  return { B: company, C: `Engineer ${n}`, D: `https://jobs.example.com/${n}`, E: posting(n), ...extra };
}

test("a reporter's run: added, replaced, duplicates, unclassified and skipped, paid at their own rate, written and painted", async (t) => {
  const h = await serve('run');
  t.after(() => h.close());

  // The global rate, set by the administrator; this reporter has a rate of their own.
  const saved = await h.call('owner', 'PUT', '/admin/job-lake/settings', { reportRateUsd: '0.050' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.reportRateMilli, 50);
  users.setReportRateMilli(h.reporter.id, 70);

  // What the lake already holds: Oldco three months ago, Recentco ten days ago.
  const now = Date.now();
  service.mergeIntoLake(
    { company: 'Oldco', jobFieldId: 'backend', title: 'Old', salary: null, url: '', jobDescription: 'old', analysisId: null, source: 'report' },
    h.otherReporter.id,
    { reward: false, now: now - 90 * DAY }
  );
  service.mergeIntoLake(
    { company: 'Recentco', jobFieldId: 'backend', title: 'Recent', salary: null, url: '', jobDescription: 'recent', analysisId: null, source: 'report' },
    h.otherReporter.id,
    { reward: false, now: now - 10 * DAY }
  );
  // Posting 12 was analysed by a build already: it costs no model call.
  const stored12 = storeJobAnalysis({ jobField: 'devops', jobMeta: { title: 'SRE', seniority: 'senior', industry: '', department: '' } }, {
    jobDescription: posting(12),
    jobLink: 'https://jobs.example.com/12',
  });
  // Row 11's posting was reported by this reporter before, as the database records it.
  const stored11 = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: posting(11), jobLink: 'https://jobs.example.com/11' });
  service.mergeIntoLake(
    service.lakeJobFromAnalysis(analyses.getJobAnalysisById(stored11), 'report', { company: 'Company E' }),
    h.reporter.id,
    { reward: false, now: now - 2 * DAY }
  );

  const rows = h.google.tab(h.sheets.reporter, TAB).rows;
  Object.assign(rows, {
    2: sheetRow('Company A', 2),
    3: sheetRow('Company B', 3),
    4: sheetRow('Company A, Inc.', 4), // the same job as row 2, another posting
    5: sheetRow('Oldco', 5), // older than the window: replaces it
    6: sheetRow('Recentco LLC', 6), // within the window: a duplicate
    7: sheetRow('Company U', 7), // no field fits
    // 8 is empty: not a job, not counted
    9: sheetRow('', 9), // no company
    10: sheetRow('Company D', 10, { E: 'Too short.' }),
    11: sheetRow('Company E', 11), // reported before
    14: sheetRow('Company G', 14, { O: 'Added', M: 'abc' }), // a Lake Status nothing reported: not read
    12: sheetRow('Company F', 12),
    13: sheetRow('Company A', 2, { D: 'https://jobs.example.com/2?utm_source=x' }), // row 2's posting again
  });

  // What the page shows before the run.
  const listed = await h.call('reporter', 'GET', `/report/rows?tab=${encodeURIComponent(TAB)}&from=2&to=14`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.jobTab, true);
  assert.deepEqual(listed.body.rows.map((row) => row.row), [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(
    listed.body.rows.filter((row) => row.reported).map((row) => [row.row, row.priorOutcome]),
    [[11, 'added']]
  );
  assert.equal(listed.body.rows[0].descriptionLength, posting(2).length);
  assert.deepEqual(Object.keys(listed.body.rows[0]).sort(), [
    'company', 'descriptionLength', 'jobHash', 'link', 'priorOutcome', 'reported', 'row', 'title',
  ]);
  assert.equal(listed.body.rows[0].jobHash, null);

  const { run, started } = await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 14 });
  assert.equal(started.state, 'running');
  assert.equal(run.state, 'finished', run.error);

  const byRow = Object.fromEntries(run.rows.map((row) => [row.row, row]));
  assert.deepEqual(
    run.rows.map((row) => [row.row, row.status, row.lakeStatus]),
    [
      [2, 'added', 'Added'],
      [3, 'added', 'Added'],
      [4, 'duplicate', 'Duplicate'],
      [5, 'replaced', 'Replaced'],
      [6, 'duplicate', 'Duplicate'],
      [7, 'unclassified', 'Unclassified'],
      [9, 'skipped', 'Skipped'],
      [10, 'skipped', 'Skipped'],
      [11, 'already-reported', 'Added'],
      [12, 'added', 'Added'],
      [13, 'duplicate', 'Duplicate'],
      [14, 'added', 'Added'],
    ]
  );
  assert.match(byRow[9].reason, /no company/);
  assert.match(byRow[10].reason, /too short/);
  assert.match(byRow[13].reason, /same posting is on a row above/, "row 2's posting again, lower down: a duplicate of row 2");
  assert.match(byRow[6].reason, /already has this job/);
  assert.equal(byRow[11].reason, 'Reported before (Added).');
  assert.equal(byRow[11].priorOutcome, 'added');
  assert.equal(byRow[2].priorOutcome, null);
  assert.equal(lake.getLakeEntry(byRow[2].lakeId).seenCount, 2, 'row 4 saw the job again; row 13, the same posting, is not counted twice');

  // Exactly one model call per posting it had to read: 2 (13 shares it), 3, 4, 5, 6, 7, 9, 14.
  assert.equal(h.seats.analyses().length, 8);

  // Paid at the reporter's own rate, for every job the lake accepted - added or replacing.
  assert.deepEqual(run.summary, {
    added: 5,
    total: 11,
    duplicates: 3,
    unclassified: 1,
    replaced: 1,
    skipped: 2,
    failed: 0,
    alreadyReported: 1,
    earnedMilli: 350,
    balanceMilli: 350,
    sheetUpdated: true,
  });
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 350);
  assert.deepEqual(byRow[2].rewardMilli, 70);
  assert.deepEqual(byRow[4].rewardMilli, 0);
  assert.deepEqual(credits.findInconsistentBalances(), []);

  // The lake: Oldco replaced by this reporter, the old version in its history.
  const oldco = lake.getLakeEntry(byRow[5].lakeId);
  assert.equal(oldco.requestedBy, h.reporter.id);
  assert.equal(lake.listLakeHistory(oldco.id)[0].requestedBy, h.otherReporter.id);
  assert.equal(lake.getLakeEntry(byRow[6].lakeId).requestedBy, h.otherReporter.id);
  // Row 12's stored analysis decided its field, not the run.
  assert.equal(lake.getLakeEntry(byRow[12].lakeId).jobFieldId, 'devops');
  assert.ok(analyses.getJobAnalysisById(stored12).mergedAt);
  assert.equal(analyses.getJobAnalysisById(stored12).companyName, 'Company F');

  // The sheet: Job Hash and Lake Status on every row reported, RAW, and the duplicates painted.
  for (const [row, status] of [[2, 'Added'], [4, 'Duplicate'], [5, 'Replaced'], [7, 'Unclassified'], [9, 'Skipped'], [13, 'Duplicate']]) {
    assert.equal(rows[row].O, status, `row ${row}`);
  }
  assert.equal(rows[2].M, byRow[2].jobHash);
  assert.match(rows[2].M, /^[0-9a-f]{64}$/);
  assert.equal(rows[7].M, '', 'an unclassified job has no hash');
  assert.equal(rows[11].O, 'Added', 'a row reported before is given its first outcome');
  assert.equal(rows[14].M, byRow[14].jobHash, 'a status it never wrote did not skip the row');
  assert.ok(rows[2].P && JSON.parse(rows[2].P).id, 'the analysis written back into its cell, once');
  const painted = h.google.calls.updates.flatMap((update) => update.requests);
  assert.deepEqual(
    painted.map((request) => request.repeatCell.range.startRowIndex + 1).sort((a, b) => a - b),
    [4, 6, 13]
  );
  assert.equal(painted[0].repeatCell.fields, 'userEnteredFormat.backgroundColor');
  assert.equal(h.google.calls.updates.length, 1, 'one batched paint per run');
  const statusWrites = h.google.calls.writes.filter((write) => write.data.some((entry) => /!M\d+:O\d+$/.test(entry.range)));
  assert.equal(statusWrites.length, 1, 'one batched status write per run');

  // The admin sheet got every job the lake added and had not sent: this
  // run's five, Oldco as its NEW version only (the old one was never sent),
  // and the seeded Recentco and Company E - and none of the duplicates.
  await until(() => h.adminFake.appended.length >= 7, 'the admin sheet sync');
  assert.deepEqual(h.adminFake.appended.map((line) => `${line[0]} ${line[5]}`).sort(), [
    'Company A reporter@example.com',
    'Company B reporter@example.com',
    'Company E reporter@example.com',
    'Company F reporter@example.com',
    'Company G reporter@example.com',
    'Oldco reporter@example.com',
    'Recentco other@example.com',
  ]);
  // Each line carries the job's type, clearance and industry, from its analysis.
  const companyA = h.adminFake.appended.find((line) => line[0] === 'Company A');
  assert.deepEqual(companyA.slice(8), ['Remote', false, 'Technology']);

  // What the page shows now: each row's first outcome, from the database.
  const after = await h.call('reporter', 'GET', `/report/rows?tab=${encodeURIComponent(TAB)}&from=2&to=14`);
  assert.deepEqual(
    after.body.rows.map((row) => [row.row, row.reported, row.priorOutcome]),
    [
      [2, true, 'added'],
      [3, true, 'added'],
      [4, true, 'duplicate'],
      [5, true, 'replaced'],
      [6, true, 'duplicate'],
      [7, true, 'unclassified'],
      [9, false, null],
      [10, false, null],
      [11, true, 'added'],
      [12, true, 'added'],
      // Row 2's posting again: the run makes it a duplicate of row 2, so it is not skipped.
      [13, false, null],
      [14, true, 'added'],
    ]
  );
  assert.equal(after.body.rows[0].jobHash, byRow[2].jobHash);
  assert.equal(after.body.rows[5].jobHash, null, 'an unclassified posting reached no lake row');

  // The same rows again: nothing analysed, nothing paid, the Skipped ones tried again.
  const before = h.seats.analyses().length;
  h.google.calls.updates.length = 0;
  const again = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 14 })).run;
  assert.equal(h.seats.analyses().length, before, 'no posting analysed twice');
  assert.equal(again.summary.added, 0);
  assert.equal(again.summary.earnedMilli, 0);
  assert.equal(again.summary.alreadyReported, 9);
  assert.equal(again.summary.total, 3, 'rows 9 and 10, still not reportable, and 13');
  assert.deepEqual(
    again.rows.filter((row) => row.status === 'already-reported').map((row) => [row.row, row.priorOutcome]),
    [[2, 'added'], [3, 'added'], [4, 'duplicate'], [5, 'replaced'], [6, 'duplicate'], [7, 'unclassified'], [11, 'added'], [12, 'added'], [14, 'added']]
  );
  assert.equal(again.rows.find((row) => row.row === 13).status, 'duplicate');
  // The duplicates painted red again: the two from before, and row 13 below row 2.
  assert.deepEqual(
    h.google.calls.updates.flatMap((update) => update.requests.map((request) => request.repeatCell.range.startRowIndex + 1)).sort((a, b) => a - b),
    [4, 6, 13]
  );
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 350);
  assert.equal(lake.getLakeEntry(byRow[2].lakeId).seenCount, 2, 'seen no more for being reported again');

  // The overview: the rate in effect and where it comes from, today's earnings, the latest run.
  const overview = await h.call('reporter', 'GET', '/report');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.rate, { rateMilli: 70, source: 'own' });
  assert.equal(overview.body.paid, true);
  assert.equal(overview.body.earnedTodayMilli, 350);
  assert.equal(overview.body.balanceMilli, 350);
  assert.equal(overview.body.lakeJobs, 6);
  assert.equal(overview.body.run.id, again.id);
  assert.equal(overview.body.sheet.spreadsheetId, h.sheets.reporter);
});

test('a run whose statuses never reached the sheet: the next run finds them reported before, marks them Added, analyses and pays nothing', async (t) => {
  const h = await serve('crash');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const rows = h.google.tab(h.sheets.reporter, TAB).rows;
  Object.assign(rows, { 2: sheetRow('Alpha', 2), 3: sheetRow('Beta', 3) });

  h.google.state.failWrites = 1;
  const first = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.equal(first.summary.added, 2);
  assert.equal(first.summary.sheetUpdated, false);
  assert.equal(rows[2].O, undefined);

  const analysed = h.seats.analyses().length;
  const second = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(second.rows.map((row) => [row.status, row.priorOutcome, row.lakeStatus]), [
    ['already-reported', 'added', 'Added'],
    ['already-reported', 'added', 'Added'],
  ]);
  assert.equal(second.rows[0].reason, 'Reported before (Added).');
  assert.equal(second.summary.earnedMilli, 0);
  assert.deepEqual([second.summary.added, second.summary.total, second.summary.alreadyReported], [0, 0, 2]);
  assert.equal(h.seats.analyses().length, analysed);
  assert.equal(rows[2].O, 'Added');
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 100);
});

test('the same posting reported again - moved, another row, another tab - is "Reported before", unpaid; twice in one run, the second is red', async (t) => {
  const h = await serve('pasted-again');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const today = h.google.tab(h.sheets.reporter, TAB).rows;
  today[8] = sheetRow('NewCo', 8);
  const first = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 8, toRow: 8 })).run;
  assert.deepEqual(first.rows.map((row) => [row.row, row.status, row.lakeStatus]), [[8, 'added', 'Added']]);
  const lakeId = first.rows[0].lakeId;
  const addedAt = lake.getLakeEntry(lakeId).updatedAt;

  // The row moved: sorted further down, and its cells with it.
  today[30] = today[8];
  delete today[8];
  const moved = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 40 })).run;
  assert.deepEqual(moved.rows.map((row) => [row.row, row.status, row.priorOutcome, row.lakeStatus]), [
    [30, 'already-reported', 'added', 'Added'],
  ]);
  assert.equal(moved.summary.total, 0);

  // Later: the identical posting on row 20 too, and on a new tab's row 2 -
  // with another posting for the same job under it.
  today[20] = sheetRow('NewCo', 8);
  const later = h.google.tab(h.sheets.reporter, 'Run E').rows;
  Object.assign(later, { 2: sheetRow('NewCo', 8), 3: sheetRow('NewCo Inc.', 9) });
  h.google.calls.updates.length = 0;

  // Rows 20 and 30 in one run: the first is reported before, the second a duplicate of it.
  const sameTab = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 20, toRow: 30 })).run;
  assert.deepEqual(sameTab.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [20, 'already-reported', 'Added'],
    [30, 'duplicate', 'Duplicate'],
  ]);
  assert.match(sameTab.rows[1].reason, /same posting is on a row above/);
  // Another tab: reported before; the other posting of the job, a duplicate like any.
  const newTab = (await h.runToEnd('reporter', { tabName: 'Run E', fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(newTab.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [2, 'already-reported', 'Added'],
    [3, 'duplicate', 'Duplicate'],
  ]);
  assert.deepEqual([newTab.summary.added, newTab.summary.duplicates, newTab.summary.alreadyReported], [0, 1, 1]);

  assert.deepEqual([today[20].O, today[30].O, later[2].O, later[3].O], ['Added', 'Duplicate', 'Added', 'Duplicate']);
  const painted = h.google.calls.updates.flatMap((update) => update.requests.map((request) => request.repeatCell.range.startRowIndex + 1));
  assert.deepEqual(painted, [30, 3], 'only the duplicates painted red');
  const entry = lake.getLakeEntry(lakeId);
  assert.equal(entry.seenCount, 2, 'seen again only for the other posting of the job');
  assert.equal(entry.updatedAt, addedAt, 'the window still runs from the add');
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 50, 'paid once, for row 8');
  assert.equal(h.seats.analyses().length, 2, 'postings 8 and 9, once each');

  // A later run of the new tab: row 3's first outcome was a duplicate - red again.
  h.google.calls.updates.length = 0;
  const again = (await h.runToEnd('reporter', { tabName: 'Run E', fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(again.rows.map((row) => [row.row, row.status, row.priorOutcome]), [
    [2, 'already-reported', 'added'],
    [3, 'already-reported', 'duplicate'],
  ]);
  assert.deepEqual(
    h.google.calls.updates.flatMap((update) => update.requests.map((request) => request.repeatCell.range.startRowIndex + 1)),
    [3]
  );
  assert.equal(lake.getLakeEntry(lakeId).seenCount, 2);
});

test('the same new posting twice in one run: the first is added, the second a red duplicate, and the preview says neither was reported', async (t) => {
  const h = await serve('twice-in-a-run');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  Object.assign(h.google.tab(h.sheets.reporter, TAB).rows, {
    2: sheetRow('TwinCo', 2),
    3: sheetRow('Unrelated', 3),
    4: sheetRow('TwinCo', 2, { D: 'https://jobs.example.com/2#apply' }),
    5: sheetRow('NoFieldCo', 7),
    6: sheetRow('NoFieldCo', 7),
  });
  const preview = await h.call('reporter', 'GET', `/report/rows?tab=${encodeURIComponent(TAB)}&from=2&to=6`);
  assert.deepEqual(preview.body.rows.map((row) => row.reported), [false, false, false, false, false]);

  const { run } = await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 6 });
  assert.deepEqual(run.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [2, 'added', 'Added'],
    [3, 'added', 'Added'],
    [4, 'duplicate', 'Duplicate'],
    [5, 'unclassified', 'Unclassified'],
    // An unclassified posting twice: unclassified both times, never a duplicate of nothing.
    [6, 'unclassified', 'Unclassified'],
  ]);
  assert.equal(run.rows[2].lakeId, run.rows[0].lakeId);
  assert.equal(h.google.calls.updates.flatMap((update) => update.requests).length, 1, 'one row painted');
  assert.equal(h.google.calls.updates[0].requests[0].repeatCell.range.startRowIndex + 1, 4);
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 100);
  assert.equal(lake.getLakeEntry(run.rows[0].lakeId).seenCount, 1);
  assert.equal(h.seats.analyses().length, 3);
});

test('a job an older build deleted from the lake is not "Reported before": the preview says so, the run adds it again, and so does a row it re-added once deleted here', async (t) => {
  const h = await serve('older-build-delete');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const db = require('../dist/database/sqlite').getDb();
  const rows = h.google.tab(h.sheets.reporter, TAB).rows;
  rows[2] = sheetRow('Hooli', 2);
  const first = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 2 })).run;
  assert.deepEqual(first.rows.map((row) => row.status), ['added']);
  const firstId = first.rows[0].lakeId;
  const preview = () => h.call('reporter', 'GET', `/report/rows?tab=${encodeURIComponent(TAB)}&from=2&to=2`);

  // Rolled back to a build that knew nothing of job_reports, an administrator
  // deletes the job: its history, then the row - and the record stays behind.
  const olderBuildDelete = (id) => {
    db.prepare('DELETE FROM job_lake_history WHERE lake_id = ?').run(id);
    db.prepare('DELETE FROM job_lake WHERE id = ?').run(id);
  };
  olderBuildDelete(firstId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_reports WHERE lake_id = ?').get(firstId).n, 1);

  const listed = await preview();
  assert.deepEqual(listed.body.rows.map((row) => [row.reported, row.priorOutcome, row.jobHash]), [[false, null, null]]);
  // The posting twice in the run: the first row is added again, the second a
  // duplicate of it - never "reported before" above a row that adds the job.
  rows[3] = sheetRow('Hooli', 2);
  const again = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(again.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [2, 'added', 'Added'],
    [3, 'duplicate', 'Duplicate'],
  ]);
  assert.match(again.rows[1].reason, /same posting is on a row above/);
  assert.equal(again.summary.alreadyReported, 0);
  delete rows[3];
  const secondId = again.rows[0].lakeId;
  assert.notEqual(secondId, firstId);
  const { analysisId, jobHash: hash } = lake.getLakeEntry(secondId);
  assert.equal(lake.findJobReports(h.reporter.id, [analysisId]).get(analysisId).lakeId, secondId, 'the stale record replaced');
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 100, 'a deleted job reported again is a new one, paid');

  // The older build again: it deletes the job, the reporter reports it there
  // (a new row, its facts NULL), and this build starts - which records the
  // report against the row it re-added, so Delete here forgets it.
  olderBuildDelete(secondId);
  const at = new Date().toISOString();
  const readded = Number(
    db
      .prepare(
        `INSERT INTO job_lake (job_hash, hash_version, company, company_key, job_field_id, analysis_id, requested_by, source,
           created_at, updated_at, reward_milli)
         VALUES (?, 1, 'Hooli', 'hooli', 'backend', ?, ?, 'report', ?, ?, 0)`
      )
      .run(hash, analysisId, h.reporter.id, at, at).lastInsertRowid
  );
  assert.deepEqual(require('../dist/database/jobLakeFacts').fillLakeFacts(db), { lakeRows: 1, historyRows: 0, reportsRecorded: 1 });
  assert.equal(lake.findJobReports(h.reporter.id, [analysisId]).get(analysisId).lakeId, readded);
  assert.deepEqual((await preview()).body.rows.map((row) => [row.reported, row.priorOutcome]), [[true, 'added']]);

  assert.equal((await h.call('owner', 'DELETE', `/admin/job-lake/${readded}`)).status, 200);
  assert.deepEqual((await preview()).body.rows.map((row) => row.reported), [false]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_reports').get().n, 0, 'every record of it forgotten');
  const third = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 2 })).run;
  assert.deepEqual(third.rows.map((row) => row.status), ['added']);
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test('a Lake Status left behind by another posting does not skip the job now in the row', async (t) => {
  const h = await serve('stale-status');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const rows = h.google.tab(h.sheets.reporter, TAB).rows;
  rows[2] = sheetRow('NewCo', 9);
  assert.equal((await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 2 })).run.rows[0].status, 'added');
  const newcoHash = rows[2].M;
  assert.equal(rows[2].O, 'Added');

  // A new batch pasted over B:E. The protected K:P cannot be cleared, so
  // NewCo's analysis, hash and status stay beside FreshCo's posting.
  Object.assign(rows[2], { B: 'FreshCo', C: 'Engineer 1', D: 'https://jobs.example.com/1', E: posting(1) });
  const listed = await h.call('reporter', 'GET', `/report/rows?tab=${encodeURIComponent(TAB)}&from=2&to=2`);
  assert.equal(listed.body.rows[0].reported, false, "NewCo's status is not FreshCo's");

  const run = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 2 })).run;
  assert.deepEqual(run.rows.map((row) => [row.status, row.lakeStatus]), [['added', 'Added']]);
  assert.equal(run.summary.earnedMilli, 50);
  assert.deepEqual(lake.queryLake({ limit: 10, offset: 0 }).rows.map((row) => row.company).sort(), ['FreshCo', 'NewCo']);
  // The row's cells are FreshCo's now, the lake's two written last.
  const fresh = lake.getLakeEntry(run.rows[0].lakeId);
  assert.equal(JSON.parse(rows[2].P).id, fresh.analysisId);
  assert.equal(rows[2].M, fresh.jobHash);
  assert.notEqual(rows[2].M, newcoHash);
  assert.equal(rows[2].O, 'Added');

  // And now the status IS the row's own: the next run skips it.
  const again = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 2 })).run;
  assert.deepEqual(again.rows.map((row) => row.status), ['already-reported']);
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 100);
  assert.equal(h.seats.analyses().length, 2);
});

test("a row Skipped once, and a row whose analysis cells failed to write, both get their analysis cells next time", async (t) => {
  const h = await serve('cells-later');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const rows = h.google.tab(h.sheets.reporter, TAB).rows;
  // Row 2 has no description yet; row 3's analysis write fails, its status lands.
  Object.assign(rows, { 2: sheetRow('LateCo', 2, { E: '' }), 3: sheetRow('Alpha', 3) });
  h.google.state.failAnalysisWrites = 1;
  const first = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(first.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [2, 'skipped', 'Skipped'],
    [3, 'added', 'Added'],
  ]);
  assert.equal(rows[3].P, undefined, 'the analysis write failed');
  assert.equal(rows[3].O, 'Added', 'the status landed');

  rows[2].E = posting(2);
  const second = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(second.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [2, 'added', 'Added'],
    [3, 'already-reported', 'Added'],
  ]);
  // The lake's own Job Hash and Lake Status are no reason to leave a row without its analysis.
  for (const row of [2, 3]) {
    const entry = lake.getLakeEntry(second.rows.find((outcome) => outcome.row === row).lakeId);
    assert.equal(rows[row].K, 'Backend', `row ${row}`);
    assert.ok(rows[row].N, `row ${row}`);
    assert.equal(JSON.parse(rows[row].P).id, entry.analysisId, `row ${row}`);
    assert.equal(rows[row].M, entry.jobHash, `row ${row}`);
    assert.equal(rows[row].O, 'Added', `row ${row}`);
  }
  assert.equal(h.seats.analyses().length, 2, 'Alpha was not analysed again');
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 100, 'Alpha was not paid again');

  // With both cells in place, the rows are reported for good.
  const third = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(third.rows.map((row) => row.status), ['already-reported', 'already-reported']);
});

test('a seat that fails on one row, or a merge that fails on one, fails only that row; a re-run finishes it, paid once', async (t) => {
  const h = await serve('row-failures');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const rows = h.google.tab(h.sheets.reporter, TAB).rows;
  Object.assign(rows, { 2: sheetRow('Alpha', 2), 3: sheetRow('Beta', 3) });

  // The seat fails the first analysis it is asked for.
  h.seats.failAnalyses = 1;
  const first = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.equal(first.state, 'finished', first.error);
  const failed = first.rows.find((row) => row.status === 'failed');
  const added = first.rows.find((row) => row.status === 'added');
  assert.ok(failed && added, JSON.stringify(first.rows));
  assert.equal(failed.lakeStatus, null);
  assert.match(failed.reason, /could not be analysed.*\(Ref: ERR-[0-9A-F]{6}\)/);
  assert.equal(rows[failed.row].O, undefined, 'no status for the row that failed');
  assert.equal(rows[failed.row].P, undefined);
  assert.equal(rows[added.row].O, 'Added');
  assert.deepEqual([first.summary.added, first.summary.failed, first.summary.earnedMilli], [1, 1, 50]);

  const second = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 3 })).run;
  assert.deepEqual(
    second.rows.map((row) => [row.row, row.status]),
    [2, 3].map((row) => [row, row === failed.row ? 'added' : 'already-reported'])
  );
  assert.equal(h.seats.analyses().length, 3, 'a failed call stored nothing: the posting is analysed on the re-run');
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 100);

  // A merge that fails: the merge and its reward are one transaction, so
  // nothing of the row moved, and it keeps no status.
  const db = require('../dist/database/sqlite').getDb();
  db.exec("CREATE TEMP TRIGGER fail_merge BEFORE INSERT ON job_lake WHEN NEW.company = 'Gamma' BEGIN SELECT RAISE(ABORT, 'stub'); END");
  t.after(() => db.exec('DROP TRIGGER IF EXISTS fail_merge'));
  Object.assign(rows, { 4: sheetRow('Gamma', 4), 5: sheetRow('Delta', 5) });
  const third = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 4, toRow: 5 })).run;
  assert.deepEqual(third.rows.map((row) => [row.row, row.status, row.lakeStatus]), [
    [4, 'failed', null],
    [5, 'added', 'Added'],
  ]);
  assert.match(third.rows[0].reason, /could not be added to the lake/);
  assert.equal(rows[4].O, undefined);
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 150, 'nothing paid for the row that failed');
  db.exec('DROP TRIGGER fail_merge');
  const fourth = (await h.runToEnd('reporter', { tabName: TAB, fromRow: 4, toRow: 5 })).run;
  assert.deepEqual(fourth.rows.map((row) => [row.row, row.status]), [[4, 'added'], [5, 'already-reported']]);
  assert.equal(rows[4].O, 'Added');
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 200, 'paid once');
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test('Lake Status cells go only into rows that still hold the posting reported from them', async (t) => {
  t.after(() => reportSheet.setReportSheetsClientForTests());
  const google = fakeGoogle();
  reportSheet.setReportSheetsClientForTests(google.client);
  // What the run read, and what the rows hold by the time it writes: row 2
  // sorted away (another company), row 3 the same company on another
  // posting's link, row 4 as it was.
  Object.assign(google.tab('sheet-x', TAB).rows, {
    2: sheetRow('Other Co', 2),
    3: sheetRow('Moved Co', 3, { D: 'https://jobs.example.com/elsewhere' }),
    4: sheetRow('Kept Co', 4),
  });
  const report = await reportSheet.writeLakeStatuses('sheet-x', TAB, 7, [
    { row: 2, company: 'Moved Co', link: 'https://jobs.example.com/2', jobHash: 'a'.repeat(64), status: 'Duplicate', red: true },
    { row: 3, company: 'Moved Co', link: 'https://jobs.example.com/3', jobHash: 'b'.repeat(64), status: 'Added', red: false },
    { row: 4, company: 'Kept Co', link: 'https://jobs.example.com/4', jobHash: 'c'.repeat(64), status: 'Duplicate', red: true },
  ]);
  assert.deepEqual(report, { written: 1, skipped: 2, painted: 1 });
  assert.deepEqual(google.calls.writes.flatMap((write) => write.data.map((entry) => entry.range)), [`'${TAB}'!M4:O4`]);
  const rows = google.tab('sheet-x', TAB).rows;
  assert.deepEqual([rows[2].O, rows[3].O, rows[4].O], [undefined, undefined, 'Duplicate']);
  assert.deepEqual(
    google.calls.updates.flatMap((update) => update.requests.map((request) => request.repeatCell.range.startRowIndex + 1)),
    [4],
    'only the row that still holds its posting is painted red'
  );
});

test('two reporters, the same job: one is paid for it, the other gets a red duplicate', async (t) => {
  const h = await serve('two-reporters');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  Object.assign(h.google.tab(h.sheets.reporter, TAB).rows, { 2: sheetRow('Shared Co', 2) });
  Object.assign(h.google.tab(h.sheets.other, TAB).rows, { 2: sheetRow('Shared Co.', 3) });
  const [mine, theirs] = await Promise.all([
    h.runToEnd('reporter', { tabName: TAB, fromRow: 2, toRow: 2 }),
    h.runToEnd('other', { tabName: TAB, fromRow: 2, toRow: 2 }),
  ]);
  assert.deepEqual([mine.run.rows[0].status, theirs.run.rows[0].status].sort(), ['added', 'duplicate']);
  assert.equal(users.getUserById(h.reporter.id).balanceMilli + users.getUserById(h.otherReporter.id).balanceMilli, 50);
});

test('a run is refused on a tab that is not a job tab, a second run while one goes, and rows outside the range rules', async (t) => {
  const h = await serve('refusals');
  t.after(() => h.close());
  const notes = h.google.tab(h.sheets.reporter, 'My notes');
  notes.header = ['Notes'];
  notes.rows[2] = { B: 'not a company' };

  const listed = await h.call('reporter', 'GET', '/report/rows?tab=My%20notes&from=2&to=5');
  assert.deepEqual([listed.status, listed.body.jobTab, listed.body.rows], [200, false, []]);
  const { run } = await h.runToEnd('reporter', { tabName: 'My notes', fromRow: 2, toRow: 5 });
  assert.equal(run.state, 'failed');
  assert.match(run.error, /not laid out as a job sheet tab/);

  for (const body of [
    { tabName: TAB, fromRow: 1, toRow: 5 },
    { tabName: TAB, fromRow: 5, toRow: 4 },
    { tabName: TAB, fromRow: 2, toRow: 2 + reportRun.MAX_REPORT_RUN_ROWS },
    { fromRow: 2, toRow: 3 },
  ]) {
    const refused = await h.call('reporter', 'POST', '/report/runs', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }

  // One run at a time, per account.
  h.seats.hold();
  Object.assign(h.google.tab(h.sheets.reporter, TAB).rows, { 2: sheetRow('Held Co', 2) });
  const going = await h.call('reporter', 'POST', '/report/runs', { tabName: TAB, fromRow: 2, toRow: 2 });
  assert.equal(going.status, 202);
  const second = await h.call('reporter', 'POST', '/report/runs', { tabName: TAB, fromRow: 2, toRow: 2 });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'run-in-progress');
  assert.equal(second.body.runId, going.body.run.id);
  const current = await h.call('reporter', 'GET', '/report/runs/current');
  assert.equal(current.body.run.state, 'running');
  // Nobody else reads it.
  assert.equal((await h.call('other', 'GET', `/report/runs/${going.body.run.id}`)).status, 404);
  h.seats.release();
  await reportRun.waitForReportRun(going.body.run.id);
});

test('who reaches what: a user is refused Report Jobs, a reporter the admin lake, an admin opens both unpaid', async (t) => {
  const h = await serve('access');
  t.after(() => h.close());
  const refusedUser = await h.call('user', 'GET', '/report');
  assert.equal(refusedUser.status, 403);
  assert.equal(refusedUser.body.code, 'role-not-allowed');
  assert.equal((await h.call('user', 'POST', '/report/runs', { tabName: TAB, fromRow: 2, toRow: 2 })).status, 403);
  const refusedReporter = await h.call('reporter', 'GET', '/admin/job-lake');
  assert.equal(refusedReporter.status, 403);
  assert.equal(refusedReporter.body.code, 'not-an-admin');

  const adminOverview = await h.call('owner', 'GET', '/report');
  assert.equal(adminOverview.status, 200);
  assert.equal(adminOverview.body.paid, false);
  // A reporter's tabs are their own sheet's; nothing in the request can name another.
  const tabs = await h.call('reporter', 'GET', `/report/tabs?sheetId=${h.sheets.other}`);
  assert.equal(tabs.body.spreadsheetId, h.sheets.reporter);
});

test("with no Google credential Report Jobs says so in its own words, and the README's row quotes them", async (t) => {
  const h = await serve('unconfigured');
  t.after(() => {
    accountSheet.setSheetsClientForTests(accountSheetClient());
    h.close();
  });
  accountSheet.setSheetsClientForTests({ ...accountSheetClient(), isConfigured: async () => false });
  const overview = await h.call('reporter', 'GET', '/report');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.sheet.configured, false);
  const message = overview.body.sheet.message;
  assert.match(message, /before jobs can be reported\.$/);

  // The Troubleshooting row a reporter finds this under quotes what THIS page
  // shows - not Settings -> Job Sheet's sentence, which ends otherwise.
  const fs = require('node:fs');
  const path = require('node:path');
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const row = readme.split('\n').find((line) => line.startsWith("| A reporter's account menu has no **Your job sheet**"));
  assert.ok(row, 'the Troubleshooting row for a reporter with no sheet');
  assert.ok(row.includes(`**Report Jobs** says *${message}*`), row);
});

test('the admin merge offers analysed, unmerged build jobs with a field and a company, and pays nobody', async (t) => {
  const h = await serve('merge');
  t.after(() => h.close());
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const at = (n) => ({ jobDescription: `${posting(n)} merge`, createdBy: h.user.id });
  const offered = storeJobAnalysis({ jobField: 'backend' }, { ...at(1), companyName: 'Merge Co' });
  const sameJob = storeJobAnalysis({ jobField: 'backend' }, { ...at(2), companyName: 'Merge Company', createdBy: h.otherReporter.id });
  const unclassified = storeJobAnalysis({ jobField: 'unclassified' }, { ...at(3), companyName: 'Nofield Co' });
  const noCompany = storeJobAnalysis({ jobField: 'frontend' }, at(4));
  const mergedBefore = storeJobAnalysis({ jobField: 'devops' }, { ...at(5), companyName: 'Done Co' });
  analyses.markJobAnalysisMerged(mergedBefore, new Date().toISOString());

  const listed = await h.call('owner', 'GET', '/admin/job-lake/merge');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.rows.map((row) => row.analysisId).sort(), [offered, sameJob].sort());
  assert.equal(listed.body.total, 2);
  const offeredRow = listed.body.rows.find((row) => row.analysisId === offered);
  assert.equal(offeredRow.company, 'Merge Co');
  assert.deepEqual(offeredRow.requester, { id: h.user.id, email: 'user@example.com', name: 'Ursula' });

  // Selected, with ones that are not offered among them.
  const picked = await h.call('owner', 'POST', '/admin/job-lake/merge', { analysisIds: [offered, unclassified, noCompany, mergedBefore, 'nope'] });
  assert.equal(picked.status, 200);
  assert.deepEqual(
    picked.body.results.map((result) => result.status),
    ['added', 'unclassified', 'not-offered', 'merged-before', 'not-found']
  );
  // The rest: the same job as the first, a duplicate, reported as one.
  const rest = await h.call('owner', 'POST', '/admin/job-lake/merge', { all: true });
  assert.deepEqual([rest.body.merged, rest.body.added, rest.body.duplicates, rest.body.remaining], [1, 0, 1, 0]);

  const entry = lake.getLakeEntry(picked.body.results[0].lakeId);
  assert.equal(entry.requestedBy, h.user.id, 'requested_by is the account whose build produced it');
  assert.equal(entry.source, 'merge');
  assert.deepEqual(entry.reward, { milli: 0, rateMilli: null, revokedMilli: 0, revokedAt: null });
  assert.equal(users.getUserById(h.user.id).balanceMilli, 0);
  assert.equal(users.getUserById(h.otherReporter.id).balanceMilli, 0, 'a merge pays nobody, a reporter included');
  assert.ok(analyses.getJobAnalysisById(offered).mergedAt);
  assert.ok(analyses.getJobAnalysisById(sameJob).mergedAt);
  assert.equal(analyses.getJobAnalysisById(unclassified).mergedAt, null);
  // No model was asked for any of it.
  assert.equal(h.seats.analyses().length, 0);

  assert.equal((await h.call('owner', 'POST', '/admin/job-lake/merge', {})).status, 400);
});

test('the admin lake: query, a row and its history, revoke and delete, settings and where the window comes from, the sync', async (t) => {
  const h = await serve('admin-api');
  t.after(() => {
    h.close();
    delete process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS;
  });
  settings.updateLakeSettings({ reportRateUsd: '0.100' }, 'admin');
  const now = Date.now();
  const job = (company, extra = {}) => ({ company, jobFieldId: 'backend', title: 'Engineer', salary: null, url: '', jobDescription: `${company} builds distributed systems`, analysisId: null, source: 'report', ...extra });
  const first = service.mergeIntoLake(job('Lakeco', { title: 'First' }), h.otherReporter.id, { reward: true, now: now - 100 * DAY });
  service.mergeIntoLake(job('Lakeco', { title: 'Second' }), h.reporter.id, { reward: true, now });
  service.mergeIntoLake(job('Pondco', { jobFieldId: 'frontend', jobType: 'remote', clearance: true, industry: 'military' }), h.reporter.id, {
    reward: true,
    now,
  });

  const all = await h.call('owner', 'GET', '/admin/job-lake?limit=10');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2);
  assert.deepEqual(all.body.rows[0].requester.email, 'reporter@example.com');
  assert.deepEqual((await h.call('owner', 'GET', '/admin/job-lake?field=frontend')).body.rows.map((row) => row.company), ['Pondco']);
  assert.deepEqual((await h.call('owner', 'GET', '/admin/job-lake?q=distributed%20lake')).body.rows.map((row) => row.company), ['Lakeco']);
  assert.deepEqual((await h.call('owner', 'GET', '/admin/job-lake?company=LAKECO%20Inc.')).body.rows.map((row) => row.company), ['Lakeco']);
  assert.equal((await h.call('owner', 'GET', '/admin/job-lake?field=nonsense')).status, 400);
  assert.equal((await h.call('owner', 'GET', '/admin/job-lake?salaryMin=lots')).status, 400);
  assert.equal((await h.call('owner', 'GET', '/admin/job-lake?updatedFrom=yesterday')).status, 400);
  // The three facts: on every row with their words, and filters of their own, refused by name when off the list.
  const pondRow = all.body.rows.find((row) => row.company === 'Pondco');
  assert.deepEqual(
    [pondRow.jobType, pondRow.jobTypeLabel, pondRow.clearance, pondRow.industry, pondRow.industryLabel],
    ['remote', 'Remote', true, 'military', 'Military']
  );
  const lakeco = all.body.rows.find((row) => row.company === 'Lakeco');
  assert.deepEqual([lakeco.jobType, lakeco.jobTypeLabel, lakeco.clearance, lakeco.industry, lakeco.industryLabel], ['', '', false, 'not_specified', '']);
  const companies = async (query) => (await h.call('owner', 'GET', `/admin/job-lake?${query}`)).body.rows.map((row) => row.company);
  assert.deepEqual(await companies('jobType=remote'), ['Pondco']);
  assert.deepEqual(await companies('jobType=not_specified'), ['Lakeco']);
  assert.deepEqual(await companies('clearance=true'), ['Pondco']);
  assert.deepEqual(await companies('clearance=false'), ['Lakeco']);
  assert.deepEqual(await companies('industry=military&jobType=remote&clearance=true'), ['Pondco']);
  assert.deepEqual(await companies('industry=not_specified'), ['Lakeco']);
  for (const [query, error] of [
    ['jobType=office', 'That job type is not one of the list.'],
    ['clearance=maybe', 'Clearance must be true or false.'],
    ['industry=fintech', 'That industry is not one of the list.'],
  ]) {
    const refused = await h.call('owner', 'GET', `/admin/job-lake?${query}`);
    assert.deepEqual([refused.status, refused.body.error], [400, error], query);
  }
  // What the selects offer, in the server's words.
  assert.deepEqual(all.body.options.jobTypes.map((option) => option.label), ['Remote', 'Hybrid', 'Onsite', 'Not specified']);
  assert.equal(all.body.options.industries.length, 20);
  assert.deepEqual(all.body.options.industries.at(-1), { id: 'not_specified', label: 'Not specified' });

  const detail = await h.call('owner', 'GET', `/admin/job-lake/${first.lakeId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.entry.title, 'Second');
  assert.equal(detail.body.entry.jobDescription, 'Lakeco builds distributed systems');
  assert.deepEqual(detail.body.history.map((version) => [version.title, version.requester.email]), [['First', 'other@example.com']]);
  assert.equal((await h.call('owner', 'GET', '/admin/job-lake/999999')).status, 404);
  assert.equal((await h.call('owner', 'GET', '/admin/job-lake/abc')).status, 404);

  // Revoke: once, and the reporter is told.
  const revoked = await h.call('owner', 'POST', `/admin/job-lake/${first.lakeId}/revoke-reward`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoke.takenMilli, 100);
  assert.equal(revoked.body.entry.reward.revokedMilli, 100);
  assert.equal((await h.call('owner', 'POST', `/admin/job-lake/${first.lakeId}/revoke-reward`)).body.revoke.revoked, false);
  const { listNotificationsFor } = require('../dist/database/notificationRepository');
  const notices = listNotificationsFor(h.reporter.id).map((notice) => notice.title);
  assert.ok(notices.includes('Job reward taken back: $0.1'), notices.join('\n'));
  assert.deepEqual(listNotificationsFor(h.otherReporter.id).map((notice) => notice.title), [], 'only the reporter it was taken from');
  const ledger = await h.call('reporter', 'GET', '/credits/ledger');
  assert.deepEqual(ledger.body.entries.map((entry) => [entry.reason, entry.deltaMilli]), [
    ['job-report-reward-revoked', -100],
    ['job-report-reward', 100],
    ['job-report-reward', 100],
  ]);

  // Delete with the reward revoked.
  const pond = all.body.rows.find((row) => row.company === 'Pondco');
  const deleted = await h.call('owner', 'DELETE', `/admin/job-lake/${pond.id}?revokeReward=1`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.revoke.takenMilli, 100);
  assert.equal(lake.getLakeEntry(pond.id), null);
  assert.equal(users.getUserById(h.reporter.id).balanceMilli, 0);
  assert.equal((await h.call('owner', 'DELETE', `/admin/job-lake/${pond.id}`)).status, 404);

  // Settings: the window in effect and where it came from.
  process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS = '45';
  let read = await h.call('owner', 'GET', '/admin/job-lake/settings');
  assert.deepEqual([read.body.settings.duplicateWindow.days, read.body.settings.duplicateWindow.source], [45, 'env']);
  const put = await h.call('owner', 'PUT', '/admin/job-lake/settings', { duplicateWindowDays: '30', dailyCapUsd: '2.5' });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.settings.duplicateWindow.days, put.body.settings.duplicateWindow.source], [30, 'admin']);
  assert.equal(put.body.settings.dailyCapMilli, 2500);
  const bad = await h.call('owner', 'PUT', '/admin/job-lake/settings', { reportRateUsd: '0.0001' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad-rate');
  read = await h.call('owner', 'GET', '/admin/job-lake/settings');
  assert.equal(read.body.settings.reportRateMilli, 100, 'a refused change changes nothing');

  // The sync: status, then "Retry now".
  const status = await h.call('owner', 'GET', '/admin/job-lake/sync');
  assert.equal(status.body.sync.unsynced, 1);
  const retried = await h.call('owner', 'POST', '/admin/job-lake/sync');
  assert.equal(retried.body.report.appended, 1);
  assert.equal(retried.body.sync.unsynced, 0);
  assert.equal(retried.body.sheet.spreadsheetUrl, 'https://docs.google.com/spreadsheets/d/admin-lake/edit');
});

test('whoever knows the company names it on the analysis - once, never over another - and the merge tab then offers it', async (t) => {
  const h = await serve('company');
  t.after(() => h.close());
  // A queued build's first task: the job's company goes onto the analysis it obtains.
  const { __analysisForTests } = require('../dist/services/queue/resumeTask');
  const queued = await __analysisForTests(
    { job: { companyName: 'Queued Co', role: '', jobDescription: posting(40) }, requestedBy: h.user.id },
    new AbortController().signal
  );
  assert.equal(queued.companyName, 'Queued Co');
  assert.equal(queued.createdBy, h.user.id);
  const again = await gate.getOrCreateAnalysis({ jd: posting(40), company: 'Somebody Else' });
  assert.equal(again.companyName, 'Queued Co', 'never written over');

  // Stored before companies were recorded: the next caller that knows names it.
  const older = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: posting(41), createdBy: h.user.id });
  assert.equal(analyses.getJobAnalysisById(older).companyName, '');
  const offeredBefore = await h.call('owner', 'GET', '/admin/job-lake/merge');
  assert.deepEqual(offeredBefore.body.rows.map((row) => row.company), ['Queued Co'], 'no company, not offered');
  const named = await gate.getOrCreateAnalysis({ jd: posting(41), company: 'Late Co' });
  assert.equal(named.companyName, 'Late Co');

  const offered = await h.call('owner', 'GET', '/admin/job-lake/merge');
  assert.deepEqual(offered.body.rows.map((row) => row.company).sort(), ['Late Co', 'Queued Co']);
  assert.equal(h.seats.analyses().length, 1, 'naming a company asks no model');
});

test('a Build Resumes run names the company on the analysis it was handed, and the merge tab then offers it', async (t) => {
  const h = await serveInstall('lake-builder-company');
  t.after(h.close);
  // What the builder sends: the description alone to /resume/analyze...
  const analyzed = await h.post('/resume/analyze', { jobDescription: posting(50) });
  assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body));
  const id = analyzed.body.analysisId;
  assert.equal(analyses.getJobAnalysisById(id).companyName, '');
  assert.deepEqual(analyses.listMergeableAnalyses(10).map((row) => row.id), [], 'no company, not offered');

  // ...then each job of the batch with its company and that analysisId. A
  // task that is handed an analysisId never reaches the gate, so the
  // submission is the one place this build names the company.
  const batch = (jobs) => h.post('/generation/batches', { mode: 'order', format: 'pdf', includeCoverLetterDocx: false, profileIds: ['p-claude'], jobs });
  const submitted = await batch([{ companyName: 'Builder Co', role: 'Engineer', jobDescription: posting(50), analysisId: id }]);
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  assert.equal(analyses.getJobAnalysisById(id).companyName, 'Builder Co');
  assert.deepEqual(analyses.listMergeableAnalyses(10).map((row) => row.id), [id]);

  // A later build naming another company does not write over it.
  const later = await batch([{ companyName: 'Other Co', role: 'Engineer', jobDescription: posting(50), analysisId: id }]);
  assert.equal(later.status, 202);
  assert.equal(analyses.getJobAnalysisById(id).companyName, 'Builder Co');
  await untilFinished(submitted.body.batchId);
  await untilFinished(later.body.batchId);

  // A caller that names the company to /resume/analyze itself records it there.
  const named = await h.post('/resume/analyze', { jobDescription: posting(51), companyName: 'Analyze Co' });
  assert.equal(analyses.getJobAnalysisById(named.body.analysisId).companyName, 'Analyze Co');
  assert.equal(h.seats.analyses().length, 2, 'naming a company asks no model');

  // The builder's own call is the first one above: description and link, no
  // company - which is why a posting it only previewed is not offered yet.
  const fs = require('node:fs');
  const path = require('node:path');
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'api.ts'), 'utf8');
  const analyze = /\n  analyze: \(([^)]*)\) =>[\s\S]*?\}\),\n/.exec(api);
  assert.ok(analyze, "lib/api.ts's resumeApi.analyze");
  assert.doesNotMatch(analyze[0], /company/i, 'the builder sends /resume/analyze no company');
  // So the README's row says that, and not that such a posting predates
  // recorded companies: job_analyses is new to an install upgraded from the
  // release before (commit 90adbaf has no such table), so none does.
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  const row = readme.split('\n').find((line) => line.startsWith('| The **Merge** tab does not offer a job a build analysed'));
  assert.ok(row, 'the Troubleshooting row for a job the Merge tab does not offer');
  assert.match(row, /the builder's analysis names none, so a posting that was only previewed has none/);
  assert.doesNotMatch(readme, /analysed before the analysis recorded\s+companies|gains `company_name`/);
});

test('the Job Filter names the company on the analysis, found by its link or made now, on the app\'s own sheet', async (t) => {
  const h = await serveInstall('lake-filter-company');
  t.after(h.close);
  const swaps = [];
  const swap = (module, name, fake) => {
    swaps.push([module, name, module[name]]);
    module[name] = fake;
  };
  t.after(() => {
    for (const [module, name, original] of swaps.reverse()) module[name] = original;
  });
  // The owner's own sheet: the filter reads its Company column too.
  users.recordAccountSheet(h.owner.id, 'filter-sheet', 'https://docs.google.com/spreadsheets/d/filter-sheet/edit');
  columns.setAnalysisSheetsClientForTests({
    async verifyTab() {
      return { gid: 7, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: true };
    },
    async readRanges(_id, ranges) {
      return ranges.map(() => []);
    },
    async writeRaw() {},
  });
  const STORED = 'https://jobs.example.com/stored';
  const FRESH = 'https://jobs.example.com/fresh';
  const storedId = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: posting(60), jobLink: STORED, createdBy: h.owner.id });
  assert.equal(analyses.getJobAnalysisById(storedId).companyName, '');

  const googleSheets = require('../dist/integrations/googleSheets');
  swap(require('../dist/services/sheets/jobSheetTarget'), 'resolveJobSheetTarget', async () => ({ spreadsheetId: 'filter-sheet', tabName: TAB }));
  // B (Company) to J (Filter Reason): the range an app sheet's filter reads.
  swap(googleSheets, 'fetchGoogleSheetsRange', async () => ({
    spreadsheetId: 'filter-sheet',
    spreadsheetTitle: 'Jobs',
    values: [
      ['Stored Co', 'Engineer', STORED, '', '', '', '', '', ''],
      ['Fresh Co', 'Engineer', FRESH, '', '', '', '', '', ''],
    ],
  }));
  swap(googleSheets, 'updateGoogleSheetsRow', async () => ({}));
  swap(require('../dist/services/jobPageContent'), 'extractJobPageContent', async () => posting(61));

  const filtered = await h.post('/jobs/filter-google-sheet', { startRow: 2, endRow: 3 });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  assert.deepEqual([filtered.body.processedRows, filtered.body.reusedAnalyses, filtered.body.scrapedRows], [2, 1, 1]);
  assert.equal(analyses.getJobAnalysisById(storedId).companyName, 'Stored Co', 'found by its link, named');
  const fresh = require('../dist/services/jobAnalysis/gate').findStoredAnalysis({ link: FRESH });
  assert.equal(fresh.companyName, 'Fresh Co', 'analysed now, named');
  assert.deepEqual(analyses.listMergeableAnalyses(10).map((row) => row.companyName).sort(), ['Fresh Co', 'Stored Co']);
  assert.equal(h.seats.analyses().length, 1);
});

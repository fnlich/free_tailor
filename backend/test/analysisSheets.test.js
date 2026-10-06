const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { analysisAnswer, posting, serveInstall, untilFinished } = require('./analysisHarness');
const { loadFresh, storeJobAnalysis } = require('./helpers');
const identity = require('../dist/services/jobAnalysis/identity');

/**
 * The app sheet's six analysis columns, G to L (owner decisions J5, S3), and
 * sheet-first builds (P7): what is read, what is trusted, what is written,
 * and how.
 *
 * Two halves. Through the routes, against a fake spreadsheet held in memory: a
 * row whose Analysis cell names its posting's stored analysis skips analysis
 * and is tailored on exactly that analysis, a cell naming anything else - an
 * analysis this store never held, another posting's - is never used or
 * stored, a row not analysed is analysed once and written back, once, and the
 * rows are read in one batched call per run - never taken from the request. Then the integration itself against a stubbed `fetch`: the
 * protection's request shape and its repair, the grid grown to twelve
 * columns, which tabs are job tabs (and every other is never touched), RAW
 * writes, and the backoff on Google's 429.
 */

const TAB = 'All';

/** A column letter as a 1-based number (A = 1). Single letters are all this sheet has. */
const columnNumber = (letter) => letter.charCodeAt(0) - 64;

/**
 * A spreadsheet tab in memory, behind the analysis-columns client seam:
 * `rows[n]` is row n's cells by column letter. Records every call.
 */
function fakeSheet(rows, options = {}) {
  const calls = { verify: 0, reads: [], writes: [] };
  const state = { protection: options.protection ?? 'intact', jobTab: options.jobTab ?? true };
  const cell = (row, letter) => rows[row]?.[letter] ?? '';
  const parse = (range) => {
    const match = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    return { fromCol: match[1], fromRow: Number(match[2]), toCol: match[3], toRow: Number(match[4]) };
  };
  return {
    calls,
    state,
    rows,
    client: {
      async verifyTab(spreadsheetId, tabName) {
        calls.verify += 1;
        assert.equal(tabName, TAB);
        return { gid: 7, protection: state.protection, grewColumns: false, wroteHeader: false, jobTab: state.jobTab };
      },
      async readRanges(spreadsheetId, ranges) {
        calls.reads.push(ranges);
        return ranges.map((range) => {
          const { fromCol, fromRow, toCol, toRow } = parse(range);
          const grid = [];
          for (let row = fromRow; row <= toRow; row += 1) {
            const values = [];
            for (let col = columnNumber(fromCol); col <= columnNumber(toCol); col += 1) {
              values.push(cell(row, String.fromCharCode(64 + col)));
            }
            grid.push(values);
          }
          return grid;
        });
      },
      async writeRaw(spreadsheetId, data) {
        calls.writes.push(data);
        for (const { range, values } of data) {
          const { fromCol, fromRow } = parse(range);
          values[0].forEach((value, offset) => {
            if (value === null) return; // Google skips a null: the cell keeps what it had.
            rows[fromRow] = rows[fromRow] ?? {};
            rows[fromRow][String.fromCharCode(columnNumber(fromCol) + offset + 64)] = value;
          });
        }
      },
    },
  };
}

/** The account-sheet client the addressability guard allocates the owner's sheet through. */
function accountSheetClient() {
  return {
    async isConfigured() {
      return true;
    },
    async checkCredential() {},
    async createSpreadsheet() {
      return { spreadsheetId: 'own-sheet', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/own-sheet/edit', firstTabGid: 7 };
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
    async setSpreadsheetVisibility(id, next) {
      return next;
    },
    async listSheetTabs() {
      return [{ title: TAB, gid: 7 }];
    },
    async readRanges(spreadsheetId, ranges) {
      return ranges.map(() => [[...require('../dist/integrations/googleSheets').JOB_SHEET_HEADERS]]);
    },
  };
}

/** An install whose owner has their own app sheet, and a fake of its tab. */
async function serveWithSheet(name, rows, options = {}) {
  const h = await serveInstall(name, {
    profiles: [['p-claude', 'Ada', 'claude-cli-sonnet'], ['p-codex', 'Bea', 'codex-cli-default']],
    ...(options.answer ? { answer: options.answer } : {}),
  });
  const accountSheet = require('../dist/services/sheets/accountSheet');
  accountSheet.setSheetsClientForTests(accountSheetClient());
  await accountSheet.ensureAccountSheet(h.users.getUserById(h.owner.id));
  const sheet = fakeSheet(rows, options);
  const columns = require('../dist/services/sheets/analysisColumns');
  columns.setAnalysisSheetsClientForTests(sheet.client);
  return { ...h, sheet, columns };
}

/** A row as the account sheet lays it out: C company, D title, E link, F description. */
function sheetRow(n, extra = {}) {
  return { C: `Company ${n}`, D: 'Engineer', E: `https://jobs.example.com/${n}`, F: posting(n), ...extra };
}

/** What the builder submits for a row it read from the sheet: never its analysis cells. */
function submittedJob(n, extra = {}) {
  return { companyName: `Company ${n}`, role: 'Engineer', jobDescription: posting(n), sourceRowNumber: n, ...extra };
}

/** The keys of sheet row n's posting, as the program records them in the row's Analysis cell. */
function postingOf(n) {
  return { hash: identity.contentHash(posting(n)), link: identity.linkKey(`https://jobs.example.com/${n}`) };
}

/**
 * An Analysis cell as the program writes it, here from another install: the
 * store has never seen its id. Written for row n's posting when `n` is given;
 * without it, the cell records no posting, and nothing ties it to any.
 */
function analysisCell(title, id = '0d6f9c3e-7a51-4c1e-9b0f-1e2d3c4b5a69', n) {
  const analysis = JSON.parse(analysisAnswer({ jobMeta: { title, seniority: 'senior', industry: '', department: '' }, jobField: 'devops' }));
  return JSON.stringify({ v: 1, id, ...(n === undefined ? {} : { posting: postingOf(n) }), jobField: 'devops', analysis });
}

/** An analysis answer whose title names the posting it was asked about, so a tailoring shows whose analysis it got. */
function titledAnswer(request) {
  const n = /Posting (\d+):/.exec(request.userBody)?.[1] ?? '?';
  return analysisAnswer({ jobMeta: { title: `Title of posting ${n}`, seniority: 'senior', industry: '', department: '' } });
}

/** The posting title each tailoring call was given. */
function tailoredTitles(h) {
  return h.seats.tailorings().map((call) => /"title":"(Title of posting \d+)"/.exec(call.userBody)?.[1]);
}

async function order(h, jobs, extra = {}) {
  const response = await h.post('/generation/batches', {
    mode: 'order',
    format: 'pdf',
    includeCoverLetterDocx: false,
    profileIds: ['p-claude', 'p-codex'],
    sheet: { tabName: TAB },
    jobs,
    ...extra,
  });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return untilFinished(response.body.batchId);
}

/** Lines a call logs, captured while it runs. */
async function capturing(stream, action) {
  const lines = [];
  const real = console[stream];
  console[stream] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await action();
  } finally {
    console[stream] = real;
  }
  return lines;
}

/** Stores posting n's analysis, with a title naming it, and answers the stored row. */
function storedFor(n, title) {
  const analyses = require('../dist/database/jobAnalysisRepository');
  const id = storeJobAnalysis(
    { jobField: 'devops', jobMeta: { title, seniority: 'senior', industry: '', department: '' } },
    { jobDescription: posting(n), jobLink: `https://jobs.example.com/${n}` }
  );
  return analyses.getJobAnalysisById(id);
}

test("rows whose Analysis cell names their posting's stored analysis make no analysis call, and tailoring gets exactly that analysis", async (t) => {
  const rows = { 2: sheetRow(2), 3: sheetRow(3) };
  const h = await serveWithSheet('sheet-filled', rows);
  t.after(h.close);
  // What the program wrote into these rows: the cells of their stored analyses.
  rows[2].L = h.columns.analysisCellText(storedFor(2, 'Stored Title Two'));
  rows[3].L = h.columns.analysisCellText(storedFor(3, 'Stored Title Three'));

  // Even a forged analysis in the body changes nothing: the cells are read by the server.
  let snapshot;
  const logged = await capturing('log', async () => {
    snapshot = await order(h, [submittedJob(2, { jobAnalysis: { jobMeta: { title: 'Forged' } } }), submittedJob(3)]);
  });
  assert.equal(snapshot.completed, 4);
  assert.equal(h.seats.analyses().length, 0, 'zero analysis calls');
  assert.equal(h.sheet.calls.reads.length, 1, 'one batched read of the submitted rows');
  assert.equal(h.sheet.calls.reads[0].length, 2, 'one run of rows: identity and Analysis, two ranges');
  assert.ok(
    logged.some((line) => /Sheet run on "All": 2 job\(s\) analysed in the sheet, 0 from the store, 0 to analyse/.test(line)),
    'both taken from their row\'s cell'
  );

  const tailored = h.seats.tailorings().map((call) => /"title":"(Stored Title \w+)"/.exec(call.userBody)?.[1]);
  assert.deepEqual(tailored.sort(), ['Stored Title Three', 'Stored Title Three', 'Stored Title Two', 'Stored Title Two']);
  assert.equal(h.seats.tailorings().some((call) => call.userBody.includes('Forged')), false);

  // Nothing was stored from the sheet: the two analyses are the two there were.
  const { getDb } = require('../dist/database/sqlite');
  assert.deepEqual(getDb().prepare('SELECT source, COUNT(*) AS n FROM job_analyses GROUP BY source').all(), [{ source: 'ai', n: 2 }]);
  await h.columns.flushAnalysisWriteBacks();
  assert.equal(h.sheet.calls.writes.length, 0, 'nothing written over cells that hold their posting\'s analysis');
});

test("a cell naming no stored analysis is never registered or used, whatever posting it claims: analysed once, and the cell replaced", async (t) => {
  const rows = { 2: sheetRow(2), 3: sheetRow(3) };
  const h = await serveWithSheet('sheet-forged-cells', rows, { answer: titledAnswer });
  t.after(h.close);
  // Row 2: the program's shape, the row's own posting keys, an id this store
  // never held - another install's cell, or a formula spilled into L from an
  // unprotected column. Row 3: a stored id, but posting 9's, under keys that
  // claim posting 3.
  rows[2].L = analysisCell('FORGED TWO', '11111111-2222-4333-8444-555555555555', 2);
  const nine = storedFor(9, 'Title of posting 9');
  rows[3].L = analysisCell('FORGED THREE', nine.id, 3);

  const warned = await capturing('warn', () => order(h, [submittedJob(2), submittedJob(3)]));
  assert.equal(h.seats.analyses().length, 2, 'each posting analysed once, through the gate');
  assert.deepEqual(tailoredTitles(h).sort(), ['Title of posting 2', 'Title of posting 2', 'Title of posting 3', 'Title of posting 3']);
  assert.equal(h.seats.tailorings().some((call) => call.userBody.includes('FORGED')), false, 'nobody is built on either cell');
  assert.ok(
    warned.some((line) => /Sheet row 2's Analysis cell names an analysis this store does not have \(11111111-/.test(line)),
    warned.join('\n')
  );
  assert.ok(warned.some((line) => /Sheet row 3's Analysis cell was not written for the posting in the row now/.test(line)));
  const { getDb } = require('../dist/database/sqlite');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM job_analyses WHERE source = 'sheet'").get().n, 0, 'nor is either stored');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM job_analyses WHERE id = '11111111-2222-4333-8444-555555555555'").get().n, 0);

  // The program is the only writer of those cells: both are put right.
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 2, skipped: 0, failed: 0, failedSpreadsheets: [] });
  const { findStoredAnalysis } = require('../dist/services/jobAnalysis/gate');
  for (const n of [2, 3]) {
    const cell = JSON.parse(rows[n].L);
    assert.equal(cell.id, findStoredAnalysis({ jd: posting(n) }).id, `row ${n} names its posting's stored analysis`);
    assert.equal(cell.analysis.jobMeta.title, `Title of posting ${n}`);
  }

  // From then on the rows are read from the sheet: no call, nothing written.
  const logged = await capturing('log', () => order(h, [submittedJob(2), submittedJob(3)]));
  assert.equal(h.seats.analyses().length, 2);
  assert.ok(logged.some((line) => /2 job\(s\) analysed in the sheet/.test(line)));
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 0, skipped: 0, failed: 0, failedSpreadsheets: [] });
  // And asking for the posting's analysis anywhere else answers the real one.
  const asked = await h.post('/resume/analyze', { jobDescription: posting(2) });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.jobMeta?.title, 'Title of posting 2');
  assert.equal(h.seats.analyses().length, 2);
});

test('rows without it are analysed once and written back, RAW, once - and the next order makes no call', async (t) => {
  const rows = { 4: sheetRow(4), 5: sheetRow(5) };
  const h = await serveWithSheet('sheet-empty', rows);
  t.after(h.close);

  await order(h, [submittedJob(4), submittedJob(5)]);
  assert.equal(h.seats.analyses().length, 2, 'one per posting, for both profiles');
  assert.equal(h.sheet.calls.reads.length, 1, 'one batched read at submission');

  const report = await h.columns.flushAnalysisWriteBacks();
  assert.equal(h.sheet.calls.reads.length, 2, 'and the write-back reads its rows again before it writes');
  assert.deepEqual(report, { written: 2, skipped: 0, failed: 0, failedSpreadsheets: [] });
  assert.equal(h.sheet.calls.writes.length, 1, 'both rows in one write');
  const [write] = h.sheet.calls.writes;
  assert.deepEqual(write.map((entry) => entry.range), [`'${TAB}'!G4:L4`, `'${TAB}'!G5:L5`]);
  const [field, salary, jobType, clearance, industry, cell] = write[0].values[0];
  assert.equal(field, 'Backend');
  assert.equal(salary, '$180k - $220k');
  assert.equal(jobType, 'Remote');
  assert.equal(clearance, false, 'a real FALSE, not the word');
  assert.equal(industry, 'Technology', 'from the analysis\'s company category: it predates Industry');
  const parsed = JSON.parse(cell);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.jobField, 'backend');
  assert.equal(parsed.analysis.sourceJobDescription, undefined, 'the posting is its own column');

  // The next order - and a Generate Immediately - on the same rows: read from the sheet.
  await order(h, [submittedJob(4), submittedJob(5)]);
  const immediate = await h.post('/generation/batches', {
    mode: 'immediate',
    format: 'pdf',
    includeCoverLetterDocx: false,
    profileIds: ['p-claude'],
    sheet: { tabName: TAB },
    jobs: [submittedJob(4)],
  });
  assert.equal(immediate.status, 202);
  await untilFinished(immediate.body.batchId);
  assert.equal(h.seats.analyses().length, 2, 'no further analysis call');
  assert.equal(h.sheet.calls.reads.length, 4, 'one batched read per run, two runs more');
  await h.columns.flushAnalysisWriteBacks();
  assert.equal(h.sheet.calls.writes.length, 1, 'written once');
});

test('a cut or unreadable cell falls back to the store, then to one analysis - logged, with its row', async (t) => {
  const cut = analysisCell('Cut Title').slice(0, 120) + ' ...[cut at 50,000 characters]';
  const rows = { 6: sheetRow(6, { L: cut }), 7: sheetRow(7, { L: 'not json at all' }), 8: sheetRow(8, { L: '{"v":1' }) };
  const h = await serveWithSheet('sheet-unusable', rows);
  t.after(h.close);
  // The store has postings 6 and 7 already; 8 it has not.
  const six = storeJobAnalysis({ jobMeta: { title: 'Stored Six', seniority: '', industry: '', department: '' } }, { jobDescription: posting(6) });
  storeJobAnalysis({}, { jobDescription: posting(7) });

  const lines = [];
  const realWarn = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await order(h, [submittedJob(6), submittedJob(7), submittedJob(8)]);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(h.seats.analyses().length, 1, 'only the posting the store lacks reached a model');
  assert.ok(lines.some((line) => /Sheet row 6's Analysis cell is cut short/.test(line)));
  assert.ok(lines.some((line) => /Sheet row 7's Analysis cell is unreadable/.test(line)));
  assert.ok(h.seats.tailorings().some((call) => call.userBody.includes('Stored Six')));
  void six;
});

test('a tab whose protection was not found intact has its cells ignored; a row that moved is neither read nor written', async (t) => {
  const rows = { 9: sheetRow(9), 10: sheetRow(10, { C: 'Somebody Else Entirely' }) };
  const h = await serveWithSheet('sheet-untrusted', rows, { protection: 'altered', answer: titledAnswer });
  t.after(h.close);
  // A cell naming posting 9's own stored analysis - which, in a tab whose
  // protection was not found intact, is not read at all.
  const nine = storedFor(9, 'Untrusted Title');
  rows[9].L = h.columns.analysisCellText(nine);
  const logged = await capturing('log', () => capturing('warn', () => order(h, [submittedJob(9), submittedJob(10)])));

  // Neither cell was used: posting 9 came from the store, and posting 10 - its
  // row now another company's - was analysed once.
  assert.ok(logged.some((line) => /0 job\(s\) analysed in the sheet, 1 from the store, 1 to analyse/.test(line)), logged.join('\n'));
  assert.equal(h.seats.analyses().length, 1);

  await h.columns.flushAnalysisWriteBacks();
  // Row 9 already holds its posting's analysis; row 10 is another company's now.
  assert.equal(h.sheet.calls.writes.length, 0);
  assert.equal(rows[9].L, h.columns.analysisCellText(nine));
});

test('a write-back re-reads the row first: moved, already written or occupied, it is skipped; a failed write is retried later', async () => {
  const columns = require('../dist/services/sheets/analysisColumns');
  const users = require('../dist/database/userRepository');
  const { useTempStorage } = require('./helpers');
  useTempStorage('sheet-writeback');
  const owner = users.createUser({ email: 'w@example.com' });
  // An app sheet: one this install allocated to an account.
  users.recordAccountSheet(owner.id, 'wb-sheet', 'https://x');
  columns.resetAnalysisWriteBacksForTests();
  const rows = {
    2: sheetRow(2),
    3: sheetRow(3, { C: 'Moved Co' }),
    4: sheetRow(4, { L: '{"v":1,"id":"x"}' }),
    // Something in G to K with L empty is not the program's (it writes all
    // six at once): typed while the protection was off, and not written over.
    5: sheetRow(5, { G: 'my own note' }),
  };
  const sheet = fakeSheet(rows);
  columns.setAnalysisSheetsClientForTests(sheet.client);
  const stored = { id: 'a1', jobFieldId: 'backend', createdAt: '2026-10-05T00:00:00.000Z', analysis: JSON.parse(analysisAnswer()) };
  try {
    assert.equal(columns.queueAnalysisWriteBack({ spreadsheetId: 'not-ours', tabName: TAB, row: 2, companyName: 'Company 2', stored }), false, 'only app sheets');
    for (const row of [2, 3, 4, 5]) {
      assert.equal(columns.queueAnalysisWriteBack({ spreadsheetId: 'wb-sheet', tabName: TAB, row, companyName: `Company ${row}`, stored }), true);
    }
    assert.equal(columns.queueAnalysisWriteBack({ spreadsheetId: 'wb-sheet', tabName: TAB, row: 2, companyName: 'Company 2', stored }), false, 'queued once');

    const failing = sheet.client.writeRaw;
    sheet.client.writeRaw = async () => {
      throw new Error('Google is down');
    };
    const realWarn = console.warn;
    console.warn = () => {};
    let report;
    try {
      report = await columns.flushAnalysisWriteBacks();
    } finally {
      console.warn = realWarn;
    }
    assert.deepEqual(report, { written: 0, skipped: 0, failed: 4, failedSpreadsheets: ['wb-sheet'] });
    sheet.client.writeRaw = failing;

    // Not settled by the failure: queued again, and this time written.
    assert.equal(columns.queueAnalysisWriteBack({ spreadsheetId: 'wb-sheet', tabName: TAB, row: 2, companyName: 'Company 2', stored }), true);
    columns.queueAnalysisWriteBack({ spreadsheetId: 'wb-sheet', tabName: TAB, row: 3, companyName: 'Company 3', stored });
    columns.queueAnalysisWriteBack({ spreadsheetId: 'wb-sheet', tabName: TAB, row: 4, companyName: 'Company 4', stored });
    columns.queueAnalysisWriteBack({ spreadsheetId: 'wb-sheet', tabName: TAB, row: 5, companyName: 'Company 5', stored });
    console.warn = () => {};
    try {
      report = await columns.flushAnalysisWriteBacks();
    } finally {
      console.warn = realWarn;
    }
    assert.deepEqual(report, { written: 1, skipped: 3, failed: 0, failedSpreadsheets: [] });
    assert.equal(rows[5].G, 'my own note');
    assert.equal(rows[5].L, undefined);
    assert.deepEqual(sheet.calls.writes.at(-1).map((entry) => entry.range), [`'${TAB}'!G2:L2`]);
    assert.equal(sheet.calls.verify, 2, 'the protection is checked before every write');
  } finally {
    columns.setAnalysisSheetsClientForTests();
    columns.resetAnalysisWriteBacksForTests();
  }
});

test("a row whose G to K are this posting's own facts, its Analysis cell cleared by a protection repair, is written again", async () => {
  const columns = require('../dist/services/sheets/analysisColumns');
  const users = require('../dist/database/userRepository');
  const { useTempStorage } = require('./helpers');
  useTempStorage('sheet-writeback-own-facts');
  const owner = users.createUser({ email: 'f@example.com' });
  users.recordAccountSheet(owner.id, 'facts-sheet', 'https://x');
  columns.resetAnalysisWriteBacksForTests();
  const stored = { id: 'f1', jobFieldId: 'backend', createdAt: '2026-10-05T00:00:00.000Z', analysis: JSON.parse(analysisAnswer()) };
  // What a FORMATTED read gives back for the program's own five: the
  // boolean as FALSE. L was emptied when the protection went back on.
  const own = { G: 'Backend', H: '$180k - $220k', I: 'Remote', J: 'FALSE', K: 'Technology' };
  const rows = { 2: sheetRow(2, own), 3: sheetRow(3, { ...own, K: 'Healthcare' }) };
  const sheet = fakeSheet(rows);
  columns.setAnalysisSheetsClientForTests(sheet.client);
  try {
    for (const row of [2, 3]) {
      columns.queueAnalysisWriteBack({ spreadsheetId: 'facts-sheet', tabName: TAB, row, companyName: `Company ${row}`, stored });
    }
    assert.deepEqual(await columns.flushAnalysisWriteBacks(), { written: 1, skipped: 1, failed: 0, failedSpreadsheets: [] });
    assert.equal(JSON.parse(rows[2].L).id, 'f1', 'its own facts: the Analysis cell goes back');
    assert.equal(rows[3].L, undefined, 'a fact that is not this analysis\'s: somebody\'s, left alone');
    assert.equal(rows[3].K, 'Healthcare');
  } finally {
    columns.setAnalysisSheetsClientForTests();
    columns.resetAnalysisWriteBacksForTests();
  }
});

test('the Analysis cell is cut at Google\'s 50,000 characters, and still names its stored row', () => {
  const columns = require('../dist/services/sheets/analysisColumns');
  const huge = JSON.parse(analysisAnswer({ responsibilities: Array.from({ length: 4000 }, (_, n) => `responsibility number ${n}`) }));
  const stored = { id: '0d6f9c3e-7a51-4c1e-9b0f-1e2d3c4b5a69', jobFieldId: 'backend', createdAt: 'x', analysis: huge };
  const text = columns.analysisCellText(stored);
  assert.equal(text.length, columns.ANALYSIS_CELL_LIMIT);
  assert.ok(text.endsWith(columns.ANALYSIS_TRUNCATED_MARKER));
  assert.deepEqual(columns.parseAnalysisCell(text), { state: 'truncated', analysisId: stored.id });

  const small = columns.analysisCellText({ ...stored, analysis: JSON.parse(analysisAnswer()) });
  const parsed = columns.parseAnalysisCell(small);
  assert.equal(parsed.state, 'ok');
  assert.equal(parsed.analysisId, stored.id);
  assert.deepEqual(columns.parseAnalysisCell('  '), { state: 'empty' });
  assert.deepEqual(columns.parseAnalysisCell('=HYPERLINK("x")'), { state: 'unparseable' });
  assert.deepEqual(columns.rowRuns([5, 2, 3, 3, 9, 4]), [[2, 5], [9, 9]]);
});

test("a row whose posting was replaced is not built on the old posting's analysis: analysed once, and its cells put right", async (t) => {
  const rows = { 2: sheetRow(2) };
  const h = await serveWithSheet('sheet-replaced', rows, { answer: titledAnswer });
  t.after(h.close);

  await order(h, [submittedJob(2)]);
  assert.equal(h.seats.analyses().length, 1);
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 1, skipped: 0, failed: 0, failedSpreadsheets: [] });
  const before = JSON.parse(rows[2].L);

  // Another posting from the same company pasted over row 2's own columns.
  // G:L are protected, so the person cannot clear them: they stay.
  Object.assign(rows[2], { E: 'https://jobs.example.com/99', F: posting(99) });
  const replaced = submittedJob(99, { companyName: 'Company 2', sourceRowNumber: 2 });
  await order(h, [replaced]);
  assert.equal(h.seats.analyses().length, 2, "the new posting is analysed once - not answered with the old one's analysis");
  assert.deepEqual(tailoredTitles(h).slice(-2), ['Title of posting 99', 'Title of posting 99']);

  // The program is the only writer of those cells, so it puts them right.
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 1, skipped: 0, failed: 0, failedSpreadsheets: [] });
  const after = JSON.parse(rows[2].L);
  assert.notEqual(after.id, before.id);
  assert.deepEqual(after.posting, postingOf(99));
  assert.equal(after.analysis.jobMeta.title, 'Title of posting 99');

  // And from then on the row is read from the sheet again: no call.
  await order(h, [replaced]);
  assert.equal(h.seats.analyses().length, 2);
  assert.deepEqual(tailoredTitles(h).slice(-2), ['Title of posting 99', 'Title of posting 99']);
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 0, skipped: 0, failed: 0, failedSpreadsheets: [] });
});

test('rows sorted under the protected columns: each task gets its own posting\'s analysis, and the cells are put right', async (t) => {
  const rows = { 2: sheetRow(2), 3: sheetRow(3) };
  const h = await serveWithSheet('sheet-sorted', rows, { answer: titledAnswer });
  t.after(h.close);
  await order(h, [submittedJob(2), submittedJob(3)]);
  assert.equal((await h.columns.flushAnalysisWriteBacks()).written, 2);

  // A sort of A:F only - the protected G:L cannot move with it.
  const own = (row) => ({ C: row.C, D: row.D, E: row.E, F: row.F });
  const [two, three] = [own(rows[2]), own(rows[3])];
  Object.assign(rows[2], three);
  Object.assign(rows[3], two);

  const response = await h.post('/generation/batches', {
    mode: 'order',
    format: 'pdf',
    includeCoverLetterDocx: false,
    profileIds: ['p-claude', 'p-codex'],
    sheet: { tabName: TAB },
    jobs: [submittedJob(3, { sourceRowNumber: 2 }), submittedJob(2, { sourceRowNumber: 3 })],
  });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  await untilFinished(response.body.batchId);
  assert.equal(h.seats.analyses().length, 2, 'both postings were analysed before: no call');

  const { findStoredAnalysis } = require('../dist/services/jobAnalysis/gate');
  const { getGenerationQueue } = require('../dist/services/queue/index');
  const batch = getGenerationQueue().getBatch(response.body.batchId);
  for (const task of batch.tasks) {
    const n = Number(/Company (\d+)/.exec(batch.shared.jobs[task.payload.jobIndex].companyName)[1]);
    assert.equal(task.payload.analysisId, findStoredAnalysis({ jd: posting(n) }).id, `Company ${n} is built on its own analysis`);
  }

  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 2, skipped: 0, failed: 0, failedSpreadsheets: [] });
  assert.deepEqual(JSON.parse(rows[2].L).posting, postingOf(3));
  assert.deepEqual(JSON.parse(rows[3].L).posting, postingOf(2));
});

test('a cell that names no posting is not registered for the row\'s, even in an intact tab - and one with no id is left alone', async (t) => {
  const rows = {
    4: sheetRow(4, { L: analysisCell('Unattached Title') }),
    // Valid JSON with an analysis and the row's posting keys, but no id: not
    // the program's shape at all, so somebody's own - never used, never written over.
    5: sheetRow(5, { L: JSON.stringify({ v: 1, posting: postingOf(5), analysis: { jobMeta: { title: 'No Id Title' } } }) }),
  };
  const h = await serveWithSheet('sheet-unattached', rows);
  t.after(h.close);
  await capturing('warn', () => order(h, [submittedJob(4), submittedJob(5)]));
  assert.equal(h.seats.analyses().length, 2, 'analysed instead');
  assert.equal(h.seats.tailorings().some((call) => /Unattached Title|No Id Title/.test(call.userBody)), false);
  const { getDb } = require('../dist/database/sqlite');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM job_analyses WHERE source = 'sheet'").get().n, 0);
  await h.columns.flushAnalysisWriteBacks();
  assert.notEqual(JSON.parse(rows[4].L).analysis.jobMeta.title, 'Unattached Title', 'the program-shaped cell is put right');
  assert.equal(JSON.parse(rows[5].L).analysis.jobMeta.title, 'No Id Title', 'the one with no id is left as it is');
});

test("a tab the person laid out for themselves is not read for analyses or written into", async (t) => {
  const rows = { 2: sheetRow(2), 3: sheetRow(3, { L: analysisCell('Their Own Text', undefined, 3) }) };
  const h = await serveWithSheet('sheet-user-tab', rows, { jobTab: false });
  t.after(h.close);
  await order(h, [submittedJob(2), submittedJob(3)]);
  assert.equal(h.sheet.calls.verify, 1, 'the verify said it is not a job tab');
  assert.equal(h.sheet.calls.reads.length, 0, 'so none of its cells was read');
  assert.equal(h.seats.analyses().length, 2, 'its postings were analysed from the store or a model');

  // Even a write-back queued for it some other way is refused at the verify.
  const stored = { id: 'u1', jobFieldId: 'backend', createdAt: 'x', analysis: JSON.parse(analysisAnswer()) };
  assert.equal(h.columns.queueAnalysisWriteBack({ spreadsheetId: 'own-sheet', tabName: TAB, row: 2, companyName: 'Company 2', stored }), true);
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 0, skipped: 1, failed: 0, failedSpreadsheets: [] });
  assert.equal(h.sheet.calls.writes.length, 0);
  assert.equal(rows[2].G, undefined);
  assert.equal(rows[2].L, undefined);
});

test('a write-back skipped because its row became another posting leaves the row free for that posting', async () => {
  const columns = require('../dist/services/sheets/analysisColumns');
  const users = require('../dist/database/userRepository');
  const { useTempStorage } = require('./helpers');
  useTempStorage('sheet-writeback-moved');
  const owner = users.createUser({ email: 'm@example.com' });
  users.recordAccountSheet(owner.id, 'moved-sheet', 'https://x');
  columns.resetAnalysisWriteBacksForTests();
  const rows = { 7: sheetRow(7) };
  const sheet = fakeSheet(rows);
  columns.setAnalysisSheetsClientForTests(sheet.client);
  const storedFor = (n) => ({
    id: `id-${n}`,
    contentHash: identity.contentHash(posting(n)),
    linkKey: identity.linkKey(`https://jobs.example.com/${n}`),
    jobFieldId: 'backend',
    createdAt: '2026-10-05T00:00:00.000Z',
    analysis: JSON.parse(analysisAnswer()),
  });
  const entry = (n) => ({
    spreadsheetId: 'moved-sheet',
    tabName: TAB,
    row: 7,
    companyName: `Company ${n}`,
    jobLink: `https://jobs.example.com/${n}`,
    jobDescription: posting(n),
    stored: storedFor(n),
  });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(columns.queueAnalysisWriteBack(entry(7)), true);
    // Sorted before the write went: row 7 holds Company 8's posting now.
    rows[7] = sheetRow(8);
    assert.deepEqual(await columns.flushAnalysisWriteBacks(), { written: 0, skipped: 1, failed: 0, failedSpreadsheets: [] });

    assert.equal(columns.queueAnalysisWriteBack(entry(8)), true, 'the posting now in the row may be written there');
    assert.deepEqual(await columns.flushAnalysisWriteBacks(), { written: 1, skipped: 0, failed: 0, failedSpreadsheets: [] });
    assert.deepEqual(sheet.calls.writes.at(-1).map((write) => write.range), [`'${TAB}'!G7:L7`]);
    assert.equal(JSON.parse(rows[7].L).id, 'id-8');
    assert.equal(columns.queueAnalysisWriteBack(entry(8)), false, 'and once it is, it is settled');
  } finally {
    console.warn = realWarn;
    columns.setAnalysisSheetsClientForTests();
    columns.resetAnalysisWriteBacksForTests();
  }
});

/* ------------------------------------------------ the Google integration -- */

/**
 * The integration against a stubbed `fetch`, with an authorized-user
 * credential in a temp directory - the shape `npm run sheets:login` writes,
 * whose identity Drive is asked for once.
 */
async function withGoogle(handler, action) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tailor-analysis-sheets-'));
  fs.writeFileSync(
    nodePath.join(dir, 'google-oauth-credentials.json'),
    JSON.stringify({ type: 'authorized_user', client_id: 'i', client_secret: 's', refresh_token: 'r' })
  );
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    // The test's own server, when a test drives the routes through the real verify.
    if (href.startsWith('http://127.0.0.1')) return realFetch(url, init);
    if (href.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    }
    if (href.includes('/drive/v3/about')) {
      return new Response(JSON.stringify({ user: { emailAddress: 'Server@Example.com' } }), { status: 200 });
    }
    const request = { url: href, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    return handler(request, requests.length);
  };
  const cwd = process.cwd();
  const savedPaths = [process.env.GOOGLE_CREDENTIALS_PATH, process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH];
  delete process.env.GOOGLE_CREDENTIALS_PATH;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  process.chdir(dir);
  try {
    const sheets = loadFresh('../dist/integrations/googleSheets');
    sheets.setSheetsRetryPolicyForTests({ sleep: async () => {}, random: () => 0.5 });
    return await action(sheets, requests);
  } finally {
    process.chdir(cwd);
    globalThis.fetch = realFetch;
    if (savedPaths[0] !== undefined) process.env.GOOGLE_CREDENTIALS_PATH = savedPaths[0];
    if (savedPaths[1] !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH = savedPaths[1];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('the protection: the six whole columns G to L, header included, editable by the server alone - and put back when altered', () => {
  const sheets = require('../dist/integrations/googleSheets');
  const email = 'server@example.com';
  const wanted = {
    description: sheets.ANALYSIS_PROTECTION_DESCRIPTION,
    warningOnly: false,
    range: { sheetId: 7, startColumnIndex: 6, endColumnIndex: 12 },
    editors: { users: [email], domainUsersCanEdit: false },
  };

  const missing = sheets.analysisProtectionRequests(7, [], email);
  assert.equal(missing.state, 'missing');
  assert.deepEqual(missing.requests, [{ addProtectedRange: { protectedRange: wanted } }]);

  const intact = { protectedRangeId: 11, ...wanted, editors: { users: ['Server@Example.com'] } };
  assert.deepEqual(sheets.analysisProtectionRequests(7, [intact], email), { state: 'intact', requests: [] });

  for (const [what, altered] of [
    ['a warning only', { ...intact, warningOnly: true }],
    ['another editor', { ...intact, editors: { users: [email, 'user@example.com'] } }],
    ['a group', { ...intact, editors: { users: [email], groups: ['team@example.com'] } }],
    ['the whole domain', { ...intact, editors: { users: [email], domainUsersCanEdit: true } }],
    ['rows only', { ...intact, range: { ...wanted.range, startRowIndex: 1 } }],
    ['other columns', { ...intact, range: { ...wanted.range, endColumnIndex: 11 } }],
    // An older build's K:P protection, found by its description on a tab that is now a job tab.
    ['the old K:P', { ...intact, range: { sheetId: 7, startColumnIndex: 10, endColumnIndex: 16 } }],
  ]) {
    const check = sheets.analysisProtectionRequests(7, [altered], email);
    assert.equal(check.state, 'altered', what);
    assert.deepEqual(
      check.requests[0],
      { updateProtectedRange: { protectedRange: { protectedRangeId: 11, ...wanted }, fields: 'range,description,warningOnly,editors' } },
      what
    );
  }
  // A second one of ours goes, so exactly one remains.
  const twice = sheets.analysisProtectionRequests(7, [intact, { ...intact, protectedRangeId: 12 }], email);
  assert.deepEqual(twice.requests, [{ deleteProtectedRange: { protectedRangeId: 12 } }]);
  // Somebody else's protection on another tab or other columns is theirs.
  const unrelated = { protectedRangeId: 13, description: 'mine', range: { sheetId: 7, startColumnIndex: 0, endColumnIndex: 2 } };
  assert.equal(sheets.analysisProtectionRequests(7, [intact, unrelated], email).state, 'intact');

  // Google leaves a field at its default out of what it sends back, and a
  // gid of 0 is the default: All, the first tab of every new sheet. Its
  // protection, read back without a sheetId, is intact - not "altered" on
  // every verify, which would clear its Analysis column each time.
  const { sheetId: _omitted, ...withoutSheetId } = intact.range;
  const onFirstTab = { ...intact, range: withoutSheetId };
  assert.deepEqual(sheets.analysisProtectionRequests(0, [onFirstTab], email), { state: 'intact', requests: [] });
  assert.deepEqual(
    sheets.analysisProtectionRequests(0, [{ ...onFirstTab, description: undefined }], email),
    { state: 'intact', requests: [] },
    'found by its columns alone, too'
  );
  assert.deepEqual(sheets.analysisProtectionRequests(0, [{ ...intact, range: { ...intact.range, sheetId: 0 } }], email), {
    state: 'intact',
    requests: [],
  });
});

test('a write is checked against the protection, whatever row 1 says: this build\'s G:L, an older build\'s K:P, never somebody else\'s', () => {
  const sheets = require('../dist/integrations/googleSheets');
  const ours = (range, extra = {}) => ({ protectedRangeId: 11, description: sheets.ANALYSIS_PROTECTION_DESCRIPTION, range, ...extra });
  const tab = (gid, ...protectedRanges) => ({ gid, protectedRanges });
  const all = tab(0, ours({ startColumnIndex: 6, endColumnIndex: 12 }));
  assert.equal(sheets.analysisProtectionHit(all, 1, 6), null, 'A to F');
  assert.equal(sheets.analysisProtectionHit(all, 13, 20), null, 'past L');
  assert.deepEqual(sheets.analysisProtectionHit(all, 12, 12), { fromCol: 7, toCol: 12 }, 'L, on a tab whose 0 gid Google left out');
  assert.deepEqual(sheets.analysisProtectionHit(all, 1, 7), { fromCol: 7, toCol: 12 }, 'a span that only reaches into G');
  // Found by its columns alone, as a verify adopts it.
  const bare = tab(4, { protectedRangeId: 3, range: { sheetId: 4, startColumnIndex: 6, endColumnIndex: 12 } });
  assert.deepEqual(sheets.analysisProtectionHit(bare, 9, 9), { fromCol: 7, toCol: 12 });
  // An older build's daily tab: K:P, by its description.
  const daily = tab(5, ours({ sheetId: 5, startColumnIndex: 10, endColumnIndex: 16 }));
  assert.deepEqual(sheets.analysisProtectionHit(daily, 16, 16), { fromCol: 11, toCol: 16 });
  assert.equal(sheets.analysisProtectionHit(daily, 7, 10), null);
  // Somebody's own protection, or one listed for another tab, is not ours to enforce.
  const mine = tab(
    5,
    { protectedRangeId: 9, description: 'mine', range: { sheetId: 5, startColumnIndex: 6, endColumnIndex: 8 } },
    ours({ sheetId: 6, startColumnIndex: 6, endColumnIndex: 12 })
  );
  assert.equal(sheets.analysisProtectionHit(mine, 7, 12), null);
});

test('verifying a narrow job tab grows the grid, rewrites the header, protects G:L and lays the rows out - in one read and one write', async () => {
  // A tab somebody headed with the six user columns themselves: a job tab, six columns wide.
  const userHeader = ['Date', 'NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description'];
  let current = { columnCount: 6, header: userHeader, protectedRanges: [] };
  await withGoogle(
    (request) => {
      if (request.method === 'GET') {
        return json({
          sheets: [
            {
              properties: { sheetId: 7, title: TAB, gridProperties: { columnCount: current.columnCount } },
              protectedRanges: current.protectedRanges,
              data: [{ rowData: [{ values: current.header.map((formattedValue) => ({ formattedValue })) }] }],
            },
          ],
        });
      }
      return json({});
    },
    async (sheets, requests) => {
      const first = await sheets.verifyJobSheetTab('own-sheet', TAB);
      assert.deepEqual(first, { gid: 7, protection: 'missing', grewColumns: true, wroteHeader: true, jobTab: true });
      assert.equal(requests.length, 2, 'one read, one write');
      assert.match(decodeURIComponent(requests[0].url), /includeGridData=true&ranges='All'!1:1/);
      const sent = requests[1].body.requests;
      assert.deepEqual(sent[0], { appendDimension: { sheetId: 7, dimension: 'COLUMNS', length: 6 } }, 'grown first, never set outright');
      const header = sent[1].updateCells.rows[0].values;
      assert.deepEqual(header.map((value) => value.userEnteredValue.stringValue), [...sheets.JOB_SHEET_HEADERS]);
      assert.ok(header.every((value) => value.userEnteredFormat.wrapStrategy === 'CLIP'), 'the header clips too');
      // The protection goes back with the Analysis column below the header
      // cleared, in the same call: L only, from row 2 down.
      const clear = { updateCells: { range: { sheetId: 7, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 }, fields: 'userEnteredValue' } };
      const clearAt = sent.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(clear));
      assert.ok(clearAt > 0, 'the Analysis column is cleared, after the grid is grown');
      assert.ok(clearAt < sent.findIndex((entry) => entry.addProtectedRange), 'in the call that protects it');
      const protection = sent.find((entry) => entry.addProtectedRange).addProtectedRange.protectedRange;
      assert.deepEqual(protection.range, { sheetId: 7, startColumnIndex: 6, endColumnIndex: 12 });
      assert.deepEqual(protection.editors, { users: ['server@example.com'], domainUsersCanEdit: false });
      assert.equal(protection.warningOnly, false);
      // And every row 21 px, the data cells clipped, in that same call.
      assert.ok(
        sent.some((entry) => entry.updateDimensionProperties?.range.dimension === 'ROWS' && entry.updateDimensionProperties.properties.pixelSize === 21),
        '21 px rows'
      );
      assert.ok(sent.some((entry) => entry.repeatCell?.cell.userEnteredFormat.wrapStrategy === 'CLIP'), 'clipped');

      // Everything current: the read, and nothing to write - not even the layout.
      current = {
        columnCount: 12,
        header: [...sheets.JOB_SHEET_HEADERS],
        protectedRanges: [{ protectedRangeId: 3, ...protection }],
      };
      const second = await sheets.verifyJobSheetTab('own-sheet', TAB);
      assert.deepEqual(second, { gid: 7, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: true });
      assert.equal(requests.length, 3, 'and nothing cleared when the protection stood');
    }
  );
});

test('the row layout: 21 px from row 1 down, CLIP on the data rows of A:L, the Date column shown as a date', () => {
  const sheets = require('../dist/integrations/googleSheets');
  const whole = sheets.jobRowLayoutRequests(7);
  assert.deepEqual(whole[0], {
    updateDimensionProperties: { range: { sheetId: 7, dimension: 'ROWS', startIndex: 0 }, properties: { pixelSize: 21 }, fields: 'pixelSize' },
  });
  assert.deepEqual(whole[1], {
    repeatCell: {
      range: { sheetId: 7, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
      cell: { userEnteredFormat: { wrapStrategy: 'CLIP' } },
      fields: 'userEnteredFormat.wrapStrategy',
    },
  });
  assert.deepEqual(whole[2].repeatCell.cell.userEnteredFormat.numberFormat, { type: 'DATE', pattern: 'mm/dd/yyyy' });
  assert.deepEqual(whole[2].repeatCell.range, { sheetId: 7, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 });
  // Bounded: only the rows an export wrote.
  const block = sheets.jobRowLayoutRequests(7, 5, 9);
  assert.deepEqual(block[0].updateDimensionProperties.range, { sheetId: 7, dimension: 'ROWS', startIndex: 4, endIndex: 9 });
  assert.deepEqual(block[1].repeatCell.range, { sheetId: 7, startRowIndex: 4, endRowIndex: 9, startColumnIndex: 0, endColumnIndex: 12 });
});

test('a new tab is added where asked and laid out in one call: the header clipped, every row 21 px, the data clipped, G:L protected', async () => {
  // formatJobSheetTab is the path every new job tab takes - a new sheet's
  // All, and every tab this adds, Temp For AI included - so the row layout is
  // pinned on it, not only on the verify and the export.
  await withGoogle(
    (request) => {
      if (request.method === 'GET') return json({ sheets: [{ properties: { title: 'All', sheetId: 0 } }] });
      if (request.body?.requests?.[0]?.addSheet) return json({ replies: [{ addSheet: { properties: { sheetId: 9 } } }] });
      return json({});
    },
    async (sheets, requests) => {
      const added = await sheets.addSheetTabWithHeaders('own-sheet', 'Temp For AI', { index: 1 });
      assert.deepEqual(added, { gid: 9, created: true, protection: 'added', jobTab: true });
      assert.equal(requests.length, 3, 'the listing, the addSheet, then one format call');
      assert.equal(requests[1].body.requests[0].addSheet.properties.index, 1, 'second, behind All');
      assert.equal(requests[1].body.requests[0].addSheet.properties.title, 'Temp For AI');

      const sent = requests[2].body.requests;
      const header = sent.find((entry) => entry.updateCells?.start?.rowIndex === 0).updateCells.rows[0].values;
      assert.deepEqual(header.map((value) => value.userEnteredValue.stringValue), [...sheets.JOB_SHEET_HEADERS]);
      assert.ok(header.every((value) => value.userEnteredFormat.wrapStrategy === 'CLIP'), 'the header clips too');
      assert.ok(
        sent.some(
          (entry) =>
            JSON.stringify(entry) ===
            JSON.stringify({
              updateDimensionProperties: {
                range: { sheetId: 9, dimension: 'ROWS', startIndex: 0 },
                properties: { pixelSize: 21 },
                fields: 'pixelSize',
              },
            })
        ),
        'every row 21 px, from row 1 down'
      );
      assert.ok(
        sent.some(
          (entry) =>
            entry.repeatCell?.cell.userEnteredFormat.wrapStrategy === 'CLIP' &&
            JSON.stringify(entry.repeatCell.range) ===
              JSON.stringify({ sheetId: 9, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 })
        ),
        'the data cells of A:L clipped, from row 2 down'
      );
      const protection = sent.find((entry) => entry.addProtectedRange).addProtectedRange.protectedRange;
      assert.deepEqual(protection.range, { sheetId: 9, startColumnIndex: 6, endColumnIndex: 12 });
      assert.deepEqual(protection.editors, { users: ['server@example.com'], domainUsersCanEdit: false });
    }
  );
});

test('the tab listing is grid tabs only: a chart on a sheet of its own is left out', async () => {
  await withGoogle(
    () =>
      json({
        sheets: [
          { properties: { title: 'All', sheetId: 0, sheetType: 'GRID' } },
          { properties: { title: 'Chart1', sheetId: 5, sheetType: 'OBJECT' } },
          // Google leaves a field at its default out: no sheetType is a grid.
          { properties: { title: 'Notes', sheetId: 6 } },
        ],
      }),
    async (sheets, requests) => {
      assert.deepEqual(await sheets.listSheetTabs('own-sheet'), [
        { title: 'All', gid: 0 },
        { title: 'Notes', gid: 6 },
      ]);
      assert.match(decodeURIComponent(requests[0].url), /fields=sheets\(properties\(title,sheetId,sheetType\)\)/);
    }
  );
});

test('analysis values are written RAW, a boolean as a real TRUE/FALSE, and read back in one batched call', async () => {
  await withGoogle(
    () => json({ responses: [] }),
    async (sheets, requests) => {
      await sheets.batchUpdateValuesRaw('own-sheet', [{ range: `'${TAB}'!G2:L2`, values: [['=1+1', 'x', null, false, 'y', '{}']] }]);
      assert.equal(requests[0].body.valueInputOption, 'RAW');
      assert.deepEqual(requests[0].body.data[0].values[0], ['=1+1', 'x', null, false, 'y', '{}'], 'a null leaves its cell alone');

      const read = await sheets.batchGetValues('own-sheet', [`'${TAB}'!C2:E3`, `'${TAB}'!G2:L3`]);
      assert.match(requests[1].url, /values:batchGetByDataFilter$/);
      assert.deepEqual(requests[1].body.dataFilters, [{ a1Range: `'${TAB}'!C2:E3` }, { a1Range: `'${TAB}'!G2:L3` }]);
      assert.deepEqual(read, [[], []]);
    }
  );
});

test("Google's 429 is waited out with jittered backoff, Retry-After honoured, up to a cap - then reported", async () => {
  let answered = 0;
  await withGoogle(
    () => {
      answered += 1;
      return answered <= 2 ? json({ error: { code: 429, message: 'Quota exceeded' } }, 429, { 'retry-after': '3' }) : json({});
    },
    async (sheets) => {
      const waits = [];
      sheets.setSheetsRetryPolicyForTests({ sleep: async (ms) => waits.push(ms), random: () => 0.5 });
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        await sheets.batchUpdateValuesRaw('own-sheet', [{ range: 'A1:A1', values: [['x']] }]);
        assert.equal(answered, 3, 'tried until it went through');
        assert.deepEqual(waits, [3000, 3000], 'Retry-After beat the shorter backoff');

        answered = -100; // every call from here is a 429
        await assert.rejects(
          sheets.batchUpdateValuesRaw('own-sheet', [{ range: 'A1:A1', values: [['x']] }]),
          (error) => error.status === 429
        );
        assert.equal(waits.length, 2 + 5, 'five retries, then given up');
      } finally {
        console.warn = realWarn;
      }
      // The window doubles to the cap, jittered over its upper half.
      const policy = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 32000, random: () => 0 };
      assert.deepEqual([1, 2, 3, 6, 9].map((attempt) => sheets.sheetsRetryDelayMs(attempt, null, policy)), [500, 1000, 2000, 16000, 16000]);
      assert.equal(sheets.sheetsRetryDelayMs(1, '120', policy), 32000, 'a Retry-After past the cap is capped');
    }
  );
});

/**
 * A spreadsheet behind the REAL verify: Google's side of one tab - its row 1,
 * its protected ranges, its cells - applying the batch updates the verify
 * sends, the Analysis column's clear included.
 */
function googleTab(rows, header) {
  const state = { protectedRanges: [], nextId: 100, batchUpdates: [] };
  const handler = (request) => {
    if (request.method === 'GET') {
      return json({
        sheets: [
          {
            properties: { sheetId: 7, title: TAB, gridProperties: { columnCount: 12, rowCount: 1000 } },
            protectedRanges: state.protectedRanges,
            data: [{ rowData: [{ values: header.map((formattedValue) => ({ formattedValue })) }] }],
          },
        ],
      });
    }
    state.batchUpdates.push(request.body.requests);
    for (const entry of request.body.requests) {
      if (entry.addProtectedRange) state.protectedRanges.push({ protectedRangeId: state.nextId++, ...entry.addProtectedRange.protectedRange });
      const clear = entry.updateCells;
      if (clear && !clear.rows && clear.fields === 'userEnteredValue') {
        const letter = String.fromCharCode(65 + clear.range.startColumnIndex);
        for (const row of Object.keys(rows)) if (Number(row) > clear.range.startRowIndex) delete rows[row][letter];
      }
    }
    return json({});
  };
  return { state, handler };
}

test('a cell typed while the tab was unprotected is cleared when the protection goes back - never trusted after', async () => {
  // Program-shaped, for row 5's own posting, with an id nobody stored: what
  // somebody with the link could type into L of a job tab whose protection
  // was never added (the server's identity could not be learned when it was
  // laid out), before anything protected it.
  const forged = JSON.stringify({
    v: 1,
    id: '11111111-2222-4333-8444-555555555555',
    posting: postingOf(5),
    jobField: 'devops',
    analysis: JSON.parse(
      analysisAnswer({
        jobMeta: { title: 'FORGED BY A SHEET WRITER', seniority: 'senior', industry: '', department: '' },
        jobField: 'devops',
        salary: { min: 999000, max: 999000, currency: 'USD', period: 'annual', raw: '$999k' },
      })
    ),
  });
  const rows = { 3: sheetRow(3), 5: sheetRow(5, { L: forged }) };
  const google = googleTab(rows, [...require('../dist/integrations/googleSheets').JOB_SHEET_HEADERS]);
  await withGoogle(google.handler, async (sheets) => {
    const h = await serveWithSheet('sheet-forged', rows);
    try {
      const verifies = [];
      h.columns.setAnalysisSheetsClientForTests({
        ...h.sheet.client,
        async verifyTab(spreadsheetId, tabName) {
          const verified = await sheets.verifyJobSheetTab(spreadsheetId, tabName);
          verifies.push(verified.protection);
          return verified;
        },
      });
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        // Run 1, on another row: the protection is missing, and goes back with L cleared.
        await order(h, [submittedJob(3)]);
        await h.columns.flushAnalysisWriteBacks();
        // Run 2, on the row: the protection is intact now, and the cell is gone.
        await order(h, [submittedJob(5)]);
        await h.columns.flushAnalysisWriteBacks();
      } finally {
        console.warn = realWarn;
      }
      assert.deepEqual(verifies.slice(0, 2), ['missing', 'intact']);
      assert.equal(h.seats.tailorings().some((call) => call.userBody.includes('FORGED')), false, 'nobody is built on it');
      const { getDb } = require('../dist/database/sqlite');
      assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM job_analyses WHERE source = 'sheet'").get().n, 0, 'nor is it stored');
      assert.equal(h.seats.analyses().length, 2, 'each posting analysed once');
      assert.notEqual(JSON.parse(rows[5].L).analysis.jobMeta.title, 'FORGED BY A SHEET WRITER', 'and the row now holds the real one');

      const asked = await h.post('/resume/analyze', { jobDescription: posting(5) });
      assert.equal(asked.status, 200);
      assert.notEqual(asked.body.jobMeta?.title, 'FORGED BY A SHEET WRITER');
      assert.equal(h.seats.analyses().length, 2);
    } finally {
      h.close();
    }
  });
});

test("only job tabs are ever verified: an older build's daily tab, a person's own tab and a tab with data under a blank row 1 are left exactly as they are", async () => {
  const own = ['Company', 'Job Link', 'Description', 'Applied?', 'Notes', 'F', 'G', 'H', 'I', 'J', 'My K column', 'My L column'];
  // Every daily tab an older build laid out: sixteen columns, NO(DATE) first, K:P protected by that build.
  const oldDaily = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder',
    'Filter Result', 'Filter Reason', 'Job Field', 'Salary', 'Job Hash', 'Analyzed At', 'Lake Status', 'Analysis'];
  const eightColumn = oldDaily.slice(0, 8);
  const headers = {
    'My shortlist': own,
    '10/05/2026': oldDaily,
    'Copied layout': eightColumn,
    'Blank header, data below': [],
    'Empty tab': [],
    // An old daily tab whose row 1 is empty, but which holds rows: not converted either.
    '10/06/2026': [],
  };
  const values = {
    'Blank header, data below': [[], ['', 'Acme', 'Engineer']],
    'Empty tab': [],
    '10/06/2026': [[], ['1', 'Acme']],
  };
  await withGoogle(
    (request) => {
      const url = decodeURIComponent(request.url);
      if (request.method !== 'GET') return json({});
      const whole = /\/values\/'([^']+)'\?/.exec(url);
      if (whole) return json({ range: whole[1], majorDimension: 'ROWS', ...(values[whole[1]].length ? { values: values[whole[1]] } : {}) });
      const title = /ranges='([^']+)'!1:1/.exec(url)[1];
      return json({
        properties: { title: 'Free Tailor - a@example.com' },
        sheets: [
          {
            properties: { sheetId: 9, title, gridProperties: { columnCount: 26, rowCount: 1000 } },
            protectedRanges: title === '10/05/2026'
              ? [{ protectedRangeId: 4, description: 'Tailor analysis columns - written by the program only', range: { sheetId: 9, startColumnIndex: 10, endColumnIndex: 16 } }]
              : [],
            data: [{ rowData: [{ values: headers[title].map((formattedValue) => ({ formattedValue })) }] }],
          },
        ],
      });
    },
    async (sheets, requests) => {
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        for (const title of ['My shortlist', '10/05/2026', 'Copied layout', 'Blank header, data below', '10/06/2026']) {
          const before = requests.length;
          const theirs = await sheets.verifyJobSheetTab('own-sheet', title);
          assert.deepEqual(theirs, { gid: 9, protection: 'unconfirmed', grewColumns: false, wroteHeader: false, jobTab: false }, title);
          assert.ok(
            requests.slice(before).every((request) => request.method === 'GET'),
            `${title}: read, and nothing written - no header, no protection, no clear, no layout`
          );
        }

        // An EMPTY tab, under any name, becomes a job tab the first time it is used.
        const empty = await sheets.verifyJobSheetTab('own-sheet', 'Empty tab');
        assert.equal(empty.jobTab, true);
        assert.equal(empty.wroteHeader, true);
        const sent = requests.at(-1).body.requests;
        assert.ok(sent.some((entry) => entry.addProtectedRange), 'protected');
        assert.ok(sent.some((entry) => entry.updateSheetProperties?.properties.gridProperties.frozenRowCount === 1), 'header row frozen');
        assert.ok(sent.some((entry) => entry.updateDimensionProperties?.properties.pixelSize === 21), 'rows laid out');

        assert.equal(sheets.isJobSheetTab({ headerRow: ['Date', 'NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description'] }), true);
        assert.equal(sheets.isJobSheetTab({ headerRow: oldDaily }), false, "an older build's daily tab");
        assert.equal(sheets.isJobSheetTab({ headerRow: [], empty: false }), false, 'blank row 1 above data');
        assert.equal(sheets.isJobSheetTab({ headerRow: [] }), false, 'blank row 1, emptiness not known');
        assert.equal(sheets.isJobSheetTab({ headerRow: ['', ''], empty: true }), true, 'a wholly empty tab');
        assert.equal(sheets.jobTabLayoutOf(oldDaily), 'other');
        assert.equal(sheets.jobTabLayoutOf([' ', '']), 'blank');
        assert.equal(sheets.jobTabLayoutOf([...sheets.JOB_SHEET_HEADERS]), 'job');
      } finally {
        console.warn = realWarn;
      }
    }
  );
});

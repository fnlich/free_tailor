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
 * The app sheet's six analysis columns (owner decision J5) and sheet-first
 * builds (P7): what is read, what is trusted, what is written, and how.
 *
 * Two halves. Through the routes, against a fake spreadsheet held in memory: a
 * row already analysed skips analysis and is tailored on exactly the analysis
 * READ FROM THE SHEET, a row not analysed is analysed once and written back,
 * once, and the rows are read in one batched call per run - never taken from
 * the request. Then the integration itself against a stubbed `fetch`: the
 * protection's request shape and its repair, the grid grown past twelve
 * columns, RAW writes, and the backoff on Google's 429.
 */

const TAB = '10/05/2026';
const COLUMNS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];

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

/** A row as the account sheet lays it out: B company, C title, D link, E description. */
function sheetRow(n, extra = {}) {
  return { B: `Company ${n}`, C: 'Engineer', D: `https://jobs.example.com/${n}`, E: posting(n), ...extra };
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

test('rows whose Analysis cell is filled make no analysis call, and tailoring gets exactly the sheet\'s analysis', async (t) => {
  const rows = {
    2: sheetRow(2, { P: analysisCell('Sheet Title Two', undefined, 2) }),
    3: sheetRow(3, { P: analysisCell('Sheet Title Three', '5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', 3) }),
  };
  const h = await serveWithSheet('sheet-filled', rows);
  t.after(h.close);

  // Even a forged analysis in the body changes nothing: the cells are read by the server.
  const snapshot = await order(h, [
    submittedJob(2, { jobAnalysis: { jobMeta: { title: 'Forged' } } }),
    submittedJob(3),
  ]);
  assert.equal(snapshot.completed, 4);
  assert.equal(h.seats.analyses().length, 0, 'zero analysis calls');
  assert.equal(h.sheet.calls.reads.length, 1, 'one batched read of the submitted rows');
  assert.equal(h.sheet.calls.reads[0].length, 2, 'one run of rows: identity and Analysis, two ranges');

  const tailored = h.seats.tailorings().map((call) => /"title":"(Sheet Title \w+)"/.exec(call.userBody)?.[1]);
  assert.deepEqual(tailored.sort(), ['Sheet Title Three', 'Sheet Title Three', 'Sheet Title Two', 'Sheet Title Two']);
  assert.equal(h.seats.tailorings().some((call) => call.userBody.includes('Forged')), false);

  // Registered without a call, so the database and the sheet hold the same analysis.
  const { getDb } = require('../dist/database/sqlite');
  const stored = getDb().prepare('SELECT source, job_field_id FROM job_analyses ORDER BY created_at').all();
  assert.deepEqual(stored, [
    { source: 'sheet', job_field_id: 'devops' },
    { source: 'sheet', job_field_id: 'devops' },
  ]);
  await h.columns.flushAnalysisWriteBacks();
  assert.equal(h.sheet.calls.writes.length, 0, 'nothing written over cells that were filled');
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
  assert.deepEqual(report, { written: 2, skipped: 0, failed: 0 });
  assert.equal(h.sheet.calls.writes.length, 1, 'both rows in one write');
  const [write] = h.sheet.calls.writes;
  assert.deepEqual(write.map((entry) => entry.range), [`'${TAB}'!K4:P4`, `'${TAB}'!K5:P5`]);
  const [field, salary, hash, analyzedAt, lakeStatus, cell] = write[0].values[0];
  assert.equal(field, 'Backend');
  assert.equal(salary, '$180k - $220k');
  assert.equal(hash, null, 'Job Hash is the lake\'s to fill');
  assert.match(analyzedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lakeStatus, null);
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
  const rows = { 6: sheetRow(6, { P: cut }), 7: sheetRow(7, { P: 'not json at all' }), 8: sheetRow(8, { P: '{"v":1' }) };
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
  const rows = {
    9: sheetRow(9, { P: analysisCell('Untrusted Title', undefined, 9) }),
    10: sheetRow(10, { B: 'Somebody Else Entirely' }),
  };
  const h = await serveWithSheet('sheet-untrusted', rows, { protection: 'altered' });
  t.after(h.close);

  await order(h, [submittedJob(9), submittedJob(10)]);
  // Neither cell could be used: the store had nothing, so each posting was analysed once.
  assert.equal(h.seats.analyses().length, 2);
  assert.equal(h.seats.tailorings().some((call) => call.userBody.includes('Untrusted Title')), false);

  await h.columns.flushAnalysisWriteBacks();
  // Row 9 has content (not overwritten); row 10 is another company's now.
  assert.equal(h.sheet.calls.writes.length, 0);
  assert.equal(rows[9].P, analysisCell('Untrusted Title', undefined, 9));
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
    3: sheetRow(3, { B: 'Moved Co' }),
    4: sheetRow(4, { P: '{"v":1,"id":"x"}' }),
    // A tab an older build made had K and L as spare columns: what somebody
    // typed there is not written over.
    5: sheetRow(5, { K: 'my own note' }),
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
    assert.deepEqual(report, { written: 0, skipped: 0, failed: 4 });
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
    assert.deepEqual(report, { written: 1, skipped: 3, failed: 0 });
    assert.equal(rows[5].K, 'my own note');
    assert.deepEqual(sheet.calls.writes.at(-1).map((entry) => entry.range), [`'${TAB}'!K2:P2`]);
    assert.equal(sheet.calls.verify, 2, 'the protection is checked before every write');
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
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 1, skipped: 0, failed: 0 });
  const before = JSON.parse(rows[2].P);

  // Another posting from the same company pasted over row 2's own columns.
  // K:P are protected, so the person cannot clear them: they stay.
  Object.assign(rows[2], { D: 'https://jobs.example.com/99', E: posting(99) });
  const replaced = submittedJob(99, { companyName: 'Company 2', sourceRowNumber: 2 });
  await order(h, [replaced]);
  assert.equal(h.seats.analyses().length, 2, "the new posting is analysed once - not answered with the old one's analysis");
  assert.deepEqual(tailoredTitles(h).slice(-2), ['Title of posting 99', 'Title of posting 99']);

  // The program is the only writer of those cells, so it puts them right.
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 1, skipped: 0, failed: 0 });
  const after = JSON.parse(rows[2].P);
  assert.notEqual(after.id, before.id);
  assert.deepEqual(after.posting, postingOf(99));
  assert.equal(after.analysis.jobMeta.title, 'Title of posting 99');

  // And from then on the row is read from the sheet again: no call.
  await order(h, [replaced]);
  assert.equal(h.seats.analyses().length, 2);
  assert.deepEqual(tailoredTitles(h).slice(-2), ['Title of posting 99', 'Title of posting 99']);
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 0, skipped: 0, failed: 0 });
});

test('rows sorted under the protected columns: each task gets its own posting\'s analysis, and the cells are put right', async (t) => {
  const rows = { 2: sheetRow(2), 3: sheetRow(3) };
  const h = await serveWithSheet('sheet-sorted', rows, { answer: titledAnswer });
  t.after(h.close);
  await order(h, [submittedJob(2), submittedJob(3)]);
  assert.equal((await h.columns.flushAnalysisWriteBacks()).written, 2);

  // A sort of A:J only - the protected K:P cannot move with it.
  const own = (row) => ({ B: row.B, C: row.C, D: row.D, E: row.E });
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

  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 2, skipped: 0, failed: 0 });
  assert.deepEqual(JSON.parse(rows[2].P).posting, postingOf(3));
  assert.deepEqual(JSON.parse(rows[3].P).posting, postingOf(2));
});

test('a cell that names no posting is not registered for the row\'s, even in an intact tab', async (t) => {
  const rows = { 4: sheetRow(4, { P: analysisCell('Unattached Title') }) };
  const h = await serveWithSheet('sheet-unattached', rows);
  t.after(h.close);
  await order(h, [submittedJob(4)]);
  assert.equal(h.seats.analyses().length, 1, 'analysed instead');
  assert.equal(h.seats.tailorings().some((call) => call.userBody.includes('Unattached Title')), false);
  const { getDb } = require('../dist/database/sqlite');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM job_analyses WHERE source = 'sheet'").get().n, 0);
});

test("a tab the person laid out for themselves is not read for analyses or written into", async (t) => {
  const rows = { 2: sheetRow(2), 3: sheetRow(3, { P: analysisCell('Their Own Text', undefined, 3) }) };
  const h = await serveWithSheet('sheet-user-tab', rows, { jobTab: false });
  t.after(h.close);
  await order(h, [submittedJob(2), submittedJob(3)]);
  assert.equal(h.sheet.calls.verify, 1, 'the verify said it is not a job tab');
  assert.equal(h.sheet.calls.reads.length, 0, 'so none of its cells was read');
  assert.equal(h.seats.analyses().length, 2, 'its postings were analysed from the store or a model');

  // Even a write-back queued for it some other way is refused at the verify.
  const stored = { id: 'u1', jobFieldId: 'backend', createdAt: 'x', analysis: JSON.parse(analysisAnswer()) };
  assert.equal(h.columns.queueAnalysisWriteBack({ spreadsheetId: 'own-sheet', tabName: TAB, row: 2, companyName: 'Company 2', stored }), true);
  assert.deepEqual(await h.columns.flushAnalysisWriteBacks(), { written: 0, skipped: 1, failed: 0 });
  assert.equal(h.sheet.calls.writes.length, 0);
  assert.equal(rows[2].K, undefined);
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
    assert.deepEqual(await columns.flushAnalysisWriteBacks(), { written: 0, skipped: 1, failed: 0 });

    assert.equal(columns.queueAnalysisWriteBack(entry(8)), true, 'the posting now in the row may be written there');
    assert.deepEqual(await columns.flushAnalysisWriteBacks(), { written: 1, skipped: 0, failed: 0 });
    assert.deepEqual(sheet.calls.writes.at(-1).map((write) => write.range), [`'${TAB}'!K7:P7`]);
    assert.equal(JSON.parse(rows[7].P).id, 'id-8');
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

test('the protection: the six whole columns, header included, editable by the server alone - and put back when altered', () => {
  const sheets = require('../dist/integrations/googleSheets');
  const email = 'server@example.com';
  const wanted = {
    description: sheets.ANALYSIS_PROTECTION_DESCRIPTION,
    warningOnly: false,
    range: { sheetId: 7, startColumnIndex: 10, endColumnIndex: 16 },
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
    ['other columns', { ...intact, range: { ...wanted.range, endColumnIndex: 15 } }],
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
});

test('verifying an old twelve-column tab grows the grid, rewrites the header and protects it - in one read and one write', async () => {
  const oldHeader = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder', 'Filter Result', 'Filter Reason'];
  let current = { columnCount: 12, header: oldHeader, protectedRanges: [] };
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
      const first = await sheets.verifyJobSheetTab('own-sheet', TAB, undefined, undefined, { onlyJobTabs: true });
      assert.deepEqual(first, { gid: 7, protection: 'missing', grewColumns: true, wroteHeader: true, jobTab: true }, 'an old app tab is a job tab');
      assert.equal(requests.length, 2, 'one read, one write');
      assert.match(decodeURIComponent(requests[0].url), /includeGridData=true&ranges='10\/05\/2026'!1:1/);
      const sent = requests[1].body.requests;
      assert.deepEqual(sent[0], { appendDimension: { sheetId: 7, dimension: 'COLUMNS', length: 4 } }, 'grown first, never set outright');
      assert.deepEqual(sent[1].updateCells.rows[0].values.map((value) => value.userEnteredValue.stringValue), [...sheets.JOB_SHEET_HEADERS]);
      // The protection goes back with the Analysis column below the header
      // cleared, in the same call: P only, from row 2 down.
      const clear = { updateCells: { range: { sheetId: 7, startRowIndex: 1, startColumnIndex: 15, endColumnIndex: 16 }, fields: 'userEnteredValue' } };
      const clearAt = sent.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(clear));
      assert.ok(clearAt > 0, 'the Analysis column is cleared, after the grid is grown');
      assert.ok(clearAt < sent.findIndex((entry) => entry.addProtectedRange), 'in the call that protects it');
      const protection = sent.find((entry) => entry.addProtectedRange).addProtectedRange.protectedRange;
      assert.deepEqual(protection.editors, { users: ['server@example.com'], domainUsersCanEdit: false });
      assert.equal(protection.warningOnly, false);

      // Everything current: the read, and nothing to write.
      current = {
        columnCount: 16,
        header: [...sheets.JOB_SHEET_HEADERS],
        protectedRanges: [{ protectedRangeId: 3, ...protection }],
      };
      const second = await sheets.verifyJobSheetTab('own-sheet', TAB);
      assert.deepEqual(second, { gid: 7, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: true });
      assert.equal(requests.length, 3, 'and nothing cleared when the protection stood');
    }
  );
});

test('analysis values and filter verdicts are written RAW, and a row write reads nothing first', async () => {
  await withGoogle(
    () => json({ responses: [] }),
    async (sheets, requests) => {
      await sheets.batchUpdateValuesRaw('own-sheet', [{ range: `'${TAB}'!K2:P2`, values: [['=1+1', 'x', null, 'y', null, '{}']] }]);
      assert.equal(requests[0].body.valueInputOption, 'RAW');
      assert.deepEqual(requests[0].body.data[0].values[0], ['=1+1', 'x', null, 'y', null, '{}'], 'a null leaves its cell alone');

      await sheets.updateGoogleSheetsRow({ sheetId: 'own-sheet', tabName: TAB, row: 5, updates: [{ col: 9, value: 'Pass' }] });
      assert.equal(requests.length, 2, 'no metadata read before the write');
      assert.equal(requests[1].body.valueInputOption, 'RAW');

      const read = await sheets.batchGetValues('own-sheet', [`'${TAB}'!B2:D3`, `'${TAB}'!P2:P3`]);
      assert.match(requests[2].url, /values:batchGetByDataFilter$/);
      assert.deepEqual(requests[2].body.dataFilters, [{ a1Range: `'${TAB}'!B2:D3` }, { a1Range: `'${TAB}'!P2:P3` }]);
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
            properties: { sheetId: 7, title: TAB, gridProperties: { columnCount: 16, rowCount: 1000 } },
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
  // somebody with the link could type into P on a tab an older build made,
  // or one they added, before anything protected it.
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
  const rows = { 3: sheetRow(3), 5: sheetRow(5, { P: forged }) };
  const google = googleTab(rows, [...require('../dist/integrations/googleSheets').JOB_SHEET_HEADERS]);
  await withGoogle(google.handler, async (sheets) => {
    const h = await serveWithSheet('sheet-forged', rows);
    try {
      const verifies = [];
      h.columns.setAnalysisSheetsClientForTests({
        ...h.sheet.client,
        async verifyTab(spreadsheetId, tabName) {
          const verified = await sheets.verifyJobSheetTab(spreadsheetId, tabName, undefined, undefined, { onlyJobTabs: true });
          verifies.push(verified.protection);
          return verified;
        },
      });
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        // Run 1, on another row: the protection is missing, and goes back with P cleared.
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
      assert.notEqual(JSON.parse(rows[5].P).analysis.jobMeta.title, 'FORGED BY A SHEET WRITER', 'and the row now holds the real one');

      const asked = await h.post('/resume/analyze', { jobDescription: posting(5) });
      assert.equal(asked.status, 200);
      assert.notEqual(asked.body.jobMeta?.title, 'FORGED BY A SHEET WRITER');
      assert.equal(h.seats.analyses().length, 2);
    } finally {
      h.close();
    }
  });
});

test("only job tabs are verified: a person's own tab is left as it is, an app tab of any age or an unformatted day's tab is not", async () => {
  const own = ['Company', 'Job Link', 'Description', 'Applied?', 'Notes', 'F', 'G', 'H', 'I', 'J', 'My K column', 'My L column'];
  const eightColumn = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder'];
  const headers = { 'My shortlist': own, 'Copied layout': eightColumn, '10/06/2026': [] };
  await withGoogle(
    (request) => {
      if (request.method !== 'GET') return json({});
      const title = /ranges='([^']+)'!1:1/.exec(decodeURIComponent(request.url))[1];
      return json({
        sheets: [
          {
            properties: { sheetId: 9, title, gridProperties: { columnCount: 26, rowCount: 1000 } },
            protectedRanges: [],
            data: [{ rowData: [{ values: headers[title].map((formattedValue) => ({ formattedValue })) }] }],
          },
        ],
      });
    },
    async (sheets, requests) => {
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        const theirs = await sheets.verifyJobSheetTab('own-sheet', 'My shortlist', undefined, undefined, { onlyJobTabs: true });
        assert.deepEqual(theirs, { gid: 9, protection: 'unconfirmed', grewColumns: false, wroteHeader: false, jobTab: false });
        assert.equal(requests.length, 1, 'read, and nothing written: no header, no protection');

        for (const title of ['Copied layout', '10/06/2026']) {
          const ours = await sheets.verifyJobSheetTab('own-sheet', title, undefined, undefined, { onlyJobTabs: true });
          assert.equal(ours.jobTab, true, title);
          assert.equal(ours.wroteHeader, true, title);
          const sent = requests.at(-1).body.requests;
          assert.ok(sent.some((entry) => entry.addProtectedRange), `${title} is protected`);
        }
        assert.equal(sheets.isJobSheetTab({ title: '10/06/2026', headerRow: ['My own header'] }), false, "a day's tab somebody headed is theirs");
      } finally {
        console.warn = realWarn;
      }
    }
  );
});

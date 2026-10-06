const assert = require('node:assert/strict');
const test = require('node:test');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { posting, serveInstall, untilFinished } = require('./analysisHarness');
const { storeJobAnalysis } = require('./helpers');

/**
 * Push to Google Sheet (Admin -> Job Lake, owner decision L1), over HTTP
 * against every account's spreadsheet held in memory: the jobs the lake's
 * filters match, newest first, written into the PUSHING administrator's own
 * Temp For AI tab - its A:L below the header replaced, values and red paint,
 * nothing past L and never the header - with Date and NO(DATE) as the job
 * sheet numbers them, the description cut at Google's limit, and the six
 * analysis cells exactly as a build writes them, so a build from the tab
 * asks no model. Then the refusals: a push already going, a Temp For AI that
 * is not a job tab or whose name is the person's own, a filter Search
 * refuses - each before anything is written - and the cap.
 */

const TEMP = 'Temp For AI';
const DAY = 24 * 60 * 60 * 1000;

const accountSheet = require('../dist/services/sheets/accountSheet');
const columns = require('../dist/services/sheets/analysisColumns');
const push = require('../dist/services/jobLake/push');
const service = require('../dist/services/jobLake/index');
const analyses = require('../dist/database/jobAnalysisRepository');
const lake = require('../dist/database/jobLakeRepository');
const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');

const letter = (n) => String.fromCharCode(64 + n);
const number = (l) => l.charCodeAt(0) - 64;
/** Every column a fake tab holds: the job layout's twelve and two of the person's own past it. */
const COLUMNS = Array.from({ length: 14 }, (_, index) => letter(index + 1));

/**
 * Every spreadsheet in memory, behind the push's seam AND the analysis
 * columns' (what a build from the tab reads): `book(id).get(tab)` is
 * `{ gid, header, rows: { [row]: { [letter]: value } }, paint: { [row]: { [letter]: color } }, rowCount }`.
 * Records every call by kind, with the spreadsheet it named.
 */
function fakeBooks() {
  const books = new Map();
  const calls = { inspect: [], verify: [], updates: [], writes: [], reads: [] };
  const hold = { update: null };
  const book = (id) => {
    if (!books.has(id)) books.set(id, new Map());
    return books.get(id);
  };
  const tab = (id, name) => {
    const tabs = book(id);
    if (!tabs.has(name)) tabs.set(name, { gid: name === TEMP ? 9 : 7, header: [...JOB_SHEET_HEADERS], rows: {}, paint: {}, rowCount: 1000 });
    return tabs.get(name);
  };
  const parse = (range) => {
    const match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    assert.ok(match, `a range the fake understands: ${range}`);
    return { tab: match[1].replace(/''/g, "'"), fromCol: number(match[2]), fromRow: Number(match[3]), toCol: number(match[4]), toRow: Number(match[5]) };
  };
  const isJobTab = (t) => JOB_SHEET_HEADERS.slice(0, 6).every((header, index) => t.header[index] === header);

  const read = (id, ranges) =>
    ranges.map((range) => {
      const { tab: name, fromCol, fromRow, toCol, toRow } = parse(range);
      const t = tab(id, name);
      const grid = [];
      for (let row = fromRow; row <= toRow; row += 1) {
        const values = [];
        for (let col = fromCol; col <= toCol; col += 1) {
          const value = t.rows[row]?.[letter(col)];
          // A FORMATTED read: a boolean as TRUE/FALSE, a number as its text.
          values.push(value === undefined || value === null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value));
        }
        grid.push(values);
      }
      return grid;
    });
  const write = (id, data) => {
    for (const { range, values } of data) {
      const { tab: name, fromCol, fromRow, toCol, toRow } = parse(range);
      assert.equal(values.length, toRow - fromRow + 1, `${range}: one row of values per row`);
      const t = tab(id, name);
      values.forEach((cells, offset) => {
        assert.ok(cells.length <= toCol - fromCol + 1, `${range}: no more cells than columns`);
        const row = fromRow + offset;
        assert.ok(row <= t.rowCount, `${range}: row ${row} is inside the grid (${t.rowCount} rows)`);
        cells.forEach((value, index) => {
          if (value === null) return;
          t.rows[row] = t.rows[row] ?? {};
          t.rows[row][letter(fromCol + index)] = value;
        });
      });
    }
  };

  const pushClient = {
    async inspectTab(id, name) {
      calls.inspect.push({ id, name });
      const t = tab(id, name);
      return { gid: t.gid, title: name, columnCount: 14, rowCount: t.rowCount, headerRow: [...t.header], protectedRanges: [] };
    },
    async verifyTab(id, name) {
      calls.verify.push({ id, name });
      const t = tab(id, name);
      return { gid: t.gid, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: isJobTab(t) };
    },
    async batchUpdate(id, requests) {
      calls.updates.push({ id, requests });
      if (hold.update) await hold.update;
      for (const request of requests) {
        if (request.appendDimension) {
          assert.equal(request.appendDimension.dimension, 'ROWS');
          const t = [...book(id).values()].find((entry) => entry.gid === request.appendDimension.sheetId);
          t.rowCount += request.appendDimension.length;
        }
        if (request.updateCells) {
          const { range, fields } = request.updateCells;
          const t = [...book(id).values()].find((entry) => entry.gid === range.sheetId);
          const clearsValues = fields.split(',').includes('userEnteredValue');
          const clearsPaint = fields.split(',').includes('userEnteredFormat.backgroundColor');
          for (const row of Object.keys({ ...t.rows, ...t.paint }).map(Number)) {
            if (row - 1 < range.startRowIndex || (range.endRowIndex !== undefined && row - 1 >= range.endRowIndex)) continue;
            for (let col = range.startColumnIndex; col < range.endColumnIndex; col += 1) {
              if (clearsValues && t.rows[row]) delete t.rows[row][letter(col + 1)];
              if (clearsPaint && t.paint[row]) delete t.paint[row][letter(col + 1)];
            }
          }
        }
      }
    },
    async writeRaw(id, data) {
      calls.writes.push({ id, data });
      write(id, data);
    },
  };
  // What a build from the tab reads and writes, through the analysis columns' seam.
  const analysisClient = {
    async verifyTab(id, name) {
      return pushClient.verifyTab(id, name);
    },
    async readRanges(id, ranges) {
      calls.reads.push({ id, ranges });
      return read(id, ranges);
    },
    async writeRaw(id, data) {
      calls.writes.push({ id, data, analysis: true });
      write(id, data);
    },
  };
  return { books, calls, hold, tab, pushClient, analysisClient };
}

/** Allocates each account `sheet-<n>` with All (gid 7) and Temp For AI (gid 9); `clash` makes Temp For AI the person's own. */
function accountSheetClient(options = {}) {
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
    async addSheetTabWithHeaders(_id, title) {
      if (title === TEMP && options.clash) return { gid: 9, created: false, jobTab: false };
      return { gid: title === TEMP ? 9 : 7, created: false };
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
      return [{ title: 'All', gid: 7 }, { title: TEMP, gid: 9 }];
    },
    async readRanges(_id, ranges) {
      return ranges.map(() => [[...JOB_SHEET_HEADERS]]);
    },
  };
}

/**
 * An install (the harness's: resume, generation and jobs routes, counting
 * seats, owner@example.com an administrator with one profile) plus the lake's
 * routes, a second administrator and a user, each with a sheet of their own.
 */
async function serve(name, options = {}) {
  const h = await serveInstall(`lake-push-${name}`, { profiles: [['p-claude', 'Ada', 'claude-cli-sonnet']] });
  push.resetLakePushForTests();
  service.setLakeClockForTests();
  const google = fakeBooks();
  accountSheet.setSheetsClientForTests(accountSheetClient(options));
  push.setLakePushSheetsClientForTests(google.pushClient);
  columns.setAnalysisSheetsClientForTests(google.analysisClient);

  const second = h.users.createUser({ email: 'second@example.com', role: 'admin' });
  const user = h.users.createUser({ email: 'user@example.com' });
  const reporter = h.users.createUser({ email: 'reporter@example.com', role: 'reporter' });
  const sheets = {};
  for (const [key, account] of [['owner', h.owner], ['second', second], ['user', user]]) {
    sheets[key] = (await accountSheet.ensureAccountSheet(h.users.getUserById(account.id))).spreadsheetId;
  }
  const tokens = Object.fromEntries(
    [['owner', h.owner], ['second', second], ['user', user], ['reporter', reporter]].map(([key, account]) => [key, h.users.createSession(account.id)])
  );

  const express = require('express');
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
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
    ...h,
    google,
    sheets,
    second,
    user,
    call,
    pushAs: (who, body = {}) => call(who, 'POST', '/admin/job-lake/push', body),
    close() {
      server.close();
      push.setLakePushSheetsClientForTests();
      push.resetLakePushForTests();
      h.close();
    },
  };
}

/**
 * A lake job from an analysis stored for posting `n` - `company`'s, in
 * `field` - merged at `at` (epoch ms). Answers the stored analysis.
 */
function lakeJob(n, company, at, analysis = {}, extra = {}) {
  const id = storeJobAnalysis(
    {
      jobField: 'backend',
      jobMeta: { title: `Engineer ${n}`, seniority: 'senior', industry: '', department: '' },
      ...analysis,
    },
    { jobDescription: extra.jobDescription ?? posting(n), jobLink: `https://jobs.example.com/${n}`, companyName: company }
  );
  const stored = analyses.getJobAnalysisById(id);
  const merged = service.mergeIntoLake(service.lakeJobFromAnalysis(stored, 'merge', { company }), null, { reward: false, now: at });
  assert.equal(merged.status, 'added', `${company} goes into the lake`);
  return stored;
}

/** Row `row` of a tab as A:N values. */
function rowOf(t, row) {
  return COLUMNS.map((col) => t.rows[row]?.[col] ?? '');
}

test('a push replaces Temp For AI A:L below the header, values and red paint, newest first - the header and columns past L untouched', async (t) => {
  const h = await serve('replace');
  t.after(() => h.close());
  const now = Date.now();
  const older = lakeJob(1, 'Acme', now - 3 * DAY, {
    jobField: 'devops',
    salary: { min: 100000, max: 120000, currency: 'USD', period: 'annual', raw: '$100k - $120k' },
    filter: { jobType: 'remote', onsiteInterview: 'no', companyCategory: 'fintech', clearanceRequired: 'secret', region: 'us', usState: null },
  });
  const newer = lakeJob(2, 'Globex', now - DAY);
  // A job merged from no analysis at all: its six analysis cells stay blank.
  service.mergeIntoLake(
    { company: 'Initech', jobFieldId: 'backend', title: 'Old hand', salary: null, url: 'https://jobs.example.com/old', jobDescription: 'An old posting.', analysisId: null, source: 'merge', jobType: '', clearance: false, industry: 'not_specified' },
    null,
    { reward: false, now: now - 5 * DAY }
  );

  // What the tab held: a header with two columns of the person's own past L,
  // six rows of an earlier push, two of them painted red whole by a report run.
  const temp = h.google.tab(h.sheets.owner, TEMP);
  temp.header = [...JOB_SHEET_HEADERS, 'My M', 'My N'];
  temp.rowCount = 7;
  for (let row = 2; row <= 7; row += 1) {
    temp.rows[row] = Object.fromEntries(COLUMNS.map((col) => [col, `old ${col}${row}`]));
  }
  const red = { red: 0.957, green: 0.8, blue: 0.8 };
  for (const row of [3, 4]) temp.paint[row] = Object.fromEntries(COLUMNS.map((col) => [col, red]));

  const pushed = await h.pushAs('owner');
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.deepEqual(pushed.body, {
    pushed: 3,
    matched: 3,
    capped: false,
    maxRows: 1000,
    tabName: TEMP,
    tabUrl: `https://docs.google.com/spreadsheets/d/${h.sheets.owner}/edit#gid=9`,
  });

  // One :batchUpdate before any value: A:L of every row below the header
  // emptied - values and background - and the rows laid out; no growth needed.
  assert.equal(h.google.calls.updates.length, 1);
  const [update] = h.google.calls.updates;
  assert.equal(update.id, h.sheets.owner);
  assert.deepEqual(update.requests[0], {
    updateCells: {
      range: { sheetId: 9, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 12 },
      fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
    },
  });
  assert.deepEqual(update.requests.slice(1), require('../dist/integrations/googleSheets').jobRowLayoutRequests(9));
  assert.equal(h.google.calls.writes.length, 1, 'three rows: one write');
  assert.deepEqual(h.google.calls.writes[0].data.map((entry) => entry.range), [`'${TEMP}'!A2:L4`]);

  // The rows: newest first, A:L, the person's M and N kept.
  assert.deepEqual(temp.header, [...JOB_SHEET_HEADERS, 'My M', 'My N'], 'the header is never touched');
  const { sheetDateSerial, sheetDateText } = accountSheet;
  const dateOf = (at) => sheetDateSerial(sheetDateText(new Date(at)));
  assert.deepEqual(rowOf(temp, 2), [
    dateOf(now - DAY), 1, 'Globex', 'Engineer 2', 'https://jobs.example.com/2', posting(2),
    ...columns.analysisColumnValues(newer), 'old M2', 'old N2',
  ]);
  const acme = rowOf(temp, 3);
  assert.deepEqual(acme.slice(0, 6), [dateOf(now - 3 * DAY), 1, 'Acme', 'Engineer 1', 'https://jobs.example.com/1', posting(1)]);
  assert.deepEqual(acme.slice(6, 12), columns.analysisColumnValues(older), 'the six exactly as a build writes them');
  assert.deepEqual(acme.slice(6, 11), ['DevOps', '$100k - $120k', 'Remote', true, 'Finance']);
  assert.equal(JSON.parse(acme[11]).id, older.id, 'the Analysis cell names its stored analysis');
  assert.deepEqual(acme.slice(12), ['old M3', 'old N3']);
  assert.deepEqual(rowOf(temp, 4).slice(0, 12), [
    dateOf(now - 5 * DAY), 1, 'Initech', 'Old hand', 'https://jobs.example.com/old', 'An old posting.', '', '', '', '', '', '',
  ]);
  for (let row = 5; row <= 7; row += 1) {
    assert.deepEqual(rowOf(temp, row), [...Array(12).fill(''), `old M${row}`, `old N${row}`], `row ${row}: A:L emptied, M:N kept`);
  }
  // The red paint is gone from A:L, and only from A:L.
  for (const row of [3, 4]) {
    assert.deepEqual(Object.keys(temp.paint[row]).sort(), ['M', 'N'], `row ${row}`);
  }

  // Only the owner's own sheet, only Temp For AI.
  const touched = [...h.google.calls.inspect, ...h.google.calls.verify, ...h.google.calls.updates, ...h.google.calls.writes];
  assert.ok(touched.every((entry) => entry.id === h.sheets.owner));
  assert.ok([...h.google.calls.inspect, ...h.google.calls.verify].every((entry) => entry.name === TEMP));
  assert.equal(h.google.books.has(h.sheets.second), false, "another administrator's sheet is never touched");
  assert.equal(h.google.books.has(h.sheets.user), false);
});

test('Date is the day a job was added or replaced in SHEET_TIMEZONE, NO(DATE) counts each day from 1 down the rows', async (t) => {
  const saved = process.env.SHEET_TIMEZONE;
  process.env.SHEET_TIMEZONE = 'America/New_York';
  const h = await serve('dates');
  t.after(() => {
    h.close();
    if (saved === undefined) delete process.env.SHEET_TIMEZONE;
    else process.env.SHEET_TIMEZONE = saved;
  });
  // 02:00 and 03:00 UTC on the 5th are the evening of the 4th in New York.
  lakeJob(1, 'Early', Date.parse('2026-10-05T02:00:00Z'));
  lakeJob(2, 'Later', Date.parse('2026-10-05T03:00:00Z'));
  lakeJob(3, 'Next day', Date.parse('2026-10-05T15:00:00Z'));
  lakeJob(4, 'Next day too', Date.parse('2026-10-05T16:00:00Z'));

  assert.equal((await h.pushAs('owner')).status, 200);
  const temp = h.google.tab(h.sheets.owner, TEMP);
  const { sheetDateSerial } = accountSheet;
  assert.deepEqual(
    [2, 3, 4, 5].map((row) => [temp.rows[row].A, temp.rows[row].B, temp.rows[row].C]),
    [
      [sheetDateSerial('10/05/2026'), 1, 'Next day too'],
      [sheetDateSerial('10/05/2026'), 2, 'Next day'],
      [sheetDateSerial('10/04/2026'), 1, 'Later'],
      [sheetDateSerial('10/04/2026'), 2, 'Early'],
    ]
  );
  assert.equal(typeof temp.rows[2].A, 'number', 'a real date: the serial the column shows as MM/DD/YYYY');
});

test('the filters are the list\'s own: a push holds exactly what Search shows, and a filter Search refuses touches nothing', async (t) => {
  const h = await serve('filters');
  t.after(() => h.close());
  const now = Date.now();
  const remote = { jobType: 'remote', onsiteInterview: 'no', companyCategory: 'healthcare', clearanceRequired: 'none', region: 'us', usState: null };
  const onsite = { ...remote, jobType: 'on_site', clearanceRequired: 'top_secret', companyCategory: 'fintech' };
  lakeJob(1, 'Remote Health', now - 4 * DAY, { jobField: 'devops', filter: remote });
  lakeJob(2, 'Onsite Bank', now - 3 * DAY, { jobField: 'devops', filter: onsite });
  lakeJob(3, 'Backend Health', now - 2 * DAY, { jobField: 'backend', filter: remote });
  lakeJob(4, 'Backend Bank', now - DAY, { jobField: 'backend', filter: onsite });

  const cases = [
    [{ field: 'devops' }, ['Onsite Bank', 'Remote Health']],
    [{ jobType: 'remote' }, ['Backend Health', 'Remote Health']],
    [{ clearance: 'true', field: 'backend' }, ['Backend Bank']],
    [{ clearance: true }, ['Backend Bank', 'Onsite Bank']],
    [{ industry: 'healthcare' }, ['Backend Health', 'Remote Health']],
    [{ company: 'onsite bank' }, ['Onsite Bank']],
    [{ q: 'Posting 3' }, ['Backend Health']],
    [{ updatedFrom: new Date(now - 2.5 * DAY).toISOString() }, ['Backend Bank', 'Backend Health']],
  ];
  for (const [filters, companies] of cases) {
    const query = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]));
    const listed = await h.call('owner', 'GET', `/admin/job-lake?${query}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.rows.map((row) => row.company), companies, `Search ${query}`);
    const pushed = await h.pushAs('owner', filters);
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(pushed.body.matched, listed.body.total);
    assert.equal(pushed.body.pushed, companies.length);
    const temp = h.google.tab(h.sheets.owner, TEMP);
    assert.deepEqual(
      Object.keys(temp.rows).map(Number).sort((a, b) => a - b).filter((row) => temp.rows[row].C).map((row) => temp.rows[row].C),
      companies,
      `Push ${query}`
    );
  }

  // Refused in Search's own words, before anything is read or written.
  const before = { inspect: h.google.calls.inspect.length, updates: h.google.calls.updates.length };
  for (const [filters, message] of [
    [{ field: 'astrology' }, 'That job field is not one of the list.'],
    [{ jobType: 'sometimes' }, 'That job type is not one of the list.'],
    [{ clearance: 'maybe' }, 'Clearance must be true or false.'],
    [{ industry: 'piracy' }, 'That industry is not one of the list.'],
    [{ salaryMin: 'lots' }, 'The lowest salary must be a number.'],
    [{ updatedTo: 'yesterday' }, 'Updated to must be a date, like 2026-10-05.'],
  ]) {
    const refused = await h.pushAs('owner', filters);
    assert.equal(refused.status, 400, JSON.stringify(filters));
    assert.equal(refused.body.error, message);
    const query = new URLSearchParams(Object.entries(filters));
    assert.equal((await h.call('owner', 'GET', `/admin/job-lake?${query}`)).body.error, message, 'the same words as Search');
  }
  assert.equal(h.google.calls.inspect.length, before.inspect);
  assert.equal(h.google.calls.updates.length, before.updates);

  // A spreadsheet or tab in the body is not read: it is always the caller's own Temp For AI.
  const aimed = await h.pushAs('owner', { spreadsheetId: h.sheets.user, tabName: 'All', field: 'devops' });
  assert.equal(aimed.status, 200);
  assert.equal(aimed.body.tabName, TEMP);
  assert.equal(h.google.books.has(h.sheets.user), false);
});

test('more matches than JOB_LAKE_PUSH_MAX_ROWS: the newest are pushed and the answer says it was capped', async (t) => {
  const saved = process.env.JOB_LAKE_PUSH_MAX_ROWS;
  process.env.JOB_LAKE_PUSH_MAX_ROWS = '3';
  const h = await serve('cap');
  t.after(() => {
    h.close();
    if (saved === undefined) delete process.env.JOB_LAKE_PUSH_MAX_ROWS;
    else process.env.JOB_LAKE_PUSH_MAX_ROWS = saved;
  });
  const now = Date.now();
  for (let n = 1; n <= 5; n += 1) lakeJob(n, `Company ${n}`, now - (10 - n) * DAY);

  const pushed = await h.pushAs('owner');
  assert.equal(pushed.status, 200);
  assert.deepEqual(
    { pushed: pushed.body.pushed, matched: pushed.body.matched, capped: pushed.body.capped, maxRows: pushed.body.maxRows },
    { pushed: 3, matched: 5, capped: true, maxRows: 3 }
  );
  const temp = h.google.tab(h.sheets.owner, TEMP);
  assert.deepEqual([2, 3, 4].map((row) => temp.rows[row].C), ['Company 5', 'Company 4', 'Company 3']);
  assert.equal(temp.rows[5], undefined);

  // The list says what the cap is, so the page's confirm can say so before a push.
  assert.equal((await h.call('owner', 'GET', '/admin/job-lake')).body.pushMaxRows, 3);

  // Exactly at the cap is not capped.
  const exact = await h.pushAs('owner', { updatedFrom: new Date(now - 7.5 * DAY).toISOString() });
  assert.deepEqual([exact.body.pushed, exact.body.matched, exact.body.capped], [3, 3, false]);

  // The repository's read: the cap plus one, newest first, the count beside it.
  const read = lake.listLakeForPush({}, 2);
  assert.deepEqual([read.rows.map((row) => row.company), read.matched, read.capped], [['Company 5', 'Company 4'], 5, true]);
  assert.equal(read.rows[0].jobDescription, posting(5), 'each row with its description');
  assert.deepEqual(lake.listLakeForPush({ company: '!!!' }, 2), { rows: [], matched: 0, capped: false });
});

test('the rows go in writes of at most 200 rows and about 1.5 MB, the grid grown first, a long description cut with the marker', async (t) => {
  const h = await serve('chunks');
  t.after(() => h.close());
  const now = Date.now();
  // 230 small jobs, and 30 whose descriptions run past Google's 50,000 characters.
  for (let n = 1; n <= 230; n += 1) lakeJob(n, `Small ${n}`, now - (500 - n) * 60_000);
  const long = (n) => `${posting(1000 + n)} ${'x'.repeat(60_000)}`;
  for (let n = 1; n <= 30; n += 1) lakeJob(1000 + n, `Long ${n}`, now - (30 - n) * 60_000, {}, { jobDescription: long(n) });
  const temp = h.google.tab(h.sheets.owner, TEMP);
  temp.rowCount = 100;

  const pushed = await h.pushAs('owner');
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.equal(pushed.body.pushed, 260);
  const [update] = h.google.calls.updates;
  assert.deepEqual(update.requests[0], { appendDimension: { sheetId: 9, dimension: 'ROWS', length: 161 } }, 'grown to the header and 260 rows');
  assert.equal(temp.rowCount, 261);

  const writes = h.google.calls.writes.map((call) => call.data);
  assert.ok(writes.every((data) => data.length === 1), 'one range a write');
  const sizes = writes.map(([entry]) => entry.values.length);
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), 260);
  assert.ok(sizes.every((size) => size <= push.PUSH_WRITE_MAX_ROWS), sizes.join(','));
  for (const [entry] of writes) {
    const bytes = Buffer.byteLength(JSON.stringify(entry.values), 'utf8');
    assert.ok(bytes <= push.PUSH_WRITE_MAX_BYTES + 200_000, `a write of ${bytes} bytes`);
  }
  assert.ok(writes.length >= 3, 'the thirty long rows alone take two writes');
  // Contiguous: each write starts where the last ended.
  let next = 2;
  for (const [entry] of writes) {
    const match = /!A(\d+):L(\d+)$/.exec(entry.range);
    assert.equal(Number(match[1]), next);
    next = Number(match[2]) + 1;
  }
  assert.equal(next, 262);

  const description = temp.rows[2].F;
  assert.equal(temp.rows[2].C, 'Long 30');
  assert.equal(description.length, 50_000);
  assert.ok(description.endsWith(' ...[cut at 50,000 characters]'));
  assert.ok(description.startsWith(posting(1030)));

  // The splitter on its own: a row bigger than the budget still goes, alone.
  const huge = ['x'.repeat(push.PUSH_WRITE_MAX_BYTES + 10)];
  assert.deepEqual(push.pushChunks([['a'], huge, ['b']]).map((chunk) => chunk.length), [1, 1, 1]);
  assert.deepEqual(push.pushChunks(Array.from({ length: 401 }, () => ['a'])).map((chunk) => chunk.length), [200, 200, 1]);
  assert.equal(push.descriptionCell('short'), 'short');
});

test('rows pushed into Temp For AI are trusted by a build from it: sheet first, no analysis call, nothing written back', async (t) => {
  const h = await serve('trusted');
  t.after(() => h.close());
  const now = Date.now();
  for (let n = 1; n <= 3; n += 1) lakeJob(n, `Company ${n}`, now - n * DAY);
  assert.equal((await h.pushAs('owner')).status, 200);
  const temp = h.google.tab(h.sheets.owner, TEMP);
  const writesBefore = h.google.calls.writes.length;

  const jobs = [2, 3, 4].map((row) => ({
    companyName: temp.rows[row].C,
    role: temp.rows[row].D,
    jobLink: temp.rows[row].E,
    jobDescription: temp.rows[row].F,
    sourceRowNumber: row,
  }));
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  let response;
  try {
    response = await h.post('/generation/batches', {
      mode: 'order',
      format: 'pdf',
      includeCoverLetterDocx: false,
      profileIds: ['p-claude'],
      sheet: { tabName: TEMP },
      jobs,
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await untilFinished(response.body.batchId);
  } finally {
    console.log = realLog;
  }
  assert.ok(
    lines.some((line) => line.includes(`Sheet run on "${TEMP}": 3 job(s) analysed in the sheet, 0 from the store, 0 to analyse`)),
    lines.filter((line) => line.includes('Sheet run')).join('\n')
  );
  assert.equal(h.seats.analyses().length, 0, 'no model was asked to analyse anything');
  assert.equal(h.seats.tailorings().length, 3);
  assert.ok(h.google.calls.reads.some((call) => call.id === h.sheets.owner && call.ranges.some((range) => range.includes(`'${TEMP}'!G2:L4`))));
  await columns.flushAnalysisWriteBacks();
  assert.equal(h.google.calls.writes.length, writesBefore, 'the cells already hold their analyses');
});

test('one push per administrator at a time: a second is refused while the first runs, another administrator is not', async (t) => {
  const h = await serve('concurrent');
  t.after(() => h.close());
  lakeJob(1, 'Acme', Date.now() - DAY);
  let release;
  h.google.hold.update = new Promise((resolve) => {
    release = resolve;
  });
  const first = h.pushAs('owner');
  while (h.google.calls.updates.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await h.pushAs('owner');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'push-in-progress');
  assert.equal(second.body.error, 'A push to your Temp For AI tab is already going. Wait for it to finish first.');
  // Another administrator's push, into their own sheet, is not held up by it.
  const other = h.pushAs('second');
  release();
  h.google.hold.update = null;
  assert.equal((await first).status, 200);
  const theirs = await other;
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.tabUrl, `https://docs.google.com/spreadsheets/d/${h.sheets.second}/edit#gid=9`);
  // And once it ended, the next one goes.
  assert.equal((await h.pushAs('owner')).status, 200);
});

test('a Temp For AI that is not a job tab is refused before anything is written, and so is the name held by a tab of the person\'s own', async (t) => {
  const h = await serve('not-job');
  t.after(() => h.close());
  lakeJob(1, 'Acme', Date.now() - DAY);
  const temp = h.google.tab(h.sheets.owner, TEMP);
  temp.header = ['My notes', 'Applied?'];
  temp.rows[2] = { A: 'mine' };

  const refused = await h.pushAs('owner');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'not-job-tab');
  assert.equal(refused.body.error, push.tempTabNotJobTabSentence());
  assert.match(refused.body.error, /^"Temp For AI" in your job sheet is not laid out as a job tab any more/);
  assert.equal(h.google.calls.verify.length, 0, 'not even verified');
  assert.equal(h.google.calls.updates.length, 0);
  assert.equal(h.google.calls.writes.length, 0);
  assert.deepEqual(temp.rows[2], { A: 'mine' });

  // The name clash: the account's Temp For AI is a tab of the person's own.
  const clash = await serve('clash', { clash: true });
  t.after(() => clash.close());
  lakeJob(2, 'Globex', Date.now() - DAY);
  const clashed = await clash.pushAs('owner');
  assert.equal(clashed.status, 409);
  assert.equal(clashed.body.code, 'tab-name-clash');
  assert.equal(
    clashed.body.error,
    'Your job sheet already has a tab named "Temp For AI" that is not laid out as a job tab, so it was left exactly ' +
      'as it is. Rename or delete it in Google Sheets, then push again.'
  );
  assert.equal(clash.google.calls.inspect.length, 0, 'Temp For AI is not even read');
  assert.equal(clash.google.calls.writes.length, 0);
});

test('only administrators push: a user and a reporter are refused, and nothing is read', async (t) => {
  const h = await serve('access');
  t.after(() => h.close());
  lakeJob(1, 'Acme', Date.now() - DAY);
  const user = await h.pushAs('user');
  assert.equal(user.status, 403);
  assert.equal(user.body.code, 'not-an-admin');
  const reporter = await h.pushAs('reporter');
  assert.equal(reporter.status, 403);
  assert.equal(h.google.calls.inspect.length, 0);
});

test("the push's read is newest first off the updated_at index, with no sort of the lake", async (t) => {
  const h = await serve('plan');
  t.after(() => h.close());
  for (let n = 1; n <= 30; n += 1) lakeJob(n, `Company ${n}`, Date.now() - n * 60_000);
  const { getDb } = require('../dist/database/sqlite');
  getDb().exec('ANALYZE');
  const plan = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${lake.PUSH_DEFAULT_SQL}`)
    .all(1001)
    .map((row) => row.detail)
    .join(' | ');
  assert.match(plan, /SCAN job_lake USING INDEX idx_job_lake_updated/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * The job routes that read and write the account's own sheet in the new
 * layout (owner decisions S1-S3), over HTTP against a sheet held in memory:
 *
 *  - the export appends A:F - Date as a real date, NO(DATE) continuing the
 *    day's numbers, the posting - RAW, after one read of A:E, with the rows'
 *    layout (21 px, clipped) sent first; never G:L; a row typed meanwhile is
 *    stepped over, never written over; a tab that is not a job tab is
 *    refused before anything is scraped;
 *  - the Job Filter reads C:E, judges every row, answers each to the page and
 *    writes NOTHING into the sheet;
 *  - the range importer reads and writes only the administrator's own sheet,
 *    and refuses a write into G:L of a job tab, or into any column under a
 *    protection of the program's whatever row 1 says (409 `protected-columns`).
 */

const HEADERS = require('../dist/integrations/googleSheets').JOB_SHEET_HEADERS;
const OLD_DAILY = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder'];
const letter = (n) => String.fromCharCode(64 + n);
const number = (l) => l.charCodeAt(0) - 64;

/** One spreadsheet in memory: tabs by title, each with row 1, rows by number and letter, and a grid size. */
function fakeBook() {
  const tabs = new Map();
  const calls = { reads: [], writes: [], updates: [], inspected: [] };
  const hooks = { afterRead: null };
  const tab = (title) => {
    if (!tabs.has(title)) tabs.set(title, { header: [...HEADERS], rows: {}, rowCount: 1000, gid: tabs.size + 10 });
    return tabs.get(title);
  };
  const cell = (t, row, col) => {
    if (row === 1) return t.header[col - 1] ?? '';
    return t.rows[row]?.[letter(col)] ?? '';
  };
  /** A range as Google answers it: trailing empty rows and cells left out. */
  const read = (range) => {
    let match = /^'((?:[^']|'')*)'!([A-Z]+):([A-Z]+)$/.exec(range);
    let title;
    let fromCol;
    let toCol;
    let fromRow = 1;
    let toRow;
    if (match) {
      [, title, fromCol, toCol] = match;
      title = title.replace(/''/g, "'");
      const t = tab(title);
      toRow = Math.max(1, ...Object.keys(t.rows).map(Number));
    } else {
      match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
      assert.ok(match, `a range the fake understands: ${range}`);
      title = match[1].replace(/''/g, "'");
      [fromCol, fromRow, toCol, toRow] = [match[2], Number(match[3]), match[4], Number(match[5])];
    }
    const t = tab(title);
    const grid = [];
    for (let row = fromRow; row <= toRow; row += 1) {
      const values = [];
      for (let col = number(fromCol); col <= number(toCol); col += 1) values.push(String(cell(t, row, col)));
      while (values.length && values.at(-1) === '') values.pop();
      grid.push(values);
    }
    while (grid.length && grid.at(-1).length === 0) grid.pop();
    return grid;
  };
  return {
    tabs,
    tab,
    calls,
    hooks,
    inspect(title) {
      calls.inspected.push(title);
      if (!tabs.has(title)) {
        const { GoogleSheetsRequestError } = require('../dist/integrations/googleSheets');
        throw new GoogleSheetsRequestError(400, `Tab "${title}" was not found in the spreadsheet.`);
      }
      const t = tab(title);
      return {
        gid: t.gid,
        title,
        columnCount: 12,
        rowCount: t.rowCount,
        headerRow: [...t.header],
        protectedRanges: structuredClone(t.protectedRanges ?? []),
        spreadsheetTitle: 'Free Tailor - x',
      };
    },
    /** A values write as the range importer makes it, row 1 included: as the server's identity, through any protection. */
    writeRange({ tabName, fromRow, fromCol, values }) {
      const t = tab(tabName);
      values.forEach((cells, rowOffset) => {
        const row = Number(fromRow) + rowOffset;
        cells.forEach((value, colOffset) => {
          const col = Number(fromCol) + colOffset;
          if (row === 1) t.header[col - 1] = value;
          else (t.rows[row] ??= {})[letter(col)] = value;
        });
      });
    },
    batchGet(ranges) {
      calls.reads.push(ranges);
      const grids = ranges.map(read);
      const hook = hooks.afterRead;
      hooks.afterRead = null;
      if (hook) hook();
      return grids;
    },
    writeRaw(data) {
      calls.writes.push(data);
      for (const { range, values } of data) {
        const match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
        const t = tab(match[1].replace(/''/g, "'"));
        const fromRow = Number(match[3]);
        assert.ok(fromRow + values.length - 1 <= t.rowCount, `a write past the grid is refused by Google: ${range}`);
        values.forEach((cells, offset) => {
          const row = (t.rows[fromRow + offset] ??= {});
          cells.forEach((value, col) => {
            if (value !== null) row[letter(number(match[2]) + col)] = value;
          });
        });
      }
    },
    batchUpdate(requests) {
      calls.updates.push(requests);
      for (const request of requests) {
        if (request.appendDimension?.dimension === 'ROWS') {
          const t = [...tabs.values()].find((entry) => entry.gid === request.appendDimension.sheetId);
          t.rowCount += request.appendDimension.length;
        }
      }
    },
  };
}

async function serve(name, options = {}) {
  useTempStorage(`job-sheet-routes-${name}`);
  useAdminEmails('admin@example.com');
  const express = require('express');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/config/aiModelConfig');
  const accountSheet = loadFresh('../dist/services/sheets/accountSheet');
  loadFresh('../dist/services/sheets/jobSheetTarget');
  const book = fakeBook();
  book.tab('All');
  book.tab('Temp For AI');
  let minted = 0;
  accountSheet.setSheetsClientForTests({
    async isConfigured() {
      return true;
    },
    async checkCredential() {},
    async createSpreadsheet() {
      minted += 1;
      return { spreadsheetId: `sheet-${minted}`, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/sheet-${minted}/edit`, firstTabGid: 10 };
    },
    async formatJobSheetTab() {},
    async addSheetTabWithHeaders(_id, title) {
      return { gid: book.tab(title).gid, created: false, jobTab: true };
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
      return [...book.tabs.entries()].map(([title, t]) => ({ title, gid: t.gid }));
    },
    async readRanges(_id, ranges) {
      return ranges.map(() => [[...HEADERS]]);
    },
  });

  // Google, behind the integration's own exports, which the routes call through.
  const googleSheets = require('../dist/integrations/googleSheets');
  const swaps = [];
  const swap = (module, key, fake) => {
    swaps.push([module, key, module[key]]);
    module[key] = fake;
  };
  const own = new Set();
  const guard = (id) => assert.ok(own.has(id), `Google was asked about ${id}, which is nobody's own sheet here`);
  swap(googleSheets, 'inspectJobSheetTab', async (id, title) => {
    guard(id);
    return book.inspect(title);
  });
  swap(googleSheets, 'verifyJobSheetTab', async (id, title, known) => {
    guard(id);
    const inspection = known ?? book.inspect(title);
    return { gid: inspection.gid, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: googleSheets.isJobSheetTab(inspection) };
  });
  swap(googleSheets, 'batchGetValues', async (id, ranges) => {
    guard(id);
    return book.batchGet(ranges);
  });
  swap(googleSheets, 'batchUpdateValuesRaw', async (id, data) => {
    guard(id);
    book.writeRaw(data);
  });
  swap(googleSheets, 'batchUpdateSpreadsheet', async (id, requests) => {
    guard(id);
    book.batchUpdate(requests);
  });
  const ranges = { fetched: [], updated: [] };
  swap(googleSheets, 'fetchGoogleSheetsRange', async (input) => {
    guard(input.sheetId);
    ranges.fetched.push(input);
    return { spreadsheetId: input.sheetId, spreadsheetTitle: 'x', tabs: [] };
  });
  swap(googleSheets, 'updateGoogleSheetsRange', async (input) => {
    guard(input.sheetId);
    ranges.updated.push(input);
    book.writeRange(input);
    return { spreadsheetId: input.sheetId, updatedRange: 'x' };
  });
  let scraped = 0;
  swap(require('../dist/services/scraperProviders'), 'resolveScraperProvider', () => ({
    id: 'stub',
    label: 'Stub',
    async run() {
      scraped += 1;
      return options.jobs ?? [];
    },
  }));
  swap(require('../dist/services/jobPageContent'), 'extractJobPageContent', async () => {
    throw new Error('no page is fetched in these tests');
  });

  const { attachUser } = loadFresh('../dist/middleware/auth');
  const jobs = loadFresh('../dist/routes/jobs');
  const admin = loadFresh('../dist/routes/admin');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/jobs', jobs.default);
  app.use('/api/admin', admin.default);
  const server = app.listen(0);
  const port = server.address().port;

  const boss = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(boss.id), alice: users.createSession(alice.id) };
  const sheetOf = async (account) => {
    const id = (await accountSheet.ensureAccountSheet(users.getUserById(account.id))).spreadsheetId;
    own.add(id);
    return id;
  };
  const sheets = { admin: await sheetOf(boss), alice: await sheetOf(alice) };
  return {
    book,
    ranges,
    sheets,
    accountSheet,
    scraped: () => scraped,
    call: async (who, method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    close() {
      server.close();
      for (const [module, key, original] of swaps.reverse()) module[key] = original;
    },
  };
}

const job = (company, n) => ({
  company,
  title: `Engineer ${n}`,
  apply_url: `https://jobs.example.com/${n}`,
  description: `The posting for job ${n}.`,
  raw: {},
});

test('the export appends A:F after the last used row: a real date, the day\'s numbers continued, RAW, laid out first', async (t) => {
  const h = await serve('export', { jobs: [job('Acme', 1), job('Existing Co', 2), job('Beta', 3)] });
  t.after(() => h.close());
  const today = h.accountSheet.sheetDateText();
  const serial = h.accountSheet.sheetDateSerial(today);
  // Rows as Google reads them back: today's two numbered 1 and 4, yesterday's 9.
  Object.assign(h.book.tab('All').rows, {
    2: { A: today, B: '1', C: 'Existing Co', D: 'Engineer', E: 'https://x.example/1', F: 'text' },
    3: { A: '01/02/2020', B: '9', C: 'Old Co', D: 'Engineer', E: 'https://x.example/2', F: 'text' },
    4: { A: String(serial), B: '4', C: 'Gamma', D: 'Engineer', E: 'https://x.example/3', F: 'text' },
  });

  const response = await h.call('alice', 'POST', '/jobs/scrapers/export', {
    source: 'indeed',
    startUrl: 'https://www.indeed.com/jobs?q=engineer',
    // A stale page's column choices: not read.
    companyNameCol: 'D',
    jobLinkCol: 'F',
    startRow: 2,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const exported = response.body.export;
  assert.equal(exported.selectedTab, 'All');
  assert.equal(exported.date, today);
  assert.deepEqual([exported.rowsWritten, exported.startRow, exported.endRow, exported.firstNo, exported.lastNo], [2, 5, 6, 5, 6]);
  assert.equal(exported.skippedCompanyDuplicates, 1, 'Existing Co is in the tab already');
  assert.deepEqual(exported.updatedRanges, ["'All'!A5:F6"]);
  assert.match(exported.tabUrl, /#gid=\d+$/);

  const rows = h.book.tab('All').rows;
  assert.deepEqual(rows[5], { A: serial, B: 5, C: 'Acme', D: 'Engineer 1', E: 'https://jobs.example.com/1', F: 'The posting for job 1.' });
  assert.deepEqual(rows[6].B, 6);
  assert.equal(typeof rows[5].A, 'number', 'a real date: the serial number, shown by the column format');
  for (const row of [5, 6]) {
    assert.deepEqual(Object.keys(rows[row]).sort(), ['A', 'B', 'C', 'D', 'E', 'F'], 'never G to L');
  }

  // ONE read of A:E for the place, the duplicates and the numbering; then the
  // rows about to be written read again before the write.
  assert.deepEqual(h.book.calls.reads[0], ["'All'!A:E"]);
  assert.deepEqual(h.book.calls.reads[1], ["'All'!A5:F6"]);
  // The layout went before the values: 21 px, clipped, the Date column a date, rows 5-6 only.
  const [layout] = h.book.calls.updates;
  assert.deepEqual(layout[0].updateDimensionProperties.range, { sheetId: h.book.tab('All').gid, dimension: 'ROWS', startIndex: 4, endIndex: 6 });
  assert.equal(layout[0].updateDimensionProperties.properties.pixelSize, 21);
  assert.equal(layout[1].repeatCell.cell.userEnteredFormat.wrapStrategy, 'CLIP');
  assert.deepEqual(layout[2].repeatCell.cell.userEnteredFormat.numberFormat, { type: 'DATE', pattern: 'mm/dd/yyyy' });

  // A second export the same day: the numbers go on from 6.
  const next = await serveAgain(h, [job('Delta', 4)]);
  assert.deepEqual([next.startRow, next.firstNo], [7, 7]);
});

/** Another export on the same server, with other results. */
async function serveAgain(h, results) {
  const scraperProviders = require('../dist/services/scraperProviders');
  const current = scraperProviders.resolveScraperProvider;
  scraperProviders.resolveScraperProvider = () => ({ id: 'stub', label: 'Stub', run: async () => results });
  try {
    const response = await h.call('alice', 'POST', '/jobs/scrapers/export', { source: 'indeed', startUrl: 'https://www.indeed.com/jobs?q=x' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.export;
  } finally {
    scraperProviders.resolveScraperProvider = current;
  }
}

test('a row typed after the read is stepped over, never written over; the grid grows to hold what is written', async (t) => {
  const h = await serve('export-moved', { jobs: [job('Acme', 1), job('Beta', 2)] });
  t.after(() => h.close());
  const all = h.book.tab('All');
  all.rowCount = 4;
  all.rows[2] = { A: '01/02/2020', B: '1', C: 'Old Co' };
  // Right after the A:E read, somebody types into row 3, the first free one - in F only.
  h.book.hooks.afterRead = () => {
    all.rows[3] = { F: 'a note somebody typed' };
  };
  const response = await h.call('alice', 'POST', '/jobs/scrapers/export', { source: 'indeed', startUrl: 'https://www.indeed.com/jobs?q=x' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual([response.body.export.startRow, response.body.export.endRow, response.body.export.firstNo], [4, 5, 1]);
  assert.deepEqual(all.rows[3], { F: 'a note somebody typed' }, 'not written over');
  assert.equal(all.rows[4].C, 'Acme');
  const grown = h.book.calls.updates.flat().find((request) => request.appendDimension);
  assert.deepEqual(grown.appendDimension, { sheetId: all.gid, dimension: 'ROWS', length: 1 }, 'grown by the one row past the grid');
});

test('the export and the filter refuse a tab that is not a job tab - an older build\'s daily tab - before anything else', async (t) => {
  const h = await serve('not-job-tab', { jobs: [job('Acme', 1)] });
  t.after(() => h.close());
  const daily = h.book.tab('10/05/2026');
  daily.header = [...OLD_DAILY];
  daily.rows[2] = { B: 'Acme', D: 'https://x.example/1' };

  const exported = await h.call('alice', 'POST', '/jobs/scrapers/export', {
    source: 'indeed',
    startUrl: 'https://www.indeed.com/jobs?q=x',
    tabName: '10/05/2026',
  });
  assert.equal(exported.status, 409);
  assert.equal(exported.body.code, 'not-job-tab');
  assert.match(exported.body.error, /"10\/05\/2026" is not laid out as a job sheet tab, so it cannot be exported into/);
  assert.equal(h.scraped(), 0, 'nothing scraped for a tab it would not write');

  const filtered = await h.call('alice', 'POST', '/jobs/filter-google-sheet', { tabName: '10/05/2026' });
  assert.equal(filtered.status, 409);
  assert.equal(filtered.body.code, 'not-job-tab');
  assert.deepEqual(h.book.calls.writes, []);
  assert.deepEqual(h.book.calls.updates, []);
  assert.deepEqual(h.book.calls.reads, [], 'not even read');
});

test('the Job Filter reads C:E of All, answers every row to the page, and writes nothing into the sheet', async (t) => {
  const h = await serve('filter');
  t.after(() => h.close());
  const { storeJobAnalysis } = require('./helpers');
  const { analysisAnswer } = require('./analysisHarness');
  storeJobAnalysis(JSON.parse(analysisAnswer()), { jobDescription: 'A stored posting, remote, senior.', jobLink: 'https://jobs.example.com/stored' });
  Object.assign(h.book.tab('All').rows, {
    2: { C: 'Stored Co', D: 'Engineer', E: 'https://jobs.example.com/stored' },
    3: { C: 'No Link Co', D: 'Engineer' },
    5: { C: 'Fetch Co', D: 'Engineer', E: 'https://jobs.example.com/fetch' },
  });
  const response = await h.call('alice', 'POST', '/jobs/filter-google-sheet', {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;
  assert.equal(body.selectedTab, 'All');
  assert.deepEqual([body.startRow, body.endRow, body.scannedRows], [2, 5, 4]);
  assert.deepEqual(
    body.rows.map((row) => [row.row, row.company, row.result, row.reused, Boolean(row.error)]),
    [
      [2, 'Stored Co', 'Pass', true, false],
      [3, 'No Link Co', null, false, false],
      [5, 'Fetch Co', null, false, true],
    ]
  );
  assert.match(body.rows[1].reason, /no job link/);
  assert.match(body.rows[2].error, /Could not open the job page.*\(Ref: ERR-[0-9A-F]{6}\)/);
  assert.deepEqual([body.processedRows, body.skippedRows, body.reusedAnalyses, body.errorRows], [1, 2, 1, 1]);
  assert.equal('resultCol' in body || 'updatedRanges' in body, false, 'no columns written, none named');
  assert.deepEqual(h.book.calls.reads, [["'All'!C:E"]], 'one read of C:E');
  assert.deepEqual(h.book.calls.writes, [], 'no verdict, no analysis cell: nothing written');
  assert.deepEqual(h.book.calls.updates, []);
});

test('the range importer: the administrator\'s own sheet only, and never G to L of a job tab', async (t) => {
  const h = await serve('range');
  t.after(() => h.close());
  const notes = h.book.tab('Notes');
  notes.header = ['Idea', 'Link'];
  const put = (body) => h.call('admin', 'PUT', '/admin/google-sheets/range', { tabName: 'All', fromRow: 2, toRow: 2, values: [['x']], ...body });

  const refused = await put({ fromCol: 6, toCol: 7, values: [['x', 'y']] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'protected-columns');
  assert.match(refused.body.error, /Columns G to L of a job tab are written by the app only/);
  assert.equal((await put({ fromCol: 12, toCol: 12 })).status, 409, 'the Analysis cell above all');
  assert.deepEqual(h.ranges.updated, [], 'nothing written');

  assert.equal((await put({ fromCol: 1, toCol: 6, values: [['a', 'b', 'c', 'd', 'e', 'f']] })).status, 200, 'A to F are the person\'s');
  assert.equal((await put({ fromCol: 13, toCol: 13 })).status, 200, 'past L is the person\'s too');
  assert.equal((await put({ tabName: 'Notes', fromCol: 7, toCol: 12, values: [['1', '2', '3', '4', '5', '6']] })).status, 200, 'a tab that is not a job tab has no protected columns');
  assert.deepEqual(h.ranges.updated.map((input) => input.sheetId), [h.sheets.admin, h.sheets.admin, h.sheets.admin], 'always their own sheet');

  // Somebody else's sheet, or a saved shared one, is not found - for reads and writes alike.
  for (const sheetId of [h.sheets.alice, 'saved-shared-sheet']) {
    assert.equal((await put({ sheetId, fromCol: 1, toCol: 1 })).status, 404);
    assert.equal((await h.call('admin', 'POST', '/admin/google-sheets/range', { sheetId })).status, 404);
  }
  const read = await h.call('admin', 'POST', '/admin/google-sheets/range', {});
  assert.equal(read.status, 200);
  assert.deepEqual(h.ranges.fetched.map((input) => input.sheetId), [h.sheets.admin]);
});

test('the range importer decides on the protection, not on row 1: A1 changed and changed back cannot smuggle an Analysis cell in', async (t) => {
  const h = await serve('range-flip');
  t.after(() => h.close());
  const googleSheets = require('../dist/integrations/googleSheets');
  const ours = (gid, startColumnIndex, endColumnIndex) => ({
    protectedRangeId: gid + 1000,
    description: googleSheets.ANALYSIS_PROTECTION_DESCRIPTION,
    warningOnly: false,
    range: { sheetId: gid, startColumnIndex, endColumnIndex },
    editors: { users: ['server@example.com'] },
  });
  const all = h.book.tab('All');
  all.protectedRanges = [ours(all.gid, 6, 12)];
  const put = (body) => h.call('admin', 'PUT', '/admin/google-sheets/range', { tabName: 'All', fromRow: 2, toRow: 2, ...body });
  const forgedCell = JSON.stringify({ v: 1, id: 'f0f0f0f0-1111-2222-3333-444455556666', analysis: { jobMeta: { title: 'FORGED' } } });

  // Row 1 is the person's, so A1 may change - and with it, All is no longer a job tab...
  assert.equal((await put({ fromRow: 1, toRow: 1, fromCol: 1, toCol: 1, values: [['Day']] })).status, 200);
  assert.equal(googleSheets.isJobSheetTab(h.book.inspect('All')), false, 'row 1 alone says "not a job tab"');
  // ...but the protection over G:L never moved, and a verify would find it intact and trust what is under it.
  const forged = await put({ fromRow: 10, toRow: 10, fromCol: 12, toCol: 12, values: [[forgedCell]] });
  assert.equal(forged.status, 409, JSON.stringify(forged.body));
  assert.equal(forged.body.code, 'protected-columns');
  assert.match(forged.body.error, /Columns G to L of a job tab are written by the app only/);
  assert.equal((await put({ fromCol: 5, toCol: 8, values: [['a', 'b', 'c', 'd']] })).status, 409, 'a span that only reaches into G');
  assert.equal(all.rows[10], undefined, 'no forged Analysis cell');
  assert.equal((await put({ fromRow: 1, toRow: 1, fromCol: 1, toCol: 1, values: [['Date']] })).status, 200);
  assert.ok(googleSheets.isJobSheetTab(h.book.inspect('All')));
  assert.ok(!h.ranges.updated.some((input) => Number(input.toCol) >= 7), 'nothing written past F');

  // A protection Google read back without its sheetId is the tab's own - it leaves a gid of 0 out.
  all.header[0] = 'Day';
  all.protectedRanges = [{ ...ours(all.gid, 6, 12), description: undefined, range: { startColumnIndex: 6, endColumnIndex: 12 } }];
  assert.equal((await put({ fromCol: 12, toCol: 12, values: [[forgedCell]] })).status, 409);
  all.header[0] = 'Date';

  // An older build's daily tab keeps its own K:P protection: refused there too, by its own letters.
  const daily = h.book.tab('10/05/2026');
  daily.header = [...OLD_DAILY];
  daily.protectedRanges = [ours(daily.gid, 10, 16)];
  const old = await put({ tabName: '10/05/2026', fromCol: 16, toCol: 16, values: [['{"v":1}']] });
  assert.equal(old.status, 409);
  assert.equal(old.body.code, 'protected-columns');
  assert.match(old.body.error, /^Columns K to P of "10\/05\/2026" are the app's protected analysis columns/);
  // Somebody's own protection is theirs, and G to J of the daily tab are not under ours.
  daily.protectedRanges.push({ protectedRangeId: 7, description: 'mine', range: { sheetId: daily.gid, startColumnIndex: 6, endColumnIndex: 8 } });
  assert.equal((await put({ tabName: '10/05/2026', fromCol: 7, toCol: 10, values: [['a', 'b', 'c', 'd']] })).status, 200);
  assert.deepEqual(daily.rows[2], { G: 'a', H: 'b', I: 'c', J: 'd' });
});

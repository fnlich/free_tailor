/*
 * A stand-in for Google Sheets, for report-run.js: every account's job sheet
 * exists, has three tabs, and its rows are held in memory - and the admin
 * sheet the lake copies every added job to is a list in memory too.
 *
 * Loaded with `node --require` before the app, after stub-seat.js (which
 * answers every analysis as a Backend posting). Four seams, the ones the unit
 * tests use (test/jobLakeReport.test.js):
 *
 *   - the account sheet's client (`setSheetsClientForTests`): allocation and
 *     the tab list behind GET /api/report/tabs;
 *   - the reporter run's client (`setReportSheetsClientForTests`): the tab
 *     inspection that refuses a tab that is not a job tab, the verify, the
 *     one read of B:E and K:P, the Lake Status write and the red paint;
 *   - the analysis columns' client (`setAnalysisSheetsClientForTests`): the
 *     sheet-first read of a run's analysis cells and the write-back;
 *   - the admin sheet's client (`setAdminLakeSheetClientForTests`).
 *
 * The first three read and write the SAME rows, so the statuses a run writes
 * are what the next preview of those rows reads - the way the page proves the
 * sheet was written. The run, the lake, its rewards and its rules are the
 * shipping code.
 *
 * Today's tab, row by row (B Company, C Job Title, D Job Link, E Job
 * Description; O is Lake Status):
 *
 *   2  Acme Corp    a posting           -> Added
 *   3  ACME, Inc.   another posting     -> Duplicate: the same company in the
 *                                          same field, once normalised - red
 *   4  Globex LLC   a third posting     -> Added
 *   5  Initech      O = "Added" already, beside the Analysis cell an earlier
 *                   run wrote for its posting -> reported before, not taken
 *   6  (no company) a posting           -> Skipped
 *   7  Umbrella     no description, and a `javascript:` link that must never
 *                   become an anchor   -> Skipped
 *
 * "My notes" is a tab of the reporter's own (its header is not the job
 * sheet's), which the preview and the run refuse before touching it.
 */

const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const accountSheet = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));
const analysisColumns = require(path.join(DIST, 'services', 'sheets', 'analysisColumns'));
const reportSheet = require(path.join(DIST, 'services', 'jobLake', 'reportSheet'));
const adminSheet = require(path.join(DIST, 'services', 'jobLake', 'adminSheet'));
const { JOB_SHEET_HEADERS } = require(path.join(DIST, 'integrations', 'googleSheets'));
const { postingKeysOf } = require(path.join(DIST, 'services', 'jobAnalysis', 'identity'));

const OLDER_TAB = '09/30/2026';
const NOTES_TAB = 'My notes';

const posting = (what) =>
  `${what}: a senior backend engineer to build TypeScript services on Node.js for a SaaS platform, owning APIs end to end.`;

/**
 * The Analysis cell an earlier run wrote for a posting: a run skips a row as
 * reported only when its Lake Status sits beside its own posting's cell. It
 * names a stored row this fresh database lacks, so the posting keys it
 * records are what tie it to the row.
 */
const analysisCell = (jd, link) =>
  JSON.stringify({
    v: 1,
    id: '00000000-0000-4000-8000-000000000004',
    posting: postingKeysOf({ jd, link }),
    jobField: 'backend',
    analysis: { jobMeta: { title: 'Engineer', seniority: 'senior', industry: '', department: '' }, jobField: 'backend' },
  });

/** Each tab's rows from row 2 (row 1 is the header), columns A..P, kept and written to in memory. */
const sheet = new Map();
function rowsFor(tab) {
  if (!sheet.has(tab)) {
    if (tab === accountSheet.todaySheetTitle()) {
      const blank = (count) => Array.from({ length: count }, () => '');
      sheet.set(tab, [
        ['1', 'Acme Corp', 'Backend Engineer', 'https://acme.example/jobs/1', posting('Acme one')],
        ['2', 'ACME, Inc.', 'Platform Engineer', 'https://acme.example/jobs/2', posting('Acme two')],
        ['3', 'Globex LLC', 'API Engineer', 'https://globex.example/careers/7', posting('Globex')],
        [
          '4',
          'Initech',
          'Engineer',
          'https://initech.example/jobs/4',
          posting('Initech'),
          ...blank(9),
          'Added',
          analysisCell(posting('Initech'), 'https://initech.example/jobs/4'),
        ],
        ['5', '', 'Engineer with no company', '', posting('Nameless')],
        ['6', 'Umbrella', 'Engineer', 'javascript:alert(1)', ''],
      ]);
    } else if (tab === OLDER_TAB) {
      sheet.set(tab, [['1', 'Older Co', 'Engineer', 'https://older.example/jobs/1', posting('Older')]]);
    } else {
      sheet.set(tab, []);
    }
  }
  return sheet.get(tab);
}

const tabs = () => [
  { title: OLDER_TAB, gid: 1 },
  { title: accountSheet.todaySheetTitle(), gid: 2 },
  { title: NOTES_TAB, gid: 3 },
];
const gidOf = (tab) => tabs().find((entry) => entry.title === tab)?.gid ?? 0;

const cellAt = (tab, row, col) => String(rowsFor(tab)[row - 2]?.[col - 1] ?? '');

/** `'Tab'!B2:E11` as its parts. Single-letter columns are all this sheet has. */
function parseRange(range) {
  const match = /^'((?:[^']|'')*)'!([A-Z])(\d+):([A-Z])(\d+)$/.exec(range);
  if (!match) throw new Error(`[e2e stub] cannot read the range ${range}`);
  return {
    tab: match[1].replace(/''/g, "'"),
    fromCol: match[2].charCodeAt(0) - 64,
    fromRow: Number(match[3]),
    toCol: match[4].charCodeAt(0) - 64,
    toRow: Number(match[5]),
  };
}

const header = (tab) => (tab === NOTES_TAB ? ['Idea', 'Where I saw it'] : [...JOB_SHEET_HEADERS]);

const client = {
  async inspectTab(_spreadsheetId, tabName) {
    return { gid: gidOf(tabName), title: tabName, columnCount: 16, rowCount: 1000, headerRow: header(tabName), protectedRanges: [] };
  },
  // The protection is reported intact, so a filled Analysis cell is trusted -
  // the trust rule itself is the shipping code's.
  async verifyTab(_spreadsheetId, tabName) {
    return { gid: gidOf(tabName), protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: tabName !== NOTES_TAB };
  },
  async readRanges(_spreadsheetId, ranges) {
    return ranges.map((range) => {
      const { tab, fromRow, toRow, fromCol, toCol } = parseRange(range);
      const values = [];
      for (let row = fromRow; row <= toRow; row += 1) {
        const cells = [];
        for (let col = fromCol; col <= toCol; col += 1) cells.push(cellAt(tab, row, col));
        values.push(cells);
      }
      return values;
    });
  },
  async writeRaw(_spreadsheetId, data) {
    for (const { range, values } of data) {
      const { tab, fromRow, fromCol } = parseRange(range);
      const rows = rowsFor(tab);
      values.forEach((cells, rowOffset) => {
        const row = (rows[fromRow - 2 + rowOffset] ??= []);
        // A null leaves the cell alone, as Google's RAW write does.
        cells.forEach((value, colOffset) => {
          if (value !== null) row[fromCol - 1 + colOffset] = String(value);
        });
      });
      console.log(`[e2e stub] wrote ${range}`);
    }
  },
  async batchUpdate(_spreadsheetId, requests) {
    for (const request of requests) {
      const range = request.repeatCell?.range;
      if (range) console.log(`[e2e stub] painted row ${range.startRowIndex + 1} of tab ${range.sheetId} red`);
    }
  },
};

accountSheet.setSheetsClientForTests({
  async isConfigured() {
    return true;
  },
  async checkCredential() {},
  async createSpreadsheet() {
    return {
      spreadsheetId: 'e2e-report-sheet',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/e2e-report-sheet/edit',
      firstTabGid: 2,
    };
  },
  async formatJobSheetTab() {},
  async addSheetTabWithHeaders() {
    return { gid: 2, created: false };
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
    return tabs();
  },
});
reportSheet.setReportSheetsClientForTests(client);
analysisColumns.setAnalysisSheetsClientForTests(client);

const appended = [];
adminSheet.setAdminLakeSheetClientForTests({
  async isConfigured() {
    return true;
  },
  async createSpreadsheet() {
    return {
      spreadsheetId: 'e2e-admin-lake',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/e2e-admin-lake/edit',
      firstTabGid: 0,
    };
  },
  async writeRaw() {},
  async appendRows(_spreadsheetId, _range, rows) {
    appended.push(...rows);
    console.log(`[e2e stub] appended ${rows.length} job(s) to the admin sheet: ${rows.map((row) => row[0]).join(', ')}`);
  },
  async shareWithEmail(_spreadsheetId, email) {
    console.log(`[e2e stub] shared the admin sheet with ${email}`);
  },
});

console.log('[e2e stub] Google Sheets stubbed for Report Jobs: three tabs, canned rows, the admin sheet in memory');

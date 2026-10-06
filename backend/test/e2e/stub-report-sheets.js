/*
 * A stand-in for Google Sheets, for report-run.js: every account's job sheet
 * exists, has four tabs, and its rows are held in memory - and the admin
 * sheet the lake copies every added job to is a list in memory too.
 *
 * Loaded with `node --require` before the app, after stub-seat.js (which
 * answers every analysis as a Backend posting). Four seams, the ones the unit
 * tests use (test/jobLakeReport.test.js):
 *
 *   - the account sheet's client (`setSheetsClientForTests`): allocation, the
 *     tab list behind GET /api/report/tabs and the one batched read of every
 *     tab's row 1 its layouts come from;
 *   - the reporter run's client (`setReportSheetsClientForTests`): the tab
 *     inspection that refuses a tab that is not a job tab, the verify, the
 *     one read of C:F, and the red paint (a `repeatCell` batch after C:E is
 *     read again) - nothing is written into a row's cells but its G:L;
 *   - the analysis columns' client (`setAnalysisSheetsClientForTests`): the
 *     sheet-first read of a run's analysis cells (C:E and G:L) and the
 *     write-back of G:L;
 *   - the admin sheet's client (`setAdminLakeSheetClientForTests`).
 *
 * The first three read and write the SAME rows, so the analyses a run writes
 * back are in the rows the next preview reads. The run, the lake, its rewards
 * and its rules are the shipping code.
 *
 * The tabs, in the spreadsheet's order: All, whose rows are
 * report-sheet-rows.js's (which report-run.js reads too: two of them hold
 * postings the reporter reported before, which the script records in the
 * database before the run - the database is what says a row was reported
 * before), Temp For AI (its header only), an older build's daily tab in that
 * build's layout, and "My notes", a tab of the reporter's own (its header is
 * not the job sheet's). The last two are listed but not offered, and a run
 * on either is refused before anything is touched.
 */

const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const accountSheet = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));
const analysisColumns = require(path.join(DIST, 'services', 'sheets', 'analysisColumns'));
const reportSheet = require(path.join(DIST, 'services', 'jobLake', 'reportSheet'));
const adminSheet = require(path.join(DIST, 'services', 'jobLake', 'adminSheet'));
const { JOB_SHEET_HEADERS } = require(path.join(DIST, 'integrations', 'googleSheets'));
const { posting, allRows } = require('./report-sheet-rows');

const OLDER_TAB = '09/30/2026';
const NOTES_TAB = 'My notes';
/** Row 1 of a daily tab an older build made: Company in B, sixteen columns. */
const OLD_HEADER = [
  'NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder',
  'Filter Result', 'Filter Reason', 'Job Field', 'Salary', 'Job Hash', 'Analyzed At', 'Lake Status', 'Analysis',
];

/** Each tab's rows from row 2 (row 1 is the header), columns A..L (A..P for the old tab), kept in memory. */
const sheet = new Map();
function rowsFor(tab) {
  if (!sheet.has(tab)) {
    if (tab === 'All') {
      sheet.set(tab, allRows());
    } else if (tab === OLDER_TAB) {
      sheet.set(tab, [['1', 'Older Co', 'Engineer', 'https://older.example/jobs/1', posting('Older')]]);
    } else {
      sheet.set(tab, []);
    }
  }
  return sheet.get(tab);
}

const TABS = [
  { title: 'All', gid: 1 },
  { title: 'Temp For AI', gid: 2 },
  { title: OLDER_TAB, gid: 3 },
  { title: NOTES_TAB, gid: 4 },
];
const tabs = () => TABS.map((tab) => ({ ...tab }));
const gidOf = (tab) => TABS.find((entry) => entry.title === tab)?.gid ?? 0;

const header = (tab) =>
  tab === NOTES_TAB ? ['Idea', 'Where I saw it'] : tab === OLDER_TAB ? [...OLD_HEADER] : [...JOB_SHEET_HEADERS];
const isJobTab = (tab) => tab !== NOTES_TAB && tab !== OLDER_TAB;

const cellAt = (tab, row, col) => (row === 1 ? String(header(tab)[col - 1] ?? '') : String(rowsFor(tab)[row - 2]?.[col - 1] ?? ''));

/**
 * `'Tab'!C2:F11` as its parts - or `'Tab'!1:1`, a tab's whole row 1, as the
 * tab listing reads it. Single-letter columns are all this sheet has.
 */
function parseRange(range) {
  const rowOne = /^'((?:[^']|'')*)'!1:1$/.exec(range);
  if (rowOne) {
    const tab = rowOne[1].replace(/''/g, "'");
    return { tab, fromCol: 1, fromRow: 1, toCol: header(tab).length, toRow: 1 };
  }
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

function readRanges(ranges) {
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
}

const client = {
  async inspectTab(_spreadsheetId, tabName) {
    return {
      gid: gidOf(tabName),
      title: tabName,
      columnCount: tabName === OLDER_TAB ? 16 : 12,
      rowCount: 1000,
      headerRow: header(tabName),
      protectedRanges: [],
      spreadsheetTitle: 'E2E job sheet',
    };
  },
  // The protection is reported intact on a job tab, so a filled Analysis cell
  // is trusted - the trust rule itself is the shipping code's. Any other tab
  // is not a job tab, and is not touched.
  async verifyTab(_spreadsheetId, tabName) {
    const jobTab = isJobTab(tabName);
    return { gid: gidOf(tabName), protection: jobTab ? 'intact' : 'unconfirmed', grewColumns: false, wroteHeader: false, jobTab };
  },
  async readRanges(_spreadsheetId, ranges) {
    return readRanges(ranges);
  },
  // The analysis write-back: G:L of a row, RAW. Nothing else is written into a cell.
  async writeRaw(_spreadsheetId, data) {
    for (const { range, values } of data) {
      const { tab, fromRow, fromCol } = parseRange(range);
      if (!isJobTab(tab)) throw new Error(`[e2e stub] the app wrote into ${tab}, a tab that is not a job tab`);
      const rows = rowsFor(tab);
      values.forEach((cells, rowOffset) => {
        const row = (rows[fromRow - 2 + rowOffset] ??= []);
        // A null leaves the cell alone, as Google's RAW write does; a boolean
        // reads back as Google shows it.
        cells.forEach((value, colOffset) => {
          if (value === null) return;
          row[fromCol - 1 + colOffset] = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
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
      firstTabGid: gidOf('All'),
    };
  },
  async formatJobSheetTab() {},
  // All and Temp For AI are already there, laid out: verified, never added.
  async addSheetTabWithHeaders(_spreadsheetId, title) {
    return { gid: gidOf(title), created: false, jobTab: isJobTab(title) };
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
  async readRanges(_spreadsheetId, ranges) {
    return readRanges(ranges);
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

console.log('[e2e stub] Google Sheets stubbed for Report Jobs: four tabs (All, Temp For AI, an old daily tab, My notes), canned rows, the admin sheet in memory');

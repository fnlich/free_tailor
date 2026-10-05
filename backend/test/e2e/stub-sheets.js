/*
 * A stand-in for Google Sheets, for sheet-panel.js: every account's job sheet
 * exists, has three tabs, and its rows are canned.
 *
 * Loaded with `node --require` before the app, after stub-seat.js. Two seams,
 * the same ones the unit tests use: the account sheet's client
 * (`setSheetsClientForTests` - allocation and the tab list behind GET
 * /api/import/tabs) and the range reader POST /api/import calls
 * (`fetchGoogleSheetsRange`, replaced on the module's exports, which the route
 * reads at call time). The route's own checks - which sheet an account may
 * address - are the shipping code.
 *
 * The tabs, in the spreadsheet's order: an older day, TODAY's (what the panel
 * must select first), and a "Notes" tab. Columns are the own sheet's: NO(DATE),
 * Company, Job Title, Job Link, Job Description.
 */

const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const accountSheet = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));
const googleSheets = require(path.join(DIST, 'integrations', 'googleSheets'));

const POSTING = 'Senior engineer wanted to ship TypeScript services packaged with Docker, for a small platform team.';
const OLDER_TAB = '09/30/2026';

/** Each tab's rows from row 2 (row 1 is the header), columns A..E. */
function rowsFor(tab) {
  if (tab === OLDER_TAB) {
    return [
      ['1', 'Older Co', 'Platform Engineer', 'https://older.example/jobs/1', POSTING],
      ['2', 'Elder Ltd', '', 'not a link', POSTING],
    ];
  }
  if (tab === accountSheet.todaySheetTitle()) {
    return [
      ['1', 'Today Inc', 'Backend Engineer', 'https://today.example/jobs/1', POSTING],
      ['2', 'Now LLC', 'Site Reliability Engineer', 'javascript:alert(1)', POSTING],
      ['3', '', 'No company here', '', POSTING],
      ['4', 'Current Co', '', '', POSTING],
    ];
  }
  return [];
}

let minted = 0;
let nextGid = 100;
const tabs = () => [
  { title: OLDER_TAB, gid: 1 },
  { title: accountSheet.todaySheetTitle(), gid: 2 },
  { title: 'Notes', gid: 3 },
];

accountSheet.setSheetsClientForTests({
  async isConfigured() {
    return true;
  },
  async checkCredential() {},
  async createSpreadsheet() {
    minted += 1;
    return {
      spreadsheetId: `e2e-sheet-${minted}`,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/e2e-sheet-${minted}/edit`,
      firstTabGid: (nextGid += 1),
    };
  },
  async formatJobSheetTab() {},
  async addSheetTabWithHeaders() {
    return { gid: (nextGid += 1), created: false };
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

googleSheets.fetchGoogleSheetsRange = async ({ sheetId, tabName, fromRow, toRow, fromCol, toCol }) => {
  const all = rowsFor(tabName);
  const values = [];
  for (let row = fromRow; row <= toRow; row += 1) {
    const source = all[row - 2] ?? [];
    const cells = [];
    for (let col = fromCol; col <= toCol; col += 1) cells.push(String(source[col - 1] ?? ''));
    values.push(cells);
  }
  return {
    spreadsheetId: sheetId,
    spreadsheetTitle: 'E2E job sheet',
    tabs: tabs(),
    selectedTab: tabName,
    range: { fromRow, toRow, fromCol, toCol, a1Notation: `${tabName}!R${fromRow}C${fromCol}:R${toRow}C${toCol}` },
    values,
    totalRows: all.length + 1,
    totalColumns: 10,
  };
};

console.log('[e2e stub] Google Sheets stubbed: three tabs, canned rows');

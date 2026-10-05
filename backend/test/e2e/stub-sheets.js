/*
 * A stand-in for Google Sheets, for sheet-panel.js: every account's job sheet
 * exists, has three tabs, and its rows are held in memory.
 *
 * Loaded with `node --require` before the app, after stub-seat.js. Three
 * seams, the same ones the unit tests use: the account sheet's client
 * (`setSheetsClientForTests` - allocation and the tab list behind GET
 * /api/import/tabs), the range reader POST /api/import calls
 * (`fetchGoogleSheetsRange`, replaced on the module's exports, which the route
 * reads at call time), and the analysis columns' client
 * (`setAnalysisSheetsClientForTests` - the tab verify, the one batched read of
 * a sheet run's rows, and the write-back of an analysis into a row). All three
 * read and write the SAME rows, so an analysis written back after a build is
 * what the panel's next Load rows shows. The route's own checks - which sheet
 * an account may address - and the trust rule are the shipping code.
 *
 * The tabs, in the spreadsheet's order: an older day, TODAY's (what the panel
 * must select first), and a "Notes" tab. Columns are the own sheet's: NO(DATE),
 * Company, Job Title, Job Link, Job Description, five the build ignores, then
 * the six analysis columns K:P - Job Field, Salary, Job Hash, Analyzed At, Lake
 * Status, Analysis. Today's first row already holds its analysis.
 */

const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const accountSheet = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));
const googleSheets = require(path.join(DIST, 'integrations', 'googleSheets'));
const analysisColumns = require(path.join(DIST, 'services', 'sheets', 'analysisColumns'));
const identity = require(path.join(DIST, 'services', 'jobAnalysis', 'identity'));

const POSTING = 'Senior engineer wanted to ship TypeScript services packaged with Docker, for a small platform team.';
const OLDER_TAB = '09/30/2026';

/**
 * Today's first row, as a build would have written it: the six analysis cells,
 * K to P. The Analysis cell records the posting it was made for, which is what
 * lets the server use it although its store never saw the row it names.
 */
const ANALYSED = [
  'Backend',
  'USD 120,000 - 140,000 / annual',
  '',
  '2026-10-01T09:00:00.000Z',
  '',
  JSON.stringify({
    v: 1,
    id: '5d0c6a52-1f3e-4b7a-9c2d-8e4f6a1b3c5d',
    posting: { hash: identity.contentHash(POSTING), link: identity.linkKey('https://today.example/jobs/1') },
    jobField: 'backend',
    analysis: {
      jobMeta: { title: 'Backend Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
      skills: { technical: ['TypeScript', 'Docker'], required: [], preferred: [], tools: [], soft: [], technologies: [] },
      technologies: [],
      protocols: [],
      methodologies: [],
      architecturePatterns: [],
      responsibilities: ['ship services'],
      domainKnowledge: [],
      softSkills: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
      jobField: 'backend',
      salary: { min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null },
      filter: {
        jobType: 'remote',
        onsiteInterview: 'not_specified',
        companyCategory: 'saas',
        clearanceRequired: 'none',
        region: 'us',
        usState: '',
      },
    },
  }),
];

const blank = (count) => Array.from({ length: count }, () => '');

/** Each tab's rows from row 2 (row 1 is the header), columns A..P, kept and written to in memory. */
const sheet = new Map();
function rowsFor(tab) {
  if (!sheet.has(tab)) {
    if (tab === OLDER_TAB) {
      sheet.set(tab, [
        ['1', 'Older Co', 'Platform Engineer', 'https://older.example/jobs/1', POSTING],
        ['2', 'Elder Ltd', '', 'not a link', POSTING],
      ]);
    } else if (tab === accountSheet.todaySheetTitle()) {
      sheet.set(tab, [
        ['1', 'Today Inc', 'Backend Engineer', 'https://today.example/jobs/1', POSTING, ...blank(5), ...ANALYSED],
        ['2', 'Now LLC', 'Site Reliability Engineer', 'javascript:alert(1)', POSTING],
        ['3', '', 'No company here', '', POSTING],
        ['4', 'Current Co', '', '', POSTING],
      ]);
    } else {
      sheet.set(tab, []);
    }
  }
  return sheet.get(tab);
}

/** The cell at a 1-based row and column, as text. */
const cellAt = (tab, row, col) => String(rowsFor(tab)[row - 2]?.[col - 1] ?? '');

/** Rows `fromRow..toRow` of columns `fromCol..toCol`, as a grid of text. */
function grid(tab, fromRow, toRow, fromCol, toCol) {
  const values = [];
  for (let row = fromRow; row <= toRow; row += 1) {
    const cells = [];
    for (let col = fromCol; col <= toCol; col += 1) cells.push(cellAt(tab, row, col));
    values.push(cells);
  }
  return values;
}

/** `'Tab'!B2:D11` as its parts. Single-letter columns are all this sheet has. */
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
  return {
    spreadsheetId: sheetId,
    spreadsheetTitle: 'E2E job sheet',
    tabs: tabs(),
    selectedTab: tabName,
    range: { fromRow, toRow, fromCol, toCol, a1Notation: `${tabName}!R${fromRow}C${fromCol}:R${toRow}C${toCol}` },
    values: grid(tabName, fromRow, toRow, fromCol, toCol),
    totalRows: all.length + 1,
    totalColumns: 16,
  };
};

// The protection is reported intact, so a filled Analysis cell is trusted -
// the trust rule itself (`protectionTrusted`) is the shipping code's.
analysisColumns.setAnalysisSheetsClientForTests({
  async verifyTab(_spreadsheetId, tabName) {
    const gid = tabs().find((tab) => tab.title === tabName)?.gid ?? 0;
    return { gid, protection: 'intact', grewColumns: false, wroteHeader: false, jobTab: true };
  },
  async readRanges(_spreadsheetId, ranges) {
    return ranges.map((range) => {
      const { tab, fromRow, toRow, fromCol, toCol } = parseRange(range);
      return grid(tab, fromRow, toRow, fromCol, toCol);
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
      console.log(`[e2e stub] wrote the analysis cells ${range}`);
    }
  },
});

console.log('[e2e stub] Google Sheets stubbed: three tabs, canned rows, the analysis columns in memory');

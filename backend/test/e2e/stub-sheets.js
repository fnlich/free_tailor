/*
 * A stand-in for Google Sheets, for sheet-panel.js (and immediate-run.js,
 * whose builder page reads the account's sheet): every account's job sheet
 * exists, has four tabs, and its rows are held in memory.
 *
 * Loaded with `node --require` before the app, after stub-seat.js. Three
 * seams, the same ones the unit tests use: the account sheet's client
 * (`setSheetsClientForTests` - allocation, and the tab list and the one
 * batched read of every tab's row 1 behind GET /api/import/tabs), the range
 * reader POST /api/import calls (`fetchGoogleSheetsRange`, replaced on the
 * module's exports, which the route reads at call time), and the analysis
 * columns' client (`setAnalysisSheetsClientForTests` - the tab verify, the one
 * batched read of a sheet run's rows, and the write-back of an analysis into a
 * row). All three read and write the SAME rows, so an analysis written back
 * after a build is what the panel's next Load rows shows. The route's own
 * checks - which sheet an account may address, which tab is a job tab - and
 * the trust rule are the shipping code.
 *
 * The tabs, in the spreadsheet's order, as a sheet an older build made looks
 * after the upgrade: All (what the panel must select first) and Temp For AI,
 * in the twelve-column layout - Date, NO(DATE), Company, Job Title, Job Link,
 * Job Description, then the six analysis columns G:L, Job Field, Salary, Job
 * Type, Clearance, Industry, Analysis - then an older build's daily tab in ITS
 * layout (NO(DATE) in A, Company in B, sixteen columns: listed, never read),
 * and "Notes", a job tab of the person's own in the new layout. All's first
 * row already holds its analysis - one stored in the server's own database,
 * which is the only kind a build trusts; Temp For AI has only its header.
 */

const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const accountSheet = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));
const googleSheets = require(path.join(DIST, 'integrations', 'googleSheets'));
const analysisColumns = require(path.join(DIST, 'services', 'sheets', 'analysisColumns'));
const identity = require(path.join(DIST, 'services', 'jobAnalysis', 'identity'));

const POSTING = 'Senior engineer wanted to ship TypeScript services packaged with Docker, for a small platform team.';
const OLDER_TAB = '09/30/2026';
/** Row 1 of a daily tab an older build made. */
const OLD_HEADER = [
  'NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder',
  'Filter Result', 'Filter Reason', 'Job Field', 'Salary', 'Job Hash', 'Analyzed At', 'Lake Status', 'Analysis',
];

const TODAY_LINK = 'https://today.example/jobs/1';

/** The analysis All's first row was built on: what the stub seat would have answered for its posting. */
const ANALYSIS = {
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
  industry: 'technology',
  salary: { min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null },
  filter: {
    jobType: 'remote',
    onsiteInterview: 'not_specified',
    companyCategory: 'saas',
    clearanceRequired: 'none',
    region: 'us',
    usState: '',
  },
  sourceJobDescription: POSTING,
};

/**
 * All's first row's six analysis cells, G to L, as a build writes them
 * (`analysisColumnValues`) and as Google shows them back (the Clearance
 * boolean as FALSE). A build trusts an Analysis cell only when it names an
 * analysis THIS install stored for the row's posting - what the cell itself
 * says, its recorded posting keys included, decides nothing - so the analysis
 * is stored in the server's database the first time the tab is read (after
 * the server has opened it), as an earlier build here would have, and the
 * cell names that row.
 */
function analysedCells() {
  const repository = require(path.join(DIST, 'database', 'jobAnalysisRepository'));
  const { row } = repository.insertJobAnalysisIfAbsent({
    contentHash: identity.contentHash(POSTING),
    linkKey: identity.linkKey(TODAY_LINK),
    jobLink: TODAY_LINK,
    analysis: ANALYSIS,
    modelId: '',
    promptHash: '',
    source: 'ai',
    createdBy: null,
    companyName: 'Today Inc',
  });
  return analysisColumns
    .analysisColumnValues(row)
    .map((value) => (typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)));
}

const TODAY = accountSheet.sheetDateText();

/** Each tab's rows from row 2 (row 1 is the header), columns A..L, kept and written to in memory. */
const sheet = new Map();
function rowsFor(tab) {
  if (!sheet.has(tab)) {
    if (tab === 'All') {
      sheet.set(tab, [
        [TODAY, '1', 'Today Inc', 'Backend Engineer', TODAY_LINK, POSTING, ...analysedCells()],
        [TODAY, '2', 'Now LLC', 'Site Reliability Engineer', 'javascript:alert(1)', POSTING],
        [TODAY, '3', '', 'No company here', '', POSTING],
        [TODAY, '4', 'Current Co', '', '', POSTING],
      ]);
    } else if (tab === 'Notes') {
      sheet.set(tab, [
        [OLDER_TAB, '1', 'Older Co', 'Platform Engineer', 'https://older.example/jobs/1', POSTING],
        [OLDER_TAB, '2', 'Elder Ltd', '', 'not a link', POSTING],
      ]);
    } else if (tab === OLDER_TAB) {
      // The OLD layout: Company in B. Never read by a job page - if it were,
      // its Job Title would show as the company.
      sheet.set(tab, [['1', 'Ancient Co', 'Old Engineer', 'https://ancient.example/jobs/1', POSTING]]);
    } else {
      sheet.set(tab, []);
    }
  }
  return sheet.get(tab);
}

const headerOf = (tab) => (tab === OLDER_TAB ? [...OLD_HEADER] : [...googleSheets.JOB_SHEET_HEADERS]);

/** The cell at a 1-based row and column, as text. */
const cellAt = (tab, row, col) => (row === 1 ? String(headerOf(tab)[col - 1] ?? '') : String(rowsFor(tab)[row - 2]?.[col - 1] ?? ''));

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

/** `'Tab'!C2:F11` as its parts. Single-letter columns are all this sheet has. */
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
const TABS = [
  { title: 'All', gid: 1 },
  { title: 'Temp For AI', gid: 2 },
  { title: OLDER_TAB, gid: 3 },
  { title: 'Notes', gid: 4 },
];
const tabs = () => TABS.map((tab) => ({ ...tab }));
const gidOf = (title) => TABS.find((tab) => tab.title === title)?.gid;

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
      firstTabGid: gidOf('All'),
    };
  },
  async formatJobSheetTab() {},
  // All and Temp For AI are already there, laid out: verified, never added.
  async addSheetTabWithHeaders(_spreadsheetId, title) {
    return { gid: gidOf(title) ?? 99, created: false, jobTab: title !== OLDER_TAB };
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
  // Every tab's row 1, in one call: what the listing's layouts are read from.
  async readRanges(_spreadsheetId, ranges) {
    return ranges.map((range) => {
      const title = /^'((?:[^']|'')*)'!1:1$/.exec(range)?.[1]?.replace(/''/g, "'");
      if (title === undefined) throw new Error(`[e2e stub] cannot read the range ${range}`);
      return [headerOf(title)];
    });
  },
});

googleSheets.fetchGoogleSheetsRange = async ({ sheetId, tabName, fromRow, toRow, fromCol, toCol }) => {
  const all = rowsFor(tabName);
  return {
    spreadsheetId: sheetId,
    spreadsheetTitle: 'E2E job sheet',
    tabs: tabs().map((tab, index) => ({ title: tab.title, index, sheetId: tab.gid })),
    selectedTab: tabName,
    range: { fromRow, toRow, fromCol, toCol, a1Notation: `${tabName}!R${fromRow}C${fromCol}:R${toRow}C${toCol}` },
    values: grid(tabName, fromRow, toRow, fromCol, toCol),
    totalRows: all.length + 1,
    totalColumns: 12,
  };
};

// The protection is reported intact on a job tab, so a filled Analysis cell
// is trusted - the trust rule itself (`protectionTrusted`) is the shipping
// code's. The older build's daily tab is not a job tab: never touched.
analysisColumns.setAnalysisSheetsClientForTests({
  async verifyTab(_spreadsheetId, tabName) {
    const jobTab = tabName !== OLDER_TAB;
    return { gid: gidOf(tabName) ?? 0, protection: jobTab ? 'intact' : 'unconfirmed', grewColumns: false, wroteHeader: false, jobTab };
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
      if (tab === OLDER_TAB) throw new Error(`[e2e stub] the app wrote into ${OLDER_TAB}, a tab that is not a job tab`);
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
      console.log(`[e2e stub] wrote the analysis cells ${range}`);
    }
  },
});

/*
 * The Job Filter's two reads, which call the integration directly: the tab's
 * inspection (whether it is a job tab) and one read of C:E, whole columns -
 * row 1 included, trailing empty rows left out, as Google answers. Replaced on
 * the module's exports, which the route reads at call time. Nothing else
 * that runs against this stub calls either (the analysis columns have their
 * own client above).
 */
googleSheets.inspectJobSheetTab = async (_spreadsheetId, tabName) => ({
  gid: gidOf(tabName) ?? 0,
  title: tabName,
  columnCount: tabName === OLDER_TAB ? 16 : 12,
  rowCount: 1000,
  headerRow: headerOf(tabName),
  protectedRanges: [],
  spreadsheetTitle: 'E2E job sheet',
});
googleSheets.batchGetValues = async (_spreadsheetId, ranges) =>
  ranges.map((range) => {
    const match = /^'((?:[^']|'')*)'!([A-Z]):([A-Z])$/.exec(range);
    if (!match) throw new Error(`[e2e stub] cannot read the range ${range}`);
    const tab = match[1].replace(/''/g, "'");
    const fromCol = match[2].charCodeAt(0) - 64;
    const toCol = match[3].charCodeAt(0) - 64;
    const values = grid(tab, 1, rowsFor(tab).length + 1, fromCol, toCol);
    while (values.length > 0 && values[values.length - 1].every((cell) => cell === '')) values.pop();
    return values;
  });

console.log('[e2e stub] Google Sheets stubbed: four tabs (All, Temp For AI, an old daily tab, Notes), canned rows, the analysis columns in memory');

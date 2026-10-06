/*
 * A stand-in for Google Sheets, for lake-push.js: every account's job sheet,
 * held in memory - each its own spreadsheet with its two tabs, All and Temp
 * For AI - so a push into one administrator's Temp For AI can be seen to
 * leave every other account's sheet alone.
 *
 * Loaded with `node --require` before the app, after stub-seat.js. Four
 * seams, the ones the unit tests use (test/jobLakePush.test.js):
 *
 *   - the account sheet's client (`setSheetsClientForTests`): allocation, the
 *     tab listing and its one batched read of every tab's row 1;
 *   - the push's client (`setLakePushSheetsClientForTests`): the inspection
 *     of Temp For AI, its verify, the ONE :batchUpdate that empties A:L of
 *     every row under the header (values and paint) and grows the grid, and
 *     the RAW writes of the rows;
 *   - the analysis columns' client (`setAnalysisSheetsClientForTests`): what
 *     a build from the tab reads (C:E and G:L of its rows) and the write-back
 *     of a row whose Analysis cell is not its posting's;
 *   - the admin lake sheet's client, so nothing reaches Google if a sync runs.
 *
 * All read and write the SAME cells. What a push and a later build do to the
 * cells - and every read and write, in order - is written to a JSON file after
 * each change, so the script (another process) can look at the sheet the way
 * a person would: E2E_SHEET_STATE, else `e2e-lake-push-sheets.json` in DB_DIR,
 * which the script shares with the server.
 *
 * Every new sheet's Temp For AI holds what an earlier push left: rows 2 to 6,
 * A:L filled and M a note of the person's own, rows 3 and 4 painted red across
 * A:M (a report run's duplicates). A sheet allocated to an account whose email
 * contains `clash` is the exception: its Temp For AI is a tab of the person's
 * own (row 1 is not the job header) - a name clash, which the push refuses
 * before it reads the tab.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const accountSheet = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));
const analysisColumns = require(path.join(DIST, 'services', 'sheets', 'analysisColumns'));
const push = require(path.join(DIST, 'services', 'jobLake', 'push'));
const adminSheet = require(path.join(DIST, 'services', 'jobLake', 'adminSheet'));
const { JOB_SHEET_HEADERS } = require(path.join(DIST, 'integrations', 'googleSheets'));

const STATE = process.env.E2E_SHEET_STATE || path.join(process.env.DB_DIR || os.tmpdir(), 'e2e-lake-push-sheets.json');
const TEMP = 'Temp For AI';
const NOTES_HEADER = ['Idea', 'Where I saw it'];
const RED = { red: 0.957, green: 0.8, blue: 0.8 };

const letter = (n) => String.fromCharCode(64 + n);
const number = (l) => l.charCodeAt(0) - 64;

/** id -> { title, tabs: { [title]: { gid, header, rows: { [row]: { [col]: value } }, paint: { [row]: { [col]: color } }, rowCount } } } */
const books = {};
const events = [];
let minted = 0;

function save() {
  fs.writeFileSync(STATE, JSON.stringify({ books, events }, null, 2));
}

/** What an earlier push left in Temp For AI: five rows, two of them painted red, and a note in M. */
function staleTemp() {
  const rows = {};
  const paint = {};
  for (let row = 2; row <= 6; row += 1) {
    rows[row] = {};
    for (let col = 1; col <= 12; col += 1) rows[row][letter(col)] = `stale ${letter(col)}${row}`;
    rows[row].M = `my note ${row}`;
  }
  for (const row of [3, 4]) {
    paint[row] = {};
    for (let col = 1; col <= 13; col += 1) paint[row][letter(col)] = RED;
  }
  return { gid: 2, header: [...JOB_SHEET_HEADERS, 'My notes'], rows, paint, rowCount: 6 };
}

function newBook(title) {
  minted += 1;
  const id = `e2e-push-sheet-${minted}`;
  const clash = /clash/.test(title);
  books[id] = {
    title,
    tabs: {
      All: { gid: 1, header: [...JOB_SHEET_HEADERS], rows: {}, paint: {}, rowCount: 1000 },
      [TEMP]: clash
        ? { gid: 2, header: [...NOTES_HEADER], rows: { 2: { A: 'An idea of my own', B: 'somewhere' } }, paint: {}, rowCount: 1000 }
        : staleTemp(),
    },
  };
  save();
  return id;
}

const tabOf = (id, title) => {
  const tab = books[id]?.tabs[title];
  if (!tab) throw new Error(`[e2e stub] ${id} has no tab named ${title}`);
  return tab;
};
const isJobTab = (tab) => JOB_SHEET_HEADERS.slice(0, 6).every((header, index) => tab.header[index] === header);
const tabsOf = (id) => Object.entries(books[id]?.tabs ?? {}).map(([title, tab]) => ({ title, gid: tab.gid }));

/** `'Tab'!C2:F11`, or `'Tab'!1:1` (a tab's whole row 1), as its parts. Single-letter columns are all this sheet has. */
function parseRange(range) {
  const rowOne = /^'((?:[^']|'')*)'!1:1$/.exec(range);
  if (rowOne) return { tab: rowOne[1].replace(/''/g, "'"), rowOne: true };
  const match = /^'((?:[^']|'')*)'!([A-Z])(\d+):([A-Z])(\d+)$/.exec(range);
  if (!match) throw new Error(`[e2e stub] cannot read the range ${range}`);
  return {
    tab: match[1].replace(/''/g, "'"),
    fromCol: number(match[2]),
    fromRow: Number(match[3]),
    toCol: number(match[4]),
    toRow: Number(match[5]),
  };
}

/** A FORMATTED read, as the app's reads are: a boolean as TRUE or FALSE, a number as its text. */
const shown = (value) =>
  value === undefined || value === null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);

function read(id, ranges) {
  return ranges.map((range) => {
    const { tab: title, rowOne, fromCol, fromRow, toCol, toRow } = parseRange(range);
    const tab = tabOf(id, title);
    if (rowOne) return [[...tab.header]];
    const grid = [];
    for (let row = fromRow; row <= toRow; row += 1) {
      const values = [];
      for (let col = fromCol; col <= toCol; col += 1) {
        values.push(row === 1 ? String(tab.header[col - 1] ?? '') : shown(tab.rows[row]?.[letter(col)]));
      }
      grid.push(values);
    }
    return grid;
  });
}

function write(id, data, kind) {
  for (const { range, values } of data) {
    const { tab: title, fromRow, fromCol } = parseRange(range);
    const tab = tabOf(id, title);
    if (!isJobTab(tab)) throw new Error(`[e2e stub] the app wrote into ${title} of ${id}, a tab that is not a job tab`);
    values.forEach((cells, offset) => {
      const row = fromRow + offset;
      if (row > tab.rowCount) throw new Error(`[e2e stub] ${range}: row ${row} is past the grid (${tab.rowCount} rows)`);
      tab.rows[row] = tab.rows[row] ?? {};
      // A null leaves the cell alone, as Google's RAW write does.
      cells.forEach((value, index) => {
        if (value !== null) tab.rows[row][letter(fromCol + index)] = value;
      });
    });
    events.push({ kind, id, range });
    console.log(`[e2e stub] ${kind}: wrote ${range} of ${id}`);
  }
  save();
}

const inspection = (id, title) => {
  const tab = tabOf(id, title);
  return { gid: tab.gid, title, columnCount: 13, rowCount: tab.rowCount, headerRow: [...tab.header], protectedRanges: [] };
};
// The protection is reported intact on a job tab, so the trust rule - whether
// a filled Analysis cell names its posting's stored analysis - is the
// shipping code's alone.
const verified = (id, title) => {
  const tab = tabOf(id, title);
  const jobTab = isJobTab(tab);
  return { gid: tab.gid, protection: jobTab ? 'intact' : 'unconfirmed', grewColumns: false, wroteHeader: false, jobTab };
};

accountSheet.setSheetsClientForTests({
  async isConfigured() {
    return true;
  },
  async checkCredential() {},
  async createSpreadsheet(title) {
    const id = newBook(title);
    return { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`, firstTabGid: 1 };
  },
  async formatJobSheetTab() {},
  // Both tabs are there from the start: verified, never added. A clash's Temp For AI is the person's own.
  async addSheetTabWithHeaders(id, title) {
    const tab = tabOf(id, title);
    return { gid: tab.gid, created: false, jobTab: isJobTab(tab) };
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
  async listSheetTabs(id) {
    return tabsOf(id);
  },
  async readRanges(id, ranges) {
    return read(id, ranges);
  },
});

push.setLakePushSheetsClientForTests({
  async inspectTab(id, title) {
    events.push({ kind: 'push-inspect', id, tab: title });
    save();
    return inspection(id, title);
  },
  async verifyTab(id, title) {
    return verified(id, title);
  },
  async batchUpdate(id, requests) {
    for (const request of requests) {
      if (request.appendDimension) {
        const tab = Object.values(books[id].tabs).find((entry) => entry.gid === request.appendDimension.sheetId);
        tab.rowCount += request.appendDimension.length;
      }
      if (request.updateCells) {
        // Emptying a range: the values, the paint, or both, as `fields` says - never past its columns.
        const { range, fields } = request.updateCells;
        const tab = Object.values(books[id].tabs).find((entry) => entry.gid === range.sheetId);
        const parts = fields.split(',');
        for (const row of Object.keys({ ...tab.rows, ...tab.paint }).map(Number)) {
          if (row - 1 < range.startRowIndex || (range.endRowIndex !== undefined && row - 1 >= range.endRowIndex)) continue;
          for (let col = range.startColumnIndex; col < range.endColumnIndex; col += 1) {
            if (parts.includes('userEnteredValue') && tab.rows[row]) delete tab.rows[row][letter(col + 1)];
            if (parts.includes('userEnteredFormat.backgroundColor') && tab.paint[row]) delete tab.paint[row][letter(col + 1)];
          }
        }
      }
    }
    events.push({ kind: 'push-batch-update', id, requests: requests.map((request) => Object.keys(request)[0]) });
    console.log(`[e2e stub] push: one batchUpdate of ${id} (${requests.length} request(s))`);
    save();
  },
  async writeRaw(id, data) {
    write(id, data, 'push-write');
  },
});

analysisColumns.setAnalysisSheetsClientForTests({
  async verifyTab(id, title) {
    return verified(id, title);
  },
  async readRanges(id, ranges) {
    events.push({ kind: 'analysis-read', id, ranges });
    save();
    return read(id, ranges);
  },
  async writeRaw(id, data) {
    write(id, data, 'analysis-write-back');
  },
});

adminSheet.setAdminLakeSheetClientForTests({
  async isConfigured() {
    return true;
  },
  async createSpreadsheet() {
    return { spreadsheetId: 'e2e-admin-lake', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/e2e-admin-lake/edit', firstTabGid: 0 };
  },
  async writeRaw() {},
  async appendRows() {},
  async shareWithEmail() {},
});

save();
console.log(`[e2e stub] Google Sheets stubbed for Push to Google Sheet: every account its own sheet (All, Temp For AI), the cells in ${STATE}`);

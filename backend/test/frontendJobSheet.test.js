const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * How the job pages pick a tab of the account's own sheet
 * (frontend/src/lib/sheetTabs.ts) and how the Job Filter page reads a run's
 * verdicts (lib/jobFilterDisplay.ts) - each run against the server's own code:
 * the tab names it gives every sheet, the listing it answers with (and which
 * tab it starts on), and the reasons the filter fails a posting for. A copy
 * that drifted would offer a tab whose columns are not the job sheet's as if
 * it held jobs, start a page on a tab the server refuses, or show a verdict as
 * a bare code.
 *
 * Loaded the way frontendHelpers.test.js loads its modules: transpiled with
 * the backend's TypeScript, importing nothing at runtime.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontendModule(relative) {
  const file = path.join(SRC, relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, refuse);
  return module.exports;
}

const tabs = loadFrontendModule('lib/sheetTabs.ts');
const filter = loadFrontendModule('lib/jobFilterDisplay.ts');
const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');

/**
 * Row 1 of a tab laid out in other columns - Company in B - under a day's
 * name: to the server it is a tab of the person's own like any other.
 */
const OTHER_COLUMNS = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder'];

/** The server's listing of a sheet with these tabs and row-1 headers, through its own code. */
async function serverListing(tabList, headers) {
  useTempStorage(`frontend-job-sheet-${Math.random().toString(36).slice(2)}`);
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const sheets = loadFresh('../dist/services/sheets/accountSheet');
  let gid = 100;
  sheets.setSheetsClientForTests({
    async isConfigured() {
      return true;
    },
    async checkCredential() {},
    async createSpreadsheet() {
      return { spreadsheetId: 'own-sheet', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/own-sheet/edit', firstTabGid: 1 };
    },
    async formatJobSheetTab() {},
    async addSheetTabWithHeaders(_id, title) {
      const found = tabList.find((tab) => tab.title === title);
      return { gid: found ? found.gid : (gid += 1), created: !found };
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
      return tabList;
    },
    async readRanges(_id, ranges) {
      return ranges.map((range) => {
        const row = headers[/^'(.*)'!1:1$/.exec(range)[1]] ?? [];
        return row.length > 0 ? [row] : [];
      });
    },
  });
  const account = users.createUser({ email: `tabs-${Math.random().toString(36).slice(2)}@example.com` });
  return { sheets, listing: await sheets.listAddressableSheetTabs(users.getUserById(account.id), undefined) };
}

// -- the tabs ------------------------------------------------------------------ //

test("the pages name the two tabs the server gives every sheet", () => {
  const { DEFAULT_TAB, TEMP_TAB } = require('../dist/services/sheets/accountSheet');
  assert.equal(tabs.DEFAULT_TAB, DEFAULT_TAB);
  assert.equal(tabs.TEMP_TAB, TEMP_TAB);
});

test("every tab the server lists is offered when it is a job tab, and listed but not offered when it is not", async () => {
  const { listing } = await serverListing(
    [
      { title: 'All', gid: 11 },
      { title: 'Temp For AI', gid: 12 },
      { title: '09/30/2026', gid: 13 },
      { title: 'Notes', gid: 14 },
      { title: 'Spare', gid: 15 },
    ],
    { All: [...JOB_SHEET_HEADERS], 'Temp For AI': [...JOB_SHEET_HEADERS], '09/30/2026': OTHER_COLUMNS, Notes: ['Idea', 'Where'] }
  );
  assert.deepEqual(
    tabs.sheetTabOptions(listing.tabs),
    [
      { title: 'All', label: 'All', usable: true },
      { title: 'Temp For AI', label: 'Temp For AI', usable: true },
      // Other columns under a date's name: a tab of the person's own, never read.
      { title: '09/30/2026', label: '09/30/2026 (not a job tab)', usable: false },
      // A tab of the person's own.
      { title: 'Notes', label: 'Notes (not a job tab)', usable: false },
      // Row 1 empty: the server lays it out the first time it is used, if the whole tab is empty.
      { title: 'Spare', label: 'Spare', usable: true },
    ],
    "in the spreadsheet's order"
  );
  assert.equal(tabs.hasUnreadTabs(listing.tabs), true);
  assert.equal(tabs.chosenTab(listing), 'All', "the server's default");
  assert.equal(tabs.chosenTab(listing, 'Temp For AI'), 'Temp For AI', 'a tab picked by hand');
  assert.equal(tabs.chosenTab(listing, '09/30/2026'), 'All', 'never a tab no job route reads, picked or not');
  assert.equal(tabs.chosenTab(listing, 'Gone'), 'All', 'nor one no longer listed');
  assert.equal(tabs.chosenTab(null), '');
});

test("without a job tab called All, the page starts where the server does - and never on a tab it refuses", async () => {
  // All is a tab of the person's own (a name clash): the first job tab instead.
  const clash = await serverListing(
    [
      { title: '09/30/2026', gid: 1 },
      { title: 'All', gid: 2 },
      { title: 'Jobs', gid: 3 },
    ],
    { '09/30/2026': OTHER_COLUMNS, All: ['My own'], Jobs: [...JOB_SHEET_HEADERS] }
  );
  assert.equal(clash.listing.defaultTab, 'Jobs');
  assert.equal(tabs.chosenTab(clash.listing), 'Jobs');
  assert.equal(tabs.sheetTabOptions(clash.listing.tabs)[1].usable, false);
  // And the note under the select does not send anybody to paste into it.
  assert.equal(tabs.hasUnreadTabs(clash.listing.tabs), true);
  assert.equal(tabs.unreadTabsNoteFor(clash.listing.tabs), tabs.UNREAD_TABS_NOTE_ALL_CLASH);

  // Nothing a job could be read from: nothing is chosen, and the select says so.
  const none = await serverListing([{ title: '09/30/2026', gid: 1 }], { '09/30/2026': OTHER_COLUMNS });
  assert.equal(none.listing.defaultTab, null);
  assert.equal(tabs.chosenTab(none.listing), '');
  assert.equal(tabs.chosenTab(none.listing, '09/30/2026'), '');
});

test("the note under the tab select says where a job in a tab that is not read goes in All", () => {
  const { JOB_SHEET_COLUMNS } = require('../dist/integrations/googleSheets');
  const letter = (column) => String.fromCharCode(64 + column);
  // C to F, the job's four columns in a job tab.
  assert.equal(letter(JOB_SHEET_COLUMNS.company), 'C');
  assert.equal(letter(JOB_SHEET_COLUMNS.jobDescription), 'F');
  assert.equal(
    tabs.UNREAD_TABS_NOTE,
    'Tabs that are not laid out as job tabs are listed but not read. To use a job from one, copy its Company, ' +
      `Job Title, Job Link and Job Description into columns C to F of ${tabs.DEFAULT_TAB}.`,
    'the whole sentence, with the tab name - spelled out in the source, so held to the constant here'
  );
  // Nothing about a day's tab, or a layout from before: such a tab is simply not a job tab.
  assert.doesNotMatch(`${tabs.UNREAD_TABS_NOTE} ${tabs.UNREAD_TABS_NOTE_ALL_CLASH}`, /daily|old layout|from before/i);

  // While All is a job tab - a tab under a date's name or a Temp For AI of
  // somebody's own beside it changes nothing - the note says to copy into All.
  const ordinary = [
    { title: tabs.DEFAULT_TAB, layout: 'job' },
    { title: tabs.TEMP_TAB, layout: 'other' },
    { title: '09/30/2026', layout: 'other' },
  ];
  assert.equal(tabs.unreadTabsNoteFor(ordinary), tabs.UNREAD_TABS_NOTE);

  // When All is the person's own tab, copying into it would be copying into a
  // tab no job route reads: the note says to clear the name first, and where
  // the app looks again (the Job Sheet page's GET /api/sheet?recheck=1).
  const clash = [
    { title: '09/30/2026', layout: 'other' },
    { title: tabs.DEFAULT_TAB, layout: 'other' },
    { title: tabs.TEMP_TAB, layout: 'job' },
  ];
  assert.equal(tabs.unreadTabsNoteFor(clash), tabs.UNREAD_TABS_NOTE_ALL_CLASH);
  assert.equal(
    tabs.UNREAD_TABS_NOTE_ALL_CLASH,
    `Tabs that are not laid out as job tabs are listed but not read. Your own tab named ${tabs.DEFAULT_TAB} is one ` +
      `of them: rename or delete it in Google Sheets, then open Settings > Job Sheet to have the job tab ` +
      `${tabs.DEFAULT_TAB} added. To use a job from a tab that is not read, copy its Company, Job Title, Job Link ` +
      `and Job Description into columns C to F of that new ${tabs.DEFAULT_TAB}.`
  );
  // The page it names is the one that re-checks a clash, under the label it has.
  const pageSource = fs.readFileSync(path.join(SRC, 'app', 'settings', 'job-sheet', 'page.tsx'), 'utf8');
  assert.match(pageSource, /sheetApi\.get\(\{ recheck: true \}\)/);
  assert.match(fs.readFileSync(path.join(SRC, 'components', 'shell', 'navModel.ts'), 'utf8'), /href: '\/settings\/job-sheet', label: 'Job Sheet'/);
});

// -- the Job Filter's verdicts ------------------------------------------------------ //

test('every reason the filter fails a posting for has words on the page', () => {
  const source = fs.readFileSync(require.resolve('../dist/services/jobFilter'), 'utf8');
  const reasons = [...new Set([...source.matchAll(/result: 'Fail', reason: '([a-z_]+)'/g)].map((match) => match[1]))];
  assert.ok(reasons.length >= 10, `found ${reasons.length} reasons in the server's filter`);
  for (const reason of reasons) {
    assert.ok(Object.prototype.hasOwnProperty.call(filter.FILTER_REASON_LABELS, reason), `no words for "${reason}"`);
  }
  assert.deepEqual(Object.keys(filter.FILTER_REASON_LABELS).sort(), [...reasons].sort(), 'and no words for a reason the server never gives');

  // Each one, as the server decides it.
  const { evaluateJobFilterAnalysis, getEmptyJobFilterAnalysis } = require('../dist/services/jobFilter');
  const hybrid = evaluateJobFilterAnalysis({ ...getEmptyJobFilterAnalysis(), jobType: 'hybrid' });
  assert.deepEqual(filter.describeFilterRow({ result: hybrid.result, reason: hybrid.reason ?? '' }), {
    label: 'Fail',
    tone: 'red',
    detail: 'Hybrid, not remote',
  });
  const remote = evaluateJobFilterAnalysis({ ...getEmptyJobFilterAnalysis(), jobType: 'remote', clearanceRequired: 'none', region: 'us' });
  assert.equal(remote.result, 'Pass');
  assert.deepEqual(filter.describeFilterRow({ result: 'Pass', reason: '' }), { label: 'Pass', tone: 'green', detail: '' });

  // A reason a later server adds is shown as its word, never hidden.
  assert.equal(filter.filterReasonLabel('needs_relocation'), 'needs relocation');
  assert.equal(filter.filterReasonLabel(' '), '');
});

test("a row that was not judged says why, in the server's words", () => {
  // The route's own sentence for a row with no link (routes/jobs.ts).
  const routeSource = fs.readFileSync(require.resolve('../dist/routes/jobs'), 'utf8');
  const noLink = /reason: '(The row has no job link to read\.)'/.exec(routeSource)?.[1];
  assert.ok(noLink, "the route's sentence for a row with no link");
  assert.deepEqual(filter.describeFilterRow({ result: null, reason: noLink }), {
    label: 'Not judged',
    tone: 'grey',
    detail: noLink,
  });
  const failed = 'Could not open the job page. Please try again, or contact your administrator. (Ref: ERR-1a2b3c)';
  assert.deepEqual(filter.describeFilterRow({ result: null, reason: '', error: failed }), {
    label: 'Not judged',
    tone: 'amber',
    detail: failed,
  });

  const rows = [
    { result: 'Pass', reason: '' },
    { result: 'Fail', reason: 'hybrid' },
    { result: 'Fail', reason: 'not_us' },
    { result: null, reason: noLink },
  ];
  assert.deepEqual(filter.countFilterRows(rows), { pass: 1, fail: 2, notJudged: 1 });
  assert.equal(filter.describeFilterCounts(rows), '1 pass, 2 fail, 1 not judged');
  assert.equal(filter.describeFilterCounts(rows.slice(0, 1)), '1 pass');
  assert.equal(filter.describeFilterCounts([]), 'No job rows');
});

test('the rows a filter run is asked for: From row 2 by default, To row optional', () => {
  assert.deepEqual(filter.readFilterRange({ startRow: '', endRow: '' }), { ok: true, startRow: 2 });
  assert.deepEqual(filter.readFilterRange({ startRow: ' 5 ', endRow: '' }), { ok: true, startRow: 5 });
  assert.deepEqual(filter.readFilterRange({ startRow: '2', endRow: '40' }), { ok: true, startRow: 2, endRow: 40 });
  assert.deepEqual(filter.readFilterRange({ startRow: '7', endRow: '7' }), { ok: true, startRow: 7, endRow: 7 });
  for (const startRow of ['0', '-1', '2.5', 'two', '1e3']) {
    assert.equal(filter.readFilterRange({ startRow, endRow: '' }).ok, false, startRow);
  }
  assert.match(filter.readFilterRange({ startRow: '9', endRow: '3' }).error, /To row must be From row or a row after it/);
  assert.match(filter.readFilterRange({ startRow: '2', endRow: 'x' }).error, /To row must be a whole number/);
});

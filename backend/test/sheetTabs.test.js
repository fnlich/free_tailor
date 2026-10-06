const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * `GET /api/import/tabs` - what the builder's sheet panel lists in its Tab
 * select, so a run can be built from any job tab of the account's sheet.
 *
 * The tab list is a list of a SPREADSHEET'S tabs, so it is the same guard as
 * every other route taking a sheet id (sheetAccessScoping.test.js): your own
 * sheet and nothing else - an administrator's included, the saved shared
 * sheets being gone. Each tab carries its layout, from ONE batched read of
 * every tab's row 1: `job`, `blank` or `other` - an older build's daily tab
 * is `other`, and the panel does not offer it. All is where the picker starts.
 * The rows of the chosen tab are read with `POST /api/import` as before.
 */

const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');
const OLD_DAILY = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder'];

function makeClient(tabsBySheet, headerOf = () => [...JOB_SHEET_HEADERS]) {
  let minted = 0;
  let nextGid = 100;
  const listed = [];
  const reads = [];
  return {
    listed,
    reads,
    async isConfigured() {
      return true;
    },
    async checkCredential() {},
    async createSpreadsheet() {
      minted += 1;
      return {
        spreadsheetId: `sheet-${minted}`,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/sheet-${minted}/edit`,
        firstTabGid: (nextGid += 1),
      };
    },
    async formatJobSheetTab() {},
    async addSheetTabWithHeaders() {
      return { gid: (nextGid += 1), created: true };
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
    async listSheetTabs(spreadsheetId) {
      listed.push(spreadsheetId);
      return tabsBySheet(spreadsheetId);
    },
    async readRanges(spreadsheetId, ranges) {
      reads.push(ranges);
      return ranges.map((range) => {
        const header = headerOf(/^'(.*)'!1:1$/.exec(range)[1]);
        return header.length ? [header] : [];
      });
    },
  };
}

async function serve(tabsBySheet, sharedSources = [], headerOf) {
  const { dbDir } = useTempStorage(`sheet-tabs-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  if (sharedSources.length > 0) {
    writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ googleSheetsSources: sharedSources }));
  }
  const express = require('express');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/config/aiModelConfig');
  const sheets = loadFresh('../dist/services/sheets/accountSheet');
  loadFresh('../dist/services/sheets/jobSheetTarget');
  const client = makeClient(tabsBySheet, headerOf);
  sheets.setSheetsClientForTests(client);
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const importRoutes = loadFresh('../dist/routes/import');

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/import', importRoutes.default);
  const server = app.listen(0);
  const port = server.address().port;
  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
  };

  return {
    client,
    sheets,
    sheetIdFor: async (account) => (await sheets.ensureAccountSheet(users.getUserById(account.id))).spreadsheetId,
    admin,
    alice,
    bob,
    close: () => server.close(),
    get: async (who, query = '') => {
      const response = await fetch(`http://127.0.0.1:${port}/api/import/tabs${query}`, {
        headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("your own sheet's tabs, every one of them with its layout, starting on All", async () => {
  const headers = { '10/01/2026': OLD_DAILY, All: [...JOB_SHEET_HEADERS], 'Temp For AI': [...JOB_SHEET_HEADERS], Notes: ['Idea', 'Link'], Spare: [] };
  const server = await serve(
    () => [
      { title: '10/01/2026', gid: 1 },
      { title: 'All', gid: 2 },
      { title: 'Temp For AI', gid: 3 },
      { title: 'Notes', gid: 4 },
      { title: 'Spare', gid: 5 },
    ],
    [],
    (title) => headers[title]
  );
  try {
    const response = await server.get('alice');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.spreadsheetId, await server.sheetIdFor(server.alice));
    assert.deepEqual(response.body.tabs, [
      { title: '10/01/2026', gid: 1, layout: 'other' },
      { title: 'All', gid: 2, layout: 'job' },
      { title: 'Temp For AI', gid: 3, layout: 'job' },
      { title: 'Notes', gid: 4, layout: 'other' },
      { title: 'Spare', gid: 5, layout: 'blank' },
    ], "in the spreadsheet's own order; an older build's daily tab is not a job tab");
    assert.equal(response.body.defaultTab, 'All');
    assert.equal(server.client.reads.at(-1).length, 5, 'every row 1 in ONE read');
    assert.deepEqual(server.client.reads.at(-1)[0], "'10/01/2026'!1:1", 'whole rows: never past a narrow grid');

    // Naming it is the same as not naming it.
    const named = await server.get('alice', `?sheetId=${response.body.spreadsheetId}`);
    assert.deepEqual(named.body, response.body);
  } finally {
    server.close();
  }
});

test('without a job tab called All, the first job tab is where the picker starts - never a tab that is not one', async () => {
  const headers = { Older: OLD_DAILY, Jobs: [...JOB_SHEET_HEADERS], All: ['My own'] };
  const server = await serve(
    () => [
      { title: 'Older', gid: 7 },
      { title: 'All', gid: 9 },
      { title: 'Jobs', gid: 8 },
    ],
    [],
    (title) => headers[title]
  );
  try {
    assert.equal((await server.get('alice')).body.defaultTab, 'Jobs');
  } finally {
    server.close();
  }
  const none = await serve(() => [{ title: 'Older', gid: 7 }], [], () => OLD_DAILY);
  try {
    assert.equal((await none.get('alice')).body.defaultTab, null, 'nothing a job could be read from');
  } finally {
    none.close();
  }
});

test('somebody else\'s sheet is not found, and is never asked of Google', async () => {
  const server = await serve(() => [{ title: 'Sheet1', gid: 1 }]);
  try {
    const bobs = await server.sheetIdFor(server.bob);
    server.client.listed.length = 0;
    const response = await server.get('alice', `?sheetId=${bobs}`);
    assert.equal(response.status, 404);
    assert.match(response.body.error, /That spreadsheet was not found/);
    assert.deepEqual(server.client.listed, [], 'refused before Google was asked');

    // Signed out is signed out.
    assert.equal((await server.get(null)).status, 401);
  } finally {
    server.close();
  }
});

test("an administrator lists only their own sheet: a shared source saved by an older build is not found", async () => {
  const server = await serve(
    (id) => (id === 'shared-sheet-1' ? [{ title: 'Board', gid: 9 }] : [{ title: 'All', gid: 1 }]),
    [{ id: 'src-1', name: 'Team board', sheetId: 'shared-sheet-1', createdAt: 'x', updatedAt: 'x' }]
  );
  try {
    assert.equal((await server.get('alice', '?sheetId=shared-sheet-1')).status, 404);
    server.client.listed.length = 0;
    const asAdmin = await server.get('admin', '?sheetId=shared-sheet-1');
    assert.equal(asAdmin.status, 404);
    assert.deepEqual(server.client.listed, [], 'never asked of Google');
    const own = await server.get('admin');
    assert.equal(own.status, 200);
    assert.equal(own.body.spreadsheetId, await server.sheetIdFor(server.admin));
  } finally {
    server.close();
  }
});

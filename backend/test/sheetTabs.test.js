const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * `GET /api/import/tabs` - what the builder's sheet panel lists in its Tab
 * select, so a run can be built from any day's tab of the account's sheet,
 * not only today's (owner's item: "Tab should be selectable by user").
 *
 * The tab list is a list of a SPREADSHEET'S tabs, so it is the same guard as
 * every other route taking a sheet id (sheetAccessScoping.test.js): your own
 * sheet, or a shared source for an administrator, and anybody else's is 404.
 * The rows of the chosen tab are read with `POST /api/import` as before.
 */

function makeClient(tabsBySheet) {
  let minted = 0;
  let nextGid = 100;
  const listed = [];
  return {
    listed,
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
  };
}

async function serve(tabsBySheet, sharedSources = []) {
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
  const client = makeClient(tabsBySheet);
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
    todayTab: sheets.todaySheetTitle(),
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

test('your own sheet\'s tabs, every one of them, starting on today\'s', async () => {
  let today;
  const server = await serve(() => [
    { title: '10/01/2026', gid: 1 },
    { title: today, gid: 2 },
    { title: 'Notes', gid: 3 },
  ]);
  today = server.todayTab;
  try {
    const response = await server.get('alice');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.spreadsheetId, await server.sheetIdFor(server.alice));
    assert.deepEqual(
      response.body.tabs.map((tab) => tab.title),
      ['10/01/2026', today, 'Notes'],
      'in the spreadsheet\'s own order, not only today\'s'
    );
    assert.equal(response.body.tabs[1].gid, 2);
    assert.equal(response.body.defaultTab, today);

    // Naming it is the same as not naming it.
    const named = await server.get('alice', `?sheetId=${response.body.spreadsheetId}`);
    assert.deepEqual(named.body, response.body);
  } finally {
    server.close();
  }
});

test('without a tab for today, the first tab is where the picker starts', async () => {
  const server = await serve(() => [
    { title: 'Older', gid: 7 },
    { title: 'Oldest', gid: 8 },
  ]);
  try {
    assert.equal((await server.get('alice')).body.defaultTab, 'Older');
  } finally {
    server.close();
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

test('an administrator may list a shared source\'s tabs; an ordinary account may not', async () => {
  const server = await serve(
    (id) => (id === 'shared-sheet-1' ? [{ title: 'Board', gid: 9 }] : [{ title: 'Sheet1', gid: 1 }]),
    [{ id: 'src-1', name: 'Team board', sheetId: 'shared-sheet-1' }]
  );
  try {
    assert.equal((await server.get('alice', '?sheetId=shared-sheet-1')).status, 404);
    const asAdmin = await server.get('admin', '?sheetId=shared-sheet-1');
    assert.equal(asAdmin.status, 200);
    assert.deepEqual(asAdmin.body, { spreadsheetId: 'shared-sheet-1', tabs: [{ title: 'Board', gid: 9 }], defaultTab: 'Board' });
  } finally {
    server.close();
  }
});

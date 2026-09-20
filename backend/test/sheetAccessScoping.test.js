const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * The routes that take a spreadsheet id, and who may point them where.
 *
 * This file exists because of a hole the per-account sheets opened. The service
 * account used to reach only the spreadsheets an administrator had shared with
 * it, so a route that took an id on trust could not reach anything private. Now
 * the service account OWNS every account's spreadsheet - so the same routes
 * would read, and write, anybody's for anybody who knew the id. Sheets are
 * public by default, which means the id travels in a URL people pass around,
 * and the private toggle does not help: these routes reach Google as the
 * service account, not as the person.
 *
 * Every assertion below is "Alice cannot touch Bob's sheet". If one of them
 * starts failing, a job route has gone back to trusting its input.
 */

function makeClient() {
  let minted = 0;
  let nextGid = 100;
  const shares = new Map();
  return {
    async isConfigured() {
      return true;
    },
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
    async shareSpreadsheetWithEmail(id, email) {
      shares.set(id, email);
    },
    async hasPersonalGrant(id, email) {
      return shares.get(id) === email;
    },
    async getSpreadsheetVisibility() {
      return 'public';
    },
    async setSpreadsheetVisibility(id, next) {
      return next;
    },
  };
}

async function serve(sharedSources = []) {
  const { dbDir } = useTempStorage(`sheet-scoping-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  // Written before anything reads settings: the settings module caches, so a
  // source added afterwards would not be seen by this process.
  if (sharedSources.length > 0) {
    writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ googleSheetsSources: sharedSources }));
  }

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/config/aiModelConfig');
  const sheets = loadFresh('../dist/services/sheets/accountSheet');
  // In dependency order, and jobSheetTarget matters: a cached copy would hold
  // the PREVIOUS accountSheet module, so the routes' `instanceof
  // SheetAccessError` check would compare against a different class object and
  // every refusal would surface as a 500.
  loadFresh('../dist/services/sheets/jobSheetTarget');
  sheets.setSheetsClientForTests(makeClient());

  const { attachUser } = loadFresh('../dist/middleware/auth');
  const importRoutes = loadFresh('../dist/routes/import');
  const jobRoutes = loadFresh('../dist/routes/jobs');
  const bidRoutes = loadFresh('../dist/routes/bidAssistant');

  // First in is the admin; the other two are ordinary accounts.
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/import', importRoutes.default);
  app.use('/api/jobs', jobRoutes.default);
  app.use('/api/bid-assistant', bidRoutes.default ?? bidRoutes);
  const server = app.listen(0);
  const port = server.address().port;

  const sheetIdFor = async (account) =>
    (await sheets.ensureAccountSheet(users.getUserById(account.id))).spreadsheetId;

  return {
    users,
    sheets,
    admin,
    alice,
    bob,
    sheetIdFor,
    adminToken: users.createSession(admin.id),
    aliceToken: users.createSession(alice.id),
    close: () => server.close(),
    post: (token, path, body) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }),
  };
}

/** Every route that accepts a spreadsheet id, and a body that is otherwise valid. */
const ID_TAKING_ROUTES = [
  { path: '/api/import', body: () => ({ tabName: 'Sheet1' }) },
  {
    path: '/api/jobs/filter-google-sheet',
    body: () => ({ tabName: 'Sheet1', startRow: 2, endRow: 3 }),
  },
  {
    path: '/api/jobs/scrapers/export',
    body: () => ({ source: 'linkedin', tabName: 'Sheet1', startRow: 2 }),
  },
  {
    path: '/api/jobs/linkedin/search-and-export',
    body: () => ({ keywords: 'engineer', tabName: 'Sheet1', startRow: 2 }),
  },
];

test("a user pointing a job route at somebody else's sheet gets 404", async () => {
  const server = await serve();
  try {
    const bobsSheet = await server.sheetIdFor(server.bob);
    assert.ok(bobsSheet);

    for (const route of ID_TAKING_ROUTES) {
      const response = await server.post(server.aliceToken, route.path, {
        ...route.body(),
        sheetId: bobsSheet,
      });
      // 404 and not 403: a forbidden would confirm the spreadsheet exists,
      // which is itself the question an attacker is asking.
      assert.equal(response.status, 404, `${route.path} should not reach another account's sheet`);
      assert.match((await response.json()).error, /not found/i);
    }
  } finally {
    server.close();
  }
});

test('an arbitrary pasted spreadsheet id is refused the same way', async () => {
  const server = await serve();
  try {
    for (const route of ID_TAKING_ROUTES) {
      const response = await server.post(server.aliceToken, route.path, {
        ...route.body(),
        // The id from the tracking sheet this feature was modelled on - a real
        // one, and exactly the kind somebody pastes in.
        sheetId: '1cTf_t9B9V6D5A29bT-Phh6Z0Lafwdi3KYIK_eSlENE8',
      });
      assert.equal(response.status, 404, route.path);
    }
  } finally {
    server.close();
  }
});

test('the guard runs before any work, so nothing is scraped or written first', async () => {
  const server = await serve();
  try {
    const bobsSheet = await server.sheetIdFor(server.bob);
    // A scrape request that would take minutes if it got past the guard. It
    // comes back immediately, which is the evidence that it did not.
    const response = await server.post(server.aliceToken, '/api/jobs/scrapers/export', {
      source: 'linkedin',
      sheetId: bobsSheet,
      tabName: 'Sheet1',
      startRow: 2,
      limit: 50,
    });
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test('an admin may address a configured shared source, an ordinary user may not', async () => {
  // How the admin page stores them.
  const server = await serve([{ id: 'src-1', name: 'Team board', sheetId: 'shared-sheet-1' }]);
  try {
    const asAlice = await server.post(server.aliceToken, '/api/import', {
      sheetId: 'shared-sheet-1',
      tabName: 'Sheet1',
    });
    assert.equal(asAlice.status, 404, 'a shared source is not a user-addressable sheet');

    // The admin gets past the guard and on to Google, which in this test has
    // no such spreadsheet - anything other than 404 proves the guard allowed it.
    const asAdmin = await server.post(server.adminToken, '/api/import', {
      sheetId: 'shared-sheet-1',
      tabName: 'Sheet1',
    });
    assert.notEqual(asAdmin.status, 404);
  } finally {
    server.close();
  }
});

test('naming no sheet at all resolves to YOUR sheet, not just to some sheet', async () => {
  const server = await serve();
  try {
    // Every account has one, so "it returned a sheet" proves nothing on its
    // own - an earlier version of this test asserted only notEqual(404), which
    // a guard handing back the FIRST account's sheet would have passed.
    const hers = await server.sheetIdFor(server.alice);
    const his = await server.sheetIdFor(server.bob);
    const admins = await server.sheetIdFor(server.admin);
    assert.equal(new Set([hers, his, admins]).size, 3);

    // Asked through the service, where the answer is inspectable rather than
    // hidden behind a Google call this test does not stand up.
    const resolved = await server.sheets.resolveAddressableSheet(
      server.users.getUserById(server.alice.id),
      undefined
    );
    assert.equal(resolved, hers);
    assert.notEqual(resolved, his);
    assert.notEqual(resolved, admins);

    // And over HTTP: it gets past the guard and reaches the real integration,
    // which has no key here. A refusal would name the spreadsheet instead.
    const response = await server.post(server.aliceToken, '/api/import', { tabName: 'Sheet1' });
    assert.notEqual(response.status, 404);
    const { error } = await response.json();
    assert.doesNotMatch(error ?? '', /That spreadsheet was not found/);
    assert.match(error ?? '', /Service Account key/i);
  } finally {
    server.close();
  }
});

test("the bid assistant cannot be used to register another account's sheet", async () => {
  const server = await serve();
  try {
    const bobsSheet = await server.sheetIdFor(server.bob);

    // The hole this closes: the bid assistant's saved sources are a global list
    // with no owner, and they are read with the SAME service account that owns
    // every per-account spreadsheet. Saving one was a way to read somebody
    // else's sheet through a feature that never had an owner concept.
    const saved = await server.post(server.aliceToken, '/api/bid-assistant/google-sheets', {
      label: 'not mine',
      sheetId: bobsSheet,
    });
    assert.equal(saved.status, 404);
    assert.match((await saved.json()).error, /not found/i);

    // Her own is fine, and so is a spreadsheet that belongs to no account -
    // pointing at a sheet somebody shared with this installation is the whole
    // purpose of these sources.
    const hers = await server.sheetIdFor(server.alice);
    assert.equal(
      (await server.post(server.aliceToken, '/api/bid-assistant/google-sheets', {
        label: 'mine',
        sheetId: hers,
      })).status,
      200
    );
    assert.equal(
      (await server.post(server.aliceToken, '/api/bid-assistant/google-sheets', {
        label: 'a sheet shared with this install',
        sheetId: '1cTf_t9B9V6D5A29bT-Phh6Z0Lafwdi3KYIK_eSlENE8',
      })).status,
      200
    );
  } finally {
    server.close();
  }
});

test('none of it is reachable without signing in', async () => {
  const server = await serve();
  try {
    for (const route of ID_TAKING_ROUTES) {
      const response = await server.post(null, route.path, route.body());
      assert.equal(response.status, 401, route.path);
    }
  } finally {
    server.close();
  }
});

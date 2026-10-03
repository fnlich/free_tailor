const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The account's own sheet over HTTP.
 *
 * The claim these exist to hold is narrow and important: there is no way to ask
 * for somebody ELSE's spreadsheet. The route takes no id, so the test for that
 * is to send one anyway - in the path, the query and the body - and assert it
 * changes nothing about which sheet comes back.
 */

function makeClient() {
  const visibility = new Map();
  const shares = new Map();
  let minted = 0;
  let nextGid = 100;
  return {
    visibility,
    shares,
    client: {
      async isConfigured() {
        return true;
      },
      async createSpreadsheet(title, firstTabTitle) {
        minted += 1;
        const spreadsheetId = `sheet-${minted}`;
        visibility.set(spreadsheetId, 'private');
        return {
          spreadsheetId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          firstTabGid: (nextGid += 1),
        };
      },
      async formatJobSheetTab() {},
      async addSheetTabWithHeaders() {
        return { gid: (nextGid += 1), created: true };
      },
      async shareSpreadsheetWithEmail(spreadsheetId, email) {
        shares.set(spreadsheetId, email);
      },
      async hasPersonalGrant(spreadsheetId, email) {
        return shares.get(spreadsheetId) === email;
      },
      async getSpreadsheetVisibility(id) {
        return visibility.get(id) ?? 'private';
      },
      async setSpreadsheetVisibility(id, next) {
        visibility.set(id, next);
        return next;
      },
    },
  };
}

async function serve(clientOverride) {
  useTempStorage(`sheet-routes-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const sheets = loadFresh('../dist/services/sheets/accountSheet');
  const fake = makeClient();
  sheets.setSheetsClientForTests({ ...fake.client, ...clientOverride });

  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/sheet');

  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const boss = users.createUser({ email: 'boss@example.com', role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/sheet', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  return {
    users,
    sheets,
    visibility: fake.visibility,
    aliceToken: users.createSession(alice.id),
    bobToken: users.createSession(bob.id),
    adminToken: users.createSession(boss.id),
    close: () => server.close(),
    request: (token, path, init = {}) =>
      fetch(`http://127.0.0.1:${port}/api/sheet${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
  };
}

test('the sheet is only ever readable by the account that owns it', async () => {
  const server = await serve();
  try {
    assert.equal((await server.request(null, '/')).status, 401);

    const alice = await (await server.request(server.aliceToken, '/')).json();
    const bob = await (await server.request(server.bobToken, '/')).json();

    assert.ok(alice.spreadsheetId);
    assert.ok(bob.spreadsheetId);
    assert.notEqual(alice.spreadsheetId, bob.spreadsheetId);

    // An id supplied by the caller is not a way in. The route reads req.user and
    // nothing else. The payloads below are Bob's REAL account id and his real
    // spreadsheet id - an earlier version of this test sent his email address,
    // which no lookup would ever have matched, so it could not have failed.
    const bobsId = server.users.getUserByEmail('bob@example.com').id;
    for (const query of [
      `?userId=${encodeURIComponent(bobsId)}`,
      `?id=${encodeURIComponent(bobsId)}`,
      `?spreadsheetId=${encodeURIComponent(bob.spreadsheetId)}`,
      `?sheetId=${encodeURIComponent(bob.spreadsheetId)}`,
    ]) {
      const smuggled = await (await server.request(server.aliceToken, `/${query}`)).json();
      assert.equal(smuggled.spreadsheetId, alice.spreadsheetId, `query ${query} changed the answer`);
      assert.notEqual(smuggled.spreadsheetId, bob.spreadsheetId);
    }

    // And the same through the body, which POST /visibility does read.
    const bobVisibilityBefore = server.visibility.get(bob.spreadsheetId);
    const viaBody = await server.request(server.aliceToken, '/visibility', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private', userId: bobsId, sheetId: bob.spreadsheetId }),
    });
    assert.equal(viaBody.status, 200);
    // Bob's sheet is UNTOUCHED - whatever it was, it still is - and hers is the
    // one that moved. Read rather than hard-coded, so the allocation default can
    // change without this test quietly becoming about the default instead of
    // about scoping.
    assert.equal(server.visibility.get(bob.spreadsheetId), bobVisibilityBefore);
    assert.equal(server.visibility.get(alice.spreadsheetId), 'private');
  } finally {
    server.close();
  }
});

test('reading the sheet reports the sharing state and the day it would file under', async () => {
  const server = await serve();
  try {
    const body = await (await server.request(server.aliceToken, '/')).json();

    assert.equal(body.configured, true);
    // That it REPORTS the sharing state is the claim; the value is whatever a
    // newly allocated sheet has, which is private unless an operator sets
    // SHEET_DEFAULT_VISIBILITY=public.
    assert.equal(body.visibility, 'private');
    assert.match(body.spreadsheetUrl, /docs\.google\.com/);
    assert.match(body.todayTab, /^\d{2}\/\d{2}\/\d{4}$/);
  } finally {
    server.close();
  }
});

test('the toggle flips sharing and answers with what Drive says afterwards', async () => {
  const server = await serve();
  try {
    const before = await (await server.request(server.aliceToken, '/')).json();

    const made = await server.request(server.aliceToken, '/visibility', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private' }),
    });
    assert.equal(made.status, 200);
    assert.equal((await made.json()).visibility, 'private');
    assert.equal(server.visibility.get(before.spreadsheetId), 'private');

    // And the backend still holds the sheet, which is the point of going
    // private rather than unsharing it: job rows stay readable from here.
    const after = await (await server.request(server.aliceToken, '/')).json();
    assert.equal(after.spreadsheetId, before.spreadsheetId);
    assert.equal(after.visibility, 'private');
  } finally {
    server.close();
  }
});

test('anything other than public or private is rejected', async () => {
  const server = await serve();
  try {
    for (const visibility of ['unlisted', '', null, 'PUBLIC']) {
      const response = await server.request(server.aliceToken, '/visibility', {
        method: 'POST',
        body: JSON.stringify({ visibility }),
      });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(visibility)}`);
    }
  } finally {
    server.close();
  }
});

test('an install with no key tells the admin what to set, and everyone else what it means', async () => {
  const server = await serve({
    async isConfigured() {
      return false;
    },
  });
  try {
    const response = await server.request(server.adminToken, '/');
    // 200: nothing the caller sent was wrong, and the fix is on the server.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.configured, false);
    assert.match(body.message, /GOOGLE_SERVICE_ACCOUNT_KEY_PATH/, 'the admin gets the variable');

    // The same state, read by somebody who cannot set an environment variable.
    const mine = await server.request(server.aliceToken, '/');
    const asUser = await mine.json();
    assert.equal(asUser.configured, false);
    assert.doesNotMatch(asUser.message, /GOOGLE_SERVICE_ACCOUNT_KEY_PATH/);
    assert.match(asUser.message, /administrator/i, 'and is told whose job it is instead');
  } finally {
    server.close();
  }
});

test("Google's own failure reaches the user with its reason intact", async () => {
  const { GoogleSheetsRequestError } = require('../dist/integrations/googleSheets');
  const server = await serve({
    async setSpreadsheetVisibility() {
      throw new GoogleSheetsRequestError(403, 'Sharing a sheet needs the Drive API.');
    },
  });
  try {
    const response = await server.request(server.aliceToken, '/visibility', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private' }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Drive API/);
  } finally {
    server.close();
  }
});

test('the half of a failure that names a command reaches admins only', async () => {
  /*
   * This route is `requireUser`, so the reader is usually somebody who cannot
   * act on the answer - and an expired Google consent used to hand them
   * `Run "npm run sheets:login" in backend/`, naming a command and a directory
   * on a server they do not administer. The diagnosis is everybody's; the
   * instruction is not.
   */
  const { GoogleSheetsRequestError } = require('../dist/integrations/googleSheets');
  const server = await serve({
    async checkCredential() {
      throw new GoogleSheetsRequestError(
        400,
        "This server's Google sign-in is no longer valid.",
        'Run "npm run sheets:login" in backend/ again, and publish the consent screen.'
      );
    },
    async createSpreadsheet() {
      throw new GoogleSheetsRequestError(
        400,
        "This server's Google sign-in is no longer valid.",
        'Run "npm run sheets:login" in backend/ again, and publish the consent screen.'
      );
    },
  });
  try {
    const mine = await server.request(server.aliceToken, '/');
    const body = await mine.json();
    assert.match(body.error, /no longer valid/, 'the diagnosis is still told plainly');
    assert.equal(body.detail, undefined, 'but not the part that assumes a shell');
    assert.doesNotMatch(JSON.stringify(body), /sheets:login|backend\//);

    const asAdmin = await server.request(server.adminToken, '/');
    const adminBody = await asAdmin.json();
    assert.match(adminBody.error, /no longer valid/);
    assert.match(adminBody.detail, /sheets:login/, 'an administrator gets the instruction');
  } finally {
    server.close();
  }
});

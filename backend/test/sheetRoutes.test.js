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

    // An id supplied by the caller is not a way in. The route reads req.user
    // and nothing else, which is the guard the batch routes once lacked.
    const smuggled = await (
      await server.request(server.aliceToken, `/?userId=${encodeURIComponent('bob@example.com')}`)
    ).json();
    assert.equal(smuggled.spreadsheetId, alice.spreadsheetId);
  } finally {
    server.close();
  }
});

test('reading the sheet reports the sharing state and the day it would file under', async () => {
  const server = await serve();
  try {
    const body = await (await server.request(server.aliceToken, '/')).json();

    assert.equal(body.configured, true);
    assert.equal(body.visibility, 'public');
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

test('an install with no key is told what to set, not handed a 500', async () => {
  const server = await serve({
    async isConfigured() {
      return false;
    },
  });
  try {
    const response = await server.request(server.aliceToken, '/');
    // 200: nothing the caller sent was wrong, and the fix is on the server.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.configured, false);
    assert.match(body.message, /GOOGLE_SERVICE_ACCOUNT_KEY_PATH/);
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

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * One spreadsheet per account, one tab per day.
 *
 * Every claim here is about NOT doing something twice. A second spreadsheet for
 * an account is invisible - the first one keeps working, and the rows somebody
 * typed are simply in a file nothing links to any more - so the duplicate cases
 * are the ones worth pinning down rather than the happy path.
 *
 * The Google calls are a fake, injected through `setSheetsClientForTests`. What
 * is being tested is the decision to call, not the HTTP.
 */

/** A spreadsheet service that remembers everything, so the tests can count calls. */
function makeClient(overrides = {}) {
  const calls = [];
  const tabs = new Map();
  const visibility = new Map();
  const shares = new Map();
  let minted = 0;

  const client = {
    async isConfigured() {
      calls.push(['isConfigured']);
      return true;
    },
    async createSpreadsheet(title) {
      calls.push(['createSpreadsheet', title]);
      minted += 1;
      const spreadsheetId = `sheet-${minted}`;
      tabs.set(spreadsheetId, new Set());
      visibility.set(spreadsheetId, 'private');
      return {
        spreadsheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      };
    },
    async addSheetTabWithHeaders(spreadsheetId, title) {
      calls.push(['addSheetTabWithHeaders', spreadsheetId, title]);
      const existing = tabs.get(spreadsheetId) ?? new Set();
      tabs.set(spreadsheetId, existing);
      // Mirrors the integration: null means "already there", not "failed".
      if (existing.has(title)) return null;
      existing.add(title);
      return existing.size;
    },
    async shareSpreadsheetWithEmail(spreadsheetId, email) {
      calls.push(['shareSpreadsheetWithEmail', spreadsheetId, email]);
      shares.set(spreadsheetId, email);
    },
    async getSpreadsheetVisibility(spreadsheetId) {
      calls.push(['getSpreadsheetVisibility', spreadsheetId]);
      return visibility.get(spreadsheetId) ?? 'private';
    },
    async setSpreadsheetVisibility(spreadsheetId, next) {
      calls.push(['setSpreadsheetVisibility', spreadsheetId, next]);
      visibility.set(spreadsheetId, next);
      return next;
    },
    ...overrides,
  };

  const named = (name) => calls.filter((call) => call[0] === name);
  return { client, calls, named, tabs, visibility, shares };
}

function setup(name, overrides) {
  useTempStorage(`account-sheet-${name}`);
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const sheets = loadFresh('../dist/services/sheets/accountSheet');
  const fake = makeClient(overrides);
  sheets.setSheetsClientForTests(fake.client);
  return { users, sheets, ...fake };
}

test('an account gets exactly one spreadsheet, however many times it is asked for', async () => {
  const { users, sheets, named } = setup('one-spreadsheet');
  const account = users.createUser({ email: 'alice@example.com' });

  const first = await sheets.ensureAccountSheet(account);
  // Deliberately the STALE account object, the way a second request would hold
  // one: the service must re-read rather than trust what it was handed.
  const second = await sheets.ensureAccountSheet(account);

  assert.equal(named('createSpreadsheet').length, 1);
  assert.equal(first.spreadsheetId, second.spreadsheetId);
  assert.equal(users.getUserById(account.id).sheetId, first.spreadsheetId);
  assert.match(users.getUserById(account.id).sheetUrl, /docs\.google\.com/);
});

test('a new spreadsheet is shared with its owner and left link-editable', async () => {
  const { users, sheets, shares, visibility } = setup('shared-public');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);

  assert.equal(shares.get(state.spreadsheetId), 'alice@example.com');
  // Public by default, which for this feature means anyone with the link may
  // edit. The private case is a choice the owner makes on the account page.
  assert.equal(visibility.get(state.spreadsheetId), 'public');
});

test("today's tab is created once and then never asked about again", async () => {
  const { users, sheets, named, tabs } = setup('tab-once');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  assert.equal(named('addSheetTabWithHeaders').length, 1);
  assert.deepEqual([...tabs.get(state.spreadsheetId)], [state.todayTab]);
  assert.match(state.todayTab, /^\d{2}\/\d{2}\/\d{4}$/);

  // The second sign-in of the same day. The stored date is what makes this
  // free: without it every sign-in would cost a round trip to list the tabs.
  await sheets.ensureAccountSheet(account);
  assert.equal(named('addSheetTabWithHeaders').length, 1);
});

test('a new date gets a new tab, beside the old one', async () => {
  const { users, sheets, named, tabs } = setup('new-date');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  // Yesterday, as the row would read on the first sign-in of a new day.
  users.recordSheetTabDate(account.id, '01/02/2020');

  await sheets.ensureAccountSheet(account);

  assert.equal(named('addSheetTabWithHeaders').length, 2);
  assert.deepEqual([...tabs.get(state.spreadsheetId)], [state.todayTab]);
  assert.equal(users.getUserById(account.id).sheetTabDate, state.todayTab);
});

test('a tab that already exists in the spreadsheet is skipped, not treated as a failure', async () => {
  const { users, sheets, tabs } = setup('tab-exists');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  // The spreadsheet keeps the tab while the row forgets it - which is what a
  // half-finished run, or a hand-made tab, leaves behind.
  users.recordSheetTabDate(account.id, '');

  await sheets.ensureAccountSheet(account);

  assert.equal(tabs.get(state.spreadsheetId).size, 1);
  assert.equal(users.getUserById(account.id).sheetTabDate, state.todayTab);
});

test('two calls racing produce one spreadsheet, not two', async () => {
  const { users, sheets, named } = setup('race');
  const account = users.createUser({ email: 'alice@example.com' });

  const [first, second] = await Promise.all([
    sheets.ensureAccountSheet(account),
    sheets.ensureAccountSheet(account),
  ]);

  assert.equal(named('createSpreadsheet').length, 1);
  assert.equal(first.spreadsheetId, second.spreadsheetId);
});

test('the claim on the spreadsheet slot is conditional, so a loser cannot overwrite', () => {
  const { users } = setup('claim');
  const account = users.createUser({ email: 'alice@example.com' });

  assert.equal(users.recordAccountSheet(account.id, 'sheet-a', 'url-a'), true);
  // The second writer arrives after the first and must be told no, rather than
  // pointing the account at a spreadsheet the first writer's rows are not in.
  assert.equal(users.recordAccountSheet(account.id, 'sheet-b', 'url-b'), false);
  assert.equal(users.getUserById(account.id).sheetId, 'sheet-a');
});

test('an install with no service account key says so instead of failing', async () => {
  const { users, sheets, calls } = setup('unconfigured', {
    async isConfigured() {
      return false;
    },
  });
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);

  assert.equal(state.configured, false);
  assert.equal(state.spreadsheetId, undefined);
  // Still a date, so the UI has something true to say about what it would name.
  assert.match(state.todayTab, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(calls.length, 0);
});

test('a sheet that cannot be shared is still kept, rather than made again on every try', async () => {
  const { users, sheets, named } = setup('share-fails', {
    async shareSpreadsheetWithEmail() {
      throw new Error('Drive API has not been enabled for this project.');
    },
  });
  const account = users.createUser({ email: 'alice@example.com' });

  const first = await sheets.ensureAccountSheet(account);
  const second = await sheets.ensureAccountSheet(account);

  assert.equal(named('createSpreadsheet').length, 1);
  assert.equal(first.spreadsheetId, second.spreadsheetId);
  assert.equal(users.getUserById(account.id).sheetId, first.spreadsheetId);
});

test('signing in still works when every Google call fails', () => {
  useTempStorage('account-sheet-signin-safe');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const sheets = loadFresh('../dist/services/sheets/accountSheet');
  sheets.setSheetsClientForTests({
    async isConfigured() {
      return true;
    },
    async createSpreadsheet() {
      throw new Error('Google is having a bad day.');
    },
    async addSheetTabWithHeaders() {
      throw new Error('Google is having a bad day.');
    },
    async shareSpreadsheetWithEmail() {
      throw new Error('Google is having a bad day.');
    },
    async getSpreadsheetVisibility() {
      throw new Error('Google is having a bad day.');
    },
    async setSpreadsheetVisibility() {
      throw new Error('Google is having a bad day.');
    },
  });
  const auth = loadFresh('../dist/services/auth/authService');

  users.storeLoginCode('alice@example.com', '123456');
  // The whole point of firing the allocation rather than awaiting it: a
  // spreadsheet is a convenience, and being able to log in is not.
  const result = auth.signInWithCode('alice@example.com', '123456');

  assert.equal(result.account.email, 'alice@example.com');
  assert.ok(result.token);
});

test('accounts from before the feature are given a spreadsheet by the backfill', async () => {
  const { users, sheets, named } = setup('backfill');
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const gone = users.createUser({ email: 'gone@example.com' });
  users.updateUser(gone.id, { disabled: true });

  const result = await sheets.backfillAccountSheets(0);

  assert.equal(result.done, 2);
  assert.equal(result.failed, 0);
  assert.equal(named('createSpreadsheet').length, 2);
  assert.ok(users.getUserById(alice.id).sheetId);
  assert.ok(users.getUserById(bob.id).sheetId);
  // A disabled account is not going to sign in and read it.
  assert.equal(users.getUserById(gone.id).sheetId, undefined);

  // Idempotent: running it again on the next boot allocates nothing.
  const again = await sheets.backfillAccountSheets(0);
  assert.equal(again.done, 0);
  assert.equal(named('createSpreadsheet').length, 2);
});

test('the header row is the one from the tracking sheet, spelling included', () => {
  const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');
  // Reproduced exactly, lower-case `note` and all: anybody matching a column by
  // its heading is matching the string a person reads on screen.
  assert.deepEqual(
    [...JOB_SHEET_HEADERS],
    ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder']
  );
});

test('SHEET_TIMEZONE decides which day a tab belongs to', () => {
  const { sheets } = setup('timezone');
  // Ten at night in New York is already tomorrow in UTC. A server in UTC would
  // otherwise file an evening's work under the next day's tab.
  const evening = new Date('2026-09-18T02:30:00Z');
  process.env.SHEET_TIMEZONE = 'America/New_York';
  try {
    assert.equal(sheets.todaySheetTitle(evening), '09/17/2026');
    process.env.SHEET_TIMEZONE = 'UTC';
    assert.equal(sheets.todaySheetTitle(evening), '09/18/2026');
    // A zone name nothing recognises must not be able to stop a sign-in.
    process.env.SHEET_TIMEZONE = 'Mars/Olympus_Mons';
    assert.match(sheets.todaySheetTitle(evening), /^\d{2}\/\d{2}\/\d{4}$/);
  } finally {
    delete process.env.SHEET_TIMEZONE;
  }
});

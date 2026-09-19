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
  let nextGid = 100;

  const client = {
    async isConfigured() {
      calls.push(['isConfigured']);
      return true;
    },
    async createSpreadsheet(title, firstTabTitle) {
      calls.push(['createSpreadsheet', title, firstTabTitle]);
      minted += 1;
      const spreadsheetId = `sheet-${minted}`;
      const firstTabGid = (nextGid += 1);
      // Created WITH its first tab, which is what keeps Google's default
      // `Sheet1` out of the file - the fake models that, not an empty file.
      tabs.set(spreadsheetId, new Map([[firstTabTitle, firstTabGid]]));
      visibility.set(spreadsheetId, 'private');
      return {
        spreadsheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        firstTabGid,
      };
    },
    async formatJobSheetTab(spreadsheetId, gid) {
      calls.push(['formatJobSheetTab', spreadsheetId, gid]);
    },
    async addSheetTabWithHeaders(spreadsheetId, title) {
      calls.push(['addSheetTabWithHeaders', spreadsheetId, title]);
      const existing = tabs.get(spreadsheetId) ?? new Map();
      tabs.set(spreadsheetId, existing);
      // `created: false` means "already there", not "failed".
      if (existing.has(title)) return { gid: existing.get(title), created: false };
      const gid = (nextGid += 1);
      existing.set(title, gid);
      return { gid, created: true };
    },
    async shareSpreadsheetWithEmail(spreadsheetId, email) {
      calls.push(['shareSpreadsheetWithEmail', spreadsheetId, email]);
      shares.set(spreadsheetId, email);
    },
    async hasPersonalGrant(spreadsheetId, email) {
      calls.push(['hasPersonalGrant', spreadsheetId, email]);
      return shares.get(spreadsheetId) === email;
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
  const titles = (spreadsheetId) => [...(tabs.get(spreadsheetId) ?? new Map()).keys()];
  return { client, calls, named, tabs, titles, visibility, shares };
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
  const { users, sheets, named, titles } = setup('tab-once');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  // The spreadsheet arrives WITH today's tab, so allocation adds none and
  // formats the one it was given - which is why there is no stray `Sheet1`.
  assert.equal(named('addSheetTabWithHeaders').length, 0);
  assert.equal(named('formatJobSheetTab').length, 1);
  assert.deepEqual(titles(state.spreadsheetId), [state.todayTab]);
  assert.match(state.todayTab, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(state.todayTabUrl, /#gid=\d+$/);

  // The second sign-in of the same day. The stored date is what makes this
  // free: without it every sign-in would cost a round trip to list the tabs.
  await sheets.ensureAccountSheet(account);
  assert.equal(named('addSheetTabWithHeaders').length, 0);
  assert.equal(named('formatJobSheetTab').length, 1);
});

test('a new date gets a new tab, beside the old one', async () => {
  const { users, sheets, named, titles } = setup('new-date');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  // Yesterday, as the row would read on the first sign-in of a new day.
  users.recordSheetTabDate(account.id, '01/02/2020');

  await sheets.ensureAccountSheet(account);

  // One call, for the new day. Allocation did not need one.
  assert.equal(named('addSheetTabWithHeaders').length, 1);
  assert.deepEqual(titles(state.spreadsheetId), [state.todayTab]);
  assert.equal(users.getUserById(account.id).sheetTabDate, state.todayTab);
});

test('a tab that already exists in the spreadsheet is skipped, not treated as a failure', async () => {
  const { users, sheets, titles } = setup('tab-exists');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  // The spreadsheet keeps the tab while the row forgets it - which is what a
  // half-finished run, or a hand-made tab, leaves behind.
  users.recordSheetTabDate(account.id, '');

  await sheets.ensureAccountSheet(account);

  assert.deepEqual(titles(state.spreadsheetId), [state.todayTab]);
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

test('a sheet whose owner grant went missing is repaired on the next ensure', async () => {
  // Counted here rather than through `named`, because an override replaces the
  // recording stub - a count taken from the stub would sit at zero and the
  // assertion would pass or fail for the wrong reason.
  let attempts = 0;
  let driveIsEnabled = false;
  const { users, sheets, shares } = setup('grant-repair', {
    async shareSpreadsheetWithEmail(spreadsheetId, email) {
      attempts += 1;
      if (!driveIsEnabled) throw new Error('Drive API has not been enabled for this project.');
      shares.set(spreadsheetId, email);
    },
  });
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  assert.equal(attempts, 1);
  assert.equal(shares.get(state.spreadsheetId), undefined);

  // The likeliest real sequence: somebody enables the Drive API afterwards. The
  // grant has to be retried by something, and nothing else ever would.
  driveIsEnabled = true;
  await sheets.ensureAccountSheet(account);
  assert.equal(attempts, 2);
  assert.equal(shares.get(state.spreadsheetId), 'alice@example.com');

  // And once it is there, it is not asked for again on every sign-in.
  await sheets.ensureAccountSheet(account);
  assert.equal(attempts, 2);
});

test('going private is refused while the owner has no access of their own', async () => {
  const { users, sheets, visibility } = setup('private-lockout', {
    async shareSpreadsheetWithEmail() {
      throw new Error('Drive API has not been enabled for this project.');
    },
  });
  const account = users.createUser({ email: 'alice@example.com' });
  const state = await sheets.ensureAccountSheet(account);

  // Withdrawing the link is the only way in that remains when the personal
  // grant never landed, so this request would lock them out of their own sheet
  // with nothing in the UI able to undo it.
  await assert.rejects(
    () => sheets.setAccountSheetVisibility(users.getUserById(account.id), 'private'),
    /does not have its own access/
  );
  assert.equal(visibility.get(state.spreadsheetId), 'public');

  // Public is still allowed - it takes nothing away.
  assert.equal(await sheets.setAccountSheetVisibility(users.getUserById(account.id), 'public'), 'public');
});

test('going private works normally once the owner holds a grant', async () => {
  const { users, sheets, visibility } = setup('private-ok');
  const account = users.createUser({ email: 'alice@example.com' });
  const state = await sheets.ensureAccountSheet(account);

  assert.equal(await sheets.setAccountSheetVisibility(users.getUserById(account.id), 'private'), 'private');
  assert.equal(visibility.get(state.spreadsheetId), 'private');
});

test('a user can address their own spreadsheet and no other', async () => {
  const { users, sheets } = setup('addressable');
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  const hers = (await sheets.ensureAccountSheet(alice)).spreadsheetId;
  const his = (await sheets.ensureAccountSheet(bob)).spreadsheetId;
  assert.notEqual(hers, his);

  const reload = (account) => users.getUserById(account.id);

  // Naming nothing, and naming her own, both land on her sheet.
  assert.equal(await sheets.resolveAddressableSheet(reload(alice), undefined), hers);
  assert.equal(await sheets.resolveAddressableSheet(reload(alice), hers), hers);

  // Naming his does not. 404 rather than 403: the difference between those two
  // answers is itself a way to ask whether a given spreadsheet exists.
  await assert.rejects(
    () => sheets.resolveAddressableSheet(reload(alice), his),
    (error) => error.status === 404 && /not found/i.test(error.message)
  );
  // Nor does any other id somebody might paste.
  await assert.rejects(() => sheets.resolveAddressableSheet(reload(alice), '1cTf_someone_elses_sheet'), {
    status: 404,
  });
});

test('an admin may address the configured shared sources, a user may not', async () => {
  const { users, sheets } = setup('admin-sources');
  // First account in is the admin.
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  assert.equal(admin.role, 'admin');

  const shared = ['shared-sheet-1', 'shared-sheet-2'];
  assert.equal(
    await sheets.resolveAddressableSheet(users.getUserById(admin.id), 'shared-sheet-1', shared),
    'shared-sheet-1'
  );
  // Same id, same allow-list, ordinary account: still not found.
  await assert.rejects(
    () => sheets.resolveAddressableSheet(users.getUserById(alice.id), 'shared-sheet-1', shared),
    { status: 404 }
  );
  // An id NOT on the list is refused even for the admin.
  await assert.rejects(
    () => sheets.resolveAddressableSheet(users.getUserById(admin.id), 'some-other-sheet', shared),
    { status: 404 }
  );
});

test("naming no tab means today's, and only for the account's own sheet", async () => {
  const { users, sheets } = setup('addressable-tab');
  const admin = users.createUser({ email: 'admin@example.com' });
  const state = await sheets.ensureAccountSheet(admin);
  const account = users.getUserById(admin.id);

  assert.equal(await sheets.resolveAddressableTab(account, state.spreadsheetId, ''), state.todayTab);
  assert.equal(await sheets.resolveAddressableTab(account, state.spreadsheetId, 'Archive'), 'Archive');

  // We do not manage a shared source's layout, so its tab has to be named.
  await assert.rejects(() => sheets.resolveAddressableTab(account, 'shared-sheet-1', ''), {
    status: 400,
  });
});

test('the column map follows the header row rather than repeating it', () => {
  const { JOB_SHEET_HEADERS, JOB_SHEET_COLUMNS, JOB_SHEET_FIRST_DATA_ROW } = require('../dist/integrations/googleSheets');

  // The four the job routes write, at the positions the header row puts them.
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.company - 1], 'Company');
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.jobTitle - 1], 'Job Title');
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.jobLink - 1], 'Job Link');
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.jobDescription - 1], 'Job Description');
  // And the two the filter writes its verdict into.
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.rate - 1], 'Rate');
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.note - 1], 'note');
  assert.equal(JOB_SHEET_FIRST_DATA_ROW, 2);
});

test('an export with no start row appends instead of overwriting the morning', () => {
  const { resolveAppendRow, resolveColumn } = require('../dist/services/sheets/jobSheetTarget');
  const { JOB_SHEET_COLUMNS } = require('../dist/integrations/googleSheets');

  // Empty tab: the first data row.
  assert.equal(resolveAppendRow(undefined, [{ values: [] }]), 2);
  // A header plus three rows already written: the fourth.
  assert.equal(resolveAppendRow(undefined, [{ values: ['h', 'a', 'b', 'c'] }, { values: ['h', 'a'] }]), 5);
  // An explicit choice still wins.
  assert.equal(resolveAppendRow(40, [{ values: ['h', 'a'] }]), 40);

  assert.equal(resolveColumn(undefined, JOB_SHEET_COLUMNS.company), JOB_SHEET_COLUMNS.company);
  assert.equal(resolveColumn(7, JOB_SHEET_COLUMNS.company), 7);
  assert.equal(resolveColumn('not a column', JOB_SHEET_COLUMNS.jobLink), JOB_SHEET_COLUMNS.jobLink);
});

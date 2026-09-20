const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

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
  useAdminEmails('admin@example.com');
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

test('a new date gets a new tab, and BESIDE the old one', async () => {
  const { users, sheets, named, titles, tabs } = setup('new-date');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);

  // A real previous day, present in the spreadsheet - not just a stale date on
  // the row. Without this the test could not tell "added a tab" from "replaced
  // the only tab", and a rewrite that deleted yesterday would still pass.
  const yesterday = '01/02/2020';
  tabs.get(state.spreadsheetId).set(yesterday, 999);
  users.recordSheetTabDate(account.id, yesterday);

  await sheets.ensureAccountSheet(account);

  assert.equal(named('addSheetTabWithHeaders').length, 1);
  assert.deepEqual(titles(state.spreadsheetId).sort(), [yesterday, state.todayTab].sort());
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

test('two calls racing join rather than each creating a spreadsheet', async () => {
  const { users, sheets, named } = setup('race');
  const account = users.createUser({ email: 'alice@example.com' });

  const [first, second] = await Promise.all([
    sheets.ensureAccountSheet(account),
    sheets.ensureAccountSheet(account),
  ]);

  // The in-flight join: the second caller got the first one's promise, so only
  // one conversation with Google happened at all.
  assert.equal(named('createSpreadsheet').length, 1);
  assert.equal(first.spreadsheetId, second.spreadsheetId);
});

test('a genuine race - two creates, one winner - leaves the loser adopting the winner', async () => {
  // The join above is the usual defence. This is the one underneath it: two
  // callers that BOTH reached Google before either wrote. Forced by holding the
  // first create open until the second has started, which the in-flight map
  // cannot prevent because the map is bypassed here on purpose.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const { users, sheets } = setup('race-real', {
    async createSpreadsheet(title, firstTabTitle) {
      started += 1;
      const mine = started;
      if (mine === 1) await held;
      return {
        spreadsheetId: `sheet-${mine}`,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/sheet-${mine}/edit`,
        firstTabGid: 10 + mine,
      };
    },
  });
  const account = users.createUser({ email: 'alice@example.com' });

  // Two separate ensures, not two handles on one.
  const slow = sheets.ensureAccountSheet(account);
  await new Promise((resolve) => setImmediate(resolve));
  sheets.resetInFlightForTests();
  const fast = sheets.ensureAccountSheet(users.getUserById(account.id));
  await fast;
  release();
  const slowState = await slow;

  // Counted by the override itself: `named` reads the recording stub, which an
  // override replaces - so it would sit at zero and prove nothing.
  assert.equal(started, 2, 'both callers really did create one');

  // One id is stored, and BOTH callers report it - the loser must adopt the
  // winner's sheet rather than keep the orphan it just made.
  const stored = users.getUserById(account.id).sheetId;
  assert.equal((await fast).spreadsheetId, stored);
  assert.equal(slowState.spreadsheetId, stored);
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
  // its heading is matching the string a person reads on screen. The first
  // eight are the tracking sheet's own; the last two belong to the job filter,
  // which needed somewhere to write that was not a field somebody fills in.
  assert.deepEqual(
    [...JOB_SHEET_HEADERS],
    [
      'NO(DATE)',
      'Company',
      'Job Title',
      'Job Link',
      'Job Description',
      'Rate',
      'note',
      'Job Finder',
      'Filter Result',
      'Filter Reason',
    ]
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
  const { users, sheets, shares, named } = setup('grant-repair', {
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

  // And once it is there, it is not asked for again on every sign-in - not the
  // share, and not even the cheaper "does it already have one?" check, which is
  // itself a Drive call and was being spent on every sign-in.
  const asked = named('hasPersonalGrant').length;
  await sheets.ensureAccountSheet(account);
  assert.equal(attempts, 2);
  assert.equal(named('hasPersonalGrant').length, asked, 'Drive was asked again for a settled grant');
});

test('a repeat sign-in on a day already prepared costs no Google calls at all', async () => {
  const { users, sheets, calls } = setup('warm-path-free');
  const account = users.createUser({ email: 'alice@example.com' });

  await sheets.ensureAccountSheet(account);

  // The claim the module makes about itself, pinned. Everything the second
  // sign-in needs - which sheet, which tab, whether the owner can open it - is
  // already on the row, so the only thing left is the filesystem check for the
  // key. A thousand users signing in at nine in the morning cost nothing.
  calls.length = 0;
  await sheets.ensureAccountSheet(users.getUserById(account.id));

  assert.deepEqual(
    calls.map((call) => call[0]),
    ['isConfigured'],
    `expected only the local key check, got ${JSON.stringify(calls.map((c) => c[0]))}`
  );
});

test('going private still asks Drive every time, however settled the grant looks', async () => {
  const { users, sheets, named } = setup('private-checks-live');
  const account = users.createUser({ email: 'alice@example.com' });
  await sheets.ensureAccountSheet(account);

  // The one request that can lock somebody out of their own spreadsheet, so it
  // is the one place a remembered answer is not good enough: the grant may have
  // been revoked in Google's own UI since we wrote it down.
  const before = named('hasPersonalGrant').length;
  await sheets.setAccountSheetVisibility(users.getUserById(account.id), 'private');
  assert.ok(
    named('hasPersonalGrant').length > before,
    'the private toggle must confirm access live, not from the stored flag'
  );
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
  // And the two the filter writes its verdict into - which must NOT be Rate,
  // note or Job Finder, because those are fields somebody types into and a
  // verdict written there would destroy what was in them.
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.filterResult - 1], 'Filter Result');
  assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS.filterReason - 1], 'Filter Reason');
  for (const owned of [JOB_SHEET_COLUMNS.rate, JOB_SHEET_COLUMNS.note, JOB_SHEET_COLUMNS.jobFinder]) {
    assert.notEqual(owned, JOB_SHEET_COLUMNS.filterResult);
    assert.notEqual(owned, JOB_SHEET_COLUMNS.filterReason);
  }
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

  assert.equal(resolveColumn('Company column', undefined, JOB_SHEET_COLUMNS.company), JOB_SHEET_COLUMNS.company);
  assert.equal(resolveColumn('Company column', 7, JOB_SHEET_COLUMNS.company), 7);

  // Supplied but wrong is a 400, NOT a quiet fall back to the default. The
  // difference matters: a caller sending a 0-based index used to be refused,
  // and substituting a column they did not ask for would write into it instead.
  for (const bad of ['not a column', 0, -3, 1.5]) {
    assert.throws(
      () => resolveColumn('Job link column', bad, JOB_SHEET_COLUMNS.jobLink),
      (error) => error.status === 400 && /Job link column/.test(error.message),
      `expected a 400 for ${JSON.stringify(bad)}`
    );
  }
  assert.throws(() => resolveAppendRow(0, [{ values: [] }]), { status: 400 });
});

test('a Google 403 names its own remedy instead of "caller does not have permission"', () => {
  const { describeGoogleFailure } = require('../dist/integrations/googleSheets');

  // The body Google actually sends when an API is switched off. The bare
  // message is true of every possible cause and useful for none of them; the
  // reason and the activation URL are the parts worth keeping.
  const disabled = {
    error: {
      code: 403,
      message: 'Google Drive API has not been used in project 12345 before or it is disabled.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE_DISABLED',
          metadata: {
            service: 'drive.googleapis.com',
            consumer: 'projects/12345',
            activationUrl: 'https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=12345',
          },
        },
      ],
    },
  };
  const said = describeGoogleFailure(403, disabled, 'create a spreadsheet');
  assert.match(said, /drive\.googleapis\.com is switched off for project 12345/);
  assert.match(said, /console\.developers\.google\.com/);

  // A scope problem, which reads identically from outside without this.
  const scope = { error: { message: 'Request had insufficient authentication scopes.',
    details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } };
  assert.match(describeGoogleFailure(403, scope, 'share a spreadsheet'), /scope needed to share/);

  // A full Drive, which is its own thing entirely.
  const quota = { error: { message: 'Quota exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } };
  assert.match(describeGoogleFailure(403, quota, 'create a spreadsheet'), /Drive is full/);

  // The bare 403 from the log that prompted all this: no reason at all, so the
  // remedy is inferred from what the call was doing.
  const bare = { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } };
  const inferred = describeGoogleFailure(403, bare, 'create a spreadsheet');
  assert.match(inferred, /The caller does not have permission/);
  assert.match(inferred, /Drive API must be enabled/);
  assert.match(inferred, /sheets:doctor/);
});

test("an unrecognised failure keeps Google's own words rather than guessing", () => {
  const { describeGoogleFailure } = require('../dist/integrations/googleSheets');

  // The rule that keeps this helper honest: add a remedy where one is known,
  // never replace a specific message with a general one.
  const odd = { error: { code: 400, message: 'Unable to parse range: NotATab!A1' } };
  assert.equal(describeGoogleFailure(400, odd, 'read a range'), 'Unable to parse range: NotATab!A1');

  // And a body that is not JSON at all still says something with the status in it.
  assert.match(describeGoogleFailure(502, null, 'read a range'), /HTTP 502/);
});

test('a tab headered by an older build is detected as needing the new columns', () => {
  const { jobSheetHeaderIsCurrent, JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');

  // What every sheet created before the filter had columns of its own looks
  // like. Without this returning false those two columns stay blank forever,
  // because the tab already exists and nothing would write a header again.
  const oldBuild = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder'];
  assert.equal(jobSheetHeaderIsCurrent(oldBuild), false);

  // The current one is left alone - re-writing it on every sign-in would undo
  // a column somebody had widened and spend a write call a day for nothing.
  assert.equal(jobSheetHeaderIsCurrent([...JOB_SHEET_HEADERS]), true);
  // Extra columns of somebody's own past the header do not make it stale.
  assert.equal(jobSheetHeaderIsCurrent([...JOB_SHEET_HEADERS, 'my own column']), true);

  // A tab created and then never formatted - the interrupted allocation.
  assert.equal(jobSheetHeaderIsCurrent([]), false);
  // And one whose spelling drifted.
  const misspelled = [...JOB_SHEET_HEADERS];
  misspelled[6] = 'Note';
  assert.equal(jobSheetHeaderIsCurrent(misspelled), false);
});

test('a refusal names the credential that was refused, not just the refusal', async () => {
  const { describeGoogleFailure } = require('../dist/integrations/googleSheets');

  // The gap this closes: a 403 reports what Google would not do and never
  // whose key asked. Somebody who has just swapped a key and sees the SAME
  // error cannot tell whether the new project is misconfigured or whether the
  // new key is not the one being used - which are opposite problems.
  const bare = { error: { code: 403, message: 'The caller does not have permission' } };
  const said = describeGoogleFailure(403, bare, 'create a spreadsheet');

  // The pure describer still says only what it can know.
  assert.match(said, /The caller does not have permission/);
  assert.match(said, /Drive API must be enabled/);
  assert.doesNotMatch(said, /Asked with/);
});

test('several key files on disk are reported rather than silently ranked', async () => {
  const fs = require('fs');
  const os = require('os');
  const nodePath = require('path');
  const { loadFresh } = require('./helpers');

  // Five paths are searched and the FIRST wins. Two keys on disk - an old one
  // at the repo root and the new one in backend/ - is the trap: the new key is
  // ignored and nothing says so, and the 403 that follows sends somebody to
  // check the new project's settings instead of which key is loaded.
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tailor-keys-'));
  fs.mkdirSync(nodePath.join(root, 'backend'), { recursive: true });
  const first = nodePath.join(root, 'service-account-key.json');
  const second = nodePath.join(root, 'backend', 'service-account-key.json');
  fs.writeFileSync(first, '{}');
  fs.writeFileSync(second, '{}');

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const sheets = loadFresh('../dist/integrations/googleSheets');
    const chosen = await sheets.resolveCredentialPath();
    assert.equal(chosen, first, 'the first candidate still wins - only the silence changes');
    const said = warnings.join('\n');
    assert.match(said, /2 Google credential files were found/);
    assert.match(said, /USING/);
    assert.match(said, /ignored/);
  } finally {
    process.chdir(cwd);
    console.warn = realWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('going private invites the owner BEFORE it withdraws the link', async () => {
  const order = [];
  const { users, sheets } = setup('private-order', {
    async shareSpreadsheetWithEmail(spreadsheetId, email) {
      order.push(`share:${email}`);
    },
    async hasPersonalGrant() {
      order.push('check');
      // Never confirmed, so the invite is attempted on the way through - the
      // sequence this test is about.
      return false;
    },
    async setSpreadsheetVisibility(spreadsheetId, next) {
      order.push(`visibility:${next}`);
      return next;
    },
  });
  const account = users.createUser({ email: 'alice@example.com' });
  await sheets.ensureAccountSheet(account);

  order.length = 0;
  await sheets.setAccountSheetVisibility(users.getUserById(account.id), 'private');

  // The order is the whole safety property. Withdrawing the link first, then
  // failing to invite, leaves somebody locked out of their own spreadsheet with
  // no way back through the UI.
  assert.deepEqual(order, ['check', 'share:alice@example.com', 'visibility:private']);
});

test('the owner is invited as a WRITER, on the file, by email', async () => {
  // Checked against the real request rather than the fake, because the role is
  // decided in the integration and a fake cannot get it wrong. "Invite them as
  // an editor" is the requirement; `reader` would satisfy every other test here
  // and still be wrong.
  const fs = require('fs');
  const os = require('os');
  const nodePath = require('path');
  const { loadFresh } = require('./helpers');

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tailor-share-'));
  fs.writeFileSync(
    nodePath.join(dir, 'google-oauth-credentials.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'id',
      client_secret: 'secret',
      refresh_token: 'refresh',
    })
  );

  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 204 });
  };

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const sheets = loadFresh('../dist/integrations/googleSheets');
    await sheets.shareSpreadsheetWithEmail('sheet-1', 'alice@example.com');

    const share = requests.find((entry) => entry.url.includes('/permissions'));
    assert.ok(share, 'no Drive permissions request was made');
    assert.match(share.url, /\/files\/sheet-1\/permissions/);
    assert.equal(share.init.method, 'POST');

    const body = JSON.parse(share.init.body);
    assert.deepEqual(body, { role: 'writer', type: 'user', emailAddress: 'alice@example.com' });

    // And no mail about it: this runs during sign-in, and the app is about to
    // show them the link anyway.
    assert.match(share.url, /sendNotificationEmail=false/);
  } finally {
    process.chdir(cwd);
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('going private withdraws only the link, leaving the owner their grant', async () => {
  const revoked = [];
  const permissions = [
    { id: 'anyone-1', type: 'anyone', role: 'writer' },
    { id: 'owner-1', type: 'user', role: 'writer', emailAddress: 'alice@example.com' },
  ];

  const fs = require('fs');
  const os = require('os');
  const nodePath = require('path');
  const { loadFresh } = require('./helpers');

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tailor-revoke-'));
  fs.writeFileSync(
    nodePath.join(dir, 'google-oauth-credentials.json'),
    JSON.stringify({ type: 'authorized_user', client_id: 'i', client_secret: 's', refresh_token: 'r' })
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.method === 'DELETE') {
      revoked.push(href.split('/permissions/')[1].split('?')[0]);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ permissions }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const sheets = loadFresh('../dist/integrations/googleSheets');
    assert.equal(await sheets.setSpreadsheetVisibility('sheet-1', 'private'), 'private');

    // Only the anyone-with-the-link grant goes. The owner's own grant is what
    // keeps them able to open it at all, so revoking it would be the lockout
    // the whole refusal path exists to prevent.
    assert.deepEqual(revoked, ['anyone-1']);
  } finally {
    process.chdir(cwd);
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

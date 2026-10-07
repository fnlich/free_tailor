const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * One spreadsheet per account, with its All and Temp For AI tabs.
 *
 * Every claim here is about NOT doing something twice - or at all. A second
 * spreadsheet for an account is invisible - the first one keeps working, and
 * the rows somebody typed are simply in a file nothing links to any more - and
 * a tab of the person's own, or an older build's daily tab, must never be
 * touched. So the duplicate and the hands-off cases are the ones worth pinning
 * down rather than the happy path.
 *
 * The Google calls are a fake, injected through `setSheetsClientForTests`. What
 * is being tested is the decision to call, not the HTTP.
 */

const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');
const OLD_DAILY_HEADER = ['NO(DATE)', 'Company', 'Job Title', 'Job Link', 'Job Description', 'Rate', 'note', 'Job Finder'];

/**
 * A spreadsheet service that remembers everything, so the tests can count
 * calls. Each tab has a row 1 (`header`): a tab added by the app gets the job
 * header; one added by `addTab` whatever the test says. A tab whose row 1 is
 * not the job header and is not wholly empty is not a job tab, which is what
 * the real `addSheetTabWithHeaders` reports (`jobTab: false`) for it.
 */
function makeClient(overrides = {}) {
  const calls = [];
  /** spreadsheetId -> [{ title, gid, header, empty }] in tab order. */
  const tabs = new Map();
  const visibility = new Map();
  const shares = new Map();
  let minted = 0;
  let nextGid = 100;
  const isJob = (tab) =>
    JOB_SHEET_HEADERS.slice(0, 6).every((header, index) => tab.header[index] === header) ||
    (tab.header.length === 0 && tab.empty !== false);

  const client = {
    async isConfigured() {
      calls.push(['isConfigured']);
      return true;
    },
    async checkCredential() {
      calls.push(['checkCredential']);
    },
    async createSpreadsheet(title, firstTabTitle) {
      calls.push(['createSpreadsheet', title, firstTabTitle]);
      minted += 1;
      const spreadsheetId = `sheet-${minted}`;
      const firstTabGid = (nextGid += 1);
      // Created WITH its first tab, which is what keeps Google's default
      // `Sheet1` out of the file - the fake models that, not an empty file.
      // Unformatted until formatJobSheetTab lays it out.
      tabs.set(spreadsheetId, [{ title: firstTabTitle, gid: firstTabGid, header: [] }]);
      visibility.set(spreadsheetId, 'private');
      return {
        spreadsheetId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        firstTabGid,
      };
    },
    async formatJobSheetTab(spreadsheetId, gid) {
      calls.push(['formatJobSheetTab', spreadsheetId, gid]);
      const tab = (tabs.get(spreadsheetId) ?? []).find((entry) => entry.gid === gid);
      if (tab) tab.header = [...JOB_SHEET_HEADERS];
    },
    async addSheetTabWithHeaders(spreadsheetId, title, options = {}) {
      calls.push(['addSheetTabWithHeaders', spreadsheetId, title, options.index]);
      const list = tabs.get(spreadsheetId) ?? [];
      tabs.set(spreadsheetId, list);
      const existing = list.find((tab) => tab.title === title);
      // `created: false` means "already there", not "failed" - and a tab that
      // is not a job tab is reported, never touched.
      if (existing) {
        if (!isJob(existing)) return { gid: existing.gid, created: false, protection: 'unconfirmed', jobTab: false };
        existing.header = [...JOB_SHEET_HEADERS];
        return { gid: existing.gid, created: false, protection: 'intact', jobTab: true };
      }
      const gid = (nextGid += 1);
      const at = typeof options.index === 'number' ? Math.min(options.index, list.length) : list.length;
      list.splice(at, 0, { title, gid, header: [...JOB_SHEET_HEADERS] });
      return { gid, created: true, protection: 'added', jobTab: true };
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
    async listSheetTabs(spreadsheetId) {
      calls.push(['listSheetTabs', spreadsheetId]);
      return (tabs.get(spreadsheetId) ?? []).map(({ title, gid }) => ({ title, gid }));
    },
    async readRanges(spreadsheetId, ranges) {
      calls.push(['readRanges', spreadsheetId, ranges]);
      return ranges.map((range) => {
        const title = /^'(.*)'!1:1$/.exec(range)[1].replace(/''/g, "'");
        const tab = (tabs.get(spreadsheetId) ?? []).find((entry) => entry.title === title);
        return tab && tab.header.length ? [tab.header] : [];
      });
    },
    ...overrides,
  };

  const named = (name) => calls.filter((call) => call[0] === name);
  const titles = (spreadsheetId) => (tabs.get(spreadsheetId) ?? []).map((tab) => tab.title);
  /** A tab put into a spreadsheet the way a person, or an older build, would have. */
  const addTab = (spreadsheetId, title, header, { at, empty } = {}) => {
    const list = tabs.get(spreadsheetId) ?? [];
    tabs.set(spreadsheetId, list);
    const tab = { title, gid: (nextGid += 1), header, ...(empty === undefined ? {} : { empty }) };
    list.splice(at ?? list.length, 0, tab);
    return tab;
  };
  return { client, calls, named, tabs, titles, addTab, visibility, shares };
}

/**
 * An account whose sheet an older build allocated: daily tabs in the old
 * layout, and the row as that build left it (sheet_tab_date set, no layout).
 */
function olderBuildSheet(users, fake, account, extraTabs = []) {
  const spreadsheetId = 'old-sheet';
  users.recordAccountSheet(account.id, spreadsheetId, `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  users.recordOwnerGrant(account.id, '2026-09-01T00:00:00.000Z');
  fake.shares.set(spreadsheetId, account.email);
  const { getDb } = require('../dist/database/sqlite');
  getDb().prepare("UPDATE users SET sheet_tab_date = '10/05/2026', sheet_tab_gid = '55' WHERE id = ?").run(account.id);
  fake.addTab(spreadsheetId, '10/04/2026', OLD_DAILY_HEADER);
  fake.addTab(spreadsheetId, '10/05/2026', OLD_DAILY_HEADER);
  for (const [title, header, options] of extraTabs) fake.addTab(spreadsheetId, title, header, options);
  return spreadsheetId;
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

test('a new spreadsheet is shared with its owner and NOT link-shared', async () => {
  const { users, sheets, shares, visibility, calls } = setup('shared-private');
  delete process.env.SHEET_DEFAULT_VISIBILITY;
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);

  // The grant that matters: the account holder can open their own sheet.
  assert.equal(shares.get(state.spreadsheetId), 'alice@example.com');

  /*
   * Private by default, and `public` on this app's Drive means anyone with the
   * link may EDIT somebody's job search. The owner loses nothing - the writer
   * grant above is their access - and anyone who wants a shareable link presses
   * the toggle.
   */
  assert.equal(visibility.get(state.spreadsheetId), 'private');
  // And no Drive call is made to achieve it: a new file has no `anyone` grant to
  // revoke, so asking for 'private' would be a round trip that can only fail.
  assert.ok(
    !calls.some(([name]) => name === 'setSpreadsheetVisibility'),
    'allocation must not touch sharing at all when the default is private'
  );
});

test('SHEET_DEFAULT_VISIBILITY=public restores link sharing for anyone who wants it', async () => {
  const { users, sheets, visibility, calls } = setup('shared-public-optin');
  process.env.SHEET_DEFAULT_VISIBILITY = 'public';
  try {
    const account = users.createUser({ email: 'alice@example.com' });
    const state = await sheets.ensureAccountSheet(account);

    assert.equal(visibility.get(state.spreadsheetId), 'public');
    assert.deepEqual(
      calls.filter(([name]) => name === 'setSpreadsheetVisibility'),
      [['setSpreadsheetVisibility', state.spreadsheetId, 'public']]
    );
  } finally {
    delete process.env.SHEET_DEFAULT_VISIBILITY;
  }
});

test('a value nobody meant resolves to private, which is the safe direction', async () => {
  const { users, sheets, visibility } = setup('shared-junk');
  // Casing counts: only the exact string opens a sheet up, because the unsafe
  // answer cannot be taken back once a link is out.
  process.env.SHEET_DEFAULT_VISIBILITY = 'PUBLIC';
  try {
    const account = users.createUser({ email: 'alice@example.com' });
    const state = await sheets.ensureAccountSheet(account);
    assert.equal(visibility.get(state.spreadsheetId), 'private');
  } finally {
    delete process.env.SHEET_DEFAULT_VISIBILITY;
  }
});

test('a new sheet is made with All first and Temp For AI second, both laid out, and never asked about again', async () => {
  const { users, sheets, named, titles } = setup('tabs-once');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);
  // The spreadsheet arrives WITH All, so there is no stray `Sheet1`: it is
  // formatted, and Temp For AI is added second.
  assert.deepEqual(named('createSpreadsheet').map((call) => call[2]), ['All']);
  assert.equal(named('formatJobSheetTab').length, 1);
  assert.deepEqual(named('addSheetTabWithHeaders').map((call) => [call[2], call[3]]), [['Temp For AI', 1]]);
  assert.deepEqual(titles(state.spreadsheetId), ['All', 'Temp For AI']);
  assert.equal(state.defaultTab, 'All');
  assert.equal(state.tempTab, 'Temp For AI');
  assert.match(state.defaultTabUrl, /#gid=\d+$/);
  assert.match(state.tempTabUrl, /#gid=\d+$/);
  assert.notEqual(state.defaultTabUrl, state.tempTabUrl);
  assert.equal(state.conflict, undefined);
  assert.equal(users.getUserById(account.id).sheetLayout, 2);
  // The older build's daily-tab cache is never written, so a rollback finds it as it was.
  const { getDb } = require('../dist/database/sqlite');
  assert.deepEqual(getDb().prepare('SELECT sheet_tab_date, sheet_tab_gid FROM users WHERE id = ?').get(account.id), {
    sheet_tab_date: null,
    sheet_tab_gid: null,
  });

  // The second sign-in. The stored layout is what makes this free: without
  // it every sign-in would cost a round trip to list the tabs.
  await sheets.ensureAccountSheet(account);
  assert.equal(named('addSheetTabWithHeaders').length, 1);
  assert.equal(named('formatJobSheetTab').length, 1);
  assert.equal(named('listSheetTabs').length, 0);
});

test("a sheet an older build laid out by day gets All and Temp For AI in front, and its daily tabs are never touched", async () => {
  const fake = setup('upgrade');
  const { users, sheets, named, titles, tabs, calls } = fake;
  const account = users.createUser({ email: 'alice@example.com' });
  const id = olderBuildSheet(users, fake, account, [['Notes', ['My', 'own', 'header']]]);

  const state = await sheets.ensureAccountSheet(users.getUserById(account.id));
  assert.equal(named('createSpreadsheet').length, 0, 'the sheet is kept');
  assert.deepEqual(titles(id), ['All', 'Temp For AI', '10/04/2026', '10/05/2026', 'Notes']);
  // Only the two tabs are asked for; the daily tabs and Notes are not named
  // in any call, and their row 1 is what it was.
  assert.deepEqual(named('addSheetTabWithHeaders').map((call) => [call[2], call[3]]), [['All', 0], ['Temp For AI', 1]]);
  assert.equal(named('listSheetTabs').length, 1, 'one listing for both');
  for (const title of ['10/04/2026', '10/05/2026']) {
    assert.deepEqual(tabs.get(id).find((tab) => tab.title === title).header, OLD_DAILY_HEADER, title);
  }
  assert.ok(!calls.some((call) => JSON.stringify(call).includes('10/05/2026')), 'no call names a daily tab');
  assert.equal(state.defaultTab, 'All');
  assert.match(state.defaultTabUrl, /#gid=\d+$/);
  assert.equal(state.conflict, undefined);

  const row = users.getUserById(account.id);
  assert.equal(row.sheetLayout, 2);
  const { getDb } = require('../dist/database/sqlite');
  assert.deepEqual(getDb().prepare('SELECT sheet_tab_date, sheet_tab_gid FROM users WHERE id = ?').get(account.id), {
    sheet_tab_date: '10/05/2026',
    sheet_tab_gid: '55',
  }, "the older build's cache, untouched");

  // Laid out once: the next sign-in asks Google nothing.
  calls.length = 0;
  await sheets.ensureAccountSheet(users.getUserById(account.id));
  assert.deepEqual(calls.map((call) => call[0]), ['isConfigured']);
});

test('an All already there is used when it is a job tab (or empty), and reported, untouched, when it is not', async () => {
  const fake = setup('clash');
  const { users, sheets, named, titles, tabs, calls } = fake;
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const carol = users.createUser({ email: 'carol@example.com' });

  // Alice's "All" is a tab of her own: a name clash.
  const hers = olderBuildSheet(users, fake, alice, [['All', ['Company', 'Notes'], { at: 0 }]]);
  const herAll = tabs.get(hers)[0];
  const state = await sheets.ensureAccountSheet(users.getUserById(alice.id));
  // Temp For AI goes first while All cannot be placed, so the All added later lands it second.
  assert.deepEqual(titles(hers), ['Temp For AI', 'All', '10/04/2026', '10/05/2026']);
  assert.deepEqual(herAll.header, ['Company', 'Notes'], 'left exactly as it was');
  assert.deepEqual(state.conflict.tabs, ['All']);
  assert.match(state.conflict.message, /already has a tab named "All" that is not laid out as a job tab/);
  assert.equal(state.defaultTabUrl, undefined, 'no link to a tab that is not the job tab');
  assert.match(state.tempTabUrl, /#gid=\d+$/);
  assert.equal(users.getUserById(alice.id).sheetLayout, 2);

  // A sign-in reports it from the row, asking Google nothing...
  calls.length = 0;
  assert.deepEqual((await sheets.ensureAccountSheet(users.getUserById(alice.id))).conflict.tabs, ['All']);
  assert.deepEqual(calls.map((call) => call[0]), ['isConfigured']);
  // ...and so does every page that reads the sheet without asking for a look - the shell, on every page load.
  calls.length = 0;
  assert.deepEqual((await sheets.describeAccountSheet(users.getUserById(alice.id))).conflict.tabs, ['All']);
  assert.deepEqual(calls.map((call) => call[0]), ['isConfigured', 'getSpreadsheetVisibility'], 'no listing, no read of her tab');
  // The Job Sheet page asks for a look: still hers, still left alone.
  assert.deepEqual((await sheets.describeAccountSheet(users.getUserById(alice.id), { recheck: true })).conflict.tabs, ['All']);
  assert.equal(named('listSheetTabs').length, 1);
  // Renamed in Google Sheets: the next look adds the job tab, first, with Temp For AI second.
  herAll.title = 'My All';
  assert.ok((await sheets.describeAccountSheet(users.getUserById(alice.id))).conflict, 'not without a look');
  const fixed = await sheets.describeAccountSheet(users.getUserById(alice.id), { recheck: true });
  assert.equal(fixed.conflict, undefined);
  assert.match(fixed.defaultTabUrl, /#gid=\d+$/);
  assert.deepEqual(titles(hers).slice(0, 3), ['All', 'Temp For AI', 'My All']);

  // Bob's "All" is wholly empty: it becomes the job tab, under that name.
  const his = 'bob-sheet';
  users.recordAccountSheet(bob.id, his, 'https://docs.google.com/spreadsheets/d/bob-sheet/edit');
  users.recordOwnerGrant(bob.id, '2026-09-01T00:00:00.000Z');
  fake.addTab(his, 'All', [], { empty: true });
  const bobs = await sheets.ensureAccountSheet(users.getUserById(bob.id));
  assert.equal(bobs.conflict, undefined);
  assert.deepEqual(titles(his), ['All', 'Temp For AI']);
  assert.deepEqual(tabs.get(his)[0].header, [...JOB_SHEET_HEADERS]);

  // Carol's has data under a blank row 1: not converted - a clash.
  const theirs = 'carol-sheet';
  users.recordAccountSheet(carol.id, theirs, 'https://docs.google.com/spreadsheets/d/carol-sheet/edit');
  users.recordOwnerGrant(carol.id, '2026-09-01T00:00:00.000Z');
  fake.addTab(theirs, 'Temp For AI', [], { empty: false });
  const carols = await sheets.ensureAccountSheet(users.getUserById(carol.id));
  assert.deepEqual(carols.conflict.tabs, ['Temp For AI']);
  assert.deepEqual(tabs.get(theirs).find((tab) => tab.title === 'Temp For AI').header, []);
  assert.equal(named('createSpreadsheet').length, 0);
});

test('a clash behind an older build\'s daily tab ends All first and Temp For AI second, however it is resolved', async (t) => {
  for (const resolve of ['rename', 'delete']) {
    await t.test(resolve, async () => {
      const fake = setup(`clash-order-${resolve}`);
      const { users, sheets, titles, tabs } = fake;
      const alice = users.createUser({ email: 'alice@example.com' });
      // The daily tabs first, then Notes, then her own All, then Scratch.
      const hers = olderBuildSheet(users, fake, alice, [
        ['Notes', ['My', 'own', 'header']],
        ['All', ['Company', 'Notes']],
        ['Scratch', ['x']],
      ]);
      const upgraded = await sheets.ensureAccountSheet(users.getUserById(alice.id));
      assert.deepEqual(upgraded.conflict.tabs, ['All']);
      assert.deepEqual(titles(hers), ['Temp For AI', '10/04/2026', '10/05/2026', 'Notes', 'All', 'Scratch']);

      const list = tabs.get(hers);
      const herAll = list.find((tab) => tab.title === 'All');
      if (resolve === 'rename') herAll.title = 'My All';
      else list.splice(list.indexOf(herAll), 1);
      const fixed = await sheets.describeAccountSheet(users.getUserById(alice.id), { recheck: true });
      assert.equal(fixed.conflict, undefined);
      assert.deepEqual(titles(hers).slice(0, 4), ['All', 'Temp For AI', '10/04/2026', '10/05/2026']);
      assert.deepEqual(list.find((tab) => tab.title === '10/05/2026').header, OLD_DAILY_HEADER, 'the daily tab untouched');
    });
  }
});

test('a look at a clash that Google refuses still answers, from the row - and the clash is logged once, not at every look', async () => {
  const fake = setup('clash-recheck-fails');
  const { users, sheets, client } = fake;
  const alice = users.createUser({ email: 'alice@example.com' });
  const hers = olderBuildSheet(users, fake, alice, [['All', ['Company', 'Notes'], { at: 0 }]]);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await sheets.ensureAccountSheet(users.getUserById(alice.id));
    const clashLines = () => warnings.filter((line) => line.includes('already has a tab named "All"'));
    assert.equal(clashLines().length, 1, 'said when found');
    await sheets.describeAccountSheet(users.getUserById(alice.id), { recheck: true });
    await sheets.describeAccountSheet(users.getUserById(alice.id), { recheck: true });
    assert.equal(clashLines().length, 1, 'not again at every look while it stays');

    client.listSheetTabs = async () => {
      throw Object.assign(new Error('The caller does not have permission'), { status: 403 });
    };
    const state = await sheets.describeAccountSheet(users.getUserById(alice.id), { recheck: true });
    assert.deepEqual(state.conflict.tabs, ['All'], 'the clash still reported');
    assert.equal(state.spreadsheetId, hers, 'and the sheet still linked');
    assert.equal(state.visibility, 'private');
    assert.ok(warnings.some((line) => line.includes("Could not look at alice@example.com's job sheet tabs again")));
  } finally {
    console.warn = realWarn;
  }
});

test('a verifying call puts back an All somebody deleted, and trusts one still under its recorded gid', async () => {
  const { users, sheets, named, tabs, titles } = setup('verify-tab');
  const account = users.createUser({ email: 'alice@example.com' });
  const state = await sheets.ensureAccountSheet(account);

  const listed = named('listSheetTabs').length;
  await sheets.ensureAccountSheet(users.getUserById(account.id), { verifyTab: true });
  assert.equal(named('listSheetTabs').length, listed + 1, 'one listing');
  assert.equal(named('addSheetTabWithHeaders').length, 1, 'and nothing added or verified: both are where they were');

  tabs.set(state.spreadsheetId, tabs.get(state.spreadsheetId).filter((tab) => tab.title !== 'All'));
  const again = await sheets.ensureAccountSheet(users.getUserById(account.id), { verifyTab: true });
  assert.deepEqual(titles(state.spreadsheetId), ['All', 'Temp For AI']);
  assert.notEqual(again.defaultTabUrl, state.defaultTabUrl, 'the new tab\'s gid');
});

test('the Job Sheet page\'s look puts back an All or Temp For AI deleted under a recorded layout - with no clash recorded, which is how a reporter (no export) gets theirs back', async () => {
  const { users, sheets, named, tabs, titles, calls } = setup('recheck-deleted');
  const rita = users.createUser({ email: 'rita@example.com', role: 'reporter' });
  const state = await sheets.ensureAccountSheet(rita);
  const id = state.spreadsheetId;
  assert.equal(state.conflict, undefined);

  // Both there: the look is ONE listing, and nothing is added or verified.
  calls.length = 0;
  const looked = await sheets.describeAccountSheet(users.getUserById(rita.id), { recheck: true });
  assert.deepEqual(calls.map((call) => call[0]), ['isConfigured', 'isConfigured', 'listSheetTabs', 'getSpreadsheetVisibility']);
  assert.equal(looked.defaultTabUrl, state.defaultTabUrl);

  // All deleted in Google Sheets. Nothing in the row says so: the shell's
  // read (no look) still answers the gone tab's link, asking Google nothing...
  tabs.set(id, tabs.get(id).filter((tab) => tab.title !== 'All'));
  calls.length = 0;
  const shell = await sheets.describeAccountSheet(users.getUserById(rita.id));
  assert.equal(shell.defaultTabUrl, state.defaultTabUrl);
  assert.equal(named('listSheetTabs').length, 0);
  // ...and the Job Sheet page's look puts it back, first, and links to it.
  const fixed = await sheets.describeAccountSheet(users.getUserById(rita.id), { recheck: true });
  assert.deepEqual(titles(id), ['All', 'Temp For AI']);
  assert.deepEqual(named('addSheetTabWithHeaders').map((call) => [call[2], call[3]]), [['All', 0]]);
  assert.match(fixed.defaultTabUrl, /#gid=\d+$/);
  assert.notEqual(fixed.defaultTabUrl, state.defaultTabUrl, 'the new tab, not the deleted one');
  assert.equal(fixed.conflict, undefined);
  // Recorded: every other reader now answers the new tab from the row.
  assert.equal((await sheets.describeAccountSheet(users.getUserById(rita.id))).defaultTabUrl, fixed.defaultTabUrl);

  // Temp For AI renamed: put back second, the renamed tab left as it is.
  tabs.get(id)[1].title = 'Old temp';
  calls.length = 0;
  const again = await sheets.describeAccountSheet(users.getUserById(rita.id), { recheck: true });
  assert.deepEqual(titles(id), ['All', 'Temp For AI', 'Old temp']);
  assert.deepEqual(named('addSheetTabWithHeaders').map((call) => [call[2], call[3]]), [['Temp For AI', 1]]);
  assert.notEqual(again.tempTabUrl, fixed.tempTabUrl);
  assert.equal(again.defaultTabUrl, fixed.defaultTabUrl, 'All, still under its recorded gid, is not asked about');
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
  // Still the tab names, so the UI has something true to say about what it would use.
  assert.equal(state.defaultTab, 'All');
  assert.equal(state.tempTab, 'Temp For AI');
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

test("the backfill also lays out the sheets an older build made, and leaves their daily tabs alone", async () => {
  const fake = setup('backfill-layout');
  const { users, sheets, named, titles, tabs } = fake;
  const old = users.createUser({ email: 'old@example.com' });
  const id = olderBuildSheet(users, fake, old);
  const fresh = users.createUser({ email: 'new@example.com' });

  const result = await sheets.backfillAccountSheets(0);
  assert.equal(result.done, 2, 'one allocated, one laid out');
  assert.equal(named('createSpreadsheet').length, 1, 'only for the account with no sheet');
  assert.deepEqual(titles(id), ['All', 'Temp For AI', '10/04/2026', '10/05/2026']);
  assert.deepEqual(tabs.get(id).find((tab) => tab.title === '10/04/2026').header, OLD_DAILY_HEADER);
  assert.equal(users.getUserById(old.id).sheetLayout, 2);
  assert.ok(users.getUserById(fresh.id).sheetId);

  const again = await sheets.backfillAccountSheets(0);
  assert.equal(again.done, 0, 'nothing left to do on the next boot');
});

test('a credential Google refused ends the backfill instead of failing per account', async () => {
  /*
   * One dead token, one warning - not one per account, each after a pause.
   *
   * Every allocation below needs the same access token, so a credential Google
   * refused (an expired consent, a deleted service account) fails all of them
   * for one reason. The loop used to run anyway: two hundred sheet-less accounts
   * meant two hundred and one warnings and, at the real 250ms pause, close to a
   * minute of startup spent failing.
   */
  let probes = 0;
  const { users, sheets, named } = setup('backfill-no-credential', {
    async checkCredential() {
      probes += 1;
      throw new Error('invalid_grant: Token has been expired or revoked.');
    },
  });
  users.createUser({ email: 'alice@example.com' });
  users.createUser({ email: 'bob@example.com' });

  const result = await sheets.backfillAccountSheets(0);

  assert.equal(result.done, 0);
  assert.equal(result.failed, 2, 'every waiting account is reported, once, as not done');
  assert.equal(
    named('createSpreadsheet').length,
    0,
    'and nothing was attempted, because nothing could have worked'
  );
  assert.equal(probes, 1, 'asked once, not once per account');
});

test('the header row: the six a person fills, then the six the program writes - spelling included', () => {
  const { JOB_SHEET_HEADERS } = require('../dist/integrations/googleSheets');
  // Reproduced exactly: anybody matching a column by its heading is matching
  // the string a person reads on screen. A to F are the person's; G to L the
  // job analysis's, protected so only the program writes them (owner
  // decision S3), in this order. Rate, note, Job Finder, the filter's two and
  // the lake's two are gone.
  assert.deepEqual(
    [...JOB_SHEET_HEADERS],
    [
      'Date',
      'NO(DATE)',
      'Company',
      'Job Title',
      'Job Link',
      'Job Description',
      'Job Field',
      'Salary',
      'Job Type',
      'Clearance',
      'Industry',
      'Analysis',
    ]
  );
});

test('SHEET_TIMEZONE decides which day a row is dated, and a date cell is read back however it reads', () => {
  const { sheets } = setup('timezone');
  // Ten at night in New York is already tomorrow in UTC. A server in UTC would
  // otherwise date, and number, an evening's rows as the next day's.
  const evening = new Date('2026-09-18T02:30:00Z');
  process.env.SHEET_TIMEZONE = 'America/New_York';
  try {
    assert.equal(sheets.sheetDateText(evening), '09/17/2026');
    process.env.SHEET_TIMEZONE = 'UTC';
    assert.equal(sheets.sheetDateText(evening), '09/18/2026');
    // A zone name nothing recognises must not be able to stop a sign-in.
    process.env.SHEET_TIMEZONE = 'Mars/Olympus_Mons';
    assert.match(sheets.sheetDateText(evening), /^\d{2}\/\d{2}\/\d{4}$/);
  } finally {
    delete process.env.SHEET_TIMEZONE;
  }
  // Google's own serial numbers: 12/30/1899 is day 0, 01/01/1970 day 25569.
  assert.equal(sheets.sheetDateSerial('01/01/1970'), 25569);
  assert.equal(sheets.sheetDateSerial('10/06/2026'), 46301);
  assert.equal(sheets.sheetDateSerial('02/30/2026'), null);
  assert.equal(sheets.sheetDateSerial('2026-10-06'), null);
  for (const cell of ['10/06/2026', '10/6/2026', '2026-10-06', '46301', ' 10/06/2026 ']) {
    assert.equal(sheets.sheetDateOfCell(cell), '10/06/2026', cell);
  }
  for (const cell of ['', 'today', '13/45/2026', '7', 'Oct 6']) assert.equal(sheets.sheetDateOfCell(cell), null, cell);
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

test('a repeat sign-in on a sheet already laid out costs no Google calls at all', async () => {
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
  // Link-shared on purpose: this guard is about the PUBLIC -> private
  // transition, which is the only time withdrawing the link can take away
  // somebody's only way in. A sheet that was private all along never had one.
  process.env.SHEET_DEFAULT_VISIBILITY = 'public';
  const account = users.createUser({ email: 'alice@example.com' });
  const state = await sheets.ensureAccountSheet(account);
  delete process.env.SHEET_DEFAULT_VISIBILITY;

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

test('an administrator may address their own sheet and no other: the saved shared sheets are gone', async () => {
  const { users, sheets } = setup('admin-own-only');
  const admin = users.createUser({ email: 'admin@example.com' });
  assert.equal(admin.role, 'admin');
  const own = (await sheets.ensureAccountSheet(admin)).spreadsheetId;

  assert.equal(await sheets.resolveAddressableSheet(users.getUserById(admin.id), own), own);
  // What an administrator could once name - a sheet saved under Admin ->
  // Google Sheets - is refused like any other id now, and resolution takes
  // no allow-list at all.
  await assert.rejects(() => sheets.resolveAddressableSheet(users.getUserById(admin.id), 'shared-sheet-1'), { status: 404 });
  assert.equal(sheets.resolveAddressableSheet.length, 3, '(account, requested, known): no allow-list parameter');
});

test('naming no tab means All', () => {
  const { sheets } = setup('addressable-tab');
  assert.equal(sheets.resolveAddressableTab(''), 'All');
  assert.equal(sheets.resolveAddressableTab(undefined), 'All');
  assert.equal(sheets.resolveAddressableTab('  Temp For AI '), 'Temp For AI');
});

test('the column map follows the header row rather than repeating it', () => {
  const { JOB_SHEET_HEADERS, JOB_SHEET_COLUMNS, JOB_SHEET_FIRST_DATA_ROW, ANALYSIS_FIRST_COLUMN, ANALYSIS_LAST_COLUMN } = require('../dist/integrations/googleSheets');

  for (const [key, header] of [
    ['date', 'Date'],
    ['no', 'NO(DATE)'],
    ['company', 'Company'],
    ['jobTitle', 'Job Title'],
    ['jobLink', 'Job Link'],
    ['jobDescription', 'Job Description'],
    ['jobField', 'Job Field'],
    ['salary', 'Salary'],
    ['jobType', 'Job Type'],
    ['clearance', 'Clearance'],
    ['industry', 'Industry'],
    ['analysis', 'Analysis'],
  ]) {
    assert.equal(JOB_SHEET_HEADERS[JOB_SHEET_COLUMNS[key] - 1], header, key);
  }
  assert.deepEqual(Object.keys(JOB_SHEET_COLUMNS).length, 12, 'no column left over from the old layout');
  // The protected block is exactly G to L.
  assert.equal(ANALYSIS_FIRST_COLUMN, 7);
  assert.equal(ANALYSIS_LAST_COLUMN, 12);
  assert.equal(JOB_SHEET_FIRST_DATA_ROW, 2);
});

test('the job routes take no columns and no other spreadsheet: the old helpers are gone', () => {
  const target = require('../dist/services/sheets/jobSheetTarget');
  assert.equal(target.resolveColumn, undefined);
  assert.equal(target.resolveAppendRow, undefined);
  assert.equal(target.adminAllowedSheetIds, undefined);
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
  //
  // Named google-oauth-credentials.json, which the search takes before any
  // service account key: a developer who has run sheets:login has one beside
  // the compiled code, and with key files here that real file would win.
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tailor-keys-'));
  fs.mkdirSync(nodePath.join(root, 'backend'), { recursive: true });
  const first = nodePath.join(root, 'google-oauth-credentials.json');
  const second = nodePath.join(root, 'backend', 'google-oauth-credentials.json');
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
    // At least these two; a developer's own credentials can add to the count.
    assert.match(said, /\d+ Google credential files were found/);
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

test('the downloaded OAuth client is not a credential, and says which half it is', async () => {
  const fs = require('fs');
  const os = require('os');
  const nodePath = require('path');
  const { loadFresh } = require('./helpers');

  // Exactly what the Cloud console downloads. Saving it under the OUTPUT name
  // is the trap: the app prefers that name over a working service account key,
  // so the whole feature stops rather than falling back.
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tailor-halfcred-'));
  fs.writeFileSync(
    nodePath.join(dir, 'google-oauth-credentials.json'),
    JSON.stringify({ web: { client_id: 'id.apps.googleusercontent.com', client_secret: 'secret' } })
  );
  // And a perfectly good service account key beside it, to prove the broken
  // file wins rather than being skipped over.
  fs.writeFileSync(
    nodePath.join(dir, 'service-account-key.json'),
    JSON.stringify({
      type: 'service_account',
      client_email: 'x@y.iam.gserviceaccount.com',
      private_key: 'key',
    })
  );

  const cwd = process.cwd();
  process.chdir(dir);
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const sheets = loadFresh('../dist/integrations/googleSheets');
    assert.match(await sheets.resolveCredentialPath(), /google-oauth-credentials\.json$/);

    await assert.rejects(
      () => sheets.getAccessToken(sheets.SHEETS_SCOPE),
      (error) => {
        // It must name the file, say what is missing, and say what to run -
        // the three things somebody staring at a 403 does not have. In the
        // operator half: an account holder's page gets the diagnosis only.
        assert.match(error.detail, /google-oauth-credentials\.json/);
        assert.match(error.detail, /refresh_token/);
        assert.match(error.detail, /sheets:login/);
        assert.doesNotMatch(error.message, /google-oauth-credentials|sheets:login/);
        return true;
      }
    );
  } finally {
    process.chdir(cwd);
    console.warn = realWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the header is written to the tab Google actually minted, not to gid 0', async () => {
  const { users, sheets, named } = setup('gid-carried');
  const account = users.createUser({ email: 'alice@example.com' });

  const state = await sheets.ensureAccountSheet(account);

  // The contract the doctor broke: gid 0 is only the first tab's id while
  // GOOGLE creates that tab and calls it Sheet1. Naming the tab at creation
  // means Google mints a random id, and writing to 0 then fails with
  // "No grid with id: 0" - which reads like a broken spreadsheet and is not.
  const [, , formattedGid] = named('formatJobSheetTab')[0];
  assert.equal(typeof formattedGid, 'number');
  assert.notEqual(formattedGid, 0);

  // And it is the id that came back from creating it, not any other number.
  assert.match(state.defaultTabUrl, new RegExp(`#gid=${formattedGid}$`));
});

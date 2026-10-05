const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * The admin sheet (owner decisions J9, J10): a spreadsheet the server creates
 * once, shares with every enabled administrator, and keeps as an append-only
 * log of every job the lake ADDED - through an outbox in the database, so a
 * failed append never undoes a job, and a retry sends it exactly once. And
 * the rule under all of it: the duplicate decision reads the database only,
 * and no sheet is asked anything to make it.
 */

const sqlite = require('../dist/database/sqlite');
const lake = require('../dist/database/jobLakeRepository');
const service = require('../dist/services/jobLake/index');
const adminSheet = require('../dist/services/jobLake/adminSheet');
const reportSheet = require('../dist/services/jobLake/reportSheet');
const columns = require('../dist/services/sheets/analysisColumns');
const accountSheet = require('../dist/services/sheets/accountSheet');
const settings = require('../dist/services/jobLake/settings');
const users = require('../dist/database/userRepository');
const { getSetting, setSetting } = require('../dist/database/settingsRepository');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-02-01T09:00:00.000Z');

function job(extra = {}) {
  return {
    company: 'Acme',
    jobFieldId: 'backend',
    title: 'Backend Engineer',
    salary: { min: null, max: null, currency: null, period: null, raw: '$150k' },
    url: 'https://jobs.example.com/1',
    jobDescription: 'Build services.',
    analysisId: null,
    source: 'report',
    ...extra,
  };
}

/**
 * The admin sheet in memory: what was created, written, appended and shared,
 * and in which order (`order`). `holdAppend` / `holdShare` park the next
 * append or share until the promise they hold settles; `appendError` is what
 * a failing append throws.
 */
function fakeAdminSheet(options = {}) {
  const calls = { creates: 0, headers: [], appends: [], shares: [], configured: 0, order: [] };
  const state = {
    failAppends: options.failAppends ?? 0,
    failHeaders: options.failHeaders ?? 0,
    configured: options.configured ?? true,
    onAppend: null,
    holdAppend: null,
    appendEntered: false,
    holdShare: null,
    appendError: null,
  };
  return {
    calls,
    state,
    appendedRows: () => calls.appends.flatMap((call) => call.rows),
    client: {
      async isConfigured() {
        calls.configured += 1;
        return state.configured;
      },
      async createSpreadsheet(title, tab) {
        calls.creates += 1;
        // A tick of latency, so two callers really do overlap.
        await new Promise((resolve) => setImmediate(resolve));
        return { spreadsheetId: `admin-sheet-${calls.creates}`, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/admin-sheet-${calls.creates}/edit`, firstTabGid: 0, title, tab };
      },
      async writeRaw(spreadsheetId, data) {
        if (state.failHeaders > 0) {
          state.failHeaders -= 1;
          throw new Error('Google Sheets is busy (stub 429 after every retry).');
        }
        calls.headers.push({ spreadsheetId, data });
        calls.order.push(`header ${spreadsheetId}`);
      },
      async appendRows(spreadsheetId, range, rows) {
        if (state.onAppend) state.onAppend();
        if (state.holdAppend) {
          const hold = state.holdAppend;
          state.holdAppend = null;
          state.appendEntered = true;
          await hold;
        }
        if (state.failAppends > 0) {
          state.failAppends -= 1;
          throw state.appendError ?? new Error('Google Sheets is busy (stub 429 after every retry).');
        }
        calls.appends.push({ spreadsheetId, range, rows });
        calls.order.push(`append ${spreadsheetId}`);
      },
      async shareWithEmail(spreadsheetId, email) {
        if (state.holdShare) {
          const hold = state.holdShare;
          state.holdShare = null;
          await hold;
        }
        calls.shares.push({ spreadsheetId, email });
      },
    },
  };
}

/** A seam that fails the test the moment anything touches it. */
function forbidden(name) {
  return new Proxy(
    {},
    {
      get(_target, method) {
        return () => {
          throw new Error(`${name}.${String(method)} was called`);
        };
      },
    }
  );
}

function fresh(name, fakeOptions) {
  useTempStorage(`job-lake-sync-${name}-${Math.random().toString(36).slice(2, 8)}`);
  adminSheet.resetAdminLakeSheetForTests();
  service.setLakeClockForTests();
  sqlite.getDb();
  const fake = fakeAdminSheet(fakeOptions);
  adminSheet.setAdminLakeSheetClientForTests(fake.client);
  users.createUser({ email: 'owner@example.com', role: 'admin' });
  const second = users.createUser({ email: 'Second.Admin@example.com', role: 'admin' });
  const gone = users.createUser({ email: 'gone@example.com', role: 'admin' });
  users.updateUser(gone.id, { disabled: true });
  users.createUser({ email: 'user@example.com' });
  const reporter = users.createUser({ email: 'reporter@example.com', role: 'reporter' });
  return { fake, reporter, second };
}

function merge(extra, by, at) {
  return service.mergeIntoLake(job(extra), by, { reward: false, now: at });
}

test('with nothing to append, Google is asked nothing and no sheet is created', async (t) => {
  const { fake } = fresh('idle');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  const report = await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(report, { appended: 0, failed: false, skipped: 'nothing-to-sync' });
  assert.equal(fake.calls.configured, 0);
  assert.equal(fake.calls.creates, 0);
  assert.equal(adminSheet.describeAdminLakeSheet(), null);
});

test('an added job reaches the database AND the sheet; the sheet is created once and shared with the enabled admins', async (t) => {
  const { fake, reporter } = fresh('added');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  const added = merge({ company: 'OpenAI, Inc.' }, reporter.id, T0);
  assert.equal(added.status, 'added');
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 1);

  const report = await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(report, { appended: 1, failed: false });
  assert.equal(fake.calls.creates, 1);
  // The header, RAW, once, in the column order the admin page documents.
  assert.equal(fake.calls.headers.length, 1);
  assert.deepEqual(fake.calls.headers[0].data[0].values[0], [
    'Company', 'Job Field', 'Title', 'Salary', 'Link', 'Requested By', 'Updated At', 'Job Hash',
  ]);
  assert.equal(fake.calls.appends.length, 1);
  assert.equal(fake.calls.appends[0].range, "'Job Lake'!A:H");
  const entry = lake.getLakeEntry(added.lakeId);
  assert.deepEqual(fake.calls.appends[0].rows, [
    ['OpenAI, Inc.', 'Backend', 'Backend Engineer', '$150k', 'https://jobs.example.com/1', 'reporter@example.com', entry.updatedAt, added.jobHash],
  ]);
  assert.ok(lake.getLakeEntry(added.lakeId).sheetSyncedAt, 'marked synced once Google took it');
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 0);

  // Shared with every ENABLED administrator, lower case - not the disabled one, not a user.
  assert.deepEqual(fake.calls.shares.map((share) => share.email).sort(), ['owner@example.com', 'second.admin@example.com']);
  const stored = getSetting(adminSheet.ADMIN_LAKE_SHEET_KEY);
  assert.equal(stored.spreadsheetId, 'admin-sheet-1');
  assert.deepEqual(stored.sharedWith.sort(), ['owner@example.com', 'second.admin@example.com']);

  // A later sync with nothing new creates and shares nothing more.
  await adminSheet.syncAdminLakeSheet();
  assert.equal(fake.calls.creates, 1);
  assert.equal(fake.calls.shares.length, 2);

  // An administrator appointed later is given the sheet at the next sync -
  // with nothing to append too: "Retry now", the boot sync.
  users.createUser({ email: 'third@example.com', role: 'admin' });
  const idle = await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(idle, { appended: 0, failed: false, skipped: 'nothing-to-sync' });
  assert.deepEqual(fake.calls.shares.slice(2).map((share) => share.email), ['third@example.com']);
  assert.ok(getSetting(adminSheet.ADMIN_LAKE_SHEET_KEY).sharedWith.includes('third@example.com'));
  assert.equal(fake.calls.creates, 1);
  assert.equal(fake.calls.appends.length, 1, 'nothing appended');
  // With nobody missing, an idle sync asks Google nothing at all.
  const asked = fake.calls.configured;
  await adminSheet.syncAdminLakeSheet();
  assert.equal(fake.calls.configured, asked);
  assert.equal(fake.calls.shares.length, 3);

  // And one appointed before the next job: shared at that sync too.
  users.createUser({ email: 'fourth@example.com', role: 'admin' });
  merge({ company: 'Globex' }, reporter.id, T0);
  await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(fake.calls.shares.slice(3).map((share) => share.email), ['fourth@example.com']);
  assert.equal(fake.calls.creates, 1);
});

test('a duplicate reaches neither the outbox nor the sheet', async (t) => {
  const { fake, reporter } = fresh('duplicate');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  merge({}, reporter.id, T0);
  await adminSheet.syncAdminLakeSheet();
  assert.equal(merge({ company: 'ACME Corp.' }, reporter.id, T0 + 10 * DAY).status, 'duplicate');
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 0);
  await adminSheet.syncAdminLakeSheet();
  assert.equal(fake.appendedRows().length, 1);
});

test('a failed append keeps the job and leaves it unsynced; a retry appends it exactly once', async (t) => {
  const { fake, reporter } = fresh('retry', { failAppends: 1 });
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  const added = merge({}, reporter.id, T0);

  const failed = await adminSheet.syncAdminLakeSheet();
  assert.equal(failed.failed, true);
  assert.equal(failed.appended, 0);
  assert.ok(lake.getLakeEntry(added.lakeId), 'the database row stands');
  const status = adminSheet.adminLakeSyncStatus();
  assert.equal(status.unsynced, 1);
  assert.match(status.lastError, /busy/);
  assert.ok(status.lastAttemptAt);
  assert.equal(fake.appendedRows().length, 0);

  // "Retry now".
  const retried = await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(retried, { appended: 1, failed: false });
  assert.equal(adminSheet.adminLakeSyncStatus().lastError, null);
  // And again: nothing left to send.
  await adminSheet.syncAdminLakeSheet();
  assert.equal(fake.appendedRows().length, 1, 'appended exactly once');
  assert.equal(fake.calls.creates, 1, 'the sheet made by the failed sync is the one used');
});

test("a replacement appends a NEW line: the sheet is the log of every job the lake added", async (t) => {
  const { fake, reporter } = fresh('replacement');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  const other = users.createUser({ email: 'other@example.com', role: 'reporter' });
  merge({ title: 'First version' }, reporter.id, T0);
  await adminSheet.syncAdminLakeSheet();
  assert.equal(merge({ title: 'Second version' }, other.id, T0 + 61 * DAY).status, 'replaced');
  await adminSheet.syncAdminLakeSheet();
  const rows = fake.appendedRows();
  assert.deepEqual(rows.map((row) => [row[2], row[5]]), [
    ['First version', 'reporter@example.com'],
    ['Second version', 'other@example.com'],
  ]);
});

test('a row replaced while its old version was being appended still gets a line for its new version', async (t) => {
  const { fake, reporter } = fresh('replaced-midway');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  merge({ title: 'Old' }, reporter.id, T0);
  fake.state.onAppend = () => {
    fake.state.onAppend = null;
    merge({ title: 'New' }, reporter.id, T0 + 70 * DAY);
  };
  await adminSheet.syncAdminLakeSheet();
  // The mark is by version: the old line did not mark the new version synced,
  // so the same sync's next batch sent it.
  assert.deepEqual(fake.appendedRows().map((row) => row[2]), ['Old', 'New']);
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 0);
  await adminSheet.syncAdminLakeSheet();
  assert.equal(fake.appendedRows().length, 2);
});

test("a failed append's reason reaches the admin page with Google's own words, not only the sentence", async (t) => {
  const { fake, reporter } = fresh('reason', { failAppends: 1 });
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  const { GoogleSheetsRequestError } = require('../dist/integrations/googleSheets');
  fake.state.appendError = new GoogleSheetsRequestError(
    404,
    'That spreadsheet or tab could not be found. Check the sheet link, or contact your administrator.',
    'Google answered 404: Requested entity was not found.'
  );
  merge({}, reporter.id, T0);
  const report = await adminSheet.syncAdminLakeSheet();
  assert.equal(report.failed, true);
  const { lastError } = adminSheet.adminLakeSyncStatus();
  assert.match(lastError, /^That spreadsheet or tab could not be found\./);
  assert.match(lastError, /\nGoogle answered 404: Requested entity was not found\.$/);
});

test('a header write that fails leaves the one spreadsheet to finish - never a second - and no row lands before the header', async (t) => {
  const { fake, reporter } = fresh('header', { failHeaders: 1 });
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  merge({}, reporter.id, T0);

  const failed = await adminSheet.syncAdminLakeSheet();
  assert.equal(failed.failed, true);
  assert.equal(fake.calls.creates, 1);
  const stored = adminSheet.describeAdminLakeSheet();
  assert.deepEqual([stored.spreadsheetId, stored.headerWritten], ['admin-sheet-1', false], 'stored the moment it exists');
  assert.equal(fake.appendedRows().length, 0);

  const retried = await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(retried, { appended: 1, failed: false });
  assert.equal(fake.calls.creates, 1, 'the same spreadsheet, finished');
  assert.deepEqual(fake.calls.order, ['header admin-sheet-1', 'append admin-sheet-1']);
  assert.equal(adminSheet.describeAdminLakeSheet().headerWritten, true);

  // A sheet stored before the flag existed reads as headed: no header written again.
  setSetting(adminSheet.ADMIN_LAKE_SHEET_KEY, {
    spreadsheetId: 'older-sheet',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/older-sheet/edit',
    tabName: 'Job Lake',
    createdAt: '',
    sharedWith: ['owner@example.com', 'second.admin@example.com'],
  });
  assert.equal(adminSheet.describeAdminLakeSheet().headerWritten, true);
  merge({ company: 'Globex' }, reporter.id, T0);
  await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(fake.calls.order.slice(2), ['append older-sheet']);
});

test('"Create a new admin sheet" while a sync is appending: the new sheet gets the whole lake, and nothing is marked sent to the old', async (t) => {
  const { fake, reporter } = fresh('recreate-midway');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  for (const company of ['A Corp', 'B Corp', 'C Corp']) merge({ company }, reporter.id, T0);
  await adminSheet.syncAdminLakeSheet();
  for (const company of ['D Corp', 'E Corp']) merge({ company }, reporter.id, T0);

  // The next append is parked inside Google, as a 429 backoff would park it.
  let release;
  fake.state.holdAppend = new Promise((resolve) => {
    release = resolve;
  });
  const syncing = adminSheet.syncAdminLakeSheet();
  for (let tries = 0; !fake.state.appendEntered && tries < 1000; tries += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fake.state.appendEntered, 'the sync is inside its append');

  // What POST /admin/job-lake/sheet { recreate: true } does.
  const recreated = await adminSheet.getOrCreateAdminLakeSheet({ recreate: true });
  adminSheet.requestAdminLakeSync('the admin sheet being set up');
  assert.equal(recreated.spreadsheetId, 'admin-sheet-2');
  release();
  await syncing;
  await adminSheet.syncAdminLakeSheet();

  const sentTo = (id) => fake.calls.appends.filter((call) => call.spreadsheetId === id).flatMap((call) => call.rows.map((row) => row[0]));
  assert.deepEqual(sentTo('admin-sheet-2').sort(), ['A Corp', 'B Corp', 'C Corp', 'D Corp', 'E Corp']);
  assert.deepEqual(sentTo('admin-sheet-1'), ['A Corp', 'B Corp', 'C Corp', 'D Corp', 'E Corp'], 'only what was sent before the recreate');
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 0);
  assert.equal(adminSheet.describeAdminLakeSheet().spreadsheetId, 'admin-sheet-2');
});

test('a recreate asked for while the sheet is still being made or shared waits for it, then makes its own', async (t) => {
  const { fake } = fresh('recreate-joins');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  let release;
  fake.state.holdShare = new Promise((resolve) => {
    release = resolve;
  });
  const plain = adminSheet.getOrCreateAdminLakeSheet();
  for (let tries = 0; fake.calls.creates === 0 && tries < 1000; tries += 1) await new Promise((resolve) => setImmediate(resolve));
  const recreate = adminSheet.getOrCreateAdminLakeSheet({ recreate: true });
  // A plain call meanwhile takes whatever is being made.
  const alsoPlain = adminSheet.getOrCreateAdminLakeSheet();
  release();
  assert.equal((await plain).spreadsheetId, 'admin-sheet-1');
  assert.equal((await recreate).spreadsheetId, 'admin-sheet-2', 'not the sheet it was asked to replace');
  assert.ok(['admin-sheet-1', 'admin-sheet-2'].includes((await alsoPlain).spreadsheetId));
  assert.equal(fake.calls.creates, 2);
  assert.equal(adminSheet.describeAdminLakeSheet().spreadsheetId, 'admin-sheet-2');
});

test('two callers at once create one sheet', async (t) => {
  const { fake } = fresh('one-sheet');
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  const [a, b] = await Promise.all([adminSheet.getOrCreateAdminLakeSheet(), adminSheet.getOrCreateAdminLakeSheet()]);
  assert.equal(a.spreadsheetId, b.spreadsheetId);
  assert.equal(fake.calls.creates, 1);
});

test('without Google Sheets the jobs stay in the database and the status says why; recreate sends the whole lake', async (t) => {
  const { fake, reporter } = fresh('recreate', { configured: false });
  t.after(() => adminSheet.resetAdminLakeSheetForTests());
  merge({ company: 'One' }, reporter.id, T0);
  merge({ company: 'Two' }, reporter.id, T0);
  const report = await adminSheet.syncAdminLakeSheet();
  assert.equal(report.skipped, 'not-configured');
  await assert.rejects(adminSheet.getOrCreateAdminLakeSheet(), (error) => error.status === 503 && error.code === 'sheets-not-configured');
  assert.equal(fake.calls.creates, 0);
  assert.match(adminSheet.adminLakeSyncStatus().lastError, /not configured/);
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 2);

  fake.state.configured = true;
  await adminSheet.syncAdminLakeSheet();
  assert.equal(fake.appendedRows().length, 2);

  // The admin deleted the spreadsheet in Google: a new one gets every job.
  await adminSheet.getOrCreateAdminLakeSheet({ recreate: true });
  assert.equal(adminSheet.describeAdminLakeSheet().spreadsheetId, 'admin-sheet-2');
  assert.equal(adminSheet.adminLakeSyncStatus().unsynced, 2);
  await adminSheet.syncAdminLakeSheet();
  assert.deepEqual(
    fake.calls.appends.map((call) => [call.spreadsheetId, call.rows.length]),
    [['admin-sheet-1', 2], ['admin-sheet-2', 2]]
  );
});

test('the duplicate decision never calls a sheets client: added, duplicate and replaced are decided on the database', (t) => {
  const { reporter } = fresh('database-only');
  t.after(() => {
    adminSheet.resetAdminLakeSheetForTests();
    reportSheet.setReportSheetsClientForTests();
    columns.setAnalysisSheetsClientForTests();
  });
  // Every Google seam the lake could reach, set to fail the moment it is touched.
  adminSheet.setAdminLakeSheetClientForTests(forbidden('adminSheet'));
  reportSheet.setReportSheetsClientForTests(forbidden('reportSheet'));
  columns.setAnalysisSheetsClientForTests(forbidden('analysisColumns'));
  accountSheet.setSheetsClientForTests(forbidden('accountSheet'));
  settings.updateLakeSettings({ reportRateUsd: '0.010' }, 'admin');

  assert.equal(service.mergeIntoLake(job(), reporter.id, { reward: true, now: T0 }).status, 'added');
  assert.equal(service.mergeIntoLake(job({ company: 'Acme Inc' }), reporter.id, { reward: true, now: T0 + DAY }).status, 'duplicate');
  assert.equal(service.mergeIntoLake(job(), reporter.id, { reward: true, now: T0 + 90 * DAY }).status, 'replaced');
  assert.equal(users.getUserById(reporter.id).balanceMilli, 20);
});

test('the server resumes the outbox at every start, after it is listening', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const listening = source.indexOf('app.listen(PORT, HOST, () => {');
  const boot = source.indexOf("requestAdminLakeSync('startup')");
  assert.ok(listening > 0 && boot > listening, 'index.ts starts the admin sheet sync inside its listen callback');
});

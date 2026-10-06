const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const { useTempStorage } = require('./helpers');

/**
 * The Job Data Lake's store (database/jobLakeRepository.ts): the tables and
 * their exact indexes, the duplicate window (J2b) on a fake clock, the reward
 * paid in the same transaction (J7) - at whose rate, once, under the daily
 * cap - its revoke, delete, the admin page's query, and two writers adding
 * the same job at the same moment from two threads.
 */

const sqlite = require('../dist/database/sqlite');
const lake = require('../dist/database/jobLakeRepository');
const service = require('../dist/services/jobLake/index');
const settings = require('../dist/services/jobLake/settings');
const credits = require('../dist/database/creditRepository');
const users = require('../dist/database/userRepository');
const analyses = require('../dist/database/jobAnalysisRepository');
const { resetEnvWarningsForTests } = require('../dist/config/envValue');
const { storeJobAnalysis } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T12:00:00.000Z');

function job(extra = {}) {
  return {
    company: 'Acme, Inc.',
    jobFieldId: 'backend',
    title: 'Backend Engineer',
    salary: { min: 150000, max: 190000, currency: 'USD', period: 'annual', raw: '$150k - $190k' },
    url: 'https://jobs.example.com/acme/1',
    jobDescription: 'Build TypeScript services that scale for Acme.',
    analysisId: null,
    source: 'report',
    ...extra,
  };
}

function fresh(name) {
  const storage = useTempStorage(`job-lake-${name}-${Math.random().toString(36).slice(2, 8)}`);
  delete process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS;
  resetEnvWarningsForTests();
  settings.resetLakeSettingsWarningsForTests();
  service.setLakeClockForTests();
  sqlite.getDb();
  return storage;
}

function reporter(email = 'reporter@example.com', rateUsd) {
  const account = users.createUser({ email, name: email.split('@')[0], role: 'reporter' });
  if (rateUsd !== undefined) users.setReportRateMilli(account.id, rateUsd);
  return account;
}

function plan(sql, ...params) {
  return sqlite
    .getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join(' | ');
}

function ledger(userId) {
  return credits.listLedger(userId, 100, 0);
}

/* ----------------------------------------------------- schema and plans -- */

test('the lake has exactly the planned indexes, and the duplicate check and default view use them', () => {
  fresh('plans');
  const db = sqlite.getDb();
  const indexes = (table) =>
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all(table);
  assert.deepEqual(
    indexes('job_lake').map((index) => index.name),
    [
      'idx_job_lake_company_updated',
      'idx_job_lake_field_updated',
      'idx_job_lake_hash',
      'idx_job_lake_requested_by',
      'idx_job_lake_unsynced',
      'idx_job_lake_updated',
    ]
  );
  const byName = Object.fromEntries(indexes('job_lake').map((index) => [index.name, index.sql]));
  assert.match(byName.idx_job_lake_hash, /CREATE UNIQUE INDEX .* \(job_hash\)/);
  assert.match(byName.idx_job_lake_unsynced, /\(id\) WHERE sheet_synced_at IS NULL/);
  assert.match(byName.idx_job_lake_field_updated, /\(job_field_id, updated_at\)/);
  assert.match(byName.idx_job_lake_company_updated, /\(company_key, updated_at\)/);
  assert.deepEqual(indexes('job_lake_history').map((index) => index.name), ['idx_job_lake_history_lake']);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'job_lake_fts'").get(), 'the FTS5 index exists');

  // Enough rows, across fields, companies and reporters, that a scan is a real choice.
  const fields = ['backend', 'frontend', 'devops', 'data-engineering', 'ml-engineering'];
  for (let n = 0; n < 60; n += 1) {
    lake.mergeIntoLake(job({ company: `Company ${n}`, jobFieldId: fields[n % 5] }), `user-${n % 7}`, {
      now: T0 + n * 1000,
      windowDays: 60,
      reward: null,
    });
  }
  // As a lake is: almost every row appended to the admin sheet already.
  lake.markLakeEntriesSynced(lake.queryLake({ limit: 55, offset: 5 }).rows, new Date(T0).toISOString());
  assert.equal(lake.countUnsyncedLakeEntries(), 5);
  db.exec('ANALYZE');

  assert.match(plan(lake.FIND_BY_HASH_SQL, 'x'), /SEARCH job_lake USING INDEX idx_job_lake_hash \(job_hash=\?\)/);
  const defaultView = plan(lake.LIST_DEFAULT_SQL, 50, 0);
  assert.match(defaultView, /SCAN job_lake USING INDEX idx_job_lake_updated/);
  assert.doesNotMatch(defaultView, /TEMP B-TREE/, 'the default order is read off the index, not sorted');
  assert.match(plan(lake.UNSYNCED_SQL, 200), /idx_job_lake_unsynced/);
  assert.match(plan(lake.HISTORY_SQL, 1), /SEARCH job_lake_history USING INDEX idx_job_lake_history_lake \(lake_id=\?\)/);
  // The admin page's two indexed filters, in that same order.
  const listColumns = 'SELECT id FROM job_lake';
  assert.match(
    plan(`${listColumns} WHERE job_field_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50`, 'backend'),
    /USING (COVERING )?INDEX idx_job_lake_field_updated \(job_field_id=\?\)/
  );
  assert.match(
    plan(`${listColumns} WHERE company_key = ? ORDER BY updated_at DESC, id DESC LIMIT 50`, 'company1'),
    /USING (COVERING )?INDEX idx_job_lake_company_updated \(company_key=\?\)/
  );
  assert.match(plan(`${listColumns} WHERE requested_by = ?`, 'user-1'), /idx_job_lake_requested_by/);
  // The merge tab's list of analysed, unmerged jobs.
  assert.match(plan(analyses.LIST_MERGEABLE_SQL, 50, 0), /USING INDEX idx_job_analyses_merge \(merged_at=\?\)/);
});

/* --------------------------------------------------------- the window -- */

test('the duplicate window on a fake clock: 59 days is a duplicate, unpaid; 61 replaces, paid once, the old kept', () => {
  fresh('window');
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const first = reporter('first@example.com');
  const second = reporter('second@example.com');
  const third = reporter('third@example.com');

  const added = service.mergeIntoLake(job(), first.id, { reward: true, now: T0 });
  assert.equal(added.status, 'added');
  assert.equal(added.rewardMilli, 50);
  assert.equal(added.rewardRateMilli, 50);

  // The same JOB - another spelling of the company, another posting - 59 days on.
  const duplicate = service.mergeIntoLake(
    job({ company: 'ACME Corporation', url: 'https://jobs.example.com/acme/2', title: 'Senior Backend' }),
    second.id,
    { reward: true, now: T0 + 59 * DAY }
  );
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.lakeId, added.lakeId);
  assert.equal(duplicate.rewardMilli, 0);
  assert.equal(duplicate.seenCount, 2);
  assert.equal(users.getUserById(second.id).balanceMilli, 0, 'a duplicate pays nothing');
  let row = lake.getLakeEntry(added.lakeId);
  assert.equal(row.requestedBy, first.id, 'a duplicate moves nothing but the count');
  assert.equal(row.updatedAt, new Date(T0).toISOString(), 'and not the window: it runs from the add');
  assert.equal(row.seenCount, 2);
  assert.equal(row.lastSeenAt, new Date(T0 + 59 * DAY).toISOString());

  // 61 days after the ADD (not after the duplicate): replaced, counts as added, paid.
  const replaced = service.mergeIntoLake(
    job({ company: 'Acme', title: 'Platform Engineer', url: 'https://jobs.example.com/acme/3', salary: null }),
    third.id,
    { reward: true, now: T0 + 61 * DAY }
  );
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.lakeId, added.lakeId, 'the same row, replaced in place');
  assert.equal(replaced.rewardMilli, 50);
  row = lake.getLakeEntry(added.lakeId);
  assert.equal(row.requestedBy, third.id);
  assert.equal(row.updatedAt, new Date(T0 + 61 * DAY).toISOString());
  assert.equal(row.createdAt, new Date(T0).toISOString(), 'created_at stays the first add');
  assert.equal(row.title, 'Platform Engineer');
  assert.equal(row.salary, null);
  assert.equal(row.seenCount, 1);
  assert.equal(row.sheetSyncedAt, null, 'the new version waits for the admin sheet');
  assert.deepEqual(row.reward, { milli: 50, rateMilli: 50, revokedMilli: 0, revokedAt: null });

  const history = lake.listLakeHistory(added.lakeId);
  assert.equal(history.length, 1);
  assert.equal(history[0].company, 'Acme, Inc.');
  assert.equal(history[0].title, 'Backend Engineer');
  assert.equal(history[0].requestedBy, first.id);
  assert.equal(history[0].seenCount, 2);
  assert.equal(history[0].versionAt, new Date(T0).toISOString());
  assert.equal(history[0].replacedAt, new Date(T0 + 61 * DAY).toISOString());
  assert.deepEqual(history[0].reward, { milli: 50, rateMilli: 50, revokedMilli: 0, revokedAt: null });

  // Each reporter was paid for exactly what the lake accepted from them.
  assert.equal(users.getUserById(first.id).balanceMilli, 50);
  assert.equal(users.getUserById(third.id).balanceMilli, 50);
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test("an administrator's window wins over .env, which wins over 60; a junk .env value warns and uses 60", (t) => {
  fresh('window-sources');
  t.after(() => delete process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS);
  assert.deepEqual(settings.resolveDuplicateWindow(), {
    days: 60,
    source: 'default',
    adminDays: null,
    envDays: 60,
    envSet: false,
    envInvalid: false,
  });

  process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS = '30';
  assert.equal(settings.resolveDuplicateWindow().days, 30);
  assert.equal(settings.resolveDuplicateWindow().source, 'env');
  // 45 days on, a 30-day window replaces.
  service.mergeIntoLake(job({ company: 'Envco' }), null, { reward: false, now: T0 });
  assert.equal(service.mergeIntoLake(job({ company: 'Envco' }), null, { reward: false, now: T0 + 45 * DAY }).status, 'replaced');

  assert.equal(settings.updateLakeSettings({ duplicateWindowDays: 90 }, 'admin').ok, true);
  const window = settings.resolveDuplicateWindow();
  assert.equal(window.days, 90);
  assert.equal(window.source, 'admin');
  assert.equal(window.envDays, 30, 'the page can still say what .env would give');
  // The same gap is a duplicate under the administrator's 90.
  service.mergeIntoLake(job({ company: 'Adminco' }), null, { reward: false, now: T0 });
  assert.equal(service.mergeIntoLake(job({ company: 'Adminco' }), null, { reward: false, now: T0 + 45 * DAY }).status, 'duplicate');

  // Cleared: .env again.
  settings.updateLakeSettings({ duplicateWindowDays: null }, 'admin');
  assert.equal(settings.resolveDuplicateWindow().source, 'env');

  process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS = 'sixty';
  resetEnvWarningsForTests();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const junk = settings.resolveDuplicateWindow();
    assert.equal(junk.days, 60);
    assert.equal(junk.source, 'default');
    assert.equal(junk.envInvalid, true);
  } finally {
    console.warn = realWarn;
  }
  assert.ok(warnings.some((line) => /JOB_LAKE_DUPLICATE_WINDOW_DAYS="sixty" is not a whole number; using 60/.test(line)), warnings.join('\n'));

  // Out of range clamps, as every operational setting does.
  process.env.JOB_LAKE_DUPLICATE_WINDOW_DAYS = '99999';
  assert.equal(settings.resolveDuplicateWindow().days, 3650);
});

test('the settings refuse what is not a rate, a window or a cap, by name, and amounts in thousandths', () => {
  fresh('settings');
  const refusal = (body) => {
    const result = settings.updateLakeSettings(body, 'admin');
    assert.equal(result.ok, false, JSON.stringify(body));
    return result;
  };
  assert.equal(refusal({ reportRateUsd: '0.0005' }).code, 'bad-rate');
  assert.equal(refusal({ reportRateUsd: '1000.001' }).code, 'bad-rate');
  assert.equal(refusal({ reportRateUsd: '-1' }).code, 'bad-rate');
  assert.equal(refusal({ duplicateWindowDays: 0 }).code, 'bad-window');
  assert.equal(refusal({ duplicateWindowDays: 3651 }).code, 'bad-window');
  assert.equal(refusal({ duplicateWindowDays: '1.5' }).code, 'bad-window');
  assert.equal(refusal({ dailyCapUsd: 'lots' }).code, 'bad-cap');
  assert.equal(refusal({ reportRateMilli: 50 }).code, 'amount-in-dollars');
  assert.equal(refusal({ dailyCapMilli: 50 }).code, 'amount-in-dollars');

  const saved = settings.updateLakeSettings({ reportRateUsd: '0.023', duplicateWindowDays: '14', dailyCapUsd: '1.5' }, 'admin');
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.reportRateMilli, 23);
  assert.equal(saved.settings.reportRateSet, true);
  assert.equal(saved.settings.duplicateWindow.days, 14);
  assert.equal(saved.settings.dailyCapMilli, 1500);
  // Each part on its own, the others kept.
  assert.equal(settings.updateLakeSettings({ dailyCapUsd: '' }, 'admin').settings.dailyCapMilli, null);
  assert.equal(settings.readLakeSettings().reportRateMilli, 23);
  assert.equal(settings.updateLakeSettings({ reportRateUsd: null }, 'admin').settings.reportRateSet, false);
  assert.equal(settings.readLakeSettings().reportRateMilli, 0);
});

/* ------------------------------------------------------------ rewards -- */

test("a reward is the reporter's own rate, else the global one, snapshotted; and nobody but a reporter is paid", () => {
  fresh('rates');
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const own = reporter('own@example.com', 123);
  const global = reporter('global@example.com');
  const admin = users.createUser({ email: 'boss@example.com', role: 'admin' });
  const user = users.createUser({ email: 'user@example.com' });

  assert.equal(service.mergeIntoLake(job({ company: 'One' }), own.id, { reward: true, now: T0 }).rewardMilli, 123);
  assert.equal(service.mergeIntoLake(job({ company: 'Two' }), global.id, { reward: true, now: T0 }).rewardMilli, 50);
  const byAdmin = service.mergeIntoLake(job({ company: 'Three' }), admin.id, { reward: true, now: T0 });
  assert.equal(byAdmin.status, 'added');
  assert.equal(byAdmin.rewardMilli, 0);
  assert.equal(byAdmin.rewardShort, 'not-a-reporter');
  assert.equal(service.mergeIntoLake(job({ company: 'Four' }), user.id, { reward: true, now: T0 }).rewardMilli, 0);
  // A merge pays nobody, a reporter included (J6).
  assert.equal(service.mergeIntoLake(job({ company: 'Five' }), global.id, { reward: false, now: T0 }).rewardMilli, 0);

  // The rate changes; what was paid does not.
  settings.updateLakeSettings({ reportRateUsd: '0.200' }, 'admin');
  const paidBefore = lake.findLakeEntryByHash(require('../dist/services/jobLake/identity').jobHash('Two', 'backend'));
  assert.equal(paidBefore.reward.rateMilli, 50);
  assert.equal(service.mergeIntoLake(job({ company: 'Six' }), global.id, { reward: true, now: T0 }).rewardMilli, 200);

  const rows = ledger(global.id);
  assert.deepEqual(
    rows.map((row) => [row.reason, row.deltaMilli, row.refKind]),
    [
      ['job-report-reward', 200, 'job-lake'],
      ['job-report-reward', 50, 'job-lake'],
    ]
  );
  assert.match(rows[1].note, /Two - Backend \(job #\d+, \$0\.05 per job\)/);
  assert.equal(users.getUserById(admin.id).balanceMilli, 0);
  assert.equal(users.getUserById(user.id).balanceMilli, 0);
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test('a reward is keyed on the row and its version: the same version never pays twice', () => {
  fresh('idempotent');
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const account = reporter();
  const added = service.mergeIntoLake(job(), account.id, { reward: true, now: T0 });
  const entry = lake.getLakeEntry(added.lakeId);
  // Somebody calling the reward again for the version already paid.
  const again = credits.payJobReportReward({
    userId: account.id,
    rateMilli: 50,
    dailyCapMilli: null,
    dayStartIso: lake.utcDayStart(T0),
    idempotencyKey: `job-lake:${entry.id}:${entry.updatedAt}`,
    refId: String(entry.id),
    note: 'again',
  });
  assert.equal(again.paidMilli, 0);
  assert.equal(again.short, 'already-paid');
  assert.equal(users.getUserById(account.id).balanceMilli, 50);
  assert.equal(ledger(account.id).length, 1);
});

test('the same report again - same row, same posting, same account - is not a duplicate of itself; anything less is', () => {
  fresh('already');
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const account = reporter();
  const other = reporter('other@example.com');
  const storedId = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: 'A posting for the already test, long enough.' });
  const row8 = lake.reportRefOf('sheet-1', '10/05/2026', 8);

  const first = service.mergeIntoLake(job({ analysisId: storedId, reportRef: row8 }), account.id, { reward: true, now: T0 });
  assert.equal(first.status, 'added');
  assert.ok(analyses.getJobAnalysisById(storedId).mergedAt, 'the analysis is marked merged with it');
  // A re-run of that row, whose Lake Status never reached the sheet.
  const repeat = service.mergeIntoLake(job({ analysisId: storedId, reportRef: row8 }), account.id, { reward: true, now: T0 + DAY });
  assert.equal(repeat.status, 'already');
  assert.equal(repeat.rewardMilli, 0);
  assert.equal(lake.getLakeEntry(first.lakeId).seenCount, 1, 'nothing moves');

  // The same posting from the same account on another row, another tab, or
  // with no row at all is a duplicate: seen again, never paid.
  for (const reportRef of [
    lake.reportRefOf('sheet-1', '10/05/2026', 20),
    lake.reportRefOf('sheet-1', '10/06/2026', 8),
    undefined,
  ]) {
    const again = service.mergeIntoLake(job({ analysisId: storedId, reportRef }), account.id, { reward: true, now: T0 + DAY });
    assert.equal(again.status, 'duplicate', String(reportRef));
  }
  assert.equal(lake.getLakeEntry(first.lakeId).seenCount, 4);
  // And from somebody else, even naming the same row.
  assert.equal(
    service.mergeIntoLake(job({ analysisId: storedId, reportRef: row8 }), other.id, { reward: true, now: T0 + DAY }).status,
    'duplicate'
  );
  assert.equal(users.getUserById(account.id).balanceMilli, 50);
  assert.equal(users.getUserById(other.id).balanceMilli, 0);

  // A job that came in with no row at all (an administrator's merge) has
  // nothing to be a re-run of: the same posting again is a duplicate.
  const mergedId = storeJobAnalysis({ jobField: 'backend' }, { jobDescription: 'A merged posting for the already test, long enough.' });
  const merged = service.mergeIntoLake(job({ company: 'Merged Co', analysisId: mergedId, source: 'merge' }), account.id, { reward: false, now: T0 });
  assert.equal(merged.status, 'added');
  assert.equal(
    service.mergeIntoLake(job({ company: 'Merged Co', analysisId: mergedId, source: 'merge' }), account.id, { reward: false, now: T0 + DAY }).status,
    'duplicate'
  );
});

test('the daily cap: a reward is cut to what is left of the UTC day, then nothing, and the next day pays again', () => {
  fresh('cap');
  settings.updateLakeSettings({ reportRateUsd: '0.400', dailyCapUsd: '1.000' }, 'admin');
  const account = reporter();
  const paid = [1, 2, 3, 4].map((n) => service.mergeIntoLake(job({ company: `Capped ${n}` }), account.id, { reward: true, now: T0 }));
  assert.deepEqual(paid.map((outcome) => outcome.status), ['added', 'added', 'added', 'added']);
  assert.deepEqual(paid.map((outcome) => outcome.rewardMilli), [400, 400, 200, 0]);
  assert.equal(paid[2].rewardShort, 'cap');
  assert.equal(paid[3].rewardShort, 'cap');
  assert.equal(lake.getLakeEntry(paid[3].lakeId).reward.rateMilli, 400, 'the rate in effect is still on record');
  assert.equal(users.getUserById(account.id).balanceMilli, 1000);
  // Three rows, never a $0 one.
  assert.equal(ledger(account.id).length, 3);

  const tomorrow = service.mergeIntoLake(job({ company: 'Capped 5' }), account.id, { reward: true, now: T0 + DAY });
  assert.equal(tomorrow.rewardMilli, 400);
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test('a rate of $0.000 - the global rate unset, no rate of their own - adds the job and writes no ledger row', () => {
  fresh('zero-rate');
  const account = reporter();
  const outcome = service.mergeIntoLake(job(), account.id, { reward: true, now: T0 });
  assert.equal(outcome.status, 'added');
  assert.equal(outcome.rewardMilli, 0);
  assert.equal(outcome.rewardShort, 'zero-rate');
  assert.deepEqual(ledger(account.id), [], 'never a $0 row');
  assert.equal(users.getUserById(account.id).balanceMilli, 0);
  assert.equal(lake.getLakeEntry(outcome.lakeId).reward.rateMilli, 0, 'the rate in effect is on record');
});

test('the daily cap counts what was PAID today: a revoked reward does not free it', () => {
  fresh('cap-gross');
  settings.updateLakeSettings({ reportRateUsd: '0.100', dailyCapUsd: '0.100' }, 'admin');
  const account = reporter();
  const admin = users.createUser({ email: 'boss@example.com', role: 'admin' });
  // Today as the clock says it, so the revoke - stamped now - falls in the same UTC day.
  const now = Date.now();
  const first = service.mergeIntoLake(job({ company: 'First' }), account.id, { reward: true, now });
  assert.equal(first.rewardMilli, 100);
  assert.equal(lake.revokeLakeReward(first.lakeId, admin.id).takenMilli, 100);
  assert.equal(users.getUserById(account.id).balanceMilli, 0);

  const second = service.mergeIntoLake(job({ company: 'Second' }), account.id, { reward: true, now });
  assert.equal(second.status, 'added');
  assert.equal(second.rewardMilli, 0);
  assert.equal(second.rewardShort, 'cap');
  assert.equal(users.getUserById(account.id).balanceMilli, 0);
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test('a revoke takes the reward back once, clamped at the balance, and a delete can revoke with it', () => {
  fresh('revoke');
  settings.updateLakeSettings({ reportRateUsd: '0.300' }, 'admin');
  const account = reporter();
  const admin = users.createUser({ email: 'boss@example.com', role: 'admin' });
  const one = service.mergeIntoLake(job({ company: 'Revoked' }), account.id, { reward: true, now: T0 });
  const two = service.mergeIntoLake(job({ company: 'Deleted' }), account.id, { reward: true, now: T0 });
  assert.equal(users.getUserById(account.id).balanceMilli, 600);

  // Paid out by hand down to $0.100: a revoke of $0.300 takes $0.100 and stops at zero.
  credits.debitReporterPayout({ userId: account.id, amountMilli: 500, idempotencyKey: 'payout-1', refId: 'p1', actorId: admin.id, note: 'bank' });
  const revoked = lake.revokeLakeReward(one.lakeId, admin.id);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.takenMilli, 100);
  assert.equal(revoked.balanceMilli, 0);
  const entry = lake.getLakeEntry(one.lakeId);
  assert.equal(entry.reward.revokedMilli, 100);
  assert.ok(entry.reward.revokedAt);
  // Once: a second revoke, even after the balance grew again, takes nothing.
  service.mergeIntoLake(job({ company: 'Later' }), account.id, { reward: true, now: T0 + DAY });
  assert.equal(lake.revokeLakeReward(one.lakeId, admin.id).revoked, false);
  assert.equal(users.getUserById(account.id).balanceMilli, 300);

  const deleted = lake.deleteLakeEntry(two.lakeId, { revokeReward: true, actorId: admin.id });
  assert.equal(deleted.deleted.id, two.lakeId);
  assert.equal(deleted.revoke.takenMilli, 300);
  assert.equal(lake.getLakeEntry(two.lakeId), null);
  assert.equal(users.getUserById(account.id).balanceMilli, 0);
  const revokes = ledger(account.id).filter((row) => row.reason === 'job-report-reward-revoked');
  assert.deepEqual(revokes.map((row) => row.deltaMilli), [-300, -100]);
  assert.equal(revokes[0].actorId, admin.id);

  // Deleted, the job can come back - as a new one, paid again.
  const back = service.mergeIntoLake(job({ company: 'Deleted' }), account.id, { reward: true, now: T0 + 2 * DAY });
  assert.equal(back.status, 'added');
  assert.notEqual(back.lakeId, two.lakeId, 'an id is never handed to another job');
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

test('a job with no field from the list, or no company, is never merged and never paid', () => {
  fresh('unmergeable');
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const account = reporter();
  const unclassified = service.mergeIntoLake(job({ jobFieldId: 'unclassified' }), account.id, { reward: true, now: T0 });
  assert.equal(unclassified.status, 'unclassified');
  assert.equal(unclassified.lakeId, null);
  const noCompany = service.mergeIntoLake(job({ company: '  ' }), account.id, { reward: true, now: T0 });
  assert.equal(noCompany.status, 'no-company');
  assert.equal(lake.countLakeEntries(), 0);
  assert.equal(users.getUserById(account.id).balanceMilli, 0);
});

/* -------------------------------------------------------------- query -- */

test("the admin query: full text, the company as the hash compares it, field, salary, requester and dates", () => {
  fresh('query');
  const merge = (extra, by, at) => lake.mergeIntoLake(job(extra), by, { now: at, windowDays: 60, reward: null });
  merge({ company: 'OpenAI, Inc.', title: 'Inference Engineer', jobDescription: 'Kubernetes and GPUs.', salary: { min: 200000, max: 300000, currency: 'USD', period: 'annual', raw: null } }, 'u1', T0);
  merge({ company: 'Globex', jobFieldId: 'frontend', title: 'React Developer', jobDescription: 'React, TypeScript, design systems.', salary: { min: 90000, max: 110000, currency: 'USD', period: 'annual', raw: null } }, 'u2', T0 + DAY);
  merge({ company: 'Initech', jobFieldId: 'devops', title: 'Site Reliability', jobDescription: 'Pager duty, kubernetes clusters.', salary: null }, 'u1', T0 + 2 * DAY);

  const ids = (query) => lake.queryLake({ limit: 50, offset: 0, ...query }).rows.map((row) => row.company);
  assert.deepEqual(ids({}), ['Initech', 'Globex', 'OpenAI, Inc.'], 'newest first');
  assert.deepEqual(ids({ text: 'kubern' }), ['Initech', 'OpenAI, Inc.'], 'every word a prefix');
  assert.deepEqual(ids({ text: 'react typescript' }), ['Globex']);
  assert.deepEqual(ids({ text: '"; DROP TABLE job_lake; --' }), [], 'free text cannot be a syntax error');
  assert.deepEqual(ids({ text: 'design-systems' }), ['Globex'], 'split as the index was');
  assert.deepEqual(ids({ text: '***' }), ['Initech', 'Globex', 'OpenAI, Inc.'], 'no word is no filter');
  assert.deepEqual(ids({ company: 'open ai llc' }), ['OpenAI, Inc.']);
  assert.deepEqual(ids({ company: '!!!' }), [], 'a company that normalises to nothing matches nothing');
  assert.deepEqual(ids({ jobFieldId: 'frontend' }), ['Globex']);
  assert.deepEqual(ids({ salaryMin: 150000 }), ['OpenAI, Inc.']);
  assert.deepEqual(ids({ salaryMax: 150000 }), ['Globex']);
  assert.deepEqual(ids({ requestedBy: 'u1' }), ['Initech', 'OpenAI, Inc.']);
  assert.deepEqual(ids({ updatedFrom: new Date(T0 + DAY).toISOString() }), ['Initech', 'Globex']);
  assert.deepEqual(ids({ updatedTo: new Date(T0 + DAY).toISOString() }), ['Globex', 'OpenAI, Inc.']);
  const page = lake.queryLake({ limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.rows.map((row) => row.company), ['Globex']);
  assert.equal(page.rows[0].jobDescription, undefined, 'a list leaves the description out');
  assert.equal(lake.getLakeEntry(page.rows[0].id).jobDescription, 'React, TypeScript, design systems.');

  // The full-text index follows a replacement and a delete.
  lake.mergeIntoLake(job({ company: 'Globex', jobFieldId: 'frontend', title: 'Vue Developer', jobDescription: 'Vue and Nuxt.' }), 'u3', {
    now: T0 + 90 * DAY,
    windowDays: 60,
    reward: null,
  });
  assert.deepEqual(ids({ text: 'react' }), []);
  assert.deepEqual(ids({ text: 'nuxt' }), ['Globex']);
  lake.deleteLakeEntry(lake.queryLake({ limit: 1, offset: 0, text: 'nuxt' }).rows[0].id, { revokeReward: false, actorId: 'admin' });
  assert.deepEqual(ids({ text: 'nuxt' }), []);
});

/* -------------------------------------------------------- concurrency -- */

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
process.env.DB_DIR = workerData.dbDir;
process.env.TAILOR_STATIC_DIR = workerData.staticDir;
const service = require(workerData.dist + '/services/jobLake/index');
require(workerData.dist + '/database/sqlite').getDb();
const flag = new Int32Array(workerData.gate);
Atomics.add(flag, 1, 1);
Atomics.wait(flag, 0, 0);
const outcome = service.mergeIntoLake(workerData.job, workerData.by, { reward: true, now: workerData.now });
parentPort.postMessage(outcome);
`;

test('two reporters adding the same job at the same moment, from separate threads: one added, the rest duplicates', async () => {
  const storage = fresh('race');
  settings.updateLakeSettings({ reportRateUsd: '0.050' }, 'admin');
  const a = reporter('a@example.com');
  const b = reporter('b@example.com');

  const gate = new SharedArrayBuffer(8);
  const flag = new Int32Array(gate);
  const outcomes = [];
  const workers = [a, b, a, b].map(
    (account, index) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(WORKER, {
          eval: true,
          workerData: {
            dbDir: storage.dbDir,
            staticDir: storage.staticDir,
            dist: path.join(__dirname, '..', 'dist'),
            gate,
            job: job({ company: index % 2 ? 'Racing Co.' : 'Racing Company' }),
            by: account.id,
            now: T0,
          },
        });
        worker.once('message', (outcome) => outcomes.push(outcome));
        worker.once('error', reject);
        worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      })
  );
  // Every worker connected and waiting, then all of them at once.
  for (let tries = 0; Atomics.load(flag, 1) < 4 && tries < 2000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  await Promise.all(workers);

  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['added', 'duplicate', 'duplicate', 'duplicate']);
  assert.equal(new Set(outcomes.map((outcome) => outcome.lakeId)).size, 1);
  assert.equal(lake.countLakeEntries(), 1);
  assert.equal(lake.getLakeEntry(outcomes[0].lakeId).seenCount, 4);
  const paid = users.getUserById(a.id).balanceMilli + users.getUserById(b.id).balanceMilli;
  assert.equal(paid, 50, 'one reward between them');
  assert.deepEqual(credits.findInconsistentBalances(), []);
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, openTestDb, useTempStorage } = require('./helpers');

/**
 * The startup guard (database/upgradeGuard.ts): this build opens only a
 * database that finished every upgrade an older build made to it.
 *
 * The code that made those upgrades is gone from this build, along with every
 * read-time tolerance for what they had not reached, so a database part way
 * along would read WRONGLY rather than fail. It is refused at startup, naming
 * each upgrade it lacks and the one thing that fixes it: start build ac3df79
 * on it once.
 *
 * "Finished" is what ac3df79 leaves: data migrations at version 8, credits
 * switched to dollars, saved templates moved to files (all of them),
 * `users.subscription` (not `plan`), and no lake row without its facts.
 */

const FINISH = 'Start build ac3df79 once on this database to finish its upgrade, then start this build.';

function meta(db, key) {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * A database as ac3df79 leaves it: made by this build's schema (the shape is
 * the same), with every marker that build writes and none of this build's own
 * `baseline_build` - so the guard reads it as an upgraded install, not one it
 * made. `change` then undoes one upgrade.
 */
function upgradedByOlderBuild(name, change = () => {}) {
  const { dbDir } = useTempStorage(`upgrade-guard-${name}`);
  loadFresh('../dist/database/sqlite').getDb().close();
  const raw = openTestDb(dbDir);
  try {
    raw.prepare("DELETE FROM schema_meta WHERE key = 'baseline_build'").run();
    raw.prepare(
      "INSERT INTO users (id, email, role, subscription, created_at, updated_at) VALUES ('u-admin', 'admin@example.com', 'admin', 'default', '2026-01-01', '2026-01-01')"
    ).run();
    change(raw);
  } finally {
    raw.close();
  }
  return dbDir;
}

/** What opening it answers: the refusal, or null once it opened. */
function open() {
  const sqlite = loadFresh('../dist/database/sqlite');
  try {
    sqlite.getDb();
    return null;
  } catch (error) {
    return error;
  }
}

test('a database this build creates is stamped with every mark, and opens again', () => {
  const { dbDir } = useTempStorage('upgrade-guard-fresh');
  loadFresh('../dist/database/sqlite').getDb();

  const raw = openTestDb(dbDir);
  try {
    assert.equal(meta(raw, 'provider_schema_version'), '8');
    assert.equal(meta(raw, 'credit_unit'), 'usd-milli');
    assert.equal(JSON.parse(meta(raw, 'templates_moved_to_files')).complete, true);
    assert.equal(meta(raw, 'baseline_build'), 'ac3df79');
    const columns = raw.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
    assert.ok(columns.includes('subscription') && !columns.includes('plan'));
  } finally {
    raw.close();
  }
  assert.equal(open(), null, 'a second start opens it');
});

test('a database ac3df79 finished upgrading opens, and is stamped so later starts read only the stamp', () => {
  const dbDir = upgradedByOlderBuild('finished', (raw) => {
    // A lake row with its facts, as ac3df79's boot step leaves every row.
    raw.prepare(
      `INSERT INTO job_lake (job_hash, hash_version, company, company_key, job_field_id, analysis_id, requested_by, source,
         created_at, updated_at, reward_milli, job_type, clearance, industry)
       VALUES ('h1', 1, 'Hooli', 'hooli', 'backend', 'a1', 'u-admin', 'merge', '2026-01-01', '2026-01-01', 0, 'remote', 0, 'other')`
    ).run();
  });
  assert.equal(open(), null);
  const raw = openTestDb(dbDir);
  try {
    assert.equal(meta(raw, 'baseline_build'), 'ac3df79');
    // Once stamped, an undone upgrade is not looked for again: nothing this
    // build writes can undo one, and the lake check would read the lake at
    // every start.
    raw.prepare("UPDATE job_lake SET job_type = NULL").run();
  } finally {
    raw.close();
  }
  assert.equal(open(), null);
});

test('its first stamp forgets a report record whose lake row an older build deleted, and only that', () => {
  const dbDir = upgradedByOlderBuild('stale-report', (raw) => {
    const lakeId = raw
      .prepare(
        `INSERT INTO job_lake (job_hash, hash_version, company, company_key, job_field_id, analysis_id, requested_by, source,
           created_at, updated_at, reward_milli, job_type, clearance, industry)
         VALUES ('h1', 1, 'Hooli', 'hooli', 'backend', 'a1', 'u-rep', 'report', '2026-01-01', '2026-01-01', 0, '', 0, 'not_specified')`
      )
      .run().lastInsertRowid;
    const report = raw.prepare(
      `INSERT INTO job_reports (account_id, analysis_id, outcome, lake_id, job_hash, reward_milli, created_at)
       VALUES ('u-rep', ?, ?, ?, ?, 0, '2026-01-01')`
    );
    report.run('a1', 'added', lakeId, 'h1');
    report.run('a2', 'added', 999, 'h-gone');
    report.run('a3', 'unclassified', null, null);
  });
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    assert.equal(open(), null);
  } finally {
    console.log = log;
  }
  const raw = openTestDb(dbDir);
  try {
    assert.deepEqual(
      raw.prepare('SELECT analysis_id FROM job_reports ORDER BY analysis_id').all().map((row) => row.analysis_id),
      ['a1', 'a3'],
      'the record naming a row that is gone is dropped; one naming a row, or none, stays'
    );
  } finally {
    raw.close();
  }
  assert.ok(logged.some((line) => /Dropped 1 job report record/.test(line)), logged.join('\n'));
});

const UNFINISHED = [
  {
    name: 'migrations-stopped',
    change: (raw) => raw.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'provider_schema_version'").run(),
    says: /its data migrations stopped at version 5 of 8/,
  },
  {
    name: 'no-migrations',
    change: (raw) => raw.prepare("DELETE FROM schema_meta WHERE key = 'provider_schema_version'").run(),
    says: /it records no data migrations \(schema_meta\.provider_schema_version is missing\)/,
  },
  {
    name: 'no-administrator',
    change: (raw) => {
      raw.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'provider_schema_version'").run();
      raw.prepare("UPDATE users SET role = 'user'").run();
    },
    // The chain waited at 003 for the first administrator: starting the older
    // build alone does not finish it.
    says: /stopped at version 2 of 8, and they wait for an administrator - sign in to build ac3df79 as one \(ADMIN_EMAILS names who\)/,
  },
  {
    name: 'credits',
    change: (raw) => raw.prepare("DELETE FROM schema_meta WHERE key = 'credit_unit'").run(),
    says: /its credits were never switched to dollars \(schema_meta\.credit_unit\)/,
  },
  {
    name: 'templates',
    change: (raw) => raw.prepare("DELETE FROM schema_meta WHERE key = 'templates_moved_to_files'").run(),
    says: /its saved templates were never moved out of the database \(schema_meta\.templates_moved_to_files\)/,
  },
  {
    name: 'templates-incomplete',
    change: (raw) =>
      raw
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'templates_moved_to_files'")
        .run(JSON.stringify({ complete: false, failed: ['old-row'] })),
    says: /some saved templates could not be written out of the database as files - make backend\/static\/templates writable/,
  },
  {
    name: 'plan-column',
    change: (raw) => raw.exec('ALTER TABLE users RENAME COLUMN subscription TO plan'),
    says: /users\.plan was never renamed to users\.subscription/,
  },
  {
    name: 'lake-facts',
    change: (raw) =>
      raw
        .prepare(
          `INSERT INTO job_lake (job_hash, hash_version, company, company_key, job_field_id, analysis_id, requested_by, source,
             created_at, updated_at, reward_milli)
           VALUES ('h1', 1, 'Hooli', 'hooli', 'backend', 'a1', 'u-admin', 'merge', '2026-01-01', '2026-01-01', 0)`
        )
        .run(),
    says: /some Job Data Lake rows were never given their job type, clearance and industry/,
  },
];

for (const { name, change, says } of UNFINISHED) {
  test(`refused, by name, when it never finished: ${name}`, () => {
    const dbDir = upgradedByOlderBuild(name, change);
    const before = openTestDb(dbDir);
    const tables = before.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n;
    before.close();

    const error = open();
    assert.ok(error, 'it does not open');
    assert.equal(error.name, 'DatabaseNotUpgradedError');
    assert.match(error.message, says);
    assert.equal(error.problems.length, 1, `only what it lacks: ${error.problems.join(' | ')}`);
    assert.ok(error.message.includes(path.join(dbDir, 'free_tailor.db')), 'the file is named');
    assert.ok(error.message.endsWith(FINISH), error.message);

    const after = openTestDb(dbDir);
    try {
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, tables, 'nothing was created in it');
      assert.equal(meta(after, 'baseline_build'), null, 'and it is not stamped');
    } finally {
      after.close();
    }
    // Asked again, it is refused again: no connection was kept for it.
    assert.match(open().message, says);
  });
}

test('a database that missed every upgrade gets every sentence, in one refusal', () => {
  upgradedByOlderBuild('everything', (raw) => {
    raw.prepare("DELETE FROM schema_meta WHERE key IN ('provider_schema_version', 'credit_unit', 'templates_moved_to_files')").run();
    raw.exec('ALTER TABLE users RENAME COLUMN subscription TO plan');
  });
  const error = open();
  assert.equal(error.problems.length, 4, error.problems.join(' | '));
  assert.match(error.message, /^The database at .* has not finished upgrading: it records no data migrations .*; its credits .*; its saved templates .*; users\.plan .*\. Start build ac3df79/);
});

test('the server stops at a refused database with that sentence and exit code 1, before any route loads', () => {
  const dbDir = upgradedByOlderBuild('server', (raw) =>
    raw.prepare("DELETE FROM schema_meta WHERE key = 'credit_unit'").run()
  );
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: { ...process.env, DB_DIR: dbDir, PORT: '3145', HOST: '127.0.0.1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\[db\] The database at .* has not finished upgrading: its credits were never switched to dollars/);
  assert.ok(run.stderr.includes(FINISH));
  assert.doesNotMatch(run.stderr, /\n\s+at /, 'a sentence, not a stack trace');
  assert.doesNotMatch(run.stdout, /listening|Database:/i, 'it never started serving');
});

/*
 * The README tells an operator what the refusal looks like - its Upgrading
 * steps quote a whole line, its Troubleshooting row the sentence around what
 * is missing - and what two of the phrases in it ask of them. So it must
 * quote the guard's own words. Whitespace is folded: the README wraps.
 */
test("the README quotes the refusal in the guard's own words", () => {
  const fs = require('node:fs');
  const guard = require('../dist/database/upgradeGuard');
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

  upgradedByOlderBuild('readme', (raw) => raw.prepare("DELETE FROM schema_meta WHERE key = 'credit_unit'").run());
  const { problems } = open();
  const line = `[db] ${new guard.DatabaseNotUpgradedError('/data/db/free_tailor.db', problems).message}`;
  assert.ok(readme.includes(line), `Upgrading quotes "${line}"`);

  const row = `[db] The database at <path> has not finished upgrading: <what is missing>. ${FINISH}`;
  assert.ok(readme.includes(row), `Troubleshooting quotes "${row}"`);

  // The two phrases the README says what to do about, as the guard words them.
  const source = fs.readFileSync(require.resolve('../dist/database/upgradeGuard'), 'utf8');
  for (const phrase of ['wait for an administrator', 'some saved templates could not be written']) {
    assert.ok(source.includes(phrase), `the guard says "${phrase}"`);
    assert.ok(readme.includes(phrase), `and the README names it`);
  }
  assert.equal(guard.UPGRADE_BUILD, 'ac3df79', 'the build the README names');
});

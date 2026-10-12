const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

/**
 * The data-migration runner (database/migrations/index.ts).
 *
 * It has no steps today - every one an older build needed ran before the
 * startup guard admits a database - but it stays for the next, which is 9,
 * and the server runs it at every start. So its contract is pinned here with
 * steps of the tests' own, rather than first meeting a regression when
 * migration 9 ships:
 *
 *   - it never throws, whatever a step or the database does;
 *   - the version is written after EACH step, so a later step that fails does
 *     not send an earlier one round again over rows it already rewrote;
 *   - a step that defers writes nothing and STOPS the ones after it - the
 *     version is one number, and a later step writing its own would put the
 *     database past the deferred one for good;
 *   - a step at or below the version the database is at never runs.
 */

const { runDataMigrations, SCHEMA_VERSION_KEY, BASELINE_SCHEMA_VERSION } = require('../dist/database/migrations');

/** A database as every one the runner sees: schema_meta at the baseline. */
function atBaseline() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(SCHEMA_VERSION_KEY, String(BASELINE_SCHEMA_VERSION));
  return db;
}

function version(db) {
  return db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_VERSION_KEY).value;
}

/** A step that records each run in `calls`, answering `outcome` (or throwing it). */
function step(versionNumber, calls, outcome = { ran: true, notes: [], summary: 'done' }) {
  return {
    version: versionNumber,
    label: `Test step ${versionNumber}`,
    apply(db) {
      calls.push(versionNumber);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

/** Runs `fn` with the console captured, so a step's lines are read, not printed. */
function quietly(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) console[level] = (...args) => lines.push(`${level}: ${args.map(String).join(' ')}`);
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

test('the baseline is 8, and the shipped list adds nothing to it', () => {
  assert.equal(SCHEMA_VERSION_KEY, 'provider_schema_version');
  assert.equal(BASELINE_SCHEMA_VERSION, 8, 'the version 008 left; the next step is 9');
  const db = atBaseline();
  const lines = quietly(() => runDataMigrations(db));
  assert.equal(version(db), '8');
  assert.deepEqual(lines, []);
});

test('each step that runs writes its version, and a second start runs none of them again', () => {
  const db = atBaseline();
  const calls = [];
  const steps = [step(9, calls), step(10, calls, { ran: false, notes: [], summary: 'nothing to do' })];

  const lines = quietly(() => runDataMigrations(db, steps));
  assert.deepEqual(calls, [9, 10]);
  assert.equal(version(db), '10', 'a step that found nothing to do is done too');
  assert.ok(lines.some((line) => line === 'log: [db] Test step 9 applied: done.'), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes('Test step 10 applied')), 'only a step that ran says it was applied');

  quietly(() => runDataMigrations(db, steps));
  assert.deepEqual(calls, [9, 10], 'nothing runs twice');
});

test('a step at or below the version the database is at never runs', () => {
  const db = atBaseline();
  const calls = [];
  quietly(() => runDataMigrations(db, [step(5, calls), step(8, calls), step(9, calls)]));
  assert.deepEqual(calls, [9]);
  assert.equal(version(db), '9');
});

test('a step that defers writes nothing and stops the ones after it, and runs again next start', () => {
  const db = atBaseline();
  const calls = [];
  let waiting = true;
  const steps = [
    {
      version: 9,
      label: 'Test step 9',
      apply() {
        calls.push(9);
        return waiting
          ? { ran: false, notes: ['nobody to hand it to yet'], summary: '', deferred: true }
          : { ran: true, notes: [], summary: 'handed over' };
      },
    },
    step(10, calls),
  ];

  const lines = quietly(() => runDataMigrations(db, steps));
  assert.deepEqual(calls, [9], 'step 10 waits behind it');
  assert.equal(version(db), '8');
  assert.ok(lines.includes('warn: [db] Test step 9 is waiting: nobody to hand it to yet'), lines.join('\n'));

  waiting = false;
  quietly(() => runDataMigrations(db, steps));
  assert.deepEqual(calls, [9, 9, 10]);
  assert.equal(version(db), '10');
});

test('a step that throws is logged, never thrown, keeps the steps before it and stops the ones after', () => {
  const db = atBaseline();
  const calls = [];
  const steps = [step(9, calls), step(10, calls, new Error('disk on fire')), step(11, calls)];

  let lines;
  assert.doesNotThrow(() => {
    lines = quietly(() => runDataMigrations(db, steps));
  });
  assert.deepEqual(calls, [9, 10]);
  assert.equal(version(db), '9', 'step 9 stays done; step 10 is tried again next start');
  assert.ok(
    lines.some((line) => line.startsWith('error: [db] Test step 10 failed. The stored rows are unchanged')),
    lines.join('\n')
  );
});

test('a database it cannot read the version of is left alone, without a throw', () => {
  const db = new Database(':memory:');
  const calls = [];
  let lines;
  assert.doesNotThrow(() => {
    lines = quietly(() => runDataMigrations(db, [step(9, calls)]));
  });
  assert.deepEqual(calls, []);
  assert.ok(lines.some((line) => line.startsWith('error: [db] Could not read the schema version')), lines.join('\n'));
});

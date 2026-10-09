import type Database from 'better-sqlite3';

/**
 * Data migrations, run once per process on the first database use.
 *
 * Distinct from the schema DDL: `db.exec(SCHEMA)` creates tables, a step here
 * rewrites rows whose SHAPE is still valid but whose CONTENT names something
 * the code no longer knows about.
 *
 * There are none now. Every step an older build needed - 001 and 003 to 008 -
 * ran on every install before this build (the startup guard in sqlite.ts
 * refuses a database where they had not), so they were folded away: SCHEMA
 * and the seeded defaults are what they produced. A database created by this
 * build is stamped at `BASELINE_SCHEMA_VERSION`, the version 008 left, and the
 * runner below stays for the next step, which is 9. Never reuse a number below
 * it: a database an older build upgraded already passed every one of them.
 */

/** The `schema_meta` key the version is kept under. */
export const SCHEMA_VERSION_KEY = 'provider_schema_version';

/** The version every database this build opens is at: 008's, the last step an older build ran. */
export const BASELINE_SCHEMA_VERSION = 8;

function readVersion(db: Database.Database): number {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
    | { value?: string }
    | undefined;
  const parsed = Number.parseInt(row?.value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SCHEMA_VERSION_KEY, String(version), new Date().toISOString());
}

/**
 * What the runner needs back from a migration, whatever else it reports.
 *
 * `deferred` says the step could not run yet through no fault of its own, and
 * the version must NOT be written - it has to be tried again on the next boot.
 * Distinct from `ran: false`, which means it looked and found nothing to do and
 * never needs to look again.
 */
export type MigrationOutcome = { ran: boolean; notes: string[]; summary: string; deferred?: boolean };

export type MigrationStep = {
  /** The version the database is at once this step has run; above BASELINE_SCHEMA_VERSION. */
  version: number;
  label: string;
  apply: (db: Database.Database) => MigrationOutcome;
};

/**
 * The migrations, in order - none yet.
 *
 * A list rather than a single call so that an install part way along runs
 * only what it is missing, and so the version is written after EACH step: a
 * later migration that throws must not roll an earlier one's version back and
 * have it re-run against rows it has already rewritten.
 */
const MIGRATIONS: readonly MigrationStep[] = [];

/**
 * Never throws. A migration that cannot run must not stop the server from
 * starting: the admin UI is the only place an operator can fix whatever went
 * wrong. `steps` is for the tests; the server runs `MIGRATIONS`.
 */
export function runDataMigrations(db: Database.Database, steps: readonly MigrationStep[] = MIGRATIONS): void {
  let current = 0;
  try {
    current = readVersion(db);
  } catch (error) {
    console.error('[db] Could not read the schema version; skipping data migrations.', error);
    return;
  }

  for (const migration of steps) {
    if (current >= migration.version) {
      continue;
    }
    try {
      const report = migration.apply(db);
      if (report.ran) {
        console.log(`[db] ${migration.label} applied: ${report.summary}.`);
        for (const note of report.notes) {
          console.warn(`[db] ${note}`);
        }
      }
      if (report.deferred) {
        for (const note of report.notes) {
          console.warn(`[db] ${migration.label} is waiting: ${note}`);
        }
        // Not done, and not a failure: it is waiting on something a later boot
        // will have. STOP rather than skip - the version is a single monotonic
        // number, so letting a LATER migration run and write its own higher
        // version would put the database past this step and it would never be
        // retried.
        return;
      }
      writeVersion(db, migration.version);
      current = migration.version;
    } catch (error) {
      console.error(
        `[db] ${migration.label} failed. The stored rows are unchanged; it will be retried on the next start.`,
        error
      );
      return;
    }
  }
}

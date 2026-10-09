import type Database from 'better-sqlite3';
import { BASELINE_SCHEMA_VERSION, SCHEMA_VERSION_KEY } from './migrations';

/**
 * The startup guard: this build opens only a database that finished every
 * upgrade an older build made to it (owner decision L1).
 *
 * The code that upgraded older databases - the numbered migrations 001 and
 * 003-008, the switch of credits to dollars, the move of saved templates out
 * of the `templates` table, the rename of `users.plan`, the filling of the
 * lake's job type, clearance and industry - is gone from this build, along
 * with every read-time tolerance for what those steps had not reached yet. A
 * database that build ac3df79 (the last to carry them) has opened and
 * finished upgrading reads correctly here; one that has not would read
 * WRONGLY - balances in the wrong unit, saved templates missing, providers
 * that no longer exist - rather than fail. So it is refused at startup, by
 * name, with the one thing that fixes it: start ac3df79 on it once.
 *
 * Each upgrade left a mark this reads (`upgradeProblems`):
 *
 *   - `schema_meta.provider_schema_version` = 8, the last numbered migration;
 *   - `schema_meta.credit_unit` = 'usd-milli', the dollar switch;
 *   - `schema_meta.templates_moved_to_files`, the template move, and not one
 *     that recorded a template it could not write (`"complete": false`);
 *   - `users.subscription` (not `plan`), the rename;
 *   - no `job_lake` row whose `job_type` IS NULL, the facts fill.
 *
 * A database that passes is stamped `baseline_build` = ac3df79, and from then
 * on only that stamp is read: the lake check would otherwise read every row
 * of the lake at every start, and nothing this build writes can undo any of
 * the five. A FRESH database - no `users` table yet - is stamped with all of
 * them as it is created (`stampCurrentDatabase`), since this build's SCHEMA
 * and defaults are what those steps produced.
 */

/** The build to start once on a database this one refuses. */
export const UPGRADE_BUILD = 'ac3df79';

/** The marks each upgrade left, by the key it left them under. */
export const DOLLAR_SWITCH_MARKER = 'credit_unit';
export const DOLLAR_SWITCH_UNIT = 'usd-milli';
export const TEMPLATE_MOVE_MARKER = 'templates_moved_to_files';
/** Written once the guard has passed, or when this build created the database. */
export const BASELINE_MARKER = 'baseline_build';

/** Refused at startup; `index.ts` prints the message and exits. */
export class DatabaseNotUpgradedError extends Error {
  readonly databasePath: string;
  readonly problems: string[];

  constructor(databasePath: string, problems: string[]) {
    super(
      `The database at ${databasePath} has not finished upgrading: ${problems.join('; ')}. ` +
        `Start build ${UPGRADE_BUILD} once on this database to finish its upgrade, then start this build.`
    );
    this.name = 'DatabaseNotUpgradedError';
    this.databasePath = databasePath;
    this.problems = problems;
  }
}

export function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function readMarker(db: Database.Database, key: string): string | null {
  if (!tableExists(db, 'schema_meta')) return null;
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function writeMarker(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, new Date().toISOString());
}

/**
 * The template move's record says whether a template was left to try again:
 * `"complete": false`. A record nobody can parse was still written by the
 * move, after a pass, and reads as complete, as the move itself read it.
 */
function templateMoveComplete(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return !(parsed && typeof parsed === 'object' && (parsed as { complete?: unknown }).complete === false);
  } catch {
    return true;
  }
}

/**
 * What an EXISTING database has not finished, one phrase per upgrade - empty
 * when it may be opened. Reads only; never throws on a table that is missing.
 */
export function upgradeProblems(db: Database.Database): string[] {
  if (readMarker(db, BASELINE_MARKER) !== null) return [];
  const problems: string[] = [];

  const version = Number.parseInt(readMarker(db, SCHEMA_VERSION_KEY) ?? '', 10);
  if (version !== BASELINE_SCHEMA_VERSION) {
    const at = Number.isFinite(version)
      ? `its data migrations stopped at version ${version} of ${BASELINE_SCHEMA_VERSION}`
      : `it records no data migrations (schema_meta.${SCHEMA_VERSION_KEY} is missing)`;
    // The chain waited at 003 for the first administrator, so on an install
    // nobody has administered, starting the older build alone does not finish
    // it - somebody has to sign in to it as one.
    const admin = tableExists(db, 'users') && columnNames(db, 'users').has('role')
      ? db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()
      : undefined;
    problems.push(
      admin
        ? at
        : `${at}, and they wait for an administrator - sign in to build ${UPGRADE_BUILD} as one ` +
            '(ADMIN_EMAILS names who) before starting this build'
    );
  }

  if (readMarker(db, DOLLAR_SWITCH_MARKER) !== DOLLAR_SWITCH_UNIT) {
    problems.push(`its credits were never switched to dollars (schema_meta.${DOLLAR_SWITCH_MARKER})`);
  }

  const moved = readMarker(db, TEMPLATE_MOVE_MARKER);
  if (moved === null) {
    problems.push(`its saved templates were never moved out of the database (schema_meta.${TEMPLATE_MOVE_MARKER})`);
  } else if (!templateMoveComplete(moved)) {
    problems.push(
      'some saved templates could not be written out of the database as files - make backend/static/templates ' +
        'writable for the user the server runs as'
    );
  }

  if (!columnNames(db, 'users').has('subscription')) {
    problems.push('users.plan was never renamed to users.subscription');
  }

  if (
    tableExists(db, 'job_lake') &&
    columnNames(db, 'job_lake').has('job_type') &&
    db.prepare('SELECT 1 FROM job_lake WHERE job_type IS NULL LIMIT 1').get()
  ) {
    problems.push('some Job Data Lake rows were never given their job type, clearance and industry');
  } else if (tableExists(db, 'job_lake') && !columnNames(db, 'job_lake').has('job_type')) {
    problems.push('the Job Data Lake has no job type, clearance or industry columns');
  }

  return problems;
}

/**
 * Throws `DatabaseNotUpgradedError` for an existing database that has not
 * finished, else stamps it - the first time, after one last tidy no step of
 * this build repeats: a `job_reports` record whose lake row is gone. Only a
 * build that knew nothing of the records could delete a row without them
 * (this one deletes both together), and the older builds read such a record
 * as standing for nothing; read as it is here, it would call the posting
 * reported before for good.
 */
export function assertUpgradeFinished(db: Database.Database, databasePath: string): void {
  const problems = upgradeProblems(db);
  if (problems.length > 0) throw new DatabaseNotUpgradedError(databasePath, problems);
  if (readMarker(db, BASELINE_MARKER) !== null) return;
  if (tableExists(db, 'job_reports') && tableExists(db, 'job_lake')) {
    const dropped = db
      .prepare(
        'DELETE FROM job_reports WHERE lake_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM job_lake WHERE job_lake.id = job_reports.lake_id)'
      )
      .run().changes;
    if (dropped > 0) console.log(`[db] Dropped ${dropped} job report record(s) whose lake row was deleted by an older build.`);
  }
  writeMarker(db, BASELINE_MARKER, UPGRADE_BUILD);
}

/**
 * A database this build has just created is current by construction: stamped
 * with every mark the guard reads, so its next start passes - and so does an
 * older build pointed at it, which finds nothing left to do.
 */
export function stampCurrentDatabase(db: Database.Database): void {
  writeMarker(db, SCHEMA_VERSION_KEY, String(BASELINE_SCHEMA_VERSION));
  writeMarker(db, DOLLAR_SWITCH_MARKER, DOLLAR_SWITCH_UNIT);
  writeMarker(
    db,
    TEMPLATE_MOVE_MARKER,
    JSON.stringify({ complete: true, moved: [], renamed: [], kept: [], failed: [], repointedProfiles: 0 })
  );
  writeMarker(db, BASELINE_MARKER, UPGRADE_BUILD);
}

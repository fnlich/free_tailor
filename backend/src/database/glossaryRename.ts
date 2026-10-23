import type Database from 'better-sqlite3';
import { tableExists } from './upgradeGuard';

/**
 * The v4.2 vocabulary step: the one place a database written under the old
 * words is brought to the new ones.
 *
 * v4.2 renamed what the app calls things. What v4.1 stored as a "profile" - one
 * resume document - is a RESUME, and what it stored as a "group" - a list of
 * resume ids an administrator made - is a PROFILE, the person. The code was
 * renamed everywhere, and the stored names are renamed here, once, in place, so
 * nothing is converted or deleted. Two blocks, in this order (the second reuses
 * the word the first vacates):
 *
 * The RESUME block (Stage R), for a database that still has the old resume table:
 *   - the table `profiles` becomes `resumes`;
 *   - `order_items.profile_id` / `profile_name` become `resume_id` /
 *     `resume_name`, and `tailor_cache.profile_id` becomes `resume_id`;
 *   - the JSON documents keep their ids and everything else, and move the keys
 *     that carried the old word: a resume's `profileSettings`, the app
 *     settings' `defaultProfileId` (to `defaultResumeId`), and five keys of a
 *     queued task, so a task queued before the upgrade restores and builds.
 *
 * The PROFILE block (Stage G), for a database that still has `profile_groups`:
 *   - the table `profile_groups` becomes `profiles`, rows untouched (a group's
 *     stored member list rides along, unread: the owner adds the resumes to
 *     their profiles again);
 *   - the app settings' `defaultGroupId` becomes `defaultProfileId`. That move
 *     must come after the resume block's, or the new key would read a resume id.
 *
 * It runs inside getDb()'s one IMMEDIATE transaction, after the startup guard
 * (upgradeGuard.ts, which still reads ac3df79's names and so must run first)
 * and BEFORE SCHEMA. SCHEMA creates `resumes`; run first it would put an empty
 * `resumes` beside the old `profiles`, every resume would seem to vanish, and
 * the rename that followed would have nowhere to go. Any throw rolls the guard's
 * first stamp, the renames and SCHEMA back together.
 *
 * There is no marker and no numbered migration: the structure is the state.
 * Each block has a shape test of its own, so a database the first block already
 * renamed (an R-only database, or any start after the first) still gets the
 * second. A database already renamed has no `profiles` table with a `disabled`
 * column and no `profile_groups` table, and the step costs two `sqlite_master`
 * lookups and one `table_info` read at every later start. Every move is
 * guarded, so running it twice changes nothing; a JSON move also never
 * overwrites - it happens only where the old key is there and the new one is not.
 *
 * The old resume table is told apart by SHAPE, not by name alone: it is
 * `profiles` WITH a `disabled` column. The table of people, also called
 * `profiles` once the second block has run, never has one (and must never gain
 * one: see hasOldResumeTable), so the step cannot take it for a resume table.
 * The old people table is `profile_groups`.
 */

/**
 * Tables renamed, old name to new name, in the order they are renamed. The old
 * name of the second pair is the new name of the first, which is why the order
 * is not free. A name is translated by ONE lookup, never a chain: ac3df79's
 * `profiles` is today's `resumes`, and ac3df79's `profile_groups` is today's
 * `profiles`.
 */
export const RENAMED_TABLES: Readonly<Record<string, string>> = {
  profiles: 'resumes',
  profile_groups: 'profiles',
};

/**
 * Columns renamed, by the table that holds them (which keeps its name): old
 * name to new name.
 */
export const RENAMED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  order_items: { profile_id: 'resume_id', profile_name: 'resume_name' },
  tailor_cache: { profile_id: 'resume_id' },
};

/** One key of a stored JSON document that moves, as a path to a path. */
export interface MovedJsonKey {
  /** The table, by its NEW name where it was renamed above. */
  table: string;
  /** The column holding the JSON text. */
  column: string;
  /** JSON paths, bound as parameters. */
  from: string;
  to: string;
  /** Only the row with this `key` (app_settings). */
  rowKey?: string;
}

/**
 * The resume block's JSON keys, in the order they move. `app_settings`'s row is
 * the administrator's settings (`APP_SETTINGS_KEY` in config/aiModelConfig.ts).
 * Its `defaultProfileId` here is a RESUME id (v4.1's meaning of the word).
 */
const RESUME_JSON_KEYS: readonly MovedJsonKey[] = [
  { table: 'resumes', column: 'data', from: '$.profileSettings', to: '$.resumeSettings' },
  { table: 'app_settings', column: 'value', from: '$.defaultProfileId', to: '$.defaultResumeId', rowKey: 'app-settings' },
  { table: 'generation_tasks', column: 'data', from: '$.label.profileId', to: '$.label.resumeId' },
  { table: 'generation_tasks', column: 'data', from: '$.label.profileName', to: '$.label.resumeName' },
  { table: 'generation_tasks', column: 'data', from: '$.payload.profileId', to: '$.payload.resumeId' },
  { table: 'generation_tasks', column: 'data', from: '$.value.profileId', to: '$.value.resumeId' },
  { table: 'generation_tasks', column: 'data', from: '$.value.profileName', to: '$.value.resumeName' },
];

/**
 * The profile block's JSON key. It moves only after `RESUME_JSON_KEYS`'
 * `defaultProfileId` has gone to `defaultResumeId`: until then that name holds
 * a resume id, and the group's default would land on top of it (the move never
 * overwrites, so it would not move at all).
 */
const PROFILE_JSON_KEYS: readonly MovedJsonKey[] = [
  { table: 'app_settings', column: 'value', from: '$.defaultGroupId', to: '$.defaultProfileId', rowKey: 'app-settings' },
];

/** Every JSON key that moves, in the order they move: the resume block's, then the profile block's. */
export const MOVED_JSON_KEYS: readonly MovedJsonKey[] = [...RESUME_JSON_KEYS, ...PROFILE_JSON_KEYS];

const OLD_RESUME_TABLE = 'profiles';
const RESUME_TABLE = 'resumes';
const OLD_PEOPLE_TABLE = 'profile_groups';
const PEOPLE_TABLE = 'profiles';

/**
 * Refused at startup; `openAtStartup.ts` prints the message and exits 1.
 *
 * The database holds BOTH an old table and the table that is to replace it, and
 * both have rows, so there is no telling which is the current one and nothing
 * is dropped. The way in is an older build started on a database this one had
 * already upgraded: its SCHEMA runs at every start and makes an empty table
 * under each name it knows - `profiles` beside the renamed resumes,
 * `profile_groups` beside the renamed people. Those are dropped here while
 * they are empty, and become this refusal once that build has saved a row into
 * one. Two cases: the resume tables (the default) and the people tables, the
 * latter named by its `meaning`.
 */
export class VocabularyConflictError extends Error {
  readonly databasePath: string;
  readonly tables: readonly string[];

  constructor(
    databasePath: string,
    tables: readonly string[] = [OLD_RESUME_TABLE, RESUME_TABLE],
    oldMeaning = 'what build 4.1 called a resume'
  ) {
    super(
      `The database at ${databasePath} has both a "${tables[0]}" table (${oldMeaning}) and a ` +
        `"${tables[1]}" table, and both hold rows, so this build cannot tell which is the current one. ` +
        'This happens when an older build was started on a database this build had already upgraded. ' +
        'Restore the backup taken before upgrading, then start this build on it.'
    );
    this.name = 'VocabularyConflictError';
    this.databasePath = databasePath;
    this.tables = tables;
  }
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function holdsRows(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
}

/**
 * The table a v4.1 build kept its resumes in: `profiles`, with a `disabled` column.
 *
 * That column is the ONLY thing that tells it from the table of people, which this build calls `profiles` too
 * (SCHEMA in sqlite.ts). So the people must never gain a `disabled` column: the next start would take their
 * table for the old resumes and rename it over `resumes`. test/glossaryRename.test.js holds it.
 */
function hasOldResumeTable(db: Database.Database): boolean {
  return tableExists(db, OLD_RESUME_TABLE) && columnNames(db, OLD_RESUME_TABLE).has('disabled');
}

/** The table a v4.1 build kept its groups in: `profile_groups`, which never had a `disabled` column. */
function hasOldPeopleTable(db: Database.Database): boolean {
  return tableExists(db, OLD_PEOPLE_TABLE);
}

function dollarPath(path: string): string {
  return path.replace(/^\$\./, '');
}

/** Moves each key where the old one is there and the new one is not, and says how many rows moved. */
function moveJsonKeys(db: Database.Database, moves: readonly MovedJsonKey[], done: string[]): void {
  for (const move of moves) {
    if (!tableExists(db, move.table)) continue;
    if (!columnNames(db, move.table).has(move.column)) continue;
    // `->` rather than json_extract: it hands back the value as JSON of its own
    // type, so a moved `true` stays `true` and a string stays a string.
    const changes = db
      .prepare(
        `UPDATE ${move.table}
            SET ${move.column} = json_set(json_remove(${move.column}, @from), @to, ${move.column} -> @from)
          WHERE ${move.rowKey === undefined ? '' : 'key = @rowKey AND '}json_valid(${move.column})
            AND json_type(${move.column}, @from) IS NOT NULL
            AND json_type(${move.column}, @to) IS NULL`
      )
      .run({ from: move.from, to: move.to, ...(move.rowKey === undefined ? {} : { rowKey: move.rowKey }) }).changes;
    if (changes > 0) {
      done.push(
        `${move.table}.${move.column} ${dollarPath(move.from)} to ${dollarPath(move.to)} (${changes} row(s))`
      );
    }
  }
}

/**
 * Brings a database written under the old vocabulary to the new one. Returns
 * what it did, one phrase each - empty when there was nothing to do, which is
 * every start after the first. getDb() prints the phrases once the transaction
 * has committed.
 *
 * Call it only inside the transaction getDb() opens, and before SCHEMA.
 * Throws `VocabularyConflictError` for two non-empty candidates for the
 * resume table or for the people table.
 *
 * The two blocks are independent calls with a shape test each, in this order:
 * the resume block first, because the people block renames INTO the name the
 * resume block vacates (`profiles`), and a database the resume block renamed
 * long ago (every start after the first) must still reach the people block.
 */
export function renameRetiredVocabulary(db: Database.Database): string[] {
  const done: string[] = [];
  if (hasOldResumeTable(db)) renameResumes(db, done);
  if (hasOldPeopleTable(db)) renamePeopleTable(db, done);
  return done;
}

/**
 * The resume block: `profiles` (the shape with `disabled`) becomes `resumes`,
 * three columns, and the JSON keys that carried the old word. Call it only when
 * `hasOldResumeTable`: its `defaultProfileId` move would otherwise take the
 * people block's default for a resume's on every later start.
 */
function renameResumes(db: Database.Database, done: string[]): void {
  // A stray: a table named for the new vocabulary that exists already. An
  // empty one is no loss either way - the new table an unfinished start made,
  // or the old-shaped one an older build re-created on a renamed database -
  // and two with rows are for a person to decide.
  let renameTable = true;
  if (tableExists(db, RESUME_TABLE)) {
    if (!holdsRows(db, RESUME_TABLE)) {
      db.exec(`DROP TABLE ${RESUME_TABLE}`);
      done.push(`dropped the empty ${RESUME_TABLE} table an unfinished start had made`);
    } else if (!holdsRows(db, OLD_RESUME_TABLE)) {
      db.exec(`DROP TABLE ${OLD_RESUME_TABLE}`);
      done.push(`dropped the empty ${OLD_RESUME_TABLE} table an older build had made`);
      renameTable = false;
    } else {
      throw new VocabularyConflictError(db.name);
    }
  }

  if (renameTable) {
    db.exec(`ALTER TABLE ${OLD_RESUME_TABLE} RENAME TO ${RESUME_TABLE}`);
    done.push(`table ${OLD_RESUME_TABLE} to ${RESUME_TABLE}`);
  }

  for (const [table, columns] of Object.entries(RENAMED_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const have = columnNames(db, table);
    for (const [from, to] of Object.entries(columns)) {
      if (!have.has(from) || have.has(to)) continue;
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
      done.push(`column ${table}.${from} to ${to}`);
    }
  }

  moveJsonKeys(db, RESUME_JSON_KEYS, done);
}

/**
 * The people block: `profile_groups` becomes `profiles`, rows untouched, and
 * the settings' `defaultGroupId` becomes `defaultProfileId`. It runs after the
 * resume block, which has by then freed the name `profiles` and moved the
 * settings' old `defaultProfileId` (a resume id) to `defaultResumeId`.
 *
 * Strays, for a `profiles` that exists already:
 *   - with a `disabled` column it is the old resume table, which the resume
 *     block always renames or refuses first - so it is a defect, not data;
 *   - empty: SCHEMA of an earlier start made it; dropped, then the rename;
 *   - holding rows while `profile_groups` is empty: an older build re-created
 *     `profile_groups` at its start; that one is dropped and `profiles` kept;
 *   - both holding rows: refused.
 *
 * Exported for the test that calls it WITHOUT the resume block first, which
 * `renameRetiredVocabulary` never does: nothing else may call it.
 */
export function renamePeopleTable(db: Database.Database, done: string[]): void {
  let renameTable = true;
  if (tableExists(db, PEOPLE_TABLE)) {
    if (columnNames(db, PEOPLE_TABLE).has('disabled')) {
      throw new Error(
        `The "${PEOPLE_TABLE}" table still has the old resume table's "disabled" column after the resume ` +
          `rename ran, so "${OLD_PEOPLE_TABLE}" cannot be renamed to it. This is a defect in the upgrade step.`
      );
    }
    if (!holdsRows(db, PEOPLE_TABLE)) {
      db.exec(`DROP TABLE ${PEOPLE_TABLE}`);
      done.push(`dropped the empty ${PEOPLE_TABLE} table an unfinished start had made`);
    } else if (!holdsRows(db, OLD_PEOPLE_TABLE)) {
      db.exec(`DROP TABLE ${OLD_PEOPLE_TABLE}`);
      done.push(`dropped the empty ${OLD_PEOPLE_TABLE} table an older build had made`);
      renameTable = false;
    } else {
      throw new VocabularyConflictError(db.name, [OLD_PEOPLE_TABLE, PEOPLE_TABLE], 'what build 4.1 called a group of resumes');
    }
  }

  if (renameTable) {
    db.exec(`ALTER TABLE ${OLD_PEOPLE_TABLE} RENAME TO ${PEOPLE_TABLE}`);
    done.push(`table ${OLD_PEOPLE_TABLE} to ${PEOPLE_TABLE}`);
  }

  moveJsonKeys(db, PROFILE_JSON_KEYS, done);
}

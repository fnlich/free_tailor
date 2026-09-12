import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runDataMigrations } from './migrations';

const POSIX_DEFAULT_DATABASE_DIR = '/data/db';

/**
 * Where the database lives when `DB_DIR` is not set.
 *
 * `/data/db` is the container convention this app was built around, and it
 * stays the default everywhere it means something. On Windows it means
 * nothing: `path.resolve('/data/db')` is `C:\data\db`, and creating a
 * directory at the root of the system drive needs administrator rights, so the
 * first `getDb()` fails with EPERM before the server has done anything.
 * Windows gets the platform's own answer for per-user application data
 * instead, which is writable without elevation and survives reinstalls.
 */
export function getDefaultDatabaseDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir
): string {
  if (platform !== 'win32') {
    return POSIX_DEFAULT_DATABASE_DIR;
  }

  // LOCALAPPDATA is the roaming-excluded profile store and is set on every
  // supported Windows; APPDATA and the profile are only fallbacks for a
  // stripped service environment.
  const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (base) {
    return path.win32.join(base, 'free_tailor', 'db');
  }
  return path.win32.join(homedir(), 'AppData', 'Local', 'free_tailor', 'db');
}

const DATABASE_FILE_NAME = 'free_tailor.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_overrides (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id          TEXT PRIMARY KEY,
    feature_key TEXT,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    type      TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    skill     TEXT NOT NULL,
    priority  INTEGER,
    category  TEXT,
    PRIMARY KEY (type, skill_key)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );

  /**
   * Generation batches, so a run survives the server restarting.
   *
   * Two tables rather than one blob per batch, because the write pattern is
   * lopsided: a batch is written once and read rarely, while its tasks change
   * state four times each. Thirty resumes is a hundred and twenty transitions,
   * and re-writing the whole batch each time would mean re-writing every job
   * description with it - about a megabyte a transition for a sheet import.
   *
   * The job descriptions live HERE, on the batch, once. A task refers to its job
   * by index rather than carrying a copy, which is the same saving again: thirty
   * tasks on one job would otherwise hold thirty copies of its posting.
   */
  CREATE TABLE IF NOT EXISTS generation_batches (
    id         TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generation_tasks (
    id         TEXT PRIMARY KEY,
    batch_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    state      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_generation_tasks_batch
    ON generation_tasks (batch_id, seq);

  /**
   * Accounts.
   *
   * The EMAIL is the identity, not the Google subject id: the two sign-in paths
   * must land on the SAME account, and somebody who signed in with a code on
   * Monday and with Google on Tuesday has one account, not two. google_sub is
   * recorded when Google is used so a later address change on the Google side
   * does not strand them, but it is not what rows are found by.
   *
   * Stored lowercased and trimmed, and UNIQUE, so the database refuses the
   * duplicate rather than trusting every caller to normalize first.
   */
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    picture       TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user',
    plan          TEXT NOT NULL DEFAULT 'default',
    credits       INTEGER NOT NULL DEFAULT 0,
    google_sub    TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  /**
   * Live sign-ins, one row per session token.
   *
   * A table rather than a self-contained signed token, because logging out has
   * to MEAN something. A stateless token cannot be withdrawn before it expires,
   * so "disable this account" would leave whoever holds one signed in for the
   * rest of the day - and disabling an account is exactly the moment that must
   * not be true.
   *
   * Only the hash is kept. A stolen database then yields no usable session.
   */
  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

  /**
   * Six-digit codes sent by email, hashed the same way and for the same reason.
   *
   * The attempt count is on the row rather than in memory so the limit
   * survives a restart - otherwise restarting the server is a way to reset
   * somebody's guess counter.
   */
  CREATE TABLE IF NOT EXISTS login_codes (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email, created_at);

  CREATE TABLE IF NOT EXISTS schema_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );
`;

const connections = new Map<string, Database.Database>();

export function getDatabaseDir(): string {
  const configured = process.env.DB_DIR?.trim();
  return configured ? path.resolve(configured) : getDefaultDatabaseDir();
}

export function getDatabasePath(): string {
  return path.join(getDatabaseDir(), DATABASE_FILE_NAME);
}

/**
 * Columns added to tables that already exist.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a database that has the
 * table, so a column added to SCHEMA later never reaches an existing install -
 * it appears on a fresh checkout and nowhere else, which is the kind of
 * difference that only shows up in production. `ALTER TABLE ADD COLUMN` is what
 * reaches both, and SQLite makes it cheap: it rewrites no rows.
 *
 * Run before any migration and before any query, since a data migration that
 * writes one of these columns needs it to exist first.
 */
function addMissingColumns(db: Database.Database): void {
  const additions: Array<{ table: string; column: string; definition: string }> = [
    // Ownership. NULL means "from before accounts existed", which migration 003
    // then hands to the first admin - it is not a valid state to stay in, but it
    // is the state every upgraded row starts in and the column has to allow it.
    { table: 'profiles', column: 'owner_id', definition: "TEXT" },
    { table: 'profile_groups', column: 'owner_id', definition: 'TEXT' },
  ];

  for (const addition of additions) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${addition.table})`).all() as Array<{ name: string }>;
      if (columns.length === 0) continue;
      if (columns.some((column) => column.name === addition.column)) continue;
      db.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
    } catch (error) {
      // Never fatal, for the same reason the data migrations are not: a column
      // this build wanted and could not add leaves the app reading the table
      // exactly as the previous build did.
      console.error(
        `[db] Could not add ${addition.table}.${addition.column}; continuing without it.`,
        error
      );
    }
  }
}

/**
 * Returns the shared SQLite connection for the configured database directory.
 * The connection is opened lazily and the schema is created on first use.
 */
export function getDb(): Database.Database {
  const filePath = getDatabasePath();
  const existing = connections.get(filePath);
  if (existing) {
    return existing;
  }

  const directory = path.dirname(filePath);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    // The single most common first-run failure, and the raw EACCES/EPERM says
    // nothing about what to do next. It is also where the two platforms differ
    // most: `/data/db` copied out of `.env.example` needs `sudo mkdir` on
    // Ubuntu and cannot be created at all without elevation on Windows, where
    // it means `C:\data\db`.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot create the database directory "${directory}": ${reason}. ` +
        'Set DB_DIR in the repository .env to a writable path (for example DB_DIR=./data/db), ' +
        'or create that directory and give this user write access to it.'
    );
  }

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  addMissingColumns(db);
  // The connection is registered BEFORE the migrations run. That ordering is
  // load-bearing: a migration (or anything it logs through) that reaches for
  // getDb() would otherwise recurse into opening a second connection to the
  // same file. Do not move this line below runDataMigrations.
  connections.set(filePath, db);
  runDataMigrations(db);
  return db;
}

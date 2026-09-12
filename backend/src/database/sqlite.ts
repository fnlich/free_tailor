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
  // The connection is registered BEFORE the migrations run. That ordering is
  // load-bearing: a migration (or anything it logs through) that reaches for
  // getDb() would otherwise recurse into opening a second connection to the
  // same file. Do not move this line below runDataMigrations.
  connections.set(filePath, db);
  runDataMigrations(db);
  return db;
}

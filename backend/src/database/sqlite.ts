import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runDataMigrations } from './migrations';

export const DEFAULT_DATABASE_DIR = '/data/db';
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

  CREATE TABLE IF NOT EXISTS schema_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );
`;

const connections = new Map<string, Database.Database>();

export function getDatabaseDir(): string {
  const configured = process.env.DB_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_DATABASE_DIR;
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

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

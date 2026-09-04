const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function makeTempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailor-${name}-`));
}

/**
 * Points the SQLite database and the static asset directory at fresh temp
 * folders so each test runs against isolated storage.
 */
function useTempStorage(name) {
  const rootDir = makeTempDataDir(name);
  const dbDir = path.join(rootDir, 'db');
  const staticDir = path.join(rootDir, 'static');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(staticDir, { recursive: true });
  process.env.DB_DIR = dbDir;
  process.env.TAILOR_STATIC_DIR = staticDir;
  return { rootDir, dbDir, staticDir };
}

function writeStaticJson(staticDir, relativePath, value) {
  const filePath = path.join(staticDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function openTestDb(dbDir) {
  return new Database(path.join(dbDir, 'free_tailor.db'));
}

function readDocument(dbDir, table, id) {
  const db = openTestDb(dbDir);
  try {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  } finally {
    db.close();
  }
}

function readSettingRaw(dbDir, key) {
  const db = openTestDb(dbDir);
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

function writeSettingRaw(dbDir, key, value) {
  const db = openTestDb(dbDir);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT
      );
    `);
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value, new Date().toISOString());
  } finally {
    db.close();
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

module.exports = {
  loadFresh,
  makeTempDataDir,
  readDocument,
  readJson,
  readSettingRaw,
  useTempStorage,
  writeSettingRaw,
  writeStaticJson,
};

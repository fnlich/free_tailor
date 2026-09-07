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

/** Lines of a recorded `claude` CLI event stream, from test/fixtures/cli. */
function readCliFixture(name) {
  const filePath = path.join(__dirname, 'fixtures', 'cli', `${name}.ndjson`);
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

/**
 * A CliRunner that replays a recorded stream instead of spawning anything.
 *
 * This is the seam the whole provider suite runs on: no `claude` binary, no
 * network, no subprocess. `script` is either one step or a function of
 * (spec, callIndex) so a test can vary behaviour per call.
 *
 * A step may set:
 *   lines      - NDJSON lines to feed, in order
 *   chunks     - raw byte chunks to feed instead, so line splitting is
 *                exercised across real chunk boundaries
 *   exitCode, stderr, timedOut, stalled, aborted, spawnError
 */
function makeFakeCliRunner(script) {
  const calls = [];

  return {
    calls,
    async run(spec) {
      calls.push({
        binary: spec.binary,
        argv: [...spec.argv],
        env: spec.env,
        cwd: spec.cwd,
        stdin: spec.stdin,
        deadlineMs: spec.deadlineMs,
      });

      // Awaited so a script may be async and hold the slot for a measurable
      // moment, which is how the concurrency bound is observed at all.
      const step = await (typeof script === 'function' ? script(spec, calls.length - 1) : script);
      if (step.spawnError) {
        return {
          exitCode: null, signal: null, stderrTail: '', timedOut: false,
          stalled: false, aborted: false, spawnError: step.spawnError, bytesRead: 0,
        };
      }

      if (Array.isArray(step.chunks)) {
        // Feed raw bytes and split here exactly as the real runner does, so a
        // fixture split mid-line or mid-UTF-8 character is exercised for real.
        let buffered = Buffer.alloc(0);
        for (const chunk of step.chunks) {
          buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
          for (;;) {
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) break;
            spec.onLine(buffered.subarray(0, newline).toString('utf8'));
            buffered = buffered.subarray(newline + 1);
          }
        }
        if (buffered.length > 0) {
          spec.onLine(buffered.toString('utf8'));
        }
      } else {
        for (const line of step.lines ?? []) {
          spec.onLine(line);
        }
      }

      return {
        exitCode: step.exitCode ?? 0,
        signal: null,
        stderrTail: step.stderr ?? '',
        timedOut: Boolean(step.timedOut),
        stalled: Boolean(step.stalled),
        aborted: Boolean(step.aborted),
        spawnError: null,
        bytesRead: 0,
      };
    },
  };
}

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

module.exports = {
  loadFresh,
  makeFakeCliRunner,
  readCliFixture,
  makeTempDataDir,
  readDocument,
  readJson,
  readSettingRaw,
  useTempStorage,
  writeSettingRaw,
  writeStaticJson,
};

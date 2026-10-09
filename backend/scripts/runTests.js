#!/usr/bin/env node
'use strict';

/**
 * Runs the backend test suite inside a temporary directory of its own, and
 * removes that directory when the suite ends.
 *
 * Why it exists: the suite makes a fresh directory for nearly every test - a
 * database here, a static tree there, a fake CLI's home - always through
 * `os.tmpdir()`, and nothing ever deleted them. One `npm test` left about 760
 * directories in the system temp dir, and running the suite a few dozen times
 * in a day filled a disk. Cleaning up in each test would be eighty files of
 * `after()` hooks that a new test forgets; pointing the whole run at one root
 * and deleting the root is one place that cannot be forgotten.
 *
 * `os.tmpdir()` reads TMPDIR on Linux and macOS and TEMP / TMP on Windows, so
 * all three are set - which also reaches every child a test spawns, since it
 * inherits this environment. `fs.mkdtemp` under `os.tmpdir()` therefore lands
 * inside the run's root on every platform.
 *
 * `node --test` is started as `process.execPath` with no shell, and it expands
 * `test/*.test.js` itself, so the same line works from cmd.exe, PowerShell and
 * sh. Arguments are passed through, so `node scripts/runTests.js
 * test/orderRoutes.test.js` runs one file the same way - after `npm run build`,
 * because the tests load `dist/`.
 *
 * DB_DIR is pointed at a directory inside the root too, whatever the
 * environment says. A test that loads a module reading the database before it
 * calls `useTempStorage` - the PDF generator reads the skill library as it
 * loads - otherwise opened the DEFAULT database directory (`/data/db` on
 * Linux), or whatever an operator's shell or `.env` names: a real install's
 * database, written by the suite, and refused by the startup guard when it is
 * one an older build left unfinished.
 *
 * TAILOR_KEEP_TEST_TMP=1 keeps the root and prints where it is, for looking at
 * what a failing test left behind.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND_DIR = path.join(__dirname, '..');
const keep = process.env.TAILOR_KEEP_TEST_TMP === '1';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-test-run-'));
const dbDir = path.join(root, 'db');
fs.mkdirSync(dbDir);
const patterns = process.argv.slice(2);
const args = ['--test', ...(patterns.length > 0 ? patterns : ['test/*.test.js'])];

const child = spawn(process.execPath, args, {
  cwd: BACKEND_DIR,
  env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root, DB_DIR: dbDir },
  stdio: 'inherit',
});

/** Removes the run's root, unless asked to keep it. Never throws: the exit code is the suite's. */
function cleanUp() {
  if (keep) {
    console.log(`[tests] Kept the run's temporary directory: ${root}`);
    return;
  }
  try {
    // Retried: on Windows a file a test just closed can stay locked for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`[tests] Could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Ctrl+C reaches the child too (same process group); these make sure the root
// is still removed when the run is interrupted rather than finished.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(`[tests] Could not start the test runner: ${error.message}`);
  cleanUp();
  process.exit(1);
});

child.on('exit', (code, signal) => {
  cleanUp();
  // A suite killed by a signal is a failed run, never a passing one.
  process.exit(typeof code === 'number' ? code : signal ? 1 : 0);
});

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

/**
 * scripts/runTests.js, the one way `npm test` starts the suite.
 *
 * A test that reads the database before it calls `useTempStorage` - anything
 * that loads the PDF generator, which reads the skill library as it loads -
 * opened whatever DB_DIR said, and with nothing set, the default `/data/db`:
 * a real install's database, written by the suite. The runner now points
 * DB_DIR inside its own temporary root, over whatever the environment names,
 * and removes it with the root.
 */

const RUNNER = path.join(__dirname, '..', 'scripts', 'runTests.js');

test('a test run gets a database directory of its own inside the run root, whatever DB_DIR says outside', () => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-probe-'));
  const probe = path.join(probeDir, 'probe.test.js');
  const report = path.join(probeDir, 'report.json');
  fs.writeFileSync(
    probe,
    [
      "const fs = require('node:fs');",
      "const os = require('node:os');",
      "require('node:test')('probe', () => {",
      `  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ dbDir: process.env.DB_DIR, tmp: os.tmpdir(), exists: fs.existsSync(process.env.DB_DIR) }));`,
      '});',
    ].join('\n')
  );

  const outside = path.join(probeDir, 'a-real-install');
  // Without NODE_TEST_CONTEXT: it marks a process this file's own runner
  // started, and a `node --test` that sees it reports to that runner instead
  // of running the probe.
  const env = { ...process.env, DB_DIR: outside };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [RUNNER, probe], {
    env,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const seen = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.notEqual(seen.dbDir, outside, 'the environment\'s DB_DIR is not the suite\'s');
  assert.equal(path.dirname(seen.dbDir), seen.tmp, 'it is inside the run\'s own root');
  assert.equal(seen.exists, true, 'and exists before the first test runs');
  assert.equal(fs.existsSync(seen.dbDir), false, 'and goes with the root when the run ends');
  assert.equal(fs.existsSync(outside), false, 'nothing was made where the environment pointed');
});

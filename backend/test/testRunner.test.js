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

test('a test run never reads a real Google credential: the search off and both path variables empty, whatever the environment says', () => {
  // A checkout holding a credential beside the compiled code lent it to every test, and each test
  // sign-in allocated a real spreadsheet in that Google account. The runner turns the search off.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-google-'));
  const probe = path.join(probeDir, 'probe.test.js');
  const report = path.join(probeDir, 'report.json');
  fs.writeFileSync(
    probe,
    [
      "const fs = require('node:fs');",
      "require('node:test')('probe', () => {",
      '  const env = process.env;',
      `  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
      '    search: env.TAILOR_GOOGLE_CREDENTIAL_SEARCH,',
      "    credentials: env.GOOGLE_CREDENTIALS_PATH ?? 'unset',",
      "    serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? 'unset',",
      '  }));',
      '});',
    ].join('\n')
  );
  const env = {
    ...process.env,
    TAILOR_GOOGLE_CREDENTIAL_SEARCH: 'on',
    GOOGLE_CREDENTIALS_PATH: path.join(probeDir, 'real-oauth.json'),
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: path.join(probeDir, 'real-key.json'),
  };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [RUNNER, probe], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), { search: 'off', credentials: '', serviceAccount: '' });
  fs.rmSync(probeDir, { recursive: true, force: true });
});

test('an e2e backend never reads a real Google credential: every preload requires no-google.js first, and every backend command loads a preload - none is started through npm or ts-node-dev', () => {
  const e2e = path.join(__dirname, 'e2e');
  // Every preload there is - a stub added later is held to it too.
  const preloads = fs.readdirSync(e2e).filter((name) => /^stub-[a-z0-9-]+\.js$/.test(name) || name === 'fake-providers.js');
  assert.ok(preloads.length >= 5, `found the preloads: ${preloads.join(', ')}`);
  for (const name of preloads) {
    const source = fs.readFileSync(path.join(e2e, name), 'utf8');
    const firstRequire = source.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
    assert.equal(firstRequire?.[1], './no-google', `${name} requires no-google.js before anything else`);
  }
  // no-google.js sets exactly what the runner sets.
  const saved = { ...process.env };
  try {
    process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH = 'on';
    process.env.GOOGLE_CREDENTIALS_PATH = '/somewhere/real.json';
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH = '/somewhere/key.json';
    const file = require.resolve(path.join(e2e, 'no-google.js'));
    delete require.cache[file];
    require(file);
    assert.deepEqual(
      [process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH, process.env.GOOGLE_CREDENTIALS_PATH, process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH],
      ['off', '', '']
    );
  } finally {
    for (const key of ['TAILOR_GOOGLE_CREDENTIAL_SEARCH', 'GOOGLE_CREDENTIALS_PATH', 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  // Every command that starts a backend (`dist/index.js`, a continued line joined) loads one of
  // those preloads, or no-google.js itself: in the e2e README's code blocks, and in each
  // script's own comments - the usage a reader copies from the file they are about to run.
  const loadsAPreload = new RegExp(
    `--require \\./test/e2e/(${['no-google.js', ...preloads].map((name) => name.replace(/[.-]/g, '\\$&')).join('|')})(\\s|\`|$)`
  );
  const readme = fs.readFileSync(path.join(e2e, 'README.md'), 'utf8');
  const blocks = [...readme.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((match) => match[1].replace(/\\\r?\n\s*/g, ' '));
  const readmeStarts = blocks.flatMap((block) => block.split(/\r?\n/)).filter((line) => /\bdist\/index\.js\b/.test(line));
  assert.ok(readmeStarts.length >= 10, `found ${readmeStarts.length} backend commands in the README`);
  for (const line of readmeStarts) assert.match(line, loadsAPreload, `README.md: ${line}`);
  const scriptStarts = fs
    .readdirSync(e2e)
    .filter((name) => name.endsWith('.js'))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(e2e, name), 'utf8')
        // A comment's continued line joined to the one before it, its ` * ` dropped.
        .replace(/\\\r?\n\s*(\*|\/\/)?\s*/g, ' ')
        .split(/\r?\n/)
        .filter((line) => /\bdist\/index\.js\b/.test(line))
        .map((line) => ({ name, line: line.trim() }))
    );
  assert.ok(scriptStarts.length >= 10, `found ${scriptStarts.length} backend commands in the scripts`);
  for (const { name, line } of scriptStarts) assert.match(line, loadsAPreload, `${name}: ${line}`);

  // Nor does any of them send a reader to a backend started another way, none of which can take a
  // preload: the root `dev`, `dev:live` and `dev:poll` (and `dev:backend`), the backend's own `dev`,
  // `dev:poll` and `start`, or ts-node-dev. shell.js said "Servers are expected to be up already
  // (`npm run dev`)", and three scripts pointed at it. A command with `--prefix frontend` starts no
  // backend. Checked in the README's prose (a paragraph at a time) and code (a line at a time, a
  // continued line joined), and in every script, comments and all; the two passages that tell the
  // history of the root dev script - what dev-reload.js is about - are named here, and must still be
  // there.
  const BACKEND_SCRIPTS = new Set(['dev', 'dev:live', 'dev:poll', 'dev:backend', 'dev:backend:poll', 'start']);
  const ABOUT_THE_DEV_SCRIPT = [
    'with the root `npm run dev` running, opening',
    'So the root `npm run dev` runs `dev:turbo`, and `npm run dev:live` keeps webpack for whoever asks for it by name',
  ];
  const readmeUnits = readme.split(/^```[a-z]*\r?$/m).flatMap((part, index) =>
    index % 2 === 1
      ? part.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
      : part.split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.replace(/\s+/g, ' '))
  );
  const units = [
    ...readmeUnits.map((text) => ({ name: 'README.md', text })),
    ...fs
      .readdirSync(e2e)
      .filter((name) => name.endsWith('.js'))
      .flatMap((name) =>
        fs
          .readFileSync(path.join(e2e, name), 'utf8')
          .replace(/\\\r?\n\s*(\*|\/\/)?\s*/g, ' ')
          .split(/\r?\n/)
          .map((text) => ({ name, text }))
      ),
  ];
  const named = new Set();
  const otherStarts = [];
  for (const { name, text } of units) {
    let rest = text;
    for (const passage of ABOUT_THE_DEV_SCRIPT) {
      if (rest.includes(passage)) named.add(passage);
      rest = rest.split(passage).join(' ');
    }
    if (/\bts-node-dev\b/.test(rest)) otherStarts.push(`${name}: ${text.trim()}`);
    for (const [, script, args] of rest.matchAll(/\bnpm (?:run )?([a-z]+(?::[a-z-]+)*)([^`#;&|]*)/g)) {
      if (BACKEND_SCRIPTS.has(script) && !/--prefix (?:\.\.\/)?frontend\b/.test(args)) otherStarts.push(`${name}: ${text.trim()}`);
    }
  }
  assert.deepEqual(otherStarts, [], 'an e2e backend is started with `node --require <a preload> dist/index.js`, never through npm or ts-node-dev');
  assert.deepEqual(
    ABOUT_THE_DEV_SCRIPT.filter((passage) => !named.has(passage)),
    [],
    'a passage named as the history of the root dev script is no longer in the README or dev-reload.js: drop it from the list'
  );
});

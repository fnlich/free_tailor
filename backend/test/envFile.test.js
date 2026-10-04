const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadFresh } = require('./helpers');

/**
 * What the doctors report about the `.env` they read.
 *
 * THE FAILURE THIS SERVES. "SMTP_HOST is not set" against a file that visibly
 * contains it has four causes that are indistinguishable from the outside: a
 * DIFFERENT file was read (the path resolves from the compiled module, so it is
 * always the repository root and never `backend/`), a later duplicate key won,
 * the encoding did not decode, or the edit was never saved. The summary exists to
 * separate them, so each of those is pinned below.
 *
 * No `.env` is touched: every case is a file written to a temp directory.
 */

const SECRET = 're_thisIsAnApiKeyAndMustNeverBePrinted';
const BODY =
  'SMTP_HOST=smtp.resend.com\n' +
  '# a comment, and a commented assignment that must not count:\n' +
  '#SMTP_IGNORED=no\n' +
  'SMTP_USER=resend\n' +
  `SMTP_PASS=${SECRET}\n` +
  'export ADMIN_EMAILS=you@example.com\n';

function writeFixture(name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-summary-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

function summarize(file) {
  return loadFresh('../dist/config/envFile').summarizeEnvFile(file);
}

test('a UTF-8 file reports its keys, and ignores comments', () => {
  const summary = summarize(writeFixture('.env', Buffer.from(BODY, 'utf8')));

  assert.equal(summary.exists, true);
  assert.equal(summary.encoding, 'utf8');
  assert.deepEqual(summary.keys, ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ADMIN_EMAILS']);
  assert.deepEqual(summary.duplicates, []);
  // `export FOO=` is valid in a .env and must be counted; `#SMTP_IGNORED=` must not.
  assert.ok(!summary.keys.includes('SMTP_IGNORED'));
});

test('a UTF-16 file written by PowerShell reads the same, which is the point', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BODY, 'utf16le')]);
  const summary = summarize(writeFixture('.env', utf16));

  assert.equal(summary.encoding, 'utf16le');
  assert.deepEqual(
    summary.keys,
    ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ADMIN_EMAILS'],
    'PowerShell writes UTF-16 from > and Set-Content, and the summary must survive it'
  );
});

test('a duplicated key is named, because dotenv keeps the last and says nothing', () => {
  const summary = summarize(
    writeFixture('.env', Buffer.from(`${BODY}SMTP_HOST=this-one-wins\n`, 'utf8'))
  );

  assert.deepEqual(summary.duplicates, ['SMTP_HOST']);
  assert.equal(
    summary.keys.filter((key) => key === 'SMTP_HOST').length,
    1,
    'listed once in keys, and separately as a duplicate'
  );
});

test('a missing file is reported as missing rather than throwing', () => {
  const summary = summarize(path.join(os.tmpdir(), 'definitely-not-here', '.env'));
  assert.equal(summary.exists, false);
  assert.equal(summary.encoding, 'absent');
  assert.deepEqual(summary.keys, []);
});

test('NO VALUE ever appears in the summary - it is printed and pasted into chat', () => {
  const summary = summarize(writeFixture('.env', Buffer.from(BODY, 'utf8')));

  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(SECRET), 'an API key must never reach a terminal or a bug report');
  assert.ok(!serialized.includes('smtp.resend.com'), 'names only, so no value can leak by accident');
  assert.ok(!serialized.includes('you@example.com'));
});

test('a bare NAME= is listed as empty, because it is in the file and sets no value', () => {
  // The shape .env.example ships dozens of: copied as-is, every one of these
  // names is "in the file", and a doctor reporting `keys` alone told an
  // operator GOOGLE_CREDENTIALS_PATH was found when it was not in effect.
  const text =
    'GOOGLE_CREDENTIALS_PATH=\n' +
    'GOOGLE_SERVICE_ACCOUNT_KEY_PATH=   \n' +
    'SHEET_TIMEZONE=Europe/Berlin\n' +
    'SMTP_HOST=first\n' +
    // The LAST assignment is the one the loader keeps, so this is empty.
    'SMTP_HOST=\n' +
    'QUOTED_EMPTY=""\n' +
    'SMTP_USER=resend # a comment is not a value\n';

  // In every encoding the loader decodes - PowerShell's above all, since the
  // empty list is computed from the decoded text and a refactor that parsed
  // the raw bytes would quietly report nothing as empty on Windows.
  const encodings = {
    utf8: Buffer.from(text, 'utf8'),
    utf16le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    utf16be: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
  };

  for (const [encoding, buffer] of Object.entries(encodings)) {
    const summary = summarize(writeFixture('.env', buffer));
    assert.equal(summary.encoding, encoding);
    assert.deepEqual(
      summary.empty,
      ['GOOGLE_CREDENTIALS_PATH', 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH', 'SMTP_HOST', 'QUOTED_EMPTY'],
      encoding
    );
    assert.ok(summary.keys.includes('GOOGLE_CREDENTIALS_PATH'), 'still a key: it IS in the file');
    assert.ok(!summary.empty.includes('SHEET_TIMEZONE'), encoding);
    assert.ok(!summary.empty.includes('SMTP_USER'), encoding);
  }
});

// -- which wins: the environment or the file -------------------------------- //

test('the environment beats the file, and a key only in the file is applied', () => {
  const { applyEnvFile } = loadFresh('../dist/config/envFile');
  // `DB_DIR=/tmp/ft-db PORT=3001 node backend/dist/index.js` - the command
  // CLAUDE.md documents - was silently ignored whenever the file set either.
  const env = { PORT: '4000', DB_DIR: '/tmp/ft-db' };
  const outcome = applyEnvFile({ PORT: '3001', DB_DIR: '/data/db', SMTP_HOST: 'smtp.example.com' }, env);

  assert.deepEqual(env, { PORT: '4000', DB_DIR: '/tmp/ft-db', SMTP_HOST: 'smtp.example.com' });
  assert.deepEqual(outcome.applied, ['SMTP_HOST']);
  assert.deepEqual(outcome.shadowed, ['PORT', 'DB_DIR']);
});

test('an exported empty value still counts as set, as it does for the frontend', () => {
  // frontend/scripts/next.mjs skips any `key in process.env`; the two halves
  // must not disagree about a variable exported empty on purpose.
  const { applyEnvFile } = loadFresh('../dist/config/envFile');
  const env = { SMTP_HOST: '' };
  const outcome = applyEnvFile({ SMTP_HOST: 'smtp.example.com' }, env);
  assert.equal(env.SMTP_HOST, '');
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(outcome.shadowed, ['SMTP_HOST']);

  // And a bare `NAME=` in the file no longer blanks a value exported in a shell.
  const shell = { GOOGLE_CREDENTIALS_PATH: '/srv/creds.json' };
  applyEnvFile({ GOOGLE_CREDENTIALS_PATH: '' }, shell);
  assert.equal(shell.GOOGLE_CREDENTIALS_PATH, '/srv/creds.json');
});

test('a key set to the SAME value in both is not news, and an inherited name is not "set"', () => {
  const { applyEnvFile } = loadFresh('../dist/config/envFile');
  const outcome = applyEnvFile({ PORT: '3001', constructor: 'x' }, { PORT: '3001' });
  assert.deepEqual(outcome.shadowed, []);
  // A plain object inherits `constructor`; only an OWN name counts as set.
  assert.deepEqual(outcome.applied, ['constructor']);
});

test('a key set to a different value in both is named as shadowed, and no value appears', () => {
  const file = writeFixture('.env', Buffer.from(BODY, 'utf8'));
  const { summarizeEnvFile } = loadFresh('../dist/config/envFile');

  // Read against the environment as it is after the load: SMTP_USER and
  // SMTP_PASS were applied from the file and hold its values; SMTP_HOST was
  // exported with another value and kept it.
  const env = { SMTP_HOST: 'smtp.other.example', SMTP_USER: 'resend', SMTP_PASS: SECRET };
  const summary = summarizeEnvFile(file, env);
  assert.deepEqual(summary.shadowed, ['SMTP_HOST']);

  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes('smtp.other.example'), 'the environment value is never in it either');
  assert.ok(!serialized.includes(SECRET));

  // With nothing exported, nothing is shadowed; a missing file shadows nothing.
  assert.deepEqual(summarizeEnvFile(file, {}).shadowed, []);
  assert.deepEqual(summarizeEnvFile(path.join(os.tmpdir(), 'definitely-not-here', '.env'), env).shadowed, []);
});

test('both loaders keep the rule: the backend applies the file through applyEnvFile, next.mjs skips what is set', () => {
  // Neither is run here - config/env.ts loads the real .env on import, and a
  // test never spawns next.mjs - so the rule is pinned in their source, which
  // is where it regressed before: the backend copied every key over
  // process.env while the frontend skipped them.
  const backend = fs.readFileSync(path.join(__dirname, '..', 'dist', 'config', 'env.js'), 'utf8');
  assert.match(backend, /applyEnvFile\)?\(/);
  assert.doesNotMatch(backend, /process\.env\[key\]\s*=/);
  assert.match(backend, /set both in the environment and in/);

  const frontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'scripts', 'next.mjs'), 'utf8');
  assert.match(frontend, /if \(key in process\.env\) \{/);
  assert.match(frontend, /set both in the environment and in/);
});

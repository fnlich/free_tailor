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

test('a bare NAME= is listed as empty, because it is in the file and sets nothing', () => {
  // The shape .env.example ships dozens of: copied as-is, every one of these
  // names is "in the file", and a doctor reporting `keys` alone told an
  // operator GOOGLE_CREDENTIALS_PATH was found when it was not in effect.
  const summary = summarize(
    writeFixture(
      '.env',
      Buffer.from(
        'GOOGLE_CREDENTIALS_PATH=\n' +
          'GOOGLE_SERVICE_ACCOUNT_KEY_PATH=   \n' +
          'SHEET_TIMEZONE=Europe/Berlin\n' +
          'SMTP_HOST=first\n' +
          // The LAST assignment is the one the loader keeps, so this is empty.
          'SMTP_HOST=\n' +
          'QUOTED_EMPTY=""\n' +
          'SMTP_USER=resend # a comment is not a value\n',
        'utf8'
      )
    )
  );

  assert.deepEqual(summary.empty, [
    'GOOGLE_CREDENTIALS_PATH',
    'GOOGLE_SERVICE_ACCOUNT_KEY_PATH',
    'SMTP_HOST',
    'QUOTED_EMPTY',
  ]);
  assert.ok(summary.keys.includes('GOOGLE_CREDENTIALS_PATH'), 'still a key: it IS in the file');
  assert.ok(!summary.empty.includes('SHEET_TIMEZONE'));
  assert.ok(!summary.empty.includes('SMTP_USER'));
});

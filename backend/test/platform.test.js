const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getDefaultDatabaseDir } = require('../dist/database/sqlite');
const { readEnvFileText } = require('../dist/config/envFile');
const { findApiPortMismatch } = require('../dist/config/apiUrl');

// The app has to start on Windows and on Ubuntu from the same checkout, and
// the default data directory is the one place where the right answer genuinely
// differs. The function takes its platform, environment and home directory as
// arguments so both branches are covered from either host.

test('Linux and macOS keep the container-conventional /data/db default', () => {
  assert.equal(getDefaultDatabaseDir('linux', {}, () => '/home/dev'), '/data/db');
  assert.equal(getDefaultDatabaseDir('darwin', {}, () => '/Users/dev'), '/data/db');
});

test('Windows defaults into the per-user application data directory', () => {
  // path.resolve('/data/db') on Windows is C:\data\db, and creating a
  // directory at the root of the system drive needs elevation, so the very
  // first getDb() would fail before the server had done anything.
  assert.equal(
    getDefaultDatabaseDir('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, () => 'C:\\Users\\dev'),
    'C:\\Users\\dev\\AppData\\Local\\free_tailor\\db'
  );
});

test('Windows falls back to APPDATA and then to the profile', () => {
  assert.equal(
    getDefaultDatabaseDir('win32', { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, () => 'C:\\Users\\dev'),
    'C:\\Users\\dev\\AppData\\Roaming\\free_tailor\\db'
  );
  assert.equal(
    getDefaultDatabaseDir('win32', {}, () => 'C:\\Users\\dev'),
    'C:\\Users\\dev\\AppData\\Local\\free_tailor\\db'
  );
});

test('an empty LOCALAPPDATA is treated as unset, not as a relative path', () => {
  assert.equal(
    getDefaultDatabaseDir('win32', { LOCALAPPDATA: '   ', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, () => 'C:\\Users\\dev'),
    'C:\\Users\\dev\\AppData\\Roaming\\free_tailor\\db'
  );
});

// -- .env encoding ---------------------------------------------------------- //
// PowerShell 5.1 is still the default powershell.exe on Windows 10 and 11, and
// both `>` and Set-Content write UTF-16LE. Read as UTF-8 that file parses into
// nothing, so a .env that plainly exists is silently ignored and the app runs
// on defaults. Measured before the fix: dotenv returned {} for the UTF-16 file
// and the frontend's parser produced keys with a NUL between every character.

const ENV_BODY = 'FRONTEND_PORT=4321\nNEXT_PUBLIC_API_URL=http://example:9/api\n';
const NUL = String.fromCharCode(0);
const BOM = String.fromCharCode(0xfeff);

function writeEnvFixture(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-env-'));
  const filePath = path.join(dir, '.env');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

test('a UTF-8 .env reads normally', () => {
  assert.equal(readEnvFileText(writeEnvFixture(Buffer.from(ENV_BODY, 'utf8'))), ENV_BODY);
});

test('a UTF-8 .env with a BOM does not carry the BOM into the first key', () => {
  const file = writeEnvFixture(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ENV_BODY, 'utf8')])
  );
  const text = readEnvFileText(file);
  assert.equal(text, ENV_BODY);
  assert.equal(text.startsWith(BOM), false, 'the first key must not be prefixed by U+FEFF');
});

test('a UTF-16LE .env, as PowerShell writes it, is decoded rather than mangled', () => {
  const file = writeEnvFixture(
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ENV_BODY, 'utf16le')])
  );
  const text = readEnvFileText(file);
  assert.equal(text, ENV_BODY);
  // The failure this replaces: a NUL between every character, which turned
  // FRONTEND_PORT into a key no lookup could ever match.
  assert.equal(text.includes(NUL), false);
});

test('a UTF-16BE .env is decoded too', () => {
  const be = Buffer.from(Buffer.from(ENV_BODY, 'utf16le')).swap16();
  const file = writeEnvFixture(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  assert.equal(readEnvFileText(file), ENV_BODY);
});

test('a missing .env is empty, not a crash', () => {
  assert.equal(readEnvFileText(path.join(os.tmpdir(), 'tailor-no-such-dir', '.env')), '');
});

// -- PORT vs NEXT_PUBLIC_API_URL -------------------------------------------- //
// Two variables that must agree, both spelled out in .env.example. Changing one
// and not the other produces a frontend that builds and runs perfectly while
// every request fails, and the browser cannot describe it: a wrong port and a
// stopped server are the same TypeError. Reported once at startup instead.

test('a same-machine port disagreement is reported', () => {
  const mismatch = findApiPortMismatch('http://localhost:9001/api', 3001);
  assert.ok(mismatch, 'a frontend pointed at 9001 while the server is on 3001 is a mistake');
  assert.equal(mismatch.configuredPort, '9001');
  assert.equal(mismatch.serverPort, '3001');
  assert.equal(mismatch.configuredOrigin, 'http://localhost:9001');
});

test('matching ports say nothing, however the port is written', () => {
  assert.equal(findApiPortMismatch('http://localhost:3001/api', 3001), null);
  assert.equal(findApiPortMismatch('http://127.0.0.1:3001/api', '3001'), null);
  assert.equal(findApiPortMismatch('http://[::1]:3001/api', 3001), null);
});

test('a different host is a split deployment, not a mistake', () => {
  // The port on another machine has nothing to do with this server's, so
  // warning here would cry wolf at every real remote setup.
  assert.equal(findApiPortMismatch('https://api.example.com/api', 3001), null);
  assert.equal(findApiPortMismatch('http://192.168.1.50:9001/api', 3001), null);
});

test('an omitted port is compared as the protocol default', () => {
  // http://localhost/api means port 80, which the backend is not on either.
  const mismatch = findApiPortMismatch('http://localhost/api', 3001);
  assert.ok(mismatch);
  assert.equal(mismatch.configuredPort, '80');
  assert.equal(findApiPortMismatch('https://localhost/api', 443), null);
});

test('an unset or unparseable NEXT_PUBLIC_API_URL is not a mismatch', () => {
  assert.equal(findApiPortMismatch(undefined, 3001), null);
  assert.equal(findApiPortMismatch('', 3001), null);
  assert.equal(findApiPortMismatch('   ', 3001), null);
  assert.equal(findApiPortMismatch('not a url', 3001), null);
});

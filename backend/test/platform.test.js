const assert = require('node:assert/strict');
const test = require('node:test');

const { getDefaultDatabaseDir } = require('../dist/database/sqlite');

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

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeMissingBrowser,
  findInstalledBrowser,
  resolveBrowser,
} = require('../dist/config/browser');

// Windows and Ubuntu both have to work, and neither can be exercised from the
// other, so the platform, the environment and the filesystem are all injected.
function deps({ platform = 'linux', env = {}, files = [], puppeteerPath = null }) {
  const present = new Set(files);
  return {
    platform,
    env,
    fileExists: (candidate) => present.has(candidate),
    puppeteerExecutablePath: () => puppeteerPath,
  };
}

const WINDOWS_ENV = {
  LOCALAPPDATA: 'C:\\Users\\Kelvin\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  USERPROFILE: 'C:\\Users\\Kelvin',
};

const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WINDOWS_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

test('an explicitly configured browser wins over everything else', () => {
  const resolved = resolveBrowser(
    deps({
      env: { PUPPETEER_EXECUTABLE_PATH: '/opt/my-chrome' },
      files: ['/root/.cache/puppeteer/chrome/linux-148/chrome', '/usr/bin/google-chrome'],
      puppeteerPath: '/root/.cache/puppeteer/chrome/linux-148/chrome',
    })
  );
  assert.equal(resolved.executablePath, '/opt/my-chrome');
  assert.equal(resolved.source, 'PUPPETEER_EXECUTABLE_PATH');
});

test('a configured browser is honoured even when the file is missing', () => {
  // Falling back to some other browser would hide the operator's typo behind a
  // render that silently used something they did not choose.
  const resolved = resolveBrowser(
    deps({ env: { CHROME_PATH: '/opt/typo' }, files: ['/usr/bin/google-chrome'] })
  );
  assert.equal(resolved.executablePath, '/opt/typo');
  assert.equal(resolved.source, 'CHROME_PATH');
  // Honoured, but reported as broken: the startup log and /api/health exist to
  // catch this before someone clicks Generate, and they read this flag.
  assert.equal(resolved.exists, false);
});

test('a browser that is really there is reported as present', () => {
  const downloaded = '/root/.cache/puppeteer/chrome/linux-148/chrome';
  assert.equal(
    resolveBrowser(deps({ files: [downloaded], puppeteerPath: downloaded })).exists,
    true
  );
  assert.equal(
    resolveBrowser(deps({ env: { CHROME_PATH: '/usr/bin/chromium' }, files: ['/usr/bin/chromium'] }))
      .exists,
    true
  );
  assert.equal(resolveBrowser(deps({ files: ['/usr/bin/google-chrome'] })).exists, true);
});

test('PUPPETEER_EXECUTABLE_PATH is preferred over CHROME_PATH', () => {
  const resolved = resolveBrowser(
    deps({ env: { PUPPETEER_EXECUTABLE_PATH: '/opt/a', CHROME_PATH: '/opt/b' } })
  );
  assert.equal(resolved.executablePath, '/opt/a');
});

test('a blank setting is ignored rather than resolved to an empty path', () => {
  const resolved = resolveBrowser(
    deps({
      env: { PUPPETEER_EXECUTABLE_PATH: '   ' },
      files: ['/usr/bin/chromium'],
    })
  );
  assert.equal(resolved.executablePath, '/usr/bin/chromium');
  assert.equal(resolved.source, 'installed browser');
});

test("puppeteer's own download is used when it is actually on disk", () => {
  const downloaded = '/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome';
  const resolved = resolveBrowser(
    deps({ files: [downloaded, '/usr/bin/google-chrome'], puppeteerPath: downloaded })
  );
  assert.equal(resolved.executablePath, downloaded);
  assert.equal(resolved.source, 'puppeteer download');
});

// The reported failure: puppeteer names a cache path and a version, and there
// is nothing there, because the postinstall download never ran.
test('a missing download falls back to a browser the machine already has', () => {
  const resolved = resolveBrowser(
    deps({
      platform: 'win32',
      env: WINDOWS_ENV,
      files: [WINDOWS_EDGE],
      puppeteerPath: 'C:\\Users\\Kelvin\\.cache\\puppeteer\\chrome\\win64-148.0.7778.97\\chrome.exe',
    })
  );
  assert.equal(resolved.executablePath, WINDOWS_EDGE);
  assert.equal(resolved.label, 'Microsoft Edge');
  assert.equal(resolved.source, 'installed browser');
});

test('Chrome is preferred over the other Chromium browsers', () => {
  const found = findInstalledBrowser(
    deps({ platform: 'win32', env: WINDOWS_ENV, files: [WINDOWS_EDGE, WINDOWS_CHROME] })
  );
  assert.equal(found.executablePath, WINDOWS_CHROME);
  assert.equal(found.label, 'Google Chrome');
});

test('a per-user Windows install is found, not just a Program Files one', () => {
  const perUser = 'C:\\Users\\Kelvin\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const found = findInstalledBrowser(
    deps({ platform: 'win32', env: WINDOWS_ENV, files: [perUser] })
  );
  assert.equal(found.executablePath, perUser);
});

test('Linux packages and the snap are both found', () => {
  for (const executablePath of [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]) {
    const found = findInstalledBrowser(deps({ platform: 'linux', files: [executablePath] }));
    assert.ok(found, `${executablePath} should be found`);
    assert.equal(found.executablePath, executablePath);
  }
});

test('a macOS install is found in /Applications and under the home directory', () => {
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(
    findInstalledBrowser(deps({ platform: 'darwin', files: [system] })).executablePath,
    system
  );

  const perUser = '/Users/kelvin/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(
    findInstalledBrowser(
      deps({ platform: 'darwin', env: { HOME: '/Users/kelvin' }, files: [perUser] })
    ).executablePath,
    perUser
  );
});

test('resolution reports nothing rather than a path that does not exist', () => {
  assert.equal(
    resolveBrowser(
      deps({
        platform: 'win32',
        env: WINDOWS_ENV,
        puppeteerPath: 'C:\\Users\\Kelvin\\.cache\\puppeteer\\chrome\\win64-148\\chrome.exe',
      })
    ),
    null
  );
});

test('the failure names the repair, not the empty cache directory', () => {
  const message = describeMissingBrowser({ platform: 'win32', env: WINDOWS_ENV });
  assert.match(message, /npm run setup:browser/);
  assert.match(message, /CHROME_PATH/);
  assert.match(message, /\.env/);
  // The old message said only which directory was empty, which is true and
  // useless. Whatever else it says, it has to say what to do.
  assert.ok(message.includes('Fix it with either'), message);
});

test('the failure points at the cache directory actually in use', () => {
  const message = describeMissingBrowser({
    platform: 'linux',
    env: { PUPPETEER_CACHE_DIR: '/srv/puppeteer-cache', HOME: '/home/app' },
  });
  assert.match(message, /\/srv\/puppeteer-cache/);
  assert.doesNotMatch(message, /\/home\/app/);
});

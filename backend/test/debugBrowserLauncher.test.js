const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

/**
 * The launcher the operator runs, and what it will and will not start.
 *
 * These used to test an HTTP endpoint: the backend spawned Chrome on request,
 * from a Start button. It does not any more - `npm run browser:debug` does -
 * and the rules that made that spawn safe did not stop being rules when they
 * moved. Every one of them is pinned here.
 *
 * Asserted against `buildBrowserArgv`'s RETURN VALUE, not against a grep of the
 * source. The tests this replaces read the launcher's file as text, and two of
 * their three assertions were `doesNotMatch` - vacuously true against any file
 * that no longer builds an argv, including an empty one. A moved launcher would
 * have kept them green while shipping nothing.
 */

const {
  DebugBrowserError,
  assertUsablePort,
  buildBrowserArgv,
  defaultProfileDirFor,
  sanitizeBrowserArgs,
  STARTUP_WAIT_MS,
} = require('../dist/scripts/launchDebugBrowsers');

const ARGV = () =>
  buildBrowserArgv({ port: 9222, profileDir: '/tmp/profile-9222', url: 'https://claude.ai/new', env: {} });

test('the browser is never started with the DevTools origin check off', () => {
  // `--remote-allow-origins=*` turns off the check that stops a WEB PAGE from
  // opening a socket to the debug port. With it, any site the operator visits
  // while this browser is running can drive it and read every session in it -
  // which for this profile is their Claude and ChatGPT accounts.
  //
  // Measured against Chrome 148.0.7778.97: with the flag, a WebSocket carrying
  // `Origin: https://evil.example.com` is accepted; without it Chrome answers
  // 403. Puppeteer connects from Node and sends no Origin header at all, so
  // nothing this app does needs the flag.
  const argv = ARGV();
  assert.ok(
    !argv.some((flag) => flag.toLowerCase().startsWith('--remote-allow-origins')),
    'the DevTools origin check must stay on'
  );
  assert.ok(argv.includes('--remote-debugging-address=127.0.0.1'), 'and the port must be on loopback');
});

test('the argv carries the port, the profile and exactly one url', () => {
  const argv = ARGV();
  assert.ok(argv.includes('--remote-debugging-port=9222'));
  assert.ok(argv.includes('--user-data-dir=/tmp/profile-9222'));

  // Exactly one. Chrome refuses to start with more than one URL argument in
  // headless mode ("Multiple targets are not supported in headless mode", exit
  // 13), and headless is how a machine with no display runs this. Further tabs
  // go through PUT /json/new once the port is up.
  const urls = argv.filter((flag) => !flag.startsWith('--'));
  assert.deepEqual(urls, ['https://claude.ai/new']);
});

test('the flags that stop Chrome freezing an unfocused window are passed', () => {
  // Several of these windows run at once and only one can be focused. Chrome
  // throttles and eventually freezes a window it thinks nobody is looking at,
  // and a DOM read against a frozen renderer does not fail - it never returns.
  // The old standalone script had none of these; shipping it as-is would have
  // reintroduced the hang this app is shaped to avoid.
  for (const flag of [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]) {
    assert.ok(ARGV().includes(flag), `missing ${flag}`);
  }
});

test('one profile directory per port, never one shared by all of them', () => {
  // Chrome will not open a debug port on a profile that is already running: a
  // second browser sharing the first one's profile opens a tab in the existing
  // window and exits, so the port never comes up and it looks like nothing
  // happened. The old script used a single directory for every port, which is
  // exactly this bug.
  assert.notEqual(defaultProfileDirFor(9222), defaultProfileDirFor(9223));
  assert.match(defaultProfileDirFor(9222), /9222$/);
});

test('the extra-args escape hatch cannot re-open the DevTools origin hole', () => {
  // The hatch is real: a machine with no display and no sandbox needs these or
  // Chrome exits immediately.
  assert.deepEqual(sanitizeBrowserArgs({ AI_WEB_BROWSER_ARGS: '--headless=new --no-sandbox' }), [
    '--headless=new',
    '--no-sandbox',
  ]);

  for (const attempt of [
    '--remote-allow-origins=*',
    '--remote-allow-origins=https://evil.example.com',
    '--headless=new --remote-allow-origins=* --no-sandbox',
  ]) {
    const out = sanitizeBrowserArgs({ AI_WEB_BROWSER_ARGS: attempt });
    assert.ok(
      !out.some((flag) => flag.toLowerCase().startsWith('--remote-allow-origins')),
      `must strip it from: ${attempt}`
    );
    // And through the real argv builder, which is what actually reaches Chrome.
    const argv = buildBrowserArgv({
      port: 9222,
      profileDir: '/tmp/p',
      url: 'https://claude.ai/new',
      env: { AI_WEB_BROWSER_ARGS: attempt },
    });
    assert.ok(!argv.some((flag) => flag.toLowerCase().startsWith('--remote-allow-origins')));
  }

  // The port and the profile are decided by this script; a second copy of
  // either is ambiguous at best and silently wrong at worst.
  assert.deepEqual(
    sanitizeBrowserArgs({
      AI_WEB_BROWSER_ARGS: '--remote-debugging-port=1 --user-data-dir=/tmp/x --lang=en',
    }),
    ['--lang=en']
  );
  assert.deepEqual(sanitizeBrowserArgs({}), []);
});

test('a port is validated before it reaches an argv', () => {
  assert.equal(assertUsablePort(9222), 9222);
  assert.equal(assertUsablePort(' 9333 '), 9333, 'a string from a CLI flag is fine');

  for (const bad of [0, 80, 1023, 65536, -1, 1.5, 'nine thousand', '', null, undefined, '9222; rm -rf /']) {
    assert.throws(
      () => assertUsablePort(bad),
      (error) => {
        assert.ok(error instanceof DebugBrowserError);
        assert.match(error.hint, /between 1024 and 65535/);
        return true;
      },
      `must refuse ${JSON.stringify(bad)}`
    );
  }
});

test('a slow browser is given long enough to bind before it is called a failure', () => {
  // Reporting a failure for a browser that IS starting is the worse mistake: it
  // leaves a window running that the operator was told did not open. Measured
  // in this container, a cold profile took past 12s - a first run on Windows
  // with antivirus in the way can take longer still.
  assert.ok(
    STARTUP_WAIT_MS >= 30_000,
    `a cold browser needs more than ${STARTUP_WAIT_MS}ms to bind its debug port`
  );
});

test('the launcher is the only thing in the backend that can start a browser', () => {
  // The point of the whole change, and the one property no unit test of the
  // launcher itself can establish: nothing reachable over HTTP may start a
  // browser. Checked by reading the tree, because a route that grew one
  // tomorrow would break no other test in this repo - there is no test for
  // src/routes/admin.ts at all.
  //
  // "Starts a browser" is spawn() TOGETHER WITH browser resolution, not spawn()
  // alone: the Claude CLI runner legitimately spawns the `claude` binary, and
  // session.ts legitimately names --remote-debugging-port inside a hint string.
  // Neither can start a browser; a file that resolves an executable and spawns
  // it can.
  const root = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const relative = path.relative(root, full);
      if (relative.startsWith('scripts' + path.sep)) continue;
      const code = fs
        .readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      const spawns = /\bspawn\s*\(/.test(code);
      const resolvesABrowser = /findInstalledBrowser|AI_WEB_BROWSER_PATH|buildBrowserArgv/.test(code);
      if (spawns && resolvesABrowser) offenders.push(relative);
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    `only src/scripts/ may start a browser; found one in: ${offenders.join(', ')}`
  );
});

test('the launcher never touches the browser puppeteer downloads', () => {
  // Sign-in flows reject a browser in automation mode - Google answers "This
  // browser or app may not be secure" - and the whole design is that a human
  // signs in here. findInstalledBrowser deliberately skips Chrome for Testing;
  // resolveBrowser would return it.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'scripts', 'launchDebugBrowsers.ts'),
    'utf8'
  );
  assert.match(source, /findInstalledBrowser/);
  assert.doesNotMatch(source, /puppeteer\.launch|executablePath\(\)/);
});

test('a profile directory is per port on every platform', () => {
  const dir = defaultProfileDirFor(9222);
  assert.ok(path.isAbsolute(dir), 'an absolute path, so it does not depend on the cwd');
  assert.ok(dir.startsWith(os.homedir()), 'and under the home directory');
});

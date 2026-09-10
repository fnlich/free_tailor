const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const {
  DebugBrowserError,
  assertUsablePort,
  probeDebugBrowser,
  startDebugBrowser,
} = require('../dist/services/debugBrowser');
const { findInstalledBrowser } = require('../dist/config/browser');
const puppeteer = require('puppeteer');

/**
 * Starting the browser the chat providers attach to.
 *
 * This spawns a process on the server from an HTTP request, so the tests that
 * matter most are the ones about what it will and will not spawn.
 */

test('the port is the only thing taken from the caller, and it is validated', () => {
  assert.equal(assertUsablePort(9222), 9222);
  assert.equal(assertUsablePort(' 9333 '), 9333, 'a string from a form field is fine');

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

test('a port nothing is listening on reports not running, and names the sites', async () => {
  // 1 is reserved and nothing will be on it.
  const status = await probeDebugBrowser(1077);
  assert.equal(status.running, false);
  assert.equal(status.browser, null);
  assert.deepEqual(
    status.sites.map((site) => site.id),
    ['claude-web', 'chatgpt-web'],
    'both sites are reported even when nothing is up, so the panel can render'
  );
  assert.ok(status.sites.every((site) => site.open === false));
});

test('a running browser is found, and its open tabs are matched to sites', async (t) => {
  // The installed browser if there is one, else puppeteer's download. Either
  // works for a PROBE test - what is being checked is the DevTools endpoint,
  // not which build is answering it.
  const installed = findInstalledBrowser({
    platform: process.platform,
    env: process.env,
    fileExists: (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  });
  const executablePath = installed?.executablePath ?? puppeteer.executablePath();
  if (!executablePath || !fs.existsSync(executablePath)) {
    return t.skip('no browser available on this machine');
  }

  const port = 9481;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-debug-'));
  const child = spawn(
    executablePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--no-sandbox',
      'https://claude.ai/new',
    ],
    { detached: true, stdio: 'ignore' }
  );

  try {
    let status = { running: false };
    for (let attempt = 0; attempt < 40 && !status.running; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await probeDebugBrowser(port);
    }
    assert.equal(status.running, true, 'the probe must find a browser that is up');
    assert.ok(status.browser, 'and report which one');

    // The claude.ai tab was opened above; the chatgpt.com one was not. The
    // point of the distinction is that the panel can tell an operator which
    // site still needs signing in to.
    const claude = status.sites.find((site) => site.id === 'claude-web');
    const chatgpt = status.sites.find((site) => site.id === 'chatgpt-web');
    assert.equal(claude.open, true, 'a tab on the site host counts as open');
    assert.equal(chatgpt.open, false, 'and a site with no tab does not');

    // Asked to start when one is already listening, it must NOT launch a
    // second: Chrome would either refuse the port or quietly open a tab in the
    // existing window and exit, which looks like success and changes nothing.
    const result = await startDebugBrowser({ port, siteId: 'claude-web' });
    assert.equal(result.started, false);
    assert.equal(result.reused, true, 'an already-running browser is reused');
    assert.equal(result.status.running, true);
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('starting refuses a port it cannot use before it spawns anything', async () => {
  await assert.rejects(startDebugBrowser({ port: 80, siteId: 'claude-web' }), (error) => {
    assert.ok(error instanceof DebugBrowserError);
    return true;
  });
});

test('the extra-args escape hatch cannot re-open the DevTools origin hole', () => {
  const { sanitizeBrowserArgs } = require('../dist/services/debugBrowser');

  // The hatch is real: a backend in a container has no display and no sandbox,
  // and Chrome there needs these or it exits immediately.
  assert.deepEqual(sanitizeBrowserArgs({ AI_WEB_BROWSER_ARGS: '--headless=new --no-sandbox' }), [
    '--headless=new',
    '--no-sandbox',
  ]);

  // But it must not be a way to put back the flag the rest of this feature is
  // built to keep out. With it, any web page the operator visits can drive this
  // browser and read the accounts signed in to it.
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
  }

  // The port and the profile are decided by this app; a second copy of either
  // is ambiguous at best and silently wrong at worst.
  assert.deepEqual(
    sanitizeBrowserArgs({
      AI_WEB_BROWSER_ARGS: '--remote-debugging-port=1 --user-data-dir=/tmp/x --lang=en',
    }),
    ['--lang=en']
  );

  assert.deepEqual(sanitizeBrowserArgs({}), []);
});

test('a site with no hostname is matched by its address, not reported missing', async () => {
  // The override that points a site at a `file:` or `data:` URL has no host to
  // match on. Reported missing, its tab is opened again on every start - two
  // tabs after two presses, and the driver then attaches to whichever it finds.
  const { probeDebugBrowser } = require('../dist/services/debugBrowser');
  const fixture = `file://${path.join(__dirname, 'fixtures', 'fakeChat.html')}?json=1`;
  const status = await probeDebugBrowser(1077, { AI_WEB_CLAUDE_URL: fixture });
  const claude = status.sites.find((site) => site.id === 'claude-web');
  assert.equal(claude.url, fixture, 'the override must reach the status the panel renders');
});

test('a slow browser is given long enough to bind before it is called a failure', () => {
  // Reporting a failure for a browser that IS starting is the worse mistake: it
  // leaves a window running that the operator was told did not open, and the
  // endpoint unsaved. Measured in this container, a cold profile took past 12s -
  // a first run on Windows with antivirus in the way can take longer still.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'debugBrowser.ts'),
    'utf8'
  );
  const wait = source.match(/const STARTUP_WAIT_MS = ([\d_]+);/);
  assert.ok(wait, 'the startup wait must be declared');
  assert.ok(
    Number(wait[1].replace(/_/g, '')) >= 30_000,
    `a cold browser needs more than ${wait[1]}ms to bind its debug port`
  );

  // And the message has to tell the operator that pressing Start again picks up
  // a window that turned out to be slow, rather than opening a second one.
  assert.match(source, /pressing Start again picks up the window that is now running/);
});

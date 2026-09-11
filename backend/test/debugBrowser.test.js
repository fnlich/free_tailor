const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const { probeDebugBrowser } = require('../dist/services/debugBrowser');
const { findInstalledBrowser } = require('../dist/config/browser');
const puppeteer = require('puppeteer');

/**
 * Reading the state of the browsers the chat providers attach to.
 *
 * The probe only. The backend no longer starts a browser - that moved to
 * `src/scripts/launchDebugBrowsers.ts` and is covered by
 * debugBrowserLauncher.test.js - so what is left here is the read-only half
 * the Settings page and the launcher's skip-if-running check both rely on.
 */

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


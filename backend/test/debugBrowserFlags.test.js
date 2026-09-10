const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'startDebugBrowser.js');
const source = fs.readFileSync(SCRIPT, 'utf8');

/**
 * The flags the debug browser is started with.
 *
 * This file exists because the change it guards is invisible to every other
 * test in the suite: the browser-chat tests drive a Chrome they launch
 * themselves, so `--remote-allow-origins=*` could be put back into this script
 * tomorrow and all 257 of them would still pass. What it protects is not a
 * behaviour of this app at all - it is the operator's signed-in accounts.
 */

test('the debug browser is never started with the DevTools origin check off', () => {
  // `--remote-allow-origins=*` turns off the check that stops a WEB PAGE from
  // opening a socket to the debug port. With it, any site the operator visits
  // while this browser is running can drive it and read every session in it -
  // which for this profile is their Claude and ChatGPT accounts.
  //
  // Measured against Chrome 148.0.7778.97: with the flag, a WebSocket carrying
  // `Origin: https://evil.example.com` is accepted; without it Chrome answers
  // 403. Puppeteer connects from Node and sends no Origin header at all, so
  // nothing this app does needs the flag.
  //
  // Matched outside comments, because the comment in that file NAMES the flag
  // in order to explain why it is absent - and a test that could not tell the
  // two apart would either fail on the explanation or pass on the real thing.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(
    code,
    /--remote-allow-origins/,
    'the DevTools origin check must stay on: it is what stops a web page driving this browser'
  );
  assert.match(
    code,
    /--remote-debugging-address=127\.0\.0\.1/,
    'and the port must be bound to loopback'
  );
});

test('the launcher reads the same .env the backend does', () => {
  // Without this the two disagree in the way hardest to diagnose: an operator
  // who sets AI_WEB_CDP_PORT in .env gets a browser on 9222 and a backend
  // probing their port, and the only symptom is "Could not reach a debug
  // browser" from a window that is plainly open and plainly signed in.
  assert.match(source, /require\('dotenv'\)/);
  assert.match(source, /AI_WEB_CDP_PORT/);
});

test('the launcher starts an installed browser, never the automation one', () => {
  // Sign-in flows reject a browser in automation mode, and the whole design
  // here is that a human signs in. `findInstalledBrowser` deliberately skips
  // puppeteer's Chrome for Testing; `resolveBrowser` would return it.
  assert.match(source, /findInstalledBrowser/);
  assert.doesNotMatch(source, /puppeteer\.launch|executablePath\(\)/);
});

#!/usr/bin/env node
/**
 * Starts the Chrome the browser-chat providers attach to.
 *
 * Two rules this script exists to get right, both of which bite when you do it
 * by hand:
 *
 * A SEPARATE PROFILE DIRECTORY. Chrome silently ignores
 * `--remote-debugging-port` when a normal Chrome is already running with the
 * same profile - it just opens a tab in the existing window and no port is
 * ever listening. A dedicated `--user-data-dir` sidesteps that, at the cost of
 * signing in once inside it.
 *
 * A REAL BROWSER, NOT THE AUTOMATION ONE. This deliberately picks the Chrome,
 * Edge or Brave already installed on the machine rather than the Chrome for
 * Testing that puppeteer downloads for PDF rendering. Sign-in flows reject a
 * browser that is in automation mode - Google's answers "This browser or app
 * may not be secure" - and the whole design here is that a human signs in.
 *
 *   node scripts/startDebugBrowser.js [--port 9222] [--profile <dir>]
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

// The same .env the backend reads.
//
// Without this the two disagree in the one way that is hardest to see: an
// operator who sets AI_WEB_CDP_PORT in .env gets a browser on 9222 and a
// backend probing their port, and the only symptom is "Could not reach a debug
// browser" from a window that is plainly open and plainly signed in.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {
  // dotenv is a backend dependency; if it is not installed yet the flags below
  // still work from the command line and the environment.
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const PORT = arg('port', process.env.AI_WEB_CDP_PORT || '9222');
const PROFILE = arg('profile', path.join(os.homedir(), '.free-tailor-chrome'));

function findBrowser() {
  try {
    // The same resolver the PDF renderer uses, minus its puppeteer download:
    // that copy is Chrome for Testing, which is exactly what must NOT be used
    // to sign in.
    const { findInstalledBrowser } = require('../dist/config/browser');
    return findInstalledBrowser({
      platform: process.platform,
      env: process.env,
      fileExists: (candidate) => {
        try {
          return require('fs').statSync(candidate).isFile();
        } catch {
          return false;
        }
      },
    });
  } catch {
    return null;
  }
}

const found = findBrowser();
if (!found) {
  console.error(
    [
      '[browser] No installed Chrome, Chromium, Edge or Brave was found.',
      '[browser] (If this project has not been built yet, run `npm run build` first.)',
      '[browser] Install one, or start it yourself:',
      `[browser]   <browser> --remote-debugging-port=${PORT} --user-data-dir="${PROFILE}"`,
    ].join('\n')
  );
  process.exit(1);
}

console.log(`[browser] Starting ${found.label} with a debug port`);
console.log(`[browser]   executable: ${found.executablePath}`);
console.log(`[browser]   debug port: ${PORT}`);
console.log(`[browser]   profile:    ${PROFILE}`);
console.log('[browser]');
console.log('[browser] Sign in to the chat sites you want to use IN THIS WINDOW:');
console.log('[browser]   https://claude.ai/new     for the "Claude (browser)" provider');
console.log('[browser]   https://chatgpt.com/      for the "ChatGPT (browser)" provider');
console.log('[browser] Leave it open. The backend attaches to it; it never launches one.');

const child = spawn(
  found.executablePath,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    // Explicit, though it is also the default: the port listens on loopback
    // only. Anything that can reach it can drive this browser and read every
    // session signed in to it.
    '--remote-debugging-address=127.0.0.1',
    // NOT `--remote-allow-origins=*`. That flag turns off the DevTools origin
    // check, and the check is the only thing stopping a WEB PAGE from driving
    // this browser: any site the operator visits could open a socket to
    // 127.0.0.1 and read every signed-in session here, which for this profile
    // means their Claude and ChatGPT accounts. Measured against 148.0.7778.97:
    // with the flag a socket sent from an https://evil.example.com origin is
    // accepted; without it Chrome answers 403. Nothing here needs it -
    // puppeteer connects from Node and sends no Origin header, so the check
    // never applies to it.
    '--no-first-run',
    '--no-default-browser-check',
  ],
  { detached: true, stdio: 'ignore' }
);

child.on('error', (error) => {
  console.error(`[browser] Could not start it: ${error.message}`);
  process.exit(1);
});

// Detached, so closing this terminal does not close the browser the operator
// just signed in to.
child.unref();

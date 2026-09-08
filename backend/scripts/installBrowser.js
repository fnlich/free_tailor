#!/usr/bin/env node
/**
 * Downloads the Chrome that puppeteer expects, if it is not already there.
 *
 * Puppeteer ships its own postinstall that does this, but it does not always
 * get to run - `npm install --ignore-scripts`, a proxy that blocks the
 * download CDN, an upgrade that wants a newer build than the cached one - and
 * when it has not run the failure only shows up later, as
 * `Could not find Chrome (ver. ...)` at the moment someone clicks Generate.
 *
 * Uses the @puppeteer/browsers API rather than shelling out to
 * `npx puppeteer browsers install chrome`: on Windows the npx entry point is a
 * .cmd shim, and spawning one needs a shell, which needs the arguments
 * escaped, which is a whole class of bug to avoid for no gain here.
 *
 *   node scripts/installBrowser.js              install if missing, fail loudly
 *   node scripts/installBrowser.js --if-missing  install if missing, never fail
 */

const fs = require('fs');
const path = require('path');

const NEVER_FAIL = process.argv.includes('--if-missing');

/**
 * A download that never finishes must not hold up `npm install`.
 *
 * @puppeteer/browsers offers no way to cancel an install, and it does not give
 * up on its own: pointed at a directory it cannot write, it sat there
 * indefinitely rather than throwing. Since this runs as a postinstall, that
 * would hang the install of the whole project, so the process is given a
 * deadline and exits on it - which does cancel the download, by ending the
 * process doing it.
 */
const TIMEOUT_MS = Number(process.env.BROWSER_INSTALL_TIMEOUT_MS) || (NEVER_FAIL ? 5 : 15) * 60_000;

/**
 * The cache directory and build id puppeteer is going to look for.
 *
 * `executablePath()` reports where it expects the browser without checking
 * that anything is there, and the path embeds both values:
 *   <cacheDir>/chrome/<platform>-<buildId>/chrome-<platform>/chrome
 */
function readPuppeteerExpectation() {
  const puppeteer = require('puppeteer');
  const executablePath = puppeteer.executablePath();
  const marker = `${path.sep}chrome${path.sep}`;
  const markerIndex = executablePath.lastIndexOf(marker);
  if (markerIndex === -1) return { executablePath, cacheDir: null, buildId: null };

  const cacheDir = executablePath.slice(0, markerIndex);
  const versionDir = executablePath.slice(markerIndex + marker.length).split(path.sep)[0];
  const separator = versionDir.lastIndexOf('-');
  const buildId = separator === -1 ? null : versionDir.slice(separator + 1);
  return { executablePath, cacheDir, buildId };
}

function fail(message) {
  console.error(message);
  process.exit(NEVER_FAIL ? 0 : 1);
}

async function main() {
  const { executablePath, cacheDir, buildId } = readPuppeteerExpectation();

  if (fs.existsSync(executablePath)) {
    console.log(`[browser] Chrome is already installed at ${executablePath}`);
    return;
  }

  const browsers = require('@puppeteer/browsers');
  const platform = browsers.detectBrowserPlatform();
  if (!platform) {
    fail('[browser] This platform has no Chrome download. Set CHROME_PATH to a browser you already have.');
    return;
  }

  const resolvedBuildId =
    buildId || (await browsers.resolveBuildId(browsers.Browser.CHROME, platform, 'stable'));
  const resolvedCacheDir = cacheDir || path.join(require('os').homedir(), '.cache', 'puppeteer');

  console.log(`[browser] Downloading Chrome ${resolvedBuildId} into ${resolvedCacheDir}`);
  const deadline = setTimeout(() => {
    fail(
      `[browser] Gave up waiting for the Chrome download after ${Math.round(TIMEOUT_MS / 1000)}s.\n` +
        '[browser] Run "npm run setup:browser" when the network is better, or set CHROME_PATH\n' +
        '[browser] to a Chrome, Edge, Chromium or Brave you already have.'
    );
  }, TIMEOUT_MS);
  deadline.unref();

  let lastPercent = -1;
  try {
    const installed = await browsers.install({
      browser: browsers.Browser.CHROME,
      buildId: resolvedBuildId,
      cacheDir: resolvedCacheDir,
      downloadProgressCallback: (downloaded, total) => {
        if (!total) return;
        const percent = Math.floor((downloaded / total) * 100);
        // One line per 10%, so a CI log does not fill with progress noise.
        if (percent >= lastPercent + 10) {
          lastPercent = percent;
          console.log(`[browser] ${percent}%`);
        }
      },
    });
    clearTimeout(deadline);
    console.log(`[browser] Chrome installed at ${installed.executablePath}`);
  } catch (error) {
    clearTimeout(deadline);
    fail(
      [
        `[browser] Could not download Chrome: ${error && error.message ? error.message : error}`,
        '[browser] PDF generation needs a Chrome to print with. Either retry this command when the',
        '[browser] download is reachable, or point the server at a browser you already have:',
        '[browser]   CHROME_PATH=<path to chrome.exe or chrome>   (put it in .env to make it stick)',
        '[browser] Chrome, Edge, Chromium and Brave all work - they are the same rendering engine.',
      ].join('\n')
    );
  }
}

main().catch((error) => {
  fail(`[browser] ${error && error.stack ? error.stack : error}`);
});

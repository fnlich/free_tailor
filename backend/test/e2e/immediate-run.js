/*
 * Generate Immediately, in a real browser, against a real server whose seat is
 * stubbed (stub-seat.js).
 *
 * test/immediateRuns.test.js and test/tabLease.test.js prove the server's half
 * - kinds, the lease, release, downloads - and test/immediateRunHelpers.test.js
 * the page's pure decisions. This proves the page and the server are joined
 * up, the part no unit test reaches:
 *
 *   - the first Generate Immediately asks first, with the owner's sentence,
 *     and "Don't show again" stops it asking in this browser
 *   - each finished resume reaches the browser's download folder by itself,
 *     and is listed under the progress to download again
 *   - a run queued for this tab is picked back up by this tab after a
 *     reload, and never by another tab (a run the page itself started is
 *     released by the reload's pagehide, so it is stopped instead)
 *   - Stop stops it, and says what was refunded
 *   - closing the tab stops it AT ONCE (the pagehide release), not after the
 *     server's grace
 *   - leaving Build Resumes inside the app asks first, and then stops it -
 *     and coming back says how it ended
 *
 * Servers are expected to be up already, the backend preloaded with the stub
 * and sharing DB_DIR with this script, IMMEDIATE_TAB_GRACE_MS left at its
 * default (30 s - the close-tab check tells the release from the grace by
 * time):
 *
 *   E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js dist/index.js
 *   DB_DIR=/tmp/e2e-db node test/e2e/immediate-run.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const { saveProfile } = require(path.join(DIST, 'database', 'profileRepository'));
const { buildNewProfile } = require(path.join(DIST, 'services', 'profileService'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;
const DOWNLOADS = process.env.E2E_DOWNLOADS || fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-e2e-downloads-'));

const WIDE = { width: 1440, height: 900 };
const CONFIRM_SENTENCE =
  'If you close the tab or the network drops, the run can be stopped. Would you like to proceed?';
const POSTING =
  'Senior engineer wanted to ship TypeScript services packaged with Docker, for a small platform team.';

let failures = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fetch against the API, signed in with `token`. */
const apiAs = (token) => async (route, init = {}) => {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function signIn(page, token) {
  // Both halves of a real sign-in: the bearer copy the API client sends, and
  // the cookie - which is all the pagehide release carries across origins.
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** Polls `predicate` in the page until it holds, or `timeoutMs` passes. */
async function until(page, predicate, timeoutMs = 30_000, arg = null) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
}

/** Polls the API until `predicate(body)` holds; the last body either way. */
async function untilApi(call, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call();
    if (predicate(last)) return { ok: true, last };
    await wait(200);
  }
  return { ok: false, last };
}

async function pressButton(page, text) {
  return page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent.trim().startsWith(label) && !candidate.disabled
    );
    button?.click();
    return Boolean(button);
  }, text);
}

/** Opens manual mode with the job typed in and Auto-generate on. */
async function openManual(page, company) {
  await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
  await pressButton(page, 'Building Manually');
  await page.waitForSelector('input[placeholder="Enter company name"]');
  await page.type('input[placeholder="Enter company name"]', company);
  await page.type('textarea[placeholder^="Paste the job description"]', POSTING);
  const auto = await page.evaluate(() => document.body.innerText.includes('Auto-generate (On)'));
  if (!auto) {
    await page.evaluate(() => {
      const toggle = Array.from(document.querySelectorAll('label input[type="checkbox"]')).find((input) =>
        /switch/.test(input.closest('label').className)
      );
      toggle?.click();
    });
  }
  return page.evaluate(() => document.body.innerText.includes('Auto-generate (On)'));
}

/** The dialog the page draws, or null. */
async function dialogText(page) {
  return page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? null);
}

/** Every finished download in the folder (Chrome writes `.crdownload` until a file is whole). */
function downloaded() {
  return fs.readdirSync(DOWNLOADS).filter((name) => !name.endsWith('.crdownload'));
}

/**
 * Every download the browser completed, by its own events - not by counting
 * files, because a second download of the same file can overwrite the first
 * under the DevTools download behaviour.
 */
const completedDownloads = [];
/**
 * Every file the PAGE handed to the browser (a click on a download anchor),
 * in order. What the browser then saves is up to it: Chrome lets a page start
 * only so many downloads on its own before it asks - headless, it just stops -
 * which is exactly why the page lists the run's files to download again.
 */
const handed = [];

async function main() {
  const stamp = Date.now().toString(36);
  // Default subscription: one profile, which is all Generate Immediately needs.
  const user = users.createUser({ email: `e2e-run-${stamp}@example.com`, name: 'Run User' });
  const profileId = `p-run-${stamp}`;
  saveProfile({
    ...buildNewProfile(
      {
        name: 'Ada Run',
        title: 'Senior Engineer',
        contact: { email: 'ada@example.com', phone: '1', location: 'Remote' },
        summary: 'Engineer who ships.',
        experience: [
          {
            title: 'Engineer',
            company: 'Acme',
            startDate: '01/2020',
            endDate: 'Present',
            location: 'Remote',
            description: 'Built product services.',
            achievements: ['Cut build time by 37%.'],
            skills: [],
          },
        ],
        skills: ['TypeScript', 'Docker'],
        education: [],
      },
      profileId
    ),
    ownerId: user.id,
  });
  const token = users.createSession(user.id);
  const api = apiAs(token);

  /** Queues an immediate run for `tabId` the way the page does, with `jobs` postings. */
  const submitFor = (tabId, jobs) =>
    api('/generation/batches', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'immediate',
        tabId,
        profileIds: [profileId],
        jobs: Array.from({ length: jobs }, (_, index) => ({
          companyName: `Queued ${index + 1}`,
          jobDescription: POSTING,
        })),
      }),
    });
  const batchState = async (batchId) => (await api(`/generation/batches/${batchId}`)).body?.state ?? null;

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
  const names = new Map();
  cdp.on('Browser.downloadWillBegin', (event) => names.set(event.guid, event.suggestedFilename));
  cdp.on('Browser.downloadProgress', (event) => {
    if (event.state === 'completed') completedDownloads.push(names.get(event.guid) ?? event.guid);
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    await page.exposeFunction('__e2eHanded', (name) => handed.push(name));
    await page.evaluateOnNewDocument(() => {
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__e2eHanded(this.download);
        return click.call(this);
      };
    });
    // A confirm the page raises is answered by each check; a leave prompt
    // (beforeunload) is always accepted, as somebody reloading would.
    let answer = { accept: true, seen: [] };
    page.on('dialog', async (dialog) => {
      answer.seen.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'beforeunload' || answer.accept) await dialog.accept();
      else await dialog.dismiss();
    });
    await signIn(page, token);

    /* ------------------------------------------- the confirm, and a build */
    check('manual: Auto-generate is on', await openManual(page, 'Acme'));
    check('manual: Generate Immediately is offered', await pressButton(page, 'Generate Immediately'));
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')), 5000);
    const confirmText = (await dialogText(page)) ?? '';
    check(
      "the first click asks first, in the owner's words, with Don't show again",
      confirmText.includes(CONFIRM_SENTENCE) && /Don.t show again/.test(confirmText),
      confirmText
    );
    await page.screenshot({ path: `${SHOTS}/immediate-1-confirm.png` });
    await pressButton(page, 'Proceed');
    const progressShown = await until(page, () => /Keep this page open until the run finishes/.test(document.body.innerText), 10_000);
    check('the run shows its progress and a Stop button', progressShown && (await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Stop')
    )));
    await page.screenshot({ path: `${SHOTS}/immediate-2-running.png` });
    const built = await until(page, () => /Built 1 of 1 resume/.test(document.body.innerText), 60_000);
    check('the run ends with what it built', built, (await page.evaluate(() => document.body.innerText)).slice(0, 600));
    await wait(1500);
    const firstFiles = downloaded();
    check(
      'the finished resume downloaded by itself, under a name that says whose and what',
      firstFiles.some((name) => /\.pdf$/i.test(name)) && firstFiles.some((name) => /Acme/.test(name)),
      `downloads: ${firstFiles.join(', ') || '(none)'}`
    );
    const listed = await page.evaluate(() => {
      const card = document.querySelector('section[aria-label="This run\'s files"]');
      return card ? { text: card.innerText, buttons: card.querySelectorAll('li button').length } : null;
    });
    check(
      "the run's files are listed to download again",
      Boolean(listed) && /Acme/.test(listed.text) && listed.buttons >= 1,
      JSON.stringify(listed)
    );
    await page.screenshot({ path: `${SHOTS}/immediate-3-done.png`, fullPage: true });
    const againBefore = completedDownloads.length;
    await page.click('section[aria-label="This run\'s files"] li button');
    await wait(2000);
    check(
      'a listed file downloads again on request',
      completedDownloads.length === againBefore + 1,
      `${againBefore} -> ${completedDownloads.length}: ${completedDownloads.slice(againBefore).join(', ')}`
    );

    // "Don't show again", then a third click that is not asked about.
    await pressButton(page, 'Generate Immediately');
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')), 5000);
    await page.evaluate(() => {
      const box = Array.from(document.querySelectorAll('[role="dialog"] input[type="checkbox"]'))[0];
      box?.click();
    });
    await pressButton(page, 'Proceed');
    await until(page, () => /Built 1 of 1 resume/.test(document.body.innerText) && !document.querySelector('[role="dialog"]'), 60_000);
    await wait(500);
    await pressButton(page, 'Generate Immediately');
    await wait(700);
    check("after Don't show again, Generate Immediately starts without asking", (await dialogText(page)) === null);
    await until(page, () => /Built 1 of 1 resume/.test(document.body.innerText), 60_000);

    /* ------------------------------------ a reload picks this tab's run up */
    const tabId = await page.evaluate(() => window.sessionStorage.getItem('freeTailor.tabId'));
    check('the tab has an id the server accepts', /^[A-Za-z0-9_-]{1,100}$/.test(tabId ?? ''), String(tabId));
    const queued = await submitFor(tabId, 4);
    check('setup: a four-resume run is queued for this tab', queued.status === 202, JSON.stringify(queued.body));
    const runId = queued.body?.batchId;
    await page.reload({ waitUntil: 'networkidle2' });
    const reattached = await until(page, () => /Keep this page open until the run finishes/.test(document.body.innerText), 10_000);
    check('a reload picks up the run queued for this tab, with its progress', reattached);

    // A second tab of the same browser has a tab of its own: it never follows
    // (or downloads) this one's run.
    const other = await browser.newPage();
    await other.setViewport(WIDE);
    await other.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await wait(1500);
    const otherState = await other.evaluate(() => ({
      tabId: window.sessionStorage.getItem('freeTailor.tabId'),
      following: /Keep this page open until the run finishes/.test(document.body.innerText),
    }));
    check(
      "a second tab has its own id and does not follow the first tab's run",
      otherState.tabId && otherState.tabId !== tabId && !otherState.following,
      JSON.stringify(otherState)
    );
    await other.close();
    check("the run is still going after the second tab came and went", (await batchState(runId)) === 'running');

    const followed = await until(page, () => /Built 4 of 4 resumes/.test(document.body.innerText), 60_000);
    check('the reattached run is followed to its end', followed);
    // Four resumes, each with its resume and cover letter as PDF and DOCX:
    // sixteen files handed to the browser, each a different one, none twice.
    const reattachedFiles = handed.filter((name) => name.startsWith('Queued'));
    check(
      'each of its resumes was handed to the browser once, every file of it',
      reattachedFiles.length === 16 && new Set(reattachedFiles).size === 16,
      reattachedFiles.join(', ')
    );
    await wait(1500);
    check(
      '...and the browser saved them (as many as it lets a page start by itself)',
      completedDownloads.some((name) => name.startsWith('Queued')),
      `saved: ${completedDownloads.filter((name) => name.startsWith('Queued')).length} of 16`
    );

    /* ---------------------------------------------------------------- Stop */
    // Twelve postings: more than the lane builds at once, so some are still
    // queued when Stop lands.
    const stopRun = (await submitFor(tabId, 12)).body?.batchId;
    await page.reload({ waitUntil: 'networkidle2' });
    await until(page, () => /Keep this page open until the run finishes/.test(document.body.innerText), 10_000);
    // One resume built (it is listed under the progress): Stop lands mid-run.
    await until(page, () => Boolean(document.querySelector('section[aria-label="This run\'s files"] li')), 40_000);
    check('Stop is pressed while the run is going', await pressButton(page, 'Stop'));
    const stopped = await until(
      page,
      () => /Stopped after building \d+ of 12 resumes; the \d+ not built were? refunded/.test(document.body.innerText),
      20_000
    );
    check('Stop ends the run and says what was refunded', stopped, (await page.evaluate(() => document.body.innerText)).slice(0, 600));
    check('the server has it cancelled', (await batchState(stopRun)) === 'cancelled');
    await page.screenshot({ path: `${SHOTS}/immediate-4-stopped.png`, fullPage: true });

    /* ------------------------------------- leaving inside the app asks first */
    const leaveRun = (await submitFor(tabId, 3)).body?.batchId;
    await page.reload({ waitUntil: 'networkidle2' });
    await until(page, () => /Keep this page open until the run finishes/.test(document.body.innerText), 10_000);
    answer = { accept: false, seen: [] };
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('.tl-sidebar a')).find((a) => a.textContent.trim() === 'Orders')?.click();
    });
    await wait(800);
    check(
      'leaving Build Resumes inside the app asks first, and Cancel stays',
      answer.seen.some((d) => d.type === 'confirm' && /Leave Build Resumes\?/.test(d.message)) &&
        new URL(page.url()).pathname === '/' &&
        (await batchState(leaveRun)) === 'running',
      JSON.stringify({ seen: answer.seen, url: page.url() })
    );
    answer = { accept: true, seen: [] };
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('.tl-sidebar a')).find((a) => a.textContent.trim() === 'Orders')?.click();
    });
    const left = await untilApi(async () => batchState(leaveRun), (state) => state === 'cancelled', 5000);
    const moved = await until(page, () => window.location.pathname === '/orders', 5000);
    check('...and OK leaves, and stops the run at once', left.ok && moved, JSON.stringify({ state: left.last, url: page.url() }));
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    const told = await until(page, () => /Your last run ended while this page was away/.test(document.body.innerText), 15_000);
    check('back on Build Resumes, the page says how that run ended', told, (await page.evaluate(() => document.body.innerText)).slice(0, 600));

    /* ---------------------------------------- Cancel on a live row of Orders */
    const placed = await api('/generation/batches', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'order',
        profileIds: [profileId],
        jobs: Array.from({ length: 8 }, (_, index) => ({ companyName: `Ordered ${index + 1}`, jobDescription: POSTING })),
      }),
    });
    const orderNumber = placed.body?.orderNumber;
    check(
      'setup: an eight-resume order is placed, on the Default subscription',
      placed.status === 202 && /^FT-\d{8}-\d{4}$/.test(orderNumber ?? ''),
      JSON.stringify(placed.body)
    );
    await page.goto(`${APP}/orders`, { waitUntil: 'networkidle2' });
    const rows = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
    check(
      'Orders lists the order and none of the Generate Immediately runs before it',
      rows === 1,
      `${rows} rows`
    );
    answer = { accept: true, seen: [] };
    const pressed = await page.evaluate((number) => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.innerText.includes(number));
      const button = Array.from(row?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Cancel');
      button?.click();
      return Boolean(button);
    }, orderNumber);
    check("the live order's row offers Cancel", pressed);
    const noted = await until(
      page,
      (number) =>
        new RegExp(
          `Order ${number} cancelled: \\d+ resumes? (not started (was|were) refunded|being built (was|were) stopped and refunded)`
        ).test(document.body.innerText),
      10_000,
      orderNumber
    );
    check(
      'Cancel asks first, then says what it stopped and refunded',
      noted && answer.seen.some((d) => d.type === 'confirm' && d.message.includes(`Cancel what is left of order ${orderNumber}?`)),
      JSON.stringify({ seen: answer.seen, text: (await page.evaluate(() => document.body.innerText)).slice(0, 400) })
    );
    const orderState = await untilApi(
      async () => (await api(`/orders/${placed.body?.orderId}`)).body?.state,
      (state) => state === 'cancelled',
      10_000
    );
    check('the order is cancelled on the server', orderState.ok, String(orderState.last));
    await page.screenshot({ path: `${SHOTS}/immediate-5-order-cancelled.png` });

    /* ------------------------------------------ closing the tab stops it now */
    const closeRun = (await submitFor(tabId, 3)).body?.batchId;
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await until(page, () => /Keep this page open until the run finishes/.test(document.body.innerText), 10_000);
    const closedAt = Date.now();
    await page.close({ runBeforeUnload: false });
    // Inside 5 s: the server's grace is 30, so only the page's own release
    // can have stopped it this soon.
    const closed = await untilApi(async () => batchState(closeRun), (state) => state === 'cancelled', 5000);
    check(
      'closing the tab stops its run at once (the pagehide release), not after the grace',
      closed.ok,
      `state ${closed.last} after ${Date.now() - closedAt} ms`
    );
  } finally {
    await browser.close();
  }

  console.log(`\nDownloads in ${DOWNLOADS}`);
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

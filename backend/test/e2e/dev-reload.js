/*
 * Opening a second tab must not reload the first - in whichever mode the
 * frontend is served.
 *
 * The owner's report: with the root `npm run dev` running, opening the app in
 * a second tab reloaded the first, and since Generate Immediately is leased to
 * its tab, that reload also STOPPED the run going there (the reload's
 * pagehide releases it). Nothing in frontend/src reloads a tab; the dev server
 * does. Next 16.1's webpack hot-reload server broadcasts `SYNC {hash}` to
 * every open tab whenever a new one connects, and a tab whose own hash is
 * older - anything compiled since it opened, such as the route the second
 * tab asked for - takes that for a restarted server and calls
 * `window.location.reload()`; 16.3.8's reloads tab A just the same (measured,
 * not read). A production `next start` has no hot reloader.
 *
 * This is the reproduction, run against each mode the frontend can be served
 * in (README, "Running it"), so the root `dev` script can point at one that
 * passes:
 *
 *   1. Tab A opens Build Resumes and is marked (`window.__mark`).
 *   2. Tab B opens a page nothing has compiled yet.
 *   3. After E2E_WAIT_MS (10 s), tab A must still carry its mark, and must
 *      not have loaded again.
 *   4. Again with a Generate Immediately run going in tab A (needs the stub
 *      seat): tab C opens another page nothing has compiled, and after the
 *      wait tab A keeps its mark AND its run, which then finishes as built.
 *
 * Servers are expected to be up already, the backend preloaded with the stub
 * seat - each model call slow enough that the run outlasts the wait - and
 * sharing DB_DIR with this script. Start the frontend FRESH for each mode, so
 * the pages tab B and tab C open really are uncompiled:
 *
 *   E2E_STUB_DELAY_MS=6000 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js dist/index.js
 *   npm run dev:live --prefix frontend      # or dev:turbo, or dev (production-style)
 *   DB_DIR=/tmp/e2e-db E2E_MODE=dev:live node test/e2e/dev-reload.js
 *
 * Use `localhost` for E2E_APP against a dev server: Next refuses its dev
 * resources to any other origin not named in allowedDevOrigins
 * (NEXT_PUBLIC_ALLOWED_DEV_ORIGINS). Exits non-zero on the first mode that
 * reloads, printing every check.
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const { saveProfile } = require(path.join(DIST, 'database', 'profileRepository'));
const { buildNewProfile } = require(path.join(DIST, 'services', 'profileService'));

const API = process.env.E2E_API || 'http://localhost:3001/api';
const APP = process.env.E2E_APP || 'http://localhost:3000';
const MODE = process.env.E2E_MODE || 'unnamed mode';
const WAIT_MS = Number(process.env.E2E_WAIT_MS || 10_000);
/** Set E2E_NO_RUN=1 against a backend without the stub seat: the run half is skipped, and says so. */
const WITH_RUN = process.env.E2E_NO_RUN !== '1';
/** Two pages nothing has opened yet in a fresh server: the one tab B opens, then tab C's. */
const FIRST_UNCOMPILED = process.env.E2E_ROUTE_B || '/orders';
const SECOND_UNCOMPILED = process.env.E2E_ROUTE_C || '/calendar';

const WIDE = { width: 1440, height: 900 };
const POSTING =
  'Senior engineer wanted to ship TypeScript services packaged with Docker, for a small platform team.';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${MODE}] ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const apiAs = (token) => async (route, init = {}) => {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function signIn(page, token) {
  // Both halves of a real sign-in: the bearer copy the API client sends, and
  // the cookie. On the APP's own host name, so the cookie goes with it.
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({
    name: 'ft_session',
    value: token,
    domain: new URL(APP).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
}

async function until(page, predicate, timeoutMs = 30_000, arg = null) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
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

/**
 * Watches a tab for loading again: every main-frame navigation after `arm()`
 * is counted, and the mark set in the page is read back. A reload clears
 * `window.__mark` - a soft client-side navigation does not - and fires a new
 * main-frame navigation; both are checked, so neither a missed event nor a
 * page that re-marked itself can pass for "stayed put".
 */
function watchReloads(page) {
  const seen = { navigations: 0, armed: false };
  page.on('framenavigated', (frame) => {
    if (seen.armed && frame === page.mainFrame()) seen.navigations += 1;
  });
  return {
    async arm(mark) {
      await page.evaluate((value) => {
        window.__mark = value;
      }, mark);
      seen.navigations = 0;
      seen.armed = true;
    },
    async read() {
      const mark = await page.evaluate(() => window.__mark ?? null).catch(() => null);
      return { mark, navigations: seen.navigations };
    },
  };
}

/** Opens `route` in a new tab of the same browser - the second tab the owner opened. */
async function openAnotherTab(browser, route) {
  const tab = await browser.newPage();
  await tab.setViewport(WIDE);
  // A first visit compiles the route in dev, which can take a while.
  await tab.goto(`${APP}${route}`, { waitUntil: 'networkidle2', timeout: 180_000 }).catch(() => null);
  return tab;
}

async function main() {
  const stamp = Date.now().toString(36);
  const user = users.createUser({ email: `e2e-reload-${stamp}@example.com`, name: 'Reload User' });
  const profileId = `p-reload-${stamp}`;
  saveProfile({
    ...buildNewProfile(
      {
        name: 'Ada Reload',
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

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    /* ------------------------------------------- tab A, then a second tab */
    const tabA = await browser.newPage();
    await tabA.setViewport(WIDE);
    // A leave prompt (beforeunload) is accepted, as somebody reloading would:
    // a reload this script does not catch must still happen, to be seen.
    tabA.on('dialog', (dialog) => dialog.accept().catch(() => null));
    await signIn(tabA, token);
    await tabA.goto(`${APP}/`, { waitUntil: 'networkidle2', timeout: 180_000 });
    const ready = await until(tabA, () => /Build Resumes/.test(document.body.innerText), 60_000);
    check('tab A: Build Resumes is open', ready, (await tabA.evaluate(() => document.body.innerText)).slice(0, 300));
    // Let the dev client connect and settle before anything else compiles.
    await wait(2_000);
    const watchA = watchReloads(tabA);
    await watchA.arm(`a-${stamp}`);

    const tabB = await openAnotherTab(browser, FIRST_UNCOMPILED);
    await wait(WAIT_MS);
    await tabA.bringToFront();
    await wait(1_500);
    const afterB = await watchA.read();
    check(
      `tab A keeps its mark ${WAIT_MS / 1000}s after tab B opened ${FIRST_UNCOMPILED} - it was not reloaded`,
      afterB.mark === `a-${stamp}` && afterB.navigations === 0,
      JSON.stringify(afterB)
    );
    await tabB.close();

    /* ------------------------------- again, with a Generate Immediately run */
    if (!WITH_RUN) {
      console.log(`SKIP  [${MODE}] the Generate Immediately half (E2E_NO_RUN=1)`);
    } else {
      if (afterB.mark !== `a-${stamp}`) {
        // Reloaded: start the second half from a page that is settled again.
        await tabA.goto(`${APP}/`, { waitUntil: 'networkidle2', timeout: 180_000 });
        await wait(2_000);
      }
      await pressButton(tabA, 'Building Manually');
      await tabA.waitForSelector('input[placeholder="Enter company name"]', { timeout: 30_000 });
      await tabA.type('input[placeholder="Enter company name"]', `Reload ${stamp}`);
      // A posting of its own, so neither the stored analysis nor the tailoring
      // cache answers it at once and the run is still going when tab C opens.
      await tabA.type('textarea[placeholder^="Paste the job description"]', `${POSTING} Ref ${stamp}.`);
      const auto = await tabA.evaluate(() => document.body.innerText.includes('Auto-generate (On)'));
      if (!auto) {
        await tabA.evaluate(() => {
          const toggle = Array.from(document.querySelectorAll('label input[type="checkbox"]')).find((input) =>
            /switch/.test(input.closest('label').className)
          );
          toggle?.click();
        });
      }
      check('tab A: Generate Immediately is offered', await pressButton(tabA, 'Generate Immediately'));
      if (await until(tabA, () => Boolean(document.querySelector('[role="dialog"]')), 5_000)) {
        await pressButton(tabA, 'Proceed');
      }
      const running = await until(tabA, () => /Keep this page open until the run finishes/.test(document.body.innerText), 20_000);
      check('tab A: the run is going', running, (await tabA.evaluate(() => document.body.innerText)).slice(0, 400));
      const tabId = await tabA.evaluate(() => window.sessionStorage.getItem('freeTailor.tabId'));
      const active = await api(`/generation/batches?active=1&tab=${encodeURIComponent(tabId ?? '')}`);
      const runId = active.body?.batches?.[0]?.id ?? active.body?.batches?.[0]?.batchId ?? null;
      check('tab A: the server holds a run for this tab', Boolean(runId), JSON.stringify(active.body).slice(0, 300));
      await watchA.arm(`a2-${stamp}`);

      const tabC = await openAnotherTab(browser, SECOND_UNCOMPILED);
      await wait(WAIT_MS);
      await tabA.bringToFront();
      await wait(1_500);
      const afterC = await watchA.read();
      const state = runId ? (await api(`/generation/batches/${runId}`)).body?.state ?? null : null;
      check(
        `tab A keeps its mark ${WAIT_MS / 1000}s after tab C opened ${SECOND_UNCOMPILED}, with its run going`,
        afterC.mark === `a2-${stamp}` && afterC.navigations === 0,
        JSON.stringify(afterC)
      );
      check(
        'the run was not stopped by the second tab',
        state !== null && state !== 'cancelled',
        `run ${runId}: ${state}`
      );
      const built = await until(tabA, () => /Built 1 of 1 resume/.test(document.body.innerText), 120_000);
      check('tab A: the run finishes as built', built, (await tabA.evaluate(() => document.body.innerText)).slice(0, 400));
      await tabC.close();
    }
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n[${MODE}] ${failures} check(s) failed.` : `\n[${MODE}] All checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

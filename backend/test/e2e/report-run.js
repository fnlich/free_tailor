/*
 * Report Jobs and Admin -> Job Lake, in a real browser, against a real server
 * whose Google Sheets and seat are stubbed (stub-report-sheets.js,
 * stub-seat.js).
 *
 * test/jobLakeReport.test.js proves the run, the lake and the rewards over
 * HTTP, and test/frontendJobLake.test.js the pages' pure decisions against
 * the server's rules. This proves the pages and the server are joined up:
 *
 *   - a reporter picks today's tab (chosen for them) and the rows, previews
 *     them - the row whose Lake Status says Added is marked as skipped, and a
 *     `javascript:` link typed into the sheet is never an anchor - and a tab
 *     of their own is refused before a run is started
 *   - "Add to job lake" runs in the background with a progress bar, and ends
 *     with the owner's line, "2 out of 5 was added, your current credit is
 *     $0.1", and every row's outcome - the duplicate red
 *   - the sheet was written: the same rows previewed again say they were
 *     reported - all but the two Skipped, which a run tries again
 *   - the top bar's balance moved with the run
 *   - an administrator finds the jobs in the lake, by a company spelled
 *     another way, opens one, deletes it revoking its reward - and the
 *     reporter's balance drops by exactly that reward
 *   - the Settings tab says where the duplicate window comes from, and the
 *     admin sheet got every added job (Retry now has nothing to send)
 *   - Admin -> Accounts' rate box names the global rate
 *   - no horizontal scrollbar at 390px on /report
 *
 * Servers are expected to be up already, the backend preloaded with both
 * stubs and sharing DB_DIR with this script:
 *
 *   E2E_STUB_DELAY_MS=700 DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-report-sheets.js dist/index.js
 *   DB_DIR=/tmp/e2e-db node test/e2e/report-run.js
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const settings = require(path.join(DIST, 'services', 'jobLake', 'settings'));
const { todaySheetTitle } = require(path.join(DIST, 'services', 'sheets', 'accountSheet'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const OWNER_LINE = '2 out of 5 was added, your current credit is $0.1';

let failures = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      (candidate) => candidate.textContent.trim() === label && !candidate.disabled
    );
    button?.click();
    return Boolean(button);
  }, text);
}

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** A table's body as cells of text (and each row's red flag), found by its caption. */
async function readTable(page, caption) {
  return page.evaluate((wanted) => {
    const table = Array.from(document.querySelectorAll('table')).find((candidate) =>
      candidate.querySelector('caption')?.textContent.includes(wanted)
    );
    if (!table) return null;
    return Array.from(table.querySelectorAll('tbody tr')).map((tr) => ({
      red: tr.getAttribute('data-duplicate') === 'true',
      background: getComputedStyle(tr.querySelector('td')).backgroundColor,
      cells: Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim()),
      hrefs: Array.from(tr.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    }));
  }, caption);
}

const pillText = () => document.querySelector('.tl-topbar')?.innerText ?? document.body.innerText;

async function main() {
  const stamp = Date.now().toString(36);
  const today = todaySheetTitle();
  const admin = users.createUser({ email: `e2e-lake-admin-${stamp}@example.com`, name: 'Lake Admin' });
  users.updateUser(admin.id, { role: 'admin' });
  const reporter = users.createUser({ email: `e2e-lake-reporter-${stamp}@example.com`, name: 'Rita Reporter' });
  users.updateUser(reporter.id, { role: 'reporter' });
  // The global rate: what a reporter with no rate of their own is paid.
  const set = settings.updateLakeSettings({ reportRateUsd: '0.05' }, admin.id);
  check('the global rate is set to $0.05', set.ok, JSON.stringify(set));

  const reporterToken = users.createSession(reporter.id);
  const adminToken = users.createSession(admin.id);
  const api = async (token, route) => {
    const response = await fetch(`${API}${route}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    /* ------------------------------------------------------------ Report Jobs */
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    await signIn(page, reporterToken);
    await page.goto(`${APP}/report`, { waitUntil: 'networkidle2' });
    await until(page, () => document.getElementById('report-tab')?.value, 20_000);

    const opened = await page.evaluate(() => ({
      title: document.querySelector('.tl-main h1')?.textContent.trim(),
      tab: document.getElementById('report-tab')?.value,
      tabs: Array.from(document.getElementById('report-tab')?.options ?? []).map((option) => option.value),
      from: document.getElementById('report-from-row')?.value,
      to: document.getElementById('report-to-row')?.value,
      rate: /per job added\s*\$0\.05(?!\d)/i.test(document.body.innerText),
      later: /arrives in a later release/.test(document.body.innerText),
      sheetLinks: Array.from(document.querySelectorAll('.tl-main a[target="_blank"]')).map((a) => a.getAttribute('href')),
    }));
    check(
      'Report Jobs opens on today\'s tab, rows 2 to 501, the rate per job shown, no "later release" note',
      opened.title === 'Report Jobs' &&
        opened.tab === today &&
        opened.tabs.length === 3 &&
        opened.from === '2' &&
        opened.to === '501' &&
        opened.rate &&
        !opened.later,
      JSON.stringify(opened)
    );
    check(
      'the job sheet link opens a new tab on https',
      opened.sheetLinks.length > 0 && opened.sheetLinks.every((href) => /^https:\/\//.test(href ?? '')),
      JSON.stringify(opened.sheetLinks)
    );
    check(
      'Add to job lake waits for a preview',
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Add to job lake');
        return Boolean(button?.disabled) && /Preview these rows first/.test(document.body.innerText);
      })
    );

    // A tab of the reporter's own is refused before a run is started.
    await page.select('#report-tab', 'My notes');
    check('Preview rows is pressed on My notes', await pressButton(page, 'Preview rows'));
    await until(page, () => /is not laid out as a job sheet tab/.test(document.body.innerText), 15_000);
    check(
      'My notes: refused as not a job sheet tab, and Add to job lake stays disabled',
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Add to job lake');
        return Boolean(button?.disabled) && /"My notes" is not laid out as a job sheet tab/.test(document.body.innerText);
      })
    );

    await page.select('#report-tab', today);
    check('Preview rows is pressed on today\'s tab', await pressButton(page, 'Preview rows'));
    await until(page, () => /6 rows hold a job/.test(document.body.innerText), 15_000);
    const preview = await readTable(page, 'rows in that range that hold a job');
    const initech = preview?.find((row) => row.cells[1] === 'Initech');
    const umbrella = preview?.find((row) => row.cells[1] === 'Umbrella');
    check(
      'the preview lists the six rows, the one reported before marked skipped',
      preview?.length === 6 && /Reported before \(Added\) - skipped/.test(initech?.cells[4] ?? ''),
      JSON.stringify(preview?.map((row) => row.cells))
    );
    check(
      'a javascript: link typed into the sheet is shown as text, never an anchor',
      umbrella && umbrella.hrefs.length === 0 && /javascript:alert/.test(umbrella.cells[3]),
      JSON.stringify(umbrella)
    );
    check(
      'the preview says what a run will do',
      await page.evaluate(() =>
        /6 rows hold a job: 5 will be taken to the job lake, and 1 was reported before and will be skipped\./.test(
          document.body.innerText
        )
      )
    );
    await page.screenshot({ path: `${SHOTS}/report-1-preview.png`, fullPage: true });

    /* ------------------------------------------------------------------ run */
    check('Add to job lake is pressed', await pressButton(page, 'Add to job lake'));
    const sawProgress = await until(page, () => Boolean(document.querySelector('[role="progressbar"][aria-label="Report run"]')), 10_000);
    check('the run shows a progress bar while it goes', sawProgress);
    await page.screenshot({ path: `${SHOTS}/report-2-running.png`, fullPage: true });
    const ended = await until(page, () => Boolean(document.querySelector('[data-testid="report-summary"]')), 90_000);
    const summary = await page.evaluate(() => document.querySelector('[data-testid="report-summary"]')?.textContent.trim());
    check("the run ends with the owner's line", ended && summary === OWNER_LINE, String(summary));

    const outcomes = await readTable(page, 'What each row of the run came to');
    const byCompany = Object.fromEntries((outcomes ?? []).map((row) => [row.cells[1], row]));
    check(
      'every row has its outcome: Added, Duplicate, Added, Reported before, Skipped, Skipped',
      (outcomes ?? []).map((row) => row.cells[3]).join(', ') === 'Added, Duplicate, Added, Reported before, Skipped, Skipped',
      JSON.stringify(outcomes?.map((row) => row.cells))
    );
    const duplicate = byCompany['ACME, Inc.'];
    check(
      'the duplicate row - and only it - is red',
      duplicate?.red === true &&
        /rgb\(254, 242, 242\)/.test(duplicate.background) &&
        (outcomes ?? []).filter((row) => row.red).length === 1,
      JSON.stringify(outcomes?.map((row) => [row.cells[1], row.red, row.background]))
    );
    check(
      'each added row earned $0.05, the duplicate nothing',
      byCompany['Acme Corp']?.cells[4] === '$0.05' && byCompany['Globex LLC']?.cells[4] === '$0.05' && duplicate?.cells[4] === '-',
      JSON.stringify(outcomes?.map((row) => row.cells))
    );

    // The page previews the same rows again once the run ends: the sheet was
    // written. Added and Duplicate rows are reported now; the two Skipped
    // ones are tried again next time.
    const rewritten = await until(
      page,
      () => /6 rows hold a job: 2 will be taken to the job lake, and 4 were reported before and will be skipped\./.test(document.body.innerText),
      15_000
    );
    const again = await readTable(page, 'rows in that range that hold a job');
    check(
      'the same rows previewed again: Added and Duplicate now say reported, the Skipped two are tried again',
      rewritten &&
        (again ?? []).map((row) => /^Reported before/.test(row.cells[4])).join() === 'true,true,true,true,false,false' &&
        /Reported before \(Duplicate\)/.test(again?.[1]?.cells[4] ?? ''),
      JSON.stringify(again?.map((row) => row.cells[4]))
    );
    const balance = await until(page, () => /\$0\.1(?!\d)/.test(document.querySelector('.tl-topbar')?.innerText ?? ''), 15_000);
    check('the top bar balance moved with the run: $0.1', balance, await page.evaluate(pillText));
    await page.screenshot({ path: `${SHOTS}/report-3-done.png`, fullPage: true });

    const overview = await api(reporterToken, '/report');
    check(
      'GET /api/report: $0.1 earned today, 2 jobs in the lake',
      overview.body?.earnedTodayMilli === 100 && overview.body?.lakeJobs === 2 && overview.body?.balanceMilli === 100,
      JSON.stringify(overview.body && { earned: overview.body.earnedTodayMilli, jobs: overview.body.lakeJobs })
    );

    await page.setViewport(PHONE);
    await wait(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('at 390px, Report Jobs adds no horizontal scrollbar', overflow <= 1, `overflow ${overflow}px`);
    await page.screenshot({ path: `${SHOTS}/report-4-phone.png`, fullPage: true });

    // Dark: the last run comes back with the page (kept an hour), its duplicate
    // red in the dark theme's own red, not the light theme's pink.
    await page.setViewport(WIDE);
    await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'dark'));
    await page.reload({ waitUntil: 'networkidle2' });
    await until(page, () => Boolean(document.querySelector('[data-testid="report-summary"]')), 15_000);
    const dark = await readTable(page, 'What each row of the run came to');
    const darkDuplicate = dark?.find((row) => row.red);
    check(
      'dark: the last run is shown again, its duplicate red in the dark palette',
      (await page.evaluate(() => document.documentElement.classList.contains('dark'))) &&
        /rgba\(248, 113, 113, 0\.1\)/.test(darkDuplicate?.background ?? ''),
      JSON.stringify(darkDuplicate)
    );
    await page.screenshot({ path: `${SHOTS}/report-5-dark.png`, fullPage: true });

    /* ----------------------------------------------------------- the admin lake */
    const adminPage = await browser.newPage();
    await adminPage.setViewport(WIDE);
    await signIn(adminPage, adminToken);
    await adminPage.goto(`${APP}/admin/job-lake`, { waitUntil: 'networkidle2' });
    await until(adminPage, () => /2 jobs in the lake/.test(document.body.innerText), 20_000);
    const lake = await readTable(adminPage, 'Jobs in the lake');
    check(
      'Admin -> Job Lake lists the two added jobs, each paid $0.05',
      lake?.length === 2 &&
        lake.every((row) => /\$0\.05 at \$0\.05 per job/.test(row.cells[6])) &&
        lake.map((row) => row.cells[1]).sort().join(', ') === 'Acme Corp, Globex LLC',
      JSON.stringify(lake?.map((row) => row.cells))
    );
    check(
      'Job Lake is a tab of the Settings row',
      await adminPage.evaluate(() =>
        Array.from(document.querySelectorAll('a')).some((a) => a.getAttribute('href') === '/admin/job-lake' && /Job Lake/.test(a.textContent))
      )
    );

    // A company spelled another way finds the job: the lake compares companies normalised.
    await adminPage.type('#lake-company', 'acme inc');
    check('Search is pressed', await pressButton(adminPage, 'Search'));
    await until(adminPage, () => /1 job match/.test(document.body.innerText), 10_000);
    const found = await readTable(adminPage, 'Jobs in the lake');
    check('"acme inc" finds Acme Corp', found?.length === 1 && found[0].cells[1] === 'Acme Corp', JSON.stringify(found?.map((row) => row.cells)));
    check('Clear is pressed', await pressButton(adminPage, 'Clear'));
    await until(adminPage, () => /2 jobs in the lake/.test(document.body.innerText), 10_000);

    // Globex's detail, then delete it taking its reward back.
    await adminPage.evaluate(() => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find((tr) => /Globex LLC/.test(tr.textContent));
      Array.from(row?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Details')?.click();
    });
    await until(adminPage, () => Boolean(document.querySelector('[role="dialog"]')) && /Job description/.test(document.body.innerText), 10_000);
    const detail = await adminPage.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? '');
    check(
      'the detail shows the reward, the requester and the history',
      /\$0\.05 at \$0\.05 per job/.test(detail) && /e2e-lake-reporter-/.test(detail) && /Earlier versions/.test(detail),
      detail.slice(0, 400)
    );
    await adminPage.screenshot({ path: `${SHOTS}/lake-1-detail.png`, fullPage: true });
    await adminPage.evaluate(() => {
      Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Delete')?.click();
    });
    await until(adminPage, () => /Also revoke the reward/.test(document.body.innerText), 5000);
    await adminPage.evaluate(() => {
      const box = Array.from(document.querySelectorAll('[role="dialog"] label')).find((label) => /Also revoke the reward/.test(label.textContent));
      box?.querySelector('input')?.click();
    });
    await until(adminPage, () => /reward is taken back from the reporter's balance/.test(document.body.innerText), 5000);
    await adminPage.evaluate(() => {
      const confirm = document.querySelector('[role="alertdialog"]');
      Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Delete')?.click();
    });
    const deleted = await until(adminPage, () => /Deleted Globex LLC - .* from the lake\. Took back the \$0\.05 reward/.test(document.body.innerText), 10_000);
    check('delete with "Also revoke the reward" takes the job and its reward back', deleted);
    await until(adminPage, () => /1 job in the lake/.test(document.body.innerText), 10_000);
    const reporterAfter = await api(reporterToken, '/report');
    check(
      "the reporter's balance dropped by exactly that reward: $0.05",
      reporterAfter.body?.balanceMilli === 50,
      String(reporterAfter.body?.balanceMilli)
    );

    // Settings: where the window comes from, and the admin sheet.
    await adminPage.goto(`${APP}/admin/job-lake?tab=settings`, { waitUntil: 'networkidle2' });
    await until(adminPage, () => Boolean(document.getElementById('lake-rate')), 15_000);
    const settingsTab = await adminPage.evaluate(() => ({
      rate: document.getElementById('lake-rate')?.value,
      windowPlaceholder: document.getElementById('lake-window')?.getAttribute('placeholder'),
      window: /In effect: 60 days/.test(document.body.innerText),
      sheet: Array.from(document.querySelectorAll('a')).some((a) => /Open the admin sheet/.test(a.textContent)),
      synced: /Every job in the lake is on the admin sheet\./.test(document.body.innerText),
    }));
    check(
      'Settings: the rate as stored, the window in effect and where it comes from, the admin sheet with every job',
      settingsTab.rate === '0.05' &&
        settingsTab.window &&
        /^60 \(/.test(settingsTab.windowPlaceholder ?? '') &&
        settingsTab.sheet &&
        settingsTab.synced,
      JSON.stringify(settingsTab)
    );
    check('Retry now is pressed', await pressButton(adminPage, 'Retry now'));
    check(
      'Retry now has nothing to send',
      await until(adminPage, () => /Nothing was waiting/.test(document.body.innerText), 10_000)
    );
    // A rate past $0.001 steps is refused under its box, in the server's words.
    await adminPage.click('#lake-rate', { clickCount: 3 });
    await adminPage.type('#lake-rate', '0.0505');
    const refused = await adminPage.evaluate(() => ({
      text: document.querySelector('#lake-rate')?.closest('div')?.parentElement?.innerText ?? '',
      save: Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Save')?.disabled,
    }));
    check('a rate of $0.0505 is refused under its box, and Save stays disabled', /rate per job/i.test(refused.text) && refused.save === true, JSON.stringify(refused));
    await adminPage.screenshot({ path: `${SHOTS}/lake-2-settings.png`, fullPage: true });

    await adminPage.goto(`${APP}/admin/job-lake?tab=merge`, { waitUntil: 'networkidle2' });
    check(
      'Merge: nothing to merge on an install with no builds',
      await until(adminPage, () => /Nothing to merge/.test(document.body.innerText), 10_000)
    );

    // Admin -> Accounts: an empty rate box names the global rate by its figure.
    await adminPage.goto(`${APP}/admin/accounts`, { waitUntil: 'networkidle2' });
    await until(adminPage, () => /Global rate \(\$0\.05\)|Global \(\$0\.05\)/.test(document.documentElement.innerHTML), 15_000);
    const placeholders = await adminPage.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map((input) => input.getAttribute('placeholder')).filter((value) => /Global/.test(value ?? ''))
    );
    check(
      'Admin -> Accounts: the rate boxes name the global rate, $0.05',
      placeholders.length > 0 && placeholders.every((value) => /\$0\.05\)/.test(value)),
      JSON.stringify(placeholders)
    );
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/*
 * The builder's sheet mode, in a real browser: the inline panel that replaced
 * the "Import from Google Sheet" dialog.
 *
 * Google is stubbed (stub-sheets.js: four tabs, canned rows) and so is the
 * seat (stub-seat.js); the routes, the account-sheet checks, the queue, the
 * order rows and the files are the shipping code. It checks what the owner
 * asked for:
 *
 *   - the account's own sheet is the only one: there is no sheet to choose,
 *     and no column mapping
 *   - the Tab select is on the page, lists EVERY tab, and starts on All; an
 *     older build's daily tab is listed, marked as an old layout that is not
 *     read, and cannot be chosen
 *   - Load rows shows the jobs found - company, title, a link only when it is
 *     a web address - and counts the rows skipped, before anything is built
 *   - another tab is another set of rows, loaded again
 *   - Order answers with an order number, and Cancel on the receipt stops it
 *   - Generate Immediately builds the loaded rows here and hands every file
 *     to the browser once
 *   - the Analysis column says which rows already hold their analysis (the
 *     protected Analysis cell, G:L read beside the job columns C:F) and so skip
 *     analysis, with the Job Field and Salary the row shows; and once a
 *     build has analysed the others, they are written back and say so too
 *   - the Job Filter, on the same tab, shows every row's Pass, Fail or why it
 *     was not judged on the page, and writes nothing into the sheet
 *   - all of it on the Default subscription, and without a horizontal
 *     scrollbar at 390px
 *
 *   E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js
 *   DB_DIR=/tmp/e2e-db node test/e2e/sheet-panel.js
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
const PHONE = { width: 390, height: 844 };
const OLDER_TAB = '09/30/2026';

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

/** The Tab select as drawn: its options and the one chosen. */
async function readTabs(page) {
  return page.evaluate(() => {
    const select = document.getElementById('sheet-tab');
    if (!select) return null;
    return {
      disabled: select.disabled,
      value: select.value,
      options: Array.from(select.options).map((option) => ({
        value: option.value,
        text: option.textContent.trim(),
        disabled: option.disabled,
      })),
    };
  });
}

/** The preview table's rows, as cells of text, and what the panel says above it. */
async function readPreview(page) {
  return page.evaluate(() => {
    const table = Array.from(document.querySelectorAll('table')).find(
      (candidate) => candidate.querySelector('caption')?.textContent.includes('loaded rows')
    );
    const notice = Array.from(document.querySelectorAll('.tl-notice')).find((node) => /job.? in rows/.test(node.textContent));
    return {
      rows: table
        ? Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
            Array.from(tr.querySelectorAll('td')).map((td) => ({
              text: td.innerText.trim(),
              href: td.querySelector('a')?.getAttribute('href') ?? null,
            }))
          )
        : null,
      notice: notice ? notice.innerText.replace(/\s+/g, ' ').trim() : null,
      analysisLine:
        Array.from(document.querySelectorAll('p')).find((node) => /analysed once, the first time any build needs it/.test(node.textContent))
          ?.innerText.replace(/\s+/g, ' ')
          .trim() ?? null,
      actions: Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter((t) => t === 'Order' || t === 'Generate Immediately'),
    };
  });
}

async function main() {
  const stamp = Date.now().toString(36);
  const all = 'All';
  const user = users.createUser({ email: `e2e-sheet-${stamp}@example.com`, name: 'Sheet User' });
  const profileId = `p-sheet-${stamp}`;
  saveProfile({
    ...buildNewProfile(
      {
        name: 'Sam Sheet',
        title: 'Senior Engineer',
        contact: { email: 'sam@example.com', phone: '1', location: 'Remote' },
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
  const api = async (route) => {
    const response = await fetch(`${API}${route}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const handed = [];
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept();
    });
    await page.exposeFunction('__e2eHanded', (name) => handed.push(name));
    await page.evaluateOnNewDocument(() => {
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__e2eHanded(this.download);
        return click.call(this);
      };
    });
    await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((value) => {
      window.localStorage.setItem('adminToken', value);
      window.localStorage.setItem('tailor-theme', 'light');
    }, token);
    await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });

    /* ---------------------------------------------------------- the tab list */
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    const opened = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('Building Automatically from Google Sheet')
      );
      card?.click();
      return Boolean(card);
    });
    check('the Google Sheet card opens', opened);
    await until(page, () => {
      const select = document.getElementById('sheet-tab');
      return Boolean(select) && !select.disabled && select.options.length > 1;
    }, 15_000);
    const tabs = await readTabs(page);
    check(
      'the Tab select lists every tab of the sheet, in its order',
      Boolean(tabs) && tabs.options.map((option) => option.value).join(' | ') === `All | Temp For AI | ${OLDER_TAB} | Notes`,
      JSON.stringify(tabs)
    );
    check('it starts on All', tabs?.value === all, JSON.stringify(tabs));
    const olderOption = tabs?.options.find((option) => option.value === OLDER_TAB);
    check(
      "an older build's daily tab is listed as an old layout that is not read, and cannot be chosen",
      Boolean(olderOption) && olderOption.disabled && olderOption.text === `${OLDER_TAB} (old layout, not read)` &&
        tabs.options.filter((option) => option.disabled).length === 1,
      JSON.stringify(tabs?.options)
    );
    const sheetChrome = await page.evaluate(() => ({
      sheetSelect: Boolean(document.getElementById('sheet-source')),
      advanced: Array.from(document.querySelectorAll('button')).some((b) => /Advanced columns/i.test(b.textContent)),
      columnInputs: Boolean(document.getElementById('sheet-from-col') || document.getElementById('sheet-col-company')),
      note: /Tabs that are not laid out as job tabs .* are listed but not read/.test(document.body.innerText),
    }));
    check(
      'no sheet to choose and no column mapping: the own sheet and its columns are the app\'s; the page says why a tab is not read',
      !sheetChrome.sheetSelect && !sheetChrome.advanced && !sheetChrome.columnInputs && sheetChrome.note,
      JSON.stringify(sheetChrome)
    );
    // Picked anyway - a select can be driven past its disabled options - it is still All.
    await page.select('#sheet-tab', OLDER_TAB);
    await wait(300);
    check('choosing the old tab anyway leaves All chosen', (await readTabs(page))?.value === all, JSON.stringify(await readTabs(page)));
    const importButton = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some((b) => /Import from Google Sheet/i.test(b.textContent))
    );
    check('no "Import from Google Sheet" button anywhere', !importButton);
    const beforeLoad = await readPreview(page);
    check('nothing can be built before rows are loaded', beforeLoad.actions.length === 0, JSON.stringify(beforeLoad.actions));

    /* ------------------------------------------------------------- Load rows */
    check('Load rows is pressed', await pressButton(page, 'Load rows'));
    await until(page, () => Boolean(document.querySelector('table caption')), 10_000);
    const loaded = await readPreview(page);
    const companies = (loaded.rows ?? []).map((cells) => cells[1]?.text);
    check(
      "All's rows are shown before anything is built: a job per row with a company and a description",
      companies.join(' | ') === 'Today Inc | Now LLC | Current Co' &&
        (loaded.rows ?? []).map((cells) => cells[0]?.text).join(',') === '2,3,5',
      JSON.stringify(loaded.rows)
    );
    const linkOf = (company) => (loaded.rows ?? []).find((cells) => cells[1]?.text === company)?.[3];
    check(
      'a link is a link only when it is a web address',
      linkOf('Today Inc')?.href === 'https://today.example/jobs/1' && linkOf('Now LLC')?.href === null,
      JSON.stringify([linkOf('Today Inc'), linkOf('Now LLC')])
    );
    check(
      'a row with no title says the posting will name it',
      (loaded.rows ?? []).find((cells) => cells[1]?.text === 'Current Co')?.[2]?.text === 'From the posting',
      JSON.stringify(loaded.rows)
    );
    check(
      'the panel counts the jobs and the rows it skipped',
      /^3 jobs in rows 2-11 of/.test(loaded.notice ?? '') && /7 rows skipped/.test(loaded.notice ?? ''),
      String(loaded.notice)
    );
    check('then both ways to build are offered', loaded.actions.join(',') === 'Order,Generate Immediately', JSON.stringify(loaded.actions));
    const analysisOf = (rowsShown, company) => (rowsShown ?? []).find((cells) => cells[1]?.text === company)?.[4]?.text ?? '';
    check(
      "a row whose Analysis cell is filled skips analysis, and shows the Job Field and Salary its row holds",
      /^Skips analysis/.test(analysisOf(loaded.rows, 'Today Inc')) &&
        analysisOf(loaded.rows, 'Today Inc').includes('Backend · USD 120,000 - 140,000 / annual'),
      JSON.stringify(analysisOf(loaded.rows, 'Today Inc'))
    );
    check(
      'a row with an empty Analysis cell is analysed when built',
      /^When built/.test(analysisOf(loaded.rows, 'Now LLC')) && /^When built/.test(analysisOf(loaded.rows, 'Current Co')),
      JSON.stringify(loaded.rows?.map((cells) => cells[4]?.text))
    );
    check(
      'the panel counts the rows that skip analysis',
      /^1 of 3 already analysed in the sheet, so they skip analysis\./.test(loaded.analysisLine ?? ''),
      String(loaded.analysisLine)
    );
    const costLine = await page.evaluate(() => document.body.innerText.match(/This run: [^\n]*/)?.[0] ?? null);
    check('the cost line prices the loaded rows', /^This run: 3 resumes/.test(costLine ?? ''), String(costLine));
    await page.screenshot({ path: `${SHOTS}/sheet-1-loaded.png`, fullPage: true });

    // Another tab is another set of rows: what was loaded goes, and is loaded again.
    await page.select('#sheet-tab', 'Notes');
    await wait(300);
    const switched = await readPreview(page);
    check('choosing another tab drops the rows loaded from the last one', switched.rows === null && switched.actions.length === 0, JSON.stringify(switched));
    await pressButton(page, 'Load rows');
    await until(page, () => Boolean(document.querySelector('table caption')), 10_000);
    const older = await readPreview(page);
    check(
      'and Load rows reads the chosen tab',
      (older.rows ?? []).map((cells) => cells[1]?.text).join(' | ') === 'Older Co | Elder Ltd',
      JSON.stringify(older.rows)
    );
    check(
      'a tab with nothing in its analysis columns has no row that skips analysis',
      (older.rows ?? []).every((cells) => /^When built/.test(cells[4]?.text ?? '')) &&
        /^Every other posting/.test(older.analysisLine ?? ''),
      JSON.stringify([older.rows?.map((cells) => cells[4]?.text), older.analysisLine])
    );

    /* --------------------------------------------- Order, and Cancel on it */
    check('Order is pressed', await pressButton(page, 'Order'));
    const receipt = await until(page, () => /You ordered successfully: Order number - FT-\d{8}-\d{4}/.test(document.body.innerText), 15_000);
    check('Order answers with an order number at once', receipt);
    const orderNumber = await page.evaluate(() => document.body.innerText.match(/FT-\d{8}-\d{4}/)?.[0] ?? null);
    await page.screenshot({ path: `${SHOTS}/sheet-2-ordered.png` });
    check('the receipt offers Cancel', await pressButton(page, 'Cancel order'));
    const cancelled = await until(
      page,
      () => /Cancelled: (\d+ resumes? (not started|being built)|nothing was left to stop)/.test(document.body.innerText),
      10_000
    );
    check(
      'Cancel on the receipt asks first, then says what it stopped',
      cancelled && dialogs.some((d) => d.type === 'confirm' && d.message.includes(`Cancel what is left of order ${orderNumber}?`)),
      JSON.stringify(dialogs)
    );
    const listed = (await api('/orders')).body?.orders ?? [];
    const order = listed.find((entry) => entry.number === orderNumber);
    check(
      'the order is on Orders, cancelled, with both rows in it',
      Boolean(order) && order.state === 'cancelled' && order.total === 2,
      JSON.stringify(order)
    );

    /* ------------------------------------------- Generate Immediately, from rows */
    await page.select('#sheet-tab', all);
    await wait(300);
    await pressButton(page, 'Load rows');
    await until(page, () => Boolean(document.querySelector('table caption')), 10_000);
    check('Generate Immediately is pressed', await pressButton(page, 'Generate Immediately'));
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')), 5000);
    check('it asks first here too', /If you close the tab or the network drops/.test((await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText)) ?? ''));
    await pressButton(page, 'Proceed');
    const built = await until(page, () => /Built 3 of 3 resumes/.test(document.body.innerText), 90_000);
    check('the loaded rows are built here', built, (await page.evaluate(() => document.body.innerText)).slice(0, 500));
    const fromSheet = handed.filter((name) => /^(Today Inc|Now LLC|Current Co)/.test(name));
    check(
      'every file of every resume is handed to the browser once',
      fromSheet.length === 12 && new Set(fromSheet).size === 12,
      fromSheet.join(', ')
    );
    await page.screenshot({ path: `${SHOTS}/sheet-3-built.png`, fullPage: true });

    // The two rows that had no analysis are written back once their posting
    // is analysed (or found stored), batched a moment after the run starts -
    // into their G:L, all six cells - so the next load of the same rows finds
    // every one analysed.
    await wait(2500);
    check('Reload rows is pressed', await pressButton(page, 'Reload rows'));
    await until(
      page,
      () => /3 of 3 already analysed/.test(document.body.innerText),
      10_000
    );
    const reloaded = await readPreview(page);
    check(
      'after the build, every row it analysed has its analysis written back, and skips analysis next time',
      (reloaded.rows ?? []).length === 3 &&
        (reloaded.rows ?? []).every((cells) => /^Skips analysis/.test(cells[4]?.text ?? '')) &&
        /^3 of 3 already analysed in the sheet/.test(reloaded.analysisLine ?? ''),
      JSON.stringify([reloaded.rows?.map((cells) => cells[4]?.text), reloaded.analysisLine])
    );

    /* ------------------------------------------- the Job Filter, same tab */
    // The filter reads All's C:E and shows every verdict on the page - it
    // writes nothing into the sheet. Today Inc's posting is analysed (its
    // cell, then this build): judged with no page fetch. Now LLC's link is
    // not a web address, so its page cannot be opened; the two rows with no
    // link are listed, not judged.
    await page.goto(`${APP}/jobs/filter`, { waitUntil: 'networkidle2' });
    await until(page, () => document.getElementById('job-filter-tab')?.value === 'All', 15_000);
    const filterTabs = await page.evaluate(() =>
      Array.from(document.getElementById('job-filter-tab')?.options ?? []).map((option) => `${option.textContent.trim()}${option.disabled ? ' [disabled]' : ''}`)
    );
    check(
      'the Job Filter lists the same tabs, starts on All, and the old daily tab cannot be chosen',
      filterTabs.join(' | ') === `All | Temp For AI | ${OLDER_TAB} (old layout, not read) [disabled] | Notes`,
      JSON.stringify(filterTabs)
    );
    check('Run job filter is pressed', await pressButton(page, 'Run job filter'));
    await until(page, () => Boolean(document.querySelector('[data-testid="filter-counts"]')), 30_000);
    const verdicts = await page.evaluate(() => ({
      counts: document.querySelector('[data-testid="filter-counts"]')?.textContent.trim() ?? null,
      rows: Array.from(document.querySelectorAll('table tbody tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim())
      ),
      written: /Nothing is written into your sheet/.test(document.body.innerText),
    }));
    check(
      "the Job Filter shows each row's verdict and why, on the page",
      verdicts.counts === '1 pass, 3 not judged.' &&
        verdicts.rows.map((cells) => `${cells[0]}:${cells[1]}:${cells[4]}`).join(' | ') ===
          [
            '2:Today Inc:Pass',
            '3:Now LLC:Not judged Job link must be an absolute http(s) URL.',
            '4:-:Not judged The row has no job link to read.',
            '5:Current Co:Not judged The row has no job link to read.',
          ].join(' | ') &&
        verdicts.written,
      JSON.stringify(verdicts)
    );
    await page.screenshot({ path: `${SHOTS}/sheet-5-filter.png`, fullPage: true });
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Building Automatically from Google Sheet'))?.click();
    });
    await until(page, () => document.getElementById('sheet-tab')?.value === 'All', 15_000);
    await pressButton(page, 'Load rows');
    await until(page, () => Boolean(document.querySelector('table caption')), 10_000);

    /* ------------------------------------------------------------------ 390 */
    await page.setViewport(PHONE);
    await wait(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('at 390px, the loaded rows and their table add no horizontal scrollbar', overflow <= 1, `overflow ${overflow}px`);
    await page.screenshot({ path: `${SHOTS}/sheet-4-phone.png`, fullPage: true });
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

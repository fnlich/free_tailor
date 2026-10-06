/*
 * Admin -> Job Lake's filter form and Push to Google Sheet, in a real
 * browser, against a real server whose Google Sheets and seat are stubbed
 * (stub-lake-push-sheets.js, stub-seat.js).
 *
 * test/jobLakePush.test.js proves the push over HTTP, and
 * test/frontendJobLake.test.js the page's decisions against the route's
 * rules. This proves the page and the server are joined up, and what the
 * sheet looks like afterwards:
 *
 *   - the filter boxes are in the owner's order - Updated from, Updated to,
 *     Requested by, Job field, Job type, Clearance, Industry, Company, Salary
 *     from, Salary to, Full text - Job type offers Any, Remote, Hybrid,
 *     Onsite, Clearance Any, Required, Not required, and Industry Any and the
 *     server's own list
 *   - Push to Google Sheet asks first, naming how many jobs go, that only the
 *     newest go past JOB_LAKE_PUSH_MAX_ROWS (the server runs with 4, the lake
 *     holds 5), and that it replaces the Temp For AI tab of your own sheet;
 *     its result says so, and links to the tab
 *   - the tab afterwards: A:L of every row under the header replaced - the
 *     rows an earlier push left emptied, values AND their red paint - the
 *     header and the person's own column M untouched, newest first, each
 *     row's six analysis cells naming its posting's stored analysis
 *   - a second push of a narrower search replaces the first, and pushes the
 *     search on the page - not boxes changed since, which the confirm says
 *   - a build from the pushed rows takes every analysis from its Analysis
 *     cell: it reads the cells, writes nothing back (a cell the server did
 *     not trust would be replaced) - and, given the server's log, the run
 *     says every job was "analysed in the sheet"
 *   - another administrator's sheet is never touched, and one whose Temp For
 *     AI is a tab of their own is refused in the Job Sheet page's words
 *   - no horizontal scrollbar at 390px
 *
 * Servers are expected to be up already, the backend preloaded with both
 * stubs and sharing a FRESH DB_DIR with this script (the lake must hold only
 * this script's jobs):
 *
 *   E2E_STUB_DELAY_MS=300 JOB_LAKE_PUSH_MAX_ROWS=4 DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-lake-push-sheets.js dist/index.js > /tmp/e2e-backend.log 2>&1
 *   DB_DIR=/tmp/e2e-db E2E_BACKEND_LOG=/tmp/e2e-backend.log node test/e2e/lake-push.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const analyses = require(path.join(DIST, 'database', 'jobAnalysisRepository'));
const identity = require(path.join(DIST, 'services', 'jobAnalysis', 'identity'));
const lakeService = require(path.join(DIST, 'services', 'jobLake', 'index'));
const { saveProfile } = require(path.join(DIST, 'database', 'profileRepository'));
const { buildNewProfile } = require(path.join(DIST, 'services', 'profileService'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;
const STATE = process.env.E2E_SHEET_STATE || path.join(process.env.DB_DIR || os.tmpdir(), 'e2e-lake-push-sheets.json');
const BACKEND_LOG = process.env.E2E_BACKEND_LOG || '';

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TEMP = 'Temp For AI';
const DAY = 24 * 60 * 60 * 1000;

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

/** Presses the enabled button labelled `text` - inside the open dialog when `inDialog`. */
async function pressButton(page, text, inDialog = false) {
  return page.evaluate(
    (label, dialogOnly) => {
      const scope = dialogOnly ? document.querySelector('[role="dialog"]') : document;
      const button = Array.from(scope?.querySelectorAll('button') ?? []).find(
        (candidate) => candidate.textContent.trim() === label && !candidate.disabled
      );
      button?.click();
      return Boolean(button);
    },
    text,
    inDialog
  );
}

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** The stub's sheets and its log of reads and writes, as it wrote them last. */
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const tabIn = (state, spreadsheetId, tab = TEMP) => state.books[spreadsheetId]?.tabs?.[tab];
const COLUMNS = Array.from({ length: 13 }, (_, index) => String.fromCharCode(65 + index));
/** Row `row` of a tab as its A:M values ('' for an empty cell). */
const rowOf = (tab, row) => COLUMNS.map((col) => tab?.rows?.[row]?.[col] ?? '');
const blankAL = (tab, row) => rowOf(tab, row).slice(0, 12).every((value) => value === '');

const posting = (company) =>
  `${company}: a senior backend engineer to build TypeScript services on Node.js for a SaaS platform, owning APIs end to end.`;

/**
 * The lake: five jobs, a day apart, each from an analysis stored for its
 * posting - the newest first in the sheet - with a job type, clearance and
 * industry of its own.
 */
const JOBS = [
  { company: 'Remote One Co', daysAgo: 1, industry: 'technology', filter: { jobType: 'remote' } },
  { company: 'Hybrid Two LLC', daysAgo: 2, industry: 'finance', filter: { jobType: 'hybrid' } },
  { company: 'Onsite Three Inc', daysAgo: 3, industry: 'healthcare', filter: { jobType: 'on_site' } },
  { company: 'Remote Four Ltd', daysAgo: 4, industry: 'government', filter: { jobType: 'remote', clearanceRequired: 'secret' } },
  { company: 'Quiet Five', daysAgo: 5, industry: 'not_specified', filter: {} },
];

function seedLake(adminId) {
  const now = Date.now();
  const stored = {};
  for (const job of JOBS) {
    const jd = posting(job.company);
    const link = `https://jobs.example.com/${encodeURIComponent(job.company)}`;
    const { row } = analyses.insertJobAnalysisIfAbsent({
      contentHash: identity.contentHash(jd),
      linkKey: identity.linkKey(link),
      jobLink: link,
      analysis: {
        jobMeta: { title: `${job.company} Engineer`, seniority: 'senior', industry: '', department: '' },
        skills: { technical: ['TypeScript'], required: [], preferred: [], tools: [], soft: [], technologies: [] },
        technologies: [],
        protocols: [],
        methodologies: [],
        architecturePatterns: [],
        responsibilities: ['services'],
        domainKnowledge: [],
        softSkills: [],
        keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
        jobField: 'backend',
        industry: job.industry,
        salary: null,
        filter: {
          jobType: 'not_specified',
          onsiteInterview: 'not_specified',
          companyCategory: 'other',
          clearanceRequired: 'none',
          region: 'us',
          usState: '',
          ...job.filter,
        },
        sourceJobDescription: jd,
      },
      modelId: '',
      promptHash: '',
      source: 'ai',
      createdBy: adminId,
      companyName: job.company,
    });
    const merged = lakeService.mergeIntoLake(
      lakeService.lakeJobFromAnalysis(row, 'merge', { company: job.company, url: link }),
      adminId,
      { reward: false, now: now - job.daysAgo * DAY }
    );
    stored[job.company] = { analysisId: row.id, status: merged.status, jd, link };
  }
  return stored;
}

async function main() {
  const stamp = Date.now().toString(36);
  const makeAdmin = (label, name) => {
    const account = users.createUser({ email: `e2e-push-${label}-${stamp}@example.com`, name });
    users.updateUser(account.id, { role: 'admin' });
    return account;
  };
  const admin = makeAdmin('admin', 'Push Admin');
  const other = makeAdmin('other', 'Other Admin');
  const clash = makeAdmin('clash', 'Clash Admin');
  const tokens = { admin: users.createSession(admin.id), other: users.createSession(other.id), clash: users.createSession(clash.id) };
  const api = async (token, route, init = {}) => {
    const response = await fetch(`${API}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const stored = seedLake(admin.id);
  check(
    'the lake gets its five jobs',
    Object.values(stored).every((job) => job.status === 'added'),
    JSON.stringify(Object.fromEntries(Object.entries(stored).map(([company, job]) => [company, job.status])))
  );
  const profileId = `p-push-${stamp}`;
  saveProfile({
    ...buildNewProfile(
      {
        name: 'Pat Push',
        title: 'Senior Engineer',
        contact: { email: 'pat@example.com', phone: '1', location: 'Remote' },
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
    ownerId: admin.id,
  });

  // The other administrator's sheet exists before any push: it must come out exactly as it went in.
  const otherSheet = await api(tokens.other, '/sheet');
  const otherId = users.getUserById(other.id)?.sheetId;
  check('the other administrator has a sheet of their own', otherSheet.status === 200 && Boolean(otherId), JSON.stringify(otherSheet.body));
  const otherBefore = JSON.stringify(tabIn(readState(), otherId));

  const lakeAnswer = await api(tokens.admin, '/admin/job-lake');
  check(
    'GET /api/admin/job-lake: five jobs, a push writes at most 4 (JOB_LAKE_PUSH_MAX_ROWS=4)',
    lakeAnswer.body?.total === 5 && lakeAnswer.body?.pushMaxRows === 4,
    JSON.stringify(lakeAnswer.body && { total: lakeAnswer.body.total, pushMaxRows: lakeAnswer.body.pushMaxRows })
  );

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    await signIn(page, tokens.admin);
    await page.goto(`${APP}/admin/job-lake`, { waitUntil: 'networkidle2' });
    await until(page, () => /5 jobs in the lake/.test(document.body.innerText), 20_000);

    /* ---------------------------------------------------------- the form */
    const form = await page.evaluate(() => {
      const options = (id) => Array.from(document.getElementById(id)?.options ?? []).map((option) => option.textContent.trim());
      return {
        labels: Array.from(document.querySelectorAll('form[aria-label="Filter the lake"] label')).map((label) => label.textContent.trim()),
        jobTypes: options('lake-job-type'),
        clearance: options('lake-clearance'),
        industries: options('lake-industry'),
        buttons: Array.from(document.querySelectorAll('form[aria-label="Filter the lake"] button')).map((b) => b.textContent.trim()),
      };
    });
    check(
      "the filter boxes are in the owner's order",
      form.labels.join(' | ') ===
        'Updated from | Updated to | Requested by | Job field | Job type | Clearance | Industry | Company | Salary from | Salary to | Full text',
      JSON.stringify(form.labels)
    );
    check(
      'Job type offers Any, Remote, Hybrid, Onsite; Clearance Any, Required, Not required',
      form.jobTypes.join(',') === 'Any,Remote,Hybrid,Onsite' && form.clearance.join(',') === 'Any,Required,Not required',
      JSON.stringify([form.jobTypes, form.clearance])
    );
    check(
      "Industry offers Any and the server's own list",
      form.industries.join(',') === ['Any', ...(lakeAnswer.body?.options?.industries ?? []).map((option) => option.label)].join(',') &&
        form.industries.includes('Healthcare'),
      JSON.stringify(form.industries)
    );
    check(
      'Push to Google Sheet sits beside Search',
      form.buttons.join(' | ') === 'Clear | Push to Google Sheet | Search',
      JSON.stringify(form.buttons)
    );
    await page.screenshot({ path: `${SHOTS}/push-1-form.png`, fullPage: true });

    /* --------------------------------------------- the first push, capped */
    check('Push to Google Sheet is pressed', await pressButton(page, 'Push to Google Sheet'));
    await until(page, () => /Push to Google Sheet\?/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 5000);
    const firstConfirm = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.replace(/\s+/g, ' ') ?? '');
    check(
      'the confirm names how many go - the newest 4 of 5, past the cap - and that it replaces Temp For AI of your own sheet',
      firstConfirm.includes(
        'Push the newest 4 of the 5 jobs these filters match - a push takes at most 4 (JOB_LAKE_PUSH_MAX_ROWS) - into the Temp For AI tab of your own job sheet, newest first?'
      ) && firstConfirm.includes('It replaces what that tab holds'),
      firstConfirm
    );
    await page.screenshot({ path: `${SHOTS}/push-2-confirm.png`, fullPage: true });
    check('Push is pressed in the confirm', await pressButton(page, 'Push', true));
    const firstDone = await until(page, () => /Pushed the newest 4 of the 5 jobs/.test(document.body.innerText), 20_000);
    const firstResult = await page.evaluate(() => {
      const notice = Array.from(document.querySelectorAll('.tl-notice')).find((node) => /Pushed/.test(node.textContent));
      return {
        text: notice?.innerText.replace(/\s+/g, ' ').trim() ?? '',
        link: notice?.querySelector('a')?.getAttribute('href') ?? null,
        linkText: notice?.querySelector('a')?.textContent.trim() ?? null,
        dialog: Boolean(document.querySelector('[role="dialog"]')),
      };
    });
    const adminSheetId = users.getUserById(admin.id)?.sheetId;
    check(
      'the result says only the newest 4 went, why, and links to the tab',
      firstDone &&
        firstResult.text.startsWith(
          'Pushed the newest 4 of the 5 jobs these filters match into Temp For AI, replacing what it held. A push writes at most 4 (JOB_LAKE_PUSH_MAX_ROWS), so the oldest was left out'
        ) &&
        firstResult.linkText === 'Open Temp For AI' &&
        firstResult.link === `https://docs.google.com/spreadsheets/d/${adminSheetId}/edit#gid=2` &&
        !firstResult.dialog,
      JSON.stringify(firstResult)
    );
    await page.screenshot({ path: `${SHOTS}/push-3-capped.png`, fullPage: true });

    let state = readState();
    let temp = tabIn(state, adminSheetId);
    check(
      'Temp For AI holds the newest four, newest first, from row 2',
      [2, 3, 4, 5].map((row) => rowOf(temp, row)[2]).join(' | ') === 'Remote One Co | Hybrid Two LLC | Onsite Three Inc | Remote Four Ltd',
      JSON.stringify([2, 3, 4, 5].map((row) => rowOf(temp, row)))
    );
    check(
      "the row an earlier push left below them is emptied across A:L, the person's column M kept, and the header untouched",
      blankAL(temp, 6) && rowOf(temp, 6)[12] === 'my note 6' && temp.header[12] === 'My notes' && temp.header[0] === 'Date',
      JSON.stringify({ row6: rowOf(temp, 6), header: temp.header })
    );
    check(
      "the red an earlier report run painted is gone from A:L, and only from A:L",
      [3, 4].every((row) => Object.keys(temp.paint[row] ?? {}).join() === 'M'),
      JSON.stringify(temp.paint)
    );
    const remoteOne = rowOf(temp, 2);
    const remoteFour = rowOf(temp, 5);
    const cellId = (row) => {
      try {
        return JSON.parse(row[11]).id;
      } catch {
        return null;
      }
    };
    check(
      "each row is the job and its analysis: a date, its number for the day, company, link and description, then the six analysis cells naming its posting's stored analysis",
      typeof remoteOne[0] === 'number' &&
        remoteOne[1] === 1 &&
        remoteOne[4] === stored['Remote One Co'].link &&
        remoteOne[5] === stored['Remote One Co'].jd &&
        remoteOne[8] === 'Remote' &&
        remoteOne[9] === false &&
        remoteOne[10] === 'Technology' &&
        cellId(remoteOne) === stored['Remote One Co'].analysisId &&
        remoteFour[9] === true &&
        remoteFour[10] === 'Government' &&
        cellId(remoteFour) === stored['Remote Four Ltd'].analysisId,
      JSON.stringify([remoteOne.slice(0, 11), remoteFour.slice(0, 11)])
    );

    /* -------------------------- the second push: the search on the page */
    await page.select('#lake-job-type', 'remote');
    check('Search is pressed with Job type: Remote', await pressButton(page, 'Search'));
    await until(page, () => /2 jobs match/.test(document.body.innerText), 10_000);
    // A box changed after the search: the push still sends the search on the page.
    await page.type('#lake-company', 'zzz');
    check('Push to Google Sheet is pressed again', await pressButton(page, 'Push to Google Sheet'));
    await until(page, () => /Push to Google Sheet\?/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 5000);
    const secondConfirm = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.replace(/\s+/g, ' ') ?? '');
    check(
      'the confirm names the 2 jobs the search found, and says the boxes changed since are not what is pushed',
      secondConfirm.includes('Push the 2 jobs these filters match into the Temp For AI tab of your own job sheet') &&
        !/JOB_LAKE_PUSH_MAX_ROWS/.test(secondConfirm) &&
        secondConfirm.includes('You changed the filters since the last Search'),
      secondConfirm
    );
    check('Push is pressed in the confirm', await pressButton(page, 'Push', true));
    const secondDone = await until(
      page,
      () => /Pushed 2 jobs into Temp For AI, newest first, replacing what it held\./.test(document.body.innerText),
      20_000
    );
    check('the result says 2 jobs went, replacing what the tab held', secondDone, await page.evaluate(() => document.body.innerText.slice(0, 1500)));
    check(
      'the table still shows the search, not the boxes changed since',
      await page.evaluate(() => /2 jobs match/.test(document.body.innerText) && document.querySelectorAll('tbody tr').length === 2)
    );
    state = readState();
    temp = tabIn(state, adminSheetId);
    check(
      'Temp For AI holds just the two remote jobs now; what the first push wrote below them is emptied, column M kept',
      [2, 3].map((row) => rowOf(temp, row)[2]).join(' | ') === 'Remote One Co | Remote Four Ltd' &&
        [4, 5, 6].every((row) => blankAL(temp, row)) &&
        [2, 3, 4, 5, 6].every((row) => rowOf(temp, row)[12] === `my note ${row}`),
      JSON.stringify([2, 3, 4, 5, 6].map((row) => rowOf(temp, row)))
    );
    await page.screenshot({ path: `${SHOTS}/push-4-remote.png`, fullPage: true });

    /* ------------------------------- a build from the pushed rows trusts them */
    const eventsBefore = state.events.length;
    const jobs = [2, 3].map((row) => {
      const cells = rowOf(temp, row);
      return { companyName: cells[2], role: cells[3], jobLink: cells[4], jobDescription: cells[5], sourceRowNumber: row };
    });
    const built = await api(tokens.admin, '/generation/batches', {
      method: 'POST',
      body: JSON.stringify({ label: 'Google Sheet (2 jobs)', profileIds: [profileId], jobs, sheet: { tabName: TEMP }, mode: 'order' }),
    });
    check('an order is placed from the two pushed rows', built.status === 202 && Boolean(built.body?.orderNumber), JSON.stringify(built.body));
    // The write-back of a cell the server would not use is batched a moment after submission: wait past it.
    await wait(3500);
    state = readState();
    const after = state.events.slice(eventsBefore);
    const readCells = after.some(
      (event) => event.kind === 'analysis-read' && event.id === adminSheetId && event.ranges.some((range) => range.startsWith(`'${TEMP}'!G2:L3`))
    );
    const wroteBack = after.filter((event) => event.kind === 'analysis-write-back');
    check(
      "the build read the rows' analysis cells, and wrote nothing back: every cell named its posting's stored analysis",
      readCells && wroteBack.length === 0 && JSON.stringify(rowOf(tabIn(state, adminSheetId), 2)) === JSON.stringify(rowOf(temp, 2)),
      JSON.stringify(after)
    );
    if (BACKEND_LOG) {
      const log = fs.readFileSync(BACKEND_LOG, 'utf8');
      check(
        'the server says both jobs were analysed in the sheet: none from the store, none to analyse',
        log.includes(`[queue] Sheet run on "${TEMP}": 2 job(s) analysed in the sheet, 0 from the store, 0 to analyse.`),
        log.split('\n').filter((line) => /Sheet run on/.test(line)).join('\n')
      );
    } else {
      console.log('NOTE  E2E_BACKEND_LOG is not set: the server\'s own "analysed in the sheet" line is not checked.');
    }

    /* ------------------------------------------------- nobody else's sheet */
    check(
      "the other administrator's Temp For AI is exactly as it was",
      JSON.stringify(tabIn(readState(), otherId)) === otherBefore,
      JSON.stringify(tabIn(readState(), otherId))
    );
    check(
      "every push wrote into the pushing administrator's sheet alone",
      readState().events.filter((event) => event.kind.startsWith('push-')).every((event) => event.id === adminSheetId)
    );

    /* ------------------------------------- a Temp For AI of the person's own */
    const clashPage = await browser.newPage();
    await clashPage.setViewport(WIDE);
    await signIn(clashPage, tokens.clash);
    await clashPage.goto(`${APP}/admin/job-lake`, { waitUntil: 'networkidle2' });
    await until(clashPage, () => /5 jobs in the lake/.test(document.body.innerText), 20_000);
    await pressButton(clashPage, 'Push to Google Sheet');
    await until(clashPage, () => Boolean(document.querySelector('[role="dialog"]')), 5000);
    await pressButton(clashPage, 'Push', true);
    const refused = await until(
      clashPage,
      () => /already has a tab named "Temp For AI" that is not laid out as a job tab/.test(document.body.innerText),
      15_000
    );
    const refusal = await clashPage.evaluate(
      () => Array.from(document.querySelectorAll('[role="alert"]')).map((node) => node.innerText.replace(/\s+/g, ' ').trim()).join(' | ')
    );
    const clashId = users.getUserById(clash.id)?.sheetId;
    check(
      "a Temp For AI of the person's own is refused in the Job Sheet page's words, and left as it is",
      refused &&
        refusal.includes(
          'Your job sheet already has a tab named "Temp For AI" that is not laid out as a job tab, so it was left exactly as it is. Rename or delete it in Google Sheets, then push again.'
        ) &&
        rowOf(tabIn(readState(), clashId), 2)[0] === 'An idea of my own',
      refusal
    );
    await clashPage.screenshot({ path: `${SHOTS}/push-5-clash.png`, fullPage: true });

    /* ------------------------------------------------------------------ 390 */
    await page.setViewport(PHONE);
    await wait(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('at 390px, the Lake tab adds no horizontal scrollbar', overflow <= 1, `overflow ${overflow}px`);
    await page.screenshot({ path: `${SHOTS}/push-6-phone.png`, fullPage: true });
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

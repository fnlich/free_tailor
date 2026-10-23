/*
 * Find Jobs (/jobs), in a real browser, against a real server whose Google
 * Sheets and seat are stubbed (stub-lake-push-sheets.js, stub-seat.js).
 *
 * test/findJobs.test.js proves the routes, test/frontendJobLake.test.js and
 * frontendFindJobs.test.js the page's decisions against the server's rules.
 * This proves the page and the server are joined up:
 *
 *   - the rail's Find Jobs opens the page in the same tab; Go to my sheet, top
 *     right, opens the account's own All tab in a new one
 *   - a user's form has no Requested by box, and the rows the API sends a
 *     user name no reporter and no reward
 *   - the list boxes take several values: two job types, keywords any of
 *     which matches, a company picked from the suggestions as it is typed -
 *     each search's count the server's own
 *   - the keyboard in a long list: ArrowDown through Job field scrolls the
 *     list to keep the active option in sight; a field chosen from what was
 *     typed stays the active option once the list is whole again; words typed
 *     into a list and never picked are gone after Search
 *   - rows are picked across pages: all of page 1 and two of page 2 are "27
 *     jobs selected", drawn tinted (the cells' computed colour, light and
 *     dark), and Search lets them go
 *   - at 1440px the table fits its box, for a user and an administrator, with
 *     the catalogues' widest words in the newest rows (Telecommunications,
 *     "Localization and internationalization"), long titles and salaries: no
 *     sideways scroll, and every row's Details in view; at 1280px an
 *     administrator's scrolls under every row's Details
 *   - Export into Sheet appends the picked jobs to the stub's All, each row's
 *     Analysis cell naming its job's stored analysis; the same jobs again are
 *     "in All already"
 *   - Order Immediately builds ONE profile in ONE build mode, on every tier:
 *     the dialog has a single profile select (#order-profile, "Una Finder (2
 *     resumes)") and the three mode cards (input[name=orderBuildMode]), none
 *     locked for a Default account, and no Several / All / group target; the
 *     cost line prices the order at the mode's price (Partial Tailor,
 *     PUT /api/admin/settings { partialPriceUsd }); Place order asks first
 *     (the spend alert, "Do not show again") and ends in the receipt, "You
 *     ordered successfully: Order number - ..." and "3 resumes for 3 jobs are
 *     being built: Partial Tailor for Una Finder.", linking to its order,
 *     which /api/orders holds with an item per resume, each naming the
 *     profile, the resume the matcher chose and why, and which takes the
 *     focus; the selection is let go
 *   - an order in Choose Suitable Resume is free (a free order asks nothing
 *     first), builds the matcher's pick as written - the stub seat is asked
 *     for its cover letter alone - and its order page says which resume and
 *     why: "Suitable resume: matched TypeScript"
 *   - an administrator's form has Requested by, the table its column and
 *     Details its line, and filtering by a reporter finds theirs alone; their
 *     order dialog offers both of their profiles, says, where the cost line
 *     stands, that none is chosen ("Please select a profile."), notes which
 *     resume each mode builds, prices the order once one is chosen, and
 *     Cancel gives the focus back to Order Immediately
 *   - a reporter is sent to Report Jobs
 *   - at 390px no horizontal scrollbar, and the chips wrap inside their box;
 *     a press on a checkbox half cut off at the box's left edge ticks it, and
 *     one on a Title link half under the held Details reaches the link, the
 *     box unmoved both times; Shift+Tab to that link scrolls it clear;
 *     a dark screenshot
 *
 * Servers are expected to be up already, the backend preloaded with both
 * stubs - with stub-seat.js alone (which loads no-google.js) the account's
 * sheet is "not set up" and the export has nowhere to go; only a backend
 * started with no preload at all reaches a real Google credential (README.md,
 * at the top) - and sharing a FRESH DB_DIR with this script (the lake must
 * hold only its jobs):
 *
 *   E2E_STUB_DELAY_MS=300 DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-lake-push-sheets.js dist/index.js
 *   DB_DIR=/tmp/e2e-db node test/e2e/find-jobs.js
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

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;
const STATE = process.env.E2E_SHEET_STATE || path.join(process.env.DB_DIR || os.tmpdir(), 'e2e-lake-push-sheets.json');

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const HOUR = 60 * 60 * 1000;

let failures = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(page, predicate, timeoutMs = 20_000, arg = null) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
}

/** A fetch against the API, signed in with `token`. */
const apiAs = (token) => async (route, init = {}) => {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function signIn(page, token, theme = 'light') {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (value, chosen) => {
      window.localStorage.setItem('adminToken', value);
      window.localStorage.setItem('tailor-theme', chosen);
    },
    token,
    theme
  );
  await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

/**
 * Whether the table fits its box: no sideways scroll, and every row's
 * Details inside the box (`inside` alone: every Details in view, scrolling or
 * not). With the reason it does not.
 */
async function tableFits(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.tl-table-box');
    const details = Array.from(box?.querySelectorAll('tbody tr td:last-child button') ?? []);
    if (!box || details.length === 0) return { ok: false, inside: false, detail: 'no table or no Details' };
    const edge = box.getBoundingClientRect();
    const inside = details.every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= edge.left - 0.5 && rect.right <= edge.right + 0.5;
    });
    const scrolls = box.scrollWidth > box.clientWidth + 1;
    return { ok: inside && !scrolls, inside, detail: JSON.stringify({ box: box.clientWidth, table: box.scrollWidth, inside, rows: details.length }) };
  });
}

/**
 * The held Details column covers what scrolls under it. Scrolls the box so
 * row 2's Title link is half under it, focuses that row's Details and presses
 * Shift+Tab: the link the focus lands on must be wholly clear of the column,
 * inside the box. With what was measured.
 */
async function titleClearOfDetails(page) {
  const before = await page.evaluate(() => {
    const box = document.querySelector('.tl-table-box');
    const row = box?.querySelector('tbody tr:nth-child(2)');
    const link = row?.querySelector('a');
    const held = row?.querySelector('[data-sticky-end]');
    if (!link || !held) return null;
    const rect = link.getBoundingClientRect();
    box.scrollLeft += rect.right - (held.getBoundingClientRect().left + rect.width / 2);
    const under = Math.round(link.getBoundingClientRect().right - held.getBoundingClientRect().left);
    held.querySelector('button').focus();
    return { under, scroll: Math.round(box.scrollLeft) };
  });
  if (!before) return { ok: false, detail: 'no Title link or Details in row 2' };
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  return page.evaluate((setUp) => {
    const box = document.querySelector('.tl-table-box');
    const link = document.activeElement;
    const held = link?.closest('tr')?.querySelector('[data-sticky-end]');
    if (link?.tagName !== 'A' || !held) return { ok: false, detail: `focused ${link?.outerHTML.slice(0, 100)}` };
    const rect = link.getBoundingClientRect();
    const edge = box.getBoundingClientRect();
    const clear = rect.left >= edge.left - 0.5 && rect.right <= held.getBoundingClientRect().left + 0.5;
    return {
      ok: setUp.under > 0 && clear,
      detail: JSON.stringify({ setUp, link: [Math.round(rect.left), Math.round(rect.right)], held: Math.round(held.getBoundingClientRect().left), scroll: Math.round(box.scrollLeft) }),
    };
  }, before);
}

/*
 * A press, where the keyboard is above: the box must stay where it is, so the
 * press lands on what was under the pointer. A mouse press or a tap focuses a
 * checkbox or a link on its way down, and a focus handler that scrolled the
 * box on every focus moved the control out from under the pointer before it
 * came up - the click landed on the cell, so the box went unticked and the
 * link unopened.
 */

/** Row 2's checkbox, 60% cut off at the box's left edge, pressed in the middle of what shows: ticked, the box unmoved. Unticked again after. */
async function pressCheckboxCutAtLeft(page) {
  const spot = await page.evaluate(() => {
    const box = document.querySelector('.tl-table-box');
    const input = box?.querySelector('tbody tr:nth-child(2) input[type="checkbox"]');
    if (!input || input.checked) return null;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // In the window's middle: a press lands only on what the window shows.
    window.scrollBy(0, input.getBoundingClientRect().top - window.innerHeight / 2);
    box.scrollLeft = 0;
    const edge = box.getBoundingClientRect().left + box.clientLeft;
    const whole = input.getBoundingClientRect();
    box.scrollLeft = Math.round(whole.left - edge + whole.width * 0.6);
    const rect = input.getBoundingClientRect();
    return { x: (edge + rect.right) / 2, y: rect.top + rect.height / 2, shows: Math.round(rect.right - edge), whole: Math.round(rect.width), scroll: box.scrollLeft };
  });
  if (!spot) return { ok: false, detail: 'no unticked checkbox in row 2' };
  await page.mouse.click(spot.x, spot.y);
  const ticked = await until(page, () => document.querySelector('.tl-table-box tbody tr:nth-child(2)')?.dataset.selected === 'true', 3000);
  const after = await page.evaluate(() => {
    const box = document.querySelector('.tl-table-box');
    const input = box.querySelector('tbody tr:nth-child(2) input[type="checkbox"]');
    const state = { checked: input.checked, scroll: box.scrollLeft };
    if (input.checked) input.click();
    return state;
  });
  await until(page, () => !document.querySelector('.tl-table-box tbody tr[data-selected="true"]'), 3000);
  return {
    ok: spot.shows > 0 && spot.shows < spot.whole / 2 && ticked && after.checked && after.scroll === spot.scroll,
    detail: JSON.stringify({ spot, ticked, after }),
  };
}

/**
 * Row 2's Title link scrolled half under the held Details, as Shift+Tab finds
 * it above, and each of its lines pressed in the middle of what shows of it
 * (a wrapped title's shorter line slid out from under the pointer first):
 * every press reaches the link - kept from opening the posting - and the box
 * stays put.
 */
async function pressTitleUnderDetails(page) {
  const setUp = await page.evaluate(() => {
    const box = document.querySelector('.tl-table-box');
    const row = box?.querySelector('tbody tr:nth-child(2)');
    const link = row?.querySelector('a');
    const held = row?.querySelector('[data-sticky-end]');
    if (!link || !held) return null;
    window.scrollBy(0, link.getBoundingClientRect().top - window.innerHeight / 3);
    box.scrollLeft = 0;
    const rect = link.getBoundingClientRect();
    box.scrollLeft = Math.round(rect.right - (held.getBoundingClientRect().left + rect.width / 2));
    const heldLeft = held.getBoundingClientRect().left;
    const edge = box.getBoundingClientRect().left + box.clientLeft;
    const spots = Array.from(link.getClientRects())
      .map((line) => {
        const from = Math.max(line.left, edge);
        const to = Math.min(line.right, heldLeft);
        return { x: (from + to) / 2, y: line.top + line.height / 2, shows: Math.round(to - from), under: Math.round(line.right - heldLeft) };
      })
      .filter((line) => line.shows >= 4);
    window.__e2ePresses = [];
    window.__e2eKeepLinkShut = (event) => {
      const into = link.contains(event.target);
      window.__e2ePresses.push(into);
      if (into) event.preventDefault();
    };
    document.addEventListener('click', window.__e2eKeepLinkShut, true);
    return { scroll: box.scrollLeft, spots };
  });
  if (!setUp) return { ok: false, detail: 'no Title link or Details in row 2' };
  const presses = [];
  for (const spot of setUp.spots) {
    await page.evaluate((scroll) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.querySelector('.tl-table-box').scrollLeft = scroll;
      window.__e2ePresses = [];
    }, setUp.scroll);
    await page.mouse.click(spot.x, spot.y);
    presses.push(
      await page.evaluate(() => ({ reached: window.__e2ePresses.length === 1 && window.__e2ePresses[0], scroll: document.querySelector('.tl-table-box').scrollLeft }))
    );
  }
  await page.evaluate(() => document.removeEventListener('click', window.__e2eKeepLinkShut, true));
  return {
    ok: setUp.spots.some((spot) => spot.under > 0) && presses.length === setUp.spots.length && presses.every((press) => press.reached && press.scroll === setUp.scroll),
    detail: JSON.stringify({ setUp, presses }),
  };
}

/**
 * Whether a picked row is drawn tinted: a picked row's cell's computed
 * background against an unpicked row's, on the page as it is - React writes
 * `data-selected` whatever the stylesheet says, so the attribute alone proves
 * nothing.
 */
async function pickedRowTinted(page) {
  return page.evaluate(() => {
    const cellOf = (row) => row?.querySelector('td:nth-child(2)');
    const picked = cellOf(document.querySelector('tbody tr[data-selected="true"]'));
    const plain = cellOf(document.querySelector('tbody tr[data-selected="false"]'));
    if (!picked || !plain) return { ok: false, detail: 'no picked and unpicked row on the page' };
    const pickedBg = getComputedStyle(picked).backgroundColor;
    const plainBg = getComputedStyle(plain).backgroundColor;
    return { ok: pickedBg !== plainBg, detail: JSON.stringify({ pickedBg, plainBg }) };
  });
}

/** Presses the enabled button (or link) whose text is `text` - inside the top dialog when `inDialog`. */
async function pressButton(page, text, inDialog = false) {
  return page.evaluate(
    (label, dialogOnly) => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const scope = dialogOnly ? dialogs[dialogs.length - 1] : document;
      const button = Array.from(scope?.querySelectorAll('button, a') ?? []).find(
        (candidate) => candidate.textContent.trim() === label && !candidate.disabled
      );
      button?.click();
      return Boolean(button);
    },
    text,
    inDialog
  );
}

/** Opens the list box `#id` and picks its option labelled `label`. Answers whether there was one. */
async function pick(page, id, label) {
  await page.click(`#${id}`);
  await page.waitForSelector(`#${id}-listbox [role="option"]`, { timeout: 8000 }).catch(() => null);
  return page.evaluate(
    (listId, wanted) => {
      const option = Array.from(document.querySelectorAll(`#${listId} [role="option"]`)).find(
        (node) => node.querySelector('[data-option-label]')?.textContent.trim() === wanted
      );
      option?.click();
      return Boolean(option);
    },
    `${id}-listbox`,
    label
  );
}

/** The page's toolbar line: the count, and how many are picked. */
const toolbar = (page) =>
  page.evaluate(() => document.querySelector('[data-find-jobs-toolbar] p')?.textContent.replace(/\s+/g, ' ').trim() ?? '');
const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const COMPANIES = [
  'Acme Robotics',
  'Globex',
  'Initech',
  'Umbrella Health',
  'Stark Labs',
  'Wayne Finance',
  'Hooli',
  'Pied Piper',
  'International Business Machines Corporation',
  'Soylent Foods',
];
const FIELDS = ['backend', 'frontend', 'devops'];
const JOB_TYPES = ['remote', 'hybrid', 'on_site'];
const WORDS = ['Kubernetes clusters and Helm', 'React and TypeScript screens', 'Data pipelines in Python', 'Payments APIs in Go'];
const SALARY = { min: 120000, max: 165000, currency: 'USD', period: 'year', raw: '' };
/**
 * The newest three - the top of page 1 - as a real lake has them: the
 * catalogues' widest words (Telecommunications, "Localization and
 * internationalization", Manufacturing, Logistics & Transportation), long
 * titles and stated salaries, so the 1440px claims are about rows that once
 * widened the table past its box. The rest are Technology.
 */
const WIDE_JOBS = {
  29: {
    field: 'localization-internationalization',
    industry: 'telecommunications',
    title: 'Senior Staff Software Engineer, Distributed Systems Infrastructure (Remote - US)',
    salary: SALARY,
  },
  28: {
    field: 'site-reliability-engineering',
    industry: 'logistics_transportation',
    title: 'Principal Site Reliability Engineer - Kubernetes/OpenShift Platform',
    salary: { min: null, max: null, currency: null, period: null, raw: '$150,000–$185,000/yr + equity' },
  },
  27: { industry: 'manufacturing', title: 'Full Stack Developer (React/Node.js) - TS/SCI Clearance Required', salary: SALARY },
};

/**
 * The lake: thirty jobs an hour apart, each from an analysis stored for its
 * own posting - ten companies across the backend, frontend and devops fields
 * but for the newest two, whose fields are their own (the newest three wide,
 * as above), half reported by the reporter and half by
 * the administrator, with job types and words of their own. Answers them
 * newest first.
 */
function seedLake({ reporterId, adminId }) {
  const now = Date.now();
  const jobs = [];
  for (let n = 0; n < 30; n += 1) {
    const company = COMPANIES[n % COMPANIES.length];
    const wide = WIDE_JOBS[n] ?? {};
    const field = wide.field ?? FIELDS[n % FIELDS.length];
    const jd = `${company} posting ${n}: ${WORDS[n % WORDS.length]}, for a ${field} team.`;
    const link = `https://jobs.example.com/${encodeURIComponent(company)}/${n}`;
    const { row } = analyses.insertJobAnalysisIfAbsent({
      contentHash: identity.contentHash(jd),
      linkKey: identity.linkKey(link),
      jobLink: link,
      analysis: {
        jobMeta: { title: wide.title ?? `${field} engineer ${n}`, seniority: 'senior', industry: '', department: '' },
        skills: { technical: ['TypeScript'], required: [], preferred: [], tools: [], soft: [], technologies: [] },
        technologies: [],
        protocols: [],
        methodologies: [],
        architecturePatterns: [],
        responsibilities: ['services'],
        domainKnowledge: [],
        softSkills: [],
        keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
        jobField: field,
        industry: wide.industry ?? 'technology',
        salary: wide.salary ?? null,
        filter: {
          jobType: JOB_TYPES[Math.floor(n / 3) % JOB_TYPES.length],
          onsiteInterview: 'not_specified',
          companyCategory: 'other',
          clearanceRequired: 'none',
          region: 'us',
          usState: '',
        },
        sourceJobDescription: jd,
      },
      modelId: '',
      promptHash: '',
      source: 'ai',
      createdBy: adminId,
      companyName: company,
    });
    const by = n % 2 ? reporterId : adminId;
    const merged = lakeService.mergeIntoLake(lakeService.lakeJobFromAnalysis(row, 'merge', { company, url: link }), by, {
      reward: false,
      now: now - (30 - n) * HOUR,
    });
    jobs.push({ n, company, field, analysisId: row.id, lakeId: merged.lakeId, status: merged.status, by });
  }
  return jobs.reverse();
}

async function main() {
  const stamp = Date.now().toString(36);
  const admin = users.createUser({ email: `e2e-find-admin-${stamp}@example.com`, name: 'Find Admin' });
  users.updateUser(admin.id, { role: 'admin' });
  const reporter = users.createUser({ email: `e2e-find-reporter-${stamp}@example.com`, name: 'Rita Finder', role: 'reporter' });
  const user = users.createUser({ email: `e2e-find-user-${stamp}@example.com`, name: 'Una Finder' });
  const tokens = { admin: users.createSession(admin.id), reporter: users.createSession(reporter.id), user: users.createSession(user.id) };
  const asAdmin = apiAs(tokens.admin);
  const asUser = apiAs(tokens.user);
  /** A resume of the person `name` with the headline `title`, its experience and curated `skills`. */
  const resumeBody = (name, title, jobTitle, skills) => ({
    name,
    title,
    contact: { email: 'una@example.com', phone: '1', location: 'Remote' },
    summary: 'Engineer who ships.',
    experience: [
      {
        title: jobTitle,
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Built product services.',
        achievements: ['Cut build time by 37%.'],
        skills: [],
      },
    ],
    skills,
    education: [],
  });
  /**
   * Makes the resume through the API, as a builder does: the server files it
   * under a profile of its person (made by the first resume of a name). A seed
   * that fails ends the script - nothing below means anything without it.
   */
  const seedResume = async (as, body) => {
    const made = await as('/resumes', { method: 'POST', body: JSON.stringify(body) });
    if (made.status !== 201 || !made.body?.profileId) {
      throw new Error(`setup: the resume of ${body.name} was not made: ${made.status} ${JSON.stringify(made.body)}`);
    }
    return made.body;
  };
  // ONE profile (a person) for the user - the Default subscription's limit, and
  // what an order builds - holding TWO resumes, so the matcher has a choice:
  // the engineer lists TypeScript (the lake's postings ask for it), the analyst
  // Go and Python. The second is filed under the first's profile by the name.
  const engineer = await seedResume(asUser, resumeBody('Una Finder', 'Senior Engineer', 'Engineer', ['TypeScript', 'Docker']));
  await seedResume(asUser, resumeBody('Una Finder', 'Data Analyst', 'Analyst', ['Go', 'Python']));
  // Two people for the administrator, whose order dialog chooses between them.
  const adaOne = await seedResume(asAdmin, resumeBody('Ada One', 'Senior Engineer', 'Engineer', ['TypeScript', 'Docker']));
  const adaTwo = await seedResume(asAdmin, resumeBody('Ada Two', 'Senior Engineer', 'Engineer', ['TypeScript', 'Docker']));
  const userProfiles = await asUser('/profiles');
  const adminProfiles = await asAdmin('/profiles');
  check(
    "setup: the user's two resumes are one profile, Una Finder; the administrator's are two, Ada One and Ada Two",
    userProfiles.status === 200 &&
      userProfiles.body?.length === 1 &&
      userProfiles.body[0].id === engineer.profileId &&
      userProfiles.body[0].resumeCount === 2 &&
      adminProfiles.status === 200 &&
      adminProfiles.body?.length === 2 &&
      adaOne.profileId !== adaTwo.profileId,
    JSON.stringify({ user: userProfiles.body, admin: adminProfiles.body })
  );

  const jobs = seedLake({ reporterId: reporter.id, adminId: admin.id });
  check('setup: the lake gets its thirty jobs', jobs.every((job) => job.status === 'added'), JSON.stringify(jobs.map((job) => job.status)));

  // A priced build mode, and credit to spend on it. What a resume costs is the
  // price of the mode it is built in (a model has no price): Partial Tailor is
  // set here, Choose Suitable Resume and Fully Tailor stay unpriced, which is free.
  const priced = await asAdmin('/admin/settings', { method: 'PUT', body: JSON.stringify({ partialPriceUsd: '0.023' }) });
  check('setup: Partial Tailor costs $0.023 a resume', priced.status === 200 && priced.body?.partialPriceMilli === 23, JSON.stringify(priced.body));
  const granted = await asAdmin(`/admin/accounts/${user.id}/credits`, { method: 'POST', body: JSON.stringify({ amountUsd: '5' }) });
  check('setup: the user has $5 of credit', granted.status === 200, JSON.stringify(granted.body));

  // What the server sends a user: no reporter, no reward, ever.
  const listed = await asUser('/jobs/lake?limit=50');
  const keys = new Set((listed.body?.rows ?? []).flatMap((row) => Object.keys(row)));
  check(
    "GET /api/jobs/lake as a user: thirty jobs, and no row names who reported it or what they were paid",
    listed.body?.total === 30 && !['requester', 'requestedBy', 'reward', 'seenCount', 'jobHash', 'source'].some((key) => keys.has(key)),
    JSON.stringify({ total: listed.body?.total, keys: [...keys] })
  );

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    page.on('dialog', (native) => void native.accept());
    await signIn(page, tokens.user);

    /* --------------------------------------------- the rail and the sheet */
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    const rail = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item')).find((node) => node.textContent.trim() === 'Find Jobs');
      return row ? { tag: row.tagName, href: row.getAttribute('href'), target: row.getAttribute('target') } : null;
    });
    check('the rail has Find Jobs, a same-tab link to /jobs', rail?.tag === 'A' && rail.href === '/jobs' && !rail.target, JSON.stringify(rail));
    await page.goto(`${APP}/jobs`, { waitUntil: 'networkidle2' });
    await until(page, () => /30 jobs in the lake/.test(document.body.innerText));
    const userFits = await tableFits(page);
    check("at 1440px a user's table fits its box: no sideways scroll, and Details in view", userFits.ok, userFits.detail);
    const sheetId = users.getUserById(user.id)?.sheetId;
    const sheetLink = await page.evaluate(() => {
      const link = document.querySelector('[data-sheet-link]');
      return link ? { tag: link.tagName, href: link.getAttribute('href'), target: link.getAttribute('target'), text: link.textContent.trim() } : null;
    });
    check(
      "Go to my sheet opens the account's own All tab, in a new tab",
      sheetLink?.tag === 'A' &&
        sheetLink.text === 'Go to my sheet' &&
        sheetLink.target === '_blank' &&
        sheetLink.href === `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=1`,
      JSON.stringify({ sheetLink, sheetId })
    );
    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('form[aria-label="Search the job lake"] label')).map((label) => label.textContent.trim())
    );
    check(
      "a user's form: the owner's order, and no Requested by",
      labels.join(' | ') === 'Updated from | Updated to | Job field | Job type | Clearance | Industry | Company | Salary from | Salary to | Full text',
      JSON.stringify(labels)
    );
    const headers = await page.evaluate(() => Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent.trim()));
    check('and no Requested by column', !headers.includes('Requested by') && headers.includes('Industry'), JSON.stringify(headers));
    await page.screenshot({ path: `${SHOTS}/find-jobs-1-page.png`, fullPage: true });

    /* --------------------------------------------- several values at once */
    const expected = async (query) => (await asUser(`/jobs/lake?${query}`)).body?.total;
    /** Presses Search, and waits for the toolbar to start with `line` (when given) - the list's answer, not the old one. */
    const searchTotal = async (line = '') => {
      check('Search is pressed', await pressButton(page, 'Search'));
      if (line) {
        await until(
          page,
          (wanted) => (document.querySelector('[data-find-jobs-toolbar] p')?.textContent.replace(/\s+/g, ' ').trim() ?? '').startsWith(wanted),
          10_000,
          line
        );
      } else {
        await wait(800);
      }
      return toolbar(page);
    };
    check('Remote is picked under Job type', await pick(page, 'lake-job-type', 'Remote'));
    check('and Hybrid', await pick(page, 'lake-job-type', 'Hybrid'));
    const bothTypes = await expected('jobType=remote&jobType=hybrid');
    const typesLine = await searchTotal(`${bothTypes} jobs match.`);
    check(`Remote or Hybrid: the server's ${bothTypes} jobs`, typesLine.startsWith(`${bothTypes} jobs match.`), typesLine);

    await pressButton(page, 'Clear');
    await wait(500);
    await page.type('#lake-q', 'kubernetes, react');
    const eitherWord = await expected('q=kubernetes&q=react');
    const wordsLine = await searchTotal(`${eitherWord} jobs match.`);
    check(`keywords "kubernetes, react": a job with either - the server's ${eitherWord}`, wordsLine.startsWith(`${eitherWord} jobs match.`), wordsLine);
    const keywordChips = await page.evaluate(() =>
      Array.from(document.getElementById('lake-q')?.closest('[data-multiselect]')?.querySelectorAll('.tl-multiselect-chip > span') ?? []).map((node) => node.textContent.trim())
    );
    check('Search turned the typed keywords into chips', keywordChips.join(',') === 'kubernetes,react', JSON.stringify(keywordChips));

    /* --------------------------------------------- the keyboard in a long list */
    await pressButton(page, 'Clear');
    await wait(500);
    // Job field is a hundred fields under their areas; focus stays in the
    // input, so the list itself must scroll to keep the active one in sight.
    await page.click('#lake-field');
    await page.waitForSelector('#lake-field-listbox [role="option"]', { timeout: 8000 }).catch(() => null);
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('ArrowDown');
    const inSight = await page.evaluate(() => {
      const input = document.getElementById('lake-field');
      const option = document.getElementById(input?.getAttribute('aria-activedescendant') ?? '');
      const list = document.getElementById('lake-field-listbox');
      if (!option || !list) return null;
      const shown = option.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      return { inView: shown.top >= box.top - 1 && shown.bottom <= box.bottom + 1, scrollTop: list.scrollTop };
    });
    check('ArrowDown through Job field scrolls its list, keeping the active option in sight', Boolean(inSight?.inView && inSight.scrollTop > 0), JSON.stringify(inSight));
    await page.keyboard.press('Escape');
    // Chosen from what was typed: the typing goes, the list is whole again, and the active option is still the one chosen.
    await page.type('#lake-field', 'devops');
    await page.keyboard.press('Enter');
    const chosenStays = await page.evaluate(() => {
      const input = document.getElementById('lake-field');
      const active = document.getElementById(input?.getAttribute('aria-activedescendant') ?? '');
      return {
        typed: input?.value,
        active: active?.querySelector('[data-option-label]')?.textContent.trim() ?? null,
        options: document.querySelectorAll('#lake-field-listbox [role="option"]').length,
      };
    });
    check(
      'DevOps chosen from what was typed stays the active option in the whole list, so the next Enter is never another field',
      chosenStays.typed === '' && chosenStays.active === 'DevOps' && chosenStays.options > 1,
      JSON.stringify(chosenStays)
    );
    // Words typed into a list and never picked filter nothing, and Search leaves no box showing them.
    await page.type('#lake-industry', 'heal');
    const devopsJobs = await expected('field=devops');
    const devopsLine = await searchTotal(`${devopsJobs} jobs match.`);
    const leftOver = await page.evaluate(() => document.getElementById('lake-industry')?.value ?? null);
    check(
      `Search applies DevOps alone - the server's ${devopsJobs} - and empties the Industry box of the words typed into it`,
      devopsLine.startsWith(`${devopsJobs} jobs match.`) && leftOver === '',
      JSON.stringify({ devopsLine, leftOver })
    );

    await pressButton(page, 'Clear');
    await wait(500);
    await page.type('#lake-company', 'acme');
    const suggested = await until(page, () =>
      Array.from(document.querySelectorAll('#lake-company-listbox [role="option"]')).some((node) => /Acme Robotics/.test(node.textContent) && /3 jobs/.test(node.textContent))
    );
    check('Company suggests the lake\'s "Acme Robotics" as it is typed, with its 3 jobs', suggested);
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('#lake-company-listbox [role="option"]')).find((node) => /Acme Robotics/.test(node.textContent))?.click()
    );
    const acmeLine = await searchTotal('3 jobs match.');
    check('the company picked: its 3 jobs', acmeLine.startsWith('3 jobs match.'), acmeLine);
    await page.screenshot({ path: `${SHOTS}/find-jobs-2-search.png`, fullPage: true });

    /* --------------------------------------------- picked across pages */
    await pressButton(page, 'Clear');
    await until(page, () => /30 jobs in the lake/.test(document.body.innerText));
    await page.click('thead input[type="checkbox"]');
    await until(page, () => /25 jobs selected/.test(document.body.innerText), 5000);
    await page.click('button[aria-label="Next page"]');
    await until(page, () => document.querySelectorAll('tbody tr').length === 5);
    const rowsOnTwo = await page.$$('tbody input[type="checkbox"]');
    await rowsOnTwo[0].click();
    await rowsOnTwo[1].click();
    const selectedLine = await toolbar(page);
    check('all of page 1 and two of page 2: "27 jobs selected"', /27 jobs selected/.test(selectedLine), selectedLine);
    const tinted = await pickedRowTinted(page);
    check(
      'the picked rows are tinted: two marked, and a picked cell drawn in another colour than an unpicked one',
      tinted.ok && (await page.evaluate(() => document.querySelectorAll('tbody tr[data-selected="true"]').length)) === 2,
      tinted.detail
    );
    await searchTotal('30 jobs in the lake.');
    check('Search lets the selection go', !/selected/.test(await toolbar(page)), await toolbar(page));
    // The toolbar reads "30 jobs in the lake." before this Search's answer as
    // after it, and the list keeps page 2's rows until page 1 arrives: wait
    // for page 1 itself before taking its boxes.
    const pageOne = await until(
      page,
      () => document.querySelectorAll('tbody tr').length === 25 && !document.querySelector('tbody tr[data-selected="true"]')
    );
    check('Search goes back to page 1', pageOne, String(await page.evaluate(() => document.querySelectorAll('tbody tr').length)));

    /* --------------------------------------------- Export into Sheet */
    const firstThree = jobs.slice(0, 3);
    const boxes = await page.$$('tbody input[type="checkbox"]');
    for (const box of boxes.slice(0, 3)) await box.click();
    check('Export into Sheet is pressed', await pressButton(page, 'Export into Sheet'));
    const exported = await until(page, () => /Exported 3 jobs into All, rows 2 to 4, each with its analysis/.test(document.body.innerText));
    check('the export says what it did', exported, await page.evaluate(() => document.querySelector('.tl-notice')?.innerText ?? ''));
    let all = readState().books[sheetId]?.tabs?.All;
    const cellId = (row) => {
      try {
        return JSON.parse(all?.rows?.[row]?.L).id;
      } catch {
        return null;
      }
    };
    check(
      "the stub's All holds the three, newest first, each Analysis cell naming its job's stored analysis",
      [2, 3, 4].map((row) => all?.rows?.[row]?.C).join(' | ') === firstThree.map((job) => job.company).join(' | ') &&
        [2, 3, 4].every((row, index) => cellId(row) === firstThree[index].analysisId),
      JSON.stringify(all?.rows)
    );
    check('the selection stays, to order', /3 jobs selected/.test(await toolbar(page)), await toolbar(page));
    check('Export into Sheet is pressed again', await pressButton(page, 'Export into Sheet'));
    const again = await until(page, () => /3 were in All already - the same link, or the same company and title/.test(document.body.innerText));
    all = readState().books[sheetId]?.tabs?.All;
    check('the same jobs again are in All already, and nothing is written twice', again && !all?.rows?.[5], JSON.stringify(all?.rows?.[5] ?? null));
    await page.screenshot({ path: `${SHOTS}/find-jobs-3-export.png`, fullPage: true });

    /* --------------------------------------------- Order Immediately */
    check('Order Immediately is pressed', await pressButton(page, 'Order Immediately'));
    // The dialog reads the profiles and the prices first: wait until its select has a profile chosen.
    await until(page, () => Boolean(document.getElementById('order-profile')?.value) && Boolean(document.querySelector('input[name="orderBuildMode"]')));
    const orderForm = await page.evaluate(() => ({
      profile: document.getElementById('order-profile')?.value ?? null,
      options: Array.from(document.querySelectorAll('#order-profile option')).map((option) => option.textContent.trim()),
      modes: Array.from(document.querySelectorAll('input[name="orderBuildMode"]')).map((input) => ({
        value: input.value,
        disabled: input.disabled,
        locked: Boolean(input.closest('[data-locked-choice]')),
      })),
      // The retired targets: Single / Several / All profiles / a list of resumes, their box and their locks.
      targetKinds: Boolean(
        document.querySelector('[role="dialog"]')?.querySelector('input[name="orderTargetMode"], #order-profiles, [data-locked-choice], [data-locked-feature]')
      ),
    }));
    check(
      'the order builds ONE profile in ONE mode: a select of the user\'s profile and three mode cards, none locked for a Default account, and no Several, All or list target',
      orderForm.profile === engineer.profileId &&
        orderForm.options.join(' | ') === 'Choose a profile... | Una Finder (2 resumes)' &&
        JSON.stringify(orderForm.modes) ===
          JSON.stringify([
            { value: 'suitable', disabled: false, locked: false },
            { value: 'partial', disabled: false, locked: false },
            { value: 'full', disabled: false, locked: false },
          ]) &&
        !orderForm.targetKinds,
      JSON.stringify(orderForm)
    );
    // Partial Tailor is what the settings start on; pick it anyway, so the claims below do not depend on the default.
    await page.evaluate(() => document.querySelector('input[name="orderBuildMode"][value="partial"]')?.click());
    const modeNote = await until(
      page,
      () =>
        /For each job, the resume whose keywords match the posting best\./.test(document.querySelector('[data-build-mode-note]')?.textContent ?? '') &&
        /\$0\.023 a resume/.test(document.querySelector('input[name="orderBuildMode"][value="partial"]')?.closest('label')?.textContent ?? ''),
      10_000
    );
    check(
      'Partial Tailor\'s card says what it costs a resume, $0.023, and the note says the resumes are chosen among by keywords',
      modeNote,
      await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.slice(0, 800) ?? '')
    );
    const costLine = await until(page, () => /This order: 3 resumes × \$0\.023 = \$0\.069/.test(document.body.innerText));
    check('the cost line prices the order: 3 resumes × $0.023', costLine, await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? ''));
    await page.screenshot({ path: `${SHOTS}/find-jobs-4-order.png`, fullPage: true });
    check('Place order is pressed', await pressButton(page, 'Place order', true));
    const asked = await until(page, () => Boolean(document.querySelector('[data-spend-kind="order"]')));
    const alert = await page.evaluate(() => document.querySelector('[data-spend-kind="order"]')?.closest('[role="dialog"]')?.innerText.replace(/\s+/g, ' ') ?? '');
    check(
      'it asks first: what it takes, the balance after, and "Do not show again"',
      asked && /This takes \$0\.069 from your credit/.test(alert) && /Do not show again/.test(alert),
      alert
    );
    check('Proceed is pressed', await pressButton(page, 'Proceed', true));
    const receipt = await until(page, () => /You ordered successfully: Order number - FT-/.test(document.body.innerText));
    const receiptLink = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.tl-notice a')).find((a) => /Order status/.test(a.textContent))?.getAttribute('href')
    );
    check('the receipt says so, and links to its order', receipt && /^\/orders\/[^/]+$/.test(receiptLink ?? ''), String(receiptLink));
    const receiptSentence = await page.evaluate(() => document.querySelector('[data-order-result]')?.innerText.replace(/\s+/g, ' ') ?? document.body.innerText.replace(/\s+/g, ' '));
    check(
      'the receipt says what is built: the resumes, the jobs, the mode and the profile - and no "across N profiles"',
      /3 resumes for 3 jobs are being built: Partial Tailor for Una Finder\./.test(receiptSentence) && !/across \d+ profiles?/.test(receiptSentence),
      receiptSentence.slice(0, 400)
    );
    const receiptFocused = await until(page, () => Boolean(document.activeElement?.closest('[data-order-result]')), 5000);
    check(
      'the receipt takes the focus, so a keyboard goes on from it rather than from the top',
      receiptFocused,
      await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? '')
    );
    check('the selection is let go', !/selected/.test(await toolbar(page)), await toolbar(page));
    const orders = await asUser('/orders');
    const order = (orders.body?.orders ?? []).find((entry) => receiptLink?.endsWith(entry.id));
    const detail = order ? await asUser(`/orders/${order.id}`) : null;
    const partialItems = detail?.body?.order?.items ?? detail?.body?.items ?? [];
    check(
      '/api/orders holds the order, a resume for each job picked',
      Boolean(order) && partialItems.length === 3,
      JSON.stringify({ orders: orders.body, detail: detail?.body && Object.keys(detail.body) })
    );
    // The matcher chose among the profile's two resumes for each job: the engineer lists TypeScript, which every posting asks for.
    check(
      'each item names the profile and the resume the matcher chose, and why: Una Finder, Senior Engineer, Partial Tailor, matched TypeScript',
      partialItems.length === 3 &&
        partialItems.every(
          (item) =>
            item.profileLabel === 'Una Finder' &&
            item.resumeLabel === 'Senior Engineer' &&
            item.match?.mode === 'partial' &&
            item.match?.reason === 'matched' &&
            item.match?.candidates === 2 &&
            (item.match?.matched ?? []).includes('TypeScript')
        ),
      JSON.stringify(partialItems.map((item) => [item.profileLabel, item.resumeLabel, item.match]))
    );
    await page.screenshot({ path: `${SHOTS}/find-jobs-5-receipt.png`, fullPage: true });

    /* ------------------------------------ the same page, Choose Suitable Resume */
    // One job, in the mode that tailors nothing: free (nothing to ask first),
    // the matcher's pick built as written, and the order page says which
    // resume and why. The stub seat is asked for the cover letter alone.
    await page.click('tbody input[type="checkbox"]');
    check('one job is picked for an order in Choose Suitable Resume', /\b1 jobs? selected/.test(await toolbar(page)), await toolbar(page));
    check('Order Immediately is pressed again', await pressButton(page, 'Order Immediately'));
    await until(page, () => Boolean(document.getElementById('order-profile')?.value) && Boolean(document.querySelector('input[name="orderBuildMode"]')));
    await page.evaluate(() => document.querySelector('input[name="orderBuildMode"][value="suitable"]')?.click());
    const freeLine = await until(page, () => /This order: 1 resume × \$0 = \$0/.test(document.body.innerText));
    const suitableCard = await page.evaluate(() => document.querySelector('input[name="orderBuildMode"][value="suitable"]')?.closest('label')?.textContent ?? '');
    check(
      'Choose Suitable Resume prices the order at nothing: 1 resume × $0, and its card says Free',
      freeLine && /Free\./.test(suitableCard),
      await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? '')
    );
    check('Place order is pressed for it', await pressButton(page, 'Place order', true));
    // A free order is not asked about; were it asked, Proceed answers.
    let suitableReceipt = false;
    for (let attempt = 0; attempt < 2 && !suitableReceipt; attempt += 1) {
      suitableReceipt = await until(
        page,
        () => /1 resume for 1 job is being built: Choose Suitable Resume for Una Finder\./.test(document.body.innerText.replace(/\s+/g, ' ')),
        attempt === 0 ? 6000 : 15_000
      );
      if (!suitableReceipt && (await page.evaluate(() => Boolean(document.querySelector('[data-spend-kind="order"]'))))) {
        await pressButton(page, 'Proceed', true);
      }
    }
    const suitableLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('.tl-notice a')).filter((a) => /Order status/.test(a.textContent));
      return links[links.length - 1]?.getAttribute('href') ?? null;
    });
    check(
      'a free order is placed without a spend alert, and its receipt says: 1 resume for 1 job is being built: Choose Suitable Resume for Una Finder',
      suitableReceipt && /^\/orders\/[^/]+$/.test(suitableLink ?? ''),
      String(suitableLink)
    );
    const suitableId = (suitableLink ?? '').split('/').pop();
    const suitableDetail = suitableId ? await asUser(`/orders/${suitableId}`) : null;
    const suitableItems = suitableDetail?.body?.order?.items ?? suitableDetail?.body?.items ?? [];
    check(
      'its item names Una Finder and the Senior Engineer resume, chosen in Choose Suitable Resume because it matched TypeScript',
      suitableItems.length === 1 &&
        suitableItems[0].profileLabel === 'Una Finder' &&
        suitableItems[0].resumeLabel === 'Senior Engineer' &&
        suitableItems[0].match?.mode === 'suitable' &&
        suitableItems[0].match?.reason === 'matched' &&
        (suitableItems[0].match?.matched ?? []).includes('TypeScript') &&
        Number(suitableItems[0].costMilli ?? 0) === 0,
      JSON.stringify(suitableItems.map((item) => [item.profileLabel, item.resumeLabel, item.match, item.costMilli]))
    );
    await page.goto(`${APP}/orders/${suitableId}`, { waitUntil: 'networkidle2' });
    const choiceLine = await until(page, () => /Suitable resume: matched TypeScript/.test(document.querySelector('[data-order-choice]')?.textContent ?? ''), 15_000);
    const itemCell = await page.evaluate(() => document.querySelector('tbody tr td:nth-child(2)')?.innerText.replace(/\s+/g, ' ') ?? '');
    check(
      "the order page prints the item as 'Una Finder · Senior Engineer' with 'Suitable resume: matched TypeScript' under it",
      choiceLine && /Una Finder · Senior Engineer/.test(itemCell),
      itemCell
    );
    await page.screenshot({ path: `${SHOTS}/find-jobs-5-suitable-order.png`, fullPage: true });

    /* --------------------------------------------- an administrator's view */
    const adminPage = await browser.newPage();
    await adminPage.setViewport(WIDE);
    await signIn(adminPage, tokens.admin);
    await adminPage.goto(`${APP}/jobs`, { waitUntil: 'networkidle2' });
    await until(adminPage, () => /30 jobs in the lake/.test(document.body.innerText));
    const adminView = await adminPage.evaluate(() => ({
      labels: Array.from(document.querySelectorAll('form[aria-label="Search the job lake"] label')).map((label) => label.textContent.trim()),
      headers: Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
    }));
    check(
      "an administrator's form has Requested by, and the table its column",
      adminView.labels.includes('Requested by') && adminView.headers.includes('Requested by'),
      JSON.stringify(adminView)
    );
    const adminFits = await tableFits(adminPage);
    check("at 1440px an administrator's table fits its box too, Requested by and all", adminFits.ok, adminFits.detail);
    await adminPage.setViewport({ width: 1280, height: 900 });
    await wait(300);
    const adminAt1280 = await tableFits(adminPage);
    check("at 1280px every row's Details is in view in an administrator's table, which scrolls under it", adminAt1280.inside, adminAt1280.detail);
    await adminPage.setViewport(WIDE);
    await wait(300);
    const reporterLabel = `${reporter.email} (Reporter)`;
    await until(adminPage, () => true, 1500);
    check('the reporter is picked under Requested by', await pick(adminPage, 'lake-requested-by', reporterLabel));
    check('Search is pressed', await pressButton(adminPage, 'Search'));
    const theirs = await until(adminPage, () => /15 jobs match/.test(document.body.innerText));
    const cells = await adminPage.evaluate(() => {
      const index = Array.from(document.querySelectorAll('thead th')).findIndex((th) => th.textContent.trim() === 'Requested by');
      return Array.from(document.querySelectorAll('tbody tr')).map((tr) => tr.children[index]?.textContent.trim());
    });
    check("filtering by the reporter finds their 15 jobs alone", theirs && cells.every((cell) => cell?.startsWith(reporter.email)), JSON.stringify(cells));
    check('Details is pressed', await pressButton(adminPage, 'Details'));
    const details = await until(adminPage, (email) => (document.querySelector('[role="dialog"]')?.innerText ?? '').includes(email), 10_000, reporter.email);
    check('Details says who reported it', details);
    await adminPage.screenshot({ path: `${SHOTS}/find-jobs-6-admin.png`, fullPage: true });
    await pressButton(adminPage, 'Close', true);
    await until(adminPage, () => !document.querySelector('[role="dialog"]'), 5000);

    // An administrator's order is one profile in one mode too: the select offers
    // both of their people, and "none chosen" is said in the footer, where the cost line stands.
    await adminPage.click('tbody input[type="checkbox"]');
    // Pressed for real, so it has the focus to be given back.
    const orderButton = await adminPage.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[data-find-jobs-toolbar] button')).find((button) => button.textContent.trim() === 'Order Immediately')
    );
    await orderButton.asElement()?.click();
    await until(adminPage, () => document.querySelectorAll('#order-profile option').length === 3 && Boolean(document.getElementById('order-profile')?.value));
    // Chosen as a person does: the select driven to its option, which fires the change React listens to.
    await adminPage.select('#order-profile', '');
    const noneChosen = await until(
      adminPage,
      () => (document.querySelector('[data-order-blocker]')?.textContent ?? '').trim() === 'Please select a profile.',
      5000
    );
    const placeOff = await adminPage.evaluate(() => document.querySelector('[data-order-place]')?.disabled === true);
    check(
      'no profile chosen says so where the cost line stands - not only in a tooltip - and Place order waits',
      noneChosen && placeOff,
      await adminPage.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? '')
    );
    await adminPage.select('#order-profile', adaOne.profileId);
    const adaOneChosen = await until(
      adminPage,
      () =>
        (document.querySelector('[data-order-blocker]')?.textContent ?? '').trim() === '' &&
        /Ada One has one resume, so every job builds it\./.test(document.querySelector('[data-build-mode-note]')?.textContent ?? ''),
      5000
    );
    check(
      'Ada One is chosen under Select Profile: the reason goes, and the note says its one resume builds every job',
      adaOneChosen,
      await adminPage.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? '')
    );
    await adminPage.evaluate(() => document.querySelector('input[name="orderBuildMode"][value="full"]')?.click());
    const fullNote = await until(
      adminPage,
      () => /Builds Senior Engineer, Ada One's default resume, for every job\./.test(document.querySelector('[data-build-mode-note]')?.textContent ?? ''),
      5000
    );
    check(
      "and Fully Tailor, open to an administrator as to everyone, says it builds Ada One's default resume",
      fullNote,
      await adminPage.evaluate(() => document.querySelector('[data-build-mode-note]')?.textContent ?? '')
    );
    const pricedForAda = await until(
      adminPage,
      () =>
        (document.querySelector('[data-order-blocker]')?.textContent ?? '').trim() === '' &&
        /Administrators are not charged/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''),
      10_000
    );
    check('the order is priced: an administrator is not charged', pricedForAda, await adminPage.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? ''));
    await adminPage.screenshot({ path: `${SHOTS}/find-jobs-6-admin-order.png`, fullPage: true });
    check('Cancel is pressed', await pressButton(adminPage, 'Cancel', true));
    const focusBack = await until(
      adminPage,
      () => !document.querySelector('[role="dialog"]') && document.activeElement?.textContent.trim() === 'Order Immediately',
      5000
    );
    check('Cancel gives the focus back to Order Immediately', focusBack, await adminPage.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? ''));

    /* --------------------------------------------- a reporter */
    const reporterPage = await browser.newPage();
    await reporterPage.setViewport(WIDE);
    await signIn(reporterPage, tokens.reporter);
    await reporterPage.goto(`${APP}/jobs`, { waitUntil: 'networkidle2' });
    const sent = await until(reporterPage, () => window.location.pathname === '/report');
    check('a reporter on /jobs is sent to Report Jobs', sent, await reporterPage.evaluate(() => window.location.pathname));

    /* --------------------------------------------- 390, and dark */
    // Every page here shares the browser's one context, so the administrator's
    // and the reporter's sign-ins replaced the user's: sign the user in again.
    // And bring the tab to the front: a background tab draws no frames, so a
    // click - which waits on an IntersectionObserver - would never land.
    await signIn(page, tokens.user);
    await page.bringToFront();
    await page.setViewport(PHONE);
    await page.goto(`${APP}/jobs`, { waitUntil: 'networkidle2' });
    await until(page, () => /30 jobs in the lake/.test(document.body.innerText));
    await page.type('#lake-q', 'kubernetes clusters, react screens, data pipelines, payments apis');
    await pressButton(page, 'Search');
    await wait(800);
    const phone = await page.evaluate(() => {
      const box = document.getElementById('lake-q')?.closest('.tl-multiselect-box');
      const tops = Array.from(box?.querySelectorAll('.tl-multiselect-chip') ?? []).map((chip) => Math.round(chip.getBoundingClientRect().top));
      return { tops: [...new Set(tops)].length, chips: tops.length, inside: box ? box.scrollWidth <= box.clientWidth + 1 : false };
    });
    check('at 390px the chips wrap inside their box', phone.chips === 4 && phone.tops > 1 && phone.inside, JSON.stringify(phone));
    check('at 390px Find Jobs adds no horizontal scrollbar', (await overflow(page)) <= 1, `overflow ${await overflow(page)}px`);
    // Presses first, then the keyboard: a press must not leave the box deaf to a Tab after it.
    const checkboxPressed = await pressCheckboxCutAtLeft(page);
    check(
      "at 390px a press on a row's checkbox, more than half cut off at the box's left edge, ticks it and leaves the box where it is",
      checkboxPressed.ok,
      checkboxPressed.detail
    );
    const titlePressed = await pressTitleUnderDetails(page);
    check(
      'at 390px a press on each line of a Title link half under the held Details reaches the link and leaves the box where it is',
      titlePressed.ok,
      titlePressed.detail
    );
    const titleClear = await titleClearOfDetails(page);
    check(
      "at 390px Shift+Tab from a row's Details to its Title link, half under the held Details, scrolls the link clear of it",
      titleClear.ok,
      titleClear.detail
    );
    await page.screenshot({ path: `${SHOTS}/find-jobs-7-phone.png`, fullPage: true });

    await page.setViewport(WIDE);
    await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'dark'));
    await page.goto(`${APP}/jobs`, { waitUntil: 'networkidle2' });
    await until(page, () => /30 jobs in the lake/.test(document.body.innerText));
    await pick(page, 'lake-job-type', 'Remote');
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    check('the page draws in dark mode', dark);
    await page.keyboard.press('Escape');
    await page.click('tbody tr:first-child input[type="checkbox"]');
    await until(page, () => Boolean(document.querySelector('tbody tr[data-selected="true"]')), 5000);
    const darkTint = await pickedRowTinted(page);
    check('in dark mode a picked row is tinted too', darkTint.ok, darkTint.detail);
    await page.screenshot({ path: `${SHOTS}/find-jobs-8-dark.png`, fullPage: true });
  } finally {
    await browser.close();
    // Reset to default: the price this script set is taken off the stored row, so .env's (else $0) is in effect again.
    if (priced.status === 200) {
      await asAdmin('/admin/settings', { method: 'PUT', body: JSON.stringify({ partialPriceUsd: null }) });
    }
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

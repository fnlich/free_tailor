/*
 * Profiles and the three build modes, in a real browser, against a real server
 * whose seat is stubbed (stub-seat.js) and whose Google Sheets are stubbed
 * (stub-sheets.js).
 *
 * A profile is a PERSON and holds that person's resumes; a run builds ONE
 * profile in one of three modes (Choose Suitable Resume, Partial Tailor, Fully
 * Tailor). test/frontendProfiles.test.js proves the pages' decisions against
 * the server's rules and test/profileTree.test.js, buildModes.test.js and
 * modePricing.test.js the server's. This proves the pages and the server are
 * joined up.
 *
 * PART A - the Profiles pages (a Premium account, so it has room for people):
 *
 *   - the dashboard's two tabs and the address: ?tab=resumes by click and by
 *     reload, a typo in it reads as Profiles, the arrow keys move between tabs
 *   - Grid and List kept in localStorage (freeTailor.profiles.view) across a
 *     reload; a search per tab with its count line, and Clear giving focus back
 *     to the box
 *   - + Create New names a profile and opens its page; New resume goes through
 *     the template chooser (?profile=<id>), the resume is created under that
 *     profile and becomes its default (the star); Set as default on a second one
 *   - the card menu (Edit, Set as default, Duplicate, Move to another profile...,
 *     Keywords, Download JSON, Disable, Delete): Duplicate keeps the template;
 *     Move hands focus back to the menu's button and, once done, to the next
 *     card; "A new profile" is open while there is room
 *   - Keywords in a dialog and in the editor's Customize tab
 *   - Delete a profile that holds TWO resumes: the owner's warning first, Escape
 *     leaves it alone, then both resumes are gone from All resumes
 *   - resumes of two profiles on ONE template: nothing is "used by" another, and
 *     Use this template is never off
 *   - an old /admin/profiles/<resume id> bookmark opens that resume's editor,
 *     /admin/profiles/new reaches the chooser, and /admin/profiles/no-such
 *     says so
 *   - a Default account: one profile, then the New profile tile and Create New
 *     are LOCKED (More profiles) while New resume, Duplicate and Delete stay open
 *   - Admin -> Models has no Price column or box; Admin -> Settings has the
 *     three #mode-price-* boxes, a red "Free" line while a price is $0, Save
 *     Prices, and the Builder Defaults' default profile and build mode
 *   - 390px (no sideways scroll, menus inside the window) and dark mode
 *
 * PART B - the builder's three modes (a Default account, one profile holding a
 * Go resume and a React resume, the prices set through the admin settings):
 *
 *   - the three mode cards are all open, each saying what a resume costs; the
 *     cost line ("1 resume × $0.01 = $0.01") follows the mode
 *   - Choose Suitable Resume previews the matched resume AS WRITTEN: no ATS
 *     pill, no Manual Edits; the Go posting gets the Go resume and the React
 *     posting the React one
 *   - Partial Tailor previews the matched resume tailored (ATS pill, Manual
 *     Edits, the stub's tailored sentence)
 *   - Fully Tailor previews the profile's DEFAULT resume (the React one), not
 *     the match
 *   - each mode built as an order, and its resume PDF read back: Choose Suitable
 *     Resume prints the chosen resume's own summary, the others the stub's
 *     tailored sentence; the order item names the resume and why; each is
 *     charged its mode's price; and, from the backend's log, Choose Suitable
 *     Resume made only cover-letter calls
 *
 * HOW THE MATCH IS DECIDED HERE. stub-seat.js answers EVERY posting's analysis
 * with the same canned one (TypeScript, Docker, "Senior Engineer"), so the
 * keyword half of the matcher cannot tell the Go posting from the React one.
 * The two resumes therefore share TypeScript and Docker (equal recall) and
 * differ in their TITLES ("Golang Backend Specialist" and "React Frontend
 * Specialist", neither of them an engineer, which the canned analysis would
 * match both of), and each posting is built with the Role box set to the title
 * it wants: the matcher's title half decides. With an analysis stub that
 * answered per posting the skills would decide too, in the same direction.
 *
 * Servers are expected to be up already, the backend preloaded with both stubs
 * and sharing a FRESH DB_DIR with this script (the script makes its own
 * accounts and profiles, and leaves them), the three prices left unset (the
 * script reads what is in effect either way) and E2E_BACKEND_LOG naming the
 * backend's log file for the call counts (without it those claims print SKIP):
 *
 *   E2E_STUB_DELAY_MS=300 E2E_OUTPUT_DIR=/tmp/e2e-out DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js > /tmp/e2e-backend.log
 *   DB_DIR=/tmp/e2e-db E2E_BACKEND_LOG=/tmp/e2e-backend.log node test/e2e/profiles.js
 *
 * or through the runner, from backend/:
 *
 *   node <plans>/v42-materials/run-e2e.js profiles test/e2e/profiles.js stub-seat.js,stub-sheets.js \
 *     E2E_STUB_DELAY_MS=300 --backend-log
 *
 * Settings, all optional:
 *   E2E_APP          the frontend (default http://127.0.0.1:3000)
 *   E2E_API          the backend's /api (default http://127.0.0.1:3001/api)
 *   E2E_DIST         the compiled backend to seed the accounts with (default ../../dist)
 *   E2E_SHOTS        a directory for screenshots (default: beside this script)
 *   E2E_BACKEND_LOG  the backend's log, for the per-call-site counts
 *
 * Written without being able to run it: every wait is for a condition, and a
 * section that throws is reported as one failed claim without stopping the
 * rest. Each claim prints PASS or FAIL (the runner counts the lines), a claim
 * that cannot be made prints SKIP, and the last line counts them.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const SHOTS = process.env.E2E_SHOTS || __dirname;
const BACKEND_LOG = process.env.E2E_BACKEND_LOG || '';

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** What the postings, the resumes and the stub's answers are called below. */
const GO_ROLE = 'Golang Backend Specialist';
const REACT_ROLE = 'React Frontend Specialist';
const GO_POSTING =
  'We are hiring a Golang backend specialist to build Go services on Kubernetes with gRPC and PostgreSQL, owning the build pipeline, for a small platform team.';
const REACT_POSTING =
  'We are hiring a React frontend specialist to build accessible interfaces in React and TypeScript with Redux, working closely with our designers on the product.';
const GO_SUMMARY = 'Builds Go microservices with Kubernetes and gRPC for a payments platform.';
const GO_SUMMARY_PHRASE = 'Go microservices with Kubernetes and gRPC';
const REACT_SUMMARY = 'Builds accessible React interfaces in TypeScript with Redux.';
const REACT_SUMMARY_PHRASE = 'accessible React interfaces';
/** The sentence stub-seat.js's tailoring answers with: what a TAILORED resume prints as its summary. */
const TAILORED_PHRASE = 'reliable TypeScript services';
const OWNER_DELETE_WARNING = "You can't undo this. Every resume in this profile will be deleted with it and can't be recovered.";

let failures = 0;
let claims = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  claims += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
let skips = 0;
function skip(name, why) {
  skips += 1;
  console.log(`SKIP  ${name} (${why})`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Polls `predicate` in the page until it holds, or `timeoutMs` passes. */
async function until(page, predicate, timeoutMs = 20_000, arg = null) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 150 }, arg);
    return true;
  } catch {
    return false;
  }
}

/** Polls an async read until `predicate(value)` holds; the last value either way. */
async function untilValue(read, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return { ok: true, last };
    } catch (error) {
      last = String(error?.message || error);
    }
    await wait(300);
  }
  return { ok: false, last };
}

/** A fetch against the API, signed in with `token`: { status, body }. */
const apiAs = (token) => async (route, init = {}) => {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function fetchBuffer(token, route) {
  const response = await fetch(`${API}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${route} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The text of a PDF, whitespace folded. */
async function pdfText(buffer) {
  const parse = require('pdf-parse');
  const out = await parse(buffer);
  return flat(out.text);
}

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
  await page.setCookie({ name: 'ft_session', value: token, domain: new URL(APP).hostname, path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** Uncaught errors the pages threw, and every browser dialog (confirm, alert) with its words. */
const pageErrors = [];
const dialogs = [];

async function newPage(browser, token, viewport, theme = 'light') {
  // A context of its own: the session cookie and localStorage's adminToken are shared by every page of one
  // context, so a later page signed in as another account would sign this one in as that account too.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 240)));
  // A confirm (Delete resume) and the leave prompts are accepted, as a person would; what was asked is kept.
  page.on('dialog', (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    dialog.accept().catch(() => {});
  });
  await signIn(page, token, theme);
  return page;
}

async function shoot(page, name, fullPage = false) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `profiles-${name}.png`), fullPage });
  } catch {
    // A screenshot is for the person reading the run, never a claim.
  }
}

/** A section that throws is ONE failed claim, and the rest still run. */
async function section(name, run) {
  try {
    await run();
  } catch (error) {
    check(`${name}: ran to the end`, false, String(error?.stack || error).split('\n').slice(0, 4).join(' | '));
  }
}

/* ------------------------------------------------------------- the page */

const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Sets an input's or a textarea's value the way typing does, so React sees it. */
function setValue(page, selector, value) {
  return page.evaluate(
    (css, text) => {
      const element = document.querySelector(css);
      if (!element) throw new Error(`${css} is not on the page`);
      const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value
  );
}

/** A DOM click on the first match; whether there was one. */
function clickSelector(page, selector) {
  return page.evaluate((css) => {
    const element = document.querySelector(css);
    element?.click();
    return Boolean(element);
  }, selector);
}

/**
 * Presses the enabled button (or link) whose text is exactly `label`: in the
 * whole page, in the top dialog (`'dialog'`), or inside the element `scope` names.
 */
function pressButton(page, label, scope = '', starts = false) {
  return page.evaluate(
    (wanted, within, prefix) => {
      let root = document;
      if (within === 'dialog') {
        const open = document.querySelectorAll('[role="dialog"]');
        root = open[open.length - 1];
      } else if (within) {
        root = document.querySelector(within);
      }
      if (!root) return false;
      const button = Array.from(root.querySelectorAll('button, a')).find((candidate) => {
        const text = candidate.textContent.trim();
        return (prefix ? text.startsWith(wanted) : text === wanted) && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true';
      });
      button?.click();
      return Boolean(button);
    },
    label,
    scope,
    starts
  );
}

/** The top dialog's text, or null. */
const dialogText = (page) =>
  page.evaluate(() => {
    const open = document.querySelectorAll('[role="dialog"]');
    return open.length > 0 ? open[open.length - 1].innerText : null;
  });

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const lastSegment = (url) => new URL(url).pathname.split('/').filter(Boolean).pop();

/** Opens a menu: the ⋮ (or Import) button `trigger` names. Answers whether the menu came up. */
async function openMenu(page, trigger) {
  const pressed = await clickSelector(page, trigger);
  if (!pressed) return false;
  return until(page, () => Boolean(document.querySelector('[role="menu"]')), 5000);
}

/** The open menu's entries, in order. */
const menuEntries = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((item) => ({
      label: (item.querySelector('span span') ?? item).textContent.trim(),
      disabled: item.disabled,
    }))
  );

function pressMenuItem(page, label) {
  return page.evaluate((wanted) => {
    const item = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find(
      (candidate) => (candidate.querySelector('span span') ?? candidate).textContent.trim() === wanted && !candidate.disabled
    );
    item?.click();
    return Boolean(item);
  }, label);
}

/** Whether focus is (within a moment) on a ⋮ (menu) button inside the element `scope` names. */
const focusOnMenuButtonIn = (page, scope) =>
  until(
    page,
    (css) => {
      const active = document.activeElement;
      return Boolean(active && active.getAttribute('aria-haspopup') === 'menu' && active.closest(css));
    },
    4000,
    scope
  );

/* ---------------------------------------------------------- the dashboard */

async function openDashboard(page, tab = 'profiles') {
  await page.goto(`${APP}/admin/profiles${tab === 'resumes' ? '?tab=resumes' : ''}`, { waitUntil: 'networkidle2' });
  return until(
    page,
    () => Boolean(document.querySelector('[role="tablist"][aria-label="Profiles and resumes"]')) && !/Loading profiles/.test(document.body.innerText),
    30_000
  );
}

/** Create New is off while the page waits for the account (it cannot yet say what the subscription allows). */
const createNewReady = (page) =>
  until(
    page,
    () => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent.trim() === 'Create New');
      return Boolean(button) && !button.disabled;
    },
    15_000
  );

/** What the dashboard (or a profile's page) shows now. */
const snapshot = (page) =>
  page.evaluate(() => {
    const ids = (attribute) => Array.from(document.querySelectorAll(`[${attribute}]`)).map((node) => node.getAttribute(attribute));
    const panel = document.querySelector('[role="tabpanel"]');
    return {
      path: location.pathname,
      search: location.search,
      h1: document.querySelector('h1')?.textContent.trim() ?? '',
      tabs: Array.from(document.querySelectorAll('[role="tablist"][aria-label="Profiles and resumes"] [role="tab"]')).map((tab) => ({
        text: tab.textContent.trim(),
        selected: tab.getAttribute('aria-selected') === 'true',
      })),
      profileCards: ids('data-profile-card'),
      profileRows: ids('data-profile-row'),
      resumeCards: ids('data-resume-card'),
      resumeRows: ids('data-resume-row'),
      matchStatus: panel?.querySelector('p[role="status"]')?.textContent.trim() ?? '',
      text: document.body.innerText,
      storedView: (() => {
        try {
          return window.localStorage.getItem('freeTailor.profiles.view');
        } catch {
          return null;
        }
      })(),
    };
  });

function pressTab(page, startsWith) {
  return page.evaluate((wanted) => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((candidate) => candidate.textContent.trim().startsWith(wanted));
    tab?.click();
    return Boolean(tab);
  }, startsWith);
}

function pressViewButton(page, name) {
  return page.evaluate((wanted) => {
    const button = document.querySelector(`[role="group"][aria-label="View"] button[aria-label="${wanted}"]`);
    button?.click();
    return Boolean(button);
  }, name);
}

const viewPressed = (page) =>
  page.evaluate(() => ({
    grid: document.querySelector('[role="group"][aria-label="View"] button[aria-label="Grid"]')?.getAttribute('aria-pressed') ?? null,
    list: document.querySelector('[role="group"][aria-label="View"] button[aria-label="List"]')?.getAttribute('aria-pressed') ?? null,
  }));

/** Types into a tab's search box the way a person does. */
async function typeSearch(page, id, text) {
  await page.click(`#${id}`, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
}

/** Whether the edit/profile pages say a notice (a green line) containing `pattern`. */
const bodyMatches = (page, source) => until(page, (src) => new RegExp(src).test(document.body.innerText), 15_000, source);

/* ----------------------------------------------------------- the backend log */

const logSize = () => (BACKEND_LOG && fs.existsSync(BACKEND_LOG) ? fs.statSync(BACKEND_LOG).size : 0);

/** The stub seat's call sites logged since `offset` (the log is written a moment late, hence the settle). */
async function callsSince(offset, settleMs = 1500) {
  await wait(settleMs);
  const text = fs.readFileSync(BACKEND_LOG).subarray(offset).toString('utf8');
  return Array.from(text.matchAll(/\[e2e stub\] call \d+: (\S+)/g)).map((match) => match[1]);
}

/* -------------------------------------------------------------------- data */

/** A resume body for POST /api/resumes. */
function resumeBody(over) {
  return {
    name: 'Resume Holder',
    title: 'Engineer',
    totalYearsExperience: 6,
    contact: { email: 'holder@example.com', phone: '(512) 555-0142', location: 'Austin, TX' },
    summary: 'Builds software.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme Works',
        startDate: '01/2019',
        endDate: 'Present',
        location: 'Austin, TX',
        achievements: ['Cut build time by 37% by caching container layers.', 'Ran the on-call rotation for four teams.'],
      },
    ],
    education: [{ degree: 'B.S. Computer Science', institution: 'State University', startDate: '2013', endDate: '2017' }],
    skills: ['Docker'],
    softSkills: ['Mentoring'],
    ...over,
  };
}

async function main() {
  const stamp = Date.now().toString(36);
  const admin = users.createUser({ email: `e2e-profiles-admin-${stamp}@example.com`, name: 'Profiles Admin' });
  users.updateUser(admin.id, { role: 'admin' });
  const premium = users.createUser({ email: `e2e-profiles-premium-${stamp}@example.com`, name: 'Pia Premium' });
  users.updateUser(premium.id, { subscription: 'premium' });
  const basic = users.createUser({ email: `e2e-profiles-default-${stamp}@example.com`, name: 'Dee Default' });
  const tokens = {
    admin: users.createSession(admin.id),
    premium: users.createSession(premium.id),
    basic: users.createSession(basic.id),
  };
  const asAdmin = apiAs(tokens.admin);
  const asPremium = apiAs(tokens.premium);
  const asBasic = apiAs(tokens.basic);

  const state = {
    c0: '',
    alpha: '',
    beta: '',
    gamma: '',
    r1: '',
    r2: '',
    r3: '',
    b1: '',
    pat: '',
    goResume: '',
    reactResume: '',
  };

  const listed = await asPremium('/templates');
  const templateList = Array.isArray(listed.body) ? listed.body : listed.body?.templates || [];
  state.c0 = templateList[0]?.id || '';
  check('setup: the installation offers templates', listed.status === 200 && state.c0 !== '', JSON.stringify(listed.body).slice(0, 200));

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    /* ============================================================ PART A */
    const pp = await newPage(browser, tokens.premium, WIDE);

    /* -------------------------------- a profile made, a resume made in it */
    await section('premium: the empty dashboard, a profile, a resume through the chooser', async () => {
      const ready = await openDashboard(pp, 'profiles');
      const empty = await snapshot(pp);
      check(
        'the dashboard opens on "My Profiles", the Profiles tab selected, nothing yet: Profiles (0), All resumes (0)',
        ready &&
          empty.h1 === 'My Profiles' &&
          empty.tabs.length === 2 &&
          empty.tabs[0].text === 'Profiles (0)' &&
          empty.tabs[0].selected &&
          empty.tabs[1].text === 'All resumes (0)' &&
          !empty.tabs[1].selected,
        JSON.stringify({ ready, h1: empty.h1, tabs: empty.tabs })
      );
      const tile = await pp.evaluate(() => {
        const node = document.querySelector('[data-new-tile="profile"]');
        return node ? { locked: node.hasAttribute('data-locked-feature'), disabled: node.disabled } : null;
      });
      check(
        'with room to spare, the New profile tile is open and the empty state says "No profiles yet"',
        Boolean(tile) && !tile.locked && !tile.disabled && /No profiles yet/.test(empty.text),
        JSON.stringify(tile)
      );

      await createNewReady(pp);
      const pressedCreate = await pressButton(pp, 'Create New');
      const named = await until(pp, () => /New profile/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 8000);
      check('Create New opens the "New profile" dialog', pressedCreate && named, String(await dialogText(pp)));
      await setValue(pp, '#profile-name-form input', 'Alpha Person');
      await pressButton(pp, 'Create profile', 'dialog');
      const landed = await until(pp, () => /^\/admin\/profiles\/[^/]+$/.test(location.pathname), 20_000);
      state.alpha = landed ? lastSegment(pp.url()) : '';
      await until(pp, () => document.querySelector('h1')?.textContent.trim() === 'Alpha Person', 15_000);
      const alphaPage = await snapshot(pp);
      check(
        "making a profile opens that profile's own page: its name, no resumes yet",
        landed && alphaPage.h1 === 'Alpha Person' && /0 resumes/.test(alphaPage.text) && /No resumes in this profile yet/.test(alphaPage.text),
        JSON.stringify({ path: alphaPage.path, h1: alphaPage.h1 })
      );
      const made = await asPremium('/profiles');
      check(
        'the server holds exactly that one profile, with no resume',
        made.status === 200 && made.body?.length === 1 && made.body[0].name === 'Alpha Person' && made.body[0].resumeCount === 0 && made.body[0].id === state.alpha,
        JSON.stringify(made.body)
      );
      await shoot(pp, 'a-1-profile-page-empty');

      // New resume, from the profile's own page, through the chooser.
      const pressedNew = await pressButton(pp, 'New resume');
      const chooser = await until(pp, () => location.pathname === '/admin/resumes/new', 20_000);
      await pp.waitForSelector('[data-template-card]', { timeout: 30_000 });
      const chooserFacts = await pp.evaluate(
        (profileId) => ({
          search: location.search,
          h1: document.querySelector('h1')?.textContent.trim() ?? '',
          // The chooser's own Back link, found by its address (the rail has a Profiles link too).
          back: Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === `/admin/profiles/${profileId}`)?.textContent.trim() ?? '',
          cards: document.querySelectorAll('[data-template-card]').length,
          text: document.body.innerText,
        }),
        state.alpha
      );
      check(
        "New resume opens the chooser for that profile: ?profile=<id>, \"Start building a resume for Alpha Person\", Back reads the profile's name",
        pressedNew &&
          chooser &&
          new URLSearchParams(chooserFacts.search).get('profile') === state.alpha &&
          chooserFacts.h1 === 'Start building a resume for Alpha Person' &&
          chooserFacts.back === 'Alpha Person',
        JSON.stringify(chooserFacts).slice(0, 300)
      );

      const firstCard = await pp.evaluate(() => {
        const card = document.querySelector('[data-template-card]');
        card.click();
        return card.getAttribute('data-template-card');
      });
      if (firstCard) state.c0 = firstCard;
      await pp.waitForSelector('[role="dialog"] button', { timeout: 10_000 });
      const detailsText = flat(await dialogText(pp));
      const useState = await pp.evaluate(() => {
        const use = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Use this template');
        return use ? { disabled: use.disabled } : null;
      });
      check(
        'the template details offer Use this template, never off, and say nothing is used by another resume',
        Boolean(useState) && !useState.disabled && !/used by/i.test(detailsText) && !/used by/i.test(chooserFacts.text),
        JSON.stringify({ useState, details: detailsText.slice(0, 200) })
      );
      await pressButton(pp, 'Use this template', 'dialog');
      const started = await until(
        pp,
        (ids) => {
          const params = new URLSearchParams(location.search);
          return location.pathname === '/admin/resumes/new' && params.get('template') === ids.template && params.get('profile') === ids.profile;
        },
        15_000,
        { template: state.c0, profile: state.alpha }
      );
      check('Use this template opens the editor on that template, still for the profile (?template=<id>&profile=<id>)', started, pp.url());

      const offered = await until(pp, () => /Import your existing resume/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 15_000);
      check('the editor first offers to import an existing resume', offered, String(await dialogText(pp)));
      await pressButton(pp, 'Start from blank', 'dialog');
      await until(pp, () => !document.querySelector('[role="dialog"]'), 8000);
      const bar = await until(pp, () => Boolean(document.querySelector('button[title="Back to Alpha Person"]')), 15_000);
      check("the editor's Back button reads the profile's name: Alpha Person", bar);

      await clickSelector(pp, 'button[aria-label="Edit name and contact details"]');
      await pp.waitForSelector('#resume-name', { timeout: 10_000 });
      await setValue(pp, '#resume-name', 'Alpha Person');
      await setValue(pp, '#resume-title', 'Alpha Backend Engineer');
      await wait(300);
      const pressedCreateResume = await pp.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button[type="submit"]')).find((candidate) => /^Create/.test(candidate.textContent.trim()));
        button?.click();
        return Boolean(button);
      });
      const back = await until(pp, (id) => location.pathname === `/admin/profiles/${id}`, 30_000, state.alpha);
      check('Create Resume files it under Alpha Person and goes back to the profile\'s page', pressedCreateResume && back, pp.url());

      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 1, 20_000);
      const afterCreate = await snapshot(pp);
      const starred = await pp.evaluate(() => Boolean(document.querySelector('[data-resume-card] [data-default-resume]')));
      check(
        'the profile now shows one resume card, and it carries the Default star',
        afterCreate.resumeCards.length === 1 && starred && /Alpha Backend Engineer/.test(afterCreate.text),
        JSON.stringify({ cards: afterCreate.resumeCards, starred })
      );
      const profileNow = await asPremium(`/profiles/${state.alpha}`);
      state.r1 = afterCreate.resumeCards[0] || '';
      const r1 = await asPremium(`/resumes/${encodeURIComponent(state.r1)}`);
      check(
        "the server agrees: the first resume became the profile's default, on the template that was chosen",
        profileNow.body?.defaultResumeId === state.r1 &&
          profileNow.body?.chosenDefaultResumeId === state.r1 &&
          profileNow.body?.resumeCount === 1 &&
          r1.body?.preferredTemplate === state.c0 &&
          r1.body?.profileId === state.alpha,
        JSON.stringify({ profile: profileNow.body, template: r1.body?.preferredTemplate, expected: state.c0 })
      );
      await shoot(pp, 'a-2-profile-page-one-resume');
    });

    /* -------------------------------------- seeded: a second resume, Beta */
    await section('premium: seed a second resume and a second profile on the same template', async () => {
      const second = await asPremium(`/resumes?profileId=${encodeURIComponent(state.alpha)}`, {
        method: 'POST',
        body: JSON.stringify(
          resumeBody({
            name: 'Alpha Person',
            title: 'Alpha Platform Engineer',
            skills: ['Docker', 'Python', 'Kubernetes'],
            preferredTemplate: state.c0,
          })
        ),
      });
      state.r2 = second.body?.id || '';
      const betaMade = await asPremium('/profiles', { method: 'POST', body: JSON.stringify({ name: 'Beta Person' }) });
      state.beta = betaMade.body?.id || '';
      const betaResume = await asPremium(`/resumes?profileId=${encodeURIComponent(state.beta)}`, {
        method: 'POST',
        body: JSON.stringify(
          resumeBody({ name: 'Beta Person', title: 'Beta Data Engineer', skills: ['Spark', 'Python'], preferredTemplate: state.c0 })
        ),
      });
      state.b1 = betaResume.body?.id || '';
      check(
        "setup: Alpha's second resume, the profile Beta Person and its resume are made, every resume on the template the chooser gave Alpha",
        second.status === 201 && betaMade.status === 201 && betaResume.status === 201 && Boolean(state.r2 && state.beta && state.b1),
        JSON.stringify([second.status, betaMade.status, betaResume.status])
      );
    });

    /* ------------------------------ two profiles' resumes on one template */
    await section('premium: two profiles on one template', async () => {
      const all = await asPremium('/resumes?includeDisabled=true');
      const onTemplate = (all.body ?? []).filter((resume) => resume.preferredTemplate === state.c0);
      check(
        'resumes of two different profiles name the same template',
        new Set(onTemplate.map((resume) => resume.profileId)).size === 2 && onTemplate.length === 3,
        JSON.stringify((all.body ?? []).map((resume) => [resume.id, resume.profileId, resume.preferredTemplate]))
      );

      await pp.goto(`${APP}/admin/resumes/new?profile=${encodeURIComponent(state.beta)}`, { waitUntil: 'networkidle2' });
      await pp.waitForSelector('[data-template-card]', { timeout: 30_000 });
      await pp.evaluate((id) => document.querySelector(`[data-template-card="${CSS.escape(id)}"]`)?.click(), state.c0);
      await pp.waitForSelector('[role="dialog"] button', { timeout: 10_000 });
      const betaChooser = await pp.evaluate(() => {
        const use = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Use this template');
        return { use: use ? { disabled: use.disabled } : null, page: document.body.innerText };
      });
      check(
        "the template Alpha's resumes use is open to Beta: Use this template is on, and nothing says \"used by\"",
        Boolean(betaChooser.use) && !betaChooser.use.disabled && !/used by/i.test(betaChooser.page),
        JSON.stringify(betaChooser.use)
      );
      await pressButton(pp, 'Use this template', 'dialog');
      await until(pp, (id) => new URLSearchParams(location.search).get('template') === id, 15_000, state.c0);
      await pp.waitForSelector('#resume-template', { timeout: 20_000 });
      const picker = await pp.evaluate(() => {
        const select = document.getElementById('resume-template');
        return {
          value: select.value,
          options: Array.from(select.options).map((option) => ({ text: option.textContent.trim(), disabled: option.disabled })),
        };
      });
      check(
        "the editor's template picker lists every template plainly: none disabled, none \"(used by ...)\"",
        picker.value === state.c0 && picker.options.length > 0 && picker.options.every((option) => !option.disabled && !/used by/i.test(option.text)),
        JSON.stringify(picker).slice(0, 300)
      );

      await pp.goto(`${APP}/admin/resumes/${encodeURIComponent(state.b1)}`, { waitUntil: 'networkidle2' });
      await pp.waitForSelector('#resume-template option[value]:not([value=""])', { timeout: 30_000 });
      // The bar says "My Profiles" until the profile's own read comes back; the template list is a separate request.
      await until(pp, () => document.querySelector('button[title^="Back to"]'), 15_000);
      const existing = await pp.evaluate(() => {
        const select = document.getElementById('resume-template');
        return {
          value: select.value,
          back: document.querySelector('button[title^="Back to"]')?.getAttribute('title') ?? '',
          bad: Array.from(select.options).filter((option) => option.disabled || /used by/i.test(option.textContent)).length,
        };
      });
      check(
        "Beta's own resume opens on that same template, with Back to Beta Person",
        existing.value === state.c0 && existing.bad === 0 && existing.back === 'Back to Beta Person',
        JSON.stringify(existing)
      );
    });

    /* ------------------------------------------------ tabs and the address */
    await section('premium: the tabs and the address', async () => {
      await openDashboard(pp, 'profiles');
      let snap = await snapshot(pp);
      check(
        'two profiles and three resumes: "Profiles (2)" selected, "All resumes (3)", two profile cards, and the welcome line says so',
        snap.tabs[0]?.text === 'Profiles (2)' &&
          snap.tabs[0].selected &&
          snap.tabs[1]?.text === 'All resumes (3)' &&
          snap.profileCards.length === 2 &&
          /You have 2 profiles and 3 resumes\./.test(snap.text),
        JSON.stringify({ tabs: snap.tabs, cards: snap.profileCards })
      );

      await pressTab(pp, 'All resumes');
      const toResumes = await until(pp, () => new URLSearchParams(location.search).get('tab') === 'resumes' && document.querySelectorAll('[data-resume-card]').length === 3, 20_000);
      snap = await snapshot(pp);
      check(
        'clicking "All resumes" puts ?tab=resumes in the address and draws a card per resume',
        toResumes && snap.tabs[1].selected && !snap.tabs[0].selected && snap.resumeCards.length === 3,
        JSON.stringify({ search: snap.search, tabs: snap.tabs, cards: snap.resumeCards.length })
      );

      await pp.reload({ waitUntil: 'networkidle2' });
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 3, 30_000);
      snap = await snapshot(pp);
      check(
        'a reload keeps the tab: still All resumes, still ?tab=resumes',
        snap.search.includes('tab=resumes') && snap.tabs[1]?.selected === true && snap.resumeCards.length === 3,
        JSON.stringify({ search: snap.search, tabs: snap.tabs })
      );

      await pressTab(pp, 'Profiles');
      const backToProfiles = await until(pp, () => !new URLSearchParams(location.search).has('tab') && document.querySelectorAll('[data-profile-card]').length === 2, 20_000);
      snap = await snapshot(pp);
      check('clicking "Profiles" takes ?tab= out of the address again', backToProfiles && snap.path === '/admin/profiles' && snap.tabs[0].selected, JSON.stringify({ search: snap.search }));

      await openDashboard(pp, 'profiles');
      await pp.goto(`${APP}/admin/profiles?tab=garbage`, { waitUntil: 'networkidle2' });
      await until(pp, () => Boolean(document.querySelector('[role="tablist"]')), 20_000);
      snap = await snapshot(pp);
      check('a ?tab= that names no tab reads as Profiles', snap.tabs[0]?.selected === true && snap.profileCards.length === 2, JSON.stringify(snap.tabs));

      await pp.focus('#dashboard-tab-profiles');
      await pp.keyboard.press('ArrowRight');
      const arrowed = await until(
        pp,
        () => document.getElementById('dashboard-tab-resumes')?.getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'dashboard-tab-resumes',
        10_000
      );
      check('ArrowRight on the tab list moves to All resumes and focuses it', arrowed);
    });

    /* ---------------------------------------------------------- grid, list */
    await section('premium: Grid and List kept after a reload', async () => {
      await openDashboard(pp, 'profiles');
      await pressViewButton(pp, 'List');
      await until(pp, () => document.querySelectorAll('[data-profile-row]').length === 2, 15_000);
      let snap = await snapshot(pp);
      let pressed = await viewPressed(pp);
      check(
        'List draws a row per profile (no cards), the List button pressed, and the choice is kept in localStorage',
        snap.profileRows.length === 2 && snap.profileCards.length === 0 && pressed.list === 'true' && pressed.grid === 'false' && snap.storedView === 'list',
        JSON.stringify({ rows: snap.profileRows.length, cards: snap.profileCards.length, pressed, stored: snap.storedView })
      );
      await pp.reload({ waitUntil: 'networkidle2' });
      await until(pp, () => document.querySelectorAll('[data-profile-row], [data-profile-card]').length > 0, 30_000);
      snap = await snapshot(pp);
      pressed = await viewPressed(pp);
      check('a reload keeps the List view', snap.profileRows.length === 2 && snap.profileCards.length === 0 && pressed.list === 'true', JSON.stringify({ rows: snap.profileRows.length, pressed }));

      await pressTab(pp, 'All resumes');
      await until(pp, () => document.querySelectorAll('[data-resume-row]').length === 3, 20_000);
      snap = await snapshot(pp);
      check('All resumes is a list of rows too, in the same view', snap.resumeRows.length === 3 && snap.resumeCards.length === 0, JSON.stringify({ rows: snap.resumeRows.length }));
      await shoot(pp, 'a-3-all-resumes-list');

      await pressViewButton(pp, 'Grid');
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 3, 15_000);
      snap = await snapshot(pp);
      check('Grid brings the cards back and is kept too', snap.resumeCards.length === 3 && snap.resumeRows.length === 0 && snap.storedView === 'grid', JSON.stringify({ stored: snap.storedView }));
      await shoot(pp, 'a-3b-all-resumes-grid');
      await pressTab(pp, 'Profiles');
      await until(pp, () => document.querySelectorAll('[data-profile-card]').length === 2, 15_000);
      await shoot(pp, 'a-0-dashboard-grid');
    });

    /* --------------------------------------------------------- the search */
    await section('premium: search and Clear', async () => {
      await openDashboard(pp, 'profiles');
      await typeSearch(pp, 'profiles-search', 'beta');
      await until(pp, () => document.querySelectorAll('[data-profile-card]').length === 1, 10_000);
      let snap = await snapshot(pp);
      check(
        'typing "beta" in Search profiles keeps Beta Person alone and says "1 of 2 profiles match."',
        snap.profileCards.length === 1 && snap.profileCards[0] === state.beta && snap.matchStatus === '1 of 2 profiles match.',
        JSON.stringify({ cards: snap.profileCards, status: snap.matchStatus })
      );
      const clearShown = await pressButton(pp, 'Clear');
      await until(pp, () => document.querySelectorAll('[data-profile-card]').length === 2, 10_000);
      snap = await snapshot(pp);
      const focused = await pp.evaluate(() => document.activeElement?.id ?? '');
      const emptied = await pp.evaluate(() => document.getElementById('profiles-search').value);
      check(
        'Clear empties the box, brings both profiles back, clears the count line and gives focus back to the box',
        clearShown && emptied === '' && snap.profileCards.length === 2 && snap.matchStatus === '' && focused === 'profiles-search',
        JSON.stringify({ clearShown, emptied, cards: snap.profileCards.length, status: snap.matchStatus, focused })
      );
      await typeSearch(pp, 'profiles-search', 'platform');
      await until(pp, () => document.querySelectorAll('[data-profile-card]').length === 1, 10_000);
      snap = await snapshot(pp);
      check(
        'a profile also matches by the headline of one of its resumes: "platform" finds Alpha Person',
        snap.profileCards.length === 1 && snap.profileCards[0] === state.alpha && snap.matchStatus === '1 of 2 profiles match.',
        JSON.stringify({ cards: snap.profileCards, status: snap.matchStatus })
      );
      await typeSearch(pp, 'profiles-search', 'zzzz');
      await until(pp, () => document.querySelectorAll('[data-profile-card]').length === 0, 10_000);
      snap = await snapshot(pp);
      check('a word nothing has matches nothing: "0 of 2 profiles match."', snap.profileCards.length === 0 && snap.matchStatus === '0 of 2 profiles match.', snap.matchStatus);
      await pressButton(pp, 'Clear');

      await pressTab(pp, 'All resumes');
      await until(pp, () => Boolean(document.getElementById('resumes-search')), 10_000);
      await typeSearch(pp, 'resumes-search', 'beta');
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 1, 10_000);
      snap = await snapshot(pp);
      check(
        'Search resumes finds a resume by its headline, name or profile: "beta" is 1 of 3',
        snap.resumeCards.length === 1 && snap.resumeCards[0] === state.b1 && snap.matchStatus === '1 of 3 resumes match.',
        JSON.stringify({ cards: snap.resumeCards, status: snap.matchStatus })
      );
      await pressButton(pp, 'Clear');
    });

    /* ----------------------------------- a profile's page: star, menu, copy */
    await section("premium: a profile's page - Set as default, Duplicate, Keywords", async () => {
      await pp.goto(`${APP}/admin/profiles/${encodeURIComponent(state.alpha)}`, { waitUntil: 'networkidle2' });
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 2, 30_000);
      let snap = await snapshot(pp);
      const firstStarred = await pp.evaluate(() => {
        const first = document.querySelector('[data-resume-card]');
        return { id: first?.getAttribute('data-resume-card'), starred: Boolean(first?.querySelector('[data-default-resume]')) };
      });
      check(
        "Alpha's page lists its two resumes with the default first and starred",
        snap.resumeCards.length === 2 && firstStarred.id === state.r1 && firstStarred.starred,
        JSON.stringify({ cards: snap.resumeCards, firstStarred })
      );

      const r2Menu = `[data-resume-card="${state.r2}"] button[aria-haspopup="menu"]`;
      const opened = await openMenu(pp, r2Menu);
      const entries = opened ? await menuEntries(pp) : [];
      check(
        "a resume's ⋮ menu: Edit, Set as default, Duplicate, Move to another profile..., Keywords, Download JSON, Disable, Delete",
        JSON.stringify(entries.map((entry) => entry.label)) ===
          JSON.stringify(['Edit', 'Set as default', 'Duplicate', 'Move to another profile...', 'Keywords', 'Download JSON', 'Disable', 'Delete']) &&
          entries.find((entry) => entry.label === 'Set as default')?.disabled === false,
        JSON.stringify(entries)
      );
      await pp.keyboard.press('Escape');
      const closed = await until(pp, () => !document.querySelector('[role="menu"]'), 5000);
      check('Escape closes the menu and gives focus back to its button', closed && (await focusOnMenuButtonIn(pp, `[data-resume-card="${state.r2}"]`)));

      const r1Menu = `[data-resume-card="${state.r1}"] button[aria-haspopup="menu"]`;
      await openMenu(pp, r1Menu);
      const defaultEntries = await menuEntries(pp);
      check(
        'the default resume\'s own menu has Set as default off (it already is)',
        defaultEntries.find((entry) => entry.label === 'Set as default')?.disabled === true,
        JSON.stringify(defaultEntries)
      );
      await pp.keyboard.press('Escape');

      await openMenu(pp, r2Menu);
      await pressMenuItem(pp, 'Set as default');
      const moved = await bodyMatches(pp, "is now Alpha Person's default resume\\.");
      await until(pp, (id) => Boolean(document.querySelector(`[data-resume-card="${id}"] [data-default-resume]`)), 15_000, state.r2);
      snap = await snapshot(pp);
      const star = await pp.evaluate((ids) => ({
        r2: Boolean(document.querySelector(`[data-resume-card="${ids.r2}"] [data-default-resume]`)),
        r1: Boolean(document.querySelector(`[data-resume-card="${ids.r1}"] [data-default-resume]`)),
        first: document.querySelector('[data-resume-card]')?.getAttribute('data-resume-card'),
      }), { r1: state.r1, r2: state.r2 });
      const afterDefault = await asPremium(`/profiles/${state.alpha}`);
      check(
        'Set as default moves the star to that resume, which now comes first, says so, and the server stores the choice',
        moved && star.r2 && !star.r1 && star.first === state.r2 && afterDefault.body?.chosenDefaultResumeId === state.r2 && afterDefault.body?.defaultResumeId === state.r2,
        JSON.stringify({ moved, star, profile: afterDefault.body })
      );

      await openMenu(pp, r2Menu);
      await pressMenuItem(pp, 'Duplicate');
      const duplicated = await bodyMatches(pp, 'Duplicated Alpha Platform Engineer in Alpha Person\\.');
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 3, 20_000);
      const afterCopy = await asPremium('/resumes?includeDisabled=true');
      const inAlpha = (afterCopy.body ?? []).filter((resume) => resume.profileId === state.alpha);
      state.r3 = (inAlpha.find((resume) => ![state.r1, state.r2].includes(resume.id)) || {}).id || '';
      check(
        'Duplicate makes a third resume in the same profile, KEEPING the template (all three on the one template)',
        duplicated && inAlpha.length === 3 && Boolean(state.r3) && inAlpha.every((resume) => resume.preferredTemplate === state.c0),
        JSON.stringify(inAlpha.map((resume) => [resume.id, resume.preferredTemplate]))
      );

      await openMenu(pp, r2Menu);
      await pressMenuItem(pp, 'Keywords');
      const keywordsOpen = await until(pp, () => /Keywords/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
      const keywordsText = flat(await dialogText(pp));
      await shoot(pp, 'a-11-keywords-dialog');
      check(
        'Keywords opens a dialog with the resume\'s job titles and its skills and technologies',
        keywordsOpen && /job titles/i.test(keywordsText) && /skills and technologies/i.test(keywordsText) && /Docker/.test(keywordsText) && /Alpha Platform Engineer/.test(keywordsText),
        keywordsText.slice(0, 300)
      );
      await pressButton(pp, 'Close', 'dialog');
      await until(pp, () => !document.querySelector('[role="dialog"]'), 8000);
      check('closing it gives focus back to the resume\'s ⋮ button', await focusOnMenuButtonIn(pp, `[data-resume-card="${state.r2}"]`));

      await pp.goto(`${APP}/admin/resumes/${encodeURIComponent(state.r2)}`, { waitUntil: 'networkidle2' });
      await pp.waitForSelector('#editor-tab-customize', { timeout: 30_000 });
      await clickSelector(pp, '#editor-tab-customize');
      await until(pp, () => !document.getElementById('editor-panel-customize')?.hidden, 8000);
      const customizeText = flat(await pp.evaluate(() => document.getElementById('editor-panel-customize')?.innerText ?? ''));
      check(
        "the editor's Customize tab has a Keywords card with this resume's skills",
        /Keywords/.test(customizeText) && /Docker/.test(customizeText) && /skills and technologies/i.test(customizeText),
        customizeText.slice(0, 300)
      );
      const barTitle = await pp.evaluate(() => document.querySelector('button[title^="Back to"]')?.getAttribute('title') ?? '');
      check("the editor's Back button reads the profile it came from", barTitle === 'Back to Alpha Person', barTitle);
      await clickSelector(pp, 'button[title^="Back to"]');
      const wentBack = await until(pp, (id) => location.pathname === `/admin/profiles/${id}`, 15_000, state.alpha);
      check("Back goes to the profile's page, not to the bare list", wentBack, pp.url());
    });

    /* --------------------------------------------------------------- move */
    await section('premium: Move, with focus', async () => {
      await pp.goto(`${APP}/admin/profiles/${encodeURIComponent(state.alpha)}`, { waitUntil: 'networkidle2' });
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 3, 30_000);
      const r3Menu = `[data-resume-card="${state.r3}"] button[aria-haspopup="menu"]`;
      await openMenu(pp, r3Menu);
      await pressMenuItem(pp, 'Move to another profile...');
      const opened = await until(pp, () => /Move Alpha Platform Engineer/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
      const dialogFacts = await pp.evaluate(() => ({
        text: document.querySelector('[role="dialog"]')?.innerText ?? '',
        radios: Array.from(document.querySelectorAll('[role="dialog"] input[name="profile-target"]')).map((radio) => ({ value: radio.value, disabled: radio.disabled })),
        locked: document.querySelectorAll('[role="dialog"] [data-locked-choice]').length,
      }));
      check(
        'Move opens "Move Alpha Platform Engineer" listing the other profile and "A new profile", which is open while there is room',
        opened &&
          /Move Alpha Platform Engineer/.test(dialogFacts.text) &&
          dialogFacts.radios.some((radio) => radio.value === state.beta && !radio.disabled) &&
          dialogFacts.radios.some((radio) => radio.value === '__new-profile__' && !radio.disabled) &&
          dialogFacts.locked === 0 &&
          !dialogFacts.radios.some((radio) => radio.value === state.alpha),
        JSON.stringify(dialogFacts).slice(0, 400)
      );
      await pp.keyboard.press('Escape');
      await until(pp, () => !document.querySelector('[role="dialog"]'), 8000);
      check('Escape closes the Move dialog and focus returns to the resume\'s ⋮ button', await focusOnMenuButtonIn(pp, `[data-resume-card="${state.r3}"]`));

      await openMenu(pp, r3Menu);
      await pressMenuItem(pp, 'Move to another profile...');
      await until(pp, () => Boolean(document.querySelector('[role="dialog"] input[name="profile-target"]')), 10_000);
      await pp.evaluate((id) => document.querySelector(`[role="dialog"] input[name="profile-target"][value="${id}"]`)?.click(), state.beta);
      await pressButton(pp, 'Move', 'dialog');
      const movedNotice = await bodyMatches(pp, 'Moved Alpha Platform Engineer to Beta Person\\.');
      await until(pp, (id) => !document.querySelector(`[data-resume-card="${id}"]`), 15_000, state.r3);
      // Focus is handed on a moment after the list is read again.
      await until(pp, (id) => document.activeElement?.closest('[data-resume-card]')?.getAttribute('data-resume-card') === id, 5000, state.r1);
      const focusAfter = await pp.evaluate(() => {
        const active = document.activeElement;
        return { inCard: Boolean(active?.closest('[data-resume-card]')), id: active?.closest('[data-resume-card]')?.getAttribute('data-resume-card') ?? '' };
      });
      const betaNow = await asPremium(`/profiles/${state.beta}`);
      check(
        'moving it to Beta Person says so, takes the card off this page and hands focus to the next card',
        movedNotice && focusAfter.inCard && focusAfter.id === state.r1 && betaNow.body?.resumeCount === 2,
        JSON.stringify({ movedNotice, focusAfter, beta: betaNow.body?.resumeCount })
      );

      const r1Menu = `[data-resume-card="${state.r1}"] button[aria-haspopup="menu"]`;
      await openMenu(pp, r1Menu);
      await pressMenuItem(pp, 'Move to another profile...');
      await until(pp, () => Boolean(document.querySelector('[role="dialog"] input[name="profile-target"]')), 10_000);
      await pp.evaluate(() => document.querySelector('[role="dialog"] input[name="profile-target"][value="__new-profile__"]')?.click());
      const nameBox = await until(pp, () => Boolean(document.querySelector('#move-resumes-form input.tl-input')), 8000);
      if (nameBox) await setValue(pp, '#move-resumes-form input.tl-input', 'Gamma Person');
      await pressButton(pp, 'Move', 'dialog');
      const gammaNotice = await bodyMatches(pp, 'Moved Alpha Backend Engineer to Gamma Person\\.');
      await until(pp, (id) => !document.querySelector(`[data-resume-card="${id}"]`), 15_000, state.r1);
      const all = await asPremium('/profiles');
      const gamma = (all.body ?? []).find((profile) => profile.name === 'Gamma Person');
      state.gamma = gamma?.id || '';
      const gammaFocus = await until(pp, () => Boolean(document.activeElement?.closest('[data-resume-card]')), 5000);
      check(
        'Move to "A new profile" (room for it on Premium) makes Gamma Person holding that resume, and focus stays on a card',
        nameBox && gammaNotice && Boolean(gamma) && gamma.resumeCount === 1 && gammaFocus,
        JSON.stringify({ nameBox, gammaNotice, gamma, gammaFocus })
      );
      const alphaNow = await asPremium(`/profiles/${state.alpha}`);
      check(
        "Alpha keeps its default (the resume that was never moved) and now holds just that one",
        alphaNow.body?.defaultResumeId === state.r2 && alphaNow.body?.resumeCount === 1,
        JSON.stringify(alphaNow.body)
      );
    });

    /* ------------------------------------------------------------- delete */
    await section('premium: delete a profile that holds two resumes', async () => {
      await openDashboard(pp, 'profiles');
      let snap = await snapshot(pp);
      check(
        'three profiles and four resumes before the delete',
        snap.tabs[0]?.text === 'Profiles (3)' && snap.tabs[1]?.text === 'All resumes (4)',
        JSON.stringify(snap.tabs)
      );
      const betaMenu = `[data-profile-card="${state.beta}"] button[aria-haspopup="menu"]`;
      await openMenu(pp, betaMenu);
      const entries = await menuEntries(pp);
      check(
        "a profile's ⋮ menu: Open, Rename, New resume, Delete",
        JSON.stringify(entries.map((entry) => entry.label)) === JSON.stringify(['Open', 'Rename', 'New resume', 'Delete']),
        JSON.stringify(entries)
      );
      await pressMenuItem(pp, 'Delete');
      const asked = await until(pp, () => /Delete Beta Person\?/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
      const warning = flat(await dialogText(pp));
      await shoot(pp, 'a-10-delete-warning');
      const confirmButton = await pp.evaluate(() => {
        const button = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => /^Delete profile/.test(b.textContent.trim()));
        return button ? { text: button.textContent.trim(), tone: button.getAttribute('data-tone') } : null;
      });
      check(
        "the warning comes first, in the owner's words, with a confirm button that says the resumes go too",
        asked && warning.includes(OWNER_DELETE_WARNING) && confirmButton?.text === 'Delete profile and its resumes' && confirmButton?.tone === 'danger',
        JSON.stringify({ warning: warning.slice(0, 260), confirmButton })
      );
      await pp.keyboard.press('Escape');
      await until(pp, () => !document.querySelector('[role="dialog"]'), 8000);
      const stillThere = await asPremium(`/profiles/${state.beta}`);
      check(
        'Escape leaves the profile alone (still two resumes) and gives focus back to its ⋮ button',
        stillThere.status === 200 && stillThere.body?.resumeCount === 2 && (await focusOnMenuButtonIn(pp, `[data-profile-card="${state.beta}"]`)),
        JSON.stringify(stillThere.body)
      );

      // Rename's name box takes focus the moment the dialog mounts (autoFocus): the place to go back to is the
      // ⋮ button that opened it, not that box, which is gone when the dialog closes.
      await openMenu(pp, betaMenu);
      await pressMenuItem(pp, 'Rename');
      const renameOpen = await until(pp, () => /Rename profile/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
      await pp.keyboard.press('Escape');
      await until(pp, () => !document.querySelector('[role="dialog"]'), 8000);
      check(
        'Escape closes Rename profile and gives focus back to the profile\'s ⋮ button',
        renameOpen && (await focusOnMenuButtonIn(pp, `[data-profile-card="${state.beta}"]`))
      );

      await openMenu(pp, betaMenu);
      await pressMenuItem(pp, 'Delete');
      await until(pp, () => /Delete Beta Person\?/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
      await pressButton(pp, 'Delete profile and its resumes', 'dialog');
      const noticed = await bodyMatches(pp, 'Deleted Beta Person and its resumes\\.');
      await until(pp, () => document.querySelectorAll('[data-profile-card]').length === 2, 15_000);
      snap = await snapshot(pp);
      const gone = await asPremium(`/profiles/${state.beta}`);
      const goneB1 = await asPremium(`/resumes/${encodeURIComponent(state.b1)}`);
      const goneR3 = await asPremium(`/resumes/${encodeURIComponent(state.r3)}`);
      check(
        'confirming deletes the profile and says "Deleted Beta Person and its resumes."; the tab counts drop to 2 and 2',
        noticed && snap.tabs[0]?.text === 'Profiles (2)' && snap.tabs[1]?.text === 'All resumes (2)' && gone.status === 404,
        JSON.stringify({ noticed, tabs: snap.tabs, goneStatus: gone.status })
      );
      check('on the server both of its resumes are gone too', goneB1.status === 404 && goneR3.status === 404, JSON.stringify([goneB1.status, goneR3.status]));
      const focusedAfter = await until(
        pp,
        () => {
          const active = document.activeElement;
          return Boolean(active && (active.closest('[data-profile-card], [data-profile-row]') || active.closest('[data-new-tile]')));
        },
        5000
      );
      check('focus goes to the next profile card (or the New tile), not to the page', focusedAfter);

      await pressTab(pp, 'All resumes');
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length === 2, 15_000);
      snap = await snapshot(pp);
      check(
        'All resumes lists only the two that are left - neither of the deleted profile\'s resumes',
        snap.resumeCards.length === 2 && !snap.resumeCards.includes(state.b1) && !snap.resumeCards.includes(state.r3) && snap.resumeCards.includes(state.r2) && snap.resumeCards.includes(state.r1),
        JSON.stringify(snap.resumeCards)
      );

      // And from the profile's own page: Gamma, one resume.
      await pp.goto(`${APP}/admin/profiles/${encodeURIComponent(state.gamma)}`, { waitUntil: 'networkidle2' });
      await until(pp, () => document.querySelector('h1')?.textContent.trim() === 'Gamma Person', 20_000);
      await openMenu(pp, 'button[aria-haspopup="menu"][aria-label="Actions for Gamma Person"]');
      await pressMenuItem(pp, 'Delete profile');
      await until(pp, () => /Delete Gamma Person\?/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
      await pressButton(pp, 'Delete profile and its resumes', 'dialog');
      const backOnDashboard = await until(pp, () => location.pathname === '/admin/profiles' && !location.search, 20_000);
      const flash = await bodyMatches(pp, 'Deleted Gamma Person and its resumes\\.');
      check(
        "deleting from the profile's own page returns to the dashboard, which says what went",
        backOnDashboard && flash && (await asPremium(`/profiles/${state.gamma}`)).status === 404,
        pp.url()
      );
    });

    /* --------------------------------------------------- the old addresses */
    await section('premium: old bookmarks and retired pages', async () => {
      await pp.goto(`${APP}/admin/profiles/${encodeURIComponent(state.r2)}`, { waitUntil: 'domcontentloaded' });
      const toEditor = await until(pp, (id) => location.pathname === `/admin/resumes/${id}`, 30_000, state.r2);
      const editorUp = await pp.waitForSelector('#editor-tab-content', { timeout: 30_000 }).then(() => true, () => false);
      check('an old /admin/profiles/<resume id> bookmark opens that resume\'s editor', toEditor && editorUp, pp.url());

      await pp.goto(`${APP}/admin/profiles/new?template=${encodeURIComponent(state.c0)}`, { waitUntil: 'domcontentloaded' });
      const toNew = await until(pp, (id) => location.pathname === '/admin/resumes/new' && new URLSearchParams(location.search).get('template') === id, 30_000, state.c0);
      check('/admin/profiles/new reaches the new-resume page, query string and all', toNew, pp.url());

      await pp.goto(`${APP}/admin/profiles/no-such-profile`, { waitUntil: 'networkidle2' });
      const missing = await bodyMatches(pp, 'That profile was not found\\. It may have been deleted\\.');
      const link = await pp.evaluate(() => Array.from(document.querySelectorAll('a')).some((a) => a.textContent.trim() === 'Back to My Profiles'));
      check('an address that is neither a profile nor a resume says "That profile was not found" with a way back', missing && link);
    });

    /* -------------------------------------------------------- 390px, dark */
    await section('premium: 390px and dark mode', async () => {
      await pp.setViewport(PHONE);
      await openDashboard(pp, 'profiles');
      const facts = await pp.evaluate(() => ({
        tabsInside: Array.from(document.querySelectorAll('[role="tab"]')).every((tab) => tab.getBoundingClientRect().right <= window.innerWidth + 1),
        create: (() => {
          const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Create New');
          const box = button?.getBoundingClientRect();
          return box ? box.right <= window.innerWidth + 1 && box.left >= 0 : false;
        })(),
      }));
      const wide390 = await overflow(pp);
      check('at 390 the dashboard has no sideways scroll, its tabs and Create New are inside the window', wide390 <= 1 && facts.tabsInside && facts.create, JSON.stringify({ wide390, facts }));
      await shoot(pp, 'a-4-dashboard-390');

      await pressViewButton(pp, 'List');
      await until(pp, () => document.querySelectorAll('[data-profile-row]').length > 0, 10_000);
      const listFacts = await pp.evaluate(() => ({
        menuInside: Array.from(document.querySelectorAll('[data-profile-row] button[aria-haspopup="menu"]')).every((button) => {
          const box = button.getBoundingClientRect();
          return box.left >= 0 && box.right <= window.innerWidth + 1;
        }),
      }));
      check('in List the rows stack on a phone: no sideways scroll, every ⋮ button inside the window', (await overflow(pp)) <= 1 && listFacts.menuInside, JSON.stringify(listFacts));
      await openMenu(pp, '[data-profile-row] button[aria-haspopup="menu"]');
      const menuBox = await pp.evaluate(() => {
        const box = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right, width: window.innerWidth } : null;
      });
      check('an open menu stays inside a 390px window', Boolean(menuBox) && menuBox.left >= -1 && menuBox.right <= menuBox.width + 1, JSON.stringify(menuBox));
      await pp.keyboard.press('Escape');
      // The Import menu hangs from a button at the LEFT of a phone's page: its list must grow rightwards from there.
      const importOpened = await pp.evaluate(() => {
        const trigger = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => /^\s*Import\s*$/.test(button.textContent));
        trigger?.click();
        return Boolean(trigger);
      });
      await until(pp, () => Boolean(document.querySelector('[role="menu"]')), 5000);
      const importBox = await pp.evaluate(() => {
        const box = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right, width: window.innerWidth } : null;
      });
      check(
        "the dashboard's Import menu stays inside a 390px window",
        importOpened && Boolean(importBox) && importBox.left >= -1 && importBox.right <= importBox.width + 1,
        JSON.stringify(importBox)
      );
      await pp.keyboard.press('Escape');
      await shoot(pp, 'a-5-list-390');
      await pressViewButton(pp, 'Grid');

      await pp.goto(`${APP}/admin/profiles/${encodeURIComponent(state.alpha)}`, { waitUntil: 'networkidle2' });
      await until(pp, () => document.querySelectorAll('[data-resume-card]').length >= 1, 30_000);
      check("at 390 a profile's page has no sideways scroll", (await overflow(pp)) <= 1, `overflow ${await overflow(pp)}`);
      const pageImportOpened = await pp.evaluate(() => {
        const trigger = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => /Import resume/.test(button.textContent));
        trigger?.click();
        return Boolean(trigger);
      });
      await until(pp, () => Boolean(document.querySelector('[role="menu"]')), 5000);
      const pageImportBox = await pp.evaluate(() => {
        const box = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right, width: window.innerWidth } : null;
      });
      check(
        "at 390 a profile page's Import resume menu stays inside the window",
        pageImportOpened && Boolean(pageImportBox) && pageImportBox.left >= -1 && pageImportBox.right <= pageImportBox.width + 1,
        JSON.stringify(pageImportBox)
      );
      await pp.keyboard.press('Escape');
      await pp.setViewport(WIDE);

      const dark = await newPage(browser, tokens.premium, WIDE, 'dark');
      await openDashboard(dark, 'profiles');
      const darkFacts = await dark.evaluate(() => {
        const card = document.querySelector('[data-profile-card]');
        // The first background that is not transparent, walking out from the element.
        const lightness = (element) => {
          for (let node = element; node; node = node.parentElement) {
            const found = getComputedStyle(node).backgroundColor.match(/[\d.]+/g) || [];
            if (found.length >= 3 && (found.length < 4 || Number(found[3]) > 0.5)) {
              return (Number(found[0]) * 299 + Number(found[1]) * 587 + Number(found[2]) * 114) / 1000;
            }
          }
          return 255;
        };
        return { isDark: document.documentElement.classList.contains('dark'), body: lightness(document.body), card: card ? lightness(card) : 255, hasCard: Boolean(card) };
      });
      check(
        'in dark mode the dashboard is dark: the page and a profile card are not white',
        darkFacts.isDark && darkFacts.hasCard && darkFacts.body < 128 && darkFacts.card < 200,
        JSON.stringify(darkFacts)
      );
      await shoot(dark, 'a-6-dashboard-dark');
      await dark.goto(`${APP}/admin/profiles/${encodeURIComponent(state.alpha)}`, { waitUntil: 'networkidle2' });
      await until(dark, () => document.querySelectorAll('[data-resume-card]').length >= 1, 30_000);
      const darkProfile = await dark.evaluate(() => ({
        isDark: document.documentElement.classList.contains('dark'),
        star: Boolean(document.querySelector('[data-default-resume]')),
      }));
      check("and a profile's page is dark too, the Default star still drawn", darkProfile.isDark && darkProfile.star, JSON.stringify(darkProfile));
      await shoot(dark, 'a-7-profile-dark');
      await dark.close();
    });

    /* ============================================ A Default account's limit */
    const bp = await newPage(browser, tokens.basic, WIDE);
    await section('default: one profile, then locked; resumes never counted', async () => {
      await openDashboard(bp, 'profiles');
      let snap = await snapshot(bp);
      let tile = await bp.evaluate(() => {
        const node = document.querySelector('[data-new-tile="profile"]');
        return node ? { locked: node.hasAttribute('data-locked-feature') } : null;
      });
      check('a Default account with no profile yet: Profiles (0) and the New profile tile open', snap.tabs[0]?.text === 'Profiles (0)' && tile && !tile.locked, JSON.stringify({ tabs: snap.tabs, tile }));

      await createNewReady(bp);
      await pressButton(bp, 'Create New');
      await until(bp, () => /New profile/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 8000);
      await setValue(bp, '#profile-name-form input', 'Pat Match');
      await pressButton(bp, 'Create profile', 'dialog');
      const landed = await until(bp, () => /^\/admin\/profiles\/[^/]+$/.test(location.pathname), 20_000);
      state.pat = landed ? lastSegment(bp.url()) : '';
      check('it can make its one profile: Pat Match', landed && Boolean(state.pat), bp.url());

      await openDashboard(bp, 'profiles');
      // The lock is drawn once the account has arrived.
      await until(bp, () => Boolean(document.querySelector('[data-new-tile="profile"][data-locked-feature="more-profiles"]')), 15_000);
      snap = await snapshot(bp);
      tile = await bp.evaluate(() => {
        const node = document.querySelector('[data-new-tile="profile"][data-locked-feature="more-profiles"]');
        const create = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Create New');
        return node
          ? { disabled: node.disabled, text: node.innerText.replace(/\s+/g, ' '), createLocked: create?.getAttribute('data-locked-feature') ?? null }
          : null;
      });
      check(
        'with the one profile made, the New profile tile is locked - pressable, "Needs Premium" - and so is Create New',
        Boolean(tile) && !tile.disabled && /Needs Premium/.test(tile.text) && tile.createLocked === 'more-profiles',
        JSON.stringify(tile)
      );
      check(
        'the page says all the profiles the subscription allows are used',
        /You are using all 1 profile on the Default subscription\./.test(snap.text),
        snap.text.slice(0, 300)
      );
      await shoot(bp, 'a-8-default-locked');
      await clickSelector(bp, '[data-new-tile="profile"][data-locked-feature="more-profiles"]');
      await until(bp, () => Boolean(document.querySelector('[role="dialog"]')), 8000);
      const lock = await bp.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        return {
          title: panel?.querySelector('h2')?.textContent.trim() ?? '',
          text: panel?.innerText ?? '',
          go: Array.from(panel?.querySelectorAll('a') ?? []).find((a) => a.textContent.trim() === 'Go to subscription')?.getAttribute('href') ?? '',
        };
      });
      check(
        'pressing it opens "Locked: More profiles", what Premium allows, and Go to subscription',
        lock.title === 'Locked: More profiles' && /Premium allows up to 5\./.test(lock.text) && lock.go === '/settings/subscription',
        JSON.stringify(lock)
      );
      await bp.keyboard.press('Escape');
      await until(bp, () => !document.querySelector('[role="dialog"]'), 8000);

      const second = await asBasic('/profiles', { method: 'POST', body: JSON.stringify({ name: 'Too Many' }) });
      check('the server is the real lock: a second profile is 402 profile-limit', second.status === 402 && second.body?.code === 'profile-limit', JSON.stringify(second.body));

      const go = await asBasic(`/resumes?profileId=${encodeURIComponent(state.pat)}`, {
        method: 'POST',
        body: JSON.stringify(
          resumeBody({
            name: 'Pat Match',
            title: GO_ROLE,
            summary: GO_SUMMARY,
            skills: ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker', 'TypeScript'],
            experience: [
              {
                title: 'Backend Specialist',
                company: 'Acme Works',
                startDate: '01/2019',
                endDate: 'Present',
                location: 'Austin, TX',
                achievements: ['Moved the payments services to Go and cut their latency by 40%.', 'Ran the Kubernetes clusters behind them.'],
              },
            ],
            preferredTemplate: state.c0,
          })
        ),
      });
      const react = await asBasic(`/resumes?profileId=${encodeURIComponent(state.pat)}`, {
        method: 'POST',
        body: JSON.stringify(
          resumeBody({
            name: 'Pat Match',
            title: REACT_ROLE,
            summary: REACT_SUMMARY,
            skills: ['React', 'Redux', 'CSS', 'Jest', 'Docker', 'TypeScript'],
            experience: [
              {
                title: 'Frontend Specialist',
                company: 'Acme Works',
                startDate: '01/2019',
                endDate: 'Present',
                location: 'Austin, TX',
                achievements: ['Rebuilt the checkout in React and TypeScript.', 'Cut the bundle size by 35%.'],
              },
            ],
            preferredTemplate: state.c0,
          })
        ),
      });
      state.goResume = go.body?.id || '';
      state.reactResume = react.body?.id || '';
      const profilesAfter = await asBasic('/profiles');
      check(
        "resumes are never counted: the Default account adds a Go and a React resume to its one profile, and still has one profile",
        go.status === 201 && react.status === 201 && profilesAfter.body?.length === 1 && profilesAfter.body[0].resumeCount === 2,
        JSON.stringify({ go: go.status, react: react.status, profiles: profilesAfter.body })
      );

      await openDashboard(bp, 'resumes');
      const newResumeTile = await bp.evaluate(() => {
        const node = document.querySelector('[data-new-tile="resume"]');
        return node ? { disabled: node.disabled, locked: node.hasAttribute('data-locked-feature') } : null;
      });
      check('on All resumes the New resume tile stays open for a Default account at its limit', Boolean(newResumeTile) && !newResumeTile.disabled && !newResumeTile.locked, JSON.stringify(newResumeTile));
      await clickSelector(bp, '[data-new-tile="resume"]');
      const toChooser = await until(bp, (id) => location.pathname === '/admin/resumes/new' && new URLSearchParams(location.search).get('profile') === id, 20_000, state.pat);
      await bp.waitForSelector('[data-template-card]', { timeout: 30_000 }).catch(() => null);
      const chooserFacts = await bp.evaluate(() => ({
        cards: document.querySelectorAll('[data-template-card]').length,
        locked: document.querySelectorAll('[data-locked-feature]').length,
        h1: document.querySelector('h1')?.textContent.trim() ?? '',
      }));
      check(
        'with exactly one profile it goes straight to the chooser for it - open, with no lock',
        toChooser && chooserFacts.cards > 0 && chooserFacts.locked === 0 && chooserFacts.h1 === 'Start building a resume for Pat Match',
        JSON.stringify(chooserFacts)
      );

      await bp.goto(`${APP}/admin/profiles/${encodeURIComponent(state.pat)}`, { waitUntil: 'networkidle2' });
      await until(bp, () => document.querySelectorAll('[data-resume-card]').length === 2, 30_000);
      await openMenu(bp, `[data-resume-card="${state.goResume}"] button[aria-haspopup="menu"]`);
      await pressMenuItem(bp, 'Duplicate');
      const duplicated = await bodyMatches(bp, `Duplicated ${GO_ROLE} in Pat Match\\.`);
      await until(bp, () => document.querySelectorAll('[data-resume-card]').length === 3, 20_000);
      const copies = await asBasic('/resumes?includeDisabled=true');
      const copy = (copies.body ?? []).find((resume) => resume.title === GO_ROLE && resume.id !== state.goResume);
      check(
        'Duplicate is open to a Default account at its limit, and keeps the template',
        duplicated && Boolean(copy) && copy.preferredTemplate === state.c0 && copy.profileId === state.pat,
        JSON.stringify(copy)
      );
      if (copy) {
        const before = dialogs.length;
        await openMenu(bp, `[data-resume-card="${copy.id}"] button[aria-haspopup="menu"]`);
        await pressMenuItem(bp, 'Delete');
        const deleted = await bodyMatches(bp, `Deleted ${GO_ROLE}\\.`);
        const asked = dialogs.slice(before).some((entry) => entry.type === 'confirm' && entry.message === `Delete ${GO_ROLE}? This can't be undone.`);
        await until(bp, () => document.querySelectorAll('[data-resume-card]').length === 2, 20_000);
        check('Delete asks first, and takes the copy away', deleted && asked, JSON.stringify(dialogs.slice(before)));
      } else {
        check('Delete asks first, and takes the copy away', false, 'there was no copy to delete');
      }
    });

    /* ============================================ Admin: Models and Settings */
    const ap = await newPage(browser, tokens.admin, WIDE);
    await section('admin: Models has no price; Settings has three', async () => {
      await ap.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
      await ap.waitForSelector('table.tl-table', { timeout: 30_000 });
      const models = await ap.evaluate(() => ({
        headers: Array.from(document.querySelectorAll('table.tl-table th')).map((th) => th.textContent.trim()),
        priceBox: Boolean(document.getElementById('model-price-per-resume')),
        text: document.body.innerText,
      }));
      check(
        'Admin -> Models has no Price column and no price box, and says where a resume\'s price is set',
        models.headers.length > 0 &&
          !models.headers.some((header) => /price/i.test(header)) &&
          !models.priceBox &&
          flat(models.text).includes('What a resume costs is set per builder mode under Settings > General > Price per resume.'),
        JSON.stringify(models.headers)
      );
      await pressButton(ap, 'Create New Model');
      await ap.waitForSelector('#model-display-name', { timeout: 10_000 });
      const dialog = flat(await dialogText(ap));
      check('the Create New Model dialog asks for a name, a provider and a model - and no price', !/price/i.test(dialog) && dialog.length > 0, dialog.slice(0, 300));
      await ap.keyboard.press('Escape');
      await until(ap, () => !document.querySelector('[role="dialog"]'), 8000);

      await ap.goto(`${APP}/admin/settings`, { waitUntil: 'networkidle2' });
      const loaded = await until(ap, () => Boolean(document.getElementById('mode-price-suitablePriceMilli')), 30_000);
      const keys = ['suitablePriceMilli', 'partialPriceMilli', 'fullPriceMilli'];
      const read = () =>
        ap.evaluate((names) => {
          const parse = (value) => (value.match(/\d+/g) || []).slice(0, 3).map(Number);
          const boxes = names.map((key) => document.getElementById(`mode-price-${key}`));
          const frees = Array.from(document.querySelectorAll('p.tl-status[data-tone="error"]')).filter((p) => /^Free: nobody is charged for /.test(p.textContent.trim()));
          return {
            values: boxes.map((box) => (box ? box.value : null)),
            inputMode: boxes.map((box) => box?.getAttribute('inputmode') ?? null),
            heading: Array.from(document.querySelectorAll('h2')).some((h) => h.textContent.trim() === 'Price per resume'),
            frees: frees.map((p) => ({ text: p.textContent.trim(), rgb: parse(getComputedStyle(p).color) })),
            text: document.body.innerText,
          };
        }, keys);
      let settings = await read();
      check(
        'Admin -> Settings: a "Price per resume" section with the three boxes, as text for dollars',
        loaded && settings.heading && settings.values.every((value) => value !== null) && settings.inputMode.every((mode) => mode === 'decimal'),
        JSON.stringify({ loaded, values: settings.values })
      );
      const zero = settings.values.filter((value) => Number(value) === 0).length;
      check(
        'every mode priced $0 has a red "Free: nobody is charged for ..." line - and only those',
        settings.frees.length === zero && settings.frees.every((free) => free.rgb.length === 3 && free.rgb[0] > free.rgb[1] + 50 && free.rgb[0] > free.rgb[2] + 50),
        JSON.stringify({ values: settings.values, frees: settings.frees })
      );
      if (zero > 0) {
        check(
          'the Free line names its mode: "Free: nobody is charged for Choose Suitable Resume." and so on',
          settings.frees.every((free) => /^Free: nobody is charged for (Choose Suitable Resume|Partial Tailor|Fully Tailor)\.$/.test(free.text)),
          JSON.stringify(settings.frees)
        );
      } else {
        skip('the Free line names its mode', 'no price is $0 in this installation');
      }
      const builder = await ap.evaluate(() => ({
        profileFirst: document.getElementById('default-profile')?.options[0]?.textContent.trim() ?? '',
        modes: Array.from(document.getElementById('default-build-mode')?.options ?? []).map((option) => option.value),
        modeLabels: Array.from(document.getElementById('default-build-mode')?.options ?? []).map((option) => option.textContent.trim()),
      }));
      check(
        'Builder Defaults: the default profile starts on "Choose automatically", the default builder mode offers the three modes',
        builder.profileFirst === 'Choose automatically' &&
          JSON.stringify(builder.modes) === JSON.stringify(['suitable', 'partial', 'full']) &&
          JSON.stringify(builder.modeLabels) === JSON.stringify(['Choose Suitable Resume', 'Partial Tailor', 'Fully Tailor']),
        JSON.stringify(builder)
      );

      // A refused amount is said before anything is sent.
      const priorPartial = (await asAdmin('/admin/settings')).body?.partialPriceMilli;
      await setValue(ap, '#mode-price-partialPriceMilli', '1.2345');
      await pressButton(ap, 'Save Prices');
      const refused = await until(ap, () => Boolean(document.getElementById('mode-price-partialPriceMilli-refusal')), 8000);
      const refusal = await ap.evaluate(() => document.getElementById('mode-price-partialPriceMilli-refusal')?.textContent.trim() ?? '');
      const unchanged = await asAdmin('/admin/settings');
      check(
        "a price finer than a thousandth is refused under its own box, in the server's words, and nothing is saved",
        refused && /Partial Tailor/.test(refusal) && /three decimal places/.test(refusal) && /\$0\.001/.test(refusal) && unchanged.body?.partialPriceMilli === priorPartial,
        JSON.stringify({ refusal, priorPartial, now: unchanged.body?.partialPriceMilli })
      );

      // A price saved from the page.
      await setValue(ap, '#mode-price-partialPriceMilli', settings.values[1]);
      await setValue(ap, '#mode-price-suitablePriceMilli', '0.01');
      await pressButton(ap, 'Save Prices');
      const savedNotice = await bodyMatches(ap, 'Prices per resume saved\\.');
      const afterSave = await asAdmin('/admin/settings');
      check(
        'Save Prices sends only what changed: the Choose Suitable Resume price is $0.01 on the server',
        savedNotice && afterSave.body?.suitablePriceMilli === 10,
        JSON.stringify({ savedNotice, milli: afterSave.body?.suitablePriceMilli })
      );
      const others = await asAdmin('/admin/settings', { method: 'PUT', body: JSON.stringify({ partialPriceUsd: '0.02', fullPriceUsd: '0.03' }) });
      const readBack = await asAdmin('/admin/settings');
      check(
        'setup: Partial Tailor $0.02 and Fully Tailor $0.03 through the settings API (read back from it)',
        others.status === 200 && readBack.body?.partialPriceMilli === 20 && readBack.body?.fullPriceMilli === 30 && readBack.body?.suitablePriceMilli === 10,
        JSON.stringify({ status: others.status, partial: readBack.body?.partialPriceMilli, full: readBack.body?.fullPriceMilli })
      );

      await ap.reload({ waitUntil: 'networkidle2' });
      await until(ap, () => Boolean(document.getElementById('mode-price-suitablePriceMilli')), 30_000);
      settings = await read();
      check(
        'after a reload the boxes read 0.01, 0.02 and 0.03, no price is Free any more, and each says it was set here',
        JSON.stringify(settings.values.map((value) => Number(value))) === JSON.stringify([0.01, 0.02, 0.03]) &&
          settings.frees.length === 0 &&
          (settings.text.match(/Set here/g) || []).length >= 3,
        JSON.stringify({ values: settings.values, frees: settings.frees.length })
      );
      await shoot(ap, 'a-9-settings-prices', true);

      await ap.setViewport(PHONE);
      await ap.goto(`${APP}/admin/settings`, { waitUntil: 'networkidle2' });
      await until(ap, () => Boolean(document.getElementById('mode-price-suitablePriceMilli')), 30_000);
      const boxesInside = await ap.evaluate(() =>
        ['suitablePriceMilli', 'partialPriceMilli', 'fullPriceMilli'].every((key) => {
          const box = document.getElementById(`mode-price-${key}`)?.getBoundingClientRect();
          return Boolean(box) && box.left >= 0 && box.right <= window.innerWidth + 1;
        })
      );
      check('at 390 the three price boxes sit inside the window, with no sideways scroll', boxesInside && (await overflow(ap)) <= 1, `overflow ${await overflow(ap)}`);
      await ap.setViewport(WIDE);
    });

    /* ============================================================ PART B */
    await section('builder: the three modes, the profile\'s default, the prices', async () => {
      const credit = await asAdmin(`/admin/accounts/${basic.id}/credits`, { method: 'POST', body: JSON.stringify({ amountUsd: '5' }) });
      const defaulted = await asBasic(`/profiles/${state.pat}`, { method: 'PUT', body: JSON.stringify({ defaultResumeId: state.reactResume }) });
      const suffix = await asBasic('/auth/account', {
        method: 'PUT',
        body: JSON.stringify({ outputPathSuffix: '/{{date}}/{{profile_name}}/{{company_name}}/{{role}}' }),
      });
      check(
        "setup: $5 of credit, the React resume as Pat Match's default, and a folder path that files by role (so the Role box is shown)",
        credit.status === 200 && defaulted.status === 200 && defaulted.body?.defaultResumeId === state.reactResume && suffix.status === 200,
        JSON.stringify([credit.status, defaulted.status, suffix.status])
      );

      await bp.goto(`${APP}/`, { waitUntil: 'networkidle2' });
      await pressButton(bp, 'Building Manually', '', true);
      const ready = await until(
        bp,
        () => {
          const select = document.getElementById('manual-profile');
          return Boolean(select) && select.options.length > 1 && Boolean(document.querySelector('input[name="manualBuildMode"]'));
        },
        30_000
      );
      const facts = await bp.evaluate(() => {
        const select = document.getElementById('manual-profile');
        const modes = ['suitable', 'partial', 'full'].map((mode) => {
          const radio = document.querySelector(`input[name="manualBuildMode"][value="${mode}"]`);
          return { mode, found: Boolean(radio), disabled: radio?.disabled ?? null, checked: radio?.checked ?? null, hint: radio?.closest('label')?.innerText.replace(/\s+/g, ' ') ?? '' };
        });
        return {
          selected: select?.value ?? '',
          optionText: select ? Array.from(select.options).map((option) => option.textContent.trim()) : [],
          modes,
          locks: document.querySelectorAll('[role="radiogroup"][aria-label="Build mode"] [data-locked-choice]').length,
          role: Boolean(document.querySelector('input[placeholder^="Taken from the job description"]')),
        };
      });
      check(
        "Build Resumes starts on the account's one profile, listed with its resume count",
        ready && facts.selected === state.pat && facts.optionText.includes('Pat Match (2 resumes)'),
        JSON.stringify({ selected: facts.selected, options: facts.optionText })
      );
      check(
        "a Default account's three mode cards are all open: radios on, no lock",
        facts.modes.every((mode) => mode.found && mode.disabled === false) && facts.locks === 0,
        JSON.stringify({ modes: facts.modes.map((mode) => [mode.mode, mode.found, mode.disabled]), locks: facts.locks })
      );
      check(
        'each card says what a resume costs in that mode: $0.01, $0.02 and $0.03 a resume',
        /\$0\.01 a resume\./.test(facts.modes[0].hint) && /\$0\.02 a resume\./.test(facts.modes[1].hint) && /\$0\.03 a resume\./.test(facts.modes[2].hint),
        JSON.stringify(facts.modes.map((mode) => mode.hint.slice(-60)))
      );
      check('with no default mode set by the administrator the builder starts on Partial Tailor', facts.modes[1].checked === true && facts.modes[0].checked === false && facts.modes[2].checked === false, JSON.stringify(facts.modes.map((mode) => mode.checked)));
      check('the Role box is shown (the folder path files by role)', facts.role);

      const costs = { suitable: '$0.01', partial: '$0.02', full: '$0.03' };
      for (const mode of ['suitable', 'partial', 'full']) {
        await clickSelector(bp, `input[name="manualBuildMode"][value="${mode}"]`);
        const shown = await until(bp, (price) => new RegExp(`1 resume \\u00d7 \\${price} = \\${price}`).test(document.body.innerText), 20_000, costs[mode]);
        check(`the cost line follows the mode: ${mode} reads "1 resume × ${costs[mode]} = ${costs[mode]}"`, shown, flat(await bodyText(bp)).slice(0, 300));
      }
      await clickSelector(bp, 'input[name="manualBuildMode"][value="suitable"]');
      await until(bp, () => document.querySelector('input[name="manualBuildMode"][value="suitable"]')?.checked === true, 5000);
      const suitableNote = await bp.evaluate(() => document.querySelector('[data-build-mode-note]')?.textContent.trim() ?? '');
      await clickSelector(bp, 'input[name="manualBuildMode"][value="full"]');
      await until(bp, () => document.querySelector('input[name="manualBuildMode"][value="full"]')?.checked === true, 5000);
      const fullNote = await bp.evaluate(() => document.querySelector('[data-build-mode-note]')?.textContent.trim() ?? '');
      check(
        "the note under the cards: Suitable chooses by keywords, Fully builds Pat Match's default resume",
        suitableNote === 'For each job, the resume whose keywords match the posting best.' &&
          fullNote === `Builds ${REACT_ROLE}, Pat Match's default resume, for every job.`,
        JSON.stringify([suitableNote, fullNote])
      );
      await shoot(bp, 'b-1-builder-modes');
    });

    /* ----------------------------------------------------------- previews */
    const previewFacts = (page) =>
      page.evaluate(() => {
        const frame = document.querySelector('iframe[title="Resume Preview"]');
        const html = frame ? frame.getAttribute('srcdoc') || '' : '';
        const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ');
        const dialog = frame ? frame.closest('.tl-dialog') : null;
        const dialogCopy = dialog ? dialog.innerText : '';
        return {
          text,
          choice: document.querySelector('[data-preview-choice]')?.textContent.trim() ?? '',
          ats: /ATS OPTIMIZATION/i.test(dialogCopy),
          manual: /Manual Edits \(JSON\)/.test(dialogCopy),
          page: document.body.innerText,
        };
      });
    async function previewFor(page, { mode, role, posting }) {
      await clickSelector(page, `input[name="manualBuildMode"][value="${mode}"]`);
      await until(page, (wanted) => document.querySelector(`input[name="manualBuildMode"][value="${wanted}"]`)?.checked === true, 5000, mode);
      await setValue(page, 'input[placeholder^="Taken from the job description"]', role);
      await setValue(page, 'textarea[placeholder^="Paste the job description"]', posting);
      await wait(300);
      const pressed = await pressButton(page, 'Analyze & Preview');
      const shown = await until(page, () => Array.from(document.querySelectorAll('h3')).some((h) => h.textContent.trim() === 'Resume Preview'), 120_000);
      return { pressed, shown, facts: shown ? await previewFacts(page) : null, fallback: shown ? '' : flat(await bodyText(page)).slice(0, 400) };
    }
    async function closePreview(page) {
      await pressButton(page, 'Close');
      await until(page, () => !Array.from(document.querySelectorAll('h3')).some((h) => h.textContent.trim() === 'Resume Preview'), 8000);
    }

    await section('builder: Choose Suitable Resume previews the matched resume as written', async () => {
      await setValue(bp, 'input[placeholder="Enter company name"]', 'Acme Works');
      // Preview mode: Analyze & Preview, not Generate Immediately.
      const previewMode = await bp.evaluate(() => document.body.innerText.includes('Preview mode (On)'));
      if (!previewMode) {
        await bp.evaluate(() => {
          const toggle = Array.from(document.querySelectorAll('label input[type="checkbox"]')).find((input) => /switch/.test(input.closest('label').className));
          toggle?.click();
        });
      }
      const window0 = logSize();
      const go = await previewFor(bp, { mode: 'suitable', role: GO_ROLE, posting: GO_POSTING });
      check(
        `Choose Suitable Resume, Go posting: the preview is built with "${GO_ROLE}" - the Go resume - and names the mode`,
        go.shown && go.facts.choice.startsWith(GO_ROLE) && /Suitable resume/.test(go.facts.choice) && /the suitable resume for this job/.test(go.facts.page),
        JSON.stringify({ pressed: go.pressed, fallback: go.fallback, choice: go.facts?.choice })
      );
      check(
        'it is drawn AS WRITTEN: the resume\'s own summary, not the tailored sentence',
        go.shown && go.facts.text.includes(GO_SUMMARY_PHRASE) && !go.facts.text.includes(TAILORED_PHRASE),
        (go.facts?.text ?? '').slice(0, 300)
      );
      check('...with no ATS OPTIMIZATION pill and no Manual Edits box (nothing was tailored)', go.shown && !go.facts.ats && !go.facts.manual, JSON.stringify({ ats: go.facts?.ats, manual: go.facts?.manual }));
      await shoot(bp, 'b-2-suitable-go-preview');
      await closePreview(bp);

      const react = await previewFor(bp, { mode: 'suitable', role: REACT_ROLE, posting: REACT_POSTING });
      check(
        `Choose Suitable Resume, React posting: the React resume ("${REACT_ROLE}"), drawn as written`,
        react.shown &&
          react.facts.choice.startsWith(REACT_ROLE) &&
          react.facts.text.includes(REACT_SUMMARY_PHRASE) &&
          !react.facts.text.includes(GO_SUMMARY_PHRASE) &&
          !react.facts.ats &&
          !react.facts.manual,
        JSON.stringify({ fallback: react.fallback, choice: react.facts?.choice, ats: react.facts?.ats })
      );
      await shoot(bp, 'b-3-suitable-react-preview');
      await closePreview(bp);

      if (BACKEND_LOG) {
        const calls = await callsSince(window0);
        check(
          'the two Choose Suitable Resume previews asked the seat for the postings\' analyses and for no tailoring and no cover letter',
          calls.length > 0 && !calls.includes('tailor-resume') && !calls.includes('generate-cover-letter') && calls.every((site) => ['analyze-job-description', 'filter-google-sheet-job'].includes(site)),
          JSON.stringify(calls)
        );
      } else {
        skip('the Suitable previews asked the seat for no tailoring and no cover letter', 'E2E_BACKEND_LOG is not set');
      }
    });

    await section('builder: Partial Tailor previews the matched resume tailored', async () => {
      const partial = await previewFor(bp, { mode: 'partial', role: GO_ROLE, posting: GO_POSTING });
      check(
        'Partial Tailor, Go posting: the matched Go resume, named with the mode',
        partial.shown && partial.facts.choice.startsWith(GO_ROLE) && /Partial Tailor/.test(partial.facts.choice),
        JSON.stringify({ fallback: partial.fallback, choice: partial.facts?.choice })
      );
      check(
        '...tailored: the ATS OPTIMIZATION pill and the Manual Edits box are there',
        partial.shown && partial.facts.ats && partial.facts.manual,
        JSON.stringify({ ats: partial.facts?.ats, manual: partial.facts?.manual })
      );
      check(
        "...and the summary is the tailoring's, not the resume's own",
        partial.shown && partial.facts.text.includes(TAILORED_PHRASE) && !partial.facts.text.includes(GO_SUMMARY_PHRASE),
        (partial.facts?.text ?? '').slice(0, 300)
      );
      await shoot(bp, 'b-4-partial-preview');
      await closePreview(bp);
    });

    await section("builder: Fully Tailor previews the profile's default resume", async () => {
      const full = await previewFor(bp, { mode: 'full', role: GO_ROLE, posting: GO_POSTING });
      check(
        "Fully Tailor, Go posting: the profile's DEFAULT resume (the React one), not the match, said as such",
        full.shown && full.facts.choice.startsWith(REACT_ROLE) && /Fully Tailor: the profile's default resume/.test(full.facts.choice) && /the default resume for this job/.test(full.facts.page),
        JSON.stringify({ fallback: full.fallback, choice: full.facts?.choice })
      );
      check(
        '...tailored: pill, Manual Edits and the tailoring\'s sentence',
        full.shown && full.facts.ats && full.facts.manual && full.facts.text.includes(TAILORED_PHRASE),
        JSON.stringify({ ats: full.facts?.ats, manual: full.facts?.manual })
      );
      await shoot(bp, 'b-5-full-preview');
      await closePreview(bp);
    });

    /* ----------------------------------------------- built, and read back */
    async function buildAndRead(mode) {
      const before = logSize();
      const placed = await asBasic('/generation/batches', {
        method: 'POST',
        body: JSON.stringify({
          mode: 'order',
          label: `E2E ${mode}`,
          profileId: state.pat,
          buildMode: mode,
          jobs: [{ companyName: 'Acme Works', role: GO_ROLE, jobDescription: GO_POSTING }],
        }),
      });
      if (placed.status !== 202) return { placed, before };
      const finished = await untilValue(
        async () => (await asBasic(`/orders/${placed.body.orderId}`)).body,
        (order) => order && order.state !== 'running' && order.items?.length === 1 && !['queued', 'running'].includes(order.items[0].state),
        180_000
      );
      const item = finished.last?.items?.[0];
      let text = '';
      let pdfError = '';
      if (item && item.state === 'done') {
        try {
          text = await pdfText(await fetchBuffer(tokens.basic, `/orders/${placed.body.orderId}/items/${item.id}/resume-pdf`));
        } catch (error) {
          pdfError = String(error?.message || error);
        }
      }
      return { placed, before, order: finished.last, item, text, pdfError };
    }

    const built = {};
    await section('builder: each mode built as an order, the resume PDF read back', async () => {
      built.suitable = await buildAndRead('suitable');
      const s = built.suitable;
      check(
        'Choose Suitable Resume: the order is accepted for that mode, one resume',
        s.placed.status === 202 && s.placed.body?.buildMode === 'suitable' && s.placed.body?.total === 1,
        JSON.stringify(s.placed.body)
      );
      check(
        'the order item names the resume it chose (the Go one) and why: mode suitable, matched on the title and terms',
        s.item?.resumeLabel === GO_ROLE && s.item?.profileLabel === 'Pat Match' && s.item?.match?.mode === 'suitable' && ['matched', 'tie'].includes(s.item?.match?.reason) && s.item?.match?.candidates === 2,
        JSON.stringify({ label: s.item?.resumeLabel, profile: s.item?.profileLabel, match: s.item?.match })
      );
      check(
        "its resume PDF prints the chosen resume's own summary, not a tailored one",
        s.text.includes(GO_SUMMARY_PHRASE) && !s.text.includes(TAILORED_PHRASE),
        s.pdfError || s.text.slice(0, 300)
      );
      check('it was charged $0.01, the mode\'s price', s.item?.costMilli === 10, String(s.item?.costMilli));
      if (BACKEND_LOG) {
        const calls = await callsSince(s.before);
        check(
          'the stub seat saw only cover-letter calls for it: the posting was already analysed and nothing was tailored',
          calls.length > 0 && calls.every((site) => site === 'generate-cover-letter'),
          JSON.stringify(calls)
        );
      } else {
        skip('the stub seat saw only cover-letter calls for Choose Suitable Resume', 'E2E_BACKEND_LOG is not set');
      }

      built.partial = await buildAndRead('partial');
      const p = built.partial;
      check(
        'Partial Tailor: accepted, builds the matched Go resume, match mode partial',
        p.placed.status === 202 && p.item?.resumeLabel === GO_ROLE && p.item?.match?.mode === 'partial',
        JSON.stringify({ placed: p.placed.status, label: p.item?.resumeLabel, match: p.item?.match })
      );
      check("its PDF prints the tailoring's sentence, not the resume's own summary", p.text.includes(TAILORED_PHRASE) && !p.text.includes(GO_SUMMARY_PHRASE), p.pdfError || p.text.slice(0, 300));
      check('it was charged $0.02', p.item?.costMilli === 20, String(p.item?.costMilli));
      if (BACKEND_LOG) {
        const calls = await callsSince(p.before);
        check('no posting was analysed again for it', !calls.includes('analyze-job-description') && !calls.includes('filter-google-sheet-job'), JSON.stringify(calls));
      }

      built.full = await buildAndRead('full');
      const f = built.full;
      check(
        "Fully Tailor: accepted, builds the profile's default (the React resume), reason default",
        f.placed.status === 202 && f.item?.resumeLabel === REACT_ROLE && f.item?.match?.mode === 'full' && f.item?.match?.reason === 'default',
        JSON.stringify({ placed: f.placed.status, label: f.item?.resumeLabel, match: f.item?.match })
      );
      check("its PDF prints the tailoring's sentence", f.text.includes(TAILORED_PHRASE) && !f.text.includes(REACT_SUMMARY_PHRASE), f.pdfError || f.text.slice(0, 300));
      check('it was charged $0.03', f.item?.costMilli === 30, String(f.item?.costMilli));

      const detail = await asBasic(`/orders/${s.placed.body?.orderId}`);
      await bp.goto(`${APP}/orders/${encodeURIComponent(s.placed.body?.orderId || '')}`, { waitUntil: 'networkidle2' });
      const line = await until(bp, () => /Suitable resume: /.test(document.querySelector('[data-order-choice]')?.textContent ?? ''), 15_000);
      const row = await bp.evaluate(() => document.querySelector('tbody tr td:nth-child(2)')?.innerText.replace(/\s+/g, ' ') ?? '');
      check(
        "the order's page prints the item as \"Pat Match · Golang Backend Specialist\" with how it was chosen under it",
        line && row.includes(`Pat Match · ${GO_ROLE}`) && detail.status === 200,
        row
      );
    });

    /* ----------------------------------------------- an order placed from the page */
    await section('builder: Order from the page ends in a receipt that names the mode and the profile', async () => {
      await bp.goto(`${APP}/`, { waitUntil: 'networkidle2' });
      await pressButton(bp, 'Building Manually', '', true);
      await until(bp, () => Boolean(document.getElementById('manual-profile')) && document.getElementById('manual-profile').options.length > 1, 30_000);
      await setValue(bp, 'input[placeholder="Enter company name"]', 'Acme Works');
      await setValue(bp, 'input[placeholder^="Taken from the job description"]', GO_ROLE);
      await setValue(bp, 'textarea[placeholder^="Paste the job description"]', GO_POSTING);
      await clickSelector(bp, 'input[name="manualBuildMode"][value="suitable"]');
      const auto = await bp.evaluate(() => document.body.innerText.includes('Auto-generate (On)'));
      if (!auto) {
        await bp.evaluate(() => {
          const toggle = Array.from(document.querySelectorAll('label input[type="checkbox"]')).find((input) => /switch/.test(input.closest('label').className));
          toggle?.click();
        });
      }
      const orderOffered = await until(bp, () => Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Order' && !b.disabled), 15_000);
      await pressButton(bp, 'Order');
      const confirmed = await until(bp, () => Boolean(document.querySelector('[role="dialog"]')) || /You ordered successfully/.test(document.body.innerText), 20_000);
      if (await dialogText(bp)) await pressButton(bp, 'Proceed', 'dialog');
      const receipt = await until(bp, () => /You ordered successfully/.test(document.body.innerText), 30_000);
      const sentence = await until(bp, () => /1 resume for 1 job is being built: Choose Suitable Resume for Pat Match\./.test(document.body.innerText.replace(/\s+/g, ' ')), 10_000);
      const finishedAlready = await bp.evaluate(() => /This order has finished/.test(document.body.innerText));
      check(
        'Order places the run and the receipt says "1 resume for 1 job is being built: Choose Suitable Resume for Pat Match."',
        orderOffered && confirmed && receipt && (sentence || finishedAlready),
        flat(await bodyText(bp)).slice(0, 400)
      );
      if (!sentence && finishedAlready) console.log('NOTE  the order finished before the receipt could be read; the sentence itself was not seen.');
      await shoot(bp, 'b-6-order-receipt');
    });

    /* ---------------------------------------- the builder at 390px and dark */
    await section('builder: 390px and dark mode', async () => {
      await bp.setViewport(PHONE);
      await bp.goto(`${APP}/`, { waitUntil: 'networkidle2' });
      await pressButton(bp, 'Building Manually', '', true);
      await until(bp, () => Boolean(document.querySelector('input[name="manualBuildMode"]')), 30_000);
      const phone = await bp.evaluate(() => {
        const labels = ['suitable', 'partial', 'full'].map((mode) => document.querySelector(`input[name="manualBuildMode"][value="${mode}"]`)?.closest('label')?.getBoundingClientRect());
        return {
          found: labels.every(Boolean),
          inside: labels.every((box) => box && box.left >= 0 && box.right <= window.innerWidth + 1),
          stacked: new Set(labels.map((box) => Math.round(box?.top ?? -1))).size === 3,
        };
      });
      check('at 390 the three mode cards stack inside the window, with no sideways scroll', phone.found && phone.inside && phone.stacked && (await overflow(bp)) <= 1, JSON.stringify({ phone, overflow: await overflow(bp) }));
      await shoot(bp, 'b-7-builder-390', true);
      await bp.setViewport(WIDE);

      const dark = await newPage(browser, tokens.basic, WIDE, 'dark');
      await dark.goto(`${APP}/`, { waitUntil: 'networkidle2' });
      await pressButton(dark, 'Building Manually', '', true);
      await until(dark, () => Boolean(document.querySelector('input[name="manualBuildMode"]')), 30_000);
      const darkFacts = await dark.evaluate(() => {
        const lightness = (element) => {
          for (let node = element; node; node = node.parentElement) {
            const found = getComputedStyle(node).backgroundColor.match(/[\d.]+/g) || [];
            if (found.length >= 3 && (found.length < 4 || Number(found[3]) > 0.5)) {
              return (Number(found[0]) * 299 + Number(found[1]) * 587 + Number(found[2]) * 114) / 1000;
            }
          }
          return 255;
        };
        const card = document.querySelector('input[name="manualBuildMode"][value="partial"]')?.closest('label');
        return {
          isDark: document.documentElement.classList.contains('dark'),
          body: lightness(document.body),
          card: card ? lightness(card) : 255,
          hasCard: Boolean(card),
        };
      });
      check('in dark mode the builder and its mode cards are dark', darkFacts.isDark && darkFacts.hasCard && darkFacts.body < 128 && darkFacts.card < 200, JSON.stringify(darkFacts));
      await shoot(dark, 'b-8-builder-dark');
      await dark.close();
    });

    /* ----------------------------------------------------------- the end */
    check('no page threw an uncaught error along the way', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }

  const skipNote = skips > 0 ? ` (${skips} more skipped)` : '';
  console.log(failures === 0 ? `\nAll ${claims} checks passed${skipNote}.` : `\n${failures} of ${claims} check(s) FAILED${skipNote}.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

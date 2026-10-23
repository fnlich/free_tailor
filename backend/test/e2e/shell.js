/*
 * The app shell, on every page, as all three roles, in both themes.
 *
 * The frontend has no test suite - `next build` proves it compiles and nothing
 * proves it renders - so this is what stands between a navigation rewrite and
 * a page that silently lost its chrome or grew a horizontal scrollbar.
 *
 * It asserts the things a screenshot would not make obvious:
 *   - exactly one top bar and one sidebar, on every route
 *   - no horizontal overflow at either width
 *   - the sidebar is actually on top at its own corner, not painted over
 *   - the right entries appear for the right role
 *   - a reporter reaches Report Jobs, Credits and Settings -> Account / Job
 *     Sheet, and every other address sends them to Report Jobs without
 *     mounting the page - so not one request of theirs is refused for their
 *     role; a user made a reporter mid-session is taken there too, or, on
 *     a page a reporter keeps, sees Settings -> Account drawn as a reporter's
 *   - an administrator sets a reporter's rate and records a payout on Accounts
 *   - what a subscription does not include is drawn LOCKED, never hidden, and
 *     there is ONE such thing now: the New profile tile at the tier's limit
 *     (More profiles, with the lock icon, opening "Locked: More profiles"
 *     with Go to subscription). The rail has no row for the old list page and no locked row;
 *     the builder locks nothing on a run - one profile select and the three
 *     build modes are open for every tier; the Subscription page's cards,
 *     one row wide and one column at 390
 *   - hiding is not the protection: the API refuses an ordinary user directly
 *
 * The session is seeded and injected, because there is no offline sign-in -
 * the same trick browser.js uses for the payment walkthrough. Servers are
 * expected to be up already, the backend preloaded with the stub seat and the
 * sheets stub and sharing DB_DIR with this script, which writes the sessions
 * and the reporter's balance straight into that database. Not the root dev
 * script, nor any backend started without a preload: it finds a real Google
 * credential when backend/ holds one, and every account this signs in gets a
 * REAL spreadsheet (README.md, at the top). From backend/:
 *
 *   DB_DIR=/path/to/db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js --require ./test/e2e/stub-sheets.js dist/index.js
 *   # the frontend, built against that backend, in another terminal; then
 *   DB_DIR=/path/to/db node test/e2e/shell.js
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const creditLedger = require(path.join(DIST, 'database', 'creditRepository'));
const { formatMoney } = require(path.join(DIST, 'utils', 'money'));
const { saveResume } = require(path.join(DIST, 'database', 'resumeRepository'));
const { buildNewResume } = require(path.join(DIST, 'services', 'resumeDocument'));

const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Every route a signed-in person can reach. */
const ROUTES = [
  '/',
  '/settings',
  '/settings/job-sheet',
  '/settings/payment-methods',
  '/settings/subscription',
  '/orders',
  '/credits',
  '/jobs',
  '/jobs/filter',
  '/bid-assistant',
  '/calendar',
  '/admin/profiles',
  // The dashboard's second tab, a profile that is nobody's (the page says so)
  // and the template chooser: all three are desk pages under the shell, and
  // the old list page's address is not among them any more - it is a Next 404, checked once
  // below.
  '/admin/profiles?tab=resumes',
  '/admin/profiles/no-such',
  '/admin/resumes/new',
  '/admin/templates',
];

/**
 * A reporter's own pages (owner decision A3). Every other address - ROUTES,
 * ADMIN_ROUTES and the ones below - sends them to Report Jobs.
 */
const REPORTER_ROUTES = ['/report', '/credits', '/settings', '/settings/job-sheet'];

/** Addresses outside both lists above that a reporter must be sent away from too. */
const REPORTER_ELSEWHERE = [
  '/admin',
  '/admin/resumes/no-such-resume',
  '/orders/no-such-order',
  '/credits/invoice?payment=no-such-payment',
  '/credits/return',
];

/** Administrator-only on top of those. */
const ADMIN_ROUTES = [
  '/admin/settings',
  '/admin/google-sheets',
  '/admin/prompts',
  '/admin/models',
  '/admin/skills',
  '/admin/notifications',
  '/admin/payments',
  '/admin/job-lake',
  '/admin/accounts',
  '/test',
];

let failures = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

async function signIn(page, token) {
  // Both halves of what a real sign-in leaves behind, because the app uses
  // both. The API client sends the localStorage copy as a bearer header; the
  // cookie is what an <iframe> carries, and the template previews are iframes
  // pointed straight at the API - with only the header they render the API's
  // "sign in to do that" JSON instead of a resume.
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => window.localStorage.setItem('adminToken', value), token);
  await page.setCookie({
    name: 'ft_session',
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
}

async function setTheme(page, theme) {
  await page.evaluate((value) => {
    window.localStorage.setItem('tailor-theme', value);
  }, theme);
}

/**
 * The top bar's own geometry and the order of its controls.
 *
 * Separate from `inspect` because the question is different, and because the
 * metric there cannot answer it. `documentElement.scrollWidth` is what catches
 * a page that grew a horizontal scrollbar - but `.tl-topbar` is
 * `position: fixed`, so anything hanging off its end does not extend the
 * document at all. The bar overflowed by 6px at 390 for as long as that check
 * has existed, and it passed every time, because the 6px is not scrollable -
 * it is simply off the screen, where nobody can reach it.
 */
async function inspectTopBar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.tl-topbar');
    if (!bar) return null;
    const viewport = window.innerWidth;

    let worst = 0;
    let culprit = '';
    for (const node of bar.querySelectorAll('*')) {
      const box = node.getBoundingClientRect();
      if (box.width === 0) continue;
      const past = Math.round(box.right - viewport);
      if (past > worst) {
        worst = past;
        culprit = `${node.tagName}.${(node.className || '').toString().slice(0, 48)}`;
      }
    }

    /*
     * Read by position rather than by DOM order, so the check describes what
     * somebody sees. A flex row can be reordered in CSS without the markup
     * moving, and the spec is about the row.
     */
    const group = bar.lastElementChild;
    const controls = Array.from(
      (group || bar).querySelectorAll('a[title], button[aria-label], button[title], .tl-credits')
    )
      .map((node) => ({
        name:
          node.getAttribute('title') ||
          node.getAttribute('aria-label') ||
          (node.classList.contains('tl-credits') ? 'Credits' : ''),
        left: node.getBoundingClientRect().left,
      }))
      .filter((entry) => entry.name)
      .sort((left, right) => left.left - right.left)
      .map((entry) => entry.name);

    const wordmark = bar.querySelector('.tl-brand span');
    return {
      viewport,
      past: worst,
      culprit,
      controls,
      /*
       * The product name, and whether all of it is there.
       *
       * The spec for this bar begins "Top Left: brand and logo and
       * name(Tailor)", and the first fix for the bar's overflow spent exactly
       * that: letting the brand shrink rendered the wordmark as "Tai..." at
       * 390 and as nothing at all once the credit balance ran to six figures.
       * The app says its own name in one place, so this is the one string in
       * the bar that may not be shortened to make room.
       */
      brand: wordmark
        ? { text: wordmark.textContent.trim(), whole: wordmark.scrollWidth <= wordmark.clientWidth + 1 }
        : null,
    };
  });
}

/** A pause, for the ticks React needs to mount or unmount a panel. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';

/** A fetch against the API, signed in with `token`. */
const apiAs = (token) => (route, init = {}) =>
  fetch(`${API}${route}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

/**
 * Opens the Bid Assistant on the job this walkthrough put on the board, and
 * reads the job's own buttons. Every date is listed first, so the job is found
 * whatever else is on the board and whichever date the page opens on.
 */
async function openSeededJob(page, company) {
  await page.goto(`${APP}/bid-assistant`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.job-card', { timeout: 10_000 }).catch(() => null);
  const [, dateFilter] = await page.$$('.top-bar-left select');
  if (dateFilter) await dateFilter.select('');
  await wait(600);
  const found = await page.evaluate((needle) => {
    const card = Array.from(document.querySelectorAll('.job-card')).find((c) => c.textContent.includes(needle));
    card?.click();
    return Boolean(card);
  }, company);
  await wait(400);
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.workspace-actions button')).map((b) => b.textContent.trim())
  );
  return { found, buttons };
}

/**
 * Opens Build Resumes and presses one of its two entry cards ("Building
 * Manually", "Building Automatically from Google Sheet").
 */
async function openBuilder(page, card) {
  await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
  // Waited for, then pressed until it takes: the card is drawn only once the
  // account has loaded, and a press that lands before the production page has
  // hydrated does nothing. Opened is the card gone - the builder replaces the
  // two entry cards - after at least one press.
  let pressed = false;
  try {
    await page.waitForFunction(
      (label) => {
        const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes(label));
        if (!button) return window.__e2eBuilderPressed === true;
        window.__e2eBuilderPressed = true;
        button.click();
        return false;
      },
      { timeout: 15_000, polling: 300 },
      card
    );
    pressed = true;
  } catch {
    pressed = false;
    const seen = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 400) }));
    console.log(`        openBuilder(${card}) did not open: ${JSON.stringify(seen)}`);
  }
  await wait(500);
  return pressed;
}

/**
 * What the builder draws to choose WHO a run builds for and HOW (owner
 * decision 10: one profile per run, on every subscription): the profile
 * select (`selectId`: manual-profile or sheets-profile), the three build-mode
 * cards (radios named `radioName`: manualBuildMode or sheetsBuildMode,
 * components/builder/BuildModeChoice.tsx), the note under them, and every
 * lock or retired control still on the page. Waits for the select to hold a
 * profile: the page reads the account's profiles after its first paint.
 */
async function readBuildOptions(page, selectId, radioName) {
  await page
    .waitForFunction(
      (id) => {
        const select = document.getElementById(id);
        return (select?.options.length ?? 0) > 1 && select.value !== '';
      },
      { timeout: 15_000, polling: 250 },
      selectId
    )
    .catch(() => null);
  return page.evaluate(
    (id, name) => {
      const select = document.getElementById(id);
      return {
        select: select
          ? {
              value: select.value,
              disabled: select.disabled,
              options: Array.from(select.options).map((option) => option.textContent.trim()),
            }
          : null,
        modes: Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`)).map((input) => ({
          value: input.value,
          checked: input.checked,
          disabled: input.disabled,
          locked: Boolean(input.closest('[data-locked-choice]')),
          label: input.closest('label')?.querySelector('.font-medium')?.textContent.trim() ?? '',
          hint: input.closest('label')?.querySelector('[data-choice-hint]')?.textContent.trim() ?? '',
        })),
        // The narrowest card's text: three cards squeezed into the 22rem sidebar left about 37px of it.
        narrowestHint: Math.min(
          ...Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`)).map(
            (input) => input.closest('label')?.querySelector('[data-choice-hint]')?.getBoundingClientRect().width ?? 0
          )
        ),
        // Any lock at all, anywhere on the page: a run has none.
        locks: document.querySelectorAll('[data-locked-choice], [data-locked-feature]').length,
        // The Single / Multiple switch and every several-profile target: all gone.
        retired: ['generateMode', 'multipleTarget', 'sheetsTargetMode'].filter((retiredName) =>
          document.querySelector(`input[name="${retiredName}"]`)
        ),
        note: document.querySelector('[data-build-mode-note]')?.textContent.trim() ?? '',
      };
    },
    selectId,
    radioName
  );
}

/** The three modes, in the order the cards are drawn, as the server names them. */
const BUILD_MODE_ORDER = ['suitable', 'partial', 'full'];
const BUILD_MODE_LABELS = ['Choose Suitable Resume', 'Partial Tailor', 'Fully Tailor'];

/** Open as a run needs them: a profile chosen from the select, three cards, none disabled, none locked, one chosen. */
const buildOptionsAreOpen = (options) =>
  Boolean(options.select) &&
  !options.select.disabled &&
  options.select.value !== '' &&
  options.select.options.length >= 2 &&
  options.modes.map((mode) => mode.value).join() === BUILD_MODE_ORDER.join() &&
  options.modes.map((mode) => mode.label).join() === BUILD_MODE_LABELS.join() &&
  options.modes.every((mode) => !mode.disabled && !mode.locked) &&
  options.modes.filter((mode) => mode.checked).length === 1 &&
  options.narrowestHint >= 140 &&
  options.locks === 0 &&
  options.retired.length === 0;

/**
 * Presses `selector` and reads the lock's dialog it opens: its title, its
 * text, where Go to subscription leads - then presses Close and says whether
 * the dialog went.
 */
async function openLock(page, selector) {
  const pressed = await page.evaluate((target) => {
    const element = document.querySelector(target);
    element?.click();
    return Boolean(element);
  }, selector);
  if (!pressed) return null;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const dialog = await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    if (!panel) return null;
    const go = Array.from(panel.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Go to subscription');
    return {
      title: panel.querySelector('h2')?.textContent.trim() ?? '',
      text: panel.innerText,
      goHref: go ? go.getAttribute('href') : null,
      close: Array.from(panel.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Close'),
    };
  });
  await page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    Array.from(panel?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Close')?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const closed = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
  return dialog ? { ...dialog, closed } : null;
}

/** A lock's dialog as the lock icon promises it: "Locked: <what>", Go to subscription, and Close that closes it. */
const isLockDialog = (dialog, title) =>
  Boolean(dialog) &&
  dialog.title === `Locked: ${title}` &&
  dialog.goHref === '/settings/subscription' &&
  dialog.close &&
  dialog.closed &&
  !/\bplans?\b/i.test(dialog.text);

/** What the shell looks like from inside the page. */
async function inspect(page) {
  return page.evaluate(() => {
    const bars = document.querySelectorAll('.tl-topbar');
    const rails = document.querySelectorAll('.tl-sidebar');
    const rail = rails[0];
    const railBox = rail ? rail.getBoundingClientRect() : null;

    let railOnTop = true;
    if (railBox && railBox.width > 0) {
      // Hit-test just inside the rail's top-right corner: if something else
      // answers, a fixed element is painting over the navigation.
      const hit = document.elementFromPoint(railBox.right - 6, railBox.top + 12);
      railOnTop = Boolean(hit && (hit === rail || rail.contains(hit)));
    }

    return {
      bars: bars.length,
      rails: rails.length,
      railWidth: railBox ? Math.round(railBox.width) : 0,
      railOnTop,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      // A `md:hidden` here would not work: every .tl-* rule is unlayered and
      // beats Tailwind's layered utilities, so the shell's own `display` wins.
      // Asserting the computed value is the only way to catch that.
      drawerTriggerShown: (() => {
        const trigger = document.querySelector('.tl-drawer-trigger');
        if (!trigger) return false;
        return getComputedStyle(trigger).display !== 'none';
      })(),
      navLabels: Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item')).map((a) =>
        a.textContent.trim()
      ),
      activeLabels: Array.from(
        document.querySelectorAll('.tl-sidebar .tl-nav-item[data-active="true"]')
      ).map((a) => a.textContent.trim()),
      isDark: document.documentElement.classList.contains('dark'),
    };
  });
}

async function visit(page, route, label, { expectRail = true, compact = false } = {}) {
  await page.goto(`${APP}${route}`, { waitUntil: 'networkidle2' });
  // Give the shell a beat to settle after hydration.
  await new Promise((resolve) => setTimeout(resolve, 350));

  const shell = await inspect(page);

  check(`${label} ${route}: one top bar`, shell.bars === 1, `found ${shell.bars}`);
  check(`${label} ${route}: one sidebar`, shell.rails === 1, `found ${shell.rails}`);

  if (expectRail) {
    check(
      `${label} ${route}: sidebar is not painted over`,
      shell.railOnTop,
      'something is stacking above the navigation at its own corner'
    );
  }

  check(
    `${label} ${route}: no horizontal scrollbar`,
    shell.scrollWidth <= shell.clientWidth + 1,
    `scrollWidth ${shell.scrollWidth} > clientWidth ${shell.clientWidth}`
  );

  check(
    `${label} ${route}: at most one active nav row`,
    shell.activeLabels.length <= 1,
    `lit: ${shell.activeLabels.join(', ')}`
  );

  check(
    `${label} ${route}: the drawer button is ${compact ? 'shown' : 'hidden'}`,
    shell.drawerTriggerShown === compact,
    compact
      ? 'there is no way to open the navigation on a phone'
      : 'a hamburger next to a sidebar that is already open'
  );

  return shell;
}

async function main() {
  const stamp = Date.now().toString(36);
  const user = users.createUser({ email: `e2e-shell-${stamp}@example.com`, name: 'Shell User' });
  const admin = users.findOrCreateUser({ email: 'boss@example.com' }).account;
  // On Default on purpose: nothing may lock for an administrator, the New
  // profile tile included, whatever their own subscription (owner decision B1).
  users.updateUser(admin.id, { role: 'admin', subscription: 'default' });

  const userToken = users.createSession(user.id);
  const adminToken = users.createSession(admin.id);

  /*
   * One resume each, put straight into the database (the raw writer files a
   * new resume under a profile of its person, and counts no limit): the user
   * ends with ONE profile - the Default subscription's whole allowance, so the
   * New profile tile is locked for them - and the builder's profile select has
   * a person to offer both of them. A resume's name is its person's.
   */
  const seedResume = (ownerId, id, name) =>
    saveResume({
      ...buildNewResume(
        {
          name,
          title: 'Engineer',
          contact: { email: 'ada@example.com', phone: '1', location: 'Remote' },
          summary: 'Engineer.',
          experience: [],
          skills: ['TypeScript'],
          education: [],
        },
        id
      ),
      ownerId,
    });
  const userResumeId = `r-shell-${stamp}`;
  seedResume(user.id, userResumeId, 'Ada Shell');
  seedResume(admin.id, `r-shell-admin-${stamp}`, 'Ada Shell Admin');

  /*
   * A reporter, with earnings to be paid out: the administrator records part
   * of it from the Accounts page below, and the reporter then finds the
   * payout in their own history.
   */
  const reporter = users.createUser({ email: `e2e-shell-reporter-${stamp}@example.com`, name: 'Shell Reporter' });
  users.updateUser(reporter.id, { role: 'reporter' });
  creditLedger.applyAdjustment({
    userId: reporter.id,
    deltaMilli: 7_250,
    reason: 'admin-grant',
    idempotencyKey: `e2e-shell-reporter:${reporter.id}`,
    note: 'e2e shell: earnings to pay out',
  });
  const reporterToken = users.createSession(reporter.id);

  /*
   * One job on the Bid Assistant board, for the Delete Job checks to have a
   * job to be offered on. With none, no job is selected and no job's buttons
   * are drawn for anybody, so "no Delete Job" passed with the gate removed.
   * Put there through the user's own import, and taken off again at the end by
   * the administrator: the board is shared.
   */
  const today = new Date();
  const seededJob = { company: `E2E shell ${stamp}`, url: `https://example.com/e2e-shell/${stamp}` };
  const seeded = await apiAs(userToken)('/bid-assistant/import-jobs', {
    method: 'POST',
    body: JSON.stringify([
      {
        company_name: seededJob.company,
        job_title: 'Shell walkthrough job',
        job_url: seededJob.url,
        posted_date: `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`,
      },
    ]),
  });
  const seededBody = await seeded.json().catch(() => null);
  check(
    'setup: a job is put on the Bid Assistant board',
    seeded.status === 200 && seededBody?.addedCount === 1,
    `got ${seeded.status} ${JSON.stringify(seededBody)}`
  );
  let seededJobGone = false;
  const removeSeededJob = async () => {
    const asAdmin = apiAs(adminToken);
    const listed = await (await asAdmin(`/bid-assistant/jobs?search=${encodeURIComponent(seededJob.company)}`))
      .json()
      .catch(() => null);
    const row = Array.isArray(listed) ? listed.find((job) => job.job_url === seededJob.url) : null;
    if (!row) return 'not listed';
    const response = await asAdmin(`/bid-assistant/jobs/${row.id}`, { method: 'DELETE' });
    if (response.status === 200) seededJobGone = true;
    return response.status;
  };

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  try {
    /* ---------------------------------------------- ordinary user, wide */
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    await signIn(page, userToken);
    await setTheme(page, 'light');

    let shell;
    /** Every page that offered anything that asks for a refund - none may (owner decision R1). */
    const askingPages = [];
    const offersAsk = (target) =>
      target.evaluate(() =>
        Array.from(document.querySelectorAll('button, a')).some((node) => /ask for (a )?refund/i.test(node.textContent))
      );
    for (const route of ROUTES) {
      shell = await visit(page, route, 'user');
      if (await offersAsk(page)) askingPages.push(route);
    }

    /*
     * Settings -> Account -> Resume files (owner decisions O3, O5): the
     * account's own folder path, its tokens as chips that insert at the caret,
     * and the server's preview - a refusal shown before anything is saved.
     */
    await page.goto(`${APP}/settings`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-preview-path]', { timeout: 10_000 }).catch(() => null);
    const resumeFiles = await page.evaluate(() => ({
      heading: Array.from(document.querySelectorAll('.tl-section h2')).some((h) => h.textContent.trim() === 'Resume files'),
      value: document.getElementById('settings-output-path-suffix')?.value ?? null,
      chips: Array.from(document.querySelectorAll('[data-token]')).map((b) => b.textContent.trim()),
      preview: document.querySelector('[data-preview-path]')?.textContent.trim() ?? null,
      source: document.querySelector('[data-suffix-source]')?.textContent.trim() ?? null,
    }));
    check(
      'user /settings: Resume files shows the folder path in effect, its five tokens as chips and the server-drawn preview',
      resumeFiles.heading &&
        resumeFiles.value === '/{{date}}/{{profile_name}}/{{company_name}}/{{role}}' &&
        resumeFiles.chips.join(' ') === '{{date}} {{profile_name}} {{company_name}} {{role}} {{row_number}}' &&
        /^\/[a-z0-9_]+\/ft_\d{8}_0001\/\d{4}_\d{2}_\d{2}\//.test(resumeFiles.preview ?? '') &&
        /^Default/.test(resumeFiles.source ?? ''),
      JSON.stringify(resumeFiles)
    );
    // A chip lands at the caret, not at the end.
    await page.evaluate(() => {
      const box = document.getElementById('settings-output-path-suffix');
      box.focus();
      box.setSelectionRange(1, 1);
    });
    await page.click('[data-token="row_number"]');
    await wait(500);
    const afterChip = await page.$eval('#settings-output-path-suffix', (box) => ({ value: box.value, caret: box.selectionStart }));
    check(
      'user /settings: a chip inserts its token at the caret',
      afterChip.value === '/{{row_number}}{{date}}/{{profile_name}}/{{company_name}}/{{role}}' && afterChip.caret === 15,
      JSON.stringify(afterChip)
    );
    // A token from the administrator's half is refused in the server's words, before any save.
    await page.$eval('#settings-output-path-suffix', (box) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(box, '/{{order_number}}');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForSelector('[data-preview-problems]', { timeout: 10_000 }).catch(() => null);
    const refusedSuffix = await page.evaluate(() => ({
      problems: document.querySelector('[data-preview-problems]')?.textContent.trim() ?? null,
      save: Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Save')?.disabled ?? null,
    }));
    check(
      "user /settings: a token in the administrator's place is refused under the box, by name",
      /cannot use \{\{order_number\}\}/.test(refusedSuffix.problems ?? ''),
      JSON.stringify(refusedSuffix)
    );

    /*
     * The rail, in the order it was asked for. Find Jobs is a page of the
     * app now (/jobs), so it is always there - the account's sheet is its
     * "Go to my sheet" - and opens in the same tab like every other row.
     */
    const RAIL = [
      'Profiles',
      'Find Jobs',
      'Build Resumes',
      'Orders',
      'Credits',
      'Job Filter',
      'Bid Assistant',
      'Calendar',
      'Templates',
      'Settings',
    ];
    check(
      'user: the rail reads Profiles, Find Jobs, Build Resumes, Orders, Credits | Job Filter, Bid Assistant, Calendar | Templates, Settings',
      shell.navLabels.join(' / ') === RAIL.join(' / '),
      `saw: ${shell.navLabels.join(', ')}`
    );
    const findJobsRow = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item')).find((node) => node.textContent.trim() === 'Find Jobs');
      return row ? { tag: row.tagName, href: row.getAttribute('href'), target: row.getAttribute('target') } : null;
    });
    check(
      'user: Find Jobs is a same-tab link to /jobs',
      findJobsRow?.tag === 'A' && findJobsRow.href === '/jobs' && !findJobsRow.target,
      JSON.stringify(findJobsRow)
    );
    const assistantHeading = await page.evaluate(() =>
      document.querySelector('.tl-sidebar .tl-sidebar-label')?.textContent.trim()
    );
    check('user: the second group is headed Assistant', assistantHeading === 'Assistant', String(assistantHeading));
    check(
      'user: no Manage Accounts row - it is an Administration tab under Settings now',
      !shell.navLabels.includes('Manage Accounts'),
      `saw: ${shell.navLabels.join(', ')}`
    );

    /*
     * Settings is everybody's now: the account's own four tabs, and none of
     * the installation's - a row of doors that would all say "administrators
     * only" is worse than no row.
     */
    const userSettings = await visit(page, '/settings/subscription', 'user');
    const userTabs = await page.evaluate(() => ({
      tabs: Array.from(document.querySelectorAll('nav.tl-tabs[aria-label="Settings"] .tl-tab')).map((a) =>
        a.textContent.trim()
      ),
      active: document.querySelector('nav.tl-tabs[aria-label="Settings"] .tl-tab[data-active="true"]')?.textContent.trim(),
      title: document.querySelector('.tl-main h1')?.textContent.trim(),
    }));
    check(
      'user /settings/subscription: the four account tabs and no Administration',
      userTabs.tabs.join(' / ') === 'Account / Job Sheet / Payment Methods / Subscription',
      userTabs.tabs.join(', ')
    );
    check(
      'user /settings/subscription: Subscription is the lit tab, not Account',
      userTabs.active === 'Subscription',
      String(userTabs.active)
    );
    check('user /settings/subscription: titled Settings', userTabs.title === 'Settings', String(userTabs.title));
    check(
      'user /settings/subscription: the Settings row is the one lit in the rail',
      userSettings.activeLabels.join() === 'Settings',
      `lit: ${userSettings.activeLabels.join(', ')}`
    );

    await page.goto(`${APP}/settings/subscription`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tierCopy = await page.evaluate(() => document.querySelector('.tl-main')?.innerText ?? '');
    check(
      "user /settings/subscription: the page never calls the tier a plan",
      /Current subscription/.test(tierCopy) && !/\bplans?\b/i.test(tierCopy),
      tierCopy.slice(0, 300)
    );
    // The tiers as cards, side by side - Default current - with a price or "Not offered" on each.
    const tierCards = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-subscription-card]')).map((card) => ({
        id: card.getAttribute('data-subscription-card'),
        current: card.getAttribute('aria-current') === 'true',
        top: Math.round(card.getBoundingClientRect().top),
        text: card.innerText,
      }))
    );
    check(
      'user /settings/subscription: four cards in one row at 1440, Default the current one',
      tierCards.map((card) => card.id).join() === 'default,premium,premium-plus,premium-max' &&
        new Set(tierCards.map((card) => card.top)).size === 1 &&
        tierCards.find((card) => card.current)?.id === 'default',
      JSON.stringify(tierCards.map(({ id, current, top }) => ({ id, current, top })))
    );
    await page.setViewport(PHONE);
    await page.goto(`${APP}/settings/subscription`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tierPhone = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      columns: new Set(
        Array.from(document.querySelectorAll('[data-subscription-card]')).map((card) =>
          Math.round(card.getBoundingClientRect().left)
        )
      ).size,
    }));
    check(
      'user /settings/subscription at 390: one card a row, no horizontal scrollbar',
      tierPhone.overflow <= 1 && tierPhone.columns === 1,
      JSON.stringify(tierPhone)
    );
    await page.screenshot({ path: `${SHOTS}/shell-subscription-phone.png`, fullPage: true });
    await page.setViewport(WIDE);

    // An invoice is a document: no rail and no bar to print around it.
    await page.goto(`${APP}/credits/invoice?payment=no-such-payment`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const invoiceChrome = await page.evaluate(() => ({
      bars: document.querySelectorAll('.tl-topbar').length,
      rails: document.querySelectorAll('.tl-sidebar').length,
      print: document.querySelectorAll('[aria-label="Print invoice"]').length,
      text: document.body.innerText,
    }));
    check(
      'user /credits/invoice: drawn without the shell',
      invoiceChrome.bars === 0 && invoiceChrome.rails === 0,
      JSON.stringify({ bars: invoiceChrome.bars, rails: invoiceChrome.rails })
    );
    check(
      "user /credits/invoice: somebody else's or a made-up payment is not found",
      /not found/i.test(invoiceChrome.text),
      invoiceChrome.text.slice(0, 200)
    );
    check(
      'user /credits/invoice: no Print button when there is no invoice to print',
      invoiceChrome.print === 0,
      `print buttons: ${invoiceChrome.print}`
    );

    /*
     * A profile is a person and holds that person's resumes, so the rail has
     * one Profiles entry, open to every builder on every subscription, and no
     * locked row.
     */
    const ordersShell = await visit(page, '/orders', 'user');
    const railRows = await page.evaluate(() => ({
      locked: document.querySelectorAll('.tl-sidebar [data-locked-feature]').length,
    }));
    check('user: no locked row in the rail', railRows.locked === 0, JSON.stringify({ labels: ordersShell.navLabels, ...railRows }));

    /*
     * The builder locks nothing on a run (owner decision 10: ONE profile per
     * run, on every subscription). Both ways of building draw one profile
     * select (#manual-profile, #sheets-profile) and the three build modes as
     * cards (Choose Suitable Resume, Partial Tailor, Fully Tailor), every one
     * open on the Default subscription. The server refuses a list of profiles
     * (400 `one-profile-per-run`), so the page offers no door to one: no
     * Single / Multiple switch, no All profiles or list target, no picker for
     * several. The user has ONE profile, put in the database above.
     */
    check('user /: the Building Manually card opens', await openBuilder(page, 'Building Manually'));
    const manualOptions = await readBuildOptions(page, 'manual-profile', 'manualBuildMode');
    check(
      "user / manual: one profile select offering the user's profile, chosen",
      Boolean(manualOptions.select) &&
        !manualOptions.select.disabled &&
        manualOptions.select.value !== '' &&
        manualOptions.select.options.length === 2 &&
        /^Ada Shell .*\(\d+ resumes?\)$/.test(manualOptions.select.options[1]),
      JSON.stringify(manualOptions.select)
    );
    check(
      'user / manual: the three build modes are cards, every one open - none disabled, none locked, one chosen',
      buildOptionsAreOpen(manualOptions),
      JSON.stringify(manualOptions)
    );
    check(
      'user / manual: each mode card says what it does, and none names a subscription',
      manualOptions.modes.length === 3 &&
        manualOptions.modes.every((mode) => mode.hint.length > 20 && !/Premium|\bplans?\b/i.test(`${mode.label} ${mode.hint}`)),
      JSON.stringify(manualOptions.modes.map((mode) => [mode.label, mode.hint]))
    );
    // Choosing a mode changes the note under the cards: Fully Tailor builds
    // the profile's default resume, the other two choose among its resumes.
    await page.evaluate(() => document.querySelector('input[name="manualBuildMode"][value="full"]')?.click());
    const fullNote = await page
      .waitForFunction(() => /default resume/.test(document.querySelector('[data-build-mode-note]')?.textContent ?? ''), {
        timeout: 5_000,
        polling: 200,
      })
      .then(() => true, () => false);
    await page.evaluate(() => document.querySelector('input[name="manualBuildMode"][value="suitable"]')?.click());
    const suitableNote = await page
      .waitForFunction(
        () => /has one resume, so every job builds it\./.test(document.querySelector('[data-build-mode-note]')?.textContent ?? ''),
        { timeout: 5_000, polling: 200 }
      )
      .then(() => true, () => false);
    check(
      'user / manual: pressing a mode chooses it, and the note follows - Fully Tailor the default resume, Suitable the one resume it has',
      fullNote &&
        suitableNote &&
        (await readBuildOptions(page, 'manual-profile', 'manualBuildMode')).modes.find((mode) => mode.checked)?.value === 'suitable',
      JSON.stringify({ fullNote, suitableNote })
    );
    const importButton = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some((b) => /Import from Google Sheet/i.test(b.textContent))
    );
    check('user / manual: no "Import from Google Sheet" button', !importButton);

    check('user /: the Google Sheet card opens', await openBuilder(page, 'Building Automatically from Google Sheet'));
    const sheetOptions = await readBuildOptions(page, 'sheets-profile', 'sheetsBuildMode');
    check(
      "user / sheet: one profile select offering the user's profile, and the three build modes, every one open",
      buildOptionsAreOpen(sheetOptions) && /^Ada Shell /.test(sheetOptions.select?.options[1] ?? ''),
      JSON.stringify(sheetOptions)
    );
    check(
      'user / sheet: no target radios (Single, All profiles, a list of profiles), no picker for several, no lock anywhere',
      sheetOptions.retired.length === 0 && sheetOptions.locks === 0,
      JSON.stringify({ retired: sheetOptions.retired, locks: sheetOptions.locks })
    );
    const sheetPage = await page.evaluate(() => ({
      importButton: Array.from(document.querySelectorAll('button')).some((b) =>
        /Import from Google Sheet/i.test(b.textContent)
      ),
      fallbackRole: /Fallback Role/i.test(document.body.innerText),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    check(
      'user / sheet: no "Import from Google Sheet" button and no Fallback Role',
      !sheetPage.importButton && !sheetPage.fallbackRole,
      JSON.stringify(sheetPage)
    );
    check('user / sheet: no horizontal scrollbar', sheetPage.overflow <= 1, `overflow ${sheetPage.overflow}px`);

    await page.setViewport(PHONE);
    await openBuilder(page, 'Building Automatically from Google Sheet');
    const sheetPhone = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    check('user / sheet at 390: no horizontal scrollbar', sheetPhone <= 1, `overflow ${sheetPhone}px`);
    await page.screenshot({ path: `${SHOTS}/shell-builder-sheet-phone.png`, fullPage: true });
    await page.setViewport(WIDE);

    /*
     * The Profiles dashboard (owner decisions D11-D18): a profile is a PERSON
     * and holds that person's resumes. Profiles (N) and All resumes (M) are
     * two tabs of one page. A subscription counts PROFILES, never resumes, so
     * at the Default subscription's one profile the New profile tile is the
     * ONE locked thing left - pressable, "Needs Premium", opening "Locked:
     * More profiles" - and a new resume is never locked.
     */
    await page.goto(`${APP}/admin/profiles`, { waitUntil: 'networkidle2' });
    await page
      .waitForSelector('[data-new-tile="profile"][data-locked-feature="more-profiles"]', { timeout: 15_000 })
      .catch(() => null);
    const dashboard = await page.evaluate(() => {
      const tile = document.querySelector('[data-new-tile="profile"]');
      return {
        headings: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent.trim()),
        tabs: Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map((tab) => ({
          text: tab.textContent.trim(),
          selected: tab.getAttribute('aria-selected') === 'true',
        })),
        cards: document.querySelectorAll('[data-profile-card]').length,
        tile: tile
          ? { lock: tile.getAttribute('data-locked-feature'), disabled: tile.disabled, text: tile.innerText.replace(/\s+/g, ' ').trim() }
          : null,
      };
    });
    check(
      "user /admin/profiles: My Profiles, with the tabs Profiles (1) and All resumes (1), Profiles selected, and the user's profile as a card",
      dashboard.headings.includes('My Profiles') &&
        dashboard.tabs.map((tab) => tab.text).join(' / ') === 'Profiles (1) / All resumes (1)' &&
        dashboard.tabs[0].selected &&
        !dashboard.tabs[1].selected &&
        dashboard.cards === 1,
      JSON.stringify(dashboard)
    );
    check(
      "user /admin/profiles: at the Default subscription's limit the New profile tile is locked - pressable, not disabled, \"Needs Premium\"",
      Boolean(dashboard.tile) && dashboard.tile.lock === 'more-profiles' && !dashboard.tile.disabled && /Needs Premium/.test(dashboard.tile.text),
      JSON.stringify(dashboard.tile)
    );
    const tileLock = await openLock(page, '[data-new-tile="profile"][data-locked-feature="more-profiles"]');
    check(
      'user /admin/profiles: pressing it opens "Locked: More profiles", what Premium allows, Go to subscription and Close',
      isLockDialog(tileLock, 'More profiles') && /Premium allows up to 5\./.test(tileLock?.text ?? ''),
      JSON.stringify(tileLock)
    );

    await page.goto(`${APP}/admin/profiles?tab=resumes`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-new-tile="resume"]', { timeout: 15_000 }).catch(() => null);
    const resumesTab = await page.evaluate(() => {
      const tile = document.querySelector('[data-new-tile="resume"]');
      return {
        selected: Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).find(
          (tab) => tab.getAttribute('aria-selected') === 'true'
        )?.textContent.trim(),
        tile: tile ? { lock: tile.getAttribute('data-locked-feature'), disabled: tile.disabled } : null,
        resumeCards: document.querySelectorAll('[data-resume-card]').length,
        lockedAnywhere: document.querySelectorAll('[data-locked-feature]').length,
      };
    });
    check(
      'user /admin/profiles?tab=resumes: All resumes is the selected tab, and the New resume tile is never locked at the limit',
      resumesTab.selected === 'All resumes (1)' &&
        Boolean(resumesTab.tile) &&
        resumesTab.tile.lock === null &&
        !resumesTab.tile.disabled &&
        resumesTab.resumeCards === 1,
      JSON.stringify(resumesTab)
    );

    // Typed, with the profile named: the chooser is drawn - at the limit too,
    // since a resume is never counted - and says whose resume it is for.
    const userProfiles = await (await apiAs(userToken)('/profiles')).json().catch(() => null);
    const userProfileId = Array.isArray(userProfiles) ? userProfiles[0]?.id : null;
    await page.goto(`${APP}/admin/resumes/new?profile=${encodeURIComponent(userProfileId ?? 'none')}`, { waitUntil: 'networkidle2' });
    await page
      .waitForFunction(() => Array.from(document.querySelectorAll('h1')).some((h) => /^Start building a resume/.test(h.textContent.trim())), {
        timeout: 15_000,
        polling: 250,
      })
      .catch(() => null);
    const chooser = await page.evaluate(() => ({
      heading: Array.from(document.querySelectorAll('h1'))
        .map((h) => h.textContent.trim())
        .find((text) => /^Start building a resume/.test(text)),
      locks: document.querySelectorAll('[data-locked-feature]').length,
    }));
    check(
      'user /admin/resumes/new?profile=<id>: the chooser is drawn, for that profile, with no lock even at the limit',
      Boolean(userProfileId) && chooser.heading === 'Start building a resume for Ada Shell' && chooser.locks === 0,
      JSON.stringify({ userProfileId, ...chooser })
    );

    await page.goto(`${APP}/admin/profiles/no-such`, { waitUntil: 'networkidle2' });
    await page
      .waitForFunction(() => /That profile was not found/.test(document.body.innerText), { timeout: 15_000, polling: 250 })
      .catch(() => null);
    const missingProfile = await page.evaluate(() => ({
      said: /That profile was not found/.test(document.body.innerText),
      link: Array.from(document.querySelectorAll('a')).some(
        (a) => a.getAttribute('href') === '/admin/profiles' && /My Profiles/.test(a.textContent)
      ),
      lit: Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item[data-active="true"]')).map((a) => a.textContent.trim()),
    }));
    check(
      'user /admin/profiles/<no such profile>: says so, with a link to My Profiles, Profiles still the lit row',
      missingProfile.said && missingProfile.link && missingProfile.lit.join() === 'Profiles',
      JSON.stringify(missingProfile)
    );

    // An old bookmark: /admin/profiles/<a resume's id> was a resume's editor
    // in v4.1, and still lands there.
    await page.goto(`${APP}/admin/profiles/${encodeURIComponent(userResumeId)}`, { waitUntil: 'domcontentloaded' });
    const bookmarked = await page
      .waitForFunction((id) => location.pathname === `/admin/resumes/${id}`, { timeout: 15_000, polling: 250 }, userResumeId)
      .then(() => true, () => false);
    check(
      "user /admin/profiles/<a resume's id>: an old bookmark replaces itself with that resume's editor",
      bookmarked,
      page.url()
    );

    /*
     * The way to the page where money is spent.
     *
     * It was reachable only from the coin pill in the top bar, which is a
     * balance you can press rather than a door somebody goes looking for. Last
     * in the main group, beside Orders, because noticing you are out of credits
     * is something that happens on an order.
     */
    const creditsShell = await visit(page, '/credits', 'user');
    check(
      'user: Credits is in the rail, last in the main group',
      creditsShell.navLabels.includes('Credits'),
      `saw: ${creditsShell.navLabels.join(', ')}`
    );
    check(
      'user: and it is the row that lights up on /credits',
      creditsShell.activeLabels.length === 1 && creditsShell.activeLabels[0] === 'Credits',
      `lit: ${creditsShell.activeLabels.join(', ')}`
    );
    check(
      'user: Credits sits after Orders',
      creditsShell.navLabels.indexOf('Credits') === creditsShell.navLabels.indexOf('Orders') + 1,
      `saw: ${creditsShell.navLabels.join(', ')}`
    );

    /*
     * The refund requests a person has made are a tab of /credits, and every
     * notice about one links to it - so the address has to light that tab.
     */
    const creditTabs = async () =>
      page.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll('[role="tablist"][aria-label="Credits"] [role="tab"]')).map((tab) =>
          tab.textContent.trim()
        ),
        active: document
          .querySelector('[role="tablist"][aria-label="Credits"] [role="tab"][aria-selected="true"]')
          ?.textContent.trim(),
        heading: document.querySelector('#refunds-heading')?.textContent.trim() ?? null,
      }));
    const creditsRow = await creditTabs();
    check(
      'user /credits: the tabs are Card, Crypto, Credit History and Refund Requests',
      creditsRow.tabs.join(' / ') === 'Card / Crypto / Credit History / Refund Requests',
      creditsRow.tabs.join(', ')
    );
    await visit(page, '/credits?tab=refunds', 'user');
    await wait(500);
    const refundsTab = await creditTabs();
    check(
      "user /credits?tab=refunds: lands on Refund Requests - where a refund notice's link goes",
      refundsTab.active === 'Refund Requests' && refundsTab.heading === 'Refund Requests',
      JSON.stringify(refundsTab)
    );
    // Read-only now: it says to contact the administrator, with the link.
    const refundsLead = await page.evaluate(() => {
      const lead = document.querySelector('#refunds-heading')?.parentElement?.querySelector('p');
      return {
        text: lead?.innerText ?? '',
        contact: Boolean(lead && Array.from(lead.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin')),
      };
    });
    check(
      'user /credits?tab=refunds: says to contact the administrator for a refund, with Contact admin',
      /contact your administrator/.test(refundsLead.text) && refundsLead.contact,
      JSON.stringify(refundsLead)
    );
    for (const route of ['/credits?tab=crypto', '/credits?tab=history', '/credits?tab=refunds']) {
      await page.goto(`${APP}${route}`, { waitUntil: 'networkidle2' });
      await wait(300);
      if (await offersAsk(page)) askingPages.push(route);
    }
    check('user: no page offers Ask for refund - not a purchase, a charge or an order', askingPages.length === 0, askingPages.join(', '));

    /*
     * Report Jobs is a reporter's page. A user who types its address is told
     * what it is for, on the address they typed - not bounced, and not shown a
     * page whose requests their account would be refused.
     */
    const userReport = await visit(page, '/report', 'user');
    const reportGate = await page.evaluate(() => ({
      path: location.pathname,
      gate: /Reporters only/.test(document.body.innerText),
      contact: Array.from(document.querySelectorAll('.tl-notice button, .tl-notice a')).some((node) =>
        /Contact admin/.test(node.textContent)
      ),
    }));
    check(
      'user /report: explained as reporters only, with Contact admin, on its own address',
      reportGate.path === '/report' && reportGate.gate && reportGate.contact,
      JSON.stringify(reportGate)
    );
    check(
      'user: no Report Jobs in the rail',
      !userReport.navLabels.includes('Report Jobs'),
      `saw: ${userReport.navLabels.join(', ')}`
    );

    // The prefix collision that a vertical rail makes obvious: /jobs is a prefix of /jobs/filter.
    const filter = await visit(page, '/jobs/filter', 'user');
    check(
      'user /jobs/filter: lights Job Filter alone',
      filter.activeLabels.length === 1 && filter.activeLabels[0] === 'Job Filter',
      `lit: ${filter.activeLabels.join(', ') || 'nothing'}`
    );
    const findJobs = await visit(page, '/jobs', 'user');
    check(
      'user /jobs: lights Find Jobs alone',
      findJobs.activeLabels.length === 1 && findJobs.activeLabels[0] === 'Find Jobs',
      `lit: ${findJobs.activeLabels.join(', ') || 'nothing'}`
    );

    // Templates: visible, and read-only.
    //
    // The preview is an <iframe> aimed at the API on another port, so it is
    // same-site but cross-ORIGIN and its contentDocument can never be read
    // from the page. Watching what the server answered is the only faithful
    // check - and the one that catches the frame being pointed at a hostname
    // the session cookie was not set on.
    const previewAnswers = [];
    const onPreviewResponse = (response) => {
      if (!response.url().includes('/preview')) return;
      previewAnswers.push({
        status: response.status(),
        type: response.headers()['content-type'] ?? '',
      });
    };
    page.on('response', onPreviewResponse);

    await page.goto(`${APP}/admin/templates`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    page.off('response', onPreviewResponse);
    const templateControls = await page.evaluate(() => {
      const text = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
      return {
        canView: text.includes('View'),
        canAdd: text.some((t) => t.startsWith('Add Manual') || t.startsWith('Upload')),
        canEdit: text.includes('Edit'),
        canDelete: text.includes('Delete'),
        blocked: document.body.textContent.includes('Administrators only'),
      };
    });
    check('user /admin/templates: is not blocked', !templateControls.blocked);
    check('user /admin/templates: can view a template', templateControls.canView);
    check(
      'user /admin/templates: the previews are actually fetched',
      previewAnswers.length > 0,
      'no preview request was made at all'
    );
    check(
      'user /admin/templates: no preview is refused',
      // 304 counts: this page was already visited once in the route sweep, so
      // the browser revalidates rather than refetching, and a 304 means the
      // document it is holding is still good. What must never appear is a 401
      // or a 403 - that is the frame being pointed somewhere the session
      // cookie does not reach.
      previewAnswers.length > 0 && previewAnswers.every((a) => a.status < 400),
      JSON.stringify(previewAnswers.slice(0, 3))
    );
    check(
      'user /admin/templates: a fresh preview answers with HTML',
      previewAnswers
        .filter((a) => a.status === 200)
        .every((a) => a.type.includes('text/html')),
      JSON.stringify(previewAnswers.filter((a) => a.status === 200).slice(0, 3))
    );
    check(
      'user /admin/templates: offers no add / edit / delete',
      !templateControls.canAdd && !templateControls.canEdit && !templateControls.canDelete,
      JSON.stringify(templateControls)
    );

    await page.screenshot({ path: `${SHOTS}/shell-1-user-light.png` });

    /*
     * The Bid Assistant's shared pieces: one prompt template for every
     * account, and a job board whose Delete takes every account's answers
     * with it. Both are the administrator's, so an ordinary user reads the
     * template and is offered no way to save it or to delete a job.
     */
    const userJob = await openSeededJob(page, seededJob.company);
    // Set Error is everybody's, so seeing it proves a job is open and its
    // buttons drawn - without that, a missing Delete Job proves nothing.
    check(
      "user /bid-assistant: the seeded job is open, with the job's buttons",
      userJob.found && userJob.buttons.includes('Set Error'),
      JSON.stringify(userJob)
    );
    check(
      'user /bid-assistant: no Delete Job',
      userJob.buttons.includes('Set Error') && !userJob.buttons.includes('Delete Job'),
      JSON.stringify(userJob)
    );
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('.top-bar button'))
        .find((button) => button.textContent.trim() === 'Prompt')
        ?.click();
    });
    await wait(300);
    const assistantControls = await page.evaluate(() => {
      const text = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
      const editor = document.querySelector('.prompt-modal textarea');
      return {
        opened: Boolean(editor),
        readOnly: editor?.readOnly ?? null,
        canSave: text.includes('Save Prompt'),
      };
    });
    check(
      'user /bid-assistant: the prompt template is shown read-only, with no Save',
      assistantControls.opened && assistantControls.readOnly === true && !assistantControls.canSave,
      JSON.stringify(assistantControls)
    );
    await page.evaluate(() => document.querySelector('.prompt-modal .bid-close')?.click());

    /* ------------------------------------------------- dark, then phone */
    await setTheme(page, 'dark');
    const dark = await visit(page, '/orders', 'user dark');
    check('user: dark mode actually applies', dark.isDark);
    await page.screenshot({ path: `${SHOTS}/shell-2-user-dark.png` });

    await page.setViewport(PHONE);
    // Below the breakpoint the rail is off-canvas, so it is legitimately not
    // the top element at its own corner.
    const phone = await visit(page, '/', 'user phone', { expectRail: false, compact: true });
    check('phone: content is not offset by a rail that is not there', phone.railWidth <= 280);
    await page.screenshot({ path: `${SHOTS}/shell-3-phone-closed.png` });

    /*
     * The top bar, at both widths.
     *
     * The order is the one the navigation spec asked for: the things that act
     * on the session you are in, then the one that navigates away.
     */
    for (const [label, viewport] of [['wide', WIDE], ['phone', PHONE]]) {
      await page.setViewport(viewport);
      await page.goto(`${APP}/orders`, { waitUntil: 'networkidle0' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const bar = await inspectTopBar(page);

      check(
        `top bar ${label}: nothing hangs off the end`,
        bar && bar.past <= 0,
        `${bar?.past}px past ${bar?.viewport}: ${bar?.culprit}`
      );
      check(
        `top bar ${label}: the name Tailor is there in full`,
        bar?.brand?.text === 'Tailor' && bar.brand.whole,
        JSON.stringify(bar?.brand)
      );

      /*
       * The whole row, not just its two ends.
       *
       * Checking only that Templates came last could not see the account at
       * all: that control carried neither a title nor an aria-label, so it was
       * missing from this list entirely, and Templates sitting between the
       * theme toggle and the account would still have matched. Naming the
       * account button closed the blind spot; asserting the full sequence is
       * what makes this check say what its name claims.
       *
       * Names come from title or aria-label, so this reads what a screen
       * reader would - folded to one word each, because two of them carry a
       * person's name or a state that changes with the theme.
       */
      const order = (bar?.controls ?? []).join(' < ');
      const shape = (bar?.controls ?? [])
        .map((name) => {
          if (/^Credits/.test(name)) return 'Credits';
          if (/^Notifications/.test(name)) return 'Notifications';
          if (/(mode|theme)$/i.test(name)) return 'Theme';
          if (/^Account/.test(name)) return 'Account';
          return name;
        })
        .join(' < ');
      check(
        `top bar ${label}: the row reads Credits, Notifications, Theme, Account`,
        shape === 'Credits < Notifications < Theme < Account',
        order
      );

      /*
       * And the menus it opens stay on the screen.
       *
       * Both hang off a trigger near the right edge and are right-aligned to
       * it, so on a phone their left edge used to fall outside the viewport -
       * the notifications panel started at -74px at 390 and -112 at 320, with
       * the heading rendering as "ions". Nothing above could see it: this
       * function measures the bar's own children with both menus shut, and the
       * page-level check reads `documentElement.scrollWidth`, which never
       * registers overflow to the LEFT at all.
       */
      for (const [name, selector] of [
        ['notifications', '.tl-topbar button[aria-label^="Notifications"]'],
        ['account', '.tl-topbar button[aria-label^="Account"]'],
      ]) {
        // Opened and measured in two steps: the panel is mounted by a state
        // change, so it is not in the DOM in the same tick as the click.
        const opened = await page.evaluate((sel) => {
          const trigger = document.querySelector(sel);
          if (!trigger) return false;
          trigger.click();
          return true;
        }, selector);
        await wait(300);
        const box = opened
          ? await page.evaluate(() => {
              const panel = document.querySelector('.app-top-nav-menu');
              if (!panel) return { missing: 'panel' };
              const rect = panel.getBoundingClientRect();
              return {
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                viewport: window.innerWidth,
              };
            })
          : { missing: 'trigger' };
        check(
          `top bar ${label}: the ${name} menu opens on the screen`,
          box && !box.missing && box.left >= 0 && box.right <= box.viewport,
          JSON.stringify(box)
        );
        if (name === 'account' && opened) {
          // The tier is a subscription here too: the pill says so, and the
          // row goes to the page by its new address rather than the redirect.
          const menu = await page.evaluate(() => {
            const panel = document.querySelector('.app-top-nav-menu');
            return panel
              ? { text: panel.innerText, hrefs: Array.from(panel.querySelectorAll('a')).map((a) => a.getAttribute('href')) }
              : null;
          });
          check(
            `top bar ${label}: the account menu says subscription, never plan, and links to it`,
            Boolean(menu) &&
              /subscription/i.test(menu.text) &&
              !/\bplans?\b/i.test(menu.text) &&
              menu.hrefs.includes('/settings/subscription') &&
              !menu.hrefs.includes('/settings/plan'),
            JSON.stringify(menu)
          );
          // How to reach the administrator is one press away from every page.
          check(
            `top bar ${label}: the account menu offers Contact admin`,
            Boolean(menu) && /Contact admin/.test(menu.text),
            JSON.stringify(menu?.text)
          );
        }
        await page.keyboard.press('Escape');
        await page.evaluate(() => document.body.click());
        await wait(200);
      }
    }

    /*
     * And the balance on a phone, whole.
     *
     * The balance is dollars to the thousandth, and the last digit is the one
     * a $0.023 charge moves - the one an ellipsis eats first. The narrow-phone
     * compaction once stopped at 375, so 375-384 (iPhone SE, 8 and mini)
     * showed "$16.4..." where 360 showed it whole, and every balance from
     * $100 lost its tail up to 392, 390 included. Neither check above could
     * see it: the bar did not overflow, the figure inside it was clipped. Two
     * accounts of their own, so nobody else's page shows a balance it did not
     * have: one in two figures, one in three - purchases start at $50 with
     * presets to $1000, so both are ordinary. Both with all three decimals,
     * the widest a balance prints since trailing zeros are dropped ($150
     * prints as "$150").
     */
    for (const milli of [16_477, 150_125]) {
      const holder = users.createUser({ email: `e2e-shell-pill-${milli}-${stamp}@example.com`, name: 'Pill' });
      creditLedger.applyAdjustment({
        userId: holder.id,
        deltaMilli: milli,
        reason: 'admin-grant',
        idempotencyKey: `e2e-shell-pill:${holder.id}`,
        note: 'e2e shell: a balance for the top bar to show',
      });
      const pillPage = await browser.newPage();
      await signIn(pillPage, users.createSession(holder.id));
      await setTheme(pillPage, 'light');
      for (const width of [360, 375, 390]) {
        await pillPage.setViewport({ width, height: 844 });
        await pillPage.goto(`${APP}/orders`, { waitUntil: 'networkidle0' });
        await pillPage
          .waitForFunction(() => /\$/.test(document.querySelector('.tl-credits span:last-child')?.textContent ?? ''), {
            timeout: 15_000,
          })
          .catch(() => {});
        const pill = await pillPage.evaluate(() => {
          const figure = document.querySelector('.tl-credits span:last-child');
          return figure
            ? { text: figure.textContent.trim(), need: figure.scrollWidth, room: figure.clientWidth }
            : null;
        });
        const bar = await inspectTopBar(pillPage);
        const expected = formatMoney(milli);
        check(
          `top bar ${width}px: a balance of ${expected} is shown whole, last digit included`,
          pill?.text === expected && pill.need <= pill.room && bar?.past <= 0 && bar?.brand?.whole,
          `${JSON.stringify(pill)}, bar ${bar?.past}px past, brand ${JSON.stringify(bar?.brand)}`
        );
      }
      await pillPage.close();
    }

    await page.setViewport(PHONE);

    const opened = await page.evaluate(() => {
      const trigger = document.querySelector('.tl-topbar button[aria-controls="app-sidebar"]');
      if (!trigger) return false;
      trigger.click();
      return true;
    });
    check('phone: there is a menu button', opened);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const drawer = await page.evaluate(() => ({
      open: document.querySelector('.tl-shell')?.dataset.drawer === 'open',
      scrim: Boolean(document.querySelector('.tl-scrim')),
      locked: document.body.style.overflow === 'hidden',
    }));
    check('phone: the drawer opens, with a scrim and a scroll lock', drawer.open && drawer.scrim && drawer.locked, JSON.stringify(drawer));
    await page.screenshot({ path: `${SHOTS}/shell-4-phone-drawer.png` });

    // The drawer holds the rail as it is - no row for the old list page, no locked row, so
    // there is no lock to open from it any more (the rail's locked-row focus
    // hand-off has nothing to hand off).
    const drawerRows = await page.evaluate(() => ({
      labels: Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item')).map((a) => a.textContent.trim()),
      locked: document.querySelectorAll('.tl-sidebar [data-locked-feature]').length,
    }));
    check(
      'phone: the drawer holds the same rail, without a row for the old list page and with no locked row',
      drawerRows.labels.join(' / ') === RAIL.join(' / ') && drawerRows.locked === 0,
      JSON.stringify(drawerRows)
    );

    // The one lock left is the New profile tile. Pressed with a real click
    // (which focuses it), it opens its lock over the page, and Close hands
    // focus back to the tile - the kit Dialog restores it, nothing special.
    // The balance pages above signed other accounts in through the one cookie jar
    // this browser has, so this page is the user with the profile again first.
    await signIn(page, userToken);
    await page.goto(`${APP}/admin/profiles`, { waitUntil: 'networkidle2' });
    const phoneTile ='[data-new-tile="profile"][data-locked-feature="more-profiles"]';
    await page.waitForSelector(phoneTile, { timeout: 15_000 }).catch(() => null);
    const phoneTilePressed = await page.click(phoneTile).then(() => true, () => false);
    await page.waitForSelector('[role="dialog"]', { timeout: 5_000 }).catch(() => null);
    const phoneLock = await page.evaluate(() => ({
      title: document.querySelector('[role="dialog"] h2')?.textContent.trim() ?? null,
      go: Array.from(document.querySelectorAll('[role="dialog"] a')).find((a) => a.textContent.trim() === 'Go to subscription')?.getAttribute('href') ?? null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('[role="dialog"] button'))
        .find((b) => b.textContent.trim() === 'Close')
        ?.click();
    });
    const phoneRestored = await page
      .waitForFunction(() => document.activeElement?.matches('[data-new-tile="profile"]') ?? false, { timeout: 5_000, polling: 100 })
      .then(() => true, () => false);
    check(
      'phone: the locked New profile tile opens "Locked: More profiles" with Go to subscription, and Close gives focus back to the tile',
      phoneTilePressed &&
        phoneLock.title === 'Locked: More profiles' &&
        phoneLock.go === '/settings/subscription' &&
        phoneLock.overflow <= 1 &&
        phoneRestored,
      JSON.stringify({ phoneTilePressed, phoneLock, phoneRestored })
    );

    await page.close();

    /* ------------------------------------------------------ admin, wide */
    const adminPage = await browser.newPage();
    await adminPage.setViewport(WIDE);
    await signIn(adminPage, adminToken);
    await setTheme(adminPage, 'light');

    let adminShell;
    const adminAsking = [];
    for (const route of [...ROUTES, ...ADMIN_ROUTES]) {
      adminShell = await visit(adminPage, route, 'admin');
      if (await offersAsk(adminPage)) adminAsking.push(route);
    }
    check('admin: no page offers Ask for refund either', adminAsking.length === 0, adminAsking.join(', '));

    /*
     * An administrator is exempt from the subscriptions (owner decision B1),
     * whatever their own is - this one is on Default - so nothing is locked:
     * not the builder (which locks nothing for anybody), and not the New
     * profile tile, though the administrator has a profile of their own.
     */
    await openBuilder(adminPage, 'Building Manually');
    const adminManual = await readBuildOptions(adminPage, 'manual-profile', 'manualBuildMode');
    check(
      'admin / manual: a profile select and the three build modes, every one open, with no lock',
      buildOptionsAreOpen(adminManual),
      JSON.stringify(adminManual)
    );
    check(
      'admin: the rail has the Profiles entry, whatever their own subscription',
      adminShell.navLabels.includes('Profiles'),
      `saw: ${adminShell.navLabels.join(', ')}`
    );
    await openBuilder(adminPage, 'Building Automatically from Google Sheet');
    const adminSheet = await readBuildOptions(adminPage, 'sheets-profile', 'sheetsBuildMode');
    check(
      'admin / sheet: the profile select and the three build modes are open, and no target radios or picker for several',
      buildOptionsAreOpen(adminSheet),
      JSON.stringify(adminSheet)
    );
    await adminPage.goto(`${APP}/admin/profiles`, { waitUntil: 'networkidle2' });
    // The usage line is drawn once the account has loaded, which is when a
    // lock would be decided: so the absence below is the page's answer.
    await adminPage
      .waitForFunction(() => /administrators have no limit/.test(document.body.innerText), { timeout: 15_000, polling: 250 })
      .catch(() => null);
    const adminTile = await adminPage.evaluate(() => {
      const tile = document.querySelector('[data-new-tile="profile"]');
      return tile
        ? {
            lock: tile.getAttribute('data-locked-feature'),
            disabled: tile.disabled,
            text: tile.innerText.replace(/\s+/g, ' ').trim(),
            usage: /administrators have no limit/.test(document.body.innerText),
          }
        : null;
    });
    check(
      'admin /admin/profiles: the New profile tile is open, never locked, whatever their own subscription',
      Boolean(adminTile) && adminTile.usage && adminTile.lock === null && !adminTile.disabled && !/Needs /.test(adminTile.text),
      JSON.stringify(adminTile)
    );

    check(
      'admin: the same rail as everybody, Settings and Templates at its foot',
      adminShell.navLabels.join(' / ') === RAIL.join(' / '),
      `saw: ${adminShell.navLabels.join(', ')}`
    );

    // Administrators too. They do not spend credits, and the page says so
    // itself - a row they can see and a page that explains beats a missing row
    // and a balance they cannot account for.
    check(
      'admin: Credits is in the rail as well',
      adminShell.navLabels.includes('Credits'),
      `saw: ${adminShell.navLabels.join(', ')}`
    );

    // The settings tabs, and only on settings routes.
    await adminPage.goto(`${APP}/admin/prompts`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const onSettings = await adminPage.evaluate(() => ({
      subnav: Boolean(document.querySelector('nav.tl-tabs[aria-label="Settings"]')),
      tabs: Array.from(document.querySelectorAll('nav.tl-tabs[aria-label="Settings"] .tl-tab')).map((a) =>
        a.textContent.trim()
      ),
      active: document.querySelector('nav.tl-tabs[aria-label="Settings"] .tl-tab[data-active="true"]')?.textContent.trim(),
      subtabs: Array.from(document.querySelectorAll('nav.tl-subtabs[aria-label="Administration"] .tl-subtab')).map((a) =>
        a.textContent.trim()
      ),
      subActive: document
        .querySelector('nav.tl-subtabs[aria-label="Administration"] .tl-subtab[data-active="true"]')
        ?.textContent.trim(),
      settingsRowLit: Boolean(
        Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item[data-active="true"]')).find(
          (a) => a.textContent.trim() === 'Settings'
        )
      ),
    }));
    check('admin /admin/prompts: the settings tabs are shown', onSettings.subnav);
    /*
     * Two levels. One row of all thirteen ran off the end of a 1440px window
     * with four of them out of sight, so the installation's pages are a second
     * row under one Administration tab.
     */
    check(
      "admin: the account's four tabs, then Administration",
      onSettings.tabs.join(' / ') === 'Account / Job Sheet / Payment Methods / Subscription / Administration',
      onSettings.tabs.join(', ')
    );
    check('admin /admin/prompts: Administration is the lit tab', onSettings.active === 'Administration', String(onSettings.active));
    check(
      "admin /admin/prompts: the installation's pages are the second row, Accounts among them",
      onSettings.subtabs[0] === 'General' && onSettings.subtabs.includes('Accounts') && onSettings.subtabs.includes('Prompt Test'),
      onSettings.subtabs.join(', ')
    );
    check('admin /admin/prompts: Prompts is the lit page', onSettings.subActive === 'Prompts', String(onSettings.subActive));
    const allVisible = await adminPage.evaluate(() => {
      const row = document.querySelector('nav.tl-subtabs[aria-label="Administration"]');
      return Boolean(row) && row.scrollWidth <= row.clientWidth + 1;
    });
    check('admin wide: every Administration page is on screen without scrolling the row', allVisible);
    check('admin /admin/prompts: the Settings sidebar row stays lit', onSettings.settingsRowLit);

    /*
     * Four features have one prompt each, edited in place: the job analysis's
     * two calls (owner decisions J0, O1), the revise pass and the cover
     * letter. None offers New Variant, Duplicate, Save Active or a model
     * override, and each says why in its own sentence. Tailor Resume, which
     * a resume may choose a variant of, still offers New Variant.
     */
    const promptFeatures = await adminPage.evaluate(() =>
      Array.from(document.querySelectorAll('aside button')).map((b) => b.textContent.replace(/\d+$/, '').trim())
    );
    const SINGLE_PROMPTS = [
      ['Analyze Job Description', /Job analysis has one prompt/],
      ['Job Facts (Filter)', /The job facts have one prompt/],
      ['Revise Resume Coverage', /The revise pass has one prompt/],
      ['Generate Cover Letter', /A cover letter has one prompt/],
    ];
    check(
      'admin /admin/prompts: the analysis, the job facts, the revise pass and the cover letter are listed, with Tailor Resume',
      SINGLE_PROMPTS.every(([label]) => promptFeatures.some((entry) => entry.startsWith(label))) &&
        promptFeatures.some((entry) => entry.startsWith('Tailor Resume')),
      promptFeatures.join(', ')
    );
    const openFeature = async (label, ready) => {
      await adminPage.evaluate((wanted) => {
        Array.from(document.querySelectorAll('aside button'))
          .find((b) => b.textContent.trim().startsWith(wanted))
          ?.click();
      }, label);
      await adminPage
        .waitForFunction((source) => new RegExp(source).test(document.body.innerText), { timeout: 10_000 }, ready.source)
        .catch(() => null);
      return adminPage.evaluate((source) => {
        const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
        return {
          note: new RegExp(source).test(document.body.innerText),
          newVariant: buttons.includes('New Variant'),
          duplicate: buttons.includes('Duplicate'),
          saveActive: buttons.includes('Save Active'),
          override: Boolean(document.getElementById('prompt-model-provider')),
        };
      }, ready.source);
    };
    for (const [label, sentence] of SINGLE_PROMPTS) {
      const shown = await openFeature(label, sentence);
      check(
        `admin /admin/prompts: ${label} is one prompt - its own sentence, no New Variant, Duplicate, Save Active or override`,
        shown.note && !shown.newVariant && !shown.duplicate && !shown.saveActive && !shown.override,
        JSON.stringify(shown)
      );
    }
    const tailoring = await openFeature('Tailor Resume', /Model override: provider/);
    check(
      'admin /admin/prompts: Tailor Resume still offers New Variant, and the override that says the run decides',
      tailoring.newVariant && tailoring.override,
      JSON.stringify(tailoring)
    );

    await adminPage.goto(`${APP}/orders`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const offSettings = await adminPage.evaluate(() =>
      Boolean(document.querySelector('nav.tl-tabs[aria-label="Settings"]'))
    );
    check('admin /orders: no settings tabs outside the hub', !offSettings);

    // The other side of the user's check: the same job offers the
    // administrator Delete Job.
    const adminJob = await openSeededJob(adminPage, seededJob.company);
    check(
      'admin /bid-assistant: the seeded job offers Delete Job',
      adminJob.found && adminJob.buttons.includes('Set Error') && adminJob.buttons.includes('Delete Job'),
      JSON.stringify(adminJob)
    );

    await adminPage.screenshot({ path: `${SHOTS}/shell-5-admin-light.png` });

    // The refund queue is a tab of Payments, and a "New refund request"
    // notice links straight to it.
    await adminPage.goto(`${APP}/admin/payments?tab=refunds`, { waitUntil: 'networkidle2' });
    await wait(600);
    const queue = await adminPage.evaluate(() => ({
      // The shell's own h1 says Settings; the page's says Payments.
      title: Array.from(document.querySelectorAll('.tl-main h1'))
        .map((h) => h.textContent.trim())
        .find((text) => text === 'Payments'),
      tabs: Array.from(document.querySelectorAll('[role="tablist"][aria-label="Payments"] [role="tab"]')).map((tab) =>
        tab.textContent.trim()
      ),
      active: document
        .querySelector('[role="tablist"][aria-label="Payments"] [role="tab"][aria-selected="true"]')
        ?.textContent.trim(),
      heading: document.querySelector('#refund-queue-heading')?.textContent.trim() ?? null,
    }));
    check(
      'admin /admin/payments?tab=refunds: titled Payments, with the Refund requests tab lit',
      queue.title === 'Payments' &&
        queue.tabs[0] === 'Payments' &&
        /^Refund requests/.test(queue.tabs[1] ?? '') &&
        /^Refund requests/.test(queue.active ?? '') &&
        queue.heading === 'Refund requests',
      JSON.stringify(queue)
    );

    // Settings -> General carries the contact editor (its own section and Save).
    await adminPage.goto(`${APP}/admin/settings`, { waitUntil: 'networkidle2' });
    await wait(600);
    const contactSection = await adminPage.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('.tl-section h2')).map((h) => h.textContent.trim());
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
      return { headings, save: buttons.includes('Save contact details'), add: buttons.includes('Add a channel') };
    });
    check(
      'admin /admin/settings: General has a Contact section with its own Save',
      contactSection.headings.includes('Contact') && contactSection.save && contactSection.add,
      JSON.stringify(contactSection)
    );
    /*
     * Every setting with a .env default says where its value came from (owner
     * decision S4); the analysis model moved to Models (M2); the folder
     * template went, and the output prefix has the server's preview (O5).
     */
    await adminPage.waitForSelector('[data-preview-path]', { timeout: 10_000 }).catch(() => null);
    const general = await adminPage.evaluate(() => ({
      analysisSelect: Boolean(document.getElementById('analysis-model')),
      analysisHeading: Array.from(document.querySelectorAll('.tl-section h2')).some((h) => h.textContent.trim() === 'Job Analysis'),
      template: Boolean(document.getElementById('output-path-template')),
      prefix: document.getElementById('output-path-prefix')?.value ?? null,
      prefixChips: Array.from(document.querySelectorAll('[data-token]')).map((b) => b.textContent.trim()),
      preview: document.querySelector('[data-preview-path]')?.textContent.trim() ?? null,
      sources: Array.from(document.querySelectorAll('[data-setting-source]')).map((p) => p.textContent.trim()),
    }));
    check(
      'admin /admin/settings: no analysis select and no folder template; the output prefix has its tokens and the server-drawn preview',
      !general.analysisSelect &&
        !general.analysisHeading &&
        !general.template &&
        general.prefix === '/{{user_email}}/{{order_number}}' &&
        general.prefixChips.join(' ') === '{{user_email}} {{order_number}} {{date}}' &&
        /ft_\d{8}_0001/.test(general.preview ?? ''),
      JSON.stringify(general)
    );
    check(
      'admin /admin/settings: each defaulted setting says where its value came from',
      general.sources.length >= 8 && general.sources.every((line) => /^(Set here|From \.env \(|Default)/.test(line)),
      JSON.stringify(general.sources)
    );
    /*
     * What a resume costs is the build mode's price (owner decision D21): three
     * boxes, one per mode, each with its source line; and the builder's
     * defaults are a profile (a person of the administrator's) and a mode, not
     * a build target.
     */
    await adminPage.waitForSelector('#mode-price-fullPriceMilli', { timeout: 10_000 }).catch(() => null);
    const builderSettings = await adminPage.evaluate(() => {
      const prices = ['suitablePriceMilli', 'partialPriceMilli', 'fullPriceMilli'].map((key) => {
        const box = document.getElementById(`mode-price-${key}`);
        return box ? { type: box.getAttribute('type'), mode: box.getAttribute('inputmode') } : null;
      });
      return {
        prices,
        priceHeading: Array.from(document.querySelectorAll('.tl-section h2')).some((h) => h.textContent.trim() === 'Price per resume'),
        save: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Save Prices'),
        defaultProfile: document.getElementById('default-profile')?.tagName.toLowerCase() ?? null,
        defaultMode: document.getElementById('default-build-mode') !== null,
        retired: ['default-resume', 'default-selection'].filter((id) => document.getElementById(id)),
      };
    });
    check(
      'admin /admin/settings: Price per resume has a box for each build mode and Save Prices; Builder Defaults chooses a profile and a mode, with no build target',
      builderSettings.priceHeading &&
        builderSettings.save &&
        builderSettings.prices.every((box) => box && box.type === 'text' && box.mode === 'decimal') &&
        builderSettings.defaultProfile === 'select' &&
        builderSettings.defaultMode &&
        builderSettings.retired.length === 0,
      JSON.stringify(builderSettings)
    );

    // Admin -> Models: Create New Model at the top right, the default and analysis badges.
    await adminPage.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
    await wait(400);
    const models = await adminPage.evaluate(() => {
      // The page's own header, not the shell's top bar.
      const create = Array.from(document.querySelectorAll('main button')).find((b) => b.textContent.trim() === 'Create New Model');
      const header = create?.closest('header');
      const headerBox = header?.getBoundingClientRect();
      const createBox = create?.getBoundingClientRect();
      const pills = Array.from(document.querySelectorAll('.tl-table .tl-pill')).map((p) => p.textContent.trim());
      return {
        create: Boolean(create),
        topRight: Boolean(headerBox && createBox && createBox.right > headerBox.right - 4 && createBox.top < headerBox.top + 40),
        inlineForm: Boolean(document.getElementById('model-display-name')),
        defaultPill: pills.includes('Default'),
        analysisPill: pills.includes('Analysis'),
        actions: ['Set default', 'Use for analysis'].map((label) =>
          Array.from(document.querySelectorAll('.tl-table button')).some((b) => b.textContent.trim() === label)
        ),
        analysis: document.querySelector('[data-analysis-model]')?.textContent.trim() ?? null,
        once: /analysed once, by the analysis model, and never again/.test(document.body.innerText),
        // A model has no price: what a resume costs is the build mode's, set on Settings -> General.
        priceColumn: Array.from(document.querySelectorAll('.tl-table thead th')).some((th) => /price/i.test(th.textContent)),
        costSentence: /What a resume costs is set per builder mode under Settings > General > Price per resume\./.test(
          document.body.innerText
        ),
      };
    });
    check(
      'admin /admin/models: Create New Model at the top right, no inline form, Default and Analysis badges, Set default and Use for analysis; no price column, and the page says a resume costs the builder mode\'s price',
      models.create &&
        models.topRight &&
        !models.inlineForm &&
        models.defaultPill &&
        models.analysisPill &&
        models.actions.every(Boolean) &&
        models.once &&
        !models.priceColumn &&
        models.costSentence,
      JSON.stringify(models)
    );
    await adminPage.evaluate(() =>
      Array.from(document.querySelectorAll('main button')).find((b) => b.textContent.trim() === 'Create New Model')?.click()
    );
    await adminPage.waitForSelector('[role="dialog"] #model-display-name', { timeout: 5_000 }).catch(() => null);
    const createDialog = await adminPage.evaluate(() => ({
      title: document.querySelector('[role="dialog"] h2')?.textContent.trim() ?? null,
      // A model has no price: no box of that name, or any other with price in its id.
      priceBox: Boolean(document.querySelector('[role="dialog"] [id*="price"]')),
      name: Boolean(document.querySelector('[role="dialog"] #model-display-name')),
    }));
    check(
      'admin /admin/models: Create New Model opens the dialog - a name, and no price box',
      createDialog.title === 'Create New Model' && createDialog.name && !createDialog.priceBox,
      JSON.stringify(createDialog)
    );
    await adminPage.keyboard.press('Escape');

    /*
     * Admin -> Accounts, for a reporter (owner decisions A3, A4, J7): Reporter
     * in the role select and the invite form, a rate per job on their row,
     * and Record payout - on their row only - saying what it will leave.
     */
    await adminPage.goto(`${APP}/admin/accounts`, { waitUntil: 'networkidle2' });
    await adminPage.waitForSelector(`#rate-${reporter.id}`, { timeout: 10_000 }).catch(() => null);
    const accountsPage = await adminPage.evaluate(
      (reporterEmail, userEmail) => {
        const rowOf = (email) =>
          Array.from(document.querySelectorAll('.tl-table tbody tr')).find((row) =>
            row.querySelector('select[aria-label^="Role for"]')?.getAttribute('aria-label') === `Role for ${email}`
          );
        const reporterRow = rowOf(reporterEmail);
        const userRow = rowOf(userEmail);
        const buttons = (row) => (row ? Array.from(row.querySelectorAll('button')).map((b) => b.textContent.trim()) : []);
        const roleSelect = reporterRow?.querySelector('select[aria-label^="Role for"]');
        return {
          inviteRoles: Array.from(document.querySelectorAll('#invite-role option')).map((o) => o.textContent.trim()),
          rowRoles: roleSelect ? Array.from(roleSelect.options).map((o) => o.textContent.trim()) : null,
          rowRole: roleSelect?.value ?? null,
          reporterPill: Boolean(reporterRow && /Reporter/.test(reporterRow.querySelector('.tl-pill')?.textContent ?? '')),
          reporterButtons: buttons(reporterRow),
          userButtons: buttons(userRow),
          userRate: Boolean(userRow?.querySelector('input[id^="rate-"]')),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      },
      reporter.email,
      user.email
    );
    check(
      'admin /admin/accounts: the invite form and the row offer User, Reporter and Administrator',
      accountsPage.inviteRoles.join(' / ') === 'User / Reporter / Administrator' &&
        accountsPage.rowRoles?.join(' / ') === 'User / Reporter / Administrator' &&
        accountsPage.rowRole === 'reporter' &&
        accountsPage.reporterPill,
      JSON.stringify(accountsPage)
    );
    check(
      "admin /admin/accounts: Record payout and a rate on a reporter's row, neither on a user's",
      accountsPage.reporterButtons.includes('Record payout') &&
        !accountsPage.userButtons.includes('Record payout') &&
        !accountsPage.userRate,
      JSON.stringify(accountsPage)
    );
    check('admin /admin/accounts: no horizontal scrollbar', accountsPage.overflow <= 1, `overflow ${accountsPage.overflow}px`);

    // Choosing Reporter in the invite form asks for a rate instead of a subscription.
    await adminPage.select('#invite-role', 'reporter');
    await wait(250);
    const inviteAsReporter = await adminPage.evaluate(() => ({
      rate: Boolean(document.getElementById('invite-rate')),
      subscription: Boolean(document.getElementById('invite-subscription')),
    }));
    check(
      'admin /admin/accounts: inviting a Reporter asks for a rate per job, not a subscription',
      inviteAsReporter.rate && !inviteAsReporter.subscription,
      JSON.stringify(inviteAsReporter)
    );
    await adminPage.select('#invite-role', 'user');

    // The rate per job: typed in dollars, stored on blur, in thousandths.
    await adminPage.click(`#rate-${reporter.id}`);
    await adminPage.type(`#rate-${reporter.id}`, '0.075');
    await adminPage.keyboard.press('Tab');
    await wait(900);
    const listed = await (await apiAs(adminToken)('/admin/accounts')).json().catch(() => null);
    const reporterListed = listed?.accounts?.find((account) => account.id === reporter.id);
    check(
      "admin /admin/accounts: a reporter's rate per job is stored from the box, $0.075 as 75",
      reporterListed?.reportRateMilli === 75,
      JSON.stringify(reporterListed && { reportRateMilli: reporterListed.reportRateMilli })
    );

    // Record payout: more than the balance is refused before it is sent, in
    // the server's words; what was paid is recorded and leaves the rest.
    await adminPage.evaluate((email) => {
      const row = Array.from(document.querySelectorAll('.tl-table tbody tr')).find(
        (candidate) => candidate.querySelector('select[aria-label^="Role for"]')?.getAttribute('aria-label') === `Role for ${email}`
      );
      Array.from(row?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent.trim() === 'Record payout')
        ?.click();
    }, reporter.email);
    await adminPage.waitForSelector(`#payout-${reporter.id}`, { timeout: 5_000 }).catch(() => null);
    const payoutForm = `form[aria-labelledby="payout-heading-${reporter.id}"]`;
    const readPayout = () =>
      adminPage.evaluate(
        (formSelector, id) => {
          const form = document.querySelector(formSelector);
          const submit = form?.querySelector('button[type="submit"]');
          return form
            ? {
                line: document.getElementById(`payout-line-${id}`)?.textContent.trim() ?? '',
                disabled: Boolean(submit?.disabled),
                title: submit?.getAttribute('title') ?? '',
              }
            : null;
        },
        payoutForm,
        reporter.id
      );
    await adminPage.type(`#payout-${reporter.id}`, '100');
    await adminPage.type(`#payout-note-${reporter.id}`, 'E2E bank transfer, ref 4471');
    const tooMuch = await readPayout();
    check(
      'admin Record payout: above the balance is refused before sending, in the server\'s words',
      Boolean(tooMuch) &&
        tooMuch.disabled &&
        /more than this reporter's balance of \$7\.25\./.test(tooMuch.line) &&
        /more than this reporter's balance/.test(tooMuch.title),
      JSON.stringify(tooMuch)
    );
    await adminPage.click(`#payout-${reporter.id}`, { clickCount: 3 });
    await adminPage.type(`#payout-${reporter.id}`, '2.25');
    const fits = await readPayout();
    check(
      'admin Record payout: says the balance it will leave',
      Boolean(fits) && !fits.disabled && fits.line === 'Leaves $5 of their $7.25 balance.',
      JSON.stringify(fits)
    );
    await adminPage.click(`${payoutForm} button[type="submit"]`);
    await wait(1_000);
    const afterPayout = await adminPage.evaluate(() => document.querySelector('.tl-notice[data-tone="info"]')?.textContent ?? '');
    check(
      'admin Record payout: recorded, with what it left',
      /Recorded a payout of \$2\.25 to .+\. Their balance is now \$5\./.test(afterPayout),
      afterPayout
    );
    const reporterLedger = await (await apiAs(adminToken)(`/admin/accounts/${reporter.id}/credits`)).json().catch(() => null);
    const payouts = (reporterLedger?.entries ?? []).filter((entry) => entry.reason === 'reporter-payout');
    check(
      'admin Record payout: one reporter-payout row of -$2.25 carrying the note',
      payouts.length === 1 && payouts[0].deltaMilli === -2_250 && payouts[0].note === 'E2E bank transfer, ref 4471',
      JSON.stringify(payouts)
    );
    await adminPage.screenshot({ path: `${SHOTS}/shell-9-admin-reporter-row.png` });

    // An administrator may open Report Jobs too.
    await visit(adminPage, '/report', 'admin');
    const adminReport = await adminPage.evaluate(() => document.querySelector('.tl-main h1')?.textContent.trim());
    check('admin /report: opens Report Jobs', adminReport === 'Report Jobs', String(adminReport));

    // Post a notification as the admin, and confirm the bell shows it.
    await adminPage.goto(`${APP}/admin/notifications`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await adminPage.type('input[placeholder^="Scheduled"]', `E2E notice ${stamp}`);
    await adminPage.type('textarea', 'Posted by the shell walkthrough.');
    await adminPage.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === 'Post notification'
      );
      button?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const posted = await adminPage.evaluate(
      (needle) => document.body.textContent.includes(needle),
      `E2E notice ${stamp}`
    );
    check('admin: a posted notification is listed', posted);
    await adminPage.screenshot({ path: `${SHOTS}/shell-6-admin-notifications.png` });

    await adminPage.close();

    /* ------------------------------------- the bell, from the other side */
    const reader = await browser.newPage();
    await reader.setViewport(WIDE);
    await signIn(reader, userToken);
    await setTheme(reader, 'light');
    await reader.goto(`${APP}/orders`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 900));

    const beforeOpen = await reader.evaluate(() =>
      Boolean(document.querySelector('.tl-topbar button[aria-label^="Notifications,"]'))
    );
    check('user: the bell shows an unread dot after an admin posts', beforeOpen);

    await reader.evaluate(() => {
      document.querySelector('.tl-topbar button[aria-label^="Notifications"]')?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const panel = await reader.evaluate(
      (needle) => ({
        shows: document.body.textContent.includes(needle),
        stillUnread: Boolean(
          document.querySelector('.tl-topbar button[aria-label^="Notifications,"]')
        ),
      }),
      `E2E notice ${stamp}`
    );
    check('user: the notice is in the panel', panel.shows);
    check('user: opening it clears the dot', !panel.stillUnread);
    await reader.screenshot({ path: `${SHOTS}/shell-7-user-bell.png` });
    await reader.close();

    /* ----------------------------------------------------------- reporter */
    const reporterPage = await browser.newPage();
    await reporterPage.setViewport(WIDE);
    /*
     * Every API answer a reporter's session gets, refusals included. Their
     * pages ask only routes a reporter may use, and an address that is not
     * theirs is never mounted - so the whole walk, both widths and every
     * bounced address, must end with no 403 at all.
     */
    const reporterRefusals = [];
    reporterPage.on('response', (response) => {
      if (response.url().startsWith(API) && response.status() === 403) {
        reporterRefusals.push(new URL(response.url()).pathname);
      }
    });
    await signIn(reporterPage, reporterToken);
    await setTheme(reporterPage, 'light');

    let reporterShell;
    for (const route of REPORTER_ROUTES) {
      reporterShell = await visit(reporterPage, route, 'reporter');
      check(`reporter ${route}: stays on its own page`, new URL(reporterPage.url()).pathname === route, reporterPage.url());
    }
    check(
      'reporter: the rail reads Report Jobs, Credits, Settings',
      reporterShell.navLabels.join(' / ') === 'Report Jobs / Credits / Settings',
      `saw: ${reporterShell.navLabels.join(', ')}`
    );

    await reporterPage.goto(`${APP}/report`, { waitUntil: 'networkidle2' });
    await wait(500);
    const reportPage = await reporterPage.evaluate(() => ({
      title: document.querySelector('.tl-main h1')?.textContent.trim(),
      card: Array.from(document.querySelectorAll('.tl-card h2')).some((h) => h.textContent.trim() === 'Your job sheet'),
      // The Phase 5 placeholder said adding jobs "arrives in a later release"; it has arrived.
      later: /arrives in a later release/.test(document.body.innerText),
      // The rate a job pays them, which the page opens with.
      rate: /per job added/i.test(document.body.innerText),
      // The sheet button, when this machine's Google account made one: a new tab, on https.
      links: Array.from(document.querySelectorAll('.tl-main a[target="_blank"]')).map((a) => a.getAttribute('href')),
      lit: Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item[data-active="true"]')).map((a) => a.textContent.trim()),
      home: document.querySelector('.tl-brand a[aria-label="Tailor home"]')?.getAttribute('href'),
    }));
    check(
      'reporter /report: Report Jobs, their rate per job and their job sheet - no "later release" note',
      reportPage.title === 'Report Jobs' && reportPage.card && reportPage.rate && !reportPage.later,
      JSON.stringify(reportPage)
    );
    check(
      'reporter /report: any sheet link opens a new tab on https',
      reportPage.links.every((href) => /^https:\/\//.test(href ?? '')),
      JSON.stringify(reportPage.links)
    );
    check('reporter /report: Report Jobs is the lit row', reportPage.lit.join() === 'Report Jobs', reportPage.lit.join(', '));
    check('reporter: the logo leads to Report Jobs', reportPage.home === '/report', String(reportPage.home));

    await reporterPage.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await reporterPage
      .waitForFunction(() => /Paid out by an administrator/.test(document.body.innerText), { timeout: 10_000 })
      .catch(() => null);
    await reporterPage
      .waitForFunction(() => /Payout requests/.test(document.body.innerText), { timeout: 10_000 })
      .catch(() => null);
    const earnings = await reporterPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
      // Ask for Refund sits where Purchase Credits sits for a user: the
      // header row's right-hand slot, in the same pill button.
      const header = document.querySelector('.tl-main h1')?.parentElement;
      const slot = header?.querySelector(':scope > .ml-auto');
      const ask = slot?.querySelector('button');
      return {
        title: document.querySelector('.tl-main h1')?.textContent.trim(),
        label: /Earned, not yet paid out/.test(document.body.innerText),
        balance: /^\$5$/.test(document.querySelector('.border-coin p.text-xl')?.textContent.trim() ?? ''),
        buy: buttons.includes('Purchase Credits'),
        tabs: document.querySelectorAll('[role="tablist"][aria-label="Credits"]').length,
        heading: document.querySelector('#ledger-heading')?.textContent.trim(),
        ask: ask
          ? { text: ask.textContent.trim(), pill: ask.className === 'tl-button' && ask.dataset.shape === 'pill', disabled: ask.disabled }
          : null,
        payoutsHeading: document.querySelector('#refunds-heading')?.textContent.trim() ?? null,
        oldAsk: buttons.includes('Ask for refund'),
        columns: Array.from(document.querySelectorAll('.tl-table thead th')).map((th) => th.textContent.trim()),
        payout: /Paid out by an administrator/.test(document.body.innerText) && /E2E bank transfer, ref 4471/.test(document.body.innerText),
      };
    });
    check(
      "reporter /credits: their earnings - the balance after the payout, titled so",
      earnings.title === 'Credits' && earnings.label && earnings.balance,
      JSON.stringify(earnings)
    );
    check(
      'reporter /credits: no Purchase Credits, no order or refund tabs, no per-row Ask for refund',
      !earnings.buy && earnings.tabs === 0 && !earnings.oldAsk && !earnings.columns.includes('Action'),
      JSON.stringify(earnings)
    );
    check(
      'reporter /credits: Ask for Refund where Purchase Credits sits, in its style - on, with $5 to pay out',
      earnings.ask?.text === 'Ask for Refund' && earnings.ask.pill && earnings.ask.disabled === false,
      JSON.stringify(earnings.ask)
    );
    check(
      'reporter /credits: their payout requests are listed under it',
      earnings.payoutsHeading === 'Payout requests',
      JSON.stringify(earnings.payoutsHeading)
    );
    check(
      'reporter /credits: the history is Earnings and Payouts, with the payout and its note',
      earnings.heading === 'Earnings and Payouts' && earnings.payout,
      JSON.stringify(earnings)
    );
    await reporterPage.screenshot({ path: `${SHOTS}/shell-10-reporter-credits.png` });

    await reporterPage.goto(`${APP}/settings`, { waitUntil: 'networkidle2' });
    await wait(400);
    const reporterTabs = await reporterPage.evaluate(() => ({
      tabs: Array.from(document.querySelectorAll('nav.tl-tabs[aria-label="Settings"] .tl-tab')).map((a) => a.textContent.trim()),
      role: /Reporter/.test(document.querySelector('.tl-main')?.innerText ?? ''),
    }));
    check(
      'reporter /settings: Account and Job Sheet, and nothing else',
      reporterTabs.tabs.join(' / ') === 'Account / Job Sheet',
      reporterTabs.tabs.join(', ')
    );
    check('reporter /settings: their role reads Reporter', reporterTabs.role);
    // A reporter builds nothing, so has no folder path to set.
    check(
      'reporter /settings: no Resume files section',
      await reporterPage.evaluate(
        () =>
          !Array.from(document.querySelectorAll('.tl-section h2')).some((h) => h.textContent.trim() === 'Resume files') &&
          !document.getElementById('settings-output-path-suffix')
      )
    );

    // The account menu: earnings, the sheet, Settings, Contact admin, Log out - no subscription.
    const reporterBar = await inspectTopBar(reporterPage);
    check(
      'reporter top bar: the row reads Credits, Notifications, Theme, Account',
      (reporterBar?.controls ?? [])
        .map((name) =>
          /^Credits/.test(name) ? 'Credits' : /^Notifications/.test(name) ? 'Notifications' : /(mode|theme)$/i.test(name) ? 'Theme' : /^Account/.test(name) ? 'Account' : name
        )
        .join(' < ') === 'Credits < Notifications < Theme < Account',
      (reporterBar?.controls ?? []).join(' < ')
    );
    await reporterPage.evaluate(() => document.querySelector('.tl-topbar button[aria-label^="Account"]')?.click());
    await wait(300);
    const reporterMenu = await reporterPage.evaluate(() => {
      const panel = document.querySelector('.app-top-nav-menu');
      return panel
        ? {
            text: panel.innerText,
            hrefs: Array.from(panel.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), blank: a.target === '_blank' })),
          }
        : null;
    });
    check(
      'reporter account menu: Reporter, Earnings, Settings, Contact admin and Log out',
      Boolean(reporterMenu) && ['Reporter', 'Earnings', 'Settings', 'Contact admin', 'Log out'].every((word) => reporterMenu.text.includes(word)),
      JSON.stringify(reporterMenu)
    );
    check(
      'reporter account menu: no subscription, no profiles, no Subscription page',
      Boolean(reporterMenu) &&
        !/subscription/i.test(reporterMenu.text) &&
        !/Profiles/.test(reporterMenu.text) &&
        !reporterMenu.hrefs.some((link) => link.href === '/settings/subscription'),
      JSON.stringify(reporterMenu)
    );
    check(
      'reporter account menu: a job sheet link, when there is one, opens a new tab on https',
      Boolean(reporterMenu) &&
        reporterMenu.hrefs.filter((link) => link.blank).every((link) => /^https:\/\//.test(link.href ?? '')),
      JSON.stringify(reporterMenu?.hrefs)
    );
    await reporterPage.keyboard.press('Escape');

    // Every other address sends them to Report Jobs.
    for (const route of [...ROUTES, ...ADMIN_ROUTES, ...REPORTER_ELSEWHERE]) {
      if (REPORTER_ROUTES.includes(route)) continue;
      await reporterPage.goto(`${APP}${route}`, { waitUntil: 'networkidle2' });
      await reporterPage.waitForFunction(() => location.pathname === '/report', { timeout: 10_000 }).catch(() => null);
      check(`reporter ${route}: sent to Report Jobs`, new URL(reporterPage.url()).pathname === '/report', reporterPage.url());
    }

    // And on a phone: the drawer holds the same three rows.
    await reporterPage.setViewport(PHONE);
    for (const route of ['/report', '/credits']) {
      const phoneShell = await visit(reporterPage, route, 'reporter phone', { expectRail: false, compact: true });
      check(
        `reporter phone ${route}: the drawer holds Report Jobs, Credits, Settings`,
        phoneShell.navLabels.join(' / ') === 'Report Jobs / Credits / Settings',
        phoneShell.navLabels.join(', ')
      );
    }
    await reporterPage.screenshot({ path: `${SHOTS}/shell-11-reporter-phone.png`, fullPage: true });

    check(
      'reporter: not one request of the whole walk was refused',
      reporterRefusals.length === 0,
      reporterRefusals.join(', ')
    );
    await reporterPage.close();

    /*
     * Made a reporter while their page is open: the server reads the role on
     * every request, so the next one the page makes is refused - and that
     * refusal re-reads the account, so the shell redraws as a reporter's and
     * takes them to Report Jobs, rather than leaving a page of refusals.
     */
    const switcher = users.createUser({ email: `e2e-shell-switch-${stamp}@example.com`, name: 'Switching User' });
    const switchPage = await browser.newPage();
    await switchPage.setViewport(WIDE);
    await signIn(switchPage, users.createSession(switcher.id));
    await switchPage.goto(`${APP}/orders`, { waitUntil: 'networkidle2' });
    await wait(400);
    users.updateUser(switcher.id, { role: 'reporter' });
    // A client-side move, so nothing reloads the account but the refusal.
    await switchPage.evaluate(() => {
      Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item'))
        .find((link) => link.textContent.trim() === 'Profiles')
        ?.click();
    });
    await switchPage.waitForFunction(() => location.pathname === '/report', { timeout: 15_000 }).catch(() => null);
    await wait(400);
    const switched = await switchPage.evaluate(() => ({
      path: location.pathname,
      rail: Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item')).map((a) => a.textContent.trim()),
    }));
    check(
      'user made a reporter mid-session: the next refusal takes them to Report Jobs, with the reporter rail',
      switched.path === '/report' && switched.rail.join(' / ') === 'Report Jobs / Credits / Settings',
      JSON.stringify(switched)
    );
    await switchPage.close();

    /*
     * Made a reporter while on a page they keep, then to Settings -> Account:
     * nothing there is refused (the job sheet and their own account are every
     * role's), so no refusal re-reads the account. Resume files' own read of
     * it answers with the new role and no folder path, and hands it to the
     * session - so the page is drawn as a reporter's, rather than a "Could
     * not load where your resumes are saved" whose Try again never succeeds.
     */
    const settler = users.createUser({ email: `e2e-shell-settle-${stamp}@example.com`, name: 'Settling User' });
    const settlePage = await browser.newPage();
    await settlePage.setViewport(WIDE);
    await signIn(settlePage, users.createSession(settler.id));
    await settlePage.goto(`${APP}/settings/job-sheet`, { waitUntil: 'networkidle2' });
    await wait(400);
    users.updateUser(settler.id, { role: 'reporter' });
    // A client-side move again: the Account tab, which both roles keep.
    await settlePage.evaluate(() => {
      Array.from(document.querySelectorAll('nav.tl-tabs[aria-label="Settings"] .tl-tab'))
        .find((tab) => tab.textContent.trim() === 'Account')
        ?.click();
    });
    await settlePage
      .waitForFunction(
        () => location.pathname === '/settings' && /Reporter/.test(document.querySelector('.tl-main')?.innerText ?? ''),
        { timeout: 15_000 }
      )
      .catch(() => null);
    await wait(400);
    const settled = await settlePage.evaluate(() => ({
      path: location.pathname,
      reporter: /Reporter/.test(document.querySelector('.tl-main')?.innerText ?? ''),
      resumeFiles:
        Array.from(document.querySelectorAll('.tl-section h2')).some((h) => h.textContent.trim() === 'Resume files') ||
        Boolean(document.getElementById('settings-output-path-suffix')),
      alerts: Array.from(document.querySelectorAll('.tl-main [role="alert"]'))
        .map((node) => node.textContent.trim())
        .filter(Boolean),
      tabs: Array.from(document.querySelectorAll('nav.tl-tabs[aria-label="Settings"] .tl-tab')).map((a) => a.textContent.trim()),
      rail: Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item')).map((a) => a.textContent.trim()),
    }));
    check(
      'user made a reporter mid-session, then Settings -> Account: drawn as a reporter\'s, with no Resume files and no failure',
      settled.path === '/settings' &&
        settled.reporter &&
        !settled.resumeFiles &&
        settled.alerts.length === 0 &&
        settled.tabs.join(' / ') === 'Account / Job Sheet' &&
        settled.rail.join(' / ') === 'Report Jobs / Credits / Settings',
      JSON.stringify(settled)
    );
    await settlePage.close();

    /* ------------------------------- hiding is not the protection */
    const asUser = apiAs(userToken);

    const postNotice = await asUser('/admin/notifications', {
      method: 'POST',
      body: JSON.stringify({ title: 'Nope' }),
    });
    check('api: an ordinary user cannot post a notification', postNotice.status === 403, `got ${postNotice.status}`);

    const makeTemplate = await asUser('/templates/create-manual', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nope' }),
    });
    check('api: an ordinary user cannot create a template', makeTemplate.status === 403, `got ${makeTemplate.status}`);

    // The skill library is every account's, and managed from an admin page;
    // an ordinary account adds to it only by confirming a skill typed into a
    // resume.
    const addSkill = await asUser('/resume/skills', {
      method: 'POST',
      body: JSON.stringify({ type: 'soft', skill: 'Nope' }),
    });
    check('api: an ordinary user cannot add to the skill library', addSkill.status === 403, `got ${addSkill.status}`);

    const assistantPrompt = await asUser('/bid-assistant/settings/prompt-template');
    const assistantPromptBody = await assistantPrompt.json().catch(() => null);
    check(
      'api: an ordinary user reads the Bid Assistant prompt, told it cannot edit it',
      assistantPrompt.status === 200 && assistantPromptBody?.canEdit === false,
      `got ${assistantPrompt.status} ${JSON.stringify(assistantPromptBody)?.slice(0, 120)}`
    );
    const savePrompt = await asUser('/bid-assistant/settings/prompt-template', {
      method: 'PUT',
      body: JSON.stringify({ promptTemplate: 'Nope' }),
    });
    check('api: ...and cannot save it', savePrompt.status === 403, `got ${savePrompt.status}`);
    const deleteJob = await asUser('/bid-assistant/jobs/999999999', { method: 'DELETE' });
    check('api: an ordinary user cannot delete a Bid Assistant job', deleteJob.status === 403, `got ${deleteJob.status}`);
    // ...and the administrator can, which also takes the seeded job back off
    // the shared board.
    const removed = await removeSeededJob();
    check('api: the administrator deletes a Bid Assistant job', removed === 200, `got ${removed}`);

    // Refund requests and the contact list: the queue and the editor are the
    // administrators', the channels everybody's - signed out included.
    const queueAsUser = await asUser('/admin/refund-requests');
    check('api: an ordinary user cannot read the refund queue', queueAsUser.status === 403, `got ${queueAsUser.status}`);
    const approveAsUser = await asUser('/admin/refund-requests/rfr_nope/approve', { method: 'POST' });
    check('api: ...nor decide a refund request', approveAsUser.status === 403, `got ${approveAsUser.status}`);
    const contactAsUser = await asUser('/admin/contact', { method: 'PUT', body: JSON.stringify({ channels: [] }) });
    check('api: an ordinary user cannot change the contact details', contactAsUser.status === 403, `got ${contactAsUser.status}`);
    const ownRequests = await asUser('/refund-requests');
    check('api: an ordinary user lists their own refund requests', ownRequests.status === 200, `got ${ownRequests.status}`);
    const signedOutRequests = await fetch(`${API}/refund-requests`);
    check('api: signed out, there are no refund requests to list', signedOutRequests.status === 401, `got ${signedOutRequests.status}`);
    const publicContact = await fetch(`${API}/contact`);
    const publicContactBody = await publicContact.json().catch(() => null);
    check(
      'api: signed out, the contact channels are readable - and nothing else is in the answer',
      publicContact.status === 200 &&
        Object.keys(publicContactBody ?? {}).join() === 'channels' &&
        /no-store/.test(publicContact.headers.get('cache-control') ?? ''),
      `got ${publicContact.status} ${JSON.stringify(publicContactBody)?.slice(0, 160)}`
    );

    // A reporter typing a builder route by hand is refused by the route, not the page.
    const asReporter = apiAs(reporterToken);
    const reporterResumes = await asReporter('/resumes');
    const reporterResumesBody = await reporterResumes.json().catch(() => null);
    check(
      'api: a reporter is refused the builder, as their role',
      reporterResumes.status === 403 && reporterResumesBody?.code === 'role-not-allowed',
      `got ${reporterResumes.status} ${JSON.stringify(reporterResumesBody)}`
    );
    const reporterCheckout = await asReporter('/payments/checkout', { method: 'POST', body: JSON.stringify({ amountUsd: '50' }) });
    check(
      'api: ...and cannot buy credit',
      reporterCheckout.status === 403,
      `got ${reporterCheckout.status}`
    );
    const reporterMe = await (await asReporter('/auth/me')).json().catch(() => null);
    check(
      "api: a reporter's session says reporter, and never carries their rate",
      reporterMe?.account?.role === 'reporter' && !('reportRateMilli' in (reporterMe?.account ?? {})),
      JSON.stringify(reporterMe?.account && { role: reporterMe.account.role })
    );

    const disabled = await asUser('/templates?includeDisabled=true');
    check('api: an ordinary user asking for disabled templates is answered', disabled.status === 200);
    const body = await disabled.json();
    check(
      'api: ...and gets none of them',
      Array.isArray(body) && body.every((t) => !t.disabled),
      'a disabled template leaked to a non-admin'
    );

    /* ------------------------------------------------ signed out */
    // Everybody sees how to reach the administrator (owner decision A2) - the
    // person who cannot sign in most of all.
    // A context of its own: the other pages' session cookie is not in it.
    const strangers = await browser.createBrowserContext();
    const visitor = await strangers.newPage();
    await visitor.setViewport(PHONE);
    await visitor.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await wait(500);
    const offered = await visitor.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Contact admin');
      button?.click();
      return Boolean(button);
    });
    await wait(700);
    const contactDialog = await visitor.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Contact admin"]');
      return dialog
        ? { text: dialog.innerText, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }
        : null;
    });
    check(
      'signed out: the sign-in screen offers Contact admin, and it opens on a phone',
      offered && Boolean(contactDialog) && !contactDialog.overflow && !/could not/i.test(contactDialog.text),
      JSON.stringify(contactDialog)
    );
    await visitor.screenshot({ path: `${SHOTS}/shell-8-signed-out-contact.png` });
    await strangers.close();
  } finally {
    // Off the shared board even when the walk stopped short of deleting it.
    if (!seededJobGone) await removeSeededJob().catch(() => {});
    await browser.close();
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

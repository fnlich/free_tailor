/*
 * The app shell, on every page, as both roles, in both themes.
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
 *   - hiding is not the protection: the API refuses an ordinary user directly
 *
 * The session is seeded and injected, because there is no offline sign-in -
 * the same trick browser.js uses for the payment walkthrough. Servers are
 * expected to be up already (`npm run dev`), as they are there.
 *
 * Usage:  node test/e2e/shell.js
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const creditLedger = require(path.join(DIST, 'database', 'creditRepository'));

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
  '/admin/templates',
  '/admin/groups',
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
  await wait(350);
  const pressed = await page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes(label));
    button?.click();
    return Boolean(button);
  }, card);
  await wait(500);
  return pressed;
}

/**
 * A group of the builder's target radios as drawn: enabled or not, chosen or
 * not, and the Premium pill beside it - a link to the Subscription page, with
 * the reason on hover - if it has one.
 */
async function readChoices(page, name) {
  return page.evaluate(
    (radioName) =>
      Array.from(document.querySelectorAll(`input[type="radio"][name="${radioName}"]`)).map((input) => {
        const pill = input.closest('label')?.querySelector('a[href="/settings/subscription"]');
        return {
          value: input.value,
          disabled: input.disabled,
          checked: input.checked,
          pill: pill ? pill.textContent.trim() : null,
          title: pill ? pill.getAttribute('title') : null,
        };
      }),
    name
  );
}

/** The locked "Select Group" of sheet mode, if drawn: its select's state and its pill. */
async function readLockedGroup(page) {
  return page.evaluate(() => {
    const select = document.getElementById('sheets-group-locked');
    if (!select) return null;
    const pill = select.parentElement?.querySelector('a[href="/settings/subscription"]');
    return { disabled: select.disabled, pill: pill ? pill.textContent.trim() : null };
  });
}

const ONE_PROFILE = 'Your subscription supports one profile';
/** Locked as owner decisions B1-B3 say: disabled, with the Premium pill and its reason. */
const isLocked = (choice) =>
  Boolean(choice) && choice.disabled && choice.pill === 'Premium' && choice.title === ONE_PROFILE;
const isOpen = (choice) => Boolean(choice) && !choice.disabled && choice.pill === null;

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
  // On Default on purpose: the builder must lock nothing for an administrator
  // whatever their own subscription (owner decision B1).
  users.updateUser(admin.id, { role: 'admin', subscription: 'default' });

  const userToken = users.createSession(user.id);
  const adminToken = users.createSession(admin.id);

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
    for (const route of ROUTES) {
      shell = await visit(page, route, 'user');
    }

    /*
     * The rail, in the order it was asked for.
     *
     * Find Jobs is the account's own job sheet and is offered only once there
     * is a URL for it - which there is not on a machine with no Google
     * credentials, so it is allowed to be missing here and nowhere else.
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
    const railOrder = (labels) => labels.filter((label) => label !== 'Find Jobs').join(' / ');
    check(
      'user: the rail reads Profiles, Find Jobs, Build Resumes, Orders, Credits | Job Filter, Bid Assistant, Calendar | Templates, Settings',
      railOrder(shell.navLabels) === railOrder(RAIL),
      `saw: ${shell.navLabels.join(', ')}`
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
      userTabs.tabs.join(' / ') === 'Profile / Job Sheet / Payment Methods / Subscription',
      userTabs.tabs.join(', ')
    );
    check(
      'user /settings/subscription: Subscription is the lit tab, not Profile',
      userTabs.active === 'Subscription',
      String(userTabs.active)
    );
    check('user /settings/subscription: titled Settings', userTabs.title === 'Settings', String(userTabs.title));
    check(
      'user /settings/subscription: the Settings row is the one lit in the rail',
      userSettings.activeLabels.join() === 'Settings',
      `lit: ${userSettings.activeLabels.join(', ')}`
    );

    // The old account page still answers, by sending people to its new home.
    await page.goto(`${APP}/account`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    check('user /account: redirects to /settings', new URL(page.url()).pathname === '/settings', page.url());
    await page.goto(`${APP}/account#subscription`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      'user /account#subscription: redirects to /settings/subscription',
      new URL(page.url()).pathname === '/settings/subscription',
      page.url()
    );

    // So does the tier's page from before it was called a subscription, and
    // it replaces the history entry: Back must not land on it and bounce.
    await page.goto(`${APP}/settings`, { waitUntil: 'networkidle2' });
    await page.goto(`${APP}/settings/plan`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      'user /settings/plan: redirects to /settings/subscription',
      new URL(page.url()).pathname === '/settings/subscription',
      page.url()
    );
    const lit = await page.evaluate(
      () => document.querySelector('nav.tl-tabs[aria-label="Settings"] .tl-tab[data-active="true"]')?.textContent.trim()
    );
    check('user /settings/plan: lands with Subscription lit', lit === 'Subscription', String(lit));
    await page.goBack({ waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      'user /settings/plan: Back goes to the page before it, not to the old address',
      new URL(page.url()).pathname === '/settings',
      page.url()
    );
    await page.goto(`${APP}/settings/subscription`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tierCopy = await page.evaluate(() => document.querySelector('.tl-main')?.innerText ?? '');
    check(
      "user /settings/subscription: the page never calls the tier a plan",
      /Current subscription/.test(tierCopy) && !/\bplans?\b/i.test(tierCopy),
      tierCopy.slice(0, 300)
    );

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

    check(
      'user: Groups is hidden on the Default subscription',
      !shell.navLabels.includes('Groups'),
      `saw: ${shell.navLabels.join(', ')}`
    );

    /*
     * The builder's subscription locks (owner decisions B1-B3). A Default
     * subscription supports one profile: Multiple, All profiles, Specific
     * group and Select Group are drawn DISABLED with a Premium pill that leads
     * to the Subscription page - shown, so the account learns what Premium
     * adds - while Single, sheet mode and both ways to run stay open. The
     * server is the real lock (403 `subscription-too-low`); this checks the
     * page does not offer a door it would refuse.
     */
    check('user /: the Building Manually card opens', await openBuilder(page, 'Building Manually'));
    const manualChoices = await readChoices(page, 'generateMode');
    const single = manualChoices.find((choice) => choice.value === 'single');
    const multiple = manualChoices.find((choice) => choice.value === 'multiple');
    check(
      'user / manual: Single is open and chosen',
      isOpen(single) && single.checked,
      JSON.stringify(manualChoices)
    );
    check(
      'user / manual: Multiple is locked, with a Premium pill to /settings/subscription',
      isLocked(multiple) && !multiple.checked,
      JSON.stringify(manualChoices)
    );
    const importButton = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).some((b) => /Import from Google Sheet/i.test(b.textContent))
    );
    check('user / manual: no "Import from Google Sheet" button', !importButton);

    check('user /: the Google Sheet card opens', await openBuilder(page, 'Building Automatically from Google Sheet'));
    const sheetChoices = await readChoices(page, 'sheetsTargetMode');
    const byValue = (value) => sheetChoices.find((choice) => choice.value === value);
    check(
      'user / sheet: Single profile is open and chosen',
      isOpen(byValue('single')) && byValue('single').checked,
      JSON.stringify(sheetChoices)
    );
    check(
      'user / sheet: All profiles and Specific group are locked with the Premium pill',
      isLocked(byValue('all')) && isLocked(byValue('group')),
      JSON.stringify(sheetChoices)
    );
    const lockedGroup = await readLockedGroup(page);
    check(
      'user / sheet: Select Group is drawn locked with the Premium pill',
      Boolean(lockedGroup) && lockedGroup.disabled && lockedGroup.pill === 'Premium',
      JSON.stringify(lockedGroup)
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
    await page.screenshot({ path: `${SHOTS}/shell-builder-sheet-locked-phone.png`, fullPage: true });
    await page.setViewport(WIDE);

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

    // The prefix collision that a vertical rail makes obvious.
    const filter = await visit(page, '/jobs/filter', 'user');
    check(
      'user /jobs/filter: lights Job Filter alone, not Job Search too',
      filter.activeLabels.length === 1 && filter.activeLabels[0] === 'Job Filter',
      `lit: ${filter.activeLabels.join(', ') || 'nothing'}`
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
     * presets to $1000, so both are ordinary.
     */
    for (const milli of [16_477, 150_000]) {
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
        const expected = `$${(milli / 1000).toFixed(3)}`;
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

    await page.close();

    /* ------------------------------------------------------ admin, wide */
    const adminPage = await browser.newPage();
    await adminPage.setViewport(WIDE);
    await signIn(adminPage, adminToken);
    await setTheme(adminPage, 'light');

    let adminShell;
    for (const route of [...ROUTES, ...ADMIN_ROUTES]) {
      adminShell = await visit(adminPage, route, 'admin');
    }

    /*
     * An administrator is exempt from the subscriptions (owner decision B1),
     * whatever their own is - this one is on Default - so nothing is locked.
     */
    await openBuilder(adminPage, 'Building Manually');
    const adminManual = await readChoices(adminPage, 'generateMode');
    check(
      'admin / manual: Multiple is open, with no Premium pill',
      isOpen(adminManual.find((choice) => choice.value === 'multiple')),
      JSON.stringify(adminManual)
    );
    await openBuilder(adminPage, 'Building Automatically from Google Sheet');
    const adminSheet = await readChoices(adminPage, 'sheetsTargetMode');
    check(
      'admin / sheet: every target is open, and no locked Select Group',
      adminSheet.length === 3 && adminSheet.every(isOpen) && (await readLockedGroup(adminPage)) === null,
      JSON.stringify(adminSheet)
    );

    check(
      'admin: the same rail as everybody, Settings and Templates at its foot',
      railOrder(adminShell.navLabels) === railOrder(RAIL),
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
      onSettings.tabs.join(' / ') === 'Profile / Job Sheet / Payment Methods / Subscription / Administration',
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
    // an ordinary account adds to it only by confirming a skill in use.
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

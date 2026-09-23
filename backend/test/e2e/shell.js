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

const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Every route a signed-in person can reach. */
const ROUTES = [
  '/',
  '/account',
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

    return { viewport, past: worst, culprit, controls, group: (group?.className || '').toString().slice(0, 40) };
  });
}

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
  users.updateUser(admin.id, { role: 'admin' });

  const userToken = users.createSession(user.id);
  const adminToken = users.createSession(admin.id);

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

    check(
      'user: sidebar offers Find Jobs, not Settings or Manage Accounts',
      !shell.navLabels.includes('Settings') && !shell.navLabels.includes('Manage Accounts'),
      `saw: ${shell.navLabels.join(', ')}`
    );

    check(
      'user: Groups is hidden on the default plan',
      !shell.navLabels.includes('Groups'),
      `saw: ${shell.navLabels.join(', ')}`
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

      // Templates last, after the account. Names come from title/aria-label,
      // so this reads the same thing a screen reader would.
      const order = (bar?.controls ?? []).join(' < ');
      check(
        `top bar ${label}: Templates is last`,
        /Templates$/.test(order),
        order
      );
      check(
        `top bar ${label}: credits come first`,
        /^Credits/.test(order),
        order
      );
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

    check(
      'admin: sidebar offers Settings and Manage Accounts, not Find Jobs',
      adminShell.navLabels.includes('Settings') &&
        adminShell.navLabels.includes('Manage Accounts') &&
        !adminShell.navLabels.includes('Find Jobs'),
      `saw: ${adminShell.navLabels.join(', ')}`
    );

    // The settings hub second row, and only on settings routes.
    await adminPage.goto(`${APP}/admin/prompts`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const onSettings = await adminPage.evaluate(() => ({
      subnav: Boolean(document.querySelector('.tl-subnav')),
      active: document.querySelector('.tl-subnav-item[data-active="true"]')?.textContent.trim(),
      settingsRowLit: Boolean(
        Array.from(document.querySelectorAll('.tl-sidebar .tl-nav-item[data-active="true"]')).find(
          (a) => a.textContent.trim() === 'Settings'
        )
      ),
    }));
    check('admin /admin/prompts: the settings sub-nav is shown', onSettings.subnav);
    check('admin /admin/prompts: Prompts is the active tab', onSettings.active === 'Prompts', String(onSettings.active));
    check('admin /admin/prompts: the Settings sidebar row stays lit', onSettings.settingsRowLit);

    await adminPage.goto(`${APP}/orders`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const offSettings = await adminPage.evaluate(() =>
      Boolean(document.querySelector('.tl-subnav'))
    );
    check('admin /orders: no settings sub-nav outside the hub', !offSettings);

    await adminPage.screenshot({ path: `${SHOTS}/shell-5-admin-light.png` });

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
    const api = process.env.E2E_API || 'http://127.0.0.1:3001/api';
    const asUser = (path, init = {}) =>
      fetch(`${api}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${userToken}`,
          ...(init.headers ?? {}),
        },
      });

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

    const disabled = await asUser('/templates?includeDisabled=true');
    check('api: an ordinary user asking for disabled templates is answered', disabled.status === 200);
    const body = await disabled.json();
    check(
      'api: ...and gets none of them',
      Array.isArray(body) && body.every((t) => !t.disabled),
      'a disabled template leaked to a non-admin'
    );
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

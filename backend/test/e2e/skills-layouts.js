/*
 * Every template in both Technical Skills layouts, as a browser lays them out,
 * and the Grouped / Plain switch on the two pages that show a template.
 *
 * test/templateLayouts.test.js and test/skillsLayoutRender.test.js prove the
 * markup; only a browser can say where a box ends up. This drives the real
 * pages against running servers:
 *
 *   1. Every enabled template - the built-ins and whatever the installation
 *      has saved - drawn from the gallery route in each layout and laid out
 *      at the printed page's size (794x1123). Plain: every child of an element
 *      the Plain net marked (`data-plain-skills`) spans its holder's width and
 *      has no minimum height - Burgundy Rule and Navy Rule's one headless
 *      group used to fill one third-width cell of a grid. Grouped: no line
 *      of a leaf block (a p, li, td or a div with no block children; a line
 *      ends at a <br>) holds both the sample's "Languages" and "Frameworks"
 *      headings - the owner's ATS templates used to print Grouped as one
 *      run-on paragraph.
 *   2. An uploaded-style three-column grid saved through the admin upload,
 *      checked the same way in Plain, and deleted again.
 *   3. The template chooser (a new resume is for a profile, so it is opened as
 *      /admin/resumes/new?profile=<id> for a profile the script makes and
 *      removes): a template's details, "Plain" in its Technical skills switch,
 *      the page frame asking for `layout=flat`, and Use this template opening
 *      the editor with `&layout=flat` - and the profile - and Plain ticked. On
 *      the way: Plain, Grouped and Plain again, each page loaded first, add
 *      nothing to the browser's history (a loaded frame sent to another
 *      address did, one entry a press, and Back then turned the page back
 *      under the switch), and the arrow keys on the switch do not step to
 *      another template.
 *   4. Admin -> Templates: View, then Plain - the frame and "Open in new tab"
 *      both asking for `layout=flat`, and the viewer still open (a click that
 *      reaches its overlay closes it). Focus moves into the viewer when it
 *      opens, the presses add nothing to the history, and Escape closes it
 *      with focus back on the View that opened it.
 *
 * Steps 3 and 4 are checked at 1440x900 and at 390x844, where the switch must
 * sit inside the window with nothing scrolling sideways.
 *
 * Not part of `npm test`: it needs both servers up - the backend with a
 * preload that keeps it off Google (README.md, at the top: one started
 * without any gives the account this signs in a REAL spreadsheet when
 * backend/ holds a credential) - and DB_DIR naming the backend's database,
 * because the session is seeded straight into it. Step 2 saves a template
 * into the backend's templates directory and removes it at the end - run it
 * against a backend whose TAILOR_STATIC_DIR is a copy, as the README says.
 * Nothing else is written but that profile (deleted again at the end): the
 * editor step 3 opens is never saved.
 *
 * Usage, from backend/:
 *   TAILOR_STATIC_DIR=/path/to/static-copy DB_DIR=/path/to/db PORT=3001 \
 *     node --require ./test/e2e/no-google.js dist/index.js   # the backend
 *   DB_DIR=/path/to/db node test/e2e/skills-layouts.js
 *
 * Settings, all optional:
 *   E2E_APP    the frontend (default http://127.0.0.1:3000)
 *   E2E_API    the backend's /api (default http://127.0.0.1:3001/api)
 *   E2E_DIST   the compiled backend to seed the session with (default ../../dist)
 *   E2E_EMAIL  the administrator to sign in as (default layouts.probe@example.com,
 *              created and made an administrator when missing)
 *   E2E_SHOTS  a directory to save screenshots of the switches into
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const EMAIL = process.env.E2E_EMAIL || 'layouts.probe@example.com';
const SHOTS = process.env.E2E_SHOTS || '';

const PAGE = { width: 794, height: 1123 };
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An uploaded-style design: a grid of three category cells, a min-height on each, the loop directly in the grid. */
const GRID_TEMPLATE = {
  name: 'E2E Category Grid',
  description: 'skills-layouts.js',
  htmlContent:
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,sans-serif;font-size:12px}' +
    '.cells{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px}' +
    '.cell{min-height:60px;border-top:2px solid #333;padding-top:4px}.cell-title{font-weight:700}' +
    '</style></head><body><h1>{{name}}</h1><h2>Technical Skills</h2><div class="cells">' +
    '{{#each skillCategories}}<div class="cell"><div class="cell-title">{{category}}</div>' +
    '<div class="cell-skills">{{join skills ", "}}</div></div>{{/each}}</div>' +
    '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}</body></html>',
  cssContent: '',
};

async function api(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

/** Saves a template the way an administrator uploads one (a JSON file), and answers its id. */
async function uploadTemplate(token, template) {
  const form = new FormData();
  form.append('template', new Blob([JSON.stringify(template)], { type: 'application/json' }), 'template.json');
  const response = await fetch(`${API}/templates/upload-json`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  const id = body.templates?.[0]?.id;
  if (response.status !== 201 || !id) {
    throw new Error(`Uploading "${template.name}" answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return id;
}

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: new URL(APP).hostname, path: '/', httpOnly: true, sameSite: 'Lax' });
}

async function shoot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** What a laid-out page says about its skills block, in one layout. */
function measureSkills(page) {
  return page.evaluate(() => {
    const plain = [];
    const holders = Array.from(document.querySelectorAll('[data-plain-skills]'));
    for (const holder of holders) {
      const style = getComputedStyle(holder);
      const room = holder.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      for (const child of Array.from(holder.children)) {
        if (child.offsetWidth < room * 0.95) {
          plain.push(`a group ${child.offsetWidth}px wide in a ${Math.round(room)}px holder`);
        }
        const minHeight = getComputedStyle(child).minHeight;
        if (minHeight !== '0px') plain.push(`a group with min-height ${minHeight}`);
      }
    }
    const BLOCKS = new Set(['DIV', 'P', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'TD', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4']);
    const leaves = Array.from(document.querySelectorAll('p, li, td, div')).filter(
      (element) => !Array.from(element.children).some((child) => BLOCKS.has(child.tagName))
    );
    // A line ends at a <br>: a joined line kept in its span or td prints its groups that way.
    const lines = (element) => element.innerHTML.split(/<br\s*\/?>/i).map((part) => part.replace(/<[^>]*>/g, ' '));
    const runOn = leaves
      .filter((element) => lines(element).some((line) => /\bLanguages\b/.test(line) && /\bFrameworks\b/.test(line)))
      .map((element) => element.outerHTML.replace(/\s+/g, ' ').slice(0, 160));
    return { marked: holders.length, plain, runOn };
  });
}

/** Draws one template's gallery page in one layout and checks its skills block; answers the problems. */
async function checkTemplate(page, token, id, layout) {
  const html = await api(token, 'GET', `/templates/${encodeURIComponent(id)}/preview?layout=${layout}`);
  await page.setViewport(PAGE);
  await page.setContent(html, { waitUntil: 'load' });
  const measured = await measureSkills(page);
  const problems =
    layout === 'flat'
      ? measured.plain
      : [
          ...measured.runOn.map((line) => `a run-on line: ${line}`),
          ...(measured.marked > 0 ? [`${measured.marked} holder(s) marked in Grouped, the design as written`] : []),
        ];
  return { marked: measured.marked, problems };
}

/** The Technical skills switch inside `scope`, and its buttons' state. */
function readSwitch(page, scope) {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector);
    const group = root?.querySelector('[role="group"][aria-label="Technical skills"]');
    if (!group) return null;
    const box = group.getBoundingClientRect();
    return {
      right: box.right,
      left: box.left,
      pressed: Array.from(group.querySelectorAll('button')).map((button) => [
        button.textContent.trim(),
        button.getAttribute('aria-pressed'),
      ]),
      windowWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  }, scope);
}

/** Clicks the switch's button named `label` with the mouse, inside `scope`. */
async function pressSwitch(page, scope, label) {
  const button = await page.evaluateHandle(
    (scopeSelector, wanted) =>
      Array.from(document.querySelectorAll(`${scopeSelector} [role="group"][aria-label="Technical skills"] button`)).find(
        (candidate) => candidate.textContent.trim() === wanted
      ) ?? null,
    scope,
    label
  );
  const element = button.asElement();
  if (!element) throw new Error(`No "${label}" in the Technical skills switch`);
  await element.click();
}

async function waitFor(page, predicate, arg, what, timeout = 15_000) {
  try {
    await page.waitForFunction(predicate, { timeout }, arg);
  } catch {
    throw new Error(`Timed out waiting for ${what}`);
  }
}

/** Waits until the frame inside `scope` shows the page for `layout`, loaded. */
async function frameLoaded(page, scope, layout, what, timeout = 15_000) {
  const wanted = new RegExp(`[?&]layout=${layout}\\b`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const handle = await page.$(`${scope} iframe`);
      const frame = handle && (await handle.contentFrame());
      if (frame && wanted.test(frame.url()) && (await frame.evaluate(() => document.readyState === 'complete'))) return;
    } catch {
      // Between frames: the old one is going and the new one has not loaded.
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const historyLength = (page) => page.evaluate(() => history.length);

/**
 * Grouped, then Plain again, in the switch inside `scope`, which shows Plain -
 * each page loaded before the next press, since only a loaded frame sent to
 * another address adds an entry to the browser's history.
 */
async function pressBackAndForth(page, scope, label) {
  await frameLoaded(page, scope, 'flat', `${label}: the Plain page`);
  await pressSwitch(page, scope, 'Grouped');
  await frameLoaded(page, scope, 'categorized', `${label}: the Grouped page again`);
  await pressSwitch(page, scope, 'Plain');
  await frameLoaded(page, scope, 'flat', `${label}: the Plain page again`);
}

/**
 * The arrow keys on the details' switch: they step through the templates from
 * anywhere in the details but there, where a step moved focus to the next
 * template's Use this template and the next Space started a resume on it.
 */
async function checkArrowsOnSwitch(page, scope, label) {
  const shown = () => page.evaluate((selector) => document.querySelector(selector).getAttribute('aria-labelledby'), scope);
  const before = await shown();
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    await page.evaluate((selector) => {
      Array.from(document.querySelectorAll(`${selector} [role="group"][aria-label="Technical skills"] button`))
        .find((button) => button.getAttribute('aria-pressed') === 'true')
        .focus();
    }, scope);
    await page.keyboard.press(key);
    await wait(300);
    const now = await shown();
    if (now !== before) throw new Error(`${label}: ${key} on the switch stepped from ${before} to ${now}`);
  }
}

/** The chooser's details: Plain, the frame, Use this template, the editor. */
async function checkChooser(page, viewport, profileId) {
  const label = `${viewport.width}x${viewport.height}`;
  await page.setViewport(viewport);
  // For a profile: a new resume is filed under one, and both steps keep it in their addresses.
  await page.goto(`${APP}/admin/resumes/new${profileId ? `?profile=${encodeURIComponent(profileId)}` : ''}`, {
    waitUntil: 'networkidle2',
  });
  // Any resume may use any template: every card opens, none is "used" by another resume.
  await page.waitForSelector('[data-template-card]', { timeout: 20_000 });
  const templateId = await page.evaluate(() => {
    const card = document.querySelector('[data-template-card]');
    card.click();
    return card.getAttribute('data-template-card');
  });
  const DETAILS = '[role="dialog"][aria-modal="true"]';
  await page.waitForSelector(`${DETAILS} [role="group"][aria-label="Technical skills"]`, { timeout: 10_000 });

  const opened = await readSwitch(page, DETAILS);
  if (JSON.stringify(opened.pressed) !== JSON.stringify([['Grouped', 'true'], ['Plain', 'false']])) {
    throw new Error(`${label}: the details opened on ${JSON.stringify(opened.pressed)}, not Grouped`);
  }
  await frameLoaded(page, DETAILS, 'categorized', `${label}: the details' Grouped page`);
  const historyBefore = await historyLength(page);
  await pressSwitch(page, DETAILS, 'Plain');
  await waitFor(
    page,
    (selector) => Array.from(document.querySelectorAll(`${selector} iframe`)).some((frame) => /[?&]layout=flat\b/.test(frame.src)),
    DETAILS,
    `${label}: the details frame to ask for layout=flat`
  );
  const pressed = await readSwitch(page, DETAILS);
  if (JSON.stringify(pressed.pressed) !== JSON.stringify([['Grouped', 'false'], ['Plain', 'true']])) {
    throw new Error(`${label}: after Plain the switch reads ${JSON.stringify(pressed.pressed)}`);
  }
  if (pressed.right > pressed.windowWidth + 0.5 || pressed.left < -0.5) {
    throw new Error(`${label}: the switch runs from ${pressed.left} to ${pressed.right}px in a ${pressed.windowWidth}px window`);
  }
  if (pressed.scrollWidth > pressed.windowWidth) {
    throw new Error(`${label}: the page scrolls sideways (${pressed.scrollWidth}px in ${pressed.windowWidth}px)`);
  }
  await pressBackAndForth(page, DETAILS, label);
  const added = (await historyLength(page)) - historyBefore;
  if (added !== 0) throw new Error(`${label}: Plain, Grouped and Plain added ${added} entries to the browser's history`);
  await checkArrowsOnSwitch(page, DETAILS, label);
  await wait(600);
  await shoot(page, `skills-layouts-details-plain-${label}`);

  await page.evaluate((selector) => {
    const use = Array.from(document.querySelectorAll(`${selector} button`)).find(
      (button) => button.textContent.trim() === 'Use this template'
    );
    if (!use || use.disabled) throw new Error('Use this template is not there to press');
    use.click();
  }, DETAILS);
  await waitFor(
    page,
    (id) => location.pathname === '/admin/resumes/new' && new URLSearchParams(location.search).get('template') === id && new URLSearchParams(location.search).get('layout') === 'flat',
    templateId,
    `${label}: the editor's address to carry &layout=flat`
  );
  if (profileId) {
    const named = await page.evaluate(() => new URLSearchParams(location.search).get('profile'));
    if (named !== profileId) throw new Error(`${label}: the editor's address lost the profile: ?profile=${named}`);
  }
  await page.waitForSelector('#resume-layout-flat', { timeout: 15_000 });
  const ticked = await page.evaluate(() => document.getElementById('resume-layout-flat').checked);
  if (!ticked) throw new Error(`${label}: the editor opened with Plain unticked`);
  return templateId;
}

/** Admin -> Templates' View: Plain, the frame and the new tab's link, the viewer still open. */
async function checkViewer(page, viewport) {
  const label = `${viewport.width}x${viewport.height}`;
  await page.setViewport(viewport);
  await page.goto(`${APP}/admin/templates`, { waitUntil: 'networkidle2' });
  await waitFor(
    page,
    () => Array.from(document.querySelectorAll('button')).some((button) => button.textContent.trim() === 'View'),
    undefined,
    `${label}: a View button`,
    20_000
  );
  // Focused first, as it is when a keyboard opens it: closing gives focus back to it.
  await page.evaluate(() => {
    const view = Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'View');
    view.focus();
    view.click();
  });
  const VIEWER = '[role="dialog"][aria-modal="true"]';
  await page.waitForSelector(`${VIEWER} [role="group"][aria-label="Technical skills"]`, { timeout: 10_000 });
  // Drawn after the whole grid: with focus left on View, Tab walked every card behind the overlay first.
  await waitFor(
    page,
    (selector) => Boolean(document.querySelector(selector)?.contains(document.activeElement)),
    VIEWER,
    `${label}: focus to move into the viewer`,
    5_000
  );
  await frameLoaded(page, VIEWER, 'categorized', `${label}: the viewer's Grouped page`);
  const historyBefore = await historyLength(page);
  await pressSwitch(page, VIEWER, 'Plain');
  await waitFor(
    page,
    (selector) => {
      const viewer = document.querySelector(selector);
      const frame = viewer?.querySelector('iframe');
      const link = Array.from(viewer?.querySelectorAll('a') ?? []).find((anchor) => anchor.textContent.trim() === 'Open in new tab');
      return Boolean(frame && link && /[?&]layout=flat\b/.test(frame.src) && /[?&]layout=flat\b/.test(link.href));
    },
    VIEWER,
    `${label}: the viewer's frame and "Open in new tab" to ask for layout=flat`
  );
  const state = await readSwitch(page, VIEWER);
  if (!state) throw new Error(`${label}: pressing Plain closed the viewer`);
  if (JSON.stringify(state.pressed) !== JSON.stringify([['Grouped', 'false'], ['Plain', 'true']])) {
    throw new Error(`${label}: after Plain the switch reads ${JSON.stringify(state.pressed)}`);
  }
  if (state.right > state.windowWidth + 0.5 || state.left < -0.5) {
    throw new Error(`${label}: the switch runs from ${state.left} to ${state.right}px in a ${state.windowWidth}px window`);
  }
  const close = await page.evaluate((selector) => {
    const button = Array.from(document.querySelector(selector).querySelectorAll('button')).find(
      (candidate) => candidate.textContent.trim() === 'Close'
    );
    return button ? button.getBoundingClientRect().right : null;
  }, VIEWER);
  if (close === null || close > state.windowWidth + 0.5) throw new Error(`${label}: Close is off the window's edge`);
  await pressBackAndForth(page, VIEWER, label);
  const added = (await historyLength(page)) - historyBefore;
  if (added !== 0) throw new Error(`${label}: Plain, Grouped and Plain added ${added} entries to the browser's history`);
  await wait(600);
  await shoot(page, `skills-layouts-viewer-plain-${label}`);

  await page.keyboard.press('Escape');
  await waitFor(page, (selector) => !document.querySelector(selector), VIEWER, `${label}: Escape to close the viewer`, 5_000);
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
  if (focused !== 'View') throw new Error(`${label}: closing the viewer left focus on ${JSON.stringify(focused)}, not View`);
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const { account } = users.findOrCreateUser({ email: EMAIL, name: 'Layouts Probe' });
  if (account.role !== 'admin') users.updateUser(account.id, { role: 'admin' });
  const token = users.createSession(account.id);

  let failures = 0;
  const report = (ok, what, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok    ' : 'FAILED'}  ${what}${detail ? `\n  ${detail}` : ''}`);
  };

  let uploadedId = '';
  let profileId = '';
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));

    // 1. Every enabled template, in both layouts.
    const templates = JSON.parse(await api(token, 'GET', '/templates'));
    const marked = [];
    for (const template of templates) {
      for (const layout of ['categorized', 'flat']) {
        const { marked: holders, problems } = await checkTemplate(page, token, template.id, layout);
        if (layout === 'flat' && holders > 0) marked.push(template.id);
        report(problems.length === 0, `${template.id.padEnd(40)} ${layout}`, problems.join('\n  '));
      }
    }
    console.log(`        Plain net marked: ${marked.length > 0 ? marked.join(', ') : 'nothing'}`);
    for (const id of ['burgundy-rule', 'navy-rule']) {
      if (templates.some((template) => template.id === id)) {
        report(marked.includes(id), `${id} has its category grid marked in Plain`);
      }
    }

    // 2. An uploaded-style category grid, saved, checked, deleted.
    uploadedId = await uploadTemplate(token, GRID_TEMPLATE);
    const grid = await checkTemplate(page, token, uploadedId, 'flat');
    report(grid.marked === 1 && grid.problems.length === 0, 'an uploaded category grid draws Plain across its row', [
      grid.marked === 1 ? '' : `${grid.marked} holder(s) marked`,
      ...grid.problems,
    ].filter(Boolean).join('\n  '));
    const gridGrouped = await checkTemplate(page, token, uploadedId, 'categorized');
    report(gridGrouped.marked === 0 && gridGrouped.problems.length === 0, 'and Grouped as its own cells', gridGrouped.problems.join('\n  '));
    await api(token, 'DELETE', `/templates/${encodeURIComponent(uploadedId)}`);
    uploadedId = '';

    // 3 and 4, wide and on a phone. The chooser is opened for a profile of its own.
    try {
      profileId = JSON.parse(await api(token, 'POST', '/profiles', { name: 'E2E Skills Layouts' })).id || '';
    } catch (error) {
      console.warn(`Could not make a profile; the chooser is opened without one: ${error.message}`);
    }
    await signIn(page, token);
    for (const viewport of [WIDE, PHONE]) {
      try {
        const id = await checkChooser(page, viewport, profileId);
        report(true, `the chooser's details switch to Plain, add no history, keep the arrows off the switch, and start ${id} Plain (${viewport.width}px)`);
      } catch (error) {
        report(false, `the chooser's Grouped / Plain switch (${viewport.width}px)`, error.message);
      }
      try {
        await checkViewer(page, viewport);
        report(true, `Admin -> Templates' View takes focus, switches to Plain with no history, stays open, and gives focus back on Escape (${viewport.width}px)`);
      } catch (error) {
        report(false, `Admin -> Templates' Grouped / Plain switch (${viewport.width}px)`, error.message);
      }
    }
  } finally {
    await browser.close();
    if (uploadedId) {
      await api(token, 'DELETE', `/templates/${encodeURIComponent(uploadedId)}`).catch((error) => console.warn(error.message));
    }
    if (profileId) {
      await api(token, 'DELETE', `/profiles/${encodeURIComponent(profileId)}`).catch((error) => console.warn(error.message));
    }
  }

  console.log(failures === 0 ? '\nEvery check passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/*
 * The profile editor's preview, held still: does the page in the preview pane
 * keep one size, or does it shake?
 *
 * The shake this guards against is a feedback loop, not a slow render. The
 * pane scales the resume to the well it sits in, and the well scrolls. With a
 * scrollbar that takes room - Windows and Linux Chrome, macOS with "always
 * show scroll bars" - a one-page resume that is just taller than the well
 * brings the scrollbar in, the well gets ~15px narrower, the page is scaled
 * down ~3% and now fits, the scrollbar goes, the page grows back and
 * overflows... every frame, with nobody touching anything. At 1920x937 (a
 * 1080p Windows screen) that band holds EVERY one-page document, so it looked
 * like "every template but one": the one whose rendering ran to a second page
 * kept its scrollbar and stood still.
 *
 * The same loop formed one level up in the narrow layout, where the WINDOW
 * scrolls the preview and the page is scaled to the window's width: a window
 * just the height of the page (a portrait 1080x1460, say) shook through the
 * window's own scrollbar. That height depends on the profile, so a viewport
 * written `1080xband` is measured first - the Preview tab's height with the
 * window's scrollbar in - and watched 5px taller, inside the band.
 *
 * Puppeteer hides scrollbars by default (`--hide-scrollbars`), which is why
 * no earlier screenshot or walkthrough ever saw it. This one launches with
 * real scrollbars, opens the editor for one profile, picks each template in
 * turn, and reads the page's width, the well's width and both scrollbars on
 * EVERY animation frame for a few seconds. A template passes when none of
 * them changes once the page has settled.
 *
 * Not part of `npm test`: it needs both servers up. Servers are expected to be
 * running already, as for shell.js, and DB_DIR must name the backend's
 * database, because the session is seeded straight into it.
 *
 * Usage:
 *   node test/e2e/preview-vibration.js
 *
 * Settings, all optional:
 *   E2E_APP        the frontend (default http://127.0.0.1:3000)
 *   E2E_API        the backend's /api (default http://127.0.0.1:3001/api)
 *   E2E_DIST       the compiled backend to seed the session with (default ../../dist)
 *   E2E_EMAIL      the account to sign in as (default vibration.probe@example.com,
 *                  created when missing; give it a profile or set E2E_PROFILE_ID)
 *   E2E_PROFILE_ID the profile to open (default: the account's first)
 *   E2E_VIEWPORTS  comma-separated WxH, or Wxband for the narrow window band
 *                  (default 1920x937,1903x937,1440x900,1080xband)
 *   E2E_TEMPLATES  comma-separated template ids (default: every one the picker offers)
 *   E2E_SECONDS    how long each template is watched (default 3)
 *   E2E_NO_GUTTER  1 to switch scrollbar-gutter off on every element, as a
 *                  browser without it would: proves ProfilePreview's own
 *                  guard settles the page by itself
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const EMAIL = process.env.E2E_EMAIL || 'vibration.probe@example.com';
const SECONDS = Number(process.env.E2E_SECONDS) > 0 ? Number(process.env.E2E_SECONDS) : 3;
const VIEWPORTS = (process.env.E2E_VIEWPORTS || '1920x937,1903x937,1440x900,1080xband')
  .split(',')
  .map((entry) => entry.trim().match(/^(\d+)x(\d+|band)$/))
  .filter(Boolean)
  .map((match) => ({ width: Number(match[1]), height: match[2] === 'band' ? 'band' : Number(match[2]) }));
const ONLY_TEMPLATES = (process.env.E2E_TEMPLATES || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const NO_GUTTER = process.env.E2E_NO_GUTTER === '1';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: new URL(APP).hostname, path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** Waits until the pane says "Up to date" and its front frame has loaded `templateName`. */
async function waitForCurrent(page, templateName, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const pane = document.querySelector('aside[aria-label="Resume preview"]');
      if (!pane) return null;
      return {
        status: pane.querySelector('[role="status"]')?.textContent?.trim() ?? '',
        shown: pane.querySelector('p.truncate')?.textContent?.trim() ?? '',
        framed: Boolean(pane.querySelector('iframe[data-front="true"]')),
      };
    });
    if (state && state.framed && state.status === 'Up to date' && (!templateName || state.shown === templateName)) {
      return true;
    }
    await wait(100);
  }
  return false;
}

/**
 * Every animation frame for `ms`: the page's width, the well's inner width and
 * its scrollbar. Read in the page, so nothing between two frames is missed.
 */
function sample(page, ms) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const pane = document.querySelector('aside[aria-label="Resume preview"]');
        const frames = [];
        const started = performance.now();
        const tick = () => {
          const frame = pane?.querySelector('iframe[data-front="true"]');
          const sheet = frame?.parentElement ?? null;
          const well = sheet?.parentElement ?? null;
          if (sheet && well) {
            const box = sheet.getBoundingClientRect();
            frames.push({
              sheetW: Math.round(box.width * 10) / 10,
              sheetH: Math.round(box.height * 10) / 10,
              wellW: well.clientWidth,
              // A classic scrollbar is the difference between the box and its
              // inside; an overlay one takes no room and reads 0.
              bar: well.offsetWidth - well.clientWidth,
              overflows: well.scrollHeight > well.clientHeight,
              docH: Math.round(parseFloat(frame.style.height) || 0),
              // The window's own scrollbar: in the narrow layout the window
              // scrolls instead of the well, and the same loop could form there.
              winBar: window.innerWidth - document.documentElement.clientWidth,
            });
          }
          if (performance.now() - started < duration) requestAnimationFrame(tick);
          else resolve(frames);
        };
        requestAnimationFrame(tick);
      }),
    ms
  );
}

/** How often each measure changed between consecutive frames. */
function summarize(frames) {
  const changes = (key) => frames.reduce((count, frame, i) => count + (i > 0 && frames[i - 1][key] !== frame[key] ? 1 : 0), 0);
  const distinct = (key) => [...new Set(frames.map((frame) => frame[key]))];
  return {
    frames: frames.length,
    widths: distinct('sheetW'),
    wellWidths: distinct('wellW'),
    bars: distinct('bar'),
    docHeights: distinct('docH'),
    winBars: distinct('winBar'),
    widthChanges: changes('sheetW'),
    barChanges: changes('bar') + changes('winBar'),
    overflowChanges: changes('overflows'),
  };
}

async function main() {
  if (VIEWPORTS.length === 0) throw new Error('E2E_VIEWPORTS names no WxH viewport.');
  const { account } = users.findOrCreateUser({ email: EMAIL, name: 'Vibration Probe' });
  const token = users.createSession(account.id);

  let profileId = process.env.E2E_PROFILE_ID || '';
  if (!profileId) {
    const response = await fetch(`${API}/profiles`, { headers: { authorization: `Bearer ${token}` } });
    const list = await response.json();
    const profiles = Array.isArray(list) ? list : list.profiles || [];
    profileId = profiles[0]?.id || '';
  }
  if (!profileId) throw new Error(`${EMAIL} has no profile to open; create one or set E2E_PROFILE_ID.`);

  // Real scrollbars: the loop cannot form without them.
  const browser = await puppeteer.launch({ args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  let shaking = 0;
  const rows = [];
  try {
    const page = await browser.newPage();
    // Picking a template dirties the draft, and leaving asks first.
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    if (NO_GUTTER) {
      // From the first paint, so the guard meets the scrollbar's first
      // appearance rather than a strip it was already shown reserved.
      await page.evaluateOnNewDocument(() => {
        const add = () => {
          const style = document.createElement('style');
          style.textContent = '*, html { scrollbar-gutter: auto !important; }';
          document.head.appendChild(style);
        };
        if (document.head) add();
        else document.addEventListener('DOMContentLoaded', add);
      });
    }
    await signIn(page, token);

    for (const wanted of VIEWPORTS) {
      const band = wanted.height === 'band';
      const viewport = { width: wanted.width, height: band ? 900 : wanted.height };
      await page.setViewport(viewport);
      await page.goto(`${APP}/admin/profiles/${profileId}`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#profile-template option[value]:not([value=""])', { timeout: 15_000 });
      // A narrow window shows the form OR the preview; the preview is what is watched.
      await page.evaluate(() => {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((node) => node.textContent.trim() === 'Preview');
        if (tab && tab.offsetParent !== null) tab.click();
      });
      if (!(await waitForCurrent(page, null))) throw new Error('The preview never said "Up to date".');
      if (band) {
        // The Preview tab's height with the window's scrollbar in; 5px more
        // is inside the band where, unfixed, the scrollbar takes itself away.
        await wait(400);
        viewport.height = (await page.evaluate(() => document.documentElement.scrollHeight)) + 5;
        await page.setViewport(viewport);
        await wait(400);
      }

      const probed = new Set();
      for (const layout of ['categorized', 'flat']) {
        // Through the DOM, not the mouse: in the narrow layout the form is
        // behind the Preview tab and has no box to click.
        const switched = await page.evaluate((value) => {
          const radio = document.querySelector(`input[type=radio][value="${value}"]`);
          if (!radio || radio.checked) return false;
          radio.click();
          return true;
        }, layout);
        if (switched) await wait(300);
        const options = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#profile-template option'))
            .filter((option) => option.value && !option.disabled)
            .map((option) => ({ id: option.value, name: option.textContent.trim().replace(/ \(.*\)$/, '') }))
        );
        for (const option of options) {
          if (probed.has(option.id)) continue;
          if (ONLY_TEMPLATES.length > 0 && !ONLY_TEMPLATES.includes(option.id)) continue;
          probed.add(option.id);
          await page.select('#profile-template', option.id);
          const current = await waitForCurrent(page, option.name);
          // Long enough for the swap, the ResizeObserver and a re-render to
          // have happened once; a loop keeps going after that, a settle does not.
          await wait(400);
          const summary = summarize(await sample(page, SECONDS * 1000));
          const shakes = summary.widthChanges > 0 || summary.barChanges > 0;
          if (shakes) shaking += 1;
          rows.push({ viewport: `${viewport.width}x${viewport.height}`, layout, template: option.id, current, ...summary });
          console.log(
            `${shakes ? 'SHAKES' : 'still '}  ${viewport.width}x${viewport.height}  ${option.id.padEnd(20)} ` +
              `doc ${summary.docHeights.join('/')}px  page ${summary.widths.join(' <-> ')}px  ` +
              `well ${summary.wellWidths.join(' <-> ')}px  bar ${summary.bars.join(' <-> ')}px  ` +
              `window bar ${summary.winBars.join(' <-> ')}px  ` +
              `changes ${summary.widthChanges} in ${summary.frames} frames${current ? '' : '  (never "Up to date")'}`
          );
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (process.env.E2E_JSON) {
    require('fs').writeFileSync(process.env.E2E_JSON, JSON.stringify(rows, null, 2));
  }
  console.log(
    `\n${rows.length} template/viewport pair(s) watched for ${SECONDS}s each: ` +
      `${shaking === 0 ? 'none shook.' : `${shaking} shook.`}`
  );
  process.exit(shaking === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

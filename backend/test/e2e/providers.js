/*
 * Admin -> Models -> Providers, the per-provider cards on Settings -> General
 * and the provider on an order's page, in a real browser against a real
 * server whose Claude seat is a stub (stub-seat.js, registered under the TYPE
 * id, so it stands in for every Claude provider an administrator adds).
 *
 * test/aiProviders.test.js and test/providerQueues.test.js prove the routes,
 * the lanes and the pool over HTTP; test/frontendProviders.test.js proves the
 * page's own decisions against the server's rules. This proves they are
 * joined up:
 *
 *   - the table lists the three built-in providers, each marked Built-in,
 *     with no Remove, and where each value comes from
 *   - Add provider: a relative folder is refused in the box before anything
 *     is sent; a folder that does not exist is refused BY THE SERVER, and the
 *     sentence is pinned under the same box; a real one is added, with its
 *     limit "Set here" and its binary the built-in's
 *   - Edit: a limit of 40 is refused in the server's words, 3 is saved; a
 *     built-in's limit set here, then cleared back to what .env says
 *   - Switch off / on, Check now
 *   - Settings -> General draws one card per provider, and the type's row
 *     counts how many of its providers can take work
 *   - with the built-in Claude provider switched off, an order runs on the
 *     added one: Remove is refused, in the server's sentence, while it builds
 *     - and the order's page names it for the administrator
 *   - an ordinary account's order page names no provider, its API answer has
 *     no `ranOn`, the provider routes refuse it, and Admin -> Models shows it
 *     nothing
 *   - no horizontal page scroll at 390px on Admin -> Models
 *
 * Servers are expected to be up already, the backend preloaded with the stub
 * seat and sharing DB_DIR with this script:
 *
 *   E2E_STUB_DELAY_MS=2500 DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js dist/index.js
 *   DB_DIR=/tmp/e2e-db node test/e2e/providers.js
 *
 * E2E_HOMES is where the added provider's sign-in folder is made (default: a
 * fresh folder under the system temp dir). It must be outside the checkout,
 * DB_DIR and the output folder - the server refuses a folder inside any of
 * them, which is one of the things it checks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const orders = require(path.join(DIST, 'database', 'orderRepository'));
const { saveProfile } = require(path.join(DIST, 'database', 'profileRepository'));
const { buildNewProfile } = require(path.join(DIST, 'services', 'profileService'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;
const OWN_HOMES = !process.env.E2E_HOMES;
const HOMES = process.env.E2E_HOMES || fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-e2e-providers-'));

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const POSTING =
  'Senior engineer wanted to ship TypeScript services packaged with Docker, for a small platform team.';

let failures = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fetch against the API, signed in with `token`. */
const apiAs = (token) => async (route, init = {}) => {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function until(page, predicate, timeoutMs = 30_000, ...args) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 200 }, ...args);
    return true;
  } catch {
    return false;
  }
}

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** Presses the enabled button whose text is `label`, inside `scope` (a CSS selector) when given. */
async function pressButton(page, label, scope = null) {
  return page.evaluate(
    ({ label: wanted, scope: within }) => {
      const root = within ? document.querySelector(within) : document;
      const button = Array.from(root?.querySelectorAll('button') ?? []).find(
        (candidate) => candidate.textContent.trim() === wanted && !candidate.disabled
      );
      button?.click();
      return Boolean(button);
    },
    { label, scope }
  );
}

/** Presses a button in one provider's row. */
async function pressInRow(page, providerId, label) {
  return pressButton(page, label, `tr[data-provider-id="${providerId}"]`);
}

/** The Providers table, row by row: id, the text of each cell, and its buttons. */
async function readProviders(page) {
  return page.evaluate(() => {
    const table = document.querySelector('table[aria-label="Providers"]');
    if (!table) return null;
    return Array.from(table.querySelectorAll('tbody tr')).map((tr) => ({
      id: tr.getAttribute('data-provider-id'),
      cells: Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\s+/g, ' ').trim()),
      buttons: Array.from(tr.querySelectorAll('button')).map((button) => button.textContent.trim()),
    }));
  });
}

/** Sets a text box the way typing does, so React sees it. */
async function setBox(page, selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (value) await page.type(selector, value);
}

/** The error line under a dialog box, by the box's id. */
async function errorUnder(page, id) {
  return page.evaluate((boxId) => {
    const box = document.getElementById(boxId);
    if (!box) return null;
    const holder = box.closest('div');
    const status = holder?.querySelector('.tl-status[data-tone="error"]');
    return { invalid: box.getAttribute('aria-invalid') === 'true', text: status?.textContent.trim() ?? '' };
  }, id);
}

const dialogOpen = () => Boolean(document.querySelector('[role="dialog"]'));

async function main() {
  const stamp = Date.now().toString(36);
  const admin = users.createUser({ email: `e2e-providers-admin-${stamp}@example.com`, name: 'Provider Admin' });
  users.updateUser(admin.id, { role: 'admin' });
  const person = users.createUser({ email: `e2e-providers-user-${stamp}@example.com`, name: 'Plain User' });
  const adminToken = users.createSession(admin.id);
  const personToken = users.createSession(person.id);
  const asAdmin = apiAs(adminToken);
  const asPerson = apiAs(personToken);

  const profileId = `p-prov-${stamp}`;
  saveProfile({
    ...buildNewProfile(
      {
        name: 'Ada Provider',
        title: 'Senior Engineer',
        contact: { email: 'ada@example.com', phone: '1', location: 'Remote' },
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

  // An ordinary account's order whose resume ran on the built-in provider -
  // recorded the way the queue records it - so its page can be shown to say
  // nothing about it.
  const seededBatch = `b-e2e-${stamp}`;
  const personOrder = orders.createOrder(
    { userId: person.id, batchId: seededBatch, label: 'Seeded', retentionDays: 7 },
    [{ seq: 0, profileId: 'p-none', profileName: 'Plain User', companyName: 'Globex', role: 'Engineer', costMilli: 0 }]
  );
  orders.markItemRunning(seededBatch, 0, 'claude-cli');

  const realHome = fs.mkdtempSync(path.join(HOMES, 'claude-team-b-'));
  const missingHome = path.join(HOMES, `does-not-exist-${stamp}`);

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    // Remove asks first; the script says yes.
    page.on('dialog', (dialog) => void dialog.accept());
    await signIn(page, adminToken);

    /* ------------------------------------------------------------ the table */
    await page.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
    await until(page, () => document.querySelectorAll('table[aria-label="Providers"] tbody tr').length >= 3, 20_000);
    // The live state arrives after the list.
    await until(
      page,
      () => /Ready|Not ready/.test(document.querySelector('tr[data-provider-id="claude-cli"]')?.innerText ?? ''),
      30_000
    );
    let rows = await readProviders(page);
    check(
      'Providers lists the three built-in providers, in catalog order',
      JSON.stringify(rows?.map((row) => row.id)) === JSON.stringify(['claude-cli', 'codex-cli', 'gemini-cli']),
      JSON.stringify(rows?.map((row) => row.id))
    );
    check(
      'each is marked Built-in and has no Remove',
      rows?.every((row) => /Built-in/.test(row.cells[0]) && !row.buttons.includes('Remove')),
      JSON.stringify(rows?.map((row) => [row.cells[0], row.buttons]))
    );
    check(
      'each value says where it comes from, and the stub Claude seat reads Ready',
      rows?.every((row) => /CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME/.test(row.cells[1])) &&
        rows?.every((row) => /Default|From \.env|Set here/.test(row.cells[3])) &&
        /Ready/.test(rows?.[0].cells[4] ?? ''),
      JSON.stringify(rows?.map((row) => row.cells))
    );
    await page.screenshot({ path: path.join(SHOTS, 'providers-1-table.png'), fullPage: true });

    /* ----------------------------------------------------------------- add */
    check('Add provider opens the form', await pressButton(page, 'Add provider'));
    await until(page, dialogOpen, 5_000);
    await setBox(page, '#provider-label', 'Team B');
    await setBox(page, '#provider-home', 'claude-team-b');
    await pressButton(page, 'Add provider', '[role="dialog"]');
    await wait(300);
    let under = await errorUnder(page, 'provider-home');
    check(
      'a relative folder is refused under its box before anything is sent',
      under?.invalid && under.text === 'The sign-in folder must be an absolute path (it is "claude-team-b").',
      JSON.stringify(under)
    );

    await setBox(page, '#provider-home', missingHome);
    await setBox(page, '#provider-limit', '2');
    await pressButton(page, 'Add provider', '[role="dialog"]');
    await until(page, () => /does not exist on this server/.test(document.querySelector('[role="dialog"]')?.innerText ?? ''), 10_000);
    under = await errorUnder(page, 'provider-home');
    check(
      "a folder that is not there is refused by the server, and its sentence is pinned under the folder's box",
      under?.invalid && under.text.startsWith(`The sign-in folder "${missingHome}" does not exist on this server.`),
      JSON.stringify(under)
    );

    await setBox(page, '#provider-home', realHome);
    check('the form is sent again with a real folder', await pressButton(page, 'Add provider', '[role="dialog"]'));
    await until(page, () => !document.querySelector('[role="dialog"]') && /Team B added\./.test(document.body.innerText), 15_000);
    rows = await readProviders(page);
    const added = rows?.find((row) => /Team B/.test(row.cells[0]));
    const addedId = added?.id ?? '';
    check(
      'Team B is added after the built-in Claude provider, with a Remove and no Built-in mark',
      /^prv-[0-9a-f]{8}$/.test(addedId) &&
        rows[1]?.id === addedId &&
        added.buttons.includes('Remove') &&
        !/Built-in/.test(added.cells[0]),
      JSON.stringify(rows?.map((row) => [row.id, row.cells[0], row.buttons]))
    );
    check(
      'its folder is the one typed, its limit "Set here", its binary the built-in\'s',
      added?.cells[1].includes(realHome) &&
        /2 at once Set here/.test(added?.cells[3] ?? '') &&
        /The built-in Claude provider's/.test(added?.cells[2] ?? ''),
      JSON.stringify(added?.cells)
    );

    /* ---------------------------------------------------------------- edit */
    await pressInRow(page, addedId, 'Edit');
    await until(page, dialogOpen, 5_000);
    await setBox(page, '#provider-limit', '40');
    await pressButton(page, 'Save provider', '[role="dialog"]');
    await wait(300);
    under = await errorUnder(page, 'provider-limit');
    check(
      'a limit of 40 is refused in the server\'s words',
      under?.invalid && under.text === 'concurrency_max_requests must be a whole number from 1 to 32.',
      JSON.stringify(under)
    );
    await setBox(page, '#provider-limit', '3');
    await pressButton(page, 'Save provider', '[role="dialog"]');
    await until(page, () => !document.querySelector('[role="dialog"]') && /Team B saved\./.test(document.body.innerText), 15_000);
    rows = await readProviders(page);
    check(
      'and 3 is saved',
      /3 at once Set here/.test(rows?.find((row) => row.id === addedId)?.cells[3] ?? ''),
      JSON.stringify(rows?.find((row) => row.id === addedId)?.cells)
    );

    const builtInLimitBefore = rows?.[0].cells[3] ?? '';
    await pressInRow(page, 'claude-cli', 'Edit');
    await until(page, dialogOpen, 5_000);
    const builtInForm = await page.evaluate(() => ({
      subtitle: document.querySelector('[role="dialog"]')?.innerText ?? '',
      home: document.getElementById('provider-home')?.value,
      limit: document.getElementById('provider-limit')?.value,
    }));
    check(
      'the built-in provider\'s form starts empty - .env decides until a value is set here',
      builtInForm.home === '' && builtInForm.limit === '' && /An empty box uses \.env/.test(builtInForm.subtitle),
      JSON.stringify(builtInForm)
    );
    await setBox(page, '#provider-limit', '5');
    await pressButton(page, 'Save provider', '[role="dialog"]');
    await until(page, () => !document.querySelector('[role="dialog"]'), 15_000);
    await until(page, () => /5 at once Set here/.test(document.querySelector('tr[data-provider-id="claude-cli"]')?.innerText.replace(/\s+/g, ' ') ?? ''), 10_000);
    check(
      "a built-in's limit set here wins over .env",
      /5 at once Set here/.test((await readProviders(page))?.[0].cells[3] ?? '')
    );
    await pressInRow(page, 'claude-cli', 'Edit');
    await until(page, dialogOpen, 5_000);
    await setBox(page, '#provider-limit', '');
    await pressButton(page, 'Save provider', '[role="dialog"]');
    await until(page, () => !document.querySelector('[role="dialog"]'), 15_000);
    await wait(500);
    const builtInLimitAfter = (await readProviders(page))?.[0].cells[3] ?? '';
    check(
      'and cleared, it is what .env says again',
      builtInLimitAfter.replace(/\d+ building.*$/, '').trim() === builtInLimitBefore.replace(/\d+ building.*$/, '').trim() &&
        !/Set here/.test(builtInLimitAfter),
      JSON.stringify([builtInLimitBefore, builtInLimitAfter])
    );

    /* ---------------------------------------------------- switch, check now */
    await pressInRow(page, addedId, 'Switch off');
    await until(page, () => /Team B switched off\./.test(document.body.innerText), 10_000);
    check(
      'Switch off: the row says so',
      /Switched off/.test((await readProviders(page))?.find((row) => row.id === addedId)?.cells[4] ?? '')
    );
    await pressInRow(page, addedId, 'Switch on');
    await until(page, () => /Team B switched on\./.test(document.body.innerText), 10_000);
    const checkedLine = (id) => document.querySelector(`tr[data-provider-id="${id}"]`)?.innerText.match(/Checked .*/)?.[0] ?? '';
    await until(page, checkedLine, 15_000, addedId);
    const checkedBefore = await page.evaluate(checkedLine, addedId);
    // The time is to the second: a check made in the same second would look unchanged.
    await wait(1_100);
    await pressInRow(page, addedId, 'Check now');
    const rechecked = await until(
      page,
      (id, before) => {
        const line = document.querySelector(`tr[data-provider-id="${id}"]`)?.innerText.match(/Checked .*/)?.[0] ?? '';
        return line !== '' && line !== before;
      },
      15_000,
      addedId,
      checkedBefore
    );
    check(
      'Check now: Team B was checked afresh and is Ready',
      rechecked && /Ready/.test((await readProviders(page))?.find((row) => row.id === addedId)?.cells[4] ?? ''),
      JSON.stringify([checkedBefore, (await readProviders(page))?.find((row) => row.id === addedId)?.cells[4]])
    );

    // The built-in Claude provider off: every Claude resume goes to Team B.
    await pressInRow(page, 'claude-cli', 'Switch off');
    await until(page, () => /switched off\./.test(document.body.innerText), 10_000);

    /* ------------------------------------------------- Settings -> General */
    await page.goto(`${APP}/admin/settings`, { waitUntil: 'networkidle2' });
    await until(page, () => /Team B \(Claude\)/.test(document.body.innerText), 20_000);
    await until(page, () => /can take work now/.test(document.body.innerText), 30_000);
    const general = await page.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('.tl-card-header h2')).map((h) => h.textContent.trim()),
      typeRow: /1 of 2 Claude providers can take work now/.test(document.body.innerText),
    }));
    check(
      'Settings -> General draws one card per provider, Team B among them',
      general.cards.includes('Team B (Claude)') && general.cards.includes('Claude (Subscription)'),
      JSON.stringify(general.cards)
    );
    check("and the Claude row counts its providers that can take work", general.typeRow);

    /* ---------------------------------------- an order, built on Team B */
    const placed = await asAdmin('/generation/batches', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'order',
        profileIds: [profileId],
        jobs: [{ companyName: 'Initech', jobDescription: POSTING }],
      }),
    });
    check('an order is placed', placed.status === 202 && placed.body?.orderId, JSON.stringify(placed));
    const batchId = placed.body?.batchId;
    let runningOn = null;
    for (let i = 0; i < 60 && !runningOn; i += 1) {
      const snapshot = await asAdmin(`/generation/batches/${batchId}`);
      runningOn = snapshot.body?.tasks?.find((task) => task.runningOn)?.runningOn ?? null;
      if (!runningOn) await wait(250);
    }
    check('it runs on Team B', runningOn === addedId, String(runningOn));

    await page.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
    await until(page, (id) => Boolean(document.querySelector(`tr[data-provider-id="${id}"]`)), 20_000, addedId);
    await pressInRow(page, addedId, 'Remove');
    await until(page, () => /is building 1 resume\(s\) right now/.test(document.body.innerText), 10_000);
    check(
      'Remove is refused while it builds, in the server\'s sentence',
      await page.evaluate(() =>
        /This provider is building 1 resume\(s\) right now\. Switch it off instead/.test(document.body.innerText)
      )
    );
    check('and Team B is still listed', Boolean((await readProviders(page))?.find((row) => row.id === addedId)));
    await page.screenshot({ path: path.join(SHOTS, 'providers-2-busy.png'), fullPage: true });

    let state = null;
    for (let i = 0; i < 120 && state !== 'done'; i += 1) {
      state = (await asAdmin(`/generation/batches/${batchId}`)).body?.state ?? null;
      if (state !== 'done') await wait(500);
    }
    check('the order finishes', state === 'done', String(state));

    await page.goto(`${APP}/orders/${placed.body.orderId}`, { waitUntil: 'networkidle2' });
    await until(page, () => /Initech/.test(document.body.innerText), 20_000);
    check(
      "the order's page names the provider that built it, for the administrator",
      await page.evaluate(() => /Built on Team B \(Claude\)/.test(document.body.innerText))
    );

    /* -------------------------------------------------------------- remove */
    await page.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
    await until(page, (id) => Boolean(document.querySelector(`tr[data-provider-id="${id}"]`)), 20_000, addedId);
    await pressInRow(page, 'claude-cli', 'Switch on');
    await until(page, () => /switched on\./.test(document.body.innerText), 10_000);
    await pressInRow(page, addedId, 'Remove');
    await until(page, () => /Team B removed\./.test(document.body.innerText), 10_000);
    check(
      'once idle, Team B is removed',
      !(await readProviders(page))?.some((row) => row.id === addedId)
    );

    /* -------------------------------------------------- at a phone's width */
    await page.setViewport(PHONE);
    await page.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
    await until(page, () => Boolean(document.querySelector('table[aria-label="Providers"]')), 20_000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal page scroll at 390px', overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: path.join(SHOTS, 'providers-3-phone.png'), fullPage: true });

    /* ----------------------------------------------------- everybody else */
    const own = await asPerson(`/orders/${personOrder.id}`);
    check(
      "an ordinary account's order says nothing about the provider",
      own.status === 200 && own.body?.items?.length === 1 && !('ranOn' in own.body.items[0]),
      JSON.stringify(own.body?.items?.[0])
    );
    check('the provider routes refuse it', (await asPerson('/admin/ai/providers')).status === 403);
    check('and so does the health route', (await asPerson('/admin/ai/health')).status === 403);

    const other = await browser.newPage();
    await other.setViewport(WIDE);
    await signIn(other, personToken);
    await other.goto(`${APP}/orders/${personOrder.id}`, { waitUntil: 'networkidle2' });
    await until(other, () => /Globex/.test(document.body.innerText), 20_000);
    const leaked = await other.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return ['Built on', 'claude-cli', 'Claude (Subscription)', 'CLAUDE_CONFIG_DIR'].filter((word) => html.includes(word));
    });
    check("its order page names no provider", leaked.length === 0, JSON.stringify(leaked));
    await other.goto(`${APP}/admin/models`, { waitUntil: 'networkidle2' });
    await wait(1_000);
    const sawProviders = await other.evaluate(() => ({
      table: Boolean(document.querySelector('table[aria-label="Providers"]')),
      folder: /CLAUDE_CONFIG_DIR|claude-team-b/.test(document.body.innerText),
    }));
    check('Admin -> Models shows it no providers', !sawProviders.table && !sawProviders.folder, JSON.stringify(sawProviders));
  } finally {
    await browser.close();
    // Only a folder this script made; one an operator named is theirs.
    if (OWN_HOMES) fs.rmSync(HOMES, { recursive: true, force: true });
    else fs.rmSync(realHome, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll provider checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

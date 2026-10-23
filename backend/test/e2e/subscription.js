/*
 * Self-serve subscriptions, the locks and the spend alert, in a real browser
 * against a real server (services/subscriptions, routes/subscription.ts).
 *
 * test/subscriptionRoutes.test.js and subscriptionRenewal.test.js prove the
 * server's half, and test/frontendSubscription.test.js the page's decisions
 * over real answers. This proves the page and the server are joined up:
 *
 *   - Settings -> Subscription draws every tier as a card, side by side at
 *     1440, two by two at 1024 and 1200 (never three and one), and one a row
 *     at 390, the one not priced saying so with a Contact admin link
 *   - Subscribe asks first (the spend alert: the amount, the balance after,
 *     "Do not show again"); Cancel there moves nothing; Proceed charges
 *     exactly that, once, and the page says when it renews
 *   - the builder locks nothing on a run, at any tier: its three build modes
 *     (Choose Suitable Resume, Partial Tailor, Fully Tailor) are open on
 *     Premium and, once the subscription ends, on Default too
 *   - Upgrade charges what the card says, which is the server's own proration
 *   - an Upgrade the unused days cover ($0) still asks: nothing now, the
 *     price when its 30 days end, and the credit it gives up
 *   - Switch at renewal says nothing is taken now; ticking "Do not show
 *     again" there stops the next subscription change asking; Keep undoes it
 *   - Cancel asks in a dialog of its own, then says when it ends - in the
 *     Current subscription section, in view and focused
 *   - the renewal sweep renews a subscription whose 30 days are up, with a
 *     ledger row and a notice - and, with no credit, ends it, with a notice,
 *     and the locks come back
 *   - at the profile limit the New profile tile is the one lock left: its dialog
 *     ("Locked: More profiles") leads to the Subscription page - while a
 *     Default account still keeps three resumes in its one profile, its New
 *     resume tile is open and /admin/resumes/new is drawn (resumes are never
 *     counted)
 *   - an administrator's page is read-only, and Settings -> General carries
 *     the three price boxes with their source lines and Reset to default
 *
 * Servers are expected to be up already, sharing DB_DIR with this script, the
 * backend with the renewal sweep run every second:
 *
 *   SUBSCRIPTION_RENEWAL_SWEEP_MS=1000 DB_DIR=/tmp/e2e-db PORT=3001 \
 *     node --require ./test/e2e/stub-seat.js dist/index.js
 *   DB_DIR=/tmp/e2e-db node test/e2e/subscription.js
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const creditRepository = require(path.join(DIST, 'database', 'creditRepository'));
const { getDb } = require(path.join(DIST, 'database', 'sqlite'));
const { readBillingRow } = require(path.join(DIST, 'database', 'subscriptionRepository'));
const billing = require(path.join(DIST, 'services', 'subscriptions', 'billing'));
const { formatMoney } = require(path.join(DIST, 'utils', 'money'));
const { saveResume } = require(path.join(DIST, 'database', 'resumeRepository'));
const { buildNewResume } = require(path.join(DIST, 'services', 'resumeDocument'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build Resumes' manual builder, opened. Clicked until its build modes are
 * drawn: a click that lands before the production page has hydrated does
 * nothing, and the builder stays on its first screen.
 */
const openManualBuilder = (page) =>
  until(page, () => {
    if (document.querySelector('input[name="manualBuildMode"]')) return true;
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Building Manually'))?.click();
    return false;
  });

/** What Build Resumes draws for its three build modes, for a failed check's detail. */
const builderModes = (page) =>
  page.evaluate(() =>
    JSON.stringify({
      modes: Array.from(document.querySelectorAll('input[name="manualBuildMode"]')).map((input) => ({
        value: input.value,
        disabled: input.disabled,
        locked: Boolean(input.closest('[data-locked-choice]')),
      })),
      locks: document.querySelectorAll('[data-locked-choice], [data-locked-feature]').length,
      text: (document.querySelector('main')?.innerText ?? document.body.innerText).slice(0, 300),
    })
  );

/**
 * True once the builder draws the three build modes - in this order, every one
 * enabled and none locked - and no lock of any kind is on the page. A run is
 * locked for no subscription (one profile per run, on every tier), so this is
 * what the page reads on Premium and on Default alike. Polled in the page:
 * the cards are drawn from the first paint, but the account the old lock
 * depended on is read after it, and "locked" was also how a choice was drawn
 * before that - so the caller waits and asks again once the page has settled.
 */
const buildModesOpen = () => {
  const radios = Array.from(document.querySelectorAll('input[name="manualBuildMode"]'));
  return (
    radios.map((radio) => radio.value).join() === 'suitable,partial,full' &&
    radios.every((radio) => !radio.disabled && !radio.closest('[data-locked-choice]')) &&
    document.querySelectorAll('[data-locked-choice], [data-locked-feature]').length === 0
  );
};

/** A fetch against the API, signed in with `token`. */
const apiAs = (token) => async (route, init = {}) => {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** Polls `predicate` in the page until it holds, or `timeoutMs` passes. */
async function until(page, predicate, timeoutMs = 15_000, arg = null) {
  try {
    await page.waitForFunction(predicate, { timeout: timeoutMs, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
}

/** Polls `read` until `predicate` holds; the last value either way. */
async function untilValue(read, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return { ok: true, last };
    await wait(250);
  }
  return { ok: false, last };
}

/** Presses the first enabled button inside `scope` (a selector) whose text starts with `text`. */
async function press(page, text, scope = 'body') {
  return page.evaluate(
    (label, within) => {
      const root = document.querySelector(within);
      const button = Array.from(root?.querySelectorAll('button, a') ?? []).find(
        (candidate) => candidate.textContent.trim().startsWith(label) && !candidate.disabled
      );
      button?.click();
      return Boolean(button);
    },
    text,
    scope
  );
}

/** The dialog the page draws: its title and text, or null. */
async function dialog(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    if (!panel) return null;
    return {
      title: panel.querySelector('h2')?.textContent.trim() ?? '',
      text: panel.innerText,
      proceedDisabled: Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Proceed')?.disabled ?? null,
    };
  });
}

/** Every tier card on the page: its id, whether it is current, where it sits, and its text. */
async function cards(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-subscription-card]')).map((card) => ({
      id: card.getAttribute('data-subscription-card'),
      current: card.getAttribute('aria-current') === 'true',
      top: Math.round(card.getBoundingClientRect().top),
      left: Math.round(card.getBoundingClientRect().left),
      text: card.innerText,
      contact: Array.from(card.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin'),
    }))
  );
}

/** Presses the action button on a tier's card. */
async function pressCard(page, tier) {
  return page.evaluate((id) => {
    const button = document.querySelector(`[data-subscription-card="${id}"] button:not([disabled])`);
    if (!button || button.textContent.trim() === 'Contact admin') return false;
    button.click();
    return true;
  }, tier);
}

async function openSubscriptionPage(page) {
  await page.goto(`${APP}/settings/subscription`, { waitUntil: 'networkidle2' });
  await until(page, () => document.querySelectorAll('[data-subscription-card]').length === 4);
}

const mainText = (page) => page.evaluate(() => document.querySelector('.tl-main')?.innerText ?? document.body.innerText);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function main() {
  const stamp = Date.now().toString(36);
  const admin = users.createUser({ email: `e2e-sub-admin-${stamp}@example.com`, name: 'Sub Admin' });
  users.updateUser(admin.id, { role: 'admin' });
  const user = users.createUser({ email: `e2e-sub-${stamp}@example.com`, name: 'Sub User' });
  // One profile: the Default subscription's limit.
  saveResume({
    ...buildNewResume(
      {
        name: 'Ada Sub',
        title: 'Engineer',
        contact: { email: 'ada@example.com', phone: '1', location: 'Remote' },
        summary: 'Engineer.',
        experience: [],
        skills: ['TypeScript'],
        education: [],
      },
      `p-sub-${stamp}`
    ),
    ownerId: user.id,
  });
  const adminToken = users.createSession(admin.id);
  const userToken = users.createSession(user.id);
  const asAdmin = apiAs(adminToken);
  const asUser = apiAs(userToken);

  // Prices through the server, so its settings cache has them at once:
  // Premium $9.99, Premium+ $19.99, Premium Max not offered (an emptied box).
  const priced = await asAdmin('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ premiumPriceUsd: '9.99', premiumPlusPriceUsd: '19.99', premiumMaxPriceUsd: '' }),
  });
  check(
    'setup: Premium $9.99, Premium+ $19.99, Premium Max not offered',
    priced.status === 200 &&
      priced.body?.premiumPriceMilli === 9_990 &&
      priced.body?.premiumPlusPriceMilli === 19_990 &&
      priced.body?.premiumMaxPriceMilli === null,
    JSON.stringify(priced.body && { s: priced.status, p: priced.body.premiumPriceMilli, e: priced.body.error })
  );
  const granted = await asAdmin(`/admin/accounts/${user.id}/credits`, { method: 'POST', body: JSON.stringify({ amountUsd: '50' }) });
  check('setup: the user has $50 of credit', granted.status === 200 && granted.body?.balanceMilli === 50_000, JSON.stringify(granted.body));

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    page.on('dialog', (native) => void native.accept());
    await signIn(page, userToken);

    /* ----------------------------------------------------------- the cards */
    await openSubscriptionPage(page);
    let tiers = await cards(page);
    check(
      'the four tiers are cards side by side at 1440, Default the current one',
      tiers.map((card) => card.id).join() === 'default,premium,premium-plus,premium-max' &&
        new Set(tiers.map((card) => card.top)).size === 1 &&
        tiers.find((card) => card.current)?.id === 'default',
      JSON.stringify(tiers.map(({ id, current, top }) => ({ id, current, top })))
    );
    const max = tiers.find((card) => card.id === 'premium-max');
    check(
      'Premium Max is not offered, and its card asks for the administrator with Contact admin',
      /Not offered/.test(max?.text ?? '') && /Ask your administrator if you need it/.test(max?.text ?? '') && max.contact,
      max?.text
    );
    check('the prices are on the cards', /\$9\.99/.test(tiers[1].text) && /\$19\.99/.test(tiers[2].text) && /Free/.test(tiers[0].text));
    check('no "plan" anywhere on the page', !/\bplans?\b/i.test(await mainText(page)));
    await page.screenshot({ path: `${SHOTS}/subscription-1-cards.png`, fullPage: true });

    // An iPad on its side and a laptop window: an auto-fit grid drew three
    // cards and Premium Max alone under them from about 1000px to 1260px.
    for (const width of [1024, 1200]) {
      await page.setViewport({ width, height: 900 });
      await wait(300);
      const laid = await cards(page);
      const perRow = [...new Set(laid.map((card) => card.top))].map((top) => laid.filter((card) => card.top === top).length);
      check(`at ${width}: the cards two by two, never three and one`, perRow.join() === '2,2', JSON.stringify(perRow));
    }
    await page.setViewport(WIDE);
    await wait(300);

    /* ----------------------------------------------- subscribe, asked first */
    check('Subscribe on Premium is pressed', await pressCard(page, 'premium'));
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    let asked = await dialog(page);
    check(
      'the spend alert names $9.99, the balance after $40.01, and Do not show again',
      Boolean(asked) &&
        asked.title === 'Subscribe to Premium' &&
        /This takes \$9\.99 from your credit, for Premium for 30 days\./.test(asked.text) &&
        /Your balance after: \$40\.01\./.test(asked.text) &&
        /Do not show again/.test(asked.text),
      asked?.text
    );
    await page.screenshot({ path: `${SHOTS}/subscription-2-alert.png` });
    await press(page, 'Cancel', '[role="dialog"]');
    await wait(500);
    check(
      'Cancel there moves nothing',
      (await dialog(page)) === null && (await asUser('/subscription')).body?.balanceMilli === 50_000
    );

    await pressCard(page, 'premium');
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    await press(page, 'Proceed', '[role="dialog"]');
    const bought = await until(page, () => /Your account is on Premium now/.test(document.body.innerText));
    let view = (await asUser('/subscription')).body;
    check(
      'Proceed buys it: Premium, $40.01 left, and the page says when it renews',
      bought && view?.subscription === 'premium' && view?.balanceMilli === 40_010 && /Renews on/.test(await mainText(page)),
      JSON.stringify(view && { s: view.subscription, b: view.balanceMilli })
    );
    const purchases = creditRepository.listLedger(user.id).filter((entry) => entry.reason === 'subscription-purchase');
    check('one ledger row, for exactly $9.99', purchases.length === 1 && purchases[0].deltaMilli === -9_990, JSON.stringify(purchases));

    /* ------------------------------------------------ the builder unlocked */
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await openManualBuilder(page);
    // Waited for, not slept on: the page draws Build options, and reads the
    // account and its profiles, after its first paint.
    const modesOpen = await until(page, buildModesOpen);
    if (!modesOpen) await page.screenshot({ path: `${SHOTS}/subscription-builder-open.png` });
    check("the builder's three build modes are open on Premium, with no lock", modesOpen, modesOpen ? '' : await builderModes(page));

    /* ---------------------------------------------------------- move up */
    await openSubscriptionPage(page);
    const row = readBillingRow(user.id);
    const expected = billing.chargeNowMilli(row, 19_990, Date.now());
    tiers = await cards(page);
    const plus = tiers.find((card) => card.id === 'premium-plus');
    check(
      "the Upgrade button names the server's own proration",
      plus.text.includes(`Upgrade · ${formatMoney(expected.chargeMilli)}`),
      `${plus.text} | expected ${formatMoney(expected.chargeMilli)}`
    );
    await pressCard(page, 'premium-plus');
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    asked = await dialog(page);
    check(
      'its alert takes the same amount',
      Boolean(asked) && asked.text.includes(`This takes ${formatMoney(expected.chargeMilli)} from your credit`),
      asked?.text
    );
    await press(page, 'Proceed', '[role="dialog"]');
    await until(page, () => /Your account is on Premium\+ now/.test(document.body.innerText));
    view = (await asUser('/subscription')).body;
    check(
      'moved up: Premium+, charged exactly that',
      view?.subscription === 'premium-plus' && view?.balanceMilli === 40_010 - expected.chargeMilli,
      JSON.stringify(view && { s: view.subscription, b: view.balanceMilli })
    );

    /* ---------------------------- an upgrade the unused days cover, at $0 */
    // A price cut puts Premium Max below what the unused days of Premium+ are
    // worth: its Upgrade takes $0 - and is still asked about, because it
    // starts 30 days that renew and gives up the rest of that credit.
    const cut = await asAdmin('/admin/settings', { method: 'PUT', body: JSON.stringify({ premiumMaxPriceUsd: '5' }) });
    check(
      'setup: Premium Max offered at $5',
      cut.status === 200 && cut.body?.premiumMaxPriceMilli === 5_000,
      JSON.stringify(cut.body && { s: cut.status, p: cut.body.premiumMaxPriceMilli, e: cut.body.error })
    );
    await openSubscriptionPage(page);
    const maxCard = (await cards(page)).find((card) => card.id === 'premium-max');
    check('its card reads Upgrade · $0', /Upgrade · \$0(?![.\d])/.test(maxCard?.text ?? ''), maxCard?.text);
    await pressCard(page, 'premium-max');
    const coveredAsked = await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    asked = await dialog(page);
    check(
      'the $0 upgrade asks first: nothing now, $5 when its 30 days end, and the credit it does not use',
      coveredAsked &&
        Boolean(asked) &&
        asked.title === 'Upgrade to Premium Max' &&
        /Nothing is taken now\. On .+, \$5 is taken from your credit, for Premium Max, and every 30 days after/.test(asked.text) &&
        /your unused days cover it, so nothing is taken now, and the \$[\d.,]+ of their credit that Premium Max does not use is not refunded/.test(
          asked.text
        ),
      asked?.text
    );
    await press(page, 'Cancel', '[role="dialog"]');
    await wait(500);
    view = (await asUser('/subscription')).body;
    check(
      'Cancel there moves nothing: still Premium+, nothing taken',
      (await dialog(page)) === null && view?.subscription === 'premium-plus' && view?.balanceMilli === 40_010 - expected.chargeMilli,
      JSON.stringify(view && { s: view.subscription, b: view.balanceMilli })
    );
    const unpriced = await asAdmin('/admin/settings', { method: 'PUT', body: JSON.stringify({ premiumMaxPriceUsd: '' }) });
    check('setup: Premium Max not offered again', unpriced.status === 200 && unpriced.body?.premiumMaxPriceMilli === null);
    await openSubscriptionPage(page);

    /* ------------------------------------- switch at renewal, then Keep */
    check('Switch at renewal on Premium is pressed', await pressCard(page, 'premium'));
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    asked = await dialog(page);
    check(
      'its alert says nothing is taken now, and what is taken on the day',
      Boolean(asked) && /Nothing is taken now\. On .+, \$9\.99 is taken from your credit/.test(asked.text),
      asked?.text
    );
    await page.evaluate(() => document.querySelector('[role="dialog"] input[type="checkbox"]')?.click());
    await press(page, 'Proceed', '[role="dialog"]');
    await until(page, () => /Switches on/.test(document.body.innerText));
    view = (await asUser('/subscription')).body;
    check('switching: Premium+ until its end, then Premium', view?.paid?.next === 'premium' && view?.paid?.renews === true);

    check('Keep Premium+ is pressed', await press(page, 'Keep Premium+'));
    await wait(700);
    check('after Do not show again, Keep asks nothing', (await dialog(page)) === null);
    await until(page, () => /Premium\+ renews again/.test(document.body.innerText));
    view = (await asUser('/subscription')).body;
    check('kept: renewing as Premium+, nothing pending', view?.paid?.next === null && view?.paid?.renews === true);

    /* ----------------------------------------------------------- cancel */
    check('Cancel subscription is pressed', await press(page, 'Cancel subscription', '.tl-main'));
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    asked = await dialog(page);
    check(
      'Cancel asks in a dialog of its own: until when, back to Default, nothing refunded',
      Boolean(asked) && asked.title === 'Cancel Premium+?' && /then your account returns to Default\. Nothing is refunded\./.test(asked.text),
      asked?.text
    );
    await press(page, 'Cancel subscription', '[role="dialog"]');
    await until(page, () => /Ends on/.test(document.body.innerText));
    check('cancelled: it says when it ends', (await asUser('/subscription')).body?.paid?.renews === false);
    // Said where Cancel was pressed - under the cards, which on a phone stand
    // four high above it - brought into view and focused, its button gone.
    const cancelSaid = await until(page, () => {
      const block = document.querySelector('[data-subscription-result="status"]');
      if (!block || !/is cancelled/.test(block.innerText)) return false;
      const box = block.getBoundingClientRect();
      return (
        block.closest('section')?.querySelector('h2')?.textContent.trim() === 'Current subscription' &&
        document.activeElement === block &&
        box.top >= 0 &&
        box.bottom <= window.innerHeight
      );
    });
    check('what Cancel did is said in Current subscription, in view and focused', cancelSaid);
    await press(page, 'Keep Premium+');
    await until(page, () => /renews again/.test(document.body.innerText));

    /* ---------------------------------------------------------- renewal */
    const db = getDb();
    const past = new Date(Date.now() - 60_000).toISOString();
    const before = creditRepository.listLedger(user.id).filter((entry) => entry.reason === 'subscription-renewal').length;
    db.prepare('UPDATE users SET subscription_paid_through = ? WHERE id = ?').run(past, user.id);
    const renewed = await untilValue(
      () => creditRepository.listLedger(user.id).filter((entry) => entry.reason === 'subscription-renewal').length,
      (count) => count === before + 1,
      15_000
    );
    check('the sweep renews a subscription whose 30 days are up, with a ledger row', renewed.ok, String(renewed.last));
    const renewedNotice = await untilValue(
      async () => (await asUser('/notifications')).body?.notifications ?? [],
      (list) => list.some((entry) => /^Premium\+ renewed: \$19\.99$/.test(entry.title))
    );
    check('and a notice says so', renewedNotice.ok, JSON.stringify(renewedNotice.last?.map((entry) => entry.title)));

    const emptied = await asAdmin(`/admin/accounts/${user.id}`, { method: 'PATCH', body: JSON.stringify({ balanceUsd: '0' }) });
    check('setup: the balance is $0', emptied.status === 200, JSON.stringify(emptied.body));
    db.prepare('UPDATE users SET subscription_paid_through = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), user.id);
    const lapsed = await untilValue(() => users.getUserById(user.id)?.subscription, (tier) => tier === 'default', 15_000);
    check('with no credit, the renewal ends it: back to Default', lapsed.ok, String(lapsed.last));
    const lapsedNotice = await untilValue(
      async () => (await asUser('/notifications')).body?.notifications ?? [],
      (list) => list.some((entry) => entry.title === 'Premium+ ended: not enough credit')
    );
    check('"Premium+ ended: not enough credit" is in the bell', lapsedNotice.ok, JSON.stringify(lapsedNotice.last?.map((entry) => entry.title)));

    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await openManualBuilder(page);
    // A run has no lock at any tier, so the modes stay open after the tier
    // ends. Asked again once the account is in the top bar: a lock would
    // depend on it, and one drawn "until the account is known" would be gone
    // or still there by then.
    const stillOpen =
      (await until(page, buildModesOpen)) &&
      (await until(page, () => Boolean(document.querySelector('.tl-topbar button[aria-label^="Account"]')))) &&
      (await page.evaluate(buildModesOpen));
    if (!stillOpen) await page.screenshot({ path: `${SHOTS}/subscription-builder-locked.png` });
    check('back on Default, the builder still has its three build modes open - a run has no lock', stillOpen, stillOpen ? '' : await builderModes(page));

    /* ------------------------------------------------- the profile limit */
    // A profile is a PERSON, and the Default subscription allows one: Ada's.
    // The only thing locked at that limit is a second PERSON.
    const NEW_PROFILE_TILE = '[data-new-tile="profile"][data-locked-feature="more-profiles"]';
    await page.goto(`${APP}/admin/profiles`, { waitUntil: 'networkidle2' });
    await until(page, (selector) => Boolean(document.querySelector(selector)), 15_000, NEW_PROFILE_TILE);
    const tile = await page.evaluate((selector) => {
      const button = document.querySelector(selector);
      return button ? { disabled: button.disabled, text: button.innerText } : null;
    }, NEW_PROFILE_TILE);
    check('at the limit, the New profile tile is locked - pressable, "Needs Premium"', Boolean(tile) && !tile.disabled && /Needs Premium/.test(tile.text), JSON.stringify(tile));
    await page.click(NEW_PROFILE_TILE);
    await until(page, () => Boolean(document.querySelector('[role="dialog"]')));
    const tileLock = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      return {
        title: panel?.querySelector('h2')?.textContent.trim(),
        text: panel?.innerText ?? '',
        go: Array.from(panel?.querySelectorAll('a') ?? []).find((a) => a.textContent.trim() === 'Go to subscription')?.getAttribute('href'),
      };
    });
    check(
      'its dialog: "Locked: More profiles", what Premium allows, Go to subscription',
      tileLock.title === 'Locked: More profiles' && /Premium allows up to 5\./.test(tileLock.text) && tileLock.go === '/settings/subscription',
      JSON.stringify(tileLock)
    );
    await page.keyboard.press('Escape');

    // Resumes are never counted: a second and a third resume of the SAME
    // person are filed under their one profile on Default, with no 402.
    const profileList = await asUser('/profiles');
    const adaProfile = Array.isArray(profileList.body) ? profileList.body[0] : null;
    const moreResumes = [];
    for (const title of ['Backend Engineer', 'Frontend Engineer']) {
      moreResumes.push(
        await asUser(`/resumes?profileId=${encodeURIComponent(adaProfile?.id ?? 'none')}`, {
          method: 'POST',
          body: JSON.stringify({
            name: 'Ada Sub',
            title,
            contact: { email: 'ada@example.com', phone: '1', location: 'Remote' },
            summary: `${title}.`,
            experience: [],
            skills: ['TypeScript'],
            education: [],
          }),
        })
      );
    }
    const afterMore = (await asUser('/profiles')).body;
    const me = (await asUser('/auth/me')).body;
    check(
      'on Default, three resumes stay open in one profile: two more are created (201), still one profile of three resumes',
      moreResumes.every((response) => response.status === 201) &&
        Array.isArray(afterMore) &&
        afterMore.length === 1 &&
        afterMore[0].resumeCount === 3 &&
        me?.account?.profilesUsed === 1,
      JSON.stringify({ created: moreResumes.map((r) => [r.status, r.body?.error]), profiles: afterMore, used: me?.account?.profilesUsed })
    );

    await page.goto(`${APP}/admin/profiles?tab=resumes`, { waitUntil: 'networkidle2' });
    await until(page, () => document.querySelectorAll('[data-resume-card]').length === 3 && Boolean(document.querySelector('[data-new-tile="resume"]')));
    const resumeTab = await page.evaluate(() => {
      const newResume = document.querySelector('[data-new-tile="resume"]');
      return {
        tabs: Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map((tab) => tab.textContent.trim()),
        cards: document.querySelectorAll('[data-resume-card]').length,
        newResume: newResume ? { lock: newResume.getAttribute('data-locked-feature'), disabled: newResume.disabled } : null,
      };
    });
    check(
      'and the dashboard reads Profiles (1) and All resumes (3), with the New resume tile open - not locked, not disabled',
      resumeTab.tabs.join(' / ') === 'Profiles (1) / All resumes (3)' &&
        resumeTab.cards === 3 &&
        Boolean(resumeTab.newResume) &&
        resumeTab.newResume.lock === null &&
        !resumeTab.newResume.disabled,
      JSON.stringify(resumeTab)
    );

    await page.goto(`${APP}/admin/resumes/new`, { waitUntil: 'networkidle2' });
    const newPage = await until(page, () =>
      Array.from(document.querySelectorAll('h1')).some((h) => /^Start building a resume/.test(h.textContent.trim()))
    );
    const newLocks = await page.evaluate(() => document.querySelectorAll('[data-locked-feature]').length);
    check('/admin/resumes/new is drawn - the template chooser, with no lock and no Go to subscription', newPage && newLocks === 0, `locks ${newLocks}`);

    /* ------------------------------------------------------------- 390px */
    await page.setViewport(PHONE);
    await openSubscriptionPage(page);
    tiers = await cards(page);
    check(
      'at 390: one card a row, no horizontal scrollbar',
      new Set(tiers.map((card) => card.left)).size === 1 && (await overflow(page)) <= 1,
      `overflow ${await overflow(page)}`
    );
    await page.screenshot({ path: `${SHOTS}/subscription-3-phone.png`, fullPage: true });
    await page.setViewport(WIDE);

    /* ------------------------------------------------------ administrator */
    const adminPage = await browser.newPage();
    await adminPage.setViewport(WIDE);
    await signIn(adminPage, adminToken);
    await openSubscriptionPage(adminPage);
    const adminView = await adminPage.evaluate(() => ({
      text: document.querySelector('.tl-main')?.innerText ?? '',
      buttons: Array.from(document.querySelectorAll('[data-subscription-card] button')).map((b) => b.textContent.trim()),
    }));
    check(
      "an administrator's page is read-only: nothing to buy, and says why",
      /never charged, so there is nothing to buy here/.test(adminView.text) &&
        adminView.buttons.every((label) => label === 'Contact admin'),
      JSON.stringify(adminView.buttons)
    );
    check(
      "and its Credits section says nothing is taken from the balance, not that the subscription is paid from it",
      /Administrators are never charged, for a subscription or for a resume/.test(adminView.text) &&
        !/Your subscription is paid from this balance/.test(adminView.text)
    );
    await adminPage.goto(`${APP}/admin/settings`, { waitUntil: 'networkidle2' });
    await until(adminPage, () => Boolean(document.getElementById('subscription-price-premiumPriceMilli')));
    const general = await adminPage.evaluate(() => {
      const box = (key) => document.getElementById(`subscription-price-${key}`);
      return {
        values: ['premiumPriceMilli', 'premiumPlusPriceMilli', 'premiumMaxPriceMilli'].map((key) => box(key)?.value ?? null),
        placeholder: box('premiumMaxPriceMilli')?.getAttribute('placeholder'),
        text:
          Array.from(document.querySelectorAll('section.tl-section')).find(
            (section) => section.querySelector('h2')?.textContent.trim() === 'Subscriptions'
          )?.innerText ?? '',
      };
    });
    check(
      'Settings -> General: the three price boxes, as stored, with their source and Reset to default',
      general.values.join() === '9.99,19.99,' &&
        general.placeholder === 'Not offered' &&
        /Set here/.test(general.text) &&
        /Reset to default/.test(general.text),
      JSON.stringify(general)
    );
    await adminPage.screenshot({ path: `${SHOTS}/subscription-4-general.png`, fullPage: true });
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

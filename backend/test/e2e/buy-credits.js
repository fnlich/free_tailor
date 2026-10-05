/*
 * Buying credit through the three-step dialog, in a real browser.
 *
 * A credit is a dollar: the dialog asks for an amount of money, the checkout
 * carries it as `amountUsd`, and every amount coming back is thousandths of a
 * dollar in a field ending `Milli` - shown on the page as $0.000.
 *
 * `walkthrough.js` proves the API; `browser.js` proves the OLD buy page. This
 * is the flow that replaced it: choose a payment method, then an amount, then
 * an order summary with the card form or the crypto hand-off beside it.
 *
 * Two halves, in this order, because the second needs what the first leaves
 * behind:
 *
 *   1. An API pass that buys once WITH "save this card" on and drives the fake
 *      provider's page to paid - which is what makes a saved card exist at all.
 *      It then charges that saved card off-session, which is the path whose
 *      webhook is `payment_intent.succeeded` and whose provider reference is a
 *      `pi_` rather than a `cs_`.
 *   2. A browser pass over the dialog itself, which by then has a card to list.
 *
 * The one thing no script here can do is type a card number: the Payment
 * Element is an iframe served by js.stripe.com and will not mount against a
 * made-up publishable key. So the card column is asserted to either mount OR
 * say plainly that it could not - the same boundary browser.js draws, and the
 * assertion that keeps a customer from watching a spinner for ever.
 *
 * Servers are expected to be up already, with the fake providers in front:
 *
 *   node --require ./test/e2e/fake-providers.js dist/index.js
 *   node test/e2e/buy-credits.js
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const { formatMoney, parseDollars } = require(path.join(DIST, 'utils', 'money'));

/** Thousandths as the dollars a request carries: 2500 -> "2.500". */
const usd = (milli) => formatMoney(milli).replace(/[$,]/g, '');
/** A dollar box's text as thousandths, or null when it is not an amount. */
const milliOf = (text) => {
  const parsed = parseDollars(text ?? '');
  return parsed.ok ? parsed.milli : null;
};

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:4242';
const SHOTS = process.env.E2E_SHOTS || __dirname;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

async function call(token, route, init = {}) {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------ browser helpers */

async function signIn(page, token) {
  // Both halves of what a real sign-in leaves behind: the API client sends the
  // localStorage copy as a bearer header, and the cookie is what an iframe
  // carries.
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

/** Click the first element whose trimmed text matches. */
async function clickText(page, selector, text) {
  return page.evaluate(
    (sel, wanted) => {
      const target = Array.from(document.querySelectorAll(sel)).find(
        (node) => node.textContent.trim().toLowerCase().includes(wanted.toLowerCase())
      );
      if (!target) return false;
      target.click();
      return true;
    },
    selector,
    text
  );
}

/** What the dialog looks like from inside the page. */
async function readDialog(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const style = getComputedStyle(dialog);
    return {
      title: dialog.querySelector('h2')?.textContent.trim() ?? '',
      width: dialog.dataset.width ?? '',
      background: style.backgroundColor,
      text: dialog.innerText,
      buttons: Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent.trim()),
      // The amount box, as typed, when a step has one.
      amount: (() => {
        const field = dialog.querySelector('input[inputmode="decimal"]');
        return field ? field.value : null;
      })(),
      /*
       * The PANEL against the window, not the document against itself.
       *
       * While a dialog is open its scroll lock sets `body { overflow: hidden }`,
       * which clamps `documentElement.scrollWidth` to the viewport - so the
       * usual overflow check passes whatever the dialog does, including
       * running off the side of a phone. Measuring the panel and its widest
       * descendant is the only thing that can actually see that.
       */
      overflow: (() => {
        const viewport = window.innerWidth;
        let worst = Math.max(0, Math.round(dialog.getBoundingClientRect().right - viewport));
        let culprit = worst > 0 ? 'the dialog itself' : '';
        dialog.querySelectorAll('*').forEach((node) => {
          const past = Math.round(node.getBoundingClientRect().right - viewport);
          if (past > worst) {
            worst = past;
            culprit = `${node.tagName}.${(node.className || '').toString().slice(0, 60)}`;
          }
        });
        return { past: worst, culprit, viewport };
      })(),
      /*
       * And the panel against ITSELF, which is a different question.
       *
       * The measurement above asks whether anything left the SCREEN. This one
       * asks whether anything left the DIALOG, and at a desktop width those
       * are hundreds of pixels apart: a 448px panel centred at 1440 has
       * roughly 496px of room on its right before a row that has escaped it
       * reaches the window edge. A row can therefore be painting over the page
       * outside its own dialog while the viewport check still reads zero -
       * which is exactly what the switched-off crypto row did, and why that
       * bug survived a check named "nothing hangs off the side".
       */
      panel: { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth },
    };
  });
}

async function openDialog(page) {
  await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
  await wait(500);
  const opened = await clickText(page, 'button', 'Purchase Credits');
  await wait(300);
  return opened;
}

/* --------------------------------------------------------------- the run */

async function main() {
  const stamp = Date.now().toString(36);
  const buyer = users.createUser({ email: `e2e-dialog-${stamp}@example.com`, name: 'Dialog Buyer' });
  const other = users.createUser({ email: `e2e-other-${stamp}@example.com`, name: 'Somebody Else' });
  const token = users.createSession(buyer.id);
  const otherToken = users.createSession(other.id);
  // Only an administrator is shown why a method is off; the buyer is pointed at one.
  const admin = users.createUser({ email: `e2e-admin-${stamp}@example.com`, name: 'Dialog Admin', role: 'admin' });
  const adminToken = users.createSession(admin.id);

  /* ============================================================ 1. the API */
  console.log('\n=== Targets ===');
  const options = await call(token, '/payments/methods');
  const targets = options.body?.targets ?? [];
  const cardTarget = targets.find((t) => t.method === 'card');
  const cryptoTarget = targets.find((t) => t.method === 'crypto');
  check('a card target is offered', Boolean(cardTarget?.available), JSON.stringify(cardTarget));
  check('a crypto target is offered', Boolean(cryptoTarget?.available), JSON.stringify(cryptoTarget));
  check(
    'each target carries its own bounds',
    cardTarget && cryptoTarget && cardTarget.minAmountMilli !== cryptoTarget.minAmountMilli,
    `card ${cardTarget?.minAmountMilli} vs crypto ${cryptoTarget?.minAmountMilli}`
  );
  check(
    'every preset is inside its own target bounds, and whole cents',
    targets
      .filter((t) => t.available)
      .every((t) =>
        t.presets.every(
          (p) => p.amountMilli >= t.minAmountMilli && p.amountMilli <= t.maxAmountMilli && p.amountMilli % 10 === 0
        )
      ),
    JSON.stringify(targets.map((t) => ({ id: t.id, presets: t.presets })))
  );
  check(
    'and nothing on them is a price per credit or a fee',
    options.body?.unitPriceCents === undefined && targets.every((t) => t.feeBps === undefined && t.minCredits === undefined),
    JSON.stringify(options.body)
  );

  console.log('\n=== A coin named by a stale tab ===');
  /*
   * Not refused - ignored.
   *
   * This used to be a closed list of coins, checked before anything was
   * recorded, because the asset chose which limits row priced the sale. Now
   * the coin is chosen on the provider's own page and nothing here can honour
   * one, so the field is simply not read. A buyer whose dialog predates the
   * change still has coin buttons on it, and pressing one meant "crypto".
   *
   * The thing still worth proving is that it cannot steer the PRICE: `card`
   * is sent among them because that was exactly the spoof the old validation
   * existed to stop - a crypto purchase priced off the card row's floor.
   */
  for (const stale of ['ethereum:USDT', 'card', 'ethereum:DOGE', '../card']) {
    const ignored = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', amountUsd: '100', asset: stale }),
    });
    check(
      `asset "${stale}" is ignored, not refused`,
      ignored.status === 201,
      `status=${ignored.status} ${JSON.stringify(ignored.body)}`
    );
    check(
      `and "${stale}" did not change the price`,
      ignored.body?.amountMilli === 100000 && ignored.body?.creditMilli === 100000,
      `${ignored.body?.amountMilli} for $100`
    );
  }

  console.log('\n=== Buying once, keeping the card ===');
  const amountMilli = cardTarget?.presets?.[0]?.amountMilli ?? cardTarget?.minAmountMilli ?? 5000;
  const amountUsd = usd(amountMilli);
  const started = await call(token, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'card', amountUsd, saveCard: true }),
  });
  check('a checkout opens', started.status === 201, `status=${started.status}`);
  check(
    'the reference is this app’s own format',
    /^FT-PAY-\d{8}-\d{4}$/.test(started.body?.reference ?? ''),
    started.body?.reference
  );
  check(
    'the amount is the server’s, from the dollars it was sent, and credits the same',
    started.body?.amountMilli === amountMilli && started.body?.creditMilli === amountMilli,
    `${started.body?.amountMilli} / ${started.body?.creditMilli} vs ${amountMilli}`
  );

  // Drive the fake provider's page to paid, which posts a signed webhook.
  const sessions = await (await fetch(`${FAKE}/state`)).json();
  const session = sessions.sessions[sessions.sessions.length - 1];
  await fetch(`${FAKE}/pay/${session.id}`, { method: 'POST', redirect: 'manual' });
  await wait(400);

  const afterPay = await call(token, `/payments/${started.body.paymentId}`);
  check('the payment is paid', afterPay.body?.payment?.state === 'paid', JSON.stringify(afterPay.body));
  check(
    'the credit granted is recorded',
    afterPay.body?.payment?.creditedMilli === amountMilli,
    `granted=${afterPay.body?.payment?.creditedMilli} quoted=${amountMilli}`
  );

  console.log('\n=== The card that was kept ===');
  const cards = await call(token, '/payments/cards');
  const saved = cards.body?.cards?.[0];
  check('the card was kept', Boolean(saved), JSON.stringify(cards.body));
  check(
    'no provider handle reaches the browser',
    saved && !('methodRef' in saved) && !('customerRef' in saved),
    JSON.stringify(saved)
  );

  console.log('\n=== Buying again WITHOUT keeping the card ===');
  {
    const before = (cards.body?.cards ?? []).length;
    const declined = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'card', amountUsd }),
    });
    const state = await (await fetch(`${FAKE}/state`)).json();
    const latest = state.sessions[state.sessions.length - 1];
    await fetch(`${FAKE}/pay/${latest.id}`, { method: 'POST', redirect: 'manual' });
    await wait(500);

    const paid = await call(token, `/payments/${declined.body.paymentId}`);
    check('it is paid all the same', paid.body?.payment?.state === 'paid', JSON.stringify(paid.body?.payment));

    const after = await call(token, '/payments/cards');
    check(
      'a card the buyer did not ask to keep is not kept',
      (after.body?.cards ?? []).length === before,
      `${before} card(s) before, ${(after.body?.cards ?? []).length} after`
    );
  }

  console.log('\n=== Nobody else’s ===');
  const theirs = await call(otherToken, '/payments/cards');
  check(
    'somebody else sees none of it',
    (theirs.body?.cards ?? []).length === 0,
    JSON.stringify(theirs.body)
  );
  if (saved) {
    const stolen = await call(otherToken, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'card', amountUsd, cardId: saved.id }),
    });
    check(
      'somebody else cannot charge it, and is not told it exists',
      stolen.status === 404,
      `status=${stolen.status} ${JSON.stringify(stolen.body)}`
    );
    const undelete = await call(otherToken, `/payments/cards/${saved.id}`, { method: 'DELETE' });
    check('somebody else cannot delete it', undelete.status === 404, `status=${undelete.status}`);
  }

  console.log('\n=== Charging the card that was kept ===');
  if (saved) {
    const before = (await call(token, '/credits')).body?.balanceMilli ?? 0;
    const offSession = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'card', amountUsd, cardId: saved.id }),
    });
    check('an off-session charge is accepted', offSession.status === 201, `status=${offSession.status}`);
    check(
      'there is nothing for the browser to do',
      offSession.body?.processing === true && !offSession.body?.clientSecret,
      JSON.stringify(offSession.body)
    );

    // The intent's webhook arrives out of band, as a real one does.
    await wait(600);
    const settled = await call(token, `/payments/${offSession.body.paymentId}`);
    check(
      'the intent webhook settled it',
      settled.body?.payment?.state === 'paid',
      JSON.stringify(settled.body?.payment)
    );
    check(
      'it settled against a pi_ reference, not a cs_ one',
      (settled.body?.payment?.providerRef ?? '').startsWith('pi_'),
      settled.body?.payment?.providerRef
    );
    const after = (await call(token, '/credits')).body?.balanceMilli ?? 0;
    check('the account was credited exactly once', after === before + amountMilli, `${before} -> ${after}`);
  }

  /* ================================================= 1b. a crypto payment */
  console.log('\n=== Crypto, through Cryptomus ===');
  check(
    'crypto is one choice rather than a row per coin',
    // A COUNT, because the `target.asset` this used to filter on no longer
    // exists on either side - so that half of the condition was always true and
    // only the `available` conjunct could ever have failed.
    targets.filter((target) => target.method === 'crypto').length === 1 &&
      Boolean(cryptoTarget?.available),
    JSON.stringify(targets.map((target) => target.id))
  );

  const want = cryptoTarget?.presets?.[0]?.amountMilli ?? cryptoTarget?.minAmountMilli ?? 50000;
  const before = (await call(token, '/credits')).body?.balanceMilli ?? 0;
  const opened = await call(token, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'crypto', amountUsd: usd(want) }),
  });
  check('a crypto checkout opens', opened.status === 201, `status=${opened.status} ${JSON.stringify(opened.body)}`);
  check(
    'and hands back a URL rather than an address',
    Boolean(opened.body?.redirectUrl) && !opened.body?.invoice,
    `${opened.body?.redirectUrl} invoice=${JSON.stringify(opened.body?.invoice ?? null)}`
  );

  const invoiceId = String(opened.body?.redirectUrl ?? '').split('/').pop();
  if (invoiceId) {
    /*
     * Paid from the provider's side, which posts a callback signed the way
     * Cryptomus signs one - the signature inside the body - to the real
     * endpoint. The server's own verifier decides whether to believe it, so
     * this exercises the shipping code rather than a stub of it.
     */
    await fetch(`${FAKE}/pay/${invoiceId}`, { method: 'POST', redirect: 'manual' });
    await wait(500);

    const paid = await call(token, `/payments/${opened.body.paymentId}`);
    check('a signed callback credits it', paid.body?.payment?.state === 'paid',
      JSON.stringify(paid.body?.payment));
    const granted = paid.body?.payment?.creditedMilli ?? 0;
    check(
      'the whole amount is credited - no fee comes out of it',
      granted === want && paid.body?.payment?.feeMilli === 0,
      `granted ${granted} against ${want} paid`
    );
    check(
      'the account was credited exactly what it bought',
      ((await call(token, '/credits')).body?.balanceMilli ?? 0) === before + granted,
      `${before} + ${granted}`
    );

    // Cryptomus retries until it gets a 2xx, so this is ordinary traffic.
    await fetch(`${FAKE}/replay/${invoiceId}`, { method: 'POST' });
    await wait(300);
    check(
      'and a retried callback credits nothing further',
      ((await call(token, '/credits')).body?.balanceMilli ?? 0) === before + granted,
      `${before} + ${granted}`
    );
  } else {
    check('a signed callback credits it', false, 'no invoice to pay');
  }

  /* ======================================================== 2. the browser */
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    await signIn(page, token);

    console.log('\n=== Step 1: payment options ===');
    check('the dialog opens', await openDialog(page), 'no Purchase Credits button');
    let dialog = await readDialog(page);
    check('step 1 is the payment options', dialog?.title === 'Payment options', dialog?.title);
    // Case-insensitive, because these headings are uppercased in CSS and
    // innerText returns what is RENDERED - "Card" reaches here as "CARD".
    check('the card section is there', /card/i.test(dialog?.text ?? ''), dialog?.text);
    check('the crypto section is there', /cryptocurrencies/i.test(dialog?.text ?? ''), dialog?.text);
    check(
      'nothing hangs off the side at 1440',
      dialog && dialog.overflow.past <= 1,
      `${dialog?.overflow.past}px past ${dialog?.overflow.viewport}: ${dialog?.overflow.culprit}`
    );
    await page.screenshot({ path: path.join(SHOTS, 'buy-1-options.png') });

    console.log('\n=== Step 2: the amount ===');
    await clickText(page, '[role="dialog"] button', 'Credit or debit card');
    await wait(250);
    dialog = await readDialog(page);
    check('step 2 is the amount', dialog?.title === 'Credit amount', dialog?.title);
    const smallest = Math.min(
      ...cardTarget.presets
        .map((entry) => entry.amountMilli)
        .filter((milli) => milli >= cardTarget.minAmountMilli && milli <= cardTarget.maxAmountMilli)
    );
    check(
      'it opens on the target’s smallest preset',
      milliOf(dialog?.amount) === smallest,
      `${dialog?.amount} vs ${smallest}`
    );

    // A preset, then the total it produced, checked against the server's own.
    const preset = cardTarget.presets[Math.min(2, cardTarget.presets.length - 1)];
    await clickText(page, '[role="dialog"] button', formatMoney(preset.amountMilli));
    await wait(200);
    dialog = await readDialog(page);
    check(
      'a preset sets the amount the server offered',
      milliOf(dialog?.amount) === preset.amountMilli,
      `${dialog?.amount} vs ${preset.amountMilli}`
    );

    const typeAmount = (text) =>
      page.evaluate((value) => {
        const field = document.querySelector('[role="dialog"] input[inputmode="decimal"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }, text);

    /*
     * An amount above the ceiling is allowed to sit in the box - fitting each
     * keystroke makes some amounts impossible to type past - but the total and
     * the Continue button must quote the amount that will actually be bought,
     * not the one being typed.
     */
    await typeAmount(usd(cardTarget.maxAmountMilli + 500000));
    await wait(250);
    dialog = await readDialog(page);
    const ceiling = formatMoney(cardTarget.maxAmountMilli);
    check(
      'an amount above the ceiling is priced at the ceiling, and says so',
      (dialog?.text ?? '').includes(ceiling) && /largest card purchase is/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 500)
    );
    check(
      'and the Continue button quotes that same figure',
      (dialog?.buttons ?? []).some((label) => label.includes(ceiling)),
      (dialog?.buttons ?? []).join(' | ')
    );

    /*
     * A fraction of a cent is not an amount a card can be charged: refused in
     * the server's own words, and Continue goes nowhere - never rounded into a
     * purchase nobody typed.
     */
    await typeAmount('12.345');
    await wait(250);
    dialog = await readDialog(page);
    const continueDisabled = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="dialog"] button')).some(
        (button) => /^Continue/.test(button.textContent.trim()) && button.disabled
      )
    );
    check(
      'a fraction of a cent is refused, and Continue is off',
      /Choose an amount in dollars and cents/.test(dialog?.text ?? '') && continueDisabled,
      `${dialog?.text?.slice(0, 400)} | continue disabled: ${continueDisabled}`
    );

    // Back to the preset for the rest of the walk.
    await clickText(page, '[role="dialog"] button', formatMoney(preset.amountMilli));
    await wait(200);
    await page.screenshot({ path: path.join(SHOTS, 'buy-2-amount.png') });

    console.log('\n=== Back preserves the amount ===');
    await clickText(page, '[role="dialog"] button', 'Back');
    await wait(200);
    await clickText(page, '[role="dialog"] button', 'Credit or debit card');
    await wait(250);
    dialog = await readDialog(page);
    check(
      'stepping back and forward keeps the amount',
      milliOf(dialog?.amount) === preset.amountMilli,
      `${dialog?.amount} vs ${preset.amountMilli}`
    );

    console.log('\n=== Step 3: the order summary ===');
    await clickText(page, '[role="dialog"] button', 'Continue');
    await wait(1500);
    dialog = await readDialog(page);
    check('step 3 is the order summary', dialog?.title === 'Order summary', dialog?.title);
    check('the summary is the wide dialog', dialog?.width === 'wide', dialog?.width);
    check(
      'it shows the amount the server quoted, and the same amount of credit added',
      (dialog?.text ?? '').includes(formatMoney(preset.amountMilli)) && /Credit added/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 400)
    );
    check(
      'and no fee anywhere on it',
      !/\bfees?\b/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 1200)
    );
    check(
      'the card kept earlier is listed',
      /ending in 4242/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 600)
    );

    /*
     * The summary prices itself WITHOUT opening a checkout.
     *
     * A buyer who has a saved card should reach this screen having created
     * nothing: no payment row in their own history, and none of the twenty
     * checkouts an account may open in an hour spent. So the figures are here
     * and the reference honestly is not.
     */
    const before = (await call(token, '/payments')).body?.payments?.length ?? 0;
    check(
      'no order is opened just for looking at the summary',
      /Assigned when you pay/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 600)
    );
    check(
      'and the payment history has not grown',
      ((await call(token, '/payments')).body?.payments?.length ?? 0) === before,
      'the summary created a payment row for a purchase nobody agreed to'
    );

    console.log('\n=== The new-card form is mounted on request ===');
    await clickText(page, '[role="dialog"] button', 'Enter a new card');
    await wait(1800);
    dialog = await readDialog(page);
    check(
      'asking for a new card allocates the order',
      /FT-PAY-\d{8}-\d{4}/.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 600)
    );
    check(
      'the card form mounts, or says plainly that it could not',
      (await page.$('[role="dialog"] iframe')) !== null ||
        /could not be loaded|Preparing your order/i.test(dialog?.text ?? ''),
      'a spinner with nothing said is the failure being designed out'
    );
    check(
      'nothing hangs off the side of the wide step',
      dialog && dialog.overflow.past <= 1,
      `${dialog?.overflow.past}px past ${dialog?.overflow.viewport}: ${dialog?.overflow.culprit}`
    );
    await page.screenshot({ path: path.join(SHOTS, 'buy-3-summary.png') });

    console.log('\n=== Escape closes it ===');
    await page.keyboard.press('Escape');
    await wait(250);
    check('Escape closes the dialog', (await readDialog(page)) === null);

    /*
     * The return page tells the rest of the app the balance moved.
     *
     * The case this exists for is narrow, and getting the test wrong is easy.
     * A buyer who arrives ALREADY PAID proves nothing: landing here is a full
     * navigation, so AuthContext mounts and fetches and the pill is right
     * whatever this page does. (Written that way first, it passed with the
     * refresh removed.)
     *
     * What the refresh is for is arriving while the payment is still PENDING -
     * which is the ordinary case, because the buyer is redirected back the
     * moment they pay and the callback is still in flight. The page polls, the
     * payment flips to paid, and NOTHING else has any reason to re-read the
     * account: the webhook was server-to-server, there is no navigation, and
     * the root layout never unmounts. So the page would say the credits
     * arrived while the pill above it still showed the old figure.
     */
    console.log('\n=== The return page moves the top-bar balance ===');
    const beforeReturn = (await call(token, '/credits')).body?.balanceMilli ?? 0;
    const pending = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', amountUsd: usd(cryptoTarget?.minAmountMilli ?? 50000) }),
    });
    const pendingInvoice = String(pending.body?.redirectUrl ?? '').split('/').pop();

    /*
     * An unpaid order has no invoice, so nothing to print either. The Print
     * button used to sit above whatever the page found, this included.
     */
    const readInvoice = () =>
      page.evaluate(() => ({
        print: document.querySelectorAll('[aria-label="Print invoice"]').length,
        text: document.body.innerText,
      }));
    await page.goto(`${APP}/credits/invoice?payment=${pending.body.paymentId}`, { waitUntil: 'networkidle2' });
    await wait(500);
    const unpaidInvoice = await readInvoice();
    check(
      'an unpaid order has no invoice and no Print button',
      unpaidInvoice.print === 0 && /No invoice yet/i.test(unpaidInvoice.text),
      `print buttons: ${unpaidInvoice.print}; ${unpaidInvoice.text.slice(0, 200)}`
    );

    // Land FIRST, unpaid, exactly as the redirect does.
    await page.goto(`${APP}/credits/return?payment=${pending.body.paymentId}`, {
      waitUntil: 'networkidle2',
    });
    await wait(800);
    const pillBefore = await page.evaluate(
      () => document.querySelector('.tl-credits')?.textContent.trim() ?? ''
    );

    // Then pay it, with the page still open and polling.
    await fetch(`${FAKE}/pay/${pendingInvoice}`, { method: 'POST', redirect: 'manual' });
    await wait(4000);

    const afterReturn = (await call(token, '/credits')).body?.balanceMilli ?? 0;
    const pillAfter = await page.evaluate(
      () => document.querySelector('.tl-credits')?.textContent.trim() ?? ''
    );
    check(
      'the top-bar pill follows a payment that credits while the page is open, in dollars',
      afterReturn > beforeReturn && pillAfter.includes(formatMoney(afterReturn)),
      `pill "${pillBefore}" -> "${pillAfter}", balance ${beforeReturn} -> ${afterReturn}`
    );

    // Once paid, the same order is an invoice, and the one thing to do with it is print it.
    await page.goto(`${APP}/credits/invoice?payment=${pending.body.paymentId}`, { waitUntil: 'networkidle2' });
    await wait(500);
    const paidInvoice = await readInvoice();
    check(
      'a paid order is an invoice with a Print button',
      paidInvoice.print === 1 && /Invoice Number/i.test(paidInvoice.text),
      `print buttons: ${paidInvoice.print}; ${paidInvoice.text.slice(0, 200)}`
    );
    const cryptoCredit = formatMoney(cryptoTarget?.minAmountMilli ?? 50000);
    check(
      'and it is one line of credit at its charge, with no fee',
      paidInvoice.text.includes(`${cryptoCredit} of Tailor credit`) &&
        /Transaction Fees\s+\$0\.000/.test(paidInvoice.text),
      paidInvoice.text.slice(0, 600)
    );

    console.log('\n=== Crypto: the hand-off ===');
    await openDialog(page);

    /*
     * No option row has its LABEL clipped.
     *
     * The label is the one string inside these buttons that can clip: it
     * carries `truncate`, so an overflow shows as an ellipsis rather than as
     * a wrap, and nothing else in the button is nowrap. The per-row limit line
     * that used to sit under it is gone - the range lives in the section
     * heading now - so this measures less than it did, and says so.
     *
     * It measured more when there was a row per coin: "USDT on Ethereum"
     * needed 125px against a 103px column in a two-up grid, and the part that
     * got cut was the network, which decides where the money goes.
     */
    const clippedRows = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return Array.from(dialog.querySelectorAll('button'))
        .flatMap((button) => Array.from(button.querySelectorAll('span > span')))
        .filter((line) => line.scrollWidth > line.clientWidth + 1)
        .map((line) => line.textContent.trim());
    });
    check(
      'no option row has its label clipped',
      clippedRows.length === 0,
      `clipped: ${clippedRows.join(' | ')}`
    );

    /*
     * ONE crypto button, and no coin buttons at all.
     *
     * There was a button per coin while this application chose the token and
     * the network itself. Cryptomus asks on its own page, so a coin picked
     * here would be a choice nothing could honour - and the buyer would be
     * shown a different list on the next page.
     */
    const cryptoButtons = await page.$$eval('[role="dialog"] button', (nodes) =>
      nodes.map((node) => node.textContent.trim()).filter((text) => /crypto/i.test(text))
    );
    check(
      'crypto is one button, not a row per coin',
      cryptoButtons.length === 1,
      cryptoButtons.join(' | ')
    );

    await clickText(page, '[role="dialog"] button', 'Cryptocurrency');
    await wait(250);
    await clickText(page, '[role="dialog"] button', 'Continue');
    await wait(2000);
    dialog = await readDialog(page);

    check(
      'the crypto column is the hand-off, not a refusal',
      !/Try again/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 400)
    );
    /*
     * It says whose page comes next, before sending anybody there.
     *
     * A buyer about to leave for a domain that is not this one has to be
     * told, and told that the coin is chosen over there - otherwise the
     * missing coin buttons read as a feature that went away.
     */
    check(
      'and says the next page belongs to the provider',
      /next page is the payment provider/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 700)
    );
    check(
      'and names the amount before the hand-off',
      /\$\d/.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 700)
    );
    const continueButton = await page.$$eval('[role="dialog"] button', (nodes) =>
      nodes.map((node) => node.textContent.trim()).filter((text) => /Continue to payment/i.test(text))
    );
    check('and offers the way there', continueButton.length === 1, continueButton.join(' | '));

    /*
     * The red panel must not still be reading from the on-chain script.
     *
     * "Send the exact amount shown, on the network named" is true only where
     * this server quoted a figure against an address it owns. Here the buyer
     * has been shown neither, and will not be until the next page - so that
     * sentence tells them to check something they do not have, about a rule
     * nothing on this path enforces. PolicyPanels exists on the premise that
     * every line in it is something the server actually does; this is the
     * check that keeps that true when the provider changes underneath it.
     */
    check(
      'the policy panel does not promise the on-chain exact-amount scheme',
      !/Send the exact amount shown/i.test(dialog?.text ?? '') &&
        !/every buyer sends to the same address/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 1200)
    );
    check(
      'and says instead where the coin and the amount are chosen',
      /provider\u2019s own page|provider's own page/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 1200)
    );

    await page.screenshot({ path: path.join(SHOTS, 'buy-3-crypto.png') });
    await page.keyboard.press('Escape');

    console.log('\n=== Dark, and a phone ===');
    await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'dark'));
    await openDialog(page);
    dialog = await readDialog(page);
    check('the dialog is not a white box in dark mode', dialog?.background !== 'rgb(255, 255, 255)', dialog?.background);
    await page.screenshot({ path: path.join(SHOTS, 'buy-1-options-dark.png') });

    /*
     * Resized and then RELOADED, not resized with the dialog still up.
     *
     * A fixed panel laid out at 1440 does not always relayout before the
     * screenshot lands, which produced a picture of a clipped dialog that the
     * measurements said was fine - the picture was the lie, but only because
     * nothing had reflowed. Reopening from a fresh navigation removes the
     * question.
     */
    await page.keyboard.press('Escape');
    await page.setViewport(PHONE);
    await openDialog(page);
    await clickText(page, '[role="dialog"] button', 'Credit or debit card');
    await wait(250);
    await clickText(page, '[role="dialog"] button', 'Continue');
    await wait(1500);
    dialog = await readDialog(page);
    check('the summary is reachable on a phone', dialog?.title === 'Order summary', dialog?.title);
    check(
      'nothing hangs off the side at 390',
      dialog && dialog.overflow.past <= 1,
      `${dialog?.overflow.past}px past ${dialog?.overflow.viewport}: ${dialog?.overflow.culprit}`
    );
    await page.screenshot({ path: path.join(SHOTS, 'buy-3-summary-phone-dark.png') });

    /*
     * The state this installation never shows, and the one that broke.
     *
     * Every check above runs against a server that CAN take payments, so the
     * unavailable branch of a choice - a method listed with the reason it is
     * off - had never once been rendered by a test. It is also handed the
     * longest string the dialog can receive: setup instructions naming two
     * environment variables, one of them thirty-two characters with nowhere a
     * browser will break it. The row blew out to 1291px inside a 398px track
     * and ran 868px past the side of the dialog.
     *
     * Forced here rather than by reconfiguring the server, because taking the
     * keys out of .env would switch off every other check in this file.
     *
     * Measured against the PANEL as well as the window, which is the half
     * that catches it. A 448px panel centred at 1440 has roughly 496px of room
     * on its right before a row that has escaped it reaches the window edge -
     * so a row can be painting over the page outside its own dialog while a
     * viewport check still reads zero. There were two shapes to test while the
     * server could send a row per coin; there is one now.
     */
    console.log('\n=== A method that is switched off ===');
    // The server's own sentence, which is the longest string this dialog can
    // be handed and contains the longest unbreakable word in it.
    const LONG_REASON =
      'Set CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY to take crypto through ' +
      'Cryptomus. The CHAIN_* and COINBASE_COMMERCE_* settings no longer do anything - ' +
      'payments already made through them still read and still refund, but no new one ' +
      'can be started.';

    /*
     * Installed ONCE, and the shape read from localStorage rather than closed
     * over. `evaluateOnNewDocument` accumulates - calling it per iteration
     * would leave every earlier patch in place, each wrapping the last - and
     * localStorage survives the navigation `openDialog` performs, being the
     * same origin.
     */
    await page.evaluateOnNewDocument((reason) => {
      const real = window.fetch;
      window.fetch = async (...args) => {
        const response = await real(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
        if (!/\/payments\/methods/.test(url) || !response.ok) return response;

        const body = await response.clone().json();
        const off = (target) => ({ ...target, available: false, reason });
        body.targets = (body.targets || []).map((target) =>
          target.method === 'crypto' ? off(target) : target
        );
        body.methods = (body.methods || []).map((method) =>
          method.id === 'crypto' ? off(method) : method
        );
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    }, LONG_REASON);

    /*
     * Twice: as an administrator, who is shown the reason - the long sentence
     * the layout half of this block exists for - and as the buyer, who is shown
     * only that the method is not available and whom to ask. The reason names
     * the server's variables, which a buyer can do nothing with.
     */
    const readers = [
      { who: 'an administrator', token: adminToken, shown: 'reason' },
      { who: 'the buyer', token, shown: 'generic' },
    ];
    for (const reader of readers) {
      await signIn(page, reader.token);
      for (const viewport of [WIDE, PHONE]) {
        const where = `at ${viewport.width}, to ${reader.who}`;
        await page.setViewport(viewport);
        await openDialog(page);
        dialog = await readDialog(page);

        if (reader.shown === 'reason') {
          check(
            `an unavailable method is listed with its reason, ${where}`,
            /CRYPTOMUS_PAYMENT_API_KEY/.test(dialog?.text ?? ''),
            dialog?.text?.slice(0, 400)
          );
        } else {
          check(
            `an unavailable method says only to contact the administrator, ${where}`,
            /Not available right now\. Please contact your administrator\./.test(dialog?.text ?? ''),
            dialog?.text?.slice(0, 400)
          );
          check(
            `and names none of the server's settings, ${where}`,
            !/CRYPTOMUS|CHAIN_|COINBASE/.test(dialog?.text ?? ''),
            dialog?.text?.slice(0, 400)
          );
        }
        check(
          `nothing leaves the dialog, ${where}`,
          dialog && dialog.panel.scrollWidth <= dialog.panel.clientWidth + 1,
          `panel scrollWidth ${dialog?.panel.scrollWidth} vs clientWidth ${dialog?.panel.clientWidth}`
        );
        check(
          `and nothing leaves the screen, ${where}`,
          dialog && dialog.overflow.past <= 1,
          `${dialog?.overflow.past}px past ${dialog?.overflow.viewport}: ${dialog?.overflow.culprit}`
        );

        if (reader.shown === 'reason') {
          /*
           * Not merely inside the dialog - READABLE.
           *
           * `truncate` would keep the row inside the panel and still fail the
           * operator, because the part naming the keys is at the END of the
           * sentence and a one-line ellipsis eats exactly that. Asking whether
           * the element is clipped is not enough on its own: in the broken
           * state the BUTTON grew instead, so the text was not overflowing
           * itself and read as unclipped. The line count is what actually
           * distinguishes wrapped from nowrap.
           */
          const reason = await page.evaluate(() => {
            const node = Array.from(document.querySelectorAll('[role="dialog"] *')).find(
              (element) =>
                /CRYPTOMUS_PAYMENT_API_KEY/.test(element.textContent || '') &&
                element.children.length === 0
            );
            if (!node) return null;
            return {
              clipped: node.scrollWidth > node.clientWidth + 1,
              lines: Math.round(node.getBoundingClientRect().height / 16),
              whiteSpace: getComputedStyle(node).whiteSpace,
            };
          });
          check(
            `the reason is wrapped rather than clipped, ${where}`,
            reason && !reason.clipped && reason.lines > 1 && reason.whiteSpace !== 'nowrap',
            JSON.stringify(reason)
          );

          await page.screenshot({
            path: path.join(SHOTS, `buy-1-unavailable-${viewport.width}.png`),
          });
        }
        await page.keyboard.press('Escape');
      }
    }
    // Back to the buyer, whose history the rest of this file reads.
    await signIn(page, token);

    /* ================================ the page's own two history columns */

    /*
     * Enough rows to page, made through the API rather than the dialog.
     *
     * The account already has a payment or two from the checks above; this
     * tops it up past the smallest page size so the controls are on screen at
     * all. They are abandoned checkouts, which is exactly the state most rows
     * in a real payment history are in.
     */
    for (let index = 0; index < 12; index += 1) {
      await call(token, '/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ method: 'card', amountUsd: usd(cardTarget?.minAmountMilli ?? 2500) }),
      });
    }

    console.log('\n=== The credits page: tabs, and a paged order table ===');
    await page.setViewport(WIDE);
    await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await wait(900);

    /*
     * The page after the reference design: Card, Crypto and Credit History as
     * tabs over one table at a time, ten rows a page, First / previous / next /
     * Last. It used to show two histories side by side with a page-size select,
     * and these checks used to say so.
     */
    const tabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main [role="tab"]')).map((tab) => ({
        text: tab.textContent.trim(),
        selected: tab.getAttribute('aria-selected') === 'true',
      }))
    );
    check(
      'the histories are tabs - Card, Crypto, Credit History - with Card chosen',
      tabs.map((tab) => tab.text).join(' / ') === 'Card / Crypto / Credit History' &&
        tabs[0]?.selected === true,
      JSON.stringify(tabs)
    );
    const cardHeading = await page.evaluate(() => document.querySelector('main h2')?.textContent.trim());
    check('the Card tab is the card order history', cardHeading === 'Card Orders History', String(cardHeading));

    await clickText(page, 'main [role="tab"]', 'Credit History');
    await wait(800);
    const historyView = await page.evaluate(() => ({
      heading: document.querySelector('main h2')?.textContent.trim(),
      query: window.location.search,
    }));
    check(
      'Credit History is a tab of its own, kept in the URL',
      historyView.heading === 'Credit History' && /tab=history/.test(historyView.query),
      JSON.stringify(historyView)
    );
    await clickText(page, 'main [role="tab"]', 'Card');
    await wait(800);

    const overflow = await page.evaluate(() => ({
      past: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      viewport: window.innerWidth,
    }));
    check('nothing hangs off the side of the credits page at 1440', overflow.past <= 1,
      JSON.stringify(overflow));
    await page.screenshot({ path: path.join(SHOTS, 'credits-1-wide.png'), fullPage: false });

    /*
     * The count sentence, which is the whole point of the exercise: a list
     * that shows the newest few and says nothing about the rest is a window
     * that looks like a history.
     */
    const readPager = () =>
      page.evaluate(() => {
        const main = document.querySelector('main');
        const texts = Array.from(main.querySelectorAll('p')).map((p) => p.textContent.trim());
        return {
          heading: main.querySelector('h2')?.textContent.trim() ?? '',
          rows: main.querySelectorAll('table tbody tr').length,
          count: texts.find((text) => /Showing \d+.\d+ of \d+/.test(text)) ?? '',
          notice: texts.find((text) => /could not be loaded/i.test(text)) ?? '',
          first: main.querySelector('table tbody tr a')?.textContent.trim() ?? '',
        };
      });
    const press = (label) =>
      page.evaluate((wanted) => {
        const button = document.querySelector(`main button[aria-label="${wanted}"]`) ||
          Array.from(document.querySelectorAll('main button')).find((node) => node.textContent.trim() === wanted);
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, label);

    const opened = await readPager();
    check(
      'the card list opens on ten rows and says how many there are',
      opened.rows === 10 && /of (\d+)/.exec(opened.count)?.[1] > 10,
      JSON.stringify(opened)
    );

    // Next, then the rows must actually be different ones.
    const firstReference = opened.first;
    await press('Next page');
    await wait(700);
    const afterNext = await readPager();
    check(
      'Next shows a different page of payments',
      firstReference && afterNext.first && firstReference !== afterNext.first && /Showing 11/.test(afterNext.count),
      `${firstReference} -> ${afterNext.first} (${afterNext.count})`
    );

    await press('Previous page');
    await wait(700);
    const backAgain = await readPager();
    check('and Previous comes back to the first one', backAgain.first === firstReference,
      `${backAgain.first} vs ${firstReference}`);

    await press('Last');
    await wait(700);
    const last = await readPager();
    const total = Number(/of (\d+)/.exec(last.count)?.[1] ?? 0);
    check(
      'Last goes to the final page, which ends at the total',
      new RegExp(`–${total} of ${total}$`).test(last.count),
      last.count
    );
    await press('First');
    await wait(700);
    check('and First comes back to the top', (await readPager()).first === firstReference);

    /*
     * A page that fails, and the sentence that must not lie about it.
     *
     * A failed page deliberately keeps the rows that are already on screen - a
     * failed page is not an empty history - and the count is drawn from the
     * server's own offset, so it keeps describing the rows it came with.
     *
     * EVERY matching request fails while the flag is up, not just the first:
     * `apiFetch` tries a list of candidate API bases and moves to the next one
     * whenever a fetch REJECTS, so failing one request only sent the page to
     * the second base, where it succeeded.
     */
    const beforeFailure = await readPager();
    await page.evaluate(() => {
      const real = window.fetch;
      window.__failPages = true;
      window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
        if (window.__failPages && /\/payments\?offset=/.test(url)) {
          throw new Error('the connection dropped');
        }
        return real(...args);
      };
    });
    check('the failed-page check starts with Next actually available', await press('Next page'));
    await wait(1200);
    const failed = await readPager();
    await page.evaluate(() => {
      window.__failPages = false;
    });
    check(
      'a page that could not be loaded keeps its rows',
      failed.rows === beforeFailure.rows && failed.first === beforeFailure.first,
      JSON.stringify({ beforeFailure, failed })
    );
    check(
      'and the count still describes the rows that are on screen',
      failed.count === beforeFailure.count,
      `${beforeFailure.count} -> ${failed.count}`
    );
    check(
      'and says so rather than looking like nothing happened',
      Boolean(failed.notice),
      JSON.stringify(failed)
    );

    /*
     * On a phone, and still not overflowing.
     *
     * The table is allowed to be wider than the screen - it scrolls sideways
     * inside its own box, as the reference's does - so its cells are left out
     * of the overflow sum and the box itself is held to the window instead.
     * Measured against the WINDOW as well as the document: `.tl-topbar` is
     * `position: fixed`, so `documentElement.scrollWidth` cannot see anything
     * that escapes through it.
     */
    await page.setViewport(PHONE);
    await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await wait(900);
    const box = await page.evaluate(() => {
      const node = document.querySelector('main .tl-table-box');
      return node ? Math.round(node.getBoundingClientRect().right) - window.innerWidth : null;
    });
    check('at 390 the order table keeps to the window and scrolls inside its box', box !== null && box <= 1,
      String(box));
    const narrowOverflow = await page.evaluate(() => ({
      past: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      widest: Math.max(
        0,
        ...Array.from(document.querySelectorAll('main *'))
          .filter((node) => !node.closest('.tl-table-box'))
          .map((node) => Math.round(node.getBoundingClientRect().right) - window.innerWidth)
      ),
      viewport: window.innerWidth,
    }));
    check(
      'nothing hangs off the side of the credits page at 390',
      narrowOverflow.past <= 1 && narrowOverflow.widest <= 1,
      JSON.stringify(narrowOverflow)
    );
    await page.screenshot({ path: path.join(SHOTS, 'credits-2-phone.png') });

    // And in the dark, where a light box left behind by a utility the shim does
    // not know is the thing most likely to come out unreadable.
    await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'dark'));
    await page.setViewport(WIDE);
    await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await wait(900);
    const dark = await page.evaluate(() => {
      const read = (node) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, color: style.color };
      };
      return {
        table: read(document.querySelector('main .tl-table-box')),
        pager: read(document.querySelector('main [aria-label="Pages"] button')),
      };
    });
    const white = 'rgb(255, 255, 255)';
    check(
      'the order table and its pager are not white boxes in dark mode',
      dark.table && dark.pager && dark.table.background !== white && dark.pager.background !== white &&
        dark.pager.color !== dark.pager.background,
      JSON.stringify(dark)
    );
    await page.screenshot({ path: path.join(SHOTS, 'credits-3-wide-dark.png') });
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

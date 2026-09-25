/*
 * Buying credits through the three-step dialog, in a real browser.
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
      // The count box, when a step has one.
      credits: (() => {
        const field = dialog.querySelector('input[type="number"]');
        return field ? Number.parseInt(field.value, 10) : null;
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
  const opened = await clickText(page, 'button', 'Buy credits');
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

  /* ============================================================ 1. the API */
  console.log('\n=== Targets ===');
  const options = await call(token, '/payments/methods');
  const targets = options.body?.targets ?? [];
  const cardTarget = targets.find((t) => t.method === 'card');
  const cryptoTarget = targets.find((t) => t.method === 'crypto');
  const unit = options.body?.unitPriceCents ?? 0;
  check('a card target is offered', Boolean(cardTarget?.available), JSON.stringify(cardTarget));
  check('a crypto target is offered', Boolean(cryptoTarget?.available), JSON.stringify(cryptoTarget));
  check(
    'each target carries its own bounds',
    cardTarget && cryptoTarget && cardTarget.minAmountCents !== cryptoTarget.minAmountCents,
    `card ${cardTarget?.minAmountCents} vs crypto ${cryptoTarget?.minAmountCents}`
  );
  check(
    'every preset is inside its own target bounds',
    targets
      .filter((t) => t.available)
      .every((t) =>
        t.presets.every(
          (p) =>
            p.credits >= t.minCredits &&
            p.credits <= t.maxCredits &&
            p.amountCents === p.credits * unit
        )
      ),
    JSON.stringify(targets.map((t) => ({ id: t.id, presets: t.presets })))
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
      body: JSON.stringify({ method: 'crypto', credits: 200, asset: stale }),
    });
    check(
      `asset "${stale}" is ignored, not refused`,
      ignored.status === 201,
      `status=${ignored.status} ${JSON.stringify(ignored.body)}`
    );
    check(
      `and "${stale}" did not change the price`,
      ignored.body?.amountCents === 200 * unit,
      `${ignored.body?.amountCents} for 200 at ${unit}c`
    );
  }

  console.log('\n=== Buying once, keeping the card ===');
  const credits = cardTarget?.presets?.[0]?.credits ?? cardTarget?.minCredits ?? 10;
  const started = await call(token, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'card', credits, saveCard: true }),
  });
  check('a checkout opens', started.status === 201, `status=${started.status}`);
  check(
    'the reference is this app’s own format',
    /^FT-PAY-\d{8}-\d{4}$/.test(started.body?.reference ?? ''),
    started.body?.reference
  );
  check(
    'the amount is the server’s, from the count it was sent',
    started.body?.amountCents === credits * unit,
    `${started.body?.amountCents} vs ${credits * unit}`
  );

  // Drive the fake provider's page to paid, which posts a signed webhook.
  const sessions = await (await fetch(`${FAKE}/state`)).json();
  const session = sessions.sessions[sessions.sessions.length - 1];
  await fetch(`${FAKE}/pay/${session.id}`, { method: 'POST', redirect: 'manual' });
  await wait(400);

  const afterPay = await call(token, `/payments/${started.body.paymentId}`);
  check('the payment is paid', afterPay.body?.payment?.state === 'paid', JSON.stringify(afterPay.body));
  check(
    'the credits granted are recorded',
    afterPay.body?.payment?.creditsGranted === credits,
    `granted=${afterPay.body?.payment?.creditsGranted} quoted=${credits}`
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
      body: JSON.stringify({ method: 'card', credits }),
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
      body: JSON.stringify({ method: 'card', credits, cardId: saved.id }),
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
    const before = (await call(token, '/credits')).body?.balance ?? 0;
    const offSession = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'card', credits, cardId: saved.id }),
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
    const after = (await call(token, '/credits')).body?.balance ?? 0;
    check('the account was credited exactly once', after === before + credits, `${before} -> ${after}`);
  }

  /* ================================================= 1b. a crypto payment */
  console.log('\n=== Crypto, through Cryptomus ===');
  check(
    'crypto is one choice rather than a row per coin',
    targets.filter((target) => target.method === 'crypto' && target.asset).length === 0 &&
      Boolean(cryptoTarget?.available),
    JSON.stringify(targets.map((target) => target.id))
  );

  const want = cryptoTarget?.presets?.[0]?.credits ?? cryptoTarget?.minCredits ?? 100;
  const before = (await call(token, '/credits')).body?.balance ?? 0;
  const opened = await call(token, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'crypto', credits: want }),
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
    const granted = paid.body?.payment?.creditsGranted ?? 0;
    check(
      'the fee comes out of the credits, not out of the amount sent',
      granted > 0 && granted < want,
      `granted ${granted} against ${want} requested`
    );
    check(
      'the account was credited exactly what it bought',
      ((await call(token, '/credits')).body?.balance ?? 0) === before + granted,
      `${before} + ${granted}`
    );

    // Cryptomus retries until it gets a 2xx, so this is ordinary traffic.
    await fetch(`${FAKE}/replay/${invoiceId}`, { method: 'POST' });
    await wait(300);
    check(
      'and a retried callback credits nothing further',
      ((await call(token, '/credits')).body?.balance ?? 0) === before + granted,
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
    check('the dialog opens', await openDialog(page), 'no Buy credits button');
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
    check('step 2 is the amount', dialog?.title === 'Credits amount', dialog?.title);
    const firstCredits = dialog?.credits ?? 0;
    check(
      'it opens on the target’s smallest preset',
      firstCredits === (cardTarget?.presets?.[0]?.credits ?? cardTarget?.minCredits),
      `${firstCredits} vs ${cardTarget?.presets?.[0]?.credits}`
    );

    // A preset, then the total it produced, checked against the server's own.
    const preset = cardTarget.presets[Math.min(2, cardTarget.presets.length - 1)];
    // The formatted figure, not the bare number: "10" also matches "$100.00".
    await clickText(page, '[role="dialog"] button', (preset.amountCents / 100).toFixed(2));
    await wait(200);
    dialog = await readDialog(page);
    check(
      'a preset sets the count the server quoted for it',
      dialog?.credits === preset.credits,
      `${dialog?.credits} vs ${preset.credits}`
    );

    /*
     * A number above the ceiling is allowed to sit in the box - clamping each
     * keystroke makes a two-digit maximum impossible to type past - but the
     * total and the Continue button must quote the number that will actually
     * be bought, not the one being typed.
     */
    await page.evaluate((over) => {
      const field = document.querySelector('[role="dialog"] input[type="number"]');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(field, String(over));
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, cardTarget.maxCredits + 500);
    await wait(250);
    dialog = await readDialog(page);
    const ceiling = (cardTarget.maxCredits * unit) / 100;
    check(
      'a count above the ceiling is priced at the ceiling, and says so',
      (dialog?.text ?? '').includes(ceiling.toFixed(2)) &&
        /largest purchase is/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 500)
    );
    check(
      'and the Continue button quotes that same figure',
      (dialog?.buttons ?? []).some((label) => label.includes(ceiling.toFixed(2))),
      (dialog?.buttons ?? []).join(' | ')
    );

    // Back to the preset for the rest of the walk.
    await clickText(page, '[role="dialog"] button', (preset.amountCents / 100).toFixed(2));
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
      dialog?.credits === preset.credits,
      `${dialog?.credits} vs ${preset.credits}`
    );

    console.log('\n=== Step 3: the order summary ===');
    await clickText(page, '[role="dialog"] button', 'Continue');
    await wait(1500);
    dialog = await readDialog(page);
    check('step 3 is the order summary', dialog?.title === 'Order summary', dialog?.title);
    check('the summary is the wide dialog', dialog?.width === 'wide', dialog?.width);
    check(
      'it shows the amount the server quoted',
      (dialog?.text ?? '').includes((preset.amountCents / 100).toFixed(2)),
      dialog?.text?.slice(0, 400)
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
    const beforeReturn = (await call(token, '/credits')).body?.balance ?? 0;
    const pending = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', credits: cryptoTarget?.minCredits ?? 100 }),
    });
    const pendingInvoice = String(pending.body?.redirectUrl ?? '').split('/').pop();

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

    const afterReturn = (await call(token, '/credits')).body?.balance ?? 0;
    const pillAfter = await page.evaluate(
      () => document.querySelector('.tl-credits')?.textContent.trim() ?? ''
    );
    check(
      'the top-bar pill follows a payment that credits while the page is open',
      afterReturn > beforeReturn && pillAfter.includes(String(afterReturn)),
      `pill "${pillBefore}" -> "${pillAfter}", balance ${beforeReturn} -> ${afterReturn}`
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

    for (const viewport of [WIDE, PHONE]) {
      const where = `at ${viewport.width}`;
      await page.setViewport(viewport);
      await openDialog(page);
      dialog = await readDialog(page);

      check(
        `an unavailable method is listed with its reason, ${where}`,
        /CRYPTOMUS_PAYMENT_API_KEY/.test(dialog?.text ?? ''),
        dialog?.text?.slice(0, 400)
      );
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
      await page.keyboard.press('Escape');
    }

    /* ================================ the page's own two history columns */

    /*
     * Enough rows to page, made through the API rather than the dialog.
     *
     * The account already has a payment or two from the checks above; this
     * tops it up past the smallest page size so the controls are on screen at
     * all. They are abandoned checkouts, which is exactly the state most rows
     * in a real payment history are in.
     */
    for (let index = 0; index < 8; index += 1) {
      await call(token, '/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ method: 'card', credits: cardTarget?.minCredits ?? 10 }),
      });
    }

    console.log('\n=== The credits page: two columns, paged ===');
    await page.setViewport(WIDE);
    await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await wait(900);

    const headings = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('main h2')).map((node) => ({
          text: node.textContent.trim(),
          left: Math.round(node.getBoundingClientRect().left),
          top: Math.round(node.getBoundingClientRect().top),
        }))
      );

    const wide = await headings();
    const payHeading = wide.find((entry) => entry.text === 'Payment history');
    const creditHeading = wide.find((entry) => entry.text === 'Credit history');
    check(
      'both histories are on the page, and named as a pair',
      Boolean(payHeading && creditHeading),
      JSON.stringify(wide)
    );
    /*
     * Side by side, measured rather than assumed from the class name.
     *
     * `lg:grid-cols-2` in the markup proves nothing about what rendered: the
     * page's own max-width has to grow at the same breakpoint or the two
     * columns are 370px each inside a 768px well, and a Tailwind config change
     * would take the layout apart silently.
     */
    check(
      'at 1440 they are side by side, not stacked',
      payHeading && creditHeading &&
        creditHeading.left > payHeading.left &&
        Math.abs(creditHeading.top - payHeading.top) < 40,
      JSON.stringify([payHeading, creditHeading])
    );

    /*
     * And NOT at 1024, which is the decision most likely to be undone.
     *
     * `lg` is the obvious breakpoint and it is the wrong one here: the rail
     * takes 240px of the window, so a 1024px screen leaves a 784px well and
     * two 347px columns - narrow enough that every payment row wraps its
     * status pill onto a second line. The split is worth having at `xl` and
     * not before, and this is what says so.
     */
    await page.setViewport({ width: 1024, height: 900 });
    await wait(600);
    const medium = await headings();
    const mediumPay = medium.find((entry) => entry.text === 'Payment history');
    const mediumCredit = medium.find((entry) => entry.text === 'Credit history');
    check(
      'at 1024 they are still stacked, because two columns there are too narrow',
      mediumPay && mediumCredit && mediumCredit.top > mediumPay.top,
      JSON.stringify([mediumPay, mediumCredit])
    );
    await page.setViewport(WIDE);
    await wait(600);

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
        const cards = Array.from(document.querySelectorAll('main h2')).map((h) => h.parentElement);
        return cards.map((card) => ({
          heading: card.querySelector('h2')?.textContent.trim() ?? '',
          rows: card.querySelectorAll('ul > li').length,
          count: Array.from(card.querySelectorAll('p'))
            .map((p) => p.textContent.trim())
            .find((text) => /\d+.\d+ of \d+/.test(text)) ?? '',
          size: card.querySelector('select')?.value ?? '',
        }));
      });

    const opened = (await readPager()).find((card) => card.heading === 'Payment history');
    check(
      'the payment list opens on five rows and says how many there are',
      opened && opened.rows === 5 && opened.size === '5' && /of \d+ payments/.test(opened.count),
      JSON.stringify(opened)
    );

    // Older, then the rows must actually be different ones.
    const firstReference = await page.evaluate(
      () => document.querySelector('main ul > li a')?.textContent.trim() ?? ''
    );
    await clickText(page, 'main button', 'Older');
    await wait(700);
    const afterOlder = await page.evaluate(
      () => document.querySelector('main ul > li a')?.textContent.trim() ?? ''
    );
    check(
      'Older shows a different page of payments',
      firstReference && afterOlder && firstReference !== afterOlder,
      `${firstReference} -> ${afterOlder}`
    );

    await clickText(page, 'main button', 'Newer');
    await wait(700);
    const backAgain = await page.evaluate(
      () => document.querySelector('main ul > li a')?.textContent.trim() ?? ''
    );
    check('and Newer comes back to the first one', backAgain === firstReference,
      `${backAgain} vs ${firstReference}`);

    // The size selector, which is the other half of what was asked for.
    await page.select('main select', '20');
    await wait(700);
    const grown = (await readPager()).find((card) => card.heading === 'Payment history');
    check(
      'choosing 20 rows shows more of them',
      grown && grown.rows > 5,
      JSON.stringify(grown)
    );

    /*
     * Stacked on a phone, and still not overflowing.
     *
     * Measured against the WINDOW as well as the document: `.tl-topbar` is
     * `position: fixed`, so `documentElement.scrollWidth` cannot see anything
     * that escapes through it - the trap that let two overflow bugs through
     * checks named "nothing hangs off the side".
     */
    await page.setViewport(PHONE);
    await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await wait(900);
    const narrow = await headings();
    const narrowPay = narrow.find((entry) => entry.text === 'Payment history');
    const narrowCredit = narrow.find((entry) => entry.text === 'Credit history');
    check(
      'at 390 the two columns stack',
      narrowPay && narrowCredit && narrowCredit.top > narrowPay.top &&
        Math.abs(narrowCredit.left - narrowPay.left) < 2,
      JSON.stringify([narrowPay, narrowCredit])
    );
    const narrowOverflow = await page.evaluate(() => ({
      past: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      widest: Math.max(
        0,
        ...Array.from(document.querySelectorAll('main *')).map(
          (node) => Math.round(node.getBoundingClientRect().right) - window.innerWidth
        )
      ),
      viewport: window.innerWidth,
    }));
    check(
      'nothing hangs off the side of the credits page at 390',
      narrowOverflow.past <= 1 && narrowOverflow.widest <= 1,
      JSON.stringify(narrowOverflow)
    );
    await page.screenshot({ path: path.join(SHOTS, 'credits-2-phone.png') });

    // And in the dark, where the select is the control most likely to come out
    // unreadable: the shim restyles bare selects and nothing else here does.
    await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'dark'));
    await page.setViewport(WIDE);
    await page.goto(`${APP}/credits`, { waitUntil: 'networkidle2' });
    await wait(900);
    const darkSelect = await page.evaluate(() => {
      const node = document.querySelector('main select');
      if (!node) return null;
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, color: style.color };
    });
    check(
      'the page-size control is not white-on-white in dark mode',
      darkSelect && darkSelect.background !== 'rgb(255, 255, 255)' &&
        darkSelect.color !== 'rgb(255, 255, 255)',
      JSON.stringify(darkSelect)
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

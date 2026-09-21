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

  console.log('\n=== A coin the server has never heard of ===');
  for (const bogus of ['card', 'crypto', 'ethereum:DOGE', '../card', '']) {
    const refused = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', credits: 200, asset: bogus }),
    });
    // An empty string is no asset at all, which is an ordinary crypto sale.
    const expected = bogus === '' ? 201 : 400;
    check(
      `asset "${bogus}" is ${expected === 400 ? 'refused' : 'ignored'}`,
      refused.status === expected,
      `status=${refused.status} ${JSON.stringify(refused.body)}`
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

    console.log('\n=== Crypto ===');
    await openDialog(page);
    await clickText(page, '[role="dialog"] button', 'Crypto');
    await wait(250);
    await clickText(page, '[role="dialog"] button', 'Continue');
    await wait(1500);
    dialog = await readDialog(page);
    check('the crypto column offers the hand-off', /Continue to payment/i.test(dialog?.text ?? ''), dialog?.text?.slice(0, 500));
    check(
      'and says the coin is chosen on the provider’s page',
      /not ours/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 500)
    );
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

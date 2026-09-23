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
  /*
   * Which of the three crypto paths this installation is actually running.
   *
   * Cryptomus when it is configured, otherwise the retired on-chain watcher,
   * otherwise the retired Coinbase one. Read, never assumed: both retired
   * paths still run in the field until they are deleted, and a walkthrough
   * that hard-coded the new shape would call a working old install broken.
   */
  const cryptoProvider =
    (options.body?.methods ?? []).find((entry) => entry.method === 'crypto')?.provider ?? 'none';
  console.log(`    (crypto is being taken through ${cryptoProvider})`);

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
  /*
   * The empty string is the one that depends on who is taking the money.
   *
   * On-chain, a payment is an amount of one specific token sent to one
   * specific address and there is no sensible default, so "no coin" is a
   * refusal. On a hosted page the buyer picks the coin over there, so no coin
   * is the ordinary case - and a stale tab that still has coin buttons on it
   * must not have its purchase failed for pressing one. An INVENTED coin is
   * refused either way: it would otherwise reach the pricing authority.
   */
  const invented = ['card', 'crypto', 'ethereum:DOGE', '../card'];
  for (const bogus of cryptoProvider === 'chain' ? [...invented, ''] : invented) {
    const refused = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', credits: 200, asset: bogus }),
    });
    /*
     * A 400, not a 503 and not a 201: `isAssetId` is a closed list, checked
     * beside the other request validation rather than inside the provider
     * block, so an invented coin never becomes a failed payment row.
     */
    check(
      `asset "${bogus}" is refused`,
      refused.status === 400,
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

  /* ================================================= 1b. a crypto payment */
  const coinTargets = targets.filter((target) => target.method === 'crypto' && target.asset);

  if (cryptoProvider === 'cryptomus') {
    console.log('\n=== Crypto, through Cryptomus ===');
    check(
      'crypto is one choice rather than a row per coin',
      coinTargets.length === 0 && Boolean(cryptoTarget?.available),
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
  } else {

  console.log('\n=== Crypto, in the operator’s own wallet ===');
  check(
    'each enabled coin is its own choice, with its network named',
    coinTargets.length >= 2,
    JSON.stringify(targets.map((target) => target.id))
  );

  const coin = coinTargets.find((target) => target.asset === 'ethereum:USDT');
  if (coin) {
    /*
     * A different amount on every run, and not for tidiness.
     *
     * An open invoice reserves its exact amount for twenty minutes, so the
     * second run of this script within that window asks for an amount the
     * first run is still holding - and is correctly refused. That is the
     * collision guard working, which is asserted deliberately a few lines
     * below with the SAME amount. Here the point is to be a different buyer.
     */
    /*
     * A wide span, because a reservation lasts a DAY here.
     *
     * An open invoice holds its exact amount until its monitor window closes,
     * and that window is the quote's twenty minutes plus
     * CHAIN_MONITOR_WINDOW_HOURS - twenty-four by default, so that a transfer
     * sent late is still credited. Against a forty-value span that made a
     * second run inside the same day collide almost every time, and a
     * collision here is a 409 the script reads as the deposit view failing to
     * open. One thousand values keeps the run well inside maxCredits and makes
     * the clash rare rather than routine.
     */
    const credits = coin.minCredits + (Math.floor(Date.now() / 1000) % 1_000);
    const started = await call(token, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', credits, asset: coin.asset }),
    });
    check('an on-chain checkout opens', started.status === 201, JSON.stringify(started.body));

    const invoice = started.body?.invoice;
    check('it hands back an address and an exact amount', Boolean(invoice?.address && invoice?.amount), JSON.stringify(invoice));
    check(
      'the address is the one the operator configured',
      invoice?.address === process.env.CHAIN_EVM_ADDRESS,
      `${invoice?.address} vs ${process.env.CHAIN_EVM_ADDRESS}`
    );
    check('nothing is sent to a hosted page', !started.body?.redirectUrl, started.body?.redirectUrl);

    /*
     * The same amount is refused to a second buyer rather than nudged.
     *
     * Two open orders one atomic unit apart are two orders a wrong-amount
     * payment could equally have meant, which is the ambiguity the whole
     * settlement design refuses to have.
     */
    const clash = await call(otherToken, '/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method: 'crypto', credits, asset: coin.asset }),
    });
    check(
      'a second buyer asking for the same amount is told to wait',
      clash.status === 409,
      `status=${clash.status} ${JSON.stringify(clash.body)}`
    );

    console.log('\n=== The watcher sees it, then credits it ===');
    const before = (await call(token, '/credits')).body?.balance ?? 0;

    // Announce the transfer just below the confirmation depth, so the SEEN
    // state is exercised rather than skipped.
    await fetch(
      `${FAKE}/chain/send?asset=${encodeURIComponent(coin.asset)}` +
        `&to=${encodeURIComponent(invoice.address)}&amount=${invoice.amountAtomic}&depth=3`,
      { method: 'POST' }
    );
    // One watcher pass, on demand: the real interval is thirty seconds and
    // this calls the same function the timer calls.
    await fetch(`${FAKE}/chain/sweep?chain=ethereum`, { method: 'POST' });
    await wait(300);

    const seen = await call(token, `/payments/${started.body.paymentId}`);
    check(
      'a transfer that is not deep enough is seen, not credited',
      seen.body?.invoice?.state === 'seen',
      JSON.stringify(seen.body?.invoice)
    );
    check(
      'and it says how deep it is',
      (seen.body?.invoice?.confirmations ?? 0) > 0 &&
        seen.body.invoice.confirmations < seen.body.invoice.confirmationsNeeded,
      JSON.stringify(seen.body?.invoice)
    );
    check(
      'nothing has been credited yet',
      ((await call(token, '/credits')).body?.balance ?? 0) === before,
      'a shallow transfer must not credit'
    );

    // Now bury it under the confirmation depth and sweep again.
    await fetch(`${FAKE}/chain/advance?chain=ethereum&blocks=30`, { method: 'POST' });
    await fetch(`${FAKE}/chain/sweep?chain=ethereum`, { method: 'POST' });
    await wait(300);

    const settled = await call(token, `/payments/${started.body.paymentId}`);
    check(
      'once it is deep enough the payment is paid',
      settled.body?.payment?.state === 'paid',
      JSON.stringify(settled.body?.payment)
    );
    check(
      'and the invoice is credited',
      settled.body?.invoice?.state === 'credited',
      JSON.stringify(settled.body?.invoice)
    );
    /*
     * What was GRANTED, not what was asked for.
     *
     * The crypto limits row carries a 2.2% fee by default, and a fee comes out
     * of the credits rather than being added to the charge - so 100 credits'
     * worth of coin credits 97. Asserting the requested figure here would be
     * asserting that the fee does not work.
     */
    const granted = started.body.credits;
    check(
      'the fee comes out of the credits, not out of the amount sent',
      granted < credits,
      `granted ${granted} against ${credits} requested`
    );
    check(
      'the account was credited exactly what it bought',
      ((await call(token, '/credits')).body?.balance ?? 0) === before + granted,
      `${before} + ${granted} !== ${(await call(token, '/credits')).body?.balance}`
    );
  } else {
    check('ethereum:USDT is configured for this walkthrough', false, 'set CHAIN_ASSETS in .env');
  }
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

    console.log('\n=== Crypto: the deposit panel ===');
    await openDialog(page);

    /*
     * The network is READABLE, not merely present.
     *
     * USDT exists on all three chains this server takes, so the network is the
     * only thing distinguishing one of these buttons from another - and
     * sending USDT on the wrong chain loses it. The coin grid used to go
     * two-up whenever there was more than one coin, which inside step 1's
     * 446px panel left a 103px text column: "USDT on Ethereum" needs 125px, so
     * it rendered as "USDT on Ethe..." beside "USDT on BNB ...", and every
     * limit line as "$50.00 - $2,000...". The label is the last string in this
     * dialog that may be shortened.
     */
    const clippedRows = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const rows = Array.from(dialog.querySelectorAll('button')).filter((button) =>
        /\bon\b|Bitcoin/.test(button.textContent || '')
      );
      return rows
        .flatMap((button) => Array.from(button.querySelectorAll('span > span')))
        .filter((line) => line.scrollWidth > line.clientWidth + 1)
        .map((line) => line.textContent.trim());
    });
    check(
      'no coin has its network or its limits clipped',
      clippedRows.length === 0,
      `clipped: ${clippedRows.join(' | ')}`
    );

    /*
     * Which crypto shape this installation renders, read rather than assumed.
     *
     * With Cryptomus configured there is ONE button - the coin and the network
     * are chosen on Cryptomus's own page, from Cryptomus's own list, so a coin
     * button here would offer a choice this application cannot honour. With
     * the retired on-chain path configured instead there is a button per coin
     * and a deposit address to show. Both are real configurations today, and a
     * script that hard-coded either would report the other as broken.
     */
    const onChainShape = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) =>
        /USDT on |BTC on |Bitcoin/.test(button.textContent || '')
      )
    );

    if (!onChainShape) {
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
    } else {

    // A coin, not a category: each is its own button with its network named.
    await clickText(page, '[role="dialog"] button', 'USDT on Ethereum');
    await wait(250);

    /*
     * A per-run amount here too, for the same reason as above: an open invoice
     * reserves its exact figure for twenty minutes, and the API half of this
     * script has already taken one. Typed into the box rather than clicked on
     * a preset, because a preset is a fixed dollar amount and two runs would
     * ask for the same one.
     */
    await page.evaluate((count) => {
      const field = document.querySelector('[role="dialog"] input[type="number"]');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(field, String(count));
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, 140 + (Math.floor(Date.now() / 1000) % 50));
    await wait(250);

    await clickText(page, '[role="dialog"] button', 'Continue');
    await wait(2000);
    dialog = await readDialog(page);
    check(
      'the crypto column is the deposit view, not a refusal',
      !/Try again/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 400)
    );

    check(
      'the panel shows the address the operator configured',
      (dialog?.text ?? '').includes(process.env.CHAIN_EVM_ADDRESS ?? 'no address'),
      dialog?.text?.slice(0, 700)
    );
    check(
      'and an exact amount to send, with the network named',
      /Send exactly/i.test(dialog?.text ?? '') && /on Ethereum, and no other network/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 700)
    );
    check(
      'and a countdown that is running',
      /Expires in/i.test(dialog?.text ?? '') && /\d+:\d\d/.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 700)
    );
    check(
      'and says why the amount has to be exact',
      /every buyer sends to the same address/i.test(dialog?.text ?? ''),
      dialog?.text?.slice(0, 900)
    );

    // Two copy buttons: the amount and the address. Both are conveniences -
    // the values are on screen and selectable either way.
    const copyButtons = await page.$$eval('[role="dialog"] button[aria-label^="Copy"]', (nodes) =>
      nodes.map((node) => node.getAttribute('aria-label'))
    );
    check(
      'both the amount and the address can be copied',
      copyButtons.length === 2,
      copyButtons.join(' | ')
    );
    await page.screenshot({ path: path.join(SHOTS, 'buy-3-crypto.png') });
    await page.keyboard.press('Escape');
    }

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
     * BOTH SHAPES, and the difference is the whole reason this is a loop.
     * With no coins configured the server sends ONE method-level crypto row,
     * which lands in a single-column grid - that is the shape in the bug
     * report. With coins configured but switched off it sends a row per coin,
     * which goes two-up at `sm`. The first overflows the viewport at 1440; the
     * second only overflows the PANEL there, and a check watching the window
     * alone passes it. Testing one shape and not the other is how this got
     * shipped in the first place.
     */
    console.log('\n=== A method that is switched off ===');
    const LONG_REASON =
      'Set CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY to take crypto through ' +
      'Cryptomus. Set CHAIN_ASSETS and the receiving addresses to take crypto payments. ' +
      'Or set COINBASE_COMMERCE_API_KEY and COINBASE_COMMERCE_WEBHOOK_SECRET for Coinbase ' +
      'Commerce. Both of those are retired and will be removed.';

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

        let shape = 'coins';
        try {
          shape = window.localStorage.getItem('e2e-methods-shape') || 'coins';
        } catch {
          /* A blocked store means the default, which is a real shape too. */
        }

        const body = await response.clone().json();
        const off = (target) => ({ ...target, available: false, reason });

        if (shape === 'method') {
          // No coins configured at all: one method-level row, as the server
          // sends when the CHAIN_ block is empty and Coinbase has no keys.
          body.targets = (body.targets || [])
            .filter((target) => target.method !== 'crypto')
            .concat([
              off({
                id: 'crypto',
                method: 'crypto',
                mark: 'crypto',
                label: 'Cryptocurrency',
                minCredits: 0,
                maxCredits: 0,
                minAmountCents: 0,
                maxAmountCents: 0,
                presets: [],
                custom: 'stepper',
                feeBps: 0,
                feeFixedCents: 0,
              }),
            ]);
        } else {
          body.targets = (body.targets || []).map((target) =>
            target.method === 'crypto' ? off(target) : target
          );
        }

        body.methods = (body.methods || []).map((method) =>
          method.id === 'crypto' ? off(method) : method
        );
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    }, LONG_REASON);

    for (const shape of ['method', 'coins']) {
      for (const viewport of [WIDE, PHONE]) {
        const where = `${shape} at ${viewport.width}`;
        await page.setViewport(viewport);
        await page.evaluate((value) => window.localStorage.setItem('e2e-methods-shape', value), shape);
        await openDialog(page);
        dialog = await readDialog(page);

        check(
          `an unavailable method is listed with its reason, ${where}`,
          /COINBASE_COMMERCE_WEBHOOK_SECRET/.test(dialog?.text ?? ''),
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
              /COINBASE_COMMERCE_WEBHOOK_SECRET/.test(element.textContent || '') &&
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
          path: path.join(SHOTS, `buy-1-unavailable-${shape}-${viewport.width}.png`),
        });
        await page.keyboard.press('Escape');
      }
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

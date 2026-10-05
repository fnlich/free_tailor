/*
 * Asking for a refund, deciding it, and Contact admin - in a real browser.
 *
 * test/refundRequests.test.js proves the server's state machine and
 * test/frontendRefunds.test.js the page's pure decisions. This proves they are
 * joined up: a person presses "Ask for refund" on a purchase, the request
 * reaches every administrator's bell with a link to the queue, an
 * administrator marks one refunded and declines another, and the person reads
 * both outcomes - in the Refund Requests tab and in their own bell, and in
 * nobody else's.
 *
 * Nothing is bought: the purchases are written straight into the database the
 * server reads (the same DB_DIR), paid the way a webhook pays them
 * (`creditPaid`), because a refund request is about a paid purchase however it
 * was paid. The crypto one is the one that can be refunded with no provider -
 * by hand, which is exactly the path that needs the "send it back FIRST" step
 * on the page. The card one, with no Stripe keys, fails at Stripe - which is
 * how this reaches the generic "contact your administrator" sentence, its
 * Contact admin link, and a dialog over a dialog.
 *
 * Servers are expected to be up already, sharing DB_DIR with this script -
 * the backend WITHOUT test/e2e/fake-providers.js and without Stripe keys, or
 * the card refund this relies on failing succeeds instead:
 *
 *   STRIPE_SECRET_KEY= STRIPE_PUBLISHABLE_KEY= STRIPE_WEBHOOK_SECRET= DB_DIR=... PORT=3001 node dist/index.js
 *   DB_DIR=... node test/e2e/refunds.js
 */

const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));
const paymentRepository = require(path.join(DIST, 'database', 'paymentRepository'));
const payments = require(path.join(DIST, 'services', 'payments'));
const credits = require(path.join(DIST, 'services', 'credits'));
const orders = require(path.join(DIST, 'database', 'orderRepository'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

let failures = 0;
/** The detail is the reason it FAILED, so printing it on a pass reads as one. */
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function signIn(page, token) {
  // Both halves of a real sign-in: the bearer copy the API client sends, and
  // the cookie. See shell.js.
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({
    name: 'ft_session',
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
}

/** A paid purchase, paid the way a provider's webhook pays one. */
function seedPurchase(userId, { method, provider, dollars }) {
  const payment = paymentRepository.createPayment({
    userId,
    method,
    provider,
    amountCents: dollars * 100,
    creditMilli: dollars * 1000,
    currency: 'USD',
  });
  paymentRepository.attachProviderRef(payment.id, `${provider === 'stripe' ? 'cs' : 'inv'}_e2e_${payment.id.slice(4, 12)}`);
  const outcome = payments.creditPaid(payment.id);
  if (!outcome.credited) throw new Error(`could not pay ${payment.reference}`);
  return paymentRepository.getPayment(payment.id);
}

/** Waits until `predicate(document)` holds, or the time runs out. Returns whether it did. */
async function until(page, predicate, arg, timeout = 8000) {
  try {
    await page.waitForFunction(predicate, { timeout, polling: 100 }, arg);
    return true;
  } catch {
    return false;
  }
}

/** The text of the open dialog with this accessible name, or null. */
function dialogText(page, label) {
  return page.evaluate((name) => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
    const dialog = dialogs.find((node) => node.getAttribute('aria-label') === name);
    return dialog ? dialog.innerText : null;
  }, label);
}

/** Presses the button with exactly this text inside the dialog with this name. */
function pressInDialog(page, label, text) {
  return page.evaluate(
    (name, wanted) => {
      const dialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).find(
        (node) => node.getAttribute('aria-label') === name
      );
      const button = dialog
        ? Array.from(dialog.querySelectorAll('button')).find((node) => node.textContent.trim() === wanted)
        : null;
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    label,
    text
  );
}

/** Presses the button with this text in the table row that mentions `needle`. */
function pressInRow(page, needle, text) {
  return page.evaluate(
    (find, wanted) => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find((node) => node.textContent.includes(find));
      const button = row
        ? Array.from(row.querySelectorAll('button')).find((node) => node.textContent.trim() === wanted)
        : null;
      button?.click();
      return Boolean(button);
    },
    needle,
    text
  );
}

/** The text of the table row that mentions `needle`, or null. */
function rowText(page, needle) {
  return page.evaluate((find) => {
    const row = Array.from(document.querySelectorAll('tbody tr')).find((node) => node.textContent.includes(find));
    return row ? row.innerText : null;
  }, needle);
}

/** Types into a field, replacing what is there, the way a person does - through React's own events. */
async function typeInto(page, selector, text) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, text);
}

/** Opens the bell and reads it: the dot's count, and every notice as title, body, link and "For you". */
async function readBell(page) {
  const label = await page.$eval('button[title="Notifications"]', (node) => node.getAttribute('aria-label'));
  await page.click('button[title="Notifications"]');
  await until(page, () => Boolean(document.querySelector('[role="dialog"][aria-label="Notifications"] article')));
  const notices = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"][aria-label="Notifications"] article')).map((node) => ({
      text: node.innerText,
      link: node.querySelector('a')?.getAttribute('href') ?? null,
      linkText: node.querySelector('a')?.textContent.trim() ?? null,
      forYou: /For you/.test(node.innerText),
    }))
  );
  return { label, notices };
}

async function main() {
  const stamp = Date.now().toString(36);
  const user = users.createUser({ email: `e2e-refunds-${stamp}@example.com`, name: 'Refund Asker' });
  const bystander = users.createUser({ email: `e2e-bystander-${stamp}@example.com`, name: 'Bystander' });
  const admin = users.findOrCreateUser({ email: 'boss@example.com' }).account;
  users.updateUser(admin.id, { role: 'admin' });

  const userToken = users.createSession(user.id);
  const bystanderToken = users.createSession(bystander.id);
  const adminToken = users.createSession(admin.id);
  const asUser = apiAs(userToken);
  const asAdmin = apiAs(adminToken);

  // Two crypto purchases (one to refund by hand, one to decline) and a card
  // one (to fail at Stripe), all paid; and one run's charge in the history.
  const crypto = seedPurchase(user.id, { method: 'crypto', provider: 'cryptomus', dollars: 25 });
  const second = seedPurchase(user.id, { method: 'crypto', provider: 'cryptomus', dollars: 5 });
  const card = seedPurchase(user.id, { method: 'card', provider: 'stripe', dollars: 10 });
  const run = credits.reserveCredits(users.getUserById(user.id), 161, { kind: 'batch', id: `e2e-run-${stamp}` });
  check('setup: three paid purchases and a $0.161 run charge', run.costMilli === 161, JSON.stringify(run));

  // An order of two $0.023 resumes, charged as one run: one delivered, one
  // that did not build - as the queue would have left them.
  const batchId = `e2e-order-${stamp}`;
  credits.reserveCredits(users.getUserById(user.id), 46, { kind: 'batch', id: batchId });
  const order = orders.createOrder({ userId: user.id, batchId, retentionDays: 5 }, [
    { seq: 0, profileId: 'e2e-profile', profileName: 'Jane Doe', companyName: 'Acme', role: 'Engineer', costMilli: 23 },
    { seq: 1, profileId: 'e2e-profile', profileName: 'Jane Doe', companyName: 'Globex', role: 'Engineer', costMilli: 23 },
  ]);
  orders.recordItemOutcome(batchId, 0, { state: 'done' });
  orders.recordItemOutcome(batchId, 1, {
    state: 'failed',
    error: 'Could not build this resume. Please try again, or contact your administrator. (Ref: ERR-e2e001)',
  });
  orders.settleOrderIfFinished(order.id);

  // The administrator's contact list, through the API the editor uses.
  const saved = await asAdmin('/admin/contact', {
    method: 'PUT',
    body: JSON.stringify({
      channels: [
        { type: 'email', label: 'Support', value: 'help@example.com' },
        { type: 'discord', label: '', value: 'Tailor.Help' },
      ],
    }),
  });
  check('setup: the administrator lists two ways to reach them', saved.status === 200, `got ${saved.status}`);

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    /* ------------------------------------------------ the person asking */
    const page = await browser.newPage();
    await page.setViewport(WIDE);
    await signIn(page, userToken);

    await page.goto(`${APP}/credits?tab=crypto`, { waitUntil: 'networkidle2' });
    await until(page, (ref) => document.body.innerText.includes(ref), crypto.reference);
    check(
      'user /credits Crypto: a paid purchase offers Ask for refund',
      await pressInRow(page, crypto.reference, 'Ask for refund'),
      await rowText(page, crypto.reference)
    );
    const opened = await until(page, () =>
      /You would get back/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const offer = await dialogText(page, 'Ask for a refund');
    check(
      'user: the dialog says what would come back - the unspent $25.000, sent back by hand for crypto',
      opened && /\$25\.000/.test(offer) && /sent back to you by your administrator/.test(offer),
      JSON.stringify(offer)
    );

    // No reason: refused on the page, in the server's words.
    await pressInDialog(page, 'Ask for a refund', 'Ask for refund');
    await wait(200);
    check(
      'user: a request with no reason is refused before it is sent',
      /Say why you are asking for a refund\./.test((await dialogText(page, 'Ask for a refund')) ?? ''),
      await dialogText(page, 'Ask for a refund')
    );

    await typeInto(page, '#refund-reason', 'Bought twice by mistake.');
    await pressInDialog(page, 'Ask for a refund', 'Ask for refund');
    await until(page, () =>
      /Refund request FT-RF-/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const sentText = (await dialogText(page, 'Ask for a refund')) ?? '';
    const reference = (sentText.match(/FT-RF-\d{8}-\d{4}/) ?? [])[0];
    check('user: the request is sent, with its reference and amount', Boolean(reference) && /\$25\.000/.test(sentText), sentText);
    await page.screenshot({ path: `${SHOTS}/refunds-1-asked.png` });
    await pressInDialog(page, 'Ask for a refund', 'Done');
    await wait(300);

    // One open request per item: asking again shows the open one, no second form.
    await pressInRow(page, crypto.reference, 'Ask for refund');
    await until(page, () =>
      /is open for this/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const again = await page.evaluate(() => ({
      text: document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '',
      reasonBox: Boolean(document.querySelector('#refund-reason')),
    }));
    check(
      'user: asking again shows the open request rather than a second form',
      again.text.includes(`Refund request ${reference} is open for this - Requested.`) && !again.reasonBox,
      JSON.stringify(again)
    );
    await page.keyboard.press('Escape');
    await wait(300);
    check(
      'user: Escape closes the dialog',
      (await dialogText(page, 'Ask for a refund')) === null,
      'still open'
    );

    // The other two through the API, as the dialog sends them.
    const secondAsked = await asUser('/refund-requests', {
      method: 'POST',
      body: JSON.stringify({ itemType: 'payment', itemId: second.id, reason: 'Changed my mind.' }),
    });
    const secondBody = await secondAsked.json().catch(() => ({}));
    const cardAsked = await asUser('/refund-requests', {
      method: 'POST',
      body: JSON.stringify({ itemType: 'payment', itemId: card.id, reason: 'Not needed.' }),
    });
    const cardBody = await cardAsked.json().catch(() => ({}));
    check(
      'setup: two more requests',
      secondAsked.status === 201 && cardAsked.status === 201,
      `${secondAsked.status} ${cardAsked.status}`
    );
    const secondRef = secondBody.request?.reference ?? '';
    const cardRef = cardBody.request?.reference ?? '';

    // A run's charge in Credit History asks which resume - and once the queue
    // no longer holds the run, says to ask the administrator, with the link.
    await page.goto(`${APP}/credits?tab=history`, { waitUntil: 'networkidle2' });
    await until(page, () => document.body.innerText.includes('-$0.161'));
    check(
      'user /credits Credit History: a run charge offers Ask for refund',
      await pressInRow(page, '-$0.161', 'Ask for refund'),
      await rowText(page, '-$0.161')
    );
    await until(page, () =>
      /no longer listed/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const gone = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Ask for a refund"]');
      return {
        text: dialog?.innerText ?? '',
        contact: Boolean(
          dialog && Array.from(dialog.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin')
        ),
      };
    });
    check(
      "user: a run the queue no longer holds says to ask the administrator - with a Contact admin link",
      /Ask your administrator/.test(gone.text) && gone.contact,
      JSON.stringify(gone)
    );
    await page.keyboard.press('Escape');

    // One charge can pay for a whole order: from Credit History the dialog
    // lists its resumes, the one that can be asked about picked, the one that
    // did not build shown with why it cannot be.
    await page.goto(`${APP}/credits?tab=history`, { waitUntil: 'networkidle2' });
    await until(page, () => document.body.innerText.includes('-$0.046'));
    await pressInRow(page, '-$0.046', 'Ask for refund');
    await until(page, () =>
      /Which resume\?/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const picker = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Ask for a refund"]');
      const radios = Array.from(dialog?.querySelectorAll('input[type="radio"]') ?? []);
      return {
        text: dialog?.innerText ?? '',
        radios: radios.map((radio) => ({
          label: radio.closest('label')?.innerText ?? '',
          checked: radio.checked,
          disabled: radio.disabled,
        })),
        reasonBox: Boolean(dialog?.querySelector('#refund-reason')),
      };
    });
    const acme = picker.radios.find((radio) => /Acme/.test(radio.label));
    const globex = picker.radios.find((radio) => /Globex/.test(radio.label));
    check(
      "user Credit History: an order's charge lists its resumes - the delivered one picked, the failed one not pickable",
      picker.radios.length === 2 &&
        acme?.checked &&
        !acme.disabled &&
        globex?.disabled &&
        /not delivered/.test(globex.label) &&
        /You would get back/.test(picker.text) &&
        picker.reasonBox,
      JSON.stringify(picker)
    );
    await page.keyboard.press('Escape');
    await wait(300);

    // One resume of an order: its charge, and Ask for refund on the one that
    // was delivered; the one that did not build was refunded on its own, and
    // its error says to contact the administrator - with the link.
    await page.goto(`${APP}/orders/${order.id}`, { waitUntil: 'networkidle2' });
    await until(page, () => /Ask for refund/.test(document.body.innerText));
    const delivered = (await rowText(page, 'Acme')) ?? '';
    const failedItem = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find((node) => node.textContent.includes('Globex'));
      return {
        text: row?.innerText ?? '',
        ask: Boolean(row && Array.from(row.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Ask for refund')),
        contact: Boolean(row && Array.from(row.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin')),
        why: Boolean(row?.querySelector('[title^="This resume was not delivered"]')),
      };
    });
    check(
      "user /orders/[id]: a delivered resume shows its $0.023 charge and offers Ask for refund",
      /\$0\.023/.test(delivered) && /Ask for refund/.test(delivered),
      JSON.stringify(delivered)
    );
    check(
      'user /orders/[id]: one that did not build offers none, says it was refunded automatically, and its error offers Contact admin',
      !failedItem.ask && failedItem.why && /Refunded automatically/.test(failedItem.text) && failedItem.contact,
      JSON.stringify(failedItem)
    );
    await pressInRow(page, 'Acme', 'Ask for refund');
    await until(page, () =>
      /You would get back/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const resumeOffer = (await dialogText(page, 'Ask for a refund')) ?? '';
    check(
      'user: a resume would come back as credit - what it was charged',
      /\$0\.023 back on your balance as credit/.test(resumeOffer) && /Jane Doe \/ Acme/.test(resumeOffer),
      JSON.stringify(resumeOffer)
    );
    await typeInto(page, '#refund-reason', 'The layout came out broken.');
    await pressInDialog(page, 'Ask for a refund', 'Ask for refund');
    await until(page, () =>
      /Refund request FT-RF-/.test(document.querySelector('[role="dialog"][aria-label="Ask for a refund"]')?.innerText ?? '')
    );
    const resumeRef = (((await dialogText(page, 'Ask for a refund')) ?? '').match(/FT-RF-\d{8}-\d{4}/) ?? [])[0] ?? '';
    await pressInDialog(page, 'Ask for a refund', 'Done');
    await until(page, () => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find((node) => node.textContent.includes('Acme'));
      return Boolean(row && /Requested/.test(row.innerText) && !/Ask for refund/.test(row.innerText));
    });
    check(
      "user /orders/[id]: once asked, the resume's row shows the request, not a second button",
      Boolean(resumeRef) && /Requested/.test((await rowText(page, 'Acme')) ?? ''),
      JSON.stringify(await rowText(page, 'Acme'))
    );
    await page.screenshot({ path: `${SHOTS}/refunds-0-order.png` });

    await page.goto(`${APP}/credits?tab=refunds`, { waitUntil: 'networkidle2' });
    await until(page, (ref) => document.body.innerText.includes(ref), reference);
    const listed = await rowText(page, reference);
    check(
      'user /credits Refund Requests: the request is listed as Requested, with the reason',
      Boolean(listed) && /Requested/.test(listed) && /Bought twice by mistake\./.test(listed) && /\$25\.000/.test(listed),
      JSON.stringify(listed)
    );

    /* ------------------------------------------------ the administrator */
    // A context of its own: a sign-in is a cookie and a localStorage token,
    // and in one context the administrator's would replace the user's.
    const adminContext = await browser.createBrowserContext();
    const adminPage = await adminContext.newPage();
    await adminPage.setViewport(WIDE);
    await signIn(adminPage, adminToken);
    await adminPage.goto(`${APP}/admin/payments`, { waitUntil: 'networkidle2' });
    await wait(400);

    const adminBell = await readBell(adminPage);
    const newRequest = adminBell.notices.find((n) => n.text.includes(`New refund request ${reference}`));
    check(
      "admin: the bell says there is something new, and a new request's notice links to the queue",
      /new/.test(adminBell.label ?? '') &&
        Boolean(newRequest) &&
        newRequest.link === '/admin/payments?tab=refunds' &&
        newRequest.linkText === 'Open the refund queue' &&
        /\$25\.000/.test(newRequest.text) &&
        /Bought twice by mistake/.test(newRequest.text),
      JSON.stringify({ label: adminBell.label, newRequest })
    );
    await adminPage.evaluate(() => {
      const link = Array.from(document.querySelectorAll('[role="dialog"][aria-label="Notifications"] a')).find(
        (node) => node.textContent.trim() === 'Open the refund queue'
      );
      link?.click();
    });
    await until(adminPage, () => Boolean(document.querySelector('#refund-queue-heading')));
    await until(adminPage, (ref) => document.body.innerText.includes(ref), reference);
    const queue = await adminPage.evaluate(() => ({
      url: window.location.pathname + window.location.search,
      active: document
        .querySelector('[role="tablist"][aria-label="Payments"] [role="tab"][aria-selected="true"]')
        ?.textContent.trim(),
    }));
    check(
      "admin: the notice's link lands on the Refund requests tab, with the open count on it",
      queue.url === '/admin/payments?tab=refunds' && /^Refund requests\s*\d+/.test(queue.active ?? ''),
      JSON.stringify(queue)
    );
    // The buttons are the only controls on the page: in view at a desktop
    // width, not past the table box's edge behind a sideways scroll. Measured,
    // because pressing them by script works on a clipped button too.
    const reach = await adminPage.evaluate(() => {
      const box = document.querySelector('#refund-queue-heading')?.closest('section')?.querySelector('.tl-table-box');
      if (!box) return { found: false };
      const edge = box.getBoundingClientRect();
      const buttons = Array.from(box.querySelectorAll('tbody button')).map((button) => {
        const rect = button.getBoundingClientRect();
        return { text: button.textContent.trim(), left: Math.round(rect.left), right: Math.round(rect.right) };
      });
      return {
        found: true,
        box: { left: Math.round(edge.left), right: Math.round(edge.right) },
        scrolls: box.scrollWidth > box.clientWidth + 1,
        outside: buttons.filter((b) => b.left < edge.left - 1 || b.right > edge.right + 1),
        count: buttons.length,
      };
    });
    check(
      'admin 1440x900: every Approve, Decline and Mark refunded lies inside the queue box, with no sideways scroll',
      reach.found && reach.count >= 8 && reach.outside.length === 0 && !reach.scrolls,
      JSON.stringify(reach)
    );

    // Crypto: the confirmation says to send it back by hand FIRST, and will
    // not go on until the administrator says they have.
    check('admin: an open request offers Mark refunded', await pressInRow(adminPage, reference, 'Mark refunded'));
    const byHandTitle = `Mark ${reference} refunded?`;
    await until(adminPage, (name) => Boolean(document.querySelector(`[role="dialog"][aria-label="${name}"]`)), byHandTitle);
    const byHand = (await dialogText(adminPage, byHandTitle)) ?? '';
    check(
      'admin: a crypto refund says to send the money back by hand first, before anything moves',
      /Crypto cannot be refunded automatically\. Send \$25\.000 back from your Cryptomus merchant dashboard first/.test(byHand),
      JSON.stringify(byHand)
    );
    await pressInDialog(adminPage, byHandTitle, 'Mark refunded');
    await wait(200);
    check(
      'admin: ...and refuses to go on until they confirm they have',
      /Confirm that you have sent the money back first\./.test((await dialogText(adminPage, byHandTitle)) ?? '')
    );
    await adminPage.screenshot({ path: `${SHOTS}/refunds-2-by-hand.png` });
    await adminPage.evaluate((name) => {
      document.querySelector(`[role="dialog"][aria-label="${name}"] input[type="checkbox"]`)?.click();
    }, byHandTitle);
    await pressInDialog(adminPage, byHandTitle, 'Mark refunded');
    await until(adminPage, () => /marked refunded/.test(document.body.innerText));
    const refundedSaid = await adminPage.evaluate(() => document.body.innerText);
    check(
      'admin: marked refunded, and the page says what moved',
      refundedSaid.includes(`${reference} marked refunded: $25.000 recorded as sent back by hand`),
      refundedSaid.slice(0, 400)
    );

    // Decline: the reason is required, and is what the person reads.
    check('admin: Decline is offered', await pressInRow(adminPage, secondRef, 'Decline'));
    const declineTitle = `Decline ${secondRef}?`;
    await until(adminPage, (name) => Boolean(document.querySelector(`[role="dialog"][aria-label="${name}"]`)), declineTitle);
    await pressInDialog(adminPage, declineTitle, 'Decline');
    await wait(200);
    check(
      'admin: a decline with no reason is refused',
      /Write the reason for declining/.test((await dialogText(adminPage, declineTitle)) ?? '')
    );
    await typeInto(adminPage, '#decline-reason', 'Credit already used for resumes.');
    await pressInDialog(adminPage, declineTitle, 'Decline');
    await until(adminPage, (ref) => document.body.innerText.includes(`${ref} declined.`), secondRef);
    check(
      'admin: declined, and told the person has been told why',
      (await adminPage.evaluate(() => document.body.innerText)).includes(`${secondRef} declined.`)
    );

    // A resume: credit back, against the run that charged it.
    check('admin: the resume request offers Mark refunded', await pressInRow(adminPage, resumeRef, 'Mark refunded'));
    const creditTitle = `Credit $0.023 back to ${user.email}?`;
    await until(adminPage, (name) => Boolean(document.querySelector(`[role="dialog"][aria-label="${name}"]`)), creditTitle);
    check('admin: ...which says it is credit back, before it moves', (await dialogText(adminPage, creditTitle)) !== null);
    await pressInDialog(adminPage, creditTitle, 'Refund $0.023');
    await until(adminPage, (ref) => document.body.innerText.includes(`${ref} refunded: $0.023 credited back`), resumeRef);
    check(
      'admin: the resume is refunded as credit',
      (await adminPage.evaluate(() => document.body.innerText)).includes(
        `${resumeRef} refunded: $0.023 credited back to ${user.email}.`
      ),
      (await adminPage.evaluate(() => document.body.innerText)).slice(0, 300)
    );

    // Card, with no Stripe keys here: the refund fails at Stripe. The sentence
    // says to contact the administrator, so it carries the link - and that
    // opens a dialog over this one, which Escape closes alone.
    check('admin: the card request offers Mark refunded', await pressInRow(adminPage, cardRef, 'Mark refunded'));
    const cardTitle = `Refund $10.000 to ${user.email}'s card?`;
    await until(adminPage, (name) => Boolean(document.querySelector(`[role="dialog"][aria-label="${name}"]`)), cardTitle);
    check(
      'admin: a card refund says it is a partial Stripe refund of the unspent part',
      /partial Stripe refund/.test((await dialogText(adminPage, cardTitle)) ?? '')
    );
    const balanceBeforeCard = users.getUserById(user.id).balanceMilli;
    await pressInDialog(adminPage, cardTitle, 'Refund $10.000');
    await until(adminPage, (name) => {
      const dialog = document.querySelector(`[role="dialog"][aria-label="${name}"]`);
      return Boolean(dialog && Array.from(dialog.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin'));
    }, cardTitle);
    const failed = (await dialogText(adminPage, cardTitle)) ?? '';
    check(
      'admin: a refund Stripe did not make says so, with a ref, and offers Contact admin',
      /Ref:|ERR-/.test(failed) && /Contact admin/.test(failed),
      paymentRepository.getPayment(card.id)?.state === 'refunded'
        ? 'the card refund SUCCEEDED: this script needs a backend without fake-providers.js and without Stripe ' +
            'keys (test/e2e/README.md, step 5)'
        : JSON.stringify(failed)
    );
    await pressInDialog(adminPage, cardTitle, 'Contact admin');
    await until(adminPage, () => Boolean(document.querySelector('[role="dialog"][aria-label="Contact admin"]')));
    await until(adminPage, () => /help@example\.com/.test(document.querySelector('[role="dialog"][aria-label="Contact admin"]')?.innerText ?? ''));
    await adminPage.screenshot({ path: `${SHOTS}/refunds-3-dialog-over-dialog.png` });
    await adminPage.keyboard.press('Escape');
    await wait(300);
    const stacked = {
      contact: (await dialogText(adminPage, 'Contact admin')) !== null,
      refund: (await dialogText(adminPage, cardTitle)) !== null,
      locked: await adminPage.evaluate(() => document.body.style.overflow),
    };
    check(
      'admin: Escape closes only the Contact admin dialog on top; the refund dialog and the scroll lock stay',
      !stacked.contact && stacked.refund && stacked.locked === 'hidden',
      JSON.stringify(stacked)
    );
    await adminPage.keyboard.press('Escape');
    await wait(300);
    const closed = {
      refund: (await dialogText(adminPage, cardTitle)) !== null,
      overflow: await adminPage.evaluate(() => document.body.style.overflow),
    };
    check(
      'admin: a second Escape closes the refund dialog, and the page scrolls again',
      !closed.refund && closed.overflow !== 'hidden',
      JSON.stringify(closed)
    );
    // Stripe refused (it was never configured), so the credit the refund held
    // while it asked is back, and nothing is left outstanding on the row.
    await wait(300);
    const cardRow = (await rowText(adminPage, cardRef)) ?? '';
    const returned = credits
      .getLedger(user.id)
      .filter((entry) => entry.reason === 'purchase-refund-failed' && /Refund request/.test(entry.note));
    check(
      'admin: a refund Stripe refused leaves the request open, nothing outstanding, and the held credit back',
      /Requested/.test(cardRow) &&
        !/not confirmed/.test(cardRow) &&
        users.getUserById(user.id).balanceMilli === balanceBeforeCard &&
        returned.length === 1 &&
        returned[0].deltaMilli === 10_000,
      JSON.stringify({ cardRow, before: balanceBeforeCard, after: users.getUserById(user.id).balanceMilli, returned })
    );

    // The payments list's own Refund dialog is not the kit's, and its error
    // notice offers Contact admin too: one Escape closes only that, and the
    // note typed underneath survives.
    await adminPage.goto(`${APP}/admin/payments`, { waitUntil: 'networkidle2' });
    await until(adminPage, (ref) => document.body.innerText.includes(ref), card.reference);
    check('admin Payments: the card purchase offers Refund', await pressInRow(adminPage, card.reference, 'Refund'));
    const listDialog = '[role="dialog"][aria-labelledby="refund-dialog-title"]';
    await until(adminPage, (selector) => Boolean(document.querySelector(selector)), listDialog);
    await adminPage.type(`${listDialog} input[aria-label="Why this is being refunded"]`, 'Asked by email');
    await adminPage.evaluate((selector) => {
      Array.from(document.querySelectorAll(`${selector} button`))
        .find((b) => b.textContent.trim() === 'Refund it')
        ?.click();
    }, listDialog);
    const offered = await until(adminPage, (selector) => {
      const dialog = document.querySelector(selector);
      return Boolean(dialog && Array.from(dialog.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin'));
    }, listDialog);
    await adminPage.evaluate((selector) => {
      Array.from(document.querySelectorAll(`${selector} button`))
        .find((b) => b.textContent.trim() === 'Contact admin')
        ?.click();
    }, listDialog);
    await until(adminPage, () => Boolean(document.querySelector('[role="dialog"][aria-label="Contact admin"]')));
    await adminPage.keyboard.press('Escape');
    await wait(300);
    const listStacked = await adminPage.evaluate((selector) => ({
      contact: Boolean(document.querySelector('[role="dialog"][aria-label="Contact admin"]')),
      refund: Boolean(document.querySelector(selector)),
      note: document.querySelector(`${selector} input[aria-label="Why this is being refunded"]`)?.value ?? null,
      locked: document.body.style.overflow,
    }), listDialog);
    check(
      "admin Payments: Escape closes only Contact admin over the list's Refund dialog; the dialog and its note stay",
      offered && !listStacked.contact && listStacked.refund && listStacked.note === 'Asked by email' && listStacked.locked === 'hidden',
      JSON.stringify(listStacked)
    );
    await adminPage.keyboard.press('Escape');
    await wait(300);
    check(
      "admin Payments: a second Escape closes the Refund dialog, and the page scrolls again",
      (await adminPage.evaluate((selector) => !document.querySelector(selector) && document.body.style.overflow !== 'hidden', listDialog)),
      'still open, or still locked'
    );
    await adminPage.goto(`${APP}/admin/payments?tab=refunds`, { waitUntil: 'networkidle2' });
    await until(adminPage, (ref) => document.body.innerText.includes(ref), cardRef);

    // The filter lives in the address.
    await adminPage.select('select.tl-input', 'refunded');
    await until(adminPage, () => window.location.search.includes('state=refunded'));
    await until(adminPage, (ref) => document.body.innerText.includes(ref), reference);
    const refundedRow = (await rowText(adminPage, reference)) ?? '';
    check(
      'admin: the Refunded filter lists it, with what went back',
      /Refunded/.test(refundedRow) && /\$25\.000 returned/.test(refundedRow) && !(await rowText(adminPage, secondRef)),
      JSON.stringify(refundedRow)
    );

    /* ------------------------------------------------ the person, after */
    // A tab in the background is throttled - timers, frames, screenshots - so
    // each switch brings the page being driven to the front, as a person would.
    await page.bringToFront();
    await page.goto(`${APP}/credits?tab=refunds`, { waitUntil: 'networkidle2' });
    await until(page, (ref) => document.body.innerText.includes(ref), secondRef);
    const afterRefund = (await rowText(page, reference)) ?? '';
    const afterDecline = (await rowText(page, secondRef)) ?? '';
    check(
      'user: Refunded, with what came back and how',
      /Refunded/.test(afterRefund) && /\$25\.000 sent back to you by your administrator\./.test(afterRefund),
      JSON.stringify(afterRefund)
    );
    check(
      "user: Declined, with the administrator's reason",
      /Declined/.test(afterDecline) && /Declined: Credit already used for resumes\./.test(afterDecline),
      JSON.stringify(afterDecline)
    );
    await page.screenshot({ path: `${SHOTS}/refunds-4-outcomes.png` });

    await page.goto(`${APP}/orders/${order.id}`, { waitUntil: 'networkidle2' });
    await until(page, () => {
      const row = Array.from(document.querySelectorAll('tbody tr')).find((node) => node.textContent.includes('Acme'));
      return Boolean(row && /Refunded/.test(row.innerText));
    });
    check("user /orders/[id]: the resume's row says Refunded", /Refunded/.test((await rowText(page, 'Acme')) ?? ''));
    await page.goto(`${APP}/credits?tab=history`, { waitUntil: 'networkidle2' });
    await until(page, () => /your refund request was granted/.test(document.body.innerText));
    const granted = (await rowText(page, 'your refund request was granted')) ?? '';
    check(
      'user Credit History: the $0.023 came back as its own row',
      /\+\$0\.023/.test(granted) && granted.includes(resumeRef),
      JSON.stringify(granted)
    );

    const userBell = await readBell(page);
    const made = userBell.notices.find((n) => /Refund made/.test(n.text) && n.text.includes(crypto.reference));
    const declined = userBell.notices.find((n) => /Refund request declined/.test(n.text));
    check(
      'user: the bell has both outcomes, marked For you, linking to the Refund Requests tab',
      Boolean(made && declined) &&
        made.forYou &&
        declined.forYou &&
        made.link === '/credits?tab=refunds' &&
        made.linkText === 'See your refund requests' &&
        /Credit already used for resumes\./.test(declined.text),
      JSON.stringify({ made, declined })
    );

    // Nobody else's bell.
    const otherFeed = await (await apiAs(bystanderToken)('/notifications')).json().catch(() => null);
    check(
      "a bystander's feed has none of it",
      Array.isArray(otherFeed?.notifications) &&
        !otherFeed.notifications.some((n) => /refund/i.test(`${n.title} ${n.body}`)),
      JSON.stringify(otherFeed?.notifications?.map((n) => n.title))
    );

    /* ------------------------------------------------ Contact admin */
    await page.keyboard.press('Escape');
    await page.click(`button[title="Account: ${user.name}"]`);
    await until(page, () =>
      Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Contact admin')
    );
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Contact admin')?.click();
    });
    await until(page, () => /help@example\.com/.test(document.querySelector('[role="dialog"][aria-label="Contact admin"]')?.innerText ?? ''));
    const contact = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Contact admin"]');
      return {
        links: Array.from(dialog?.querySelectorAll('a') ?? []).map((a) => a.getAttribute('href')),
        text: dialog?.innerText ?? '',
        copy: Array.from(dialog?.querySelectorAll('button') ?? []).filter((b) => b.textContent.trim() === 'Copy').length,
      };
    });
    check(
      'user: the account menu opens Contact admin - the address as a mailto link, the Discord name to copy',
      contact.links.join() === 'mailto:help@example.com' &&
        /Support/.test(contact.text) &&
        /tailor\.help/.test(contact.text) &&
        contact.copy === 1,
      JSON.stringify(contact)
    );
    await page.keyboard.press('Escape');

    // The editor: a value the server refuses is shown on its own row.
    await adminPage.bringToFront();
    await adminPage.goto(`${APP}/admin/settings`, { waitUntil: 'networkidle2' });
    await until(adminPage, () =>
      Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === 'Add a channel')
    );
    await adminPage.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Add a channel')?.click();
    });
    await wait(200);
    const rows = await adminPage.$$('ol[aria-label="Contact channels"] > li');
    check('admin /admin/settings: the editor lists the two channels and the new one', rows.length === 3, `found ${rows.length}`);
    const last = rows[rows.length - 1];
    await adminPage.select('ol[aria-label="Contact channels"] > li:last-child select', 'telegram');
    const valueBox = await last.$('input[aria-describedby]');
    await valueBox.type('x');
    await adminPage.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Save contact details')?.click();
    });
    await until(adminPage, () =>
      Boolean(document.querySelector('ol[aria-label="Contact channels"] > li:last-child .tl-status[data-tone="error"]'))
    );
    const refusal = await adminPage.evaluate(() => ({
      onRow: document.querySelector('ol[aria-label="Contact channels"] > li:last-child .tl-status[data-tone="error"]')
        ?.textContent,
      elsewhere: Array.from(document.querySelectorAll('ol[aria-label="Contact channels"] > li:not(:last-child) .tl-status')).length,
    }));
    check(
      "admin: a Telegram name the server refuses is shown under that row's value, and nowhere else",
      Boolean(refusal.onRow) && refusal.elsewhere === 0,
      JSON.stringify(refusal)
    );
    await adminPage.screenshot({ path: `${SHOTS}/refunds-5-contact-editor.png` });
    const stillSaved = await (await fetch(`${API}/contact`)).json();
    check(
      'admin: ...and nothing was saved - a refused save is refused whole',
      stillSaved.channels?.length === 2,
      JSON.stringify(stillSaved)
    );

    /* ------------------------------------------------ on a phone */
    const phoneContext = await browser.createBrowserContext();
    const phone = await phoneContext.newPage();
    await phone.setViewport(PHONE);
    await signIn(phone, userToken);
    await phone.goto(`${APP}/credits?tab=refunds`, { waitUntil: 'networkidle2' });
    await until(phone, (ref) => document.body.innerText.includes(ref), reference);
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    check('phone /credits?tab=refunds: no horizontal scrollbar', !overflow);
    await phone.screenshot({ path: `${SHOTS}/refunds-6-phone.png` });
  } finally {
    await browser.close();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

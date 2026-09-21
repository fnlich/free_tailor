/*
 * The same purchase, done the way a person does it: in a browser.
 *
 * The API walkthrough proves the server is right. This proves the pages are
 * wired to it - that the buy page prices what the server would charge, that
 * the button reaches a checkout, that the return page waits for the webhook
 * rather than congratulating on arrival, and that the balance a person sees
 * afterwards is the one the ledger holds.
 *
 * The session is seeded and injected, because there is no offline sign-in.
 * Everything after that is clicks.
 */

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('path');
const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const APP = 'http://127.0.0.1:3000';
const SHOTS = process.env.E2E_SHOTS || __dirname;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  const stamp = Date.now().toString(36);
  const buyer = users.createUser({ email: `e2e-web-${stamp}@example.com` });
  const token = users.createSession(buyer.id);
  const admin = users.findOrCreateUser({ email: 'boss@example.com' }).account;
  const adminToken = users.createSession(admin.id);

  const browser = await chromium.launch();

  const open = async (sessionToken) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([
      { name: 'ft_session', value: sessionToken, domain: '127.0.0.1', path: '/', httpOnly: true },
    ]);
    await context.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ['adminToken', sessionToken]
    );
    return context;
  };

  const context = await open(token);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));

  console.log('\n=== The buy page ===');
  await page.goto(`${APP}/credits`, { waitUntil: 'networkidle' });
  const heading = await page.locator('h1').first().innerText();
  check('the buy page loads', heading.includes('Buy credits'), heading);

  const balanceShown = await page.locator('text=Your balance').locator('..').innerText();
  check('it shows a balance of zero to start', /\b0\b/.test(balanceShown), balanceShown.replace(/\n/g, ' | '));

  const cardButton = page.getByRole('button', { name: /pay by credit or debit card/i });
  const cryptoButton = page.getByRole('button', { name: /pay by crypto/i });
  check('both configured methods have a button', (await cardButton.count()) === 1 && (await cryptoButton.count()) === 1);

  await page.fill('#credits', '40');
  await page.waitForTimeout(150);
  const totalText = await page.locator('text=Total').locator('..').innerText();
  check('the total is priced from the server price', /\$20\.00/.test(totalText), totalText.replace(/\n/g, ' | '));

  const priceLine = await page.locator('text=/per credit/').innerText();
  check('the price and bounds are stated', /\$0\.50 per credit/.test(priceLine) && /10 and 5000/.test(priceLine), priceLine);

  await page.screenshot({ path: `${SHOTS}/1-buy-page.png` });

  console.log('\n=== The form stays on our page ===');
  /*
   * The point of the change, and the limit of what a fake can prove.
   *
   * The real Payment Element is an iframe served by Stripe and will not mount
   * against a made-up publishable key, so this cannot type a card number
   * offline - a live test-mode key is needed for that, and the README says so.
   * What it CAN prove is the property the embedding was for: pressing Pay
   * takes the customer nowhere. The URL does not change, the amount field is
   * replaced by the payment panel in place, and the order is restated there.
   */
  await cardButton.click();
  /*
   * Either outcome is a pass; an endless spinner is not.
   *
   * With a real publishable key the form mounts. In a sandbox that cannot
   * reach js.stripe.com it must SAY so rather than spin, which is the failure
   * this waits on both halves of.
   */
  const mounted = page.locator('text=/go straight to them/');
  const refused = page.locator('text=/The payment form could not be loaded/');
  // Polled rather than raced: a locator that matches more than one node throws
  // a strict-mode violation the instant it is awaited, and a race over two
  // caught rejections would then resolve immediately and prove nothing.
  let formShowed = false;
  let saidSo = false;
  for (let waited = 0; waited < 30000 && !formShowed && !saidSo; waited += 500) {
    formShowed = (await mounted.count()) > 0;
    saidSo = (await refused.count()) > 0;
    if (!formShowed && !saidSo) await page.waitForTimeout(500);
  }
  check(
    'the form either mounts or says plainly that it could not',
    formShowed || saidSo,
    formShowed ? 'mounted' : 'reported it could not load (no network to js.stripe.com here)'
  );
  check('pressing Pay does not navigate away', page.url().startsWith(`${APP}/credits`), page.url());
  check('and no checkout page opened anywhere', !page.url().includes('4242'), page.url());

  const panel = await page.locator('main').innerText();
  check('the panel restates what is being bought', /40 credits/.test(panel) && /\$20\.00/.test(panel), panel.replace(/\n/g, ' | ').slice(0, 200));
  check(
    'and offers a way back out',
    (await page.getByRole('button', { name: /^Cancel$/ }).count()) +
      (await page.getByRole('button', { name: /^Start again$/ }).count()) >=
      1
  );
  await page.screenshot({ path: `${SHOTS}/2-embedded-form.png` });

  console.log('\n=== Paying, and the return page ===');
  // Driven from the provider's side, which is what a real card confirmation
  // ends up doing: a signed webhook, server to server.
  const mine = await (await fetch('http://127.0.0.1:3001/api/payments', {
    headers: { authorization: `Bearer ${token}` },
  })).json();
  const started = mine.payments.find((p) => p.state === 'pending');
  check('the checkout recorded a pending payment', Boolean(started), started?.reference);
  await fetch(`http://127.0.0.1:4242/pay/${started.providerRef}`, { method: 'POST', redirect: 'manual' });

  await page.goto(`${APP}/credits/return?payment=${started.id}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Paid. Your credits are on your balance.', { timeout: 20000 });
  check('the return page reports the payment once the webhook has landed', true);
  const returnCopy = await page.locator('main').innerText();
  check('and shows the reference and what was bought', /FT-PAY-/.test(returnCopy) && /40 credits for \$20\.00/.test(returnCopy), returnCopy.replace(/\n/g, ' | ').slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/3-return-paid.png` });

  console.log('\n=== Back on the buy page ===');
  await page.goto(`${APP}/credits`, { waitUntil: 'networkidle' });
  const balanceAfter = await page.locator('text=Your balance').locator('..').innerText();
  check('the balance has the credits on it', /\b40\b/.test(balanceAfter), balanceAfter.replace(/\n/g, ' | '));
  const paymentsList = await page.locator('text=Your payments').locator('..').innerText();
  check('the payment is listed as paid', /FT-PAY-/.test(paymentsList) && /Paid/.test(paymentsList), paymentsList.replace(/\n/g, ' | ').slice(0, 160));
  const history = await page.locator('text=Credit history').locator('..').innerText();
  check('and the credit history says it was bought', /Bought/.test(history), history.replace(/\n/g, ' | ').slice(0, 160));
  await page.screenshot({ path: `${SHOTS}/4-after-paying.png` });

  console.log('\n=== Backing out of a payment ===');
  await page.fill('#credits', '10');
  await page.getByRole('button', { name: /pay by credit or debit card/i }).click();
  await page.getByRole('button', { name: /^Cancel$|^Start again$/ }).first().waitFor({ timeout: 25000 });
  await page.getByRole('button', { name: /^Cancel$|^Start again$/ }).first().click();
  await page.waitForSelector('#credits', { timeout: 10000 });
  /*
   * Asserting the URL alone proved nothing - it was already `/credits` before
   * the click and could not have changed, since the dialog never navigates.
   * What cancelling has to do is put the CHOOSER back and take the dialog away.
   */
  const backOnTheForm = await page.locator('main').innerText();
  check(
    'cancelling puts the amount field back and closes the dialog',
    (await page.locator('#credits').count()) === 1 &&
      (await page.getByRole('dialog').count()) === 0 &&
      /per credit/.test(backOnTheForm),
    page.url()
  );
  check(
    'and the amount that was typed is still there',
    (await page.locator('#credits').inputValue()) === '10'
  );
  await page.screenshot({ path: `${SHOTS}/5-cancelled.png` });

  console.log('\n=== The administrator ===');
  const adminContext = await open(adminToken);
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', (error) => problems.push(String(error)));
  await adminPage.goto(`${APP}/admin/payments`, { waitUntil: 'networkidle' });
  await adminPage.waitForSelector('h1:has-text("Payments")', { timeout: 15000 });
  const adminCopy = await adminPage.locator('body').innerText();
  check('the admin page lists the buyer\'s payment', adminCopy.includes(buyer.email), buyer.email);
  check('with the pricing controls beside it', /Price per credit/.test(adminCopy));
  await adminPage.screenshot({ path: `${SHOTS}/6-admin-payments.png`, fullPage: true });

  const refundButton = adminPage.getByRole('button', { name: /^Refund$/ }).first();
  await refundButton.click();
  await adminPage.fill('input[placeholder="Why this is being refunded"]', 'end-to-end test');
  await adminPage.getByRole('button', { name: /refund it/i }).click();
  await adminPage.waitForSelector('text=/refunded, and all 40 credits reversed/', { timeout: 20000 });
  check('a refund from the UI reports what it reversed', true);
  await adminPage.screenshot({ path: `${SHOTS}/7-refunded.png`, fullPage: true });

  await page.goto(`${APP}/credits`, { waitUntil: 'networkidle' });
  const finalBalance = await page.locator('text=Your balance').locator('..').innerText();
  check('and the buyer\'s balance comes back down', /\b0\b/.test(finalBalance), finalBalance.replace(/\n/g, ' | '));

  // js.stripe.com is unreachable from this sandbox, and the page reporting that
  // is the correct behaviour rather than a defect - so those are not counted.
  const unexpected = problems.filter(
    (p) => !/stripe\.com|Failed to load Stripe|ERR_CERT_AUTHORITY_INVALID/i.test(p)
  );
  check('no page threw an unexpected error along the way', unexpected.length === 0, unexpected.join(' | ').slice(0, 300));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nEvery browser check passed');
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error('\nThe browser run itself broke:', error);
  process.exit(2);
});

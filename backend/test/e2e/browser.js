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

  console.log('\n=== Checkout ===');
  await Promise.all([page.waitForURL(/4242\/checkout\//, { timeout: 15000 }), cardButton.click()]);
  check('the card button lands on the provider checkout', page.url().includes(':4242/checkout/'), page.url());
  const reference = await page.locator('#reference').innerText();
  check('the provider page quotes the order', /FT-PAY-/.test(reference), reference);
  const providerCopy = await page.locator('.card').innerText();
  check('for the amount the server quoted', /40 credits/.test(providerCopy) && /20\.00 USD/.test(providerCopy), providerCopy.replace(/\n/g, ' | '));
  await page.screenshot({ path: `${SHOTS}/2-provider-checkout.png` });

  console.log('\n=== Paying, and the return page ===');
  await Promise.all([page.waitForURL(/\/credits\/return/, { timeout: 15000 }), page.click('#pay')]);
  check('paying sends the browser back to the return page', page.url().includes('/credits/return?payment=pay_'), page.url());

  // The webhook is already in flight; the page polls until the server says paid.
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

  console.log('\n=== Cancelling a checkout ===');
  await page.fill('#credits', '10');
  await Promise.all([page.waitForURL(/4242\/checkout\//, { timeout: 15000 }), page.getByRole('button', { name: /pay by crypto/i }).click()]);
  await Promise.all([page.waitForURL(/\/credits\?cancelled=/, { timeout: 15000 }), page.click('#cancel')]);
  await page.waitForSelector('text=That payment was cancelled. Nothing was charged.', { timeout: 10000 });
  check('cancelling comes back with an honest notice', true, page.url());
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

  check('no page threw an error along the way', problems.length === 0, problems.join(' | ').slice(0, 300));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nEvery browser check passed');
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error('\nThe browser run itself broke:', error);
  process.exit(2);
});

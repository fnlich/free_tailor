/*
 * The administrator's "needs attention" queue, end to end in a browser.
 *
 * The settler refuses to guess which of two equally-close orders an odd
 * amount was meant for. That refusal is only honest if somebody is told, so
 * this walks the whole way: two orders open a dollar apart, a transfer lands
 * between them, and an administrator sees it on the page they already use and
 * can clear it once they have dealt with it.
 *
 * THIS WALKS THE RETIRED ON-CHAIN PATH, and it is the only script that does.
 * A server taking crypto through Cryptomus cannot open a chain invoice at all,
 * so there is nothing here to walk: unset CRYPTOMUS_MERCHANT_ID and
 * CRYPTOMUS_PAYMENT_API_KEY and restart the server to run it. It stops with a
 * message rather than failing, because "this installation is configured the
 * other way" is not a defect, and a wall of red would train somebody to ignore
 * it. It goes when the machinery it tests goes.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:4242';
const SHOTS = process.env.E2E_SHOTS || __dirname;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function call(token, p, init = {}) {
  const r = await fetch(`${API}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Finish and report without ever having opened a browser. */
async function browserless() {
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const stamp = Date.now().toString(36);
  /*
   * Ask the server which way it takes crypto, before creating anything.
   *
   * Signed in, because `/payments/methods` is not public - and as an account
   * of its own rather than the admin below, so a skipped run leaves no trace.
   */
  const probeToken = users.createSession(
    users.createUser({ email: `held-probe-${stamp}@example.com` }).id
  );
  const offered = await call(probeToken, '/payments/methods');
  if (offered.status !== 200) {
    console.log(`The API answered ${offered.status}. Start the server first.`);
    process.exit(1);
  }
  const provider = (offered.body?.methods ?? []).find((entry) => entry.method === 'crypto')?.provider;
  if (provider !== 'chain') {
    console.log(
      `\nSkipped: this server takes crypto through ${provider ?? 'nothing'}, not the on-chain ` +
        'watcher this script walks.\nUnset CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY, ' +
        'restart the server, and run it again.'
    );
    process.exit(0);
  }

  const one = users.createUser({ email: `held-a-${stamp}@example.com` });
  const two = users.createUser({ email: `held-b-${stamp}@example.com` });
  const admin = users.findOrCreateUser({ email: 'boss@example.com' }).account;
  const oneToken = users.createSession(one.id);
  const twoToken = users.createSession(two.id);
  const adminToken = users.createSession(admin.id);

  // A fresh pair of amounts every run, so an earlier run's reservations do
  // not collide with this one's.
  const base = 200 + (Math.floor(Date.now() / 1000) % 600);
  const a = await call(oneToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'crypto', credits: base, asset: 'ethereum:USDT' }),
  });
  const b = await call(twoToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'crypto', credits: base + 2, asset: 'ethereum:USDT' }),
  });
  check(
    'two orders open',
    a.status === 201 && b.status === 201,
    `${a.status}/${b.status} ${JSON.stringify(a.body?.error ?? b.body?.error ?? '')}`
  );

  /*
   * Reported, not crashed.
   *
   * A checkout can legitimately be refused here - two runs inside the same
   * twenty-minute window can ask for an amount the first is still holding,
   * which is the reservation rule working. Reaching straight into the invoice
   * turned that into a TypeError that killed the script and took every check
   * below it with it, so the one interesting failure looked like a broken
   * harness.
   */
  if (!a.body?.invoice || !b.body?.invoice) {
    check('the two amounts differ', false, 'no invoices to compare');
    await browserless();
    return;
  }

  // Exactly between them, so both are inside the band and neither can be
  // credited without possibly robbing the other.
  const lo = BigInt(a.body.invoice.amountAtomic);
  const hi = BigInt(b.body.invoice.amountAtomic);
  const between = (lo + hi) / 2n;
  check('the two amounts differ', lo !== hi, `${lo} vs ${hi}`);

  await fetch(
    `${FAKE}/chain/send?asset=ethereum%3AUSDT&to=${encodeURIComponent(a.body.invoice.address)}` +
      `&amount=${between}&depth=1&advance=30`,
    { method: 'POST' }
  );
  await fetch(`${FAKE}/chain/sweep?chain=ethereum`, { method: 'POST' });
  await wait(400);

  const queue = await call(adminToken, '/admin/payments/held');
  const mine = (queue.body?.held ?? []).filter((entry) => entry.resolvable);
  check('the unclaimed transfer is in the queue', mine.length >= 1, JSON.stringify(queue.body?.held ?? []).slice(0, 400));

  // Neither buyer was touched.
  const stillOpen = await Promise.all([
    call(oneToken, `/payments/${a.body.paymentId}`),
    call(twoToken, `/payments/${b.body.paymentId}`),
  ]);
  check(
    'both orders are left open and unpaid',
    stillOpen.every((r) => r.body?.payment?.state === 'pending' && r.body?.invoice?.state === 'waiting'),
    stillOpen.map((r) => `${r.body?.payment?.state}/${r.body?.invoice?.state}`).join(' ')
  );

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((v) => window.localStorage.setItem('adminToken', v), adminToken);
  await page.setCookie({
    name: 'ft_session', value: adminToken, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  });
  await page.goto(`${APP}/admin/payments`, { waitUntil: 'networkidle0' });
  await wait(600);

  const banner = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h2')).some((n) => /need(s)? attention/i.test(n.textContent))
  );
  check('the page warns that something needs attention', banner);

  const countButtons = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).filter((n) =>
        /mark as dealt with/i.test(n.textContent)
      ).length
    );
  const before = await countButtons();
  check('and offers to clear it', before > 0, `${before} button(s)`);

  await page.screenshot({ path: path.join(SHOTS, 'held-queue.png') });

  /*
   * Dark, because this card is built from the light utilities the unlayered
   * `html.dark` shim remaps rather than from `dark:` variants - so the only
   * way to know it works is to look.
   */
  await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle0' });
  await wait(600);
  const darkCard = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll('h2')).find((n) =>
      /need(s)? attention/i.test(n.textContent)
    );
    if (!heading) return null;
    const card = heading.closest('div');
    return {
      card: getComputedStyle(card).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  check(
    'the attention card is not a white box in dark mode',
    Boolean(darkCard) && darkCard.card !== 'rgb(255, 255, 255)' && darkCard.card !== darkCard.body,
    JSON.stringify(darkCard)
  );
  await page.screenshot({ path: path.join(SHOTS, 'held-queue-dark.png') });
  await page.evaluate(() => window.localStorage.setItem('tailor-theme', 'light'));
  await page.reload({ waitUntil: 'networkidle0' });
  await wait(600);

  if (before > 0) {
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button'))
        .find((n) => /mark as dealt with/i.test(n.textContent))
        .click();
    });
    await wait(900);
    const left = await countButtons();
    check('clearing it takes it off the list', left === before - 1, `${left} left, was ${before}`);
    const after = await call(adminToken, '/admin/payments/held');
    check(
      'and it is gone from the server too',
      (after.body?.held ?? []).length === (queue.body?.held ?? []).length - 1,
      `${(after.body?.held ?? []).length} vs ${(queue.body?.held ?? []).length}`
    );
  }

  await browser.close();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

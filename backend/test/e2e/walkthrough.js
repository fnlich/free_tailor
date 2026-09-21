/*
 * An end-to-end walk through buying credits, against the running server.
 *
 * Nothing here is a unit test: it talks to http://127.0.0.1:3001 over the
 * network, through the real routers, the real auth middleware, the real
 * database and the real webhook mount. The only thing that is not real is the
 * company at the other end - fake-providers.js replaced the four functions
 * that reach Stripe and Coinbase, and serves a checkout page of its own that
 * signs a webhook exactly as they would.
 *
 * Sign-in is seeded rather than driven: there is no offline path to a login
 * code (mailer.ts refuses to pretend an email was sent), so a session row is
 * written directly and its token used as a Bearer token - which is what the
 * browser would be carrying anyway.
 */

const path = require('path');
const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const API = 'http://127.0.0.1:3001/api';
const FAKE = 'http://127.0.0.1:4242';

let failures = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

async function call(token, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
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

const stamp = Date.now().toString(36);

async function main() {
  console.log('\n=== Accounts ===');
  const buyer = users.createUser({ email: `e2e-buyer-${stamp}@example.com` });
  const admin = users.findOrCreateUser({ email: 'boss@example.com' }).account;
  const buyerToken = users.createSession(buyer.id);
  const adminToken = users.createSession(admin.id);
  check('a buyer account is an ordinary user', buyer.role !== 'admin', `role=${buyer.role}`);
  check('the ADMIN_EMAILS account is an administrator', admin.role === 'admin', `role=${admin.role}`);

  const me = await call(buyerToken, '/auth/me');
  check('the seeded session is a real session', me.body?.account?.id === buyer.id, `status=${me.status}`);

  console.log('\n=== 1. What can be bought ===');
  const methods = await call(buyerToken, '/payments/methods');
  const card = methods.body?.methods?.find((m) => m.method === 'card');
  const crypto = methods.body?.methods?.find((m) => m.method === 'crypto');
  check('both methods are offered', Boolean(card?.available && crypto?.available), JSON.stringify(methods.body?.methods));
  check(
    'the buy page is given a publishable key to mount the form with',
    methods.body?.publishableKey === process.env.STRIPE_PUBLISHABLE_KEY,
    `${methods.body?.publishableKey}`
  );
  check(
    'the price and bounds come from settings',
    methods.body?.unitPriceCents === 50 && methods.body?.minCredits === 10 && methods.body?.maxCredits === 5000,
    `${methods.body?.unitPriceCents}c, ${methods.body?.minCredits}-${methods.body?.maxCredits} ${methods.body?.currency}`
  );

  console.log('\n=== 2. A price cannot be sent ===');
  const tampered = await call(buyerToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'card', credits: 20, amountCents: 1, unitPriceCents: 1, price: 0 }),
  });
  check(
    'a request carrying its own price is priced by the server anyway',
    tampered.status === 201 && tampered.body.amountCents === 1000,
    `status=${tampered.status} amountCents=${tampered.body?.amountCents}`
  );

  const rubbish = await call(buyerToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'card', credits: '20abc' }),
  });
  check('a credit count that is not a count is refused', rubbish.status === 400, `status=${rubbish.status}: ${rubbish.body?.error}`);

  console.log('\n=== 3. Card: checkout, pay, credit ===');
  const startBalance = (await call(buyerToken, '/credits')).body?.balance ?? 0;
  const checkout = await call(buyerToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'card', credits: 40 }),
  });
  check(
    'a checkout returns a client secret for a form on our own page',
    checkout.status === 201 &&
      typeof checkout.body?.clientSecret === 'string' &&
      !checkout.body?.redirectUrl,
    `${checkout.body?.reference} -> ${checkout.body?.clientSecret}`
  );

  const before = await call(buyerToken, `/payments/${checkout.body.paymentId}`);
  check('it starts pending, and credits nothing yet', before.body?.payment?.state === 'pending');
  const balanceBeforePaying = (await call(buyerToken, '/credits')).body?.balance ?? 0;
  check('opening a checkout adds no credits', balanceBeforePaying === startBalance, `${balanceBeforePaying}`);

  const sessionId = checkout.body.clientSecret.replace(/_secret$/, '');

  /*
   * The free-credits test, done properly.
   *
   * Arriving at the return page must not be what credits an account, so this
   * actually FETCHES the return page and everything it polls, before paying.
   * The previous version only re-read the payment and claimed to have visited
   * the page, which proved nothing the line above it had not already proved.
   */
  const returnUrl = `${(process.env.PAYMENTS_RETURN_URL || 'http://localhost:3000').replace(/\/+$/, '')}` +
    `/credits/return?payment=${encodeURIComponent(checkout.body.paymentId)}`;
  const visited = await fetch(returnUrl).catch(() => null);
  const polled = await call(buyerToken, `/payments/${checkout.body.paymentId}`);
  check(
    'visiting the return page before paying credits nothing',
    polled.body?.payment?.state === 'pending' &&
      (await call(buyerToken, '/credits')).body.balance === startBalance,
    `fetched ${returnUrl} -> ${visited ? visited.status : 'unreachable (frontend not running)'}`
  );

  // Now press Pay on the provider's page, which signs a webhook and sends it.
  const paid = await fetch(`${FAKE}/pay/${sessionId}`, { method: 'POST', redirect: 'manual' });
  check('the provider page redirects back after paying', paid.status === 303, `-> ${paid.headers.get('location')}`);

  const after = await call(buyerToken, `/payments/${checkout.body.paymentId}`);
  check('the payment is now paid', after.body?.payment?.state === 'paid', `state=${after.body?.payment?.state}`);
  const balanceAfter = (await call(buyerToken, '/credits')).body?.balance ?? 0;
  check('the credits are on the balance', balanceAfter === startBalance + 40, `${startBalance} -> ${balanceAfter}`);

  const ledger = await call(buyerToken, '/credits/ledger?limit=5');
  const purchase = ledger.body?.entries?.find((e) => e.reason === 'purchase');
  check('the ledger records the purchase', purchase?.delta === 40, JSON.stringify(purchase ?? null));

  console.log('\n=== 4. The same webhook again ===');
  const replay = await fetch(`${FAKE}/pay/${sessionId}`, { method: 'POST', redirect: 'manual' });
  const balanceAfterReplay = (await call(buyerToken, '/credits')).body?.balance ?? 0;
  check(
    'a replayed delivery credits nothing further',
    balanceAfterReplay === balanceAfter,
    `redirect=${replay.status} balance=${balanceAfterReplay}`
  );

  console.log('\n=== 5. Crypto ===');
  const cryptoCheckout = await call(buyerToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'crypto', credits: 15 }),
  });
  check('a crypto checkout is created', cryptoCheckout.status === 201, `${cryptoCheckout.body?.reference}`);
  const chargeCode = cryptoCheckout.body.redirectUrl.split('/').pop();
  await fetch(`${FAKE}/pay/${chargeCode}`, { method: 'POST', redirect: 'manual' });
  const cryptoPaid = await call(buyerToken, `/payments/${cryptoCheckout.body.paymentId}`);
  const balanceWithCrypto = (await call(buyerToken, '/credits')).body?.balance ?? 0;
  check('a confirmed charge credits too', cryptoPaid.body?.payment?.state === 'paid' && balanceWithCrypto === balanceAfter + 15, `${balanceWithCrypto}`);

  console.log('\n=== 6. Cancelling ===');
  const abandoned = await call(buyerToken, '/payments/checkout', {
    method: 'POST',
    body: JSON.stringify({ method: 'card', credits: 10 }),
  });
  const abandonedId = abandoned.body.clientSecret.replace(/_secret$/, '');
  await fetch(`${FAKE}/cancel/${abandonedId}`, { method: 'POST', redirect: 'manual' });
  const expired = await call(buyerToken, `/payments/${abandoned.body.paymentId}`);
  check('an expired checkout closes without crediting', expired.body?.payment?.state === 'expired', `state=${expired.body?.payment?.state}`);
  check(
    'and the balance did not move',
    (await call(buyerToken, '/credits')).body.balance === balanceWithCrypto
  );

  console.log('\n=== 7. Somebody else\'s payment ===');
  const stranger = users.createUser({ email: `e2e-stranger-${stamp}@example.com` });
  const strangerToken = users.createSession(stranger.id);
  const peek = await call(strangerToken, `/payments/${checkout.body.paymentId}`);
  check('another account gets 404, not 403', peek.status === 404, `status=${peek.status}`);
  const anonymous = await call('', `/payments/${checkout.body.paymentId}`);
  check('signed out is refused', anonymous.status === 401 || anonymous.status === 403, `status=${anonymous.status}`);

  console.log('\n=== 8. The webhook is the only door ===');
  const forged = await fetch(`${API}/payments/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({
      id: 'evt_forged',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_whatever', payment_status: 'paid', metadata: { paymentId: checkout.body.paymentId } } },
    }),
  });
  check('an unsigned event is refused', forged.status === 400, `status=${forged.status}`);
  const unsigned = await fetch(`${API}/payments/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('a webhook with no signature at all is refused', unsigned.status === 400, `status=${unsigned.status}`);

  console.log('\n=== 9. The administrator ===');
  const asUser = await call(buyerToken, '/admin/payments');
  check('a non-admin cannot see every payment', asUser.status === 403, `status=${asUser.status}`);
  const adminList = await call(adminToken, '/admin/payments');
  const listed = adminList.body?.payments?.find((p) => p.id === checkout.body.paymentId);
  check('an admin sees the payment with the buyer on it', listed?.userEmail === buyer.email, `${listed?.reference} ${listed?.userEmail}`);
  check('and the stored provider reference to reconcile with', Boolean(listed?.providerRef), `${listed?.providerRef}`);

  console.log('\n=== 10. Refund ===');
  const refund = await call(adminToken, `/admin/payments/${checkout.body.paymentId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ note: 'e2e refund' }),
  });
  check(
    'the refund reverses the credits and reports three numbers',
    refund.status === 200 && refund.body?.creditsReversed === 40 && refund.body?.shortfall === 0,
    JSON.stringify(refund.body && { sold: refund.body.creditsSold, reversed: refund.body.creditsReversed, short: refund.body.shortfall })
  );
  const balanceAfterRefund = (await call(buyerToken, '/credits')).body?.balance ?? 0;
  check('the balance comes down', balanceAfterRefund === balanceWithCrypto - 40, `${balanceWithCrypto} -> ${balanceAfterRefund}`);

  const again = await call(adminToken, `/admin/payments/${checkout.body.paymentId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ note: 'twice' }),
  });
  check('a second refund is refused', again.status === 409, `status=${again.status}: ${again.body?.error}`);

  console.log('\n=== 11. Refund against a spent balance ===');
  const spend = await call(adminToken, `/admin/accounts/${buyer.id}/credits`, {
    method: 'POST',
    body: JSON.stringify({ amount: -balanceAfterRefund, note: 'spent on resumes' }),
  });
  check('the balance is spent down to nothing', spend.status === 200, `status=${spend.status}`);
  const shortRefund = await call(adminToken, `/admin/payments/${cryptoCheckout.body.paymentId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ note: 'spent already' }),
  });
  check(
    'a crypto refund says plainly that it cannot be done automatically',
    shortRefund.status === 409 && /coinbase/i.test(shortRefund.body?.error ?? ''),
    `${shortRefund.status}: ${shortRefund.body?.error}`
  );

  console.log('\n=== 12. What the provider was actually asked for ===');
  const fakeState = await (await fetch(`${FAKE}/state`)).json();
  const askedFor = fakeState.sessions.find((s) => s.reference === checkout.body.reference);
  check(
    'the provider was asked for the amount the server quoted',
    askedFor?.amountCents === 2000 && askedFor?.credits === 40,
    `${askedFor?.credits} credits, ${askedFor?.amountCents}c`
  );
  check('the refund reached the provider', fakeState.refunds.length === 1, JSON.stringify(fakeState.refunds));

  console.log('\n=== 13. The stored event ===');
  const events = await call(adminToken, `/admin/payments`);
  const sqlite = require(path.join(DIST, 'database', 'sqlite'));
  const row = sqlite
    .getDb()
    .prepare('SELECT payload FROM payment_events ORDER BY received_at DESC LIMIT 1')
    .get();
  check('the event payload keeps the amount', /amount_total/.test(row?.payload ?? ''), '');
  check(
    'and drops the customer',
    !/e2e-buyer@example\.com/.test(row?.payload ?? '') && !/1 Test Street/.test(row?.payload ?? ''),
    (row?.payload ?? '').slice(0, 160)
  );

  console.log(`\n=== ${results.length - failures} of ${results.length} checks passed ===`);
  if (failures) {
    console.log('\nFailures:');
    for (const r of results.filter((r) => !r.ok)) console.log(` - ${r.name} ${r.detail}`);
  }
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('\nThe walkthrough itself broke:', error);
  process.exit(2);
});

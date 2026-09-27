const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Refunds, and the number that does not add up unless you look for it.
 *
 * A balance may not go negative. So refunding somebody who has already SPENT
 * what they bought returns all of their money and reverses only what is left -
 * and the difference has to be reported, because a refund that quietly reverses
 * forty of two hundred credits is the kind of discrepancy that surfaces weeks
 * later as an accounting argument.
 *
 * The other claims here are the ordinary ones for anything that moves money:
 * it happens once, only to a paid payment, and the provider is called before
 * anything local changes.
 */

async function setup() {
  useTempStorage(`payment-refund-${Math.random().toString(36).slice(2)}`);
  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const paymentsDb = loadFresh('../dist/database/paymentRepository');
  const creditsDb = loadFresh('../dist/database/creditRepository');
  const credits = loadFresh('../dist/services/credits');
  loadFresh('../dist/config/aiModelConfig');

  const stripe = loadFresh('../dist/integrations/stripe');
  const refunds = [];
  stripe.getCheckoutSession = async () => ({ id: 'cs_1', payment_intent: 'pi_1' });
  stripe.refundPaymentIntent = async (intent, paymentId) => {
    refunds.push({ intent, paymentId });
  };

  const payments = loadFresh('../dist/services/payments');

  const buyer = users.createUser({ email: 'buyer@example.com' });
  const admin = users.createUser({ email: 'boss@example.com' });

  /** A payment that has been through the webhook and credited. */
  const paidPayment = (creditAmount) => {
    const payment = paymentsDb.createPayment({
      userId: buyer.id,
      method: 'card',
      provider: 'stripe',
      credits: creditAmount,
      amountCents: creditAmount * 50,
      currency: 'usd',
      unitPriceCents: 50,
    });
    paymentsDb.attachProviderRef(payment.id, `cs_${payment.id}`);
    payments.creditPaid(payment.id);
    return paymentsDb.getPayment(payment.id);
  };

  return {
    users,
    paymentsDb,
    creditsDb,
    credits,
    payments,
    refunds,
    buyer,
    admin,
    paidPayment,
    balance: () => users.getUserById(buyer.id).credits,
    spend: (units) =>
      creditsDb.applyAdjustment({
        userId: buyer.id,
        delta: -units,
        reason: 'admin-revoke',
        idempotencyKey: `spend:${Math.random()}`,
        note: 'spent on resumes',
      }),
  };
}

test('a refund returns the money and reverses the credits', async () => {
  const context = await setup();
  const payment = context.paidPayment(200);
  assert.equal(context.balance(), 200);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'changed their mind');

  assert.deepEqual(
    { sold: outcome.creditsSold, reversed: outcome.creditsReversed, shortfall: outcome.shortfall },
    { sold: 200, reversed: 200, shortfall: 0 }
  );
  assert.equal(context.balance(), 0);
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'refunded');

  // The provider was actually called, with the intent behind the session.
  assert.deepEqual(context.refunds, [{ intent: 'pi_1', paymentId: payment.id }]);

  const entry = context.credits
    .getLedger(context.buyer.id)
    .find((row) => row.reason === 'purchase-refund');
  assert.ok(entry, 'the reversal is in the ledger, not just on the payment');
  assert.equal(entry.delta, -200);
  assert.equal(entry.actorId, context.admin.id, 'and says who did it');
});

test('against a spent balance it reverses what remains and reports the shortfall', async () => {
  const context = await setup();
  const payment = context.paidPayment(200);
  context.spend(160);
  assert.equal(context.balance(), 40);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id);

  // The money went back in full; the credits could not.
  assert.equal(outcome.creditsSold, 200);
  assert.equal(outcome.creditsReversed, 40, 'only what was left');
  assert.equal(outcome.shortfall, 160, 'and the difference is reported, not hidden');
  assert.equal(context.balance(), 0, 'never negative');

  // The stored figure matches, so the admin page can say the same thing later.
  assert.equal(context.paymentsDb.getPayment(payment.id).refundedCredits, 40);
});

test('a balance spent to nothing refunds the money and reverses nothing', async () => {
  const context = await setup();
  const payment = context.paidPayment(100);
  context.spend(100);
  assert.equal(context.balance(), 0);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id);

  assert.equal(outcome.creditsReversed, 0);
  assert.equal(outcome.shortfall, 100);
  assert.equal(context.balance(), 0);
  assert.equal(context.refunds.length, 1, 'the customer still gets their money back');
});

test('a refund cannot be run twice', async () => {
  const context = await setup();
  const payment = context.paidPayment(50);

  await context.payments.refundPayment(payment.id, context.admin.id);
  await assert.rejects(
    () => context.payments.refundPayment(payment.id, context.admin.id),
    /already refunded/i
  );

  assert.equal(context.refunds.length, 1, 'and the provider is not asked twice');
  const reversals = context.credits
    .getLedger(context.buyer.id)
    .filter((row) => row.reason === 'purchase-refund');
  assert.equal(reversals.length, 1);
});

test('only a paid payment can be refunded', async () => {
  const context = await setup();
  const pending = context.paymentsDb.createPayment({
    userId: context.buyer.id,
    method: 'card',
    provider: 'stripe',
    credits: 10,
    amountCents: 500,
    currency: 'usd',
    unitPriceCents: 50,
  });

  await assert.rejects(
    () => context.payments.refundPayment(pending.id, context.admin.id),
    /only a paid payment/i
  );
  await assert.rejects(
    () => context.payments.refundPayment('pay_nothing', context.admin.id),
    /not found/i
  );
  assert.equal(context.refunds.length, 0);
});

test('a provider that refuses the refund changes nothing locally', async () => {
  const context = await setup();
  const payment = context.paidPayment(80);

  const stripe = require('../dist/integrations/stripe');
  stripe.refundPaymentIntent = async () => {
    throw new stripe.StripeError('The charge is too old to refund.');
  };

  await assert.rejects(() => context.payments.refundPayment(payment.id, context.admin.id), /too old/i);

  // The provider is called FIRST for exactly this reason: the reverse order
  // would leave somebody with no credits and no money back.
  assert.equal(context.balance(), 80, 'the credits are untouched');
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'paid', 'and it can be tried again');
});

/*
 * Crypto cannot be pulled back, only sent back - and the message has to say
 * WHERE FROM, which is different for each of the three providers that have
 * taken crypto here.
 *
 * All three are tested because `PaymentProvider` is not switched on
 * exhaustively anywhere in this codebase: a new member does not fail to
 * compile, it falls into whichever branch happens to be last. That is how this
 * message once told every on-chain payment to look in a Coinbase Commerce
 * account the coin had never passed through, and it is why the retired rows -
 * which still exist, and still get refunded - are pinned here rather than
 * assumed to have gone away with the code that created them.
 */
const CRYPTO_REFUND_ADVICE = [
  ['cryptomus', 'inv-uuid-1', /Cryptomus merchant dashboard/],
  ['coinbase', 'CODE1', /Coinbase Commerce account/],
  ['chain', 'cinv_1', /wallet you configured in CHAIN_\*_ADDRESS/],
];

for (const [provider, providerRef, advice] of CRYPTO_REFUND_ADVICE) {
  test(`a ${provider} payment says plainly where to send the money back from`, async () => {
    const context = await setup();
    const payment = context.paymentsDb.createPayment({
      userId: context.buyer.id,
      method: 'crypto',
      provider,
      credits: 60,
      amountCents: 3000,
      currency: 'usd',
      unitPriceCents: 50,
    });
    context.paymentsDb.attachProviderRef(payment.id, providerRef);
    context.payments.creditPaid(payment.id);

    // Pretending it can be pulled back would be the worst possible answer, and
    // naming the wrong place to go and look is the second worst.
    await assert.rejects(
      () => context.payments.refundPayment(payment.id, context.admin.id),
      (error) => {
        assert.match(error.message, /cannot be refunded automatically|nobody is holding it/i);
        assert.match(error.message, advice);
        return true;
      }
    );
    assert.equal(context.balance(), 60, 'and nothing is reversed on a promise');
  });
}

test('two refunds of the same payment at once: one refunds, the other is refused', async () => {
  const context = await setup();
  const payment = context.paidPayment(200);

  /*
   * The race an admin makes by having two tabs open.
   *
   * Both requests read `paid` before either calls Stripe, so a check that is
   * only a read lets both through. What must not happen is the second one
   * measuring a balance the first has already moved and reporting "0 of 200
   * reversed - the rest had been spent", which is a false statement about the
   * customer's account handed to the person about to write to them.
   */
  let releaseProvider = () => {};
  const held = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const stripe = require('../dist/integrations/stripe');
  stripe.getCheckoutSession = async () => {
    await held;
    return { id: 'cs_1', payment_intent: 'pi_1' };
  };

  const first = context.payments.refundPayment(payment.id, context.admin.id, 'first');
  const second = context.payments
    .refundPayment(payment.id, context.admin.id, 'second')
    .then(() => null)
    .catch((error) => error);

  const refusal = await second;
  releaseProvider();
  const outcome = await first;

  assert.ok(refusal instanceof Error, 'the second attempt is an error, not a second answer');
  assert.equal(refusal.status, 409);
  assert.match(refusal.message, /already being refunded/i);

  assert.equal(outcome.creditsReversed, 200, 'the one that ran reports the truth');
  assert.equal(outcome.shortfall, 0);
  assert.equal(context.balance(), 0);
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'refunded');
  assert.equal(context.refunds.length, 1, 'and the provider was asked exactly once');
});

test('a provider that refuses leaves the payment refundable', async () => {
  const context = await setup();
  const payment = context.paidPayment(100);

  const stripe = require('../dist/integrations/stripe');
  stripe.refundPaymentIntent = async () => {
    throw new Error('Stripe is unreachable');
  };

  await assert.rejects(() => context.payments.refundPayment(payment.id, context.admin.id, ''));

  // Claimed, then given back: a refund that did not happen must not leave a
  // payment stuck in a state with no button on it.
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'paid');
  assert.equal(context.balance(), 100, 'and nothing was reversed');

  stripe.refundPaymentIntent = async () => {};
  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'retried');
  assert.equal(outcome.creditsReversed, 100);
});

test('a refund whose answer was lost says so, instead of "nothing moved"', async () => {
  /*
   * The distinction `startCheckout` has always made, and this did not.
   *
   * Every failed refund released the claim with the comment "the money did not
   * move" - which for a dropped socket is a guess in the wrong direction. The
   * refund may well exist at Stripe, and the credits have NOT been reversed,
   * because that happens after the provider call. Money back, credits kept,
   * and an operator told nothing happened.
   *
   * The claim still goes back either way, because pressing Refund again is
   * safe: `refundPaymentIntent` sends `Idempotency-Key: refund:<paymentId>` and
   * Stripe will not create a second refund under it. What has to change is what
   * the operator is told, and the message has to say that.
   */
  const context = await setup();
  const payment = context.paidPayment(100);

  const stripe = require('../dist/integrations/stripe');
  stripe.refundPaymentIntent = async () => {
    throw new stripe.StripeError(
      'Lost the connection to Stripe while reading its reply: socket hang up',
      502,
      true
    );
  };

  const failure = await context.payments
    .refundPayment(payment.id, context.admin.id, '')
    .then(() => null)
    .catch((error) => error);

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /could not confirm the refund/i, failure.message);
  assert.match(failure.message, /may/i, 'it must not claim the refund did not happen');
  assert.match(failure.message, /again/i, 'and must say retrying is the way out');
  assert.doesNotMatch(
    failure.message,
    /nothing was refunded|did not go through/i,
    'which is exactly the claim it cannot make'
  );

  // Still refundable and nothing reversed, as for any other failure - the
  // release is right, it is only the sentence that was wrong.
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'paid');
  assert.equal(context.balance(), 100);

  stripe.refundPaymentIntent = async () => {};
  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'retried');
  assert.equal(outcome.creditsReversed, 100, 'and pressing again finishes it');
});

test('a provider this build does not know is not sent to Coinbase', async () => {
  /*
   * The fallback used to name Coinbase Commerce, which made "a provider added
   * after this code was written" and "Coinbase" the same answer - while the
   * admin page's own copy ended on Cryptomus, so the two halves of the product
   * already disagreed about that case. Every member of the union is named now
   * and the fallback names none of them.
   */
  const context = await setup();
  const payment = context.paymentsDb.createPayment({
    userId: context.buyer.id,
    method: 'crypto',
    provider: 'stripe-crypto-of-the-future',
    credits: 60,
    amountCents: 3_000,
    currency: 'usd',
    unitPriceCents: 50,
  });
  context.paymentsDb.markPaid(payment.id, 60);
  context.paymentsDb.attachProviderRef(payment.id, 'unknown_ref_1');

  const refusal = await context.payments
    .refundPayment(payment.id, context.admin.id, '')
    .then(() => null)
    .catch((error) => error);

  assert.ok(refusal instanceof Error);
  assert.equal(refusal.status, 409);
  assert.doesNotMatch(refusal.message, /coinbase|cryptomus|wallet you configured/i, refusal.message);
  assert.match(refusal.message, /wherever this payment was taken/i);
});

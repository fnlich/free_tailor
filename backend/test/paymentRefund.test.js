const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Refunds, and the number that does not add up unless you look for it.
 *
 * A balance may not go negative. So refunding somebody who has already SPENT
 * what they bought returns all of their money and reverses only what is left -
 * and the difference has to be reported, because a refund that quietly reverses
 * $40 of $200 is the kind of discrepancy that surfaces weeks
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

  /** A payment of `dollars` that has been through the webhook and credited - a credit is a dollar. */
  const paidPayment = (dollars) => {
    const payment = paymentsDb.createPayment({
      userId: buyer.id,
      method: 'card',
      provider: 'stripe',
      amountCents: dollars * 100,
      creditMilli: dollars * 1000,
      currency: 'usd',
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
    balance: () => users.getUserById(buyer.id).balanceMilli,
    /** Spends `dollars` of the balance, as resumes would. */
    spend: (dollars) =>
      creditsDb.applyAdjustment({
        userId: buyer.id,
        deltaMilli: -dollars * 1000,
        reason: 'admin-revoke',
        idempotencyKey: `spend:${Math.random()}`,
        note: 'spent on resumes',
      }),
  };
}

test('a refund returns the money and reverses the credits', async () => {
  const context = await setup();
  const payment = context.paidPayment(200);
  assert.equal(context.balance(), 200_000);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'changed their mind');

  assert.deepEqual(
    { credited: outcome.creditedMilli, reversed: outcome.reversedMilli, shortfall: outcome.shortfallMilli },
    { credited: 200_000, reversed: 200_000, shortfall: 0 }
  );
  assert.equal(context.balance(), 0);
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'refunded');

  // The provider was actually called, with the intent behind the session.
  assert.deepEqual(context.refunds, [{ intent: 'pi_1', paymentId: payment.id }]);

  const entry = context.credits
    .getLedger(context.buyer.id)
    .find((row) => row.reason === 'purchase-refund');
  assert.ok(entry, 'the reversal is in the ledger, not just on the payment');
  assert.equal(entry.deltaMilli, -200_000);
  assert.equal(entry.actorId, context.admin.id, 'and says who did it');
});

test('against a spent balance it reverses what remains and reports the shortfall', async () => {
  const context = await setup();
  const payment = context.paidPayment(200);
  context.spend(160);
  assert.equal(context.balance(), 40_000);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id);

  // The money went back in full; the credits could not.
  assert.equal(outcome.creditedMilli, 200_000);
  assert.equal(outcome.reversedMilli, 40_000, 'only what was left');
  assert.equal(outcome.shortfallMilli, 160_000, 'and the difference is reported, not hidden');
  assert.equal(context.balance(), 0, 'never negative');

  // The stored figure matches, so the admin page can say the same thing later.
  assert.equal(context.paymentsDb.getPayment(payment.id).refundedMilli, 40_000);
});

test('a balance spent to nothing refunds the money and reverses nothing', async () => {
  const context = await setup();
  const payment = context.paidPayment(100);
  context.spend(100);
  assert.equal(context.balance(), 0);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id);

  assert.equal(outcome.reversedMilli, 0);
  assert.equal(outcome.shortfallMilli, 100_000);
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
    amountCents: 500,
    creditMilli: 5_000,
    currency: 'usd',
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
  assert.equal(context.balance(), 80_000, 'the credits are untouched');
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'paid', 'and it can be tried again');
});

/*
 * Crypto cannot be pulled back, only sent back - and the message has to say
 * WHERE FROM. A Cryptomus payment is in that merchant account. A payment a
 * retired path took (`coinbase`, `chain` - the rows still exist, and still get
 * refunded by hand) is told the one sentence that cannot be wrong about where
 * it is: this build no longer knows those paths, so it names none of them.
 */
const CRYPTO_REFUND_ADVICE = [
  ['cryptomus', 'inv-uuid-1', /Cryptomus merchant dashboard/],
  ['coinbase', 'CODE1', /wherever this payment was taken/],
  ['chain', 'cinv_1', /wherever this payment was taken/],
];

for (const [provider, providerRef, advice] of CRYPTO_REFUND_ADVICE) {
  test(`a ${provider} payment says plainly where to send the money back from`, async () => {
    const context = await setup();
    const payment = context.paymentsDb.createPayment({
      userId: context.buyer.id,
      method: 'crypto',
      provider,
      amountCents: 6_000,
      creditMilli: 60_000,
      currency: 'usd',
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
    assert.equal(context.balance(), 60_000, 'and nothing is reversed on a promise');
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

  assert.equal(outcome.reversedMilli, 200_000, 'the one that ran reports the truth');
  assert.equal(outcome.shortfallMilli, 0);
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
  assert.equal(context.balance(), 100_000, 'and nothing was reversed');

  stripe.refundPaymentIntent = async () => {};
  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'retried');
  assert.equal(outcome.reversedMilli, 100_000);
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
  assert.equal(context.balance(), 100_000);

  stripe.refundPaymentIntent = async () => {};
  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'retried');
  assert.equal(outcome.reversedMilli, 100_000, 'and pressing again finishes it');
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
    amountCents: 6_000,
    creditMilli: 60_000,
    currency: 'usd',
  });
  context.paymentsDb.markPaid(payment.id, 60_000);
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

test('a payment from before credits were dollars refunds its money and reverses nothing', async () => {
  /*
   * It bought credits at 50c; the switch to dollars reset them to $0 with every
   * balance. Taking its $100 back off the balance now would take dollars the
   * buyer has paid for SINCE. The money goes back, nothing is reversed, and the
   * payment's own legacy figures say why.
   */
  const context = await setup();
  const later = context.paidPayment(30); // $30 bought after the switch
  const { getDb } = require('../dist/database/sqlite');
  const old = context.paymentsDb.createPayment({
    userId: context.buyer.id,
    method: 'card',
    provider: 'stripe',
    amountCents: 10_000,
    creditMilli: 0,
    currency: 'usd',
  });
  // As the older build wrote and settled it: 200 credits at 50c, all granted.
  getDb()
    .prepare(
      `UPDATE payments SET credits = 200, credits_granted = 200, unit_price_cents = 50, state = 'paid',
              provider_ref = 'cs_old', credited_at = created_at WHERE id = ?`
    )
    .run(old.id);
  assert.equal(context.balance(), 30_000);

  const outcome = await context.payments.refundPayment(old.id, context.admin.id);
  assert.deepEqual(
    { credited: outcome.creditedMilli, reversed: outcome.reversedMilli, shortfall: outcome.shortfallMilli },
    { credited: 0, reversed: 0, shortfall: 0 }
  );
  assert.equal(context.refunds.length, 1, 'the money still goes back');
  assert.equal(context.balance(), 30_000, "the later purchase's dollars are untouched");
  assert.deepEqual(outcome.payment.legacyCredits, { credits: 200, creditsGranted: 200, refundedCredits: 0, unitPriceCents: 50 });
  assert.equal(outcome.payment.state, 'refunded');
  assert.ok(later);
});

/*
 * Partial refunds - what a refund request makes of a purchase.
 *
 * A refund request returns only the UNSPENT part of a purchase: Stripe is
 * asked for that amount, exactly that much credit is reversed, and the
 * payment records both the money returned and the credit taken back, so the
 * admin page and the invoice can say "refunded $39.970 of $50.000".
 */
test('a partial refund asks Stripe for that amount and reverses only that much', async () => {
  const context = await setup();
  const stripe = require('../dist/integrations/stripe');
  const sent = [];
  stripe.refundPaymentIntent = async (intent, paymentId, amountCents) => {
    sent.push({ intent, paymentId, amountCents });
  };

  const payment = context.paidPayment(50);
  context.spend(10);
  assert.equal(context.balance(), 40_000);

  const outcome = await context.payments.refundPayment(payment.id, context.admin.id, 'unspent part', {
    amountMilli: 39_970,
  });

  assert.deepEqual(sent, [{ intent: 'pi_1', paymentId: payment.id, amountCents: 3_997 }]);
  assert.equal(outcome.refundAmountMilli, 39_970, 'what went back to the card');
  assert.equal(outcome.creditedMilli, 39_970, 'what the reversal set out to take');
  assert.equal(outcome.reversedMilli, 39_970);
  assert.equal(outcome.shortfallMilli, 0);
  assert.equal(context.balance(), 30, 'the sub-cent remainder of the purchase stays as credit');

  const stored = context.paymentsDb.getPayment(payment.id);
  assert.equal(stored.state, 'refunded');
  assert.equal(stored.refundCents, 3_997);
  assert.equal(stored.refundedMilli, 39_970);
  assert.equal(context.paymentsDb.toPaymentView(stored).refundAmountMilli, 39_970);
});

test('a full refund records the whole charge as returned, and an older refunded row reads the same way', async () => {
  const context = await setup();
  const payment = context.paidPayment(20);
  await context.payments.refundPayment(payment.id, context.admin.id);
  assert.equal(context.paymentsDb.getPayment(payment.id).refundCents, 2_000);

  // A payment refunded before refunds could be partial has refund_cents 0:
  // every one of those returned its whole charge, and reads so.
  const { getDb } = require('../dist/database/sqlite');
  getDb().prepare('UPDATE payments SET refund_cents = 0 WHERE id = ?').run(payment.id);
  assert.equal(context.paymentsDb.toPaymentView(context.paymentsDb.getPayment(payment.id)).refundAmountMilli, 20_000);
});

test('a partial refund refuses an amount that is not whole cents, nothing, or more than the charge', async () => {
  const context = await setup();
  const payment = context.paidPayment(10);
  for (const amountMilli of [1_005, 0, -10, 10_010]) {
    await assert.rejects(
      () => context.payments.refundPayment(payment.id, context.admin.id, '', { amountMilli }),
      /partial refund/i
    );
  }
  assert.equal(context.paymentsDb.getPayment(payment.id).state, 'paid', 'refused before the claim');
  assert.equal(context.refunds.length, 0);
});

test('crypto sent back by hand is recorded and its credit reversed; a card cannot be refunded by hand', async () => {
  const context = await setup();
  const crypto = context.paymentsDb.createPayment({
    userId: context.buyer.id,
    method: 'crypto',
    provider: 'cryptomus',
    amountCents: 6_000,
    creditMilli: 60_000,
    currency: 'usd',
  });
  context.paymentsDb.attachProviderRef(crypto.id, 'inv-hand');
  context.payments.creditPaid(crypto.id);

  const outcome = await context.payments.refundPayment(crypto.id, context.admin.id, 'sent back', {
    amountMilli: 25_000,
    refundedByHand: true,
  });
  assert.equal(outcome.refundAmountMilli, 25_000);
  assert.equal(outcome.reversedMilli, 25_000);
  assert.equal(context.balance(), 35_000);
  assert.equal(context.refunds.length, 0, 'nothing is asked of any provider');
  assert.equal(context.paymentsDb.getPayment(crypto.id).state, 'refunded');

  const card = context.paidPayment(5);
  await assert.rejects(
    () => context.payments.refundPayment(card.id, context.admin.id, '', { refundedByHand: true }),
    /through Stripe, not by hand/
  );
  assert.equal(context.paymentsDb.getPayment(card.id).state, 'paid');
});

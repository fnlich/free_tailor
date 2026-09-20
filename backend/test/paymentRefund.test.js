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

test('a crypto payment says plainly that it cannot be refunded automatically', async () => {
  const context = await setup();
  const payment = context.paymentsDb.createPayment({
    userId: context.buyer.id,
    method: 'crypto',
    provider: 'coinbase',
    credits: 60,
    amountCents: 3000,
    currency: 'usd',
    unitPriceCents: 50,
  });
  context.paymentsDb.attachProviderRef(payment.id, 'CODE1');
  context.payments.creditPaid(payment.id);

  // A chain payment cannot be pulled back, only sent back. Pretending
  // otherwise would be the worst possible answer here.
  await assert.rejects(
    () => context.payments.refundPayment(payment.id, context.admin.id),
    /cannot be refunded automatically/i
  );
  assert.equal(context.balance(), 60, 'and nothing is reversed on a promise');
});

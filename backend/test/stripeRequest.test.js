const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

/**
 * What actually goes over the wire to Stripe.
 *
 * Every other payment test replaces `createCheckoutSession`, which is the right
 * seam for testing what the app does with a session - and means the request
 * itself was never tested at all. Two things in it are load-bearing and neither
 * fails in a way a stub can show:
 *
 *  1. `ui_mode: 'elements'` is what makes the form ours rather than a redirect,
 *     and it exists ONLY from API version 2026-03-25.dahlia. Stripe resolves a
 *     request at the ACCOUNT's pinned version unless a header says otherwise, so
 *     without `Stripe-Version` this works on a new account and 400s on an older
 *     one - the failure lands on the operator, not on us, and looks like a bug
 *     in this app.
 *  2. The hosted-page parameters must be GONE. Sending `success_url` alongside
 *     `ui_mode: 'elements'` is a contradiction Stripe rejects.
 *
 * So this test stubs `fetch` and reads the bytes.
 */

function withStubbedFetch(reply) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(reply),
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** The form-encoded body, back as something assertable. */
function fields(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

test('a checkout session is asked for in elements mode, at a pinned API version', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_wire';
  const stripe = loadFresh('../dist/integrations/stripe');
  const stub = withStubbedFetch({ id: 'cs_test_1', client_secret: 'cs_test_1_secret' });

  try {
    const session = await stripe.createCheckoutSession({
      paymentId: 'pay_wire',
      reference: 'FT-PAY-20260921-0001',
      credits: 40,
      amountCents: 2000,
      currency: 'usd',
      customerEmail: 'buyer@example.com',
      returnUrl: 'https://app.example.com/credits/return?payment=pay_wire',
    });

    assert.equal(session.client_secret, 'cs_test_1_secret');
    assert.equal(stub.calls.length, 1);

    const [call] = stub.calls;
    assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(call.init.method, 'POST');

    // Without this header Stripe answers at whatever version the account is
    // pinned to, and `elements` does not exist before 2026-03-25.dahlia.
    assert.equal(call.init.headers['Stripe-Version'], '2026-03-25.dahlia');
    assert.equal(call.init.headers.Authorization, 'Bearer sk_test_wire');
    assert.equal(call.init.headers['Idempotency-Key'], 'checkout:pay_wire');

    const body = fields(call.init.body);
    assert.equal(body.ui_mode, 'elements', 'the form is ours, not a redirect');
    assert.equal(body.return_url, 'https://app.example.com/credits/return?payment=pay_wire');
    assert.equal(body.mode, 'payment');

    // The hosted-page parameters are a contradiction in elements mode.
    assert.equal(body.success_url, undefined);
    assert.equal(body.cancel_url, undefined);

    // Priced in the smallest unit, in usd - which is also what stablecoin
    // payments require of every line item.
    assert.equal(body['line_items[0][price_data][currency]'], 'usd');
    assert.equal(body['line_items[0][price_data][unit_amount]'], '2000');
    assert.equal(body['metadata[paymentId]'], 'pay_wire');
  } finally {
    stub.restore();
  }
});

test('every Stripe request carries the pinned version, not just the checkout', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_wire';
  const stripe = loadFresh('../dist/integrations/stripe');
  const stub = withStubbedFetch({ id: 're_1' });

  try {
    await stripe.refundPaymentIntent('pi_1', 'pay_wire');
    assert.equal(stub.calls[0].init.headers['Stripe-Version'], '2026-03-25.dahlia');
  } finally {
    stub.restore();
  }
});

test('a key in the wrong slot is refused rather than published', () => {
  const stripe = loadFresh('../dist/integrations/stripe');

  /*
   * The publishable key is served to every browser that opens the buy page.
   * That is correct for a publishable key and catastrophic for a secret one,
   * and the two sit beside each other on the same dashboard page under names
   * that are easy to confuse.
   */
  const secretInTheWrongSlot = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PUBLISHABLE_KEY: 'sk_test_x',
  };
  assert.equal(stripe.stripePublishableKey(secretInTheWrongSlot), '');
  assert.equal(
    stripe.isStripeConfigured(secretInTheWrongSlot),
    false,
    'and the method is withheld rather than offered with no key'
  );

  const restricted = { ...secretInTheWrongSlot, STRIPE_PUBLISHABLE_KEY: 'rk_live_x' };
  assert.equal(stripe.stripePublishableKey(restricted), '');

  const right = { ...secretInTheWrongSlot, STRIPE_PUBLISHABLE_KEY: 'pk_test_x' };
  assert.equal(stripe.stripePublishableKey(right), 'pk_test_x');
  assert.equal(stripe.isStripeConfigured(right), true);
});

test('a dropped connection is reported as unknown, not as a refusal', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_wire';
  const stripe = loadFresh('../dist/integrations/stripe');
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('socket hang up');
  };

  try {
    await assert.rejects(
      () =>
        stripe.createCheckoutSession({
          paymentId: 'pay_x',
          reference: 'FT-PAY-1',
          credits: 10,
          amountCents: 500,
          currency: 'usd',
          customerEmail: 'a@b.c',
          returnUrl: 'https://app.example.com/return',
        }),
      (error) => {
        // The flag is what stops startCheckout closing a payment whose session
        // may well exist at Stripe with somebody about to pay it.
        assert.equal(error.transport, true);
        return true;
      }
    );
  } finally {
    globalThis.fetch = real;
  }
});

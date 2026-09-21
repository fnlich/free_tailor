const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const { useTempStorage, useAdminEmails, loadFresh, writeSettingRaw } = require('./helpers');

/*
 * A card somebody kept belongs to them, and charging it credits once.
 *
 * Three claims, and the third is the one that is easy to get wrong.
 *
 * One: a card is saved only when it was asked for. A guest checkout must not
 * quietly create a customer and keep a payment method nobody offered to store.
 *
 * Two: a saved card is scoped to an account like everything else here - by id
 * AND owner in one query, answering 404 rather than 403, because the difference
 * would confirm that somebody else's card exists.
 *
 * Three: an off-session charge reports itself as `payment_intent.succeeded`,
 * and `provider_ref` then holds a `pi_` where it used to hold a `cs_`. That
 * means TWO id spaces in one column, and an ordinary embedded-checkout payment
 * ALSO emits a `payment_intent.succeeded` carrying `metadata.paymentId` - so
 * if the intent branch trusted that hint it would find every card payment
 * twice. It settles by provider reference only, and that is what these tests
 * pin.
 */

const PRICE_CENTS = 50;
const STRIPE_SECRET = 'whsec_test_secret';

function signStripe(rawBody, secret = STRIPE_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function serve() {
  const { dbDir } = useTempStorage(`saved-cards-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');

  process.env.STRIPE_SECRET_KEY = 'sk_test_key';
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_key';
  delete process.env.COINBASE_COMMERCE_API_KEY;
  delete process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  process.env.PAYMENTS_RETURN_URL = 'https://app.example.com';

  writeSettingRaw(
    dbDir,
    'app-settings',
    JSON.stringify({
      creditPriceCents: PRICE_CENTS,
      creditMinCredits: 1,
      creditMaxCredits: 100_000,
      paymentLimits: [
        { target: 'card', minCents: 1, maxCents: 1_000_000, feeBps: 0, feeFixedCents: 0, presetsCents: [] },
      ],
    })
  );

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  const payments = loadFresh('../dist/database/paymentRepository');
  const cards = loadFresh('../dist/database/savedCardRepository');
  loadFresh('../dist/config/aiModelConfig');

  // The whole Stripe boundary, replaced before the service that calls it loads.
  const stripe = loadFresh('../dist/integrations/stripe');
  const calls = { sessions: [], customers: [], charges: [], detached: [] };

  stripe.createCheckoutSession = async (input) => {
    calls.sessions.push(input);
    return {
      id: `cs_test_${calls.sessions.length}`,
      client_secret: `cs_test_${calls.sessions.length}_secret`,
      payment_intent: `pi_from_session_${calls.sessions.length}`,
    };
  };
  stripe.createCustomer = async (input) => {
    calls.customers.push(input);
    return { id: `cus_test_${calls.customers.length}` };
  };
  stripe.chargeSavedCard = async (input) => {
    calls.charges.push(input);
    return { id: `pi_saved_${calls.charges.length}`, status: 'succeeded' };
  };
  stripe.getCheckoutSession = async (id) => ({
    id,
    payment_status: 'paid',
    // `cs_test_3` -> `pi_from_session_3`, so an intent can be traced back to
    // the session that made it and to what that session was asked for.
    payment_intent: `pi_from_session_${id.replace('cs_test_', '')}`,
  });
  stripe.getPaymentIntent = async (id) => {
    /*
     * `setup_future_usage` is the buyer's own answer coming back.
     *
     * Stripe copies it from `payment_intent_data.setup_future_usage`, which is
     * set only when they ticked "save this card" - so a fake that always
     * returned it would hide the difference between a buyer who asked and one
     * who did not, which is the difference the service now turns on.
     */
    const index = Number.parseInt(id.replace('pi_from_session_', ''), 10);
    const session = calls.sessions[index - 1];
    return {
      id,
      payment_method: `pm_test_${Number.isInteger(index) ? index : 1}`,
      ...(session?.saveCard ? { setup_future_usage: 'off_session' } : {}),
    };
  };
  stripe.getPaymentMethod = async (id) => ({
    id,
    card: { brand: 'mastercard', last4: '9729', exp_month: 4, exp_year: 2031 },
  });
  // Handed to a test so it can settle a session the way the webhook does.
  calls.stripe = stripe;
  stripe.detachPaymentMethod = async (id) => {
    calls.detached.push(id);
  };

  loadFresh('../dist/services/payments/pricing');
  const service = loadFresh('../dist/services/payments');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/payments');
  const webhooks = loadFresh('../dist/routes/paymentWebhooks');

  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  const app = express();
  // The webhook mount comes first and takes a raw body, exactly as index.ts
  // does it: a provider signs the bytes it sent, and a JSON parser replaces
  // them with an object whose re-serialization is only usually identical.
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), webhooks.default);
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/payments', routes.default);

  const server = app.listen(0);
  const port = server.address().port;

  const call = (token, path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  const aliceToken = users.createSession(alice.id);
  const bobToken = users.createSession(bob.id);

  const deliver = (event) => {
    const body = JSON.stringify(event);
    return fetch(`http://127.0.0.1:${port}/api/payments/webhook/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(body) },
      body,
    });
  };

  return {
    users,
    payments,
    cards,
    service,
    calls,
    alice,
    bob,
    aliceToken,
    bobToken,
    close: () => server.close(),
    call,
    deliver,
    checkout: (token, body) =>
      call(token, '/api/payments/checkout', { method: 'POST', body: JSON.stringify(body) }),
  };
}

test('a card is kept only when the buyer asked for it', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'card', credits: 10 });

    assert.equal(server.calls.customers.length, 0, 'no customer for a guest checkout');
    assert.equal(server.calls.sessions[0].customer, undefined);
    assert.equal(server.calls.sessions[0].saveCard, undefined);

    await server.checkout(server.aliceToken, { method: 'card', credits: 10, saveCard: true });

    assert.equal(server.calls.customers.length, 1, 'and one when they did');
    assert.equal(server.calls.sessions[1].customer, 'cus_test_1');
    assert.equal(server.calls.sessions[1].saveCard, true);
  } finally {
    server.close();
  }
});

test('one customer per account, however many times they pay', async () => {
  const server = await serve();
  try {
    await server.checkout(server.aliceToken, { method: 'card', credits: 10, saveCard: true });
    await server.checkout(server.aliceToken, { method: 'card', credits: 20, saveCard: true });
    await server.checkout(server.aliceToken, { method: 'card', credits: 30, saveCard: true });

    assert.equal(server.calls.customers.length, 1, 'created once and then reused');
    /*
     * Read from the repository, not off the account.
     *
     * The handle is deliberately NOT a field on `UserAccount`: both account
     * serializers spread the account wholesale, so anything on that type is
     * served to a browser - and an administrator's account list would have
     * carried every customer's Stripe handle.
     */
    assert.equal(server.users.getStripeCustomerId(server.alice.id), 'cus_test_1');
    for (const session of server.calls.sessions) {
      assert.equal(session.customer, 'cus_test_1');
    }
  } finally {
    server.close();
  }
});

test('a saved card is listed to its owner and to nobody else', async () => {
  const server = await serve();
  try {
    server.users.claimStripeCustomer(server.alice.id, 'cus_alice');
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
      brand: 'mastercard',
      last4: '9729',
    });

    const mine = await (await server.call(server.aliceToken, '/api/payments/cards')).json();
    assert.equal(mine.cards.length, 1);
    assert.equal(mine.cards[0].last4, '9729');
    assert.equal(mine.cards[0].methodRef, undefined, 'the handle is not served to the browser');

    const theirs = await (await server.call(server.bobToken, '/api/payments/cards')).json();
    assert.deepEqual(theirs.cards, [], 'somebody else sees none of it');

    // And the route is reachable at all, which is the trap: declared after
    // `/:id` it would resolve as an id of "cards" and answer 404.
    const deleteAsStranger = await server.call(server.bobToken, `/api/payments/cards/${card.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteAsStranger.status, 404, '404, never 403 - 403 would confirm it exists');
    assert.equal(server.cards.listCardsForUser(server.alice.id).length, 1, 'and it survives');
  } finally {
    server.close();
  }
});

test('a card is forgotten at Stripe before it disappears here', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
      brand: 'visa',
      last4: '4242',
    });

    const response = await server.call(server.aliceToken, `/api/payments/cards/${card.id}`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(server.calls.detached, ['pm_alice_1']);
    assert.equal(server.cards.listCardsForUser(server.alice.id).length, 0);

    // The payment made with it is still explainable, which is why the delete
    // is soft: the row is there, it is simply not offered.
    assert.ok(server.cards.getCardByMethodRef('stripe', 'pm_alice_1'));
  } finally {
    server.close();
  }
});

test('a card Stripe will not forget is not forgotten here either', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
    });

    const stripe = require('../dist/integrations/stripe');
    stripe.detachPaymentMethod = async () => {
      throw new Error('Stripe is down');
    };

    const response = await server.call(server.aliceToken, `/api/payments/cards/${card.id}`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 502);
    assert.equal(
      server.cards.listCardsForUser(server.alice.id).length,
      1,
      'still offered, because a card the buyer believes is gone but still works at the ' +
        'provider is the failure worth avoiding'
    );
  } finally {
    server.close();
  }
});

test('paying with a saved card charges it and asks the browser for nothing', async () => {
  const server = await serve();
  try {
    server.users.claimStripeCustomer(server.alice.id, 'cus_alice');
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
      brand: 'mastercard',
      last4: '9729',
    });

    const response = await server.checkout(server.aliceToken, {
      method: 'card',
      credits: 40,
      cardId: card.id,
    });
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.clientSecret, undefined, 'nothing to confirm');
    assert.equal(body.redirectUrl, undefined, 'nowhere to go');
    assert.equal(body.processing, true, 'just wait');

    assert.equal(server.calls.sessions.length, 0, 'no checkout session at all');
    assert.equal(server.calls.charges.length, 1);
    assert.equal(server.calls.charges[0].paymentMethod, 'pm_alice_1');
    assert.equal(server.calls.charges[0].amountCents, 40 * PRICE_CENTS, 'the server\'s number');

    // The intent, not a session, is what was recorded against the payment.
    const payment = server.payments.getPayment(body.paymentId);
    assert.equal(payment.providerRef, 'pi_saved_1');
  } finally {
    server.close();
  }
});

test('somebody else\'s saved card cannot be charged', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
    });

    const response = await server.checkout(server.bobToken, {
      method: 'card',
      credits: 10,
      cardId: card.id,
    });
    assert.equal(response.status, 404, '404, never 403');
    assert.equal(server.calls.charges.length, 0, 'and nothing was charged');
  } finally {
    server.close();
  }
});

test('an off-session charge is credited once, by its own intent event', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
    });

    const started = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 40, cardId: card.id })
    ).json();

    const event = {
      id: 'evt_intent_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_saved_1',
          amount_received: 40 * PRICE_CENTS,
          currency: 'usd',
          metadata: { paymentId: started.paymentId },
        },
      },
    };

    assert.equal((await server.deliver(event)).status, 200);
    assert.equal(server.users.getUserById(server.alice.id).credits, 40);
    assert.equal(server.payments.getPayment(started.paymentId).state, 'paid');

    // A second delivery of the same event credits nothing, as for any other.
    assert.equal((await server.deliver({ ...event, id: 'evt_intent_2' })).status, 200);
    assert.equal(server.users.getUserById(server.alice.id).credits, 40, 'and must not pay twice');
  } finally {
    server.close();
  }
});

test('a session payment\'s own intent event credits nothing, and the session event still does', async () => {
  const server = await serve();
  try {
    const started = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 40 })
    ).json();

    /*
     * The double-event case.
     *
     * An embedded-checkout payment emits BOTH `checkout.session.completed` and
     * `payment_intent.succeeded`, for the same money. The intent's id is not
     * what is in `provider_ref` - the session's is - but it does carry
     * `metadata.paymentId`, copied there by `payment_intent_data`. If the
     * intent branch passed that hint along it would find this payment, record
     * a second event, and log an "already settled" line for every single card
     * sale in the system.
     */
    const intentEvent = {
      id: 'evt_intent_first',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_from_session_1',
          amount_received: 40 * PRICE_CENTS,
          currency: 'usd',
          metadata: { paymentId: started.paymentId },
        },
      },
    };

    const acknowledged = await server.deliver(intentEvent);
    assert.equal(acknowledged.status, 200);
    assert.match(
      (await acknowledged.json()).note,
      /no matching payment/i,
      'resolved by reference only, so a session\'s intent is a stranger\'s event'
    );
    assert.equal(server.users.getUserById(server.alice.id).credits, 0, 'nothing credited');
    assert.equal(server.payments.getPayment(started.paymentId).state, 'pending');

    // And the event that IS this payment's still works.
    const sessionEvent = {
      id: 'evt_session_first',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: server.payments.getPayment(started.paymentId).providerRef,
          payment_status: 'paid',
          amount_total: 40 * PRICE_CENTS,
          currency: 'usd',
          metadata: { paymentId: started.paymentId },
        },
      },
    };
    assert.equal((await server.deliver(sessionEvent)).status, 200);
    assert.equal(server.users.getUserById(server.alice.id).credits, 40);
  } finally {
    server.close();
  }
});

test('an intent reporting a different amount credits nothing', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
    });
    const started = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 40, cardId: card.id })
    ).json();

    const response = await server.deliver({
      id: 'evt_short',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_saved_1', amount_received: 100, currency: 'usd' },
      },
    });

    // 200, because a retry would say exactly the same thing. It is recorded,
    // logged and left for a person - the same answer the session path gives.
    assert.equal(response.status, 200);
    assert.match((await response.json()).note, /amount does not match/i);
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
    assert.equal(server.payments.getPayment(started.paymentId).state, 'pending');
  } finally {
    server.close();
  }
});

test('a failed intent closes the payment without crediting', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
    });
    const started = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 40, cardId: card.id })
    ).json();

    assert.equal(
      (
        await server.deliver({
          id: 'evt_failed',
          type: 'payment_intent.payment_failed',
          data: { object: { id: 'pi_saved_1', currency: 'usd' } },
        })
      ).status,
      200
    );

    const payment = server.payments.getPayment(started.paymentId);
    assert.equal(payment.state, 'failed');
    assert.equal(server.users.getUserById(server.alice.id).credits, 0);
    assert.doesNotMatch(payment.failure, /payment_intent/, 'the buyer is not shown an event name');
  } finally {
    server.close();
  }
});

test('a refund finds the payment behind a pi_ reference without asking for a session', async () => {
  const server = await serve();
  try {
    const card = server.cards.saveCard({
      userId: server.alice.id,
      customerRef: 'cus_alice',
      methodRef: 'pm_alice_1',
    });
    const started = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 40, cardId: card.id })
    ).json();
    server.service.creditPaid(started.paymentId);

    const stripe = require('../dist/integrations/stripe');
    let sessionAsked = false;
    const refunded = [];
    stripe.getCheckoutSession = async (id) => {
      sessionAsked = true;
      return { id };
    };
    stripe.refundPaymentIntent = async (intent, paymentId) => {
      refunded.push({ intent, paymentId });
    };

    const outcome = await server.service.refundPayment(started.paymentId, 'admin');

    assert.equal(sessionAsked, false, 'a pi_ is already the intent; asking for a session 404s');
    assert.deepEqual(refunded, [{ intent: 'pi_saved_1', paymentId: started.paymentId }]);
    assert.equal(outcome.creditsReversed, 40);
    assert.equal(outcome.shortfall, 0);
  } finally {
    server.close();
  }
});

/*
 * Consent, read back from the provider rather than remembered here.
 *
 * `recordSavedCardFromSession` runs after every settled Stripe payment, so
 * what stops it storing a card is the only question that matters. The obvious
 * gate - "does this account have a customer" - is the WRONG question: an
 * account that saved a card once has a customer for ever, so every later
 * purchase would quietly keep whatever card paid for it, including one the
 * buyer had just declined to save. The right question is what they were asked,
 * and Stripe hands that back on the intent as `setup_future_usage`.
 */

/** One paid session, delivered the way the webhook mount receives it. */
function paidSession(payment, credits, priceCents) {
  return {
    id: `evt_${payment.id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: payment.providerRef,
        payment_status: 'paid',
        amount_total: credits * priceCents,
        currency: 'usd',
        metadata: { paymentId: payment.id },
      },
    },
  };
}

test('a card is stored when the buyer ticked the box', async () => {
  const server = await serve();
  try {
    const started = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 10, saveCard: true })
    ).json();

    const payment = server.payments.getPayment(started.paymentId);
    assert.equal((await server.deliver(paidSession(payment, 10, PRICE_CENTS))).status, 200);
    // Recorded after the transaction and never awaited, so give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const kept = server.cards.listCardsForUser(server.alice.id);
    assert.equal(kept.length, 1, 'the card they asked to keep is kept');
    assert.equal(kept[0].last4, '9729');
  } finally {
    server.close();
  }
});

test('a card is NOT stored when the buyer did not, even once they have a customer', async () => {
  const server = await serve();
  try {
    // First, a purchase that DID ask - which is what gives Alice a customer
    // and makes the weaker gate stop protecting her.
    const first = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 10, saveCard: true })
    ).json();
    const firstPayment = server.payments.getPayment(first.paymentId);
    await server.deliver(paidSession(firstPayment, 10, PRICE_CENTS));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.cards.listCardsForUser(server.alice.id).length, 1);
    assert.ok(server.users.getStripeCustomerId(server.alice.id), 'she has a customer now');

    // Then one that did not ask. A different card, and it must not be kept.
    const second = await (
      await server.checkout(server.aliceToken, { method: 'card', credits: 10 })
    ).json();
    const secondPayment = server.payments.getPayment(second.paymentId);
    assert.equal((await server.deliver(paidSession(secondPayment, 10, PRICE_CENTS))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const kept = server.cards.listCardsForUser(server.alice.id);
    assert.equal(kept.length, 1, 'still just the one she asked to keep');
    assert.equal(server.users.getUserById(server.alice.id).credits, 20, 'both purchases credited');
  } finally {
    server.close();
  }
});

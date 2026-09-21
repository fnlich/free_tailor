/*
 * A stand-in for Stripe and Coinbase Commerce, loaded into the real server.
 *
 * Run as `node --require ./fake-providers.js dist/index.js`, so this file is
 * evaluated before the app requires its integration modules and replaces every
 * function that reaches the network. NOTHING else is replaced: the routes,
 * the database, the webhook mount, the signature verification and the ledger
 * are the real ones, which is the whole point - the only thing faked is the
 * company at the other end of the wire.
 *
 * It also serves a hosted checkout page of its own, because a checkout the
 * browser cannot actually visit is not an end-to-end test of anything. Pay
 * sends a properly signed webhook to the server, exactly as the real provider
 * would, and then redirects the browser back to the success URL.
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const stripe = require(path.join(DIST, 'integrations', 'stripe.js'));
const coinbase = require(path.join(DIST, 'integrations', 'coinbaseCommerce.js'));

const FAKE_PORT = Number(process.env.FAKE_PROVIDER_PORT || 4242);
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;

/** Everything the fake has been asked for, so a test can assert on it. */
const ledger = {
  sessions: [],
  charges: [],
  refunds: [],
  webhooks: [],
  intents: [],
  customers: [],
  detached: [],
};
const byId = new Map();

let counter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}${(counter += 1)}`;

stripe.createCheckoutSession = async (input) => {
  const id = nextId('cs_test');
  const record = { ...input, id, provider: 'stripe' };
  byId.set(id, record);
  ledger.sessions.push(record);
  /*
   * Elements mode: a client secret, not a URL.
   *
   * The real Payment Element is an iframe served by Stripe and cannot be
   * driven offline, so the hosted page below stands in for it. What it
   * reproduces faithfully is the part that matters to this server: pressing
   * Pay sends a SIGNED webhook, and the browser lands on the return_url.
   */
  return { id, client_secret: `${id}_secret`, url: `http://127.0.0.1:${FAKE_PORT}/checkout/${id}` };
};

stripe.getCheckoutSession = async (id) => {
  const record = byId.get(id);
  return { id, payment_status: 'paid', payment_intent: `pi_${id}`, metadata: record ? { paymentId: record.paymentId } : {} };
};

stripe.refundPaymentIntent = async (intent, paymentId) => {
  ledger.refunds.push({ intent, paymentId });
};

/* ------------------------------------------------------------ saved cards */

/*
 * The customer and payment-method side of Stripe.
 *
 * Kept as simple as it can be while still being wrong in the ways Stripe is
 * wrong: a saved-card charge returns a PAYMENT INTENT (`pi_`) and not a
 * session, so `provider_ref` holds two id spaces and anything that confuses
 * them breaks here rather than in production. The intent's webhook is
 * delivered on a tick of its own, because Stripe's arrives over a separate
 * connection and can beat or trail the HTTP response - a fake that settles
 * inline would hide every ordering bug this server has to survive.
 */
const customers = new Map();
const methods = new Map();

/** A card that exists at the fake provider, so a session can "save" it. */
function fakeCard(id) {
  if (!methods.has(id)) {
    methods.set(id, {
      id,
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 },
    });
  }
  return methods.get(id);
}

stripe.createCustomer = async (input) => {
  // Idempotent per account, exactly as the real one is through its key: two
  // tabs racing must not produce two customers holding half the cards each.
  const existing = customers.get(input.userId);
  if (existing) return { id: existing };
  const id = nextId('cus_test');
  customers.set(input.userId, id);
  ledger.customers.push({ id, userId: input.userId, email: input.email });
  return { id };
};

stripe.getPaymentIntent = async (intentId) => {
  /*
   * A session's intent is `pi_<sessionId>`, which is what getCheckoutSession
   * hands back, so the record behind it may be the session rather than an
   * intent of its own. Either way a payment method comes with it, so a card
   * can be recorded for reuse.
   */
  const record = byId.get(intentId) ?? byId.get(intentId.replace(/^pi_/, ''));
  const method = fakeCard(`pm_${intentId}`);
  return {
    id: intentId,
    status: 'succeeded',
    amount_received: record ? record.amountCents : undefined,
    currency: record ? record.currency : undefined,
    payment_method: method.id,
    /*
     * The buyer's own answer, coming back.
     *
     * Stripe copies `payment_intent_data.setup_future_usage` from the session
     * onto the intent, and the server reads it as consent to keep the card.
     * A fake that always returned it would hide the difference between a
     * buyer who ticked the box and one who did not - which is the whole
     * question this field answers.
     */
    setup_future_usage: record && record.saveCard ? 'off_session' : null,
  };
};

stripe.getPaymentMethod = async (methodId) => fakeCard(methodId);

stripe.detachPaymentMethod = async (methodId) => {
  methods.delete(methodId);
  ledger.detached.push(methodId);
};

stripe.chargeSavedCard = async (input) => {
  const id = nextId('pi_test');
  const record = { ...input, id, provider: 'stripe', kind: 'intent' };
  byId.set(id, record);
  ledger.intents.push(record);

  /*
   * Off session, so there is nobody to challenge - unless the test asks for
   * one. `FAKE_REQUIRE_ACTION=1` makes every saved-card charge come back
   * `requires_action`, which is the branch that hands a client secret to the
   * browser instead of waiting for a webhook.
   */
  if (process.env.FAKE_REQUIRE_ACTION === '1') {
    return { id, status: 'requires_action', client_secret: `${id}_secret`, currency: input.currency };
  }

  // Out of band, like the real thing. Failures are logged and not thrown: a
  // webhook that cannot be delivered is the provider's problem, not the
  // caller's, and throwing here would mark a charge failed that succeeded.
  setTimeout(() => {
    deliver(record, 'paid').catch((error) => {
      console.warn('[fake-provider] could not deliver an intent webhook', error);
    });
  }, 25);

  return { id, status: 'succeeded', amount_received: input.amountCents, currency: input.currency };
};

coinbase.createCharge = async (input) => {
  const code = nextId('CHG');
  const record = { ...input, id: code, provider: 'coinbase' };
  byId.set(code, record);
  ledger.charges.push(record);
  return { code, hosted_url: `http://127.0.0.1:${FAKE_PORT}/checkout/${code}` };
};

coinbase.getCharge = async (code) => ({ code, timeline: [] });

/* ------------------------------------------------------- the hosted page */

function stripeIntentEvent(record, type) {
  return JSON.stringify({
    id: nextId('evt'),
    type,
    data: {
      object: {
        id: record.id,
        // What the intent branch reads. `amount_received` and not
        // `amount_total`: the two events carry the figure under different
        // names, and reading the wrong one settles at zero.
        amount_received: type === 'payment_intent.succeeded' ? record.amountCents : 0,
        currency: record.currency,
        status: type === 'payment_intent.succeeded' ? 'succeeded' : 'requires_payment_method',
        /*
         * The metadata a real intent carries, INCLUDING the payment id.
         *
         * The server deliberately does not read it - an intent is settled by
         * provider reference alone, because an embedded checkout emits this
         * event too and its metadata names a payment already settled through
         * the session. Sending it anyway is what makes that hold provable
         * rather than merely stated.
         */
        metadata: { paymentId: record.paymentId, reference: record.reference, flow: 'saved-card' },
      },
    },
  });
}

function stripeEvent(record, type) {
  return JSON.stringify({
    id: nextId('evt'),
    type,
    data: {
      object: {
        id: record.id,
        payment_status: type === 'checkout.session.completed' ? 'paid' : 'unpaid',
        amount_total: record.amountCents,
        currency: record.currency,
        // The customer details a real Stripe event carries, so the redaction
        // this server does on the way into the database has something to bite.
        customer_email: 'e2e-buyer@example.com',
        customer_details: { email: 'e2e-buyer@example.com', address: { line1: '1 Test Street' } },
        metadata: { paymentId: record.paymentId, reference: record.reference },
      },
    },
  });
}

function coinbaseEvent(record, type) {
  return JSON.stringify({
    event: {
      id: nextId('cbevt'),
      type,
      data: {
        code: record.id,
        pricing: { local: { amount: (record.amountCents / 100).toFixed(2), currency: record.currency.toUpperCase() } },
        metadata: { paymentId: record.paymentId, reference: record.reference },
      },
    },
  });
}

async function deliver(record, outcome, replayBody = null) {
  const isStripe = record.provider === 'stripe';
  // A saved-card charge is an intent, and intents have their own event names.
  const isIntent = record.kind === 'intent';
  const type = isStripe
    ? isIntent
      ? outcome === 'paid'
        ? 'payment_intent.succeeded'
        : 'payment_intent.payment_failed'
      : outcome === 'paid'
        ? 'checkout.session.completed'
        : 'checkout.session.expired'
    : outcome === 'paid'
      ? 'charge:confirmed'
      : 'charge:expired';

  const body =
    replayBody ??
    (isStripe
      ? isIntent
        ? stripeIntentEvent(record, type)
        : stripeEvent(record, type)
      : coinbaseEvent(record, type));
  record.lastBody = body;
  const headers = { 'content-type': 'application/json' };

  if (isStripe) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET || '')
      .update(`${timestamp}.${body}`)
      .digest('hex');
    headers['stripe-signature'] = `t=${timestamp},v1=${signature}`;
  } else {
    headers['x-cc-webhook-signature'] = crypto
      .createHmac('sha256', process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '')
      .update(body)
      .digest('hex');
  }

  const url = `${BACKEND}/api/payments/webhook/${isStripe ? 'stripe' : 'coinbase'}`;
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  ledger.webhooks.push({ url, status: response.status, body: text, type });
  return { status: response.status, text };
}

const PAGE = (record, note = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>Fake provider checkout</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#f6f7f9}
.card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 8px rgba(0,0,0,.1);max-width:420px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;cursor:pointer;margin-right:8px}
.pay{background:#635bff;color:#fff}.cancel{background:#eee}
code{background:#f0f0f4;padding:2px 5px;border-radius:4px}</style></head>
<body><div class="card">
<h1>Fake ${record.provider} checkout</h1>
<p><strong>${record.credits} credits</strong> for ${(record.amountCents / 100).toFixed(2)} ${record.currency.toUpperCase()}</p>
<p>Reference <code id="reference">${record.reference}</code></p>
<p style="color:#666">${note}</p>
<form method="POST" action="/pay/${record.id}"><button class="pay" id="pay" type="submit">Pay</button></form>
<form method="POST" action="/cancel/${record.id}"><button class="cancel" id="cancel" type="submit">Cancel</button></form>
</div></body></html>`;

http
  .createServer(async (req, res) => {
    const [, action, id] = req.url.split('?')[0].split('/');
    const record = byId.get(id || '');

    if (action === 'state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ledger));
      return;
    }
    if (!record) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such checkout');
      return;
    }
    if (action === 'checkout') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(record));
      return;
    }
    if (action === 'replay') {
      // What a provider's retry is: the SAME event, signed afresh. A new
      // signature every attempt, but one event id - which is the thing the
      // server is supposed to recognise.
      const result = await deliver(record, 'paid', record.lastBody);
      console.log(`[fake-provider] replay ${record.reference} -> webhook ${result.status} ${result.text}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(result.text);
      return;
    }
    if (action === 'pay' || action === 'cancel') {
      const outcome = action === 'pay' ? 'paid' : 'expired';
      const result = await deliver(record, outcome);
      const target =
      action === 'pay'
        ? record.returnUrl || record.successUrl || record.redirectUrl
        : record.cancelUrl;
      console.log(`[fake-provider] ${action} ${record.reference} -> webhook ${result.status}`);

      /*
       * There is not always somewhere to go.
       *
       * With the form embedded, a Stripe session has no cancel URL at all -
       * cancelling is simply not confirming, and the customer never left our
       * page to begin with. The session still expires and still fires its
       * webhook, which is the half that matters here.
       */
      if (!target) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcome, webhook: result.status }));
        return;
      }
      res.writeHead(303, { location: target });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(FAKE_PORT, '127.0.0.1', () => {
    console.log(`[fake-provider] listening on http://127.0.0.1:${FAKE_PORT}`);
  });

module.exports = { ledger };

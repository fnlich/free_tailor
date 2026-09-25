import { Router, type Request, type Response } from 'express';

import {
  canVerifyStripeWebhooks,
  stripeWebhookSecret,
  verifyStripeSignature,
} from '../integrations/stripe';
import {
  canVerifyCryptomusWebhooks,
  cryptomusPaymentKey,
  verifyWebhookSign,
  FAILED_STATUSES,
  PAID_STATUSES,
} from '../integrations/cryptomus';
import {
  recordSavedCardFromSession,
  settleWebhookEvent,
  type PaymentProvider,
  type WebhookOutcome,
} from '../services/payments';

/**
 * The only thing in this application that adds credits to an account.
 *
 * Not the browser returning to a success page: a success URL is a GET anybody
 * can visit, so a checkout that credited on redirect would be a free-credits
 * button with an inconvenient URL. Everything here is reachable only by a
 * request carrying a signature over bytes this server never generated.
 *
 * Three properties this router has to keep, in order of how badly each fails:
 *
 *  1. **Verify before reading.** The body is untrusted until the signature
 *     checks out, and it is verified against the RAW bytes - which is why this
 *     router is mounted with `express.raw` AHEAD of the app-wide JSON parser in
 *     index.ts. Re-serializing a parsed body gives a string that is usually
 *     identical to what was signed, and "usually" is not a security property.
 *
 *     Cryptomus is the exception, and it is the provider's design rather than
 *     a corner cut here: it puts its signature INSIDE the JSON as a `sign`
 *     field, so there is no way to check it without parsing first and
 *     re-serializing what is left. That is confined to `verifyWebhookSign` in
 *     `integrations/cryptomus.ts`, which explains what makes it survivable and
 *     names the one way it is known to break. Nothing below acts on a
 *     Cryptomus body until that function has returned ok, and the payload
 *     recorded is still the raw bytes.
 *
 *  2. **Once.** A provider guarantees at-least-once delivery and retries until
 *     it gets a 2xx. `recordEventOnce` turns the second delivery into a no-op
 *     on a UNIQUE index, and the ledger's own key would stop it again.
 *
 *  3. **Answer 2xx for anything understood.** An event for a payment this
 *     server has never heard of, or a type it does not act on, is acknowledged
 *     and dropped. Returning 500 to those makes the provider retry them for
 *     days and eventually disable the endpoint - taking the events that DO
 *     matter with it.
 *
 * There is no `requireUser` here, and there cannot be: the caller is Stripe.
 * The signature is the authentication. It passes the app's CORS gate because
 * `isOriginAllowed` returns true when there is no `Origin` header, which a
 * server-to-server POST does not send.
 */

/**
 * The intent events a saved-card charge produces.
 *
 * `payment_intent.canceled` is here with the failures: an intent Stripe gave
 * up on is a payment that will not arrive, and leaving it pending would keep a
 * row waiting for a webhook that is never coming.
 */
const INTENT_TYPES = new Set([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
]);

const router = Router();

/** Express gives a Buffer here only because of the `express.raw` mount. */
function rawBodyOf(req: Request): Buffer | null {
  return Buffer.isBuffer(req.body) ? req.body : null;
}

function headerValue(req: Request, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

/**
 * Logged, then acknowledged.
 *
 * A webhook whose body is unreadable is not worth a retry - the next delivery
 * will be the same bytes - so it is recorded in the log and answered 200. The
 * log line is the only place this can ever be seen.
 */
function acknowledge(res: Response, reason: string): void {
  res.status(200).json({ received: true, note: reason });
}

type Handled = {
  provider: PaymentProvider;
  eventId: string;
  type: string;
  providerRef: string;
  paymentIdHint?: string;
  outcome: WebhookOutcome;
  paidAmountCents?: number;
  paidCurrency?: string;
};

/**
 * Applies a decided event, whichever provider it came from.
 *
 * Shared because the two providers differ only in how an event is parsed and
 * proven; what happens next - find the payment, credit it or close it - is the
 * same, and two copies of the crediting logic is two places to get it wrong.
 *
 * The work itself is one transaction in the service, so that recording the
 * event and acting on it commit together. This function only decides what to
 * say about the result.
 */
function apply(event: Handled, rawBody: Buffer, res: Response): void {
  const settlement = settleWebhookEvent({
    provider: event.provider,
    eventId: event.eventId,
    type: event.type,
    providerRef: event.providerRef,
    ...(event.paymentIdHint ? { paymentIdHint: event.paymentIdHint } : {}),
    outcome: event.outcome,
    ...(typeof event.paidAmountCents === 'number'
      ? { paidAmountCents: event.paidAmountCents }
      : {}),
    ...(event.paidCurrency ? { paidCurrency: event.paidCurrency } : {}),
    payload: rawBody.toString('utf8'),
  });

  if (settlement.status === 'replayed') {
    acknowledge(res, 'already handled');
    return;
  }
  if (settlement.status === 'unknown') {
    acknowledge(res, 'no matching payment');
    return;
  }
  if (settlement.status === 'mismatch') {
    // 200: the event was understood and is not going to be understood any
    // better on a retry. It is recorded, logged, and left for a person.
    acknowledge(res, 'amount does not match');
    return;
  }

  const payment = settlement.payment;
  if (payment && event.outcome === 'paid') {
    console.log(
      `[payments] ${payment.reference}: ${event.type} -> ` +
        (settlement.credited ? `${payment.creditsGranted} credits added` : 'already settled')
    );

    /*
     * Now that the money is accounted for, see whether a card was kept.
     *
     * After the transaction, deliberately: it is synchronous by design and this
     * is two network calls. Not awaited either - the provider is waiting for a
     * 200 and this is a convenience for the buyer's next purchase, so it must
     * never be able to delay or fail the acknowledgement.
     */
    if (settlement.credited) {
      void recordSavedCardFromSession(payment);
    }
  }

  acknowledge(res, 'handled');
}

/**
 * Stripe.
 *
 * `checkout.session.completed` with a paid status is the event that matters.
 * `async_payment_succeeded` is its slower twin for the payment methods that
 * settle later, and it has to be honoured or those customers never get what
 * they bought.
 */
router.post('/stripe', (req: Request, res: Response) => {
  // Only the webhook secret, not the whole card configuration: see the note on
  // canVerifyStripeWebhooks. An endpoint that 503s is an endpoint Stripe stops
  // delivering to, and the events it stops delivering credit paying customers.
  if (!canVerifyStripeWebhooks()) {
    res.status(503).json({ error: 'Card payments are not configured on this server.' });
    return;
  }

  const rawBody = rawBodyOf(req);
  if (!rawBody) {
    console.error('[payments] The Stripe webhook did not receive a raw body; check the route mount.');
    res.status(400).json({ error: 'Expected a raw body.' });
    return;
  }

  if (!verifyStripeSignature(rawBody, headerValue(req, 'stripe-signature'), stripeWebhookSecret())) {
    // 400, not 200: this one IS worth telling Stripe about, because a failing
    // signature means the secrets disagree and every event is being dropped.
    console.warn('[payments] A Stripe webhook failed signature verification and was refused.');
    res.status(400).json({ error: 'Signature verification failed.' });
    return;
  }

  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    acknowledge(res, 'unreadable body');
    return;
  }

  const object = event.data?.object ?? {};
  const sessionId = typeof object.id === 'string' ? object.id : '';
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  const type = event.type ?? '';

  /*
   * A payment intent, which is how a saved card reports itself.
   *
   * Charging a card off-session never produces a `checkout.session.completed`
   * - there is no session - so these types are the only word we get for that
   * flow, and `provider_ref` holds the `pi_` rather than a `cs_`.
   *
   * The rule that keeps the two flows apart: AN INTENT EVENT SETTLES ONLY BY
   * PROVIDER REFERENCE, and its metadata hint is deliberately not passed.
   * An ordinary embedded-checkout payment also emits `payment_intent.succeeded`
   * for the same money, carrying `metadata.paymentId` (the session copies it
   * onto the intent) but an id that is NOT in `provider_ref`. Passing the hint
   * would let that event find the payment, be recorded as a second event, and
   * put an "already settled" line in the log for every single card sale. With
   * the hint withheld it resolves to no payment and is acknowledged as a
   * stranger's event, which is what it is.
   */
  if (INTENT_TYPES.has(type)) {
    if (!event.id) {
      acknowledge(res, 'not an event this server acts on');
      return;
    }

    apply(
      {
        provider: 'stripe',
        eventId: event.id,
        type,
        providerRef: sessionId,
        outcome: type === 'payment_intent.succeeded' ? 'paid' : 'failed',
        // `amount_received` is what actually cleared, in the smallest currency
        // unit - the comparable figure, where `amount` is only what was asked.
        ...(typeof object.amount_received === 'number'
          ? { paidAmountCents: object.amount_received }
          : {}),
        ...(typeof object.currency === 'string' ? { paidCurrency: object.currency } : {}),
      },
      rawBody,
      res
    );
    return;
  }

  const outcome: Handled['outcome'] =
    (type === 'checkout.session.completed' && object.payment_status === 'paid') ||
    type === 'checkout.session.async_payment_succeeded'
      ? 'paid'
      : type === 'checkout.session.async_payment_failed'
        ? 'failed'
        : type === 'checkout.session.expired'
          ? 'expired'
          : 'ignore';

  if (outcome === 'ignore' || !event.id) {
    acknowledge(res, 'not an event this server acts on');
    return;
  }

  apply(
    {
      provider: 'stripe',
      eventId: event.id,
      type,
      providerRef: sessionId,
      ...(metadata.paymentId ? { paymentIdHint: metadata.paymentId } : {}),
      outcome,
      // `amount_total` is already in the smallest currency unit, which is what
      // the payment row stores, so these are comparable without arithmetic.
      ...(typeof object.amount_total === 'number'
        ? { paidAmountCents: object.amount_total }
        : {}),
      ...(typeof object.currency === 'string' ? { paidCurrency: object.currency } : {}),
    },
    rawBody,
    res
  );
});

/**
 * Cryptomus.
 *
 * Two things here are unlike the handlers above, and both are the provider's:
 *
 *  1. **The signature is in the body**, not a header - see the note on rule 1.
 *  2. **There is no event id.** Every other provider sends an opaque id that
 *     `recordEventOnce` dedupes on; Cryptomus sends none at all. So one is
 *     built from the invoice and the status it is reporting. That is exactly
 *     the right granularity: a retry of the same status - and Cryptomus retries
 *     until it gets a 2xx - collapses onto the row already written, while the
 *     genuine progression from `check` to `paid` is two different events and
 *     gets recorded as two. A random id would defeat the UNIQUE index that is
 *     the only thing standing between a retry and double credit; the uuid
 *     alone would swallow the `paid` that follows a `check`.
 */
router.post('/cryptomus', (req: Request, res: Response) => {
  if (!canVerifyCryptomusWebhooks()) {
    res.status(503).json({ error: 'Crypto payments are not configured on this server.' });
    return;
  }

  const rawBody = rawBodyOf(req);
  if (!rawBody) {
    console.error('[payments] The Cryptomus webhook did not receive a raw body; check the route mount.');
    res.status(400).json({ error: 'Expected a raw body.' });
    return;
  }

  const verified = verifyWebhookSign(rawBody, cryptomusPaymentKey());
  if (!verified.ok || !verified.body) {
    // 400 rather than 200, as for Stripe: a signature that does not check out
    // means the key here and the key there disagree, and EVERY event is being
    // dropped. That is worth a retry and worth seeing in Cryptomus's own log.
    console.warn('[payments] A Cryptomus webhook failed signature verification and was refused.');
    res.status(400).json({ error: 'Signature verification failed.' });
    return;
  }

  const body = verified.body;
  const uuid = typeof body.uuid === 'string' ? body.uuid : '';
  const status = typeof body.status === 'string' ? body.status : '';

  const outcome: Handled['outcome'] = PAID_STATUSES.has(status)
    ? 'paid'
    : FAILED_STATUSES.has(status)
      ? 'failed'
      : 'ignore';

  if (outcome === 'ignore' || !uuid || !status) {
    // `check`, `process`, `confirm_check` - the money is on its way and is not
    // credited until it has arrived. Acknowledged so it is not retried.
    acknowledge(res, 'not an event this server acts on');
    return;
  }

  /*
   * `amount`, deliberately - not `payment_amount`.
   *
   * `amount` is the invoice in the merchant's own currency, which is the
   * figure the payment row stores in minor units and the only one comparable
   * to it. `payment_amount` is denominated in whichever coin the buyer chose,
   * so comparing it to a dollar total would reject every correct payment.
   * Rounded rather than truncated, because 12.50 is not exactly representable
   * and truncating it rejects a payment that was exactly right.
   */
  const paidCents =
    typeof body.amount === 'string' && body.amount.trim() !== ''
      ? Math.round(Number.parseFloat(body.amount) * 100)
      : Number.NaN;

  apply(
    {
      provider: 'cryptomus',
      eventId: `${uuid}:${status}`,
      type: `payment.${status}`,
      providerRef: uuid,
      ...(typeof body.order_id === 'string' && body.order_id
        ? { paymentIdHint: body.order_id }
        : {}),
      outcome,
      ...(Number.isFinite(paidCents) ? { paidAmountCents: paidCents } : {}),
      ...(typeof body.currency === 'string' ? { paidCurrency: body.currency } : {}),
    },
    rawBody,
    res
  );
});

export default router;

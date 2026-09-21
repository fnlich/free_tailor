import { Router, type Request, type Response } from 'express';

import {
  canVerifyStripeWebhooks,
  stripeWebhookSecret,
  verifyStripeSignature,
} from '../integrations/stripe';
import {
  canVerifyCoinbaseWebhooks,
  coinbaseWebhookSecret,
  verifyCoinbaseSignature,
} from '../integrations/coinbaseCommerce';
import {
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
        (settlement.credited ? `${payment.credits} credits added` : 'already settled')
    );
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
 * Coinbase Commerce.
 *
 * `charge:confirmed`, and only that. `charge:pending` means the transaction is
 * on the chain and not yet confirmed - crediting there would hand out credits
 * for a payment that can still be reorganised away.
 */
router.post('/coinbase', (req: Request, res: Response) => {
  if (!canVerifyCoinbaseWebhooks()) {
    res.status(503).json({ error: 'Crypto payments are not configured on this server.' });
    return;
  }

  const rawBody = rawBodyOf(req);
  if (!rawBody) {
    console.error('[payments] The Coinbase webhook did not receive a raw body; check the route mount.');
    res.status(400).json({ error: 'Expected a raw body.' });
    return;
  }

  if (
    !verifyCoinbaseSignature(
      rawBody,
      headerValue(req, 'x-cc-webhook-signature'),
      coinbaseWebhookSecret()
    )
  ) {
    console.warn('[payments] A Coinbase webhook failed signature verification and was refused.');
    res.status(400).json({ error: 'Signature verification failed.' });
    return;
  }

  let body: { event?: { id?: string; type?: string; data?: Record<string, unknown> } };
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    acknowledge(res, 'unreadable body');
    return;
  }

  const event = body.event ?? {};
  const charge = (event.data ?? {}) as Record<string, unknown>;
  const code = typeof charge.code === 'string' ? charge.code : '';
  const metadata = (charge.metadata ?? {}) as Record<string, string>;
  const type = event.type ?? '';

  const outcome: Handled['outcome'] =
    type === 'charge:confirmed'
      ? 'paid'
      : type === 'charge:failed'
        ? 'failed'
        : type === 'charge:expired'
          ? 'expired'
          : 'ignore';

  if (outcome === 'ignore' || !event.id) {
    acknowledge(res, 'not an event this server acts on');
    return;
  }

  const local = ((charge.pricing ?? {}) as Record<string, unknown>).local as
    | { amount?: string; currency?: string }
    | undefined;
  // Coinbase quotes a decimal string in the local currency ("12.50"), not
  // minor units, so this is the one place a conversion happens - rounded, not
  // truncated, because 12.50 is not exactly representable.
  const paidCents =
    local && typeof local.amount === 'string' && local.amount.trim() !== ''
      ? Math.round(Number.parseFloat(local.amount) * 100)
      : Number.NaN;

  apply(
    {
      provider: 'coinbase',
      eventId: String(event.id),
      type,
      providerRef: code,
      ...(metadata.paymentId ? { paymentIdHint: metadata.paymentId } : {}),
      outcome,
      ...(Number.isFinite(paidCents) ? { paidAmountCents: paidCents } : {}),
      ...(local && typeof local.currency === 'string' ? { paidCurrency: local.currency } : {}),
    },
    rawBody,
    res
  );
});

export default router;

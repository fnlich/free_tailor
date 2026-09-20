import { applyAdjustment } from '../../database/creditRepository';
import { getDb } from '../../database/sqlite';
import { getUserById } from '../../database/userRepository';
import {
  attachProviderRef,
  beginRefund,
  countPaymentsSince,
  createPayment,
  getPayment,
  getPaymentByProviderRef,
  markPaid,
  markRefunded,
  markUnpaid,
  recordEventOnce,
  releaseRefund,
  type Payment,
  type PaymentMethod,
  type PaymentProvider,
} from '../../database/paymentRepository';
import type { UserAccount } from '../../types/account';
import * as stripe from '../../integrations/stripe';
import * as coinbase from '../../integrations/coinbaseCommerce';
import { PriceError, quoteCredits } from './pricing';

/**
 * Buying credits.
 *
 * One rule shapes everything here: **only a verified webhook credits an
 * account.** The browser coming back to a success URL credits nothing, because
 * anybody can visit a success URL - it is a GET with no secret in it. So
 * `startCheckout` creates a pending payment and a redirect, and `creditPaid`
 * is reachable only from a request that carried a valid provider signature.
 *
 * The second rule follows from the first: a webhook may arrive twice, out of
 * order, or after the payment has already been decided. Every state change here
 * is conditional, and the credit itself carries a deterministic idempotency key
 * so that the ledger refuses a second helping even if everything above it
 * fails at once.
 */

export type MethodAvailability = {
  method: PaymentMethod;
  provider: PaymentProvider;
  label: string;
  available: boolean;
  /** Why it is not on offer, in words a person can act on. */
  reason?: string;
};

export function describeMethods(env: NodeJS.ProcessEnv = process.env): MethodAvailability[] {
  const card = stripe.isStripeConfigured(env);
  const crypto = coinbase.isCoinbaseConfigured(env);
  return [
    {
      method: 'card',
      provider: 'stripe',
      label: 'Credit or debit card',
      available: card,
      ...(card
        ? {}
        : { reason: 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to take card payments.' }),
    },
    {
      method: 'crypto',
      provider: 'coinbase',
      label: 'Crypto',
      available: crypto,
      ...(crypto
        ? {}
        : {
            reason:
              'Set COINBASE_COMMERCE_API_KEY and COINBASE_COMMERCE_WEBHOOK_SECRET to take crypto.',
          }),
    },
  ];
}

export class PaymentError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PaymentError';
    this.status = status;
  }
}

/**
 * Where the browser comes back to.
 *
 * `PAYMENTS_RETURN_URL` when set, otherwise the first configured frontend
 * origin. It has to be absolute and it has to be the FRONTEND: a provider
 * redirects a person's browser there, and sending them to the API would show
 * them JSON.
 */
export function returnBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PAYMENTS_RETURN_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const frontend = env.FRONTEND_URL?.split(',')[0]?.trim();
  if (frontend) return frontend.replace(/\/+$/, '');

  const port = env.FRONTEND_PORT?.trim() || '3000';
  return `http://localhost:${port}`;
}

export type StartedCheckout = { payment: Payment; redirectUrl: string };

/** How many checkouts one account may open in an hour. */
const MAX_CHECKOUTS_PER_WINDOW = 20;
const CHECKOUT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Prices the request, records it, and asks the provider for a checkout.
 *
 * In that order, and the order matters: the payment row exists before the
 * provider is told anything, so a webhook that beats the response back has
 * somewhere to land. The alternative - create at the provider, then record -
 * has a window in which money can be taken for a payment this server has never
 * heard of.
 */
export async function startCheckout(
  account: UserAccount,
  method: unknown,
  requestedCredits: unknown,
  env: NodeJS.ProcessEnv = process.env
): Promise<StartedCheckout> {
  if (method !== 'card' && method !== 'crypto') {
    throw new PaymentError('Choose a payment method.');
  }

  const availability = describeMethods(env).find((entry) => entry.method === method);
  if (!availability?.available) {
    throw new PaymentError(
      method === 'card'
        ? 'Card payments are not set up on this server.'
        : 'Crypto payments are not set up on this server.',
      503
    );
  }

  /*
   * A ceiling on how often one account may open a checkout.
   *
   * Every checkout is a call to Stripe or Coinbase, so an endpoint that any
   * signed-in account can loop is an endpoint that runs up somebody else's
   * provider bill and fills the payments table with rows nobody will ever pay.
   * Abandoning a checkout is normal, so the limit is generous - it is here to
   * stop a loop, not to scold somebody who changed their mind twice.
   */
  const since = new Date(Date.now() - CHECKOUT_WINDOW_MS).toISOString();
  if (countPaymentsSince(account.id, since) >= MAX_CHECKOUTS_PER_WINDOW) {
    throw new PaymentError(
      'Too many checkouts started in the last hour. Finish or abandon one, then try again.',
      429
    );
  }

  // The browser sent a COUNT. The price is worked out here, from settings, and
  // an `amount` in the request body is never read.
  const quote = await quoteCredits(requestedCredits);

  const payment = createPayment({
    userId: account.id,
    method,
    provider: availability.provider,
    credits: quote.credits,
    amountCents: quote.amountCents,
    currency: quote.currency,
    unitPriceCents: quote.unitPriceCents,
  });

  const base = returnBaseUrl(env);
  const successUrl = `${base}/credits/return?payment=${encodeURIComponent(payment.id)}`;
  const cancelUrl = `${base}/credits?cancelled=${encodeURIComponent(payment.id)}`;

  /*
   * Only a refusal BY THE PROVIDER closes the payment.
   *
   * The distinction matters more than it looks. If the checkout page was
   * created and something after it throws - a socket dropped while reading the
   * response, a database write - then a live session exists at the provider
   * with this payment's id on it, and somebody may still pay it. Marking it
   * `failed` here would mean the webhook for that payment arrives, finds a row
   * that is not `pending`, and credits nothing: money taken, nothing given.
   * So the catch that closes a payment wraps the provider call and nothing
   * else.
   */
  const opened = await (async () => {
    try {
      if (method === 'card') {
        const session = await stripe.createCheckoutSession({
          paymentId: payment.id,
          reference: payment.reference,
          credits: quote.credits,
          amountCents: quote.amountCents,
          currency: quote.currency,
          customerEmail: account.email,
          successUrl,
          cancelUrl,
        });
        return { ref: session.id, url: session.url ?? '' };
      }

      const charge = await coinbase.createCharge({
        paymentId: payment.id,
        reference: payment.reference,
        credits: quote.credits,
        amountCents: quote.amountCents,
        currency: quote.currency,
        redirectUrl: successUrl,
        cancelUrl,
      });
      return { ref: charge.code, url: charge.hosted_url ?? '' };
    } catch (error) {
      /*
       * The detail goes to the log, and a fixed sentence goes in the row.
       *
       * A provider's own error text quotes back what it was sent, including
       * the tail of the API key it was sent with, and `failure` is served to
       * the person who clicked Buy. An operator's misconfiguration must not
       * become a customer's view of a secret.
       */
      console.error(`[payments] ${payment.reference}: the provider refused to open a checkout.`, error);
      markUnpaid(payment.id, 'failed', 'The payment provider would not open a checkout page.');
      throw new PaymentError(
        'The payment provider would not open a checkout page. Try again in a moment.',
        502
      );
    }
  })();

  if (!opened.url) {
    // A session may exist without a usable URL, so this payment is NOT closed:
    // see the note above. It simply cannot be sent anywhere.
    console.error(`[payments] ${payment.reference}: the provider returned no checkout URL.`);
    throw new PaymentError('The payment provider did not return a checkout page.', 502);
  }

  if (opened.ref && !attachProviderRef(payment.id, opened.ref)) {
    // Not fatal, and not silent. A reference that will not attach means one is
    // already there, which is the only case the condition refuses.
    console.warn(
      `[payments] ${payment.reference}: a provider reference was already recorded; keeping it.`
    );
  }

  return { payment: getPayment(payment.id) ?? payment, redirectUrl: opened.url };
}

export type CreditOutcome = { credited: boolean; payment: Payment | null };

/**
 * Turns a paid payment into credits, exactly once.
 *
 * Three guards, deliberately stacked rather than chosen between:
 *
 *  1. `markPaid` is `WHERE state = 'pending'`, so only the first call proceeds;
 *  2. the caller has already refused a duplicate provider event id;
 *  3. the ledger key is `purchase:<paymentId>`, so even if both of those were
 *     somehow bypassed the money still cannot move twice.
 *
 * Any one of them would usually do. All three are here because the failure this
 * prevents is giving away credits, and the cost of the extra two is a comment
 * longer than the code.
 */
export function creditPaid(paymentId: string): CreditOutcome {
  const payment = getPayment(paymentId);
  if (!payment) return { credited: false, payment: null };
  if (payment.state !== 'pending') return { credited: false, payment };

  if (!markPaid(payment.id)) {
    return { credited: false, payment: getPayment(paymentId) };
  }

  // `applied` rather than an assumption: the ledger refuses a key it has
  // already used, and a caller that reported success anyway would put a line
  // in the log saying credits were added when none were.
  const { applied } = applyAdjustment({
    userId: payment.userId,
    delta: payment.credits,
    reason: 'purchase',
    idempotencyKey: `purchase:${payment.id}`,
    note: `${payment.reference} - ${payment.credits} credits`,
  });

  return { credited: applied, payment: getPayment(paymentId) };
}

export type RefundOutcome = {
  payment: Payment;
  creditsSold: number;
  creditsReversed: number;
  /** Credits that could not be taken back because they were already spent. */
  shortfall: number;
};

/**
 * Refunds a payment at the provider and reverses what credits remain.
 *
 * The honest part, and the reason this returns three numbers rather than a
 * boolean: a balance may not go negative, so refunding somebody who has already
 * spent what they bought returns all of their money and reverses only what is
 * left. `applyAdjustment` clamps the negative delta at zero for exactly that
 * reason. Reporting the difference is the point - a refund that silently
 * reverses forty of two hundred credits is a number that does not add up, and
 * whoever pressed the button deserves to know before the customer does.
 *
 * The provider is called FIRST. If the refund fails there, nothing local
 * changes and the button can be pressed again; the reverse order would leave a
 * customer with no credits and no money back.
 */
export async function refundPayment(
  paymentId: string,
  actorId: string,
  note = ''
): Promise<RefundOutcome> {
  const payment = getPayment(paymentId);
  if (!payment) throw new PaymentError('That payment was not found.', 404);
  if (payment.state === 'refunded') throw new PaymentError('That payment is already refunded.', 409);
  if (payment.state === 'refunding') {
    throw new PaymentError('That payment is already being refunded.', 409);
  }
  if (payment.state !== 'paid') throw new PaymentError('Only a paid payment can be refunded.', 409);
  if (!payment.providerRef) throw new PaymentError('That payment has no provider reference.', 409);

  /*
   * Claimed before anything is said to the provider.
   *
   * The checks above are a read, and a read is not a claim: two tabs, or two
   * administrators, both see `paid` and both go on. This UPDATE is the
   * decision, because only one of them can change the row. Without it the
   * loser measures a balance the winner has already moved and reports
   * "reversed 0 of 200 - the rest had been spent", which is a false statement
   * about a customer's account made to the person who is about to write to
   * them.
   */
  if (!beginRefund(payment.id)) {
    throw new PaymentError('That payment is already being refunded.', 409);
  }

  try {
    if (payment.provider === 'stripe') {
      const session = await stripe.getCheckoutSession(payment.providerRef);
      const intent =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
      if (!intent) throw new PaymentError('Stripe has no payment to refund for that session.', 409);
      await stripe.refundPaymentIntent(intent, payment.id);
    } else {
      // Coinbase Commerce has no refund API: a chain payment cannot be pulled
      // back, only sent back. Saying so is the only honest answer - the operator
      // returns the funds themselves and this records that they did.
      throw new PaymentError(
        'Crypto payments cannot be refunded automatically. Send the funds back from your ' +
          'Coinbase Commerce account, then adjust the balance from the accounts page.',
        409
      );
    }
  } catch (error) {
    // The money did not move, so the claim goes back and the button works
    // again. Leaving it claimed would strand a refundable payment.
    releaseRefund(payment.id);
    throw error;
  }

  /*
   * Measured, not assumed.
   *
   * `applyAdjustment` reports the balance it ended on and whether it applied,
   * but not how much of a clamped negative it managed to take - and it clamps
   * at zero, so a refund against a spent balance moves less than it was asked
   * to. Reading the balance either side gives the real figure without adding a
   * field to a function four other callers depend on.
   */
  const balanceBefore = getUserById(payment.userId)?.credits ?? 0;
  applyAdjustment({
    userId: payment.userId,
    delta: -payment.credits,
    reason: 'purchase-refund',
    idempotencyKey: `purchase-refund:${payment.id}`,
    actorId,
    note: note.trim() || `${payment.reference} refunded`,
  });
  const balanceAfter = getUserById(payment.userId)?.credits ?? 0;

  const reversed = Math.max(0, balanceBefore - balanceAfter);
  if (!markRefunded(payment.id, reversed)) {
    // The claim above makes this unreachable short of a direct database edit.
    // It is checked rather than assumed because the alternative is reporting a
    // refund that the record does not show.
    console.error(`[payments] ${payment.reference}: the refund could not be recorded.`);
    throw new PaymentError('The refund was made but could not be recorded. Check the provider.', 500);
  }

  return {
    payment: getPayment(paymentId)!,
    creditsSold: payment.credits,
    creditsReversed: reversed,
    shortfall: payment.credits - reversed,
  };
}

export type WebhookOutcome = 'paid' | 'failed' | 'expired' | 'ignore';

export type WebhookEvent = {
  provider: PaymentProvider;
  eventId: string;
  type: string;
  payload: string;
  providerRef: string;
  paymentIdHint?: string;
  outcome: WebhookOutcome;
  /** What the provider says was actually paid, when the event says. */
  paidAmountCents?: number;
  paidCurrency?: string;
};

export type Settlement = {
  /**
   * `replayed` - this exact event has been seen; `unknown` - nothing here is
   * about a payment this server started; `mismatch` - it is about a payment
   * whose amount it does not agree with; `handled` - it was applied.
   */
  status: 'replayed' | 'unknown' | 'mismatch' | 'handled';
  payment: Payment | null;
  credited: boolean;
};

/**
 * Records a webhook and acts on it, both or neither.
 *
 * The transaction is the point, and it is not decoration. Writing the event
 * down first and crediting afterwards looks safer - a crash in between leaves
 * an event that a retry recognises - but that is exactly backwards for the
 * failure that matters: the provider retries, finds the event already
 * recorded, is told 200, and the customer who paid never gets their credits.
 * Committing both together means a failure rolls the event row back with it,
 * so the retry is a first delivery again and lands.
 *
 * Doing it in this order is only safe because crediting twice is impossible
 * anyway: `markPaid` moves a payment out of `pending` in one conditional
 * UPDATE, and the ledger key is `purchase:<paymentId>`. The event row is the
 * third guard, not the only one.
 *
 * Everything inside is synchronous, which is what allows a single
 * better-sqlite3 transaction to cover it. `applyAdjustment` opens its own
 * transaction and nests as a SAVEPOINT.
 */
/**
 * Field names a provider uses for the customer, dropped before the event is
 * stored. Compared case-insensitively, at any depth.
 */
const PERSONAL_FIELDS = new Set([
  'customer_details',
  'customer_email',
  'customer_name',
  'customer_phone',
  'billing_details',
  'billing_address',
  'shipping',
  'shipping_details',
  'receipt_email',
  'address',
  'email',
  'phone',
  'name',
  'tax_ids',
]);

/**
 * Keeps the event, drops the person.
 *
 * An event body is worth storing: it is what this server was told, and a
 * dispute months later is argued from it. What is NOT worth storing is the
 * copy of the customer's name, email, address and card details a provider
 * includes with it - written to a plain file, kept for ever, and never once
 * read by this application. Ids, amounts, currencies and statuses survive;
 * everything that identifies a person is replaced by a marker, so what is left
 * still reads as a record rather than as a gap.
 *
 * A body that will not parse is stored as nothing at all. It cannot be
 * redacted, and storing it unredacted to be helpful is the mistake this
 * function exists to avoid.
 */
export function redactEventPayload(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }

  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = PERSONAL_FIELDS.has(key.toLowerCase()) ? '[redacted]' : scrub(entry);
      }
      return out;
    }
    return value;
  };

  return JSON.stringify(scrub(parsed)).slice(0, 20_000);
}

export function settleWebhookEvent(event: WebhookEvent): Settlement {
  return getDb().transaction((): Settlement => {
    /*
     * By provider reference first, by our own id second.
     *
     * Two routes to the same row because the providers are not consistent
     * about which they quote: the session or charge is the natural key, but an
     * event fired from a dashboard action can carry only the metadata we set.
     * The fallback re-checks the provider, so a hinted id belonging to some
     * other provider's payment cannot be credited by this one.
     */
    const byRef = getPaymentByProviderRef(event.provider, event.providerRef);
    const byHint = event.paymentIdHint ? getPayment(event.paymentIdHint) : null;
    const payment = byRef ?? (byHint && byHint.provider === event.provider ? byHint : null);

    const fresh = recordEventOnce({
      provider: event.provider,
      eventId: event.eventId,
      type: event.type,
      payload: redactEventPayload(event.payload),
      ...(payment ? { paymentId: payment.id } : {}),
    });
    if (!fresh) return { status: 'replayed', payment, credited: false };

    // A charge created from the provider's own dashboard, or a test event.
    // Neither is an error, and the event row above is the record that it came.
    if (!payment) return { status: 'unknown', payment: null, credited: false };

    /*
     * What was paid has to be what was quoted.
     *
     * Nothing today can make these disagree - the amount is set server-side on
     * a Checkout Session and the browser never sends one - but "nothing today"
     * is a property of settings at the provider, not of this code. An operator
     * who turns on promotion codes, or a crypto charge settled short, would
     * otherwise credit the full order for a smaller payment. The payment is
     * left `pending` rather than failed, because somebody has to look at it.
     */
    if (event.outcome === 'paid' && typeof event.paidAmountCents === 'number') {
      const currencyDiffers =
        typeof event.paidCurrency === 'string' &&
        event.paidCurrency.toLowerCase() !== payment.currency.toLowerCase();
      if (event.paidAmountCents !== payment.amountCents || currencyDiffers) {
        console.error(
          `[payments] ${payment.reference}: the provider reported ` +
            `${event.paidAmountCents} ${event.paidCurrency ?? ''} against ` +
            `${payment.amountCents} ${payment.currency}. Nothing was credited.`
        );
        return { status: 'mismatch', payment, credited: false };
      }
    }

    if (event.outcome === 'paid') {
      const result = creditPaid(payment.id);
      return { status: 'handled', payment: result.payment ?? payment, credited: result.credited };
    }
    if (event.outcome === 'failed' || event.outcome === 'expired') {
      /*
       * A sentence, not the event name.
       *
       * `failure` is rendered to the person who tried to pay, on their own
       * return page. "checkout.session.expired" is the provider's vocabulary,
       * not theirs; the event type is already on the payment_events row for
       * whoever needs to reconcile.
       */
      markUnpaid(
        payment.id,
        event.outcome,
        event.outcome === 'expired'
          ? 'That checkout expired before it was paid.'
          : 'The payment did not go through at the provider.'
      );
      return { status: 'handled', payment: getPayment(payment.id), credited: false };
    }
    return { status: 'handled', payment, credited: false };
  })();
}

/** Looks a payment up the way a webhook refers to it: by provider reference. */
export function findByProviderRef(provider: PaymentProvider, providerRef: string): Payment | null {
  return getPaymentByProviderRef(provider, providerRef);
}

export {
  PriceError,
  recordEventOnce,
  markUnpaid,
  getPayment,
  type Payment,
  type PaymentMethod,
  type PaymentProvider,
};

import { applyAdjustment } from '../../database/creditRepository';
import { getUserById } from '../../database/userRepository';
import {
  attachProviderRef,
  createPayment,
  getPayment,
  getPaymentByProviderRef,
  markPaid,
  markRefunded,
  markUnpaid,
  recordEventOnce,
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
      if (!session.url) throw new PaymentError('Stripe did not return a checkout page.', 502);
      attachProviderRef(payment.id, session.id);
      return { payment: getPayment(payment.id) ?? payment, redirectUrl: session.url };
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
    if (!charge.hosted_url) throw new PaymentError('Coinbase did not return a checkout page.', 502);
    attachProviderRef(payment.id, charge.code);
    return { payment: getPayment(payment.id) ?? payment, redirectUrl: charge.hosted_url };
  } catch (error) {
    // The provider refused, so this payment can never be paid. Closing it now
    // keeps it out of the pending list, where it would look like something
    // somebody might still complete.
    markUnpaid(payment.id, 'failed', error instanceof Error ? error.message : 'Checkout failed.');
    throw error;
  }
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

  applyAdjustment({
    userId: payment.userId,
    delta: payment.credits,
    reason: 'purchase',
    idempotencyKey: `purchase:${payment.id}`,
    note: `${payment.reference} - ${payment.credits} credits`,
  });

  return { credited: true, payment: getPayment(paymentId) };
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
  if (payment.state !== 'paid') throw new PaymentError('Only a paid payment can be refunded.', 409);
  if (!payment.providerRef) throw new PaymentError('That payment has no provider reference.', 409);

  if (payment.provider === 'stripe') {
    const session = await stripe.getCheckoutSession(payment.providerRef);
    const intent =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
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
  markRefunded(payment.id, reversed);

  return {
    payment: getPayment(paymentId)!,
    creditsSold: payment.credits,
    creditsReversed: reversed,
    shortfall: payment.credits - reversed,
  };
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

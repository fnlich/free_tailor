import { applyAdjustment } from '../../database/creditRepository';
import { getDb } from '../../database/sqlite';
import {
  claimStripeCustomer,
  getStripeCustomerId,
  getUserById,
} from '../../database/userRepository';
import { getCardForUser, saveCard } from '../../database/savedCardRepository';
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
import { normalizeOrigin, publicBaseUrl } from '../../config/publicUrl';
import { centsToMilli, formatMoney, isWholeCents, milliToCents } from '../../utils/money';
import * as stripe from '../../integrations/stripe';
import * as cryptomus from '../../integrations/cryptomus';
import { PublicError } from '../../middleware/publicError';
import {
  PriceError,
  quotePurchase,
  requireThreeDSecure,
  resolveLimits,
  presetsFor,
  type QuoteTarget,
} from './pricing';

/**
 * Buying credit - which is buying dollars: a purchase of $X credits exactly
 * $X (services/payments/pricing.ts).
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

/** The publishable key the buy page needs, or '' when cards are not set up. */
export function publishableKey(env: NodeJS.ProcessEnv = process.env): string {
  return stripe.isStripeConfigured(env) ? stripe.stripePublishableKey(env) : '';
}

export function describeMethods(env: NodeJS.ProcessEnv = process.env): MethodAvailability[] {
  const card = stripe.isStripeConfigured(env);
  // One way of taking crypto: Cryptomus's hosted invoice.
  const crypto = cryptomus.isCryptomusConfigured(env);
  return [
    {
      method: 'card',
      provider: 'stripe',
      label: 'Credit or debit card',
      available: card,
      ...(card
        ? {}
        : {
            reason:
              'Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PUBLISHABLE_KEY to take ' +
              'card payments.',
          }),
    },
    {
      method: 'crypto',
      provider: 'cryptomus',
      label: 'Crypto',
      available: crypto,
      ...(crypto
        ? {}
        : {
            reason: 'Set CRYPTOMUS_MERCHANT_ID and CRYPTOMUS_PAYMENT_API_KEY to take crypto through Cryptomus.',
          }),
    },
  ];
}

/**
 * A checkout or refund refused in words written for whoever asked: the buyer's
 * own card, amount or limit, or - on the admin-only refund routes - the
 * administrator's. Public, so `sendPublicError` passes it through.
 */
export class PaymentError extends PublicError {
  /** `detail` is the administrator's half, as on PriceError: logged under the ref, never shown to a buyer. */
  constructor(message: string, status = 400, detail?: string) {
    super(message, { status, ...(detail ? { detail } : {}) });
    this.name = 'PaymentError';
  }
}

/**
 * Where the browser comes back to.
 *
 * It has to be absolute and it has to be the FRONTEND: a provider redirects a
 * person's browser there, and sending them to the API would show them JSON.
 *
 * Most card payments never use it - the form confirms in place - but 3-D Secure
 * and every crypto invoice hand the buyer to somebody else's site, and this is
 * where they are sent afterwards. Getting it wrong does not lose the money (the
 * webhook grants the credits either way) but it lands a person who has just
 * paid on a dead page, which they cannot tell apart from having lost it.
 *
 * Most explicit first:
 *
 *   1. PAYMENTS_RETURN_URL - names this exact thing, so nothing outranks it.
 *   2. APP_URL             - names the installation's public address.
 *   3. FRONTEND_URL        - a list of allowed origins; the first is canonical.
 *   4. The origin the buyer's browser is actually on.
 *   5. localhost.
 *
 * Rung 4 is what rescues a domain install where none of the three variables was
 * set, and it is safe BECAUSE OF WHERE IT COMES FROM: the CORS middleware in
 * index.ts runs ahead of every route and answers 403 to an origin that is not
 * allowed, so a handler only ever sees an `Origin` that already passed
 * `isOriginAllowed`. It is not a client header being trusted; it is one that
 * has been checked. Anything that moves this call out from behind that
 * middleware has to re-establish that, or drop the rung.
 *
 * Rung 5 is then only reached by a request-less caller with nothing configured,
 * which in practice means local development.
 */
export function returnBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  requestOrigin?: string
): string {
  const explicit = env.PAYMENTS_RETURN_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const app = publicBaseUrl(env);
  if (app) return app;

  const frontend = env.FRONTEND_URL?.split(',')[0]?.trim();
  if (frontend) return frontend.replace(/\/+$/, '');

  const fromRequest = normalizeOrigin(requestOrigin);
  if (fromRequest) return fromRequest;

  const port = env.FRONTEND_PORT?.trim() || '3000';
  return `http://localhost:${port}`;
}

/**
 * One thing a buyer can pay with, and what it may be paid in.
 *
 * One per METHOD, which is the granularity the buyer chooses at: one card
 * button and one crypto button. It was a method OR a single coin while an
 * on-chain payment meant picking a token and a network here. The bounds and
 * the presets travel with it so the page never has to work out which limits
 * apply - or, worse, work out a price.
 */
export type PaymentTarget = {
  id: string;
  method: PaymentMethod;
  label: string;
  /** Which mark the page should draw. A key, not an image. */
  mark: string;
  available: boolean;
  reason?: string;
  /** The smallest and largest single purchase, in thousandths of a dollar (whole cents). */
  minAmountMilli: number;
  maxAmountMilli: number;
  /** The amounts to offer as buttons. Each charges, and credits, exactly its amount. */
  presets: Array<{ amountMilli: number }>;
  /** A slider for card, a whole-dollar stepper for a coin. */
  custom: 'slider' | 'stepper';
};

/**
 * What the browser needs to take the payment.
 *
 * Exactly one of the three is set. `clientSecret` means the form is ours: the
 * page mounts Stripe's Payment Element with it and the customer never leaves.
 * A `redirectUrl` is the older shape, for a provider whose checkout is a page
 * of its own. `processing` means the charge has already been made against a
 * card the buyer kept, and there is nothing to do but wait for the webhook.
 */
export type StartedCheckout = {
  payment: Payment;
  clientSecret?: string;
  redirectUrl?: string;
  /**
   * Set when a saved card was charged off-session and there is nothing for the
   * browser to do but wait. Distinct from a client secret, which asks it to
   * confirm, and from a redirect, which sends it away.
   */
  processing?: boolean;
};

/**
 * What the browser may ask for.
 *
 * `amountUsd` is the amount of credit wanted, in dollars - which is also the
 * charge, since a credit is a dollar and nothing is taken out. It is judged
 * against the method's bounds by the pricing module, which is the only thing
 * that decides what the provider is asked for. `cardId` charges a card this
 * account has saved; `saveCard` asks to keep the one about to be entered.
 *
 * There was an `asset` too, naming a coin so its own limits applied. Nothing
 * can honour one now, so it is not in the type and `startCheckout` does not
 * read it - a stale tab that still sends one gets an ordinary crypto checkout.
 */
export type CheckoutRequest = {
  method: unknown;
  amountUsd: unknown;
  cardId?: unknown;
  saveCard?: unknown;
};

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
export type CheckoutContext = {
  env?: NodeJS.ProcessEnv;
  /**
   * `Origin` from the request that asked for this checkout, when there was one.
   *
   * Kept OUT of `CheckoutRequest` on purpose: that object is assembled from
   * `req.body`, and a value the server derived must not sit where a buyer could
   * later be read into it by a careless spread.
   */
  requestOrigin?: string;
};

export async function startCheckout(
  account: UserAccount,
  request: CheckoutRequest,
  context: CheckoutContext = {}
): Promise<StartedCheckout> {
  const { env = process.env, requestOrigin } = context;
  const { method, amountUsd } = request;
  if (method !== 'card' && method !== 'crypto') {
    throw new PaymentError('Choose a payment method.');
  }

  const cardId = typeof request.cardId === 'string' && request.cardId.trim()
    ? request.cardId.trim()
    : undefined;
  const saveCard = request.saveCard === true;

  /*
   * No coin is named here any more, and nothing validates one.
   *
   * The buyer chooses the coin and the network on Cryptomus's own page, from
   * Cryptomus's own list, so an `asset` in this request could not have been
   * honoured - and a parameter that is accepted and ignored is worse than one
   * that is gone. A stale tab that still sends one gets a perfectly ordinary
   * crypto checkout, which is what pressing a coin button meant.
   */
  if (cardId && method !== 'card') {
    throw new PaymentError('A saved card can only be used for a card payment.');
  }

  /*
   * The card is found HERE, not in the provider block below.
   *
   * That block converts everything it catches into a 502 and marks the payment
   * failed, because everything it wraps is a call to Stripe. A card that is not
   * this account's is a request error - 404 - and reporting it as "the provider
   * would not open a checkout page" would be a lie told to the buyer and a
   * failed payment row nobody asked for.
   */
  const savedCard = cardId ? getCardForUser(account.id, cardId) : null;
  if (cardId && !savedCard) {
    // 404 rather than 403: an id in a path must not confirm that somebody
    // else's card exists.
    throw new PaymentError('That saved card is not available.', 404);
  }

  const availability = describeMethods(env).find((entry) => entry.method === method);
  if (!availability?.available) {
    // Keys only an administrator can set, so the buyer is pointed there and
    // the reason - which names them - is the administrator's detail, as it is
    // for the price settings' own 503.
    throw new PaymentError(
      method === 'card'
        ? 'Card payments are not available right now. Please contact your administrator.'
        : 'Crypto payments are not available right now. Please contact your administrator.',
      503,
      availability?.reason || `No ${method} payment provider is configured on this server.`
    );
  }

  /*
   * A ceiling on how often one account may open a checkout.
   *
   * Every checkout is a call to Stripe or Cryptomus, so an endpoint that any
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

  /*
   * The browser sent the dollars it wants. Whether that may be bought, and
   * what the provider is asked to charge for it, is worked out here.
   *
   * The target is passed so the method's own bounds apply. Omitting it would
   * silently judge every purchase against the card row, which is the one
   * mistake this parameter exists to make impossible.
   */
  const target: QuoteTarget = { method };
  const quote = await quotePurchase(amountUsd, target);

  const payment = createPayment({
    userId: account.id,
    method,
    provider: availability.provider,
    amountCents: quote.amountCents,
    // The charge, exactly: a credit is a dollar and nothing is taken out.
    creditMilli: quote.creditMilli,
    currency: quote.currency,
  });

  const base = returnBaseUrl(env, requestOrigin);
  /*
   * Where a customer lands if the payment took them off our page.
   *
   * With the form embedded, most card payments never go anywhere - the element
   * confirms in place. But 3-D Secure and stablecoin payments both hand the
   * customer to somebody else's domain, and they have to come back somewhere.
   * That somewhere is the page that polls for the webhook, which is the only
   * thing that decides a payment either way.
   */
  const returnUrl = `${base}/credits/return?payment=${encodeURIComponent(payment.id)}`;
  const cancelUrl = `${base}/credits?cancelled=${encodeURIComponent(payment.id)}`;

  /*
   * Only a refusal BY THE PROVIDER closes the payment.
   *
   * If the checkout page was created and something after it throws, a live
   * session exists at the provider with this payment's id on it and somebody
   * may still pay it. Marking that `failed` means the webhook arrives, finds a
   * row that is not `pending`, and credits nothing: money taken, nothing given.
   *
   * So the catch below wraps provider calls, and it asks WHO said no rather
   * than assuming - a settings read and two lines of customer bookkeeping are
   * inside it too, and a locked database must not be reported as Stripe
   * refusing.
   */
  const opened = await (async () => {
    try {
      if (method === 'card') {
        /*
         * Read once for both branches below, because the two card paths have
         * to agree: it would be a strange installation where a new card is
         * authenticated and a kept one is not.
         */
        const authenticate = await requireThreeDSecure();

        /*
         * Paying with a card already kept: no form, no client secret.
         *
         * The charge is made here and now, so what comes back is a payment
         * intent rather than something for the browser to confirm. A bank can
         * still demand authentication even off-session, and that is the one
         * case where a client secret is handed over after all - and when the
         * operator requires 3-D Secure it stops being the exception and
         * becomes what always happens, because the charge is then made
         * on-session on purpose.
         */
        if (savedCard) {
          const intent = await stripe.chargeSavedCard({
            paymentId: payment.id,
            reference: payment.reference,
            amountCents: quote.amountCents,
            currency: quote.currency,
            customer: savedCard.customerRef,
            paymentMethod: savedCard.methodRef,
            returnUrl,
            ...(authenticate ? { requireThreeDSecure: true } : {}),
          });

          return {
            ref: intent.id,
            // Only when the bank insisted. Otherwise there is nothing to do
            // but wait for the webhook, as with any other payment.
            clientSecret: intent.status === 'requires_action' ? (intent.client_secret ?? '') : '',
            url: '',
            processing: intent.status !== 'requires_action',
          };
        }

        /*
         * A customer is created only when the buyer asked to keep the card.
         *
         * A guest checkout stores nothing reusable, which is the correct shape
         * for somebody who did not ask - and it means an account that never
         * saves a card never gets a customer record at Stripe at all.
         */
        let customer = getStripeCustomerId(account.id);
        if (saveCard && !customer) {
          const created = await stripe.createCustomer({
            userId: account.id,
            email: account.email,
          });
          customer = claimStripeCustomer(account.id, created.id);
        }

        const session = await stripe.createCheckoutSession({
          paymentId: payment.id,
          reference: payment.reference,
          creditMilli: quote.creditMilli,
          amountCents: quote.amountCents,
          currency: quote.currency,
          customerEmail: account.email,
          returnUrl,
          ...(customer ? { customer } : {}),
          ...(saveCard && customer ? { saveCard: true } : {}),
          ...(authenticate ? { requireThreeDSecure: true } : {}),
        });
        return { ref: session.id, clientSecret: session.client_secret ?? '', url: '' };
      }

      /*
       * The hosted invoice: a URL to send the buyer to, and a signed callback
       * to settle on. The only crypto branch there is.
       */
      const invoice = await cryptomus.createInvoice({
        paymentId: payment.id,
        reference: payment.reference,
        amountCents: quote.amountCents,
        currency: quote.currency,
        returnUrl,
        cancelUrl,
      });
      return { ref: invoice.uuid, clientSecret: '', url: invoice.url, processing: false };
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

      /*
       * A refusal that named an intent still tells us which charge it was.
       *
       * Stripe returns the whole `payment_intent` on a failed confirm, and
       * that attempt exists at Stripe whether this ends as failed or pending.
       * Recording it here means an event about that intent later finds this
       * payment instead of resolving to nobody - and it is the only chance to
       * record it, because nothing below this line runs.
       *
       * Guarded, because `(provider, provider_ref)` is UNIQUE and this is the
       * one attach whose value comes from a failure rather than from a call
       * this server made: an intent id already on another row would throw a
       * constraint error from inside a catch block, which would throw away the
       * sentence below and leave the payment open. Recording the reference is
       * worth having and is not worth that.
       */
      if (error instanceof stripe.StripeError && error.paymentIntentId) {
        try {
          attachProviderRef(payment.id, error.paymentIntentId);
        } catch (clash) {
          console.warn(
            `[payments] ${payment.reference}: could not record the refused intent ` +
              `${error.paymentIntentId}.`,
            clash
          );
        }
      }

      /*
       * Closed only when the provider definitively said no.
       *
       * A transport failure - the connection dropped before an answer arrived -
       * is NOT a refusal: the session may well exist at Stripe with this
       * payment's id on it, and somebody may still pay it. Marking that failed
       * would mean the webhook arrives, finds a row that is not pending, and
       * credits nothing. Money taken, nothing given. So an unknown outcome
       * leaves the payment pending and lets it expire on its own.
       */
      const unknown =
        (error instanceof stripe.StripeError && error.transport) ||
        (error instanceof cryptomus.CryptomusError && error.transport);

      /*
       * The bank asking for the buyer, which is not a broken integration.
       *
       * A card on file is charged off-session, and an issuer may still insist
       * on a challenge - in which case Stripe REFUSES with
       * `authentication_required` rather than handing back an intent to
       * finish. Without this branch that answer is indistinguishable from a
       * misconfigured key: the buyer is told "the payment provider would not
       * open a checkout page" about their own bank, and has nothing to act on.
       * Nothing was charged either way, so the payment closes as it would for
       * any other refusal - only the sentence changes, and the sentence is the
       * whole of what the buyer gets.
       */
      const authenticationNeeded =
        error instanceof stripe.StripeError && error.code === 'authentication_required';
      const bankWantsYou =
        'Your bank wants to authenticate this payment, which a saved card cannot do on its own, so ' +
        'nothing was charged. Pay with the card form instead, or ask the operator to turn on 3-D ' +
        'Secure for kept cards.';

      /*
       * Whose failure this was, which decides what everybody is told.
       *
       * Nothing on this side of the wire can have moved money - every line that
       * could is a provider call, and those throw their own error types - so the
       * payment closes either way and only the sentence changes.
       */
      const providerAnswered =
        error instanceof stripe.StripeError || error instanceof cryptomus.CryptomusError;
      const ourFault = 'This server could not start that payment. Nothing was charged.';

      if (!unknown) {
        markUnpaid(
          payment.id,
          'failed',
          !providerAnswered
            ? ourFault
            : authenticationNeeded
              ? bankWantsYou
              : 'The payment provider would not open a checkout page.'
        );
      }
      throw new PaymentError(
        unknown
          ? 'Could not reach the payment provider. Nothing was charged - try again in a moment.'
          : !providerAnswered
            ? ourFault
            : authenticationNeeded
              ? bankWantsYou
              : 'The payment provider would not open a checkout page. Try again in a moment.',
        // 402 for a bank that wants the buyer: nothing is broken and they are
        // the one who can act. 500 when it was us, because 502 says the trouble
        // is upstream and it is not.
        authenticationNeeded ? 402 : providerAnswered ? 502 : 500
      );
    }
  })();

  /*
   * Before the guard below, not after: a saved-card charge has already moved the
   * money by this point, and a refusal that discards `opened.ref` leaves the row
   * with no reference for the webhook to find.
   */
  if (opened.ref && !attachProviderRef(payment.id, opened.ref)) {
    // Not fatal, and not silent. A reference that will not attach means one is
    // already there, which is the only case the condition refuses.
    console.warn(
      `[payments] ${payment.reference}: a provider reference was already recorded; keeping it.`
    );
  }

  if (!opened.clientSecret && !opened.url && !('processing' in opened && opened.processing)) {
    // The session may exist without anything the browser can use, so this
    // payment is NOT closed: see the note above. It simply cannot be paid.
    console.error(`[payments] ${payment.reference}: the provider returned nothing to pay with.`);
    throw new PaymentError('The payment provider did not return a way to pay.', 502);
  }

  return {
    payment: getPayment(payment.id) ?? payment,
    ...(opened.clientSecret ? { clientSecret: opened.clientSecret } : {}),
    ...(opened.url ? { redirectUrl: opened.url } : {}),
    ...('processing' in opened && opened.processing ? { processing: true } : {}),
  };
}

/**
 * Writes down the card a buyer just kept.
 *
 * Called AFTER the settling transaction has committed, never inside it: that
 * transaction is synchronous by design and these are two network calls. Losing
 * this row costs a convenience on the next purchase, so it never fails a
 * webhook and never blocks the 200 - the money has already been accounted for
 * by the time it runs.
 */
export async function recordSavedCardFromSession(payment: Payment): Promise<void> {
  try {
    if (payment.provider !== 'stripe' || !payment.providerRef) return;
    const customerRef = getStripeCustomerId(payment.userId);
    if (!customerRef) return;

    const intentId = await (async () => {
      if (payment.providerRef!.startsWith('pi_')) return payment.providerRef!;
      const session = await stripe.getCheckoutSession(payment.providerRef!);
      return typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    })();
    if (!intentId) return;

    const intent = await stripe.getPaymentIntent(intentId);

    /*
     * Only a card the buyer ASKED to keep.
     *
     * Without this the check above - "does this account have a customer" - is
     * the whole gate, and it is the wrong question: an account that saved a
     * card once has a customer for ever, so every later purchase would quietly
     * store whatever card it was paid with, including one the buyer had just
     * declined to save. `setup_future_usage` is set on the session only when
     * they ticked the box, and Stripe hands it back on the intent, so it is
     * their own answer being read rather than a flag this server kept.
     *
     * It is also what keeps an off-session charge from re-saving a card that
     * is already saved: that intent carries no `setup_future_usage`, and the
     * card it charged is in the table already.
     */
    if (!intent.setup_future_usage) return;

    const methodId =
      typeof intent.payment_method === 'string'
        ? intent.payment_method
        : intent.payment_method?.id;
    if (!methodId) return;

    const method = await stripe.getPaymentMethod(methodId);
    if (!method.card) return;

    saveCard({
      userId: payment.userId,
      customerRef,
      methodRef: method.id,
      brand: method.card.brand ?? '',
      last4: method.card.last4 ?? '',
      expMonth: method.card.exp_month ?? 0,
      expYear: method.card.exp_year ?? 0,
    });
  } catch (error) {
    console.warn(
      `[payments] ${payment.reference}: the card could not be saved for reuse; the payment is unaffected.`,
      error
    );
  }
}

/**
 * Everything a buyer may choose between, with its own limits.
 *
 * Two buttons: a card, and crypto. It briefly grew a row per coin, back when
 * an on-chain payment meant choosing a token AND a network here - Cryptomus
 * asks that on its own page, from a list this server does not hold, so a coin
 * chosen here would have been a choice nothing could honour.
 *
 * A target whose limits cannot be resolved - a settings read that fails -
 * comes back unavailable with the reason, rather than being dropped. An
 * operator has to be able to see a misconfiguration; a missing button is
 * invisible.
 */
export async function describeTargets(env: NodeJS.ProcessEnv = process.env): Promise<PaymentTarget[]> {
  const methods = describeMethods(env);
  const targets: PaymentTarget[] = [];

  for (const entry of methods) {
    /*
     * The method's own label for a card, a clearer noun for the coins.
     *
     * "Card" would repeat the section heading the page puts above it and tell
     * a buyer nothing; `describeMethods` already says "Credit or debit card",
     * which is the question they are actually asking. Crypto's method label is
     * the bare "Crypto", so the button that means every coin says so instead.
     */
    const base = {
      method: entry.method,
      label: entry.method === 'card' ? entry.label : 'Cryptocurrency',
      mark: entry.method === 'card' ? 'card' : 'crypto',
      available: entry.available,
      ...(entry.reason ? { reason: entry.reason } : {}),
    };

    try {
      const limits = await resolveLimits({ method: entry.method });
      const presets = await presetsFor({ method: entry.method });
      targets.push({
        ...base,
        id: entry.method,
        minAmountMilli: centsToMilli(limits.minAmountCents),
        maxAmountMilli: centsToMilli(limits.maxAmountCents),
        presets,
        custom: entry.method === 'card' ? 'slider' : 'stepper',
      });
    } catch (error) {
      targets.push({
        ...base,
        id: entry.method,
        available: false,
        // The operator's reason - the route gives anybody else a plain "not
        // available" instead (see GET /api/payments/methods).
        reason:
          error instanceof PublicError && error.detail
            ? error.detail
            : error instanceof Error
              ? error.message
              : 'These limits cannot be resolved.',
        minAmountMilli: 0,
        maxAmountMilli: 0,
        presets: [],
        custom: entry.method === 'card' ? 'slider' : 'stepper',
      });
    }
  }

  return targets;
}

export type CreditOutcome = { credited: boolean; payment: Payment | null };

/**
 * Turns a paid payment into credit, exactly once.
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

  /*
   * What was quoted, and only that - which is what was charged, a credit being
   * a dollar. Nothing clamps a measured figure down to it: every provider
   * settles for the amount it was asked for or not at all, and the webhook's
   * own amount check refuses a disagreement before this is reached.
   *
   * A checkout opened before credits became dollars and paid after has no
   * quote in dollars of its own unless the switch stamped one; it gets what
   * it was charged, at a dollar a dollar, like every purchase since.
   */
  const granted = payment.creditMilli > 0 ? payment.creditMilli : centsToMilli(payment.amountCents);
  if (granted <= 0) {
    // Nothing to credit is not a settlement. The caller holds the payment for
    // somebody to look at rather than marking it paid for zero.
    return { credited: false, payment };
  }

  if (!markPaid(payment.id, granted)) {
    return { credited: false, payment: getPayment(paymentId) };
  }

  // `applied` rather than an assumption: the ledger refuses a key it has
  // already used, and a caller that reported success anyway would put a line
  // in the log saying credit was added when none was.
  const { applied } = applyAdjustment({
    userId: payment.userId,
    deltaMilli: granted,
    reason: 'purchase',
    idempotencyKey: `purchase:${payment.id}`,
    note: `${payment.reference} - ${formatMoney(granted)}`,
  });

  return { credited: applied, payment: getPayment(paymentId) };
}

/** What a refund did, in thousandths of a dollar. */
export type RefundOutcome = {
  payment: Payment;
  /** What went back to the buyer: the whole charge, or the part asked for. */
  refundAmountMilli: number;
  /**
   * What the refund set out to take back off the balance: everything the
   * payment credited, or - for a partial refund - the part returned. 0 for a
   * payment from before credits were dollars.
   */
  creditedMilli: number;
  /** What could be taken back off the balance. */
  reversedMilli: number;
  /** What could not be taken back because it was already spent. */
  shortfallMilli: number;
};

/**
 * How a refund is made, beyond "all of it, through the provider".
 */
export type RefundOptions = {
  /**
   * Return only this much, in thousandths of a dollar - a positive whole
   * number of cents, no more than was charged - and reverse only that much
   * credit. A crypto refund request recorded by hand uses it (services/refunds).
   * Absent: the whole charge, as the payments list's button does.
   *
   * A CARD refund request does not come through here: a partial refund is a
   * promise about what is left unspent, so it takes its credit off the balance
   * BEFORE the money leaves (services/refunds, `sendCardRefund`), where this
   * calls the provider first and reverses after - which lets the buyer spend,
   * or a second refund claim, the same credit while Stripe is answering.
   */
  amountMilli?: number;
  /**
   * The administrator has ALREADY sent a crypto payment's money back by hand,
   * and is recording it: nothing is asked of the provider - nothing could be
   * - and the credit is reversed. Refused for a card, which goes back through
   * Stripe.
   */
  refundedByHand?: boolean;
};

/**
 * Refunds a payment at the provider and reverses what credit remains.
 *
 * The honest part, and the reason this returns three numbers rather than a
 * boolean: a balance may not go negative, so refunding somebody who has already
 * spent what they bought returns all of their money and reverses only what is
 * left. `applyAdjustment` clamps the negative delta at zero for exactly that
 * reason. Reporting the difference is the point - a refund that silently
 * reverses $12.400 of $50.000 is a number that does not add up, and whoever
 * pressed the button deserves to know before the customer does.
 *
 * A payment from before credits became dollars put credits on the balance
 * that the switch then reset to $0, so refunding its money reverses NOTHING:
 * there is nothing of it left on any balance, and taking dollars bought since
 * would be taking somebody's later purchase. All three figures read 0, and
 * `payment.legacyCredits` says why.
 *
 * The provider is called FIRST. If the refund fails there, nothing local
 * changes and the button can be pressed again; the reverse order would leave a
 * customer with no credits and no money back.
 */
export async function refundPayment(
  paymentId: string,
  actorId: string,
  note = '',
  options: RefundOptions = {}
): Promise<RefundOutcome> {
  const payment = getPayment(paymentId);
  if (!payment) throw new PaymentError('That payment was not found.', 404);
  const partial = options.amountMilli;
  if (partial !== undefined) {
    // Checked before the claim, so a bad amount leaves the payment as it was.
    // A bug upstream rather than an administrator's typing, which is why it
    // is said in a programmer's words.
    if (!isWholeCents(partial) || partial <= 0 || partial > centsToMilli(payment.amountCents)) {
      throw new Error(
        `A partial refund must be a positive whole number of cents up to the charge, not ${partial} thousandths.`
      );
    }
  }
  if (options.refundedByHand && payment.provider === 'stripe') {
    throw new PaymentError('A card payment is refunded through Stripe, not by hand.', 409);
  }
  if (payment.state === 'refunded') throw new PaymentError('That payment is already refunded.', 409);
  if (payment.state === 'refunding') {
    throw new PaymentError('That payment is already being refunded.', 409);
  }
  if (payment.state !== 'paid') throw new PaymentError('Only a paid payment can be refunded.', 409);
  // Money sent back by hand needs no provider reference - nothing is asked of the provider.
  if (!payment.providerRef && !options.refundedByHand) {
    throw new PaymentError('That payment has no provider reference.', 409);
  }

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
    // Still `paid` means the claim was refused for a refund REQUEST holding an
    // unconfirmed card refund - see beginRefund - not for another refund.
    if (getPayment(payment.id)?.state === 'paid') {
      throw new PaymentError(
        'A refund request for this payment has a card refund that Stripe has not confirmed yet, and its credit ' +
          'is already off the balance. Finish it under Refund requests - Mark refunded sends the same refund ' +
          'again, which cannot refund twice - before refunding from here.',
        409
      );
    }
    throw new PaymentError('That payment is already being refunded.', 409);
  }

  try {
    if (payment.provider === 'stripe') {
      await sendCardRefund(payment, partial === undefined ? undefined : milliToCents(partial));
    } else if (options.refundedByHand) {
      // Sent back already, by the person recording it. Nothing to ask anybody;
      // what follows reverses the credit and records the refund.
    } else {
      /*
       * Crypto cannot be pulled back, only sent back. A Cryptomus payment is
       * in that merchant account; any other - a payment taken by a retired
       * path - gets the sentence that cannot be wrong about where it is.
       */
      throw new PaymentError(
        payment.provider === 'cryptomus'
          ? 'Crypto payments cannot be refunded automatically. Send the funds back from your ' +
            'Cryptomus merchant dashboard, then adjust the balance from the accounts page.'
          : 'Crypto payments cannot be refunded automatically. Send the funds back from ' +
            'wherever this payment was taken, then adjust the balance from the accounts page.',
        409
      );
    }
  } catch (error) {
    /*
     * The claim goes back either way; what is SAID depends on whether we know.
     *
     * Releasing is right in both cases - leaving it claimed strands a
     * refundable payment behind a state nothing clears - and pressing Refund
     * again is safe, because `refundPaymentIntent` sends
     * `Idempotency-Key: refund:<paymentId>` and Stripe will not create a
     * second refund for it.
     *
     * But this said "the money did not move" unconditionally, and for a
     * dropped socket that is a guess in the wrong direction: the refund may
     * well have been created, and the credits have NOT been reversed, because
     * that happens after this block. Money returned, credits kept, and an
     * operator told nothing happened. `StripeError.transport` is exactly the
     * distinction `startCheckout` already makes, and the answer is the same:
     * say the outcome is unknown, and say what to do about it.
     */
    releaseRefund(payment.id);
    if (isUnansweredRefund(error)) {
      console.error(
        `[payments] ${payment.reference}: the refund call to Stripe did not answer. ` +
          'It may or may not have been created; no credits were reversed.',
        error
      );
      throw new PaymentError(
        'Could not confirm the refund with Stripe, so nothing was reversed here. The refund may ' +
          'have gone through - press Refund again, which cannot refund twice, or check the ' +
          'payment in the Stripe dashboard first.',
        502
      );
    }
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
  /*
   * Reverse what was CREDITED, measured when it was, in dollars - which is 0
   * for a payment from before credits were dollars, whose credits the switch
   * already reset. A partial refund reverses only the part it returned: the
   * rest of the purchase was spent, which is why only that part is going back.
   */
  const credited = partial === undefined ? payment.creditedMilli : Math.min(partial, payment.creditedMilli);
  const refundCents = partial === undefined ? payment.amountCents : milliToCents(partial);

  const balanceBefore = getUserById(payment.userId)?.balanceMilli ?? 0;
  applyAdjustment({
    userId: payment.userId,
    deltaMilli: -credited,
    reason: 'purchase-refund',
    idempotencyKey: `purchase-refund:${payment.id}`,
    actorId,
    note: note.trim() || `${payment.reference} refunded`,
  });
  const balanceAfter = getUserById(payment.userId)?.balanceMilli ?? 0;

  const reversed = Math.max(0, balanceBefore - balanceAfter);
  if (!markRefunded(payment.id, reversed, refundCents)) {
    // The claim above makes this unreachable short of a direct database edit.
    // It is checked rather than assumed because the alternative is reporting a
    // refund that the record does not show.
    console.error(`[payments] ${payment.reference}: the refund could not be recorded.`);
    throw new PaymentError('The refund was made but could not be recorded. Check the provider.', 500);
  }

  return {
    payment: getPayment(paymentId)!,
    refundAmountMilli: centsToMilli(refundCents),
    creditedMilli: credited,
    reversedMilli: reversed,
    shortfallMilli: credited - reversed,
  };
}

/**
 * Asks Stripe to refund a card payment - all of it, or `amountCents` of it -
 * and does nothing else: no claim, no reversal, no record. The caller holds the
 * claim (`beginRefund`) and decides what the answer means: `refundPayment` for
 * the payments list, services/refunds for a refund request, which takes its
 * credit off BEFORE calling this.
 *
 * Throws what Stripe answered (`StripeError`; `isUnansweredRefund` tells a
 * refusal from no answer), or a PaymentError when the session has no payment
 * behind it.
 */
export async function sendCardRefund(payment: Payment, amountCents?: number): Promise<void> {
  /*
   * Two shapes live in `provider_ref` now, and the prefix tells them apart.
   *
   * A checkout session (`cs_`) has to be read to find the payment intent
   * behind it; a saved-card charge put the intent (`pi_`) there directly,
   * and asking Stripe for a session by that id is a 404. Testing the prefix
   * is inelegant, but it is Stripe's own namespacing and it cannot
   * disagree with the value it describes - which a second column recording
   * "what kind of reference this is" eventually would.
   */
  const reference = payment.providerRef ?? '';
  const intent = reference.startsWith('pi_')
    ? reference
    : await (async () => {
        const session = await stripe.getCheckoutSession(reference);
        return typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      })();
  if (!intent) throw new PaymentError('Stripe has no payment to refund for that session.', 409);
  await stripe.refundPaymentIntent(intent, payment.id, amountCents);
}

/**
 * Whether a refund call ended with NO answer - a dropped socket, a reply that
 * never finished arriving - so the refund may or may not exist at Stripe, as
 * opposed to Stripe refusing it. `StripeError.transport` is the same
 * distinction `startCheckout` makes.
 */
export function isUnansweredRefund(error: unknown): boolean {
  return error instanceof stripe.StripeError && error.transport;
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
  /**
   * Whether a `paid` event with NO amount on it should be held rather than
   * credited. See the comparison in `settleWebhookEvent`.
   */
  mustMatchAmount?: boolean;
  /**
   * What to tell the buyer, when the generic sentence would be wrong.
   *
   * Most failures are "it did not go through", which is both true and all
   * anybody needs. A few are not: money that arrived and was too little is not
   * money that never left. The provider's own module writes this, because it is
   * the only place that knows which status it was.
   */
  failure?: string;
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
     * Found by hint, with no reference on the row: record the reference now.
     *
     * This is the repair half of the saved-card rule in `paymentWebhooks.ts`.
     * That flow charges the card inside the confirm call and writes
     * `provider_ref` afterwards, so an interrupted attempt leaves a row the
     * hint can still find and a reference nobody wrote. Crediting it and
     * leaving the reference blank would settle the money and still leave the
     * payment unrefundable, because `refundPayment` needs one - so the fix is
     * to take the reference from the event that found it.
     *
     * `attachProviderRef` only writes into an empty column, so a row that
     * already carries a reference is never overwritten by an event that
     * reached it some other way.
     */
    if (!byRef && !payment.providerRef && event.providerRef) {
      attachProviderRef(payment.id, event.providerRef);
    }

    /*
     * What was paid has to be what was quoted.
     *
     * Nothing today can make these disagree - the amount is set server-side on
     * a Checkout Session and the browser never sends one - but "nothing today"
     * is a property of settings at the provider, not of this code. An operator
     * who turns on promotion codes, or a crypto charge settled short, would
     * otherwise credit the full order for a smaller payment. The payment is
     * left `pending` rather than failed, because somebody has to look at it.
     *
     * **`mustMatchAmount` is what stops the check being skippable.** Without
     * it the comparison ran only when an amount happened to be present, so a
     * signed event with the field missing - or sent as a number where this
     * expected a string - credited the full order and looked exactly like
     * agreement in the log. A provider whose body shape is asserted rather
     * than observed sets this, and then no amount means held, not credited.
     */
    if (event.outcome === 'paid' && event.mustMatchAmount && typeof event.paidAmountCents !== 'number') {
      console.error(
        `[payments] ${payment.reference}: a paid event arrived with no amount on it. Nothing was ` +
          'credited - the event is recorded and the payment is still pending.'
      );
      return { status: 'mismatch', payment, credited: false };
    }
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
        event.failure ||
          (event.outcome === 'expired'
            ? 'That checkout expired before it was paid, and you were not charged.'
            : 'The payment did not go through at the provider, and you were not charged.')
      );
      return { status: 'handled', payment: getPayment(payment.id), credited: false };
    }
    return { status: 'handled', payment, credited: false };
  })();
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

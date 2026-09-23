import { applyAdjustment } from '../../database/creditRepository';
import { getDb } from '../../database/sqlite';
import {
  claimStripeCustomer,
  getStripeCustomerId,
  getUserById,
} from '../../database/userRepository';
import { getCardForUser, saveCard } from '../../database/savedCardRepository';
import { ASSETS, isAssetId } from '../../config/chainAssets';
import {
  chainPaymentsReason,
  isChainPaymentsConfigured,
  readChainPaymentsConfig,
} from '../../config/chainPayments';
import { getInvoiceForPayment } from '../../database/chainInvoiceRepository';
import { ChainInvoiceError, describeInvoice, openInvoice } from './chain/invoices';
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
import {
  PriceError,
  quoteCredits,
  requireThreeDSecure,
  resolveLimits,
  presetsFor,
  type QuoteTarget,
} from './pricing';

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

/** The publishable key the buy page needs, or '' when cards are not set up. */
export function publishableKey(env: NodeJS.ProcessEnv = process.env): string {
  return stripe.isStripeConfigured(env) ? stripe.stripePublishableKey(env) : '';
}

export function describeMethods(env: NodeJS.ProcessEnv = process.env): MethodAvailability[] {
  const card = stripe.isStripeConfigured(env);
  /*
   * Either way of taking crypto counts, and the on-chain one is preferred.
   *
   * Coinbase Commerce is retired rather than removed: payments already made
   * through it still read, its webhook still settles, and an installation
   * configured only for it keeps working exactly as before. What changes is
   * which one a NEW checkout gets. Changing the METHOD union instead would
   * misread every row already in the table.
   */
  const onChain = isChainPaymentsConfigured(env);
  const crypto = onChain || coinbase.isCoinbaseConfigured(env);
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
      provider: onChain ? 'chain' : 'coinbase',
      label: 'Crypto',
      available: crypto,
      ...(crypto
        ? {}
        : {
            // The chain reason first, because that is the one an operator
            // setting this up now is trying to satisfy. It names the variables
            // rather than describing them, for the same reason.
            reason:
              `${chainPaymentsReason(env)} Or set COINBASE_COMMERCE_API_KEY and ` +
              'COINBASE_COMMERCE_WEBHOOK_SECRET to take crypto through Coinbase Commerce instead.',
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

/**
 * One thing a buyer can pay with, and what it may be paid in.
 *
 * A target is a method OR a single coin, because that is the granularity the
 * buyer chooses at: "card" is one button, and each asset is another. The
 * bounds and the presets travel with it so the page never has to work out
 * which limits apply - or, worse, work out a price.
 */
export type PaymentTarget = {
  id: string;
  method: PaymentMethod;
  asset?: string;
  chain?: string;
  label: string;
  symbol?: string;
  /** Which mark the page should draw. A key, not an image. */
  mark: string;
  available: boolean;
  reason?: string;
  minCredits: number;
  maxCredits: number;
  minAmountCents: number;
  maxAmountCents: number;
  presets: Array<{ credits: number; amountCents: number }>;
  /** A slider for card, a whole-dollar stepper for a coin. */
  custom: 'slider' | 'stepper';
  feeBps: number;
  feeFixedCents: number;
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
   * The deposit instructions, when the payment is on-chain.
   *
   * A fourth shape beside the three below, and the only one that asks the
   * buyer to do something outside the browser entirely: send an exact amount
   * to an address. There is nothing to confirm and nowhere to be sent.
   */
  invoice?: ReturnType<typeof describeInvoice>;
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
 * `credits` is a COUNT and there is no amount here, which is the rule the
 * whole pricing module exists to enforce. `asset` names a coin so its own
 * limits apply; `cardId` charges a card this account has saved; `saveCard`
 * asks to keep the one about to be entered.
 */
export type CheckoutRequest = {
  method: unknown;
  credits: unknown;
  asset?: unknown;
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
export async function startCheckout(
  account: UserAccount,
  request: CheckoutRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<StartedCheckout> {
  const { method, credits: requestedCredits } = request;
  if (method !== 'card' && method !== 'crypto') {
    throw new PaymentError('Choose a payment method.');
  }

  const asset = typeof request.asset === 'string' && request.asset.trim()
    ? request.asset.trim()
    : undefined;
  const cardId = typeof request.cardId === 'string' && request.cardId.trim()
    ? request.cardId.trim()
    : undefined;
  const saveCard = request.saveCard === true;

  if (asset && method !== 'crypto') {
    throw new PaymentError('A coin can only be chosen for a crypto payment.');
  }
  /*
   * A coin this build has actually heard of, or none.
   *
   * `asset` comes from the request body and ends up choosing which limits row
   * prices the sale. `isAssetId` is the closed list in `chainAssets.ts`, so an
   * invented string - or a method's own name - cannot reach the pricing
   * authority at all. The check is here, beside the other request validation,
   * rather than inside the provider block below: a coin that does not exist is
   * the caller's mistake, and reporting it as "the provider refused" would be
   * a 502 and a failed payment row for a request that never should have been
   * recorded.
   */
  if (asset && !isAssetId(asset)) {
    throw new PaymentError('That coin is not one this server can take.');
  }

  /*
   * On-chain crypto needs to know WHICH coin. Coinbase does not.
   *
   * The difference is real rather than pedantic: an on-chain payment is an
   * amount of one specific token sent to one specific address, and there is no
   * sensible default. Coinbase's hosted page asks the buyer itself, which is
   * why an asset stays optional there and why this check is conditional.
   */
  const chainConfigured = isChainPaymentsConfigured(env);
  if (method === 'crypto' && chainConfigured && !asset) {
    throw new PaymentError('Choose which coin to pay with.');
  }
  const chosenAsset = asset && isAssetId(asset) ? asset : null;
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

  /*
   * The browser sent a COUNT. The price is worked out here, from settings, and
   * an `amount` in the request body is never read.
   *
   * The target is passed so the method's - or the coin's - own bounds and fee
   * apply. Omitting it would silently price every purchase against the card
   * row, which is the one mistake this parameter exists to make impossible.
   */
  const target: QuoteTarget = asset ? { method, asset } : { method };
  const quote = await quoteCredits(requestedCredits, target);

  const payment = createPayment({
    userId: account.id,
    method,
    provider: availability.provider,
    // `credits` is what will be granted; the charge is the gross.
    credits: quote.credits,
    amountCents: quote.amountCents,
    currency: quote.currency,
    unitPriceCents: quote.unitPriceCents,
    feeCents: quote.feeCents,
  });

  const base = returnBaseUrl(env);
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
          credits: quote.credits,
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
       * On-chain when it is configured, Coinbase Commerce when it is not.
       *
       * The difference for the buyer is total: on-chain they are shown an
       * address this operator controls and an exact amount, and the money
       * never touches a processor. Coinbase remains for an installation that
       * has not set up addresses, and for every row already paid through it.
       */
      if (chainConfigured && chosenAsset) {
        const invoice = await openInvoice({
          paymentId: payment.id,
          userId: account.id,
          assetId: chosenAsset,
          amountCents: quote.amountCents,
        });
        /*
         * The invoice id is the provider reference.
         *
         * There is no session and no charge at anybody's API, so the thing
         * that identifies this payment on the provider's side is the row this
         * server wrote. It keeps `provider_ref` meaning the same thing for
         * every provider - "the object at the other end" - and it is what a
         * reconciling administrator looks the payment up by.
         */
        return { ref: invoice.id, clientSecret: '', url: '', processing: false };
      }

      const charge = await coinbase.createCharge({
        paymentId: payment.id,
        reference: payment.reference,
        credits: quote.credits,
        amountCents: quote.amountCents,
        currency: quote.currency,
        redirectUrl: returnUrl,
        cancelUrl,
      });
      return { ref: charge.code, clientSecret: '', url: charge.hosted_url ?? '', processing: false };
    } catch (error) {
      /*
       * An invoice refusal is the caller's answer, not the provider's.
       *
       * "Somebody is already paying that exact amount" and "the price feed is
       * not answering" are both things the buyer can act on, and neither is
       * "the payment provider would not open a checkout page". Reporting them
       * as a 502 would tell somebody to try later when the real advice is to
       * try NOW with a different amount. The payment row is closed on the way
       * past, because no invoice exists for it and nothing will ever pay it.
       */
      if (error instanceof ChainInvoiceError) {
        markUnpaid(payment.id, 'failed', 'No invoice could be opened for this payment.');
        throw new PaymentError(error.message, error.status);
      }

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
       * Closed only when the provider definitively said no.
       *
       * A transport failure - the connection dropped before an answer arrived -
       * is NOT a refusal: the session may well exist at Stripe with this
       * payment's id on it, and somebody may still pay it. Marking that failed
       * would mean the webhook arrives, finds a row that is not pending, and
       * credits nothing. Money taken, nothing given. So an unknown outcome
       * leaves the payment pending and lets it expire on its own.
       */
      const unknown = error instanceof stripe.StripeError && error.transport;
      if (!unknown) {
        markUnpaid(payment.id, 'failed', 'The payment provider would not open a checkout page.');
      }
      throw new PaymentError(
        unknown
          ? 'Could not reach the payment provider. Nothing was charged - try again in a moment.'
          : 'The payment provider would not open a checkout page. Try again in a moment.',
        502
      );
    }
  })();

  const invoice = getInvoiceForPayment(payment.id);
  if (invoice) {
    attachProviderRef(payment.id, opened.ref);
    return { payment: getPayment(payment.id) ?? payment, invoice: describeInvoice(invoice) };
  }

  if (!opened.clientSecret && !opened.url && !('processing' in opened && opened.processing)) {
    // The session may exist without anything the browser can use, so this
    // payment is NOT closed: see the note above. It simply cannot be paid.
    console.error(`[payments] ${payment.reference}: the provider returned nothing to pay with.`);
    throw new PaymentError('The payment provider did not return a way to pay.', 502);
  }

  if (opened.ref && !attachProviderRef(payment.id, opened.ref)) {
    // Not fatal, and not silent. A reference that will not attach means one is
    // already there, which is the only case the condition refuses.
    console.warn(
      `[payments] ${payment.reference}: a provider reference was already recorded; keeping it.`
    );
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
 * A target whose limits cannot be resolved - a price so high that no whole
 * number of credits fits inside the configured amounts - comes back
 * unavailable with the reason, rather than being dropped. An operator has to
 * be able to see a misconfiguration; a missing button is invisible.
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
     * the bare "Crypto", so the button that means EVERY coin says so instead -
     * and once there is a row per asset, each one carries its own coin's name
     * and this one is not shown at all.
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
        minCredits: limits.minCredits,
        maxCredits: limits.maxCredits,
        minAmountCents: limits.minAmountCents,
        maxAmountCents: limits.maxAmountCents,
        presets,
        custom: entry.method === 'card' ? 'slider' : 'stepper',
        feeBps: limits.feeBps,
        feeFixedCents: limits.feeFixedCents,
      });
    } catch (error) {
      targets.push({
        ...base,
        id: entry.method,
        available: false,
        reason: error instanceof Error ? error.message : 'These limits cannot be resolved.',
        minCredits: 0,
        maxCredits: 0,
        minAmountCents: 0,
        maxAmountCents: 0,
        presets: [],
        custom: entry.method === 'card' ? 'slider' : 'stepper',
        feeBps: 0,
        feeFixedCents: 0,
      });
    }
  }

  /*
   * One row per coin, replacing the single "Cryptocurrency" row.
   *
   * A buyer paying on-chain is choosing a coin AND a network, not a category:
   * USDT on Ethereum and USDT on TRON are different addresses, different fees
   * and different confirmation times, and sending one to the other loses the
   * money. So each is its own button, with its own limits row, and the
   * method-level entry is dropped once there is anything to replace it with.
   *
   * An asset the operator asked for that cannot be served appears here too,
   * unavailable and with the reason - the rule chainPayments.ts states for
   * itself: a misconfiguration is something they need to SEE.
   */
  const chainConfig = readChainPaymentsConfig(env);
  {
    const coinTargets: PaymentTarget[] = [];

    for (const enabled of chainConfig.assets) {
      const asset = enabled.definition;
      try {
        const limits = await resolveLimits({ method: 'crypto', asset: asset.id });
        const presets = await presetsFor({ method: 'crypto', asset: asset.id });
        coinTargets.push({
          id: asset.id,
          method: 'crypto',
          asset: asset.id,
          chain: asset.chain,
          label: asset.label,
          symbol: asset.symbol,
          mark: asset.id,
          available: true,
          minCredits: limits.minCredits,
          maxCredits: limits.maxCredits,
          minAmountCents: limits.minAmountCents,
          maxAmountCents: limits.maxAmountCents,
          presets,
          custom: 'stepper',
          feeBps: limits.feeBps,
          feeFixedCents: limits.feeFixedCents,
        });
      } catch (error) {
        coinTargets.push({
          id: asset.id,
          method: 'crypto',
          asset: asset.id,
          chain: asset.chain,
          label: asset.label,
          symbol: asset.symbol,
          mark: asset.id,
          available: false,
          reason: error instanceof Error ? error.message : 'These limits cannot be resolved.',
          minCredits: 0,
          maxCredits: 0,
          minAmountCents: 0,
          maxAmountCents: 0,
          presets: [],
          custom: 'stepper',
          feeBps: 0,
          feeFixedCents: 0,
        });
      }
    }

    for (const problem of chainConfig.problems) {
      const asset = ASSETS[problem.asset];
      coinTargets.push({
        id: problem.asset,
        method: 'crypto',
        asset: problem.asset,
        ...(asset ? { chain: asset.chain, symbol: asset.symbol } : {}),
        label: asset ? asset.label : problem.asset,
        mark: problem.asset,
        available: false,
        reason: problem.reason,
        minCredits: 0,
        maxCredits: 0,
        minAmountCents: 0,
        maxAmountCents: 0,
        presets: [],
        custom: 'stepper',
        feeBps: 0,
        feeFixedCents: 0,
      });
    }

    if (coinTargets.length === 0) return targets;

    /*
     * The method-level crypto row is replaced only when a coin can ACTUALLY be
     * paid with, and that distinction was a hole.
     *
     * These rows used to be built only when at least one asset was enabled. So
     * an operator who listed nothing but coins this server refuses - the two
     * EVM natives, say - produced named problems that were then thrown away,
     * and what they saw depended entirely on whether Coinbase Commerce
     * happened to be configured. Without it the method-level row carried the
     * joined reason and they were told. WITH it that row is available and
     * carries no reason at all, so the refusal was silent: a working Crypto
     * button, every payment going through a processor, and no hint that the
     * wallet they had configured was being ignored. `.env.example` promises
     * the opposite in as many words.
     *
     * So the problem rows are emitted either way, and the method-level row
     * stays when no coin is payable - it is the only button that can start a
     * Coinbase checkout, because the chain path is taken only when an `asset`
     * comes with the request.
     */
    if (chainConfig.assets.length === 0) return [...targets, ...coinTargets];

    return [...targets.filter((target) => target.method !== 'crypto'), ...coinTargets];
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
export function creditPaid(paymentId: string, grantedCredits?: number): CreditOutcome {
  const payment = getPayment(paymentId);
  if (!payment) return { credited: false, payment: null };
  if (payment.state !== 'pending') return { credited: false, payment };

  /*
   * What to credit, clamped to what was quoted.
   *
   * Omitted by every card caller, which is why the default is the quote and
   * the card path is byte-for-byte what it always was. A chain payment passes
   * a measured figure, and the clamp is the guard that matters there: crediting
   * MORE than the order would sell credits at a price nobody quoted and could
   * step straight past the method's own ceiling.
   */
  const granted = Math.max(0, Math.min(grantedCredits ?? payment.credits, payment.credits));
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
  // in the log saying credits were added when none were.
  const { applied } = applyAdjustment({
    userId: payment.userId,
    delta: granted,
    reason: 'purchase',
    idempotencyKey: `purchase:${payment.id}`,
    note: `${payment.reference} - ${granted} credits`,
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
      const reference = payment.providerRef;
      const intent = reference.startsWith('pi_')
        ? reference
        : await (async () => {
            const session = await stripe.getCheckoutSession(reference);
            return typeof session.payment_intent === 'string'
              ? session.payment_intent
              : session.payment_intent?.id;
          })();
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
  /*
   * Reverse what was GRANTED, not what was quoted.
   *
   * The two differ whenever a fee was taken, and the `|| credits` covers every
   * row written before the column existed - those took no fee, so the quote
   * IS what was granted. Reversing the quote instead would take back credits
   * the account never received.
   */
  const granted = payment.creditsGranted || payment.credits;

  const balanceBefore = getUserById(payment.userId)?.credits ?? 0;
  applyAdjustment({
    userId: payment.userId,
    delta: -granted,
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
    creditsSold: granted,
    creditsReversed: reversed,
    shortfall: granted - reversed,
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

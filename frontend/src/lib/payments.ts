import { apiFetch } from './api';

/**
 * Buying credits.
 *
 * The one thing to know reading this: **a checkout request carries a COUNT of
 * credits and never a price.** The server quotes from its own settings, so the
 * page below cannot show an amount the server would not charge - it displays
 * the same number, from the same place, rather than working one out.
 */

export type PaymentMethod = 'card' | 'crypto';
export type PaymentProvider = 'stripe' | 'coinbase' | 'chain' | 'cryptomus';
export type PaymentState = 'pending' | 'paid' | 'failed' | 'expired' | 'refunding' | 'refunded';

export type MethodAvailability = {
  method: PaymentMethod;
  provider: PaymentProvider;
  label: string;
  available: boolean;
  /** Why it is not on offer. Written for the operator, not the customer. */
  reason?: string;
};

/**
 * One thing a buyer can choose, with its own limits and buttons.
 *
 * The presets are COUNTS with the price the server would charge for each. A
 * button that carried its own price would be a price the browser had decided,
 * which is the one thing this whole module exists to prevent - so what is
 * rendered on a $50 button is `formatAmount(preset.amountCents)`, a figure the
 * server worked out.
 */
export type PaymentTarget = {
  id: string;
  method: PaymentMethod;
  label: string;
  /** Which mark to draw. A key into the marks registry, never a URL. */
  mark: string;
  available: boolean;
  reason?: string;
  minCredits: number;
  maxCredits: number;
  minAmountCents: number;
  maxAmountCents: number;
  presets: Array<{ credits: number; amountCents: number }>;
  custom: 'slider' | 'stepper';
  feeBps: number;
  feeFixedCents: number;
};

export type PaymentOptions = {
  unitPriceCents: number;
  minCredits: number;
  maxCredits: number;
  currency: string;
  methods: MethodAvailability[];
  /** One per method. What the picker is built from. */
  targets: PaymentTarget[];
  /** Stripe's publishable key, served by the API. Empty when cards are off. */
  publishableKey: string;
  /**
   * Whether the operator has asked for every card payment to be authenticated.
   *
   * Only so the card step can warn before the bank's challenge appears, and
   * so a kept card does not promise one tap when it now takes two.
   */
  requireThreeDSecure: boolean;
};

/** A card kept for reuse. No handle is served to the browser, only a label. */
export type SavedCard = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  createdAt: string;
};

/** `Mastercard ending in 9729`, in the words the design uses. */
export function describeCard(card: SavedCard): string {
  const brand = card.brand
    ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1)
    : 'Card';
  return `${brand} ending in ${card.last4 || '****'}`;
}

export type Payment = {
  id: string;
  reference: string;
  userId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  providerRef?: string;
  credits: number;
  amountCents: number;
  currency: string;
  unitPriceCents: number;
  /** The fee taken, at the rate in force when the payment was made. */
  feeCents: number;
  /** What the ledger received, as against `credits`, which was quoted. */
  creditsGranted: number;
  state: PaymentState;
  failure: string;
  creditedAt?: string;
  refundedAt?: string;
  refundedCredits: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminPayment = Payment & { userEmail: string };

/**
 * One of `clientSecret` and `redirectUrl`, and sometimes neither.
 *
 * `clientSecret` means the form is ours and the customer stays on this site;
 * `redirectUrl` means the provider hosts its own page and we send them there.
 * Neither is the third case - a card already on file, charged before this
 * answer was written - and the server says `processing` about it. Nothing here
 * reads that: the saved-card path goes straight to the page that waits for the
 * webhook, which is where `processing` would have sent it anyway. It is left on
 * the type because the server's own guard turns on it, and because reading
 * "neither of those two, and that is fine" off a missing field is worse.
 */
export type StartedCheckout = {
  paymentId: string;
  reference: string;
  credits: number;
  amountCents: number;
  feeCents?: number;
  currency: string;
  /*
   * Exactly one of the three. A secret asks the browser to confirm, a redirect
   * sends it elsewhere, and `processing` means a card already kept has been
   * charged and there is nothing to do but wait for the webhook.
   */
  clientSecret?: string;
  redirectUrl?: string;
  processing?: boolean;
};

/**
 * What a purchase would cost, priced by the server and creating nothing.
 *
 * The order summary prints these figures before anybody has committed to
 * anything. They come from `GET /payments/quote`, which runs the same pricing
 * the checkout runs but records no payment and calls no provider - so a buyer
 * reading the summary and then paying with a card they already saved does not
 * leave an abandoned order behind for having looked.
 */
export type CreditQuote = {
  /** What the account receives: the gross, less the fee, floored. */
  credits: number;
  /** What was asked for, before the fee. */
  grossCredits: number;
  unitPriceCents: number;
  /** What is charged. A fee never inflates this. */
  amountCents: number;
  feeCents: number;
  currency: string;
};

export type RefundOutcome = {
  payment: Payment;
  creditsSold: number;
  creditsReversed: number;
  shortfall: number;
};

export const STATE_LABELS: Record<PaymentState, string> = {
  pending: 'Waiting for payment',
  paid: 'Paid',
  failed: 'Failed',
  expired: 'Expired',
  refunding: 'Refund in progress',
  refunded: 'Refunded',
};

export const STATE_STYLES: Record<PaymentState, string> = {
  pending: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200',
  paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200',
  expired: 'bg-gray-200 text-gray-700 dark:bg-slate-700 dark:text-slate-200',
  refunding: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200',
  refunded: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
};

/**
 * Money, formatted by the platform rather than by hand.
 *
 * Cents divided by a hundred and nothing else: the value arrives as an integer
 * precisely so that no arithmetic here can introduce a rounding error into a
 * number somebody is about to be charged.
 */
export function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** True while a payment might still be decided, and so is worth polling for. */
export function isPaymentPending(payment: Payment): boolean {
  return payment.state === 'pending';
}

/** What may be asked for. A count, never an amount. */
export type CheckoutRequest = {
  method: PaymentMethod;
  credits: number;
  /*
   * There was an `asset` here, naming a coin. It went when the coins did: the
   * server removed it from both request surfaces on the grounds that a
   * parameter accepted and ignored is worse than one that is gone, and then
   * this side kept sending it for three commits. Cryptomus asks for the coin on
   * its own page, from its own list.
   */
  /** Charge a card already kept, instead of showing the form. */
  cardId?: string;
  /** Keep the card about to be entered. */
  saveCard?: boolean;
};

export const paymentsApi = {
  options: () => apiFetch<PaymentOptions>('/payments/methods'),
  quote: (request: { method: PaymentMethod; credits: number }) => {
    const query = new URLSearchParams({
      method: request.method,
      credits: String(request.credits),
    });
    return apiFetch<CreditQuote>(`/payments/quote?${query.toString()}`);
  },
  /**
   * A page of this account's own payments.
   *
   * `total` is what lets the page say how many it is not showing. The
   * parameters are optional at the API, so an older tab that sends neither
   * keeps getting the newest 50 exactly as it did.
   */
  list: (offset = 0, limit = 0) =>
    apiFetch<{ payments: Payment[]; total: number; offset: number }>(
      `/payments?offset=${offset}${limit ? `&limit=${limit}` : ''}`
    ),
  get: (id: string) =>
    apiFetch<{ payment: Payment }>(`/payments/${id}`),
  checkout: (request: CheckoutRequest) =>
    apiFetch<StartedCheckout>('/payments/checkout', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  cards: () => apiFetch<{ cards: SavedCard[] }>('/payments/cards'),
  deleteCard: (id: string) =>
    apiFetch<{ deleted: true }>(`/payments/cards/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

export const adminPaymentsApi = {
  /** One page of payments, newest first. `offset` fetches the next lot. */
  list: (offset = 0) =>
    apiFetch<{ payments: AdminPayment[]; total: number; offset: number }>(
      `/admin/payments?offset=${offset}`
    ),
  refund: (id: string, note: string) =>
    apiFetch<RefundOutcome>(`/admin/payments/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
};

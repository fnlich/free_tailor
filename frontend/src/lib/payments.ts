import { apiFetch } from './api';

/**
 * Buying credit.
 *
 * A credit is a dollar. A buyer chooses an amount of money, is charged exactly
 * that and credited exactly that - $50 by card or by crypto is $50 of
 * credit, with nothing taken out - so "what does it cost" and "what do I get"
 * are one number.
 *
 * The one thing to know reading this: **a checkout request carries the amount
 * the buyer TYPED, in dollars (`amountUsd`), and the server decides whether it
 * may be bought.** It quotes from its own bounds, so the page below cannot show
 * an amount the server would not charge - it displays the server's figures,
 * from the same place, rather than working one out. Every amount coming back
 * is an integer count of thousandths of a dollar in a field ending `Milli`,
 * shown with lib/format.ts's `formatMoney`.
 */

export type PaymentMethod = 'card' | 'crypto';
export type PaymentProvider = 'stripe' | 'coinbase' | 'chain' | 'cryptomus';
export type PaymentState = 'pending' | 'paid' | 'failed' | 'expired' | 'refunding' | 'refunded';

export type MethodAvailability = {
  method: PaymentMethod;
  provider: PaymentProvider;
  label: string;
  available: boolean;
  /**
   * Why it is not on offer. Written for the operator, not the customer, so the
   * server sends it to administrators and the page shows it to nobody else.
   */
  reason?: string;
};

/**
 * One thing a buyer can choose, with its own limits and buttons.
 *
 * The presets are the server's amounts, already inside this method's bounds,
 * so a $50 button is `formatMoney(preset.amountMilli)` - a figure the server
 * worked out and will charge.
 */
export type PaymentTarget = {
  id: string;
  method: PaymentMethod;
  label: string;
  /** Which mark to draw. A key into the marks registry, never a URL. */
  mark: string;
  available: boolean;
  /** As `MethodAvailability.reason`: the operator's, shown to administrators only. */
  reason?: string;
  /** The smallest purchase, in thousandths of a dollar. Always whole cents. */
  minAmountMilli: number;
  /** The largest purchase, in thousandths of a dollar. Always whole cents. */
  maxAmountMilli: number;
  presets: Array<{ amountMilli: number }>;
  custom: 'slider' | 'stepper';
};

export type PaymentOptions = {
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

/**
 * What a payment made before credits became dollars bought, as it was written:
 * a count of credits at a price per credit, possibly less a fee. Its receipt
 * keeps saying "200 Credits at $0.50 each", because a receipt has to say what
 * was sold - and its credits are never converted into dollars: they were
 * reset to $0 with every balance.
 */
export type LegacyPaymentCredits = {
  /** Credits quoted. */
  credits: number;
  /** Credits the ledger received; 0 on a very old row, which means read `credits`. */
  creditsGranted: number;
  /** Credits a refund reversed. */
  refundedCredits: number;
  /** What one credit cost then, in thousandths of a dollar (500 = $0.50). */
  unitPriceMilli: number;
};

export type Payment = {
  id: string;
  reference: string;
  userId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  providerRef?: string;
  currency: string;
  state: PaymentState;
  failure: string;
  creditedAt?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** What was charged, in thousandths of a dollar. */
  amountMilli: number;
  /** A fee taken by a crypto payment from before purchases stopped taking one. 0 since. */
  feeMilli: number;
  /**
   * What this payment credits: exactly its charge. 0 on a payment made before
   * credits were dollars - unless it was still waiting to be paid when they
   * became so, in which case it credits its charge like any since.
   */
  creditMilli: number;
  /** What the ledger actually received for it. 0 until it is paid, and on a payment from before dollars. */
  creditedMilli: number;
  /** What a refund took back off the balance. */
  refundedMilli: number;
  /**
   * The money a refund RETURNED, in thousandths of a dollar: the whole charge
   * from the payments list's Refund, the unspent part (in whole cents) from a
   * refund request, what an administrator sent by hand for crypto - so it can
   * be less than `amountMilli`. 0 until refunded.
   */
  refundAmountMilli: number;
  /** Non-null on a payment made before credits became dollars. */
  legacyCredits: LegacyPaymentCredits | null;
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
  /** What will be charged, in thousandths of a dollar. */
  amountMilli: number;
  /** What the balance receives once it is paid: the same amount. */
  creditMilli: number;
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
 * leave an abandoned order behind for having looked. It is also where an
 * amount outside the method's bounds, or in fractions of a cent, is refused
 * by name.
 */
export type PurchaseQuote = {
  /** What is charged, in thousandths of a dollar. */
  amountMilli: number;
  /** What the account receives: always the same amount - nothing is taken out. */
  creditMilli: number;
  currency: string;
};

/** What an administrator's refund did, in thousandths of a dollar. */
export type RefundOutcome = {
  payment: Payment;
  /** What the payment had put on the balance. 0 for one from before credits were dollars. */
  creditedMilli: number;
  /** What could be taken back off the balance. */
  reversedMilli: number;
  /** What could not, because it had already been spent. */
  shortfallMilli: number;
  /** The money returned. The whole charge, from this button. */
  refundAmountMilli?: number;
  /** Refund requests still open for the payment that this refund closed as Refunded. */
  closedRequests?: number;
};

export const STATE_LABELS: Record<PaymentState, string> = {
  pending: 'Waiting for payment',
  paid: 'Paid',
  failed: 'Failed',
  expired: 'Expired',
  refunding: 'Refund in progress',
  refunded: 'Refunded',
};

/**
 * The pill colour each state gets, wherever a payment is shown - the buyer's
 * order history, the return page and the administrator's list - so one payment
 * reads alike on all three. A kit Pill tone (components/ui/kit.tsx), named here
 * as plain strings so this module does not import from components.
 */
export const STATE_TONES: Record<PaymentState, 'green' | 'amber' | 'red' | 'grey' | 'sky'> = {
  paid: 'green',
  pending: 'amber',
  failed: 'red',
  expired: 'grey',
  refunding: 'sky',
  refunded: 'grey',
};

/*
 * There was a `formatAmount(cents, currency)` here, through Intl. Money is
 * `formatMoney` from lib/format.ts now, everywhere: thousandths, every
 * significant decimal, the same digits the server writes into its own sentences. Two
 * formatters were two ways for the order table and the summary above it to
 * disagree about the same purchase.
 */

/** True while a payment might still be decided, and so is worth polling for. */
export function isPaymentPending(payment: Payment): boolean {
  return payment.state === 'pending';
}

/**
 * True once money moved and credit landed - including a payment since
 * refunded, which was still paid for. What an invoice can be issued for, and
 * when a "credit received" figure means anything.
 */
export function isPaymentSettled(payment: Payment): boolean {
  return payment.state === 'paid' || payment.state === 'refunding' || payment.state === 'refunded';
}

/**
 * What may be asked for: an amount in dollars, as the buyer chose it, and never
 * a price - the server decides whether that amount may be bought.
 */
export type CheckoutRequest = {
  method: PaymentMethod;
  /** Dollars and cents, as text: "25", "12.50". Parsed exactly by the server. */
  amountUsd: string;
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
  quote: (request: { method: PaymentMethod; amountUsd: string }) => {
    const query = new URLSearchParams({
      method: request.method,
      amountUsd: request.amountUsd,
    });
    return apiFetch<PurchaseQuote>(`/payments/quote?${query.toString()}`);
  },
  /**
   * A page of this account's own payments.
   *
   * `total` is what lets the page say how many it is not showing. Without
   * `limit` the server answers the newest 50.
   *
   * `method` narrows both the rows and `total` to card or crypto. Left out,
   * the list spans both.
   */
  list: (offset = 0, limit = 0, method?: PaymentMethod) =>
    apiFetch<{ payments: Payment[]; total: number; offset: number }>(
      `/payments?offset=${offset}${limit ? `&limit=${limit}` : ''}${method ? `&method=${method}` : ''}`
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

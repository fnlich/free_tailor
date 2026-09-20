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
export type PaymentProvider = 'stripe' | 'coinbase';
export type PaymentState = 'pending' | 'paid' | 'failed' | 'expired' | 'refunding' | 'refunded';

export type MethodAvailability = {
  method: PaymentMethod;
  provider: PaymentProvider;
  label: string;
  available: boolean;
  /** Why it is not on offer. Written for the operator, not the customer. */
  reason?: string;
};

export type PaymentOptions = {
  unitPriceCents: number;
  minCredits: number;
  maxCredits: number;
  currency: string;
  methods: MethodAvailability[];
};

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
  state: PaymentState;
  failure: string;
  creditedAt?: string;
  refundedAt?: string;
  refundedCredits: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminPayment = Payment & { userEmail: string };

export type StartedCheckout = {
  paymentId: string;
  reference: string;
  credits: number;
  amountCents: number;
  currency: string;
  redirectUrl: string;
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

export const paymentsApi = {
  options: () => apiFetch<PaymentOptions>('/payments/methods'),
  list: () => apiFetch<{ payments: Payment[] }>('/payments'),
  get: (id: string) => apiFetch<{ payment: Payment }>(`/payments/${id}`),
  checkout: (method: PaymentMethod, credits: number) =>
    apiFetch<StartedCheckout>('/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ method, credits }),
    }),
};

export const adminPaymentsApi = {
  list: () => apiFetch<{ payments: AdminPayment[] }>('/admin/payments'),
  refund: (id: string, note: string) =>
    apiFetch<RefundOutcome>(`/admin/payments/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
};

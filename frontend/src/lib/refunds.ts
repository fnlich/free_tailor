import { apiFetch } from './api';

/**
 * Refund requests: somebody asks for their money (a purchase's unspent part)
 * or one resume's charge back, with a reason, and an administrator decides.
 *
 * The SERVER measures every amount - a request carries which thing is asked
 * about and why, never a figure - and every amount coming back is an integer
 * count of thousandths of a dollar in a field ending `Milli`, shown with
 * lib/format.ts's `formatMoney`. How a request reads (its pill, its sentence,
 * which buttons it gets) is lib/refundDisplay.ts, which has no request in it so
 * backend/test can load it.
 *
 * The four states, set by an administrator only:
 *
 *   Requested -> Approved                (accepted; no money moves yet)
 *   Requested | Approved -> Declined     (with the administrator's reason; final)
 *   Requested | Approved -> Refunded     (the money moves in the same step; final)
 */

export type RefundRequestState = 'requested' | 'approved' | 'declined' | 'refunded';

/** A list filter: one state, `open` (requested and approved together), or `all`. */
export type RefundStateFilter = RefundRequestState | 'open' | 'all';

export type RefundKind = 'purchase' | 'resume';

/**
 * How the thing asked about is named. A resume has exactly one name: an order
 * item, the charge of a resume the builder handed straight back, or - while
 * the queue still holds its run - the task of a queued resume not placed as an
 * order.
 */
export type RefundItemType = 'payment' | 'order-item' | 'task' | 'charge';

/** Why something cannot be asked about right now. The sentence comes with it. */
export type RefundUnavailableCode =
  | 'refunded'
  | 'refunding'
  | 'not-paid'
  | 'legacy'
  | 'nothing-unspent'
  | 'in-progress'
  | 'auto-refunded'
  | 'not-charged'
  | 'cost-unknown';

/** A request as the person who asked reads it. */
export type RefundRequest = {
  id: string;
  /** `FT-RF-20261005-0001`: what to quote. */
  reference: string;
  kind: RefundKind;
  itemType: RefundItemType;
  itemId: string;
  /** What it is about, in words: "FT-20261005-0003 - Card purchase of $25.000", "Jane / Acme (Engineer)". */
  label: string;
  /** What would come back, measured when it was asked. */
  amountMilli: number;
  /** What actually came back. 0 until Refunded. */
  refundedMilli: number;
  /** Why they asked, in their own words. */
  reason: string;
  state: RefundRequestState;
  /** The administrator's reason, written for the person who asked. '' unless Declined. */
  declineReason: string;
  /** For a purchase, how it was paid; null for a resume. */
  paymentMethod: 'card' | 'crypto' | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  refundedAt: string | null;
};

/** A request as an administrator reads it in the queue. */
export type AdminRefundRequest = RefundRequest & {
  accountId: string;
  /** '' once the account has been deleted. */
  accountEmail: string;
  paymentProvider: 'stripe' | 'cryptomus' | 'coinbase' | 'chain' | null;
  paymentReference: string | null;
  decidedBy: string | null;
  refundedBy: string | null;
  /** What a card refund was last sent to Stripe with, when one was. A retry sends the same. */
  attemptMilli: number | null;
  /**
   * For an open request: what Refunded would give back NOW - re-measured,
   * never above `amountMilli` - or 0 with `refundableNowReason` saying why
   * nothing would. Null on a decided request.
   */
  refundableNowMilli: number | null;
  refundableNowReason: string | null;
};

/** One thing that may be asked about, from wherever a charge is shown. */
export type RefundOption = {
  kind: RefundKind;
  itemType: RefundItemType;
  itemId: string;
  label: string;
  /** What the purchase charged, or what the resume was charged. */
  chargedMilli: number;
  /** What a request would give back now. 0 when it cannot be asked about. */
  refundableMilli: number;
  /** False when it cannot be asked about - or a request for it is already open. */
  available: boolean;
  unavailableCode: RefundUnavailableCode | null;
  /** The sentence for `unavailableCode`, written for whoever is looking. */
  unavailableReason: string | null;
  paymentMethod: 'card' | 'crypto' | null;
  /** The request already Requested or Approved for it, if any. One per item. */
  openRequest: RefundRequest | null;
};

/**
 * Where the options are being asked from: a purchase on the order history, an
 * order's resumes, or a charge line of the credit history (`chargeId` is the
 * ledger row's `refId`).
 */
export type RefundSource = { paymentId: string } | { orderId: string } | { chargeId: string };

/** What a Refunded press moved. Null when it moved nothing - already refunded, or a second click. */
export type RefundMoved = {
  /** What went back to the person: credit for a resume, money for a purchase. */
  refundedMilli: number;
  /** For a purchase, the credit taken back off the balance. */
  reversedMilli: number;
  /** For a purchase, what could not be taken back because it was spent since. */
  shortfallMilli: number;
};

export type RefundRequestCounts = Record<RefundRequestState, number>;

function sourceQuery(source: RefundSource): string {
  if ('paymentId' in source) return `paymentId=${encodeURIComponent(source.paymentId)}`;
  if ('orderId' in source) return `orderId=${encodeURIComponent(source.orderId)}`;
  return `chargeId=${encodeURIComponent(source.chargeId)}`;
}

function pageQuery(offset: number, limit: number, state?: RefundStateFilter): string {
  return `offset=${offset}${limit ? `&limit=${limit}` : ''}${state ? `&state=${state}` : ''}`;
}

export const refundRequestsApi = {
  /** This account's own requests, newest first. */
  list: (offset = 0, limit = 0, state?: RefundStateFilter) =>
    apiFetch<{ requests: RefundRequest[]; total: number; offset: number }>(
      `/refund-requests?${pageQuery(offset, limit, state)}`
    ),
  /** What may be asked about from one place, and what each would give back. Asks nothing. */
  options: (source: RefundSource) =>
    apiFetch<{ items: RefundOption[]; note: string | null }>(`/refund-requests/options?${sourceQuery(source)}`),
  /** Asks. No amount: the server measures it. */
  create: (input: { itemType: RefundItemType; itemId: string; reason: string }) =>
    apiFetch<{ request: RefundRequest }>('/refund-requests', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};

export const adminRefundRequestsApi = {
  /** The queue. Open requests oldest first, as a queue is worked; any other filter newest first. */
  list: (offset = 0, limit = 0, state: RefundStateFilter = 'open') =>
    apiFetch<{ requests: AdminRefundRequest[]; total: number; offset: number; counts: RefundRequestCounts }>(
      `/admin/refund-requests?${pageQuery(offset, limit, state)}`
    ),
  approve: (id: string) =>
    apiFetch<{ request: AdminRefundRequest; changed: boolean }>(
      `/admin/refund-requests/${encodeURIComponent(id)}/approve`,
      { method: 'POST' }
    ),
  decline: (id: string, reason: string) =>
    apiFetch<{ request: AdminRefundRequest; changed: boolean }>(
      `/admin/refund-requests/${encodeURIComponent(id)}/decline`,
      { method: 'POST', body: JSON.stringify({ reason }) }
    ),
  /**
   * Refunded, and the refund itself. A crypto purchase needs `paidByHand: true`
   * - the administrator's word that the money went back from the merchant
   * dashboard - with what was sent (`amountUsd`, whole cents; required, and
   * built by refundDisplay's `byHandRefundBody`). A card purchase sends nothing.
   */
  refund: (id: string, body: { paidByHand: true; amountUsd: string } | Record<string, never> = {}) =>
    apiFetch<{ request: AdminRefundRequest; changed: boolean; outcome: RefundMoved | null }>(
      `/admin/refund-requests/${encodeURIComponent(id)}/refund`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
};

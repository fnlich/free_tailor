import { apiFetch } from './api';

/**
 * Refund and payout requests, and the administrators' queue of them.
 *
 * Only a REPORTER asks now, and only to be paid out (owner decision R1): the
 * whole earned balance, with an optional note, never a figure they type. Users
 * and administrators no longer ask for refunds in the app - the server answers
 * the old asking routes 410 `refund-requests-closed` - but what they asked
 * before is still listed on /credits, read-only, and every request still open
 * is decided in the queue exactly as before.
 *
 * Every amount coming back is an integer count of thousandths of a dollar in
 * a field ending `Milli`, shown with lib/format.ts's `formatMoney`; an amount
 * sent is dollars as typed, in a field ending `Usd`. How a request reads (its
 * pill, its sentence, which buttons it gets) is lib/refundDisplay.ts, which has
 * no request in it so backend/test can load it.
 *
 * The four states, set by an administrator only:
 *
 *   Requested -> Approved                (accepted; no money moves yet)
 *   Requested | Approved -> Declined     (with the administrator's reason; final)
 *   Requested | Approved -> Refunded     (the money moves - or, for a payout,
 *                                         the payout is recorded - in the same
 *                                         step; final. "Paid out" on a payout)
 */

export type RefundRequestState = 'requested' | 'approved' | 'declined' | 'refunded';

/** A list filter: one state, `open` (requested and approved together), or `all`. */
export type RefundStateFilter = RefundRequestState | 'open' | 'all';

/** What a request is about: a purchase, one resume's charge, or a reporter's earned balance. */
export type RefundKind = 'purchase' | 'resume' | 'payout';

/** A list filter on the kind: one kind, or `all`. */
export type RefundKindFilter = RefundKind | 'all';

/**
 * How the thing asked about is named. A resume has exactly one name: an order
 * item, the charge of a resume the builder handed straight back, or - while
 * the queue still holds its run - the task of a queued resume not placed as an
 * order. A payout's item is the reporter's own account (`itemId`).
 */
export type RefundItemType = 'payment' | 'order-item' | 'task' | 'charge' | 'payout';

/** A request as the person who asked reads it. */
export type RefundRequest = {
  id: string;
  /** `FT-RF-20261005-0001`: what to quote. */
  reference: string;
  kind: RefundKind;
  itemType: RefundItemType;
  itemId: string;
  /**
   * What it is about, in words: "FT-20261005-0003 - Card purchase of $25",
   * "Jane / Acme (Engineer)", "Payout of earnings". Fixed when asked, so an
   * older one keeps the figures it was written with ("$25.000").
   */
  label: string;
  /** What would come back, measured when it was asked - for a payout, the balance then. */
  amountMilli: number;
  /**
   * What actually came back. 0 until Refunded. For a payout, what the
   * administrator recorded as sent - which may be MORE than was asked, up to
   * the balance when it was recorded (owner decision R2).
   */
  refundedMilli: number;
  /** Why they asked, in their own words. A payout's note is optional, so it may be ''. */
  reason: string;
  state: RefundRequestState;
  /** The administrator's reason, written for the person who asked. '' unless Declined. */
  declineReason: string;
  /** For a purchase, how it was paid; null for a resume or a payout. */
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
   * nothing would. For a payout, the reporter's balance now: the most Record
   * payout may record (0 with the reason once the account is no longer a
   * reporter, or is gone). Null on a decided request.
   */
  refundableNowMilli: number | null;
  refundableNowReason: string | null;
};

/** Why a reporter cannot ask for a payout now - the server's `PayoutUnavailableCode`. */
export type PayoutUnavailableCode = 'not-a-reporter' | 'request-open' | 'nothing-to-pay-out';

/** A reporter's payout standing: GET /api/refund-requests/payout. */
export type PayoutStatus = {
  /** The earned balance: what a request would ask for now. */
  balanceMilli: number;
  /** Their open payout request, if any - one at a time. */
  openRequest: RefundRequest | null;
  available: boolean;
  unavailableCode: PayoutUnavailableCode | null;
  /** The sentence for `unavailableCode`, written for the reporter. */
  unavailableReason: string | null;
};

/** What a Refunded press moved. Null when it moved nothing - already refunded, or a second click. */
export type RefundMoved = {
  /** What went back to the person: credit for a resume, money for a purchase, a payout recorded. */
  refundedMilli: number;
  /** For a purchase, the credit taken back off the balance. */
  reversedMilli: number;
  /** For a purchase, what could not be taken back because it was spent since. */
  shortfallMilli: number;
};

export type RefundRequestCounts = Record<RefundRequestState, number>;

function pageQuery(offset: number, limit: number, state?: RefundStateFilter, kind?: RefundKindFilter): string {
  return (
    `offset=${offset}${limit ? `&limit=${limit}` : ''}${state ? `&state=${state}` : ''}` +
    `${kind ? `&kind=${kind}` : ''}`
  );
}

export const refundRequestsApi = {
  /**
   * This account's own requests, newest first - a reporter's payout requests
   * with `kind: 'payout'`. Read-only: nothing here asks for a refund any more.
   */
  list: (offset = 0, limit = 0, state?: RefundStateFilter, kind?: RefundKindFilter) =>
    apiFetch<{ requests: RefundRequest[]; total: number; offset: number }>(
      `/refund-requests?${pageQuery(offset, limit, state, kind)}`
    ),
};

/**
 * A reporter's payout requests (owner decision R1). Both routes are a
 * reporter's alone (requireReporter): a user is refused 403
 * `role-not-allowed`, an administrator 409 `not-a-reporter`.
 */
export const payoutRequestsApi = {
  /** Whether they may ask now, and their open request if there is one. Asks nothing. */
  status: () => apiFetch<PayoutStatus>('/refund-requests/payout'),
  /**
   * Asks to be paid out the WHOLE balance as it stands. Never an amount: the
   * server reads the balance itself, and the administrator records what they
   * actually sent. `reason` is the reporter's optional note.
   */
  create: (reason: string) =>
    apiFetch<{ request: RefundRequest; status: PayoutStatus }>('/refund-requests/payout', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};

/**
 * What Refunded sends. A crypto purchase needs `paidByHand: true` - the
 * administrator's word that the money went back from the merchant dashboard -
 * with what was sent (`amountUsd`, whole cents; required, and built by
 * refundDisplay's `byHandRefundBody`). A payout needs what was actually paid
 * (`amountUsd`, to $0.001, up to the reporter's balance) and how (`note`). A
 * card purchase or a resume sends nothing.
 */
export type RefundBody =
  | { paidByHand: true; amountUsd: string }
  | { amountUsd: string; note: string }
  | Record<string, never>;

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
  /** Refunded, and the refund itself - or, for a payout, Record payout. See `RefundBody`. */
  refund: (id: string, body: RefundBody = {}) =>
    apiFetch<{ request: AdminRefundRequest; changed: boolean; outcome: RefundMoved | null }>(
      `/admin/refund-requests/${encodeURIComponent(id)}/refund`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
};

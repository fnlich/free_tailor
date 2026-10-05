import crypto from 'crypto';

import { getDb } from './sqlite';
import { formatSequenceDate, nextDailyReference } from './dailySequence';

/**
 * Refund requests: somebody asking for money back, and what an administrator
 * decided.
 *
 * This module moves no money and knows nothing about balances or providers -
 * services/refunds does that, and writes the state change here in the same
 * transaction as the money it describes. What this module owns is the state
 * machine, and it is enforced in the WHERE clause, in the style of
 * paymentRepository: a double click, two tabs or two administrators cannot
 * talk a request backwards or decide it twice, because only one UPDATE can
 * match.
 *
 *   requested -> approved                (no money moves)
 *   requested | approved -> declined     (a reason is required; final)
 *   requested | approved -> refunded     (the money moves in the same step; final)
 *
 * "One open request per item" is the database's rule, not this module's: a
 * partial UNIQUE index over (item_key) WHERE state is requested or approved
 * (database/sqlite.ts), so a second request is refused however the two
 * arrive, and a declined request does not stop the next one.
 */

export type RefundRequestKind = 'purchase' | 'resume';
export type RefundRequestState = 'requested' | 'approved' | 'declined' | 'refunded';

/**
 * What a request names, as the API spells it. One per way a charge can exist:
 *
 * - `payment`: a purchase. Refundable: its unspent part.
 * - `order-item`: one resume of an order - durable, priced from the item.
 * - `task`: one resume of a queued run with NO order row, while the queue
 *   still holds its batch (up to an hour after it settles, sooner once twenty
 *   newer batches have finished). Since Generate Immediately runs are filed
 *   with an order row of their own (kind `immediate`), every run queued now
 *   has one, so this names only a builder run queued by an older build and
 *   restored - kept so a request made before the upgrade still reads, and
 *   gone in practice once those batches are evicted. A task of a batch WITH
 *   an order row is always named by its order item instead, so one resume
 *   never has two names and so never two open requests.
 * - `charge`: one resume built synchronously by POST /api/resume/generate,
 *   named by its reservation - which is that resume alone.
 */
export const REFUND_ITEM_TYPES = ['payment', 'order-item', 'task', 'charge'] as const;
export type RefundItemType = (typeof REFUND_ITEM_TYPES)[number];

export const REFUND_REQUEST_STATES: readonly RefundRequestState[] = ['requested', 'approved', 'declined', 'refunded'];
export const OPEN_REFUND_STATES: readonly RefundRequestState[] = ['requested', 'approved'];

export function isRefundItemType(value: unknown): value is RefundItemType {
  return typeof value === 'string' && (REFUND_ITEM_TYPES as readonly string[]).includes(value);
}

export function isRefundRequestState(value: unknown): value is RefundRequestState {
  return typeof value === 'string' && (REFUND_REQUEST_STATES as readonly string[]).includes(value);
}

/** The one string an item is known by, which the open-request index is over. */
export function refundItemKey(itemType: RefundItemType, itemId: string): string {
  return `${itemType}:${itemId}`;
}

export type RefundRequest = {
  id: string;
  /** `FT-RF-YYYYMMDD-NNNN`, for quoting. */
  reference: string;
  accountId: string;
  kind: RefundRequestKind;
  itemType: RefundItemType;
  itemId: string;
  itemKey: string;
  paymentId?: string;
  orderItemId?: string;
  taskId?: string;
  /** The reservation a resume was charged under - what a resume refund is given back against. */
  reservationId?: string;
  /** What it is for, in words, fixed when asked. */
  label: string;
  /** Thousandths of a dollar refundable when it was asked for. */
  amountMilli: number;
  /** Thousandths of a dollar actually returned. 0 until refunded. */
  refundedMilli: number;
  /**
   * A card refund not yet confirmed: the amount it was sent to Stripe with,
   * written - and that much credit taken off the balance - BEFORE the call.
   * Null when no card refund is outstanding: none was tried, or Stripe refused
   * the last one and its credit went back.
   */
  attemptMilli: number | null;
  /** The ledger key the credit held for that refund was taken off under; null with `attemptMilli`. */
  holdKey: string | null;
  /** The requester's own words. */
  reason: string;
  state: RefundRequestState;
  /** The administrator's own words, when declined; '' otherwise. */
  declineReason: string;
  decidedBy?: string;
  decidedAt?: string;
  refundedBy?: string;
  refundedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type RefundRequestRow = {
  id: string;
  reference: string;
  account_id: string;
  kind: string;
  item_key: string;
  payment_id: string | null;
  order_item_id: string | null;
  task_id: string | null;
  reservation_id: string | null;
  label: string;
  amount_milli: number;
  refunded_milli: number;
  attempt_milli: number | null;
  hold_key: string | null;
  reason: string;
  state: string;
  decline_reason: string;
  decided_by: string | null;
  decided_at: string | null;
  refunded_by: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = `id, reference, account_id, kind, item_key, payment_id, order_item_id, task_id,
  reservation_id, label, amount_milli, refunded_milli, attempt_milli, hold_key, reason, state, decline_reason,
  decided_by, decided_at, refunded_by, refunded_at, created_at, updated_at`;

/** SQL for the open states, kept beside the constant it spells. */
const OPEN_SQL = "('requested', 'approved')";

function now(): string {
  return new Date().toISOString();
}

function toRequest(row: RefundRequestRow): RefundRequest {
  const separator = row.item_key.indexOf(':');
  const itemType = row.item_key.slice(0, separator);
  return {
    id: row.id,
    reference: row.reference,
    accountId: row.account_id,
    kind: row.kind === 'purchase' ? 'purchase' : 'resume',
    itemType: isRefundItemType(itemType) ? itemType : 'payment',
    itemId: row.item_key.slice(separator + 1),
    itemKey: row.item_key,
    ...(row.payment_id ? { paymentId: row.payment_id } : {}),
    ...(row.order_item_id ? { orderItemId: row.order_item_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.reservation_id ? { reservationId: row.reservation_id } : {}),
    label: row.label ?? '',
    amountMilli: row.amount_milli,
    refundedMilli: row.refunded_milli ?? 0,
    attemptMilli: typeof row.attempt_milli === 'number' ? row.attempt_milli : null,
    holdKey: typeof row.hold_key === 'string' && row.hold_key ? row.hold_key : null,
    reason: row.reason,
    state: isRefundRequestState(row.state) ? row.state : 'requested',
    declineReason: row.decline_reason ?? '',
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.refunded_by ? { refundedBy: row.refunded_by } : {}),
    ...(row.refunded_at ? { refundedAt: row.refunded_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type NewRefundRequest = {
  accountId: string;
  kind: RefundRequestKind;
  itemType: RefundItemType;
  itemId: string;
  paymentId?: string;
  orderItemId?: string;
  taskId?: string;
  reservationId?: string;
  label: string;
  amountMilli: number;
  reason: string;
};

/** A second open request for an item that already has one. The index decided it. */
export class OpenRefundRequestExists extends Error {
  constructor(readonly itemKey: string) {
    super(`An open refund request already exists for ${itemKey}.`);
    this.name = 'OpenRefundRequestExists';
  }
}

/**
 * Writes a new request in the `requested` state, or throws
 * `OpenRefundRequestExists` when the item already has an open one.
 *
 * The insert is the decision, not a read before it: two submissions racing
 * both see no open request if they look first, and only one can win the
 * partial UNIQUE index. The reference retry covers the one race the other
 * UNIQUE index can catch - two requests in the same millisecond reaching for
 * the same number.
 */
export function insertRefundRequest(input: NewRefundRequest, at: Date = new Date()): RefundRequest {
  if (!Number.isSafeInteger(input.amountMilli) || input.amountMilli <= 0) {
    throw new Error(`A refund request must be for a positive whole number of thousandths, not ${input.amountMilli}.`);
  }
  const db = getDb();
  const timestamp = at.toISOString();
  const datePart = formatSequenceDate(at);
  const itemKey = refundItemKey(input.itemType, input.itemId);

  const insert = (reference: string): RefundRequestRow => {
    const id = `rfr_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO refund_requests (id, reference, account_id, kind, item_key, payment_id, order_item_id,
                                    task_id, reservation_id, label, amount_milli, reason, state,
                                    created_at, updated_at)
       VALUES (@id, @reference, @accountId, @kind, @itemKey, @paymentId, @orderItemId,
               @taskId, @reservationId, @label, @amountMilli, @reason, 'requested',
               @createdAt, @createdAt)`
    ).run({
      id,
      reference,
      accountId: input.accountId,
      kind: input.kind,
      itemKey,
      paymentId: input.paymentId ?? null,
      orderItemId: input.orderItemId ?? null,
      taskId: input.taskId ?? null,
      reservationId: input.reservationId ?? null,
      label: input.label,
      amountMilli: input.amountMilli,
      reason: input.reason,
      createdAt: timestamp,
    });
    return db.prepare(`SELECT ${COLUMNS} FROM refund_requests WHERE id = ?`).get(id) as RefundRequestRow;
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return toRequest(insert(nextDailyReference('refund_requests', 'reference', 'FT-RF-', datePart)));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/UNIQUE constraint failed: refund_requests\.item_key/i.test(message)) {
        throw new OpenRefundRequestExists(itemKey);
      }
      if (!/UNIQUE constraint failed: refund_requests\.reference/i.test(message)) throw error;
    }
  }
  throw new Error('Could not allocate a refund request reference.');
}

export function getRefundRequest(id: string): RefundRequest | null {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM refund_requests WHERE id = ?`).get(id) as
    | RefundRequestRow
    | undefined;
  return row ? toRequest(row) : null;
}

/** The open request for an item, if there is one - at most one, by the index. */
export function findOpenRequestForItem(itemKey: string): RefundRequest | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM refund_requests WHERE item_key = ? AND state IN ${OPEN_SQL}`)
    .get(itemKey) as RefundRequestRow | undefined;
  return row ? toRequest(row) : null;
}

/** Whether a request for this item has already been refunded - which makes it final for the item. */
export function findRefundedRequestForItem(itemKey: string): RefundRequest | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM refund_requests WHERE item_key = ? AND state = 'refunded' LIMIT 1`)
    .get(itemKey) as RefundRequestRow | undefined;
  return row ? toRequest(row) : null;
}

/** Every open request naming one payment - closed by a refund made from the payments list. */
export function listOpenRequestsForPayment(paymentId: string): RefundRequest[] {
  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM refund_requests WHERE payment_id = ? AND state IN ${OPEN_SQL} ORDER BY created_at`
    )
    .all(paymentId) as RefundRequestRow[];
  return rows.map(toRequest);
}

/**
 * The states a list filter names: one state, or `open` for both open ones.
 * Fixed SQL per shape, every value bound - never a clause spliced from a
 * query string.
 */
function statesClause(states: readonly RefundRequestState[] | undefined): { sql: string; values: string[] } {
  const wanted = (states ?? []).filter(isRefundRequestState);
  if (wanted.length === 0) return { sql: '', values: [] };
  return { sql: `state IN (${wanted.map(() => '?').join(', ')})`, values: [...wanted] };
}

/**
 * One account's requests, newest first. `rowid` breaks the tie on created_at,
 * so two requests made in the same tick cannot swap places between pages.
 */
export function listRefundRequestsForAccount(
  accountId: string,
  options: { states?: readonly RefundRequestState[]; limit?: number; offset?: number } = {}
): RefundRequest[] {
  const { sql, values } = statesClause(options.states);
  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM refund_requests
        WHERE account_id = ?${sql ? ` AND ${sql}` : ''}
        ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    )
    .all(accountId, ...values, options.limit ?? 50, options.offset ?? 0) as RefundRequestRow[];
  return rows.map(toRequest);
}

export function countRefundRequestsForAccount(accountId: string, states?: readonly RefundRequestState[]): number {
  const { sql, values } = statesClause(states);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM refund_requests WHERE account_id = ?${sql ? ` AND ${sql}` : ''}`)
    .get(accountId, ...values) as { n: number };
  return row.n;
}

/**
 * Every account's requests, for the administrators' queue. Oldest first while
 * the filter is only open states - a queue is worked from the front - and
 * newest first otherwise, as a history reads.
 */
export function listRefundRequests(
  options: { states?: readonly RefundRequestState[]; limit?: number; offset?: number } = {}
): RefundRequest[] {
  const { sql, values } = statesClause(options.states);
  const queue =
    (options.states ?? []).length > 0 && (options.states ?? []).every((state) => OPEN_REFUND_STATES.includes(state));
  const rows = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM refund_requests
        ${sql ? `WHERE ${sql}` : ''}
        ORDER BY created_at ${queue ? 'ASC' : 'DESC'}, rowid ${queue ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`
    )
    .all(...values, options.limit ?? 50, options.offset ?? 0) as RefundRequestRow[];
  return rows.map(toRequest);
}

export function countRefundRequests(states?: readonly RefundRequestState[]): number {
  const { sql, values } = statesClause(states);
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM refund_requests${sql ? ` WHERE ${sql}` : ''}`)
    .get(...values) as { n: number };
  return row.n;
}

/** How many requests sit in each state - the queue's tab counts. */
export function countRefundRequestsByState(): Record<RefundRequestState, number> {
  const counts: Record<RefundRequestState, number> = { requested: 0, approved: 0, declined: 0, refunded: 0 };
  const rows = getDb()
    .prepare('SELECT state, COUNT(*) AS n FROM refund_requests GROUP BY state')
    .all() as Array<{ state: string; n: number }>;
  for (const row of rows) {
    if (isRefundRequestState(row.state)) counts[row.state] = row.n;
  }
  return counts;
}

/** requested -> approved. False when it was not `requested` - approved already, or final. */
export function approveRefundRequest(id: string, actorId: string): boolean {
  const at = now();
  return (
    getDb()
      .prepare(
        `UPDATE refund_requests SET state = 'approved', decided_by = @actorId, decided_at = @at, updated_at = @at
          WHERE id = @id AND state = 'requested'`
      )
      .run({ id, actorId, at }).changes > 0
  );
}

/** requested | approved -> declined, with the administrator's reason. False when it was already final. */
export function declineRefundRequest(id: string, actorId: string, reason: string): boolean {
  const at = now();
  return (
    getDb()
      .prepare(
        `UPDATE refund_requests SET state = 'declined', decline_reason = @reason, decided_by = @actorId,
                decided_at = @at, updated_at = @at
          WHERE id = @id AND state IN ${OPEN_SQL}`
      )
      .run({ id, actorId, reason, at }).changes > 0
  );
}

/**
 * requested | approved -> refunded, recording what was returned. False when it
 * was already final. The caller moves the money in the SAME transaction, and
 * rolls both back on false.
 */
export function markRefundRequestRefunded(id: string, actorId: string, refundedMilli: number): boolean {
  if (!Number.isSafeInteger(refundedMilli) || refundedMilli < 0) {
    throw new Error(`A refunded amount must be a whole, non-negative number of thousandths, not ${refundedMilli}.`);
  }
  const at = now();
  return (
    getDb()
      .prepare(
        `UPDATE refund_requests SET state = 'refunded', refunded_milli = @refundedMilli, refunded_by = @actorId,
                refunded_at = @at, updated_at = @at
          WHERE id = @id AND state IN ${OPEN_SQL}`
      )
      .run({ id, actorId, refundedMilli, at }).changes > 0
  );
}

/**
 * Writes down a card refund about to be sent to Stripe: the amount, and the
 * ledger key its credit was just taken off under - in the SAME transaction as
 * that credit and the payment's claim (services/refunds). Once only: a retry
 * after a dropped answer reads them back and sends the same amount, so
 * Stripe's idempotency key meets the same body and returns the same refund
 * instead of refusing - or, worse, refunding a second amount - and the credit
 * is not taken twice.
 */
export function recordRefundHold(id: string, attemptMilli: number, holdKey: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE refund_requests SET attempt_milli = @attemptMilli, hold_key = @holdKey, updated_at = @at
          WHERE id = @id AND state IN ${OPEN_SQL} AND attempt_milli IS NULL AND hold_key IS NULL`
      )
      .run({ id, attemptMilli, holdKey, at: now() }).changes > 0
  );
}

/**
 * Forgets a card refund Stripe REFUSED, in the transaction that gives its held
 * credit back: the next press measures again and holds afresh. Only the hold
 * named, so a late answer cannot clear a newer one.
 */
export function clearRefundHold(id: string, holdKey: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE refund_requests SET attempt_milli = NULL, hold_key = NULL, updated_at = @at
          WHERE id = @id AND hold_key = @holdKey`
      )
      .run({ id, holdKey, at: now() }).changes > 0
  );
}

/**
 * The open request holding a card refund for this payment that Stripe has not
 * confirmed, if any. While one does, the payments list's whole refund is
 * refused: it would take back the credit the request already holds a second
 * time.
 */
export function findUnconfirmedRefundForPayment(paymentId: string): RefundRequest | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM refund_requests
        WHERE payment_id = ? AND state IN ${OPEN_SQL} AND hold_key IS NOT NULL LIMIT 1`
    )
    .get(paymentId) as RefundRequestRow | undefined;
  return row ? toRequest(row) : null;
}

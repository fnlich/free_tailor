import { getDb } from '../../database/sqlite';
import { getUserById, listUsers } from '../../database/userRepository';
import {
  beginRefund,
  getPayment,
  markRefunded,
  releaseRefund,
  type Payment,
} from '../../database/paymentRepository';
import { applyAdjustment } from '../../database/creditRepository';
import {
  findOrderForBatch,
  findOrderItem,
  findOrderItemForBatch,
  getOrder,
  listOrderItems,
  type Order,
  type OrderItem,
} from '../../database/orderRepository';
import {
  approveRefundRequest,
  clearRefundHold,
  countRefundRequests,
  countRefundRequestsByState,
  countRefundRequestsForAccount,
  declineRefundRequest,
  findOpenRequestForItem,
  findRefundedRequestForItem,
  getRefundRequest,
  insertRefundRequest,
  isRefundItemType,
  listOpenRequestsForPayment,
  listRefundRequests,
  listRefundRequestsForAccount,
  markRefundRequestRefunded,
  OpenRefundRequestExists,
  recordRefundHold,
  refundItemKey,
  type RefundItemType,
  type RefundRequest,
  type RefundRequestKind,
  type RefundRequestState,
} from '../../database/refundRequestRepository';
import { createNotification } from '../../database/notificationRepository';
import { getReservation, isLedgerKeyUsed, refundRequestedCharge, type Reservation } from '../credits';
import { getGenerationQueue, isOrderBatch, taskCostMilli } from '../queue';
import {
  isUnansweredRefund,
  PaymentError,
  refundPayment,
  sendCardRefund,
  type RefundOutcome,
} from '../payments';
import { PublicError } from '../../middleware/publicError';
import {
  centsToMilli,
  describeDollarProblem,
  formatMoney,
  isWholeCents,
  milliToCents,
  parseDollars,
  wholeCentsBelow,
} from '../../utils/money';
import type { UserAccount } from '../../types/account';
import type { Batch, Task } from '../queue/taskQueue';

/**
 * Asking for money back (owner decision M3), and an administrator deciding.
 *
 * Two kinds of thing can be asked about, in one queue:
 *
 * - A PURCHASE gives back its UNSPENT part: what is left of what it credited,
 *   measured exactly as `refundPayment` measures a reversal - the balance,
 *   capped at what the payment credited - and rounded down to whole cents,
 *   because a card or a crypto invoice returns cents and a balance moves in
 *   tenths of one. The sub-cent remainder stays on the balance as credit. It is
 *   measured when asked (`amountMilli`, what the person is shown) and again when
 *   refunded, never above what was asked: they may have spent some since.
 *   Money back is the payment's own refund - a PARTIAL Stripe refund for a
 *   card, set Refunded only once Stripe accepts it; for crypto, which nothing
 *   can pull back, the administrator sends it by hand and then confirms - and
 *   either way the same amount of credit is reversed. A card's credit comes off
 *   FIRST, with the payment's claim, and goes back only if Stripe refuses:
 *   what is unspent is a fact about the balance at one moment, and a refund
 *   that measured it and then waited on Stripe before taking it would pay out
 *   credit the buyer spent - or a second refund claimed - in the meantime.
 * - A RESUME CHARGE gives back exactly that resume's own charge, as credit:
 *   one `refund-request` ledger row keyed `refund-request:<id>`, refunded
 *   against the run's reservation (so the run's SQL cap still holds), in the
 *   same transaction as the request turning Refunded.
 *
 * WHICH RESUME. Every charged resume has exactly one name here (the
 * `RefundItemType`s): an order's resume is its ORDER ITEM, which outlives its
 * batch and carries its charge (`order_items.cost_milli`); a resume built by
 * POST /api/resume/generate is its RESERVATION (`charge`), which is that one
 * resume; and a queued resume NOT placed as an order is its TASK, while the
 * queue holds the batch - after that it cannot be named, because nothing
 * durable records what it alone cost. A task of an order's batch is always
 * resolved to its order item, so one resume never has two names and so can
 * never have two open requests.
 *
 * WHO SEES WHAT. A requester's sentences are about their own purchase or
 * resume and say what they can do (PublicError, specific). The administrators'
 * routes go through the same errors, and anything unexpected through
 * `sendPublicError` with a ref, like everywhere else.
 */

/** The longest reason either side may write. A paragraph, not a document. */
export const MAX_REFUND_REASON = 1000;

const REFUND_REQUESTS_PATH = '/credits?tab=refunds';
const ADMIN_REFUND_QUEUE_PATH = '/admin/payments?tab=refunds';

/** A refund request refused, in words written for whoever asked. */
export class RefundRequestError extends PublicError {
  constructor(message: string, status: number, code: string, extra?: Record<string, unknown>) {
    super(message, { status, code, ...(extra ? { extra } : {}) });
    this.name = 'RefundRequestError';
  }
}

/** Why an item cannot be refunded right now, as a code a page can branch on and a sentence anybody can read. */
export type RefundUnavailable = { code: RefundUnavailableCode; message: string };

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

/** One thing that may be asked about, as the server sees it now. */
export type RefundItem = {
  kind: RefundRequestKind;
  itemType: RefundItemType;
  itemId: string;
  itemKey: string;
  /** Whose purchase or resume it is. */
  accountId: string;
  label: string;
  /** What the purchase charged, or what the resume was charged; 0 when it was not. */
  chargedMilli: number;
  /** What a request would give back now; 0 when `unavailable`. */
  refundableMilli: number;
  unavailable: RefundUnavailable | null;
  paymentId?: string;
  paymentMethod?: Payment['method'];
  paymentProvider?: Payment['provider'];
  orderItemId?: string;
  taskId?: string;
  reservationId?: string;
};

function unavailable(code: RefundUnavailableCode, message: string): RefundUnavailable {
  return { code, message };
}

const ALREADY_REFUNDED = (what: string) => unavailable('refunded', `This ${what} has already been refunded.`);
const STILL_BUILDING = unavailable('in-progress', 'This resume is still being built.');
const NOT_DELIVERED = unavailable(
  'auto-refunded',
  'This resume was not delivered, so its charge was refunded automatically.'
);
const NOT_CHARGED = unavailable('not-charged', 'This resume was not charged.');

function notFound(what: 'purchase' | 'resume' | 'charge' | 'order'): RefundRequestError {
  return new RefundRequestError(`That ${what} was not found.`, 404, 'not-found');
}

/**
 * The text a person typed, made safe to store and show: trimmed, control
 * characters other than line breaks and tabs removed. `null` for nothing left.
 */
export function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text ? text : null;
}

function readReason(value: unknown, whose: 'requester' | 'admin'): string {
  const reason = cleanReason(value);
  if (!reason) {
    throw new RefundRequestError(
      whose === 'requester'
        ? 'Say why you are asking for a refund.'
        : 'Write the reason for declining - the person who asked will read it.',
      400,
      'reason-required'
    );
  }
  if (reason.length > MAX_REFUND_REASON) {
    throw new RefundRequestError(
      `Keep the reason under ${MAX_REFUND_REASON} characters.`,
      400,
      'reason-too-long'
    );
  }
  return reason;
}

/* ------------------------------------------------------------ the queue */

/** A task the queue still holds, by its id, with its batch. */
function findLiveTask(taskId: string): { batch: Batch; task: Task } | null {
  for (const batch of getGenerationQueue().listBatches(false)) {
    const task = batch.tasks.find((candidate) => candidate.id === taskId);
    if (task) return { batch, task };
  }
  return null;
}

/** A task's charge while the queue still holds it - for an order item from before items carried one. */
function liveTaskCost(batchId: string, seq: number): number | null {
  const batch = getGenerationQueue().getBatch(batchId);
  const task = batch?.tasks.find((candidate) => candidate.seq === seq);
  return task ? taskCostMilli(task.payload) : null;
}

/* ------------------------------------------------------ resolving items */

/**
 * The part of a purchase not yet spent, in whole cents as thousandths: the
 * balance, capped at what the payment credited - the reversal `refundPayment`
 * would make - rounded down to the cent.
 */
function unspentPart(payment: Payment): number {
  const balance = getUserById(payment.userId)?.balanceMilli ?? 0;
  return wholeCentsBelow(Math.min(balance, payment.creditedMilli));
}

function purchaseLabel(payment: Payment): string {
  const how = payment.method === 'card' ? 'Card' : 'Crypto';
  return `${payment.reference} - ${how} purchase of ${formatMoney(centsToMilli(payment.amountCents))}`;
}

function resolvePayment(paymentId: string, ownerId: string | null): RefundItem {
  const payment = getPayment(paymentId);
  if (!payment || (ownerId !== null && payment.userId !== ownerId)) throw notFound('purchase');

  const itemKey = refundItemKey('payment', payment.id);
  const base = {
    kind: 'purchase' as const,
    itemType: 'payment' as const,
    itemId: payment.id,
    itemKey,
    accountId: payment.userId,
    label: purchaseLabel(payment),
    chargedMilli: centsToMilli(payment.amountCents),
    paymentId: payment.id,
    paymentMethod: payment.method,
    paymentProvider: payment.provider,
  };

  const reason = ((): RefundUnavailable | null => {
    if (findRefundedRequestForItem(itemKey) || payment.state === 'refunded') return ALREADY_REFUNDED('purchase');
    if (payment.state === 'refunding') return unavailable('refunding', 'This purchase is being refunded already.');
    if (payment.state !== 'paid') {
      return unavailable('not-paid', 'This purchase was not paid, so there is nothing to refund.');
    }
    // Credited in credits, before they were dollars: the switch reset them
    // with every balance, so nothing of it is left on any balance to give back.
    if (payment.creditedMilli <= 0) {
      return unavailable(
        'legacy',
        'This purchase bought credits before they became dollars. Those were reset with every balance, ' +
          'so nothing of it is left to refund.'
      );
    }
    if (unspentPart(payment) <= 0) {
      return unavailable('nothing-unspent', 'Nothing of this purchase is left unspent to refund.');
    }
    return null;
  })();

  return { ...base, refundableMilli: reason ? 0 : unspentPart(payment), unavailable: reason };
}

/**
 * The checks every resume shares once its charge is known: delivered, charged
 * under a reservation of this account's, not already refunded automatically or
 * by an earlier request - and never more than the run has left to give back.
 */
function resumeRefundable(input: {
  itemKey: string;
  state: string;
  ownerId: string;
  reservation: Reservation | null;
  costMilli: number | null;
  taskId?: string;
}): { refundable: number; unavailable: RefundUnavailable | null } {
  const none = (reason: RefundUnavailable) => ({ refundable: 0, unavailable: reason });
  if (findRefundedRequestForItem(input.itemKey)) return none(ALREADY_REFUNDED('resume'));
  if (input.state === 'queued' || input.state === 'running') return none(STILL_BUILDING);
  if (input.state !== 'done') return none(NOT_DELIVERED);
  const reservation = input.reservation;
  // An administrator's run, a free one, or one from before credits were dollars:
  // no reservation in dollars, so no charge to give back.
  if (!reservation || reservation.userId !== input.ownerId || reservation.unitsMilli <= 0) return none(NOT_CHARGED);
  if (input.costMilli === null) {
    return none(
      unavailable('cost-unknown', 'What this resume was charged is not on record, so it cannot be refunded here.')
    );
  }
  if (input.costMilli <= 0) return none(NOT_CHARGED);
  if (input.taskId && isLedgerKeyUsed(`refund:task:${input.taskId}`)) return none(NOT_DELIVERED);
  const left = reservation.unitsMilli - reservation.refundedMilli;
  const refundable = Math.min(input.costMilli, left);
  if (refundable <= 0) return none(ALREADY_REFUNDED('resume'));
  return { refundable, unavailable: null };
}

function orderItemLabel(order: Order, item: OrderItem): string {
  const role = item.role ? ` (${item.role})` : '';
  return `${order.number} - ${item.profileName} / ${item.companyName}${role}`;
}

function resolveOrderItem(found: { order: Order; item: OrderItem }, ownerId: string | null): RefundItem {
  const { order, item } = found;
  if (ownerId !== null && order.userId !== ownerId) throw notFound('resume');
  const itemKey = refundItemKey('order-item', item.id);
  const reservation = order.batchId ? getReservation(order.batchId) : null;
  const costMilli = item.costMilli ?? (order.batchId ? liveTaskCost(order.batchId, item.seq) : null);
  const { refundable, unavailable: reason } = resumeRefundable({
    itemKey,
    state: item.state,
    ownerId: order.userId,
    reservation,
    costMilli,
    ...(item.taskId ? { taskId: item.taskId } : {}),
  });
  return {
    kind: 'resume',
    itemType: 'order-item',
    itemId: item.id,
    itemKey,
    accountId: order.userId,
    label: orderItemLabel(order, item),
    chargedMilli: reservation && reservation.unitsMilli > 0 ? costMilli ?? 0 : 0,
    refundableMilli: refundable,
    unavailable: reason,
    orderItemId: item.id,
    ...(item.taskId ? { taskId: item.taskId } : {}),
    ...(order.batchId ? { reservationId: order.batchId } : {}),
  };
}

function resolveTask(batch: Batch, task: Task, ownerId: string | null): RefundItem {
  const owner = typeof batch.shared.ownerId === 'string' ? batch.shared.ownerId : '';
  if (!owner || (ownerId !== null && owner !== ownerId)) throw notFound('resume');

  // A resume of an order is named by its order item, always.
  if (isOrderBatch(batch) || findOrderForBatch(batch.id)) {
    const found = findOrderItemForBatch(batch.id, task.seq);
    if (!found) throw notFound('resume');
    return resolveOrderItem(found, ownerId);
  }

  const itemKey = refundItemKey('task', task.id);
  const reservation = getReservation(batch.id);
  const costMilli = taskCostMilli(task.payload);
  const { refundable, unavailable: reason } = resumeRefundable({
    itemKey,
    state: task.state,
    ownerId: owner,
    reservation,
    costMilli,
    taskId: task.id,
  });
  return {
    kind: 'resume',
    itemType: 'task',
    itemId: task.id,
    itemKey,
    accountId: owner,
    label: `${task.label.profileName} / ${task.label.companyName}${task.label.role ? ` (${task.label.role})` : ''}`,
    chargedMilli: reservation && reservation.unitsMilli > 0 ? costMilli : 0,
    refundableMilli: refundable,
    unavailable: reason,
    taskId: task.id,
    reservationId: batch.id,
  };
}

/**
 * "Jane / Acme" out of the reservation's history line, "Jane / Acme - 1
 * resume: 1 x Claude @ $0.023 = $0.023": the charge breakdown is the credit
 * history's, and a notice reads "your refund request for Jane / Acme".
 */
function chargeLabel(label: string): string {
  const resume = label.replace(/ - \d+ resumes?: .*$/, '').trim();
  return resume || 'A resume';
}

/**
 * A resume built by POST /api/resume/generate: its reservation (kind
 * `request`) is that resume alone, so the reservation IS its name. Delivered
 * means settled - closed with nothing given back; a run that failed released
 * its whole charge.
 */
function resolveCharge(reservation: Reservation, ownerId: string | null): RefundItem {
  if (ownerId !== null && reservation.userId !== ownerId) throw notFound('charge');
  if (reservation.kind !== 'request') {
    throw new RefundRequestError(
      'That charge paid for a whole run. Ask for a refund on one of its resumes instead.',
      400,
      'bad-item'
    );
  }
  const itemKey = refundItemKey('charge', reservation.id);
  const reason = ((): RefundUnavailable | null => {
    if (findRefundedRequestForItem(itemKey)) return ALREADY_REFUNDED('resume');
    if (reservation.state === 'open') return STILL_BUILDING;
    if (reservation.unitsMilli <= 0) return NOT_CHARGED;
    if (reservation.refundedMilli >= reservation.unitsMilli) return NOT_DELIVERED;
    return null;
  })();
  return {
    kind: 'resume',
    itemType: 'charge',
    itemId: reservation.id,
    itemKey,
    accountId: reservation.userId,
    label: chargeLabel(reservation.label),
    chargedMilli: Math.max(0, reservation.unitsMilli),
    refundableMilli: reason ? 0 : reservation.unitsMilli - reservation.refundedMilli,
    unavailable: reason,
    reservationId: reservation.id,
  };
}

/**
 * What an item is, whose it is, and what it would give back now.
 *
 * `ownerId` is the account asking - a stranger's item answers 404, never 403,
 * because the difference would confirm it exists - or null for an
 * administrator re-measuring a request, who is not its owner.
 */
export function resolveRefundItem(itemType: RefundItemType, itemId: string, ownerId: string | null): RefundItem {
  switch (itemType) {
    case 'payment':
      return resolvePayment(itemId, ownerId);
    case 'order-item': {
      const found = findOrderItem(itemId);
      if (!found) throw notFound('resume');
      return resolveOrderItem(found, ownerId);
    }
    case 'task': {
      const live = findLiveTask(itemId);
      if (!live) {
        throw new RefundRequestError(
          'That resume is no longer listed. Ask your administrator for a refund instead.',
          404,
          'not-found'
        );
      }
      return resolveTask(live.batch, live.task, ownerId);
    }
    case 'charge': {
      const reservation = getReservation(itemId);
      if (!reservation) throw notFound('charge');
      return resolveCharge(reservation, ownerId);
    }
    default:
      throw new RefundRequestError('Choose the purchase or resume to ask about.', 400, 'bad-item');
  }
}

/**
 * What a resume REQUEST would credit back now, and against which reservation.
 *
 * Re-measured from the item, except for a queued resume not placed as an order
 * whose batch the queue has since evicted: that task cannot be looked up any
 * more, and does not need to be - it was delivered when the request was made
 * (only a delivered resume can be asked about), and delivered is final. What
 * still has to hold is checked against what the request recorded: the run's
 * reservation is this account's and has that much left to give back, the task
 * never refunded itself, and no earlier request for it was refunded.
 */
function resumeTarget(request: RefundRequest): {
  reservationId: string;
  refundable: number;
  unavailable: RefundUnavailable | null;
} {
  if (request.itemType === 'task' && !findLiveTask(request.itemId)) {
    const reservation = request.reservationId ? getReservation(request.reservationId) : null;
    const measured = resumeRefundable({
      itemKey: request.itemKey,
      state: 'done',
      ownerId: request.accountId,
      reservation,
      costMilli: request.amountMilli,
      ...(request.taskId ? { taskId: request.taskId } : {}),
    });
    return { reservationId: request.reservationId ?? '', refundable: measured.refundable, unavailable: measured.unavailable };
  }
  const item = resolveRefundItem(request.itemType, request.itemId, request.accountId);
  return { reservationId: item.reservationId ?? '', refundable: item.refundableMilli, unavailable: item.unavailable };
}

/* ------------------------------------------------------------- views */

/** A request as its owner reads it. Every amount in thousandths of a dollar, in a `Milli` field. */
export type RefundRequestView = {
  id: string;
  reference: string;
  kind: RefundRequestKind;
  itemType: RefundItemType;
  itemId: string;
  label: string;
  amountMilli: number;
  refundedMilli: number;
  reason: string;
  state: RefundRequestState;
  declineReason: string;
  /** For a purchase: how it was paid, so a page can say "back to your card". Null for a resume. */
  paymentMethod: Payment['method'] | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  refundedAt: string | null;
};

/** A request as an administrator reads it in the queue. */
export type AdminRefundRequestView = RefundRequestView & {
  accountId: string;
  /** '' when the account has since been deleted. */
  accountEmail: string;
  paymentProvider: Payment['provider'] | null;
  paymentReference: string | null;
  decidedBy: string | null;
  refundedBy: string | null;
  /** The amount a card refund was last sent to Stripe with, if one was. */
  attemptMilli: number | null;
  /**
   * For an open request: what Refunded would give back right now - re-measured,
   * never above `amountMilli` - or 0 with `refundableNowReason` saying why not.
   * Null on a final request.
   */
  refundableNowMilli: number | null;
  refundableNowReason: string | null;
};

export function toRefundRequestView(request: RefundRequest): RefundRequestView {
  const payment = request.paymentId ? getPayment(request.paymentId) : null;
  return {
    id: request.id,
    reference: request.reference,
    kind: request.kind,
    itemType: request.itemType,
    itemId: request.itemId,
    label: request.label,
    amountMilli: request.amountMilli,
    refundedMilli: request.refundedMilli,
    reason: request.reason,
    state: request.state,
    declineReason: request.state === 'declined' ? request.declineReason : '',
    paymentMethod: payment?.method ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    decidedAt: request.decidedAt ?? null,
    refundedAt: request.refundedAt ?? null,
  };
}

/** What Refunded would move now, for an open request: re-measured, never above what was asked. */
function refundableNow(request: RefundRequest): { milli: number; reason: string | null } {
  if (request.attemptMilli !== null) return { milli: request.attemptMilli, reason: null };
  try {
    if (request.kind === 'resume') {
      const target = resumeTarget(request);
      if (target.unavailable) return { milli: 0, reason: target.unavailable.message };
      return { milli: Math.min(target.refundable, request.amountMilli), reason: null };
    }
    const item = resolveRefundItem(request.itemType, request.itemId, null);
    if (item.unavailable) return { milli: 0, reason: item.unavailable.message };
    return { milli: Math.min(item.refundableMilli, request.amountMilli), reason: null };
  } catch (error) {
    return { milli: 0, reason: error instanceof PublicError ? error.message : 'It can no longer be measured.' };
  }
}

export function toAdminRefundRequestView(request: RefundRequest): AdminRefundRequestView {
  const payment = request.paymentId ? getPayment(request.paymentId) : null;
  const open = request.state === 'requested' || request.state === 'approved';
  const now = open ? refundableNow(request) : null;
  return {
    ...toRefundRequestView(request),
    accountId: request.accountId,
    accountEmail: getUserById(request.accountId)?.email ?? '',
    paymentProvider: payment?.provider ?? null,
    paymentReference: payment?.reference ?? null,
    decidedBy: request.decidedBy ?? null,
    refundedBy: request.refundedBy ?? null,
    attemptMilli: request.attemptMilli,
    refundableNowMilli: now ? now.milli : null,
    refundableNowReason: now ? now.reason : null,
  };
}

/** One item a person may ask about, for the dialog: what it is, what it would give back, and any open request. */
export type RefundOptionView = {
  kind: RefundRequestKind;
  itemType: RefundItemType;
  itemId: string;
  label: string;
  chargedMilli: number;
  refundableMilli: number;
  available: boolean;
  unavailableCode: RefundUnavailableCode | null;
  unavailableReason: string | null;
  paymentMethod: Payment['method'] | null;
  openRequest: RefundRequestView | null;
};

function toOptionView(item: RefundItem): RefundOptionView {
  const open = findOpenRequestForItem(item.itemKey);
  return {
    kind: item.kind,
    itemType: item.itemType,
    itemId: item.itemId,
    label: item.label,
    chargedMilli: item.chargedMilli,
    refundableMilli: item.refundableMilli,
    available: !item.unavailable && !open,
    unavailableCode: item.unavailable?.code ?? null,
    unavailableReason: item.unavailable?.message ?? null,
    paymentMethod: item.paymentMethod ?? null,
    openRequest: open ? toRefundRequestView(open) : null,
  };
}

/**
 * What a person may ask a refund for, from one place they can see a charge:
 * a purchase (`paymentId`), an order's resumes (`orderId`), or a line of
 * their credit history (`chargeId` - the reservation a charge row names:
 * one resume for a synchronous build, every resume of the run for a queued
 * one). Read-only: nothing is asked by looking.
 */
export function listRefundOptions(
  account: UserAccount,
  query: { paymentId?: unknown; orderId?: unknown; chargeId?: unknown }
): { items: RefundOptionView[]; note: string | null } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const paymentId = text(query.paymentId);
  const orderId = text(query.orderId);
  const chargeId = text(query.chargeId);
  const named = [paymentId, orderId, chargeId].filter(Boolean).length;
  if (named !== 1) {
    throw new RefundRequestError('Name one purchase, order or charge.', 400, 'bad-item');
  }

  if (paymentId) return { items: [toOptionView(resolvePayment(paymentId, account.id))], note: null };

  if (orderId) {
    const order = getOrder(orderId);
    if (!order || order.userId !== account.id) throw notFound('order');
    return {
      items: listOrderItems(order.id).map((item) => toOptionView(resolveOrderItem({ order, item }, account.id))),
      note: null,
    };
  }

  const reservation = getReservation(chargeId);
  if (!reservation || reservation.userId !== account.id) throw notFound('charge');
  if (reservation.kind === 'request') {
    return { items: [toOptionView(resolveCharge(reservation, account.id))], note: null };
  }
  const order = findOrderForBatch(reservation.id);
  if (order && order.userId === account.id) {
    return {
      items: listOrderItems(order.id).map((item) => toOptionView(resolveOrderItem({ order, item }, account.id))),
      note: null,
    };
  }
  const batch = getGenerationQueue().getBatch(reservation.id);
  if (batch) {
    return {
      items: batch.tasks.map((task) => toOptionView(resolveTask(batch, task, account.id))),
      note: null,
    };
  }
  return {
    items: [],
    note:
      "This run's resumes are no longer listed, so they cannot be picked here. " +
      'Ask your administrator if one of them should be refunded.',
  };
}

/* ------------------------------------------------------- notifications */

function notifyRequester(request: RefundRequest, title: string, body: string): void {
  // An account deleted since asking has nobody left to read it, and a notice
  // addressed to it would outlive the cleanup that deleting it did.
  if (!getUserById(request.accountId)) return;
  createNotification({
    recipientId: request.accountId,
    title,
    body: body.slice(0, 4000),
    link: REFUND_REQUESTS_PATH,
  });
}

/** One notice per administrator who can act on it - written in the request's own transaction. */
function notifyAdminsOfNewRequest(request: RefundRequest, requester: UserAccount): void {
  const who = requester.email || requester.name || 'An account';
  const body = `${who} asks for ${formatMoney(request.amountMilli)} back for ${request.label}: "${request.reason}"`;
  for (const admin of listUsers()) {
    if (admin.role !== 'admin' || admin.disabled) continue;
    createNotification({
      recipientId: admin.id,
      title: `New refund request ${request.reference}`,
      body: body.slice(0, 4000),
      link: ADMIN_REFUND_QUEUE_PATH,
    });
  }
}

function refundedSentence(request: RefundRequest, refundedMilli: number, how: 'credit' | 'card' | 'by-hand'): string {
  const lead = `Your refund request for ${request.label} was refunded (${formatMoney(refundedMilli)}).`;
  if (how === 'credit') return `${lead} It is back on your balance.`;
  if (how === 'card') return `${lead} The money is on its way back to your card.`;
  return `${lead} Your administrator has sent it back to you.`;
}

/* --------------------------------------------------------------- asking */

export type CreateRefundRequestInput = { itemType?: unknown; itemId?: unknown; reason?: unknown };

/**
 * A person asks for a refund on one of their own purchases or resumes.
 *
 * Refused, in their words, when: the reason is missing or too long; the item
 * is not theirs (404); it is not refundable right now (409, `not-refundable`,
 * with `why` - still building, already refunded...); or it already has an open
 * request (409, `request-open`, with that request's id). Every administrator
 * gets a notice, in the same transaction as the request.
 */
export function createRefundRequest(account: UserAccount, input: CreateRefundRequestInput): RefundRequestView {
  const itemType = input.itemType;
  const itemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
  if (!isRefundItemType(itemType) || !itemId || itemId.length > 200) {
    throw new RefundRequestError('Choose the purchase or resume to ask about.', 400, 'bad-item');
  }
  const reason = readReason(input.reason, 'requester');

  const db = getDb();
  return db.transaction((): RefundRequestView => {
    const item = resolveRefundItem(itemType, itemId, account.id);
    const open = findOpenRequestForItem(item.itemKey);
    if (open) {
      throw new RefundRequestError('A refund request for this is already open.', 409, 'request-open', {
        requestId: open.id,
      });
    }
    if (item.unavailable) {
      throw new RefundRequestError(item.unavailable.message, 409, 'not-refundable', { why: item.unavailable.code });
    }

    let request: RefundRequest;
    try {
      request = insertRefundRequest({
        accountId: account.id,
        kind: item.kind,
        itemType: item.itemType,
        itemId: item.itemId,
        ...(item.paymentId ? { paymentId: item.paymentId } : {}),
        ...(item.orderItemId ? { orderItemId: item.orderItemId } : {}),
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(item.reservationId ? { reservationId: item.reservationId } : {}),
        label: item.label,
        amountMilli: item.refundableMilli,
        reason,
      });
    } catch (error) {
      if (error instanceof OpenRefundRequestExists) {
        throw new RefundRequestError('A refund request for this is already open.', 409, 'request-open');
      }
      throw error;
    }
    notifyAdminsOfNewRequest(request, account);
    return toRefundRequestView(request);
  }).immediate();
}

export function listMyRefundRequests(
  account: UserAccount,
  options: { states?: readonly RefundRequestState[]; limit: number; offset: number }
): { requests: RefundRequestView[]; total: number } {
  return {
    requests: listRefundRequestsForAccount(account.id, options).map(toRefundRequestView),
    total: countRefundRequestsForAccount(account.id, options.states),
  };
}

export function listRefundQueue(options: {
  states?: readonly RefundRequestState[];
  limit: number;
  offset: number;
}): { requests: AdminRefundRequestView[]; total: number; counts: Record<RefundRequestState, number> } {
  return {
    requests: listRefundRequests(options).map(toAdminRefundRequestView),
    total: countRefundRequests(options.states),
    counts: countRefundRequestsByState(),
  };
}

/* ------------------------------------------------------------ deciding */

export type DecisionResult = {
  request: AdminRefundRequestView;
  /** False when the request was already in the state asked for - a double click - and nothing changed. */
  changed: boolean;
};

function loadRequest(id: string): RefundRequest {
  const request = getRefundRequest(id);
  if (!request) throw new RefundRequestError('That refund request was not found.', 404, 'not-found');
  return request;
}

function finalError(request: RefundRequest): RefundRequestError {
  return new RefundRequestError(
    `This refund request was already ${request.state}, and that is final.`,
    409,
    'request-final',
    { state: request.state }
  );
}

/**
 * Requested -> Approved. No money moves: it says the refund is accepted, and
 * the requester is told so. Approving an approved request changes nothing and
 * is not an error - it is the second click of a double click.
 */
export function approveRefund(id: string, admin: UserAccount): DecisionResult {
  const db = getDb();
  return db.transaction((): DecisionResult => {
    const request = loadRequest(id);
    if (request.state === 'approved') return { request: toAdminRefundRequestView(request), changed: false };
    if (request.state !== 'requested') throw finalError(request);
    if (!approveRefundRequest(id, admin.id)) throw finalError(loadRequest(id));
    notifyRequester(
      request,
      'Refund request approved',
      `Your refund request for ${request.label} was approved. The refund itself follows, and you will be told ` +
        'when it is made.'
    );
    return { request: toAdminRefundRequestView(loadRequest(id)), changed: true };
  }).immediate();
}

/**
 * Requested or Approved -> Declined, with the administrator's own reason,
 * which the requester reads. Final. Declining a declined request changes
 * nothing - the first reason stands.
 */
export function declineRefund(id: string, admin: UserAccount, body: { reason?: unknown }): DecisionResult {
  const reason = readReason(body.reason, 'admin');
  const db = getDb();
  const decided = db.transaction((): DecisionResult | { refundedPayment: Payment; request: RefundRequest } => {
    const request = loadRequest(id);
    if (request.state === 'declined') return { request: toAdminRefundRequestView(request), changed: false };
    if (request.state === 'refunded') throw finalError(request);
    const refundedPayment = moneyAlreadyMoving(request);
    if (refundedPayment) return { refundedPayment, request };
    if (!declineRefundRequest(id, admin.id, reason)) throw finalError(loadRequest(id));
    notifyRequester(request, 'Refund request declined', `Your refund request for ${request.label} was declined: ${reason}`);
    return { request: toAdminRefundRequestView(loadRequest(id)), changed: true };
  }).immediate();

  if ('refundedPayment' in decided) {
    // The money went back already. Declined would tell its requester the
    // opposite, so it is closed from the payment, which tells them the truth.
    closeFromPayment(decided.request, decided.refundedPayment, admin);
    throw new RefundRequestError(
      'That purchase has been refunded already, so the request was closed as Refunded instead, and the person ' +
        'who asked has been told.',
      409,
      'request-final',
      { state: 'refunded' }
    );
  }
  return decided;
}

/**
 * Whether a purchase's request can be DECLINED now, read inside the decline's
 * own transaction. Declined is final and tells the requester no money moves,
 * so it must not land while money is moving or may have moved:
 *
 * - the payment is `refunding` - this request's card refund, or one from the
 *   payments list, is with the provider right now: refused (409 `refunding`),
 *   to be looked at again once it has answered. This is the payment's claim in
 *   the database, set before the provider is called, so it holds across
 *   processes, not only against a press in this one;
 * - the request holds a card refund Stripe never confirmed (`hold_key`): the
 *   money may be on its way back, and its credit is off the balance. Refused
 *   (409 `refund-unconfirmed`) until Mark refunded is pressed again - it
 *   cannot refund twice - and declinable only once Stripe has refused it;
 * - the payment is `refunded` already: returned, so the caller closes the
 *   request from the payment instead.
 */
function moneyAlreadyMoving(request: RefundRequest): Payment | null {
  if (request.kind !== 'purchase' || !request.paymentId) return null;
  const payment = getPayment(request.paymentId);
  if (!payment) return null;
  if (payment.state === 'refunding') {
    throw new RefundRequestError(
      'That purchase is being refunded right now. Wait for the refund to finish, then look at the request again.',
      409,
      'refunding'
    );
  }
  if (request.holdKey && request.attemptMilli !== null) {
    throw new RefundRequestError(
      `A ${formatMoney(request.attemptMilli)} card refund was sent to Stripe for this request and never confirmed, ` +
        'and that much credit is held off the balance until it is. Press Mark refunded again first - it sends the ' +
        'same refund, which cannot refund twice - and decline only if Stripe refuses it.',
      409,
      'refund-unconfirmed',
      { attemptMilli: request.attemptMilli }
    );
  }
  return payment.state === 'refunded' ? payment : null;
}

export type RefundResult = DecisionResult & {
  /**
   * What moved, in thousandths of a dollar. For a resume: `refundedMilli` back
   * on the balance. For a purchase: `refundedMilli` returned to the buyer and
   * `reversedMilli` taken off the balance, `shortfallMilli` short of it when
   * the balance no longer held it - money sent back by hand only: a card's
   * credit is held before Stripe is asked, so it is never short. Null when
   * nothing changed.
   */
  outcome: { refundedMilli: number; reversedMilli: number; shortfallMilli: number } | null;
};

/** Card refunds in flight, by request: a second click waits for the first rather than starting another. */
const purchaseRefundsInFlight = new Map<string, Promise<RefundResult>>();

/**
 * Requested or Approved -> Refunded: the refund happens in the same step.
 *
 * - A resume: its charge goes back on the balance and the request turns
 *   Refunded in ONE transaction - neither without the other.
 * - A card purchase: the unspent part (re-measured now, never above what was
 *   asked) comes off the balance and the payment is claimed, together; then a
 *   partial Stripe refund of exactly that. The request turns Refunded only
 *   once Stripe has accepted it; a refusal puts the credit back.
 * - A crypto purchase: refused (`paid-by-hand-required`, with the amount)
 *   until the administrator confirms they have sent the money back by hand
 *   (`paidByHand: true` with `amountUsd`: what they sent), then that much
 *   credit is reversed - what is left of it, the rest reported as spent.
 *
 * Final. Refunding a refunded request changes nothing and moves nothing.
 */
export async function refundRequest(
  id: string,
  admin: UserAccount,
  body: { paidByHand?: unknown; amountUsd?: unknown } = {}
): Promise<RefundResult> {
  const request = loadRequest(id);
  if (request.state === 'refunded') {
    return { request: toAdminRefundRequestView(request), changed: false, outcome: null };
  }
  if (request.state === 'declined') throw finalError(request);

  if (request.kind === 'resume') return refundResume(id, admin);

  const running = purchaseRefundsInFlight.get(id);
  if (running) {
    await running.catch(() => undefined);
    return { request: toAdminRefundRequestView(loadRequest(id)), changed: false, outcome: null };
  }
  const work = refundPurchase(request, admin, body);
  purchaseRefundsInFlight.set(id, work);
  try {
    return await work;
  } finally {
    purchaseRefundsInFlight.delete(id);
  }
}

function refundResume(id: string, admin: UserAccount): RefundResult {
  const db = getDb();
  return db.transaction((): RefundResult => {
    const request = loadRequest(id);
    if (request.state === 'refunded') {
      return { request: toAdminRefundRequestView(request), changed: false, outcome: null };
    }
    if (request.state === 'declined') throw finalError(request);
    if (!getUserById(request.accountId)) {
      throw new RefundRequestError(
        'That account no longer exists, so nothing can be credited back. Decline the request instead.',
        409,
        'account-missing'
      );
    }

    const target = resumeTarget(request);
    if (target.unavailable || !target.reservationId) {
      throw new RefundRequestError(
        target.unavailable?.message ?? 'Nothing can be credited back for this resume.',
        409,
        'not-refundable',
        target.unavailable ? { why: target.unavailable.code } : undefined
      );
    }
    const amount = Math.min(request.amountMilli, target.refundable);
    const moved = refundRequestedCharge({
      requestId: request.id,
      reservationId: target.reservationId,
      userId: request.accountId,
      amountMilli: amount,
      actorId: admin.id,
      note: `Refund request ${request.reference}: ${request.label}`,
    });
    if (moved <= 0) {
      // Thrown, so the transaction takes nothing with it: a request that says
      // Refunded with no credit behind it is the one outcome this must not have.
      throw new RefundRequestError(
        'Nothing could be credited back: that run has already given back everything it took.',
        409,
        'not-refundable'
      );
    }
    if (!markRefundRequestRefunded(id, admin.id, moved)) {
      throw finalError(loadRequest(id));
    }
    notifyRequester(request, 'Refund made', refundedSentence(request, moved, 'credit'));
    return {
      request: toAdminRefundRequestView(loadRequest(id)),
      changed: true,
      outcome: { refundedMilli: moved, reversedMilli: 0, shortfallMilli: 0 },
    };
  }).immediate();
}

/**
 * Closes an open request from its payment's own refund record: the payment was
 * refunded already - from the payments list, or by an earlier press of this
 * whose answer was lost after the provider accepted it.
 */
function closeFromPayment(request: RefundRequest, payment: Payment, admin: UserAccount): RefundResult {
  const db = getDb();
  return db.transaction((): RefundResult => {
    const current = loadRequest(request.id);
    if (current.state !== 'requested' && current.state !== 'approved') {
      return { request: toAdminRefundRequestView(current), changed: false, outcome: null };
    }
    const refunded = centsToMilli(payment.refundCents);
    markRefundRequestRefunded(current.id, admin.id, refunded);
    notifyRequester(
      current,
      'Refund made',
      refundedSentence(current, refunded, payment.provider === 'stripe' ? 'card' : 'by-hand')
    );
    return {
      request: toAdminRefundRequestView(loadRequest(current.id)),
      changed: true,
      outcome: {
        refundedMilli: refunded,
        reversedMilli: payment.refundedMilli,
        shortfallMilli: Math.max(0, refunded - payment.refundedMilli),
      },
    };
  }).immediate();
}

/**
 * Closes every open request for a payment just refunded from the payments
 * list - the money went back, so whatever was asked about it is answered.
 * Never throws: the refund itself already happened, and a notice that could
 * not be written must not turn it into an error.
 */
export function closeRequestsForRefundedPayment(paymentId: string, admin: UserAccount): number {
  let closed = 0;
  try {
    const payment = getPayment(paymentId);
    if (!payment || payment.state !== 'refunded') return 0;
    for (const request of listOpenRequestsForPayment(paymentId)) {
      if (closeFromPayment(request, payment, admin).changed) closed += 1;
    }
  } catch (error) {
    console.error(`[refunds] Could not close the refund requests for payment ${paymentId}.`, error);
  }
  return closed;
}

async function refundPurchase(
  request: RefundRequest,
  admin: UserAccount,
  body: { paidByHand?: unknown; amountUsd?: unknown }
): Promise<RefundResult> {
  const payment = request.paymentId ? getPayment(request.paymentId) : null;
  if (!payment) {
    throw new RefundRequestError('That payment no longer exists. Decline the request instead.', 409, 'not-refundable');
  }
  if (payment.state === 'refunded') return closeFromPayment(request, payment, admin);
  if (payment.state === 'refunding') {
    throw new RefundRequestError('That payment is being refunded already.', 409, 'not-refundable', {
      why: 'refunding',
    });
  }
  return payment.provider === 'stripe'
    ? refundCardPurchase(request, admin)
    : refundPurchaseByHand(request, payment, admin, body);
}

const NOTHING_UNSPENT = () =>
  new RefundRequestError(
    'Nothing of this purchase is left unspent to refund. Decline the request instead.',
    409,
    'nothing-unspent'
  );

/**
 * A fresh ledger key for the credit a card refund holds:
 * `purchase-refund:<payment>:<request>:<n>`. One per hold rather than one per
 * request, because a hold that Stripe refused is given back, and pressing again
 * must be able to take it again - under a key the ledger has not seen.
 */
function nextHoldKey(paymentId: string, requestId: string): string {
  for (let n = 1; ; n += 1) {
    const key = `purchase-refund:${paymentId}:${requestId}:${n}`;
    if (!isLedgerKeyUsed(key)) return key;
  }
}

/**
 * Refunded, for a card purchase: the credit off the balance FIRST, then the
 * money back through Stripe.
 *
 * 1. One transaction takes the unspent part - re-measured now, never above
 *    what was asked - off the balance (`purchase-refund`, a key of its own per
 *    hold), writes it down on the request (`attempt_milli`, `hold_key`) and
 *    claims the payment (`paid` -> `refunding`). From then on the buyer cannot
 *    spend it, a second refund cannot measure it as still there, and a Decline
 *    is refused; Stripe is sent EXACTLY what was taken, so the two always
 *    agree and nothing is short.
 * 2. Stripe is asked for a partial refund of that, under
 *    `Idempotency-Key: refund:<payment>`.
 * 3. Accepted: the payment and the request turn Refunded together.
 *    Refused: the credit goes back (`purchase-refund-failed`), the hold is
 *    forgotten and the claim released, together - the next press measures
 *    again. No answer: the claim is released but the credit stays held and the
 *    attempt written down, so the next press sends the SAME amount under the
 *    same key - Stripe answers with the refund it made, if it made one - and
 *    takes nothing more.
 */
async function refundCardPurchase(request: RefundRequest, admin: UserAccount): Promise<RefundResult> {
  const db = getDb();
  type Claimed =
    | { kind: 'claimed'; payment: Payment; amount: number; holdKey: string; note: string }
    | { kind: 'refunded'; payment: Payment }
    | { kind: 'final'; request: RefundRequest };

  const claimed = db.transaction((): Claimed => {
    const current = loadRequest(request.id);
    if (current.state === 'refunded') return { kind: 'final', request: current };
    if (current.state === 'declined') throw finalError(current);
    const payment = current.paymentId ? getPayment(current.paymentId) : null;
    if (!payment) {
      throw new RefundRequestError('That payment no longer exists. Decline the request instead.', 409, 'not-refundable');
    }
    if (payment.state === 'refunded') return { kind: 'refunded', payment };
    if (payment.state === 'refunding') {
      throw new RefundRequestError('That payment is being refunded already.', 409, 'not-refundable', {
        why: 'refunding',
      });
    }
    if (payment.state !== 'paid' || !payment.providerRef) {
      throw new RefundRequestError('This purchase was not paid, so there is nothing to refund.', 409, 'not-refundable', {
        why: 'not-paid',
      });
    }

    const note = `Refund request ${current.reference}`;
    let amount: number;
    let holdKey: string;
    if (current.holdKey && current.attemptMilli !== null) {
      // An earlier press whose answer was lost: its credit is still held, and
      // Stripe must be sent the same body for its key to answer the same.
      amount = current.attemptMilli;
      holdKey = current.holdKey;
    } else {
      const item = resolveRefundItem('payment', payment.id, null);
      const measured = item.unavailable ? 0 : Math.min(item.refundableMilli, current.amountMilli);
      if (measured <= 0) throw NOTHING_UNSPENT();
      holdKey = nextHoldKey(payment.id, current.id);
      const before = getUserById(payment.userId)?.balanceMilli ?? 0;
      applyAdjustment({
        userId: payment.userId,
        deltaMilli: -measured,
        reason: 'purchase-refund',
        idempotencyKey: holdKey,
        actorId: admin.id,
        note,
      });
      const after = getUserById(payment.userId)?.balanceMilli ?? 0;
      // `measured` is at most the balance, so all of it comes off. Checked
      // rather than assumed: Stripe is about to be sent this figure.
      if (before - after !== measured || !recordRefundHold(current.id, measured, holdKey)) {
        throw new Error(`${current.reference}: could not hold ${measured} thousandths for the refund.`);
      }
      amount = measured;
    }
    if (!beginRefund(payment.id, current.id)) {
      throw new RefundRequestError('That payment is being refunded already.', 409, 'not-refundable', {
        why: 'refunding',
      });
    }
    return { kind: 'claimed', payment, amount, holdKey, note };
  }).immediate();

  if (claimed.kind === 'final') {
    return { request: toAdminRefundRequestView(claimed.request), changed: false, outcome: null };
  }
  if (claimed.kind === 'refunded') return closeFromPayment(request, claimed.payment, admin);

  const { payment, amount, holdKey, note } = claimed;
  try {
    await sendCardRefund(payment, milliToCents(amount));
  } catch (error) {
    if (isUnansweredRefund(error)) {
      // Not known either way. The credit stays held and the attempt written
      // down; only the claim goes back, so the next press can send it again.
      releaseRefund(payment.id);
      console.error(
        `[refunds] ${request.reference}: the refund call to Stripe did not answer. It may or may not have been ` +
          `made; ${formatMoney(amount)} of credit stays held until it is confirmed.`,
        error
      );
      throw new PaymentError(
        'Could not confirm the refund with Stripe. Its credit stays off the balance until it is: press Mark ' +
          'refunded again - it sends the same refund, which cannot refund twice - or check the payment in the ' +
          'Stripe dashboard first.',
        502
      );
    }
    // Refused: no money moved, so the credit goes back with the claim, and the
    // hold is forgotten - the next press measures again.
    try {
      db.transaction(() => {
        applyAdjustment({
          userId: payment.userId,
          deltaMilli: amount,
          reason: 'purchase-refund-failed',
          idempotencyKey: `${holdKey}:returned`,
          actorId: admin.id,
          note,
        });
        clearRefundHold(request.id, holdKey);
        releaseRefund(payment.id);
      }).immediate();
    } catch (undoError) {
      // The hold stays, written down, so the next press sends the same refund
      // and gets the same refusal - and tries to put the credit back again.
      console.error(`[refunds] ${request.reference}: could not put back the credit a refused refund held.`, undoError);
      releaseRefund(payment.id);
    }
    throw error;
  }

  return db.transaction((): RefundResult => {
    if (!markRefunded(payment.id, amount, milliToCents(amount))) {
      // The claim above makes this unreachable short of a direct database edit.
      console.error(`[refunds] ${request.reference}: the refund was made but the payment could not be marked refunded.`);
    }
    const current = loadRequest(request.id);
    const outcome = { refundedMilli: amount, reversedMilli: amount, shortfallMilli: 0 };
    if (!markRefundRequestRefunded(current.id, admin.id, amount)) {
      // Unreachable while a Decline is refused during the claim; kept as the
      // last word rather than a silent state.
      console.error(
        `[refunds] ${current.reference}: refunded ${formatMoney(amount)} at the provider, but the request ` +
          `was already ${current.state}.`
      );
      return { request: toAdminRefundRequestView(current), changed: false, outcome };
    }
    notifyRequester(current, 'Refund made', refundedSentence(current, amount, 'card'));
    return { request: toAdminRefundRequestView(loadRequest(current.id)), changed: true, outcome };
  }).immediate();
}

/**
 * Refunded, for a crypto purchase: nothing can pull crypto back, so the
 * administrator sends it by hand FIRST and then records here how much they
 * sent (`amountUsd`, required - the figure they confirmed, not one measured
 * again now, because the money has already gone). That much credit is
 * reversed - what is left of it, the rest reported as spent since.
 */
async function refundPurchaseByHand(
  request: RefundRequest,
  payment: Payment,
  admin: UserAccount,
  body: { paidByHand?: unknown; amountUsd?: unknown }
): Promise<RefundResult> {
  const item = resolveRefundItem('payment', payment.id, null);
  const measured = item.unavailable ? 0 : Math.min(item.refundableMilli, request.amountMilli);

  if (body.paidByHand !== true) {
    if (measured <= 0) throw NOTHING_UNSPENT();
    throw new RefundRequestError(
      `Crypto cannot be refunded automatically. Send ${formatMoney(measured)} back from your Cryptomus ` +
        'merchant dashboard first, then confirm here that you have.',
      409,
      'paid-by-hand-required',
      { amountMilli: measured }
    );
  }
  if (body.amountUsd === undefined || body.amountUsd === null || body.amountUsd === '') {
    throw new RefundRequestError('Say how much you sent back, in dollars.', 400, 'bad-amount');
  }
  const parsed = parseDollars(body.amountUsd);
  if (!parsed.ok) {
    throw new RefundRequestError(describeDollarProblem(parsed.problem, 'The amount sent back'), 400, 'bad-amount');
  }
  if (parsed.milli <= 0 || !isWholeCents(parsed.milli) || parsed.milli > request.amountMilli) {
    throw new RefundRequestError(
      `The amount sent back must be whole cents, more than $0.000 and no more than the ${formatMoney(
        request.amountMilli
      )} asked for.`,
      400,
      'bad-amount'
    );
  }
  const amount = parsed.milli;

  // No provider is asked, so nothing is awaited between the claim and the
  // reversal inside refundPayment.
  const outcome: RefundOutcome = await refundPayment(payment.id, admin.id, `Refund request ${request.reference}`, {
    amountMilli: amount,
    refundedByHand: true,
  });

  const db = getDb();
  return db.transaction((): RefundResult => {
    const current = loadRequest(request.id);
    const refunded = outcome.refundAmountMilli;
    const moved = { refundedMilli: refunded, reversedMilli: outcome.reversedMilli, shortfallMilli: outcome.shortfallMilli };
    if (!markRefundRequestRefunded(current.id, admin.id, refunded)) {
      // Decided elsewhere in between. The money moved either way; the log says
      // so, and the request keeps its state.
      console.error(
        `[refunds] ${current.reference}: refunded ${formatMoney(refunded)} by hand, but the request ` +
          `was already ${current.state}.`
      );
      return { request: toAdminRefundRequestView(current), changed: false, outcome: moved };
    }
    notifyRequester(current, 'Refund made', refundedSentence(current, refunded, 'by-hand'));
    return { request: toAdminRefundRequestView(loadRequest(current.id)), changed: true, outcome: moved };
  }).immediate();
}

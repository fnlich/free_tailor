import { Router, type Request, type Response } from 'express';

import { requireAccount, requireAdmin, requireUser } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import {
  approveRefund,
  createRefundRequest,
  declineRefund,
  listMyRefundRequests,
  listRefundOptions,
  listRefundQueue,
  refundRequest,
} from '../services/refunds';
import {
  isRefundRequestState,
  OPEN_REFUND_STATES,
  REFUND_REQUEST_STATES,
  type RefundRequestState,
} from '../database/refundRequestRepository';
import { readPage } from './paging';

/**
 * Refund requests: asking (any signed-in account, about its own purchases and
 * resumes) and deciding (administrators).
 *
 * Two routers, mounted apart - /api/refund-requests and
 * /api/admin/refund-requests - so "requires an administrator" is a property of
 * the mount rather than of each route somebody remembers to guard.
 *
 * Every amount in every response is thousandths of a dollar in a `Milli`
 * field. A refusal is a PublicError - about the caller's own item, in words
 * they can act on, with a `code` - and anything else is the generic sentence
 * with a ref (`sendPublicError`), the cause logged.
 */

/**
 * `?state=` as the routes take it: one of the four states, `open` for
 * requested and approved together, or `all`. Refused rather than ignored when
 * it is anything else - an unknown filter quietly becoming "everything" would
 * show the wrong list with nothing on screen saying why.
 */
function readStates(raw: unknown, fallback: 'all' | 'open'): readonly RefundRequestState[] | null {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  if (value === 'all') return [];
  if (value === 'open') return OPEN_REFUND_STATES;
  if (isRefundRequestState(value)) return [value];
  return null;
}

const BAD_STATE = `The state filter must be one of ${[...REFUND_REQUEST_STATES, 'open', 'all'].join(', ')}.`;

const router = Router();
/*
 * Reading your own requests is every role's: an account made a reporter
 * after asking still sees how its request ended. ASKING - and the options
 * that lead to it - is for an account that builds and buys (`requireUser`,
 * per route below). A reporter's balance is their earnings, paid out by an
 * administrator outside the app (owner decision A4); a refund of a purchase
 * made before they became one gives back the UNSPENT part of the balance, so
 * it would pay those earnings out to a card instead, past the payout record.
 */
router.use(requireAccount);

/**
 * The caller's own requests, newest first:
 * `{ requests: RefundRequestView[], total, offset }`.
 */
router.get('/', (req: Request, res: Response) => {
  const states = readStates(req.query.state, 'all');
  if (!states) {
    res.status(400).json({ error: BAD_STATE, code: 'bad-state' });
    return;
  }
  try {
    const { limit, offset } = readPage(req, 50, 100);
    res.json({ ...listMyRefundRequests(req.user!, { states, limit, offset }), offset });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not read your refund requests');
  }
});

/**
 * What may be asked about from one place a charge is shown, and what it would
 * give back: exactly one of `?paymentId=`, `?orderId=`, `?chargeId=` ->
 * `{ items: RefundOptionView[], note }`. Read-only.
 */
router.get('/options', requireUser, (req: Request, res: Response) => {
  try {
    res.json(listRefundOptions(req.user!, req.query as Record<string, unknown>));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not check what can be refunded');
  }
});

/**
 * Asks for a refund: `{ itemType, itemId, reason }` -> 201 `{ request }`.
 * Three keys, read one at a time - an amount is never taken from the request;
 * the server measures it.
 */
router.post('/', requireUser, (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = createRefundRequest(req.user!, {
      itemType: body.itemType,
      itemId: body.itemId,
      reason: body.reason,
    });
    res.status(201).json({ request });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not send the refund request');
  }
});

export default router;

/* --------------------------------------------------------- administrators */

export const adminRefundRequestsRouter = Router();
adminRefundRequestsRouter.use(requireAdmin);

/**
 * The queue: `?state=` (default `open`), paged ->
 * `{ requests: AdminRefundRequestView[], total, offset, counts }`. Open
 * requests come oldest first, as a queue is worked; any other filter newest
 * first.
 */
adminRefundRequestsRouter.get('/', (req: Request, res: Response) => {
  const states = readStates(req.query.state, 'open');
  if (!states) {
    res.status(400).json({ error: BAD_STATE, code: 'bad-state' });
    return;
  }
  try {
    const { limit, offset } = readPage(req, 50, 200);
    res.json({ ...listRefundQueue({ states, limit, offset }), offset });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not read the refund requests');
  }
});

/** Requested -> Approved. `{ request, changed }`; `changed: false` for an already approved one. */
adminRefundRequestsRouter.post('/:id/approve', (req: Request<{ id: string }>, res: Response) => {
  try {
    res.json(approveRefund(String(req.params.id ?? ''), req.user!));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not approve the refund request');
  }
});

/** Requested or Approved -> Declined, `{ reason }` required. `{ request, changed }`. */
adminRefundRequestsRouter.post('/:id/decline', (req: Request<{ id: string }>, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(declineRefund(String(req.params.id ?? ''), req.user!, { reason: body.reason }));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not decline the refund request');
  }
});

/**
 * Requested or Approved -> Refunded, and the refund itself. Body, crypto only:
 * `{ paidByHand: true, amountUsd }` - what was sent back, required.
 * `{ request, changed, outcome }`.
 */
adminRefundRequestsRouter.post('/:id/refund', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      await refundRequest(String(req.params.id ?? ''), req.user!, {
        paidByHand: body.paidByHand,
        amountUsd: body.amountUsd,
      })
    );
  } catch (error) {
    // A Stripe failure is a PaymentError with its own sentence; anything else
    // the generic one, with the cause for the administrator as `detail`.
    sendPublicError(req, res, error, 'Could not make the refund', 502);
  }
});

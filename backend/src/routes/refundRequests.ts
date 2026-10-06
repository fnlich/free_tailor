import { Router, type Request, type Response } from 'express';

import { requireAccount, requireAdmin, requireReporter, requireUser } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import {
  approveRefund,
  createPayoutRequest,
  declineRefund,
  describePayoutStatus,
  listMyRefundRequests,
  listRefundQueue,
  refundAskingClosedError,
  refundRequest,
} from '../services/refunds';
import {
  isRefundRequestKind,
  isRefundRequestState,
  OPEN_REFUND_STATES,
  REFUND_REQUEST_KINDS,
  REFUND_REQUEST_STATES,
  type RefundRequestKind,
  type RefundRequestState,
} from '../database/refundRequestRepository';
import { readPage } from './paging';

/**
 * Refund requests: a reporter asking for a PAYOUT of their earnings, anybody
 * reading their own requests, and administrators deciding. Asking for a
 * refund of a purchase or a resume was removed (owner decision R1): its two
 * routes answer 410 `refund-requests-closed` for a page left open from
 * before, and the requests made before stay in the queue.
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

/** `?kind=` on the caller's own list: one kind, or `all` (the default). Refused rather than ignored, like `?state=`. */
function readKinds(raw: unknown): readonly RefundRequestKind[] | null {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : 'all';
  if (value === 'all') return [];
  return isRefundRequestKind(value) ? [value] : null;
}

const BAD_KIND = `The kind filter must be one of ${[...REFUND_REQUEST_KINDS, 'all'].join(', ')}.`;

const router = Router();
/*
 * Reading your own requests is every role's: an account made a reporter
 * after asking still sees how its request ended. Asking for a PAYOUT is a
 * reporter's (`requireReporter` on the two /payout routes; an administrator,
 * whom that guard lets through, is refused by the service - their balance is
 * not earnings). The two retired asking routes keep `requireUser`, so a
 * reporter still meets the same 403 as before, and a user or an administrator
 * the 410.
 */
router.use(requireAccount);

/**
 * The caller's own requests, newest first:
 * `{ requests: RefundRequestView[], total, offset }`. `?state=` as the queue
 * takes it (default `all`); `?kind=purchase|resume|payout|all` (default
 * `all`) - a reporter's page lists its payout requests with `?kind=payout`.
 */
router.get('/', (req: Request, res: Response) => {
  const states = readStates(req.query.state, 'all');
  if (!states) {
    res.status(400).json({ error: BAD_STATE, code: 'bad-state' });
    return;
  }
  const kinds = readKinds(req.query.kind);
  if (!kinds) {
    res.status(400).json({ error: BAD_KIND, code: 'bad-kind' });
    return;
  }
  try {
    const { limit, offset } = readPage(req, 50, 100);
    res.json({ ...listMyRefundRequests(req.user!, { states, kinds, limit, offset }), offset });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not read your refund requests');
  }
});

/**
 * A reporter's payout standing: `{ balanceMilli, openRequest, available,
 * unavailableCode, unavailableReason }` - what the Ask for Refund button on
 * their Credits page reads. Read-only.
 */
router.get('/payout', requireReporter, (req: Request, res: Response) => {
  try {
    res.json(describePayoutStatus(req.user!));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not read your payout standing');
  }
});

/**
 * A reporter asks an administrator to pay out their earned balance:
 * `{ reason? }` (optional, at most 1000 characters) -> 201 `{ request, status }`.
 * No amount is read: the request is for the balance as it stands. 409
 * `not-a-reporter` (an administrator), `request-open` (with `requestId`) or
 * `nothing-to-pay-out`.
 */
router.post('/payout', requireReporter, (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = createPayoutRequest(req.user!, { reason: body.reason });
    res.status(201).json({ request, status: describePayoutStatus(req.user!) });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not send the payout request');
  }
});

/*
 * Asking for a refund of a purchase or a resume, removed (owner decision R1):
 * 410 `refund-requests-closed` with a sentence that asks the reader to contact
 * their administrator, so a page left open from before says what happened
 * instead of failing generically. Nothing in the request is read.
 */
router.get('/options', requireUser, (req: Request, res: Response) => {
  sendPublicError(req, res, refundAskingClosedError(), 'Refunds are no longer asked for here');
});

router.post('/', requireUser, (req: Request, res: Response) => {
  sendPublicError(req, res, refundAskingClosedError(), 'Refunds are no longer asked for here');
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
 * `{ paidByHand: true, amountUsd }` - what was sent back, required. For a
 * PAYOUT request ("Record payout"): `{ amountUsd, note }`, both required -
 * what was sent the reporter, up to their balance now, and how.
 * `{ request, changed, outcome }`.
 */
adminRefundRequestsRouter.post('/:id/refund', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      await refundRequest(String(req.params.id ?? ''), req.user!, {
        paidByHand: body.paidByHand,
        amountUsd: body.amountUsd,
        note: body.note,
      })
    );
  } catch (error) {
    // A Stripe failure is a PaymentError with its own sentence; anything else
    // the generic one, with the cause for the administrator as `detail`.
    sendPublicError(req, res, error, 'Could not make the refund', 502);
  }
});

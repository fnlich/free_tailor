import { Router, type Request, type Response } from 'express';

import { requireUser } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import {
  cancelSubscription,
  describeSubscription,
  downgrade,
  resumeSubscription,
  subscribe,
} from '../services/subscriptions';

/**
 * The signed-in account's own subscription, bought from its credit balance
 * (services/subscriptions says how). A builder's: a reporter has no tier to
 * buy - their balance is earnings - and is refused every route here with 403
 * `role-not-allowed`; an administrator may read the page and buys nothing
 * (409 `admin-exempt`).
 *
 *   GET  /            the view: the tier, where it came from, the paid period,
 *                     every tier's price and offer, and the balance
 *   POST /subscribe   { subscription, chargeUsd } - buy, or move up now
 *   POST /downgrade   { subscription } - a lower paid tier at renewal
 *   POST /cancel      stop renewing; the tier ends with its 30 days
 *   POST /resume      undo a cancel, or a pending switch
 *
 * Every change answers the view as it stands afterwards, with `changed`
 * (false: a repeat that moved nothing) and, for a purchase, `chargedMilli`.
 * Every refusal is a public sentence about the request, with a `code`.
 */

const router = Router();
router.use(requireUser);

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await describeSubscription(req.user!));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not load your subscription');
  }
});

router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    res.json(await subscribe(req.user!, req.body));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not change your subscription');
  }
});

router.post('/downgrade', async (req: Request, res: Response) => {
  try {
    res.json(await downgrade(req.user!, req.body));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not change your subscription');
  }
});

router.post('/cancel', async (req: Request, res: Response) => {
  try {
    res.json(await cancelSubscription(req.user!));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not cancel your subscription');
  }
});

router.post('/resume', async (req: Request, res: Response) => {
  try {
    res.json(await resumeSubscription(req.user!));
  } catch (error) {
    sendPublicError(req, res, error, 'Could not keep your subscription');
  }
});

export default router;

import { Router, type Request, type Response } from 'express';

import { requireAdmin, requireUser } from '../middleware/auth';
import {
  describeMethods,
  getPayment,
  PaymentError,
  refundPayment,
  startCheckout,
} from '../services/payments';
import { listAllPayments, listPaymentsForUser } from '../database/paymentRepository';
import { getPricingLimits, PriceError } from '../services/payments/pricing';
import { getUserById } from '../database/userRepository';

/**
 * Buying credits, and an administrator's view of what was bought.
 *
 * Nothing here credits an account - that is the webhook router's job, and only
 * a signed request reaches it. These routes start a checkout, report what
 * happened, and let an administrator reconcile and refund.
 *
 * `POST /checkout` takes a COUNT of credits and no price. A request that
 * carried its own amount would be a request that set its own price; the server
 * quotes from settings every time.
 */

const router = Router();
router.use(requireUser);

function fail(res: Response, error: unknown): void {
  if (error instanceof PaymentError || error instanceof PriceError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error('[payments] A payment request failed.', error);
  res.status(502).json({ error: 'Could not reach the payment provider. Try again in a moment.' });
}

/**
 * What can be bought, and for how much.
 *
 * The price lives here rather than in the public app settings so that there is
 * one answer to "what does this cost" - the same function the checkout prices
 * with. A method whose keys are missing is reported unavailable WITH the reason,
 * because the person who needs to read it is the operator, and "no button"
 * tells them nothing.
 */
router.get('/methods', async (_req: Request, res: Response) => {
  try {
    const limits = await getPricingLimits();
    res.json({
      ...limits,
      methods: describeMethods(),
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/checkout', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { method?: unknown; credits?: unknown };
    const started = await startCheckout(req.user!, body.method, body.credits);
    res.status(201).json({
      paymentId: started.payment.id,
      reference: started.payment.reference,
      credits: started.payment.credits,
      amountCents: started.payment.amountCents,
      currency: started.payment.currency,
      redirectUrl: started.redirectUrl,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/', (req: Request, res: Response) => {
  res.json({ payments: listPaymentsForUser(req.user!.id) });
});

/**
 * One payment - what the return page polls while it waits for the webhook.
 *
 * 404 rather than 403 for somebody else's, the rule the sheet and order routes
 * already follow: the difference between those two answers confirms the
 * payment exists.
 */
router.get('/:id', (req: Request, res: Response) => {
  const payment = getPayment(String(req.params.id ?? ''));
  if (!payment || payment.userId !== req.user!.id) {
    res.status(404).json({ error: 'That payment was not found.' });
    return;
  }
  res.json({ payment });
});

export default router;

/**
 * The administrator's half, mounted separately at /api/admin/payments.
 *
 * Its own router rather than a role check inside the one above, so that
 * "requires an administrator" is a property of the mount and cannot be lost by
 * somebody adding a route in the wrong place.
 */
export const adminPaymentsRouter = Router();
adminPaymentsRouter.use(requireAdmin);

adminPaymentsRouter.get('/', (_req: Request, res: Response) => {
  const payments = listAllPayments();
  // The list is for reconciliation, so it needs to say WHO - and an email is
  // what an operator has in front of them when somebody writes in.
  res.json({
    payments: payments.map((payment) => ({
      ...payment,
      userEmail: getUserById(payment.userId)?.email ?? '',
    })),
  });
});

adminPaymentsRouter.post('/:id/refund', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { note?: unknown };
    const outcome = await refundPayment(
      String(req.params.id ?? ''),
      req.user!.id,
      typeof body.note === 'string' ? body.note : ''
    );
    // All three numbers, always. A refund that reversed forty of two hundred
    // credits is not a success worth reporting as a bare "done".
    res.json(outcome);
  } catch (error) {
    fail(res, error);
  }
});

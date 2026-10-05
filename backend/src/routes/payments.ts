import { Router, type Request, type Response } from 'express';

import { isAdmin, requireAdmin, requireUser } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import {
  describeMethods,
  getPayment,
  PaymentError,
  publishableKey,
  refundPayment,
  startCheckout,
  describeTargets,
} from '../services/payments';
import {
  countAllPayments,
  countPaymentsForUser,
  listAllPayments,
  listPaymentsForUser,
  toPaymentView,
  type PaymentMethod,
} from '../database/paymentRepository';
import { readPage } from './paging';
import { detachCard, getCardForUser, listCardsForUser } from '../database/savedCardRepository';
import * as stripe from '../integrations/stripe';
import { quotePurchase, requireThreeDSecure } from '../services/payments/pricing';
import { CREDIT_CURRENCY } from '../config/aiModelConfig';
import { getUserById } from '../database/userRepository';
import { closeRequestsForRefundedPayment } from '../services/refunds';

/**
 * Buying credit, and an administrator's view of what was bought.
 *
 * Nothing here credits an account - that is the webhook router's job, and only
 * a signed request reaches it. These routes start a checkout, report what
 * happened, and let an administrator reconcile and refund.
 *
 * A credit is a dollar. `POST /checkout` takes the dollars wanted
 * (`amountUsd`), which are also the charge - nothing is taken out - and the
 * server decides whether that amount may be bought. Every amount in every
 * response here is an integer count of thousandths of a dollar, in a field
 * ending `Milli`; a payment from before credits were dollars carries what it
 * bought then under `legacyCredits`.
 */

const router = Router();
router.use(requireUser);

/**
 * A refused or failed payment request.
 *
 * `PaymentError` and `PriceError` are public: the buyer's own amount, card or
 * limit, or "purchases are not available" with the reason as an
 * administrator's `detail`. Anything else is the provider being unreachable
 * as far as the buyer is concerned - a 502 with a ref.
 */
function fail(req: Request, res: Response, error: unknown): void {
  sendPublicError(req, res, error, 'Could not reach the payment provider', 502);
}

/**
 * What anybody but an administrator is told about a method that is not on
 * offer. The real reason names the STRIPE_* and CRYPTOMUS_* variables or the
 * Admin -> Payments limits that leave nothing to buy - the operator's to read.
 */
const NOT_AVAILABLE = 'Not available right now.';

function withPublicReason<T extends { reason?: string }>(entry: T, admin: boolean): T {
  return admin || !entry.reason ? entry : { ...entry, reason: NOT_AVAILABLE };
}

/**
 * What can be bought, and in what amounts.
 *
 * The bounds live here rather than in the public app settings so that there is
 * one answer to "what may I buy" - the same function the checkout judges with.
 * A method whose keys are missing is reported unavailable WITH the reason,
 * because the person who needs to read it is the operator, and "no button"
 * tells them nothing.
 */
router.get('/methods', async (req: Request, res: Response) => {
  try {
    const admin = isAdmin(req);
    res.json({
      currency: CREDIT_CURRENCY,
      methods: describeMethods().map((entry) => withPublicReason(entry, admin)),
      /*
       * The same information, per thing a buyer can actually choose.
       *
       * `methods` is kept beside it rather than replaced: it is what an older
       * page reads, and a deploy must not blank the buy page of a browser tab
       * that has not been reloaded.
       */
      targets: (await describeTargets()).map((entry) => withPublicReason(entry, admin)),
      /*
       * So the card step can warn before the challenge appears.
       *
       * Served here rather than in public settings, for the same reason the
       * bounds are: this is the one response the buy page already asks for, and
       * a second place to read payment facts from is a second place to get
       * them out of step.
       */
      requireThreeDSecure: await requireThreeDSecure(),
      /*
       * Served, not baked in.
       *
       * The payment form in the browser needs this key, and it is safe to hand
       * out - that is what "publishable" means. Serving it keeps every Stripe
       * value in the one .env the server reads, instead of a NEXT_PUBLIC_
       * variable that has to be present at FRONTEND BUILD time and needs a
       * rebuild to change.
       */
      publishableKey: publishableKey(),
    });
  } catch (error) {
    fail(req, res, error);
  }
});

/**
 * Whether a purchase may be made, and what it is, WITHOUT starting one:
 * `?method=card|crypto&amountUsd=12.50` -> `{ amountMilli, creditMilli,
 * currency }`, the two amounts always equal.
 *
 * The order summary has to print the charge and the credit the account will
 * actually receive before anybody commits to anything - and both figures have
 * to be the server's, or the summary and the charge disagree the first time a
 * limit moves mid-session.
 *
 * Read-only, and that is the whole point of it existing beside `/checkout`.
 * Pricing the summary by opening a checkout meant a payment row and a call to
 * a provider for a purchase nobody had agreed to yet: a buyer paying with a
 * card they had already saved left an abandoned `pending` row behind on every
 * visit to the summary, and burned two of the twenty checkouts an account may
 * open in an hour for one purchase. This creates nothing and calls nobody.
 *
 * It takes the same COUNT of credits the checkout takes, and no amount - for
 * the same reason.
 */
router.get('/quote', async (req: Request, res: Response) => {
  try {
    const method = req.query.method;
    if (method !== 'card' && method !== 'crypto') {
      throw new PaymentError('Choose a payment method.');
    }
    // A count of credits from a buy page loaded before credits were dollars.
    // Read as dollars it would quote a different purchase than the page shows.
    if (req.query.credits !== undefined && req.query.amountUsd === undefined) {
      throw new PaymentError('This page is from an older version of the app. Reload it and try again.');
    }
    // No coin is named here. The buyer chooses it on the provider's own page,
    // so an `asset` in the query could not change the amount and is not read.
    const quote = await quotePurchase(req.query.amountUsd, { method });
    res.json({
      amountMilli: quote.amountMilli,
      creditMilli: quote.creditMilli,
      currency: quote.currency,
    });
  } catch (error) {
    fail(req, res, error);
  }
});

router.post('/checkout', async (req: Request, res: Response) => {
  try {
    /*
     * Four keys, read one at a time.
     *
     * Spreading `req.body` into the service would let a future field arrive
     * without anybody deciding it should, which is how a request ends up able
     * to set its own terms. Each one is named here or it does not exist -
     * which is why a stale tab still sending `asset` is simply not read.
     */
    const body = (req.body ?? {}) as Record<string, unknown>;
    // A count of credits from a buy page loaded before credits were dollars:
    // at the old price, 10 credits was $5, and nothing here can say which the
    // buyer meant. Refused, before a checkout is opened.
    if (body.credits !== undefined && body.amountUsd === undefined) {
      throw new PaymentError('This page is from an older version of the app. Reload it and try again.');
    }
    const started = await startCheckout(
      req.user!,
      {
        method: body.method,
        amountUsd: body.amountUsd,
        cardId: body.cardId,
        saveCard: body.saveCard,
      },
      // Already vetted: the CORS middleware refuses a disallowed origin before
      // any route runs, so this is a checked value rather than a raw header.
      { requestOrigin: req.headers.origin }
    );
    const view = toPaymentView(started.payment);
    res.status(201).json({
      paymentId: view.id,
      reference: view.reference,
      amountMilli: view.amountMilli,
      creditMilli: view.creditMilli,
      currency: view.currency,
      // One of three: a secret to mount our own form with, somewhere to send
      // the browser, or nothing to do but wait for a charge already made.
      // Never a price - the page displays what it was quoted.
      ...(started.clientSecret ? { clientSecret: started.clientSecret } : {}),
      ...(started.redirectUrl ? { redirectUrl: started.redirectUrl } : {}),
      ...(started.processing ? { processing: true } : {}),
    });
  } catch (error) {
    fail(req, res, error);
  }
});

/*
 * Saved cards, declared ABOVE `/:id`.
 *
 * Express matches in declaration order, so `GET /payments/cards` placed after
 * `GET /payments/:id` resolves to that route with an id of "cards" and answers
 * 404 - a bug with no error message anywhere. Order is the fix, and this note
 * is here so nobody tidies these further down the file.
 */
router.get('/cards', (req: Request, res: Response) => {
  /*
   * Shaped, not spread.
   *
   * The row holds the Stripe handles - the customer and the payment method -
   * and the browser has no use for either. They are not secrets on their own
   * (nothing can be done with them without the secret key, which is not in
   * this database) but there is no reason to hand them out, and a response
   * built by spreading the row would ship whatever column is added next.
   */
  const cards = listCardsForUser(req.user!.id).map((card) => ({
    id: card.id,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.expMonth,
    expYear: card.expYear,
    createdAt: card.createdAt,
  }));
  res.json({ cards });
});

router.delete('/cards/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const card = getCardForUser(req.user!.id, req.params.id);
    if (!card) {
      // 404 for somebody else's, never 403: the difference would confirm the
      // card exists. The same rule the payment and order routes follow.
      res.status(404).json({ error: 'No such card.' });
      return;
    }

    /*
     * Forgotten at Stripe FIRST, then here.
     *
     * The other order would leave a card the buyer believes is gone still
     * usable at the provider, which is the failure worth avoiding. If Stripe
     * refuses, the row stays and they can try again.
     */
    await stripe.detachPaymentMethod(card.methodRef);
    detachCard(req.user!.id, card.id);
    res.json({ deleted: true });
  } catch (error) {
    // Through the shared refusal, so the log line carries a ref the buyer can
    // quote and an administrator gets Stripe's reason - which, with the keys
    // gone, is permanent configuration rather than a moment's wait.
    sendPublicError(req, res, error, 'That card could not be removed', 502);
  }
});

/**
 * This account's own payments, a page at a time.
 *
 * It used to answer with the newest fifty and say nothing about the rest,
 * which made it a window rather than a history: every row here links to the
 * order's own page, so a payment past the cap was an order its buyer could not
 * open. `total` is what lets the page say how many it is not showing.
 *
 * Both parameters are optional and the defaults are the old behaviour, so a
 * browser tab loaded before this shipped keeps working unchanged.
 *
 * `method` is optional too, and filters the count as well as the page. Unlike
 * a junk offset it is refused rather than ignored: an unknown method quietly
 * becoming "every method" would fill the crypto tab with card payments, and
 * nothing on screen would say why.
 */
router.get('/', (req: Request, res: Response) => {
  const { limit, offset } = readPage(req, 50, 100);
  const asked = req.query.method;
  if (asked !== undefined && asked !== 'card' && asked !== 'crypto') {
    res.status(400).json({ error: 'The method filter must be "card" or "crypto".' });
    return;
  }
  const method: PaymentMethod | undefined = asked;
  res.json({
    payments: listPaymentsForUser(req.user!.id, limit, offset, method).map(toPaymentView),
    total: countPaymentsForUser(req.user!.id, method),
    offset,
  });
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
  res.json({ payment: toPaymentView(payment) });
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

/** How many rows one request returns. The page asks again for the next lot. */
const ADMIN_PAGE_SIZE = 200;

adminPaymentsRouter.get('/', (req: Request, res: Response) => {
  /*
   * Clamped, because the offset arrives from a query string.
   *
   * A negative offset is a SQL error rather than a refusal, and a NaN silently
   * becomes the first page again - which would make the page loop on itself
   * fetching the same rows for ever.
   */
  const asked = Number.parseInt(String(req.query.offset ?? '0'), 10);
  const offset = Number.isFinite(asked) && asked > 0 ? asked : 0;

  const payments = listAllPayments(ADMIN_PAGE_SIZE, offset);
  // The list is for reconciliation, so it needs to say WHO - and an email is
  // what an operator has in front of them when somebody writes in.
  res.json({
    payments: payments.map((payment) => ({
      ...toPaymentView(payment),
      userEmail: getUserById(payment.userId)?.email ?? '',
    })),
    /*
     * So the page knows there is more, and can say so.
     *
     * Without this it had no way to tell a short last page from a full one,
     * and described whatever it had as "every credit purchase on this
     * installation" - which was wrong by 177 rows, 66 of them refundable.
     */
    total: countAllPayments(),
    offset,
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
    // The money went back, so any refund request still open for this payment
    // is answered: closed as Refunded, its requester told, here rather than
    // left in the queue for somebody to decline by hand.
    const closedRequests = closeRequestsForRefundedPayment(outcome.payment.id, req.user!);
    // All three numbers, always. A refund that reversed $12.400 of $50.000 is
    // not a success worth reporting as a bare "done".
    res.json({ ...outcome, payment: toPaymentView(outcome.payment), closedRequests });
  } catch (error) {
    fail(req, res, error);
  }
});

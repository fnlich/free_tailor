import { Router, type Request, type Response } from 'express';

import { requireAdmin, requireUser } from '../middleware/auth';
import {
  describeMethods,
  getPayment,
  PaymentError,
  publishableKey,
  refundPayment,
  startCheckout,
  describeTargets,
} from '../services/payments';
import { listAllPayments, listPaymentsForUser } from '../database/paymentRepository';
import { detachCard, getCardForUser, listCardsForUser } from '../database/savedCardRepository';
import * as stripe from '../integrations/stripe';
import {
  getPricingLimits,
  PriceError,
  quoteCredits,
  requireThreeDSecure,
} from '../services/payments/pricing';
import { isAssetId } from '../config/chainAssets';
import { getUserById } from '../database/userRepository';
import {
  getInvoiceForPayment,
  listHeldInvoices,
} from '../database/chainInvoiceRepository';
import { listOpenOrphans, resolveOrphan } from '../database/chainOrphanRepository';
import { describeInvoice, formatAtomic } from '../services/payments/chain/invoices';

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
      /*
       * The same information, per thing a buyer can actually choose.
       *
       * `methods` is kept beside it rather than replaced: it is what an older
       * page reads, and a deploy must not blank the buy page of a browser tab
       * that has not been reloaded.
       */
      targets: await describeTargets(),
      /*
       * So the card step can warn before the challenge appears.
       *
       * Served here rather than in public settings, for the same reason the
       * price is: this is the one response the buy page already asks for, and
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
    fail(res, error);
  }
});

/**
 * What a purchase would cost, WITHOUT starting one.
 *
 * The order summary has to print the charge, the fee and the credits the
 * account will actually receive before anybody commits to anything - and every
 * one of those figures has to be the server's, or the summary and the charge
 * disagree the first time a rate or a setting moves mid-session.
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
    const asset = typeof req.query.asset === 'string' && req.query.asset.trim()
      ? req.query.asset.trim()
      : undefined;
    if (asset && !isAssetId(asset)) {
      throw new PaymentError('That coin is not one this server can take.');
    }

    const quote = await quoteCredits(req.query.credits, asset ? { method, asset } : { method });
    res.json({
      credits: quote.credits,
      grossCredits: quote.grossCredits,
      unitPriceCents: quote.unitPriceCents,
      amountCents: quote.amountCents,
      feeCents: quote.feeCents,
      currency: quote.currency,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/checkout', async (req: Request, res: Response) => {
  try {
    /*
     * Five keys, read one at a time, and never an amount.
     *
     * Spreading `req.body` into the service would let a future field arrive
     * without anybody deciding it should, which is how a request ends up able
     * to set its own price. Each one is named here or it does not exist.
     */
    const body = (req.body ?? {}) as Record<string, unknown>;
    const started = await startCheckout(req.user!, {
      method: body.method,
      credits: body.credits,
      asset: body.asset,
      cardId: body.cardId,
      saveCard: body.saveCard,
    });
    res.status(201).json({
      paymentId: started.payment.id,
      reference: started.payment.reference,
      credits: started.payment.credits,
      amountCents: started.payment.amountCents,
      feeCents: started.payment.feeCents,
      currency: started.payment.currency,
      // One of three: a secret to mount our own form with, somewhere to send
      // the browser, or nothing to do but wait for a charge already made.
      // Never a price - the page displays what it was quoted.
      ...(started.clientSecret ? { clientSecret: started.clientSecret } : {}),
      ...(started.redirectUrl ? { redirectUrl: started.redirectUrl } : {}),
      ...(started.processing ? { processing: true } : {}),
      // Where to send coin, and how much. Only for an on-chain payment.
      ...(started.invoice ? { invoice: started.invoice } : {}),
    });
  } catch (error) {
    fail(res, error);
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
    console.error('[payments] a saved card could not be removed:', error);
    res.status(502).json({ error: 'That card could not be removed. Try again in a moment.' });
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
  /*
   * The invoice rides along, so the deposit panel has one thing to poll.
   *
   * It is what changes while somebody is waiting: an amount arrives, then it
   * gets deeper, then it is credited. The payment itself only moves once, at
   * the very end, so a page watching only the payment would show nothing at
   * all for the several minutes a chain takes.
   */
  const invoice = getInvoiceForPayment(payment.id);
  res.json({ payment, ...(invoice ? { invoice: describeInvoice(invoice) } : {}) });
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

/**
 * Money that arrived and could not be matched to an order.
 *
 * Held rather than credited or written off. The creation-time rule - refusing
 * a taken amount instead of shifting it - makes this rare, because two open
 * invoices on one asset now differ by dollars rather than by one atomic unit.
 * Rare is not never: a wallet rounds, a withdrawal takes a fee, somebody types
 * the figure by hand. When that money cannot be attributed to exactly one
 * order, nothing moves and it ends up in this list.
 *
 * On this page rather than a page of its own, because this is where an
 * administrator already comes to reconcile against the provider's own records,
 * and a second place to check is a place nobody checks.
 */
adminPaymentsRouter.get('/held', (_req: Request, res: Response) => {
  /*
   * Two shapes of the same problem, in one list.
   *
   * A HELD INVOICE is money that can be attributed to an order but not
   * credited - too little to buy a credit, or a payment row that has gone.
   * An ORPHAN is money that could have been meant by two different orders, so
   * it has no invoice at all. An administrator does not care about that
   * distinction when deciding what to do, so they are served together.
   */
  const orphans = listOpenOrphans().map((orphan) => ({
    id: orphan.id,
    paymentId: '',
    asset: orphan.asset,
    chain: orphan.chain,
    address: '',
    expected: '',
    received: formatAtomic(orphan.amountAtomic, orphan.decimals),
    txid: orphan.txid,
    note: orphan.reason,
    at: orphan.createdAt,
    /** Only an orphan can be dismissed; a held invoice is its own record. */
    resolvable: true,
  }));

  const held = listHeldInvoices().map((invoice) => ({
    id: invoice.id,
    paymentId: invoice.paymentId,
    asset: invoice.asset,
    chain: invoice.chain,
    address: invoice.address,
    expected: formatAtomic(invoice.amountAtomic, invoice.decimals),
    received: invoice.seenAmount ? formatAtomic(invoice.seenAmount, invoice.decimals) : '',
    txid: invoice.seenTxid,
    /** Why it is here, in a sentence a person can act on. */
    note: invoice.note,
    at: invoice.updatedAt,
    resolvable: false,
  }));

  res.json({ held: [...orphans, ...held].sort((left, right) => right.at.localeCompare(left.at)) });
});

/**
 * Dismisses an unattributable transfer once a person has dealt with it.
 *
 * A queue that cannot be cleared is a queue nobody reads, and an administrator
 * who has refunded the sender or credited the account by hand has genuinely
 * finished with it. Only orphans can be dismissed - a held invoice is the
 * payment's own record and stays.
 */
adminPaymentsRouter.post('/held/:id/resolve', (req: Request, res: Response) => {
  const resolved = resolveOrphan(String(req.params.id ?? ''));
  if (!resolved) {
    res.status(404).json({ error: 'That is not an open item.' });
    return;
  }
  res.json({ resolved: true });
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

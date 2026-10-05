import crypto from 'crypto';
import { getDb } from './sqlite';
import { formatSequenceDate, nextDailyReference } from './dailySequence';
import { centsToMilli } from '../utils/money';

/**
 * Payments, and the webhooks that decide them.
 *
 * This module knows nothing about credits. It records what was bought, what
 * the provider said about it, and nothing else - moving a balance is the
 * ledger's job, and keeping the two apart is what lets the ledger stay
 * append-only while a payment changes state several times.
 *
 * Every write here is narrow and conditional, in the style of
 * creditRepository: the state machine is enforced in the WHERE clause, so a
 * webhook arriving twice, or out of order, cannot talk a payment backwards.
 */

export type PaymentMethod = 'card' | 'crypto';
/**
 * Who took the money.
 *
 * `coinbase` and `chain` stay in the union although both paths are DELETED -
 * no code here can open one, and neither webhook is answered any more. Their
 * rows still exist, still have to read and render, and still have to refund
 * with the right advice about where that money actually is. Narrowing this
 * union is what misreads history: a row does not stop having been paid
 * on-chain because the code that watched the chain was deleted.
 *
 * Nothing in this codebase switches exhaustively on this type, so ADDING a
 * member is not a compile error. A new provider has to be carried by hand to
 * every place that says something different per provider - in practice the
 * refund advice in `services/payments`, the same sentence on the admin page,
 * and the precedence in `describeMethods`.
 */
export type PaymentProvider = 'stripe' | 'coinbase' | 'chain' | 'cryptomus';

/**
 * Where a payment has got to.
 *
 * `pending` is every payment that has been started and not decided - the
 * overwhelming majority of rows at any moment, because a person who opens a
 * checkout page and closes it leaves one behind. Only `paid` has ever moved
 * credits, and only a `paid` payment can be refunded.
 *
 * `refunding` exists for one reason: a refund calls the provider over the
 * network, and two administrators - or one with two tabs - would otherwise
 * both read `paid`, both call out, and both report an outcome for work only
 * one of them did. Claiming the row before the network call makes the second
 * attempt a refusal instead of a false report.
 */
export type PaymentState = 'pending' | 'paid' | 'failed' | 'expired' | 'refunding' | 'refunded';

/**
 * What a payment made before credits became dollars bought, as it was written:
 * a count of credits at a price per credit, possibly less a fee. Kept so its
 * receipt still says "200 credits at $0.50" - a receipt has to say what was
 * sold - and never converted into dollars: those credits were reset to $0
 * with every balance (database/dollarSwitch.ts).
 */
export type LegacyPaymentCredits = {
  /** Credits quoted. */
  credits: number;
  /** Credits the ledger actually received (0 on a row from before the column existed: read `credits`). */
  creditsGranted: number;
  /** Credits a refund actually reversed. */
  refundedCredits: number;
  /** What one credit cost, in cents. */
  unitPriceCents: number;
};

export type Payment = {
  id: string;
  reference: string;
  userId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  providerRef?: string;
  /** What was charged, in cents: what the provider was asked for and must report back. */
  amountCents: number;
  currency: string;
  state: PaymentState;
  failure: string;
  creditedAt?: string;
  refundedAt?: string;
  /** The fee taken, on a payment from before purchases stopped taking one. 0 since. */
  feeCents: number;
  /**
   * What this payment credits, in thousandths of a dollar: exactly its charge.
   * 0 on a payment made before credits became dollars (see `legacyCredits`),
   * except one still pending at the switch, which was stamped with its charge.
   */
  creditMilli: number;
  /** What the ledger actually received for it, in thousandths. 0 until it is credited. */
  creditedMilli: number;
  /** What a refund actually took back from the balance, in thousandths. See the note on refunds. */
  refundedMilli: number;
  /**
   * What the refund RETURNED to the buyer, in cents: the whole charge for a
   * refund from the payments list, the unspent part for one a refund request
   * asked for (services/refunds). 0 until refunded. A payment refunded before
   * refunds could be partial reads as its whole charge, because it was.
   */
  refundCents: number;
  /** Non-null on a payment from before credits became dollars. */
  legacyCredits: LegacyPaymentCredits | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A payment as the API sends it: every amount in thousandths of a dollar, in a
 * field ending `Milli`, like every other amount in every response. The cents
 * the provider works in stay inside.
 */
export type PaymentView = Omit<Payment, 'amountCents' | 'feeCents' | 'refundCents' | 'legacyCredits'> & {
  amountMilli: number;
  feeMilli: number;
  /** What the refund returned to the buyer, in thousandths: `refundCents` x 10. 0 until refunded. */
  refundAmountMilli: number;
  legacyCredits: (Omit<LegacyPaymentCredits, 'unitPriceCents'> & { unitPriceMilli: number }) | null;
};

export function toPaymentView(payment: Payment): PaymentView {
  const { amountCents, feeCents, refundCents, legacyCredits, ...rest } = payment;
  return {
    ...rest,
    amountMilli: centsToMilli(amountCents),
    feeMilli: centsToMilli(feeCents),
    refundAmountMilli: centsToMilli(refundCents),
    legacyCredits: legacyCredits
      ? {
          credits: legacyCredits.credits,
          creditsGranted: legacyCredits.creditsGranted,
          refundedCredits: legacyCredits.refundedCredits,
          unitPriceMilli: centsToMilli(legacyCredits.unitPriceCents),
        }
      : null,
  };
}

type PaymentRow = {
  id: string;
  reference: string;
  user_id: string;
  method: string;
  provider: string;
  provider_ref: string | null;
  credits: number;
  amount_cents: number;
  currency: string;
  unit_price_cents: number;
  state: string;
  failure: string;
  credited_at: string | null;
  refunded_at: string | null;
  refunded_credits: number;
  fee_cents: number;
  credits_granted: number;
  credit_milli: number;
  credited_milli: number;
  refunded_milli: number;
  refund_cents: number;
  created_at: string;
  updated_at: string;
};

const PAYMENT_COLUMNS = `id, reference, user_id, method, provider, provider_ref, credits,
  amount_cents, currency, unit_price_cents, state, failure, credited_at, refunded_at,
  refunded_credits, fee_cents, credits_granted, credit_milli, credited_milli, refunded_milli,
  refund_cents, created_at, updated_at`;

function now(): string {
  return new Date().toISOString();
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    reference: row.reference,
    userId: row.user_id,
    method: row.method as PaymentMethod,
    provider: row.provider as PaymentProvider,
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    amountCents: row.amount_cents,
    currency: row.currency,
    state: row.state as PaymentState,
    failure: row.failure ?? '',
    ...(row.credited_at ? { creditedAt: row.credited_at } : {}),
    ...(row.refunded_at ? { refundedAt: row.refunded_at } : {}),
    feeCents: row.fee_cents ?? 0,
    creditMilli: row.credit_milli ?? 0,
    creditedMilli: row.credited_milli ?? 0,
    refundedMilli: row.refunded_milli ?? 0,
    // Every refund before refund requests returned the whole charge; the
    // column is 0 on those rows, and on every payment not refunded.
    refundCents:
      (row.refund_cents ?? 0) > 0
        ? row.refund_cents
        : row.state === 'refunded'
          ? row.amount_cents
          : 0,
    // A payment made since the switch writes 0 credits; one from before it
    // always quoted at least one.
    legacyCredits:
      row.credits > 0
        ? {
            credits: row.credits,
            creditsGranted: row.credits_granted ?? 0,
            refundedCredits: row.refunded_credits ?? 0,
            unitPriceCents: row.unit_price_cents,
          }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type NewPayment = {
  userId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  amountCents: number;
  /** What it will credit, in thousandths of a dollar: the charge, exactly. */
  creditMilli: number;
  currency: string;
};

/**
 * Starts a payment, before the provider has been told anything.
 *
 * The row exists first so that its id can be handed to the provider as the
 * thing to quote back. A webhook that arrives before we have written down what
 * it is about has nowhere to land.
 */
export function createPayment(input: NewPayment, at: Date = new Date()): Payment {
  const db = getDb();
  const timestamp = at.toISOString();
  const datePart = formatSequenceDate(at);

  const insert = db.transaction((reference: string): PaymentRow => {
    const id = `pay_${crypto.randomUUID()}`;
    db.prepare(
      // The whole-credit columns get 0: they describe payments from before
      // credits were dollars, and an older build rolled back to reads a 0 as
      // "credits nothing" rather than as a count to grant.
      `INSERT INTO payments (id, reference, user_id, method, provider, credits, amount_cents,
                             currency, unit_price_cents, fee_cents, credit_milli, state, created_at, updated_at)
       VALUES (@id, @reference, @userId, @method, @provider, 0, @amountCents,
               @currency, 0, 0, @creditMilli, 'pending', @createdAt, @createdAt)`
    ).run({
      id,
      reference,
      userId: input.userId,
      method: input.method,
      provider: input.provider,
      amountCents: input.amountCents,
      currency: input.currency,
      creditMilli: input.creditMilli,
      createdAt: timestamp,
    });
    return db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ?`).get(id) as PaymentRow;
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return toPayment(insert(nextDailyReference('payments', 'reference', 'FT-PAY-', datePart)));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/UNIQUE constraint failed: payments.reference/i.test(message)) throw error;
    }
  }
  throw new Error('Could not allocate a payment reference.');
}

/**
 * Records which object at the provider this payment is.
 *
 * Separate from creating the row because the provider assigns it: the session
 * or charge does not exist until we have asked for one, and we cannot ask
 * without something to quote.
 *
 * Conditional on the reference still being EMPTY, not on the state still
 * being `pending`. Both stop a late write re-pointing a payment at a different
 * session, which is the thing to prevent; only this one still records the
 * reference when a webhook has decided the payment during the round trip that
 * produced it. The difference is not academic - a `paid` payment with no
 * provider reference is money taken that the refund path then refuses to give
 * back.
 */
export function attachProviderRef(paymentId: string, providerRef: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE payments SET provider_ref = @providerRef, updated_at = @at
       WHERE id = @id AND (provider_ref IS NULL OR provider_ref = '')`
    )
    .run({ id: paymentId, providerRef, at: now() });
  return result.changes > 0;
}

export function getPayment(id: string): Payment | null {
  const row = getDb()
    .prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ?`)
    .get(id) as PaymentRow | undefined;
  return row ? toPayment(row) : null;
}

export function getPaymentByProviderRef(provider: PaymentProvider, providerRef: string): Payment | null {
  const trimmed = providerRef.trim();
  if (!trimmed) return null;
  const row = getDb()
    .prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider = ? AND provider_ref = ?`)
    .get(provider, trimmed) as PaymentRow | undefined;
  return row ? toPayment(row) : null;
}

/**
 * A page of one account's payments, newest first.
 *
 * The offset is what makes this a history rather than a window onto the newest
 * fifty. Each row on the credits page links to the order's own page, so a row
 * the list cannot reach is an order its buyer cannot open.
 *
 * The `rowid` tiebreak is load-bearing for the same reason it is in
 * `listAllPayments` below: `created_at` is a second-resolution string, so
 * without it two payments made in the same second can swap places between two
 * requests, and one of them is returned on neither page.
 *
 * `method` narrows it to card or crypto, the credits page's two order tabs.
 */
export function listPaymentsForUser(
  userId: string,
  limit = 50,
  offset = 0,
  method?: PaymentMethod
): Payment[] {
  /*
   * Two fixed statements rather than one with a clause spliced in. `method` is
   * bound either way; keeping the SQL text constant means there is no string
   * here a future caller could widen into something that is not a parameter.
   */
  const rows = (
    method
      ? getDb()
          .prepare(
            `SELECT ${PAYMENT_COLUMNS} FROM payments
             WHERE user_id = ? AND method = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
          )
          .all(userId, method, limit, offset)
      : getDb()
          .prepare(
            `SELECT ${PAYMENT_COLUMNS} FROM payments
             WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
          )
          .all(userId, limit, offset)
  ) as PaymentRow[];
  return rows.map(toPayment);
}

/**
 * How many that account has, so a page can say what it is not showing.
 *
 * Filtered exactly as the list is, or "1-10 of 23" counts card payments under
 * a table that only shows crypto ones.
 */
export function countPaymentsForUser(userId: string, method?: PaymentMethod): number {
  const row = (
    method
      ? getDb()
          .prepare('SELECT COUNT(*) AS total FROM payments WHERE user_id = ? AND method = ?')
          .get(userId, method)
      : getDb().prepare('SELECT COUNT(*) AS total FROM payments WHERE user_id = ?').get(userId)
  ) as { total: number };
  return row.total;
}

/** Every payment, newest first. The administrator's reconciliation view. */
/**
 * A page of every payment, newest first.
 *
 * The offset is what makes the list reachable past its first page, and the
 * reason it had to exist: refunds are driven from a ROW on the admin page, so
 * a payment the page cannot show is a payment nobody can refund. With 377
 * payments on one install, 66 paid ones sat past the cap with no button
 * anywhere in the product - while the page introduced itself as "every credit
 * purchase on this installation".
 *
 * `rowid` breaks the tie on `created_at`, which is a second-resolution string:
 * without it two payments made in the same second could swap places between
 * pages and one of them would never be returned.
 */
export function listAllPayments(limit = 200, offset = 0): Payment[] {
  const rows = getDb()
    .prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM payments
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as PaymentRow[];
  return rows.map(toPayment);
}

/** How many there are in total, so a page can say what it is not showing. */
export function countAllPayments(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS total FROM payments').get() as { total: number };
  return row.total;
}

/**
 * Marks a payment paid, and says whether THIS call is the one that did it.
 *
 * The return value is the whole point. `WHERE state = 'pending'` means a
 * replayed webhook changes no rows and gets `false`, so the caller knows not to
 * credit again. The ledger's idempotency key would catch it anyway; this
 * catches it one step earlier and without relying on that.
 */
/**
 * Marks a payment paid, and records what was credited for it, in thousandths
 * of a dollar.
 *
 * `creditedMilli` is written in the SAME conditional UPDATE, not a second
 * statement: the guard is `state = 'pending'`, so only the first caller moves
 * the row, and a credited amount written separately could land against a row
 * somebody else had already settled.
 */
export function markPaid(paymentId: string, creditedMilli: number): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'paid', credited_at = @at, updated_at = @at, failure = '',
              credited_milli = @credited
       WHERE id = @id AND state = 'pending'`
    )
    .run({ id: paymentId, at: timestamp, credited: creditedMilli });
  return result.changes > 0;
}

/**
 * Marks a payment failed or expired.
 *
 * Only from `pending`: a provider that reports an expiry after reporting
 * success - which happens, because those are different subsystems at their end
 * - must not be able to un-pay a payment whose credits are already spent.
 */
export function markUnpaid(paymentId: string, state: 'failed' | 'expired', failure = ''): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = @state, failure = @failure, updated_at = @at
       WHERE id = @id AND state = 'pending'`
    )
    .run({ id: paymentId, state, failure: failure.slice(0, 500), at: timestamp });
  return result.changes > 0;
}

/**
 * Records a refund: how much of it the balance could actually give back, in
 * thousandths of a dollar, and how much money went back, in cents (the whole
 * charge, or the part a refund request asked for).
 *
 * `reversedMilli` is not always what was credited. A balance may not go
 * negative, so refunding somebody who has already spent what they bought
 * returns their money and reverses only what is left. Storing the difference
 * is the point: the admin page has to be able to say "refunded $50.000,
 * reversed $12.400", because the alternative is a number that quietly does not
 * add up.
 */
export function markRefunded(paymentId: string, reversedMilli: number, refundCents: number): boolean {
  if (!Number.isSafeInteger(reversedMilli) || reversedMilli < 0) {
    throw new Error(`A reversed amount must be a whole, non-negative number of thousandths, not ${reversedMilli}.`);
  }
  if (!Number.isSafeInteger(refundCents) || refundCents <= 0) {
    throw new Error(`A refunded amount must be a positive whole number of cents, not ${refundCents}.`);
  }
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'refunded', refunded_at = @at, refunded_milli = @reversed,
                           refund_cents = @refundCents, updated_at = @at
       WHERE id = @id AND state = 'refunding'`
    )
    .run({ id: paymentId, reversed: reversedMilli, refundCents, at: timestamp });
  return result.changes > 0;
}

/**
 * Claims a payment for a refund, and says whether THIS caller got it.
 *
 * One conditional UPDATE, before anything is said to the provider. The second
 * caller changes no rows, is told `false`, and answers the administrator with
 * a refusal - rather than calling the provider a second time, measuring a
 * balance that the first caller has already moved, and reporting that nothing
 * could be reversed.
 *
 * Also refused while a refund REQUEST for this payment holds a card refund
 * Stripe has not confirmed (`refund_requests.hold_key`, services/refunds): that
 * request has already taken its credit off the balance, and a refund of the
 * whole payment on top would take it a second time. `heldBy` is that request
 * itself, coming back to finish its own refund. In the UPDATE rather than read
 * first, so no second process can slip between the look and the claim. The
 * payment still reads `paid` after this refusal, which is how the caller tells
 * it from a claim somebody else holds.
 */
export function beginRefund(paymentId: string, heldBy: string | null = null): boolean {
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'refunding', updated_at = @at
       WHERE id = @id AND state = 'paid'
         AND NOT EXISTS (
           SELECT 1 FROM refund_requests r
            WHERE r.payment_id = @id AND r.hold_key IS NOT NULL
              AND r.state IN ('requested', 'approved')
              AND (@heldBy IS NULL OR r.id <> @heldBy)
         )`
    )
    .run({ id: paymentId, heldBy, at: now() });
  return result.changes > 0;
}

/**
 * Gives the claim back when the refund did not happen.
 *
 * Only from `refunding`, so a claim released late cannot talk a payment that
 * has since been refunded back into being refundable.
 */
export function releaseRefund(paymentId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'paid', updated_at = @at
       WHERE id = @id AND state = 'refunding'`
    )
    .run({ id: paymentId, at: now() });
  return result.changes > 0;
}

/**
 * How many checkouts an account has opened recently.
 *
 * Every one of these cost a call to a payment provider, so this is what stops
 * a signed-in account looping the checkout endpoint and running up somebody
 * else's API bill. Counting rows rather than requests deliberately: a refused
 * checkout leaves a `failed` row, and a loop of refusals is the same abuse as
 * a loop of successes.
 */
export function countPaymentsSince(userId: string, sinceIso: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND created_at >= ?')
    .get(userId, sinceIso) as { n: number };
  return row.n;
}

export type PaymentEvent = {
  provider: PaymentProvider;
  eventId: string;
  type: string;
  payload: string;
  paymentId?: string;
};

/**
 * Writes down a webhook, and says whether it is new.
 *
 * `false` means this exact event has been seen before and the caller should do
 * nothing further. The UNIQUE index is the decision, not a pre-check: two
 * deliveries racing each other both look unseen if you SELECT first, and only
 * one can win an INSERT.
 */
export function recordEventOnce(event: PaymentEvent): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO payment_events (id, payment_id, provider, event_id, type, payload, received_at)
         VALUES (@id, @paymentId, @provider, @eventId, @type, @payload, @receivedAt)`
      )
      .run({
        id: `pev_${crypto.randomUUID()}`,
        paymentId: event.paymentId ?? null,
        provider: event.provider,
        eventId: event.eventId,
        type: event.type,
        payload: event.payload,
        receivedAt: now(),
      });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed/i.test(message)) return false;
    throw error;
  }
}

import crypto from 'crypto';
import { getDb } from './sqlite';
import { formatSequenceDate, nextDailyReference } from './dailySequence';

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
 * `coinbase` stays in the union although new crypto checkouts no longer use
 * it: rows exist, they still have to read and render, and its webhook still
 * has to be answered for an install part-way through the change.
 */
export type PaymentProvider = 'stripe' | 'coinbase' | 'chain';

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

export type Payment = {
  id: string;
  reference: string;
  userId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  providerRef?: string;
  credits: number;
  amountCents: number;
  currency: string;
  unitPriceCents: number;
  state: PaymentState;
  failure: string;
  creditedAt?: string;
  refundedAt?: string;
  /** How many credits a refund actually reversed. See the note on refunds. */
  refundedCredits: number;
  /** The fee taken, at the rate in force when the payment was made. */
  feeCents: number;
  /**
   * What the ledger actually received, as against `credits`, which is what was
   * quoted. Zero until the payment is credited.
   */
  creditsGranted: number;
  createdAt: string;
  updatedAt: string;
};

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
  created_at: string;
  updated_at: string;
};

const PAYMENT_COLUMNS = `id, reference, user_id, method, provider, provider_ref, credits,
  amount_cents, currency, unit_price_cents, state, failure, credited_at, refunded_at,
  refunded_credits, fee_cents, credits_granted, created_at, updated_at`;

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
    credits: row.credits,
    amountCents: row.amount_cents,
    currency: row.currency,
    unitPriceCents: row.unit_price_cents,
    state: row.state as PaymentState,
    failure: row.failure ?? '',
    ...(row.credited_at ? { creditedAt: row.credited_at } : {}),
    ...(row.refunded_at ? { refundedAt: row.refunded_at } : {}),
    refundedCredits: row.refunded_credits ?? 0,
    feeCents: row.fee_cents ?? 0,
    creditsGranted: row.credits_granted ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type NewPayment = {
  userId: string;
  method: PaymentMethod;
  provider: PaymentProvider;
  credits: number;
  amountCents: number;
  currency: string;
  unitPriceCents: number;
  feeCents?: number;
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
      `INSERT INTO payments (id, reference, user_id, method, provider, credits, amount_cents,
                             currency, unit_price_cents, fee_cents, state, created_at, updated_at)
       VALUES (@id, @reference, @userId, @method, @provider, @credits, @amountCents,
               @currency, @unitPriceCents, @feeCents, 'pending', @createdAt, @createdAt)`
    ).run({
      id,
      reference,
      userId: input.userId,
      method: input.method,
      provider: input.provider,
      credits: input.credits,
      amountCents: input.amountCents,
      currency: input.currency,
      feeCents: input.feeCents ?? 0,
      unitPriceCents: input.unitPriceCents,
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

export function listPaymentsForUser(userId: string, limit = 50): Payment[] {
  const rows = getDb()
    .prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM payments
       WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(userId, limit) as PaymentRow[];
  return rows.map(toPayment);
}

/** Every payment, newest first. The administrator's reconciliation view. */
export function listAllPayments(limit = 200): Payment[] {
  const rows = getDb()
    .prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM payments ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(limit) as PaymentRow[];
  return rows.map(toPayment);
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
 * Marks a payment paid, and records what was credited for it.
 *
 * `grantedCredits` is written in the SAME conditional UPDATE, not a second
 * statement: the guard is `state = 'pending'`, so only the first caller moves
 * the row, and a granted count written separately could land against a row
 * somebody else had already settled.
 */
export function markPaid(paymentId: string, grantedCredits: number): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'paid', credited_at = @at, updated_at = @at, failure = '',
              credits_granted = @granted
       WHERE id = @id AND state = 'pending'`
    )
    .run({ id: paymentId, at: timestamp, granted: grantedCredits });
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
 * Records a refund, and how much of it the balance could actually give back.
 *
 * `reversedCredits` is not always `credits`. A balance may not go negative, so
 * refunding somebody who has already spent what they bought returns their money
 * and reverses only what is left. Storing the difference is the point: the
 * admin page has to be able to say "refunded 200 credits' worth, reversed 40",
 * because the alternative is a number that quietly does not add up.
 */
export function markRefunded(paymentId: string, reversedCredits: number): boolean {
  const timestamp = now();
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'refunded', refunded_at = @at, refunded_credits = @reversed,
                           updated_at = @at
       WHERE id = @id AND state = 'refunding'`
    )
    .run({ id: paymentId, reversed: Math.max(0, Math.trunc(reversedCredits)), at: timestamp });
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
 */
export function beginRefund(paymentId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE payments SET state = 'refunding', updated_at = @at
       WHERE id = @id AND state = 'paid'`
    )
    .run({ id: paymentId, at: now() });
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

import { randomUUID } from 'crypto';

import type { CreditReason, LedgerEntry, Reservation } from '../services/credits/types';
import { getDb } from './sqlite';

/**
 * The only module that writes to users.balance_milli.
 *
 * That exclusivity is the point, not a convention. The previous way to change a
 * balance was updateUser's `credits` branch, which did an absolute SET - so two
 * debits arriving together composed as "last one wins" and the first spend
 * vanished. Every write here is a conditional UPDATE inside one transaction, so
 * a balance can only move by an amount somebody actually had.
 *
 * EVERY AMOUNT IS AN INTEGER COUNT OF THOUSANDTHS OF A DOLLAR (utils/money.ts),
 * and nothing here rounds: a $0.023 charge takes 23, seven of them 161, and a
 * refund of two gives back 46. The whole-credit columns beside these (credits,
 * delta, units...) belong to the history from before credits became dollars;
 * every row written here puts 0 in them, so an older build rolled back to
 * reads nothing moving rather than a thousand times what did
 * (database/dollarSwitch.ts).
 */

type LedgerRow = {
  seq: number;
  id: string;
  user_id: string;
  delta: number;
  balance_after: number;
  delta_milli: number;
  balance_after_milli: number;
  reason: string;
  ref_kind: string;
  ref_id: string;
  actor_id: string | null;
  note: string;
  created_at: string;
};

type ReservationRow = {
  id: string;
  user_id: string;
  kind: string;
  units_milli: number;
  refunded_milli: number;
  state: string;
  label: string;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

/**
 * One row as the API reads it.
 *
 * A row from before credits became dollars carries its amount in whole credits
 * (`delta`) and nothing in dollars; it is shown as what it was, under
 * `legacyCredits`, never converted - a figure in credits multiplied into
 * dollars at some rate would be a history that never happened. Its dollar
 * fields read 0, which is true: no dollar moved.
 *
 * A `reset` row is in credits even when it moves none: the one written for an
 * account whose credits were all held by a run (database/dollarSwitch.ts) has
 * delta 0, and read by its delta alone it would show as a "+$0.000" movement
 * in dollars rather than as the end of the history in credits.
 */
function toEntry(row: LedgerRow): LedgerEntry {
  const legacy = row.delta !== 0 || row.reason === 'reset';
  return {
    seq: row.seq,
    id: row.id,
    userId: row.user_id,
    deltaMilli: row.delta_milli ?? 0,
    balanceAfterMilli: row.balance_after_milli ?? 0,
    legacyCredits: legacy ? { delta: row.delta, balanceAfter: row.balance_after } : null,
    reason: row.reason as CreditReason,
    refKind: row.ref_kind,
    refId: row.ref_id,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    note: row.note,
    createdAt: row.created_at,
  };
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    unitsMilli: row.units_milli,
    refundedMilli: row.refunded_milli,
    state: row.state === 'closed' ? 'closed' : 'open',
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type LedgerWrite = {
  userId: string;
  deltaMilli: number;
  balanceAfterMilli: number;
  reason: CreditReason;
  refKind?: string;
  refId?: string;
  actorId?: string;
  note?: string;
  idempotencyKey: string;
  /** When it happened, if not this instant: a job reward is stamped with its merge's moment. */
  createdAt?: string;
};

/**
 * Appends one ledger row. Must be called inside a transaction that has already
 * moved the balance, so `balanceAfter` is a measurement and not a prediction.
 */
function insertLedger(write: LedgerWrite): void {
  getDb()
    .prepare(
      `INSERT INTO credit_ledger
         (id, user_id, delta, balance_after, delta_milli, balance_after_milli, reason, ref_kind, ref_id,
          actor_id, note, idempotency_key, created_at)
       VALUES (@id, @userId, 0, 0, @deltaMilli, @balanceAfterMilli, @reason, @refKind, @refId, @actorId,
               @note, @idempotencyKey, @createdAt)`
    )
    .run({
      id: `led_${randomUUID()}`,
      userId: write.userId,
      deltaMilli: write.deltaMilli,
      balanceAfterMilli: write.balanceAfterMilli,
      reason: write.reason,
      refKind: write.refKind ?? '',
      refId: write.refId ?? '',
      actorId: write.actorId ?? null,
      note: write.note ?? '',
      idempotencyKey: write.idempotencyKey,
      createdAt: write.createdAt ?? now(),
    });
}

function readBalance(userId: string): number {
  const row = getDb().prepare('SELECT balance_milli FROM users WHERE id = ?').get(userId) as
    | { balance_milli: number }
    | undefined;
  return row?.balance_milli ?? 0;
}

function keyUsed(idempotencyKey: string): boolean {
  return Boolean(
    getDb().prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key = ?').get(idempotencyKey)
  );
}

/**
 * Whether money has already moved under this key - for a caller deciding
 * whether something is still refundable (a task whose `refund:task:<id>` was
 * written gave its charge back already). A read, not a claim: the write paths
 * above re-check it inside their own transaction.
 */
export function isLedgerKeyUsed(idempotencyKey: string): boolean {
  return keyUsed(idempotencyKey);
}

export type DebitOutcome = { ok: true; balance: number } | { ok: false; balance: number };

/**
 * Takes `amountMilli` and opens a reservation for it, or takes nothing.
 *
 * The conditional UPDATE is the entire concurrency argument: two submissions
 * racing for the last ten cents both run it, SQLite serializes them, and the
 * loser sees `changes === 0`. There is no read-then-write window to lose - and
 * because both sides are integers, `balance_milli >= amount` is exact: a
 * balance of exactly $0.161 buys a $0.161 run.
 *
 * `.immediate()` rather than a deferred transaction because the test harness
 * routinely holds a genuine second connection to the same file, and a deferred
 * transaction that upgrades to a write half way through can deadlock instead of
 * failing fast.
 */
export function debitAndReserve(input: {
  reservationId: string;
  userId: string;
  amountMilli: number;
  kind: string;
  label: string;
}): DebitOutcome {
  if (!Number.isSafeInteger(input.amountMilli) || input.amountMilli <= 0) {
    throw new Error(`A charge must be a positive whole number of thousandths of a dollar, not ${input.amountMilli}.`);
  }
  const db = getDb();
  const timestamp = now();

  return db.transaction((): DebitOutcome => {
    const changed = db
      .prepare(
        `UPDATE users SET balance_milli = balance_milli - @amount, updated_at = @timestamp
          WHERE id = @userId AND balance_milli >= @amount`
      )
      .run({ amount: input.amountMilli, userId: input.userId, timestamp }).changes;

    if (changed === 0) return { ok: false, balance: readBalance(input.userId) };

    const balance = readBalance(input.userId);
    db.prepare(
      `INSERT INTO credit_reservations
         (id, user_id, kind, units, refunded, units_milli, refunded_milli, state, label, created_at, updated_at)
       VALUES (@id, @userId, @kind, 0, 0, @amount, 0, 'open', @label, @timestamp, @timestamp)`
    ).run({
      id: input.reservationId,
      userId: input.userId,
      kind: input.kind,
      amount: input.amountMilli,
      label: input.label,
      timestamp,
    });

    insertLedger({
      userId: input.userId,
      deltaMilli: -input.amountMilli,
      balanceAfterMilli: balance,
      reason: 'generation-reserve',
      refKind: input.kind,
      refId: input.reservationId,
      note: input.label,
      idempotencyKey: `reserve:${input.reservationId}`,
    });

    return { ok: true, balance };
  }).immediate();
}

/**
 * Gives `amountMilli` back against an open reservation, once.
 *
 * Four gates, in order, inside one transaction:
 *   1. the reservation must exist and be open - an admin-exempt run, a batch
 *      from before credits existed, a run the dollar switch settled, or an
 *      already-closed run all no-op here (unless `includeClosed`, below);
 *   2. the idempotency key must be unused - this is what makes a hook that
 *      fires twice harmless;
 *   3. refunded + amount must not exceed what the run holds - a per-run
 *      ceiling in SQL that holds even for a caller that invented a fresh key;
 *   4. only then does the balance move, and the ledger row records the balance
 *      read back afterwards.
 *
 * Gate 1 is inside the transaction rather than before it, so "the reconciler
 * closed this" and "a late task is refunding into it" cannot both win.
 */
export function refundAgainstReservation(input: {
  reservationId: string;
  amountMilli: number;
  reason: CreditReason;
  idempotencyKey: string;
  note?: string;
  actorId?: string;
  /**
   * Refund into a CLOSED reservation too. Only for a refund an administrator
   * granted on a resume that was delivered - by then its run has usually
   * settled. Gate 1 is then "the reservation exists"; the cap in gate 3 still
   * holds, so the run can never give back more than it took, however its
   * automatic refunds and the granted ones mix.
   */
  includeClosed?: boolean;
  /** Refuse unless the reservation is this account's. */
  userId?: string;
}): { refunded: number } {
  if (!Number.isSafeInteger(input.amountMilli)) {
    throw new Error(`A refund must be a whole number of thousandths of a dollar, not ${input.amountMilli}.`);
  }
  if (input.amountMilli <= 0) return { refunded: 0 };
  const db = getDb();
  const timestamp = now();

  return db.transaction((): { refunded: number } => {
    const reservation = (
      input.includeClosed
        ? db.prepare('SELECT * FROM credit_reservations WHERE id = ?').get(input.reservationId)
        : db.prepare("SELECT * FROM credit_reservations WHERE id = ? AND state = 'open'").get(input.reservationId)
    ) as ReservationRow | undefined;
    if (!reservation) return { refunded: 0 };
    if (input.userId !== undefined && reservation.user_id !== input.userId) return { refunded: 0 };

    if (keyUsed(input.idempotencyKey)) return { refunded: 0 };

    const capped = db
      .prepare(
        `UPDATE credit_reservations SET refunded_milli = refunded_milli + @amount, updated_at = @timestamp
          WHERE id = @id AND refunded_milli + @amount <= units_milli`
      )
      .run({ id: input.reservationId, amount: input.amountMilli, timestamp }).changes;
    if (capped === 0) return { refunded: 0 };

    db.prepare(
      'UPDATE users SET balance_milli = balance_milli + @amount, updated_at = @timestamp WHERE id = @userId'
    ).run({
      amount: input.amountMilli,
      userId: reservation.user_id,
      timestamp,
    });

    insertLedger({
      userId: reservation.user_id,
      deltaMilli: input.amountMilli,
      balanceAfterMilli: readBalance(reservation.user_id),
      reason: input.reason,
      refKind: reservation.kind,
      refId: input.reservationId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      note: input.note ?? '',
      idempotencyKey: input.idempotencyKey,
    });

    return { refunded: input.amountMilli };
  }).immediate();
}

/**
 * Closes a reservation, refunding nothing.
 *
 * For a run that ACCOUNTED FOR ITSELF: the units that failed were refunded
 * explicitly, and everything not refunded delivered a resume, so its credit is
 * spent and stays spent.
 *
 * The distinction from `abandonReservation` below is the whole of the money
 * model, and getting it backwards makes every successful run free: "not
 * refunded" means DELIVERED here, and means UNACCOUNTED there. Which one
 * applies is known by the caller and cannot be inferred from the row.
 */
export function settleReservation(reservationId: string): boolean {
  const db = getDb();
  return db.transaction((): boolean => {
    const changed = db
      .prepare(
        "UPDATE credit_reservations SET state = 'closed', updated_at = ? WHERE id = ? AND state = 'open'"
      )
      .run(now(), reservationId).changes;
    return changed > 0;
  }).immediate();
}

/**
 * Refunds whatever is still outstanding and closes the reservation.
 *
 * For a run that did NOT get to account for itself - a handler that threw, a
 * submit that failed, or a process that died and left the row behind for the
 * boot reconciler. Everything not already refunded is presumed undelivered.
 *
 * Safe to call after `settleReservation`, and that composition is deliberate:
 * the handlers call it in a `finally`, where it is a no-op on the happy path
 * (already closed) and the full sweep on the throwing one.
 */
export function abandonReservation(input: {
  reservationId: string;
  reason: CreditReason;
  note?: string;
}): { refunded: number; closed: boolean } {
  const db = getDb();
  const timestamp = now();

  return db.transaction((): { refunded: number; closed: boolean } => {
    const reservation = db
      .prepare("SELECT * FROM credit_reservations WHERE id = ? AND state = 'open'")
      .get(input.reservationId) as ReservationRow | undefined;
    if (!reservation) return { refunded: 0, closed: false };

    const outstanding = reservation.units_milli - reservation.refunded_milli;
    const key = `release:${input.reservationId}`;

    if (outstanding > 0 && !keyUsed(key)) {
      db.prepare(
        'UPDATE credit_reservations SET refunded_milli = units_milli, updated_at = @timestamp WHERE id = @id'
      ).run({ id: input.reservationId, timestamp });
      db.prepare(
        'UPDATE users SET balance_milli = balance_milli + @amount, updated_at = @timestamp WHERE id = @userId'
      ).run({ amount: outstanding, userId: reservation.user_id, timestamp });
      insertLedger({
        userId: reservation.user_id,
        deltaMilli: outstanding,
        balanceAfterMilli: readBalance(reservation.user_id),
        reason: input.reason,
        refKind: reservation.kind,
        refId: input.reservationId,
        note: input.note ?? '',
        idempotencyKey: key,
      });
    }

    db.prepare(
      "UPDATE credit_reservations SET state = 'closed', updated_at = @timestamp WHERE id = @id"
    ).run({ id: input.reservationId, timestamp });

    return { refunded: outstanding > 0 ? outstanding : 0, closed: true };
  }).immediate();
}

/**
 * Moves a balance by an absolute amount, for an administrator.
 *
 * Separate from the reserve/refund path because a grant is not accounted
 * against a run: there is no reservation, and the idempotency key is the
 * caller's to choose.
 */
export function applyAdjustment(input: {
  userId: string;
  deltaMilli: number;
  reason: CreditReason;
  idempotencyKey: string;
  actorId?: string;
  note?: string;
}): { balance: number; applied: boolean } {
  const db = getDb();
  const timestamp = now();

  return db.transaction((): { balance: number; applied: boolean } => {
    // Refused rather than rounded: every caller hands over an exact count of
    // thousandths, and anything else is a bug that must not reach a balance.
    if (!Number.isSafeInteger(input.deltaMilli)) {
      throw new Error(`A credit adjustment must be a whole number of thousandths of a dollar, not ${input.deltaMilli}.`);
    }
    if (input.deltaMilli === 0) return { balance: readBalance(input.userId), applied: false };
    if (keyUsed(input.idempotencyKey)) return { balance: readBalance(input.userId), applied: false };

    // Clamped at zero rather than allowed negative: a negative balance would
    // read as a debt this app has no way to collect. A revoke of more than
    // somebody holds takes them to zero and the ledger records what actually
    // moved, not what was asked for.
    const before = readBalance(input.userId);
    const delta = input.deltaMilli < 0 ? -Math.min(before, -input.deltaMilli) : input.deltaMilli;
    if (delta === 0) return { balance: before, applied: false };

    db.prepare(
      'UPDATE users SET balance_milli = balance_milli + @delta, updated_at = @timestamp WHERE id = @userId'
    ).run({ delta, userId: input.userId, timestamp });

    const balance = readBalance(input.userId);
    insertLedger({
      userId: input.userId,
      deltaMilli: delta,
      balanceAfterMilli: balance,
      reason: input.reason,
      refKind: 'user',
      refId: input.userId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      note: input.note ?? '',
      idempotencyKey: input.idempotencyKey,
    });

    return { balance, applied: true };
  }).immediate();
}

export type PayoutOutcome =
  | { ok: true; applied: boolean; balance: number; entry: LedgerEntry | null }
  | { ok: false; reason: 'no-account' | 'not-a-reporter' | 'insufficient'; balance: number };

/**
 * Records a reporter's payout: takes `amountMilli` off the balance and writes
 * a `reporter-payout` row, or takes nothing.
 *
 * Unlike `applyAdjustment` it never clamps. A revoke of more than somebody
 * holds is an administrator taking back what was given, and stopping at zero
 * is right for it; a payout records money that left by hand, and a record
 * that says less left than did is a wrong record. So a payout the balance
 * cannot cover is refused outright.
 *
 * One conditional UPDATE decides all of it - the account is a reporter AND
 * holds at least the amount - so neither a role change nor a second payout
 * landing at the same moment can slip between a check and the debit. When it
 * changes nothing, a second read says which condition failed, for the
 * caller's sentence.
 *
 * Idempotent on `idempotencyKey`: a repeat answers `applied: false` with the
 * row the first one wrote, and moves nothing - so a double-pressed "Record
 * payout" that sends the same key twice records one payout.
 */
export function debitReporterPayout(input: {
  userId: string;
  amountMilli: number;
  idempotencyKey: string;
  refId: string;
  actorId: string;
  note: string;
}): PayoutOutcome {
  if (!Number.isSafeInteger(input.amountMilli) || input.amountMilli <= 0) {
    throw new Error(`A payout must be a positive whole number of thousandths of a dollar, not ${input.amountMilli}.`);
  }
  const db = getDb();
  const timestamp = now();
  const readEntry = (): LedgerEntry | null => {
    const row = db.prepare('SELECT * FROM credit_ledger WHERE idempotency_key = ?').get(input.idempotencyKey) as
      | LedgerRow
      | undefined;
    return row ? toEntry(row) : null;
  };

  return db.transaction((): PayoutOutcome => {
    if (keyUsed(input.idempotencyKey)) {
      return { ok: true, applied: false, balance: readBalance(input.userId), entry: readEntry() };
    }

    const changed = db
      .prepare(
        `UPDATE users SET balance_milli = balance_milli - @amount, updated_at = @timestamp
          WHERE id = @userId AND role = 'reporter' AND balance_milli >= @amount`
      )
      .run({ amount: input.amountMilli, userId: input.userId, timestamp }).changes;

    if (changed === 0) {
      const account = db.prepare('SELECT role, balance_milli FROM users WHERE id = ?').get(input.userId) as
        | { role: string; balance_milli: number }
        | undefined;
      if (!account) return { ok: false, reason: 'no-account', balance: 0 };
      return {
        ok: false,
        reason: account.role === 'reporter' ? 'insufficient' : 'not-a-reporter',
        balance: account.balance_milli,
      };
    }

    const balance = readBalance(input.userId);
    insertLedger({
      userId: input.userId,
      deltaMilli: -input.amountMilli,
      balanceAfterMilli: balance,
      reason: 'reporter-payout',
      refKind: 'payout',
      refId: input.refId,
      actorId: input.actorId,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    });
    return { ok: true, applied: true, balance, entry: readEntry() };
  }).immediate();
}

/* ------------------------------------------------------- job lake rewards */

export type JobRewardOutcome = {
  /** What was credited, in thousandths of a dollar: 0 when nothing was. */
  paidMilli: number;
  /** The balance afterwards (or as it stands, when nothing moved). */
  balance: number;
  /**
   * Why nothing - or less than the rate - was paid: the account is not a
   * reporter (an administrator reporting, a role changed meanwhile), the rate
   * in effect is $0.000, today's cap was reached, or this version was paid
   * already (the key is used).
   */
  short?: 'not-a-reporter' | 'zero-rate' | 'cap' | 'already-paid';
};

/** What one account has earned from the lake since `sinceIso`, in thousandths. Gross: a revoke does not free the cap. */
export function jobRewardsSince(userId: string, sinceIso: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(delta_milli), 0) AS earned FROM credit_ledger
        WHERE user_id = ? AND reason = 'job-report-reward' AND created_at >= ?`
    )
    .get(userId, sinceIso) as { earned: number };
  return row.earned;
}

/**
 * Pays a reporter for one job the lake accepted - for the CALLER's
 * transaction (jobLakeRepository's `mergeIntoLake`), so the lake row and its
 * reward commit together or not at all. Nested in that one it is a
 * savepoint; called alone it is its own IMMEDIATE transaction.
 *
 * Every condition is read inside the transaction: the account is a reporter
 * NOW (the UPDATE says so again), the key is unused, and what today's cap
 * leaves. A reward is cut to what the cap leaves rather than refused whole,
 * so the cap is reached exactly; nothing is written for $0 (a rate of
 * $0.000, a reached cap), because a ledger row that moves nothing explains
 * nothing.
 */
export function payJobReportReward(input: {
  userId: string;
  rateMilli: number;
  /** Null for no cap. */
  dailyCapMilli: number | null;
  /** The start of the day the cap counts, as an ISO time. */
  dayStartIso: string;
  /**
   * The moment of the merge it pays for, as the row's time: the cap counts
   * rows by it, so the day a reward is counted in is the day of its merge.
   */
  at?: string;
  idempotencyKey: string;
  refId: string;
  note: string;
}): JobRewardOutcome {
  if (!Number.isSafeInteger(input.rateMilli) || input.rateMilli < 0) {
    throw new Error(`A job reward must be a whole number of thousandths of a dollar, not ${input.rateMilli}.`);
  }
  const db = getDb();
  const timestamp = now();

  return db.transaction((): JobRewardOutcome => {
    if (keyUsed(input.idempotencyKey)) return { paidMilli: 0, balance: readBalance(input.userId), short: 'already-paid' };
    const account = db.prepare('SELECT role FROM users WHERE id = ?').get(input.userId) as { role: string } | undefined;
    if (!account || account.role !== 'reporter') {
      return { paidMilli: 0, balance: readBalance(input.userId), short: 'not-a-reporter' };
    }
    if (input.rateMilli === 0) return { paidMilli: 0, balance: readBalance(input.userId), short: 'zero-rate' };

    let amount = input.rateMilli;
    if (input.dailyCapMilli !== null) {
      const left = Math.max(0, input.dailyCapMilli - jobRewardsSince(input.userId, input.dayStartIso));
      if (left === 0) return { paidMilli: 0, balance: readBalance(input.userId), short: 'cap' };
      amount = Math.min(amount, left);
    }

    const changed = db
      .prepare(
        `UPDATE users SET balance_milli = balance_milli + @amount, updated_at = @timestamp
          WHERE id = @userId AND role = 'reporter'`
      )
      .run({ amount, userId: input.userId, timestamp }).changes;
    if (changed === 0) return { paidMilli: 0, balance: readBalance(input.userId), short: 'not-a-reporter' };

    const balance = readBalance(input.userId);
    insertLedger({
      userId: input.userId,
      deltaMilli: amount,
      balanceAfterMilli: balance,
      reason: 'job-report-reward',
      refKind: 'job-lake',
      refId: input.refId,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      ...(input.at ? { createdAt: input.at } : {}),
    });
    return { paidMilli: amount, balance, ...(amount < input.rateMilli ? { short: 'cap' as const } : {}) };
  }).immediate();
}

/**
 * Takes a job reward back, for an administrator - clamped at the balance,
 * like `applyAdjustment`'s revoke: a reporter whose earnings were already
 * paid out keeps $0, not a debt this app could never collect. Records what
 * actually moved, and nothing when nothing could. Once per key.
 */
export function revokeJobReportReward(input: {
  userId: string;
  amountMilli: number;
  idempotencyKey: string;
  refId: string;
  actorId: string;
  note: string;
}): { takenMilli: number; balance: number } {
  if (!Number.isSafeInteger(input.amountMilli) || input.amountMilli < 0) {
    throw new Error(`A revoke must be a whole number of thousandths of a dollar, not ${input.amountMilli}.`);
  }
  const db = getDb();
  const timestamp = now();
  return db.transaction((): { takenMilli: number; balance: number } => {
    const before = readBalance(input.userId);
    if (input.amountMilli === 0 || keyUsed(input.idempotencyKey)) return { takenMilli: 0, balance: before };
    const taken = Math.min(before, input.amountMilli);
    if (taken === 0) return { takenMilli: 0, balance: before };
    db.prepare(
      'UPDATE users SET balance_milli = balance_milli - @taken, updated_at = @timestamp WHERE id = @userId'
    ).run({ taken, userId: input.userId, timestamp });
    const balance = readBalance(input.userId);
    insertLedger({
      userId: input.userId,
      deltaMilli: -taken,
      balanceAfterMilli: balance,
      reason: 'job-report-reward-revoked',
      refKind: 'job-lake',
      refId: input.refId,
      actorId: input.actorId,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    });
    return { takenMilli: taken, balance };
  }).immediate();
}

/** An account's balance, in thousandths of a dollar - for a summary that says what somebody holds now. */
export function readBalanceMilli(userId: string): number {
  return readBalance(userId);
}

/* ----------------------------------------------------------------- reading */

export function getReservation(id: string): Reservation | null {
  const row = getDb().prepare('SELECT * FROM credit_reservations WHERE id = ?').get(id) as
    | ReservationRow
    | undefined;
  return row ? toReservation(row) : null;
}

/** Sum of what is still held against in-flight runs for one account, in thousandths of a dollar. */
export function heldForUser(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(units_milli - refunded_milli), 0) AS held
         FROM credit_reservations WHERE user_id = ? AND state = 'open'`
    )
    .get(userId) as { held: number };
  return row.held;
}

/**
 * A page of one account's movements, newest first.
 *
 * Ordered on `seq`, which is monotonic per row, so offset paging over it is
 * stable and needs no tiebreak - unlike the payments list, whose timestamp is
 * only second-resolution.
 *
 * The limit clamp stays where it is rather than moving to the route. It is a
 * second guard, and the thing it guards against - one request asking for every
 * row an account has ever moved - is not something a caller should be able to
 * do by getting the query string wrong.
 */
export function listLedger(userId: string, limit = 100, offset = 0): LedgerEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?')
    .all(userId, Math.max(1, Math.min(limit, 500)), Math.max(0, offset)) as LedgerRow[];
  return rows.map(toEntry);
}

/** How many movements that account has, so a page can say what it is hiding. */
export function countLedger(userId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total FROM credit_ledger WHERE user_id = ?')
    .get(userId) as { total: number };
  return row.total;
}

export function hasLedgerEntries(userId: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM credit_ledger WHERE user_id = ? LIMIT 1').get(userId));
}

/** Open reservations older than a cutoff. The boot reconciler's input. */
export function listOpenReservations(olderThan?: string): Reservation[] {
  const rows = olderThan
    ? (getDb()
        .prepare("SELECT * FROM credit_reservations WHERE state = 'open' AND created_at < ? ORDER BY created_at")
        .all(olderThan) as ReservationRow[])
    : (getDb()
        .prepare("SELECT * FROM credit_reservations WHERE state = 'open' ORDER BY created_at")
        .all() as ReservationRow[]);
  return rows.map(toReservation);
}

/**
 * Accounts whose cached balance disagrees with their ledger, in thousandths of
 * a dollar.
 *
 * The ledger is append-only and the column is a cache of its sum, so the two
 * agreeing is a standing invariant. Reported rather than silently repaired:
 * a disagreement means something wrote the column outside this module, and
 * quietly correcting it would hide that.
 *
 * In dollars only. Rows from before credits became dollars carry 0 in
 * delta_milli, and the dollar balance started from 0 at the switch, so the
 * history in credits takes no part in the sum - it adds up on its own, to the
 * zero the reset row leaves.
 */
export function findInconsistentBalances(): Array<{ userId: string; balanceMilli: number; ledgerSumMilli: number }> {
  const rows = getDb()
    .prepare(
      `SELECT u.id AS userId, u.balance_milli AS balanceMilli, COALESCE(SUM(l.delta_milli), 0) AS ledgerSumMilli
         FROM users u
         LEFT JOIN credit_ledger l ON l.user_id = u.id
        GROUP BY u.id
        HAVING u.balance_milli != COALESCE(SUM(l.delta_milli), 0)`
    )
    .all() as Array<{ userId: string; balanceMilli: number; ledgerSumMilli: number }>;
  return rows;
}

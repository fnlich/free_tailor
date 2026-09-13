import { randomUUID } from 'crypto';

import type { CreditReason, LedgerEntry, Reservation } from '../services/credits/types';
import { getDb } from './sqlite';

/**
 * The only module that writes to users.credits.
 *
 * That exclusivity is the point, not a convention. The previous way to change a
 * balance was updateUser's `credits` branch, which did an absolute SET - so two
 * debits arriving together composed as "last one wins" and the first spend
 * vanished. Every write here is a conditional UPDATE inside one transaction, so
 * a balance can only move by an amount somebody actually had.
 */

type LedgerRow = {
  seq: number;
  id: string;
  user_id: string;
  delta: number;
  balance_after: number;
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
  units: number;
  refunded: number;
  state: string;
  label: string;
  created_at: string;
  updated_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    seq: row.seq,
    id: row.id,
    userId: row.user_id,
    delta: row.delta,
    balanceAfter: row.balance_after,
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
    units: row.units,
    refunded: row.refunded,
    state: row.state === 'closed' ? 'closed' : 'open',
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type LedgerWrite = {
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: CreditReason;
  refKind?: string;
  refId?: string;
  actorId?: string;
  note?: string;
  idempotencyKey: string;
};

/**
 * Appends one ledger row. Must be called inside a transaction that has already
 * moved the balance, so `balanceAfter` is a measurement and not a prediction.
 */
function insertLedger(write: LedgerWrite): void {
  getDb()
    .prepare(
      `INSERT INTO credit_ledger
         (id, user_id, delta, balance_after, reason, ref_kind, ref_id, actor_id, note,
          idempotency_key, created_at)
       VALUES (@id, @userId, @delta, @balanceAfter, @reason, @refKind, @refId, @actorId, @note,
               @idempotencyKey, @createdAt)`
    )
    .run({
      id: `led_${randomUUID()}`,
      userId: write.userId,
      delta: write.delta,
      balanceAfter: write.balanceAfter,
      reason: write.reason,
      refKind: write.refKind ?? '',
      refId: write.refId ?? '',
      actorId: write.actorId ?? null,
      note: write.note ?? '',
      idempotencyKey: write.idempotencyKey,
      createdAt: now(),
    });
}

function readBalance(userId: string): number {
  const row = getDb().prepare('SELECT credits FROM users WHERE id = ?').get(userId) as
    | { credits: number }
    | undefined;
  return row?.credits ?? 0;
}

function keyUsed(idempotencyKey: string): boolean {
  return Boolean(
    getDb().prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key = ?').get(idempotencyKey)
  );
}

export type DebitOutcome = { ok: true; balance: number } | { ok: false; balance: number };

/**
 * Takes `units` credits and opens a reservation, or takes nothing.
 *
 * The conditional UPDATE is the entire concurrency argument: two submissions
 * racing for the last ten credits both run it, SQLite serializes them, and the
 * loser sees `changes === 0`. There is no read-then-write window to lose.
 *
 * `.immediate()` rather than a deferred transaction because the test harness
 * routinely holds a genuine second connection to the same file, and a deferred
 * transaction that upgrades to a write half way through can deadlock instead of
 * failing fast.
 */
export function debitAndReserve(input: {
  reservationId: string;
  userId: string;
  units: number;
  kind: string;
  label: string;
}): DebitOutcome {
  const db = getDb();
  const timestamp = now();

  return db.transaction((): DebitOutcome => {
    const changed = db
      .prepare(
        `UPDATE users SET credits = credits - @units, updated_at = @timestamp
          WHERE id = @userId AND credits >= @units`
      )
      .run({ units: input.units, userId: input.userId, timestamp }).changes;

    if (changed === 0) return { ok: false, balance: readBalance(input.userId) };

    const balance = readBalance(input.userId);
    db.prepare(
      `INSERT INTO credit_reservations
         (id, user_id, kind, units, refunded, state, label, created_at, updated_at)
       VALUES (@id, @userId, @kind, @units, 0, 'open', @label, @timestamp, @timestamp)`
    ).run({
      id: input.reservationId,
      userId: input.userId,
      kind: input.kind,
      units: input.units,
      label: input.label,
      timestamp,
    });

    insertLedger({
      userId: input.userId,
      delta: -input.units,
      balanceAfter: balance,
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
 * Gives `units` back against an open reservation, once.
 *
 * Four gates, in order, inside one transaction:
 *   1. the reservation must exist and be open - an admin-exempt run, a batch
 *      from before credits existed, or an already-closed run all no-op here;
 *   2. the idempotency key must be unused - this is what makes a hook that
 *      fires twice harmless;
 *   3. refunded + units must not exceed units - a per-run ceiling in SQL that
 *      holds even for a caller that invented a fresh key;
 *   4. only then does the balance move, and the ledger row records the balance
 *      read back afterwards.
 *
 * Gate 1 is inside the transaction rather than before it, so "the reconciler
 * closed this" and "a late task is refunding into it" cannot both win.
 */
export function refundAgainstReservation(input: {
  reservationId: string;
  units: number;
  reason: CreditReason;
  idempotencyKey: string;
  note?: string;
  actorId?: string;
}): { refunded: number } {
  if (input.units <= 0) return { refunded: 0 };
  const db = getDb();
  const timestamp = now();

  return db.transaction((): { refunded: number } => {
    const reservation = db
      .prepare("SELECT * FROM credit_reservations WHERE id = ? AND state = 'open'")
      .get(input.reservationId) as ReservationRow | undefined;
    if (!reservation) return { refunded: 0 };

    if (keyUsed(input.idempotencyKey)) return { refunded: 0 };

    const capped = db
      .prepare(
        `UPDATE credit_reservations SET refunded = refunded + @units, updated_at = @timestamp
          WHERE id = @id AND refunded + @units <= units`
      )
      .run({ id: input.reservationId, units: input.units, timestamp }).changes;
    if (capped === 0) return { refunded: 0 };

    db.prepare('UPDATE users SET credits = credits + @units, updated_at = @timestamp WHERE id = @userId').run({
      units: input.units,
      userId: reservation.user_id,
      timestamp,
    });

    insertLedger({
      userId: reservation.user_id,
      delta: input.units,
      balanceAfter: readBalance(reservation.user_id),
      reason: input.reason,
      refKind: reservation.kind,
      refId: input.reservationId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      note: input.note ?? '',
      idempotencyKey: input.idempotencyKey,
    });

    return { refunded: input.units };
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

    const outstanding = reservation.units - reservation.refunded;
    const key = `release:${input.reservationId}`;

    if (outstanding > 0 && !keyUsed(key)) {
      db.prepare(
        'UPDATE credit_reservations SET refunded = units, updated_at = @timestamp WHERE id = @id'
      ).run({ id: input.reservationId, timestamp });
      db.prepare(
        'UPDATE users SET credits = credits + @units, updated_at = @timestamp WHERE id = @userId'
      ).run({ units: outstanding, userId: reservation.user_id, timestamp });
      insertLedger({
        userId: reservation.user_id,
        delta: outstanding,
        balanceAfter: readBalance(reservation.user_id),
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
  delta: number;
  reason: CreditReason;
  idempotencyKey: string;
  actorId?: string;
  note?: string;
}): { balance: number; applied: boolean } {
  const db = getDb();
  const timestamp = now();

  return db.transaction((): { balance: number; applied: boolean } => {
    if (input.delta === 0) return { balance: readBalance(input.userId), applied: false };
    if (keyUsed(input.idempotencyKey)) return { balance: readBalance(input.userId), applied: false };

    // Clamped at zero rather than allowed negative: a negative balance would
    // read as a debt this app has no way to collect. A revoke of more than
    // somebody holds takes them to zero and the ledger records what actually
    // moved, not what was asked for.
    const before = readBalance(input.userId);
    const delta = input.delta < 0 ? -Math.min(before, -input.delta) : input.delta;
    if (delta === 0) return { balance: before, applied: false };

    db.prepare(
      'UPDATE users SET credits = credits + @delta, updated_at = @timestamp WHERE id = @userId'
    ).run({ delta, userId: input.userId, timestamp });

    const balance = readBalance(input.userId);
    insertLedger({
      userId: input.userId,
      delta,
      balanceAfter: balance,
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

/* ----------------------------------------------------------------- reading */

export function getReservation(id: string): Reservation | null {
  const row = getDb().prepare('SELECT * FROM credit_reservations WHERE id = ?').get(id) as
    | ReservationRow
    | undefined;
  return row ? toReservation(row) : null;
}

/** Sum of what is still held against in-flight runs for one account. */
export function heldForUser(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(units - refunded), 0) AS held
         FROM credit_reservations WHERE user_id = ? AND state = 'open'`
    )
    .get(userId) as { held: number };
  return row.held;
}

export function listLedger(userId: string, limit = 100): LedgerEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY seq DESC LIMIT ?')
    .all(userId, Math.max(1, Math.min(limit, 500))) as LedgerRow[];
  return rows.map(toEntry);
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
 * Accounts whose cached balance disagrees with their ledger.
 *
 * The ledger is append-only and the column is a cache of its sum, so the two
 * agreeing is a standing invariant. Reported rather than silently repaired:
 * a disagreement means something wrote the column outside this module, and
 * quietly correcting it would hide that.
 */
export function findInconsistentBalances(): Array<{ userId: string; balance: number; ledgerSum: number }> {
  const rows = getDb()
    .prepare(
      `SELECT u.id AS userId, u.credits AS balance, COALESCE(SUM(l.delta), 0) AS ledgerSum
         FROM users u
         LEFT JOIN credit_ledger l ON l.user_id = u.id
        GROUP BY u.id
        HAVING u.credits != COALESCE(SUM(l.delta), 0)`
    )
    .all() as Array<{ userId: string; balance: number; ledgerSum: number }>;
  return rows;
}

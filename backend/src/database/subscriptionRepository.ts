import { isAccountRole } from '../config/accountRoles';
import {
  DEFAULT_SUBSCRIPTION,
  isSubscriptionId,
  MAX_SUBSCRIPTION_PRICE_MILLI,
  type AccountSubscriptionId,
} from '../config/accountSubscriptions';
import type { LedgerEntry } from '../services/credits/types';
import type { BillingState } from '../services/subscriptions/billing';
import { debitSubscriptionCharge, type SubscriptionChargeOutcome } from './creditRepository';
import { getDb } from './sqlite';

/**
 * A tier paid for from the credit balance: the six `users.subscription_*`
 * columns (database/sqlite.ts says what each holds).
 *
 * The ONLY writer of those columns - bar `userRepository.updateUser`, which
 * clears them when an administrator sets a tier or moves the role away from
 * user (`BILLING_CLEARED_SQL`). Every change goes through `changeSubscription`:
 * ONE IMMEDIATE transaction that reads the row, lets the caller decide what
 * to do with it, takes the charge (a savepoint of
 * creditRepository.debitSubscriptionCharge) and writes the change -
 * conditional on the `subscription_paid_through` it read, so a change decided
 * on a period another writer has since renewed, ended or replaced moves
 * nothing. The decisions themselves - buy, move up, switch at renewal,
 * cancel, keep, renew or end - are services/subscriptions' (the
 * `mergeIntoLake(job, requestedBy, policy)` shape): this module knows SQL, not
 * subscriptions.
 *
 * Read by their own queries, never through `USER_COLUMNS`: the session reads
 * an account on every request, and an install whose ALTER failed must still
 * sign in.
 */

const BILLING_COLUMNS =
  'subscription_base, subscription_period_start, subscription_paid_through, ' +
  'subscription_period_price_milli, subscription_renews, subscription_next';

/** The SET clause that ends paid billing: every column NULL. */
export const BILLING_CLEARED_SQL =
  'subscription_base = NULL, subscription_period_start = NULL, subscription_paid_through = NULL, ' +
  'subscription_period_price_milli = NULL, subscription_renews = NULL, subscription_next = NULL';

type BillingColumnsRow = {
  subscription_base: unknown;
  subscription_period_start: unknown;
  subscription_paid_through: unknown;
  subscription_period_price_milli: unknown;
  subscription_renews: unknown;
  subscription_next: unknown;
};

/** What the rules read beside the six columns: the role, the tier in effect, and whether the account is disabled. */
type AccountStateColumns = { role: string; subscription: string; disabled: unknown };

type AccountBillingRow = BillingColumnsRow &
  AccountStateColumns & {
    id: string;
    email: string;
    balance_milli: unknown;
  };

/** An account's paid state, read inside a transaction: its role, tier and balance beside it. */
export type BillingRow = BillingState & { id: string; email: string; balanceMilli: number };

/** A paid tier as Admin -> Accounts and the override note read it. Null while the tier is not paid. */
export type SubscriptionBilling = {
  base: AccountSubscriptionId;
  periodStart: string;
  paidThrough: string;
  periodPriceMilli: number;
  renews: boolean;
  next: AccountSubscriptionId | null;
};

function tierOrNull(value: unknown): AccountSubscriptionId | null {
  return isSubscriptionId(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The columns as the rules read them. Lenient: a tier this build does not
 * know reads as none (the base then falls back to Default), a price that is
 * not a whole number of thousandths in range as $0 - which is worth no credit
 * on an upgrade, the safe direction - and only `subscription_renews = 1`
 * renews. While `paid_through` is NULL nothing else is read: a tier that is
 * not paid has no period.
 */
function toBillingState(row: BillingColumnsRow & AccountStateColumns): BillingState {
  const paidThrough = textOrNull(row.subscription_paid_through);
  const role = isAccountRole(row.role) ? row.role : 'user';
  const subscription = tierOrNull(row.subscription) ?? DEFAULT_SUBSCRIPTION;
  // users.disabled is 0 or 1; only 1 is disabled, as userRepository reads it.
  const disabled = row.disabled === 1;
  if (paidThrough === null) {
    return {
      role,
      disabled,
      subscription,
      base: null,
      periodStart: null,
      paidThrough: null,
      periodPriceMilli: 0,
      renews: false,
      next: null,
    };
  }
  const price = row.subscription_period_price_milli;
  return {
    role,
    disabled,
    subscription,
    base: tierOrNull(row.subscription_base),
    periodStart: textOrNull(row.subscription_period_start),
    paidThrough,
    periodPriceMilli:
      typeof price === 'number' && Number.isSafeInteger(price) && price >= 0 && price <= MAX_SUBSCRIPTION_PRICE_MILLI
        ? price
        : 0,
    renews: row.subscription_renews === 1,
    next: tierOrNull(row.subscription_next),
  };
}

function toBillingRow(row: AccountBillingRow): BillingRow {
  const balance = row.balance_milli;
  return {
    ...toBillingState(row),
    id: row.id,
    email: row.email,
    balanceMilli: typeof balance === 'number' && Number.isSafeInteger(balance) ? balance : 0,
  };
}

function toSubscriptionBilling(state: BillingState): SubscriptionBilling | null {
  if (state.paidThrough === null) return null;
  return {
    base: state.base ?? DEFAULT_SUBSCRIPTION,
    periodStart: state.periodStart ?? state.paidThrough,
    paidThrough: state.paidThrough,
    periodPriceMilli: state.periodPriceMilli,
    renews: state.renews,
    next: state.next,
  };
}

/** One account's role, tier, balance and paid state, or null when there is no such account. */
export function readBillingRow(userId: string): BillingRow | null {
  const row = getDb()
    .prepare(`SELECT id, email, role, subscription, disabled, balance_milli, ${BILLING_COLUMNS} FROM users WHERE id = ?`)
    .get(userId) as AccountBillingRow | undefined;
  return row ? toBillingRow(row) : null;
}

/** An account's paid tier, or null when its tier is not paid (or there is no such account). */
export function getSubscriptionBilling(userId: string): SubscriptionBilling | null {
  const row = readBillingRow(userId);
  return row ? toSubscriptionBilling(row) : null;
}

/** Every paid tier, by account id, for the accounts list: one query through the partial index, not one per row. */
export function listPaidSubscriptions(): Map<string, SubscriptionBilling> {
  const rows = getDb()
    .prepare(
      `SELECT id, role, subscription, disabled, ${BILLING_COLUMNS} FROM users
        WHERE subscription_paid_through IS NOT NULL`
    )
    .all() as Array<BillingColumnsRow & AccountStateColumns & { id: string }>;
  const paid = new Map<string, SubscriptionBilling>();
  for (const row of rows) {
    const billing = toSubscriptionBilling(toBillingState(row));
    if (billing) paid.set(row.id, billing);
  }
  return paid;
}

/**
 * The renewal sweep's query: paid tiers whose 30 days are up, the longest due
 * first, one page AFTER the last row of the page before - by `paid_through`,
 * then rowid, which idx_users_subscription_due holds in that order, so the
 * page is a range of the index with nothing to sort.
 *
 * Paged from where the last page ended rather than from the start: a due row
 * the sweep leaves as it is - held while its price cannot be read, or failed
 * - is still due, and re-reading from the start would put it, and every other
 * such row, in front of everything behind them each time; two hundred of them
 * would hide every other account due.
 */
export const DUE_SUBSCRIPTIONS_SQL =
  'SELECT rowid AS position, id, subscription_paid_through FROM users ' +
  'WHERE subscription_paid_through IS NOT NULL AND (subscription_paid_through, rowid) > (?, ?) ' +
  'AND subscription_paid_through <= ? ' +
  'ORDER BY subscription_paid_through, rowid LIMIT ?';

/** Where a page of due subscriptions ends: the next page starts after it. '' and 0 are before every row. */
export type DuePosition = { paidThrough: string; position: number };

export const FIRST_DUE_POSITION: DuePosition = { paidThrough: '', position: 0 };

/**
 * Up to `limit` accounts whose paid period ended at or before `nowIso`, after
 * `after`, each with the `paid_through` it was listed at and its place in the
 * order (to start the next page after).
 */
export function listDueSubscriptions(
  nowIso: string,
  limit = 200,
  after: DuePosition = FIRST_DUE_POSITION
): Array<{ id: string } & DuePosition> {
  const rows = getDb().prepare(DUE_SUBSCRIPTIONS_SQL).all(after.paidThrough, after.position, nowIso, limit) as Array<{
    position: number;
    id: string;
    subscription_paid_through: string;
  }>;
  return rows.map((row) => ({ id: row.id, paidThrough: row.subscription_paid_through, position: row.position }));
}

/** A paid period to write: the tier and its 30 days. */
export type BillingWrite = {
  subscription: AccountSubscriptionId;
  base: AccountSubscriptionId;
  periodStart: string;
  paidThrough: string;
  periodPriceMilli: number;
  renews: boolean;
  next: AccountSubscriptionId | null;
};

/** What a change takes from the balance, in the same transaction as the change. */
export type BillingCharge = {
  amountMilli: number;
  reason: 'subscription-purchase' | 'subscription-renewal';
  idempotencyKey: string;
  note: string;
};

/**
 * What the caller decided, from the row as it stands inside the transaction:
 * `none` (nothing to do - a repeat, or a row that moved on), `lapse` (the paid
 * tier ends: the account returns to its base and every column is cleared), or
 * a paid period to write. A `charge` of more than $0 is taken first, and a
 * balance that cannot cover it refuses the whole change - or, with
 * `lapseWhenShort` (a renewal), ends the paid tier instead.
 */
export type BillingChange = {
  charge?: BillingCharge;
  set: BillingWrite | 'lapse' | 'none';
  lapseWhenShort?: boolean;
};

export type ChangeOutcome =
  | {
      ok: true;
      /** Nothing; the change; the paid tier ended; or ended because the balance could not cover a renewal. */
      done: 'none' | 'set' | 'lapse' | 'lapse-short';
      /** The row as it was read, inside the transaction. */
      before: BillingRow;
      /** What was taken, in thousandths: 0 when nothing was. */
      chargedMilli: number;
      entry: LedgerEntry | null;
      /** The balance afterwards. */
      balanceMilli: number;
    }
  | {
      ok: false;
      reason: 'no-account' | Extract<SubscriptionChargeOutcome, { ok: false }>['reason'];
      before: BillingRow | null;
      /** What the change would have taken. */
      neededMilli: number;
      balanceMilli: number;
    };

/** The UPDATE did not find the row as it was read - which an IMMEDIATE transaction rules out, so it rolls back. */
function assertWritten(changes: number, userId: string): void {
  if (changes !== 1) {
    throw new Error(`The subscription of account ${userId} changed while it was being written; nothing was changed.`);
  }
}

/**
 * Reads an account's row, asks `decide` what to do with it, and does it, in
 * ONE IMMEDIATE transaction: the charge (if any) first, then the columns,
 * conditional on the `paid_through` read - so the charge and the tier it buys
 * commit together or not at all, and two changes racing for one account are
 * decided one after the other, each on the row the other left.
 *
 * `decide` may throw - a refusal for the caller to answer with - and then
 * nothing is written. A refused charge writes nothing either, unless the
 * change says `lapseWhenShort`.
 */
export function changeSubscription(userId: string, decide: (row: BillingRow) => BillingChange): ChangeOutcome {
  const db = getDb();
  return db
    .transaction((): ChangeOutcome => {
      const before = readBillingRow(userId);
      if (!before) return { ok: false, reason: 'no-account', before: null, neededMilli: 0, balanceMilli: 0 };

      const change = decide(before);
      if (change.set === 'none') {
        return { ok: true, done: 'none', before, chargedMilli: 0, entry: null, balanceMilli: before.balanceMilli };
      }

      const timestamp = new Date().toISOString();
      const lapse = (): void => {
        const changes = db
          .prepare(
            `UPDATE users SET subscription = @tier, ${BILLING_CLEARED_SQL}, updated_at = @at
              WHERE id = @id AND subscription_paid_through IS @read`
          )
          .run({ id: userId, tier: before.base ?? DEFAULT_SUBSCRIPTION, at: timestamp, read: before.paidThrough }).changes;
        assertWritten(changes, userId);
      };

      let entry: LedgerEntry | null = null;
      let chargedMilli = 0;
      let balanceMilli = before.balanceMilli;
      if (change.charge && change.charge.amountMilli > 0) {
        const debit = debitSubscriptionCharge({
          userId,
          amountMilli: change.charge.amountMilli,
          reason: change.charge.reason,
          idempotencyKey: change.charge.idempotencyKey,
          refId: `subscription:${userId}`,
          note: change.charge.note,
        });
        if (!debit.ok) {
          if (debit.reason === 'insufficient' && change.lapseWhenShort) {
            lapse();
            return { ok: true, done: 'lapse-short', before, chargedMilli: 0, entry: null, balanceMilli: debit.balance };
          }
          return {
            ok: false,
            reason: debit.reason,
            before,
            neededMilli: change.charge.amountMilli,
            balanceMilli: debit.balance,
          };
        }
        entry = debit.entry;
        chargedMilli = change.charge.amountMilli;
        balanceMilli = debit.balance;
      }

      if (change.set === 'lapse') {
        lapse();
        return { ok: true, done: 'lapse', before, chargedMilli, entry, balanceMilli };
      }

      const set = change.set;
      const changes = db
        .prepare(
          `UPDATE users SET subscription = @subscription, subscription_base = @base,
                  subscription_period_start = @start, subscription_paid_through = @end,
                  subscription_period_price_milli = @price, subscription_renews = @renews,
                  subscription_next = @next, updated_at = @at
            WHERE id = @id AND subscription_paid_through IS @read`
        )
        .run({
          id: userId,
          subscription: set.subscription,
          base: set.base,
          start: set.periodStart,
          end: set.paidThrough,
          price: set.periodPriceMilli,
          renews: set.renews ? 1 : 0,
          next: set.next,
          at: timestamp,
          read: before.paidThrough,
        }).changes;
      assertWritten(changes, userId);
      return { ok: true, done: 'set', before, chargedMilli, entry, balanceMilli };
    })
    .immediate();
}

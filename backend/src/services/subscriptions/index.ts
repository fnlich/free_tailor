import {
  isPaidSubscriptionId,
  isSubscriptionId,
  listSubscriptions,
  SUBSCRIPTION_PERIOD_DAYS,
  SUBSCRIPTION_PRICE_FIELDS,
  SUBSCRIPTIONS,
  type AccountSubscription,
  type AccountSubscriptionId,
  type PaidSubscriptionId,
  type SubscriptionPrices,
} from '../../config/accountSubscriptions';
import {
  getSubscriptionPriceReading,
  getSubscriptionPrices,
  type SubscriptionPriceReading,
  type UnreadableSubscriptionPrice,
} from '../../config/aiModelConfig';
import { getDb } from '../../database/sqlite';
import {
  changeSubscription,
  FIRST_DUE_POSITION,
  getSubscriptionBilling,
  listDueSubscriptions,
  readBillingRow,
  type BillingChange,
  type BillingRow,
  type BillingWrite,
  type ChangeOutcome,
  type DuePosition,
  type SubscriptionBilling,
} from '../../database/subscriptionRepository';
import { getUserById, updateUser } from '../../database/userRepository';
import { RoleNotAllowedError } from '../../middleware/auth';
import type { AccountUpdate, UserAccount } from '../../types/account';
import { describeDollarProblem, formatMoney, parseDollars } from '../../utils/money';
import { isExempt } from '../credits';
import {
  addPeriod,
  chargeNowMilli,
  daysLeft,
  isPaid,
  lapsesTo,
  offerFor,
  priceOf,
  renewalDecision,
  renewalPeriod,
  unusedCreditMilli,
  type Offer,
  type RenewalDecision,
  type TierOffer,
} from './billing';
import { SubscriptionRefusal, SubscriptionShortError } from './errors';
import { isoDay, lapsedNotice, overrideNotice, renewedNotice, sendSubscriptionNotice } from './notices';

/**
 * Self-serve subscriptions, paid from the credit balance (owner decisions,
 * 2026-10-19): an account buys a paid tier for 30 days, moves up at once for
 * the new price less the unused days, moves down or cancels at the end of the
 * period, and is renewed from its balance by the sweep (./renewal.ts) at the
 * price in effect that day - or returned to its base, with a notice, when it
 * cancelled, the tier is no longer offered, or the balance is short.
 *
 * The tier in effect stays `users.subscription`, which every gate reads
 * (`hasSubscription`, `assertCanAddProfile`...); the paid period is beside it
 * (database/subscriptionRepository.ts). Every change is ONE transaction there,
 * deciding on the row as it stands inside it, and every charge is ONE
 * conditional debit with a unique ledger key - so two presses, two tabs, a
 * sweep run twice or a restart charge once.
 *
 * Nobody is charged an amount they were not shown: a purchase carries the
 * amount the page showed (`chargeUsd`), and the server works it out again
 * inside the transaction - a different figure is refused (409
 * `charge-changed`, with the figure in effect now).
 *
 * Administrators are exempt: they have every tier's features (`hasSubscription`)
 * and are never charged, so nothing here sells them anything. A reporter
 * cannot reach any of it (routes/subscription.ts is behind `requireUser`).
 *
 * A MONEY MODULE (test/money.test.js): amounts are integer thousandths.
 */

/** The clock every decision here reads - the routes and the sweep alike. Tests move it. */
let clock: () => number = () => Date.now();

/** Moves the clock for a test (a function of no arguments answering ms); no argument puts the real one back. */
export function setSubscriptionClockForTests(next?: () => number): void {
  clock = next ?? (() => Date.now());
}

/** Where the tier in effect came from: Default, an administrator, a purchase - or nowhere, for an administrator. */
export type SubscriptionSource = 'default' | 'admin' | 'paid' | 'exempt';

export type SubscriptionTierView = AccountSubscription &
  TierOffer & {
    /** What it costs for 30 days, in thousandths: 0 for Default; null for a paid tier nobody priced (not offered). */
    priceMilli: number | null;
  };

/** `GET /api/subscription`: the account's subscription, every tier's offer, and the balance it is paid from. */
export type SubscriptionView = {
  /** The tier in effect. */
  subscription: AccountSubscriptionId;
  source: SubscriptionSource;
  /** What a paid tier returns to when it ends; the tier in effect while it is not paid. */
  base: AccountSubscriptionId;
  paid: null | {
    /** When the current 30 days began. */
    since: string;
    /** When they end: it renews then, or ends then. */
    paidThrough: string;
    renews: boolean;
    /** A lower tier chosen for the next 30 days. */
    next: AccountSubscriptionId | null;
    /** The 30 days are up and the sweep has not been round yet: renewing now. */
    due: boolean;
    /** What the renewal will take at today's price, in thousandths; null when it will end instead. */
    renewalPriceMilli: number | null;
    /** How much the balance is short of that renewal now; 0 when it covers it. */
    renewalShortMilli: number;
  };
  /** Every tier, in catalogue order, with what its card offers. */
  tiers: SubscriptionTierView[];
  balanceMilli: number;
  periodDays: number;
};

/** A change's answer: the view as it stands afterwards. `changed: false` is a repeat that moved nothing. */
export type SubscriptionChangeResult = SubscriptionView & { changed: boolean; chargedMilli?: number };

function label(tier: AccountSubscriptionId): string {
  return SUBSCRIPTIONS[tier].label;
}

function order(tier: AccountSubscriptionId): number {
  return SUBSCRIPTIONS[tier].order;
}

function sourceOf(row: BillingRow): SubscriptionSource {
  if (isExempt(row)) return 'exempt';
  if (isPaid(row)) return 'paid';
  return row.subscription === 'default' ? 'default' : 'admin';
}

function viewOf(row: BillingRow, prices: SubscriptionPrices, nowMs: number): SubscriptionView {
  let paid: SubscriptionView['paid'] = null;
  if (row.paidThrough !== null) {
    const renewingAs = row.next ?? row.subscription;
    const renewalPriceMilli = row.role === 'user' && row.renews ? priceOf(renewingAs, prices) : null;
    paid = {
      since: row.periodStart ?? row.paidThrough,
      paidThrough: row.paidThrough,
      renews: row.renews,
      next: row.next,
      due: Date.parse(row.paidThrough) <= nowMs,
      renewalPriceMilli,
      renewalShortMilli: renewalPriceMilli === null ? 0 : Math.max(0, renewalPriceMilli - row.balanceMilli),
    };
  }
  return {
    subscription: row.subscription,
    source: sourceOf(row),
    base: isPaid(row) ? lapsesTo(row) : row.subscription,
    paid,
    tiers: listSubscriptions().map((tier) => ({
      ...tier,
      priceMilli: priceOf(tier.id, prices),
      ...offerFor(tier.id, row, prices, nowMs),
    })),
    balanceMilli: row.balanceMilli,
    periodDays: SUBSCRIPTION_PERIOD_DAYS,
  };
}

function freshRow(accountId: string): BillingRow {
  const row = readBillingRow(accountId);
  // The account was deleted while the request ran: a generic failure, with a ref.
  if (!row) throw new Error(`Account ${accountId} is gone.`);
  return row;
}

/** What `GET /api/subscription` answers for the signed-in account. */
export async function describeSubscription(account: Pick<UserAccount, 'id'>): Promise<SubscriptionView> {
  const prices = await getSubscriptionPrices();
  return viewOf(freshRow(account.id), prices, clock());
}

/* ------------------------------------------------------------ refusals */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A paid tier named in a body, or 400 `bad-subscription`: Default is not bought, it is what is left. */
function readPaidTier(value: unknown): PaidSubscriptionId {
  if (isPaidSubscriptionId(value)) return value;
  throw new SubscriptionRefusal(
    'bad-subscription',
    400,
    "That is not one of this installation's paid subscriptions."
  );
}

const ADMIN_EXEMPT =
  "Administrators have every subscription's features and are never charged, so there is nothing to buy.";

function refuseExempt(account: Pick<UserAccount, 'role'>): void {
  if (isExempt(account)) throw new SubscriptionRefusal('admin-exempt', 409, ADMIN_EXEMPT);
}

/**
 * A request let in before an administrator disabled the account. Every later
 * one is refused at sign-in (`resolveSession`); this one changes nothing.
 */
function accountDisabled(): SubscriptionRefusal {
  return new SubscriptionRefusal(
    'account-disabled',
    403,
    'Your account has been disabled, so its subscription cannot be changed. ' +
      'Ask an administrator of this installation to re-enable it.'
  );
}

/**
 * Inside the transaction, on the row as it stands: the role may have changed
 * since the request was let in, or the account been disabled.
 */
function refuseUnlessUser(row: BillingRow): void {
  if (row.role === 'admin') throw new SubscriptionRefusal('admin-exempt', 409, ADMIN_EXEMPT);
  if (row.role !== 'user') throw new RoleNotAllowedError();
  if (row.disabled) throw accountDisabled();
}

function refuseUnpaid(row: BillingRow): void {
  if (isPaid(row)) return;
  throw new SubscriptionRefusal(
    'not-subscribed',
    409,
    row.subscription === 'default'
      ? 'You have no paid subscription to change.'
      : 'Your subscription was set by an administrator, so it does not renew and there is nothing to change here. ' +
          'Ask your administrator to change it.'
  );
}

function notOffered(tier: AccountSubscriptionId): SubscriptionRefusal {
  return new SubscriptionRefusal(
    'not-offered',
    409,
    `${label(tier)} is not offered on this installation. Ask your administrator if you need it.`
  );
}

/** The amount the page showed, in dollars as typed: required, and read exactly. */
function readAgreedCharge(value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new SubscriptionRefusal('charge-required', 400, 'Say what you agreed to pay, in dollars, as chargeUsd.');
  }
  const parsed = parseDollars(value);
  if (!parsed.ok) {
    throw new SubscriptionRefusal('bad-charge', 400, describeDollarProblem(parsed.problem, 'The amount you agreed to pay'));
  }
  return parsed.milli;
}

/** A change the repository could not make: a short balance is the account's to fix; anything else is ours. */
function refusalOf(outcome: Extract<ChangeOutcome, { ok: false }>, tier: AccountSubscriptionId): Error {
  if (outcome.reason === 'insufficient') {
    return new SubscriptionShortError(label(tier), outcome.neededMilli, outcome.balanceMilli);
  }
  if (outcome.reason === 'not-a-user') return new RoleNotAllowedError();
  if (outcome.reason === 'disabled') return accountDisabled();
  return new Error(`The subscription change for this account was not made (${outcome.reason}).`);
}

/* ------------------------------------------------------------- changes */

/** The paid period a row holds, to write back with one thing changed. */
function keptPeriod(row: BillingRow): BillingWrite {
  return {
    subscription: row.subscription,
    base: lapsesTo(row),
    periodStart: row.periodStart ?? (row.paidThrough as string),
    paidThrough: row.paidThrough as string,
    periodPriceMilli: row.periodPriceMilli,
    renews: row.renews,
    next: row.next,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The ledger row's note: what was bought, to when, and what the unused days took off. */
function purchaseNote(
  tier: AccountSubscriptionId,
  until: string,
  priceMilli: number,
  credit: { creditMilli: number; daysLeft: number; from: AccountSubscriptionId } | null
): string {
  const lead = `${label(tier)} for ${SUBSCRIPTION_PERIOD_DAYS} days, to ${isoDay(until)}`;
  if (!credit || credit.creditMilli <= 0) return lead;
  return (
    `${lead}: ${formatMoney(priceMilli)} less ${formatMoney(credit.creditMilli)} for ` +
    `${plural(credit.daysLeft, 'unused day')} of ${label(credit.from)}`
  );
}

/**
 * `POST /subscribe { subscription, chargeUsd }`: buys a paid tier, or moves up
 * to one now. From Default, or a tier an administrator set, it is the full
 * price, and that tier becomes the base it returns to; from a paid tier it is
 * the new price less what its unused days are worth, and the 30 days start
 * again. `chargeUsd` is what the page showed: worked out again here, inside
 * the transaction, and refused with the figure in effect when it differs.
 */
export async function subscribe(account: UserAccount, body: unknown): Promise<SubscriptionChangeResult> {
  const input = asRecord(body);
  const target = readPaidTier(input.subscription);
  refuseExempt(account);
  const agreedMilli = readAgreedCharge(input.chargeUsd);
  const prices = await getSubscriptionPrices();
  const nowMs = clock();
  const nowIso = new Date(nowMs).toISOString();

  const outcome = changeSubscription(account.id, (row): BillingChange => {
    refuseUnlessUser(row);
    if (order(target) <= order(row.subscription)) {
      throw new SubscriptionRefusal(
        'not-an-upgrade',
        409,
        target === row.subscription
          ? `Your account is already on ${label(target)}.`
          : `${label(target)} is below your ${label(row.subscription)} subscription. ` +
              (isPaid(row) ? 'To move down, choose Switch at renewal.' : 'Yours includes it.')
      );
    }
    const price = prices[target];
    if (price === null) throw notOffered(target);
    const due = chargeNowMilli(row, price, nowMs);
    if (due.chargeMilli !== agreedMilli) {
      throw new SubscriptionRefusal(
        'charge-changed',
        409,
        `This change costs ${formatMoney(due.chargeMilli)} now, not the ${formatMoney(agreedMilli)} you were shown: ` +
          'the price or the days left have changed since. Check the new amount and confirm again.',
        { chargeMilli: due.chargeMilli }
      );
    }
    const paidThrough = addPeriod(nowIso);
    const credit = isPaid(row) ? { ...due, from: row.subscription } : null;
    return {
      ...(due.chargeMilli > 0
        ? {
            charge: {
              amountMilli: due.chargeMilli,
              reason: 'subscription-purchase' as const,
              idempotencyKey: `subscription:${row.id}:${target}:${nowIso}`,
              note: purchaseNote(target, paidThrough, price, credit),
            },
          }
        : {}),
      set: {
        subscription: target,
        // The tier it held when it first paid: kept through every upgrade.
        base: isPaid(row) ? lapsesTo(row) : row.subscription,
        periodStart: nowIso,
        paidThrough,
        periodPriceMilli: price,
        renews: true,
        next: null,
      },
    };
  });
  if (!outcome.ok) throw refusalOf(outcome, target);
  return { ...viewOf(freshRow(account.id), prices, clock()), changed: true, chargedMilli: outcome.chargedMilli };
}

/**
 * `POST /downgrade { subscription }`: a lower paid tier for the next 30 days,
 * taken at renewal at its price then - above the base, since cancelling
 * returns there anyway. Keeps a cancelled tier renewing, as that tier.
 */
export async function downgrade(account: UserAccount, body: unknown): Promise<SubscriptionChangeResult> {
  const target = readPaidTier(asRecord(body).subscription);
  refuseExempt(account);
  const prices = await getSubscriptionPrices();
  const outcome = changeSubscription(account.id, (row): BillingChange => {
    refuseUnlessUser(row);
    refuseUnpaid(row);
    if (order(target) >= order(row.subscription)) {
      throw new SubscriptionRefusal(
        'not-a-downgrade',
        409,
        `${label(target)} is not below your ${label(row.subscription)} subscription.`
      );
    }
    if (order(target) <= order(lapsesTo(row))) {
      throw new SubscriptionRefusal(
        'not-a-downgrade',
        409,
        `Cancelling already returns you to ${label(lapsesTo(row))}; choose Cancel subscription instead.`
      );
    }
    if (prices[target] === null) throw notOffered(target);
    if (row.renews && row.next === target) return { set: 'none' };
    return { set: { ...keptPeriod(row), renews: true, next: target } };
  });
  if (!outcome.ok) throw refusalOf(outcome, target);
  return { ...viewOf(freshRow(account.id), prices, clock()), changed: outcome.done !== 'none' };
}

/** `POST /cancel`: the paid tier ends at the end of its 30 days instead of renewing. Nothing is refunded. */
export async function cancelSubscription(account: UserAccount): Promise<SubscriptionChangeResult> {
  refuseExempt(account);
  const prices = await getSubscriptionPrices();
  const outcome = changeSubscription(account.id, (row): BillingChange => {
    refuseUnlessUser(row);
    refuseUnpaid(row);
    if (!row.renews && row.next === null) return { set: 'none' };
    return { set: { ...keptPeriod(row), renews: false, next: null } };
  });
  if (!outcome.ok) throw refusalOf(outcome, account.subscription);
  return { ...viewOf(freshRow(account.id), prices, clock()), changed: outcome.done !== 'none' };
}

/** `POST /resume`: undoes a cancel, or a pending switch - the tier paid for renews as itself. */
export async function resumeSubscription(account: UserAccount): Promise<SubscriptionChangeResult> {
  refuseExempt(account);
  const prices = await getSubscriptionPrices();
  const outcome = changeSubscription(account.id, (row): BillingChange => {
    refuseUnlessUser(row);
    refuseUnpaid(row);
    if (row.renews && row.next === null) return { set: 'none' };
    if (priceOf(row.subscription, prices) === null) throw notOffered(row.subscription);
    return { set: { ...keptPeriod(row), renews: true, next: null } };
  });
  if (!outcome.ok) throw refusalOf(outcome, account.subscription);
  return { ...viewOf(freshRow(account.id), prices, clock()), changed: outcome.done !== 'none' };
}

/* -------------------------------------------------------------- renewal */

export type RenewalReport = {
  renewed: number;
  /** Ended: cancelled, the account disabled, not offered any more, not a user, or the balance short. */
  lapsed: number;
  /**
   * Due, and neither renewed nor ended: the price of the tier it renews as
   * cannot be read (`renewalDecision`'s hold). It keeps its features, and is
   * looked at again every pass.
   */
  held: number;
  /** Listed as due, and found moved on, or failed (logged): tried again next pass. */
  skipped: number;
  /** The prices could not be read, so nobody was looked at. */
  stopped: boolean;
};

export type RenewOutcome = 'renewed' | 'lapsed' | 'held' | 'skipped';

const warnedRenewals = new Set<string>();

/**
 * Renews, or ends, ONE account's paid tier whose 30 days ended at
 * `expectedEnd`, in one transaction - or does nothing when its row has moved
 * on since it was listed (renewed, changed, ended), or when the price of the
 * tier it renews as is among `unreadable` (held). The notice follows the
 * commit.
 */
export function renewOrLapse(
  accountId: string,
  expectedEnd: string,
  prices: SubscriptionPrices,
  nowIso: string,
  unreadable: readonly PaidSubscriptionId[] = []
): RenewOutcome {
  // What was decided inside the transaction, for the notice after it.
  const decided: { decision: RenewalDecision | null } = { decision: null };
  const outcome = changeSubscription(accountId, (row): BillingChange => {
    if (row.paidThrough !== expectedEnd) return { set: 'none' };
    const decision = renewalDecision(row, prices, unreadable);
    decided.decision = decision;
    if (decision.kind === 'hold') return { set: 'none' };
    if (decision.kind === 'lapse') return { set: 'lapse' };
    const period = renewalPeriod(expectedEnd, nowIso);
    return {
      ...(decision.priceMilli > 0
        ? {
            charge: {
              amountMilli: decision.priceMilli,
              reason: 'subscription-renewal' as const,
              idempotencyKey: `subscription-renewal:${row.id}:${expectedEnd}`,
              note: `${label(decision.tier)} for ${SUBSCRIPTION_PERIOD_DAYS} days, to ${isoDay(period.end)}`,
            },
          }
        : {}),
      set: {
        subscription: decision.tier,
        base: lapsesTo(row),
        periodStart: period.start,
        paidThrough: period.end,
        periodPriceMilli: decision.priceMilli,
        renews: true,
        next: null,
      },
      lapseWhenShort: true,
    };
  });

  if (!outcome.ok) {
    // `already-charged`: this period's renewal is in the ledger, yet the row
    // is back at its end - edited by hand. Left alone rather than charged
    // twice or given away, and said once.
    const key = `${accountId}:${expectedEnd}:${outcome.reason}`;
    if (!warnedRenewals.has(key)) {
      warnedRenewals.add(key);
      console.warn(
        `[subscriptions] Account ${accountId}'s subscription due at ${expectedEnd} was not renewed or ended ` +
          `(${outcome.reason}); it is tried again at the next pass.`
      );
    }
    return 'skipped';
  }
  if (outcome.done === 'none') return decided.decision?.kind === 'hold' ? 'held' : 'skipped';

  const { decision } = decided;
  const row = outcome.before;
  if (outcome.done === 'set' && decision?.kind === 'renew') {
    const after = readBillingRow(accountId);
    sendSubscriptionNotice(
      renewedNotice({
        recipientId: accountId,
        from: row.subscription,
        to: decision.tier,
        chargedMilli: outcome.chargedMilli,
        balanceMilli: outcome.balanceMilli,
        paidThrough: after?.paidThrough ?? expectedEnd,
      })
    );
    return 'renewed';
  }
  sendSubscriptionNotice(
    lapsedNotice({
      recipientId: accountId,
      role: row.role,
      tier: row.subscription,
      renewingAs: row.next ?? row.subscription,
      returnedTo: lapsesTo(row),
      reason: outcome.done === 'lapse-short' ? 'insufficient' : decision?.kind === 'lapse' ? decision.reason : 'cancelled',
      endedAt: expectedEnd,
      ...(outcome.done === 'lapse-short' && decision?.kind === 'renew'
        ? { priceMilli: decision.priceMilli, balanceMilli: outcome.balanceMilli }
        : {}),
    })
  );
  return 'lapsed';
}

/** 200 accounts a page, 200 pages: 40,000 - a bound on one pass, not a working limit. */
const SWEEP_PAGE_SIZE = 200;
const MAX_SWEEP_PAGES = 200;

/** The log line for a pass that held subscriptions because a price could not be read. */
function describeHeldRenewals(held: number, unreadable: readonly UnreadableSubscriptionPrice[]): string {
  const where = unreadable
    .map((price) =>
      price.source === 'env'
        ? `${label(price.tier)}: ${SUBSCRIPTION_PRICE_FIELDS[price.tier].env} in .env`
        : `${label(price.tier)}: the price stored under Admin -> Settings -> General`
    )
    .join('; ');
  const one = unreadable.length === 1;
  return (
    `[subscriptions] ${held} subscription(s) due were neither renewed nor ended, because ` +
    `${one ? 'a price cannot' : 'prices cannot'} be read (${where}). Reading ${one ? 'it' : 'them'} as ` +
    '"not offered" would end them, so they keep their features until it is corrected - in .env, then a ' +
    'restart, or by saving the price under Admin -> Settings -> General - and the next pass renews them.'
  );
}

/**
 * One pass of the renewal sweep: every paid tier whose 30 days are up,
 * renewed or ended, one transaction each. The prices are read ONCE, first -
 * and a read that fails ends the pass touching nobody: a settings failure must
 * never read as "not offered" and end everybody's subscription. Nor must a
 * price that is set and cannot be read (a typo in .env): the subscriptions
 * renewing as that tier are HELD - neither renewed nor ended - and said so,
 * while every other one is renewed or ended as usual.
 *
 * Paged through the due accounts in their order, each page starting after the
 * last (`listDueSubscriptions`): a row renewed or ended drops out of the due
 * set, and one held or failed this pass is left behind, to be looked at again
 * at the next.
 */
export async function renewDueSubscriptions(nowIso?: string): Promise<RenewalReport> {
  const now = nowIso ?? new Date(clock()).toISOString();
  const report: RenewalReport = { renewed: 0, lapsed: 0, held: 0, skipped: 0, stopped: false };
  let reading: SubscriptionPriceReading;
  try {
    reading = await getSubscriptionPriceReading();
  } catch (error) {
    console.warn(
      '[subscriptions] Could not read the subscription prices, so no subscription was renewed or ended; ' +
        'the next pass tries again.',
      error
    );
    return { ...report, stopped: true };
  }
  const { prices } = reading;
  const unreadable = reading.unreadable.map((price) => price.tier);

  let after: DuePosition = FIRST_DUE_POSITION;
  for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
    const due = listDueSubscriptions(now, SWEEP_PAGE_SIZE, after);
    for (const entry of due) {
      try {
        report[renewOrLapse(entry.id, entry.paidThrough, prices, now, unreadable)] += 1;
      } catch (error) {
        report.skipped += 1;
        console.warn(`[subscriptions] Could not renew account ${entry.id}'s subscription; the next pass tries again.`, error);
      }
    }
    if (due.length < SWEEP_PAGE_SIZE) break;
    const last = due[due.length - 1];
    after = { paidThrough: last.paidThrough, position: last.position };
    // Let a request in between pages: one pass can be long on a large install.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (report.held > 0) console.warn(describeHeldRenewals(report.held, reading.unreadable));
  return report;
}

/* ------------------------------------------------- administrator override */

/** What an administrator's change on Admin -> Accounts did, read in the transaction that made it. */
export type AdministratorChange = {
  /** The account just before the change. */
  before: UserAccount;
  /** The account as the change left it. */
  account: UserAccount;
  /** Its paid period just before the change, and just after: null while its tier is not paid. */
  billingBefore: SubscriptionBilling | null;
  billingAfter: SubscriptionBilling | null;
};

let warnedBillingRead = false;

/**
 * The paid period, or null when it cannot be read: an install that could not
 * add the columns loses billing, never the accounts page. Said once.
 */
function billingOrNull(accountId: string): SubscriptionBilling | null {
  try {
    return getSubscriptionBilling(accountId);
  } catch (error) {
    if (!warnedBillingRead) {
      warnedBillingRead = true;
      console.warn('[subscriptions] Could not read a paid subscription; accounts are changed without it.', error);
    }
    return null;
  }
}

/**
 * Makes an administrator's change to an account (userRepository.updateUser)
 * and reads the account and its paid period just before it and just after,
 * in ONE IMMEDIATE transaction. Setting the tier, or moving the role away from
 * user, ends a tier the account pays for (updateUser clears the period), and
 * what the administrator and the account are told is worked out from these
 * reads - so they must be of the period the UPDATE ended. Read apart from it,
 * a renewal or a purchase another server on this database committed in
 * between was ended without a word, and the note named the period before it.
 * Null when there is no such account.
 */
export function applyAdministratorChange(accountId: string, update: AccountUpdate): AdministratorChange | null {
  return getDb()
    .transaction((): AdministratorChange | null => {
      const before = getUserById(accountId);
      if (!before) return null;
      const billingBefore = billingOrNull(accountId);
      const account = Object.keys(update).length > 0 ? updateUser(accountId, update) : before;
      if (!account) return null;
      return { before, account, billingBefore, billingAfter: billingOrNull(accountId) };
    })
    .immediate();
}

/**
 * When an administrator's change on Admin -> Accounts ended a tier the
 * account paid for - setting the tier, or moving the role away from user
 * (userRepository.updateUser clears the paid period either way) - notifies
 * the account and answers the administrator's note. Nothing is refunded
 * automatically: a credit given to an account made a reporter would be paid
 * out as earnings. So the note says how much of the period was unused, for
 * the administrator to give back with +/- if they mean to. Null when nothing
 * paid ended: the account was not paying, or the change named the tier it
 * pays for and left its role alone. Called after the change has committed.
 */
export function reportEndedByAdministrator(change: AdministratorChange): string | null {
  const { billingBefore: before, before: target, account: updated } = change;
  if (!before || change.billingAfter) return null;
  const paidTier = isSubscriptionId(target.subscription) ? target.subscription : 'default';
  const unused = unusedCreditMilli(before.periodPriceMilli, daysLeft(clock(), Date.parse(before.paidThrough)));
  sendSubscriptionNotice(
    overrideNotice({
      recipientId: target.id,
      paid: paidTier,
      now: updated.subscription,
      role: updated.role,
      roleChanged: updated.role !== target.role,
    })
  );
  return (
    `Ended ${target.email}'s ${label(paidTier)} paid from credit until ${isoDay(before.paidThrough)}; nothing was refunded.` +
    (unused > 0
      ? ` About ${formatMoney(unused)} of it was unused - give it back with +/- beside the balance if you mean to.`
      : '')
  );
}

/**
 * The administrator's note when the change DISABLED an account that pays for
 * a tier which would renew. Nothing ends now: the account keeps the 30 days
 * it paid for, and enabled again in time it renews as before. But a disabled
 * account is never charged for another period (`renewalDecision`), so if it
 * is still disabled when they end, the tier ends then, with nothing more
 * taken - which the administrator should know when they disable it. Null for
 * any other change.
 */
export function describeDisabledPaidTier(change: AdministratorChange): string | null {
  const billing = change.billingAfter;
  if (!billing || !billing.renews || change.before.disabled || !change.account.disabled) return null;
  const tier = label(isSubscriptionId(change.account.subscription) ? change.account.subscription : 'default');
  const until = isoDay(billing.paidThrough);
  return (
    `${change.account.email} pays for ${tier} from credit until ${until}. A disabled account does not renew: ` +
    `unless it is enabled again by then, ${tier} ends that day and nothing more is taken.`
  );
}

export type { Offer, SubscriptionBilling };

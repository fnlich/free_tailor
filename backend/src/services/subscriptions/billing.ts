import {
  DEFAULT_SUBSCRIPTION,
  isPaidSubscriptionId,
  MAX_SUBSCRIPTION_PRICE_MILLI,
  resolveSubscription,
  SUBSCRIPTION_PERIOD_DAYS,
  SUBSCRIPTIONS,
  type AccountSubscriptionId,
  type PaidSubscriptionId,
  type SubscriptionPrices,
} from '../../config/accountSubscriptions';
import type { UserRole } from '../../types/account';

/**
 * The rules of a paid subscription, and nothing else: no database, no clock
 * of their own (every function is handed "now"), no setting read. The routes
 * and the renewal sweep decide with these inside their transactions
 * (services/subscriptions/index.ts), and test/subscriptionBilling.test.js runs
 * them as tables.
 *
 * A paid tier lasts 30 days from the moment it is bought, then renews from
 * the balance at the price in effect that day. Moving UP starts a new 30 days
 * at once and costs the new price less what the unused days of the paid
 * period are worth; moving DOWN, and cancelling, take effect at the end of
 * the period. A paid tier that ends returns the account to its BASE - the tier
 * it held when it first paid: Default, or one an administrator gave it.
 *
 * A MONEY MODULE (test/money.test.js): every amount is an integer count of
 * thousandths of a dollar, and nothing here floors, truncates or float-parses
 * one - a division is `(a - a % b) / b`, exact on integers.
 */

export const DAY_MS = 86_400_000;

/** One paid period, in ms: 30 days. */
export const PERIOD_MS = SUBSCRIPTION_PERIOD_DAYS * DAY_MS;

/**
 * An account's paid state as its row holds it (database/subscriptionRepository.ts).
 * While the tier is not paid - Default, or set by an administrator - `base`,
 * `periodStart`, `paidThrough` and `next` are null, `renews` false and
 * `periodPriceMilli` 0.
 */
export type BillingState = {
  role: UserRole;
  /**
   * An administrator disabled the account: it cannot sign in, so it can
   * neither use a paid tier nor cancel one, and a renewal does not charge it.
   */
  disabled: boolean;
  /** The tier in effect: `users.subscription`, what every gate reads. */
  subscription: AccountSubscriptionId;
  /** The tier a paid one returns to when it ends. */
  base: AccountSubscriptionId | null;
  /** When the current 30 days began. */
  periodStart: string | null;
  /** When they end: "renews on" / "ends on", and the renewal sweep's key. */
  paidThrough: string | null;
  /** What the tier cost for THIS period, in thousandths: what an upgrade's credit is worked out from. */
  periodPriceMilli: number;
  /** False once cancelled: the tier then ends at `paidThrough`. */
  renews: boolean;
  /** A lower paid tier chosen to switch to at renewal. */
  next: AccountSubscriptionId | null;
};

export function isPaid(state: Pick<BillingState, 'paidThrough'>): boolean {
  return state.paidThrough !== null;
}

/** The tier a paid one returns to when it ends - its base, else Default. */
export function lapsesTo(state: Pick<BillingState, 'base'>): AccountSubscriptionId {
  return state.base ?? DEFAULT_SUBSCRIPTION;
}

/** What a tier costs for one period, in thousandths: Default is free, a paid tier its price (null: not offered). */
export function priceOf(tier: AccountSubscriptionId, prices: SubscriptionPrices): number | null {
  return isPaidSubscriptionId(tier) ? prices[tier] : 0;
}

/** `startIso` plus one period, as an ISO time. */
export function addPeriod(startIso: string): string {
  return new Date(Date.parse(startIso) + PERIOD_MS).toISOString();
}

/**
 * The days left of a paid period, counting a day that has started as left:
 * 0 to 30. It changes once a day, at the hour the period started, so a price
 * worked out from it holds for the rest of that day - which is what lets the
 * page show an upgrade's cost and the server charge exactly that.
 */
export function daysLeft(nowMs: number, paidThroughMs: number): number {
  const left = paidThroughMs - nowMs;
  if (!(left > 0)) return 0;
  const remainder = left % DAY_MS;
  const days = (left - remainder) / DAY_MS + (remainder > 0 ? 1 : 0);
  return Math.min(SUBSCRIPTION_PERIOD_DAYS, days);
}

/**
 * What the unused days of a paid period are worth: its price x days / 30,
 * rounded DOWN to the thousandth - the direction that never credits more than
 * was paid. Exact: a price is at most $10,000 and the days at most 30, so the
 * product stays far inside the integers a double holds.
 */
export function unusedCreditMilli(periodPriceMilli: number, days: number): number {
  if (!Number.isSafeInteger(periodPriceMilli) || periodPriceMilli <= 0) return 0;
  if (!Number.isSafeInteger(days) || days <= 0) return 0;
  const price = Math.min(periodPriceMilli, MAX_SUBSCRIPTION_PRICE_MILLI);
  const total = price * Math.min(days, SUBSCRIPTION_PERIOD_DAYS);
  return (total - (total % SUBSCRIPTION_PERIOD_DAYS)) / SUBSCRIPTION_PERIOD_DAYS;
}

export type ChargeNow = {
  /** What is taken now, in thousandths: never below zero. */
  chargeMilli: number;
  /** What the unused days of the paid period were worth, taken off the price. */
  creditMilli: number;
  /** The days of the paid period left unused. */
  daysLeft: number;
};

/**
 * What moving up to a tier priced `priceMilli` costs NOW: the price, less the
 * unused part of a paid period. A tier that is not paid - Default, or one an
 * administrator set - is worth nothing, so it pays the full price. A higher
 * tier priced below what is left of the current one costs nothing, and the
 * rest of that credit is not paid out.
 */
export function chargeNowMilli(state: BillingState, priceMilli: number, nowMs: number): ChargeNow {
  if (!isPaid(state)) return { chargeMilli: priceMilli, creditMilli: 0, daysLeft: 0 };
  const days = daysLeft(nowMs, Date.parse(state.paidThrough as string));
  const creditMilli = unusedCreditMilli(state.periodPriceMilli, days);
  return { chargeMilli: Math.max(0, priceMilli - creditMilli), creditMilli, daysLeft: days };
}

/**
 * The 30 days a renewal buys: from the old end, so a sweep that runs late
 * loses nobody any time - or from now, when the whole of that period has gone
 * by already (a server stopped for weeks), so nobody pays for days that are
 * over.
 */
export function renewalPeriod(paidThroughIso: string, nowIso: string): { start: string; end: string } {
  const oldEnd = Date.parse(paidThroughIso);
  const now = Date.parse(nowIso);
  const startMs = !Number.isFinite(oldEnd) || now >= oldEnd + PERIOD_MS ? now : oldEnd;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + PERIOD_MS).toISOString() };
}

/**
 * What a tier's card offers the account:
 *
 *  - `current` - the tier it is on;
 *  - `subscribe` - a higher tier, bought at its full price (nothing is paid now);
 *  - `upgrade` - a higher tier, from a paid one: its price less the unused days;
 *  - `switch-at-renewal` - a lower paid tier above the base, taken at renewal;
 *  - `switching` - that tier, already chosen;
 *  - `return-here` - the base, where cancelling returns to;
 *  - `included` - a lower tier, which the one in effect includes;
 *  - `not-offered` - a tier the account could move to, that nobody priced;
 *  - `none` - nothing to do: an administrator is exempt, a reporter builds nothing.
 */
export type Offer =
  | 'current'
  | 'subscribe'
  | 'upgrade'
  | 'switch-at-renewal'
  | 'switching'
  | 'return-here'
  | 'included'
  | 'not-offered'
  | 'none';

export type TierOffer = {
  offer: Offer;
  /** What `subscribe` or `upgrade` takes now, in thousandths; null for every other offer. */
  chargeMilli: number | null;
  /** An upgrade's credit for the unused days; 0 otherwise. */
  creditMilli: number;
  /** An upgrade's unused days; 0 otherwise. */
  daysLeft: number;
};

function plainOffer(offer: Offer): TierOffer {
  return { offer, chargeMilli: null, creditMilli: 0, daysLeft: 0 };
}

/**
 * The offer for one tier, from the account's state and today's prices. A
 * higher tier is offered only when priced; a lower one is never charged for
 * now - it is included, or switched to at renewal.
 */
export function offerFor(
  tier: AccountSubscriptionId,
  state: BillingState,
  prices: SubscriptionPrices,
  nowMs: number
): TierOffer {
  if (tier === state.subscription) return plainOffer('current');
  // Only a user buys: an administrator has every tier's features and is never
  // charged, and a reporter builds no resumes, so has no tier to change.
  if (state.role !== 'user') return plainOffer('none');

  const order = SUBSCRIPTIONS[tier].order;
  const currentOrder = resolveSubscription(state.subscription).order;
  const paid = isPaid(state);

  if (order > currentOrder) {
    const price = priceOf(tier, prices);
    if (price === null) return plainOffer('not-offered');
    if (!paid) return { offer: 'subscribe', chargeMilli: price, creditMilli: 0, daysLeft: 0 };
    return { offer: 'upgrade', ...chargeNowMilli(state, price, nowMs) };
  }

  if (!paid) return plainOffer('included');
  const base = lapsesTo(state);
  if (tier === base) return plainOffer('return-here');
  if (order < SUBSCRIPTIONS[base].order) return plainOffer('included');
  // Between the base and the tier paid for: a lower paid tier for the next period.
  if (state.next === tier) return plainOffer('switching');
  if (priceOf(tier, prices) === null) return plainOffer('not-offered');
  return plainOffer('switch-at-renewal');
}

/** Why a paid tier ends at its renewal rather than renewing - a short balance is the debit's to find. */
export type LapseReason = 'cancelled' | 'not-offered' | 'not-a-user' | 'disabled';

export type RenewalDecision =
  | { kind: 'renew'; tier: PaidSubscriptionId; priceMilli: number }
  | { kind: 'lapse'; reason: LapseReason; tier: AccountSubscriptionId }
  /** Neither, for now: the price of the tier it renews as cannot be read. */
  | { kind: 'hold'; tier: PaidSubscriptionId };

/**
 * What a due paid tier does at its renewal: renew as `next` (else itself) at
 * today's price - or end, because the account no longer builds resumes (made
 * a reporter or an administrator some way that did not end it: an address in
 * ADMIN_EMAILS is promoted at sign-in without passing Admin -> Accounts),
 * because it was cancelled, because the account is disabled (it can neither
 * sign in to use another 30 days nor to cancel them, so it is not charged for
 * them), or because that tier is not offered any more.
 *
 * `unreadable` names the tiers whose price is "not offered" only because a
 * value somebody set could not be read - a mistyped
 * SUBSCRIPTION_<TIER>_PRICE_USD (config/aiModelConfig.ts
 * `getSubscriptionPriceReading`). That is nobody's decision to stop offering
 * the tier, so one renewing as such a tier HOLDS: it is neither renewed nor
 * ended, and keeps its features until the price can be read. Whether the
 * balance covers a renewal is the debit's question, asked inside the same
 * transaction.
 */
export function renewalDecision(
  state: BillingState,
  prices: SubscriptionPrices,
  unreadable: readonly PaidSubscriptionId[] = []
): RenewalDecision {
  const tier = state.next ?? state.subscription;
  if (state.role !== 'user') return { kind: 'lapse', reason: 'not-a-user', tier };
  if (!state.renews) return { kind: 'lapse', reason: 'cancelled', tier };
  if (state.disabled) return { kind: 'lapse', reason: 'disabled', tier };
  if (!isPaidSubscriptionId(tier)) return { kind: 'lapse', reason: 'not-offered', tier };
  if (unreadable.includes(tier)) return { kind: 'hold', tier };
  const price = prices[tier];
  if (price === null) return { kind: 'lapse', reason: 'not-offered', tier };
  return { kind: 'renew', tier, priceMilli: price };
}

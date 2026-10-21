import { apiFetch } from './api';
import type { AccountSubscription } from './auth';
import { toDollarInput } from './format';
import type { AccountSubscriptionId } from './subscriptions';

/**
 * The account's own subscription, bought from its credit balance 30 days at a
 * time (the server's routes/subscription.ts and services/subscriptions): the
 * tier it is on and where that came from, the period it paid for, every
 * tier's price and what its card offers, and the balance it is paid from.
 * What a change costs is worked out by the server, never here.
 *
 * Every amount coming back is an integer count of thousandths of a dollar in
 * a field ending `Milli`, shown with lib/format.ts's `formatMoney`. A purchase
 * sends back the amount the page SHOWED, in dollars (`chargeUsd`): the server
 * works it out again as it charges, and a figure that has changed since - a
 * new price, or a day gone by - is refused with 409 `charge-changed` and the
 * figure in effect (`chargeMilli`), so nobody is charged an amount they were
 * not shown. Too little credit is 402 `insufficient-credits`, as for a run.
 */

/** What a tier's card offers the account (the server's billing.ts `Offer`). */
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

/** Where the tier in effect came from: Default, an administrator, a purchase - or nowhere, for an administrator. */
export type SubscriptionSource = 'default' | 'admin' | 'paid' | 'exempt';

export type SubscriptionTierView = AccountSubscription & {
  /** What it costs for 30 days: 0 for Default; null for a paid tier nobody priced (not offered). */
  priceMilli: number | null;
  offer: Offer;
  /** What `subscribe` or `upgrade` takes now; null for every other offer. */
  chargeMilli: number | null;
  /** An upgrade's credit for the unused days of the paid tier; 0 otherwise. */
  creditMilli: number;
  /** An upgrade's unused days; 0 otherwise. */
  daysLeft: number;
};

/** `GET /api/subscription`. */
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
    /** The 30 days are up and the server has not renewed it yet. */
    due: boolean;
    /** What the renewal takes at today's price; null when it ends instead. */
    renewalPriceMilli: number | null;
    /** How far the balance is short of that renewal now; 0 when it covers it. */
    renewalShortMilli: number;
  };
  /** Every tier, in the catalogue's order. */
  tiers: SubscriptionTierView[];
  balanceMilli: number;
  periodDays: number;
};

/** A change's answer: the view as it stands afterwards. `changed: false` is a repeat that moved nothing. */
export type SubscriptionChange = SubscriptionView & { changed: boolean; chargedMilli?: number };

function change(path: string, body: Record<string, unknown> = {}): Promise<SubscriptionChange> {
  return apiFetch<SubscriptionChange>(`/subscription${path}`, { method: 'POST', body: JSON.stringify(body) });
}

export const subscriptionApi = {
  get: () => apiFetch<SubscriptionView>('/subscription'),

  /** Buy a paid tier, or move up to one now, for exactly the amount the page showed. */
  subscribe: (subscription: AccountSubscriptionId, chargeMilli: number) =>
    change('/subscribe', { subscription, chargeUsd: toDollarInput(chargeMilli) }),

  /** A lower paid tier for the next 30 days, taken at renewal. */
  downgrade: (subscription: AccountSubscriptionId) => change('/downgrade', { subscription }),

  /** Stop renewing: the tier ends with the 30 days it paid for. Nothing is refunded. */
  cancel: () => change('/cancel'),

  /** Undo a cancel, or a switch chosen. */
  resume: () => change('/resume'),
};

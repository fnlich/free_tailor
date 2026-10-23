/**
 * The account subscriptions, and what each one is allowed.
 *
 * A subscription is an account's tier - Default, Premium, Premium+, Premium
 * Max - and nothing else. It is not the AI seats' "subscription" (the Claude,
 * ChatGPT or Google account a CLI is signed in to), which is the operator's,
 * not an account's; the two share a word and no code.
 *
 * A leaf module on purpose - the repository, the routes and the frontend's
 * copy of this all read from here, and a subscription that meant one thing to
 * the limit check and another to the label beside it would be the worst kind
 * of bug: the user is told they may have five and refused the second.
 *
 * Self-serve: an account buys a paid tier from its own credit balance, 30
 * days at a time, renewed from the balance (services/subscriptions). What
 * each paid tier costs is an administrator's setting with a `.env` default
 * (`SUBSCRIPTION_PRICE_FIELDS`); a tier priced nowhere is not offered. An
 * administrator may still set any account's tier on Admin -> Accounts, which
 * ends what that account paid for.
 */

export const SUBSCRIPTION_IDS = ['default', 'premium', 'premium-plus', 'premium-max'] as const;

export type AccountSubscriptionId = (typeof SUBSCRIPTION_IDS)[number];

export type AccountSubscription = {
  id: AccountSubscriptionId;
  label: string;
  /**
   * How many profiles the account may keep, or `null` for no limit.
   *
   * `null` rather than `Infinity`: this number is serialized to JSON on its way
   * to the account page, and `Infinity` does not survive that - `JSON.stringify`
   * turns it into `null` anyway, so saying `null` here means the wire format and
   * the type agree instead of quietly differing.
   */
  profileLimit: number | null;
  /** Shown under the subscription on Settings > Subscription. */
  summary: string;
  order: number;
  /**
   * What the tier includes, one short line each, for the Subscription page's
   * cards. Words, not switches: what a tier unlocks is decided by
   * `profileLimit` and `subscriptionAtLeast` below, never by reading these.
   */
  features: readonly string[];
};

export const SUBSCRIPTIONS: Readonly<Record<AccountSubscriptionId, AccountSubscription>> = Object.freeze({
  default: {
    id: 'default',
    label: 'Default',
    profileLimit: 1,
    summary: 'One profile, with any number of resumes. Everything else in the app is included.',
    order: 0,
    features: Object.freeze(['1 profile', 'Any number of resumes in each', 'Everything else in the app']),
  },
  premium: {
    id: 'premium',
    label: 'Premium',
    profileLimit: 5,
    summary: 'Up to five profiles, each with any number of resumes.',
    order: 1,
    features: Object.freeze(['Up to 5 profiles', 'Any number of resumes in each']),
  },
  'premium-plus': {
    id: 'premium-plus',
    label: 'Premium+',
    profileLimit: 25,
    summary: 'Up to twenty-five profiles.',
    order: 2,
    features: Object.freeze(['Up to 25 profiles', 'Everything in Premium']),
  },
  'premium-max': {
    id: 'premium-max',
    label: 'Premium Max',
    profileLimit: null,
    summary: 'Unlimited profiles.',
    order: 3,
    features: Object.freeze(['Unlimited profiles', 'Everything in Premium']),
  },
});

/**
 * The tiers an account can BUY, lowest first. Default is not one: it is what
 * every account has without paying, and what a paid tier that ends returns to
 * unless an administrator gave the account another.
 */
export const PAID_SUBSCRIPTION_IDS = ['premium', 'premium-plus', 'premium-max'] as const satisfies readonly AccountSubscriptionId[];

export type PaidSubscriptionId = (typeof PAID_SUBSCRIPTION_IDS)[number];

export function isPaidSubscriptionId(value: unknown): value is PaidSubscriptionId {
  return typeof value === 'string' && (PAID_SUBSCRIPTION_IDS as readonly string[]).includes(value);
}

/** How long one paid period lasts, in days: bought, or renewed, 30 days at a time. */
export const SUBSCRIPTION_PERIOD_DAYS = 30;

/**
 * The most a paid tier may cost for one period, in thousandths of a dollar:
 * $10,000. An administrator's price above it is refused by name, `.env`'s
 * clamped with a warning. It also keeps the proration exact: a price times
 * the days left (at most 30) stays far inside the integers a double holds.
 */
export const MAX_SUBSCRIPTION_PRICE_MILLI = 10_000_000;

/**
 * Where each paid tier's price lives: the app-settings field the admin payload
 * serves it in (thousandths, `null` = not offered), the field a save sends it
 * in (dollars, as typed), and the `.env` variable that is its default while
 * an administrator stores none (config/settingDefaults.ts).
 */
export const SUBSCRIPTION_PRICE_FIELDS = {
  premium: { setting: 'premiumPriceMilli', request: 'premiumPriceUsd', env: 'SUBSCRIPTION_PREMIUM_PRICE_USD' },
  'premium-plus': {
    setting: 'premiumPlusPriceMilli',
    request: 'premiumPlusPriceUsd',
    env: 'SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD',
  },
  'premium-max': {
    setting: 'premiumMaxPriceMilli',
    request: 'premiumMaxPriceUsd',
    env: 'SUBSCRIPTION_PREMIUM_MAX_PRICE_USD',
  },
} as const satisfies Record<PaidSubscriptionId, { setting: string; request: string; env: string }>;

/** The app-settings field of a paid tier's price: `premiumPriceMilli`, `premiumPlusPriceMilli`, `premiumMaxPriceMilli`. */
export type SubscriptionPriceSetting = (typeof SUBSCRIPTION_PRICE_FIELDS)[PaidSubscriptionId]['setting'];

/** What each paid tier costs for one period, in thousandths of a dollar; null is not offered. */
export type SubscriptionPrices = Record<PaidSubscriptionId, number | null>;

/** The subscription a new account starts on. */
export const DEFAULT_SUBSCRIPTION: AccountSubscriptionId = 'default';

export function isSubscriptionId(value: unknown): value is AccountSubscriptionId {
  return typeof value === 'string' && (SUBSCRIPTION_IDS as readonly string[]).includes(value);
}

/**
 * The subscription for a stored value, falling back rather than throwing.
 *
 * A row naming a subscription this build does not have - a downgrade, a
 * hand-edited row - must not take the account down with it. Landing on the
 * smallest subscription is the safe direction: it can refuse a profile
 * somebody was entitled to, which an admin can fix in a click, where the other
 * direction hands out entitlements nobody granted.
 */
export function resolveSubscription(value: unknown): AccountSubscription {
  return SUBSCRIPTIONS[isSubscriptionId(value) ? value : DEFAULT_SUBSCRIPTION];
}

export function listSubscriptions(): AccountSubscription[] {
  return SUBSCRIPTION_IDS.map((id) => SUBSCRIPTIONS[id]).sort((a, b) => a.order - b.order);
}

/**
 * Whether a subscription is at least as high as another.
 *
 * Compares `order` rather than the ids, so adding a tier in the middle later
 * does not silently change who passes an existing check - the numbers move with
 * the list. An unrecognised stored value resolves to the smallest subscription
 * and is therefore refused, which is the same safe direction the profile cap
 * takes: it can withhold something an account was entitled to, which an admin
 * fixes in a click, rather than hand out an entitlement nobody granted.
 */
export function subscriptionAtLeast(value: unknown, minimum: AccountSubscriptionId): boolean {
  return resolveSubscription(value).order >= SUBSCRIPTIONS[minimum].order;
}


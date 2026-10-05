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
};

export const SUBSCRIPTIONS: Readonly<Record<AccountSubscriptionId, AccountSubscription>> = Object.freeze({
  default: {
    id: 'default',
    label: 'Default',
    profileLimit: 1,
    summary: 'One profile. Everything else in the app is included.',
    order: 0,
  },
  premium: {
    id: 'premium',
    label: 'Premium',
    profileLimit: 5,
    summary: 'Up to five profiles, for tailoring against a few different tracks.',
    order: 1,
  },
  'premium-plus': {
    id: 'premium-plus',
    label: 'Premium+',
    profileLimit: 25,
    summary: 'Up to twenty-five profiles.',
    order: 2,
  },
  'premium-max': {
    id: 'premium-max',
    label: 'Premium Max',
    profileLimit: null,
    summary: 'Unlimited profiles.',
    order: 3,
  },
});

/**
 * The lowest subscription that may build for more than one profile at once -
 * Multiple, All profiles, Specific group and Select Group, in the builder's
 * manual and sheet modes alike (owner decisions B1-B3). A Default subscription
 * supports one profile, so it builds for that one. Administrators are exempt
 * (`hasSubscription`).
 */
export const MULTI_PROFILE_SUBSCRIPTION: AccountSubscriptionId = 'premium';

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

/** How the limit reads in a sentence: "5" or "unlimited". */
export function describeProfileLimit(subscription: AccountSubscription): string {
  return subscription.profileLimit === null ? 'unlimited' : String(subscription.profileLimit);
}

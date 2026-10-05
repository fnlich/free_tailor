/**
 * The account subscriptions (Default, Premium, Premium+, Premium Max), and how
 * to compare them.
 *
 * A copy of the backend's order rather than a fetch, because it is needed while
 * deciding what to render - before any request - and the list has not changed
 * since the tiers were introduced. The backend's `subscriptionAtLeast`
 * (backend/src/config/accountSubscriptions.ts) is the one that actually
 * enforces anything; this exists so the UI does not offer a door the API will
 * slam. backend/test/frontendHelpers.test.js fails when the two orders differ.
 *
 * Keep the order in step with the backend. A disagreement shows somebody a page
 * whose every request then fails, which is worse than not showing it.
 */

export const SUBSCRIPTION_ORDER = ['default', 'premium', 'premium-plus', 'premium-max'] as const;

export type AccountSubscriptionId = (typeof SUBSCRIPTION_ORDER)[number];

function rank(value: unknown): number {
  const index = SUBSCRIPTION_ORDER.indexOf(String(value ?? '') as AccountSubscriptionId);
  // An unknown subscription ranks lowest and is therefore refused - the same
  // safe direction the backend takes.
  return index < 0 ? 0 : index;
}

export function subscriptionAtLeast(value: unknown, minimum: AccountSubscriptionId): boolean {
  return rank(value) >= rank(minimum);
}

/**
 * The account an entitlement is decided for: its role and its subscription.
 * Structural, so the session's `Account` fits without this module importing it.
 */
export type EntitledAccount = { role?: unknown; subscription?: unknown } | null | undefined;

/**
 * Whether an account has a subscription at least this high - or is an
 * administrator, who is exempt (owner decision B1), exactly as the backend's
 * `hasSubscription` (backend/src/middleware/auth.ts) decides it.
 * backend/test/frontendHelpers.test.js runs both over every role and tier.
 */
export function hasSubscription(account: EntitledAccount, minimum: AccountSubscriptionId): boolean {
  if (!account) return false;
  if (account.role === 'admin') return true;
  return subscriptionAtLeast(account.subscription, minimum);
}

/**
 * The subscription that unlocks building for more than one profile at once:
 * Multiple, All profiles, Specific group and Select Group (owner decisions B1,
 * B3). The backend's MULTI_PROFILE_SUBSCRIPTION, which is the real lock - a
 * run, quote or preview-all for several profiles below it is refused with 403
 * `subscription-too-low`.
 */
export const MULTI_PROFILE_SUBSCRIPTION: AccountSubscriptionId = 'premium';

/** Whether the builder offers the multi-profile choices to this account. */
export function canBuildForManyProfiles(account: EntitledAccount): boolean {
  return hasSubscription(account, MULTI_PROFILE_SUBSCRIPTION);
}

/**
 * The builder's starting target for this account.
 *
 * The administrator's "Default resume target" applies to everybody - except
 * that an account whose subscription supports one profile starts on Single,
 * whatever the default says: starting it on a choice it cannot take showed a
 * locked option selected and a run the server would refuse.
 */
export function startingResumeSelection<T extends string>(selection: T, manyProfiles: boolean): T | 'single' {
  return manyProfiles ? selection : 'single';
}

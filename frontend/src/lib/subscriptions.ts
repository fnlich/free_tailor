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

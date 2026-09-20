/**
 * The plan tiers, and how to compare them.
 *
 * A copy of the backend's order rather than a fetch, because it is needed while
 * deciding what to render - before any request - and the list has not changed
 * since the plans were introduced. The backend's `planAtLeast`
 * (backend/src/config/accountPlans.ts) is the one that actually enforces
 * anything; this exists so the UI does not offer a door the API will slam.
 *
 * Keep the order in step with the backend. A disagreement shows somebody a page
 * whose every request then fails, which is worse than not showing it.
 */

export const PLAN_ORDER = ['default', 'premium', 'premium-plus', 'premium-max'] as const;

export type AccountPlanId = (typeof PLAN_ORDER)[number];

function rank(value: unknown): number {
  const index = PLAN_ORDER.indexOf(String(value ?? '') as AccountPlanId);
  // An unknown plan ranks lowest and is therefore refused - the same safe
  // direction the backend takes.
  return index < 0 ? 0 : index;
}

export function planAtLeast(value: unknown, minimum: AccountPlanId): boolean {
  return rank(value) >= rank(minimum);
}

/**
 * The account plans, and what each one is allowed.
 *
 * A leaf module on purpose - the repository, the routes and the frontend's
 * copy of this all read from here, and a plan that meant one thing to the
 * limit check and another to the label beside it would be the worst kind of
 * bug: the user is told they may have five and refused the second.
 */

export const ACCOUNT_PLAN_IDS = ['default', 'premium', 'premium-plus', 'premium-max'] as const;

export type AccountPlanId = (typeof ACCOUNT_PLAN_IDS)[number];

export type AccountPlan = {
  id: AccountPlanId;
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
  /** Shown under the plan on the subscription panel. */
  summary: string;
  order: number;
};

export const ACCOUNT_PLANS: Readonly<Record<AccountPlanId, AccountPlan>> = Object.freeze({
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

/** The plan a new account starts on. */
export const DEFAULT_ACCOUNT_PLAN: AccountPlanId = 'default';

export function isAccountPlanId(value: unknown): value is AccountPlanId {
  return typeof value === 'string' && (ACCOUNT_PLAN_IDS as readonly string[]).includes(value);
}

/**
 * The plan for a stored value, falling back rather than throwing.
 *
 * A row naming a plan this build does not have - a downgrade, a hand-edited
 * row - must not take the account down with it. Landing on the smallest plan is
 * the safe direction: it can refuse a profile somebody was entitled to, which
 * an admin can fix in a click, where the other direction hands out entitlements
 * nobody granted.
 */
export function resolveAccountPlan(value: unknown): AccountPlan {
  return ACCOUNT_PLANS[isAccountPlanId(value) ? value : DEFAULT_ACCOUNT_PLAN];
}

export function listAccountPlans(): AccountPlan[] {
  return ACCOUNT_PLAN_IDS.map((id) => ACCOUNT_PLANS[id]).sort((a, b) => a.order - b.order);
}

/** How the limit reads in a sentence: "5" or "unlimited". */
export function describeProfileLimit(plan: AccountPlan): string {
  return plan.profileLimit === null ? 'unlimited' : String(plan.profileLimit);
}

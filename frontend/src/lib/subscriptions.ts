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
 *
 * It also words the LOCKS (`describeLock`): what a locked choice's dialog and
 * panel say (components/subscription/LockedFeature.tsx), with the tier that
 * unlocks it and a way to the Subscription page. Imports nothing at runtime,
 * so the backend suite loads it as it is.
 */

export const SUBSCRIPTION_ORDER = ['default', 'premium', 'premium-plus', 'premium-max'] as const;

export type AccountSubscriptionId = (typeof SUBSCRIPTION_ORDER)[number];

/**
 * Each tier's name and profile limit (null: no limit) - copies of the
 * backend's catalogue, for the lock's sentences, which are written before any
 * request. backend/test/frontendHelpers.test.js holds both to it.
 */
export const SUBSCRIPTION_LABELS: Readonly<Record<AccountSubscriptionId, string>> = {
  default: 'Default',
  premium: 'Premium',
  'premium-plus': 'Premium+',
  'premium-max': 'Premium Max',
};

export const SUBSCRIPTION_PROFILE_LIMITS: Readonly<Record<AccountSubscriptionId, number | null>> = {
  default: 1,
  premium: 5,
  'premium-plus': 25,
  'premium-max': null,
};

/** A stored value as a tier this page knows, the smallest for anything else - the backend's `resolveSubscription`. */
function tierOf(value: unknown): AccountSubscriptionId {
  return SUBSCRIPTION_ORDER[rank(value)];
}

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
 * Multiple, Several profiles, All profiles, Specific group and Select Group
 * (owner decisions B1, B3). The backend's MULTI_PROFILE_SUBSCRIPTION, which
 * is the real lock - a run, quote or preview-all for several profiles below
 * it is refused with 403 `subscription-too-low`.
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

/* ------------------------------------------------------------------ locks */

/**
 * What a subscription can lock: building for more than one profile at once
 * (Multiple, Several profiles, All profiles, Specific group, Select Group),
 * Groups, and a profile past the subscription's limit.
 */
export type LockedFeatureId = 'many-profiles' | 'groups' | 'more-profiles';

/**
 * A locked feature, as the lock's dialog and panel say it: "Locked: <title>",
 * the sentence under it, and the tier that unlocks it. The server is the real
 * lock every time (403 `subscription-too-low`, 402 `profile-limit`); this is
 * only the page saying so before it is asked.
 */
export type LockSpec = {
  feature: LockedFeatureId;
  title: string;
  /** The lowest tier that unlocks it. */
  needs: AccountSubscriptionId;
  needsLabel: string;
  body: string;
};

function profileCount(count: number): string {
  return `${count} profile${count === 1 ? '' : 's'}`;
}

/** The lowest tier whose limit is above `used`: what a new profile needs. */
function tierAbove(used: number): AccountSubscriptionId {
  return (
    SUBSCRIPTION_ORDER.find((tier) => {
      const limit = SUBSCRIPTION_PROFILE_LIMITS[tier];
      return limit === null || limit > used;
    }) ?? 'premium-max'
  );
}

/**
 * The words of a lock, for the account it is shown to. `subscription` is the
 * account's tier as the session has it; `profilesUsed` matters only for
 * `more-profiles`, whose sentence names the cheapest tier with room for one
 * more.
 */
export function describeLock(
  feature: LockedFeatureId,
  account: { subscription?: unknown; profilesUsed?: unknown } | null | undefined
): LockSpec {
  const current = tierOf(account?.subscription);
  const currentLabel = SUBSCRIPTION_LABELS[current];

  if (feature === 'more-profiles') {
    const limit = SUBSCRIPTION_PROFILE_LIMITS[current];
    const used =
      typeof account?.profilesUsed === 'number' && Number.isSafeInteger(account.profilesUsed) && account.profilesUsed >= 0
        ? account.profilesUsed
        : limit ?? 0;
    const needs = tierAbove(used);
    const needsLimit = SUBSCRIPTION_PROFILE_LIMITS[needs];
    const allows = limit === null ? 'has no limit on profiles' : `allows ${profileCount(limit)}`;
    return {
      feature,
      title: 'More profiles',
      needs,
      needsLabel: SUBSCRIPTION_LABELS[needs],
      body:
        `The ${currentLabel} subscription ${allows}, and you have ${used}. ` +
        (needsLimit === null
          ? `${SUBSCRIPTION_LABELS[needs]} has no limit on profiles.`
          : `${SUBSCRIPTION_LABELS[needs]} allows up to ${needsLimit}.`),
    };
  }

  const needs = MULTI_PROFILE_SUBSCRIPTION;
  const needsLabel = SUBSCRIPTION_LABELS[needs];
  if (feature === 'groups') {
    return {
      feature,
      title: 'Groups',
      needs,
      needsLabel,
      body:
        `Groups need a ${needsLabel} subscription or higher, and your account is on ${currentLabel}. ` +
        'A group is a set of profiles you build for together.',
    };
  }
  return {
    feature,
    title: 'Building for several profiles',
    needs,
    needsLabel,
    body:
      `Your ${currentLabel} subscription builds for one profile at a time. ` +
      `${needsLabel} and higher build for the profiles you choose, every profile, or a group of them, in one run.`,
  };
}

/*
 * The locks for what the SERVER refused, worded from the refusal rather than
 * the session. A page that offered the thing believed the account could have
 * it, so a refusal means its session is behind the server - a tier that
 * lapsed at renewal under an open page, a profile added in another tab - and a
 * lock worded from that session named the tier the account no longer has:
 * "Your Premium subscription builds for one profile at a time. Premium and
 * higher build ...".
 */

/**
 * A run for several profiles refused 403 `subscription-too-low`: the server
 * holds the account below MULTI_PROFILE_SUBSCRIPTION, and below Premium there
 * is only Default (an unknown tier ranks as Default too).
 */
export function describeTooLowRefusal(): LockSpec {
  return describeLock('many-profiles', { subscription: SUBSCRIPTION_ORDER[rank(MULTI_PROFILE_SUBSCRIPTION) - 1] });
}

/** The tier whose profile limit is `limit`, or null when no tier has it. */
export function tierWithProfileLimit(limit: unknown): AccountSubscriptionId | null {
  if (typeof limit !== 'number') return null;
  return SUBSCRIPTION_ORDER.find((tier) => SUBSCRIPTION_PROFILE_LIMITS[tier] === limit) ?? null;
}

/**
 * A new profile refused 402 `profile-limit`. Its `limit` is the limit of the
 * tier the server holds the account on (the backend's ProfileLimitError), so
 * it names that tier - the session's only when no tier has that limit - and
 * the server counted at least that many profiles. `used` is the page's own
 * count, read again after the refusal when it could be.
 */
export function describeProfileLimitRefusal(
  refusal: { limit?: unknown; used?: unknown },
  account: { subscription?: unknown } | null | undefined
): LockSpec {
  const counts = [refusal.limit, refusal.used].filter(
    (count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
  );
  return describeLock('more-profiles', {
    subscription: tierWithProfileLimit(refusal.limit) ?? account?.subscription,
    profilesUsed: counts.length > 0 ? Math.max(...counts) : undefined,
  });
}

import { SUBSCRIPTIONS, SUBSCRIPTION_PERIOD_DAYS, type AccountSubscriptionId } from '../../config/accountSubscriptions';
import { createNotification } from '../../database/notificationRepository';
import type { UserRole } from '../../types/account';
import { formatMoney } from '../../utils/money';
import type { LapseReason } from './billing';

/**
 * What an account is told when its paid subscription changes without it
 * asking: renewed, switched, ended - and why - or ended by an administrator.
 * A change the person makes themselves is answered on the page, and needs no
 * notice.
 *
 * Every notice is written AFTER the change commits, and a notice that cannot
 * be written is logged and never undoes it: the money has moved, and the
 * ledger already says so. Each links to the Subscription page - except a
 * reporter's, whose account has no such page.
 */

export const SUBSCRIPTION_PAGE = '/settings/subscription';

export type SubscriptionNotice = { recipientId: string; title: string; body: string; link: string };

function label(tier: AccountSubscriptionId): string {
  return SUBSCRIPTIONS[tier].label;
}

/** A day as the notices write it: 2026-11-18, the UTC day of an ISO time. */
export function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Writes one notice, after the change it describes has committed. Never throws. */
export function sendSubscriptionNotice(notice: SubscriptionNotice | null): void {
  if (!notice) return;
  try {
    createNotification({
      recipientId: notice.recipientId,
      title: notice.title,
      body: notice.body,
      ...(notice.link ? { link: notice.link } : {}),
    });
  } catch (error) {
    console.warn(`[subscriptions] Could not notify account ${notice.recipientId}: "${notice.title}".`, error);
  }
}

/** A paid subscription renewed by the sweep - as itself, or as the lower tier chosen for the next period. */
export function renewedNotice(input: {
  recipientId: string;
  from: AccountSubscriptionId;
  to: AccountSubscriptionId;
  chargedMilli: number;
  balanceMilli: number;
  paidThrough: string;
}): SubscriptionNotice {
  const until = isoDay(input.paidThrough);
  const taken =
    input.chargedMilli > 0
      ? `${formatMoney(input.chargedMilli)} was taken from your credit, and your balance is now ${formatMoney(input.balanceMilli)}.`
      : 'Nothing was taken from your credit.';
  if (input.from === input.to) {
    return {
      recipientId: input.recipientId,
      title: `${label(input.to)} renewed: ${formatMoney(input.chargedMilli)}`,
      body:
        `Your ${label(input.to)} subscription renewed for another ${SUBSCRIPTION_PERIOD_DAYS} days, until ${until}. ` +
        taken,
      link: SUBSCRIPTION_PAGE,
    };
  }
  return {
    recipientId: input.recipientId,
    title: `${label(input.from)} is now ${label(input.to)}: ${formatMoney(input.chargedMilli)}`,
    body:
      `As you chose, your subscription switched from ${label(input.from)} to ${label(input.to)} for the next ` +
      `${SUBSCRIPTION_PERIOD_DAYS} days, until ${until}. ${taken}`,
    link: SUBSCRIPTION_PAGE,
  };
}

/**
 * A paid subscription that ended at its renewal, saying why - or null when
 * nobody needs telling: an administrator (made one some way that did not end
 * it) is exempt from subscriptions altogether.
 */
export function lapsedNotice(input: {
  recipientId: string;
  role: UserRole;
  /** The tier that was paid for. */
  tier: AccountSubscriptionId;
  /** The tier it would have renewed as: `tier`, or the lower one chosen for the next period. */
  renewingAs: AccountSubscriptionId;
  /** Where the account is now. */
  returnedTo: AccountSubscriptionId;
  reason: LapseReason | 'insufficient';
  /** The day it ended: the paid period's end. */
  endedAt: string;
  /** For `insufficient`: what the renewal would have cost, and the balance it found. */
  priceMilli?: number;
  balanceMilli?: number;
}): SubscriptionNotice | null {
  const on = isoDay(input.endedAt);
  const paid = label(input.tier);
  const now = `Your account is on ${label(input.returnedTo)} now.`;
  const notice = (title: string, body: string, link = SUBSCRIPTION_PAGE): SubscriptionNotice => ({
    recipientId: input.recipientId,
    title,
    body,
    link,
  });
  switch (input.reason) {
    case 'insufficient': {
      const cost =
        input.renewingAs === input.tier
          ? `it costs ${formatMoney(input.priceMilli ?? 0)}`
          : `the next ${SUBSCRIPTION_PERIOD_DAYS} days, on ${label(input.renewingAs)}, cost ${formatMoney(input.priceMilli ?? 0)}`;
      return notice(
        `${paid} ended: not enough credit`,
        `Your ${paid} subscription could not renew on ${on}: ${cost} and your balance was ` +
          `${formatMoney(input.balanceMilli ?? 0)}. ${now} Buy credits, then subscribe again from the Subscription page.`
      );
    }
    case 'cancelled':
      return notice(`${paid} ended`, `Your ${paid} subscription ended on ${on}, as you cancelled it. ${now}`);
    case 'disabled':
      // Read once the account is enabled again: until then it cannot sign in.
      return notice(
        `${paid} ended`,
        `Your ${paid} subscription ended on ${on} without renewing, because your account was disabled then, ` +
          `and nothing was taken from your credit. ${now}`
      );
    case 'not-offered':
      return notice(
        `${paid} ended: no longer offered`,
        input.renewingAs === input.tier
          ? `Your ${paid} subscription could not renew on ${on}: this installation no longer offers it. ${now}`
          : `Your ${paid} subscription could not renew on ${on}: this installation no longer offers ` +
              `${label(input.renewingAs)}, the subscription you chose for the next ${SUBSCRIPTION_PERIOD_DAYS} days. ${now}`
      );
    case 'not-a-user':
      // A reporter builds no resumes, so has no Subscription page to link to.
      if (input.role !== 'reporter') return null;
      return notice(
        `${paid} ended`,
        `Your ${paid} subscription ended on ${on}: your account no longer builds resumes, so it has no subscription.`,
        ''
      );
    default:
      return null;
  }
}

/**
 * A paid subscription ended at once by an administrator - by setting the
 * account's tier on Admin -> Accounts, or by moving its role away from user.
 * Nothing is refunded automatically, and the notice says so.
 */
export function overrideNotice(input: {
  recipientId: string;
  /** The tier that was paid for. */
  paid: AccountSubscriptionId;
  /** The tier the account is on now. */
  now: AccountSubscriptionId;
  /** The account's role now: a role change, rather than a tier set, ended it. */
  role: UserRole;
  roleChanged: boolean;
}): SubscriptionNotice {
  const ended = `Your ${label(input.paid)} paid from credit has ended and will not renew; nothing was refunded.`;
  if (input.roleChanged && input.role !== 'user') {
    return {
      recipientId: input.recipientId,
      title: 'Your subscription was changed',
      body: `An administrator changed your account's role. ${ended}`,
      // A reporter has no Subscription page; an administrator's is read-only, and theirs.
      link: input.role === 'reporter' ? '' : SUBSCRIPTION_PAGE,
    };
  }
  return {
    recipientId: input.recipientId,
    title: 'Your subscription was changed',
    body: `An administrator set your subscription to ${label(input.now)}. ${ended}`,
    link: SUBSCRIPTION_PAGE,
  };
}

import { formatDate, formatMoney } from './format';
import type { SpendEstimate } from './spendConfirm';
import { SUBSCRIPTION_LABELS, type AccountSubscriptionId } from './subscriptions';
import type { SubscriptionChange, SubscriptionTierView, SubscriptionView } from './subscriptionBilling';

const DAY_MS = 86_400_000;

/**
 * What the Subscription page draws from `GET /api/subscription`, with no
 * React in it: each tier card's price and action, and the "Current
 * subscription" summary. The server decides every offer and every amount
 * (services/subscriptions); this only puts them into words and picks the
 * button - so backend/test/frontendSubscription.test.js runs it over real
 * answers from the real routes, in every state.
 *
 * Runtime imports: lib/format.ts and lib/subscriptions.ts only.
 *
 * A MONEY MODULE (test/frontendMoney.test.js): amounts are integer thousandths.
 */

function labelOf(tier: AccountSubscriptionId | string | null | undefined): string {
  return (tier && SUBSCRIPTION_LABELS[tier as AccountSubscriptionId]) || 'Default';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A day of the paid period, as the page prints it. */
export function dayText(iso: string): string {
  return formatDate(iso, { style: 'date' });
}

/** A card's price: `$9.99`, `Free`, or `Not offered` for a paid tier nobody priced. */
export function priceText(tier: Pick<SubscriptionTierView, 'priceMilli'>): string {
  if (tier.priceMilli === null) return 'Not offered';
  if (tier.priceMilli <= 0) return 'Free';
  return formatMoney(tier.priceMilli);
}

/**
 * What a card offers, as its button - or, where there is nothing to press,
 * the words in its place:
 *
 *  - `buy` - subscribe at the full price, or move up now for the price less
 *    the unused days (`prorationNote`); the amount is the server's `chargeMilli`;
 *  - `switch` - a lower paid tier at renewal, on `on`, at its price then;
 *  - `keep` - the tier paid for, renewing again after a cancel or a switch;
 *  - `state` - nothing to press: the current tier, one included, where a
 *    switch or a cancel lands, or one not offered.
 *
 * `title` is what the spend confirm is titled.
 */
export type CardAction =
  | {
      kind: 'buy';
      label: string;
      title: string;
      chargeMilli: number;
      creditMilli: number;
      daysLeft: number;
      prorationNote: string | null;
    }
  | { kind: 'switch'; label: string; title: string; on: string; priceMilli: number | null }
  | { kind: 'keep'; label: string; title: string; on: string; priceMilli: number | null }
  | { kind: 'state'; text: string };

export function cardAction(tier: SubscriptionTierView, view: SubscriptionView): CardAction {
  const paid = view.paid;
  switch (tier.offer) {
    case 'current': {
      // Cancelled, or switching: Keep renews it as itself - while it is still offered.
      if (view.source === 'paid' && paid && (!paid.renews || paid.next !== null) && tier.priceMilli !== null) {
        return {
          kind: 'keep',
          label: `Keep ${tier.label}`,
          title: `Keep ${tier.label}`,
          on: paid.paidThrough,
          priceMilli: tier.priceMilli,
        };
      }
      return { kind: 'state', text: 'Current subscription' };
    }
    case 'subscribe':
    case 'upgrade': {
      const chargeMilli = tier.chargeMilli ?? tier.priceMilli ?? 0;
      const upgrade = tier.offer === 'upgrade';
      return {
        kind: 'buy',
        label: upgrade ? `Upgrade · ${formatMoney(chargeMilli)}` : 'Subscribe',
        title: upgrade ? `Upgrade to ${tier.label}` : `Subscribe to ${tier.label}`,
        chargeMilli,
        creditMilli: tier.creditMilli,
        daysLeft: tier.daysLeft,
        prorationNote:
          upgrade && tier.creditMilli > 0 && tier.priceMilli !== null
            ? `${formatMoney(tier.priceMilli)} less ${formatMoney(tier.creditMilli)} for ` +
              `${plural(tier.daysLeft, 'unused day')} of ${labelOf(view.subscription)}`
            : null,
      };
    }
    case 'switch-at-renewal':
      return {
        kind: 'switch',
        label: 'Switch at renewal',
        title: `Switch to ${tier.label} at renewal`,
        on: paid?.paidThrough ?? '',
        priceMilli: tier.priceMilli,
      };
    case 'switching':
      return { kind: 'state', text: paid ? `Switches here on ${dayText(paid.paidThrough)}` : 'Switches here at renewal' };
    case 'return-here':
      return {
        kind: 'state',
        text:
          paid && !paid.renews ? `Your account returns here on ${dayText(paid.paidThrough)}` : 'You return here if you cancel',
      };
    case 'included':
      return { kind: 'state', text: 'Included in yours' };
    case 'not-offered':
      return { kind: 'state', text: 'Not offered here' };
    default:
      return { kind: 'state', text: view.source === 'exempt' ? 'Included for administrators' : '' };
  }
}

/**
 * What the spend confirm (components/SpendConfirm.tsx, kind `subscription`)
 * says before a purchase - `buy`, subscribing or moving up - and so whether it
 * asks at all.
 *
 * Usually the amount taken now. But an upgrade whose price the unused days of
 * the tier paid for cover is `chargeMilli` 0 - a higher tier priced at or below
 * that credit, after a price cut - and an estimate of $0 now would not be
 * asked about, though the press starts a new 30 days that renew from the
 * credit and gives up whatever of the unused days' credit the new price does
 * not use. So that one is asked about as what it is: nothing now, and the new
 * tier's price when its first 30 days end (`periodDays` from `now`).
 */
export function buyQuestion(
  tier: SubscriptionTierView,
  action: Extract<CardAction, { kind: 'buy' }>,
  view: SubscriptionView,
  now: number
): { estimate: SpendEstimate; what: string; detail: string } {
  const days = view.periodDays;
  if (action.chargeMilli > 0) {
    return {
      estimate: { costMilli: action.chargeMilli, balanceMilli: view.balanceMilli, exempt: false, chargedOn: null },
      what: `${tier.label} for ${days} days`,
      detail:
        (action.prorationNote ? `${action.prorationNote}. ` : '') +
        `Your ${days} days start now, and ${tier.label} renews from your credit at the end of them, at its price then, until you cancel.`,
    };
  }
  const priceMilli = tier.priceMilli ?? 0;
  const unusedMilli = action.creditMilli - priceMilli;
  return {
    estimate: {
      costMilli: priceMilli,
      balanceMilli: view.balanceMilli,
      exempt: false,
      chargedOn: new Date(now + days * DAY_MS).toISOString(),
    },
    what: tier.label,
    detail:
      (action.prorationNote ? `${action.prorationNote}: your` : 'Your') +
      ' unused days cover it, so nothing is taken now' +
      (unusedMilli > 0
        ? `, and the ${formatMoney(unusedMilli)} of their credit that ${tier.label} does not use is not refunded`
        : '') +
      `. Your ${days} days of ${tier.label} start now.`,
  };
}

/** A row of the "Current subscription" summary. */
export type StatusRow = { label: string; value: string };

/**
 * The "Current subscription" summary: the tier, where it came from, and - for
 * one paid from credit - when it started, when it renews, ends or switches,
 * and what the next charge is. `warning` is set while the balance is short of
 * a renewal that will be taken (`shortMilli` > 0); `canCancel` while there is
 * a renewal to stop.
 */
export type StatusSummary = {
  headline: string;
  source: string;
  rows: StatusRow[];
  warning: { shortMilli: number; renewalMilli: number; balanceMilli: number; on: string; sentence: string } | null;
  canCancel: boolean;
};

export function statusSummary(view: SubscriptionView): StatusSummary {
  const headline = labelOf(view.subscription);
  if (view.source === 'exempt') {
    return {
      headline,
      source: "Administrators have every subscription's features and are never charged, so there is nothing to buy here.",
      rows: [],
      warning: null,
      canCancel: false,
    };
  }
  if (view.source === 'admin' || !view.paid) {
    return {
      headline,
      source:
        view.source === 'admin'
          ? 'Set by an administrator. It does not renew and nothing is taken from your credit.'
          : 'The subscription every account has without paying. Nothing is taken from your credit for it.',
      rows: [],
      warning: null,
      canCancel: false,
    };
  }

  const paid = view.paid;
  const on = dayText(paid.paidThrough);
  const base = labelOf(view.base);
  const rows: StatusRow[] = [{ label: 'Started', value: dayText(paid.since) }];
  if (paid.due) {
    rows.push({ label: 'Renewing', value: `Now: its 30 days ended on ${on}` });
  }
  if (!paid.renews) {
    rows.push({ label: 'Ends on', value: `${on}, then your account returns to ${base}` });
    rows.push({ label: 'Next charge', value: 'None: cancelled, so nothing more is taken' });
  } else if (paid.next) {
    const next = labelOf(paid.next);
    rows.push({ label: 'Switches on', value: `${on}, to ${next}` });
    rows.push({
      label: 'Next charge',
      value:
        paid.renewalPriceMilli === null
          ? `None: ${next} is no longer offered, so it ends then and your account returns to ${base}`
          : `${formatMoney(paid.renewalPriceMilli)} for ${next}, on ${on}`,
    });
  } else {
    rows.push({ label: 'Renews on', value: on });
    rows.push({
      label: 'Next charge',
      value:
        paid.renewalPriceMilli === null
          ? `None: ${headline} is no longer offered, so it ends then and your account returns to ${base}`
          : `${formatMoney(paid.renewalPriceMilli)}, on ${on}, and every 30 days after until you cancel`,
    });
  }

  const short = paid.renews && paid.renewalPriceMilli !== null && paid.renewalShortMilli > 0;
  return {
    headline,
    source: 'Paid from your credit, 30 days at a time.',
    rows,
    warning:
      short && paid.renewalPriceMilli !== null
        ? {
            shortMilli: paid.renewalShortMilli,
            renewalMilli: paid.renewalPriceMilli,
            balanceMilli: view.balanceMilli,
            on: paid.paidThrough,
            sentence:
              `Your balance (${formatMoney(view.balanceMilli)}) is less than the renewal ` +
              `(${formatMoney(paid.renewalPriceMilli)}). Buy credits before ${on}, or the subscription ends then.`,
          }
        : null,
    canCancel: paid.renews,
  };
}

/** A change the page asked for: buy or move up, switch at renewal, cancel, keep. */
export type SubscriptionChangeKind = 'subscribe' | 'downgrade' | 'cancel' | 'resume';

/** What the page says once a change has been made, from the server's answer (the view after it). */
export function changeMessage(kind: SubscriptionChangeKind, result: SubscriptionChange): string {
  const tier = labelOf(result.subscription);
  const on = result.paid ? dayText(result.paid.paidThrough) : '';
  if (!result.changed) return 'Nothing changed: your subscription was already like that.';
  switch (kind) {
    case 'subscribe': {
      const taken =
        result.chargedMilli && result.chargedMilli > 0
          ? ` ${formatMoney(result.chargedMilli)} was taken from your credit.`
          : ' Nothing was taken from your credit: the unused days covered it.';
      return `Your account is on ${tier} now, until ${on}.${taken}`;
    }
    case 'downgrade':
      return `You keep ${tier} until ${on}; then your subscription switches to ${labelOf(result.paid?.next)}.`;
    case 'cancel':
      return `${tier} is cancelled: it stays until ${on}, then your account returns to ${labelOf(result.base)}. Nothing more is taken.`;
    default:
      return `${tier} renews again on ${on}.`;
  }
}

/** A paid tier as Admin -> Accounts lists it (the server's `subscriptionBilling` on a row). */
export type BillingSummary = { paidThrough: string; renews: boolean; next: AccountSubscriptionId | null };

/** The line under an account's subscription on Admin -> Accounts: `Paid · renews 18/11/2026`. */
export function billingLine(billing: BillingSummary): string {
  const on = dayText(billing.paidThrough);
  if (!billing.renews) return `Paid · ends ${on}`;
  if (billing.next) return `Paid · switches to ${labelOf(billing.next)} ${on}`;
  return `Paid · renews ${on}`;
}

/**
 * What Admin -> Accounts asks before a change that ends a tier the account
 * pays for - setting its subscription, or moving its role away from user:
 * the server ends it at once and refunds nothing (its answer's note says how
 * much was unused).
 */
export function overrideQuestion(
  account: { email: string; subscription: unknown },
  billing: BillingSummary,
  change: 'subscription' | 'role'
): string {
  const what = change === 'role' ? 'Changing the role' : 'Setting the subscription here';
  return (
    `${account.email} pays for ${labelOf(account.subscription as AccountSubscriptionId)} from credit until ` +
    `${dayText(billing.paidThrough)}. ${what} ends that at once and refunds nothing.`
  );
}

/** The Cancel confirm's sentence: what stays, until when, where the account goes, and that nothing is refunded. */
export function cancelQuestion(view: SubscriptionView): string {
  const tier = labelOf(view.subscription);
  const on = view.paid ? dayText(view.paid.paidThrough) : 'the end of its 30 days';
  return `${tier} stays until ${on}, then your account returns to ${labelOf(view.base)}. Nothing is refunded.`;
}

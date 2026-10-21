import type { AdminAppSettings, AdminAppSettingsUpdate } from '@/lib/api';
import { describeDollarProblem, formatMoney, parseDollars, toDollarInput } from '@/lib/format';
import { SUBSCRIPTION_PRICE_REQUEST_FIELDS, type SubscriptionPriceKey } from '@/lib/settingSources';

/**
 * Settings -> General -> Subscriptions while it is being edited, with no
 * React in it (the payments page's limitDraft.ts pattern):
 * backend/test/frontendSettings.test.js runs it through the real route and
 * frontendMoney.test.js holds it to the money rules. The runtime imports are
 * lib/format.ts and lib/settingSources.ts.
 *
 * Each box is DOLLARS as typed ("9.99") - sent as typed, never a number the
 * page parsed, under the price's `...Usd` name - and an empty box is the
 * administrator's "not offered", which beats a price `.env` gives. The server
 * serves each price in thousandths (`premiumPriceMilli`, null = not offered).
 * A save sends only the boxes that changed: one sent unchanged would mark it
 * "Set here", frozen at the price `.env` gives today.
 *
 * A MONEY MODULE (test/frontendMoney.test.js): amounts are integer thousandths.
 */

/** The three prices, in the catalogue's order. */
export const SUBSCRIPTION_PRICE_KEYS = Object.keys(SUBSCRIPTION_PRICE_REQUEST_FIELDS) as SubscriptionPriceKey[];

/** Each price's subscription, as its box and its sentences name it. */
export const SUBSCRIPTION_PRICE_LABELS: Readonly<Record<SubscriptionPriceKey, string>> = {
  premiumPriceMilli: 'Premium',
  premiumPlusPriceMilli: 'Premium+',
  premiumMaxPriceMilli: 'Premium Max',
};

/** The most a subscription may cost for 30 days: $10,000 - the server's MAX_SUBSCRIPTION_PRICE_MILLI. */
export const MAX_SUBSCRIPTION_PRICE_MILLI = 10_000_000;

export type PriceDrafts = Record<SubscriptionPriceKey, string>;

/** A price in effect as the text of its box: '' for not offered. */
export function priceDraftOf(milli: number | null): string {
  return milli === null ? '' : toDollarInput(milli);
}

export function toPriceDrafts(settings: Pick<AdminAppSettings, SubscriptionPriceKey>): PriceDrafts {
  return {
    premiumPriceMilli: priceDraftOf(settings.premiumPriceMilli),
    premiumPlusPriceMilli: priceDraftOf(settings.premiumPlusPriceMilli),
    premiumMaxPriceMilli: priceDraftOf(settings.premiumMaxPriceMilli),
  };
}

/** What a box holds, as the price it would store: null for not offered ('' or $0), the text itself when it is not an amount. */
function typedPrice(text: string): number | null | string {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = parseDollars(trimmed);
  if (!parsed.ok) return trimmed;
  return parsed.milli === 0 ? null : parsed.milli;
}

/**
 * Why a box would be refused, in the server's own sentence - or null. Empty
 * is fine: it is "not offered".
 */
export function priceProblem(key: SubscriptionPriceKey, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const label = `The ${SUBSCRIPTION_PRICE_LABELS[key]} price`;
  const parsed = parseDollars(trimmed);
  if (!parsed.ok) return describeDollarProblem(parsed.problem, label);
  if (parsed.milli > MAX_SUBSCRIPTION_PRICE_MILLI) {
    return `${label} must be at most ${formatMoney(MAX_SUBSCRIPTION_PRICE_MILLI)}.`;
  }
  return null;
}

/** Every box's refusal, by price; empty when all of them would be accepted. */
export function priceProblems(drafts: PriceDrafts): Partial<Record<SubscriptionPriceKey, string>> {
  const problems: Partial<Record<SubscriptionPriceKey, string>> = {};
  for (const key of SUBSCRIPTION_PRICE_KEYS) {
    const problem = priceProblem(key, drafts[key]);
    if (problem) problems[key] = problem;
  }
  return problems;
}

/**
 * A save's body: of the three, only the boxes whose price differs from the
 * one in effect - "9.990" for a stored $9.99, or an empty box for one not
 * offered, is no change - each as typed under its `...Usd` name, '' for not
 * offered. Empty when nothing changed: then nothing is sent.
 */
export function priceChanges(
  drafts: PriceDrafts,
  settings: Pick<AdminAppSettings, SubscriptionPriceKey>
): Pick<AdminAppSettingsUpdate, 'premiumPriceUsd' | 'premiumPlusPriceUsd' | 'premiumMaxPriceUsd'> {
  const body: Record<string, string> = {};
  for (const key of SUBSCRIPTION_PRICE_KEYS) {
    if (typedPrice(drafts[key]) === settings[key]) continue;
    body[SUBSCRIPTION_PRICE_REQUEST_FIELDS[key]] = drafts[key].trim();
  }
  return body;
}

/** The price whose box a refusal's `field` names (`premiumPriceUsd`...), or null. */
export function priceKeyOfField(field: unknown): SubscriptionPriceKey | null {
  return SUBSCRIPTION_PRICE_KEYS.find((key) => SUBSCRIPTION_PRICE_REQUEST_FIELDS[key] === field) ?? null;
}

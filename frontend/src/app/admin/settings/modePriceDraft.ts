import type { AdminAppSettings, AdminAppSettingsUpdate } from '@/lib/api';
import { BUILD_MODE_LABELS, type BuildMode } from '@/lib/buildModes';
import { describeDollarProblem, MILLI_PER_DOLLAR, parseDollars, toDollarInput } from '@/lib/format';
import { MODE_PRICE_REQUEST_FIELDS, type ModePriceKey } from '@/lib/settingSources';

/**
 * Settings -> General -> Price per resume while it is being edited, with no
 * React in it (subscriptionPriceDraft.ts is its twin):
 * backend/test/frontendSettings.test.js runs it through the real route and
 * frontendMoney.test.js holds it to the money rules. The runtime imports are
 * lib/format.ts, lib/settingSources.ts and lib/buildModes.ts.
 *
 * What a resume costs is the price of the mode it is built in - Choose
 * Suitable Resume, Partial Tailor or Fully Tailor - whatever model runs it.
 * Each box is DOLLARS as typed ("0.023"), sent as typed under the price's
 * `...Usd` name, never a number the page parsed; the server serves each price
 * in thousandths (`partialPriceMilli`) and parses what was typed again, so it
 * is the one that decides. $0 is a price: the mode is free, on purpose. A
 * price is REQUIRED, though: an empty box is refused (Reset to default is the
 * button that returns to `.env`'s), as the server refuses it.
 *
 * A save sends only the boxes that changed: one sent unchanged would mark it
 * "Set here", frozen at the price `.env` gives today.
 *
 * A MONEY MODULE (test/frontendMoney.test.js): amounts are integer thousandths.
 */

/** The three prices, in the server's mode order: Choose Suitable Resume, Partial Tailor, Fully Tailor. */
export const MODE_PRICE_KEYS = Object.keys(MODE_PRICE_REQUEST_FIELDS) as ModePriceKey[];

/** The mode each price belongs to. */
const MODE_OF_KEY: Readonly<Record<ModePriceKey, BuildMode>> = {
  suitablePriceMilli: 'suitable',
  partialPriceMilli: 'partial',
  fullPriceMilli: 'full',
};

/** Each price's mode, as its box and its sentences name it. */
export const MODE_PRICE_LABELS: Readonly<Record<ModePriceKey, string>> = {
  suitablePriceMilli: BUILD_MODE_LABELS.suitable,
  partialPriceMilli: BUILD_MODE_LABELS.partial,
  fullPriceMilli: BUILD_MODE_LABELS.full,
};

/** The most a resume may cost in any mode: $1,000 - the server's MAX_BUILD_MODE_PRICE_MILLI. */
export const MAX_MODE_PRICE_MILLI = 1_000_000;

/** The words every refusal of a price ends with - the server's own (config/buildModes.ts `PRICE_RULE`). */
const PRICE_RULE = `from $0 to $${MAX_MODE_PRICE_MILLI / MILLI_PER_DOLLAR} in steps of $0.001, like 0.023; 0 makes it free`;

export type ModePriceDrafts = Record<ModePriceKey, string>;

/** The mode a price is for. */
export function modeOfPriceKey(key: ModePriceKey): BuildMode {
  return MODE_OF_KEY[key];
}

/** A price in effect as the text of its box. */
export function modePriceDraftOf(milli: number): string {
  return toDollarInput(milli);
}

export function toModePriceDrafts(settings: Pick<AdminAppSettings, ModePriceKey>): ModePriceDrafts {
  return {
    suitablePriceMilli: modePriceDraftOf(settings.suitablePriceMilli),
    partialPriceMilli: modePriceDraftOf(settings.partialPriceMilli),
    fullPriceMilli: modePriceDraftOf(settings.fullPriceMilli),
  };
}

/**
 * Why a box would be refused, in the server's own sentence
 * (`parseBuildModePriceInput`) - or null. Empty is refused: a price is
 * required, and $0 is typed as 0.
 */
export function modePriceProblem(key: ModePriceKey, text: string): string | null {
  const label = `The ${MODE_PRICE_LABELS[key]} price`;
  const parsed = parseDollars(text);
  if (!parsed.ok) return `${describeDollarProblem(parsed.problem, label)} It is ${PRICE_RULE}.`;
  if (parsed.milli < 0 || parsed.milli > MAX_MODE_PRICE_MILLI) return `${label} must be ${PRICE_RULE}.`;
  return null;
}

/** Every box's refusal, by price; empty when all of them would be accepted. */
export function modePriceProblems(drafts: ModePriceDrafts): Partial<Record<ModePriceKey, string>> {
  const problems: Partial<Record<ModePriceKey, string>> = {};
  for (const key of MODE_PRICE_KEYS) {
    const problem = modePriceProblem(key, drafts[key]);
    if (problem) problems[key] = problem;
  }
  return problems;
}

/**
 * A save's body: of the three, only the boxes whose price differs from the one
 * in effect - "0.050" for a stored $0.05 is no change - each as typed under its
 * `...Usd` name. A box that is not an amount is a change too (the page judges
 * it first and sends nothing). Empty when nothing changed: then nothing is sent.
 */
export function modePriceChanges(
  drafts: ModePriceDrafts,
  settings: Pick<AdminAppSettings, ModePriceKey>
): Pick<AdminAppSettingsUpdate, 'suitablePriceUsd' | 'partialPriceUsd' | 'fullPriceUsd'> {
  const body: Record<string, string> = {};
  for (const key of MODE_PRICE_KEYS) {
    const parsed = parseDollars(drafts[key]);
    if (parsed.ok && parsed.milli === settings[key]) continue;
    body[MODE_PRICE_REQUEST_FIELDS[key]] = drafts[key].trim();
  }
  return body;
}

/** The price whose box a refusal's `field` names (`partialPriceUsd`...), or null. */
export function modePriceKeyOfField(field: unknown): ModePriceKey | null {
  return MODE_PRICE_KEYS.find((key) => MODE_PRICE_REQUEST_FIELDS[key] === field) ?? null;
}

/** Whether a settings key is one of the three prices. */
export function isModePriceKey(key: string): key is ModePriceKey {
  return (MODE_PRICE_KEYS as readonly string[]).includes(key);
}

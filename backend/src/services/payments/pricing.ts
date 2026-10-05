import {
  DEFAULT_PAYMENT_LIMITS,
  getPurchaseSettings,
  type PaymentTargetLimits,
} from '../../config/aiModelConfig';
import { PublicError } from '../../middleware/publicError';
import { centsToMilli, formatMoney, isWholeCents, milliToCents, parseDollars } from '../../utils/money';

/**
 * What a purchase is, decided here and nowhere else.
 *
 * A CREDIT IS A DOLLAR. A buyer chooses an amount of money, is charged exactly
 * that, and is credited exactly that: $50 by card or by crypto is $50.000 of
 * credit. There is no price of a credit to multiply by and no fee taken out of
 * it (the owner's decisions M1 and M2) - so "what does this cost" and "what do
 * I get" are one number, and the receipt has nothing to explain.
 *
 * The rule this file still enforces: **the browser never sets its own terms.**
 * It sends the amount it wants, in dollars, and this module decides whether
 * that amount may be bought - by this method's bounds, in whole cents - and
 * what the provider is asked to charge. Both the checkout and the quote the
 * buy page displays call it, so the page cannot show a figure the server
 * would not charge.
 *
 * The bounds are part of the pricing, not a separate check. A field in a
 * browser will eventually receive `1e9`, `-1`, `2.505` and `"lots"`, and each
 * of those has to be a refusal with a reason rather than a strange order.
 */

/**
 * A purchase amount refused: the buyer's own choice, so it says what to choose
 * instead. There is no longer a configuration that leaves nothing to buy - the
 * 503 for "no whole number of credits fits these bounds" went with the price
 * of a credit - so every refusal here is the buyer's to act on.
 */
export class PriceError extends PublicError {
  constructor(message: string, status = 400) {
    super(message, { status });
    this.name = 'PriceError';
  }
}

export type Quote = {
  /** What the provider is asked to charge, in cents - what Stripe and Cryptomus take. */
  amountCents: number;
  /** The same charge in thousandths of a dollar, as every response carries money. */
  amountMilli: number;
  /** What the balance receives: exactly the charge. */
  creditMilli: number;
  currency: string;
  /** Which limits row decided this, for the log line and the receipt. */
  target: string;
};

/**
 * Which method, and which coin, a quote is for.
 *
 * Optional throughout, and when it is absent the CARD row applies rather than
 * "no bounds". Defaulting to unbounded is the bug this note exists to stop: a
 * caller that forgot to say what it was pricing would get the widest possible
 * band, which is the opposite of the safe direction.
 */
export type QuoteTarget = { method: 'card' | 'crypto'; asset?: string };

/** One method's bounds on a single purchase, in cents. */
export type ResolvedLimits = {
  target: string;
  currency: string;
  minAmountCents: number;
  maxAmountCents: number;
};

/**
 * Whether the operator has asked for every card payment to be authenticated.
 *
 * Its own accessor rather than a field on the limits, because it is not a
 * bound and folding it in would make that type mean "whatever the buy page
 * happens to need". Payments reads its settings through this module, so this
 * keeps that one door.
 */
export async function requireThreeDSecure(): Promise<boolean> {
  return (await getPurchaseSettings()).requireThreeDSecure;
}

/**
 * The names a row can carry that are METHODS rather than coins.
 *
 * One column holds both namespaces, and half of what goes looking in it
 * arrives from a browser - so the two have to be told apart here, in the one
 * place that decides what a purchase may be.
 */
const METHOD_TARGETS = new Set<string>(['card', 'crypto']);

function rowFor(rows: PaymentTargetLimits[], target?: QuoteTarget): PaymentTargetLimits | null {
  if (!target) {
    return rows.find((row) => row.target === 'card') ?? null;
  }
  /*
   * An asset may only ever match an ASSET row.
   *
   * Exact asset first, then the method: a per-coin row is an override, so an
   * operator can single one coin out without writing a row for every other.
   * But the asset is a string from the request, and without the guard below
   * `{ method: 'crypto', asset: 'card' }` bounds a crypto purchase by the
   * CARD row - the card's minimum, which is twenty times smaller. A request
   * that can choose its own limits is one step from a request that can choose
   * its own terms, which is the thing this module exists to make impossible.
   *
   * This is the ONLY lock now. `startCheckout` used to refuse an asset this
   * build did not know, before the coins went away and the request stopped
   * carrying one at all - so a stored row keyed on a coin can still be
   * resolved here, but nothing can ask for one by name.
   */
  if (target.asset && !METHOD_TARGETS.has(target.asset)) {
    const exact = rows.find((row) => row.target === target.asset);
    if (exact) return exact;
  }
  return rows.find((row) => row.target === target.method) ?? null;
}

/**
 * The bounds for one method, in cents.
 *
 * The method's own row, or - when an administrator removed it and kept the
 * other - the shipped default for that method. Not "no bounds": an unbounded
 * method is one somebody can send $100,000,000 through.
 */
export async function resolveLimits(target?: QuoteTarget): Promise<ResolvedLimits> {
  const settings = await getPurchaseSettings();
  const method = target?.method ?? 'card';
  const row =
    rowFor(settings.paymentLimits, target) ?? DEFAULT_PAYMENT_LIMITS.find((entry) => entry.target === method)!;
  return {
    target: row.target,
    currency: settings.currency,
    minAmountCents: row.minCents,
    maxAmountCents: row.maxCents,
  };
}

/**
 * The buttons to offer, as amounts in thousandths of a dollar.
 *
 * The configured presets, less any outside the bounds - dropped rather than
 * clamped: two buttons both reading $2.500 because they clamped to the same
 * floor is worse than one. What a button says is what it charges and what it
 * credits; there is nothing left to round.
 */
export async function presetsFor(target?: QuoteTarget): Promise<Array<{ amountMilli: number }>> {
  const settings = await getPurchaseSettings();
  const limits = await resolveLimits(target);
  const method = target?.method ?? 'card';
  const row =
    rowFor(settings.paymentLimits, target) ?? DEFAULT_PAYMENT_LIMITS.find((entry) => entry.target === method)!;

  return row.presetsCents
    .filter((cents) => cents >= limits.minAmountCents && cents <= limits.maxAmountCents)
    .map((cents) => ({ amountMilli: centsToMilli(cents) }));
}

/** What a buyer is told about an amount that is not one. */
const CHOOSE_AN_AMOUNT = 'Choose an amount in dollars and cents, like 25 or 12.50.';

/**
 * Prices a purchase of `requestedUsd` dollars, or refuses it by name.
 *
 * Dollars as the buyer typed them ("12.50") or a JSON number (12.5), read
 * EXACTLY by utils/money's parser - never `parseFloat`, which reads "25abc" as
 * 25 and "1e3" as 1000: a purchase the person did not ask for at an amount
 * they did not see. Whole cents only, because that is what a card or a crypto
 * invoice can be asked to charge; $12.505 is refused rather than charged as
 * $12.50 or $12.51.
 */
export async function quotePurchase(requestedUsd: unknown, target?: QuoteTarget): Promise<Quote> {
  const limits = await resolveLimits(target);

  const parsed = parseDollars(requestedUsd);
  if (!parsed.ok || !isWholeCents(parsed.milli) || parsed.milli <= 0) {
    throw new PriceError(CHOOSE_AN_AMOUNT);
  }

  const amountCents = milliToCents(parsed.milli);
  const method = target?.method === 'crypto' ? 'crypto' : 'card';
  if (amountCents < limits.minAmountCents) {
    throw new PriceError(`The smallest ${method} purchase is ${formatMoney(centsToMilli(limits.minAmountCents))}.`);
  }
  if (amountCents > limits.maxAmountCents) {
    throw new PriceError(`The largest ${method} purchase is ${formatMoney(centsToMilli(limits.maxAmountCents))}.`);
  }

  return {
    amountCents,
    amountMilli: parsed.milli,
    // A credit is a dollar and nothing is taken out: the balance receives
    // exactly what the provider charges.
    creditMilli: parsed.milli,
    currency: limits.currency,
    target: limits.target,
  };
}

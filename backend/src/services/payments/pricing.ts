import { getCreditPricingSettings, type PaymentTargetLimits } from '../../config/aiModelConfig';

/**
 * What a number of credits costs, decided here and nowhere else.
 *
 * The rule this file exists to enforce: **the browser sends a count, never an
 * amount.** A request carrying its own price is a request that sets its own
 * price, and no amount of validation elsewhere makes that safe - so there is
 * one function that turns credits into money, and both the checkout and the
 * quote the buy page displays call it. The page cannot show a price the server
 * would not charge, because it is not the page that works the price out.
 *
 * The bounds are part of the pricing, not a separate check. An integer field in
 * a browser will eventually receive `1e9`, `-1`, `2.5` and `"lots"`, and each
 * of those has to be a refusal with a reason rather than a strange order.
 */

export class PriceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PriceError';
    this.status = status;
  }
}

export type Quote = {
  /** What the ledger will be credited: the gross, less the fee, floored. */
  credits: number;
  /** What the buyer chose, before the fee. */
  grossCredits: number;
  unitPriceCents: number;
  /** What is charged - always the gross. A fee never inflates the charge. */
  amountCents: number;
  feeCents: number;
  currency: string;
  /** Which limits row decided this, for the log line and the receipt. */
  target: string;
};

export type PricingLimits = {
  unitPriceCents: number;
  minCredits: number;
  maxCredits: number;
  currency: string;
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

export type ResolvedLimits = PricingLimits & {
  target: string;
  minAmountCents: number;
  maxAmountCents: number;
  feeBps: number;
  feeFixedCents: number;
};

export async function getPricingLimits(): Promise<PricingLimits> {
  const settings = await getCreditPricingSettings();
  return {
    unitPriceCents: settings.creditPriceCents,
    minCredits: settings.creditMinCredits,
    maxCredits: settings.creditMaxCredits,
    currency: settings.currency,
  };
}

/**
 * The names a row can carry that are METHODS rather than coins.
 *
 * One column holds both namespaces, and half of what goes looking in it
 * arrives from a browser - so the two have to be told apart here, in the one
 * place that decides what a purchase costs.
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
   * `{ method: 'crypto', asset: 'card' }` prices a crypto purchase off the
   * CARD row - the card's minimum, which is twenty times smaller, and the
   * card's fee, which is nothing. A request that can choose its own limits is
   * one step from a request that can choose its own price, which is the thing
   * this module exists to make impossible.
   *
   * `startCheckout` also refuses an asset this build does not know, so this is
   * the second of two locks rather than the only one. It is here as well as
   * there because this function is the pricing authority: anything that calls
   * it later, by any route, gets the same answer.
   */
  if (target.asset && !METHOD_TARGETS.has(target.asset)) {
    const exact = rows.find((row) => row.target === target.asset);
    if (exact) return exact;
  }
  return rows.find((row) => row.target === target.method) ?? null;
}

/**
 * The bounds for one target, in credits and in cents.
 *
 * The conversion rounds in the only direction that cannot escape the
 * operator's band: UP on the floor, DOWN on the ceiling. Rounding a $2.50
 * minimum down to 4 credits at 60c each would offer a $2.40 purchase the
 * operator said was too small.
 *
 * When that inverts - a price so high that no whole number of credits fits
 * between the two - the target is refused BY NAME at 503, because it is a
 * misconfiguration and not the buyer's mistake. The alternative is a buy page
 * that rejects every amount somebody tries and never says why.
 */
export async function resolveLimits(target?: QuoteTarget): Promise<ResolvedLimits> {
  const settings = await getCreditPricingSettings();
  const unitPriceCents = settings.creditPriceCents;
  const row = rowFor(settings.paymentLimits, target);

  const configuredMinCents = row ? row.minCents : unitPriceCents * settings.creditMinCredits;
  const configuredMaxCents = row ? row.maxCents : unitPriceCents * settings.creditMaxCredits;

  const minCredits = Math.max(
    settings.creditMinCredits,
    Math.ceil(configuredMinCents / unitPriceCents)
  );
  const maxCredits = Math.min(
    settings.creditMaxCredits,
    Math.floor(configuredMaxCents / unitPriceCents)
  );

  const name = row?.target ?? target?.asset ?? target?.method ?? 'card';

  if (minCredits > maxCredits) {
    throw new PriceError(
      `${name} purchases are not available: at ${unitPriceCents}c per credit no whole ` +
        'number of credits falls inside the configured amounts. Change the price or the ' +
        'limits under Admin - Payments.',
      503
    );
  }

  return {
    unitPriceCents,
    minCredits,
    maxCredits,
    currency: settings.currency,
    target: name,
    /*
     * The band that is ENFORCED, not the one that was configured.
     *
     * These two figures are what the buy page prints beside a method, and the
     * credit counts above are what a checkout is actually judged against - so
     * they have to be the same band said twice. Returning the row's raw cents
     * instead meant a card section advertising "$2.50 – $100.00" while the
     * smallest purchase the server would take was $5.00, because a global
     * floor of 10 credits at 50c each outranks a row's $2.50. Somebody reading
     * the page, choosing $2.50 and being refused would have been right and the
     * page wrong.
     */
    minAmountCents: minCredits * unitPriceCents,
    maxAmountCents: maxCredits * unitPriceCents,
    feeBps: row?.feeBps ?? 0,
    feeFixedCents: row?.feeFixedCents ?? 0,
  };
}

/**
 * The buttons to offer, as counts of credits.
 *
 * The configured presets are an INTENTION in cents; what comes back is whole
 * credits and what they actually cost. So at 40c a credit the operator's $2.50
 * button becomes 6 credits and reads $2.40 - a figure the server will really
 * charge, rather than a round number it would refuse.
 *
 * Rounding is UP, the same direction as the floor, and that is not arbitrary.
 * An operator who sets a $2.50 minimum and offers a $2.50 button means them to
 * be the same button; rounding to nearest turns $2.50 at 40c a credit into 6
 * credits, which is $2.40, which is below the floor they just set - so the
 * button they configured silently disappears. Rounding up lands it exactly on
 * the floor instead, and no preset is ever cheaper than the operator asked.
 *
 * Anything still outside the bounds is dropped rather than clamped: two buttons
 * both reading $2.80 because they clamped to the same floor is worse than one.
 */
export async function presetsFor(
  target?: QuoteTarget
): Promise<Array<{ credits: number; amountCents: number }>> {
  const settings = await getCreditPricingSettings();
  const limits = await resolveLimits(target);
  const row = rowFor(settings.paymentLimits, target);
  const unit = limits.unitPriceCents;

  const seen = new Set<number>();
  const presets: Array<{ credits: number; amountCents: number }> = [];

  for (const cents of row?.presetsCents ?? []) {
    const credits = Math.ceil(cents / unit);
    if (credits < limits.minCredits || credits > limits.maxCredits) continue;
    if (seen.has(credits)) continue;
    seen.add(credits);
    presets.push({ credits, amountCents: credits * unit });
  }

  return presets;
}

/**
 * The fee, and what is left to credit.
 *
 * The fee rounds UP and the credits round DOWN, so the residue - at most one
 * credit's price less a cent - stays with the house. That is a choice, and the
 * reason to write it down rather than pick the flattering direction: rounding
 * the other way hands out a credit whose cash never arrived, and a credit is a
 * rendered resume with a real cost behind it.
 *
 * What the buyer is shown is `credits * unitPriceCents`, not `netCents`, so the
 * figure on the summary is exactly what lands on the balance.
 */
export function applyFee(
  grossCredits: number,
  unitPriceCents: number,
  feeBps: number,
  feeFixedCents: number
): { credits: number; feeCents: number } {
  const amountCents = grossCredits * unitPriceCents;
  if (feeBps <= 0 && feeFixedCents <= 0) {
    return { credits: grossCredits, feeCents: 0 };
  }

  const feeCents = Math.min(
    amountCents,
    Math.ceil((amountCents * feeBps) / 10_000) + feeFixedCents
  );
  const credits = Math.floor((amountCents - feeCents) / unitPriceCents);
  return { credits, feeCents };
}

/**
 * Prices a request, or refuses it by name.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger`, because the product
 * below has to stay exact: past 2^53 an integer multiplication silently stops
 * being the number you asked for, and the one place that must never happen is
 * the one that decides what to charge.
 */
export async function quoteCredits(requested: unknown, target?: QuoteTarget): Promise<Quote> {
  const limits = await resolveLimits(target);

  /*
   * Digits, or a number. Nothing in between.
   *
   * `parseFloat` would read "25abc" as 25 and "1e3" as 1000, which is a
   * purchase the person did not ask for arriving at a price they did not see.
   * A field that should hold a count of credits either holds one or is a
   * refusal with a reason.
   */
  let credits: number;
  if (typeof requested === 'number') {
    credits = requested;
  } else if (typeof requested === 'string' && /^\s*\d+\s*$/.test(requested)) {
    credits = Number(requested.trim());
  } else {
    throw new PriceError('Choose a whole number of credits.');
  }

  if (!Number.isFinite(credits) || !Number.isSafeInteger(credits)) {
    throw new PriceError('Choose a whole number of credits.');
  }
  if (credits < limits.minCredits) {
    throw new PriceError(`The smallest purchase is ${limits.minCredits} credits.`);
  }
  if (credits > limits.maxCredits) {
    throw new PriceError(`The largest purchase is ${limits.maxCredits} credits.`);
  }

  const amountCents = credits * limits.unitPriceCents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new PriceError('That amount cannot be charged.');
  }

  const { credits: netCredits, feeCents } = applyFee(
    credits,
    limits.unitPriceCents,
    limits.feeBps,
    limits.feeFixedCents
  );

  /*
   * A fee that swallows the whole purchase is refused rather than charged.
   *
   * Taking money and crediting nothing is the one outcome worse than refusing
   * the sale, and at a small enough amount a fixed fee does exactly that.
   */
  if (netCredits <= 0) {
    throw new PriceError(
      'That amount is too small once the transaction fee is taken. Choose a larger amount.'
    );
  }

  return {
    credits: netCredits,
    grossCredits: credits,
    unitPriceCents: limits.unitPriceCents,
    amountCents,
    feeCents,
    currency: limits.currency,
    target: limits.target,
  };
}

/** `$12.50`, for a log line or a page. Money is never formatted by hand. */
export function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    // An unknown currency code should not take a page down over a label.
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

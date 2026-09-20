import { getCreditPricingSettings } from '../../config/aiModelConfig';

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
  credits: number;
  unitPriceCents: number;
  amountCents: number;
  currency: string;
};

export type PricingLimits = {
  unitPriceCents: number;
  minCredits: number;
  maxCredits: number;
  currency: string;
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
 * Prices a request, or refuses it by name.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger`, because the product
 * below has to stay exact: past 2^53 an integer multiplication silently stops
 * being the number you asked for, and the one place that must never happen is
 * the one that decides what to charge.
 */
export async function quoteCredits(requested: unknown): Promise<Quote> {
  const limits = await getPricingLimits();

  const credits =
    typeof requested === 'number'
      ? requested
      : Number.parseFloat(String(requested ?? '').trim());

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

  return {
    credits,
    unitPriceCents: limits.unitPriceCents,
    amountCents,
    currency: limits.currency,
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

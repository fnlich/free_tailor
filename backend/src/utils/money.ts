/**
 * Money, as this application counts it: whole thousandths of a US dollar.
 *
 * A credit is a dollar, and a resume is priced in steps of $0.001, so every
 * amount that moves - a balance, a price, a charge, a refund, a purchase - is
 * an INTEGER count of milli-dollars: $0.023 is 23, $50 is 50000. Never a
 * float, and never a decimal string in arithmetic. The reason is not
 * pedantry: SQLite stores a REAL in an INTEGER column without a word, and ten
 * $0.10 grants added as floats come to 0.9999999999999999, so somebody holding
 * exactly a dollar could not buy a one-dollar resume.
 *
 * Text becomes milli in exactly one place (`parseDollars`) and milli becomes
 * text in exactly one place (`formatMoney`), and neither goes through a float:
 * "0.023" is read as the digits 0 and 023, never as `parseFloat("0.023") *
 * 1000`, which is 22.999999999999996 on some inputs and floors to the wrong
 * price. The frontend's `lib/format.ts` mirrors both, rule for rule.
 *
 * A leaf on purpose: the env reader, the price-per-resume rules, the credit
 * service and the payments module all read it, and it imports nothing.
 */

/** Thousandths of a dollar in one dollar. A credit is a dollar. */
export const MILLI_PER_DOLLAR = 1000;

/** Thousandths of a dollar in one cent - what a card or a crypto invoice charges in. */
export const MILLI_PER_CENT = 10;

/**
 * The widest whole-dollar part `parseDollars` reads: a trillion dollars, far
 * past any figure this app has a use for, and short enough that the integer
 * arithmetic below cannot leave the range a double holds exactly.
 */
const MAX_WHOLE_DIGITS = 12;

/** Why a dollar amount was refused, for the caller to put into its own sentence. */
export type DollarProblem = 'empty' | 'format' | 'precision' | 'negative' | 'range';

export type DollarParse = { ok: true; milli: number } | { ok: false; problem: DollarProblem };

/**
 * Optional sign, optional `$`, digits, an optional point and fraction digits.
 * The fraction may be any length HERE and is counted after the match, so
 * "0.0235" is refused for its precision - which is what the person needs to
 * hear - rather than as an unreadable string.
 */
const DOLLAR_TEXT = /^([+-])?\s*\$?\s*(\d*)(?:\.(\d*))?$/;

/**
 * Dollars, as a person types them, to an exact count of milli-dollars.
 *
 * Takes text ("0.023", "$12.50", "-1", ".5") or a JSON number (0.023). A
 * number is read through its shortest decimal spelling, `String(0.023)` being
 * "0.023", so a value typed with three decimals arrives as exactly those
 * digits - and one that is not what it looks like (0.1 + 0.2) is refused for
 * its precision rather than rounded into something nobody typed.
 *
 * At most THREE decimal places: $0.001 is the smallest step anything here is
 * priced in, and "0.0235" is a price this application cannot charge, so it is
 * refused rather than rounded either way. No thousands separators - "1,000" is
 * ambiguous across locales - and no exponents.
 *
 * Negative only when the caller allows it (an administrator taking credit
 * away); "-0" is zero.
 */
export function parseDollars(value: unknown, options: { allowNegative?: boolean } = {}): DollarParse {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, problem: 'format' };
    text = String(value);
    // An exponent is how a double spells anything very small or very large.
    if (/e/i.test(text)) return { ok: false, problem: Math.abs(value) < 1 ? 'precision' : 'range' };
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return { ok: false, problem: value === undefined || value === null ? 'empty' : 'format' };
  }
  if (!text) return { ok: false, problem: 'empty' };

  const match = DOLLAR_TEXT.exec(text);
  if (!match) return { ok: false, problem: 'format' };
  const [, sign, whole = '', fraction = ''] = match;
  if (!whole && !fraction) return { ok: false, problem: 'format' };
  if (fraction.length > 3) return { ok: false, problem: 'precision' };

  const wholeDigits = whole.replace(/^0+(?=\d)/, '');
  if (wholeDigits.length > MAX_WHOLE_DIGITS) return { ok: false, problem: 'range' };

  const magnitude = Number(wholeDigits || '0') * MILLI_PER_DOLLAR + Number(fraction.padEnd(3, '0'));
  if (!Number.isSafeInteger(magnitude)) return { ok: false, problem: 'range' };

  if (sign === '-' && magnitude > 0) {
    if (!options.allowNegative) return { ok: false, problem: 'negative' };
    return { ok: true, milli: -magnitude };
  }
  return { ok: true, milli: magnitude };
}

/**
 * The sentence for a refused amount, naming what was being typed.
 *
 * Every refusal reads the same way wherever it happens, so an administrator
 * who meets "can have at most three decimal places" on a model's price meets
 * the same words on a balance.
 */
export function describeDollarProblem(problem: DollarProblem, label: string): string {
  switch (problem) {
    case 'empty':
      return `${label} is required: an amount in dollars, like 0.023.`;
    case 'precision':
      return `${label} can have at most three decimal places: $0.001 is the smallest step.`;
    case 'negative':
      return `${label} cannot be negative.`;
    case 'range':
      return `${label} is too large.`;
    default:
      return `${label} must be an amount in dollars, like 0.023 or 12.50.`;
  }
}

/**
 * A decimal amount a PROVIDER reported ("12.50", "12.5", "12.50000000", or the
 * JSON number 12.5) as an exact count of cents - or null when it is not one.
 *
 * Not `parseDollars`: a provider is not a person, may pad its figures with
 * trailing zeros past any precision this app uses, and is compared for
 * EQUALITY against what it was asked to charge. So any number of decimals is
 * read, but a non-zero digit past the cents ("12.505") makes it not a whole
 * number of cents, and null - which the caller holds for a person rather than
 * rounding into a match. Never `Math.round(parseFloat(x) * 100)`, which reads
 * "12.50abc" as 1250 and "12.505" as 1250 too.
 */
export function parseProviderCents(value: unknown): number | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return null;
  const match = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (/[1-9]/.test(fraction.slice(2))) return null;
  if (whole.replace(/^0+(?=\d)/, '').length > MAX_WHOLE_DIGITS) return null;
  const cents = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A count of cents - what Stripe and Cryptomus charge in - as milli-dollars. */
export function centsToMilli(cents: number): number {
  return cents * MILLI_PER_CENT;
}

/** True when an amount is a whole number of cents, which is all a card or an invoice can charge. */
export function isWholeCents(milli: number): boolean {
  return Number.isSafeInteger(milli) && milli % MILLI_PER_CENT === 0;
}

/**
 * The largest whole number of cents in a non-negative amount, as milli-dollars:
 * $39.977 is $39.970.
 *
 * For the ONE place money leaves as cents without having arrived that way: a
 * purchase refunded in part gives back its unspent balance, and a balance moves
 * in $0.001 steps while a card - or a crypto invoice - can only return whole
 * cents. Rounding DOWN is the only honest direction: the seven tenths of a cent
 * stay on the balance as credit rather than being paid out as money nobody
 * held. Exact integer arithmetic, not a float divided and floored.
 */
export function wholeCentsBelow(milli: number): number {
  if (!Number.isSafeInteger(milli) || milli <= 0) return 0;
  return milli - (milli % MILLI_PER_CENT);
}

/**
 * Milli-dollars as cents, for an amount already known to be whole cents.
 *
 * Throws rather than rounding: a purchase of $2.505 must have been refused
 * before it got here, and quietly charging $2.51 or $2.50 for it would be a
 * price nobody was shown.
 */
export function milliToCents(milli: number): number {
  if (!isWholeCents(milli)) throw new Error(`${milli} thousandths of a dollar is not a whole number of cents.`);
  return milli / MILLI_PER_CENT;
}

/**
 * Milli-dollars as a person reads them: `$0.023`, `$3.977`, `$1,250`, `$4.1`,
 * `$0`, `-$0.046`.
 *
 * Every digit that is not a trailing zero, and nothing else: charges move in
 * $0.001 steps, so a balance shown as "$3.98" after a $0.023 charge would hide
 * the very digit that moved, while "$1.000" for a dollar reads as a thousand to
 * most people (the owner's report). So the fraction keeps its significant
 * digits - never rounded - and drops the zeros after them, and a bare dot with
 * them. Built from the integer's digits, never from a float.
 */
export function formatMoney(milli: number): string {
  // An amount is always a whole number of thousandths; anything else is a bug
  // upstream, and a sentence that says "$NaN" helps nobody find it. This path
  // only ever DISPLAYS - nothing reads a figure back out of it.
  const whole = Number.isSafeInteger(milli) ? milli : Math.round(Number(milli) || 0);
  const negative = whole < 0;
  const digits = String(Math.abs(whole)).padStart(4, '0');
  const dollars = digits.slice(0, -3).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return `${negative ? '-' : ''}$${dollars}${fraction ? `.${fraction}` : ''}`;
}

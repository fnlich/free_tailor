/**
 * Rendering what the server sends for a reader: a timestamp here, and money -
 * with the one parser for a dollar amount typed into a page - further down.
 * Imports nothing at runtime, so backend/test can load it on its own.
 *
 * Seven pages had written their own `formatDate`, and they disagreed in three
 * ways that all turned out to be deliberate: what an absent value shows, what
 * an unreadable one shows, and how much of the date to print. Those are the two
 * options below, so one function covers all seven rather than seven functions
 * covering one each.
 *
 * Every timestamp reaching this comes from the API as an ISO string, and the
 * output is the VIEWER's locale - deliberately, because these are read by the
 * person the row belongs to. The server formats in `en-US` where it has to name
 * an amount in a log; that is the other direction and stays separate.
 */

export type DateStyle =
  /** Date and time, the default: `27/09/2026, 14:03:12`. */
  | 'full'
  /** Date only, for a column where the time is noise: `27/09/2026`. */
  | 'date'
  /** Compact date and time for a dense list: `27 Sep, 14:03`. */
  | 'short';

export function formatDate(
  value?: string,
  options: { empty?: string; style?: DateStyle } = {}
): string {
  /*
   * Nothing to format. `empty` is what to say instead - "Never" for a
   * last-seen column, "-" for a table cell - and where a caller names none the
   * value is handed back untouched, which is what the callers taking a
   * non-optional string always did.
   */
  if (!value) return options.empty ?? '';

  /*
   * An unreadable timestamp shows the raw string, NOT "Invalid Date".
   *
   * Six of the seven copies guarded this; `admin/prompts` did not, and rendered
   * the literal words `Invalid Date` to an administrator - which says nothing
   * about which row is wrong. The raw value at least identifies it.
   */
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;

  if (options.style === 'date') return at.toLocaleDateString();
  if (options.style === 'short') {
    return at.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return at.toLocaleString();
}

/* ------------------------------------------------------------------ money */

/*
 * Money, as the server counts it: whole THOUSANDTHS of a US dollar.
 *
 * A credit is a dollar, and a resume is priced in steps of $0.001, so every
 * amount the API sends is an integer in a field ending `Milli` - $0.023 is 23,
 * $50 is 50000 - and every amount a page sends back is dollars, as the person
 * typed them, in a field ending `Usd`. This block is the browser's half of
 * backend/src/utils/money.ts and mirrors it rule for rule: the same parser, the
 * same refusals in the same words, the same formatter. backend/test/
 * frontendMoney.test.js runs both over the same inputs and fails on any
 * difference, because a box that accepts "0.0235" and a server that refuses it
 * is a form that cannot be saved and does not say why.
 *
 * Nothing here goes through a float. "0.023" is read as the digits 0 and 023,
 * never as `parseFloat("0.023") * 1000`, and a figure is printed from the
 * integer's digits, never from `toFixed` - a balance shown as $3.98 after a
 * $0.023 charge would hide the very digit that moved.
 */

/** Thousandths of a dollar in one dollar. A credit is a dollar. */
export const MILLI_PER_DOLLAR = 1000;

/** Thousandths of a dollar in one cent - what a card or a crypto invoice charges in. */
export const MILLI_PER_CENT = 10;

/** As the server's: a trillion dollars, short enough that the sums below stay exact. */
const MAX_WHOLE_DIGITS = 12;

/** Why a dollar amount was refused, for `describeDollarProblem` to put into words. */
export type DollarProblem = 'empty' | 'format' | 'precision' | 'negative' | 'range';

export type DollarParse = { ok: true; milli: number } | { ok: false; problem: DollarProblem };

/** Optional sign, optional `$`, digits, an optional point and fraction digits - counted after the match. */
const DOLLAR_TEXT = /^([+-])?\s*\$?\s*(\d*)(?:\.(\d*))?$/;

/**
 * Dollars, as a person types them, to an exact count of thousandths - or the
 * reason they are not an amount.
 *
 * The server's `parseDollars`, copied: at most THREE decimal places ("0.0235"
 * is refused for its precision, never rounded either way), no thousands
 * separators, no exponents, negative only where the caller allows it. A page
 * checks with this before sending so the refusal names the field at once, and
 * then sends what was TYPED - the server parses it again and is the one that
 * decides.
 */
export function parseDollars(value: unknown, options: { allowNegative?: boolean } = {}): DollarParse {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, problem: 'format' };
    text = String(value);
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

/** The server's sentence for a refused amount, word for word, naming what was being typed. */
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

/** True when an amount is a whole number of cents, which is all a card or an invoice can charge. */
export function isWholeCents(milli: number): boolean {
  return Number.isSafeInteger(milli) && milli % MILLI_PER_CENT === 0;
}

/**
 * An amount's digits, split where a person reads them: the sign, the whole
 * dollars with their thousands commas, and the fraction as all THREE digits.
 * Built from the integer's digits, never from a float. Private, so the
 * helpers that need a fixed number of decimals - a dollar box, a legacy unit
 * price - do not depend on how `formatMoney` happens to print.
 */
function moneyParts(milli: number): { negative: boolean; dollars: string; fraction3: string } {
  // Display only. A value that is not a whole number of thousandths is a bug
  // upstream, and "$NaN" helps nobody find it.
  const whole = Number.isSafeInteger(milli) ? milli : Math.round(Number(milli) || 0);
  const digits = String(Math.abs(whole)).padStart(4, '0');
  return {
    negative: whole < 0,
    dollars: digits.slice(0, -3).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    fraction3: digits.slice(-3),
  };
}

/**
 * Thousandths of a dollar as a person reads them: `$0.023`, `$3.977`, `$1`,
 * `$4.1`, `$0`, `$1,234.5`, `-$0.046`. A copy of the server's (utils/money.ts),
 * run against it by test/frontendMoney.test.js.
 *
 * Every digit that is not a trailing zero, and nothing else - the owner's
 * rule. Charges move in $0.001 steps, so a figure rounded for display would
 * hide the very digit that moved and not add up against the history beneath
 * it, while "$1.000" for a dollar reads as a thousand to most people. So the
 * fraction keeps its significant digits, never rounded, and drops the zeros
 * after them, and a bare dot with them. Not `Intl.NumberFormat`, which would
 * round to the currency's two places, and not the viewer's locale: the same
 * digits the server writes into its own sentences ("This needs $0.161 of
 * credit"), so a balance on this page and the refusal that names it read
 * alike.
 */
export function formatMoney(milli: number): string {
  const { negative, dollars, fraction3 } = moneyParts(milli);
  const fraction = fraction3.replace(/0+$/, '');
  return `${negative ? '-' : ''}$${dollars}${fraction ? `.${fraction}` : ''}`;
}

/** `+$0.023` / `-$0.046`: a movement, with its sign visible without reading the colour. */
export function formatSignedMoney(milli: number): string {
  return milli > 0 ? `+${formatMoney(milli)}` : formatMoney(milli);
}

/**
 * An amount as the text to put back into a dollar input: `0.023`, `2.50`,
 * `50.00`. Two decimals when the amount is whole cents and three when it is
 * not, so a purchase box reads like money and a price keeps its third digit -
 * and either one parses back to exactly the same amount. No commas, which
 * parseDollars refuses.
 */
export function toDollarInput(milli: number): string {
  const { negative, dollars, fraction3 } = moneyParts(milli);
  const fraction = isWholeCents(milli) ? fraction3.slice(0, 2) : fraction3;
  return `${negative ? '-' : ''}${dollars.replace(/,/g, '')}.${fraction}`;
}

/**
 * A price per credit from BEFORE credits were dollars, as its receipt printed
 * it: whole cents, `$0.50`. Only for that one line - "200 Credits at $0.50
 * each" - which a receipt has to keep saying, because it is what was sold, in
 * the two decimals it was sold in (never `$0.5`). Every other amount is
 * `formatMoney`.
 */
export function formatLegacyUnitPrice(milli: number): string {
  if (!isWholeCents(milli)) return formatMoney(milli);
  const { negative, dollars, fraction3 } = moneyParts(milli);
  return `${negative ? '-' : ''}$${dollars}.${fraction3.slice(0, 2)}`;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What a run costs, as the builder's cost line says it:
 * `7 resumes × $0.023 = $0.161`.
 *
 * The server's quote names a single price only when every resume in the run
 * costs the same - profiles in a group can resolve to different models - and
 * then the line shows the multiplication, so the total can be checked by eye.
 * A mixed run says the total alone (`7 resumes = $0.161`) rather than an
 * average that no model actually costs.
 */
export function describeRunCost(quote: {
  resumes: number;
  costMilli: number;
  pricePerResumeMilli: number | null;
}): string {
  const resumes = countOf(quote.resumes, 'resume');
  if (quote.pricePerResumeMilli !== null && quote.resumes > 0) {
    return `${resumes} × ${formatMoney(quote.pricePerResumeMilli)} = ${formatMoney(quote.costMilli)}`;
  }
  return `${resumes} = ${formatMoney(quote.costMilli)}`;
}

import { describeDollarProblem, formatMoney, parseDollars } from '../utils/money';

/**
 * What one resume costs on a given model, in thousandths of a dollar.
 *
 * Each model record carries its own `pricePerResumeMilli`, set by an
 * administrator under Admin -> Models in dollars ("0.023") and stored as the
 * integer 23. A credit IS a dollar, so there is no second "price of a credit"
 * to multiply this by; a resume on a $0.023 model takes $0.023 off a balance,
 * and seven of them take $0.161, exactly.
 *
 * It replaced `creditsPerResume`, a whole number of credits at whatever a
 * credit then cost. That field is never read as a price: it was in another
 * unit, and every balance it was spent from was reset to $0 when credits
 * became dollars (database/dollarSwitch.ts). A stored record that still
 * carries it, and no `pricePerResumeMilli`, reads as FREE - see below.
 *
 * A leaf on purpose. The model settings read it to normalize a record and the
 * admin routes to parse one, and neither may import the other.
 */

/** Zero makes a model free. A free run takes no reservation and writes no ledger row. */
export const MIN_PRICE_PER_RESUME_MILLI = 0;

/**
 * $1000.000. A ceiling, because the value arrives from a form and a field with
 * no ceiling is a field somebody will type 1000000 into - after which every
 * resume on that model is refused for want of a balance nobody could hold.
 */
export const MAX_PRICE_PER_RESUME_MILLI = 1_000_000;

const warnedStoredValues = new Set<string>();

/**
 * A stored record's price, as the settings READ takes it. Never throws.
 *
 * ABSENT IS FREE, not some default price. There is no default on purpose: a
 * model is priced by an administrator, and every record without a price is
 * either one priced before credits were dollars - reset to $0.000 by the
 * owner's decision - or a seed a migration added, which nobody has priced
 * yet. Admin -> Models lists every enabled model at $0.000 in red
 * (`freeEnabledModelIds`), so "free because nobody set a price" is visible
 * rather than a silent default.
 *
 * Junk - a string that is not digits, a fraction of a thousandth, a negative -
 * also reads as $0.000, and is said once in the log naming the record so the
 * fix can be found; out of range clamps. Forgiving where an admin's save is
 * strict, for the reason the rest of the stored row is: one hand-edited record
 * refusing to parse would fail every settings read, including the page an
 * administrator would fix it from. Nothing is written back.
 */
export function readPricePerResumeMilli(value: unknown, recordId = ''): number {
  if (value === undefined || value === null) return MIN_PRICE_PER_RESUME_MILLI;

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
  const read = !Number.isSafeInteger(parsed) || parsed < 0
    ? MIN_PRICE_PER_RESUME_MILLI
    : Math.min(MAX_PRICE_PER_RESUME_MILLI, parsed);

  if (read !== value) {
    const key = `${recordId}:${String(value)}`;
    if (!warnedStoredValues.has(key)) {
      warnedStoredValues.add(key);
      console.warn(
        `[models] Stored model "${recordId || '(no id)'}" has pricePerResumeMilli ${JSON.stringify(value)}, ` +
          `which is not a whole number of thousandths of a dollar from ${MIN_PRICE_PER_RESUME_MILLI} to ` +
          `${MAX_PRICE_PER_RESUME_MILLI}; it is read as ${formatMoney(read)}. Saving the model's price under ` +
          'Admin -> Models stores a valid one.'
      );
    }
  }
  return read;
}

/** The words every refusal of an administrator's price ends with. */
const PRICE_RULE =
  `from ${formatMoney(MIN_PRICE_PER_RESUME_MILLI)} to ${formatMoney(MAX_PRICE_PER_RESUME_MILLI)} in steps of ` +
  '$0.001, like 0.023; 0 makes the model free';

/**
 * An administrator's price for a model they are creating or editing, in
 * DOLLARS (`pricePerResumeUsd`: "0.023" or the JSON number 0.023), as an exact
 * count of thousandths.
 *
 * `fallback` is the stored price on an edit: a field left out keeps it, so the
 * enable switch, which sends only `{ enabled }`, cannot reset what a model
 * costs. A create has no fallback, and leaving the price out is refused - a new
 * model is priced by whoever adds it, never by a default nobody chose.
 *
 * Refused rather than rounded: "0.0235", "-1", "1001", "two". A price is money,
 * and a figure the administrator did not type is a figure every user is then
 * charged.
 */
export function parsePricePerResume(value: unknown, fallback: number | undefined): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Price per resume is required for a new model: enter it in dollars ${PRICE_RULE}.`);
  }
  const parsed = parseDollars(value);
  if (!parsed.ok) {
    throw new Error(`${describeDollarProblem(parsed.problem, 'Price per resume')} It is ${PRICE_RULE}.`);
  }
  if (parsed.milli < MIN_PRICE_PER_RESUME_MILLI || parsed.milli > MAX_PRICE_PER_RESUME_MILLI) {
    throw new Error(`Price per resume must be ${PRICE_RULE}.`);
  }
  return parsed.milli;
}

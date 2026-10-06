import { describeDollarProblem, formatMoney, parseDollars } from '../utils/money';

/**
 * What a reporter is paid for one job the lake accepts, in thousandths of a
 * dollar - the per-reporter override an administrator sets on Admin ->
 * Accounts.
 *
 * Stored on the account as `users.report_rate_milli`, NULL meaning "the
 * installation's global rate". That global rate is the Job Data Lake's own
 * setting, set on /admin/job-lake, and a reward reads `report_rate_milli ??
 * global` when it is written and snapshots it on the reward row (owner
 * decision J7): changing either rate changes what the NEXT accepted job pays,
 * never one already paid.
 *
 * A leaf, for the reason pricePerResume.ts is: the accounts route parses it
 * and the lake will, and neither may import the other. The same units and the
 * same ceiling as a price per resume - $0.001 steps, $0.000 to $1000.000 -
 * because both are an amount per item that an administrator types into a box.
 */

export const MIN_REPORT_RATE_MILLI = 0;

/** $1,000, the price-per-resume ceiling: a box with no ceiling gets 1000000 typed into it. */
export const MAX_REPORT_RATE_MILLI = 1_000_000;

export type ReportRateParse = { ok: true; milli: number | null } | { ok: false; error: string };

/**
 * An administrator's `reportRateUsd`, as text or a JSON number in dollars.
 *
 * `null` or an empty string CLEARS the override (the account goes back to the
 * global rate) and reads as `{ ok: true, milli: null }`. Anything else must be
 * dollars to at most three decimals, from $0.000 to $1000.000 - refused by
 * name rather than rounded or clamped, because a pay rate silently changed
 * from what was typed is a reporter paid the wrong amount for every job after.
 */
export function parseReportRateUsd(value: unknown): ReportRateParse {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return { ok: true, milli: null };
  const parsed = parseDollars(value);
  if (!parsed.ok) return { ok: false, error: describeDollarProblem(parsed.problem, 'The rate per job') };
  if (parsed.milli > MAX_REPORT_RATE_MILLI) {
    return {
      ok: false,
      error: `The rate per job can be at most ${formatMoney(MAX_REPORT_RATE_MILLI)}.`,
    };
  }
  return { ok: true, milli: parsed.milli };
}

/**
 * A stored `report_rate_milli`, as a read takes it. Never throws.
 *
 * NULL is "no override". A value that is not a whole, in-range number of
 * thousandths - a hand-edited row - also reads as no override rather than as
 * some other amount: the global rate is the one an administrator chose for
 * everybody, which beats a figure nobody typed.
 */
export function readStoredReportRateMilli(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < MIN_REPORT_RATE_MILLI || value > MAX_REPORT_RATE_MILLI) return null;
  return value;
}

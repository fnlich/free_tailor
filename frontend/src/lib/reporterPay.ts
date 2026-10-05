import { describeDollarProblem, formatMoney, parseDollars } from './format';

/**
 * What Admin -> Accounts types for a reporter: their own rate per job, and a
 * payout recorded against their balance (owner decisions J7, A4).
 *
 * The server's rules, copied so a box can say what is wrong before anything is
 * sent - and in the server's own words, so the sentence under the box and the
 * one a refusal would bring are the same sentence. The server parses what was
 * TYPED again and is the one that decides; backend/test/frontendRoles.test.js
 * runs these against `parseReportRateUsd` (config/reportRate.ts) and against
 * the real POST /api/admin/accounts/:id/payout, and fails on any difference.
 *
 * Imports only lib/format.ts, which imports nothing at runtime.
 */

/** $1000.000, the server's MAX_REPORT_RATE_MILLI - the price-per-resume ceiling. */
export const MAX_REPORT_RATE_MILLI = 1_000_000;

export type ReportRateParse = { ok: true; milli: number | null } | { ok: false; error: string };

/**
 * A rate per job as typed. Empty CLEARS the account's own rate, so the
 * installation's global rate applies (`milli: null`) - which is how the box
 * says "global" without a second control. Otherwise dollars to $0.001, from
 * $0.000 to $1000.000, refused by name rather than rounded.
 */
export function parseReportRate(text: unknown): ReportRateParse {
  if (text === null || (typeof text === 'string' && text.trim() === '')) return { ok: true, milli: null };
  const parsed = parseDollars(text);
  if (!parsed.ok) return { ok: false, error: describeDollarProblem(parsed.problem, 'The rate per job') };
  if (parsed.milli > MAX_REPORT_RATE_MILLI) {
    return { ok: false, error: `The rate per job can be at most ${formatMoney(MAX_REPORT_RATE_MILLI)}.` };
  }
  return { ok: true, milli: parsed.milli };
}

/**
 * How a stored rate reads beside its box: its own figure, or the global one -
 * named with its figure when the page knows it (Admin -> Accounts' list carries
 * `globalReportRateMilli`, set on Admin -> Job Lake), so "Global" is never a
 * word that hides whether a reporter is being paid $0.000.
 */
export function describeReportRate(milli: number | null | undefined, globalMilli?: number | null): string {
  if (typeof milli === 'number') return `${formatMoney(milli)} per job`;
  return typeof globalMilli === 'number'
    ? `The global rate per job, ${formatMoney(globalMilli)}`
    : 'The global rate per job';
}

/** The placeholder of an empty rate box: the global rate, by its figure when it is known. */
export function globalRatePlaceholder(globalMilli: number | null | undefined, short = false): string {
  const word = short ? 'Global' : 'Global rate';
  return typeof globalMilli === 'number' ? `${word} (${formatMoney(globalMilli)})` : word;
}

/** The server's MAX_PAYOUT_NOTE. */
export const MAX_PAYOUT_NOTE = 500;

/**
 * Why this payout cannot be recorded, or '' when it can - checked in the order
 * the server checks, so the first problem named is the one it would name.
 *
 * Never "record the balance instead": a payout is money that already left by
 * hand, and a record that says less (or more) than was paid is wrong. Above
 * the balance is refused here exactly as the server refuses it.
 */
export function payoutProblem(amountText: string, note: string, balanceMilli: number): string {
  const parsed = parseDollars(amountText);
  if (!parsed.ok) return describeDollarProblem(parsed.problem, 'The payout');
  if (parsed.milli === 0) return 'Give the amount paid, in dollars.';
  const trimmed = note.trim();
  if (!trimmed) return 'Say how it was paid - a method, a date or a reference - so the record explains itself.';
  if (trimmed.length > MAX_PAYOUT_NOTE) return `Keep the note under ${MAX_PAYOUT_NOTE} characters.`;
  if (parsed.milli > balanceMilli) return insufficientBalance(balanceMilli);
  return '';
}

/** The server's 409 `insufficient-balance` sentence, word for word. */
export function insufficientBalance(balanceMilli: number): string {
  return (
    `That is more than this reporter's balance of ${formatMoney(balanceMilli)}. ` +
    'Record what was actually paid, up to the balance.'
  );
}

/**
 * The balance a payout of `amountText` would leave, in thousandths - or null
 * while the amount is not one, or is more than there is. Shown under the box
 * as it is typed, so the administrator sees what the record will say before
 * pressing anything.
 */
export function payoutLeaves(amountText: string, balanceMilli: number): number | null {
  const parsed = parseDollars(amountText);
  if (!parsed.ok || parsed.milli > balanceMilli) return null;
  return balanceMilli - parsed.milli;
}

/**
 * The line under the payout's amount box, as it is typed: the balance before
 * anything is typed, then the balance the payout would leave - or, when the
 * amount is not one or is more than the balance, why, in the server's words.
 * Only the amount: the note's problems are the button's to say.
 */
export function describePayoutAmount(
  amountText: string,
  balanceMilli: number
): { tone: 'idle' | 'ok' | 'error'; text: string } {
  if (!amountText.trim()) return { tone: 'idle', text: `Their balance is ${formatMoney(balanceMilli)}.` };
  const parsed = parseDollars(amountText);
  if (!parsed.ok) return { tone: 'error', text: describeDollarProblem(parsed.problem, 'The payout') };
  if (parsed.milli === 0) return { tone: 'error', text: 'Give the amount paid, in dollars.' };
  const leaves = payoutLeaves(amountText, balanceMilli);
  if (leaves === null) return { tone: 'error', text: insufficientBalance(balanceMilli) };
  return { tone: 'ok', text: `Leaves ${formatMoney(leaves)} of their ${formatMoney(balanceMilli)} balance.` };
}

/**
 * One payout's id, minted when its form opens and sent with every press of it,
 * so a double press or a retried request records the payout once (the server
 * answers the repeat `recorded: false` with the first row).
 *
 * `crypto.randomUUID` exists only on a secure origin, and this app is often
 * opened over plain http on a LAN address; the fallback still fits the
 * server's 8 to 100 letters, digits, `-` and `_`.
 */
export function mintPayoutRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // An insecure origin; fall through.
  }
  return `payout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

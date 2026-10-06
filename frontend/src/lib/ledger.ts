import type { LedgerEntry } from './credits';
import { formatMoney, formatSignedMoney } from './format';

/**
 * How one ledger row reads, on /credits and on Admin -> Accounts alike.
 *
 * Its own module, apart from lib/credits.ts, because these are decisions with
 * no request in them and backend/test/frontendMoney.test.js loads them - which
 * it can only do for a module whose one runtime import is lib/format.ts.
 *
 * The rule they keep: **a row is shown in the unit it was written in.** Rows
 * since credits became dollars move thousandths of a dollar. Rows from before
 * - and the `reset` row that ended them - moved whole credits, and carry those
 * figures as `legacyCredits`. Printing such a row as `$0` would say
 * nothing happened; converting it at some rate would put a figure on it that
 * the account never held. So it says `-12 credits`, which is what it did.
 */

function credits(count: number): string {
  return `${count} ${count === 1 || count === -1 ? 'credit' : 'credits'}`;
}

/** Which way a row moved the balance - 1, -1 or 0 - in whichever unit it is in. For the colour. */
export function ledgerDirection(entry: LedgerEntry): number {
  return Math.sign(entry.legacyCredits ? entry.legacyCredits.delta : entry.deltaMilli);
}

/** The movement with its sign, visible without reading the colour: `+$0.023`, `-$0.161`, `-12 credits`. */
export function describeLedgerChange(entry: LedgerEntry): string {
  if (entry.legacyCredits) {
    const { delta } = entry.legacyCredits;
    return delta > 0 ? `+${credits(delta)}` : credits(delta);
  }
  return formatSignedMoney(entry.deltaMilli);
}

/** The balance the row left, in the row's own unit: `$3.977`, or `12 credits` on a legacy row. */
export function describeLedgerBalance(entry: LedgerEntry): string {
  return entry.legacyCredits ? credits(entry.legacyCredits.balanceAfter) : formatMoney(entry.balanceAfterMilli);
}

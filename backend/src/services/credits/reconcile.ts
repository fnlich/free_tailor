import { countAdmins } from '../../database/userRepository';
import {
  abandonReservation,
  findInconsistentBalances,
  listOpenReservations,
} from '../../database/creditRepository';

/**
 * Putting the credit books straight after a restart.
 *
 * Two jobs, both of them read-mostly and neither of them fatal.
 *
 * 1. ORPHANED RESERVATIONS. A reservation is opened at submit and closed when
 *    its run finishes accounting for itself. A process that dies in between
 *    leaves one open forever, holding credits against work that will never
 *    finish. The queue's own restore requeues the tasks it can; anything still
 *    open and old enough that no live run could own it is released.
 *
 * 2. THE STANDING INVARIANT. The ledger is append-only and users.credits is a
 *    cache of its sum, so the two agreeing is something that should always be
 *    true. It is REPORTED rather than silently repaired: a disagreement means
 *    something wrote the column outside creditRepository, and quietly correcting
 *    it would hide the bug that caused it.
 */

/**
 * How old an open reservation must be before it is presumed abandoned.
 *
 * Comfortably longer than the longest plausible run - a thirty-resume sheet
 * import on one slow browser is tens of minutes - because releasing one that is
 * merely slow would hand back credits for resumes that then arrive.
 */
const ORPHAN_AFTER_MS = 6 * 60 * 60_000;

export type ReconcileReport = {
  released: number;
  credits: number;
  inconsistent: Array<{ userId: string; balance: number; ledgerSum: number }>;
};

export function reconcileCredits(now = Date.now()): ReconcileReport {
  const report: ReconcileReport = { released: 0, credits: 0, inconsistent: [] };

  try {
    const cutoff = new Date(now - ORPHAN_AFTER_MS).toISOString();
    for (const reservation of listOpenReservations(cutoff)) {
      const outcome = abandonReservation({
        reservationId: reservation.id,
        reason: 'reconcile-orphan',
        note: 'The run holding these credits did not finish; released on restart.',
      });
      if (outcome.closed) {
        report.released += 1;
        report.credits += outcome.refunded;
      }
    }

    report.inconsistent = findInconsistentBalances();
  } catch (error) {
    console.warn('[credits] Could not reconcile the credit books after restart.', error);
    return report;
  }

  if (report.released > 0) {
    console.log(
      `[credits] Released ${report.credits} credit(s) from ${report.released} run(s) that never finished.`
    );
  }
  for (const row of report.inconsistent) {
    console.warn(
      `[credits] Account ${row.userId} holds ${row.balance} credits but its ledger sums to ` +
        `${row.ledgerSum}. Something wrote the balance outside the credit service.`
    );
  }

  return report;
}

/**
 * Says so when an installation has nobody who can administer it.
 *
 * This is reachable, and not only in theory. `roleForNewUser` defers ENTIRELY to
 * ADMIN_EMAILS when that variable is set - it does not fall back to the
 * first-account rule - so an operator who sets it and then has somebody else
 * sign in first gets an install whose only user is an ordinary one, on zero
 * credits, with no administrator to grant any. Nothing in the app can fix that
 * from inside, so the least it can do is say what is wrong on the way past.
 */
export function warnIfNoAdmin(): boolean {
  try {
    if (countAdmins() > 0) return false;
  } catch {
    return false;
  }

  console.warn(
    '[auth] This installation has no enabled administrator. Nobody can manage accounts, ' +
      'edit prompts, or grant credits. Set ADMIN_EMAILS in .env to an address that has signed ' +
      'in (or will), then restart.'
  );
  return true;
}

import { randomUUID } from 'crypto';

import {
  abandonReservation,
  applyAdjustment,
  debitAndReserve,
  findInconsistentBalances,
  getReservation,
  hasLedgerEntries,
  heldForUser,
  countLedger,
  listLedger,
  listOpenReservations,
  refundAgainstReservation,
  settleReservation,
} from '../../database/creditRepository';
import { getUserById } from '../../database/userRepository';
import { DEFAULT_CREDITS_PER_RESUME } from '../../config/creditsPerResume';
import type { UserAccount } from '../../types/account';
import { InsufficientCreditsError } from './errors';
import type { CreditStatus, LedgerEntry, ReserveResult } from './types';

export { InsufficientCreditsError } from './errors';
export type { CreditReason, CreditStatus, LedgerEntry, Reservation, ReserveResult } from './types';

/**
 * What a credit buys, and who pays.
 *
 * A RESUME COSTS WHAT ITS MODEL COSTS. Each model record carries a
 * `creditsPerResume` an administrator sets under Admin -> Models (0 is free),
 * and one deliverable unit - one (profile x job) pair - is charged that once,
 * however many files it writes. A run asking for both PDF and DOCX plus a cover
 * letter produces four files and costs one resume's price, because what the
 * person asked for is one tailored resume.
 *
 * The charge happens at SUBMIT, before the first model call, and every unit that
 * does not deliver gives its own price back. The invariant is: credits spent
 * equals the price of the resumes delivered.
 *
 * Charging at submit rather than on delivery is forced by the architecture, not
 * chosen for convenience. The queued path hands back a batch id and returns
 * before any work runs, and by the time a task executes there is no request and
 * no user attached to it - so the only moment a charge can be both truthful and
 * attributable is when the work is asked for. Which is also why the price is
 * SNAPSHOTTED then, onto each queued task: an administrator repricing a model
 * mid-batch changes what the next submission costs, never what a refund of this
 * one gives back.
 */

/**
 * What a resume costs when nothing names a price: the default every seed and
 * every record saved before prices existed carry, and what a task queued
 * before the upgrade - with no price of its own on it - refunds. `GET
 * /api/credits` still sends it as `perResume` for a page loaded before prices
 * were per model.
 */
export const CREDITS_PER_RESUME = DEFAULT_CREDITS_PER_RESUME;

/**
 * How many credits a brand-new account gets. Zero unless an operator says
 * otherwise.
 *
 * The default keeps the stated behaviour - an account starts at zero - while
 * giving an operator running an open installation a self-serve door rather than
 * hand-granting every arrival. An operator running a closed one changes nothing
 * and never needs to learn this exists.
 */
export function signupGrant(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.CREDIT_SIGNUP_GRANT?.trim() || '0', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Administrators spend nothing.
 *
 * The same reasoning as the profile cap: an administrator can already set any
 * account's balance, so metering them is a formality that only gets in the way
 * of fixing somebody else's.
 */
export function isExempt(account: Pick<UserAccount, 'role'>): boolean {
  return account.role === 'admin';
}

export function newReservationId(): string {
  return `res_${randomUUID()}`;
}

/**
 * Takes the whole cost of a run up front, or refuses it.
 *
 * `credits` is the cost itself - the sum of what each resume in the run costs
 * on its own model - not a count of resumes to multiply by a price: since
 * prices are per model, only the caller that resolved each resume's model knows
 * the total.
 *
 * Throws `InsufficientCreditsError` rather than returning a flag, because every
 * caller's correct response is to stop - and a boolean that a handler forgets to
 * check would mean an uncharged run rather than a visible failure.
 */
export function reserveCredits(
  account: UserAccount,
  credits: number,
  ref: { kind: string; id: string; label?: string }
): ReserveResult {
  if (isExempt(account)) {
    // No reservation row and no ledger row. Every later refund against this id
    // is then a no-op for the honest reason that there is nothing to find,
    // rather than because the refund path remembered to re-check the role.
    return { id: ref.id, userId: account.id, units: 0, exempt: true };
  }

  const cost = Math.max(0, Math.floor(credits));
  // A run on free models takes nothing and writes nothing, so it leaves no row
  // in the account's history - and an account with no credits can run it.
  if (cost === 0) return { id: ref.id, userId: account.id, units: 0, exempt: false };

  const outcome = debitAndReserve({
    reservationId: ref.id,
    userId: account.id,
    units: cost,
    kind: ref.kind,
    label: ref.label ?? '',
  });

  if (!outcome.ok) throw new InsufficientCreditsError(cost, outcome.balance);

  return { id: ref.id, userId: account.id, units: cost, exempt: false };
}

/**
 * Gives back what one unit that did not deliver was charged, keyed on the task
 * so a repeated hook cannot double-refund.
 *
 * `credits` is that unit's own price, as snapshotted when it was charged - not
 * whatever its model costs now. The reservation's refund cap still holds in
 * SQL, so no mixture of refunds can return more than the run took.
 */
export function refundTaskUnit(batchId: string, taskId: string, credits: number, note: string): number {
  return refundAgainstReservation({
    reservationId: batchId,
    units: Math.max(0, Math.floor(credits)),
    reason: 'generation-refund',
    idempotencyKey: `refund:task:${taskId}`,
    note,
  }).refunded;
}

/**
 * A charge's line in the account's credit history, by model: "3 resumes: 2 x
 * Claude Sonnet @ 2, 1 x Codex @ 1 = 5 credits".
 *
 * By the display name an administrator gave each model, which is the only name
 * an ordinary account is shown, and in the order the models first appear.
 * Written once, with the reservation, so it says what was charged at the time
 * whatever the models cost later.
 */
export function describeCharge(units: ReadonlyArray<{ modelLabel: string; credits: number }>): string {
  const groups = new Map<string, { modelLabel: string; credits: number; count: number }>();
  for (const unit of units) {
    const key = `${unit.modelLabel}\u0000${unit.credits}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { modelLabel: unit.modelLabel, credits: unit.credits, count: 1 });
  }
  const total = units.reduce((sum, unit) => sum + unit.credits, 0);
  const parts = [...groups.values()].map((group) => `${group.count} x ${group.modelLabel} @ ${group.credits}`);
  return (
    `${units.length} resume${units.length === 1 ? '' : 's'}: ${parts.join(', ')} = ` +
    `${total} credit${total === 1 ? '' : 's'}`
  );
}

/**
 * Closes a run that accounted for itself. Refunds nothing.
 *
 * Call this once the failures have been refunded explicitly: whatever is left
 * DELIVERED, and its credits are spent.
 */
export function settleRun(reservationId: string): boolean {
  return settleReservation(reservationId);
}

/**
 * Gives back everything still outstanding, for a run that did not finish
 * accounting for itself.
 *
 * A no-op once the run has been settled, which is what lets a handler call it
 * unconditionally in a `finally`: nothing on the happy path, the full sweep
 * when the body threw before it could settle.
 */
export function releaseReservation(reservationId: string, note = ''): number {
  return abandonReservation({ reservationId, reason: 'generation-release', note }).refunded;
}

/**
 * Closes a batch's reservation once nothing is left queued or running.
 *
 * SETTLES rather than releases. By the time the last task has finished, every
 * task that did not deliver has already refunded its own credit through the
 * hook - so what remains held is exactly what was delivered. Releasing here
 * instead would hand back the credits for every successful resume in the batch,
 * which is to say it would make generation free.
 *
 * Closing early would be the mirror-image bug: a later task refunding into a
 * closed reservation is a no-op, so a credit for a resume that never arrived
 * would be quietly kept.
 */
export function closeIfSettled(
  reservationId: string,
  outstanding: { queued: number; running: number } | null
): void {
  if (!outstanding) return;
  if (outstanding.queued > 0 || outstanding.running > 0) return;
  settleReservation(reservationId);
}

export function grantCredits(
  userId: string,
  amount: number,
  actorId: string,
  note = ''
): number {
  return applyAdjustment({
    userId,
    delta: Math.floor(amount),
    reason: amount >= 0 ? 'admin-grant' : 'admin-revoke',
    idempotencyKey: `grant:${randomUUID()}`,
    actorId,
    note,
  }).balance;
}

/**
 * Moves a balance TO an absolute number, the way the accounts page's field
 * reads.
 *
 * Written as the difference rather than a SET, so it goes through the same
 * single-owner path as everything else and leaves a row explaining the move.
 */
export function setBalance(userId: string, target: number, actorId: string, note = ''): number {
  const account = getUserById(userId);
  if (!account) return 0;
  const wanted = Math.max(0, Math.floor(target));
  const delta = wanted - account.credits;
  if (delta === 0) return account.credits;

  return applyAdjustment({
    userId,
    delta,
    reason: 'admin-set',
    idempotencyKey: `set:${randomUUID()}`,
    actorId,
    note: note || `Set to ${wanted}.`,
  }).balance;
}

/** The opening grant for a brand-new account, when an operator configured one. */
export function applySignupGrant(account: UserAccount, env: NodeJS.ProcessEnv = process.env): void {
  const amount = signupGrant(env);
  if (amount <= 0) return;
  applyAdjustment({
    userId: account.id,
    delta: amount,
    reason: 'signup-grant',
    // Keyed on the account, so a retried sign-in cannot grant twice.
    idempotencyKey: `signup:${account.id}`,
    note: 'Welcome credits for a new account.',
  });
}

export function getStatus(account: UserAccount): CreditStatus {
  return {
    balance: account.credits,
    held: heldForUser(account.id),
    exempt: isExempt(account),
  };
}

export function getLedger(userId: string, limit?: number, offset?: number): LedgerEntry[] {
  return listLedger(userId, limit, offset);
}

export {
  countLedger,
  findInconsistentBalances,
  getReservation,
  hasLedgerEntries,
  listOpenReservations,
};

import { randomUUID } from 'crypto';

import {
  abandonReservation,
  applyAdjustment,
  debitAndReserve,
  findInconsistentBalances,
  getReservation,
  hasLedgerEntries,
  heldForUser,
  isLedgerKeyUsed,
  countLedger,
  listLedger,
  listOpenReservations,
  refundAgainstReservation,
  settleReservation,
} from '../../database/creditRepository';
import { getUserById } from '../../database/userRepository';
import { envDollarsMilli } from '../../config/envValue';
import { formatMoney } from '../../utils/money';
import type { UserAccount } from '../../types/account';
import { InsufficientCreditsError } from './errors';
import type { CreditStatus, LedgerEntry, ReserveResult } from './types';

export { InsufficientCreditsError } from './errors';
export type { CreditReason, CreditStatus, LedgerEntry, Reservation, ReserveResult } from './types';

/**
 * What credit buys, and who pays.
 *
 * A CREDIT IS A DOLLAR, counted in thousandths (utils/money.ts): a balance, a
 * price, a charge and a refund are all integer milli-dollars, and nothing in
 * this module rounds. A $0.023 resume takes 23; seven take 161 = $0.161; two of
 * them failing give back 46 = $0.046, exactly.
 *
 * A RESUME COSTS WHAT ITS MODEL COSTS. Each model record carries a
 * `pricePerResumeMilli` an administrator sets under Admin -> Models (0 is free),
 * and one deliverable unit - one (profile x job) pair - is charged that once,
 * however many files it writes. A run asking for both PDF and DOCX plus a cover
 * letter produces four files and costs one resume's price, because what the
 * person asked for is one tailored resume.
 *
 * The charge happens at SUBMIT, before the first model call, and every unit that
 * does not deliver gives its own price back. The invariant is: credit spent
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

/** The most `CREDIT_SIGNUP_GRANT` may give a new account: $1000.000. */
export const MAX_SIGNUP_GRANT_MILLI = 1_000_000;

/**
 * What a brand-new account starts with, in thousandths of a dollar. Zero unless
 * an operator says otherwise.
 *
 * `CREDIT_SIGNUP_GRANT` is DOLLARS since credits became dollars: `5` gives $5,
 * `0.25` gives $0.250, and more than three decimals is junk. It used to be a
 * count of credits at whatever a credit cost, so the same `5` gave about $2.50
 * of resumes; the README says so where an operator looks. Read through
 * envValue's rules: junk warns once and gives nothing, above $1000 clamps.
 *
 * The default keeps the stated behaviour - an account starts at zero - while
 * giving an operator running an open installation a self-serve door rather than
 * hand-granting every arrival. An operator running a closed one changes nothing
 * and never needs to learn this exists.
 */
export function signupGrantMilli(env: NodeJS.ProcessEnv = process.env): number {
  return envDollarsMilli('CREDIT_SIGNUP_GRANT', 0, { maxMilli: MAX_SIGNUP_GRANT_MILLI }, env);
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
 * A charge or refund amount refused before it reaches the ledger: anything
 * but a whole number of thousandths of a dollar. Never rounded - a cost of
 * 22.6 is a bug upstream, and flooring it to 22 is a resume sold below its
 * price without a word.
 */
function exactMilli(amount: number, what: string): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${what} must be a whole, non-negative number of thousandths of a dollar, not ${amount}.`);
  }
  return amount;
}

/**
 * Takes the whole cost of a run up front, or refuses it.
 *
 * `costMilli` is the cost itself, in thousandths of a dollar - the sum of what
 * each resume in the run costs on its own model - not a count of resumes to
 * multiply by a price: since prices are per model, only the caller that
 * resolved each resume's model knows the total.
 *
 * Throws `InsufficientCreditsError` rather than returning a flag, because every
 * caller's correct response is to stop - and a boolean that a handler forgets to
 * check would mean an uncharged run rather than a visible failure.
 */
export function reserveCredits(
  account: UserAccount,
  costMilli: number,
  ref: { kind: string; id: string; label?: string }
): ReserveResult {
  if (isExempt(account)) {
    // No reservation row and no ledger row. Every later refund against this id
    // is then a no-op for the honest reason that there is nothing to find,
    // rather than because the refund path remembered to re-check the role.
    return { id: ref.id, userId: account.id, costMilli: 0, exempt: true };
  }

  const cost = exactMilli(costMilli, 'A charge');
  // A run on free models takes nothing and writes nothing, so it leaves no row
  // in the account's history - and an account with no credit can run it.
  if (cost === 0) return { id: ref.id, userId: account.id, costMilli: 0, exempt: false };

  const outcome = debitAndReserve({
    reservationId: ref.id,
    userId: account.id,
    amountMilli: cost,
    kind: ref.kind,
    label: ref.label ?? '',
  });

  if (!outcome.ok) throw new InsufficientCreditsError(cost, outcome.balance);

  return { id: ref.id, userId: account.id, costMilli: cost, exempt: false };
}

/**
 * Gives back what one unit that did not deliver was charged, keyed on the task
 * so a repeated hook cannot double-refund.
 *
 * `costMilli` is that unit's own price, as snapshotted when it was charged -
 * not whatever its model costs now. The reservation's refund cap still holds
 * in SQL, so no mixture of refunds can return more than the run took.
 */
export function refundTaskUnit(batchId: string, taskId: string, costMilli: number, note: string): number {
  return refundAgainstReservation({
    reservationId: batchId,
    amountMilli: exactMilli(costMilli, 'A refund'),
    reason: 'generation-refund',
    idempotencyKey: `refund:task:${taskId}`,
    note,
  }).refunded;
}

/**
 * Gives back ONE delivered resume's charge, because its owner asked and an
 * administrator agreed (services/refunds), and says how much moved: the
 * amount, or 0 when nothing could.
 *
 * Not a parallel path: it is the same refund the queue hook makes for a unit
 * that failed, against the same reservation and under the same SQL cap - so
 * no mixture of automatic and granted refunds can return more than the run
 * took. Two differences, both because the resume DID deliver: the run has
 * usually settled by now, so a closed reservation takes it too; and the key is
 * the request's, `refund-request:<id>`, so one request credits once however
 * often it is pressed. The caller writes the request's state change in the
 * same transaction, and treats 0 as "do not change it".
 */
export function refundRequestedCharge(input: {
  requestId: string;
  reservationId: string;
  userId: string;
  amountMilli: number;
  actorId: string;
  note: string;
}): number {
  return refundAgainstReservation({
    reservationId: input.reservationId,
    amountMilli: exactMilli(input.amountMilli, 'A refund'),
    reason: 'refund-request',
    idempotencyKey: `refund-request:${input.requestId}`,
    note: input.note,
    actorId: input.actorId,
    includeClosed: true,
    userId: input.userId,
  }).refunded;
}

/**
 * A charge's line in the account's credit history, by model: "3 resumes: 2 x
 * Claude Sonnet @ $0.023, 1 x Codex @ $0.010 = $0.056".
 *
 * By the display name an administrator gave each model, which is the only name
 * an ordinary account is shown, and in the order the models first appear.
 * Written once, with the reservation, so it says what was charged at the time
 * whatever the models cost later.
 */
export function describeCharge(units: ReadonlyArray<{ modelLabel: string; costMilli: number }>): string {
  const groups = new Map<string, { modelLabel: string; costMilli: number; count: number }>();
  for (const unit of units) {
    const key = `${unit.modelLabel}\u0000${unit.costMilli}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { modelLabel: unit.modelLabel, costMilli: unit.costMilli, count: 1 });
  }
  const total = units.reduce((sum, unit) => sum + unit.costMilli, 0);
  const parts = [...groups.values()].map(
    (group) => `${group.count} x ${group.modelLabel} @ ${formatMoney(group.costMilli)}`
  );
  return `${units.length} resume${units.length === 1 ? '' : 's'}: ${parts.join(', ')} = ${formatMoney(total)}`;
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

/**
 * Adds to a balance - or, negative, takes from it - by an administrator, in
 * thousandths of a dollar. A take larger than the balance stops at zero; the
 * returned balance says where it landed.
 */
export function grantCredits(
  userId: string,
  amountMilli: number,
  actorId: string,
  note = ''
): number {
  if (!Number.isSafeInteger(amountMilli)) {
    throw new Error(`A grant must be a whole number of thousandths of a dollar, not ${amountMilli}.`);
  }
  return applyAdjustment({
    userId,
    deltaMilli: amountMilli,
    reason: amountMilli >= 0 ? 'admin-grant' : 'admin-revoke',
    idempotencyKey: `grant:${randomUUID()}`,
    actorId,
    note,
  }).balance;
}

/**
 * Moves a balance TO an absolute amount, the way the accounts page's field
 * reads, in thousandths of a dollar.
 *
 * Written as the difference rather than a SET, so it goes through the same
 * single-owner path as everything else and leaves a row explaining the move.
 */
export function setBalance(userId: string, targetMilli: number, actorId: string, note = ''): number {
  const account = getUserById(userId);
  if (!account) return 0;
  const wanted = exactMilli(targetMilli, 'A balance');
  const delta = wanted - account.balanceMilli;
  if (delta === 0) return account.balanceMilli;

  return applyAdjustment({
    userId,
    deltaMilli: delta,
    reason: 'admin-set',
    idempotencyKey: `set:${randomUUID()}`,
    actorId,
    note: note || `Set to ${formatMoney(wanted)}.`,
  }).balance;
}

/** The opening grant for a brand-new account, when an operator configured one. */
export function applySignupGrant(account: UserAccount, env: NodeJS.ProcessEnv = process.env): void {
  const amount = signupGrantMilli(env);
  if (amount <= 0) return;
  applyAdjustment({
    userId: account.id,
    deltaMilli: amount,
    reason: 'signup-grant',
    // Keyed on the account, so a retried sign-in cannot grant twice.
    idempotencyKey: `signup:${account.id}`,
    note: `Welcome credit for a new account: ${formatMoney(amount)}.`,
  });
}

export function getStatus(account: UserAccount): CreditStatus {
  return {
    balanceMilli: account.balanceMilli,
    heldMilli: heldForUser(account.id),
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
  isLedgerKeyUsed,
  listOpenReservations,
};

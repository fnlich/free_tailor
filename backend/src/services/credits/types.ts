/**
 * The vocabulary of the credit ledger.
 *
 * Every row carries one of these reasons, and they are the only strings the
 * describer below switches on. A closed union rather than free text because the
 * ledger's whole job is to be readable back: "you have three" is not an answer
 * anybody can check, and neither is a row that says whatever its writer felt
 * like at the time.
 */
export const CREDIT_REASONS = [
  'opening-balance',
  'signup-grant',
  'admin-grant',
  'admin-revoke',
  'admin-set',
  'generation-reserve',
  'generation-refund',
  'generation-release',
  'reconcile-orphan',
  // Money in, and money back out. A purchase is the only reason a balance ever
  // rises without an administrator deciding it should.
  'purchase',
  'purchase-refund',
  // A card refund request takes its credit off (as `purchase-refund`) BEFORE
  // Stripe is asked, so it cannot be spent while the money is on its way back.
  // This is that credit put back because Stripe REFUSED the refund
  // (services/refunds). Keyed `<the hold's key>:returned`, so it returns once.
  'purchase-refund-failed',
  // A resume's charge given back because somebody asked and an administrator
  // agreed (services/refunds). Keyed refund-request:<request id>, so one
  // request credits once; refunded against the run's reservation, so no mix
  // of these and the automatic refunds can give back more than it took.
  'refund-request',
  // A reporter's earnings paid out by an administrator OUTSIDE the app (owner
  // decision A4: by bank, by hand - nothing here moves money outward for it),
  // recorded as a deduction with the administrator's note saying how. Only
  // ever on a reporter's account, never more than the balance, never
  // clamped: a payout the balance cannot cover is refused instead
  // (creditRepository.debitReporterPayout).
  'reporter-payout',
  // A reporter paid for a job the Job Data Lake accepted (owner decision J7):
  // written in the SAME transaction as the lake row it pays for
  // (database/jobLakeRepository.ts mergeIntoLake), keyed
  // job-lake:<lake id>:<the version's updated_at>, so a replacement after the
  // duplicate window pays again and one version never twice. Its amount is
  // the rate in effect then - the reporter's own, else the global one - cut
  // to what is left of the daily cap, and never written at $0.
  'job-report-reward',
  // That reward taken back by an administrator, as a deduction clamped at the
  // balance (a reporter who was paid out already keeps $0, not a debt).
  // Keyed job-lake-revoke:<lake id>:<updated_at>, so a version is revoked once.
  'job-report-reward-revoked',
  // Credits became dollars, and every balance was reset to $0. One row per
  // account that held any, in the old unit, taking it to zero - or, for one
  // whose credits were all held by a run, moving nothing and saying so.
  // Always read as a row in credits. History: nothing writes one now.
  'reset',
] as const;

export type CreditReason = (typeof CREDIT_REASONS)[number];

export type LedgerEntry = {
  seq: number;
  id: string;
  userId: string;
  /**
   * Thousandths of a dollar: negative for a charge, positive for a grant or
   * refund. Never zero on a row written since credits became dollars; 0 on a
   * row from before, whose amount is in `legacyCredits`.
   */
  deltaMilli: number;
  /** The balance after this row, in thousandths of a dollar, measured rather than computed. */
  balanceAfterMilli: number;
  /**
   * A row from before credits became dollars - and the `reset` row that ended
   * them - as it was written, in whole credits. Null on every row since. Not
   * converted: what a credit was worth depended on what it was bought at, and
   * the owner reset the balances rather than pick a rate.
   */
  legacyCredits: { delta: number; balanceAfter: number } | null;
  reason: CreditReason;
  refKind: string;
  refId: string;
  actorId?: string;
  note: string;
  createdAt: string;
};

export type Reservation = {
  id: string;
  userId: string;
  kind: string;
  /** What the run took, in thousandths of a dollar. */
  unitsMilli: number;
  /** What it has given back so far; never more than `unitsMilli`. */
  refundedMilli: number;
  state: 'open' | 'closed';
  label: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * What a reserve produced.
 *
 * `exempt` means no credits were taken and no row was written - the account is
 * an administrator. Every later refund against it is a no-op for the same
 * reason: there is nothing to find.
 */
export type ReserveResult = {
  id: string;
  userId: string;
  /** What was taken, in thousandths of a dollar. 0 for a free run or an administrator. */
  costMilli: number;
  exempt: boolean;
};

/** A balance, and what is currently held against in-flight runs, in thousandths of a dollar. */
export type CreditStatus = {
  balanceMilli: number;
  /** Sum of (units - refunded) over open reservations. */
  heldMilli: number;
  /** Administrators spend nothing; the balance is shown but never moves. */
  exempt: boolean;
};

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
] as const;

export type CreditReason = (typeof CREDIT_REASONS)[number];

export type LedgerEntry = {
  seq: number;
  id: string;
  userId: string;
  /** Negative for a charge, positive for a grant or refund. Never zero. */
  delta: number;
  /** The balance after this row, measured rather than computed. */
  balanceAfter: number;
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
  units: number;
  refunded: number;
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
  units: number;
  exempt: boolean;
};

/** A balance, and what is currently held against in-flight runs. */
export type CreditStatus = {
  balance: number;
  /** Sum of (units - refunded) over open reservations. */
  held: number;
  /** Administrators spend nothing; the balance is shown but never moves. */
  exempt: boolean;
};

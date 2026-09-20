import { apiFetch } from './api';

/**
 * Credits: what an account has, and where it went.
 *
 * The reasons are a closed union rather than free text because the ledger's
 * whole job is to be read back by a person. A reason with no phrase for it would
 * render as a blank cell in the one place that is supposed to explain things.
 */

export type CreditReason =
  | 'opening-balance'
  | 'signup-grant'
  | 'admin-grant'
  | 'admin-revoke'
  | 'admin-set'
  | 'generation-reserve'
  | 'generation-refund'
  | 'generation-release'
  | 'reconcile-orphan';

export type LedgerEntry = {
  /** Monotonic, and authoritative for ordering: two rows can share a timestamp. */
  seq: number;
  id: string;
  userId: string;
  /** Negative for a charge, positive for a grant or a refund. */
  delta: number;
  balanceAfter: number;
  reason: CreditReason;
  refKind: string;
  refId: string;
  actorId?: string;
  note: string;
  createdAt: string;
};

export type CreditStatus = {
  balance: number;
  /** What runs in flight are holding. Comes back for any resume that fails. */
  held: number;
  /** Administrators spend nothing. */
  exempt: boolean;
  perResume: number;
};

export type CreditLedgerResponse = {
  balance: number;
  entries: LedgerEntry[];
};

export const creditsApi = {
  status: () => apiFetch<CreditStatus>('/credits'),
  ledger: (limit?: number) =>
    apiFetch<CreditLedgerResponse>(`/credits/ledger${limit ? `?limit=${limit}` : ''}`),
};

/**
 * Keyed by the union, so adding a reason to the backend without a phrase here is
 * a compile error rather than a blank cell somebody notices in production.
 */
const REASON_PHRASES: Record<CreditReason, string> = {
  'opening-balance': 'Balance carried over from before the ledger existed',
  'signup-grant': 'Welcome credits',
  'admin-grant': 'Added by an administrator',
  'admin-revoke': 'Removed by an administrator',
  'admin-set': 'Set by an administrator',
  'generation-reserve': 'Reserved for a generation run',
  'generation-refund': 'Refunded - a resume did not build',
  'generation-release': 'Returned - the run did not finish',
  'reconcile-orphan': 'Returned - the run never finished',
};

/**
 * A phrase a person can read in a list.
 *
 * The fallback is for wire data, not for the union: a server newer than this
 * build can send a reason the map has never heard of, and showing its raw id
 * beats showing nothing in the panel whose purpose is to explain.
 */
export function describeLedgerReason(entry: LedgerEntry): string {
  return REASON_PHRASES[entry.reason] ?? String(entry.reason);
}

/** "+3" / "-12", so the sign is visible without reading the colour. */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

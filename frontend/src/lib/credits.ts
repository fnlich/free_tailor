import { apiFetch } from './api';

/**
 * Credit: what an account has, and where it went.
 *
 * A credit is a dollar, counted in thousandths: every amount here is an
 * integer in a field ending `Milli`, shown with `formatMoney` ($0.023). Rows
 * written before credits became dollars are the exception, and are shown as
 * what they were - see `LedgerEntry.legacyCredits`, and lib/ledger.ts for how
 * a row reads.
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
  | 'reconcile-orphan'
  | 'purchase'
  | 'purchase-refund'
  /**
   * Credits became dollars and every balance was reset to $0.000: one row per
   * account that held any, in its balance or in a run still going (that one
   * moves 0 credits). Always carries `legacyCredits`.
   */
  | 'reset';

export type LedgerEntry = {
  /** Monotonic, and authoritative for ordering: two rows can share a timestamp. */
  seq: number;
  id: string;
  userId: string;
  /**
   * Thousandths of a dollar: negative for a charge, positive for a grant or a
   * refund. 0 on a row from before credits were dollars - read `legacyCredits`.
   */
  deltaMilli: number;
  /** The balance after this row, in thousandths of a dollar. 0 on a legacy row. */
  balanceAfterMilli: number;
  /**
   * A row written before credits became dollars - and the `reset` row that
   * ended them - as it was written, in whole CREDITS. Null on every row since.
   * Never converted into dollars: what a credit was worth depended on what it
   * was bought at, and the balances were reset rather than repriced, so the
   * honest display is the figure the row holds, in the unit it holds it in.
   */
  legacyCredits: { delta: number; balanceAfter: number } | null;
  reason: CreditReason;
  refKind: string;
  refId: string;
  actorId?: string;
  note: string;
  createdAt: string;
};

export type CreditStatus = {
  /** Thousandths of a dollar. */
  balanceMilli: number;
  /** What runs in flight are holding, in thousandths. Comes back for any resume that fails. */
  heldMilli: number;
  /** Administrators spend nothing. */
  exempt: boolean;
};

export type CreditLedgerResponse = {
  balanceMilli: number;
  entries: LedgerEntry[];
  /** How many movements there are altogether, so a page can say what it hides. */
  total: number;
  offset: number;
};

export const creditsApi = {
  status: () => apiFetch<CreditStatus>('/credits'),
  /**
   * A page of this account's movements.
   *
   * `(offset, limit)`, the same way round as `paymentsApi.list`. It used to be
   * `(limit, offset)`, and the credits page calls both one after the other -
   * two functions that look alike and mean the opposite is a transposition
   * nothing would catch, because five rows at offset five and five rows with a
   * page size of five are indistinguishable at the default.
   */
  ledger: (offset = 0, limit?: number) =>
    apiFetch<CreditLedgerResponse>(
      `/credits/ledger?offset=${offset}${limit ? `&limit=${limit}` : ''}`
    ),
};

/**
 * Keyed by the union, so adding a reason to the backend without a phrase here is
 * a compile error rather than a blank cell somebody notices in production.
 */
const REASON_PHRASES: Record<CreditReason, string> = {
  'opening-balance': 'Balance carried over from before the ledger existed',
  'signup-grant': 'Welcome credit',
  'admin-grant': 'Added by an administrator',
  'admin-revoke': 'Removed by an administrator',
  'admin-set': 'Set by an administrator',
  'generation-reserve': 'Reserved for a generation run',
  'generation-refund': 'Refunded - a resume did not build',
  'generation-release': 'Returned - the run did not finish',
  'reconcile-orphan': 'Returned - the run never finished',
  purchase: 'Bought',
  'purchase-refund': 'Refunded to your payment method',
  reset: 'Reset to $0.000 when credits became dollars',
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

import type { AccountSubscriptionId } from '../config/accountSubscriptions';

/**
 * Who an account is to the installation (config/accountRoles.ts).
 *
 * - `user` builds resumes from their own profiles - every new sign-in;
 * - `reporter` adds job postings to the shared job lake and is paid per job
 *   accepted (owner decisions A3, A4). No resume builder, no Job Filter: the
 *   routes for those answer a reporter 403 `role-not-allowed`;
 * - `admin` manages everything the installation shares.
 *
 * Exclusive: an account is exactly one of the three.
 */
export type UserRole = 'user' | 'reporter' | 'admin';

/** An account as the rest of the app sees it. Never carries a session token. */
export interface UserAccount {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: UserRole;
  /** The account's tier (Default, Premium...): `users.subscription`. */
  subscription: AccountSubscriptionId;
  /**
   * The balance, in thousandths of a dollar: `users.balance_milli`, a cache of
   * the ledger's sum. A credit is a dollar, so 3977 is $3.977.
   */
  balanceMilli: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  /** The account's own Google spreadsheet, once one has been allocated. */
  sheetId?: string;
  sheetUrl?: string;
  /**
   * How far this build laid the spreadsheet out (2: its All and Temp For AI
   * tabs are there). A cache of work already done, not a fact about the
   * spreadsheet - see the column comment in sqlite.ts.
   */
  sheetLayout?: number;
  /** The All tab's gid, for a link that opens it. Absent at layout 2: the name is a tab that is not a job tab. */
  sheetAllGid?: string;
  /** The Temp For AI tab's gid, likewise. */
  sheetTempGid?: string;
  /**
   * When the owner's own Drive grant was last confirmed. Absent means it never
   * has been, which is what makes sign-in keep retrying it.
   */
  sheetSharedAt?: string;
}

/**
 * What an admin may change about somebody else's account.
 *
 * The balance is deliberately NOT here. A balance is not a field to be set: it
 * is the sum of a ledger, and moving it goes through services/credits so the
 * move leaves a row explaining itself. The accounts route reads `balanceUsd`
 * from the same request body and hands it to `setBalance`.
 */
export interface AccountUpdate {
  role?: UserRole;
  subscription?: AccountSubscriptionId;
  disabled?: boolean;
  name?: string;
}

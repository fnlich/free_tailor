import type { AccountPlanId } from '../config/accountPlans';

export type UserRole = 'user' | 'admin';

/** An account as the rest of the app sees it. Never carries a session token. */
export interface UserAccount {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: UserRole;
  plan: AccountPlanId;
  credits: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  /** The account's own Google spreadsheet, once one has been allocated. */
  sheetId?: string;
  sheetUrl?: string;
  /**
   * The last `MM/DD/YYYY` tab prepared in it. A cache of work already done, not
   * a fact about the spreadsheet - see the column comment in sqlite.ts.
   */
  sheetTabDate?: string;
}

/**
 * What an admin may change about somebody else's account.
 *
 * `credits` is deliberately NOT here. A balance is not a field to be set: it is
 * the sum of a ledger, and moving it goes through services/credits so the move
 * leaves a row explaining itself. The accounts route reads the number from the
 * same request body and hands it to `setBalance`.
 */
export interface AccountUpdate {
  role?: UserRole;
  plan?: AccountPlanId;
  disabled?: boolean;
  name?: string;
}

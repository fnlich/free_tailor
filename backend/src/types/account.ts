import type { AccountSubscriptionId } from '../config/accountSubscriptions';

export type UserRole = 'user' | 'admin';

/** An account as the rest of the app sees it. Never carries a session token. */
export interface UserAccount {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: UserRole;
  /** The account's tier (Default, Premium...): `users.subscription`. */
  subscription: AccountSubscriptionId;
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
  /** The gid of that tab, for a link that opens the right day. */
  sheetTabGid?: string;
  /**
   * When the owner's own Drive grant was last confirmed. Absent means it never
   * has been, which is what makes sign-in keep retrying it.
   */
  sheetSharedAt?: string;
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
  subscription?: AccountSubscriptionId;
  disabled?: boolean;
  name?: string;
}

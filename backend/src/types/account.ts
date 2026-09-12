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
}

/** What an admin may change about somebody else's account. */
export interface AccountUpdate {
  role?: UserRole;
  plan?: AccountPlanId;
  credits?: number;
  disabled?: boolean;
  name?: string;
}
